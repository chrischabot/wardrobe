//! Photographs, the media core, as the app's capture and wardrobe screens use it: authorize an
//! upload, send its bytes in pieces within Ferrite's 256 KiB body cap, finalize it through the
//! command service (a receipt like every other change), then read the garment's photograph, the
//! rendition, the asset and a signed link, none of which carries location unless the owner asks for
//! the original as supplied; and the portable export with and without `includeLocation`.
//!
//! Test doubles: the store is an in-memory double of the APE binding (the same guarded-commit
//! semantics), and the image files are synthetic, built byte by byte with the structure of a JPEG
//! or PNG (they are not real photographs). The garments are the real seed.

use std::collections::BTreeMap;
use std::io;

use ferrite_app::serde_json::{self, json, Value};
use ferrite_app::IngressRequest;
use wardrobe::api::{self, Store, Tokens};
use wardrobe::image::{has_location, probe};
use wardrobe::media::{FINALIZE_GRACE_MS, MAX_CHUNK_BYTES, MAX_UPLOAD_BYTES, NO_PHOTO, UPLOAD_TTL_MS};
use wardrobe::time::parse_instant;

const ORIGIN: &str = "http://127.0.0.1:8787";
const OWNER: &str = "owner-token-for-tests";
const ASSISTANT: &str = "assistant-token-for-tests";
const OXFORD_BLUE: &str = "gmt_3894b6a6295908d5e687af4f";

#[derive(Default, Clone)]
struct MemStore {
    data: BTreeMap<Vec<u8>, Vec<u8>>,
}

impl Store for MemStore {
    async fn get(&mut self, key: &[u8]) -> io::Result<Option<Vec<u8>>> {
        Ok(self.data.get(key).cloned())
    }
    async fn commit_n_if(&mut self, guard: &[u8], expected: Option<&[u8]>, entries: &[(&[u8], &[u8])]) -> io::Result<Result<(), Option<Vec<u8>>>> {
        let current = self.data.get(guard).cloned();
        if current.as_deref() != expected {
            return Ok(Err(current));
        }
        for (k, v) in entries {
            self.data.insert(k.to_vec(), v.to_vec());
        }
        Ok(Ok(()))
    }
}

struct Answer {
    status: u16,
    json: Value,
    content_type: String,
    bytes: Vec<u8>,
    headers: Vec<(String, String)>,
}

impl Answer {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
    fn code(&self) -> Option<&str> {
        self.json["error"]["code"].as_str()
    }
}

async fn send(store: &mut MemStore, now: u64, method: &str, path: &str, auth: Option<&str>, headers: &[(&str, &str)], body: Vec<u8>) -> Answer {
    let mut req = IngressRequest::new(method, path, body);
    req.correlation_id = "corr-media".into();
    if let Some(a) = auth {
        req.headers.push(("authorization".into(), format!("Bearer {a}")));
    }
    req.headers.extend(headers.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    let tokens = Tokens { owner: Some(OWNER.into()), assistant: Some(ASSISTANT.into()), public_origin: Some(ORIGIN.into()), app_client_id: None, app_redirect_uri: None };
    let reply = api::handle(store, &tokens, now, &req).await;
    let (content_type, bytes) = reply.content();
    Answer { status: reply.status, json: serde_json::from_slice(&bytes).unwrap_or(Value::Null), content_type, bytes, headers: reply.headers }
}

async fn owner(store: &mut MemStore, now: u64, method: &str, path: &str, body: Value) -> Answer {
    let bytes = if body.is_null() { Vec::new() } else { body.to_string().into_bytes() };
    send(store, now, method, path, Some(OWNER), &[], bytes).await
}

async fn put(store: &mut MemStore, now: u64, url: &str, offset: usize, piece: &[u8]) -> Answer {
    send(store, now, "PUT", &format!("{url}&offset={offset}"), None, &[], piece.to_vec()).await
}

fn at(text: &str) -> u64 {
    parse_instant(text).unwrap()
}

// ─────────────────────────── synthetic image files ───────────────────────────

fn segment(marker: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![0xFF, marker];
    out.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// A big-endian Exif block with an orientation of 6 and a GPS directory holding a latitude.
fn exif_with_gps() -> Vec<u8> {
    let mut t = b"Exif\0\0MM\0\x2a".to_vec();
    t.extend_from_slice(&8u32.to_be_bytes());
    t.extend_from_slice(&2u16.to_be_bytes());
    t.extend_from_slice(&[0x01, 0x12, 0x00, 0x03, 0, 0, 0, 1, 0, 6, 0, 0]);
    t.extend_from_slice(&[0x88, 0x25, 0x00, 0x04, 0, 0, 0, 1, 0, 0, 0, 38]);
    t.extend_from_slice(&0u32.to_be_bytes());
    t.extend_from_slice(b"GPS 51 30 26 N 0 7 39 W");
    t
}

/// A structurally complete JPEG of `w`×`h` with GPS metadata, a comment, and `pad` scan bytes.
fn jpeg(w: u16, h: u16, pad: usize) -> Vec<u8> {
    let mut b = vec![0xFF, 0xD8];
    b.extend(segment(0xE0, b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0"));
    b.extend(segment(0xE1, &exif_with_gps()));
    b.extend(segment(0xFE, b"taken at home"));
    b.extend(segment(0xDB, &[0u8; 65]));
    let mut sof = vec![8];
    sof.extend_from_slice(&h.to_be_bytes());
    sof.extend_from_slice(&w.to_be_bytes());
    sof.extend_from_slice(&[1, 1, 0x11, 0]);
    b.extend(segment(0xC0, &sof));
    b.extend(segment(0xC4, &[0u8; 17]));
    b.extend(segment(0xDA, &[1, 1, 0, 0, 0x3F, 0]));
    b.extend(std::iter::repeat(0x11).take(pad));
    b.extend_from_slice(&[0x12, 0xFF, 0x00, 0x34, 0x56, 0xFF, 0xD9]);
    b
}

fn find(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// The entries of a ZIP archive written without compression, by walking its local headers.
fn entries(zip: &[u8]) -> BTreeMap<String, Vec<u8>> {
    let u16_at = |i: usize| u16::from_le_bytes([zip[i], zip[i + 1]]) as usize;
    let u32_at = |i: usize| u32::from_le_bytes([zip[i], zip[i + 1], zip[i + 2], zip[i + 3]]) as usize;
    let mut out = BTreeMap::new();
    let mut i = 0;
    while i + 30 <= zip.len() && u32_at(i) == 0x0403_4b50 {
        let size = u32_at(i + 18);
        let (name_len, extra_len) = (u16_at(i + 26), u16_at(i + 28));
        let name = String::from_utf8(zip[i + 30..i + 30 + name_len].to_vec()).unwrap();
        let start = i + 30 + name_len + extra_len;
        out.insert(name, zip[start..start + size].to_vec());
        i = start + size;
    }
    out
}

fn upload_request(client: &str, intent: &str, content_type: &str, bytes: usize, garment: Option<&str>) -> Value {
    json!({"clientUploadId": client, "intent": intent, "contentType": content_type, "byteLength": bytes, "garmentId": garment})
}

/// Authorize, send in pieces of `piece` bytes, and complete: the completion's answer.
async fn upload(store: &mut MemStore, now: u64, client: &str, content_type: &str, file: &[u8], garment: Option<&str>) -> Answer {
    let intent = if garment.is_some() { "garment_photo" } else { "attachment" };
    let auth = owner(store, now, "POST", "/v1/uploads", upload_request(client, intent, content_type, file.len(), garment)).await;
    assert_eq!(auth.status, 200, "{}", auth.json);
    let url = auth.json["url"].as_str().unwrap().to_string();
    let mut offset = 0;
    for piece in file.chunks(MAX_CHUNK_BYTES) {
        let r = put(store, now + 1_000, &url, offset, piece).await;
        assert_eq!(r.status, 200, "{}", r.json);
        offset += piece.len();
    }
    let id = auth.json["uploadId"].as_str().unwrap();
    owner(store, now + 2_000, "POST", &format!("/v1/uploads/{id}/complete"), Value::Null).await
}

#[tokio::test]
async fn a_garment_photo_arrives_in_pieces_gets_a_receipt_and_is_never_served_with_its_location() {
    let mut store = MemStore::default();
    let now = at("2026-10-13T08:00:00Z");
    let file = jpeg(1200, 1600, 400_000);
    assert!(file.len() > MAX_CHUNK_BYTES && has_location(&file), "a photograph larger than one request, with GPS");

    // Before any photograph, the garment's image is an honest 404 with the app's note.
    let none = owner(&mut store, now, "GET", &format!("/v1/items/{OXFORD_BLUE}/image"), Value::Null).await;
    assert_eq!((none.status, none.json["error"]["details"]["missingImageNote"].as_str()), (404, Some(NO_PHOTO)), "{}", none.json);

    // Authorization: retried, it answers the same upload; a different upload under its ID is refused.
    let request = upload_request("capture-0001", "garment_photo", "image/jpeg", file.len(), Some(OXFORD_BLUE));
    let auth = owner(&mut store, now, "POST", "/v1/uploads", request.clone()).await;
    assert_eq!(auth.status, 200, "{}", auth.json);
    let (id, url) = (auth.json["uploadId"].as_str().unwrap().to_string(), auth.json["url"].as_str().unwrap().to_string());
    assert!(url.starts_with(&format!("/v1/uploads/{id}/content?token=")), "{url}");
    assert_eq!((auth.json["method"].as_str(), auth.json["maxBytes"].as_u64(), auth.json["replayed"].as_bool()), (Some("PUT"), Some(file.len() as u64), Some(false)));
    let again = owner(&mut store, now + 500, "POST", "/v1/uploads", request).await;
    assert_eq!((again.json["url"].as_str(), again.json["replayed"].as_bool()), (Some(url.as_str()), Some(true)));
    let reuse = owner(&mut store, now + 500, "POST", "/v1/uploads", upload_request("capture-0001", "garment_photo", "image/jpeg", file.len() + 1, Some(OXFORD_BLUE))).await;
    assert_eq!((reuse.status, reuse.code()), (409, Some("idempotency_key_reuse")));

    // The bytes, in order, authorized by the URL alone.
    let (first, rest) = file.split_at(200_000);
    let r = put(&mut store, now + 1_000, &url, 0, first).await;
    assert_eq!((r.status, r.json["receivedBytes"].as_u64()), (200, Some(200_000)), "{}", r.json);
    let early = put(&mut store, now + 1_000, &url, 300_000, &rest[100_000..]).await;
    assert_eq!((early.status, early.json["error"]["details"]["receivedBytes"].as_u64()), (409, Some(200_000)), "out of order: {}", early.json);
    let resent = put(&mut store, now + 1_100, &url, 0, first).await;
    assert_eq!((resent.status, resent.json["receivedBytes"].as_u64()), (200, Some(200_000)), "a piece sent again is answered as received");
    let big = put(&mut store, now + 1_100, &url, 200_000, &vec![0x11; MAX_CHUNK_BYTES + 1]).await;
    assert_eq!((big.status, big.code()), (413, Some("payload_too_large")));
    let forged = url.replace("token=", "token=0");
    let r = put(&mut store, now + 1_100, &forged, 200_000, rest).await;
    assert_eq!((r.status, r.code()), (401, Some("unauthenticated")), "{}", r.json);
    let status = owner(&mut store, now + 1_200, "GET", &format!("/v1/uploads/{id}"), Value::Null).await;
    assert_eq!(status.json["state"], "authorized", "{}", status.json);
    // Completing between pieces waits for the rest and records nothing.
    let early = owner(&mut store, now + 1_200, "POST", &format!("/v1/uploads/{id}/complete"), Value::Null).await;
    assert_eq!((early.status, early.code(), early.json["error"]["details"]["receivedBytes"].as_u64()), (409, Some("precondition_failed"), Some(200_000)), "{}", early.json);
    let status = owner(&mut store, now + 1_200, "GET", &format!("/v1/uploads/{id}"), Value::Null).await;
    assert_eq!((status.json["state"].as_str(), status.json["rejectionReason"].is_null()), (Some("authorized"), true), "{}", status.json);
    let r = put(&mut store, now + 1_300, &url, 200_000, rest).await;
    assert_eq!((r.status, r.json["receivedBytes"].as_u64()), (200, Some(file.len() as u64)), "{}", r.json);

    // Only the owner finalizes; the owner's completion is a command with a receipt.
    let path = format!("/v1/uploads/{id}/complete");
    let refused = send(&mut store, now + 2_000, "POST", &path, Some(ASSISTANT), &[], Vec::new()).await;
    assert_eq!(refused.status, 403, "{}", refused.json);
    let done = owner(&mut store, now + 2_000, "POST", &path, Value::Null).await;
    assert_eq!(done.status, 200, "{}", done.json);
    assert_eq!((done.json["state"].as_str(), done.json["rejectionReason"].is_null()), (Some("finalized"), true), "{}", done.json);
    let asset = done.json["asset"].clone();
    assert_eq!((asset["kind"].as_str(), asset["garmentId"].as_str(), asset["hadLocationMetadata"].as_bool(), asset["status"].as_str()), (Some("owner_photo"), Some(OXFORD_BLUE), Some(true), Some("active")));
    assert_eq!((asset["renditions"][0]["width"].as_u64(), asset["renditions"][0]["height"].as_u64()), (Some(1200), Some(1600)));
    let receipt = done.json["receipt"].clone();
    assert_eq!(receipt["result"]["finalized"], true, "{receipt}");
    let replay = owner(&mut store, now + 3_000, "POST", &path, Value::Null).await;
    assert_eq!(replay.json["receipt"]["commandId"], receipt["commandId"], "completing again answers the same receipt");
    let listed = owner(&mut store, now + 3_000, "GET", "/v1/commands", Value::Null).await;
    assert!(listed.json.to_string().contains("media.finalize_upload"), "{}", listed.json);
    let late = put(&mut store, now + 3_000, &url, file.len(), b"more").await;
    assert_eq!(late.status, 409, "a finalized upload takes no more bytes: {}", late.json);

    // The garment's photograph: the same picture, without its metadata, and only for the owner.
    let image = owner(&mut store, now + 4_000, "GET", &format!("/v1/items/{OXFORD_BLUE}/image?width=320"), Value::Null).await;
    assert_eq!((image.status, image.content_type.as_str()), (200, "image/jpeg"), "{}", image.json);
    assert!(!has_location(&image.bytes) && !find(&image.bytes, b"taken at home"), "no GPS, no comment");
    let (p, q) = (probe(&image.bytes).unwrap(), probe(&file).unwrap());
    assert_eq!(p, q, "the same picture");
    assert_eq!(image.header("x-content-type-options"), Some("nosniff"));
    let etag = image.header("etag").unwrap().to_string();
    let cached = send(&mut store, now + 4_000, "GET", &format!("/v1/items/{OXFORD_BLUE}/image"), Some(OWNER), &[("if-none-match", &etag)], Vec::new()).await;
    assert_eq!((cached.status, cached.bytes.len()), (304, 0));
    let theirs = send(&mut store, now + 4_000, "GET", &format!("/v1/items/{OXFORD_BLUE}/image"), Some(ASSISTANT), &[], Vec::new()).await;
    assert_eq!(theirs.status, 403);
    let bad_width = owner(&mut store, now + 4_000, "GET", &format!("/v1/items/{OXFORD_BLUE}/image?width=999"), Value::Null).await;
    assert_eq!(bad_width.status, 400);
    let unsigned = send(&mut store, now + 4_000, "GET", &format!("/v1/items/{OXFORD_BLUE}/image"), None, &[], Vec::new()).await;
    assert_eq!(unsigned.status, 401, "the garment's photograph needs the sign-in");

    // The rendition and the asset's display view are that copy; only the owner's request for the
    // original with its location is the file as supplied. There is no cutout.
    let rendition_id = asset["renditions"][0]["renditionId"].as_str().unwrap().to_string();
    let asset_id = asset["assetId"].as_str().unwrap().to_string();
    let r = owner(&mut store, now + 5_000, "GET", &format!("/v1/media/renditions/{rendition_id}"), Value::Null).await;
    assert_eq!((r.status, &r.bytes), (200, &image.bytes));
    for query in ["", "?variant=display", "?variant=original", "?variant=display&withLocation=true"] {
        let r = owner(&mut store, now + 5_000, "GET", &format!("/v1/media/assets/{asset_id}{query}"), Value::Null).await;
        assert_eq!((r.status, &r.bytes), (200, &image.bytes), "{query}");
    }
    let original = owner(&mut store, now + 5_000, "GET", &format!("/v1/media/assets/{asset_id}?variant=original&withLocation=true"), Value::Null).await;
    assert_eq!((original.status, &original.bytes), (200, &file));
    let cutout = owner(&mut store, now + 5_000, "GET", &format!("/v1/media/assets/{asset_id}?variant=cutout"), Value::Null).await;
    assert_eq!(cutout.status, 404);
    for path in [format!("/v1/media/renditions/{rendition_id}"), format!("/v1/media/assets/{asset_id}?variant=original&withLocation=true")] {
        let theirs = send(&mut store, now + 5_000, "GET", &path, Some(ASSISTANT), &[], Vec::new()).await;
        assert_eq!(theirs.status, 403, "{path}");
    }

    // A signed link opens without a sign-in, never with location, and refuses to be asked for it.
    let sign = format!("/v1/media/renditions/{rendition_id}/sign");
    let r = owner(&mut store, now + 6_000, "POST", &sign, json!({"withLocation": true})).await;
    assert_eq!((r.status, r.json["error"]["details"]["reason"].as_str()), (400, Some("signed_link_without_location")), "{}", r.json);
    let link = owner(&mut store, now + 6_000, "POST", &sign, json!({"ttlSeconds": 3600})).await;
    assert_eq!(link.status, 200, "{}", link.json);
    assert_eq!(link.json["expiresAt"], wardrobe::time::instant(now + 6_000 + 900_000), "clamped to 15 minutes");
    let link_url = link.json["url"].as_str().unwrap().to_string();
    let opened = send(&mut store, now + 7_000, "GET", &link_url, None, &[], Vec::new()).await;
    assert_eq!((opened.status, &opened.bytes), (200, &image.bytes));
    assert!(!has_location(&opened.bytes));
    let expired = send(&mut store, now + 6_000 + 900_000, "GET", &link_url, None, &[], Vec::new()).await;
    let mut tampered = link_url.clone();
    let last = tampered.pop().unwrap();
    tampered.push(if last == '0' { '1' } else { '0' });
    let tampered = send(&mut store, now + 7_000, "GET", &tampered, None, &[], Vec::new()).await;
    let longer = link_url.replacen(&format!("{}.0.", rendition_id), &format!("{}.0.9", rendition_id), 1);
    let longer = send(&mut store, now + 7_000, "GET", &longer, None, &[], Vec::new()).await;
    // The same numbers spelt differently are not the signed text.
    let wider = send(&mut store, now + 7_000, "GET", &link_url.replacen(&format!("{}.0.", rendition_id), &format!("{}.00.", rendition_id), 1), None, &[], Vec::new()).await;
    let padded = send(&mut store, now + 7_000, "GET", &link_url.replacen(&format!("{}.0.", rendition_id), &format!("{}.0.0", rendition_id), 1), None, &[], Vec::new()).await;
    let plus = send(&mut store, now + 7_000, "GET", &link_url.replacen(&format!("{}.0.", rendition_id), &format!("{}.+0.", rendition_id), 1), None, &[], Vec::new()).await;
    for refused in [&expired, &tampered, &longer, &wider, &padded, &plus] {
        assert_eq!((refused.status, refused.bytes.as_slice()), (404, &b"Not found"[..]), "every refusal looks the same");
    }
    let unsigned = send(&mut store, now + 7_000, "GET", &format!("/v1/media/renditions/{rendition_id}"), None, &[], Vec::new()).await;
    assert_eq!(unsigned.status, 401, "a rendition itself needs the sign-in");
}

#[tokio::test]
async fn uploads_are_refused_for_what_they_are_and_rejections_are_recorded_with_their_reason() {
    let mut store = MemStore::default();
    let now = at("2026-10-13T08:00:00Z");
    let photo = jpeg(640, 480, 1_000);

    // Refused at authorization: HEIC, too large, a garment photograph without a garment or of an
    // unknown one, a selfie naming a garment, and anyone but the owner.
    for (request, status) in [
        (upload_request("capture-heic", "garment_photo", "image/heic", 1_000, Some(OXFORD_BLUE)), 415),
        (upload_request("capture-huge", "garment_photo", "image/jpeg", MAX_UPLOAD_BYTES as usize + 1, Some(OXFORD_BLUE)), 413),
        (upload_request("capture-none", "garment_photo", "image/jpeg", 1_000, None), 400),
        (upload_request("capture-ghost", "garment_photo", "image/jpeg", 1_000, Some("gmt_000000000000000000000000")), 404),
        (upload_request("capture-selfie", "selfie", "image/jpeg", 1_000, Some(OXFORD_BLUE)), 400),
    ] {
        let r = owner(&mut store, now, "POST", "/v1/uploads", request.clone()).await;
        assert_eq!(r.status, status, "{request}: {}", r.json);
    }
    let r = send(&mut store, now, "POST", "/v1/uploads", Some(ASSISTANT), &[], upload_request("capture-them", "attachment", "image/jpeg", 1_000, None).to_string().into_bytes()).await;
    assert_eq!(r.status, 403);
    assert!(store.data.is_empty(), "nothing was stored");

    // Nothing received yet: completion waits for the bytes and records nothing.
    let auth = owner(&mut store, now, "POST", "/v1/uploads", upload_request("capture-empty", "attachment", "image/jpeg", photo.len(), None)).await;
    let id = auth.json["uploadId"].as_str().unwrap().to_string();
    let r = owner(&mut store, now, "POST", &format!("/v1/uploads/{id}/complete"), Value::Null).await;
    assert_eq!((r.status, r.code()), (409, Some("precondition_failed")), "{}", r.json);
    // The time to send the bytes passes.
    let url = auth.json["url"].as_str().unwrap().to_string();
    let r = put(&mut store, now + UPLOAD_TTL_MS, &url, 0, &photo).await;
    assert_eq!((r.status, r.code()), (410, Some("expired")), "{}", r.json);
    // Completed after its finalization hour with its bytes missing: refused, and nothing recorded.
    let before = store.data.clone();
    let late = now + UPLOAD_TTL_MS + FINALIZE_GRACE_MS + 1;
    let r = owner(&mut store, late, "POST", &format!("/v1/uploads/{id}/complete"), Value::Null).await;
    assert_eq!((r.status, r.code(), r.json["error"]["details"]["retryable"].as_bool()), (409, Some("precondition_failed"), Some(false)), "{}", r.json);
    assert_eq!(store.data, before, "no receipt, no rejection");
    let status = owner(&mut store, late, "GET", &format!("/v1/uploads/{id}"), Value::Null).await;
    assert_eq!(status.json["state"], "expired");

    // What the bytes are decides: a JPEG declared as PNG, a picture too small, and a file that is
    // not an image are each recorded as rejected, with the reason, and add no photograph.
    for (client, content_type, file, reason) in [
        ("capture-png", "image/png", photo.clone(), "the file is image/jpeg but image/png was declared"),
        ("capture-tiny", "image/jpeg", jpeg(32, 32, 10), "the image is only 32x32 pixels"),
        ("capture-text", "image/jpeg", b"<html>not a photograph</html>".to_vec(), "the file is not a recognised image"),
    ] {
        let done = upload(&mut store, now, client, content_type, &file, None).await;
        assert_eq!(done.status, 200, "{}", done.json);
        assert_eq!((done.json["state"].as_str(), done.json["rejectionReason"].as_str(), done.json["asset"].is_null()), (Some("rejected"), Some(reason), true), "{}", done.json);
        assert_eq!(done.json["receipt"]["result"]["finalized"], false);
        let id = done.json["uploadId"].as_str().unwrap();
        let status = owner(&mut store, now + 3_000, "GET", &format!("/v1/uploads/{id}"), Value::Null).await;
        assert_eq!((status.json["state"].as_str(), status.json["rejectionReason"].as_str()), (Some("rejected"), Some(reason)));
    }
    assert!(!store.data.contains_key(b"media-index".as_slice()), "no photograph was added");

    // A garment photograph that is a real image becomes the garment's photograph.
    let done = upload(&mut store, now, "capture-good", "image/jpeg", &photo, Some(OXFORD_BLUE)).await;
    assert_eq!(done.json["state"], "finalized", "{}", done.json);
    let image = owner(&mut store, now + 4_000, "GET", &format!("/v1/items/{OXFORD_BLUE}/image"), Value::Null).await;
    assert_eq!(image.status, 200);
}

#[tokio::test]
async fn the_export_carries_photographs_without_location_unless_the_owner_asks_for_it() {
    let mut store = MemStore::default();
    let now = at("2026-10-13T08:00:00Z");
    let photo = jpeg(800, 600, 20_000);
    let done = upload(&mut store, now, "capture-0001", "image/jpeg", &photo, Some(OXFORD_BLUE)).await;
    assert_eq!(done.json["state"], "finalized", "{}", done.json);
    let asset_id = done.json["asset"]["assetId"].as_str().unwrap().to_string();

    for (client, include_location) in [("export-0001", false), ("export-0002", true)] {
        let job = owner(&mut store, now + 10_000, "POST", "/v1/exports", json!({"clientRequestId": client, "includeLocation": include_location})).await;
        assert_eq!(job.status, 200, "{}", job.json);
        let media = job.json["components"].as_array().unwrap().iter().find(|c| c["name"] == "media").unwrap().clone();
        assert_eq!((media["state"].as_str(), media["records"].as_u64()), (Some("complete"), Some(1)), "{media}");
        let id = job.json["exportId"].as_str().unwrap();
        let ticket = owner(&mut store, now + 10_000, "POST", &format!("/v1/exports/{id}/ticket"), Value::Null).await;
        let package = send(&mut store, now + 11_000, "GET", ticket.json["url"].as_str().unwrap(), None, &[], Vec::new()).await;
        assert_eq!(package.status, 200);
        let files = entries(&package.bytes);
        let packaged = &files[&format!("media/{asset_id}.jpg")];
        if include_location {
            assert_eq!(packaged, &photo, "the original as supplied, location included");
        } else {
            assert!(!has_location(packaged), "no location without includeLocation");
            assert!(!has_location(&package.bytes), "anywhere in the package");
            assert_eq!(probe(packaged), probe(&photo));
        }
        let records: Value = serde_json::from_slice(&files["records/media.json"]).unwrap();
        assert_eq!((records["assets"][0]["assetId"].as_str(), records["includesLocation"].as_bool()), (Some(asset_id.as_str()), Some(include_location)));
        let manifest: Value = serde_json::from_slice(&files["manifest.json"]).unwrap();
        let listed = manifest["components"].as_array().unwrap().iter().find(|c| c["name"] == "media").unwrap()["files"].clone();
        assert_eq!(listed, json!(["records/media.json", format!("media/{asset_id}.jpg")]));
    }
}

#[tokio::test]
async fn photographs_beyond_the_export_budget_are_left_out_and_the_component_says_so() {
    let mut store = MemStore::default();
    let now = at("2026-10-13T08:00:00Z");
    // Three photographs of about 700 KB: two fit in the 1.5 MiB for photographs, the third does not.
    let mut sizes = Vec::new();
    for n in 0..3 {
        let photo = jpeg(1000 + n, 800, 700_000);
        sizes.push(photo.len());
        let done = upload(&mut store, now + n as u64 * 10_000, &format!("capture-big-{n}"), "image/jpeg", &photo, Some(OXFORD_BLUE)).await;
        assert_eq!(done.json["state"], "finalized", "{}", done.json);
    }
    let job = owner(&mut store, now + 60_000, "POST", "/v1/exports", json!({"clientRequestId": "export-budget"})).await;
    assert_eq!(job.status, 200, "{}", job.json);
    assert_eq!((job.json["state"].as_str(), job.json["complete"].as_bool()), (Some("completed_incomplete"), Some(false)));
    let media = job.json["components"].as_array().unwrap().iter().find(|c| c["name"] == "media").unwrap().clone();
    assert_eq!((media["state"].as_str(), media["records"].as_u64()), (Some("incomplete"), Some(3)), "{media}");
    assert!(media["note"].as_str().unwrap().contains("1 photographs did not fit"), "{media}");
    let id = job.json["exportId"].as_str().unwrap();
    let ticket = owner(&mut store, now + 60_000, "POST", &format!("/v1/exports/{id}/ticket"), Value::Null).await;
    let package = send(&mut store, now + 61_000, "GET", ticket.json["url"].as_str().unwrap(), None, &[], Vec::new()).await;
    let files = entries(&package.bytes);
    let photos: Vec<&Vec<u8>> = files.iter().filter(|(k, _)| k.starts_with("media/")).map(|(_, v)| v).collect();
    assert_eq!(photos.len(), 2, "{:?}", files.keys().collect::<Vec<_>>());
    assert!(photos.iter().map(|p| p.len()).sum::<usize>() <= wardrobe::exports::PHOTO_BUDGET_BYTES);
    assert!(sizes.iter().sum::<usize>() > wardrobe::exports::PHOTO_BUDGET_BYTES);
    let records: Value = serde_json::from_slice(&files["records/media.json"]).unwrap();
    assert_eq!(records["assets"].as_array().map(Vec::len), Some(3), "every record, even of a photograph left out");
}
