//! The MCP endpoint and the app's own OAuth, as the Codex plugin uses them:
//! discovery from the 401 challenge, dynamic registration, the owner's
//! consent with PKCE, tokens and their rotation, the tools (read the
//! wardrobe, one routine change with its receipt, and its undo), the refusal
//! of restriction lifts, the read-only step-up, and disconnecting.
//!
//! Most of it runs `api::handle` over an in-memory store with an explicit
//! clock (a test double for the APE binding, so token expiry can be shown);
//! the last test runs the app through its real request queue on the local
//! harness to show the reply headers and content types are served.

use std::collections::BTreeMap;
use std::io;

use ferrite_app::serde_json::{self, json, Value};
use ferrite_app::IngressRequest;
use wardrobe::api::{self, Store, Tokens};
use wardrobe::oauth::{b64url, pct_encode, ACCESS_TTL_MS, CODE_TTL_MS, MAX_CLIENTS, MAX_GRANTS, REFRESH_IDLE_MS};
use wardrobe::sha256::digest;

const ORIGIN: &str = "http://127.0.0.1:8787";
const OWNER: &str = "owner-token-for-tests";
const REDIRECT: &str = "http://127.0.0.1:43123/callback";
const VERIFIER: &str = "verifier-verifier-verifier-verifier-verifier-0001";
const T0: u64 = 1_789_000_000_000;

#[derive(Default)]
struct MemStore {
    data: BTreeMap<Vec<u8>, Vec<u8>>,
    /// Applied just before the first commit guarded on this key, as if
    /// another request committed between this request's read and write.
    interleave: Option<(Vec<u8>, Vec<u8>)>,
}

impl Store for MemStore {
    async fn get(&mut self, key: &[u8]) -> io::Result<Option<Vec<u8>>> {
        Ok(self.data.get(key).cloned())
    }
    async fn commit_n_if(&mut self, guard: &[u8], expected: Option<&[u8]>, entries: &[(&[u8], &[u8])]) -> io::Result<Result<(), Option<Vec<u8>>>> {
        Ok(Self::apply(self, guard, expected, entries))
    }
}

impl MemStore {
    fn count(&self, prefix: &[u8]) -> usize {
        self.data.keys().filter(|k| k.starts_with(prefix)).count()
    }
    fn apply(&mut self, guard: &[u8], expected: Option<&[u8]>, entries: &[(&[u8], &[u8])]) -> Result<(), Option<Vec<u8>>> {
        if let Some((k, v)) = self.interleave.take_if(|(k, _)| k.as_slice() == guard) {
            self.data.insert(k, v);
        }
        let current = self.data.get(guard).cloned();
        if current.as_deref() != expected {
            return Err(current);
        }
        for (k, v) in entries {
            self.data.insert(k.to_vec(), v.to_vec());
        }
        Ok(())
    }
}

fn tokens() -> Tokens {
    Tokens { owner: Some(OWNER.into()), assistant: None, public_origin: Some(ORIGIN.into()) }
}

struct Answer {
    status: u16,
    json: Value,
    text: String,
    headers: Vec<(String, String)>,
}

impl Answer {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

async fn send(store: &mut MemStore, now: u64, method: &str, path: &str, auth: Option<&str>, body: Vec<u8>) -> Answer {
    let mut req = IngressRequest::new(method, path, body);
    if let Some(a) = auth {
        req.headers = vec![("authorization".into(), a.to_string())];
    }
    let reply = api::handle(store, &tokens(), now, &req).await;
    let (_, bytes) = reply.content();
    Answer { status: reply.status, json: serde_json::from_slice(&bytes).unwrap_or(Value::Null), text: String::from_utf8_lossy(&bytes).into_owned(), headers: reply.headers }
}

fn form(pairs: &[(&str, &str)]) -> Vec<u8> {
    pairs.iter().map(|(k, v)| format!("{k}={}", pct_encode(v))).collect::<Vec<_>>().join("&").into_bytes()
}

fn challenge() -> String {
    b64url(&digest(VERIFIER.as_bytes()))
}

async fn register(store: &mut MemStore) -> String {
    let body = json!({"redirect_uris": [REDIRECT], "client_name": "Codex", "token_endpoint_auth_method": "none", "grant_types": ["authorization_code", "refresh_token"]});
    let r = send(store, T0, "POST", "/oauth/register", None, body.to_string().into_bytes()).await;
    assert_eq!(r.status, 201, "{}", r.text);
    r.json["client_id"].as_str().unwrap().to_string()
}

fn authorize_params<'a>(client: &'a str, challenge: &'a str, scope: &'a str) -> Vec<(&'a str, &'a str)> {
    vec![
        ("response_type", "code"),
        ("client_id", client),
        ("redirect_uri", REDIRECT),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
        ("scope", scope),
        ("state", "state-123"),
        ("resource", "http://127.0.0.1:8787/mcp"),
    ]
}

/// Consent as the owner; returns the authorization code.
async fn consent(store: &mut MemStore, client: &str, scope: &str, write: bool) -> String {
    let ch = challenge();
    let mut params = authorize_params(client, &ch, scope);
    params.push(("owner_token", OWNER));
    params.push(("decision", "allow"));
    if write {
        params.push(("write", "on"));
    }
    let r = send(store, T0, "POST", "/oauth/authorize", None, form(&params)).await;
    assert_eq!(r.status, 302, "{}", r.text);
    let location = r.header("location").unwrap().to_string();
    assert!(location.starts_with(&format!("{REDIRECT}?code=wac.")), "{location}");
    assert!(location.contains("&state=state-123") && location.ends_with(&format!("&iss={}", pct_encode(ORIGIN))), "{location}");
    let code = location.split("code=").nth(1).unwrap().split('&').next().unwrap();
    code.to_string()
}

async fn exchange(store: &mut MemStore, client: &str, code: &str, verifier: &str) -> Answer {
    let body = form(&[("grant_type", "authorization_code"), ("code", code), ("redirect_uri", REDIRECT), ("client_id", client), ("code_verifier", verifier), ("resource", "http://127.0.0.1:8787/mcp")]);
    send(store, T0, "POST", "/oauth/token", None, body).await
}

async fn connect(store: &mut MemStore, write: bool) -> (String, Value) {
    let client = register(store).await;
    let code = consent(store, &client, "wardrobe.read wardrobe.write", write).await;
    let t = exchange(store, &client, &code, VERIFIER).await;
    assert_eq!(t.status, 200, "{}", t.text);
    (client, t.json)
}

async fn rpc(store: &mut MemStore, now: u64, access: &str, id: u64, method: &str, params: Value) -> Answer {
    let body = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
    send(store, now, "POST", "/mcp", Some(&format!("Bearer {access}")), body.to_string().into_bytes()).await
}

async fn call(store: &mut MemStore, access: &str, tool: &str, args: Value) -> Value {
    let r = rpc(store, T0 + 1_000, access, 7, "tools/call", json!({"name": tool, "arguments": args})).await;
    assert_eq!(r.status, 200, "{}", r.text);
    r.json["result"].clone()
}

fn error_of(result: &Value) -> Value {
    assert_eq!(result["isError"], true, "{result}");
    serde_json::from_str::<Value>(result["content"][0]["text"].as_str().unwrap()).unwrap()["error"].clone()
}

#[tokio::test]
async fn discovery_starts_from_the_401_challenge() {
    let mut store = MemStore::default();
    let r = send(&mut store, T0, "POST", "/mcp", None, br#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#.to_vec()).await;
    assert_eq!(r.status, 401);
    assert_eq!(r.header("www-authenticate"), Some("Bearer resource_metadata=\"http://127.0.0.1:8787/.well-known/oauth-protected-resource/mcp\", scope=\"wardrobe.read\""));

    let pr = send(&mut store, T0, "GET", "/.well-known/oauth-protected-resource/mcp", None, vec![]).await;
    assert_eq!((pr.status, pr.json["resource"].clone(), pr.json["authorization_servers"].clone()), (200, json!("http://127.0.0.1:8787/mcp"), json!([ORIGIN])));
    let as_meta = send(&mut store, T0, "GET", "/.well-known/oauth-authorization-server", None, vec![]).await;
    assert_eq!(as_meta.json["issuer"], ORIGIN);
    assert_eq!(as_meta.json["registration_endpoint"], "http://127.0.0.1:8787/oauth/register");
    assert_eq!(as_meta.json["code_challenge_methods_supported"], json!(["S256"]));
    assert_eq!(as_meta.json["scopes_supported"], json!(["wardrobe.read", "wardrobe.write"]));

    // A token that is not a grant is told why, with the same discovery pointer.
    let bad = send(&mut store, T0, "POST", "/mcp", Some("Bearer wat.nope"), b"{}".to_vec()).await;
    assert_eq!(bad.status, 401);
    assert!(bad.header("www-authenticate").unwrap().starts_with("Bearer error=\"invalid_token\""));
    // GET opens no stream on this stateless server.
    assert_eq!(send(&mut store, T0, "GET", "/mcp", None, vec![]).await.status, 405);

    // A browser page on another origin is refused before anything else
    // (DNS rebinding); the server's own origin is let through.
    for (o, status) in [("http://evil.example", 403), ("http://127.0.0.1:9999", 403), (ORIGIN, 401)] {
        let mut req = IngressRequest::new("POST", "/mcp", br#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#.to_vec());
        req.headers = vec![("origin".into(), o.into())];
        assert_eq!(api::handle(&mut store, &tokens(), T0, &req).await.status, status, "{o}");
    }
}

#[tokio::test]
async fn registration_and_consent_refuse_what_they_must() {
    let mut store = MemStore::default();
    for body in [json!({"redirect_uris": ["http://evil.example/cb"]}), json!({"redirect_uris": []}), json!({"redirect_uris": [REDIRECT], "token_endpoint_auth_method": "client_secret_basic"})] {
        let r = send(&mut store, T0, "POST", "/oauth/register", None, body.to_string().into_bytes()).await;
        assert_eq!(r.status, 400, "{body}: {}", r.text);
    }
    let client = register(&mut store).await;
    let ch = challenge();

    // The consent page names the application and asks for the owner token.
    let query = String::from_utf8(form(&authorize_params(&client, &ch, "wardrobe.read wardrobe.write"))).unwrap();
    let page = send(&mut store, T0, "GET", &format!("/oauth/authorize?{query}"), None, vec![]).await;
    assert_eq!(page.status, 200);
    assert!(page.text.contains("Connect Codex to Garderobe?") && page.text.contains("name=\"owner_token\"") && page.text.contains("name=\"write\""), "{}", page.text);
    assert!(page.header("content-security-policy").unwrap().contains("frame-ancestors 'none'"));

    // An unregistered redirect is never followed.
    let mut evil = authorize_params(&client, &ch, "wardrobe.read");
    evil[2] = ("redirect_uri", "http://127.0.0.1:9/elsewhere");
    let r = send(&mut store, T0, "GET", &format!("/oauth/authorize?{}", String::from_utf8(form(&evil)).unwrap()), None, vec![]).await;
    assert_eq!((r.status, r.header("location")), (400, None));
    // No PKCE: back to the client with an error.
    let mut plain = authorize_params(&client, &ch, "wardrobe.read");
    plain[4] = ("code_challenge_method", "plain");
    let r = send(&mut store, T0, "GET", &format!("/oauth/authorize?{}", String::from_utf8(form(&plain)).unwrap()), None, vec![]).await;
    assert_eq!(r.status, 302);
    assert!(r.header("location").unwrap().starts_with(&format!("{REDIRECT}?error=invalid_request")));

    // A wrong owner token grants nothing and redirects nowhere.
    let mut wrong = authorize_params(&client, &ch, "wardrobe.read");
    wrong.push(("owner_token", "guess"));
    wrong.push(("decision", "allow"));
    let r = send(&mut store, T0, "POST", "/oauth/authorize", None, form(&wrong)).await;
    assert_eq!((r.status, r.header("location")), (401, None));
    // Deny goes back to the client as access_denied.
    let mut deny = authorize_params(&client, &ch, "wardrobe.read");
    deny.push(("decision", "deny"));
    let r = send(&mut store, T0, "POST", "/oauth/authorize", None, form(&deny)).await;
    assert!(r.header("location").unwrap().starts_with(&format!("{REDIRECT}?error=access_denied")));
    // Nothing was granted by any of that.
    let list = send(&mut store, T0, "GET", "/v1/connections", Some(&format!("Bearer {OWNER}")), vec![]).await;
    assert_eq!(list.json["connections"], json!([]));
}

#[tokio::test]
async fn the_codex_flow_reads_writes_with_a_receipt_and_undoes() {
    let mut store = MemStore::default();
    let (client, tokens) = connect(&mut store, true).await;
    assert_eq!(tokens["scope"], "wardrobe.read wardrobe.write");
    assert_eq!(tokens["expires_in"], 900);
    let access = tokens["access_token"].as_str().unwrap().to_string();

    let init = rpc(&mut store, T0, &access, 1, "initialize", json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "codex", "version": "0"}})).await;
    assert_eq!(init.json["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(init.json["result"]["serverInfo"]["name"], "garderobe");
    let note = send(&mut store, T0, "POST", "/mcp", Some(&format!("Bearer {access}")), br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.to_vec()).await;
    assert_eq!(note.status, 202);
    let list = rpc(&mut store, T0, &access, 2, "tools/list", json!({})).await;
    let names: Vec<&str> = list.json["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["garderobe_inventory", "garderobe_command"]);

    // Reads: the complete inventory, and a page that says it is not the whole.
    let snapshot = call(&mut store, &access, "garderobe_inventory", json!({"view": "snapshot"})).await;
    let s = &snapshot["structuredContent"];
    assert_eq!((s["complete"].clone(), s["total"].clone(), s["data"]["items"].as_array().unwrap().len()), (json!(true), json!(127), 127));
    assert_eq!(s["data"]["counts"]["ownedUnits"], 144);
    let page = call(&mut store, &access, "garderobe_inventory", json!({"view": "items", "limit": 100})).await;
    assert_eq!((page["structuredContent"]["complete"].clone(), page["structuredContent"]["nextCursor"].clone()), (json!(false), json!("100")));
    let last = call(&mut store, &access, "garderobe_inventory", json!({"view": "items", "limit": 100, "cursor": "100"})).await;
    assert_eq!(last["structuredContent"]["data"]["items"].as_array().unwrap().len(), 27);
    assert_eq!((last["structuredContent"]["complete"].clone(), last["structuredContent"]["nextCursor"].clone()), (json!(false), Value::Null));
    let unported = call(&mut store, &access, "garderobe_inventory", json!({"view": "availability"})).await;
    assert_eq!(error_of(&unported)["code"], "invalid_command");

    // A restriction lift is refused before anything is looked up, and nothing is written.
    let lift = call(&mut store, &access, "garderobe_command", json!({"type": "restriction.resolve", "payload": {"restrictionId": "rst_not_a_restriction"}, "idempotencyKey": "codex-lift-0001"})).await;
    let e = error_of(&lift);
    assert_eq!((e["code"].clone(), e["details"]["reason"].clone()), (json!("forbidden"), json!("restriction_lift_not_relayed")));

    // One routine change, the owner's wash report: applied at once with a receipt.
    let shirt = s["data"]["items"].as_array().unwrap().iter().find(|i| i["careChannel"] == "service" && i["quantity"] == 1).unwrap()["garmentId"].as_str().unwrap().to_string();
    let dirty = call(&mut store, &access, "garderobe_command", json!({"type": "care.mark_dirty", "payload": {"items": [{"garmentId": shirt}]}, "idempotencyKey": "codex-dirty-0001"})).await;
    let receipt = dirty["structuredContent"]["receipt"].clone();
    assert_eq!((receipt["actor"].clone(), receipt["channel"].clone(), receipt["outcome"].clone()), (json!("assistant"), json!("mcp"), json!("committed")));
    assert_eq!(receipt["undo"]["available"], true);
    assert!(dirty["content"][0]["text"].as_str().unwrap().starts_with("Recorded: In the wash: "));
    let again = call(&mut store, &access, "garderobe_command", json!({"type": "care.mark_dirty", "payload": {"items": [{"garmentId": shirt}]}, "idempotencyKey": "codex-dirty-0001"})).await;
    assert_eq!(again["structuredContent"]["receipt"]["replayed"], true);

    // Its undo, with its own receipt; a second undo is refused.
    let undo = call(&mut store, &access, "garderobe_command", json!({"type": "command.undo", "payload": {"commandId": receipt["commandId"]}, "idempotencyKey": "codex-undo-0001"})).await;
    assert_eq!(undo["structuredContent"]["receipt"]["result"]["undoneCommandId"], receipt["commandId"]);
    let twice = call(&mut store, &access, "garderobe_command", json!({"type": "command.undo", "payload": {"commandId": receipt["commandId"]}, "idempotencyKey": "codex-undo-0002"})).await;
    assert_eq!(error_of(&twice)["code"], "not_undoable");
    let snap = call(&mut store, &access, "garderobe_inventory", json!({"view": "snapshot"})).await;
    let item = snap["structuredContent"]["data"]["items"].as_array().unwrap().iter().find(|i| i["garmentId"] == shirt.as_str()).unwrap().clone();
    assert_eq!(item["balances"], json!({"clean": 1, "dirty": 0}));
    let receipts = call(&mut store, &access, "garderobe_inventory", json!({"view": "receipts"})).await;
    assert_eq!((receipts["structuredContent"]["total"].clone(), receipts["structuredContent"]["complete"].clone()), (json!(2), json!(true)));

    // Refresh rotates. The replaced token stays usable until one of its
    // successors is used, and a retry with it ends no successor.
    let r0 = tokens["refresh_token"].as_str().unwrap().to_string();
    let refresh = |rt: &str| form(&[("grant_type", "refresh_token"), ("refresh_token", rt), ("client_id", &client)]);
    let t1 = send(&mut store, T0 + 2_000, "POST", "/oauth/token", None, refresh(&r0)).await;
    assert_eq!(t1.status, 200, "{}", t1.text);
    let r1 = t1.json["refresh_token"].as_str().unwrap().to_string();
    let t2 = send(&mut store, T0 + 3_000, "POST", "/oauth/token", None, refresh(&r0)).await;
    assert_eq!(t2.status, 200, "a retry with the replaced token: {}", t2.text);
    let r2 = t2.json["refresh_token"].as_str().unwrap().to_string();
    // R1, issued before the retry, still works; using it retires R0 and R2.
    let t3 = send(&mut store, T0 + 4_000, "POST", "/oauth/token", None, refresh(&r1)).await;
    assert_eq!(t3.status, 200, "the earlier successor after a retry: {}", t3.text);
    let (stale_r0, stale_r2) = (r0, r2);
    let r2 = r1;
    // Narrowing on refresh is allowed, widening is not.
    let r3 = form(&[("grant_type", "refresh_token"), ("refresh_token", &r2), ("client_id", &client), ("scope", "wardrobe.admin")]);
    let wide = send(&mut store, T0 + 6_000, "POST", "/oauth/token", None, r3).await;
    assert_eq!((wide.status, wide.json["error"].clone()), (400, json!("invalid_scope")));
    let narrow = form(&[("grant_type", "refresh_token"), ("refresh_token", &r2), ("client_id", &client), ("scope", "wardrobe.read")]);
    let read_only = send(&mut store, T0 + 6_000, "POST", "/oauth/token", None, narrow).await;
    assert_eq!((read_only.status, read_only.json["scope"].clone()), (200, json!("wardrobe.read")));
    let ro = read_only.json["access_token"].as_str().unwrap().to_string();
    let ro_list = rpc(&mut store, T0 + 7_000, &ro, 8, "tools/list", json!({})).await;
    assert_eq!(ro_list.json["result"]["tools"].as_array().unwrap().len(), 1);
    // Narrowing is permanent: a later refresh cannot win write back, asked or not.
    let rn = read_only.json["refresh_token"].as_str().unwrap().to_string();
    let back = send(&mut store, T0 + 7_000, "POST", "/oauth/token", None, form(&[("grant_type", "refresh_token"), ("refresh_token", &rn), ("client_id", &client), ("scope", "wardrobe.read wardrobe.write")])).await;
    assert_eq!((back.status, back.json["error"].clone()), (400, json!("invalid_scope")));
    let plain = send(&mut store, T0 + 7_000, "POST", "/oauth/token", None, refresh(&rn)).await;
    assert_eq!((plain.status, plain.json["scope"].clone()), (200, json!("wardrobe.read")));
    // The write-scoped access token issued before narrowing is held to read too.
    let early_write = t3.json["access_token"].as_str().unwrap();
    let r = rpc(&mut store, T0 + 7_000, early_write, 8, "tools/list", json!({})).await;
    assert_eq!(r.json["result"]["tools"].as_array().unwrap().len(), 1);

    // An access token expires after 15 minutes. (The first access token is
    // already gone: a grant keeps at most four, and five were issued.)
    assert_eq!(rpc(&mut store, T0 + 7_000, &access, 9, "ping", json!({})).await.status, 401);
    assert_eq!(rpc(&mut store, T0 + 6_000 + ACCESS_TTL_MS - 1, &ro, 9, "ping", json!({})).await.status, 200);
    let late = rpc(&mut store, T0 + 6_000 + ACCESS_TTL_MS + 1, &ro, 9, "ping", json!({})).await;
    assert_eq!(late.status, 401);
    assert!(late.header("www-authenticate").unwrap().contains("expired"));

    // A superseded refresh token presented again is a replay: the grant and
    // everything it issued end, the newest refresh token included.
    let newest = plain.json["refresh_token"].as_str().unwrap().to_string();
    let t4 = send(&mut store, T0 + 8_000, "POST", "/oauth/token", None, refresh(&newest)).await;
    assert_eq!(t4.status, 200, "{}", t4.text);
    let fresh = t4.json["access_token"].as_str().unwrap().to_string();
    let r4 = t4.json["refresh_token"].as_str().unwrap().to_string();
    let replay = send(&mut store, T0 + 9_000, "POST", "/oauth/token", None, refresh(&stale_r2)).await;
    assert_eq!((replay.status, replay.json["error"].clone()), (400, json!("invalid_grant")));
    assert_eq!(rpc(&mut store, T0 + 9_000, &fresh, 10, "ping", json!({})).await.status, 401);
    for gone in [&r4, &stale_r0] {
        let t = send(&mut store, T0 + 9_000, "POST", "/oauth/token", None, refresh(gone)).await;
        assert_eq!((t.status, t.json["error"].clone()), (400, json!("invalid_grant")));
    }
    let owner = format!("Bearer {OWNER}");
    let list = send(&mut store, T0 + 9_000, "GET", "/v1/connections", Some(&owner), vec![]).await;
    assert_eq!(list.json["connections"][0]["status"], "revoked");
}

#[tokio::test]
async fn a_read_only_connection_is_not_offered_the_write_tool_and_is_stepped_up() {
    let mut store = MemStore::default();
    let (_, tokens) = connect(&mut store, false).await;
    assert_eq!(tokens["scope"], "wardrobe.read");
    let access = tokens["access_token"].as_str().unwrap();
    let list = rpc(&mut store, T0, access, 1, "tools/list", json!({})).await;
    assert_eq!(list.json["result"]["tools"].as_array().unwrap().len(), 1);
    let r = rpc(&mut store, T0, access, 2, "tools/call", json!({"name": "garderobe_command", "arguments": {"type": "care.mark_dirty", "payload": {}, "idempotencyKey": "codex-ro-0001"}})).await;
    assert_eq!(r.status, 403);
    assert!(r.header("www-authenticate").unwrap().starts_with("Bearer error=\"insufficient_scope\", scope=\"wardrobe.read wardrobe.write\""));
}

#[tokio::test]
async fn codes_are_bound_to_pkce_and_a_replayed_code_ends_the_grant() {
    let mut store = MemStore::default();
    let client = register(&mut store).await;
    let code = consent(&mut store, &client, "wardrobe.read", false).await;
    let wrong = exchange(&mut store, &client, &code, "another-verifier-another-verifier-another-0002").await;
    assert_eq!((wrong.status, wrong.json["error"].clone()), (400, json!("invalid_grant")));
    let first = exchange(&mut store, &client, &code, VERIFIER).await;
    assert_eq!(first.status, 200);
    let access = first.json["access_token"].as_str().unwrap().to_string();
    assert_eq!(rpc(&mut store, T0, &access, 1, "ping", json!({})).await.status, 200);

    // Presenting the spent code again, even with its verifier, ends the grant
    // and the tokens it issued; the client connects again.
    let retry = exchange(&mut store, &client, &code, VERIFIER).await;
    assert_eq!((retry.status, retry.json["error"].clone()), (400, json!("invalid_grant")));
    assert_eq!(rpc(&mut store, T0, &access, 2, "ping", json!({})).await.status, 401);
    let owner = format!("Bearer {OWNER}");
    let list = send(&mut store, T0, "GET", "/v1/connections", Some(&owner), vec![]).await;
    assert_eq!(list.json["connections"][0]["status"], "revoked");

    // Without the verifier too.
    let code = consent(&mut store, &client, "wardrobe.read", false).await;
    let first = exchange(&mut store, &client, &code, VERIFIER).await;
    let access2 = first.json["access_token"].as_str().unwrap().to_string();
    assert_eq!(rpc(&mut store, T0, &access2, 3, "ping", json!({})).await.status, 200);
    let stolen = exchange(&mut store, &client, &code, "").await;
    assert_eq!(stolen.status, 400);
    assert_eq!(rpc(&mut store, T0, &access2, 4, "ping", json!({})).await.status, 401);
}

#[tokio::test]
async fn registrations_are_bounded_and_pruned_slots_are_reused() {
    let mut store = MemStore::default();
    let body = json!({"redirect_uris": [REDIRECT], "client_name": "Flood"}).to_string().into_bytes();
    let mut first = String::new();
    for i in 0..MAX_CLIENTS {
        let r = send(&mut store, T0, "POST", "/oauth/register", None, body.clone()).await;
        assert_eq!(r.status, 201);
        if i == 0 {
            first = r.json["client_id"].as_str().unwrap().to_string();
        }
    }
    // A flood within the hour is refused rather than stored.
    let refused = send(&mut store, T0 + 1_000, "POST", "/oauth/register", None, body.clone()).await;
    assert_eq!(refused.status, 429, "{}", refused.text);
    assert_eq!(store.count(b"o/client/"), MAX_CLIENTS);
    // After an hour the oldest make room; storage stays at the same records.
    for i in 0..5 {
        assert_eq!(send(&mut store, T0 + 3_600_001 + i, "POST", "/oauth/register", None, body.clone()).await.status, 201);
    }
    assert_eq!(store.count(b"o/client/"), MAX_CLIENTS);
    // A pruned registration, whose slot is reused, starts nothing.
    let ch = challenge();
    let page = send(&mut store, T0 + 3_700_000, "GET", &format!("/oauth/authorize?{}", String::from_utf8(form(&authorize_params(&first, &ch, "wardrobe.read"))).unwrap()), None, vec![]).await;
    assert_eq!(page.status, 400, "{}", page.text);
}

#[tokio::test]
async fn pruning_never_overwrites_a_grant_that_became_live_meanwhile() {
    let mut store = MemStore::default();
    let owner = format!("Bearer {OWNER}");
    let client = register(&mut store).await;
    for _ in 0..MAX_GRANTS {
        consent(&mut store, &client, "wardrobe.read", false).await;
    }
    let later = T0 + CODE_TTL_MS + 1;
    // Slot 0's grant is exchanged by a request that read it before the code
    // expired and commits while the pruning is under way.
    let mut live: Value = serde_json::from_slice(&store.data[b"o/grant/0".as_slice()]).unwrap();
    live["code"]["used"] = json!(true);
    live["refresh"] = json!({"current": ["h"], "previous": null, "retired": [], "lastUsedAt": later});
    live["version"] = json!(2);
    store.interleave = Some((b"o/grant/0".to_vec(), live.to_string().into_bytes()));

    let ch = challenge();
    let mut params = authorize_params(&client, &ch, "wardrobe.read");
    params.extend([("owner_token", OWNER), ("decision", "allow")]);
    let fits = send(&mut store, later, "POST", "/oauth/authorize", None, form(&params)).await;
    assert_eq!(fits.status, 302, "{}", fits.text);
    assert!(store.interleave.is_none(), "the competing write happened");
    let kept: Value = serde_json::from_slice(&store.data[b"o/grant/0".as_slice()]).unwrap();
    assert_eq!((kept["status"].clone(), kept["refresh"]["current"].clone()), (json!("active"), json!(["h"])), "{kept}");
    let list = send(&mut store, later, "GET", "/v1/connections", Some(&owner), vec![]).await;
    let statuses: Vec<&str> = list.json["connections"].as_array().unwrap().iter().map(|c| c["status"].as_str().unwrap()).collect();
    assert_eq!(statuses, vec!["active", "active"], "the live grant and the new one");
}

#[tokio::test]
async fn expired_authorizations_hold_no_place_and_are_shown_as_expired() {
    let mut store = MemStore::default();
    let owner = format!("Bearer {OWNER}");
    // One real connection whose refresh token then sits idle.
    let (_, _) = connect(&mut store, false).await;
    let client = register(&mut store).await;
    // Fill the remaining places with consents whose codes are never exchanged.
    for _ in 1..MAX_GRANTS {
        consent(&mut store, &client, "wardrobe.read", false).await;
    }
    let ch = challenge();
    let mut params = authorize_params(&client, &ch, "wardrobe.read");
    params.extend([("owner_token", OWNER), ("decision", "allow")]);
    let full = send(&mut store, T0, "POST", "/oauth/authorize", None, form(&params)).await;
    assert_eq!(full.status, 409, "{}", full.text);

    // Once the codes expire unused they are expired, and a new consent fits.
    let later = T0 + CODE_TTL_MS + 1;
    let list = send(&mut store, later, "GET", "/v1/connections", Some(&owner), vec![]).await;
    let statuses: Vec<&str> = list.json["connections"].as_array().unwrap().iter().map(|c| c["status"].as_str().unwrap()).collect();
    assert_eq!(statuses.len(), MAX_GRANTS);
    assert_eq!(statuses.iter().filter(|s| **s == "expired").count(), MAX_GRANTS - 1);
    assert_eq!(statuses.iter().filter(|s| **s == "active").count(), 1);
    let fits = send(&mut store, later, "POST", "/oauth/authorize", None, form(&params)).await;
    assert_eq!(fits.status, 302, "{}", fits.text);
    let list = send(&mut store, later, "GET", "/v1/connections", Some(&owner), vec![]).await;
    assert_eq!(list.json["connections"].as_array().unwrap().len(), 2, "expired grants leave the index");
    assert_eq!(store.count(b"o/grant/"), MAX_GRANTS, "the new grant reused a freed slot");

    // A refresh token idle for 90 days: the connection is shown as expired.
    let idle = T0 + REFRESH_IDLE_MS + 1;
    let list = send(&mut store, idle, "GET", "/v1/connections", Some(&owner), vec![]).await;
    assert!(list.json["connections"].as_array().unwrap().iter().all(|c| c["status"] == "expired"), "{}", list.text);
}

#[tokio::test]
async fn the_owner_disconnects_and_the_next_request_is_refused() {
    let mut store = MemStore::default();
    let (client, tokens) = connect(&mut store, true).await;
    let access = tokens["access_token"].as_str().unwrap();
    let owner = format!("Bearer {OWNER}");
    let list = send(&mut store, T0, "GET", "/v1/connections", Some(&owner), vec![]).await;
    let c = list.json["connections"][0].clone();
    assert_eq!((c["clientName"].clone(), c["access"].clone(), c["status"].clone(), c["redirectHost"].clone()), (json!("Codex"), json!("read_write"), json!("active"), json!("127.0.0.1:43123")));
    assert!(!list.text.contains("hash"), "{}", list.text);
    let grant = c["grantId"].as_str().unwrap();

    let gone = send(&mut store, T0, "POST", &format!("/v1/connections/{grant}/disconnect"), Some(&owner), vec![]).await;
    assert_eq!((gone.status, gone.json["connection"]["status"].clone()), (200, json!("revoked")));
    // Malformed disconnect paths are not found, never a crash.
    for bad in ["/v1/connections/disconnect", "/v1/connections//disconnect", "/v1/connections/a/b/disconnect"] {
        assert_eq!(send(&mut store, T0, "POST", bad, Some(&owner), vec![]).await.status, 404, "{bad}");
    }
    let r = rpc(&mut store, T0, access, 1, "ping", json!({})).await;
    assert_eq!(r.status, 401);
    let rt = tokens["refresh_token"].as_str().unwrap();
    let t = send(&mut store, T0, "POST", "/oauth/token", None, form(&[("grant_type", "refresh_token"), ("refresh_token", rt), ("client_id", &client)])).await;
    assert_eq!(t.status, 400);

    // Revocation by the client ends the grant too.
    let (client, tokens) = connect(&mut store, false).await;
    let rt = tokens["refresh_token"].as_str().unwrap();
    assert_eq!(send(&mut store, T0, "POST", "/oauth/revoke", None, form(&[("token", rt), ("client_id", &client)])).await.status, 200);
    assert_eq!(rpc(&mut store, T0, tokens["access_token"].as_str().unwrap(), 1, "ping", json!({})).await.status, 401);
}

#[tokio::test]
async fn without_a_public_origin_the_endpoints_say_which_secret_is_missing() {
    let mut store = MemStore::default();
    for origin in [None, Some("http://wardrobe.example".to_string())] {
        let t = Tokens { owner: Some(OWNER.into()), assistant: None, public_origin: origin };
        let reply = api::handle(&mut store, &t, T0, &IngressRequest::new("GET", "/.well-known/oauth-authorization-server", vec![])).await;
        assert_eq!(reply.status, 500);
        assert!(reply.body["error"]["message"].as_str().unwrap().contains("WARDROBE_PUBLIC_ORIGIN"));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_app_serves_challenges_and_pages_through_its_request_queue() {
    use ferrite_app_test::{ingress, TestHarness};
    let env = TestHarness::new().with_queue("requests").with_queue("replies").with_ape("state").build().await;
    env.run_app(|ctx| async move { wardrobe::serve(ctx, tokens()).await });
    let unauth = env.handle(ingress::request("POST", "/mcp", "", b"{}".to_vec())).await.expect("a reply");
    assert_eq!(unauth.status, 401);
    assert!(unauth.headers.iter().any(|(k, v)| k == "www-authenticate" && v.contains("resource_metadata=")), "{:?}", unauth.headers);
    let meta = env.handle(ingress::get("/.well-known/oauth-protected-resource/mcp")).await.expect("a reply");
    assert_eq!(serde_json::from_slice::<Value>(&meta.body).unwrap()["resource"], "http://127.0.0.1:8787/mcp");
    let page = env.handle(ingress::get("/oauth/authorize?client_id=cli_unknown")).await.expect("a reply");
    assert_eq!(page.status, 400);
    assert!(page.headers.iter().any(|(k, v)| k == "content-type" && v.starts_with("text/html")), "{:?}", page.headers);
}
