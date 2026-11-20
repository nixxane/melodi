//! Signed, expiring song URLs: `/a/<id>?e=<expiry>&t=<hmac>`.
//!
//! Only `prepare_stream` (which is rate limited) hands them out, so other
//! sites can't use the relay as a free YouTube audio proxy.

use std::time::{SystemTime, UNIX_EPOCH};

use hmac::{Hmac, Mac};
use sha2::Sha256;

/// Long enough to pause a song for an evening and resume it.
const VALID_SECS: u64 = 12 * 3600;

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn mac(secret: &[u8], id: &str, exp: u64) -> Hmac<Sha256> {
    let mut m = Hmac::<Sha256>::new_from_slice(secret).expect("any key length works");
    m.update(format!("{id}.{exp}").as_bytes());
    m
}

/// (expiry, signature) for a song.
pub fn sign(secret: &[u8], id: &str) -> (u64, String) {
    let exp = now() + VALID_SECS;
    (exp, hex::encode(mac(secret, id, exp).finalize().into_bytes()))
}

pub fn verify(secret: &[u8], id: &str, exp: u64, sig: &str) -> bool {
    if exp < now() {
        return false;
    }
    let Ok(raw) = hex::decode(sig) else { return false };
    mac(secret, id, exp).verify_slice(&raw).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let (e, t) = sign(b"k", "dQw4w9WgXcQ");
        assert!(verify(b"k", "dQw4w9WgXcQ", e, &t));
        assert!(!verify(b"other", "dQw4w9WgXcQ", e, &t));
        assert!(!verify(b"k", "aaaaaaaaaaa", e, &t));
        assert!(!verify(b"k", "dQw4w9WgXcQ", e + 1, &t));
        assert!(!verify(b"k", "dQw4w9WgXcQ", 1, &t));
    }
}
