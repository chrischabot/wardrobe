//! Photographs, the media core: `POST /v1/uploads`, the token-authenticated
//! `PUT /v1/uploads/{id}/content`, `GET /v1/uploads/{id}`, `POST /v1/uploads/{id}/complete` (the
//! `media.finalize_upload` command, through the command service, so it has a receipt like every other
//! change), `GET /v1/items/{id}/image`, `GET /v1/media/renditions/{id}`,
//! `POST /v1/media/renditions/{id}/sign` with the session-less `GET /v1/media/signed/{token}`, and
//! `GET /v1/media/assets/{id}`, as apps/worker/src/routes/media.ts and packages/media define them.
//! Every route but the two self-authenticated ones is the owner's alone.
//!
//! Bytes are stored in the app's own storage, never anywhere public. A request body is capped at
//! 256 KiB by Ferrite's ingress, so the content route takes a photograph in pieces of at most
//! [`MAX_CHUNK_BYTES`], appended in order (`?offset=` names where each piece starts; a piece sent
//! again at the same offset is answered as received). A photograph may be at most
//! [`MAX_UPLOAD_BYTES`]. HEIC is refused at authorization: this server cannot remove its location.
//!
//! Finalization reads what the bytes are (JPEG, PNG or WebP, by their structure, `crate::image`) and
//! refuses anything that is not the declared type, is animated, holds no image data or is outside the
//! accepted dimensions, as a committed rejection with its reason. Nothing is re-encoded, resized or
//! cut out: there is no background removal and no model. Each asset has one rendition, the original,
//! and every read of it is a copy without metadata (`image::strip`: no GPS, no Exif but the
//! orientation, no XMP), except one: the owner's own request for the original with
//! `withLocation=true`. A signed link, which is opened without a sign-in, never carries location
//! (owner decision of 2026-10-13: location leaves only through the owner's signed-in export with
//! `includeLocation` or the owner's own view of the original).
//!
//! Storage (APE `state`):
//!   `mu/<uploadId>`      an upload, its own commit guard for its pieces;
//!   `mc/<uploadId>/<n>`  its bytes, in parts of [`PART_BYTES`], written with the upload record;
//!   `ma/<assetId>`       an asset, written with the ledger by `media.finalize_upload`;
//!   `media-index`        every asset (at most [`MAX_ASSETS`]), written with the ledger.
//! The upload ID is derived from the client's `clientUploadId`, so a retried authorization finds its
//! upload. The content URL's token and a signed link's signature are HMAC-SHA-256 keyed with the
//! owner token, so nothing secret is stored and replacing the owner token ends every outstanding
//! upload URL and link.

use ferrite_app::crypto::hmac_sha256;
use ferrite_app::serde_json::{self, json, Map, Value};
use ferrite_app::IngressRequest;

use crate::api::{self, Principal, Reply, Store, Tokens, OWNER};
use crate::image;
use crate::ledger::{CmdError, Ctx, Plan};
use crate::seed::catalogue;
use crate::sha256::{constant_time_eq, hex, hex_digest};
use crate::time::{instant, parse_local_date};

/// The largest photograph this server accepts (a reply carries about 4 MiB).
pub const MAX_UPLOAD_BYTES: u64 = 3 * 1024 * 1024;
/// The most bytes one content request carries: Ferrite's ingress body cap.
pub const MAX_CHUNK_BYTES: usize = 256 * 1024;
/// The size of one stored part of a photograph.
pub const PART_BYTES: usize = 128 * 1024;
/// The most pieces one upload may arrive in.
pub const MAX_CHUNKS: usize = 64;
/// How long the bytes may be sent after authorization (TypeScript: 600 s).
pub const UPLOAD_TTL_MS: u64 = 10 * 60_000;
/// Finalization is accepted for this long after the byte window closed (TypeScript: one hour).
pub const FINALIZE_GRACE_MS: u64 = 3_600_000;
/// Photographs this server keeps.
pub const MAX_ASSETS: usize = 500;
/// The delivery widths a request may name (`MEDIA_THUMBNAIL_WIDTHS`). No thumbnail is generated:
/// the stored rendition is served at every width.
pub const WIDTHS: [u64; 4] = [160, 320, 640, 1280];
/// Signed link lifetimes in seconds (TypeScript: 300 by default, at most 900 for the app).
pub const DEFAULT_LINK_TTL_S: u64 = 300;
pub const MAX_LINK_TTL_S: u64 = 900;
/// Accepted dimensions (`DEFAULT_MEDIA_LIMITS`).
pub const MIN_DIMENSION: u32 = 64;
pub const MAX_DIMENSION: u32 = 8192;
pub const MAX_PIXELS: u64 = 25_000_000;
/// The payload fields of `media.finalize_upload`.
pub const FINALIZE_FIELDS: &[&str] = &["uploadId"];
/// What a garment without a photograph says (`missingImageNote`).
pub const NO_PHOTO: &str = "No photo yet";

const INDEX_KEY: &[u8] = b"media-index";
const ATTEMPTS: usize = 3;
const INTENTS: &[&str] = &["garment_photo", "selfie", "attachment"];
/// Headers every image response carries (`MEDIA_RESPONSE_HEADERS` in packages/media): an image is
/// only ever an image.
const IMAGE_HEADERS: &[(&str, &str)] = &[
    ("x-content-type-options", "nosniff"),
    ("content-security-policy", "default-src 'none'; sandbox"),
    ("content-disposition", "inline"),
    ("referrer-policy", "no-referrer"),
    ("cross-origin-resource-policy", "same-site"),
];

// ─────────────────────────────── records ───────────────────────────────

#[derive(Debug, Clone, PartialEq)]
struct Piece {
    offset: u64,
    length: u64,
    sha256: String,
}

#[derive(Debug, Clone, PartialEq)]
struct Upload {
    upload_id: String,
    client_upload_id: String,
    intent: String,
    garment_id: Option<String>,
    content_type: String,
    declared_bytes: u64,
    wearing_date: Option<String>,
    /// `authorized`, `finalized` or `rejected`.
    state: String,
    rejection_reason: Option<String>,
    asset_id: Option<String>,
    created_at_ms: u64,
    expires_at_ms: u64,
    pieces: Vec<Piece>,
}

fn parts_of(length: u64) -> u64 {
    length.div_ceil(PART_BYTES as u64)
}

impl Upload {
    fn received(&self) -> u64 {
        self.pieces.iter().map(|p| p.length).sum()
    }

    fn parts(&self) -> u64 {
        self.pieces.iter().map(|p| parts_of(p.length)).sum()
    }

    fn to_json(&self) -> Value {
        json!({
            "v": 1, "uploadId": self.upload_id, "clientUploadId": self.client_upload_id, "intent": self.intent,
            "garmentId": self.garment_id, "contentType": self.content_type, "declaredBytes": self.declared_bytes,
            "wearingDate": self.wearing_date, "state": self.state, "rejectionReason": self.rejection_reason,
            "assetId": self.asset_id, "createdAtMs": self.created_at_ms, "expiresAtMs": self.expires_at_ms,
            "pieces": self.pieces.iter().map(|p| json!({"offset": p.offset, "length": p.length, "sha256": p.sha256})).collect::<Vec<_>>(),
        })
    }

    fn from_json(v: &Value) -> Option<Upload> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        let opt = |k: &str| match v.get(k)? {
            Value::Null => Some(None),
            Value::String(x) => Some(Some(x.clone())),
            _ => None,
        };
        let n = |k: &str| v.get(k).and_then(Value::as_u64);
        if v.get("v")? != 1 {
            return None;
        }
        let pieces = v.get("pieces")?.as_array()?.iter().map(|p| Some(Piece { offset: p.get("offset")?.as_u64()?, length: p.get("length")?.as_u64()?, sha256: p.get("sha256")?.as_str()?.to_string() })).collect::<Option<Vec<_>>>()?;
        let u = Upload {
            upload_id: s("uploadId")?,
            client_upload_id: s("clientUploadId")?,
            intent: s("intent")?,
            garment_id: opt("garmentId")?,
            content_type: s("contentType")?,
            declared_bytes: n("declaredBytes")?,
            wearing_date: opt("wearingDate")?,
            state: s("state")?,
            rejection_reason: opt("rejectionReason")?,
            asset_id: opt("assetId")?,
            created_at_ms: n("createdAtMs")?,
            expires_at_ms: n("expiresAtMs")?,
            pieces,
        };
        // The pieces are contiguous from the start and within what was authorized.
        let mut at = 0;
        for p in &u.pieces {
            if p.offset != at || p.length == 0 || p.sha256.len() != 64 {
                return None;
            }
            at += p.length;
        }
        let ok = id_ok(&u.upload_id, "upl_") && INTENTS.contains(&u.intent.as_str()) && ["authorized", "finalized", "rejected"].contains(&u.state.as_str()) && at <= u.declared_bytes;
        ok.then_some(u)
    }

    /// `UploadStatus`. An authorization past its finalization window reads as expired.
    fn status(&self, now_ms: u64) -> Value {
        let state = if self.state == "authorized" && now_ms > self.expires_at_ms + FINALIZE_GRACE_MS { "expired" } else { self.state.as_str() };
        json!({
            "uploadId": self.upload_id, "intent": self.intent, "garmentId": self.garment_id, "state": state,
            "rejectionReason": self.rejection_reason, "assetId": self.asset_id, "expiresAt": instant(self.expires_at_ms),
        })
    }
}

fn upload_key(id: &str) -> Vec<u8> {
    format!("mu/{id}").into_bytes()
}

fn part_key(upload_id: &str, n: u64) -> Vec<u8> {
    format!("mc/{upload_id}/{n}").into_bytes()
}

fn asset_key(id: &str) -> Vec<u8> {
    format!("ma/{id}").into_bytes()
}

fn id_ok(id: &str, prefix: &str) -> bool {
    id.len() == prefix.len() + 24 && id.starts_with(prefix) && id[prefix.len()..].bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The upload a `clientUploadId` names: the same on every retry.
pub fn upload_id_for(client_upload_id: &str) -> String {
    format!("upl_{}", &hex_digest(format!("wardrobe/upload\n{client_upload_id}").as_bytes())[..24])
}

fn asset_id_for(upload_id: &str) -> String {
    format!("ast_{}", &hex_digest(format!("wardrobe/asset\n{upload_id}").as_bytes())[..24])
}

fn rendition_id_for(asset_id: &str) -> String {
    format!("rnd_{}", &hex_digest(format!("wardrobe/rendition\n{asset_id}\noriginal").as_bytes())[..24])
}

fn invalid(message: impl Into<String>) -> CmdError {
    CmdError::new("invalid_command", message)
}

fn internal(message: &str) -> CmdError {
    CmdError::with("internal", message, json!({"retryable": true}))
}

fn damaged(message: &str) -> CmdError {
    CmdError::with("internal", message, json!({"retryable": false}))
}

fn owner_only(principal: Principal) -> Result<(), CmdError> {
    if principal == OWNER {
        Ok(())
    } else {
        Err(CmdError::new("forbidden", "photographs are the owner's: only the owner's app adds or reads them"))
    }
}

fn owner_secret(tokens: &Tokens) -> Result<&str, CmdError> {
    tokens.owner.as_deref().filter(|t| !t.is_empty()).ok_or_else(|| CmdError::new("internal", format!("the server has no {} secret; set it and deploy again", api::OWNER_TOKEN_SECRET)))
}

fn upload_token(secret: &str, upload_id: &str) -> String {
    hex(&hmac_sha256(secret.as_bytes(), format!("wardrobe/upload-url/v1\n{upload_id}").as_bytes()))
}

fn link_mac(secret: &str, rendition_id: &str, width: u64, expires_at_ms: u64) -> String {
    hex(&hmac_sha256(secret.as_bytes(), format!("wardrobe/signed-media/v1\n{rendition_id}\n{width}\n{expires_at_ms}").as_bytes()))
}

async fn read_upload<S: Store>(store: &mut S, id: &str) -> Result<(Option<Vec<u8>>, Option<Upload>), CmdError> {
    let bytes = store.get(&upload_key(id)).await.map_err(|_| internal("the upload could not be read just now; try again"))?;
    let upload = match &bytes {
        None => None,
        Some(b) => Some(serde_json::from_slice::<Value>(b).ok().and_then(|v| Upload::from_json(&v)).filter(|u| u.upload_id == id).ok_or_else(|| damaged("the stored upload is unreadable; authorize a new upload"))?),
    };
    Ok((bytes, upload))
}

async fn upload_bytes<S: Store>(store: &mut S, u: &Upload) -> Result<Vec<u8>, CmdError> {
    let mut bytes = Vec::with_capacity(u.received() as usize);
    for n in 0..u.parts() {
        let part = store.get(&part_key(&u.upload_id, n)).await.map_err(|_| internal("the photograph could not be read just now; try again"))?;
        bytes.extend(part.ok_or_else(|| damaged("the stored photograph is incomplete"))?);
    }
    if bytes.len() as u64 != u.received() {
        return Err(damaged("the stored photograph is incomplete"));
    }
    Ok(bytes)
}

/// A stored asset: its `MediaAsset` view and where its bytes are.
struct Stored {
    view: Value,
    upload_id: String,
    parts: u64,
}

async fn load_asset<S: Store>(store: &mut S, id: &str) -> Result<Option<Stored>, CmdError> {
    if !id_ok(id, "ast_") {
        return Ok(None);
    }
    let Some(bytes) = store.get(&asset_key(id)).await.map_err(|_| internal("the photograph could not be read just now; try again"))? else {
        return Ok(None);
    };
    let v: Value = serde_json::from_slice(&bytes).map_err(|_| damaged("a stored photograph record is unreadable"))?;
    let parsed = (|| {
        let view = v.get("asset")?.clone();
        (v.get("v")? == 1 && view["assetId"] == id && view["renditions"][0]["sha256"].as_str()?.len() == 64).then_some(())?;
        Some(Stored { view, upload_id: v.get("uploadId")?.as_str()?.to_string(), parts: v.get("parts")?.as_u64()? })
    })();
    parsed.map(Some).ok_or_else(|| damaged("a stored photograph record is unreadable"))
}

async fn load_index<S: Store>(store: &mut S) -> Result<Vec<Value>, CmdError> {
    let bytes = store.get(INDEX_KEY).await.map_err(|_| internal("the photographs could not be read just now; try again"))?;
    match bytes {
        None => Ok(Vec::new()),
        Some(b) => serde_json::from_slice::<Value>(&b)
            .ok()
            .filter(|v| v["v"] == 1)
            .and_then(|v| v["assets"].as_array().cloned())
            .ok_or_else(|| damaged("the stored list of photographs is unreadable")),
    }
}

/// The original bytes of an asset, checked against its recorded length and digest.
async fn original_bytes<S: Store>(store: &mut S, a: &Stored) -> Result<Vec<u8>, CmdError> {
    let mut bytes = Vec::new();
    for n in 0..a.parts {
        let part = store.get(&part_key(&a.upload_id, n)).await.map_err(|_| internal("the photograph could not be read just now; try again"))?;
        bytes.extend(part.ok_or_else(|| damaged("the stored photograph is damaged"))?);
    }
    let r = &a.view["renditions"][0];
    if Some(bytes.len() as u64) != r["byteLength"].as_u64() || r["sha256"].as_str() != Some(hex_digest(&bytes).as_str()) {
        return Err(damaged("the stored photograph is damaged"));
    }
    Ok(bytes)
}

/// The bytes served for an asset: a copy without metadata, unless `with_location` (the owner's own
/// signed-in request for the original as supplied).
async fn served_bytes<S: Store>(store: &mut S, a: &Stored, with_location: bool) -> Result<Vec<u8>, CmdError> {
    let original = original_bytes(store, a).await?;
    if with_location {
        return Ok(original);
    }
    image::strip(&original).ok_or_else(|| damaged("the stored photograph cannot be read"))
}

// ─────────────────────────────── uploads ───────────────────────────────

struct UploadRequest {
    client_upload_id: String,
    intent: String,
    content_type: String,
    byte_length: u64,
    garment_id: Option<String>,
    wearing_date: Option<String>,
}

fn parse_upload_request(body: &[u8]) -> Result<UploadRequest, CmdError> {
    let m: Map<String, Value> = match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(m)) => m,
        Ok(_) => return Err(invalid("the request body must be a JSON object")),
        Err(_) => return Err(invalid("the request body is not valid JSON")),
    };
    if let Some(k) = m.keys().find(|k| !["clientUploadId", "intent", "contentType", "byteLength", "garmentId", "wearingDate"].contains(&k.as_str())) {
        return Err(invalid(format!("'{k}' is not a field of an upload request")));
    }
    let client_upload_id = match m.get("clientUploadId") {
        Some(Value::String(s)) if (8..=128).contains(&s.chars().count()) => s.clone(),
        _ => return Err(invalid("clientUploadId: expected 8 to 128 characters")),
    };
    let intent = match m.get("intent").and_then(Value::as_str) {
        Some(i) if INTENTS.contains(&i) => i.to_string(),
        _ => return Err(invalid("intent: expected garment_photo, selfie or attachment")),
    };
    let content_type = match m.get("contentType").and_then(Value::as_str) {
        Some(t @ ("image/jpeg" | "image/png" | "image/webp")) => t.to_string(),
        Some("image/heic") => {
            return Err(CmdError::with(
                "unsupported_media_type",
                "HEIC photographs are not accepted by this server, because it cannot remove their location data; send the photograph as a JPEG",
                json!({"accepted": ["image/jpeg", "image/png", "image/webp"]}),
            ))
        }
        _ => return Err(invalid("contentType: expected image/jpeg, image/png or image/webp")),
    };
    let byte_length = match m.get("byteLength").and_then(Value::as_u64) {
        Some(n) if n > 0 => n,
        _ => return Err(invalid("byteLength: expected a whole number of bytes above 0")),
    };
    if byte_length > MAX_UPLOAD_BYTES {
        return Err(CmdError::with(
            "payload_too_large",
            format!("this server accepts photographs of at most {MAX_UPLOAD_BYTES} bytes; this one is {byte_length}"),
            json!({"limit": MAX_UPLOAD_BYTES}),
        ));
    }
    let garment_id = match m.get("garmentId") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if !s.is_empty() && s.len() <= 64 => Some(s.clone()),
        Some(_) => return Err(invalid("garmentId: expected a garment ID")),
    };
    match (intent.as_str(), &garment_id) {
        ("garment_photo", None) => return Err(invalid("garmentId: a garment photograph names its garment")),
        ("garment_photo", Some(id)) if !catalogue().garments.iter().any(|g| &g.id == id) => {
            return Err(CmdError::with("not_found", "no such garment", json!({"garmentId": id})));
        }
        ("selfie" | "attachment", Some(_)) => return Err(invalid("garmentId: only a garment photograph names a garment")),
        _ => {}
    }
    let wearing_date = match m.get("wearingDate") {
        None | Some(Value::Null) => None,
        Some(Value::String(d)) if parse_local_date(d).is_some() => Some(d.clone()),
        Some(_) => return Err(invalid("wearingDate: expected the day as YYYY-MM-DD")),
    };
    Ok(UploadRequest { client_upload_id, intent, content_type, byte_length, garment_id, wearing_date })
}

/// `UploadAuthorizationResponse`. `maxBytes` is what was declared; the URL is relative to the origin.
fn authorization(u: &Upload, secret: &str, replayed: bool) -> Value {
    json!({
        "uploadId": u.upload_id,
        "method": "PUT",
        "url": format!("/v1/uploads/{}/content?token={}", u.upload_id, upload_token(secret, &u.upload_id)),
        "requiredHeaders": {},
        "maxBytes": u.declared_bytes,
        "expiresAt": instant(u.expires_at_ms),
        "replayed": replayed,
    })
}

/// `POST /v1/uploads` (`UploadRequest` → `UploadAuthorizationResponse`). The same `clientUploadId`
/// answers the same upload again; a different request under it is refused.
async fn authorize<S: Store>(store: &mut S, tokens: &Tokens, now_ms: u64, body: &[u8]) -> Result<Value, CmdError> {
    let secret = owner_secret(tokens)?;
    let req = parse_upload_request(body)?;
    let id = upload_id_for(&req.client_upload_id);
    let key = upload_key(&id);
    for _ in 0..ATTEMPTS {
        let (old, existing) = read_upload(store, &id).await?;
        if let Some(u) = existing {
            let same = u.client_upload_id == req.client_upload_id
                && u.intent == req.intent
                && u.content_type == req.content_type
                && u.declared_bytes == req.byte_length
                && u.garment_id == req.garment_id
                && u.wearing_date == req.wearing_date;
            if !same {
                return Err(CmdError::new("idempotency_key_reuse", "that clientUploadId was already used for a different upload"));
            }
            return Ok(authorization(&u, secret, true));
        }
        let u = Upload {
            upload_id: id.clone(),
            client_upload_id: req.client_upload_id.clone(),
            intent: req.intent.clone(),
            garment_id: req.garment_id.clone(),
            content_type: req.content_type.clone(),
            declared_bytes: req.byte_length,
            wearing_date: req.wearing_date.clone(),
            state: "authorized".into(),
            rejection_reason: None,
            asset_id: None,
            created_at_ms: now_ms,
            expires_at_ms: now_ms + UPLOAD_TTL_MS,
            pieces: Vec::new(),
        };
        let record = u.to_json().to_string();
        match store.commit_n_if(&key, old.as_deref(), &[(key.as_slice(), record.as_bytes())]).await {
            Ok(Ok(())) => return Ok(authorization(&u, secret, false)),
            Ok(Err(_)) => continue,
            Err(_) => return Err(internal("the upload could not be authorized just now; whether it was is unknown, so send the same request again")),
        }
    }
    Err(CmdError::with("conflict", "the upload kept changing; try again", json!({"retryable": true})))
}

fn link_not_valid() -> CmdError {
    CmdError::new("unauthenticated", "this upload link is not valid; authorize the upload again")
}

/// `PUT /v1/uploads/{id}/content?token=…[&offset=…]` (`UploadContentResponse`): one piece of the
/// photograph, authorized by the URL's token alone. `sha256` is the digest of this piece.
async fn receive<S: Store>(store: &mut S, tokens: &Tokens, now_ms: u64, upload_id: &str, query: &[(String, String)], body: &[u8]) -> Result<Value, CmdError> {
    let secret = owner_secret(tokens)?;
    let token = query.iter().find(|(k, _)| k == "token").map(|(_, v)| v.as_str()).unwrap_or("");
    if !id_ok(upload_id, "upl_") || !constant_time_eq(token.as_bytes(), upload_token(secret, upload_id).as_bytes()) {
        return Err(link_not_valid());
    }
    let offset = match query.iter().find(|(k, _)| k == "offset") {
        None => 0,
        Some((_, v)) => v.parse::<u64>().map_err(|_| invalid("offset: expected a whole number of bytes"))?,
    };
    if body.is_empty() {
        return Err(invalid("the upload has no content"));
    }
    if body.len() > MAX_CHUNK_BYTES {
        return Err(CmdError::with(
            "payload_too_large",
            format!("one request may carry at most {MAX_CHUNK_BYTES} bytes; send the photograph in pieces, each at ?offset= the bytes already sent"),
            json!({"limit": MAX_CHUNK_BYTES}),
        ));
    }
    let sha256 = hex_digest(body);
    let key = upload_key(upload_id);
    for _ in 0..ATTEMPTS {
        let (old, upload) = read_upload(store, upload_id).await?;
        let Some(mut u) = upload else { return Err(CmdError::new("not_found", "no such upload")) };
        let received = u.received();
        // A piece already received, sent again (its reply was lost): answered as received.
        if let Some(p) = u.pieces.iter().find(|p| p.offset == offset) {
            if p.length == body.len() as u64 && p.sha256 == sha256 {
                return Ok(json!({"uploadId": upload_id, "receivedBytes": received, "sha256": sha256}));
            }
        }
        if u.state != "authorized" {
            return Err(CmdError::new("conflict", format!("this upload was already {}; authorize a new upload", u.state)));
        }
        if now_ms >= u.expires_at_ms {
            return Err(CmdError::new("expired", "the time to send this photograph has passed; authorize the upload again"));
        }
        if offset != received {
            return Err(CmdError::with("conflict", format!("the bytes must arrive in order: {received} bytes were received, so send the next piece at offset={received}"), json!({"receivedBytes": received})));
        }
        if received + body.len() as u64 > u.declared_bytes {
            return Err(CmdError::with("payload_too_large", format!("this upload was authorized for {} bytes", u.declared_bytes), json!({"limit": u.declared_bytes, "receivedBytes": received})));
        }
        if u.pieces.len() >= MAX_CHUNKS {
            return Err(invalid(format!("an upload may arrive in at most {MAX_CHUNKS} pieces; send larger pieces")));
        }
        let first = u.parts();
        u.pieces.push(Piece { offset, length: body.len() as u64, sha256: sha256.clone() });
        let record = u.to_json().to_string();
        let part_keys: Vec<Vec<u8>> = (0..parts_of(body.len() as u64)).map(|n| part_key(upload_id, first + n)).collect();
        let mut entries: Vec<(&[u8], &[u8])> = vec![(key.as_slice(), record.as_bytes())];
        entries.extend(part_keys.iter().zip(body.chunks(PART_BYTES)).map(|(k, v)| (k.as_slice(), v)));
        match store.commit_n_if(&key, old.as_deref(), &entries).await {
            Ok(Ok(())) => return Ok(json!({"uploadId": upload_id, "receivedBytes": received + body.len() as u64, "sha256": sha256})),
            Ok(Err(_)) => continue,
            Err(_) => return Err(internal("the bytes could not be saved just now; whether they were is unknown, so send the same piece again at the same offset")),
        }
    }
    Err(CmdError::with("conflict", "the upload kept changing; try again", json!({"retryable": true})))
}

/// `GET /v1/uploads/{id}` (`UploadStatus`).
async fn status<S: Store>(store: &mut S, now_ms: u64, upload_id: &str) -> Result<Value, CmdError> {
    if !id_ok(upload_id, "upl_") {
        return Err(CmdError::new("not_found", "no such upload"));
    }
    match read_upload(store, upload_id).await?.1 {
        Some(u) => Ok(u.status(now_ms)),
        None => Err(CmdError::new("not_found", "no such upload")),
    }
}

// ─────────────────────────────── finalization ───────────────────────────────

fn payload_error(issue: impl Into<String>) -> CmdError {
    CmdError::with("invalid_command", "invalid payload for 'media.finalize_upload'", json!({"issues": [issue.into()]}))
}

fn display_label(kind: &str) -> &'static str {
    match kind {
        "selfie" => "Selfie",
        "attachment" => "Attachment",
        _ => "Your photo",
    }
}

/// A finalization that records the upload as rejected, with its reason.
fn rejection(u: &Upload, reason: String) -> Result<(Plan, Vec<(Vec<u8>, Value)>), CmdError> {
    let mut u = u.clone();
    u.state = "rejected".into();
    u.rejection_reason = Some(reason.clone());
    let plan = Plan {
        outcome: "committed",
        summary: format!("Upload rejected: {reason}. Nothing was added to the wardrobe"),
        affected: vec![json!({"kind": "media_upload", "id": u.upload_id, "version": 2})],
        repairs: Vec::new(),
        result: json!({"uploadId": u.upload_id, "finalized": false, "rejectionReason": reason}),
        undo: Err("authorize a new upload instead".into()),
    };
    Ok((plan, vec![(upload_key(&u.upload_id), u.to_json())]))
}

/// Plan `media.finalize_upload` (packages/media/src/commands/uploads.ts): validate the received bytes
/// and record the asset, or record the rejection and its reason. The records it writes go in the
/// command's own commit with the ledger. Only the owner finalizes.
pub(crate) async fn plan_finalize<S: Store>(store: &mut S, principal: Principal, ctx: &Ctx<'_>, payload: &Value) -> Result<(Plan, Vec<(Vec<u8>, Value)>), CmdError> {
    crate::ledger::only_keys(payload, "media.finalize_upload", FINALIZE_FIELDS)?;
    let upload_id = match payload.get("uploadId").and_then(Value::as_str) {
        Some(s) if !s.is_empty() && s.len() <= 64 => s.to_string(),
        _ => return Err(payload_error("uploadId: expected an upload ID (1 to 64 characters)")),
    };
    if principal != OWNER {
        return Err(CmdError::new("forbidden", "only the owner adds photographs, in the Garderobe app; nothing was written"));
    }
    let upload = if id_ok(&upload_id, "upl_") { read_upload(store, &upload_id).await?.1 } else { None };
    let Some(mut u) = upload else { return Err(CmdError::with("not_found", "no such upload; nothing was written", json!({"uploadId": upload_id}))) };
    let nothing = |summary: String, result: Value| Plan { outcome: "noop", summary, affected: Vec::new(), repairs: Vec::new(), result, undo: Err("nothing changed".into()) };
    match u.state.as_str() {
        "finalized" => return Ok((nothing("This upload was already finalized".into(), json!({"uploadId": u.upload_id, "finalized": true, "assetId": u.asset_id})), Vec::new())),
        "rejected" => {
            let reason = u.rejection_reason.clone().unwrap_or_default();
            return Ok((nothing(format!("This upload was rejected: {reason}"), json!({"uploadId": u.upload_id, "finalized": false, "rejectionReason": reason})), Vec::new()));
        }
        _ => {}
    }
    let reject = |reason: String| rejection(&u, reason);
    let expired = ctx.now_ms > u.expires_at_ms + FINALIZE_GRACE_MS;
    // Every declared byte first. This is also what keeps finalization and the content route apart:
    // they write the upload record under different guards (the ledger here, the upload record
    // there), but once every declared byte is recorded the content route can commit nothing more
    // (another piece would pass the declared size, and a piece read against an earlier record fails
    // that record's guard), so the record read here is the one this command rewrites. An upload
    // that expired before its bytes arrived is refused the same way, recording nothing.
    if u.received() != u.declared_bytes {
        let (message, retryable) = if expired {
            (format!("this upload expired with {} of its {} declared bytes received; authorize a new upload. Nothing was written", u.received(), u.declared_bytes), false)
        } else {
            (format!("{} of the {} declared bytes have been received; send the rest at offset={} and complete again. Nothing was written", u.received(), u.declared_bytes, u.received()), true)
        };
        return Err(CmdError::with(
            "precondition_failed",
            message,
            json!({"uploadId": u.upload_id, "receivedBytes": u.received(), "declaredBytes": u.declared_bytes, "retryable": retryable}),
        ));
    }
    if expired {
        return reject("the upload authorization expired before finalization".into());
    }
    let bytes = upload_bytes(store, &u).await?;
    // What the bytes are, never what the client said they were.
    let Some(probe) = image::probe(&bytes) else { return reject("the file is not a recognised image".into()) };
    if probe.content_type != u.content_type {
        return reject(format!("the file is {} but {} was declared", probe.content_type, u.content_type));
    }
    if probe.animated {
        return reject("animated images are not accepted".into());
    }
    if !probe.has_image_data {
        return reject("the file holds no image data".into());
    }
    if probe.width < MIN_DIMENSION || probe.height < MIN_DIMENSION {
        return reject(format!("the image is only {}x{} pixels", probe.width, probe.height));
    }
    if probe.width > MAX_DIMENSION || probe.height > MAX_DIMENSION || u64::from(probe.width) * u64::from(probe.height) > MAX_PIXELS {
        return reject(format!("the image is {}x{} pixels, above the accepted size; resize it on the device first", probe.width, probe.height));
    }
    if image::strip(&bytes).is_none() {
        return reject("the file's structure cannot be read, so its metadata cannot be removed".into());
    }
    let mut index = load_index(store).await?;
    if index.len() >= MAX_ASSETS {
        return Err(CmdError::with("precondition_failed", format!("this server keeps at most {MAX_ASSETS} photographs; nothing was written"), json!({"limit": MAX_ASSETS})));
    }
    let had_location = image::has_location(&bytes);
    let sha256 = hex_digest(&bytes);
    let asset_id = asset_id_for(&u.upload_id);
    let rendition_id = rendition_id_for(&asset_id);
    let kind = match u.intent.as_str() {
        "selfie" => "selfie",
        "attachment" => "attachment",
        _ => "owner_photo",
    };
    let now = instant(ctx.now_ms);
    let finalized_by = json!({"actor": principal.actor, "channel": principal.channel});
    let match_evidence = if u.garment_id.is_some() {
        json!({"basis": "owner_statement", "note": "the owner supplied this photograph for this garment", "channel": principal.channel, "finalizedBy": finalized_by})
    } else {
        json!({"finalizedBy": finalized_by})
    };
    let rendition = json!({
        "renditionId": rendition_id, "assetId": asset_id, "kind": "original", "version": 1, "contentType": probe.content_type,
        "width": probe.width, "height": probe.height, "byteLength": bytes.len(), "sha256": sha256, "sourceRenditionId": null,
        "transformations": [], "edited": false, "status": "active", "createdAt": now,
    });
    let view = json!({
        "assetId": asset_id, "garmentId": u.garment_id, "kind": kind, "displayLabel": display_label(kind), "isDemo": false,
        // Nothing more is done to a photograph on this server, so it is ready as soon as it is stored.
        "status": "active", "statusReason": null,
        "source": {"kind": "owner_upload", "imageUrl": null, "pageUrl": null, "retrievedAt": now, "permittedUse": "owner_owned", "note": null},
        "matchEvidence": match_evidence, "usableAsEvidence": true, "hadLocationMetadata": had_location, "wearingDate": u.wearing_date,
        "retainOriginalUntil": null, "renditions": [rendition], "fidelity": [], "version": 1, "createdAt": now,
    });
    index.push(json!({"assetId": asset_id, "renditionId": rendition_id, "garmentId": u.garment_id, "kind": kind, "createdAt": now}));
    let parts = u.parts();
    u.state = "finalized".into();
    u.asset_id = Some(asset_id.clone());
    let plan = Plan {
        outcome: "committed",
        summary: format!("Photo stored privately ({}x{} {})", probe.width, probe.height, probe.content_type),
        affected: vec![json!({"kind": "media_upload", "id": u.upload_id, "version": 2}), json!({"kind": "media_asset", "id": asset_id, "version": 1})],
        repairs: Vec::new(),
        result: json!({
            "uploadId": u.upload_id, "finalized": true, "assetId": asset_id, "renditionId": rendition_id, "jobId": null,
            "sha256": sha256, "width": probe.width, "height": probe.height, "hadLocationMetadata": had_location,
        }),
        undo: Err("this server cannot delete photographs yet, so storing one is not undone".into()),
    };
    let docs = vec![
        (upload_key(&u.upload_id), u.to_json()),
        (asset_key(&asset_id), json!({"v": 1, "uploadId": u.upload_id, "parts": parts, "asset": view})),
        (INDEX_KEY.to_vec(), json!({"v": 1, "assets": index})),
    ];
    Ok((plan, docs))
}

/// The result `media.finalize_upload` writes, field by field, for its outcome.
pub(crate) fn finalize_result_ok(outcome: Option<&str>, r: &Map<String, Value>) -> bool {
    let s = |k: &str| r.get(k).and_then(Value::as_str).map_or(false, |x| !x.is_empty());
    let keys = |want: &[&str]| r.len() == want.len() && want.iter().all(|k| r.contains_key(*k));
    s("uploadId")
        && match (outcome, r.get("finalized")) {
            (Some("committed"), Some(Value::Bool(true))) => {
                keys(&["uploadId", "finalized", "assetId", "renditionId", "jobId", "sha256", "width", "height", "hadLocationMetadata"])
                    && s("assetId")
                    && s("renditionId")
                    && r["jobId"].is_null()
                    && r["sha256"].as_str().map_or(false, |h| h.len() == 64)
                    && r["width"].is_u64()
                    && r["height"].is_u64()
                    && r["hadLocationMetadata"].is_boolean()
            }
            (Some("committed" | "noop"), Some(Value::Bool(false))) => keys(&["uploadId", "finalized", "rejectionReason"]) && s("rejectionReason"),
            (Some("noop"), Some(Value::Bool(true))) => keys(&["uploadId", "finalized", "assetId"]) && s("assetId"),
            _ => false,
        }
}

/// `POST /v1/uploads/{id}/complete` (`UploadCompleteResponse`): `media.finalize_upload` through the
/// command service, under the idempotency key `finalize:<uploadId>`, so asking again answers the same
/// receipt.
async fn complete<S: Store>(store: &mut S, principal: Principal, now_ms: u64, upload_id: &str) -> Result<Value, CmdError> {
    if !id_ok(upload_id, "upl_") {
        return Err(CmdError::new("not_found", "no such upload"));
    }
    let envelope = json!({
        "type": "media.finalize_upload", "payload": {"uploadId": upload_id}, "idempotencyKey": format!("finalize:{upload_id}"),
        "authorization": "owner_tap", "source": {"channel": principal.channel},
    });
    let receipt = api::execute(store, principal, now_ms, &envelope).await?;
    let result = receipt["result"].clone();
    if result["finalized"] == true {
        let asset_id = result["assetId"].as_str().unwrap_or_default();
        let asset = load_asset(store, asset_id).await?.ok_or_else(|| damaged("the finalized photograph's record is missing"))?;
        Ok(json!({"uploadId": upload_id, "state": "finalized", "asset": asset.view, "rejectionReason": null, "jobId": null, "receipt": receipt}))
    } else {
        Ok(json!({"uploadId": upload_id, "state": "rejected", "asset": null, "rejectionReason": result["rejectionReason"], "jobId": null, "receipt": receipt}))
    }
}

// ─────────────────────────────── reads ───────────────────────────────

/// How many photographs are stored (the portable export reports them, `src/exports.rs`).
pub(crate) async fn stored_count<S: Store>(store: &mut S) -> Result<usize, CmdError> {
    Ok(load_index(store).await?.len())
}

fn image_reply(content_type: &str, bytes: Vec<u8>, if_none_match: Option<&str>) -> Reply {
    let etag = format!("\"{}\"", hex_digest(&bytes));
    let fresh = if_none_match.map_or(false, |v| v.trim() == etag);
    let mut headers: Vec<(String, String)> = IMAGE_HEADERS.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    headers.push(("etag".into(), etag));
    if fresh {
        return Reply { status: 304, body: Value::Null, headers, raw: Some((content_type.to_string(), Vec::new())) };
    }
    Reply { status: 200, body: Value::Null, headers, raw: Some((content_type.to_string(), bytes)) }
}

fn content_type_of(a: &Stored) -> String {
    a.view["renditions"][0]["contentType"].as_str().unwrap_or("application/octet-stream").to_string()
}

fn query_value<'a>(query: &'a [(String, String)], name: &str) -> Option<&'a str> {
    query.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

fn width_of(raw: Option<&str>) -> Result<Option<u64>, CmdError> {
    match raw {
        None => Ok(None),
        Some(v) => match v.parse::<u64>() {
            Ok(w) if WIDTHS.contains(&w) => Ok(Some(w)),
            _ => Err(invalid("width must be one of 160, 320, 640, 1280")),
        },
    }
}

/// The asset whose rendition is `rendition_id`.
async fn asset_of_rendition<S: Store>(store: &mut S, rendition_id: &str) -> Result<Option<Stored>, CmdError> {
    if !id_ok(rendition_id, "rnd_") {
        return Ok(None);
    }
    let index = load_index(store).await?;
    let Some(asset_id) = index.iter().find(|e| e["renditionId"] == rendition_id).and_then(|e| e["assetId"].as_str()).map(str::to_string) else {
        return Ok(None);
    };
    load_asset(store, &asset_id).await
}

fn photo_not_found() -> CmdError {
    CmdError::new("not_found", "that photograph was not found")
}

/// `GET /v1/media/renditions/{id}[?width=]`: the rendition without metadata.
async fn rendition<S: Store>(store: &mut S, rendition_id: &str, query: &[(String, String)], if_none_match: Option<&str>) -> Result<Reply, CmdError> {
    width_of(query_value(query, "width"))?;
    let a = asset_of_rendition(store, rendition_id).await?.ok_or_else(photo_not_found)?;
    let bytes = served_bytes(store, &a, false).await?;
    Ok(image_reply(&content_type_of(&a), bytes, if_none_match))
}

/// `GET /v1/media/assets/{id}[?variant=][&width=][&withLocation=true]`: the photograph without
/// metadata; the original as supplied only for `variant=original&withLocation=true`. There is no
/// cutout or catalogue view (no background removal on this server).
async fn asset<S: Store>(store: &mut S, asset_id: &str, query: &[(String, String)], if_none_match: Option<&str>) -> Result<Reply, CmdError> {
    let variant = match query_value(query, "variant") {
        None => "display",
        Some(v @ ("display" | "original" | "cutout" | "catalogue")) => v,
        Some(_) => return Err(invalid("variant: expected display, original, cutout or catalogue")),
    };
    width_of(query_value(query, "width"))?;
    let with_location = match query_value(query, "withLocation") {
        None => false,
        Some("true") => true,
        Some(_) => return Err(invalid("withLocation: expected true")),
    };
    let a = load_asset(store, asset_id).await?.ok_or_else(photo_not_found)?;
    if matches!(variant, "cutout" | "catalogue") {
        return Err(CmdError::with("not_found", "this server removes no backgrounds, so a photograph has no cutout or catalogue view; ask for the display view", json!({"variant": variant})));
    }
    let bytes = served_bytes(store, &a, with_location && variant == "original").await?;
    Ok(image_reply(&content_type_of(&a), bytes, if_none_match))
}

/// `GET /v1/items/{id}/image[?width=]`: the garment's newest photograph, without metadata, or 404
/// with the honest note; a placeholder is never served.
async fn item_image<S: Store>(store: &mut S, garment_id: &str, query: &[(String, String)], if_none_match: Option<&str>) -> Result<Reply, CmdError> {
    width_of(query_value(query, "width"))?;
    let index = load_index(store).await?;
    let newest = index.iter().rev().find(|e| e["garmentId"] == garment_id && e["kind"] == "owner_photo").and_then(|e| e["assetId"].as_str()).map(str::to_string);
    let Some(asset_id) = newest else {
        return Err(CmdError::with("not_found", NO_PHOTO, json!({"missingImageNote": NO_PHOTO})));
    };
    let a = load_asset(store, &asset_id).await?.ok_or_else(|| damaged("the garment's photograph record is missing"))?;
    let bytes = served_bytes(store, &a, false).await?;
    Ok(image_reply(&content_type_of(&a), bytes, if_none_match))
}

/// `POST /v1/media/renditions/{id}/sign` (`SignRenditionRequest` → `SignedMediaUrl`): a short-lived
/// link to the rendition without metadata. A request naming `withLocation` is refused: a link is
/// opened without a sign-in, so it never carries location.
async fn sign<S: Store>(store: &mut S, tokens: &Tokens, now_ms: u64, rendition_id: &str, body: &[u8]) -> Result<Value, CmdError> {
    let secret = owner_secret(tokens)?;
    let m: Map<String, Value> = if body.iter().all(u8::is_ascii_whitespace) {
        Map::new()
    } else {
        match serde_json::from_slice::<Value>(body) {
            Ok(Value::Object(m)) => m,
            Ok(_) => return Err(invalid("the request body must be a JSON object")),
            Err(_) => return Err(invalid("the request body is not valid JSON")),
        }
    };
    if m.contains_key("withLocation") {
        return Err(CmdError::with(
            "invalid_command",
            "a signed link never carries location data; open the original in the app to see it as supplied",
            json!({"reason": "signed_link_without_location"}),
        ));
    }
    if let Some(k) = m.keys().find(|k| *k != "width" && *k != "ttlSeconds") {
        return Err(invalid(format!("'{k}' is not a field of a signing request")));
    }
    let width = match m.get("width") {
        None | Some(Value::Null) => None,
        Some(v) => match v.as_u64() {
            Some(w) if WIDTHS.contains(&w) => Some(w),
            _ => return Err(invalid("width must be one of 160, 320, 640, 1280")),
        },
    };
    let ttl = match m.get("ttlSeconds") {
        None | Some(Value::Null) => DEFAULT_LINK_TTL_S,
        Some(v) => match v.as_u64() {
            Some(t) if (30..=3600).contains(&t) => t.min(MAX_LINK_TTL_S),
            _ => return Err(invalid("ttlSeconds: expected a whole number from 30 to 3600")),
        },
    };
    let a = asset_of_rendition(store, rendition_id).await?.ok_or_else(photo_not_found)?;
    if a.view["status"] != "active" {
        return Err(photo_not_found());
    }
    let expires_at_ms = now_ms + ttl * 1000;
    let w = width.unwrap_or(0);
    let token = format!("{rendition_id}.{w}.{expires_at_ms}.{}", link_mac(secret, rendition_id, w, expires_at_ms));
    Ok(json!({"url": format!("/v1/media/signed/{token}"), "renditionId": rendition_id, "width": width, "expiresAt": instant(expires_at_ms)}))
}

/// Every refusal of a signed link: the same 404 with no detail, so a link reveals nothing about what exists.
fn denied() -> Reply {
    Reply {
        status: 404,
        body: Value::Null,
        headers: vec![("x-content-type-options".into(), "nosniff".into()), ("content-security-policy".into(), "default-src 'none'; sandbox".into())],
        raw: Some(("text/plain; charset=utf-8".into(), b"Not found".to_vec())),
    }
}

/// `GET /v1/media/signed/{token}`: the rendition without metadata, for a valid, unexpired link.
async fn serve_signed<S: Store>(store: &mut S, tokens: &Tokens, now_ms: u64, token: &str, if_none_match: Option<&str>) -> Reply {
    let Ok(secret) = owner_secret(tokens) else { return denied() };
    let fields: Vec<&str> = token.split('.').collect();
    let [rendition_id, w_text, exp_text, mac] = fields[..] else { return denied() };
    let (Ok(w), Ok(exp)) = (w_text.parse::<u64>(), exp_text.parse::<u64>()) else { return denied() };
    // Only the spelling the server signs (no sign, no leading zero) is accepted, so the signed text
    // is exactly the text presented.
    if w.to_string() != w_text || exp.to_string() != exp_text {
        return denied();
    }
    if !id_ok(rendition_id, "rnd_") || (w != 0 && !WIDTHS.contains(&w)) || !constant_time_eq(mac.as_bytes(), link_mac(secret, rendition_id, w, exp).as_bytes()) || exp <= now_ms {
        return denied();
    }
    let a = match asset_of_rendition(store, rendition_id).await {
        Ok(Some(a)) if a.view["status"] == "active" => a,
        _ => return denied(),
    };
    match served_bytes(store, &a, false).await {
        Ok(bytes) => image_reply(&content_type_of(&a), bytes, if_none_match),
        Err(_) => denied(),
    }
}

// ─────────────────────────────── routing ───────────────────────────────

/// The `{id}` of `prefix{id}suffix`, if the path is one.
fn target<'a>(path: &'a str, prefix: &str, suffix: &str) -> Option<&'a str> {
    let id = path.strip_prefix(prefix)?.strip_suffix(suffix)?;
    (!id.is_empty() && !id.contains('/')).then_some(id)
}

fn if_none_match(req: &IngressRequest) -> Option<&str> {
    req.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("if-none-match")).map(|(_, v)| v.as_str())
}

/// The two routes authorized by their URL alone (a sign-in is neither required nor read): the
/// upload content target and a signed link. `None` for any other request.
pub async fn public_route<S: Store>(store: &mut S, tokens: &Tokens, now_ms: u64, req: &IngressRequest, path: &str, query: &[(String, String)]) -> Option<Reply> {
    match req.method.as_str() {
        "PUT" => {
            let id = target(path, "/v1/uploads/", "/content")?;
            Some(match receive(store, tokens, now_ms, id, query, &req.body).await {
                Ok(body) => Reply::json(200, body),
                Err(e) => api::error_reply(e),
            })
        }
        "GET" => {
            let token = target(path, "/v1/media/signed/", "")?;
            Some(serve_signed(store, tokens, now_ms, token, if_none_match(req)).await)
        }
        _ => None,
    }
}

/// The owner's media routes, after sign-in. `None` for any other request.
pub async fn route<S: Store>(store: &mut S, tokens: &Tokens, principal: Principal, now_ms: u64, req: &IngressRequest, path: &str, query: &[(String, String)]) -> Option<Reply> {
    let inm = if_none_match(req);
    let json_reply = |r: Result<Value, CmdError>| match r {
        Ok(body) => Reply::json(200, body),
        Err(e) => api::error_reply(e),
    };
    let raw_reply = |r: Result<Reply, CmdError>| r.unwrap_or_else(api::error_reply);
    enum Route<'p> {
        Authorize,
        Status(&'p str),
        Complete(&'p str),
        Rendition(&'p str),
        Sign(&'p str),
        Asset(&'p str),
        ItemImage(&'p str),
    }
    let route = match req.method.as_str() {
        "POST" if path == "/v1/uploads" => Route::Authorize,
        "POST" if target(path, "/v1/uploads/", "/complete").is_some() => Route::Complete(target(path, "/v1/uploads/", "/complete")?),
        "POST" if target(path, "/v1/media/renditions/", "/sign").is_some() => Route::Sign(target(path, "/v1/media/renditions/", "/sign")?),
        "GET" if target(path, "/v1/uploads/", "").is_some() => Route::Status(target(path, "/v1/uploads/", "")?),
        "GET" if target(path, "/v1/media/renditions/", "").is_some() => Route::Rendition(target(path, "/v1/media/renditions/", "")?),
        "GET" if target(path, "/v1/media/assets/", "").is_some() => Route::Asset(target(path, "/v1/media/assets/", "")?),
        "GET" if target(path, "/v1/items/", "/image").is_some() => Route::ItemImage(target(path, "/v1/items/", "/image")?),
        _ => return None,
    };
    if let Err(e) = owner_only(principal) {
        return Some(api::error_reply(e));
    }
    Some(match route {
        Route::Authorize => json_reply(authorize(store, tokens, now_ms, &req.body).await),
        Route::Status(id) => json_reply(status(store, now_ms, id).await),
        Route::Complete(id) => json_reply(complete(store, principal, now_ms, id).await),
        Route::Sign(id) => json_reply(sign(store, tokens, now_ms, id, &req.body).await),
        Route::Rendition(id) => raw_reply(rendition(store, id, query, inm).await),
        Route::Asset(id) => raw_reply(asset(store, id, query, inm).await),
        Route::ItemImage(id) => raw_reply(item_image(store, id, query, inm).await),
    })
}
