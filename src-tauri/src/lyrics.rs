//! Lyrics lookup.
//!
//! 1. LRCLIB (https://lrclib.net) — free, open database with time-synced
//!    lyrics. Queried by track title / artist / duration only.
//! 2. YouTube Music's own lyrics tab (plain text, usually from Musixmatch).

use serde::{Deserialize, Serialize};

use crate::innertube::InnerTube;
use crate::Error;

#[derive(Debug, Clone, Serialize)]
pub struct LyricLine {
    /// Start time in milliseconds.
    pub t: u64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Lyrics {
    pub source: String,
    pub synced: Option<Vec<LyricLine>>,
    pub plain: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LrcRecord {
    plain_lyrics: Option<String>,
    synced_lyrics: Option<String>,
    instrumental: Option<bool>,
    duration: Option<f64>,
}

pub struct LyricsClient {
    http: reqwest::Client,
}

impl LyricsClient {
    pub fn new() -> Result<Self, Error> {
        let http = reqwest::Client::builder()
            .user_agent("Melodi/0.1 (desktop music player)")
            .timeout(std::time::Duration::from_secs(8))
            .build()?;
        Ok(Self { http })
    }

    pub async fn find(
        &self,
        yt: &InnerTube,
        video_id: &str,
        title: &str,
        artist: &str,
        duration_ms: Option<u64>,
    ) -> Result<Lyrics, Error> {
        if let Some(l) = self.lrclib(title, artist, duration_ms).await {
            return Ok(l);
        }
        let clean = clean_title(title);
        if clean != title {
            if let Some(l) = self.lrclib(&clean, artist, duration_ms).await {
                return Ok(l);
            }
        }
        if let Some((text, footer)) = yt.lyrics_text(video_id).await? {
            return Ok(Lyrics {
                source: footer.unwrap_or_else(|| "YouTube Music".into()),
                synced: None,
                plain: Some(text),
            });
        }
        Ok(Lyrics::default())
    }

    /// Exact match first (fast, uses duration), then a fuzzy search.
    async fn lrclib(&self, title: &str, artist: &str, duration_ms: Option<u64>) -> Option<Lyrics> {
        let mut q = vec![("track_name", title.to_string()), ("artist_name", artist.to_string())];
        if let Some(d) = duration_ms {
            q.push(("duration", (d / 1000).to_string()));
        }
        if let Ok(r) = self.http.get("https://lrclib.net/api/get").query(&q).send().await {
            if r.status().is_success() {
                if let Ok(rec) = r.json::<LrcRecord>().await {
                    if let Some(l) = to_lyrics(rec) {
                        return Some(l);
                    }
                }
            }
        }

        let r = self
            .http
            .get("https://lrclib.net/api/search")
            .query(&[("track_name", title), ("artist_name", artist)])
            .send()
            .await
            .ok()?;
        let recs: Vec<LrcRecord> = r.json().await.ok()?;
        let target = duration_ms.map(|d| d as f64 / 1000.0);
        // Prefer synced lyrics whose duration is close to the track's.
        let close = |rec: &LrcRecord| match (target, rec.duration) {
            (Some(t), Some(d)) => (t - d).abs() <= 5.0,
            _ => true,
        };
        let mut recs: Vec<LrcRecord> = recs.into_iter().filter(close).collect();
        recs.sort_by_key(|r| r.synced_lyrics.is_none());
        recs.into_iter().find_map(to_lyrics)
    }
}

fn to_lyrics(rec: LrcRecord) -> Option<Lyrics> {
    if rec.instrumental == Some(true) {
        return Some(Lyrics {
            source: "LRCLIB".into(),
            synced: None,
            plain: Some("♪ instrumental ♪".into()),
        });
    }
    let synced = rec.synced_lyrics.as_deref().map(parse_lrc).filter(|l| !l.is_empty());
    let plain = rec.plain_lyrics.filter(|p| !p.trim().is_empty());
    if synced.is_none() && plain.is_none() {
        return None;
    }
    Some(Lyrics { source: "LRCLIB".into(), synced, plain })
}

/// Parse `[mm:ss.xx] text` lines (a line may carry several timestamps).
pub fn parse_lrc(s: &str) -> Vec<LyricLine> {
    let mut out = Vec::new();
    for line in s.lines() {
        let mut rest = line.trim();
        let mut stamps = Vec::new();
        while let Some(stripped) = rest.strip_prefix('[') {
            let Some(end) = stripped.find(']') else { break };
            if let Some(t) = parse_stamp(&stripped[..end]) {
                stamps.push(t);
            }
            rest = stripped[end + 1..].trim_start();
        }
        for t in stamps {
            out.push(LyricLine { t, text: rest.to_string() });
        }
    }
    out.sort_by_key(|l| l.t);
    out
}

fn parse_stamp(s: &str) -> Option<u64> {
    let (m, sec) = s.split_once(':')?;
    let m: u64 = m.trim().parse().ok()?;
    let sec: f64 = sec.trim().parse().ok()?;
    Some(m * 60_000 + (sec * 1000.0).round() as u64)
}

/// Drop decorations that lyric databases don't use: "(feat. …)",
/// "(Radio Edit)", "- Remastered 2011", "[Official Video]".
fn clean_title(t: &str) -> String {
    let mut s = t.to_string();
    for (open, close) in [('(', ')'), ('[', ']')] {
        while let (Some(a), Some(b)) = (s.find(open), s.find(close)) {
            if b <= a {
                break;
            }
            s.replace_range(a..=b, "");
        }
    }
    if let Some(i) = s.find(" - ") {
        s.truncate(i);
    }
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lrc_and_cleans_titles() {
        let l = parse_lrc("[00:12.50] Hello\n[01:02.00][01:30.00] Chorus\nno stamp");
        assert_eq!(l.len(), 3);
        assert_eq!(l[0].t, 12_500);
        assert_eq!(l[1].text, "Chorus");
        assert_eq!(l[2].t, 90_000);
        assert_eq!(clean_title("Get Lucky (Radio Edit - feat. Pharrell) - Remastered"), "Get Lucky");
        assert_eq!(clean_title("One More Time"), "One More Time");
    }
}
