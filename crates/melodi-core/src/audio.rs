//! Audio relay + song cache, independent of any particular HTTP server.
//!
//! The player can't use YouTube's audio URLs directly (googlevideo sends no
//! CORS headers, so Web Audio would only hear silence, and the URLs are tied
//! to the IP that resolved them). Instead every song is played through
//! Melodi's own HTTP endpoint, which
//!   * forwards range requests to YouTube,
//!   * downloads the whole song into a disk cache in the background,
//!   * serves cached songs straight from disk (instant start, works offline),
//!   * turns live broadcasts (HLS) into one endless AAC stream (see live.rs).
//!
//! [`AudioStore::serve`] returns an [`AudioResponse`] (status, headers and a
//! body stream). The desktop app writes it to a tiny 127.0.0.1 server; the
//! web server hands it to axum. CORS and access control are the caller's job.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use bytes::Bytes;
use futures_util::{Stream, StreamExt, TryStreamExt};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::innertube::InnerTube;
use crate::live::{LiveError, LiveFeed};
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
pub const DEFAULT_LIMIT: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct Prepared {
    /// URL for the <audio> element.
    pub url: String,
    /// A live broadcast: endless, not seekable, never cached.
    pub live: bool,
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

/// Body of an [`AudioResponse`]: chunks pulled one at a time, so a paused
/// player (which stops reading) also pauses the upstream download.
pub type BodyStream = Pin<Box<dyn Stream<Item = std::io::Result<Bytes>> + Send>>;

pub struct AudioResponse {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    /// None for an empty body (errors, HEAD requests).
    pub body: Option<BodyStream>,
}

impl AudioResponse {
    fn empty(status: u16) -> Self {
        Self { status, headers: vec![("Content-Length", "0".into())], body: None }
    }
}

/// Byte range from a `Range` header: (start, inclusive end).
pub type Range = Option<(u64, Option<u64>)>;

#[derive(Clone)]
pub struct AudioStore {
    inner: Arc<Inner>,
}

struct Inner {
    /// Song cache folder.
    dir: PathBuf,
    /// App data folder (yt-dlp lives under it).
    data_dir: PathBuf,
    http: reqwest::Client,
    yt: Arc<InnerTube>,
    streams: Arc<StreamCache>,
    limit: AtomicU64,
    downloading: Mutex<HashSet<String>>,
    loudness: Mutex<HashMap<String, f32>>,
}

impl AudioStore {
    /// `cache_dir` holds the songs; `data_dir` is where yt-dlp is managed.
    /// Doesn't spawn anything, so it's safe to call outside a Tokio runtime.
    pub fn new(
        cache_dir: PathBuf,
        data_dir: PathBuf,
        yt: Arc<InnerTube>,
        streams: Arc<StreamCache>,
        limit_bytes: u64,
    ) -> Result<Self, Error> {
        std::fs::create_dir_all(&cache_dir)?;
        // Leftovers from a download that was interrupted last time.
        if let Ok(rd) = std::fs::read_dir(&cache_dir) {
            for e in rd.flatten() {
                if e.path().extension().is_some_and(|x| x == "part") {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
        let loudness = std::fs::read(cache_dir.join("loudness.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();

        Ok(Self {
            inner: Arc::new(Inner {
                dir: cache_dir,
                data_dir,
                http: reqwest::Client::builder()
                    .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")
                    .connect_timeout(Duration::from_secs(10))
                    .build()?,
                yt,
                streams,
                limit: AtomicU64::new(limit_bytes),
                downloading: Mutex::new(HashSet::new()),
                loudness: Mutex::new(loudness),
            }),
        })
    }

    /// Resolve a song (unless it's cached) and return its playback URL plus
    /// loudness. `url_for(live)` builds the caller's URL for this song.
    /// Resolution errors are returned so the UI can explain them.
    pub async fn prepare(
        &self,
        video_id: &str,
        force: bool,
        url_for: impl FnOnce(bool) -> String,
    ) -> Result<Prepared, Error> {
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
            return Ok(Prepared { url: url_for(false), live: false, loudness_db, cached: true });
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
        Ok(Prepared { url: url_for(info.hls), live: info.hls, loudness_db, cached: false })
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

    /// Cache size limit; 0 turns caching off. Evicts on a plain thread, so
    /// it works from sync code too.
    pub fn set_limit_bytes(&self, bytes: u64) {
        self.inner.limit.store(bytes, Ordering::Relaxed);
        let inner = self.inner.clone();
        std::thread::spawn(move || inner.evict());
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

    /// Answer a GET/HEAD for a song (`live` = the endless HLS-to-AAC stream).
    pub async fn serve(&self, id: &str, live: bool, range: Range, head_only: bool) -> AudioResponse {
        if !valid_id(id) {
            return AudioResponse::empty(403);
        }
        let inner = &self.inner;
        if live {
            return serve_live(inner, id, head_only).await;
        }

        // 1. From disk.
        if let Some((path, mime)) = inner.cached_file(id) {
            return serve_file(path, mime, range, head_only).await;
        }

        // 2. From YouTube, caching the whole song in the background.
        let Ok(info) = inner.resolve(id, false).await else {
            return AudioResponse::empty(502);
        };
        if info.hls {
            return AudioResponse::empty(415);
        }
        inner.clone().download_in_background(id.to_string(), info.url.clone());
        serve_upstream(inner, id, info.url, range, head_only).await
    }
}

impl Inner {
    async fn resolve(&self, id: &str, force: bool) -> Result<StreamInfo, Error> {
        ytdlp::resolve_stream(&self.data_dir, &self.streams, id, force).await
    }

    async fn fetch_loudness(&self, id: &str, timeout: Duration) -> Option<f32> {
        let l = tokio::time::timeout(timeout, self.yt.loudness(id)).await.ok()?.ok()??;
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
        tokio::spawn(async move {
            if let Err(e) = self.download(&id, url).await {
                eprintln!("[melodi] caching {id} failed: {e}");
            }
            if let Ok(mut d) = self.downloading.lock() {
                d.remove(&id);
            }
            let me = self.clone();
            let _ = tokio::task::spawn_blocking(move || me.evict()).await;
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
        Ok(())
    }
}

// ---- responses ---------------------------------------------------------------

pub fn parse_range(v: &str) -> Range {
    let spec = v.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (a, b) = spec.split_once('-')?;
    let start = a.trim().parse().ok()?;
    let end = if b.trim().is_empty() { None } else { Some(b.trim().parse().ok()?) };
    Some((start, end))
}

/// Follow a live broadcast and stream it as one endless AAC response.
async fn serve_live(inner: &Arc<Inner>, id: &str, head_only: bool) -> AudioResponse {
    let headers = vec![("Content-Type", "audio/aac".to_string()), ("Cache-Control", "no-store".into())];
    if head_only {
        return AudioResponse { status: 200, headers, body: None };
    }
    let url = match inner.resolve(id, false).await {
        Ok(info) if info.hls => info.url,
        _ => return AudioResponse::empty(502),
    };
    let mut feed = LiveFeed::new(inner.http.clone(), url);
    // Wait for the first chunk so a dead stream can still answer 502.
    let mut refreshes = 0;
    let first = loop {
        match feed.next_chunk(Duration::from_secs(30)).await {
            Ok(Some(chunk)) => break chunk,
            Err(LiveError::Expired) if refreshes < 2 => {
                refreshes += 1;
                match inner.resolve(id, true).await {
                    Ok(info) if info.hls => feed.set_url(info.url),
                    _ => return AudioResponse::empty(502),
                }
            }
            Ok(None) | Err(_) => return AudioResponse::empty(502),
        }
    };

    struct St {
        inner: Arc<Inner>,
        id: String,
        feed: LiveFeed,
        first: Option<Vec<u8>>,
    }
    let st = St { inner: inner.clone(), id: id.to_string(), feed, first: Some(first) };
    let body = futures_util::stream::unfold(st, |mut st| async move {
        if let Some(c) = st.first.take() {
            return Some((Ok(Bytes::from(c)), st));
        }
        // Re-resolves allowed in a row before giving up (reset by every chunk).
        let mut refreshes = 0;
        loop {
            match st.feed.next_chunk(Duration::from_secs(30)).await {
                Ok(Some(chunk)) => return Some((Ok(Bytes::from(chunk)), st)),
                Ok(None) => return None,
                Err(LiveError::Expired) if refreshes < 2 => {
                    refreshes += 1;
                    match st.inner.resolve(&st.id, true).await {
                        Ok(info) if info.hls => st.feed.set_url(info.url),
                        _ => return None,
                    }
                }
                Err(e) => {
                    eprintln!("[melodi] live stream {} stopped: {e:?}", st.id);
                    return None;
                }
            }
        }
    });
    AudioResponse { status: 200, headers, body: Some(Box::pin(body)) }
}

/// Work out the byte span to send. Returns (start, end inclusive, partial).
fn span(range: Range, total: u64) -> Option<(u64, u64, bool)> {
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

fn ranged(mime: &str, start: u64, end: u64, total: u64, partial: bool, body: Option<BodyStream>) -> AudioResponse {
    let mut headers = vec![
        ("Content-Type", mime.to_string()),
        ("Content-Length", (end - start + 1).to_string()),
        ("Accept-Ranges", "bytes".into()),
        ("Cache-Control", "no-store".into()),
    ];
    if partial {
        headers.push(("Content-Range", format!("bytes {start}-{end}/{total}")));
    }
    AudioResponse { status: if partial { 206 } else { 200 }, headers, body }
}

fn not_satisfiable(total: u64) -> AudioResponse {
    AudioResponse {
        status: 416,
        headers: vec![("Content-Range", format!("bytes */{total}")), ("Content-Length", "0".into())],
        body: None,
    }
}

async fn serve_file(path: PathBuf, mime: &str, range: Range, head_only: bool) -> AudioResponse {
    let Ok(mut f) = tokio::fs::File::open(&path).await else {
        return AudioResponse::empty(404);
    };
    let Ok(total) = f.metadata().await.map(|m| m.len()) else {
        return AudioResponse::empty(500);
    };
    // Mark as recently played so eviction keeps it.
    if let Ok(std_f) = std::fs::File::options().write(true).open(&path) {
        let _ = std_f.set_modified(SystemTime::now());
    }
    let Some((start, end, partial)) = span(range, total) else {
        return not_satisfiable(total);
    };
    if head_only {
        return ranged(mime, start, end, total, partial, None);
    }
    if f.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return AudioResponse::empty(500);
    }
    let reader = f.take(end - start + 1);
    let body = tokio_util::io::ReaderStream::with_capacity(reader, 64 * 1024);
    ranged(mime, start, end, total, partial, Some(Box::pin(body)))
}

async fn serve_upstream(
    inner: &Arc<Inner>,
    id: &str,
    mut url: String,
    range: Range,
    head_only: bool,
) -> AudioResponse {
    let (_, mime) = mime_of(&url);
    let Some(total) = clen_of(&url) else {
        return AudioResponse::empty(502);
    };
    let Some((start, end, partial)) = span(range, total) else {
        return not_satisfiable(total);
    };
    if head_only {
        return ranged(mime, start, end, total, partial, None);
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
    let Some(resp) = resp else {
        return AudioResponse::empty(502);
    };
    let body = resp.bytes_stream().map_err(std::io::Error::other).boxed();
    ranged(mime, start, end, total, partial, Some(body))
}

// ---- helpers -----------------------------------------------------------------

pub fn valid_id(id: &str) -> bool {
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
