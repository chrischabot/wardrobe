//! The recovery kit, as `issueRecoveryKit` and recovery in apps/worker/src/identity/service.ts: a
//! one-time, high-entropy code the owner keeps offline, for signing in to the app when the owner
//! token is not at hand.
//!
//! This port has no identity provider, so the TypeScript Worker's recovery transaction (a new
//! Google sign-in proving the code at `/auth/recovery/complete`) has nothing to bind to. The app's
//! only login is its sign-in page (`/oauth/authorize` for the configured app), so that is where
//! the code is accepted, in place of the owner token. Using it ends every other sign-in of the app,
//! disconnects every connected assistant and spends the code, in the same commit that creates the
//! new sign-in. The owner then issues a new kit from Settings (`POST /v1/recovery-kit`); the owner
//! token itself is unchanged.
//!
//! Only a verifier is stored: the HMAC-SHA-256 of the normalised code under a random salt. The
//! code carries 256 random bits, so it cannot be guessed, and a check is one hash and a
//! constant-time comparison whether the code is malformed, unknown, wrong or right.
//!
//! Storage: `o/recovery-kit`, the one kit, written only in commits guarded on the grant store's
//! version (`oauth::GRANTS_EPOCH_KEY`), so issuing a kit, using it and creating sign-ins are
//! serialised with one another.

use ferrite_app::crypto::hmac_sha256;
use ferrite_app::serde_json::{self, json, Value};

use crate::api::Store;
use crate::oauth::{self, Fault};
use crate::sha256::{constant_time_eq, hex};
use crate::time::instant;

pub const KIT_KEY: &[u8] = b"o/recovery-kit";

const STORAGE_INSTRUCTION: &str = "Keep this recovery code somewhere you can reach without your owner token and without this phone: printed, or in a password manager that does not depend on either. It works once. Anyone who has it can sign in to the Garderobe app as you on its sign-in page, so do not store it in email or a shared document.";

/// The stored kit: its ID, the verifier and salt, and whether it can still be used.
#[derive(Debug, Clone, PartialEq)]
pub struct Kit {
    pub kit_id: String,
    pub salt: String,
    pub verifier: String,
    pub active: bool,
    pub issued_at: u64,
    pub used_at: Option<u64>,
}

impl Kit {
    pub fn to_json(&self) -> Value {
        json!({"v": 1, "kitId": self.kit_id, "salt": self.salt, "verifier": self.verifier, "status": if self.active { "active" } else { "used" }, "issuedAt": self.issued_at, "usedAt": self.used_at})
    }

    /// Strict: a record of another shape is `None`, and callers refuse rather than guess.
    pub fn from_json(v: &Value) -> Option<Kit> {
        (v.get("v")?.as_u64()? == 1).then_some(())?;
        let active = match v.get("status")?.as_str()? {
            "active" => true,
            "used" => false,
            _ => return None,
        };
        let used_at = match v.get("usedAt")? {
            Value::Null => None,
            u => Some(u.as_u64()?),
        };
        Some(Kit {
            kit_id: v.get("kitId")?.as_str().filter(|k| kit_id_ok(k))?.to_string(),
            salt: v.get("salt")?.as_str()?.to_string(),
            verifier: v.get("verifier")?.as_str()?.to_string(),
            active,
            issued_at: v.get("issuedAt")?.as_u64()?,
            used_at,
        })
    }

    /// This kit, spent at `now`.
    pub fn spent(&self, now: u64) -> Kit {
        Kit { active: false, used_at: Some(now), ..self.clone() }
    }
}

/// The stored kit, if one was ever issued.
pub async fn read<S: Store>(store: &mut S) -> Result<Option<Kit>, Fault> {
    match store.get(KIT_KEY).await.map_err(|_| Fault::Unavailable)? {
        None => Ok(None),
        Some(bytes) => serde_json::from_slice::<Value>(&bytes).ok().and_then(|v| Kit::from_json(&v)).map(Some).ok_or(Fault::Corrupt),
    }
}

/// `MeResponse.recoveryKit`: whether a usable kit exists, and when it was issued.
pub async fn status<S: Store>(store: &mut S) -> Result<Value, Fault> {
    Ok(match read(store).await? {
        Some(k) if k.active => json!({"present": true, "issuedAt": instant(k.issued_at)}),
        _ => json!({"present": false, "issuedAt": null}),
    })
}

const BASE32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// RFC 4648 base32, upper case, without padding.
fn base32(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 8 / 5 + 1);
    let (mut buffer, mut bits) = (0u32, 0u32);
    for &b in bytes {
        buffer = (buffer << 8) | u32::from(b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(BASE32[((buffer >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(BASE32[((buffer << (5 - bits)) & 31) as usize] as char);
    }
    out
}

fn kit_id_ok(k: &str) -> bool {
    k.len() >= 10 && k.len() <= 18 && k.starts_with("RK") && k[2..].bytes().all(|b| b.is_ascii_digit() || b.is_ascii_uppercase())
}

fn verifier(salt: &str, normalized: &str) -> String {
    hex(&hmac_sha256(salt.as_bytes(), format!("wardrobe/recovery-kit/v1\n{normalized}").as_bytes()))
}

/// The kit ID and the normalised `kitId:secret` of a presented code (`GRD1-<kitId>-<secret in
/// groups>`, case and spacing ignored), as `parseRecoveryCode` reads it.
pub fn parse_code(input: &str) -> Option<(String, String)> {
    if input.len() > 200 {
        return None;
    }
    let compact: String = input.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_ascii_uppercase();
    let parts: Vec<&str> = compact.split('-').collect();
    if parts.len() < 3 || parts[0] != "GRD1" || !kit_id_ok(parts[1]) {
        return None;
    }
    let secret = parts[2..].concat();
    if !(40..=64).contains(&secret.len()) || !secret.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_uppercase()) {
        return None;
    }
    Some((parts[1].to_string(), format!("{}:{secret}", parts[1])))
}

/// Whether `code` is this kit's code and the kit is unused. One hash and one constant-time
/// comparison whatever is presented (a malformed code is compared as an empty one).
pub fn accepts(kit: &Kit, code: &str) -> bool {
    let parsed = parse_code(code);
    let derived = verifier(&kit.salt, parsed.as_ref().map_or("", |(_, n)| n.as_str()));
    let matches = constant_time_eq(derived.as_bytes(), kit.verifier.as_bytes());
    matches && parsed.is_some() && kit.active
}

/// A new kit: the record to store and the `RecoveryKit` shown once.
pub fn new_kit(now: u64) -> (Kit, Value) {
    let kit_id = format!("RK{}", &base32(&crate::random::bytes(7))[..10]);
    let secret = base32(&crate::random::bytes(32));
    let salt = crate::random::token(16);
    let normalized = format!("{kit_id}:{secret}");
    let grouped = secret.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).unwrap_or_default()).collect::<Vec<_>>().join("-");
    let code = format!("GRD1-{kit_id}-{grouped}");
    let issued = instant(now);
    let download_text = [
        "GARDEROBE RECOVERY KIT".to_string(),
        String::new(),
        format!("Issued: {issued}"),
        format!("Kit: {kit_id}"),
        String::new(),
        "Recovery code (works once):".into(),
        code.clone(),
        String::new(),
        "How to use it".into(),
        "1. Open Garderobe and choose Sign in.".into(),
        "2. On the sign-in page, enter the code above under 'Recovery code' instead of the owner token.".into(),
        "3. You are signed in. Every other sign-in of the app ends, every connected assistant is".into(),
        "   disconnected, and this code stops working. Issue a new kit in Settings straight away.".into(),
        String::new(),
        "What it does not do".into(),
        "It does not change the owner token, and it does not reconnect assistants; connect those again.".into(),
        String::new(),
        STORAGE_INSTRUCTION.into(),
        String::new(),
    ]
    .join("\n");
    let kit = Kit { verifier: verifier(&salt, &normalized), kit_id: kit_id.clone(), salt, active: true, issued_at: now, used_at: None };
    let view = json!({
        "kitId": kit_id,
        "recoveryCode": code,
        "issuedAt": issued,
        "storageInstruction": STORAGE_INSTRUCTION,
        "downloadFileName": format!("garderobe-recovery-kit-{kit_id}.txt"),
        "downloadText": download_text,
    });
    (kit, view)
}

/// `POST /v1/recovery-kit` (`RecoveryKitIssued`): issue a kit, or replace the current one (which
/// stops working in the same commit). Committed under the grant store's guard, so a sign-in that
/// is spending the previous kit at the same moment either commits first (and this kit replaces a
/// used one) or is refused and finds this kit instead.
///
/// `session` is the app sign-in the request came from (none for the owner token). It is read with
/// the grant store's version and the commit is guarded on that version, so a sign-in that a
/// recovery or sign-out ended at any moment before the commit cannot issue a kit: `Ok(None)`.
pub async fn issue<S: Store>(store: &mut S, now: u64, session: Option<&str>) -> Result<Option<Value>, Fault> {
    for _ in 0..oauth::ATTEMPTS {
        let epoch = match session {
            None => oauth::read_epoch(store).await?,
            Some(grant_id) => match oauth::load_grant(store, grant_id).await? {
                Some((epoch, grant)) if grant.active && grant.is_app() => epoch,
                _ => return Ok(None),
            },
        };
        let previous = read(store).await?;
        let (kit, view) = new_kit(now);
        let bytes = kit.to_json().to_string().into_bytes();
        if oauth::commit_grants(store, &epoch, &[(KIT_KEY, &bytes)]).await? {
            return Ok(Some(json!({
                "kit": view,
                "replacedKitId": previous.filter(|p| p.active).map(|p| p.kit_id),
                "receiptId": format!("aud_{}", crate::random::token(12)),
            })));
        }
    }
    Err(Fault::Unavailable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base32_follows_rfc_4648() {
        assert_eq!(base32(b""), "");
        assert_eq!(base32(b"f"), "MY");
        assert_eq!(base32(b"fo"), "MZXQ");
        assert_eq!(base32(b"foobar"), "MZXW6YTBOI");
    }

    #[test]
    fn a_kit_accepts_its_own_code_in_any_spelling_and_nothing_else() {
        let (kit, view) = new_kit(1_789_000_000_000);
        let code = view["recoveryCode"].as_str().unwrap().to_string();
        assert!(code.starts_with(&format!("GRD1-{}-", kit.kit_id)) && kit.kit_id.len() == 12, "{code}");
        assert!(accepts(&kit, &code));
        assert!(accepts(&kit, &format!("  {} ", code.to_lowercase().replace('-', " - "))), "case and spacing are ignored");
        assert!(!accepts(&kit.spent(1), &code), "a used kit refuses its code");
        let (other, other_view) = new_kit(1_789_000_000_000);
        assert!(!accepts(&kit, other_view["recoveryCode"].as_str().unwrap()) && !accepts(&other, &code));
        let mut wrong = code.clone();
        let last = wrong.pop().unwrap();
        wrong.push(if last == 'A' { 'B' } else { 'A' });
        assert!(!accepts(&kit, &wrong));
        let long = "A".repeat(300);
        for junk in ["", "GRD1", "GRD1-RK1234567890-ABC", long.as_str(), "GRD2-RK1234567890-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"] {
            assert!(!accepts(&kit, junk), "{junk}");
        }
        // The stored record holds no code, and reads back as written.
        let stored = kit.to_json().to_string();
        assert!(!stored.contains(&code[18..23]) && !stored.contains("recoveryCode"));
        assert_eq!(Kit::from_json(&kit.to_json()), Some(kit.clone()));
        assert_eq!(Kit::from_json(&json!({"v": 1})), None);
    }
}
