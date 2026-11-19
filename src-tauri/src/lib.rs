mod audio;
mod commands;
mod discord;
mod tray;
mod innertube;
mod live;
mod lyrics;
mod spotify;
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
        // Must be registered first: a second launch (taskbar, Start menu,
        // shortcut) hands off to the running Melodi and exits, which then
        // brings its window back from the tray.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main(app);
        }))
        .manage(tray::TrayState::default())
        .on_window_event(tray::on_window_event)
        .setup(|app| {
            tray::setup(app);
            // Local audio proxy + offline cache (see audio.rs).
            match audio::AudioServer::start(app.handle()) {
                Ok(server) => {
                    tauri::Manager::manage(app, server);
                }
                Err(e) => return Err(format!("couldn't start the audio server: {e}").into()),
            }
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
        .manage(spotify::Spotify::new().expect("failed to build Spotify client"))
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
            commands::prepare_stream,
            commands::set_audio_cache,
            commands::audio_cache_info,
            commands::clear_audio_cache,
            commands::import_spotify,
            commands::import_tracks,
            commands::backend_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running Melodi");
}
