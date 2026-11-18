//! Pure-Rust client for YouTube Music's public InnerTube API.
//!
//! Used for search and browse (home shelves). This is the *metadata* layer;
//! stream resolution is delegated to the yt-dlp backend (see `ytdlp.rs`)
//! because YouTube gates the unauthneticated `player` endpoint.

use serde::Serialize;
use serde_json::Value;

use crate::Error;

/// Public InnerTube API key for the WEB_REMIX (music.youtube.com) client.
/// These keys are shipped inside every official web client and are stable.
const API_KEY: &str = "AIzaSyC9XL3ZjWddXyaL4xK2TKNMH0Y1QYt7qLQ";
/// `params` value for YouTube Music's "Songs" search filter.
const SONGS_FILTER: &str = "EgWKAQIIAWoKEAkQBRAKEAMQBA==";
const CLIENT_VERSION: &str = "1.20240916.01.00";
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[derive(Debug, Clone, Serialize)]
pub struct Thumbnail {
    pub url: String,
    pub width: u32,
    pub height: u32,
}

/// A unified media item. `kind` discriminates between song / album / artist /
/// playlist. Only `song` items are directly playable in v1.
#[derive(Debug, Clone, Serialize, Default)]
pub struct Item {
    pub kind: String,
    pub video_id: Option<String>,
    pub browse_id: Option<String>,
    pub title: String,
    pub subtitle: String,
    pub artists: Vec<String>,
    pub duration_ms: Option<u64>,
    pub thumbnails: Vec<Thumbnail>,
    pub explicit: bool,
    /// Browse id (UC…) of the first credited artist, when known.
    pub artist_id: Option<String>,
    /// Browse id (MPREb_…) of the track's album, when known.
    pub album_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Shelf {
    pub title: String,
    pub items: Vec<Item>,
}

/// A ready-made radio: play `video_id` within `playlist_id` via `up_next`.
#[derive(Debug, Clone, Serialize)]
pub struct Radio {
    pub video_id: String,
    pub playlist_id: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Artist {
    pub name: String,
    pub description: String,
    pub audience: String,
    pub thumbnails: Vec<Thumbnail>,
    pub radio: Option<Radio>,
    pub shuffle: Option<Radio>,
    pub top_songs: Vec<Item>,
    /// Playlist (VL…) with all of the artist's top songs.
    pub top_songs_id: Option<String>,
    pub shelves: Vec<Shelf>,
}

/// An album or a playlist.
#[derive(Debug, Clone, Serialize, Default)]
pub struct Collection {
    pub kind: String,
    pub browse_id: String,
    pub title: String,
    /// e.g. "Album • 2010"
    pub subtitle: String,
    /// e.g. "22 songs • 58 minutes"
    pub stats: String,
    pub description: String,
    pub artist: Option<String>,
    pub artist_id: Option<String>,
    pub thumbnails: Vec<Thumbnail>,
    pub tracks: Vec<Item>,
    pub shelves: Vec<Shelf>,
    #[serde(skip)]
    continuation: Option<String>,
}

pub struct InnerTube {
    http: reqwest::Client,
}

impl InnerTube {
    pub fn new() -> Result<Self, Error> {
        let http = reqwest::Client::builder().user_agent(USER_AGENT).build()?;
        Ok(Self { http })
    }

    async fn call(&self, endpoint: &str, mut body: Value) -> Result<Value, Error> {
        body["context"] = serde_json::json!({
            "client": {
                "clientName": "WEB_REMIX",
                "clientVersion": CLIENT_VERSION,
                "hl": "en",
                "gl": "US"
            },
            "user": {}
        });

        let url = format!(
            "https://music.youtube.com/youtubei/v1/{endpoint}?key={API_KEY}&prettyPrint=false"
        );
        let resp = self.http.post(&url).json(&body).send().await?;
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            return Err(Error::Msg(format!(
                "InnerTube {endpoint} returned {status}: {}",
                truncate(&text, 200)
            )));
        }
        Ok(serde_json::from_str(&text)?)
    }

    /// Search results, ordered as: top result, then songs (from the "Songs"
    /// filter, which carries album + duration), then albums/artists/playlists.
    pub async fn search(&self, query: &str) -> Result<Vec<Item>, Error> {
        let (general, songs) = tokio::join!(self.search_raw(query, None), self.search_raw(query, Some(SONGS_FILTER)));
        let general = general?;
        let songs = match songs {
            Ok(s) if !s.is_empty() => s,
            // Fall back to the songs in the general results.
            _ => general.iter().filter(|i| i.kind == "song").cloned().collect(),
        };

        let mut out: Vec<Item> = Vec::new();
        if let Some(top) = general.first() {
            out.push(top.clone());
        }
        let top_id = out.first().and_then(|t| t.video_id.clone());
        out.extend(songs.into_iter().filter(|s| s.video_id.is_some() && s.video_id != top_id));
        out.extend(general.into_iter().skip(1).filter(|i| i.kind != "song"));
        Ok(out)
    }

    async fn search_raw(&self, query: &str, params: Option<&str>) -> Result<Vec<Item>, Error> {
        let mut body = serde_json::json!({ "query": query });
        if let Some(p) = params {
            body["params"] = Value::String(p.to_string());
        }
        let v = self.call("search", body).await?;

        let mut out = Vec::new();
        if let Some(sections) = v
            .pointer("/contents/tabbedSearchResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents")
            .and_then(|x| x.as_array())
        {
            for section in sections {
                if let Some(r) = section.get("musicShelfRenderer") {
                    collect_items(r.get("contents"), &mut out);
                } else if let Some(r) = section.get("musicCardShelfRenderer") {
                    if let Some(item) = parse_card(r) {
                        out.push(item);
                    }
                } else if let Some(r) = section.get("itemSectionRenderer") {
                    collect_items(r.get("contents"), &mut out);
                }
            }
        }
        Ok(out)
    }

    /// Radio / "up next" tracks for a video, via the `next` endpoint.
    /// With `playlist_id` (e.g. an artist "Mix"), the whole radio is returned
    /// including the seed track; without it, a song radio minus the seed.
    pub async fn up_next(&self, video_id: &str, playlist_id: Option<&str>) -> Result<Vec<Item>, Error> {
        let body = serde_json::json!({
            "videoId": video_id,
            "playlistId": playlist_id.map(String::from).unwrap_or_else(|| format!("RDAMVM{video_id}")),
            "isAudioOnly": true,
        });
        let v = self.call("next", body).await?;
        Ok(parse_up_next(&v, if playlist_id.is_some() { None } else { Some(video_id) }))
    }

    /// Plain lyrics from YouTube Music's lyrics tab: (text, source footer).
    pub async fn lyrics_text(&self, video_id: &str) -> Result<Option<(String, Option<String>)>, Error> {
        let v = self
            .call("next", serde_json::json!({ "videoId": video_id, "isAudioOnly": true }))
            .await?;
        let tabs = v
            .pointer("/contents/singleColumnMusicWatchNextResultsRenderer/tabbedRenderer/watchNextTabbedResultsRenderer/tabs")
            .and_then(|t| t.as_array());
        let Some(id) = tabs.into_iter().flatten().find_map(|t| {
            let b = t.pointer("/tabRenderer/endpoint/browseEndpoint/browseId")?.as_str()?;
            b.starts_with("MPLYt").then(|| b.to_string())
        }) else {
            return Ok(None);
        };
        let v = self.call("browse", serde_json::json!({ "browseId": id })).await?;
        let shelf = v.pointer("/contents/sectionListRenderer/contents/0/musicDescriptionShelfRenderer");
        let text = shelf.map(|d| text_join(d.pointer("/description/runs"))).unwrap_or_default();
        if text.trim().is_empty() {
            return Ok(None);
        }
        let footer = shelf.map(|d| text_join(d.pointer("/footer/runs"))).filter(|f| !f.is_empty());
        Ok(Some((text, footer)))
    }

    pub async fn artist(&self, browse_id: &str) -> Result<Artist, Error> {
        let v = self.call("browse", serde_json::json!({ "browseId": browse_id })).await?;
        Ok(parse_artist(&v))
    }

    /// Album (MPREb_…) or playlist (VL…) page, with up to ~300 playlist tracks.
    pub async fn collection(&self, browse_id: &str) -> Result<Collection, Error> {
        let v = self.call("browse", serde_json::json!({ "browseId": browse_id })).await?;
        let mut c = parse_collection(&v, browse_id);
        for _ in 0..2 {
            let Some(token) = c.continuation.take() else { break };
            let v = self.call("browse", serde_json::json!({ "continuation": token })).await?;
            let items = v
                .pointer("/onResponseReceivedActions/0/appendContinuationItemsAction/continuationItems")
                .and_then(|x| x.as_array());
            for it in items.into_iter().flatten() {
                if let Some(tok) = continuation_token(it) {
                    c.continuation = Some(tok);
                } else if let Some(item) = it.get("musicResponsiveListItemRenderer").and_then(parse_song) {
                    push_track(&mut c, item);
                }
            }
        }
        Ok(c)
    }

    pub async fn home(&self) -> Result<Vec<Shelf>, Error> {
        let body = serde_json::json!({ "browseId": "FEmusic_home" });
        let v = self.call("browse", body).await?;

        let mut shelves = Vec::new();
        if let Some(sections) = v
            .pointer("/contents/singleColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents")
            .and_then(|x| x.as_array())
        {
            for section in sections {
                let (title, contents) = if let Some(c) = section.get("musicCarouselShelfRenderer") {
                    (
                        title_of(c, "/header/musicCarouselShelfBasicHeaderRenderer/title/runs/0/text"),
                        c.get("contents"),
                    )
                } else if let Some(c) = section.get("musicImmersiveCarouselShelfRenderer") {
                    (
                        title_of(
                            c,
                            "/header/musicImmersiveCarouselShelfHeaderRenderer/title/runs/0/text",
                        ),
                        c.get("contents"),
                    )
                } else {
                    continue;
                };

                let items = contents
                    .and_then(|x| x.as_array())
                    .map(|arr| arr.iter().filter_map(parse_item).collect::<Vec<_>>())
                    .unwrap_or_default();

                if !items.is_empty() {
                    shelves.push(Shelf {
                        title: title.unwrap_or_default(),
                        items,
                    });
                }
            }
        }
        Ok(shelves)
    }
}

/// Parse `playlistPanelVideoRenderer` entries from a `next` response, skipping
/// the seed track itself.
fn parse_up_next(v: &Value, seed_id: Option<&str>) -> Vec<Item> {
    let contents = v
        .pointer("/contents/singleColumnMusicWatchNextResultsRenderer/tabbedRenderer/watchNextTabbedResultsRenderer/tabs/0/tabRenderer/content/musicQueueRenderer/content/playlistPanelRenderer/contents")
        .and_then(|x| x.as_array());
    let mut out = Vec::new();
    for entry in contents.into_iter().flatten() {
        let r = entry
            .get("playlistPanelVideoRenderer")
            .or_else(|| entry.pointer("/playlistPanelVideoWrapperRenderer/primaryRenderer/playlistPanelVideoRenderer"));
        if let Some(item) = r.and_then(parse_panel_video) {
            if seed_id.is_none() || item.video_id.as_deref() != seed_id {
                out.push(item);
            }
        }
    }
    out
}

fn parse_panel_video(r: &Value) -> Option<Item> {
    let video_id = r.get("videoId")?.as_str()?.to_string();
    let mut item = Item {
        kind: "song".to_string(),
        video_id: Some(video_id),
        title: text_join(r.pointer("/title/runs")),
        ..Default::default()
    };
    if let Some(runs) = r.pointer("/longBylineText/runs").and_then(|x| x.as_array()) {
        for run in runs {
            let text = run.get("text").and_then(|t| t.as_str()).unwrap_or("");
            let browse = run
                .pointer("/navigationEndpoint/browseEndpoint/browseId")
                .and_then(|b| b.as_str());
            match browse {
                Some(b) if b.starts_with("UC") && !text.is_empty() => {
                    item.artists.push(text.to_string());
                    item.artist_id.get_or_insert_with(|| b.to_string());
                }
                Some(b) if b.starts_with("MPREb_") => {
                    item.album_id.get_or_insert_with(|| b.to_string());
                }
                _ => {}
            }
        }
    }
    item.subtitle = item.artists.join(", ");
    item.duration_ms = r
        .pointer("/lengthText/runs/0/text")
        .and_then(|t| t.as_str())
        .and_then(parse_duration);
    item.thumbnails = parse_thumbnails(r.pointer("/thumbnail/thumbnails"));
    item.explicit = r
        .get("badges")
        .map(|b| b.to_string().contains("musicExplicitBadgeRenderer"))
        .unwrap_or(false);
    Some(item)
}

fn collect_items(contents: Option<&Value>, out: &mut Vec<Item>) {
    if let Some(arr) = contents.and_then(|x| x.as_array()) {
        for it in arr {
            if let Some(item) = parse_item(it) {
                out.push(item);
            }
        }
    }
}

fn title_of(v: &Value, path: &str) -> Option<String> {
    v.pointer(path)
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
}

fn parse_item(value: &Value) -> Option<Item> {
    if let Some(r) = value.get("musicResponsiveListItemRenderer") {
        return parse_song(r);
    }
    if let Some(r) = value.get("musicTwoRowItemRenderer") {
        return Some(parse_two_row(r));
    }
    if let Some(r) = value.get("musicCardShelfRenderer") {
        return parse_card(r);
    }
    None
}

fn parse_card(r: &Value) -> Option<Item> {
    let content = r.get("content")?;
    if let Some(song) = content.get("musicResponsiveListItemRenderer") {
        return parse_song(song);
    }
    if let Some(tr) = content.get("musicTwoRowItemRenderer") {
        return Some(parse_two_row(tr));
    }
    None
}

fn parse_song(r: &Value) -> Option<Item> {
    let video_id = r
        .pointer("/playlistItemData/videoId")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| {
            r.pointer(
                "/flexColumns/0/musicResponsiveListItemFlexColumnRenderer/text/runs/0/navigationEndpoint/watchEndpoint/videoId",
            )
            .and_then(|v| v.as_str())
            .map(String::from)
        });

    let Some(video_id) = video_id else {
        return parse_list_browse(r);
    };

    let mut item = Item {
        kind: "song".to_string(),
        video_id: Some(video_id),
        ..Default::default()
    };

    item.title = text_join(
        r.pointer("/flexColumns/0/musicResponsiveListItemFlexColumnRenderer/text/runs"),
    );

    if let Some(runs) = r
        .pointer("/flexColumns/1/musicResponsiveListItemFlexColumnRenderer/text/runs")
        .and_then(|x| x.as_array())
    {
        for run in runs {
            let text = run.get("text").and_then(|t| t.as_str()).unwrap_or("");
            let browse = run
                .pointer("/navigationEndpoint/browseEndpoint/browseId")
                .and_then(|b| b.as_str());
            if let Some(b) = browse {
                if b.starts_with("UC") && !text.is_empty() {
                    item.artists.push(text.to_string());
                    item.artist_id.get_or_insert_with(|| b.to_string());
                } else if b.starts_with("MPREb_") {
                    item.album_id.get_or_insert_with(|| b.to_string());
                }
            }
        }
    }
    item.subtitle = item.artists.join(", ");

    item.duration_ms = r
        .pointer("/fixedColumns/0/musicResponsiveListItemFixedColumnRenderer/text/runs/0/text")
        .and_then(|t| t.as_str())
        .and_then(parse_duration)
        .or_else(|| {
            // Search results put the length in the subtitle: "Artist • Album • 4:12".
            r.pointer("/flexColumns/1/musicResponsiveListItemFlexColumnRenderer/text/runs")
                .and_then(|x| x.as_array())
                .and_then(|runs| {
                    runs.iter().rev().find_map(|run| {
                        let t = run.get("text")?.as_str()?.trim();
                        let is_clock = t.contains(':')
                            && t.split(':').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
                        if is_clock { parse_duration(t) } else { None }
                    })
                })
        });

    item.thumbnails =
        parse_thumbnails(r.pointer("/thumbnail/musicThumbnailRenderer/thumbnail/thumbnails"));
    item.explicit = r
        .get("badges")
        .map(|b| b.to_string().contains("musicExplicitBadgeRenderer"))
        .unwrap_or(false);

    Some(item)
}

fn parse_two_row(r: &Value) -> Item {
    let mut item = Item::default();
    item.title = r
        .pointer("/title/runs/0/text")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    item.subtitle = text_join(r.pointer("/subtitle/runs"));
    item.browse_id = r
        .pointer("/navigationEndpoint/browseEndpoint/browseId")
        .and_then(|b| b.as_str())
        .map(String::from);

    let page_type = r
        .pointer(
            "/navigationEndpoint/browseEndpoint/browseEndpointContextSupportedConfigs/browseEndpointContextMusicConfig/pageType",
        )
        .and_then(|t| t.as_str())
        .unwrap_or("");

    item.kind = match page_type {
        "MUSIC_PAGE_TYPE_ALBUM" => "album",
        "MUSIC_PAGE_TYPE_ARTIST" => "artist",
        "MUSIC_PAGE_TYPE_PLAYLIST" => "playlist",
        _ => kind_from_browse_id(item.browse_id.as_deref()),
    }
    .to_string();

    item.thumbnails =
        parse_thumbnails(r.pointer("/thumbnailRenderer/musicThumbnailRenderer/thumbnail/thumbnails"));

    // Songs / videos in carousels navigate to a watch endpoint, not a page.
    if let Some(vid) = r
        .pointer("/navigationEndpoint/watchEndpoint/videoId")
        .and_then(|v| v.as_str())
    {
        item.kind = "song".to_string();
        item.video_id = Some(vid.to_string());
        item.browse_id = None;
    }
    if let Some(runs) = r.pointer("/subtitle/runs").and_then(|x| x.as_array()) {
        for run in runs {
            let text = run.get("text").and_then(|t| t.as_str()).unwrap_or("");
            if let Some(b) = run
                .pointer("/navigationEndpoint/browseEndpoint/browseId")
                .and_then(|b| b.as_str())
            {
                if b.starts_with("UC") && !text.is_empty() {
                    item.artists.push(text.to_string());
                    item.artist_id.get_or_insert_with(|| b.to_string());
                }
            }
        }
    }
    item
}

/// A list row that opens a page (artist / album / playlist in search results).
fn parse_list_browse(r: &Value) -> Option<Item> {
    let ep = r.pointer("/navigationEndpoint/browseEndpoint")?;
    let browse_id = ep.get("browseId")?.as_str()?.to_string();
    let page_type = ep
        .pointer("/browseEndpointContextSupportedConfigs/browseEndpointContextMusicConfig/pageType")
        .and_then(|t| t.as_str())
        .unwrap_or("");
    let kind = match page_type {
        "MUSIC_PAGE_TYPE_ALBUM" => "album",
        "MUSIC_PAGE_TYPE_ARTIST" => "artist",
        "MUSIC_PAGE_TYPE_PLAYLIST" => "playlist",
        // Podcasts, episodes, user channels: not supported.
        _ => return None,
    };
    let title = text_join(r.pointer("/flexColumns/0/musicResponsiveListItemFlexColumnRenderer/text/runs"));
    // Subtitle without the leading "Album • " type label.
    let sub = text_join(r.pointer("/flexColumns/1/musicResponsiveListItemFlexColumnRenderer/text/runs"));
    let subtitle = sub.split_once(" • ").map(|(_, rest)| rest.to_string()).unwrap_or(sub);
    Some(Item {
        kind: kind.to_string(),
        browse_id: Some(browse_id),
        title,
        subtitle,
        thumbnails: parse_thumbnails(r.pointer("/thumbnail/musicThumbnailRenderer/thumbnail/thumbnails")),
        ..Default::default()
    })
}

/// Parse a carousel shelf (`musicCarouselShelfRenderer`) into a titled shelf.
fn parse_carousel(c: &Value) -> Option<Shelf> {
    let title = title_of(c, "/header/musicCarouselShelfBasicHeaderRenderer/title/runs/0/text").unwrap_or_default();
    let items: Vec<Item> = c
        .get("contents")?
        .as_array()?
        .iter()
        .filter_map(parse_item)
        .collect();
    (!items.is_empty()).then_some(Shelf { title, items })
}

fn parse_artist(v: &Value) -> Artist {
    let mut a = Artist::default();
    // Header renderer name varies (immersive / visual); take whichever is present.
    if let Some(h) = v.get("header").and_then(|h| h.as_object()).and_then(|o| o.values().next()) {
        a.name = text_join(h.pointer("/title/runs"));
        a.description = text_join(h.pointer("/description/runs"));
        a.audience = text_join(h.pointer("/monthlyListenerCount/runs"));
        a.thumbnails = parse_thumbnails(
            h.pointer("/thumbnail/musicThumbnailRenderer/thumbnail/thumbnails")
                .or_else(|| h.pointer("/foregroundThumbnail/musicThumbnailRenderer/thumbnail/thumbnails")),
        );
        let radio = |p: &str| {
            let ep = h.pointer(p)?;
            Some(Radio {
                video_id: ep.get("videoId")?.as_str()?.to_string(),
                playlist_id: ep.get("playlistId")?.as_str()?.to_string(),
            })
        };
        a.radio = radio("/startRadioButton/buttonRenderer/navigationEndpoint/watchEndpoint");
        a.shuffle = radio("/playButton/buttonRenderer/navigationEndpoint/watchEndpoint");
    }
    let sections = v
        .pointer("/contents/singleColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents")
        .and_then(|x| x.as_array());
    for s in sections.into_iter().flatten() {
        if let Some(r) = s.get("musicShelfRenderer") {
            // "Top songs"
            collect_items(r.get("contents"), &mut a.top_songs);
            a.top_songs.retain(|i| i.video_id.is_some());
            a.top_songs_id = r
                .pointer("/title/runs/0/navigationEndpoint/browseEndpoint/browseId")
                .or_else(|| r.pointer("/bottomEndpoint/browseEndpoint/browseId"))
                .and_then(|b| b.as_str())
                .map(String::from);
        } else if let Some(shelf) = s.get("musicCarouselShelfRenderer").and_then(parse_carousel) {
            a.shelves.push(shelf);
        } else if a.description.is_empty() {
            if let Some(d) = s.get("musicDescriptionShelfRenderer") {
                a.description = text_join(d.pointer("/description/runs"));
            }
        }
    }
    a
}

fn parse_collection(v: &Value, browse_id: &str) -> Collection {
    let mut c = Collection {
        browse_id: browse_id.to_string(),
        kind: if browse_id.starts_with("MPREb_") { "album" } else { "playlist" }.to_string(),
        ..Default::default()
    };
    let root = v.pointer("/contents/twoColumnBrowseResultsRenderer");
    if let Some(h) = root.and_then(|r| {
        r.pointer("/tabs/0/tabRenderer/content/sectionListRenderer/contents/0/musicResponsiveHeaderRenderer")
            .or_else(|| r.pointer("/tabs/0/tabRenderer/content/sectionListRenderer/contents/0/musicEditablePlaylistDetailHeaderRenderer/header/musicResponsiveHeaderRenderer"))
    }) {
        c.title = text_join(h.pointer("/title/runs"));
        c.subtitle = text_join(h.pointer("/subtitle/runs"));
        c.stats = text_join(h.pointer("/secondSubtitle/runs"));
        c.description = text_join(h.pointer("/description/musicDescriptionShelfRenderer/description/runs"));
        c.thumbnails = parse_thumbnails(h.pointer("/thumbnail/musicThumbnailRenderer/thumbnail/thumbnails"));
        if let Some(run) = h.pointer("/straplineTextOne/runs/0") {
            c.artist = run.get("text").and_then(|t| t.as_str()).map(String::from);
            c.artist_id = run
                .pointer("/navigationEndpoint/browseEndpoint/browseId")
                .and_then(|b| b.as_str())
                .map(String::from);
        }
    }
    let sections = root
        .and_then(|r| r.pointer("/secondaryContents/sectionListRenderer/contents"))
        .and_then(|x| x.as_array());
    for s in sections.into_iter().flatten() {
        let shelf = s.get("musicShelfRenderer").or_else(|| s.get("musicPlaylistShelfRenderer"));
        if let Some(r) = shelf {
            for it in r.get("contents").and_then(|x| x.as_array()).into_iter().flatten() {
                if let Some(tok) = continuation_token(it) {
                    c.continuation = Some(tok);
                } else if let Some(item) = it.get("musicResponsiveListItemRenderer").and_then(parse_song) {
                    push_track(&mut c, item);
                }
            }
        } else if let Some(shelf) = s.get("musicCarouselShelfRenderer").and_then(parse_carousel) {
            c.shelves.push(shelf);
        }
    }
    c
}

fn continuation_token(it: &Value) -> Option<String> {
    it.pointer("/continuationItemRenderer/continuationEndpoint/continuationCommand/token")
        .and_then(|t| t.as_str())
        .map(String::from)
}

/// Add a track to a collection, filling in what album rows leave out.
fn push_track(c: &mut Collection, mut item: Item) {
    if item.video_id.is_none() {
        return;
    }
    // Album rows carry neither artist nor artwork: inherit from the header.
    if item.artists.is_empty() {
        if let Some(a) = &c.artist {
            item.artists.push(a.clone());
            item.subtitle = a.clone();
            item.artist_id = c.artist_id.clone();
        }
    }
    if item.thumbnails.is_empty() {
        item.thumbnails = c.thumbnails.clone();
    }
    if c.kind == "album" {
        item.album_id = Some(c.browse_id.clone());
    }
    c.tracks.push(item);
}

fn kind_from_browse_id(id: Option<&str>) -> &'static str {
    match id {
        Some(b) if b.starts_with("UC") => "artist",
        Some(b) if b.starts_with("MPREb_") => "album",
        Some(b) if b.starts_with("VL") || b.starts_with("RD") => "playlist",
        _ => "album",
    }
}

fn text_join(v: Option<&Value>) -> String {
    v.and_then(|x| x.as_array())
        .map(|runs| {
            runs.iter()
                .filter_map(|x| x.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

fn parse_thumbnails(v: Option<&Value>) -> Vec<Thumbnail> {
    v.and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| {
                    Some(Thumbnail {
                        url: t.get("url")?.as_str()?.to_string(),
                        width: t.get("width").and_then(|w| w.as_u64()).unwrap_or(0) as u32,
                        height: t.get("height").and_then(|h| h.as_u64()).unwrap_or(0) as u32,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_duration(s: &str) -> Option<u64> {
    let parts: Vec<u64> = s
        .split(':')
        .filter_map(|p| p.trim().parse::<u64>().ok())
        .collect();
    if parts.is_empty() {
        return None;
    }
    let mut total = 0u64;
    for p in parts {
        total = total * 60 + p;
    }
    Some(total * 1000)
}

fn truncate(s: &str, n: usize) -> String {
    match s.char_indices().nth(n) {
        None => s.to_string(),
        Some((i, _)) => format!("{}…", &s[..i]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "requires network access"]
    async fn search_returns_items() {
        let it = InnerTube::new().unwrap();
        let items = it.search("lofi hip hop").await.unwrap();
        assert!(!items.is_empty(), "search returned no items");
        for i in items.iter().take(6) {
            println!(
                "[{}] video={:?} browse={:?} title={:?} artists={:?} dur={:?}",
                i.kind, i.video_id, i.browse_id, i.title, i.artists, i.duration_ms
            );
        }
        assert!(
            items.iter().any(|i| i.kind == "song" && i.video_id.is_some()),
            "expected at least one playable song"
        );
    }

    #[test]
    fn truncate_is_utf8_safe() {
        assert_eq!(truncate("héllo wörld", 4), "héll…");
        assert_eq!(truncate("ab", 4), "ab");
    }

    #[tokio::test]
    #[ignore = "requires network access"]
    async fn up_next_returns_tracks() {
        let it = InnerTube::new().unwrap();
        let items = it.up_next("1N8hOpMqvYs", None).await.unwrap();
        for i in items.iter().take(5) {
            println!("{:?} {:?} {:?} {:?}", i.video_id, i.title, i.artists, i.duration_ms);
        }
        assert!(!items.is_empty(), "up_next returned nothing");
        assert!(items.iter().all(|i| i.video_id.as_deref() != Some("1N8hOpMqvYs")));
    }

    #[tokio::test]
    #[ignore = "requires network access"]
    async fn pages_parse() {
        let it = InnerTube::new().unwrap();
        let a = it.artist("UCRr1xG_2WIDs18a6cIiCxeA").await.unwrap();
        println!("artist {} | {} | radio={:?} | top={} top_id={:?}", a.name, a.audience, a.radio, a.top_songs.len(), a.top_songs_id);
        for s in &a.shelves {
            println!("  shelf '{}' {} first={:?}/{:?}", s.title, s.items.len(), s.items[0].kind, s.items[0].title);
        }
        assert!(!a.name.is_empty() && !a.top_songs.is_empty());

        let al = it.collection("MPREb_BQHrCwSBM37").await.unwrap();
        println!("album {} | {} | {} | by {:?} {:?} | tracks {} | t0 {:?} {:?}", al.title, al.subtitle, al.stats, al.artist, al.artist_id, al.tracks.len(), al.tracks[0].title, al.tracks[0].artists);
        assert!(al.tracks.len() > 10);

        let pl = it.collection("VLOLAK5uy_lNVBcjNtiCwq-n95uoxJ-Gd4vsfMkyZNs").await.unwrap();
        println!("playlist {} | {} | tracks {}", pl.title, pl.stats, pl.tracks.len());
        assert!(pl.tracks.len() > 100, "continuation not followed");

        let r = a.radio.unwrap();
        let mix = it.up_next(&r.video_id, Some(&r.playlist_id)).await.unwrap();
        println!("artist mix {} tracks, first {:?}", mix.len(), mix.first().map(|m| &m.title));
        assert!(!mix.is_empty());

        let s = it.search("daft punk").await.unwrap();
        let others: Vec<_> = s.iter().filter(|i| i.kind != "song").map(|i| format!("{}:{}", i.kind, i.title)).collect();
        println!("search non-songs: {:?}", &others[..others.len().min(6)]);
        assert!(s.iter().any(|i| i.kind == "artist"));
    }

    #[tokio::test]
    #[ignore = "requires network access"]
    async fn home_returns_shelves() {
        let it = InnerTube::new().unwrap();
        let shelves = it.home().await.unwrap();
        println!("shelves = {}", shelves.len());
        for s in shelves.iter().take(10) {
            println!("  '{}' -> {} items", s.title, s.items.len());
        }
    }
}
