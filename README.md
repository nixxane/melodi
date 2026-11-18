# Melodi 🎧

A cross-platform, **ad-free desktop music client** built with **Rust + Tauri 2**.
It streams YouTube Music's catalog through YouTube's public backend — **no account,
no sign-up, no ads** — with an original UI that is *not* a YouTube Music clone.

> **Status:** functional MVP. Search + browse + streaming playback work today.
> Live streams (HLS) are on the roadmap.

---

## How it works

Melodi uses two complementary backends:

| Concern | Engine | Why |
| --- | --- | --- |
| **Search & browse** (metadata, thumbnails, artists) | Pure-Rust **InnerTube** client (`src-tauri/src/innertube.rs`) | YouTube Music's public WEB_REMIX API — no auth required |
| **Audio stream resolution** | **yt-dlp** (`src-tauri/src/ytdlp.rs`) | YouTube's unauthenticated `player` endpoint now requires a Proof-of-Origin token. yt-dlp is the battle-tested extractor that keeps up with these changes (signature + `n` deciphering, throttling). |

The frontend is a **React + TypeScript + Vite** app. The Rust backend exposes six
commands — `search`, `browse_home`, `up_next`, `resolve_stream`, `prefetch_stream`,
`backend_status` — via Tauri IPC.

```
┌──────────────────────────────────────────────────────────┐
│  React UI (custom design)                                │
│  sidebar · home shelves · search · queue · player bar    │
└──────────────┬───────────────────────────────────────────┘
               │ Tauri IPC (invoke)
┌──────────────▼───────────────────────────────────────────┐
│  Rust backend                                            │
│  • innertube.rs  → InnerTube WEB_REMIX (search/browse)   │
│  • ytdlp.rs      → yt-dlp (resolve progressive audio URL)│
└──────────────┬───────────────────────────────────────────┘
               │ HTTPS
      ┌────────▼────────┐        ┌─────────────────────┐
      │ music.youtube.com │        │ googlevideo.com      │
      │ (InnerTube API)  │        │ (audio stream)       │
      └─────────────────┘        └─────────────────────┘
```

The resolved stream URL is handed back to the webview, which plays it in an
HTML5 `<audio>` element. Because playback never touches YouTube's ad-serving web
player, there are simply no ads to serve — not "ad blocking", just a clean
direct stream.

---

## Features

- 🔎 **Search** songs, artists, albums (no account needed) with a top result, recent searches and skeleton loading
- 👤 **Artist pages** — top songs, albums, singles, videos, "fans might also like", plus shuffle and artist radio
- 💿 **Album & playlist pages** — full track lists (playlists up to ~300 tracks), shuffle, radio
- 📻 **Radio** — start a radio of similar songs from any track (right-click → start radio, or `≈` in the player)
- 🎤 **Lyrics** (`L`) — time-synced, auto-scrolling lyrics from [LRCLIB](https://lrclib.net) (click a line to jump there), falling back to YouTube Music's plain lyrics. Lookups send only the track title, artist and length.
- 📝 **Your playlists** — create, rename, reorder (drag) and delete; add songs from any row (`+pl`, right-click), the player, or save a whole queue / album. Stored locally.
- 🕘 **Recently played** and "your artists" on Home, kept locally. A song only counts after 30 s of listening (or half a short track), and artists can be hidden with `x`.
- 🏠 **Home shelves** (quick picks, new releases, moods & genres) with a time-aware greeting
- ▶️ **Playback** — shuffle, repeat (off / all / one), smart previous (restarts after 3 s), seek with hover preview, volume with mute
- 🧭 **Queue** — play next / add to queue (buttons and right-click menu), drag to reorder, remove, clear
- 📻 **Autoplay radio** — when the queue runs out, similar songs are appended automatically (toggle in the queue header)
- 💾 **Session restore** — the queue and your position come back after a restart (paused)
- 🎹 **OS media keys** and now-playing card via the Media Session API; the window title follows the track
- 🚀 **Fast starts** — resolved stream URLs are cached, the next track is prefetched, and expired streams recover automatically
- 🖥️ **Terminal-style UI** — amber-phosphor TUI look (JetBrains Mono, boxed panels, ASCII seek/volume bars, vim-style status line), with `1`/`2`/`3` view switching and `j`/`k` list navigation
- ⚡ **Self-provisioning** — downloads yt-dlp automatically on first run (checksum-verified) if it's missing

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` / `→` | Seek −5 s / +5 s |
| `Shift` + `←` / `→` | Previous / next track |
| `↑` / `↓` | Volume +5% / −5% |
| `M` | Mute / unmute |
| `L` | Lyrics |
| `Backspace` / `Alt`+`←` / mouse back | Back |
| `/` or `Ctrl`+`K` | Focus search |
| `1` / `2` / `3` | Home / Search / Queue |
| `j` / `k` | Move down / up through rows and cards (`Enter` plays) |
| `Esc` (in search) | Clear and leave the search box |

Shortcuts are ignored while you're typing in a text field.

---

## Getting started

### Prerequisites

- **Rust** (1.77+) with the MSVC toolchain — https://rustup.rs
- **Node.js** 20+ and **pnpm** — `corepack enable` or https://pnpm.io
- On Windows: **WebView2** (preinstalled on Windows 10/11)
- Optional but recommended: **ffmpeg** on your `PATH` (used by yt-dlp for some
  edge cases; most music plays fine without it)

### Run in development

```bash
pnpm install
pnpm tauri dev
```

The backend auto-locates yt-dlp from (in order): `$MELODI_YTDLP`, your `PATH`,
the `src-tauri/binaries/` folder, or downloads it to your app-data directory.

### Build a release

```bash
pnpm tauri build
```

---

## Configuration

| Setting | How |
| --- | --- |
| Custom yt-dlp path | set the `MELODI_YTDLP` environment variable |
| Client locale / region | `hl` / `gl` fields in `src-tauri/src/innertube.rs` |
| Stream format | `resolve_stream` in `src-tauri/src/ytdlp.rs` (defaults to best progressive audio) |

---

## Known limitations (honest notes)

- **Live streams** (e.g. 24/7 radio) are HLS-only and can't play in the WebView2
  audio element yet. Regular tracks stream fine. A backend proxy is the planned fix.
- **Podcasts / episodes / user profiles** aren't supported and are left out of search.
- YouTube periodically tightens its anti-bot measures. If a track fails to resolve,
  updating yt-dlp usually fixes it (`yt-dlp -U`).
- yt-dlp resolves URLs in your region; streams are IP-locked and expire after a
  few hours — a URL is only valid for immediate playback, which is fine for a player.

---

## Legal

Melodi is an **independent, unofficial client**. It is not affiliated with,
endorsed by, or connected to YouTube or Google. "YouTube Music" is a trademark of
its respective owner; the name is used only to describe the service this tool
interfaces with. This project provides no copyrighted content and no tools to
download or retain it. Use is at your own risk and subject to the terms of any
service you connect to.

---

## Project layout

```
melodi/
├── src/                    # React frontend (custom UI)
│   ├── App.tsx
│   ├── components/         # Sidebar, PlayerBar, TrackList, HomeView, SearchView, Card, ShelfRow, ContextMenu, Toasts
│   ├── lib/                # usePlayer, useQueue, useSearch, useToasts, shortcuts, media session, format helpers
│   └── api.ts              # typed Tauri invoke wrappers
├── src-tauri/              # Rust backend
│   ├── src/
│   │   ├── lib.rs          # app bootstrap + command registration
│   │   ├── innertube.rs    # InnerTube (WEB_REMIX) client + parsers
│   │   ├── ytdlp.rs        # yt-dlp stream resolver
│   │   └── commands.rs     # Tauri IPC commands
│   ├── binaries/           # bundled yt-dlp (dev convenience)
│   ├── capabilities/       # Tauri capability (default)
│   └── tauri.conf.json
└── scripts/gen_icon.py     # app-icon generator (Pillow)
```
