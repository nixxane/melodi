//! Live streams (24/7 radio, live sets).
//!
//! YouTube serves live audio only as HLS: a playlist of ~5 s segments that is
//! refreshed as the broadcast goes on. WebView2 can't play HLS by itself, but
//! YouTube's audio-only live segments are plain ADTS AAC, each starting with a
//! small ID3 timestamp tag. So the audio proxy follows the playlist, strips the
//! tags and joins the segments into one endless `audio/aac` stream that a
//! normal `<audio>` element plays like an internet radio station.

use std::time::Duration;

use crate::Error;

/// How far behind the live edge playback starts. A few segments of buffer
/// smooth over slow playlist refreshes.
const START_SEGMENTS: usize = 3;

#[derive(Debug, PartialEq)]
pub struct Playlist {
    /// Media sequence number of `segments[0]`.
    pub first_seq: u64,
    /// Segment length the server aims for, in seconds.
    pub target_secs: f64,
    pub segments: Vec<String>,
    /// The broadcast is over (`#EXT-X-ENDLIST`).
    pub ended: bool,
}

/// What went wrong while following a live stream. (Payloads are logged via Debug.)
#[allow(dead_code)]
#[derive(Debug)]
pub enum LiveError {
    /// The signed playlist/segment URL expired or was revoked: resolve again.
    Expired,
    /// The stream isn't something we can turn into plain AAC.
    Unsupported(&'static str),
    Other(Error),
}

impl From<reqwest::Error> for LiveError {
    fn from(e: reqwest::Error) -> Self {
        LiveError::Other(e.into())
    }
}

/// Parse an HLS media playlist. Segment URIs are made absolute against `base`.
/// Returns None for a master playlist or something that isn't HLS.
pub fn parse_playlist(text: &str, base: &str) -> Option<Playlist> {
    let mut lines = text.lines().map(str::trim);
    if lines.next()? != "#EXTM3U" {
        return None;
    }
    let mut first_seq = 0;
    let mut target_secs = 5.0;
    let mut segments = Vec::new();
    let mut ended = false;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if let Some(v) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            first_seq = v.trim().parse().ok()?;
        } else if let Some(v) = line.strip_prefix("#EXT-X-TARGETDURATION:") {
            target_secs = v.trim().parse().unwrap_or(5.0);
        } else if line.starts_with("#EXT-X-ENDLIST") {
            ended = true;
        } else if line.starts_with("#EXT-X-STREAM-INF") {
            return None; // master playlist
        } else if !line.starts_with('#') {
            segments.push(absolute(line, base));
        }
    }
    Some(Playlist { first_seq, target_secs, segments, ended })
}

fn absolute(uri: &str, base: &str) -> String {
    if uri.starts_with("http://") || uri.starts_with("https://") {
        return uri.to_string();
    }
    let base = base.split(['?', '#']).next().unwrap_or(base);
    let scheme_end = base.find("://").map(|i| i + 3).unwrap_or(0);
    if uri.starts_with('/') {
        let host_end = base[scheme_end..].find('/').map(|i| scheme_end + i).unwrap_or(base.len());
        format!("{}{uri}", &base[..host_end])
    } else {
        let dir_end = base.rfind('/').filter(|&i| i >= scheme_end).map(|i| i + 1).unwrap_or(base.len());
        format!("{}{uri}", &base[..dir_end])
    }
}

/// Drop leading ID3v2 tags (YouTube puts a timestamp tag on every segment).
pub fn strip_id3(mut b: &[u8]) -> &[u8] {
    while b.len() >= 10 && &b[..3] == b"ID3" {
        let size = b[6..10].iter().fold(0usize, |acc, &x| (acc << 7) | (x & 0x7f) as usize);
        let footer = if b[5] & 0x10 != 0 { 10 } else { 0 };
        let total = 10 + size + footer;
        if total > b.len() {
            return &[];
        }
        b = &b[total..];
    }
    b
}

fn is_adts(b: &[u8]) -> bool {
    b.len() >= 2 && b[0] == 0xFF && (b[1] & 0xF6) == 0xF0
}

fn is_mpeg_ts(b: &[u8]) -> bool {
    b.len() > 188 && b[0] == 0x47 && b[188] == 0x47
}

/// Follows one live playlist and hands out audio in order.
pub struct LiveFeed {
    http: reqwest::Client,
    url: String,
    /// Sequence number of the next segment to hand out (None until the first
    /// playlist is read).
    next_seq: Option<u64>,
    pending: std::collections::VecDeque<(u64, String)>,
    target: Duration,
    ended: bool,
}

impl LiveFeed {
    pub fn new(http: reqwest::Client, playlist_url: String) -> Self {
        Self {
            http,
            url: playlist_url,
            next_seq: None,
            pending: Default::default(),
            target: Duration::from_secs(5),
            ended: false,
        }
    }

    /// Swap in a freshly resolved playlist URL (after `Expired`), keeping our
    /// place in the stream.
    pub fn set_url(&mut self, url: String) {
        self.url = url;
        self.pending.clear();
    }

    /// Re-read the playlist and queue segments we haven't sent yet.
    async fn refresh(&mut self) -> Result<(), LiveError> {
        let resp = self.http.get(&self.url).timeout(Duration::from_secs(15)).send().await?;
        let status = resp.status();
        if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::NOT_FOUND {
            return Err(LiveError::Expired);
        }
        if !status.is_success() {
            return Err(LiveError::Other(Error::Msg(format!("live playlist returned {status}"))));
        }
        let text = resp.text().await?;
        let pl = parse_playlist(&text, &self.url).ok_or(LiveError::Unsupported("not a media playlist"))?;
        self.target = Duration::from_secs_f64(pl.target_secs.clamp(1.0, 15.0));
        self.ended = pl.ended;
        let n = pl.segments.len() as u64;
        let next = match self.next_seq {
            Some(s) => s,
            // Start a little behind the live edge (or at the top of a
            // finished recording).
            None if pl.ended => pl.first_seq,
            None => pl.first_seq + n.saturating_sub(START_SEGMENTS as u64),
        };
        // Fell out of the playlist window (long stall): jump to what's there.
        let next = next.max(pl.first_seq);
        self.pending.clear();
        for (i, url) in pl.segments.into_iter().enumerate() {
            let seq = pl.first_seq + i as u64;
            if seq >= next {
                self.pending.push_back((seq, url));
            }
        }
        self.next_seq = Some(next);
        Ok(())
    }

    /// The next piece of AAC audio. Waits for the broadcast when we're at the
    /// live edge. `Ok(None)` means the stream is over (ended, or it stopped
    /// producing segments for `give_up`).
    pub async fn next_chunk(&mut self, give_up: Duration) -> Result<Option<Vec<u8>>, LiveError> {
        let started = tokio::time::Instant::now();
        loop {
            if let Some((seq, url)) = self.pending.pop_front() {
                let resp = self.http.get(&url).timeout(Duration::from_secs(30)).send().await?;
                let status = resp.status();
                if status == reqwest::StatusCode::FORBIDDEN {
                    self.pending.push_front((seq, url));
                    return Err(LiveError::Expired);
                }
                self.next_seq = Some(seq + 1);
                if !status.is_success() {
                    // A missing segment: skip it rather than stopping the radio.
                    eprintln!("[melodi] live segment {seq} returned {status}");
                    continue;
                }
                let bytes = resp.bytes().await?;
                let audio = strip_id3(&bytes);
                if audio.is_empty() {
                    continue;
                }
                if !is_adts(audio) {
                    return Err(LiveError::Unsupported(if is_mpeg_ts(audio) {
                        "MPEG-TS live segments"
                    } else {
                        "unknown live segment format"
                    }));
                }
                return Ok(Some(audio.to_vec()));
            }
            if self.ended && self.next_seq.is_some() {
                return Ok(None);
            }
            if self.next_seq.is_some() {
                if started.elapsed() > give_up {
                    return Ok(None);
                }
                // At the live edge: wait about half a segment for new ones.
                tokio::time::sleep(self.target / 2).await;
            }
            self.refresh().await?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PL: &str = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:5\n#EXT-X-MEDIA-SEQUENCE:100\n\
#EXTINF:5.0,\nhttps://a.example/seg/100.ts\n#EXTINF:5.0,\n/abs/101.ts\n#EXTINF:5.0,\nrel/102.ts\n";

    #[test]
    fn parses_media_playlist() {
        let p = parse_playlist(PL, "https://h.example/dir/index.m3u8?x=1").unwrap();
        assert_eq!(p.first_seq, 100);
        assert_eq!(p.target_secs, 5.0);
        assert!(!p.ended);
        assert_eq!(
            p.segments,
            vec![
                "https://a.example/seg/100.ts".to_string(),
                "https://h.example/abs/101.ts".into(),
                "https://h.example/dir/rel/102.ts".into(),
            ]
        );
        assert!(parse_playlist("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n", "https://h/").is_none());
        assert!(parse_playlist("<html>", "https://h/").is_none());
        assert!(parse_playlist(&format!("{PL}#EXT-X-ENDLIST\n"), "https://h/").unwrap().ended);
    }

    #[test]
    fn strips_id3_tags() {
        // 10-byte header + 4-byte body (syncsafe size 4), then an ADTS frame.
        let mut seg = b"ID3\x03\x00\x00\x00\x00\x00\x04abcd".to_vec();
        seg.extend_from_slice(&[0xFF, 0xF1, 0x50, 0x80]);
        let audio = strip_id3(&seg);
        assert_eq!(audio, &[0xFF, 0xF1, 0x50, 0x80]);
        assert!(is_adts(audio));
        assert_eq!(strip_id3(b"plain"), b"plain");
        assert_eq!(strip_id3(b"ID3\x03\x00\x00\x00\x00\x7f\x7f"), b"");
        let mut ts = vec![0u8; 400];
        ts[0] = 0x47;
        ts[188] = 0x47;
        assert!(is_mpeg_ts(&ts) && !is_adts(&ts));
    }

    /// Resolves the Lofi Girl stream and writes ~15 s of it to
    /// `$TEMP/melodi-live.aac`. Set MELODI_LIVE_ID to try another stream.
    #[tokio::test]
    #[ignore = "requires network access and a running live stream"]
    async fn follows_a_live_stream() {
        let id = std::env::var("MELODI_LIVE_ID").unwrap_or_else(|_| "4t4AQ15yj1M".into());
        let dir = std::env::temp_dir().join("melodi-smoke");
        let cache = crate::ytdlp::StreamCache::default();
        let info = crate::ytdlp::resolve_stream(&dir, &cache, &id, false).await.unwrap();
        assert!(info.hls, "expected a live (HLS) stream");
        let mut feed = LiveFeed::new(reqwest::Client::new(), info.url);
        let mut out = Vec::new();
        for _ in 0..START_SEGMENTS {
            let chunk = feed.next_chunk(Duration::from_secs(30)).await.unwrap().unwrap();
            assert!(is_adts(&chunk));
            out.extend_from_slice(&chunk);
        }
        let path = std::env::temp_dir().join("melodi-live.aac");
        std::fs::write(&path, &out).unwrap();
        println!("wrote {} bytes to {}", out.len(), path.display());
    }
}
