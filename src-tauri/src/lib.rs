mod audio_server;
mod commands;
mod discord;
mod tray;

use std::sync::Arc;

use melodi_core::audio::{AudioStore, DEFAULT_LIMIT};
use melodi_core::innertube::InnerTube;
use melodi_core::ytdlp::{self, StreamCache};
use melodi_core::{lyrics, spotify};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let inner = Arc::new(InnerTube::new().expect("failed to build InnerTube client"));
    let streams = Arc::new(StreamCache::default());
    let lyrics = lyrics::LyricsClient::new().expect("failed to build lyrics client");

    let (inner_for_audio, streams_for_audio) = (inner.clone(), streams.clone());

    tauri::Builder::default()
        // Must be registered first: a second launch (taskbar, Start menu,
        // shortcut) hands off to the running Melodi and exits, which then
        // brings its window back from the tray.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main(app);
        }))
        .manage(tray::TrayState::default())
        .on_window_event(tray::on_window_event)
        .setup(move |app| {
            tray::setup(app);
            // Local audio proxy + offline cache (see audio_server.rs).
            let path = tauri::Manager::path(app);
            let cache_dir = path.app_cache_dir()?.join("audio");
            let data_dir = path.app_data_dir()?;
            let store = AudioStore::new(cache_dir, data_dir, inner_for_audio, streams_for_audio, DEFAULT_LIMIT)?;
            match audio_server::AudioServer::start(store) {
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
        .manage(streams)
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
