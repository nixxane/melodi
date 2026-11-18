//! Local audio proxy + offline cache.
//!
//! The webview can't process YouTube's audio directly (googlevideo sends no
//! CORS headers, so Web Audio would only hear silence). Instead every song is
//! played through a tiny HTTP server on 127.0.0.1 that
//!   * forwards range requests to YouTube and adds CORS headers,
//!   * downloads the whole song into a disk cache in the background, and
//!   * serves cached songs straight from disk (instant start, works offline).
//!
//! Requests must carry a random per-run key, so other local programs and web
//! pages can't use the server.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::innertube::InnerTube;
use crate::ytdlp::{self, StreamCache, StreamInfo};
use crate::Error;

/// Largest slice returned for an open-ended range ("bytes=N-"). The player
/// simply asks for the next slice; small slices keep seeking snappy.
const SLICE: u64 = 2 * 1024 * 1024;
/// Background downloads fetch the song in chunks of this size (YouTube
/// throttles single large requests).
const CHUNK: u64 = 4 * 1024 * 1024;
/// Songs bigger than this (hour-long mixes) are streamed but not cached.
const MAX_CACHED_FILE: u64 = 200 * 1024 * 1024;
const DEFAULT_LIMIT: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct Prepared {
    /// URL for the <audio> element.
    pub url: String,
    pub hls: bool,
    /// YouTube's loudness for the song in dB relative to its reference level
    /// (positive = louder than the target). None if unknown.
    pub loudness_db: Option<f32>,
    /// Already on disk: plays instantly and offline.
    pub cached: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CacheInfo {
    pub bytes: u64,
    pub songs: u64,
    pub limit_bytes: u64,
}

pub struct AudioServer {
    port: u16,
    key: String,
    inner: Arc<Inner>,
}

struct Inner {
    app: AppHandle,
    dir: PathBuf,
    http: reqwest::Client,
    limit: AtomicU64,
    downloading: Mutex<HashSet<String>>,
    loudness: Mutex<HashMap<String, f32>>,
}

impl AudioServer {
    /// Bind the server and start accepting connections.
    pub fn start(app: &AppHandle) -> Result<Self, Error> {
        let base = app
            .path()
            .app_cache_dir()
            .map_err(|e| Error::Msg(format!("no cache dir: {e}")))?;
        let dir = base.join("audio");
        std::fs::create_dir_all(&dir)?;
        // Leftovers from a download that was interrupted last time.
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                if e.path().extension().is_some_and(|x| x == "part") {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
        let loudness = std::fs::read(dir.join("loudness.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();

        let std_listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        std_listener.set_nonblocking(true)?;
        let port = std_listener.local_addr()?.port();

        let inner = Arc::new(Inner {
            app: app.clone(),
            dir,
            http: reqwest::Client::builder()
                .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")
                .connect_timeout(Duration::from_secs(10))
                .build()?,
            limit: AtomicU64::new(DEFAULT_LIMIT),
            downloading: Mutex::new(HashSet::new()),
            loudness: Mutex::new(loudness),
        });

        let srv = inner.clone();
        let key = random_key();
        let k = key.clone();
        tauri::async_runtime::spawn(async move {
            let listener = match TcpListener::from_std(std_listener) {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("[melodi] audio server failed: {e}");
                    return;
                }
            };
            loop {
                let Ok((sock, _)) = listener.accept().await else { continue };
                let srv = srv.clone();
                let k = k.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = handle(sock, &srv, &k).await;
                });
            }
        });

        Ok(Self { port, key, inner })
    }

    fn url_for(&self, id: &str) -> String {
        format!("http://127.0.0.1:{}/a/{id}?k={}", self.port, self.key)
    }

    /// Resolve a song (unless it's cached) and return the proxy URL plus its
    /// loudness. Resolution errors are returned so the UI can explain them.
    pub async fn prepare(&self, video_id: &str, force: bool) -> Result<Prepared, Error> {
        if !valid_id(video_id) {
            return Err(Error::Msg("invalid video id".into()));
        }
        let inner = &self.inner;
        let cached = !force && inner.cached_file(video_id).is_some();
        let known = inner.loudness.lock().ok().and_then(|m| m.get(video_id).copied());

        if cached {
            let loudness_db = match known {
                Some(l) => Some(l),
                None => inner.fetch_loudness(video_id, Duration::from_millis(1200)).await,
            };
            return Ok(Prepared { url: self.url_for(video_id), hls: false, loudness_db, cached: true });
        }

        let resolve = inner.resolve(video_id, force);
        let loud = async {
            match known {
                Some(l) => Some(l),
                None => inner.fetch_loudness(video_id, Duration::from_secs(3)).await,
            }
        };
        let (info, loudness_db) = tokio::join!(resolve, loud);
        let info = info?;
        if info.hls {
            return Ok(Prepared { url: info.url, hls: true, loudness_db, cached: false });
        }
        Ok(Prepared { url: self.url_for(video_id), hls: false, loudness_db, cached: false })
    }

    /// Download the song into the cache ahead of time (used for "up next").
    pub async fn prefetch(&self, video_id: &str) {
        if !valid_id(video_id) || self.inner.cached_file(video_id).is_some() {
            return;
        }
        if let Ok(info) = self.inner.resolve(video_id, false).await {
            if !info.hls {
                self.inner.clone().download_in_background(video_id.to_string(), info.url);
            }
        }
        if self.inner.loudness.lock().ok().is_some_and(|m| !m.contains_key(video_id)) {
            self.inner.fetch_loudness(video_id, Duration::from_secs(5)).await;
        }
    }

    pub fn set_limit_mb(&self, mb: u64) {
        self.inner.limit.store(mb * 1024 * 1024, Ordering::Relaxed);
        let inner = self.inner.clone();
        tauri::async_runtime::spawn_blocking(move || inner.evict());
    }

    pub fn info(&self) -> CacheInfo {
        let (bytes, songs) = self.inner.usage();
        CacheInfo { bytes, songs, limit_bytes: self.inner.limit.load(Ordering::Relaxed) }
    }

    pub fn clear(&self) {
        for (path, _, _) in self.inner.files() {
            let _ = std::fs::remove_file(path);
        }
    }
}

impl Inner {
    async fn resolve(&self, id: &str, force: bool) -> Result<StreamInfo, Error> {
        let dir = self.app.path().app_data_dir().map_err(|e| Error::Msg(e.to_string()))?;
        let cache = self.app.state::<StreamCache>();
        ytdlp::resolve_stream(&dir, &cache, id, force).await
    }

    async fn fetch_loudness(&self, id: &str, timeout: Duration) -> Option<f32> {
        let it = self.app.state::<InnerTube>();
        let l = tokio::time::timeout(timeout, it.loudness(id)).await.ok()?.ok()??;
        if let Ok(mut m) = self.loudness.lock() {
            m.insert(id.to_string(), l);
            if m.len() > 20_000 {
                m.clear(); // crude bound; values are cheap to fetch again
            }
            if let Ok(json) = serde_json::to_vec(&*m) {
                let _ = std::fs::write(self.dir.join("loudness.json"), json);
            }
        }
        Some(l)
    }

    /// A finished cache file for `id`, if there is one.
    fn cached_file(&self, id: &str) -> Option<(PathBuf, &'static str)> {
        for (ext, mime) in [("webm", "audio/webm"), ("m4a", "audio/mp4")] {
            let p = self.dir.join(format!("{id}.{ext}"));
            if p.is_file() {
                return Some((p, mime));
            }
        }
        None
    }

    /// Finished cache files: (path, size, last used).
    fn files(&self) -> Vec<(PathBuf, u64, SystemTime)> {
        let Ok(rd) = std::fs::read_dir(&self.dir) else { return vec![] };
        rd.flatten()
            .filter(|e| {
                e.path()
                    .extension()
                    .is_some_and(|x| x == "webm" || x == "m4a")
            })
            .filter_map(|e| {
                let m = e.metadata().ok()?;
                Some((e.path(), m.len(), m.modified().unwrap_or(SystemTime::UNIX_EPOCH)))
            })
            .collect()
    }

    fn usage(&self) -> (u64, u64) {
        let f = self.files();
        (f.iter().map(|x| x.1).sum(), f.len() as u64)
    }

    /// Delete least recently played songs until the cache fits its limit.
    fn evict(&self) {
        let limit = self.limit.load(Ordering::Relaxed);
        let mut files = self.files();
        let mut total: u64 = files.iter().map(|x| x.1).sum();
        if total <= limit {
            return;
        }
        files.sort_by_key(|x| x.2);
        for (path, size, _) in files {
            if total <= limit {
                break;
            }
            if std::fs::remove_file(&path).is_ok() {
                total = total.saturating_sub(size);
            }
        }
    }

    fn download_in_background(self: Arc<Self>, id: String, url: String) {
        if self.limit.load(Ordering::Relaxed) == 0 {
            return;
        }
        {
            let Ok(mut d) = self.downloading.lock() else { return };
            if !d.insert(id.clone()) {
                return;
            }
        }
        tauri::async_runtime::spawn(async move {
            if let Err(e) = self.download(&id, url).await {
                eprintln!("[melodi] caching {id} failed: {e}");
            }
            if let Ok(mut d) = self.downloading.lock() {
                d.remove(&id);
            }
        });
    }

    async fn download(&self, id: &str, mut url: String) -> Result<(), Error> {
        let (ext, _) = mime_of(&url);
        let Some(total) = clen_of(&url) else {
            return Err(Error::Msg("unknown size".into()));
        };
        if total == 0 || total > MAX_CACHED_FILE {
            return Ok(());
        }
        let part = self.dir.join(format!("{id}.{ext}.part"));
        let mut file = tokio::fs::File::create(&part).await?;
        let mut pos = 0u64;
        let mut refreshed = false;
        while pos < total {
            let end = (pos + CHUNK).min(total) - 1;
            let resp = self
                .http
                .get(&url)
                .header("Range", format!("bytes={pos}-{end}"))
                .timeout(Duration::from_secs(60))
                .send()
                .await?;
            if resp.status() == reqwest::StatusCode::FORBIDDEN && !refreshed {
                // The signed URL expired: resolve a fresh one and carry on.
                refreshed = true;
                url = self.resolve(id, true).await?.url;
                continue;
            }
            if resp.status() != reqwest::StatusCode::PARTIAL_CONTENT {
                drop(file);
                let _ = tokio::fs::remove_file(&part).await;
                return Err(Error::Msg(format!("upstream returned {}", resp.status())));
            }
            let bytes = resp.bytes().await?;
            if bytes.is_empty() {
                break;
            }
            file.write_all(&bytes).await?;
            pos += bytes.len() as u64;
        }
        file.flush().await?;
        drop(file);
        if pos != total {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(Error::Msg("incomplete download".into()));
        }
        tokio::fs::rename(&part, self.dir.join(format!("{id}.{ext}"))).await?;
        let me = self.app.state::<AudioServer>().inner.clone();
        tauri::async_runtime::spawn_blocking(move || me.evict());
        Ok(())
    }
}

// ---- HTTP ------------------------------------------------------------------

struct Request {
    method: String,
    path: String,
    query: String,
    range: Option<(u64, Option<u64>)>,
}

async fn read_request(sock: &mut TcpStream) -> Option<Request> {
    let mut buf = Vec::with_capacity(1024);
    let mut tmp = [0u8; 1024];
    loop {
        let n = tokio::time::timeout(Duration::from_secs(10), sock.read(&mut tmp)).await.ok()?.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buf.len() > 16 * 1024 {
            return None;
        }
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let method = first.next()?.to_string();
    let target = first.next()?;
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let mut range = None;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("range") {
                range = parse_range(v.trim());
            }
        }
    }
    Some(Request { method, path: path.to_string(), query: query.to_string(), range })
}

fn parse_range(v: &str) -> Option<(u64, Option<u64>)> {
    let spec = v.strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (a, b) = spec.split_once('-')?;
    let start = a.trim().parse().ok()?;
    let end = if b.trim().is_empty() { None } else { Some(b.trim().parse().ok()?) };
    Some((start, end))
}

const CORS: &str = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Range\r\nAccess-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n";

async fn simple(sock: &mut TcpStream, status: &str) -> std::io::Result<()> {
    let head = format!("HTTP/1.1 {status}\r\n{CORS}Content-Length: 0\r\nConnection: close\r\n\r\n");
    sock.write_all(head.as_bytes()).await
}

async fn handle(mut sock: TcpStream, inner: &Arc<Inner>, key: &str) -> std::io::Result<()> {
    let Some(req) = read_request(&mut sock).await else { return Ok(()) };
    if req.method == "OPTIONS" {
        return simple(&mut sock, "204 No Content").await;
    }
    let id = req.path.strip_prefix("/a/").unwrap_or("");
    let key_ok = req.query.split('&').any(|p| p == format!("k={key}"));
    if !key_ok || !valid_id(id) {
        return simple(&mut sock, "403 Forbidden").await;
    }
    let head_only = req.method == "HEAD";
    if req.method != "GET" && !head_only {
        return simple(&mut sock, "405 Method Not Allowed").await;
    }

    // 1. From disk.
    if let Some((path, mime)) = inner.cached_file(id) {
        return serve_file(&mut sock, &path, mime, req.range, head_only).await;
    }

    // 2. From YouTube, caching the whole song in the background.
    let Ok(info) = inner.resolve(id, false).await else {
        return simple(&mut sock, "502 Bad Gateway").await;
    };
    if info.hls {
        return simple(&mut sock, "415 Unsupported Media Type").await;
    }
    inner.clone().download_in_background(id.to_string(), info.url.clone());
    serve_upstream(&mut sock, inner, id, info.url, req.range, head_only).await
}

/// Work out the byte span to send. Returns (start, end inclusive, partial).
fn span(range: Option<(u64, Option<u64>)>, total: u64) -> Option<(u64, u64, bool)> {
    match range {
        None => Some((0, total.checked_sub(1)?, false)),
        Some((start, end)) => {
            if start >= total {
                return None;
            }
            let end = match end {
                Some(e) => e.min(total - 1),
                None => (start + SLICE - 1).min(total - 1),
            };
            (end >= start).then_some((start, end, true))
        }
    }
}

fn head(mime: &str, start: u64, end: u64, total: u64, partial: bool) -> String {
    let len = end - start + 1;
    let status = if partial { "206 Partial Content" } else { "200 OK" };
    let range = if partial { format!("Content-Range: bytes {start}-{end}/{total}\r\n") } else { String::new() };
    format!(
        "HTTP/1.1 {status}\r\n{CORS}Content-Type: {mime}\r\nContent-Length: {len}\r\n{range}Accept-Ranges: bytes\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
    )
}

async fn not_satisfiable(sock: &mut TcpStream, total: u64) -> std::io::Result<()> {
    let h = format!("HTTP/1.1 416 Range Not Satisfiable\r\n{CORS}Content-Range: bytes */{total}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    sock.write_all(h.as_bytes()).await
}

async fn serve_file(
    sock: &mut TcpStream,
    path: &Path,
    mime: &str,
    range: Option<(u64, Option<u64>)>,
    head_only: bool,
) -> std::io::Result<()> {
    let mut f = tokio::fs::File::open(path).await?;
    let total = f.metadata().await?.len();
    // Mark as recently played so eviction keeps it.
    if let Ok(std_f) = std::fs::File::options().write(true).open(path) {
        let _ = std_f.set_modified(SystemTime::now());
    }
    let Some((start, end, partial)) = span(range, total) else {
        return not_satisfiable(sock, total).await;
    };
    sock.write_all(head(mime, start, end, total, partial).as_bytes()).await?;
    if head_only {
        return Ok(());
    }
    f.seek(std::io::SeekFrom::Start(start)).await?;
    let mut left = end - start + 1;
    let mut buf = vec![0u8; 64 * 1024];
    while left > 0 {
        let want = left.min(buf.len() as u64) as usize;
        let n = f.read(&mut buf[..want]).await?;
        if n == 0 {
            break;
        }
        sock.write_all(&buf[..n]).await?;
        left -= n as u64;
    }
    Ok(())
}

async fn serve_upstream(
    sock: &mut TcpStream,
    inner: &Arc<Inner>,
    id: &str,
    mut url: String,
    range: Option<(u64, Option<u64>)>,
    head_only: bool,
) -> std::io::Result<()> {
    let (_, mime) = mime_of(&url);
    let Some(total) = clen_of(&url) else {
        return simple(sock, "502 Bad Gateway").await;
    };
    let Some((start, end, partial)) = span(range, total) else {
        return not_satisfiable(sock, total).await;
    };
    if head_only {
        return sock.write_all(head(mime, start, end, total, partial).as_bytes()).await;
    }

    let mut resp = None;
    for attempt in 0..2 {
        let r = inner
            .http
            .get(&url)
            .header("Range", format!("bytes={start}-{end}"))
            .send()
            .await;
        match r {
            Ok(r) if r.status() == reqwest::StatusCode::PARTIAL_CONTENT => {
                resp = Some(r);
                break;
            }
            Ok(r) if r.status() == reqwest::StatusCode::FORBIDDEN && attempt == 0 => {
                match inner.resolve(id, true).await {
                    Ok(info) => url = info.url,
                    Err(_) => break,
                }
            }
            _ => break,
        }
    }
    let Some(mut resp) = resp else {
        return simple(sock, "502 Bad Gateway").await;
    };

    sock.write_all(head(mime, start, end, total, partial).as_bytes()).await?;
    while let Ok(Some(chunk)) = resp.chunk().await {
        sock.write_all(&chunk).await?;
    }
    Ok(())
}

// ---- helpers -----------------------------------------------------------------

fn valid_id(id: &str) -> bool {
    id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn query_param<'a>(url: &'a str, name: &str) -> Option<&'a str> {
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|p| p.strip_prefix(name)?.strip_prefix('='))
}

fn clen_of(url: &str) -> Option<u64> {
    query_param(url, "clen")?.parse().ok()
}

/// (cache file extension, content type) from the stream URL.
fn mime_of(url: &str) -> (&'static str, &'static str) {
    match query_param(url, "mime") {
        Some(m) if m.contains("mp4") => ("m4a", "audio/mp4"),
        _ => ("webm", "audio/webm"),
    }
}

/// 128-bit key from the OS-seeded hasher keys (std's RandomState draws them
/// from the system RNG), so no extra crate is needed.
fn random_key() -> String {
    use std::hash::{BuildHasher, Hasher};
    let part = || {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        h.finish()
    };
    format!("{:016x}{:016x}", part(), part())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-"), Some((0, None)));
        assert_eq!(parse_range("bytes=10-20"), Some((10, Some(20))));
        assert_eq!(parse_range("bytes=1-2,4-5"), None);
        assert_eq!(span(Some((0, None)), 10), Some((0, 9, true)));
        assert_eq!(span(Some((0, None)), SLICE * 3), Some((0, SLICE - 1, true)));
        assert_eq!(span(Some((5, Some(100))), 10), Some((5, 9, true)));
        assert_eq!(span(Some((10, None)), 10), None);
        assert_eq!(span(None, 10), Some((0, 9, false)));
    }

    #[test]
    fn url_params() {
        let u = "https://x/videoplayback?expire=1&mime=audio%2Fwebm&clen=3433755&c=WEB";
        assert_eq!(clen_of(u), Some(3433755));
        assert_eq!(mime_of(u), ("webm", "audio/webm"));
        assert_eq!(mime_of("https://x/v?mime=audio%2Fmp4"), ("m4a", "audio/mp4"));
        assert!(valid_id("dQw4w9WgXcQ"));
        assert!(!valid_id("../etc/pass"));
    }
}
