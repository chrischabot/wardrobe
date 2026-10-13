//! The recovery kit, as `issueRecoveryKit` and recovery in apps/worker/src/identity/service.ts: a
//! one-time, high-entropy code the owner keeps offline, for signing in to the app when the owner
//! token is not at hand.
//!
//! This port has no identity provider, so the TypeScript Worker's recovery (a new Google sign-in
//! proving the code inside a recovery transaction) has no new identity to bind. The app's only
//! login is its sign-in page (`/oauth/authorize` for the configured app), so the code is accepted
//! there, in place of the owner token. Using it ends every other sign-in of the app,
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
//!
//! The recovery transaction (`POST /auth/recovery/start` and `/auth/recovery/complete`, as
//! `startRecovery` and `completeRecovery`) is served too, for a client that follows the TypeScript
//! flow: a transaction lasts 15 minutes and allows 5 attempts; a valid code then does in one commit what
//! the recovery sign-in does (the code is spent, every app sign-in and connected assistant ends) and
//! issues the replacement kit, shown once, whose code is what the owner signs in with next on the
//! sign-in page. With no identity provider nothing is linked (`identityLinked: false`). There is one
//! transaction at a time (`o/recovery-txn`, under the same guard): starting one replaces the last, so the
//! store never grows with unauthenticated requests.

use ferrite_app::crypto::hmac_sha256;
use ferrite_app::serde_json::{self, json, Map, Value};

use crate::api::Store;
use crate::ledger::CmdError;
use crate::oauth::{self, Fault};
use crate::sha256::{constant_time_eq, hex, hex_digest};
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

/// The one recovery transaction (`recovery_transactions`).
pub const TXN_KEY: &[u8] = b"o/recovery-txn";
/// `RECOVERY_TTL_MS` and `RECOVERY_MAX_ATTEMPTS` in identity/service.ts.
pub const TXN_TTL_MS: u64 = 15 * 60_000;
pub const TXN_MAX_ATTEMPTS: u64 = 5;

#[derive(Debug, Clone, PartialEq)]
struct Txn {
    /// SHA-256 of the transaction ID; the ID itself is never stored.
    id_hash: String,
    expires_at: u64,
    attempts: u64,
    /// `open`, `failed` (no attempts left) or `completed`.
    status: String,
}

impl Txn {
    fn to_json(&self) -> Value {
        json!({"v": 1, "idHash": self.id_hash, "expiresAt": self.expires_at, "attempts": self.attempts, "status": self.status})
    }

    fn from_json(v: &Value) -> Option<Txn> {
        (v.get("v")?.as_u64()? == 1).then_some(())?;
        let status = v.get("status")?.as_str().filter(|s| matches!(*s, "open" | "failed" | "completed"))?.to_string();
        Some(Txn { id_hash: v.get("idHash")?.as_str()?.to_string(), expires_at: v.get("expiresAt")?.as_u64()?, attempts: v.get("attempts")?.as_u64()?, status })
    }
}

fn txn_hash(id: &str) -> String {
    hex_digest(format!("wardrobe/recovery-txn/v1\n{id}").as_bytes())
}

async fn read_txn<S: Store>(store: &mut S) -> Result<Option<Txn>, Fault> {
    match store.get(TXN_KEY).await.map_err(|_| Fault::Unavailable)? {
        None => Ok(None),
        Some(bytes) => serde_json::from_slice::<Value>(&bytes).ok().and_then(|v| Txn::from_json(&v)).map(Some).ok_or(Fault::Corrupt),
    }
}

fn fault(f: Fault) -> CmdError {
    match f {
        Fault::Unavailable => CmdError::with("internal", "the account could not be read just now; try again", json!({"retryable": true})),
        Fault::Corrupt => CmdError::with("internal", "a stored account record is unreadable; nothing was changed", json!({"retryable": false})),
    }
}

/// `POST /auth/recovery/start` (`RecoveryTransaction`): open a recovery transaction, replacing any
/// earlier one.
pub async fn start<S: Store>(store: &mut S, now: u64) -> Result<Value, CmdError> {
    for _ in 0..oauth::ATTEMPTS {
        let epoch = oauth::read_epoch(store).await.map_err(fault)?;
        let id = format!("rtx_{}", crate::random::token(24));
        let txn = Txn { id_hash: txn_hash(&id), expires_at: now + TXN_TTL_MS, attempts: 0, status: "open".into() };
        let bytes = txn.to_json().to_string().into_bytes();
        if oauth::commit_grants(store, &epoch, &[(TXN_KEY, &bytes)]).await.map_err(fault)? {
            return Ok(json!({"transactionId": id, "expiresAt": instant(txn.expires_at), "attemptsRemaining": TXN_MAX_ATTEMPTS}));
        }
    }
    Err(fault(Fault::Unavailable))
}

fn invalid(issue: &str) -> CmdError {
    CmdError::with("invalid_command", "that recovery request is not valid", json!({"issues": [issue]}))
}

/// `POST /auth/recovery/complete` (`RecoveryCompleteRequest` → `RecoveryCompleteResponse`): prove the
/// recovery code within an open transaction. A wrong code uses an attempt (`forbidden`, with the
/// attempts left), the last one fails the transaction (`unrecoverable`). A valid code spends the kit,
/// ends every app sign-in and connected assistant and stores the replacement kit, in one commit.
pub async fn complete<S: Store>(store: &mut S, now: u64, body: &[u8]) -> Result<Value, CmdError> {
    let request: Map<String, Value> = match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(o)) => o,
        _ => return Err(invalid("body: expected a JSON object")),
    };
    let transaction_id = match request.get("transactionId") {
        Some(Value::String(t)) => t.clone(),
        _ => return Err(invalid("transactionId: expected a string")),
    };
    let code = match request.get("recoveryCode") {
        Some(Value::String(c)) if (16..=200).contains(&c.encode_utf16().count()) => c.clone(),
        _ => return Err(invalid("recoveryCode: expected 16 to 200 characters")),
    };
    match request.get("unlinkPreviousIdentities") {
        None | Some(Value::Bool(_)) => {}
        Some(_) => return Err(invalid("unlinkPreviousIdentities: expected true or false")),
    }
    let presented = txn_hash(&transaction_id);
    for _ in 0..oauth::ATTEMPTS {
        // The grant store's version is read first: the transaction, the kit and the grants below are
        // all read after it and written in one commit guarded on it.
        let (epoch, revoked, _apps, assistants) = oauth::recovery_revocations(store, now).await.map_err(fault)?;
        let txn = match read_txn(store).await.map_err(fault)? {
            Some(t) if constant_time_eq(t.id_hash.as_bytes(), presented.as_bytes()) => t,
            _ => return Err(CmdError::new("not_found", "that recovery attempt was not found; start again")),
        };
        if txn.status != "open" {
            return Err(CmdError::with("expired", "that recovery attempt is finished; start again", json!({"status": txn.status})));
        }
        if now >= txn.expires_at {
            return Err(CmdError::new("expired", "that recovery attempt has expired; start again"));
        }
        let kit = read(store).await.map_err(fault)?;
        let accepted = kit.as_ref().map_or(false, |k| accepts(k, &code));
        if !accepted {
            let attempts = txn.attempts + 1;
            let failed = attempts >= TXN_MAX_ATTEMPTS;
            let next = Txn { attempts, status: if failed { "failed".into() } else { "open".into() }, ..txn };
            let bytes = next.to_json().to_string().into_bytes();
            if !oauth::commit_grants(store, &epoch, &[(TXN_KEY, &bytes)]).await.map_err(fault)? {
                continue;
            }
            if failed {
                return Err(CmdError::with(
                    "unrecoverable",
                    "the recovery credential was not accepted and no attempts remain. Without a valid recovery code this account cannot be recovered through this route; the owner token still signs in on the sign-in page.",
                    json!({"attemptsRemaining": 0}),
                ));
            }
            return Err(CmdError::with("forbidden", "the recovery credential was not accepted", json!({"reason": "recovery_credential_not_accepted", "attemptsRemaining": TXN_MAX_ATTEMPTS - attempts})));
        }
        let (replacement, view) = new_kit(now);
        let kit_bytes = replacement.to_json().to_string().into_bytes();
        let txn_bytes = Txn { status: "completed".into(), ..txn }.to_json().to_string().into_bytes();
        let mut entries: Vec<(&[u8], &[u8])> = revoked.iter().map(|(k, v)| (k.as_slice(), v.as_slice())).collect();
        entries.push((KIT_KEY, &kit_bytes));
        entries.push((TXN_KEY, &txn_bytes));
        if oauth::commit_grants(store, &epoch, &entries).await.map_err(fault)? {
            return Ok(json!({
                "userId": "owner",
                "identityLinked": false,
                "sessionsRevokedBefore": instant(now),
                "assistantGrantsRevoked": assistants,
                "previousIdentitiesUnlinked": 0,
                "replacementKit": view,
                "receiptId": format!("aud_{}", crate::random::token(12)),
                "connectionsUnchanged": true,
            }));
        }
    }
    Err(fault(Fault::Unavailable))
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
