mod commands;
mod innertube;
mod lyrics;
mod ytdlp;

use innertube::InnerTube;
use ytdlp::StreamCache;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let inner = InnerTube::new().expect("failed to build InnerTube client");
    let lyrics = lyrics::LyricsClient::new().expect("failed to build lyrics client");

    tauri::Builder::default()
        .manage(inner)
        .manage(StreamCache::default())
        .manage(lyrics)
        .invoke_handler(tauri::generate_handler![
            commands::search,
            commands::browse_home,
            commands::up_next,
            commands::browse_artist,
            commands::browse_collection,
            commands::lyrics,
            commands::resolve_stream,
            commands::prefetch_stream,
            commands::backend_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running Melodi");
}
