//! System tray icon with playback controls, plus optional "close to tray".

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime, WindowEvent};

const TRAY_ID: &str = "main";

/// Whether closing the window should hide it to the tray instead of quitting.
#[derive(Default)]
pub struct TrayState {
    pub close_to_tray: AtomicBool,
}

/// Build the tray icon. Failing to create one (e.g. a Linux desktop without a
/// tray) is not fatal: Melodi just runs without it.
pub fn setup<R: Runtime>(app: &tauri::App<R>) {
    if let Err(e) = build(app) {
        eprintln!("[melodi] tray unavailable: {e}");
    }
}

fn build<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "Play / Pause", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "Next", true, None::<&str>)?;
    let prev = MenuItem::with_id(app, "prev", "Previous", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show Melodi", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&toggle, &prev, &next, &sep1, &show, &sep2, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Melodi")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            // Playback lives in the frontend: forward the action.
            id @ ("toggle" | "next" | "prev") => {
                let _ = app.emit("tray", id);
            }
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Window close: hide to the tray when that setting is on (and a tray exists).
pub fn on_window_event<R: Runtime>(window: &tauri::Window<R>, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        let app = window.app_handle();
        let wants = app.state::<TrayState>().close_to_tray.load(Ordering::Relaxed);
        if wants && app.tray_by_id(TRAY_ID).is_some() {
            api.prevent_close();
            let _ = window.hide();
        }
    }
}

#[tauri::command]
pub fn set_close_to_tray(state: tauri::State<'_, TrayState>, enabled: bool) {
    state.close_to_tray.store(enabled, Ordering::Relaxed);
}

/// Show the current song in the tray tooltip.
#[tauri::command]
pub fn set_tray_tooltip(app: AppHandle, text: String) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let text: String = text.chars().take(120).collect();
        let _ = tray.set_tooltip(Some(if text.is_empty() { "Melodi".to_string() } else { text }));
    }
}

/// Whether a tray icon could be created on this system.
#[tauri::command]
pub fn tray_available(app: AppHandle) -> bool {
    app.tray_by_id(TRAY_ID).is_some()
}
