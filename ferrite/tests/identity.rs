//! Sign-in for the one owner, as far as this server goes without an identity provider: the owner's
//! app (the iOS client's public OAuth client, configured by `WARDROBE_APP_CLIENT_ID` and
//! `WARDROBE_APP_REDIRECT_URI`) discovers the authorization server, signs in on the consent page
//! with the owner token (PKCE S256, resource = the API origin), and its tokens act as the owner on
//! `/v1` and nowhere else. Sign out everywhere ends every app sign-in and no connected assistant.
//! Claims, linked identities, recovery kits and account deletion answer `module_unavailable`.
//!
//! The store is an in-memory test double of the APE binding (the same guarded-commit semantics).

use std::collections::BTreeMap;
use std::io;

use ferrite_app::serde_json::{self, json, Value};
use ferrite_app::IngressRequest;
use wardrobe::api::{self, Store, Tokens};
use wardrobe::oauth::{b64url, consent_form_mac, pct_encode, ACCESS_TTL_MS, MAX_APP_SESSIONS};
use wardrobe::sha256::digest;

const ORIGIN: &str = "http://127.0.0.1:8787";
const OWNER: &str = "owner-token-for-tests";
const ASSISTANT: &str = "assistant-token-for-tests";
const APP_ID: &str = "garderobe-ios";
const APP_REDIRECT: &str = "https://app.example.test/oauth/callback";
const VERIFIER: &str = "verifier-verifier-verifier-verifier-verifier-0001";
const T0: u64 = 1_789_000_000_000;

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

fn tokens(app_id: Option<&str>) -> Tokens {
    Tokens {
        owner: Some(OWNER.into()),
        assistant: Some(ASSISTANT.into()),
        public_origin: Some(ORIGIN.into()),
        app_client_id: app_id.map(str::to_string),
        app_redirect_uri: Some(APP_REDIRECT.into()),
    }
}

struct Answer {
    status: u16,
    json: Value,
    text: String,
    headers: Vec<(String, String)>,
}

async fn send_with(store: &mut MemStore, t: &Tokens, now: u64, method: &str, path: &str, auth: Option<&str>, body: Vec<u8>) -> Answer {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let mut req = IngressRequest::new(method, path, body);
    req.correlation_id = format!("corr-{}", NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    if let Some(a) = auth {
        req.headers = vec![("authorization".into(), format!("Bearer {a}"))];
    }
    let reply = api::handle(store, t, now, &req).await;
    let (_, bytes) = reply.content();
    Answer { status: reply.status, json: serde_json::from_slice(&bytes).unwrap_or(Value::Null), text: String::from_utf8_lossy(&bytes).into_owned(), headers: reply.headers }
}

async fn send(store: &mut MemStore, now: u64, method: &str, path: &str, auth: Option<&str>, body: Vec<u8>) -> Answer {
    send_with(store, &tokens(Some(APP_ID)), now, method, path, auth, body).await
}

fn form(pairs: &[(&str, &str)]) -> Vec<u8> {
    pairs.iter().map(|(k, v)| format!("{k}={}", pct_encode(v))).collect::<Vec<_>>().join("&").into_bytes()
}

fn query(pairs: &[(&str, &str)]) -> String {
    String::from_utf8(form(pairs)).unwrap()
}

fn challenge() -> String {
    b64url(&digest(VERIFIER.as_bytes()))
}

/// The authorize parameters the iOS client sends (`OAuthSession.beginAuthorization`): no scope, the
/// API origin as the resource indicator.
fn app_params(challenge: &str) -> Vec<(&'static str, String)> {
    vec![
        ("response_type", "code".into()),
        ("client_id", APP_ID.into()),
        ("redirect_uri", APP_REDIRECT.into()),
        ("code_challenge", challenge.into()),
        ("code_challenge_method", "S256".into()),
        ("state", "app-state-1".into()),
        ("resource", ORIGIN.into()),
    ]
}

fn borrowed<'a>(p: &'a [(&'static str, String)]) -> Vec<(&'static str, &'a str)> {
    p.iter().map(|(k, v)| (*k, v.as_str())).collect()
}

/// The owner signs in on the consent page; returns the redirect's code.
async fn sign_in_code(store: &mut MemStore, now: u64) -> String {
    let ch = challenge();
    let ap = app_params(&ch);
    let mut params = borrowed(&ap);
    let mac = consent_form_mac(OWNER, now, APP_ID, APP_REDIRECT, &ch);
    let issued = now.to_string();
    params.extend([("owner_token", OWNER), ("decision", "allow"), ("issued", issued.as_str()), ("form_mac", mac.as_str())]);
    let r = send(store, now, "POST", "/oauth/authorize", None, form(&params)).await;
    assert_eq!(r.status, 302, "{}", r.text);
    let location = r.headers.iter().find(|(k, _)| k == "location").unwrap().1.clone();
    assert!(location.starts_with(&format!("{APP_REDIRECT}?code=wac.")) && location.contains("&state=app-state-1"), "{location}");
    location.split("code=").nth(1).unwrap().split('&').next().unwrap().to_string()
}

/// A full sign-in of the app: (access token, refresh token).
async fn sign_in(store: &mut MemStore, now: u64) -> (String, String) {
    let code = sign_in_code(store, now).await;
    let r = send(store, now, "POST", "/oauth/token", None, form(&[("grant_type", "authorization_code"), ("code", &code), ("redirect_uri", APP_REDIRECT), ("client_id", APP_ID), ("code_verifier", VERIFIER), ("resource", ORIGIN)])).await;
    assert_eq!(r.status, 200, "{}", r.text);
    assert_eq!((r.json["scope"].clone(), r.json["token_type"].clone(), r.json["expires_in"].clone()), (json!("wardrobe.owner"), json!("Bearer"), json!(ACCESS_TTL_MS / 1000)));
    (r.json["access_token"].as_str().unwrap().to_string(), r.json["refresh_token"].as_str().unwrap().to_string())
}

/// A connected assistant (registered, consented read and write): its access token.
async fn connect_assistant(store: &mut MemStore) -> String {
    let redirect = "http://127.0.0.1:43123/callback";
    let reg = send(store, T0, "POST", "/oauth/register", None, json!({"redirect_uris": [redirect], "client_name": "Codex"}).to_string().into_bytes()).await;
    assert_eq!(reg.status, 201, "{}", reg.text);
    let client = reg.json["client_id"].as_str().unwrap().to_string();
    let ch = challenge();
    let mac = consent_form_mac(OWNER, T0, &client, redirect, &ch);
    let issued = T0.to_string();
    let params = [("response_type", "code"), ("client_id", client.as_str()), ("redirect_uri", redirect), ("code_challenge", ch.as_str()), ("code_challenge_method", "S256"), ("scope", "wardrobe.read wardrobe.write"), ("resource", "http://127.0.0.1:8787/mcp"), ("owner_token", OWNER), ("decision", "allow"), ("write", "on"), ("issued", issued.as_str()), ("form_mac", mac.as_str())];
    let r = send(store, T0, "POST", "/oauth/authorize", None, form(&params)).await;
    assert_eq!(r.status, 302, "{}", r.text);
    let location = r.headers.iter().find(|(k, _)| k == "location").unwrap().1.clone();
    let code = location.split("code=").nth(1).unwrap().split('&').next().unwrap().to_string();
    let t = send(store, T0, "POST", "/oauth/token", None, form(&[("grant_type", "authorization_code"), ("code", &code), ("redirect_uri", redirect), ("client_id", &client), ("code_verifier", VERIFIER), ("resource", "http://127.0.0.1:8787/mcp")])).await;
    assert_eq!(t.status, 200, "{}", t.text);
    t.json["access_token"].as_str().unwrap().to_string()
}

async fn mcp_status(store: &mut MemStore, now: u64, token: &str) -> u16 {
    let body = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}).to_string().into_bytes();
    let mut req = IngressRequest::new("POST", "/mcp", body);
    req.headers = vec![("authorization".into(), format!("Bearer {token}"))];
    api::handle(store, &tokens(Some(APP_ID)), now, &req).await.status
}

#[tokio::test]
async fn the_app_signs_in_as_the_owner_and_its_token_works_on_the_api() {
    let mut store = MemStore::default();
    // Discovery, as `OAuthSession.discover` reads it.
    let meta = send(&mut store, T0, "GET", "/.well-known/oauth-authorization-server", None, vec![]).await;
    assert_eq!(meta.status, 200);
    assert_eq!((meta.json["authorization_endpoint"].clone(), meta.json["token_endpoint"].clone()), (json!(format!("{ORIGIN}/oauth/authorize")), json!(format!("{ORIGIN}/oauth/token"))));
    assert!(meta.json["code_challenge_methods_supported"].as_array().unwrap().contains(&json!("S256")));

    // The consent page is a sign-in page for the app, with no write choice.
    let ch = challenge();
    let page = send(&mut store, T0, "GET", &format!("/oauth/authorize?{}", query(&borrowed(&app_params(&ch)))), None, vec![]).await;
    assert_eq!(page.status, 200, "{}", page.text);
    assert!(page.text.contains("Sign in to Garderobe") && page.text.contains("name=\"owner_token\"") && !page.text.contains("name=\"write\""), "{}", page.text);
    assert!(page.text.contains("value=\"wardrobe.owner\""), "the form carries the owner scope");

    let (access, refresh) = sign_in(&mut store, T0).await;
    let me = send(&mut store, T0 + 1_000, "GET", "/v1/me", Some(&access), vec![]).await;
    assert_eq!(me.status, 200, "{}", me.text);
    assert_eq!((me.json["userId"].clone(), me.json["channel"].clone(), me.json["scopes"].clone(), me.json["identities"].clone()), (json!("owner"), json!("ios"), json!(["read", "write", "admin"]), json!([])));
    // The owner's own commands go through with the app's token, recorded on the app's channel.
    let cmd = json!({"type": "care.mark_dirty", "idempotencyKey": "app-dirty-1", "authorization": "owner_tap", "source": {"channel": "ios"}, "payload": {"items": [{"garmentId": "gmt_3894b6a6295908d5e687af4f"}]}});
    let r = send(&mut store, T0 + 2_000, "POST", "/v1/commands", Some(&access), cmd.to_string().into_bytes()).await;
    assert_eq!(r.status, 200, "{}", r.text);
    assert_eq!((r.json["actor"].clone(), r.json["channel"].clone()), (json!("owner"), json!("ios")), "{}", r.text);
    assert_eq!(send(&mut store, T0 + 3_000, "GET", "/v1/today", Some(&access), vec![]).await.status, 200);

    // It expires with its lifetime; the refresh keeps the owner scope and cannot be widened or swapped.
    let late = send(&mut store, T0 + ACCESS_TTL_MS + 1, "GET", "/v1/me", Some(&access), vec![]).await;
    assert_eq!((late.status, late.json["error"]["code"].clone()), (401, json!("unauthenticated")));
    let narrowed = send(&mut store, T0 + ACCESS_TTL_MS + 2, "POST", "/oauth/token", None, form(&[("grant_type", "refresh_token"), ("refresh_token", &refresh), ("client_id", APP_ID), ("scope", "wardrobe.read")])).await;
    assert_eq!((narrowed.status, narrowed.json["error"].clone()), (400, json!("invalid_scope")), "{}", narrowed.text);
    let renewed = send(&mut store, T0 + ACCESS_TTL_MS + 3, "POST", "/oauth/token", None, form(&[("grant_type", "refresh_token"), ("refresh_token", &refresh), ("client_id", APP_ID), ("resource", ORIGIN)])).await;
    assert_eq!((renewed.status, renewed.json["scope"].clone()), (200, json!("wardrobe.owner")), "{}", renewed.text);
    let fresh = renewed.json["access_token"].as_str().unwrap().to_string();
    assert_eq!(send(&mut store, T0 + ACCESS_TTL_MS + 4, "GET", "/v1/me", Some(&fresh), vec![]).await.status, 200);
}

#[tokio::test]
async fn app_and_assistant_tokens_stay_on_their_own_side() {
    let mut store = MemStore::default();
    let (app, _) = sign_in(&mut store, T0).await;
    let assistant = connect_assistant(&mut store).await;
    // The app's token does not reach the MCP endpoint, and an assistant's token does not reach /v1.
    assert_eq!(mcp_status(&mut store, T0 + 1_000, &app).await, 401);
    assert_eq!(mcp_status(&mut store, T0 + 1_000, &assistant).await, 200);
    let r = send(&mut store, T0 + 1_000, "GET", "/v1/me", Some(&assistant), vec![]).await;
    assert_eq!((r.status, r.json["error"]["code"].clone()), (401, json!("unauthenticated")));
    assert!(r.json["error"]["message"].as_str().unwrap().contains("/mcp only"), "{}", r.text);
    // Settings › Connected assistants lists the assistant, not the app's sign-in, and cannot disconnect the app.
    let list = send(&mut store, T0 + 1_000, "GET", "/v1/connections", Some(OWNER), vec![]).await;
    let names: Vec<&str> = list.json["connections"].as_array().unwrap().iter().map(|c| c["clientName"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["Codex"]);
    let app_grant = app.split('.').nth(1).unwrap();
    let r = send(&mut store, T0 + 1_000, "POST", &format!("/v1/connections/{app_grant}/disconnect"), Some(OWNER), vec![]).await;
    assert_eq!(r.status, 404, "{}", r.text);

    // The app's request is refused when it asks for anything but the owner scope, or for the MCP resource;
    // an assistant may not ask for the owner scope or the API origin.
    let ch = challenge();
    let ap = app_params(&ch);
    for (extra, error) in [(("scope", "wardrobe.write"), "invalid_scope"), (("resource", "http://127.0.0.1:8787/mcp"), "invalid_target")] {
        let mut p: Vec<(&str, &str)> = borrowed(&ap).into_iter().filter(|(k, _)| *k != extra.0).collect();
        p.push(extra);
        let r = send(&mut store, T0, "GET", &format!("/oauth/authorize?{}", query(&p)), None, vec![]).await;
        let location = r.headers.iter().find(|(k, _)| k == "location").map(|(_, v)| v.clone()).unwrap_or_default();
        assert!(r.status == 302 && location.starts_with(APP_REDIRECT) && location.contains(&format!("error={error}")), "{extra:?}: {} {location}", r.status);
    }
    let reg = send(&mut store, T0, "POST", "/oauth/register", None, json!({"redirect_uris": ["http://127.0.0.1:5000/cb"]}).to_string().into_bytes()).await;
    let client = reg.json["client_id"].as_str().unwrap().to_string();
    for (scope, resource, error) in [("wardrobe.owner", "http://127.0.0.1:8787/mcp", "invalid_scope"), ("wardrobe.read", ORIGIN, "invalid_target")] {
        let p = [("response_type", "code"), ("client_id", client.as_str()), ("redirect_uri", "http://127.0.0.1:5000/cb"), ("code_challenge", ch.as_str()), ("code_challenge_method", "S256"), ("scope", scope), ("resource", resource)];
        let r = send(&mut store, T0, "GET", &format!("/oauth/authorize?{}", query(&p)), None, vec![]).await;
        let location = r.headers.iter().find(|(k, _)| k == "location").map(|(_, v)| v.clone()).unwrap_or_default();
        assert!(location.contains(&format!("error={error}")), "{scope} {resource}: {location}");
    }
    // Another redirect for the app is refused on the page itself (never redirected).
    let mut p = borrowed(&ap);
    p.retain(|(k, _)| *k != "redirect_uri");
    p.push(("redirect_uri", "https://evil.example.test/cb"));
    let r = send(&mut store, T0, "GET", &format!("/oauth/authorize?{}", query(&p)), None, vec![]).await;
    assert_eq!(r.status, 400);
}

#[tokio::test]
async fn sign_out_everywhere_ends_every_app_sign_in_and_no_assistant() {
    let mut store = MemStore::default();
    let (phone, phone_refresh) = sign_in(&mut store, T0).await;
    let (other, _) = sign_in(&mut store, T0 + 10).await;
    let assistant = connect_assistant(&mut store).await;
    // The assistant token may not sign the owner out.
    let r = send(&mut store, T0 + 1_000, "POST", "/v1/sessions/revoke", Some(ASSISTANT), vec![]).await;
    assert_eq!((r.status, r.json["error"]["code"].clone()), (403, json!("forbidden")));
    let r = send(&mut store, T0 + 2_000, "POST", "/v1/sessions/revoke", Some(&phone), vec![]).await;
    assert_eq!(r.status, 200, "{}", r.text);
    assert_eq!(r.json["sessionsRevokedBefore"], "2026-09-10T00:26:42Z");
    assert!(r.json["receiptId"].as_str().unwrap().starts_with("aud_"));
    for token in [&phone, &other] {
        let r = send(&mut store, T0 + 3_000, "GET", "/v1/me", Some(token), vec![]).await;
        assert_eq!((r.status, r.json["error"]["code"].clone()), (401, json!("unauthenticated")), "{}", r.text);
    }
    let r = send(&mut store, T0 + 3_000, "POST", "/oauth/token", None, form(&[("grant_type", "refresh_token"), ("refresh_token", &phone_refresh), ("client_id", APP_ID)])).await;
    assert_eq!((r.status, r.json["error"].clone()), (400, json!("invalid_grant")));
    // The connected assistant and the owner token are untouched.
    assert_eq!(mcp_status(&mut store, T0 + 3_000, &assistant).await, 200);
    assert_eq!(send(&mut store, T0 + 3_000, "GET", "/v1/me", Some(OWNER), vec![]).await.status, 200);
    // Signing in again works.
    let (again, _) = sign_in(&mut store, T0 + 4_000).await;
    assert_eq!(send(&mut store, T0 + 5_000, "GET", "/v1/me", Some(&again), vec![]).await.status, 200);
}

#[tokio::test]
async fn the_oldest_app_sign_in_ends_when_one_too_many_signs_in() {
    let mut store = MemStore::default();
    let mut sessions = Vec::new();
    for i in 0..=MAX_APP_SESSIONS as u64 {
        sessions.push(sign_in(&mut store, T0 + i * 1_000).await.0);
    }
    let now = T0 + 60_000;
    let first = send(&mut store, now, "GET", "/v1/me", Some(&sessions[0]), vec![]).await;
    assert_eq!(first.status, 401, "the oldest sign-in was signed out");
    for s in &sessions[1..] {
        assert_eq!(send(&mut store, now, "GET", "/v1/me", Some(s), vec![]).await.status, 200);
    }
}

#[tokio::test]
async fn without_or_after_changing_the_app_configuration_its_sign_ins_do_not_work() {
    let mut store = MemStore::default();
    // Not configured: the app's client ID is an unregistered application.
    let ch = challenge();
    let page = send_with(&mut store, &tokens(None), T0, "GET", &format!("/oauth/authorize?{}", query(&borrowed(&app_params(&ch)))), None, vec![]).await;
    assert!(page.status == 400 && page.text.contains("not registered"), "{}", page.text);
    // A registered-client ID cannot be configured as the app.
    let page = send_with(&mut store, &tokens(Some("cli_0000aaaaaaaaaaaaaaaaaaaaaaaaaaaa")), T0, "GET", "/oauth/authorize?client_id=cli_0000aaaaaaaaaaaaaaaaaaaaaaaaaaaa", None, vec![]).await;
    assert_eq!(page.status, 400);
    // Signed in, then the configured client ID changes: the sign-in no longer works on /v1 or at the token endpoint.
    let (access, refresh) = sign_in(&mut store, T0).await;
    let changed = tokens(Some("garderobe-ios-2"));
    let r = send_with(&mut store, &changed, T0 + 1_000, "GET", "/v1/me", Some(&access), vec![]).await;
    assert_eq!(r.status, 401, "{}", r.text);
    let r = send_with(&mut store, &changed, T0 + 1_000, "POST", "/oauth/token", None, form(&[("grant_type", "refresh_token"), ("refresh_token", &refresh), ("client_id", APP_ID)])).await;
    assert_eq!((r.status, r.json["error"].clone()), (400, json!("invalid_grant")), "{}", r.text);
}

#[tokio::test]
async fn identity_routes_that_need_an_identity_provider_say_so() {
    let mut store = MemStore::default();
    for (path, auth) in [("/auth/claim", None), ("/auth/link/complete", None), ("/auth/recovery/start", None), ("/auth/recovery/complete", None), ("/v1/identities/link", Some(OWNER)), ("/v1/identities/unlink", Some(OWNER)), ("/v1/recovery-kit", Some(OWNER)), ("/v1/account/delete", Some(OWNER))] {
        let r = send(&mut store, T0, "POST", path, auth, b"{}".to_vec()).await;
        assert_eq!((r.status, r.json["error"]["code"].clone(), r.json["error"]["details"]["module"].clone()), (501, json!("module_unavailable"), json!("identity")), "{path}: {}", r.text);
    }
    // The /v1 ones still need a sign-in first.
    assert_eq!(send(&mut store, T0, "POST", "/v1/recovery-kit", None, vec![]).await.status, 401);
    assert!(store.data.is_empty(), "nothing was written");
}
