mod commands;
mod discord;
mod tray;
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
        .manage(tray::TrayState::default())
        .on_window_event(tray::on_window_event)
        .setup(|app| {
            tray::setup(app);
            // Keep the managed yt-dlp fresh: YouTube regularly breaks old versions.
            if let Ok(dir) = tauri::Manager::path(app).app_data_dir() {
                tauri::async_runtime::spawn(async move {
                    ytdlp::maybe_update(&dir, false).await;
                });
            }
            Ok(())
        })
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .manage(inner)
        .manage(StreamCache::default())
        .manage(lyrics)
        .manage(discord::Discord::start())
        .invoke_handler(tauri::generate_handler![
            commands::search,
            commands::browse_home,
            commands::up_next,
            commands::browse_artist,
            commands::browse_collection,
            commands::lyrics,
            commands::set_locale,
            tray::set_close_to_tray,
            tray::set_tray_tooltip,
            tray::tray_available,
            commands::discord_presence,
            commands::discord_available,
            commands::resolve_stream,
            commands::prefetch_stream,
            commands::backend_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running Melodi");
}
