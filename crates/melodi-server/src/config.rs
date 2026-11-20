//! Settings from environment variables (documented in README.md).

use std::net::SocketAddr;
use std::path::PathBuf;

pub enum TrustProxy {
    /// Use the TCP peer address.
    None,
    /// Behind Cloudflare: `CF-Connecting-IP`.
    Cloudflare,
    /// Behind another reverse proxy: first `X-Forwarded-For` entry.
    Forwarded,
}

pub struct Config {
    pub addr: SocketAddr,
    pub data_dir: PathBuf,
    pub cache_bytes: u64,
    /// e.g. `https://api.getmelodi.xyz`; otherwise taken from the request.
    pub public_url: Option<String>,
    /// CORS origins; None allows any.
    pub allowed_origins: Option<Vec<String>>,
    pub trust_proxy: TrustProxy,
    /// Signs song URLs.
    pub secret: Vec<u8>,
    /// Built web app to serve as well (optional).
    pub web_dir: Option<PathBuf>,
}

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

impl Config {
    pub fn from_env() -> Self {
        let addr = var("MELODI_ADDR")
            .unwrap_or_else(|| "0.0.0.0:8080".into())
            .parse()
            .expect("MELODI_ADDR must look like 0.0.0.0:8080");
        let data_dir = PathBuf::from(var("MELODI_DATA_DIR").unwrap_or_else(|| "data".into()));
        let cache_gb: f64 = var("MELODI_CACHE_GB").and_then(|v| v.parse().ok()).unwrap_or(20.0);
        let secret = match var("MELODI_SECRET") {
            Some(s) => s.into_bytes(),
            None => {
                eprintln!("[melodi] MELODI_SECRET is not set: song links stop working after a restart");
                random_secret()
            }
        };
        Self {
            addr,
            data_dir,
            cache_bytes: (cache_gb * 1024.0 * 1024.0 * 1024.0) as u64,
            public_url: var("MELODI_PUBLIC_URL").map(|u| u.trim_end_matches('/').to_string()),
            allowed_origins: var("MELODI_ALLOWED_ORIGINS")
                .map(|v| v.split(',').map(|o| o.trim().trim_end_matches('/').to_string()).filter(|o| !o.is_empty()).collect()),
            trust_proxy: match var("MELODI_TRUST_PROXY").as_deref() {
                Some("cloudflare") => TrustProxy::Cloudflare,
                Some("forwarded") => TrustProxy::Forwarded,
                _ => TrustProxy::None,
            },
            secret,
            web_dir: var("MELODI_WEB_DIR").map(PathBuf::from),
        }
    }
}

fn random_secret() -> Vec<u8> {
    use std::hash::{BuildHasher, Hasher};
    (0..4)
        .flat_map(|i| {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u32(i);
            h.finish().to_le_bytes()
        })
        .collect()
}
