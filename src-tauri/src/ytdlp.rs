//! Stream resolution via a bundled/auto-downloaded yt-dlp binary.
//!
//! YouTube's unauthenticated `player` endpoint is locked down (it requires a
//! Proof-of-Origin token), so instead of re-implementing signature + `n`
//! deciphering in Rust we delegate URL resolution to yt-dlp — the de-facto
//! standard extractor that keeps up with these changes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::Error;

#[derive(Debug, Clone, Serialize)]
pub struct StreamInfo {
    pub url: String,
    pub hls: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackendStatus {
    pub ytdlp_available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

const BINARY_NAMES: &[&str] = &["yt-dlp", "yt-dlp.exe"];

/// Locate yt-dlp without touching the network.
pub fn locate() -> Option<PathBuf> {
    // 1. Explicit override.
    if let Ok(p) = std::env::var("MELODI_YTDLP") {
        let pb = PathBuf::from(&p);
        if pb.is_file() {
            return Some(pb);
        }
    }

    // 2. On PATH.
    if let Ok(paths) = std::env::var("PATH") {
        for dir in std::env::split_paths(&paths) {
            for name in BINARY_NAMES {
                let cand = dir.join(name);
                if cand.is_file() {
                    return Some(cand);
                }
            }
        }
    }

    // 3. Next to the running executable (release bundle).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in BINARY_NAMES {
                let cand = dir.join(name);
                if cand.is_file() {
                    return Some(cand);
                }
            }
        }
    }

    // 4. Dev checkout: <manifest>/binaries.
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    for name in BINARY_NAMES {
        let cand = manifest.join("binaries").join(name);
        if cand.is_file() {
            return Some(cand);
        }
    }

    None
}

/// Locate including the per-app data directory (still no download).
pub fn locate_with(app_data_dir: &Path) -> Option<PathBuf> {
    if let Some(p) = locate() {
        return Some(p);
    }
    let dir = app_data_dir.join("bin");
    for name in BINARY_NAMES {
        let cand = dir.join(name);
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/// Serialises yt-dlp downloads so concurrent callers don't fetch it twice.
static DOWNLOAD_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Build a yt-dlp command that never flashes a console window on Windows.
fn ytdlp_cmd(bin: &Path) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(bin);
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Locate yt-dlp, downloading it into the app data directory if missing.
/// The download is verified against the release's SHA2-256SUMS file.
pub async fn ensure(app_data_dir: &Path) -> Result<PathBuf, Error> {
    if let Some(p) = locate_with(app_data_dir) {
        return Ok(p);
    }

    let _guard = DOWNLOAD_LOCK.lock().await;
    // Another task may have finished the download while we waited.
    if let Some(p) = locate_with(app_data_dir) {
        return Ok(p);
    }

    let dir = app_data_dir.join("bin");
    tokio::fs::create_dir_all(&dir).await?;

    let (name, asset) = if cfg!(target_os = "windows") {
        ("yt-dlp.exe", "yt-dlp.exe")
    } else if cfg!(target_os = "macos") {
        ("yt-dlp", "yt-dlp_macos")
    } else {
        ("yt-dlp", "yt-dlp")
    };
    let base = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";

    let sums = reqwest::get(format!("{base}/SHA2-256SUMS")).await?;
    if !sums.status().is_success() {
        return Err(Error::Msg(format!(
            "failed to fetch yt-dlp checksums: HTTP {}",
            sums.status()
        )));
    }
    let sums = sums.text().await?;
    let expected = sums
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let hash = it.next()?;
            let file = it.next()?.trim_start_matches('*');
            (file == asset).then(|| hash.to_ascii_lowercase())
        })
        .next()
        .ok_or_else(|| Error::Msg("yt-dlp checksum not found".into()))?;

    let resp = reqwest::get(format!("{base}/{asset}")).await?;
    if !resp.status().is_success() {
        return Err(Error::Msg(format!(
            "failed to download yt-dlp: HTTP {}",
            resp.status()
        )));
    }
    let bytes = resp.bytes().await?;
    if sha256_hex(&bytes) != expected {
        return Err(Error::Msg("yt-dlp download failed its checksum".into()));
    }

    let dest = dir.join(name);
    let tmp = dir.join(format!("{name}.tmp"));
    tokio::fs::write(&tmp, &bytes).await?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).await?;
    }

    tokio::fs::rename(&tmp, &dest).await?;
    Ok(dest)
}

// ---------------------------------------------------------------------------
// Stream cache
// ---------------------------------------------------------------------------

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Pull `expire=<unix ts>` out of a googlevideo URL.
fn expire_of(url: &str) -> Option<u64> {
    let query = url.split_once('?')?.1;
    query
        .split('&')
        .find_map(|kv| kv.strip_prefix("expire="))
        .and_then(|v| v.parse().ok())
}

/// Caches resolved stream URLs and de-duplicates concurrent resolves.
#[derive(Default)]
pub struct StreamCache {
    /// video id -> (stream, valid-until unix seconds)
    entries: Mutex<HashMap<String, (StreamInfo, u64)>>,
    inflight: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl StreamCache {
    fn get(&self, id: &str) -> Option<StreamInfo> {
        let map = self.entries.lock().ok()?;
        let (info, valid_until) = map.get(id)?;
        (*valid_until > now_secs()).then(|| info.clone())
    }

    fn put(&self, id: &str, info: &StreamInfo) {
        let valid_until = match expire_of(&info.url) {
            Some(exp) => exp.saturating_sub(600),
            None => now_secs() + 3600,
        };
        if let Ok(mut map) = self.entries.lock() {
            let now = now_secs();
            map.retain(|_, (_, v)| *v > now);
            map.insert(id.to_string(), (info.clone(), valid_until));
        }
    }

    fn lock_for(&self, id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut map = self.inflight.lock().unwrap_or_else(|e| e.into_inner());
        map.entry(id.to_string()).or_default().clone()
    }

    fn release(&self, id: &str) {
        if let Ok(mut map) = self.inflight.lock() {
            map.remove(id);
        }
    }
}

/// Map raw yt-dlp stderr to a short, user-facing message.
fn friendly_error(stderr: &str) -> String {
    let s = stderr.to_lowercase();
    if s.contains("age-restricted") || s.contains("confirm your age") || s.contains("age restricted")
    {
        "This track is age-restricted".into()
    } else if s.contains("not available in your country")
        || s.contains("blocked it in your country")
        || s.contains("geo restrict")
        || s.contains("geo-restrict")
        || s.contains("your region")
    {
        "Not available in your region".into()
    } else if s.contains("video unavailable")
        || s.contains("private video")
        || s.contains("has been removed")
        || s.contains("no longer available")
        || s.contains("this video is not available")
        || s.contains("copyright")
    {
        "Video unavailable".into()
    } else if s.contains("unable to download")
        || s.contains("getaddrinfo")
        || s.contains("timed out")
        || s.contains("connection")
        || s.contains("network is unreachable")
        || s.contains("name or service not known")
        || s.contains("transporterror")
    {
        "Network problem \u{2014} check your connection".into()
    } else {
        "Couldn't load this track".into()
    }
}

/// Resolve a direct, progressive audio stream URL, using the cache.
pub async fn resolve_stream(
    app_data_dir: &Path,
    cache: &StreamCache,
    video_id: &str,
    force_refresh: bool,
) -> Result<StreamInfo, Error> {
    if !force_refresh {
        if let Some(hit) = cache.get(video_id) {
            return Ok(hit);
        }
    }

    let lock = cache.lock_for(video_id);
    let _guard = lock.lock().await;
    // A concurrent resolve of the same id may have filled the cache meanwhile.
    if !force_refresh {
        if let Some(hit) = cache.get(video_id) {
            return Ok(hit);
        }
    }

    let result = resolve_uncached(app_data_dir, video_id).await;
    if let Ok(info) = &result {
        cache.put(video_id, info);
    }
    cache.release(video_id);
    result
}

async fn resolve_uncached(app_data_dir: &Path, video_id: &str) -> Result<StreamInfo, Error> {
    let bin = ensure(app_data_dir).await?;
    let target = format!("https://music.youtube.com/watch?v={video_id}");

    let output = ytdlp_cmd(&bin)
        .args([
            "-f",
            "bestaudio[protocol^=http]/bestaudio",
            "--no-warnings",
            "--no-playlist",
            "--no-part",
            "--no-cache-dir",
            "-g",
            &target,
        ])
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!(
            "[melodi] yt-dlp failed for {video_id}: {}",
            truncate_lines(&stderr, 600)
        );
        return Err(Error::Msg(friendly_error(&stderr)));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let url = stdout.lines().next().unwrap_or("").trim().to_string();
    if url.is_empty() {
        return Err(Error::Msg("Couldn't load this track".into()));
    }

    let hls = url.contains("/api/manifest/") || url.contains(".m3u8");
    Ok(StreamInfo { url, hls })
}

pub async fn version_of(bin: &Path) -> Option<String> {
    let out = ytdlp_cmd(bin).arg("--version").output().await.ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        None
    }
}

/// Best-effort status report; never fails.
pub async fn status(app_data_dir: &Path) -> BackendStatus {
    match ensure(app_data_dir).await {
        Ok(bin) => BackendStatus {
            ytdlp_available: true,
            path: Some(bin.display().to_string()),
            version: version_of(&bin).await,
        },
        Err(e) => {
            eprintln!("[melodi] yt-dlp setup failed: {e}");
            BackendStatus {
                ytdlp_available: false,
                path: locate_with(app_data_dir).map(|p| p.display().to_string()),
                version: None,
            }
        }
    }
}

/// Keep at most `n` bytes of whole lines, never splitting a UTF-8 character.
fn truncate_lines(s: &str, n: usize) -> String {
    let mut out = String::new();
    for line in s.lines() {
        out.push_str(line);
        out.push('\n');
        if out.len() >= n {
            break;
        }
    }
    if out.len() > n {
        let mut cut = n;
        while !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_errors_and_parses_expiry() {
        assert_eq!(friendly_error("ERROR: Video unavailable"), "Video unavailable");
        assert_eq!(
            friendly_error("This video is age-restricted"),
            "This track is age-restricted"
        );
        assert_eq!(friendly_error("something odd"), "Couldn't load this track");
        assert_eq!(
            expire_of("https://x/videoplayback?a=1&expire=123&b=2"),
            Some(123)
        );
        assert!(truncate_lines("h\u{e9}llo\nw\u{f6}rld\n", 2).len() <= 2);
    }

    #[tokio::test]
    #[ignore = "requires network access"]
    async fn resolves_progressive_stream() {
        let dir = std::env::temp_dir().join("melodi-smoke");
        let cache = StreamCache::default();
        let info = resolve_stream(&dir, &cache, "1N8hOpMqvYs", false)
            .await
            .unwrap();
        println!("url_len={} hls={}", info.url.len(), info.hls);
        assert!(info.url.starts_with("https://"), "unexpected url: {}", info.url);
        assert!(!info.hls, "expected a progressive (non-HLS) stream");
        // Second call must come from the cache.
        let again = resolve_stream(&dir, &cache, "1N8hOpMqvYs", false)
            .await
            .unwrap();
        assert_eq!(info.url, again.url);
    }
}
