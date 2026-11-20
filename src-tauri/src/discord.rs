//! Discord Rich Presence over Discord's local IPC socket.
//!
//! The protocol is tiny: frames of `[opcode u32 LE][len u32 LE][json]` over a
//! named pipe (Windows) or Unix socket. We handshake with the app's client id
//! and then send `SET_ACTIVITY` commands. Nothing leaves the machine except
//! through the user's own Discord client.
//!
//! A worker thread owns the connection. Updates are coalesced (only the latest
//! matters) and spaced out to respect Discord's ~5 updates / 20 s limit.

use std::io::{Read, Write};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

/// Discord application id (from https://discord.com/developers/applications).
/// The application's name is shown on the profile card. Not a secret.
/// Can be overridden with the `MELODI_DISCORD_CLIENT_ID` environment variable.
const CLIENT_ID: &str = "1572617750973780049";

/// Discord allows about 5 activity updates per 20 seconds. Within that budget
/// updates go out immediately; beyond it only the newest state is kept.
const BURST: usize = 5;
const WINDOW: Duration = Duration::from_secs(20);
/// Gather changes that arrive together (new track + duration + position)
/// into one update instead of spending several.
const SETTLE: Duration = Duration::from_millis(150);
/// Don't retry connecting to Discord more often than this.
const RECONNECT_EVERY: Duration = Duration::from_secs(15);

/// What the frontend sends: the current track, or nothing to clear.
#[derive(Debug, Clone, Deserialize)]
pub struct Presence {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub image: Option<String>,
    pub video_id: Option<String>,
    /// Playback position and length, in milliseconds.
    pub position_ms: u64,
    pub duration_ms: Option<u64>,
}

pub struct Discord {
    tx: Option<Sender<Option<Presence>>>,
}

impl Discord {
    pub fn start() -> Self {
        let id = std::env::var("MELODI_DISCORD_CLIENT_ID")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| CLIENT_ID.to_string());
        if id.trim().is_empty() {
            return Self { tx: None };
        }
        let (tx, rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("discord-rpc".into())
            .spawn(move || worker(id, rx))
            .ok();
        Self { tx: Some(tx) }
    }

    pub fn enabled(&self) -> bool {
        self.tx.is_some()
    }

    /// Queue an update (`None` clears the activity). Never blocks.
    pub fn update(&self, p: Option<Presence>) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(p);
        }
    }
}

/// Sliding-window limiter: at most `BURST` sends per `WINDOW`.
struct Limiter {
    sent: std::collections::VecDeque<Instant>,
}

impl Limiter {
    /// How long until another send is allowed (zero = now).
    fn wait(&mut self) -> Duration {
        while self.sent.front().is_some_and(|t| t.elapsed() >= WINDOW) {
            self.sent.pop_front();
        }
        if self.sent.len() < BURST {
            Duration::ZERO
        } else {
            WINDOW.saturating_sub(self.sent.front().unwrap().elapsed())
        }
    }

    fn record(&mut self) {
        self.sent.push_back(Instant::now());
    }
}

fn worker(client_id: String, rx: Receiver<Option<Presence>>) {
    let mut conn: Option<Conn> = None;
    let mut last_connect: Option<Instant> = None;
    let mut limiter = Limiter { sent: Default::default() };
    // Latest wanted state not yet delivered. Outer None = nothing pending.
    let mut pending: Option<Option<Presence>> = None;

    loop {
        // Idle until news arrives; with something pending, wake when allowed.
        let wait = if pending.is_some() {
            limiter.wait().max(Duration::from_millis(20))
        } else {
            Duration::from_secs(3600)
        };
        match rx.recv_timeout(wait) {
            Ok(p) => {
                pending = Some(p);
                // Let related changes land, then keep only the newest state.
                std::thread::sleep(SETTLE);
                while let Ok(p) = rx.try_recv() {
                    pending = Some(p);
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        if pending.is_none() || !limiter.wait().is_zero() {
            continue;
        }

        if conn.is_none() {
            if last_connect.is_some_and(|t| t.elapsed() < RECONNECT_EVERY) {
                continue; // Discord not running; try again later.
            }
            last_connect = Some(Instant::now());
            conn = Conn::open(&client_id);
            if conn.is_none() {
                continue;
            }
        }

        let p = pending.take().unwrap();
        let ok = conn.as_mut().is_some_and(|c| c.set_activity(p.as_ref()).is_ok());
        limiter.record();
        if !ok {
            // Discord closed: reconnect next time and resend this state.
            conn = None;
            last_connect = None;
            pending = Some(p);
        }
    }
}

/// Build the activity JSON: "Listening to <artist>" with the song as details.
fn activity(p: &Presence) -> Value {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let start = now_ms.saturating_sub(p.position_ms);

    let mut a = json!({
        "type": 2,                 // Listening
        "status_display_type": 1,  // status line shows `state`: "Listening to <artist>"
        "details": field(&p.title),
        "state": field(&p.artist),
        "timestamps": { "start": start },
        "assets": {
            "large_text": field(p.album.as_deref().unwrap_or(&p.title)),
            "small_text": "via Melodi",
        },
        "instance": false,
    });
    if let Some(d) = p.duration_ms.filter(|d| *d > 0) {
        a["timestamps"]["end"] = json!(start + d);
    }
    if let Some(img) = p.image.as_deref().filter(|u| u.starts_with("https://")) {
        a["assets"]["large_image"] = json!(img);
    }
    if let Some(id) = &p.video_id {
        a["buttons"] = json!([{
            "label": "Play on YouTube Music",
            "url": format!("https://music.youtube.com/watch?v={id}"),
        }]);
    }
    a
}

/// Discord requires 2..=128 characters for text fields.
fn field(s: &str) -> String {
    let mut t: String = s.trim().chars().take(128).collect();
    while t.chars().count() < 2 {
        t.push(' ');
    }
    t
}

// ---- IPC transport -----------------------------------------------------------

#[cfg(windows)]
type Stream = std::fs::File;
#[cfg(unix)]
type Stream = std::os::unix::net::UnixStream;

struct Conn {
    s: Stream,
    nonce: u64,
}

impl Conn {
    fn open(client_id: &str) -> Option<Self> {
        for i in 0..10 {
            let Some(s) = connect(i) else { continue };
            let mut c = Conn { s, nonce: 0 };
            let hello = json!({ "v": 1, "client_id": client_id });
            if c.send(0, &hello).is_ok() {
                if let Ok((_, v)) = c.recv() {
                    if v.get("evt").and_then(|e| e.as_str()) == Some("READY") {
                        return Some(c);
                    }
                }
            }
        }
        None
    }

    fn set_activity(&mut self, p: Option<&Presence>) -> std::io::Result<()> {
        self.nonce += 1;
        let cmd = json!({
            "cmd": "SET_ACTIVITY",
            "args": { "pid": std::process::id(), "activity": p.map(activity) },
            "nonce": self.nonce.to_string(),
        });
        self.send(1, &cmd)?;
        // Read (and ignore) the reply so the pipe never fills up.
        let (_, reply) = self.recv()?;
        if reply.get("evt").and_then(|e| e.as_str()) == Some("ERROR") {
            eprintln!("discord: {}", reply.get("data").unwrap_or(&Value::Null));
        }
        Ok(())
    }

    fn send(&mut self, op: u32, v: &Value) -> std::io::Result<()> {
        let body = serde_json::to_vec(v)?;
        let mut frame = Vec::with_capacity(8 + body.len());
        frame.extend_from_slice(&op.to_le_bytes());
        frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
        frame.extend_from_slice(&body);
        self.s.write_all(&frame)?;
        self.s.flush()
    }

    fn recv(&mut self) -> std::io::Result<(u32, Value)> {
        let mut head = [0u8; 8];
        self.s.read_exact(&mut head)?;
        let op = u32::from_le_bytes(head[0..4].try_into().unwrap());
        let len = u32::from_le_bytes(head[4..8].try_into().unwrap()) as usize;
        if len > 1 << 20 {
            return Err(std::io::Error::other("discord frame too large"));
        }
        let mut body = vec![0u8; len];
        self.s.read_exact(&mut body)?;
        if op == 2 {
            return Err(std::io::Error::other("discord closed the connection"));
        }
        Ok((op, serde_json::from_slice(&body).unwrap_or(Value::Null)))
    }
}

#[cfg(windows)]
fn connect(i: u32) -> Option<Stream> {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(format!(r"\\.\pipe\discord-ipc-{i}"))
        .ok()
}

#[cfg(unix)]
fn connect(i: u32) -> Option<Stream> {
    let base = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]
        .iter()
        .find_map(|k| std::env::var(k).ok())
        .unwrap_or_else(|| "/tmp".into());
    // Plain install, Flatpak and Snap Discord.
    ["", "app/com.discordapp.Discord/", "snap.discord/"].iter().find_map(|sub| {
        std::os::unix::net::UnixStream::connect(format!("{base}/{sub}discord-ipc-{i}")).ok()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_listening_activity() {
        let p = Presence {
            title: "Bu Dünyada".into(),
            artist: "Yeat".into(),
            album: Some("Album".into()),
            image: Some("https://lh3.googleusercontent.com/x=w544-h544".into()),
            video_id: Some("abc".into()),
            position_ms: 10_000,
            duration_ms: Some(150_000),
        };
        let a = activity(&p);
        assert_eq!(a["type"], 2);
        assert_eq!(a["status_display_type"], 1);
        assert_eq!(a["state"], "Yeat");
        let ts = &a["timestamps"];
        assert_eq!(ts["end"].as_u64().unwrap() - ts["start"].as_u64().unwrap(), 150_000);
        assert_eq!(field("a"), "a ");
    }

    #[test]
    fn limiter_allows_bursts_then_waits() {
        let mut l = Limiter { sent: Default::default() };
        for _ in 0..BURST {
            assert!(l.wait().is_zero(), "a burst of {BURST} must go out immediately");
            l.record();
        }
        let w = l.wait();
        assert!(w > Duration::from_secs(19) && w <= WINDOW, "6th update waits for the window: {w:?}");
    }

    /// Toggles play/pause against the running Discord client and times each
    /// update end to end (queue → limiter → Discord's reply).
    #[test]
    #[ignore = "needs a running Discord client"]
    fn live_toggle_latency() {
        let p = Presence {
            title: "Latency test".into(),
            artist: "Melodi".into(),
            album: None,
            image: None,
            video_id: None,
            position_ms: 0,
            duration_ms: Some(180_000),
        };
        let mut c = Conn::open(CLIENT_ID).expect("connect to Discord");
        let mut l = Limiter { sent: Default::default() };
        for i in 0..6 {
            let state = if i % 2 == 0 { Some(&p) } else { None };
            let t0 = Instant::now();
            let wait = l.wait();
            std::thread::sleep(SETTLE + wait);
            c.set_activity(state).unwrap();
            l.record();
            println!(
                "{} -> on Discord after {:?} (limiter wait {:?})",
                if state.is_some() { "play " } else { "pause" },
                t0.elapsed(),
                wait
            );
            std::thread::sleep(Duration::from_millis(600));
        }
        c.set_activity(None).unwrap();
    }

    /// Shows a real presence in the running Discord client for ~20 s.
    #[tokio::test]
    #[ignore = "needs a running Discord client and network"]
    async fn live_presence() {
        let it = melodi_core::innertube::InnerTube::new().unwrap();
        let song = it
            .search("yeat")
            .await
            .unwrap()
            .into_iter()
            .find(|i| i.kind == "song" && i.artists.iter().any(|a| a == "Yeat"))
            .expect("a Yeat song");
        let image = song.thumbnails.iter().max_by_key(|t| t.width).map(|t| t.url.clone());
        let p = Presence {
            title: song.title.clone(),
            artist: song.artists.join(", "),
            album: None,
            image,
            video_id: song.video_id.clone(),
            position_ms: 30_000,
            duration_ms: song.duration_ms.or(Some(180_000)),
        };
        println!("sending: {} — {}", p.title, p.artist);

        let mut c = Conn::open(CLIENT_ID).expect("connect + handshake with Discord");
        c.nonce += 1;
        let cmd = json!({
            "cmd": "SET_ACTIVITY",
            "args": { "pid": std::process::id(), "activity": activity(&p) },
            "nonce": c.nonce.to_string(),
        });
        c.send(1, &cmd).unwrap();
        let (_, reply) = c.recv().unwrap();
        println!("discord replied: evt={:?} data={}", reply.get("evt"), reply.get("data").unwrap_or(&Value::Null));
        assert_ne!(reply.get("evt").and_then(|e| e.as_str()), Some("ERROR"));
        std::thread::sleep(Duration::from_secs(20));
        c.set_activity(None).unwrap();
    }
}
