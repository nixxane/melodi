use tauri::{AppHandle, Emitter, Manager, State};

use crate::innertube::{Artist, Collection, InnerTube, Item, Shelf};
use crate::lyrics::{Lyrics, LyricsClient};
use crate::ytdlp::{self, StreamCache};

#[tauri::command]
pub async fn search(state: State<'_, InnerTube>, query: String) -> Result<Vec<Item>, String> {
    state.search(&query).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browse_home(state: State<'_, InnerTube>) -> Result<Vec<Shelf>, String> {
    state.home().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn up_next(
    state: State<'_, InnerTube>,
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
pub fn set_locale(state: State<'_, InnerTube>, hl: String, gl: String) -> Result<(), String> {
    state.set_locale(&hl, &gl).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browse_artist(state: State<'_, InnerTube>, browse_id: String) -> Result<Artist, String> {
    state.artist(&browse_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browse_collection(
    state: State<'_, InnerTube>,
    browse_id: String,
) -> Result<Collection, String> {
    state.collection(&browse_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lyrics(
    yt: State<'_, InnerTube>,
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
    cache: State<'_, StreamCache>,
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
pub async fn prefetch_stream(
    app: AppHandle,
    cache: State<'_, StreamCache>,
    video_id: String,
) -> Result<(), String> {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = ytdlp::resolve_stream(&dir, &cache, &video_id, false).await;
    }
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
