use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::audio_server::AudioServer;
use melodi_core::audio::{CacheInfo, Prepared};
use melodi_core::innertube::{Artist, Collection, InnerTube, Item, Shelf};
use melodi_core::lyrics::{Lyrics, LyricsClient};
use melodi_core::spotify::{self, Imported, SourceList, Spotify, Track};
use melodi_core::ytdlp::{self, StreamCache};

type Yt<'a> = State<'a, Arc<InnerTube>>;

#[tauri::command]
pub async fn search(state: Yt<'_>, query: String) -> Result<Vec<Item>, String> {
    state.search(&query).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browse_home(state: Yt<'_>) -> Result<Vec<Shelf>, String> {
    state.home().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn up_next(
    state: Yt<'_>,
    video_id: String,
    playlist_id: Option<String>,
) -> Result<Vec<Item>, String> {
    state
        .up_next(&video_id, playlist_id.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Language / region for YouTube Music content (e.g. "tr", "TR").
#[tauri::command]
pub fn set_locale(state: Yt<'_>, hl: String, gl: String) -> Result<(), String> {
    state.set_locale(&hl, &gl).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browse_artist(state: Yt<'_>, browse_id: String) -> Result<Artist, String> {
    state.artist(&browse_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browse_collection(
    state: Yt<'_>,
    browse_id: String,
) -> Result<Collection, String> {
    state.collection(&browse_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lyrics(
    yt: Yt<'_>,
    client: State<'_, LyricsClient>,
    video_id: String,
    title: String,
    artist: String,
    duration_ms: Option<u64>,
) -> Result<Lyrics, String> {
    client
        .find(&yt, &video_id, &title, &artist, duration_ms)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn resolve_stream(
    app: AppHandle,
    cache: State<'_, Arc<StreamCache>>,
    video_id: String,
    force_refresh: Option<bool>,
) -> Result<ytdlp::StreamInfo, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    ytdlp::resolve_stream(&dir, &cache, &video_id, force_refresh.unwrap_or(false))
        .await
        .map_err(|e| e.to_string())
}

/// Fire-and-forget: warm the stream cache. Errors are swallowed.
#[tauri::command]
pub async fn prefetch_stream(audio: State<'_, AudioServer>, video_id: String) -> Result<(), String> {
    // Resolves the URL and downloads the song into the offline cache.
    audio.store.prefetch(&video_id).await;
    Ok(())
}

#[tauri::command]
pub async fn backend_status(app: AppHandle) -> Result<ytdlp::BackendStatus, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if ytdlp::locate_with(&dir).is_none() {
        // First run: tell the UI we're about to download yt-dlp.
        let _ = app.emit("backend-setup", true);
    }
    Ok(ytdlp::status(&dir).await)
}

/// Update (or clear, with `None`) the Discord "Listening to …" activity.
#[tauri::command]
pub fn discord_presence(
    discord: State<'_, crate::discord::Discord>,
    presence: Option<crate::discord::Presence>,
) {
    discord.update(presence);
}

/// Whether Discord presence is configured (a client id is set).
#[tauri::command]
pub fn discord_available(discord: State<'_, crate::discord::Discord>) -> bool {
    discord.enabled()
}

// ---- audio proxy / cache ---------------------------------------------------

/// Resolve a song and return the local proxy URL plus its loudness.
#[tauri::command]
pub async fn prepare_stream(
    audio: State<'_, AudioServer>,
    video_id: String,
    force_refresh: Option<bool>,
) -> Result<Prepared, String> {
    audio
        .prepare(&video_id, force_refresh.unwrap_or(false))
        .await
        .map_err(|e| e.to_string())
}

/// Size limit for the offline song cache; 0 turns caching off.
#[tauri::command]
pub fn set_audio_cache(audio: State<'_, AudioServer>, limit_mb: u64) {
    audio.store.set_limit_bytes(limit_mb * 1024 * 1024);
}

#[tauri::command]
pub async fn audio_cache_info(audio: State<'_, AudioServer>) -> Result<CacheInfo, String> {
    Ok(audio.store.info())
}

#[tauri::command]
pub async fn clear_audio_cache(audio: State<'_, AudioServer>) -> Result<(), String> {
    audio.store.clear();
    Ok(())
}

// ---- Spotify import ----------------------------------------------------------

/// Import a Spotify playlist / album / track link, matched to YouTube Music.
#[tauri::command]
pub async fn import_spotify(
    app: AppHandle,
    yt: Yt<'_>,
    spotify: State<'_, Spotify>,
    url: String,
) -> Result<Imported, String> {
    let (kind, id) = spotify::parse_link(&url).ok_or("That doesn't look like a Spotify playlist, album or song link")?;
    let list = spotify::fetch(&spotify.http, kind, &id).await.map_err(|e| e.to_string())?;
    if list.tracks.is_empty() {
        return Err("That Spotify playlist is empty".into());
    }
    Ok(spotify::match_all(&yt, list, progress_events(&app)).await)
}

/// Forward import progress to the UI as `import-progress` events.
fn progress_events(app: &AppHandle) -> spotify::OnProgress {
    let app = app.clone();
    Arc::new(move |p| {
        let _ = app.emit("import-progress", p);
    })
}

/// Match a track list read from a file (e.g. a CSV export) to YouTube Music.
#[tauri::command]
pub async fn import_tracks(
    app: AppHandle,
    yt: Yt<'_>,
    name: String,
    tracks: Vec<Track>,
) -> Result<Imported, String> {
    if tracks.is_empty() {
        return Err("No songs found in that file".into());
    }
    let tracks: Vec<Track> = tracks.into_iter().take(5000).collect();
    Ok(spotify::match_all(&yt, SourceList { name, tracks, truncated: false }, progress_events(&app)).await)
}
