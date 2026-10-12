//! The app's own OAuth 2.1 authorization server for the MCP endpoint, in the
//! shape the TypeScript Worker serves (apps/worker/src/mcp/handler.ts with the
//! Workers OAuth provider, and the consent page of mcp/consent.ts):
//!
//! - protected-resource metadata (RFC 9728) and authorization-server metadata
//!   (RFC 8414) under `/.well-known/`;
//! - dynamic client registration (RFC 7591) for public clients only;
//! - the authorization code flow with PKCE S256 only, and a consent page on
//!   which the owner signs in with the owner token and allows or denies
//!   "Make changes" (`wardrobe.write`);
//! - access tokens that live 15 minutes and rotating refresh tokens that end
//!   after 90 idle days, both opaque and stored only as SHA-256 hashes;
//! - revocation (RFC 7009), and the owner's list and disconnect of grants.
//!
//! Storage, in the app's APE binding:
//!   `o/client/<id>`  a registered client;
//!   `o/clients`      the registration index, bounded by [`MAX_CLIENTS`];
//!   `o/grant/<id>`   one grant with its code, refresh and access token hashes;
//!   `o/grants`       the grant index, bounded by [`MAX_GRANTS`].
//! Every write is a guarded commit on the record it changes, so concurrent
//! token requests never lose one another's change.
//!
//! Tokens name their grant (`wat.<grant>.<secret>`), so a request reads one
//! record. A grant the owner disconnects stops working on the next request.

use ferrite_app::serde_json::{self, json, Value};
use ferrite_app::IngressRequest;

use crate::api::{Reply, Store};
use crate::random::token;
use ferrite_app::crypto::hmac_sha256;
use crate::sha256::{constant_time_eq, digest, hex_digest};
use crate::time::instant;

pub const PUBLIC_ORIGIN_SECRET: &str = "WARDROBE_PUBLIC_ORIGIN";
pub const READ: &str = "wardrobe.read";
pub const WRITE: &str = "wardrobe.write";
pub const SCOPES: [&str; 2] = [READ, WRITE];
/// `ACCESS_TOKEN_TTL_SECONDS` and `REFRESH_IDLE_TTL_SECONDS` in mcp/handler.ts.
pub const ACCESS_TTL_MS: u64 = 15 * 60_000;
pub const REFRESH_IDLE_MS: u64 = 90 * 86_400_000;
pub const CODE_TTL_MS: u64 = 10 * 60_000;
pub const MAX_CLIENTS: usize = 200;
pub const MAX_GRANTS: usize = 100;
/// Registrations younger than this are never pruned to make room.
const CLIENT_PRUNE_AGE_MS: u64 = 60 * 60_000;
const MAX_ACCESS_PER_GRANT: usize = 2 * MAX_SUCCESSORS;
/// How long a replaced refresh token may be retried, counted from the moment
/// it was replaced. Retries never extend it, and the first use of any of its
/// successors ends it at once (the client then holds the new lineage).
pub const PREVIOUS_RETRY_MS: u64 = 2 * 60_000;
/// How long a consent page may be submitted after it was served. The form
/// carries its issue time under an owner-keyed MAC.
pub const CONSENT_FORM_TTL_MS: u64 = 10 * 60_000;
/// Clock difference tolerated between the instance that served a consent
/// page and the one that receives it.
pub const CLOCK_SKEW_MS: u64 = 60_000;

/// The MAC a consent form carries over its issue time and the flow it
/// belongs to, keyed from the owner token.
pub fn consent_form_mac(owner_token: &str, issued: u64, client_id: &str, redirect_uri: &str, challenge: &str) -> String {
    let key = hmac_sha256(owner_token.as_bytes(), b"wardrobe/oauth/consent-form-key/v1");
    crate::sha256::hex(&hmac_sha256(&key, format!("wardrobe/oauth/consent-form/v1\n{issued}\n{client_id}\n{redirect_uri}\n{challenge}").as_bytes()))
}
const ATTEMPTS: u32 = 6;
const CLIENTS_KEY: &[u8] = b"o/clients";

/// The secrets one request mints (codes, access and refresh tokens).
///
/// The request queue redelivers an envelope whose reply or acknowledgement
/// was lost, with the same gateway-assigned correlation ID. Each secret is
/// therefore the HMAC of that ID and a label, under a key derived from the
/// owner-token secret: a redelivery computes exactly the tokens the first
/// delivery recorded, finds them recorded, and answers again without a second
/// state transition. Nothing in plaintext is stored to make this work. With no
/// owner token or no correlation ID (a hand-built request) secrets are random
/// and nothing is replayable.
pub struct Mint {
    key: Option<[u8; 32]>,
    request: String,
}

impl Mint {
    pub fn new(owner_token: Option<&str>, correlation_id: &str) -> Mint {
        let key = owner_token.filter(|t| !t.is_empty()).map(|t| hmac_sha256(t.as_bytes(), b"wardrobe/oauth/mint-key/v1"));
        Mint { key, request: correlation_id.to_string() }
    }

    fn replayable(&self) -> bool {
        self.key.is_some() && !self.request.is_empty()
    }

    /// The request's identity as recorded on what it created (None when it
    /// cannot be replayed).
    fn recorded(&self) -> Option<String> {
        self.replayable().then(|| self.request.clone())
    }

    fn is(&self, recorded: Option<&str>) -> bool {
        self.replayable() && recorded == Some(self.request.as_str())
    }

    fn secret(&self, label: &str) -> String {
        match &self.key {
            Some(k) if !self.request.is_empty() => crate::sha256::hex(&hmac_sha256(k, format!("wardrobe/oauth/mint/v1\n{}\n{label}", self.request).as_bytes())),
            _ => token(32),
        }
    }

    /// An access and refresh token pair for `grant_id`.
    fn pair(&self, grant_id: &str, kind: &str) -> (String, String) {
        (format!("wat.{grant_id}.{}", self.secret(&format!("{grant_id}/{kind}/access"))), format!("wrt.{grant_id}.{}", self.secret(&format!("{grant_id}/{kind}/refresh"))))
    }

    fn code(&self, grant_id: &str) -> String {
        format!("wac.{grant_id}.{}", self.secret(&format!("{grant_id}/code")))
    }
}

// ───────────────────────────── configuration ─────────────────────────────

fn host_is_loopback(authority: &str) -> bool {
    let host = if let Some(rest) = authority.strip_prefix('[') {
        match rest.split_once(']') {
            Some((h, port)) if port.is_empty() || port.strip_prefix(':').map_or(false, |p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())) => return h == "::1",
            _ => return false,
        }
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => h,
            Some(_) => return false,
            None => authority,
        }
    };
    host == "127.0.0.1" || host == "localhost"
}

fn authority_ok(a: &str) -> bool {
    !a.is_empty() && a.len() <= 255 && a.bytes().all(|b| b.is_ascii_alphanumeric() || b".-:[]".contains(&b))
}

/// The app's public origin: `https://host[:port]`, or `http://` for a
/// loopback host only, with no path, query or credentials.
pub fn valid_origin(origin: &str) -> bool {
    match origin.split_once("://") {
        Some(("https", a)) => authority_ok(a),
        Some(("http", a)) => authority_ok(a) && host_is_loopback(a),
        _ => false,
    }
}

/// A redirect URI a client may register: https, or http on a loopback host
/// (RFC 8252), with no fragment or credentials.
pub fn valid_redirect_uri(uri: &str) -> bool {
    if uri.len() > 512 || !uri.bytes().all(|b| b.is_ascii_graphic()) || uri.contains('#') {
        return false;
    }
    let Some((scheme, rest)) = uri.split_once("://") else { return false };
    let authority = rest.split(['/', '?']).next().unwrap_or("");
    match scheme {
        "https" => authority_ok(authority),
        "http" => authority_ok(authority) && host_is_loopback(authority),
        _ => false,
    }
}

pub fn resource_uri(origin: &str) -> String {
    format!("{origin}/mcp")
}

pub fn resource_metadata_uri(origin: &str) -> String {
    format!("{origin}/.well-known/oauth-protected-resource/mcp")
}

// ─────────────────────────────── encoding ────────────────────────────────

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn pct_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' => {
                let hi = hex_val(*bytes.get(i + 1)?)?;
                let lo = hex_val(*bytes.get(i + 2)?)?;
                out.push(hi << 4 | lo);
                i += 2;
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8(out).ok()
}

/// `application/x-www-form-urlencoded` (also a query string). `None` when a
/// pair does not decode.
pub fn form_decode(s: &str) -> Option<Vec<(String, String)>> {
    s.split('&').filter(|p| !p.is_empty()).map(|pair| {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        Some((pct_decode(k)?, pct_decode(v)?))
    }).collect()
}

pub fn pct_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Base64url without padding (RFC 4648 section 5), for PKCE.
pub fn b64url(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |acc, (i, b)| acc | u32::from(*b) << (16 - 8 * i));
        for i in 0..=chunk.len() {
            out.push(A[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

fn hash(secret: &str) -> String {
    hex_digest(secret.as_bytes())
}

fn hash_matches(secret: &str, stored: &str) -> bool {
    constant_time_eq(hash(secret).as_bytes(), stored.as_bytes())
}

/// The grant a token names: `<prefix>.<grant>.<secret>`.
fn grant_of_token<'a>(t: &'a str, prefix: &str) -> Option<&'a str> {
    let mut parts = t.splitn(3, '.');
    (parts.next()? == prefix).then_some(())?;
    let grant = parts.next()?;
    let secret = parts.next()?;
    (is_grant_id(grant) && secret.len() == 64 && secret.bytes().all(|b| b.is_ascii_hexdigit())).then_some(grant)
}

fn is_grant_id(s: &str) -> bool {
    s.len() == 36 && s.starts_with("grt_") && s[4..].bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_client_id(s: &str) -> bool {
    s.len() == 36 && s.starts_with("cli_") && s[4..].bytes().all(|b| b.is_ascii_hexdigit())
}

// ─────────────────────────────── records ─────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct Client {
    pub id: String,
    pub name: String,
    pub redirect_uris: Vec<String>,
    pub registered_at: u64,
}

impl Client {
    fn to_json(&self) -> Value {
        json!({"v": 1, "id": self.id, "name": self.name, "redirectUris": self.redirect_uris, "registeredAt": self.registered_at})
    }
    fn from_json(v: &Value) -> Option<Client> {
        (v.get("v")?.as_u64()? == 1).then_some(())?;
        let uris = v.get("redirectUris")?.as_array()?.iter().map(|u| u.as_str().map(str::to_string)).collect::<Option<Vec<_>>>()?;
        Some(Client { id: v.get("id")?.as_str()?.to_string(), name: v.get("name")?.as_str()?.to_string(), redirect_uris: uris, registered_at: v.get("registeredAt")?.as_u64()? })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Code {
    pub hash: String,
    pub challenge: String,
    pub expires_at: u64,
    pub used: bool,
    /// The request that exchanged it, so a redelivery of that request is
    /// answered again instead of being taken for a replay.
    pub exchanged_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Refresh {
    /// Hashes of the successors issued and not yet used (oldest first, at
    /// most `MAX_SUCCESSORS`). Using one makes it the replaced token and ends
    /// the others.
    pub current: Vec<String>,
    /// Hash of the token most recently replaced; it stays usable (each use
    /// adds a successor) until `previous_until` or until one of its
    /// successors is used, whichever comes first.
    pub previous: Option<String>,
    /// When `previous` stops being accepted: fixed when it is replaced,
    /// never extended. Use after it is a replay.
    pub previous_until: Option<u64>,
    /// Hashes of refresh tokens that were superseded (newest last, at most
    /// `MAX_RETIRED`). Presenting one is a replay: the grant ends.
    pub retired: Vec<String>,
    pub last_used_at: u64,
}

/// Unused successors kept for a replaced refresh token that is retried.
pub const MAX_SUCCESSORS: usize = 4;
/// Superseded refresh tokens remembered for replay detection.
pub const MAX_RETIRED: usize = 32;

fn retire(retired: &mut Vec<String>, hashes: impl IntoIterator<Item = String>) {
    retired.extend(hashes);
    let excess = retired.len().saturating_sub(MAX_RETIRED);
    retired.drain(..excess);
}

#[derive(Debug, Clone, PartialEq)]
pub struct Access {
    pub hash: String,
    pub expires_at: u64,
    pub scopes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Grant {
    pub id: String,
    pub client_id: String,
    pub client_name: String,
    pub redirect_uri: String,
    pub scopes: Vec<String>,
    pub active: bool,
    pub created_at: u64,
    pub revoked_at: Option<u64>,
    pub revoked_reason: Option<String>,
    /// The request that created it (consent), so a redelivery returns the
    /// same code instead of creating another grant.
    pub created_by: Option<String>,
    pub code: Option<Code>,
    pub refresh: Option<Refresh>,
    pub access: Vec<Access>,
    pub version: u64,
}

fn strings(v: &Value) -> Option<Vec<String>> {
    v.as_array()?.iter().map(|x| x.as_str().map(str::to_string)).collect()
}

fn opt_u64(v: &Value) -> Option<Option<u64>> {
    match v {
        Value::Null => Some(None),
        v => v.as_u64().map(Some),
    }
}

/// A field added after records were first written: absent reads as `None`;
/// present but of another shape is still refused.
fn added_str(v: Option<&Value>) -> Option<Option<String>> {
    v.map_or(Some(None), opt_str)
}

fn opt_str(v: &Value) -> Option<Option<String>> {
    match v {
        Value::Null => Some(None),
        Value::String(s) => Some(Some(s.clone())),
        _ => None,
    }
}

impl Grant {
    pub fn to_json(&self) -> Value {
        json!({
            "v": 1,
            "id": self.id,
            "clientId": self.client_id,
            "clientName": self.client_name,
            "redirectUri": self.redirect_uri,
            "scopes": self.scopes,
            "status": if self.active { "active" } else { "revoked" },
            "createdAt": self.created_at,
            "revokedAt": self.revoked_at,
            "revokedReason": self.revoked_reason,
            "createdBy": self.created_by,
            "code": self.code.as_ref().map(|c| json!({"hash": c.hash, "challenge": c.challenge, "expiresAt": c.expires_at, "used": c.used, "exchangedBy": c.exchanged_by})),
            "refresh": self.refresh.as_ref().map(|r| json!({"current": r.current, "previous": r.previous, "previousUntil": r.previous_until, "retired": r.retired, "lastUsedAt": r.last_used_at})),
            "access": self.access.iter().map(|a| json!({"hash": a.hash, "expiresAt": a.expires_at, "scopes": a.scopes})).collect::<Vec<_>>(),
            "version": self.version,
        })
    }

    /// Strict: a record missing a field or of another shape is `None`, and
    /// every caller then refuses rather than guessing.
    pub fn from_json(v: &Value) -> Option<Grant> {
        (v.get("v")?.as_u64()? == 1).then_some(())?;
        let active = match v.get("status")?.as_str()? {
            "active" => true,
            "revoked" => false,
            _ => return None,
        };
        let code = match v.get("code")? {
            Value::Null => None,
            c => Some(Code { hash: c.get("hash")?.as_str()?.to_string(), challenge: c.get("challenge")?.as_str()?.to_string(), expires_at: c.get("expiresAt")?.as_u64()?, used: c.get("used")?.as_bool()?, exchanged_by: added_str(c.get("exchangedBy"))? }),
        };
        let refresh = match v.get("refresh")? {
            Value::Null => None,
            r => {
                let current = strings(r.get("current")?)?;
                let retired = strings(r.get("retired")?)?;
                if current.is_empty() || current.len() > MAX_SUCCESSORS || retired.len() > MAX_RETIRED {
                    return None;
                }
                let previous = opt_str(r.get("previous")?)?;
                let last_used_at = r.get("lastUsedAt")?.as_u64()?;
                let previous_until = match r.get("previousUntil") {
                    Some(v) => opt_u64(v)?,
                    // Written before the window existed: the replaced token
                    // was replaced no later than the last use, so its window
                    // is counted from there.
                    None => previous.as_ref().map(|_| last_used_at + PREVIOUS_RETRY_MS),
                };
                Some(Refresh { current, previous, previous_until, retired, last_used_at })
            }
        };
        let access = v
            .get("access")?
            .as_array()?
            .iter()
            .map(|a| Some(Access { hash: a.get("hash")?.as_str()?.to_string(), expires_at: a.get("expiresAt")?.as_u64()?, scopes: strings(a.get("scopes")?)? }))
            .collect::<Option<Vec<_>>>()?;
        let scopes = strings(v.get("scopes")?)?;
        if scopes.iter().any(|s| !SCOPES.contains(&s.as_str())) || !scopes.iter().any(|s| s == READ) {
            return None;
        }
        Some(Grant {
            id: v.get("id")?.as_str().filter(|s| is_grant_id(s))?.to_string(),
            client_id: v.get("clientId")?.as_str()?.to_string(),
            client_name: v.get("clientName")?.as_str()?.to_string(),
            redirect_uri: v.get("redirectUri")?.as_str()?.to_string(),
            scopes,
            active,
            created_at: v.get("createdAt")?.as_u64()?,
            revoked_at: opt_u64(v.get("revokedAt")?)?,
            revoked_reason: opt_str(v.get("revokedReason")?)?,
            created_by: added_str(v.get("createdBy"))?,
            code,
            refresh,
            access,
            version: v.get("version")?.as_u64()?,
        })
    }

    /// Still able to produce tokens: an unused code inside its lifetime, or a
    /// refresh token used within the idle window. Expired grants hold no place
    /// among the connected assistants and are shown as expired.
    pub fn live(&self, now: u64) -> bool {
        self.active
            && (self.code.as_ref().map_or(false, |c| !c.used && now <= c.expires_at)
                || self.refresh.as_ref().map_or(false, |r| now.saturating_sub(r.last_used_at) <= REFRESH_IDLE_MS))
    }

    fn revoke(&mut self, now: u64, reason: &str) {
        if self.active {
            self.active = false;
            self.revoked_at = Some(now);
            self.revoked_reason = Some(reason.to_string());
        }
        self.refresh = None;
        self.access.clear();
    }

    /// Public view for the owner's settings: no hashes.
    pub fn summary(&self, now: u64) -> Value {
        let redirect_host = self.redirect_uri.split_once("://").map(|(_, r)| r.split(['/', '?']).next().unwrap_or("").to_string()).unwrap_or_default();
        json!({
            "grantId": self.id,
            "clientId": self.client_id,
            "clientName": self.client_name,
            "redirectHost": redirect_host,
            "scopes": self.scopes,
            "access": if self.scopes.iter().any(|s| s == WRITE) { "read_write" } else { "read_only" },
            "status": if !self.active { "revoked" } else if self.live(now) { "active" } else { "expired" },
            "grantedAt": instant(self.created_at),
            "revokedAt": self.revoked_at.map(instant),
            "version": self.version,
        })
    }
}

/// A storage read or write failed, or a record is not one this code wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fault {
    Unavailable,
    Corrupt,
}

/// Records live in a fixed set of slots, so storage stays bounded without a
/// delete (the APE binding has none): an ID's first four hex digits name its
/// slot, a new record overwrites a slot its index no longer names, and an ID
/// whose slot now holds another record is simply not found.
fn slot_of(id: &str) -> Option<usize> {
    usize::from_str_radix(id.get(4..8)?, 16).ok()
}

fn grant_key(id: &str) -> Option<Vec<u8>> {
    slot_of(id).filter(|s| *s < MAX_GRANTS).map(|s| format!("o/grant/{s}").into_bytes())
}

fn client_key(id: &str) -> Option<Vec<u8>> {
    slot_of(id).filter(|s| *s < MAX_CLIENTS).map(|s| format!("o/client/{s}").into_bytes())
}

/// The lowest slot no ID in `index` occupies.
fn free_slot(index: &[(String, u64)], max: usize) -> Option<usize> {
    let used: Vec<usize> = index.iter().filter_map(|(id, _)| slot_of(id)).collect();
    (0..max).find(|s| !used.contains(s))
}

pub async fn load_grant<S: Store>(store: &mut S, id: &str) -> Result<Option<(Vec<u8>, Grant)>, Fault> {
    let Some(key) = grant_key(id).filter(|_| is_grant_id(id)) else { return Ok(None) };
    match store.get(&key).await.map_err(|_| Fault::Unavailable)? {
        None => Ok(None),
        Some(bytes) => {
            let grant = serde_json::from_slice::<Value>(&bytes).ok().and_then(|v| Grant::from_json(&v)).ok_or(Fault::Corrupt)?;
            // The slot was reused by a later grant: this one no longer exists.
            Ok((grant.id == id).then_some((bytes, grant)))
        }
    }
}

/// Write `grant` if its record still holds `old`. `Ok(false)` = changed meanwhile.
async fn save_grant<S: Store>(store: &mut S, old: &[u8], grant: &Grant) -> Result<bool, Fault> {
    let key = grant_key(&grant.id).ok_or(Fault::Corrupt)?;
    let new = grant.to_json().to_string().into_bytes();
    match store.commit_n_if(&key, Some(old), &[(&key, &new)]).await {
        Ok(Ok(())) => Ok(true),
        Ok(Err(_)) => Ok(false),
        Err(_) => Err(Fault::Unavailable),
    }
}

/// The index records: a list of `[id, createdAtMs]`.
fn parse_index(bytes: Option<&[u8]>) -> Result<Vec<(String, u64)>, Fault> {
    let Some(b) = bytes else { return Ok(Vec::new()) };
    let v: Value = serde_json::from_slice(b).map_err(|_| Fault::Corrupt)?;
    (v.get("v").and_then(Value::as_u64) == Some(1)).then_some(()).ok_or(Fault::Corrupt)?;
    v.get("ids")
        .and_then(Value::as_array)
        .ok_or(Fault::Corrupt)?
        .iter()
        .map(|e| Some((e.get(0)?.as_str()?.to_string(), e.get(1)?.as_u64()?)))
        .collect::<Option<Vec<_>>>()
        .ok_or(Fault::Corrupt)
}

fn index_json(ids: &[(String, u64)]) -> Vec<u8> {
    json!({"v": 1, "ids": ids.iter().map(|(id, at)| json!([id, at])).collect::<Vec<_>>()}).to_string().into_bytes()
}

async fn load_client<S: Store>(store: &mut S, id: &str) -> Result<Option<Client>, Fault> {
    let Some(key) = client_key(id).filter(|_| is_client_id(id)) else { return Ok(None) };
    let index = store.get(CLIENTS_KEY).await.map_err(|_| Fault::Unavailable)?;
    // A registration pruned from the index can no longer start an authorization.
    if !parse_index(index.as_deref())?.iter().any(|(c, _)| c == id) {
        return Ok(None);
    }
    match store.get(&key).await.map_err(|_| Fault::Unavailable)? {
        None => Ok(None),
        Some(b) => match serde_json::from_slice::<Value>(&b).ok().and_then(|v| Client::from_json(&v)) {
            Some(c) => Ok((c.id == id).then_some(c)),
            None => Err(Fault::Corrupt),
        },
    }
}

// ─────────────────────────────── replies ─────────────────────────────────

fn oauth_error(status: u16, error: &str, description: &str) -> Reply {
    Reply::json(status, json!({"error": error, "error_description": description})).with_header("pragma", "no-cache")
}

fn fault_reply(f: Fault) -> Reply {
    match f {
        Fault::Unavailable => oauth_error(503, "temporarily_unavailable", "the authorization store could not be reached; try again"),
        Fault::Corrupt => oauth_error(500, "server_error", "a stored authorization record is unreadable; nothing was changed"),
    }
}

fn redirect(location: String) -> Reply {
    Reply::empty(302).with_header("location", &location).with_header("referrer-policy", "no-referrer")
}

fn with_query(uri: &str, pairs: &[(&str, &str)]) -> String {
    let mut out = uri.to_string();
    let mut sep = if uri.contains('?') { '&' } else { '?' };
    for (k, v) in pairs {
        out.push(sep);
        out.push_str(k);
        out.push('=');
        out.push_str(&pct_encode(v));
        sep = '&';
    }
    out
}

// ─────────────────────────────── metadata ────────────────────────────────

pub fn protected_resource_metadata(origin: &str) -> Reply {
    Reply::json(200, json!({
        "resource": resource_uri(origin),
        "authorization_servers": [origin],
        "scopes_supported": SCOPES,
        "bearer_methods_supported": ["header"],
        "resource_name": "Garderobe",
    }))
}

pub fn authorization_server_metadata(origin: &str) -> Reply {
    Reply::json(200, json!({
        "issuer": origin,
        "authorization_endpoint": format!("{origin}/oauth/authorize"),
        "token_endpoint": format!("{origin}/oauth/token"),
        "registration_endpoint": format!("{origin}/oauth/register"),
        "revocation_endpoint": format!("{origin}/oauth/revoke"),
        "scopes_supported": SCOPES,
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "token_endpoint_auth_methods_supported": ["none"],
        "revocation_endpoint_auth_methods_supported": ["none"],
        "code_challenge_methods_supported": ["S256"],
        "authorization_response_iss_parameter_supported": true,
        "client_id_metadata_document_supported": false,
    }))
}

// ───────────────────────────── registration ──────────────────────────────

/// `POST /oauth/register` (RFC 7591), public clients only.
pub async fn register<S: Store>(store: &mut S, now: u64, body: &[u8]) -> Reply {
    let bad = |d: &str| oauth_error(400, "invalid_client_metadata", d);
    let Ok(Value::Object(m)) = serde_json::from_slice::<Value>(body) else { return bad("the body must be a JSON object") };
    let uris: Vec<String> = match m.get("redirect_uris").and_then(strings) {
        Some(u) if (1..=10).contains(&u.len()) => u,
        _ => return oauth_error(400, "invalid_redirect_uri", "redirect_uris: one to ten URIs"),
    };
    if let Some(u) = uris.iter().find(|u| !valid_redirect_uri(u)) {
        return oauth_error(400, "invalid_redirect_uri", &format!("{u}: a redirect URI must be https, or http on a loopback host, with no fragment"));
    }
    match m.get("token_endpoint_auth_method") {
        None | Some(Value::Null) => {}
        Some(Value::String(s)) if s == "none" => {}
        _ => return bad("token_endpoint_auth_method: only public clients (\"none\") are supported"),
    }
    let subset = |key: &str, allowed: &[&str]| match m.get(key) {
        None | Some(Value::Null) => true,
        Some(v) => strings(v).map_or(false, |l| l.iter().all(|x| allowed.contains(&x.as_str()))),
    };
    if !subset("grant_types", &["authorization_code", "refresh_token"]) || !subset("response_types", &["code"]) {
        return bad("grant_types and response_types: only the authorization code flow with refresh is supported");
    }
    let name = match m.get("client_name") {
        None | Some(Value::Null) => "MCP client".to_string(),
        Some(Value::String(s)) if !s.trim().is_empty() && s.chars().count() <= 200 && !s.chars().any(char::is_control) => s.trim().to_string(),
        _ => return bad("client_name: up to 200 printable characters"),
    };
    for _ in 0..ATTEMPTS {
        let current = match store.get(CLIENTS_KEY).await {
            Ok(c) => c,
            Err(_) => return fault_reply(Fault::Unavailable),
        };
        let mut index = match parse_index(current.as_deref()) {
            Ok(i) => i,
            Err(f) => return fault_reply(f),
        };
        if index.len() >= MAX_CLIENTS {
            // Make room by dropping the oldest registrations over an hour old;
            // grants already given keep working (they do not need the client).
            // The new registration takes over a freed slot.
            index.sort_by_key(|(_, at)| *at);
            let excess = index.len() + 1 - MAX_CLIENTS;
            let prunable = index.iter().take_while(|(_, at)| now.saturating_sub(*at) > CLIENT_PRUNE_AGE_MS).count();
            if prunable < excess {
                return oauth_error(429, "temporarily_unavailable", "too many recent client registrations; try again later").with_header("retry-after", "3600");
            }
            index.drain(..excess);
        }
        let Some(slot) = free_slot(&index, MAX_CLIENTS) else { return fault_reply(Fault::Corrupt) };
        let client = Client { id: format!("cli_{slot:04x}{}", token(14)), name: name.clone(), redirect_uris: uris.clone(), registered_at: now };
        index.push((client.id.clone(), now));
        let Some(ckey) = client_key(&client.id) else { return fault_reply(Fault::Corrupt) };
        let cval = client.to_json().to_string().into_bytes();
        let ival = index_json(&index);
        match store.commit_n_if(CLIENTS_KEY, current.as_deref(), &[(CLIENTS_KEY, &ival), (&ckey, &cval)]).await {
            Ok(Ok(())) => {
                return Reply::json(201, json!({
                    "client_id": client.id,
                    "client_id_issued_at": now / 1000,
                    "client_name": client.name,
                    "redirect_uris": client.redirect_uris,
                    "grant_types": ["authorization_code", "refresh_token"],
                    "response_types": ["code"],
                    "token_endpoint_auth_method": "none",
                }))
            }
            Ok(Err(_)) => continue,
            // Nothing depends on a registration whose answer was lost: the client registers again.
            Err(_) => return fault_reply(Fault::Unavailable),
        }
    }
    fault_reply(Fault::Unavailable)
}

// ───────────────────────────── authorization ─────────────────────────────

/// A validated authorization request.
#[derive(Debug, Clone)]
pub struct AuthRequest {
    pub client_id: String,
    pub client_name: String,
    pub redirect_uri: String,
    pub scopes: Vec<String>,
    pub challenge: String,
    pub state: Option<String>,
    pub resource: Option<String>,
}

enum AuthError {
    /// Shown to the owner; never redirected (the client or its redirect is not trusted).
    Page(u16, String),
    /// Sent back to the client's registered redirect URI.
    Redirect { uri: String, error: &'static str, description: String, state: Option<String> },
    Fault(Fault),
}

fn single<'a>(params: &'a [(String, String)], name: &str) -> Result<Option<&'a str>, String> {
    let mut found = params.iter().filter(|(k, _)| k == name);
    let first = found.next().map(|(_, v)| v.as_str());
    if found.next().is_some() {
        return Err(format!("{name} is repeated"));
    }
    Ok(first.filter(|v| !v.is_empty()))
}

async fn validate_authorize<S: Store>(store: &mut S, origin: &str, params: &[(String, String)]) -> Result<AuthRequest, AuthError> {
    let page = |m: String| AuthError::Page(400, m);
    let client_id = single(params, "client_id").map_err(page)?.ok_or_else(|| page("client_id is missing".into()))?;
    let client = load_client(store, client_id).await.map_err(AuthError::Fault)?.ok_or_else(|| page("this application is not registered with Garderobe; register it again from the assistant".into()))?;
    let redirect_uri = single(params, "redirect_uri").map_err(page)?.ok_or_else(|| page("redirect_uri is missing".into()))?;
    if !client.redirect_uris.iter().any(|u| u == redirect_uri) {
        return Err(page("the redirect address is not one this application registered".into()));
    }
    let state = match single(params, "state") {
        Ok(s) if s.map_or(true, |s| s.len() <= 1024) => s.map(str::to_string),
        _ => return Err(page("state is repeated or too long".into())),
    };
    let back = |error: &'static str, description: &str| AuthError::Redirect { uri: redirect_uri.to_string(), error, description: description.to_string(), state: state.clone() };
    let get = |name: &str| single(params, name).map_err(|m| back("invalid_request", &m));
    if get("response_type")? != Some("code") {
        return Err(back("unsupported_response_type", "only response_type=code is supported"));
    }
    if get("code_challenge_method")? != Some("S256") {
        return Err(back("invalid_request", "PKCE with code_challenge_method=S256 is required"));
    }
    let challenge = match get("code_challenge")? {
        Some(c) if c.len() == 43 && c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') => c.to_string(),
        _ => return Err(back("invalid_request", "code_challenge must be the base64url SHA-256 of the verifier")),
    };
    let mut scopes: Vec<String> = match get("scope")? {
        None => vec![READ.to_string()],
        Some(s) => s.split(' ').filter(|x| !x.is_empty()).map(str::to_string).collect(),
    };
    if scopes.is_empty() || scopes.iter().any(|s| !SCOPES.contains(&s.as_str())) {
        return Err(back("invalid_scope", "the scopes are wardrobe.read and wardrobe.write"));
    }
    // Writing implies reading; keep the canonical order and no repeats.
    scopes = SCOPES.iter().filter(|s| **s == READ || scopes.iter().any(|x| x == *s)).map(|s| s.to_string()).collect();
    let resource = get("resource")?.map(str::to_string);
    if resource.as_deref().map_or(false, |r| r != resource_uri(origin)) {
        return Err(back("invalid_target", "the only resource is this server's MCP endpoint"));
    }
    Ok(AuthRequest { client_id: client.id, client_name: client.name, redirect_uri: redirect_uri.to_string(), scopes, challenge, state, resource })
}

fn auth_error_reply(origin: &str, e: AuthError) -> Reply {
    match e {
        AuthError::Page(status, message) => message_page(status, "Cannot connect this application", &message),
        AuthError::Fault(f) => message_page(if f == Fault::Unavailable { 503 } else { 500 }, "Garderobe could not finish this", "The authorization store could not be read. Try again in a moment."),
        AuthError::Redirect { uri, error, description, state } => {
            let mut pairs = vec![("error", error), ("error_description", description.as_str())];
            if let Some(s) = state.as_deref() {
                pairs.push(("state", s));
            }
            pairs.push(("iss", origin));
            redirect(with_query(&uri, &pairs))
        }
    }
}

const PAGE_STYLE: &str = "body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1d1d1f}h1{font-size:1.4rem}label{display:block;margin:1rem 0}input[type=password]{width:100%;padding:.5rem;font:inherit}button{font:inherit;padding:.5rem 1.2rem;margin-right:.5rem}.error{color:#b00020}.muted{color:#6e6e73;font-size:.9rem}";

fn page(status: u16, body: &str) -> Reply {
    let html = format!("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Garderobe</title><style>{PAGE_STYLE}</style></head><body>{body}</body></html>");
    Reply::html(status, html)
        .with_header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'")
        .with_header("x-frame-options", "DENY")
        .with_header("referrer-policy", "no-referrer")
}

fn message_page(status: u16, title: &str, message: &str) -> Reply {
    page(status, &format!("<h1>{}</h1><p>{}</p>", html_escape(title), html_escape(message)))
}

fn consent_page(status: u16, origin: &str, r: &AuthRequest, error: Option<&str>, owner_token: Option<&str>, now: u64) -> Reply {
    let hidden = |name: &str, value: &str| format!("<input type=\"hidden\" name=\"{name}\" value=\"{}\">", html_escape(value));
    let mut fields = String::new();
    if let Some(owner) = owner_token.filter(|t| !t.is_empty()) {
        fields.push_str(&hidden("issued", &now.to_string()));
        fields.push_str(&hidden("form_mac", &consent_form_mac(owner, now, &r.client_id, &r.redirect_uri, &r.challenge)));
    }
    fields.push_str(&hidden("response_type", "code"));
    fields.push_str(&hidden("client_id", &r.client_id));
    fields.push_str(&hidden("redirect_uri", &r.redirect_uri));
    fields.push_str(&hidden("scope", &r.scopes.join(" ")));
    fields.push_str(&hidden("code_challenge", &r.challenge));
    fields.push_str(&hidden("code_challenge_method", "S256"));
    if let Some(s) = &r.state {
        fields.push_str(&hidden("state", s));
    }
    if let Some(res) = &r.resource {
        fields.push_str(&hidden("resource", res));
    }
    let host = r.redirect_uri.split_once("://").map(|(_, rest)| rest.split(['/', '?']).next().unwrap_or("")).unwrap_or("");
    let write = if r.scopes.iter().any(|s| s == WRITE) {
        "<label><input type=\"checkbox\" name=\"write\" value=\"on\" checked> Make changes: record wear and wash reports and routine actions, each with a receipt you can undo. Leave this off for a read-only connection.</label>"
    } else {
        "<p class=\"muted\">This application asked to read only.</p>"
    };
    let error = error.map(|e| format!("<p class=\"error\">{}</p>", html_escape(e))).unwrap_or_default();
    let body = format!(
        "<h1>Connect {name} to Garderobe?</h1><p><strong>{name}</strong> (returning to {host}) asks to read your wardrobe.</p>{error}<form method=\"post\" action=\"{origin}/oauth/authorize\">{fields}{write}<label>Owner token<input type=\"password\" name=\"owner_token\" autocomplete=\"current-password\"></label><button type=\"submit\" name=\"decision\" value=\"allow\">Allow</button><button type=\"submit\" name=\"decision\" value=\"deny\">Deny</button></form><p class=\"muted\">A connected assistant can never lift a restriction or undo the record of one. You can disconnect it at any time.</p>",
        name = html_escape(&r.client_name),
        host = html_escape(host),
        origin = html_escape(origin),
    );
    page(status, &body)
}

/// `GET /oauth/authorize`: the consent page.
pub async fn authorize_page<S: Store>(store: &mut S, origin: &str, owner_token: Option<&str>, now: u64, query: &str) -> Reply {
    let Some(params) = form_decode(query) else { return message_page(400, "Cannot connect this application", "The request is not readable.") };
    match validate_authorize(store, origin, &params).await {
        Ok(r) => consent_page(200, origin, &r, None, owner_token, now),
        Err(e) => auth_error_reply(origin, e),
    }
}

/// `POST /oauth/authorize`: the owner's decision.
pub async fn authorize_decision<S: Store>(store: &mut S, origin: &str, owner_token: Option<&str>, mint: &Mint, now: u64, body: &[u8]) -> Reply {
    let Some(params) = std::str::from_utf8(body).ok().and_then(form_decode) else { return message_page(400, "Cannot connect this application", "The form is not readable.") };
    let r = match validate_authorize(store, origin, &params).await {
        Ok(r) => r,
        Err(e) => return auth_error_reply(origin, e),
    };
    let field = |name: &str| single(&params, name).ok().flatten();
    match field("decision") {
        Some("deny") => return auth_error_reply(origin, AuthError::Redirect { uri: r.redirect_uri.clone(), error: "access_denied", description: "the owner did not allow this connection".into(), state: r.state.clone() }),
        Some("allow") => {}
        _ => return consent_page(400, origin, &r, Some("Choose Allow or Deny."), owner_token, now),
    }
    let presented = field("owner_token").unwrap_or("");
    let Some(owner) = owner_token.filter(|t| !t.is_empty()) else { return message_page(500, "Garderobe is not configured", "The server has no owner token, so nobody can sign in.") };
    // The form must be one this server served for this flow, within its
    // lifetime. That bounds how late a consent (or a queue redelivery of
    // one) can arrive, which is what lets a grant's slot be reused safely.
    let fresh = match (field("issued").and_then(|i| i.parse::<u64>().ok()), field("form_mac")) {
        (Some(issued), Some(mac)) => {
            issued <= now + CLOCK_SKEW_MS
                && now.saturating_sub(issued) <= CONSENT_FORM_TTL_MS
                && constant_time_eq(mac.as_bytes(), consent_form_mac(owner, issued, &r.client_id, &r.redirect_uri, &r.challenge).as_bytes())
        }
        _ => false,
    };
    if !fresh {
        return consent_page(400, origin, &r, Some("This page expired. Nothing was granted; sign in and choose again."), owner_token, now);
    }
    if presented.is_empty() || !constant_time_eq(presented.as_bytes(), owner.as_bytes()) {
        return consent_page(401, origin, &r, Some("That owner token is not valid. Nothing was granted."), owner_token, now);
    }
    let scopes: Vec<String> = if field("write") == Some("on") { r.scopes.clone() } else { vec![READ.to_string()] };
    let code = match create_grant(store, now, &r, scopes, mint).await {
        Ok(code) => code,
        Err(GrantRefusal::Full) => return message_page(409, "Too many connected assistants", "Disconnect an assistant you no longer use, then connect this one again."),
        Err(GrantRefusal::Fault(f)) => return auth_error_reply(origin, AuthError::Fault(f)),
    };
    let mut pairs = vec![("code", code.as_str())];
    if let Some(s) = r.state.as_deref() {
        pairs.push(("state", s));
    }
    pairs.push(("iss", origin));
    redirect(with_query(&r.redirect_uri, &pairs))
}

enum GrantRefusal {
    Full,
    Fault(Fault),
}

/// Every grant slot: its number, the record's exact bytes, and the grant.
/// The slot records are the whole grant store; there is no separate index
/// whose updates could race the records.
async fn read_grant_slots<S: Store>(store: &mut S) -> Result<Vec<(usize, Option<Vec<u8>>, Option<Grant>)>, Fault> {
    let mut out = Vec::with_capacity(MAX_GRANTS);
    for slot in 0..MAX_GRANTS {
        let key = format!("o/grant/{slot}").into_bytes();
        let bytes = store.get(&key).await.map_err(|_| Fault::Unavailable)?;
        let grant = match &bytes {
            None => None,
            Some(b) => Some(serde_json::from_slice::<Value>(b).ok().and_then(|v| Grant::from_json(&v)).filter(|g| slot_of(&g.id) == Some(slot)).ok_or(Fault::Corrupt)?),
        };
        out.push((slot, bytes, grant));
    }
    Ok(out)
}

async fn create_grant<S: Store>(store: &mut S, now: u64, r: &AuthRequest, scopes: Vec<String>, mint: &Mint) -> Result<String, GrantRefusal> {
    for _ in 0..ATTEMPTS {
        let slots = read_grant_slots(store).await.map_err(GrantRefusal::Fault)?;
        // A redelivery of a consent that already committed gets its code again.
        if let Some(g) = slots.iter().filter_map(|(_, _, g)| g.as_ref()).find(|g| mint.is(g.created_by.as_deref())) {
            return Ok(mint.code(&g.id));
        }
        // A slot is free when it is empty, or its grant can no longer produce
        // tokens (revoked, code expired unused, refresh idle too long) and
        // every consent form that could have created it has expired. So a
        // late redelivery of that consent still finds its grant here and is
        // answered from it, and can never create a grant again.
        let reusable = |g: &Grant| !g.live(now) && now > g.created_at + CONSENT_FORM_TTL_MS + CLOCK_SKEW_MS;
        let Some((slot, expected)) = slots.into_iter().find(|(_, _, g)| g.as_ref().map_or(true, reusable)).map(|(s, b, _)| (s, b)) else {
            return Err(GrantRefusal::Full);
        };
        let id = format!("grt_{slot:04x}{}", token(14));
        let code = mint.code(&id);
        let grant = Grant {
            id: id.clone(),
            client_id: r.client_id.clone(),
            client_name: r.client_name.clone(),
            redirect_uri: r.redirect_uri.clone(),
            scopes: scopes.clone(),
            active: true,
            created_at: now,
            revoked_at: None,
            revoked_reason: None,
            created_by: mint.recorded(),
            code: Some(Code { hash: hash(&code), challenge: r.challenge.clone(), expires_at: now + CODE_TTL_MS, used: false, exchanged_by: None }),
            refresh: None,
            access: Vec::new(),
            version: 1,
        };
        let Some(gkey) = grant_key(&id) else { return Err(GrantRefusal::Fault(Fault::Corrupt)) };
        let gval = grant.to_json().to_string().into_bytes();
        // Compare-and-swap on the slot record itself: written only if the slot
        // still holds exactly the bytes judged free above. An exchange,
        // refresh or disconnect that committed since changed those bytes, so
        // this write is refused and the attempt starts over from fresh slots.
        match store.commit_n_if(&gkey, expected.as_deref(), &[(&gkey, &gval)]).await {
            Ok(Ok(())) => return Ok(code),
            Ok(Err(_)) => continue,
            // A lost answer leaves at most an unused grant, which the owner sees and can disconnect.
            Err(_) => return Err(GrantRefusal::Fault(Fault::Unavailable)),
        }
    }
    Err(GrantRefusal::Fault(Fault::Unavailable))
}

// ───────────────────────────────── tokens ─────────────────────────────────

fn verifier_matches(verifier: &str, challenge: &str) -> bool {
    (43..=128).contains(&verifier.len())
        && verifier.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
        && constant_time_eq(b64url(&digest(verifier.as_bytes())).as_bytes(), challenge.as_bytes())
}

/// Record an issued access token on its grant (at most four kept).
fn record_access(grant: &mut Grant, now: u64, access: &str, scopes: Vec<String>) {
    grant.access.retain(|a| a.expires_at > now);
    grant.access.push(Access { hash: hash(access), expires_at: now + ACCESS_TTL_MS, scopes });
    let excess = grant.access.len().saturating_sub(MAX_ACCESS_PER_GRANT);
    grant.access.drain(..excess);
}

fn token_reply(access: &str, refresh: &str, scopes: &[String]) -> Reply {
    Reply::json(200, json!({
        "access_token": access,
        "token_type": "Bearer",
        "expires_in": ACCESS_TTL_MS / 1000,
        "refresh_token": refresh,
        "scope": scopes.join(" "),
    }))
    .with_header("pragma", "no-cache")
}

/// The answer to a redelivered exchange or refresh, from what the first
/// delivery recorded. It is given only while that answer is still usable:
/// its refresh token is unused (or the replaced token inside its window) and
/// its access token is live, reported with its remaining lifetime, never a
/// fresh 15 minutes. Otherwise the client has moved on, or the tokens have
/// expired, and handing them out would only invite a replay; the redelivery
/// is refused. Nothing changes either way.
///
/// Every usable pair keeps its access record: at most MAX_SUCCESSORS - 1
/// siblings and MAX_SUCCESSORS successors are issued after the replaced
/// token's own pair, so the newest 2 * MAX_SUCCESSORS access records
/// (MAX_ACCESS_PER_GRANT) always include it until it expires.
fn replay_reply(grant: &Grant, now: u64, access: &str, refresh: &str) -> Reply {
    let refresh_hash = hash(refresh);
    let usable = grant.refresh.as_ref().map_or(false, |r| {
        r.current.contains(&refresh_hash) || (r.previous.as_ref() == Some(&refresh_hash) && r.previous_until.map_or(false, |until| now <= until))
    });
    if !usable {
        return oauth_error(400, "invalid_grant", "this request was already answered and the tokens it issued have since been replaced");
    }
    let issued = hash(access);
    match grant.access.iter().find(|a| a.hash == issued && a.expires_at > now) {
        Some(a) => Reply::json(200, json!({
            "access_token": access,
            "token_type": "Bearer",
            "expires_in": ((a.expires_at - now) / 1000).max(1),
            "refresh_token": refresh,
            "scope": a.scopes.join(" "),
        }))
        .with_header("pragma", "no-cache"),
        None => oauth_error(400, "invalid_grant", "this request was already answered and the access token it issued has expired"),
    }
}

/// `POST /oauth/token`: the authorization code and refresh token grants.
pub async fn token_endpoint<S: Store>(store: &mut S, origin: &str, mint: &Mint, now: u64, body: &[u8]) -> Reply {
    let Some(params) = std::str::from_utf8(body).ok().and_then(form_decode) else { return oauth_error(400, "invalid_request", "the body must be application/x-www-form-urlencoded") };
    let get = |name: &str| single(&params, name);
    let (grant_type, client_id, resource) = match (get("grant_type"), get("client_id"), get("resource")) {
        (Ok(g), Ok(c), Ok(r)) => (g, c, r),
        _ => return oauth_error(400, "invalid_request", "a parameter is repeated"),
    };
    let Some(client_id) = client_id else { return oauth_error(401, "invalid_client", "client_id is required (public clients)") };
    if resource.map_or(false, |r| r != resource_uri(origin)) {
        return oauth_error(400, "invalid_target", "the only resource is this server's MCP endpoint");
    }
    match grant_type {
        Some("authorization_code") => {
            let (Ok(Some(code)), Ok(Some(redirect_uri)), Ok(verifier)) = (get("code"), get("redirect_uri"), get("code_verifier")) else {
                return oauth_error(400, "invalid_request", "code, redirect_uri and code_verifier are required");
            };
            exchange_code(store, mint, now, client_id, code, redirect_uri, verifier.unwrap_or("")).await
        }
        Some("refresh_token") => {
            let (Ok(Some(refresh)), Ok(scope)) = (get("refresh_token"), get("scope")) else { return oauth_error(400, "invalid_request", "refresh_token is required") };
            refresh_tokens(store, mint, now, client_id, refresh, scope).await
        }
        _ => oauth_error(400, "unsupported_grant_type", "the grants are authorization_code and refresh_token"),
    }
}

async fn exchange_code<S: Store>(store: &mut S, mint: &Mint, now: u64, client_id: &str, code: &str, redirect_uri: &str, verifier: &str) -> Reply {
    let invalid = |d: &str| oauth_error(400, "invalid_grant", d);
    let Some(grant_id) = grant_of_token(code, "wac") else { return invalid("the authorization code is not valid") };
    for _ in 0..ATTEMPTS {
        let (old, mut grant) = match load_grant(store, grant_id).await {
            Ok(Some(g)) => g,
            Ok(None) => return invalid("the authorization code is not valid"),
            Err(f) => return fault_reply(f),
        };
        let Some(stored) = grant.code.clone() else { return invalid("the authorization code is not valid") };
        if !hash_matches(code, &stored.hash) || grant.client_id != client_id || grant.redirect_uri != redirect_uri {
            return invalid("the authorization code is not valid for this client and redirect");
        }
        if !grant.active {
            return invalid("this authorization was withdrawn");
        }
        if stored.used {
            if mint.is(stored.exchanged_by.as_deref()) && verifier_matches(verifier, &stored.challenge) {
                // The same delivery again (its reply or acknowledgement was
                // lost): answer with the tokens it issued, change nothing.
                let (access, refresh) = mint.pair(&grant.id, "exchange");
                return replay_reply(&grant, now, &access, &refresh);
            }
            // A code is used once. Presenting it again, with or without the
            // verifier, ends the grant and every token it issued (RFC 6749
            // section 4.1.2, RFC 9700 section 4.5); the client connects again.
            grant.revoke(now, "authorization_code_replayed");
            grant.version += 1;
            return match save_grant(store, &old, &grant).await {
                Ok(true) => invalid("the authorization code was already used; the authorization is withdrawn"),
                Ok(false) => continue,
                Err(f) => fault_reply(f),
            };
        }
        if !verifier_matches(verifier, &stored.challenge) {
            return invalid("code_verifier does not match the code challenge");
        }
        if now > stored.expires_at {
            return invalid("the authorization code has expired");
        }
        let scopes = grant.scopes.clone();
        let (access, refresh) = mint.pair(&grant.id, "exchange");
        record_access(&mut grant, now, &access, scopes.clone());
        grant.code = Some(Code { used: true, exchanged_by: mint.recorded(), ..stored });
        grant.refresh = Some(Refresh { current: vec![hash(&refresh)], previous: None, previous_until: None, retired: Vec::new(), last_used_at: now });
        grant.version += 1;
        match save_grant(store, &old, &grant).await {
            Ok(true) => return token_reply(&access, &refresh, &scopes),
            Ok(false) => continue,
            Err(f) => return fault_reply(f),
        }
    }
    fault_reply(Fault::Unavailable)
}

async fn refresh_tokens<S: Store>(store: &mut S, mint: &Mint, now: u64, client_id: &str, refresh: &str, scope: Option<&str>) -> Reply {
    let invalid = |d: &str| oauth_error(400, "invalid_grant", d);
    let Some(grant_id) = grant_of_token(refresh, "wrt") else { return invalid("the refresh token is not valid") };
    for _ in 0..ATTEMPTS {
        let (old, mut grant) = match load_grant(store, grant_id).await {
            Ok(Some(g)) => g,
            Ok(None) => return invalid("the refresh token is not valid"),
            Err(f) => return fault_reply(f),
        };
        if !grant.active || grant.client_id != client_id {
            return invalid("the refresh token is not valid");
        }
        let Some(r) = grant.refresh.clone() else { return invalid("the refresh token is not valid") };
        let is_current = r.current.iter().any(|c| hash_matches(refresh, c));
        let is_previous = r.previous.as_deref().map_or(false, |p| hash_matches(refresh, p));
        let is_retired = r.retired.iter().any(|h| hash_matches(refresh, h));
        // A redelivery of a refresh that already committed: the token it
        // issued is recorded in this lineage. Answer again, change nothing,
        // even if the client has moved on since.
        let (access, new_refresh) = mint.pair(&grant.id, "refresh");
        let new_hash = hash(&new_refresh);
        if mint.replayable() && (is_current || is_previous || is_retired) && (r.current.contains(&new_hash) || r.previous.as_ref() == Some(&new_hash) || r.retired.contains(&new_hash)) {
            return replay_reply(&grant, now, &access, &new_refresh);
        }
        // The replaced token is retried only within its fixed window.
        let stale_previous = is_previous && r.previous_until.map_or(true, |until| now > until);
        if is_retired || stale_previous {
            // A superseded refresh token: the client and someone else both
            // hold this lineage. End the grant and every token it issued
            // (OAuth 2.1 section 4.3.1, RFC 9700 section 4.14.2).
            grant.revoke(now, "refresh_token_replayed");
            grant.version += 1;
            return match save_grant(store, &old, &grant).await {
                Ok(true) => invalid("the refresh token was already replaced; the authorization is withdrawn"),
                Ok(false) => continue,
                Err(f) => fault_reply(f),
            };
        }
        if !is_current && !is_previous {
            return invalid("the refresh token is not valid");
        }
        if now.saturating_sub(r.last_used_at) > REFRESH_IDLE_MS {
            return invalid("the connection was idle too long; connect again");
        }
        // The replaced token may add successors only up to MAX_SUCCESSORS.
        // That keeps every token it issued in `current` (never pushed out to
        // `retired` early), so a redelivery of any of those requests is still
        // recognised above: `retired` is first-in first-out and a token is
        // always retired before, or together with and ahead of, the tokens
        // it issued, so a request's output outlives its input.
        if is_previous && r.current.len() >= MAX_SUCCESSORS {
            return invalid("the replaced refresh token was retried too often; use the newest one");
        }
        let scopes: Vec<String> = match scope {
            None => grant.scopes.clone(),
            Some(s) => {
                let asked: Vec<&str> = s.split(' ').filter(|x| !x.is_empty()).collect();
                if asked.is_empty() || asked.iter().any(|a| !grant.scopes.iter().any(|g| g == a)) {
                    return oauth_error(400, "invalid_scope", "a refresh can only keep or narrow the granted scopes");
                }
                SCOPES.iter().filter(|s| **s == READ || asked.contains(s)).map(|s| s.to_string()).collect()
            }
        };
        record_access(&mut grant, now, &access, scopes.clone());
        // Narrowing is permanent: the new refresh token, and every later
        // refresh, carries at most these scopes (and earlier access tokens are
        // held to them too, because authenticate intersects with the grant's).
        grant.scopes = scopes.clone();
        // Rotation: the replaced token stays usable for a fixed window from
        // when it was replaced, so a client whose answer was lost can retry,
        // and a retry never ends a successor issued before it. Using any
        // successor ends the replaced token at once.
        grant.refresh = Some(if is_current {
            // A successor is used: it becomes the replaced token; the older
            // token and the other unused successors are retired.
            let used = hash(refresh);
            let mut retired = r.retired.clone();
            retire(&mut retired, r.previous.clone().into_iter().chain(r.current.iter().filter(|c| **c != used).cloned()));
            Refresh { current: vec![new_hash], previous: Some(used), previous_until: Some(now + PREVIOUS_RETRY_MS), retired, last_used_at: now }
        } else {
            // The replaced token again: one more successor beside the unused
            // ones (bounded by the check above).
            let mut current = r.current.clone();
            current.push(new_hash);
            Refresh { current, previous: r.previous.clone(), previous_until: r.previous_until, retired: r.retired.clone(), last_used_at: now }
        });
        grant.version += 1;
        match save_grant(store, &old, &grant).await {
            Ok(true) => return token_reply(&access, &new_refresh, &scopes),
            Ok(false) => continue,
            Err(f) => return fault_reply(f),
        }
    }
    fault_reply(Fault::Unavailable)
}

/// `POST /oauth/revoke` (RFC 7009): a refresh token ends its grant; an access
/// token ends itself. Unknown tokens are answered 200 as the RFC requires.
pub async fn revoke<S: Store>(store: &mut S, now: u64, body: &[u8]) -> Reply {
    let Some(params) = std::str::from_utf8(body).ok().and_then(form_decode) else { return oauth_error(400, "invalid_request", "the body must be application/x-www-form-urlencoded") };
    let Ok(Some(t)) = single(&params, "token") else { return oauth_error(400, "invalid_request", "token is required") };
    let client_id = single(&params, "client_id").ok().flatten();
    let (grant_id, is_refresh) = match (grant_of_token(t, "wrt"), grant_of_token(t, "wat")) {
        (Some(g), _) => (g, true),
        (None, Some(g)) => (g, false),
        _ => return Reply::json(200, json!({})),
    };
    for _ in 0..ATTEMPTS {
        let (old, mut grant) = match load_grant(store, grant_id).await {
            Ok(Some(g)) => g,
            Ok(None) => return Reply::json(200, json!({})),
            Err(f) => return fault_reply(f),
        };
        if client_id.map_or(false, |c| c != grant.client_id) {
            return Reply::json(200, json!({}));
        }
        let changed = if is_refresh {
            let matches = grant.refresh.as_ref().map_or(false, |r| r.current.iter().any(|c| hash_matches(t, c)) || r.previous.as_deref().map_or(false, |p| hash_matches(t, p)));
            if matches {
                grant.revoke(now, "client_revoked");
            }
            matches
        } else {
            let before = grant.access.len();
            grant.access.retain(|a| !hash_matches(t, &a.hash));
            grant.access.len() != before
        };
        if !changed {
            return Reply::json(200, json!({}));
        }
        grant.version += 1;
        match save_grant(store, &old, &grant).await {
            Ok(true) => return Reply::json(200, json!({})),
            Ok(false) => continue,
            Err(f) => return fault_reply(f),
        }
    }
    fault_reply(Fault::Unavailable)
}

// ─────────────────────────── the protected resource ───────────────────────

/// Who an MCP request acts for, established by its access token.
#[derive(Debug, Clone, PartialEq)]
pub struct Caller {
    pub grant_id: String,
    pub client_id: String,
    pub scopes: Vec<String>,
}

impl Caller {
    pub fn can_write(&self) -> bool {
        self.scopes.iter().any(|s| s == WRITE)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum BearerError {
    Missing,
    Invalid(&'static str),
    Fault(Fault),
}

/// Check an `Authorization` header against the grant its token names. The
/// scopes are the token's, within the grant's (never wider).
pub async fn authenticate<S: Store>(store: &mut S, header: Option<&str>, now: u64) -> Result<Caller, BearerError> {
    let presented = header
        .and_then(|h| h.strip_prefix("Bearer ").or_else(|| h.strip_prefix("bearer ")))
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or(BearerError::Missing)?;
    let grant_id = grant_of_token(presented, "wat").ok_or(BearerError::Invalid("the access token is not a Garderobe grant"))?;
    let (_, grant) = load_grant(store, grant_id).await.map_err(BearerError::Fault)?.ok_or(BearerError::Invalid("the access token is not a Garderobe grant"))?;
    if !grant.active {
        return Err(BearerError::Invalid("this assistant is no longer connected to Garderobe; connect it again"));
    }
    let access = grant.access.iter().find(|a| hash_matches(presented, &a.hash)).ok_or(BearerError::Invalid("the access token is not valid"))?;
    if access.expires_at <= now {
        return Err(BearerError::Invalid("the access token has expired"));
    }
    let scopes = SCOPES.iter().filter(|s| access.scopes.iter().any(|a| a == *s) && grant.scopes.iter().any(|g| g == *s)).map(|s| s.to_string()).collect::<Vec<_>>();
    if !scopes.iter().any(|s| s == READ) {
        return Err(BearerError::Invalid("the access token carries no wardrobe scope"));
    }
    Ok(Caller { grant_id: grant.id, client_id: grant.client_id, scopes })
}

/// The 401 that starts discovery (RFC 9728 section 5.1).
pub fn bearer_challenge(origin: &str, e: &BearerError) -> Reply {
    let metadata = resource_metadata_uri(origin);
    match e {
        BearerError::Missing => Reply::json(401, json!({"error": "invalid_token", "error_description": "sign in with OAuth: this endpoint needs a Garderobe access token"}))
            .with_header("www-authenticate", &format!("Bearer resource_metadata=\"{metadata}\", scope=\"{READ}\"")),
        BearerError::Invalid(d) => Reply::json(401, json!({"error": "invalid_token", "error_description": d}))
            .with_header("www-authenticate", &format!("Bearer error=\"invalid_token\", error_description=\"{d}\", resource_metadata=\"{metadata}\"")),
        BearerError::Fault(f) => fault_reply(*f),
    }
}

/// The 403 step-up for a read-only connection calling the write tool.
pub fn insufficient_scope(origin: &str) -> Reply {
    let d = "this connection is read-only; changing the wardrobe needs the write permission";
    Reply::json(403, json!({"error": "insufficient_scope", "error_description": d})).with_header(
        "www-authenticate",
        &format!("Bearer error=\"insufficient_scope\", scope=\"{READ} {WRITE}\", error_description=\"{d}\", resource_metadata=\"{}\"", resource_metadata_uri(origin)),
    )
}

// ───────────────────────────── owner settings ─────────────────────────────

/// Settings › Connected assistants: every grant still in a slot, newest first.
pub async fn list_grants<S: Store>(store: &mut S, now: u64) -> Result<Value, Fault> {
    let mut grants: Vec<Grant> = read_grant_slots(store).await?.into_iter().filter_map(|(_, _, g)| g).collect();
    grants.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.id.cmp(&a.id)));
    Ok(json!({"connections": grants.iter().map(|g| g.summary(now)).collect::<Vec<_>>()}))
}

/// Settings › Connected assistants › Disconnect: effective on the next request.
pub async fn disconnect<S: Store>(store: &mut S, now: u64, grant_id: &str) -> Result<Option<Value>, Fault> {
    for _ in 0..ATTEMPTS {
        let Some((old, mut grant)) = load_grant(store, grant_id).await? else { return Ok(None) };
        if !grant.active && grant.refresh.is_none() && grant.access.is_empty() {
            return Ok(Some(grant.summary(now)));
        }
        grant.revoke(now, "owner_disconnect");
        grant.version += 1;
        if save_grant(store, &old, &grant).await? {
            return Ok(Some(grant.summary(now)));
        }
    }
    Err(Fault::Unavailable)
}

/// The `Authorization` header of a request (for the MCP route).
pub fn authorization_header(req: &IngressRequest) -> Option<&str> {
    req.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("authorization")).map(|(_, v)| v.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_and_redirects() {
        assert!(valid_origin("https://wardrobe.example"));
        assert!(valid_origin("https://wardrobe.example:8443"));
        assert!(valid_origin("http://127.0.0.1:8787"));
        assert!(valid_origin("http://localhost:8787"));
        assert!(valid_origin("http://[::1]:8787"));
        for bad in ["http://wardrobe.example", "https://wardrobe.example/", "https://a@b", "ftp://x", "https://", "http://127.0.0.1.evil:80"] {
            assert!(!valid_origin(bad), "{bad}");
        }
        assert!(valid_redirect_uri("http://127.0.0.1:43123/callback"));
        assert!(valid_redirect_uri("https://client.example/cb?x=1"));
        for bad in ["http://client.example/cb", "https://client.example/cb#frag", "https://user@client.example/cb", "javascript:alert(1)", "https://client.example/a b"] {
            assert!(!valid_redirect_uri(bad), "{bad}");
        }
    }

    #[test]
    fn pkce_s256_matches_rfc_7636_appendix_b() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(b64url(&digest(verifier.as_bytes())), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        assert!(verifier_matches(verifier, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
        assert!(!verifier_matches("short", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
        assert_eq!(b64url(b"f"), "Zg");
        assert_eq!(b64url(b"fo"), "Zm8");
        assert_eq!(b64url(b"foo"), "Zm9v");
    }

    #[test]
    fn form_coding_round_trips_and_refuses_bad_escapes() {
        let pairs = form_decode("a=1+2&b=%2Fx%3D&c=").unwrap();
        assert_eq!(pairs, vec![("a".into(), "1 2".into()), ("b".into(), "/x=".into()), ("c".into(), "".into())]);
        assert!(form_decode("a=%zz").is_none());
        assert!(form_decode("a=%ff").is_none());
        assert_eq!(pct_encode("a b/é"), "a%20b%2F%C3%A9");
        assert_eq!(single(&pairs, "a").unwrap(), Some("1 2"));
        assert!(single(&form_decode("a=1&a=2").unwrap(), "a").is_err());
    }

    #[test]
    fn tokens_name_their_grant_and_nothing_else() {
        let id = format!("grt_{}", "0".repeat(32));
        let t = format!("wat.{id}.{}", "a".repeat(64));
        assert_eq!(grant_of_token(&t, "wat"), Some(id.as_str()));
        assert_eq!(grant_of_token(&t, "wrt"), None);
        assert_eq!(grant_of_token(&format!("wat.{id}.short"), "wat"), None);
        assert_eq!(grant_of_token("wat.grt_x.aaaa", "wat"), None);
    }

    #[test]
    fn a_grant_record_round_trips_and_a_malformed_one_is_refused() {
        let g = Grant {
            id: format!("grt_{}", "1".repeat(32)),
            client_id: format!("cli_{}", "2".repeat(32)),
            client_name: "Codex".into(),
            redirect_uri: "http://127.0.0.1:1/cb".into(),
            scopes: vec![READ.into(), WRITE.into()],
            active: true,
            created_at: 5,
            revoked_at: None,
            revoked_reason: None,
            created_by: Some("req-1".into()),
            code: Some(Code { hash: "h".into(), challenge: "c".into(), expires_at: 9, used: false, exchanged_by: None }),
            refresh: Some(Refresh { current: vec!["r".into()], previous: Some("p".into()), previous_until: Some(8), retired: vec!["q".into()], last_used_at: 6 }),
            access: vec![Access { hash: "a".into(), expires_at: 7, scopes: vec![READ.into()] }],
            version: 3,
        };
        assert_eq!(Grant::from_json(&g.to_json()), Some(g.clone()));
        let mut v = g.to_json();
        v["scopes"] = json!(["wardrobe.admin"]);
        assert_eq!(Grant::from_json(&v), None);
        let mut v = g.to_json();
        v.as_object_mut().unwrap().remove("access");
        assert_eq!(Grant::from_json(&v), None);
        let mut v = g.to_json();
        v["createdBy"] = json!(7);
        assert_eq!(Grant::from_json(&v), None, "an added field of the wrong shape is still refused");
    }

    #[test]
    fn a_grant_written_before_redelivery_and_the_retry_window_still_loads() {
        let g = Grant {
            id: format!("grt_{}", "1".repeat(32)),
            client_id: format!("cli_{}", "2".repeat(32)),
            client_name: "Codex".into(),
            redirect_uri: "http://127.0.0.1:1/cb".into(),
            scopes: vec![READ.into()],
            active: true,
            created_at: 5,
            revoked_at: None,
            revoked_reason: None,
            created_by: None,
            code: Some(Code { hash: "h".into(), challenge: "c".into(), expires_at: 9, used: true, exchanged_by: None }),
            refresh: Some(Refresh { current: vec!["r".into()], previous: Some("p".into()), previous_until: Some(6 + PREVIOUS_RETRY_MS), retired: vec![], last_used_at: 6 }),
            access: vec![],
            version: 3,
        };
        let mut v = g.to_json();
        v.as_object_mut().unwrap().remove("createdBy");
        v["code"].as_object_mut().unwrap().remove("exchangedBy");
        v["refresh"].as_object_mut().unwrap().remove("previousUntil");
        assert_eq!(Grant::from_json(&v), Some(g), "the replaced token's window is counted from the last use");
    }
}
