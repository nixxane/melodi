//! Import Spotify playlists and albums.
//!
//! Spotify's public embed page (the player sites show in an iframe) carries
//! the track list as JSON, no account or API key needed. It lists up to 100
//! tracks; longer playlists can be imported from a CSV export instead. Each
//! track is then matched to a YouTube Music song by title, artist and length.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::innertube::{InnerTube, Item};
use crate::Error;

/// Tracks matched at the same time.
const PARALLEL: usize = 4;

/// HTTP client for Spotify's public pages (managed Tauri state).
pub struct Spotify {
    pub http: reqwest::Client,
}

impl Spotify {
    pub fn new() -> Result<Self, Error> {
        Ok(Self {
            http: reqwest::Client::builder()
                .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")
                .timeout(std::time::Duration::from_secs(20))
                .build()?,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    pub title: String,
    pub artists: Vec<String>,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SourceList {
    pub name: String,
    pub tracks: Vec<Track>,
    /// The page only showed the first 100 tracks.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Imported {
    pub name: String,
    pub items: Vec<Item>,
    /// "Artist – Title" of tracks with no good match.
    pub missing: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
struct Progress {
    done: usize,
    total: usize,
}

/// Recognise open.spotify.com/{playlist|album|track}/ID links (with or
/// without /intl-xx/) and spotify:{kind}:ID URIs.
pub fn parse_link(input: &str) -> Option<(&'static str, String)> {
    let s = input.trim();
    let (kind, rest) = if let Some(uri) = s.strip_prefix("spotify:") {
        uri.split_once(':')?
    } else {
        let after = s.split_once("open.spotify.com/")?.1;
        let mut parts = after.split('/').filter(|p| !p.is_empty() && !p.starts_with("intl-"));
        let kind = parts.next()?;
        (kind, parts.next()?)
    };
    let id: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
    if id.len() < 10 || id.len() > 40 {
        return None;
    }
    let kind = match kind {
        "playlist" => "playlist",
        "album" => "album",
        "track" => "track",
        _ => return None,
    };
    Some((kind, id))
}

pub async fn fetch(http: &reqwest::Client, kind: &str, id: &str) -> Result<SourceList, Error> {
    let url = format!("https://open.spotify.com/embed/{kind}/{id}");
    let resp = http.get(&url).send().await?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(Error::Msg("Spotify couldn't find that — is the playlist public?".into()));
    }
    if !resp.status().is_success() {
        return Err(Error::Msg(format!("Spotify returned {}", resp.status())));
    }
    let html = resp.text().await?;
    let marker = r#"<script id="__NEXT_DATA__" type="application/json">"#;
    let json = html
        .split_once(marker)
        .and_then(|(_, rest)| rest.split_once("</script>"))
        .map(|(j, _)| j)
        .ok_or_else(|| Error::Msg("Couldn't read the Spotify page (it may have changed)".into()))?;
    let v: Value = serde_json::from_str(json)?;
    let e = v
        .pointer("/props/pageProps/state/data/entity")
        .ok_or_else(|| Error::Msg("Spotify didn't return that playlist — is it public?".into()))?;
    Ok(parse_entity(e))
}

fn parse_entity(e: &Value) -> SourceList {
    let name = e
        .get("name")
        .or_else(|| e.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("Spotify import")
        .to_string();
    let split = |s: &str| -> Vec<String> {
        s.split(',')
            .map(|a| a.replace('\u{a0}', " ").trim().to_string())
            .filter(|a| !a.is_empty())
            .collect()
    };
    let tracks: Vec<Track> = match e.get("trackList").and_then(Value::as_array) {
        Some(list) => list
            .iter()
            .filter_map(|t| {
                Some(Track {
                    title: t.get("title")?.as_str()?.to_string(),
                    artists: split(t.get("subtitle").and_then(Value::as_str).unwrap_or("")),
                    duration_ms: t.get("duration").and_then(Value::as_u64),
                })
            })
            .collect(),
        // A single track page.
        None => vec![Track {
            title: name.clone(),
            artists: split(e.get("subtitle").and_then(Value::as_str).unwrap_or("")),
            duration_ms: e.get("duration").and_then(Value::as_u64),
        }],
    };
    let truncated = tracks.len() >= 100;
    SourceList { name, tracks, truncated }
}

/// Lowercase, drop bracketed extras ("(feat. X)", "[Remastered]") and
/// " - Remastered 2011" style suffixes, keep letters/digits.
fn norm(s: &str) -> String {
    let mut out = String::new();
    let mut depth = 0;
    for c in s.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = (depth - 1).max(0),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    let out = match out.split_once(" - ") {
        Some((a, b)) if is_version_note(b) => a.to_string(),
        _ => out,
    };
    out.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_version_note(s: &str) -> bool {
    let s = s.to_lowercase();
    ["remaster", "version", "edit", "mix", "live", "mono", "stereo", "feat", "with "]
        .iter()
        .any(|w| s.contains(w))
}

fn words(s: &str) -> Vec<String> {
    s.split_whitespace().map(str::to_string).collect()
}

/// Share of `a`'s words found in `b` (0..1).
fn overlap(a: &str, b: &str) -> f32 {
    let wa = words(a);
    if wa.is_empty() {
        return 0.0;
    }
    let wb = words(b);
    wa.iter().filter(|w| wb.contains(w)).count() as f32 / wa.len() as f32
}

/// Words marking a different take of a song. A candidate carrying one the
/// Spotify title doesn't (e.g. "(Acoustic)") is probably the wrong version.
const VERSION_TAGS: &[&str] = &[
    "acoustic", "live", "remix", "demo", "stripped", "instrumental", "karaoke", "cover",
    "sped up", "slowed", "reverb", "nightcore", "piano", "orchestral", "8d", "edit", "extended",
    "radio", "a cappella", "acapella", "version", "rework", "flip", "mashup", "lofi", "lo-fi",
];

fn version_tags(title: &str) -> Vec<&'static str> {
    let t = title.to_lowercase();
    VERSION_TAGS.iter().copied().filter(|w| t.contains(w)).collect()
}

/// How well a YouTube Music song matches a Spotify track (higher is better).
fn score(t: &Track, cand: &Item) -> f32 {
    let wanted = version_tags(&t.title);
    let extra = version_tags(&cand.title).iter().filter(|w| !wanted.contains(w)).count() as f32;
    let (tt, ct) = (norm(&t.title), norm(&cand.title));
    let title = if tt == ct { 1.0 } else { (overlap(&tt, &ct) + overlap(&ct, &tt)) / 2.0 };

    let cand_artists = norm(&cand.artists.join(" "));
    let artist = t
        .artists
        .iter()
        .map(|a| overlap(&norm(a), &cand_artists))
        .fold(0.0f32, f32::max);

    let dur = match (t.duration_ms, cand.duration_ms) {
        (Some(a), Some(b)) => {
            let diff = (a as i64 - b as i64).unsigned_abs() as f32 / 1000.0;
            if diff <= 3.0 {
                1.0
            } else if diff <= 15.0 {
                0.6
            } else if diff <= 40.0 {
                0.2
            } else {
                -0.5
            }
        }
        _ => 0.4,
    };
    title * 2.0 + artist * 1.5 + dur - extra * 0.8
}

async fn match_one(it: &InnerTube, t: &Track) -> Option<Item> {
    let artist = t.artists.first().map(String::as_str).unwrap_or("");
    let query = format!("{} {}", t.title, artist);
    let results = it.search_songs(query.trim()).await.ok()?;
    results
        .into_iter()
        .take(6)
        .enumerate()
        // A small bonus for YouTube's own ranking breaks ties.
        .map(|(rank, c)| (score(t, &c) + (6 - rank) as f32 * 0.02, c))
        .max_by(|a, b| a.0.total_cmp(&b.0))
        // Needs a decent title match plus the artist or the length.
        .filter(|(s, _)| *s >= 2.6)
        .map(|(_, c)| c)
}

/// Match every track, emitting `import-progress` as it goes. Order is kept.
pub async fn match_all(app: &AppHandle, list: SourceList) -> Imported {
    let total = list.tracks.len();
    let done = Arc::new(AtomicUsize::new(0));
    let tracks = Arc::new(list.tracks);
    let mut slots: Vec<Option<Item>> = vec![None; total];

    let next = Arc::new(AtomicUsize::new(0));
    let mut workers = Vec::new();
    for _ in 0..PARALLEL.min(total.max(1)) {
        let (app, tracks, next, done) = (app.clone(), tracks.clone(), next.clone(), done.clone());
        workers.push(tauri::async_runtime::spawn(async move {
            let it = app.state::<InnerTube>();
            let mut found = Vec::new();
            loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                if i >= tracks.len() {
                    break;
                }
                found.push((i, match_one(&it, &tracks[i]).await));
                let d = done.fetch_add(1, Ordering::Relaxed) + 1;
                let _ = app.emit("import-progress", Progress { done: d, total: tracks.len() });
            }
            found
        }));
    }
    for w in workers {
        if let Ok(found) = w.await {
            for (i, item) in found {
                slots[i] = item;
            }
        }
    }

    let mut items = Vec::new();
    let mut missing = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (t, slot) in tracks.iter().zip(slots) {
        match slot {
            Some(item) => {
                if seen.insert(item.video_id.clone()) {
                    items.push(item);
                }
            }
            None => missing.push(format!("{} – {}", t.artists.join(", "), t.title)),
        }
    }
    Imported { name: list.name, items, missing, truncated: list.truncated }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links() {
        assert_eq!(
            parse_link("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc"),
            Some(("playlist", "37i9dQZF1DXcBWIGoYBM5M".into()))
        );
        assert_eq!(
            parse_link("https://open.spotify.com/intl-de/album/4m2880jivSbbyEGAKfITCa"),
            Some(("album", "4m2880jivSbbyEGAKfITCa".into()))
        );
        assert_eq!(parse_link("spotify:track:3h5T5JypYU7huFiVYhv1dr"), Some(("track", "3h5T5JypYU7huFiVYhv1dr".into())));
        assert_eq!(parse_link("https://open.spotify.com/user/abc"), None);
        assert_eq!(parse_link("https://youtube.com/watch?v=x"), None);
    }

    #[test]
    fn normalising() {
        assert_eq!(norm("Song 2 - 2012 Remaster"), "song 2");
        assert_eq!(norm("Flawlëss (feat. Lil Uzi Vert)"), "flawlëss");
        assert_eq!(norm("Don't Stop Me Now - Remastered 2011"), "don t stop me now");
        assert_eq!(norm("Mr. Brightside"), "mr brightside");
    }

    #[test]
    fn scoring_prefers_right_song() {
        let t = Track { title: "Blinding Lights".into(), artists: vec!["The Weeknd".into()], duration_ms: Some(200_040) };
        let mk = |title: &str, artist: &str, d: u64| Item {
            kind: "song".into(),
            video_id: Some("x".into()),
            browse_id: None,
            title: title.into(),
            subtitle: String::new(),
            artists: vec![artist.into()],
            duration_ms: Some(d),
            thumbnails: vec![],
            explicit: false,
            artist_id: None,
            album_id: None,
        };
        let good = score(&t, &mk("Blinding Lights", "The Weeknd", 201_000));
        let cover = score(&t, &mk("Blinding Lights", "Some Cover Band", 185_000));
        let other = score(&t, &mk("Save Your Tears", "The Weeknd", 215_000));
        assert!(good > cover && good > other);
        assert!(good >= 2.6 && other < 2.6);

        let t = Track { title: "Boston".into(), artists: vec!["Stella Lefty".into()], duration_ms: Some(171_000) };
        let orig = score(&t, &mk("Boston", "STELLA LEFTY", 171_000));
        let acoustic = score(&t, &mk("Boston (Acoustic)", "STELLA LEFTY", 171_000));
        assert!(orig > acoustic);
        // Asking for the live version prefers it.
        let t = Track { title: "Boston - Live".into(), artists: vec!["Stella Lefty".into()], duration_ms: None };
        assert!(score(&t, &mk("Boston (Live)", "STELLA LEFTY", 0)) > score(&t, &mk("Boston (Acoustic)", "STELLA LEFTY", 0)));
    }

    #[tokio::test]
    #[ignore = "network"]
    async fn embed_parses() {
        let http = reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36")
            .build()
            .unwrap();
        let l = fetch(&http, "playlist", "37i9dQZF1DXcBWIGoYBM5M").await.unwrap();
        assert!(l.tracks.len() >= 20, "{}", l.tracks.len());
        assert!(!l.tracks[0].artists.is_empty());
    }
}
