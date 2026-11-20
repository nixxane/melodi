//! The desktop app's tiny HTTP server on 127.0.0.1 that plays songs through
//! [`AudioStore`] (relay + offline cache, see melodi-core's audio.rs).
//!
//! Requests must carry a random per-run key, so other local programs and web
//! pages can't use the server.

use std::time::{Duration, SystemTime};

use futures_util::StreamExt;
use melodi_core::audio::{self, AudioResponse, AudioStore, Prepared};
use melodi_core::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub struct AudioServer {
    port: u16,
    key: String,
    pub store: AudioStore,
}

impl AudioServer {
    /// Bind the server and start accepting connections.
    pub fn start(store: AudioStore) -> Result<Self, Error> {
        let std_listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        std_listener.set_nonblocking(true)?;
        let port = std_listener.local_addr()?.port();

        let key = random_key();
        let (srv, k) = (store.clone(), key.clone());
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
                let (srv, k) = (srv.clone(), k.clone());
                tauri::async_runtime::spawn(async move {
                    let _ = handle(sock, &srv, &k).await;
                });
            }
        });

        Ok(Self { port, key, store })
    }

    pub async fn prepare(&self, video_id: &str, force: bool) -> Result<Prepared, Error> {
        let (port, key) = (self.port, &self.key);
        self.store
            .prepare(video_id, force, |live| {
                let kind = if live { "live" } else { "a" };
                format!("http://127.0.0.1:{port}/{kind}/{video_id}?k={key}")
            })
            .await
    }
}

struct Request {
    method: String,
    path: String,
    query: String,
    range: audio::Range,
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
                range = audio::parse_range(v);
            }
        }
    }
    Some(Request { method, path: path.to_string(), query: query.to_string(), range })
}

const CORS: &str = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Range\r\nAccess-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n";

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        206 => "Partial Content",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        415 => "Unsupported Media Type",
        416 => "Range Not Satisfiable",
        502 => "Bad Gateway",
        _ => "Error",
    }
}

async fn write_response(sock: &mut TcpStream, resp: AudioResponse) -> std::io::Result<()> {
    let mut head = format!("HTTP/1.1 {} {}\r\n{CORS}", resp.status, reason(resp.status));
    for (k, v) in &resp.headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("Connection: close\r\n\r\n");
    sock.write_all(head.as_bytes()).await?;
    if let Some(mut body) = resp.body {
        // Blocks while the player is paused; errors once it lets go.
        while let Some(chunk) = body.next().await {
            sock.write_all(&chunk?).await?;
        }
    }
    Ok(())
}

async fn simple(sock: &mut TcpStream, status: u16) -> std::io::Result<()> {
    write_response(sock, AudioResponse { status, headers: vec![("Content-Length", "0".into())], body: None }).await
}

async fn handle(mut sock: TcpStream, store: &AudioStore, key: &str) -> std::io::Result<()> {
    let Some(req) = read_request(&mut sock).await else { return Ok(()) };
    if req.method == "OPTIONS" {
        return simple(&mut sock, 204).await;
    }
    let (live, id) = match req.path.strip_prefix("/live/") {
        Some(id) => (true, id),
        None => (false, req.path.strip_prefix("/a/").unwrap_or("")),
    };
    let key_ok = req.query.split('&').any(|p| p == format!("k={key}"));
    if !key_ok {
        return simple(&mut sock, 403).await;
    }
    let head_only = req.method == "HEAD";
    if req.method != "GET" && !head_only {
        return simple(&mut sock, 405).await;
    }
    let resp = store.serve(id, live, req.range, head_only).await;
    write_response(&mut sock, resp).await
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
