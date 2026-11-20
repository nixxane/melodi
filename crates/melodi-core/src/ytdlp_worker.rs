//! A small pool of long-running yt-dlp processes (see ytdlp_worker.py).
//!
//! Starting yt-dlp costs about a second and a half per song (Python start-up,
//! loading yt-dlp, set-up). The web server resolves songs all day, so it keeps
//! a few workers alive instead. Opt-in with `MELODI_YTDLP_WORKERS=<n>`; it
//! needs `python3` and the zipapp build of yt-dlp (the Linux download). The
//! desktop app keeps running yt-dlp once per song.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::LazyLock;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{Mutex, Semaphore};

use crate::Error;

const SCRIPT: &str = include_str!("ytdlp_worker.py");
/// A worker is replaced after this many songs (keeps memory in check).
const MAX_USES: u32 = 300;
/// Longest a single song may take before its worker is killed.
const TIMEOUT: Duration = Duration::from_secs(60);

struct Worker {
    _child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    uses: u32,
    generation: u64,
}

pub struct Pool {
    slots: Semaphore,
    idle: Mutex<Vec<Worker>>,
    /// Bumped when yt-dlp is updated: older workers are retired.
    generation: AtomicU64,
}

static POOL: LazyLock<Option<Pool>> = LazyLock::new(|| {
    let size: usize = std::env::var("MELODI_YTDLP_WORKERS").ok()?.trim().parse().ok()?;
    (size > 0).then(|| Pool {
        slots: Semaphore::new(size),
        idle: Mutex::new(Vec::new()),
        generation: AtomicU64::new(0),
    })
});

/// The pool, if workers are enabled and usable with this yt-dlp binary.
pub fn pool_for(bin: &Path) -> Option<&'static Pool> {
    let pool = POOL.as_ref()?;
    // The Windows/macOS builds are frozen executables, not importable zipapps.
    let zipapp = bin.extension().is_none() && bin.file_name().is_some_and(|n| n == "yt-dlp");
    zipapp.then_some(pool)
}

/// Retire every worker (call after yt-dlp was updated).
pub fn recycle() {
    if let Some(p) = POOL.as_ref() {
        p.generation.fetch_add(1, Ordering::Relaxed);
    }
}

pub enum Answer {
    Url(String),
    /// yt-dlp's own error message (same text it prints on the command line).
    Failed(String),
}

impl Pool {
    pub async fn resolve(&self, data_dir: &Path, bin: &Path, args: &[String], video_id: &str) -> Result<Answer, Error> {
        let _slot = self.slots.acquire().await.map_err(|e| Error::Msg(e.to_string()))?;
        let generation = self.generation.load(Ordering::Relaxed);
        let reused = {
            let mut idle = self.idle.lock().await;
            idle.retain(|w| w.generation == generation);
            idle.pop()
        };
        let mut w = match reused {
            Some(w) => w,
            None => spawn(data_dir, bin, args, generation).await?,
        };

        let request = format!("{}\n", serde_json::json!({ "id": video_id }));
        let exchange = async {
            w.stdin.write_all(request.as_bytes()).await?;
            w.stdin.flush().await?;
            let mut line = String::new();
            let n = w.stdout.read_line(&mut line).await?;
            Ok::<_, std::io::Error>((n, line))
        };
        let (n, line) = match tokio::time::timeout(TIMEOUT, exchange).await {
            Ok(Ok(x)) => x,
            // Dropping the worker kills it (kill_on_drop).
            Ok(Err(e)) => return Err(Error::Msg(format!("yt-dlp worker failed: {e}"))),
            Err(_) => return Err(Error::Msg("yt-dlp worker timed out".into())),
        };
        if n == 0 {
            return Err(Error::Msg("yt-dlp worker exited".into()));
        }
        let v: serde_json::Value = serde_json::from_str(line.trim())?;

        w.uses += 1;
        if w.uses < MAX_USES {
            self.idle.lock().await.push(w);
        }
        match (v["url"].as_str(), v["error"].as_str()) {
            (Some(url), _) => Ok(Answer::Url(url.to_string())),
            (_, Some(err)) => Ok(Answer::Failed(err.to_string())),
            _ => Err(Error::Msg("unexpected yt-dlp worker answer".into())),
        }
    }
}

fn script_path(data_dir: &Path) -> PathBuf {
    data_dir.join("ytdlp_worker.py")
}

/// The script is written once per run, so an updated server always runs its own copy.
static WRITTEN: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();

async fn spawn(data_dir: &Path, bin: &Path, args: &[String], generation: u64) -> Result<Worker, Error> {
    let script = script_path(data_dir);
    WRITTEN
        .get_or_try_init(|| async { tokio::fs::write(&script, SCRIPT).await })
        .await?;
    let mut child = tokio::process::Command::new("python3")
        .arg(&script)
        .arg(bin)
        .arg(serde_json::to_string(args)?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()?;
    let stdin = child.stdin.take().ok_or_else(|| Error::Msg("no worker stdin".into()))?;
    let stdout = child.stdout.take().ok_or_else(|| Error::Msg("no worker stdout".into()))?;
    Ok(Worker { _child: child, stdin, stdout: BufReader::new(stdout), uses: 0, generation })
}
