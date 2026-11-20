//! Melodi's backend, shared by the desktop app (Tauri) and the web server.
//!
//! Nothing here knows about Tauri or any HTTP framework: callers pass in
//! their folders and wire the results to their own transport.

pub mod audio;
pub mod innertube;
pub mod live;
pub mod lyrics;
pub mod spotify;
pub mod ytdlp;
pub mod ytdlp_worker;

/// Crate-wide error type shared by the InnerTube client and the yt-dlp backend.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Msg(String),
}
