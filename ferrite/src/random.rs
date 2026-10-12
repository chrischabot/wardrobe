//! Unpredictable tokens for OAuth codes, access and refresh tokens and
//! identifiers.
//!
//! Upstream Ferrite's SDK exports no random function, and the code gate
//! refuses `std::fs`, `rand` and `getrandom`. Its route to the operating
//! system's generator is key generation: `Ed25519SigningKey::generate_pkcs8()`
//! draws a fresh seed from the system generator on every call
//! (docs/building-on-upstream-core.md, "Entropy and the code gate"). Each 32
//! bytes here are the HMAC-SHA-256 of a fixed label keyed with one freshly
//! generated key document, which is then dropped and never signs anything.
//! The clock is never an input.

use ferrite_app::crypto::{hmac_sha256, Ed25519SigningKey};

use crate::sha256::hex;

const LABEL: &[u8] = b"wardrobe/ferrite/token/v1";

/// `n` unpredictable bytes.
pub fn bytes(n: usize) -> Vec<u8> {
    let mut out = vec![0u8; n];
    for chunk in out.chunks_mut(32) {
        let document = Ed25519SigningKey::generate_pkcs8();
        let block = hmac_sha256(&document, LABEL);
        chunk.copy_from_slice(&block[..chunk.len()]);
    }
    out
}

/// Lower-case hex of `n` unpredictable bytes (`2n` characters).
pub fn token(n: usize) -> String {
    hex(&bytes(n))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_distinct_and_of_the_asked_length() {
        let a = token(32);
        let b = token(32);
        assert_eq!((a.len(), b.len()), (64, 64));
        assert_ne!(a, b);
        assert_eq!(token(40).len(), 80);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
    }
}
