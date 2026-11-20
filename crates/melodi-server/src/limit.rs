//! Per-IP rate limits (fixed windows, in memory).

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub enum Bucket {
    /// Search, browse, lyrics…
    Api,
    /// Starting or prefetching a song (runs yt-dlp, downloads audio).
    Stream,
    /// Playlist imports (hundreds of searches each).
    Import,
}

impl Bucket {
    /// (requests, window seconds)
    fn limit(self) -> (u32, u64) {
        match self {
            Bucket::Api => (300, 60),
            Bucket::Stream => (60, 60),
            Bucket::Import => (5, 600),
        }
    }
}

#[derive(Default)]
pub struct Limiter {
    /// (ip, bucket) -> (window number, count)
    hits: Mutex<HashMap<(IpAddr, Bucket), (u64, u32)>>,
}

impl Limiter {
    pub fn allow(&self, ip: IpAddr, bucket: Bucket) -> bool {
        let (max, secs) = bucket.limit();
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let window = now / secs;
        let Ok(mut m) = self.hits.lock() else { return true };
        if m.len() > 200_000 {
            m.retain(|(_, b), (w, _)| *w == now / b.limit().1);
        }
        let e = m.entry((ip, bucket)).or_insert((window, 0));
        if e.0 != window {
            *e = (window, 0);
        }
        e.1 += 1;
        e.1 <= max
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_per_ip_and_bucket() {
        let l = Limiter::default();
        let a: IpAddr = "1.2.3.4".parse().unwrap();
        let b: IpAddr = "5.6.7.8".parse().unwrap();
        for _ in 0..5 {
            assert!(l.allow(a, Bucket::Import));
        }
        assert!(!l.allow(a, Bucket::Import));
        assert!(l.allow(b, Bucket::Import));
        assert!(l.allow(a, Bucket::Api));
    }
}
