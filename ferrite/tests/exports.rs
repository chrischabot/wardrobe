//! Portable export (`POST /v1/exports`, its list, read, ticket and download) as the app's
//! `ExportModel` uses it: one package of the owner's records, readable and checksummed, built from
//! the landed reads, downloaded once per single-use ticket, and never carrying a credential: no
//! owner or assistant token, no OAuth token or token hash, no device token, no session.
//!
//! The store is an in-memory test double of the APE binding (the same guarded-commit semantics); the
//! garments, the profile document and the rules are the real seed. The OAuth grant is minted by the
//! real endpoints, and the device token is synthetic.

use std::collections::{BTreeMap, BTreeSet};
use std::io;

use ferrite_app::serde_json::{self, json, Value};
use ferrite_app::IngressRequest;
use wardrobe::api::{self, Store, Tokens};
use wardrobe::exports::{DOWNLOAD_WINDOW_MS, HOURLY_LIMIT, TICKET_TTL_MS};
use wardrobe::oauth::{b64url, consent_form_mac, pct_encode};
use wardrobe::sha256::{digest, hex_digest};
use wardrobe::time::parse_instant;

const ORIGIN: &str = "http://127.0.0.1:8787";
const OWNER: &str = "owner-token-for-tests";
const ASSISTANT: &str = "assistant-token-for-tests";
const REDIRECT: &str = "http://127.0.0.1:43123/callback";
const APP_ID: &str = "garderobe-ios";
const APP_REDIRECT: &str = "https://app.example.test/oauth/callback";
const VERIFIER: &str = "verifier-verifier-verifier-verifier-verifier-0001";
const DEVICE_TOKEN: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
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

/// Another export request commits its job between this request's read of the index and its own
/// commit: the first guarded commit on `exports` finds `racer` there instead.
struct RacingStore {
    inner: MemStore,
    racer: Option<Vec<u8>>,
}

impl Store for RacingStore {
    async fn get(&mut self, key: &[u8]) -> io::Result<Option<Vec<u8>>> {
        self.inner.get(key).await
    }
    async fn commit_n_if(&mut self, guard: &[u8], expected: Option<&[u8]>, entries: &[(&[u8], &[u8])]) -> io::Result<Result<(), Option<Vec<u8>>>> {
        if guard == b"exports" {
            if let Some(racer) = self.racer.take() {
                self.inner.data.insert(b"exports".to_vec(), racer.clone());
                return Ok(Err(Some(racer)));
            }
        }
        self.inner.commit_n_if(guard, expected, entries).await
    }
}

struct Answer {
    status: u16,
    json: Value,
    content_type: String,
    bytes: Vec<u8>,
    headers: Vec<(String, String)>,
}

async fn send<S: Store>(store: &mut S, now: u64, method: &str, path: &str, auth: Option<&str>, body: Vec<u8>) -> Answer {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let mut req = IngressRequest::new(method, path, body);
    req.correlation_id = format!("corr-{}", NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    if let Some(a) = auth {
        req.headers = vec![("authorization".into(), format!("Bearer {a}"))];
    }
    let tokens = Tokens {
        owner: Some(OWNER.into()),
        assistant: Some(ASSISTANT.into()),
        public_origin: Some(ORIGIN.into()),
        app_client_id: Some(APP_ID.into()),
        app_redirect_uri: Some(APP_REDIRECT.into()),
    };
    let reply = api::handle(store, &tokens, now, &req).await;
    let (content_type, bytes) = reply.content();
    Answer { status: reply.status, json: serde_json::from_slice(&bytes).unwrap_or(Value::Null), content_type, bytes, headers: reply.headers }
}

fn at(text: &str) -> u64 {
    parse_instant(text).unwrap()
}

async fn owner<S: Store>(store: &mut S, now: u64, method: &str, path: &str, body: Value) -> Answer {
    let bytes = if body.is_null() { Vec::new() } else { body.to_string().into_bytes() };
    send(store, now, method, path, Some(OWNER), bytes).await
}

async fn command(store: &mut MemStore, now: u64, key: &str, kind: &str, payload: Value) -> Value {
    let envelope = json!({"type": kind, "payload": payload, "idempotencyKey": key, "authorization": "owner_tap", "source": {"channel": "ios"}});
    let r = owner(store, now, "POST", "/v1/commands", envelope).await;
    assert_eq!(r.status, 200, "{kind}: {}", r.json);
    r.json
}

fn form(pairs: &[(&str, &str)]) -> Vec<u8> {
    pairs.iter().map(|(k, v)| format!("{k}={}", pct_encode(v))).collect::<Vec<_>>().join("&").into_bytes()
}

/// A connected assistant through the real OAuth endpoints: registration, the owner's consent with
/// PKCE and the code exchange. Returns the token response.
async fn connect_assistant(store: &mut MemStore, now: u64) -> Value {
    let body = json!({"redirect_uris": [REDIRECT], "client_name": "Codex", "token_endpoint_auth_method": "none", "grant_types": ["authorization_code", "refresh_token"]});
    let r = send(store, now, "POST", "/oauth/register", None, body.to_string().into_bytes()).await;
    assert_eq!(r.status, 201, "{}", r.json);
    let client = r.json["client_id"].as_str().unwrap().to_string();
    let challenge = b64url(&digest(VERIFIER.as_bytes()));
    let mac = consent_form_mac(OWNER, now, &client, REDIRECT, &challenge);
    let issued = now.to_string();
    let consent = form(&[
        ("response_type", "code"),
        ("client_id", &client),
        ("redirect_uri", REDIRECT),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
        ("scope", "wardrobe.read wardrobe.write"),
        ("state", "state-123"),
        ("resource", "http://127.0.0.1:8787/mcp"),
        ("owner_token", OWNER),
        ("decision", "allow"),
        ("write", "on"),
        ("issued", &issued),
        ("form_mac", &mac),
    ]);
    let r = send(store, now, "POST", "/oauth/authorize", None, consent).await;
    assert_eq!(r.status, 302, "{}", String::from_utf8_lossy(&r.bytes));
    let location = r.headers.iter().find(|(k, _)| k == "location").unwrap().1.clone();
    let code = location.split("code=").nth(1).unwrap().split('&').next().unwrap().to_string();
    let exchange = form(&[("grant_type", "authorization_code"), ("code", &code), ("redirect_uri", REDIRECT), ("client_id", &client), ("code_verifier", VERIFIER), ("resource", "http://127.0.0.1:8787/mcp")]);
    let t = send(store, now, "POST", "/oauth/token", None, exchange).await;
    assert_eq!(t.status, 200, "{}", t.json);
    t.json
}

/// A sign-in of the owner's app through the real endpoints (consent, PKCE, code exchange):
/// (access token, refresh token).
async fn app_sign_in(store: &mut MemStore, now: u64) -> (String, String) {
    let challenge = b64url(&digest(VERIFIER.as_bytes()));
    let mac = consent_form_mac(OWNER, now, APP_ID, APP_REDIRECT, &challenge);
    let issued = now.to_string();
    let consent = form(&[
        ("response_type", "code"),
        ("client_id", APP_ID),
        ("redirect_uri", APP_REDIRECT),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
        ("state", "app-state-1"),
        ("resource", ORIGIN),
        ("owner_token", OWNER),
        ("decision", "allow"),
        ("issued", &issued),
        ("form_mac", &mac),
    ]);
    let r = send(store, now, "POST", "/oauth/authorize", None, consent).await;
    assert_eq!(r.status, 302, "{}", String::from_utf8_lossy(&r.bytes));
    let location = r.headers.iter().find(|(k, _)| k == "location").unwrap().1.clone();
    let code = location.split("code=").nth(1).unwrap().split('&').next().unwrap().to_string();
    let exchange = form(&[("grant_type", "authorization_code"), ("code", &code), ("redirect_uri", APP_REDIRECT), ("client_id", APP_ID), ("code_verifier", VERIFIER), ("resource", ORIGIN)]);
    let t = send(store, now, "POST", "/oauth/token", None, exchange).await;
    assert_eq!(t.status, 200, "{}", t.json);
    (t.json["access_token"].as_str().unwrap().to_string(), t.json["refresh_token"].as_str().unwrap().to_string())
}

/// The entries of a ZIP archive written without compression, by walking its local headers.
fn entries(zip: &[u8]) -> BTreeMap<String, Vec<u8>> {
    let u16_at = |i: usize| u16::from_le_bytes([zip[i], zip[i + 1]]) as usize;
    let u32_at = |i: usize| u32::from_le_bytes([zip[i], zip[i + 1], zip[i + 2], zip[i + 3]]) as usize;
    let mut out = BTreeMap::new();
    let mut i = 0;
    while i + 30 <= zip.len() && u32_at(i) == 0x0403_4b50 {
        assert_eq!(u16_at(i + 8), 0, "stored, not compressed");
        let size = u32_at(i + 18);
        assert_eq!(size, u32_at(i + 22));
        let (name_len, extra_len) = (u16_at(i + 26), u16_at(i + 28));
        let name = String::from_utf8(zip[i + 30..i + 30 + name_len].to_vec()).unwrap();
        let start = i + 30 + name_len + extra_len;
        out.insert(name, zip[start..start + size].to_vec());
        i = start + size;
    }
    assert_eq!(u32_at(i), 0x0201_4b50, "the central directory follows the files");
    out
}

/// Every string under a key named `hash`, `challenge` or `requestHash` in a stored record (OAuth code,
/// token and PKCE hashes, export ticket hashes, command and run request hashes).
fn hashes(v: &Value, out: &mut BTreeSet<String>) {
    match v {
        Value::Array(a) => a.iter().for_each(|x| hashes(x, out)),
        Value::Object(m) => {
            for (k, x) in m {
                match x {
                    Value::String(s) if k == "hash" || k == "challenge" || k == "requestHash" => {
                        out.insert(s.clone());
                    }
                    _ => hashes(x, out),
                }
            }
        }
        _ => {}
    }
}

fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle.as_bytes())
}

#[tokio::test]
async fn an_export_holds_the_owners_records_once_downloaded_and_no_credential() {
    let mut store = MemStore::default();
    let t0 = at("2026-10-12T09:00:00Z");
    let wear = command(&mut store, t0, "wear-0001", "wear.record", json!({"wearingDate": "2026-10-12", "garmentIds": [OXFORD_BLUE]})).await;
    command(&mut store, t0 + 1_000, "trip-0001", "trip.create", json!({
        "tripId": "trp_lisbon", "name": "Lisbon", "departsOn": "2026-10-20", "returnsOn": "2026-10-23",
        "destinations": [{"label": "Lisbon", "latitude": 38.7223, "longitude": -9.1393, "timezone": "Europe/Lisbon", "from": "2026-10-20", "to": "2026-10-23"}],
        "source": {"kind": "owner_statement"},
    })).await;
    let r = owner(&mut store, t0 + 2_000, "POST", "/v1/devices", json!({"deviceId": "device-0001-phone", "token": DEVICE_TOKEN, "environment": "production"})).await;
    assert_eq!(r.status, 200, "{}", r.json);
    let grant = connect_assistant(&mut store, t0 + 3_000).await;
    let (access, refresh) = (grant["access_token"].as_str().unwrap().to_string(), grant["refresh_token"].as_str().unwrap().to_string());
    // The app's own sign-in session: the export is requested with it, as the app does.
    let (app_access, app_refresh) = app_sign_in(&mut store, t0 + 4_000).await;

    let now = t0 + 10_000;
    let r = send(&mut store, now, "POST", "/v1/exports", Some(&app_access), json!({"clientRequestId": "export-0001"}).to_string().into_bytes()).await;
    assert_eq!(r.status, 200, "{}", r.json);
    let job = r.json.clone();
    assert_eq!((job["state"].as_str(), job["complete"].as_bool(), job["encrypted"].as_bool(), job["includesLocation"].as_bool()), (Some("completed"), Some(true), Some(false), Some(false)), "{job}");
    let names: Vec<&str> = job["components"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["inventory", "ledger", "boards", "trips", "returns", "feedback", "receipts", "style", "account", "conversation", "media"]);
    assert_eq!(job["components"][0]["records"], 127, "every imported garment");
    assert_eq!(job["snapshot"]["wardrobeRevision"], 2, "{job}");
    let export_id = job["exportId"].as_str().unwrap().to_string();

    // The same request ID answers the same job; a different request under it is refused.
    let again = owner(&mut store, now + 5_000, "POST", "/v1/exports", json!({"clientRequestId": "export-0001"})).await;
    assert_eq!((again.status, again.json["exportId"].as_str()), (200, Some(export_id.as_str())));
    let other = owner(&mut store, now + 5_000, "POST", "/v1/exports", json!({"clientRequestId": "export-0001", "includeLocation": true})).await;
    assert_eq!((other.status, other.json["error"]["code"].as_str()), (409, Some("idempotency_key_reuse")));
    let listed = owner(&mut store, now, "GET", "/v1/exports", Value::Null).await;
    assert_eq!(listed.json["exports"].as_array().map(Vec::len), Some(1));
    let read = owner(&mut store, now, "GET", &format!("/v1/exports/{export_id}"), Value::Null).await;
    assert_eq!(read.json, job);

    // A ticket downloads the package once, without the sign-in; the bytes are the job's.
    let ticket = owner(&mut store, now, "POST", &format!("/v1/exports/{export_id}/ticket"), Value::Null).await;
    assert_eq!(ticket.status, 200, "{}", ticket.json);
    let url = ticket.json["url"].as_str().unwrap().to_string();
    assert!(url.starts_with(&format!("/v1/exports/{export_id}/download?ticket=")), "{url}");
    assert!(ticket.json["fileName"].as_str().unwrap().ends_with(".zip"));
    let package = send(&mut store, now + 1_000, "GET", &url, None, Vec::new()).await;
    assert_eq!((package.status, package.content_type.as_str()), (200, "application/zip"), "{}", package.json);
    assert_eq!(hex_digest(&package.bytes), job["sha256"].as_str().unwrap());
    assert_eq!(package.bytes.len() as u64, job["byteLength"].as_u64().unwrap());
    let spent = send(&mut store, now + 2_000, "GET", &url, None, Vec::new()).await;
    assert_eq!((spent.status, spent.json["error"]["code"].as_str()), (401, Some("unauthenticated")), "a ticket works once");

    // The package: every file checksummed, the records and readable views, no photograph.
    let files = entries(&package.bytes);
    for name in ["README.md", "manifest.json", "checksums.sha256", "records/inventory.json", "records/ledger.json", "records/receipts.json", "records/trips.json", "records/style.json", "records/account.json", "views/inventory.csv", "views/wear-history.csv", "views/profile.md", "views/summary.md"] {
        assert!(files.contains_key(name), "{name} is missing: {:?}", files.keys().collect::<Vec<_>>());
    }
    assert!(!files.keys().any(|k| k.starts_with("media/")), "no photograph, so no location data");
    let checksums = String::from_utf8(files["checksums.sha256"].clone()).unwrap();
    assert_eq!(checksums.lines().count(), files.len() - 1);
    for line in checksums.lines() {
        let (sum, path) = line.split_once("  ").unwrap();
        assert_eq!(hex_digest(&files[path]), sum, "{path}");
    }
    // The profile document exactly as supplied (its recorded hash), and the wear in both the records and the view.
    assert_eq!(hex_digest(&files["views/profile.md"]), "e15639d891f9a5264c7eff13d05a478bcb188745aea11323b2131db37f5cb198");
    let history = String::from_utf8(files["views/wear-history.csv"].clone()).unwrap();
    assert!(history.contains(&format!("2026-10-12,{OXFORD_BLUE},")), "{history}");
    let receipts: Value = serde_json::from_slice(&files["records/receipts.json"]).unwrap();
    let kinds: BTreeSet<&str> = receipts.as_array().unwrap().iter().map(|r| r["receipt"]["type"].as_str().unwrap()).collect();
    assert_eq!(kinds, BTreeSet::from(["trip.create", "wear.record"]));
    assert!(receipts.as_array().unwrap().iter().any(|r| r["receipt"]["commandId"] == wear["commandId"]));
    assert!(receipts.as_array().unwrap().iter().all(|r| r.get("requestHash").is_none() && r.get("undo").is_none()));
    let account: Value = serde_json::from_slice(&files["records/account.json"]).unwrap();
    assert_eq!(account["devices"][0]["deviceId"], "device-0001-phone");
    assert_eq!(account["connectedAssistants"][0]["clientName"], "Codex");

    // No credential: neither token of this server, no app session token, no OAuth token, no unspent
    // download ticket, no device token, and no hash, PKCE challenge or request hash any stored record
    // holds (OAuth codes and tokens, export tickets, commands and runs), anywhere in the package.
    let unspent = owner(&mut store, now + 3_000, "POST", &format!("/v1/exports/{export_id}/ticket"), Value::Null).await;
    assert_eq!(unspent.status, 200, "{}", unspent.json);
    let unspent = unspent.json["url"].as_str().unwrap().split("ticket=").nth(1).unwrap().to_string();
    let mut secrets: BTreeSet<String> = BTreeSet::from([OWNER.to_string(), ASSISTANT.to_string(), DEVICE_TOKEN.to_string(), access.clone(), refresh.clone(), app_access.clone(), app_refresh.clone(), unspent]);
    let records: Vec<Value> = store.data.values().filter_map(|v| serde_json::from_slice::<Value>(v).ok()).collect();
    assert!(records.iter().filter(|v| v["requestHash"].is_string()).count() >= 2, "the commands' request hashes are stored");
    assert!(records.iter().any(|v| v["jobs"][0]["tickets"][0]["hash"].is_string()), "the unspent ticket's hash is stored");
    for v in &records {
        hashes(v, &mut secrets);
    }
    assert!(secrets.len() > 12, "the stored records hold hashes: {secrets:?}");
    for secret in &secrets {
        assert!(!contains(&package.bytes, secret), "the package carries a credential: {secret}");
    }
}

#[tokio::test]
async fn only_the_owner_exports_and_an_encryption_request_is_never_answered_unencrypted() {
    let mut store = MemStore::default();
    let now = at("2026-10-12T09:00:00Z");
    let r = send(&mut store, now, "POST", "/v1/exports", Some(ASSISTANT), json!({"clientRequestId": "export-0001"}).to_string().into_bytes()).await;
    assert_eq!(r.status, 403, "{}", r.json);
    let r = send(&mut store, now, "GET", "/v1/exports", Some(ASSISTANT), Vec::new()).await;
    assert_eq!(r.status, 403, "{}", r.json);
    let r = send(&mut store, now, "POST", "/v1/exports", None, json!({"clientRequestId": "export-0001"}).to_string().into_bytes()).await;
    assert_eq!(r.status, 401, "{}", r.json);

    let r = owner(&mut store, now, "POST", "/v1/exports", json!({"clientRequestId": "export-0001", "passphrase": "correct horse battery staple"})).await;
    assert_eq!((r.status, r.json["error"]["code"].as_str()), (501, Some("module_unavailable")), "{}", r.json);
    let r = owner(&mut store, now, "POST", "/v1/exports", json!({"clientRequestId": "export-0001", "userId": "someone"})).await;
    assert_eq!(r.status, 400, "{}", r.json);
    assert!(store.data.is_empty(), "nothing was started");

    // The owner may ask for photographs with their location: recorded on the job; there are none.
    let r = owner(&mut store, now, "POST", "/v1/exports", json!({"clientRequestId": "export-0002", "includeLocation": true})).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["includesLocation"], true);
    let media = r.json["components"].as_array().unwrap().iter().find(|c| c["name"] == "media").unwrap().clone();
    assert_eq!(media["records"], 0, "{media}");
    // The assistant can neither read the job nor ask for its download.
    let id = r.json["exportId"].as_str().unwrap().to_string();
    for (method, path) in [("GET", format!("/v1/exports/{id}")), ("POST", format!("/v1/exports/{id}/ticket"))] {
        let r = send(&mut store, now, method, &path, Some(ASSISTANT), Vec::new()).await;
        assert_eq!(r.status, 403, "{method} {path}: {}", r.json);
    }
    // A download needs a ticket the owner was given.
    let r = send(&mut store, now, "GET", &format!("/v1/exports/{id}/download?ticket={}", "0".repeat(64)), None, Vec::new()).await;
    assert_eq!(r.status, 401, "{}", r.json);
}

#[tokio::test]
async fn tickets_and_packages_expire_and_an_expired_package_is_emptied() {
    let mut store = MemStore::default();
    let now = at("2026-10-12T09:00:00Z");
    let job = owner(&mut store, now, "POST", "/v1/exports", json!({"clientRequestId": "export-0001"})).await.json;
    let id = job["exportId"].as_str().unwrap().to_string();
    let ticket = owner(&mut store, now, "POST", &format!("/v1/exports/{id}/ticket"), Value::Null).await.json;
    let late = send(&mut store, now + TICKET_TTL_MS, "GET", ticket["url"].as_str().unwrap(), None, Vec::new()).await;
    assert_eq!((late.status, late.json["error"]["code"].as_str()), (410, Some("expired")), "{}", late.json);
    // A ticket issued shortly before the package expires stops when the package does, and says so.
    let last = owner(&mut store, now + DOWNLOAD_WINDOW_MS - 60_000, "POST", &format!("/v1/exports/{id}/ticket"), Value::Null).await;
    assert_eq!(last.status, 200, "{}", last.json);
    assert_eq!(last.json["expiresAt"], job["expiresAt"], "a ticket never outlives its package");

    // A day later the package has expired: it is shown so, no ticket is issued, and the next export
    // empties its stored parts.
    let later = now + DOWNLOAD_WINDOW_MS;
    let read = owner(&mut store, later, "GET", &format!("/v1/exports/{id}"), Value::Null).await;
    assert_eq!(read.json["state"], "expired");
    let r = owner(&mut store, later, "POST", &format!("/v1/exports/{id}/ticket"), Value::Null).await;
    assert_eq!((r.status, r.json["error"]["code"].as_str()), (410, Some("expired")));
    let part = format!("x/{id}/0").into_bytes();
    assert!(!store.data[&part].is_empty());
    let r = owner(&mut store, later, "POST", "/v1/exports", json!({"clientRequestId": "export-0002"})).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert!(store.data[&part].is_empty(), "the expired package's parts are emptied");

    // At most HOURLY_LIMIT exports in an hour.
    for n in 3..=HOURLY_LIMIT + 1 {
        let r = owner(&mut store, later + 1_000, "POST", "/v1/exports", json!({"clientRequestId": format!("export-{n:04}")})).await;
        assert_eq!(r.status, 200, "{n}: {}", r.json);
    }
    let r = owner(&mut store, later + 1_000, "POST", "/v1/exports", json!({"clientRequestId": "export-9999"})).await;
    assert_eq!((r.status, r.json["error"]["code"].as_str()), (429, Some("rate_limited")), "{}", r.json);
}

#[tokio::test]
async fn concurrent_requests_cannot_pass_the_hourly_limit_together() {
    let mut store = MemStore::default();
    let now = at("2026-10-12T09:00:00Z");
    for n in 1..HOURLY_LIMIT {
        let r = owner(&mut store, now, "POST", "/v1/exports", json!({"clientRequestId": format!("export-{n:04}")})).await;
        assert_eq!(r.status, 200, "{n}: {}", r.json);
    }
    // Another request takes the hour's last place while this one builds its package (both saw
    // HOURLY_LIMIT - 1 recent jobs before building).
    let mut other = store.clone();
    let r = owner(&mut other, now + 1_000, "POST", "/v1/exports", json!({"clientRequestId": "export-race-b"})).await;
    assert_eq!(r.status, 200, "{}", r.json);
    let racer = other.data.get(b"exports".as_slice()).unwrap().clone();
    let mut racing = RacingStore { inner: store, racer: Some(racer) };
    let r = owner(&mut racing, now + 1_000, "POST", "/v1/exports", json!({"clientRequestId": "export-race-a"})).await;
    assert!(racing.racer.is_none(), "the other request committed first");
    assert_eq!((r.status, r.json["error"]["code"].as_str()), (429, Some("rate_limited")), "{}", r.json);
    let listed = owner(&mut racing, now + 1_000, "GET", "/v1/exports", Value::Null).await;
    assert_eq!(listed.json["exports"].as_array().map(Vec::len), Some(HOURLY_LIMIT), "{}", listed.json);
}
