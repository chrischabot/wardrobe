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
use wardrobe::oauth::{b64url, pct_encode, ACCESS_TTL_MS, MAX_CLIENTS, MAX_GRANTS, MAX_SUCCESSORS, PREVIOUS_RETRY_MS, CONSENT_FORM_TTL_MS, CLOCK_SKEW_MS, GRANTS_EPOCH_KEY, consent_form_mac, REFRESH_IDLE_MS};
use wardrobe::sha256::digest;

const ORIGIN: &str = "http://127.0.0.1:8787";
const OWNER: &str = "owner-token-for-tests";
const REDIRECT: &str = "http://127.0.0.1:43123/callback";
const VERIFIER: &str = "verifier-verifier-verifier-verifier-verifier-0001";
const T0: u64 = 1_789_000_000_000;

#[derive(Default, Clone)]
struct MemStore {
    data: BTreeMap<Vec<u8>, Vec<u8>>,
    /// Applied just before the first commit guarded on this key, as if
    /// another request committed these records between this request's read
    /// and write.
    interleave: Option<(Vec<u8>, Vec<(Vec<u8>, Vec<u8>)>)>,
    /// After this many reads of the ledger, these records replace the store's, as if another request
    /// committed between two of this request's reads.
    swap_after_ledger_reads: Option<(usize, BTreeMap<Vec<u8>, Vec<u8>>)>,
}

impl Store for MemStore {
    async fn get(&mut self, key: &[u8]) -> io::Result<Option<Vec<u8>>> {
        if key == b"ledger" {
            match self.swap_after_ledger_reads.take() {
                Some((0, records)) => self.data = records,
                Some((n, records)) => self.swap_after_ledger_reads = Some((n - 1, records)),
                None => {}
            }
        }
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
    fn same_records(&self, other: &MemStore) -> bool {
        self.data == other.data
    }
    /// The records `self` holds that `before` does not hold identically.
    fn changes_since(&self, before: &MemStore) -> Vec<(Vec<u8>, Vec<u8>)> {
        self.data.iter().filter(|(k, v)| before.data.get(*k) != Some(*v)).map(|(k, v)| (k.clone(), v.clone())).collect()
    }
    fn apply(&mut self, guard: &[u8], expected: Option<&[u8]>, entries: &[(&[u8], &[u8])]) -> Result<(), Option<Vec<u8>>> {
        if let Some((_, records)) = self.interleave.take_if(|(k, _)| k.as_slice() == guard) {
            self.data.extend(records);
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
    Tokens { owner: Some(OWNER.into()), assistant: None, public_origin: Some(ORIGIN.into()), ..Default::default() }
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

/// Every request gets its own correlation ID, as the gateway assigns one;
/// `send_as` reuses one to model the queue redelivering an envelope.
async fn send(store: &mut MemStore, now: u64, method: &str, path: &str, auth: Option<&str>, body: Vec<u8>) -> Answer {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let id = format!("corr-{}", NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    send_as(store, now, method, path, auth, body, &id).await
}

async fn send_as(store: &mut MemStore, now: u64, method: &str, path: &str, auth: Option<&str>, body: Vec<u8>, correlation: &str) -> Answer {
    let mut req = IngressRequest::new(method, path, body);
    req.correlation_id = correlation.to_string();
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

/// A consent form as the page served at `issued` would submit it: the
/// authorize parameters, the owner's choices, and the signed issue time.
fn signed(params: &[(&str, &str)], issued: u64) -> Vec<u8> {
    let get = |k: &str| params.iter().find(|(n, _)| *n == k).map(|(_, v)| *v).unwrap();
    let mac = consent_form_mac(OWNER, issued, get("client_id"), get("redirect_uri"), get("code_challenge"));
    let issued = issued.to_string();
    let mut all = params.to_vec();
    all.extend([("issued", issued.as_str()), ("form_mac", mac.as_str())]);
    form(&all)
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
    let r = send(store, T0, "POST", "/oauth/authorize", None, signed(&params, T0)).await;
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
    assert!(page.text.contains(&format!("name=\"issued\" value=\"{T0}\"")) && page.text.contains(&consent_form_mac(OWNER, T0, &client, REDIRECT, &ch)), "the page carries its signed issue time");
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
    let r = send(&mut store, T0, "POST", "/oauth/authorize", None, signed(&wrong, T0)).await;
    assert_eq!((r.status, r.header("location")), (401, None));
    // A form that is unsigned, signed for another flow, or past its
    // lifetime grants nothing either, even with the right owner token.
    let mut right = authorize_params(&client, &ch, "wardrobe.read");
    right.extend([("owner_token", OWNER), ("decision", "allow")]);
    let other = challenge().replace('A', "B") + "x";
    let mut cross = form(&right);
    cross.extend(format!("&issued={T0}&form_mac={}", consent_form_mac(OWNER, T0, &client, REDIRECT, &other)).into_bytes());
    for (what, body, at) in [("unsigned", form(&right), T0), ("another flow", cross, T0), ("expired", signed(&right, T0), T0 + CONSENT_FORM_TTL_MS + 1), ("from the future", signed(&right, T0 + CLOCK_SKEW_MS + 1), T0)] {
        let r = send(&mut store, at, "POST", "/oauth/authorize", None, body).await;
        assert_eq!((r.status, r.header("location")), (400, None), "{what}: {}", r.text);
        assert!(r.text.contains("This page expired"), "{what}");
    }
    // Deny goes back to the client as access_denied.
    let mut deny = authorize_params(&client, &ch, "wardrobe.read");
    deny.push(("decision", "deny"));
    let r = send(&mut store, T0, "POST", "/oauth/authorize", None, form(&deny)).await;
    assert!(r.header("location").unwrap().starts_with(&format!("{REDIRECT}?error=access_denied")));
    // Nothing was granted by any of that.
    let list = send(&mut store, T0, "GET", "/v1/assistants", Some(&format!("Bearer {OWNER}")), vec![]).await;
    assert_eq!(list.json["grants"], json!([]));
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
    // A response to a server request is accepted; a message with neither a method nor a response's
    // shape (no id, both or neither of result and error, a stray key, a non-string method) is refused.
    let bearer = format!("Bearer {access}");
    let reply = send(&mut store, T0, "POST", "/mcp", Some(&bearer), br#"{"jsonrpc":"2.0","id":7,"result":{}}"#.to_vec()).await;
    assert_eq!(reply.status, 202);
    for ok in [
        r#"{"jsonrpc":"2.0","id":"a","error":{"code":-32601,"message":"no such method"}}"#,
        r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error","data":{}}}"#,
        r#"{"jsonrpc":"2.0","id":8,"error":{"code":9223372036854775808,"message":"large"}}"#,
    ] {
        let r = send(&mut store, T0, "POST", "/mcp", Some(&bearer), ok.as_bytes().to_vec()).await;
        assert_eq!(r.status, 202, "{ok}");
    }
    for bad in [
        r#"{"jsonrpc":"2.0","id":7,"error":null}"#,
        r#"{"jsonrpc":"2.0","id":7,"error":{}}"#,
        r#"{"jsonrpc":"2.0","id":7,"error":{"code":1.5,"message":"x"}}"#,
        r#"{"jsonrpc":"2.0","id":7,"error":{"code":1,"message":"x","extra":1}}"#,
        r#"{"jsonrpc":"2.0","id":null,"result":{}}"#,
        r#"{"jsonrpc":"2.0","id":7}"#,
        r#"{"jsonrpc":"2.0"}"#,
        r#"{"jsonrpc":"2.0","id":7,"result":{},"error":{}}"#,
        r#"{"jsonrpc":"2.0","result":{}}"#,
        r#"{"jsonrpc":"2.0","id":7,"result":{},"params":{}}"#,
        r#"{"jsonrpc":"2.0","id":7,"method":42}"#,
    ] {
        let r = send(&mut store, T0, "POST", "/mcp", Some(&bearer), bad.as_bytes().to_vec()).await;
        assert_eq!((r.status, r.json["error"]["code"].clone()), (400, json!(-32600)), "{bad}");
    }
    let list = rpc(&mut store, T0, &access, 2, "tools/list", json!({})).await;
    let names: Vec<&str> = list.json["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["garderobe_today", "garderobe_recommend", "garderobe_inventory", "garderobe_run", "garderobe_ask", "garderobe_research", "garderobe_command"]);

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
    let avail = call(&mut store, &access, "garderobe_inventory", json!({"view": "availability", "date": "2026-10-13"})).await;
    let a = &avail["structuredContent"];
    assert_eq!((a["total"].clone(), a["data"]["forDate"].clone(), a["data"]["modelVersion"].clone()), (json!(127), json!("2026-10-13"), json!("availability-estimator/1.0.0")));
    assert!(avail["content"][0]["text"].as_str().unwrap().contains("parameters are hypotheses"));
    let resolved = call(&mut store, &access, "garderobe_inventory", json!({"view": "resolve", "phrase": "PCF4339"})).await;
    assert_eq!(resolved["structuredContent"]["data"]["matches"][0]["garmentId"], "gmt_3894b6a6295908d5e687af4f");
    assert!(resolved["content"][0]["text"].as_str().unwrap().starts_with("\"PCF4339\" is Lightweight oxford — blue"));
    let ambiguous = call(&mut store, &access, "garderobe_inventory", json!({"view": "resolve", "phrase": "lightweight oxford"})).await;
    assert!(ambiguous["content"][0]["text"].as_str().unwrap().contains("ask which one"));
    let socks = call(&mut store, &access, "garderobe_inventory", json!({"view": "selection", "selector": {"category": "socks"}})).await;
    assert_eq!((socks["structuredContent"]["total"].clone(), socks["structuredContent"]["data"]["count"].clone()), (json!(15), json!(15)));
    let stray = call(&mut store, &access, "garderobe_inventory", json!({"view": "items", "phrase": "blue"})).await;
    assert_eq!(error_of(&stray)["code"], "invalid_command");
    let unported = call(&mut store, &access, "garderobe_inventory", json!({"view": "item"})).await;
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
    assert_eq!(item["balances"], json!({"clean": 1, "dirty": 0, "service": 0, "trip": 0}));
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
    assert_eq!(ro_list.json["result"]["tools"].as_array().unwrap().len(), 6, "the read tools, not the write tool");
    // Narrowing is permanent: a later refresh cannot win write back, asked or not.
    let rn = read_only.json["refresh_token"].as_str().unwrap().to_string();
    let back = send(&mut store, T0 + 7_000, "POST", "/oauth/token", None, form(&[("grant_type", "refresh_token"), ("refresh_token", &rn), ("client_id", &client), ("scope", "wardrobe.read wardrobe.write")])).await;
    assert_eq!((back.status, back.json["error"].clone()), (400, json!("invalid_scope")));
    let plain = send(&mut store, T0 + 7_000, "POST", "/oauth/token", None, refresh(&rn)).await;
    assert_eq!((plain.status, plain.json["scope"].clone()), (200, json!("wardrobe.read")));
    // The write-scoped access token issued before narrowing is held to read too.
    let early_write = t3.json["access_token"].as_str().unwrap();
    let r = rpc(&mut store, T0 + 7_000, early_write, 8, "tools/list", json!({})).await;
    assert_eq!(r.json["result"]["tools"].as_array().unwrap().len(), 6);

    // An access token expires after 15 minutes.
    assert_eq!(rpc(&mut store, T0 + 7_000, &access, 9, "ping", json!({})).await.status, 200, "the first access token is still kept");
    assert_eq!(rpc(&mut store, T0 + ACCESS_TTL_MS + 1, &access, 9, "ping", json!({})).await.status, 401);
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
    let list = send(&mut store, T0 + 9_000, "GET", "/v1/assistants", Some(&owner), vec![]).await;
    assert_eq!(list.json["grants"][0]["status"], "revoked");
}

#[tokio::test]
async fn the_inventory_views_and_resources_are_the_landed_reads_in_the_mcp_envelope() {
    let mut store = MemStore::default();
    // A read-only grant may read every view and resource.
    let (_, tokens) = connect(&mut store, false).await;
    let access = tokens["access_token"].as_str().unwrap().to_string();
    let owner = format!("Bearer {OWNER}");
    let now = T0 + 1_000; // the time `call` reads at, so `readAt` agrees
    // Something behind the views, recorded by the owner in the app: a wash report, a trip and an exchange.
    let shirt = "gmt_3894b6a6295908d5e687af4f";
    let trip = json!({
        "tripId": "trp_lisbon", "name": "Lisbon", "departsOn": "2026-10-20", "returnsOn": "2026-10-23",
        "destinations": [{"label": "Lisbon", "latitude": 38.7223, "longitude": -9.1393, "timezone": "Europe/Lisbon", "from": "2026-10-20", "to": "2026-10-23"}],
        "source": {"kind": "owner_statement"},
    });
    for (key, kind, payload) in [
        ("mcp-views-dirty-1", "care.mark_dirty", json!({"items": [{"garmentId": shirt}]})),
        ("mcp-views-trip-1", "trip.create", trip),
        ("mcp-views-return-1", "return.open_case", json!({"kind": "exchange", "garmentId": "gmt_14bc4338d6760f6a13434b2f", "timezone": "UTC"})),
    ] {
        let envelope = json!({"type": kind, "payload": payload, "idempotencyKey": key, "authorization": "owner_tap", "source": {"channel": "ios"}});
        let r = send(&mut store, now, "POST", "/v1/commands", Some(&owner), envelope.to_string().into_bytes()).await;
        assert_eq!(r.status, 200, "{kind}: {}", r.text);
    }

    // Each view's data is exactly what its REST route serves, in the envelope, as the whole result.
    for (view, path, total) in [
        ("laundry", "/v1/laundry", Value::Null),
        ("style", "/v1/style", Value::Null),
        ("command_types", "/v1/command-types", json!(20)),
        ("trips", "/v1/trips", json!(1)),
        ("returns", "/v1/returns", json!(1)),
        ("orders", "/v1/orders", json!(0)),
    ] {
        let rest = send(&mut store, now, "GET", path, Some(&owner), Vec::new()).await;
        assert_eq!(rest.status, 200, "{path}: {}", rest.text);
        let r = call(&mut store, &access, "garderobe_inventory", json!({"view": view})).await;
        let s = &r["structuredContent"];
        assert_eq!(s["data"], rest.json, "{view}");
        assert_eq!(
            (s["view"].clone(), s["complete"].clone(), s["total"].clone(), s["nextCursor"].clone(), s["wardrobeRevision"].clone()),
            (json!(view), json!(true), total, Value::Null, json!(3)),
            "{view}: {s}"
        );
    }
    let text = |r: &Value| r["content"][0]["text"].as_str().unwrap().to_string();
    let laundry = call(&mut store, &access, "garderobe_inventory", json!({"view": "laundry"})).await;
    assert_eq!(laundry["structuredContent"]["data"]["awaitingService"][0]["garmentId"], shirt);
    assert_eq!(text(&laundry), "Awaiting service laundry: 1 item(s); awaiting hand-wash: 0; batches: 0.");
    let style = call(&mut store, &access, "garderobe_inventory", json!({"view": "style", "date": "2026-10-21"})).await;
    assert_eq!(style["structuredContent"]["data"]["rules"].as_array().unwrap().len(), 28);
    assert!(text(&style).starts_with("Style profile version 1 with 0 amendment(s), 28 rule(s), 0 standing direction(s). Precedence:"), "{}", text(&style));
    let trips = call(&mut store, &access, "garderobe_inventory", json!({"view": "trips"})).await;
    assert_eq!((trips["structuredContent"]["data"]["trips"][0]["tripId"].clone(), text(&trips)), (json!("trp_lisbon"), "1 trip(s).".to_string()));
    assert_eq!(text(&call(&mut store, &access, "garderobe_inventory", json!({"view": "returns"})).await), "1 return or exchange case(s).");
    assert_eq!(text(&call(&mut store, &access, "garderobe_inventory", json!({"view": "orders"})).await), "0 order(s).");
    assert!(text(&call(&mut store, &access, "garderobe_inventory", json!({"view": "command_types"})).await).starts_with("20 command types"));

    // A command committed between the view's first ledger read and its data read: the view reads
    // again, so its data and wardrobeRevision belong to the same commit (revision 4, two trips).
    let before = store.data.clone();
    let second = json!({
        "tripId": "trp_porto", "name": "Porto", "departsOn": "2026-11-02", "returnsOn": "2026-11-04",
        "destinations": [{"label": "Porto", "latitude": 41.15, "longitude": -8.61, "timezone": "Europe/Lisbon", "from": "2026-11-02", "to": "2026-11-04"}],
        "source": {"kind": "owner_statement"},
    });
    let envelope = json!({"type": "trip.create", "payload": second, "idempotencyKey": "mcp-views-trip-2", "authorization": "owner_tap", "source": {"channel": "ios"}});
    assert_eq!(send(&mut store, now, "POST", "/v1/commands", Some(&owner), envelope.to_string().into_bytes()).await.status, 200);
    let committed = std::mem::replace(&mut store.data, before);
    store.swap_after_ledger_reads = Some((1, committed));
    let raced = call(&mut store, &access, "garderobe_inventory", json!({"view": "trips"})).await;
    assert!(store.swap_after_ledger_reads.is_none(), "the commit landed between the view's reads");
    let s = &raced["structuredContent"];
    assert_eq!((s["wardrobeRevision"].clone(), s["total"].clone(), s["data"]["trips"].as_array().unwrap().len()), (json!(4), json!(2), 2), "{s}");

    // Arguments that belong to other views are refused, and so is a malformed day.
    for (args, words) in [
        (json!({"view": "trips", "limit": 5}), "view 'trips' takes no other argument, not 'limit'"),
        (json!({"view": "laundry", "date": "2026-10-21"}), "view 'laundry' takes no other argument, not 'date'"),
        (json!({"view": "style", "category": "shirt"}), "view 'style' takes only date, not 'category'"),
        (json!({"view": "style", "date": "2026-02-30"}), "date: expected the day as YYYY-MM-DD"),
        (json!({"view": "style", "date": 20261021}), "date must be a date, YYYY-MM-DD"),
    ] {
        let e = error_of(&call(&mut store, &access, "garderobe_inventory", args.clone()).await);
        assert_eq!((e["code"].clone(), e["message"].as_str().unwrap().contains(words)), (json!("invalid_command"), true), "{args}: {e}");
    }

    // The resources: offered on initialize, listed, and read as the REST routes serve them.
    let init = rpc(&mut store, now, &access, 1, "initialize", json!({"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "codex", "version": "0"}})).await;
    assert_eq!(init.json["result"]["capabilities"]["resources"], json!({"listChanged": false}));
    let list = rpc(&mut store, now, &access, 2, "resources/list", json!({})).await;
    let uris: Vec<&str> = list.json["result"]["resources"].as_array().unwrap().iter().map(|r| r["uri"].as_str().unwrap()).collect();
    assert_eq!(uris, vec!["garderobe://guide", "garderobe://style/profile", "garderobe://commands"]);
    assert_eq!(rpc(&mut store, now, &access, 3, "resources/templates/list", json!({})).await.json["result"], json!({"resourceTemplates": []}));
    let read = |r: &Answer| r.json["result"]["contents"][0].clone();
    let profile = read(&rpc(&mut store, now, &access, 4, "resources/read", json!({"uri": "garderobe://style/profile"})).await);
    let rest_style = send(&mut store, now, "GET", "/v1/style", Some(&owner), Vec::new()).await.json;
    assert_eq!((profile["uri"].clone(), profile["mimeType"].clone()), (json!("garderobe://style/profile"), json!("text/markdown")));
    assert_eq!(profile["text"], rest_style["document"]["content"]);
    assert!(profile["text"].as_str().unwrap().starts_with("# Chris — Taste, Formation, Preferences and Operating Rules"));
    assert_eq!(profile["text"].as_str().unwrap().len() as u64, rest_style["document"]["byteLength"].as_u64().unwrap(), "the whole document, byte for byte");
    let commands = read(&rpc(&mut store, now, &access, 5, "resources/read", json!({"uri": "garderobe://commands"})).await);
    let rest_types = send(&mut store, now, "GET", "/v1/command-types", Some(&owner), Vec::new()).await.json;
    assert_eq!((commands["mimeType"].clone(), serde_json::from_str::<Value>(commands["text"].as_str().unwrap()).unwrap()), (json!("application/json"), rest_types));
    let guide = read(&rpc(&mut store, now, &access, 6, "resources/read", json!({"uri": "garderobe://guide"})).await);
    assert!(guide["text"].as_str().unwrap().contains("laundry, style, command_types, trips, returns, orders"), "{guide}");
    let missing = rpc(&mut store, now, &access, 7, "resources/read", json!({"uri": "garderobe://nothing"})).await;
    assert_eq!((missing.status, missing.json["error"]["code"].clone(), missing.json["error"]["data"]["uri"].clone()), (200, json!(-32002), json!("garderobe://nothing")));
    let no_uri = rpc(&mut store, now, &access, 8, "resources/read", json!({})).await;
    assert_eq!(no_uri.json["error"]["code"], -32602);
}

#[tokio::test]
async fn the_codex_verifier_board_steps_run_over_mcp() {
    let mut store = MemStore::default();
    let (_, tokens) = connect(&mut store, true).await;
    let access = tokens["access_token"].as_str().unwrap().to_string();
    let date = "2026-09-11";
    let none = call(&mut store, &access, "garderobe_today", json!({"date": date})).await;
    assert_eq!(none["structuredContent"]["board"], Value::Null);
    // Without a date it is the owner's day now in London (00:26 UTC on the 10th is 01:26 BST on the 10th).
    let undated = call(&mut store, &access, "garderobe_today", json!({})).await;
    assert_eq!((undated["structuredContent"]["localDate"].clone(), undated["structuredContent"]["timezone"].clone()), (json!("2026-09-10"), json!("Europe/London")));
    assert_eq!(error_of(&call(&mut store, &access, "garderobe_today", json!({"date": "2026-9-11"})).await)["code"], "invalid_command");

    // The owner's app publishes the day's board (until the recommender is ported).
    let outfit = |top: &str, bottom: &str, socks: &str, shoes: &str| json!({"slots": [{"role": "top", "garmentId": top}, {"role": "bottom", "garmentId": bottom}, {"role": "socks", "garmentId": socks}, {"role": "footwear", "garmentId": shoes}], "reason": ""});
    let publish = json!({"type": "board.publish", "idempotencyKey": "owner-publish-1", "authorization": "owner_tap", "source": {"channel": "ios"}, "payload": {"localDate": date, "requestedCount": 2, "options": [
        outfit("gmt_3894b6a6295908d5e687af4f", "gmt_0bd82c642c7606199361d3d4", "gmt_9eb32f6a40ea3e5e4dee484b", "gmt_14bc4338d6760f6a13434b2f"),
        outfit("gmt_41c2da80e7f41e5dc6a4340b", "gmt_b8744c2627cd88a3b937f851", "gmt_67d3228f744d17138e400729", "gmt_185ccf753d109848f21f7cec"),
    ]}});
    let r = send(&mut store, T0, "POST", "/v1/commands", Some(&format!("Bearer {OWNER}")), publish.to_string().into_bytes()).await;
    assert_eq!(r.status, 200, "{}", r.text);

    let read = |store: &mut MemStore| {
        let access = access.clone();
        let mut s = store.clone();
        async move {
            let r = call(&mut s, &access, "garderobe_today", json!({"date": date})).await;
            (s, r["structuredContent"]["board"].clone())
        }
    };
    let (s, board) = read(&mut store).await;
    store = s;
    let id = board["boardId"].as_str().unwrap().to_string();
    let versions = |b: &Value| json!({format!("board:{}", b["boardId"].as_str().unwrap()): b["revision"]});
    // As the verifier's boardState: the choice and every option's pieces (not the revision or change marks).
    let state = |b: &Value| (b["selection"]["optionId"].clone(), b["selection"]["footwearGarmentId"].clone(), b["options"].as_array().unwrap().iter().map(|o| (o["optionId"].clone(), o["garments"].as_array().unwrap().iter().map(|g| format!("{}:{}", g["role"], g["garmentId"])).collect::<Vec<_>>())).collect::<Vec<_>>());
    let option = board["options"][1]["optionId"].clone();

    let sel = call(&mut store, &access, "garderobe_command", json!({"type": "board.select", "payload": {"boardId": id, "optionId": option}, "expectedVersions": versions(&board), "idempotencyKey": "codex-verify-select-1"})).await;
    let receipt = sel["structuredContent"]["receipt"].clone();
    assert_eq!((receipt["actor"].clone(), receipt["channel"].clone()), (json!("assistant"), json!("mcp")));
    let (s, after) = read(&mut store).await;
    store = s;
    // The verifier adopts the read only when its revision is the receipt's board version.
    assert_eq!(receipt["affected"][0], json!({"kind": "board", "id": id, "version": after["revision"]}));
    assert_eq!(after["selection"]["optionId"], option);
    let undo = call(&mut store, &access, "garderobe_command", json!({"type": "command.undo", "payload": {"commandId": receipt["commandId"]}, "expectedVersions": versions(&after), "idempotencyKey": "codex-verify-undo-1"})).await;
    assert!(undo["structuredContent"]["receipt"]["commandId"].is_string(), "{undo}");
    let (s, restored) = read(&mut store).await;
    store = s;
    assert_eq!(state(&restored), state(&board));

    let swap = call(&mut store, &access, "garderobe_command", json!({"type": "board.swap_slot", "payload": {"boardId": id, "optionId": option, "role": "top"}, "expectedVersions": versions(&restored), "idempotencyKey": "codex-verify-swap-1"})).await;
    let sr = swap["structuredContent"]["receipt"].clone();
    let (s, swapped) = read(&mut store).await;
    store = s;
    assert_eq!(sr["affected"][0]["version"], swapped["revision"]);
    assert_ne!(swapped["options"][1]["garments"][0], restored["options"][1]["garments"][0]);
    call(&mut store, &access, "garderobe_command", json!({"type": "command.undo", "payload": {"commandId": sr["commandId"]}, "expectedVersions": versions(&swapped), "idempotencyKey": "codex-verify-undo-2"})).await;
    let (_, back) = read(&mut store).await;
    assert_eq!(state(&back), state(&board), "after undoing the swap the board is exactly as before");
}

#[tokio::test]
async fn a_read_only_connection_is_not_offered_the_write_tool_and_is_stepped_up() {
    let mut store = MemStore::default();
    let (_, tokens) = connect(&mut store, false).await;
    assert_eq!(tokens["scope"], "wardrobe.read");
    let access = tokens["access_token"].as_str().unwrap();
    let list = rpc(&mut store, T0, access, 1, "tools/list", json!({})).await;
    let names: Vec<&str> = list.json["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["garderobe_today", "garderobe_recommend", "garderobe_inventory", "garderobe_run", "garderobe_ask", "garderobe_research"]);
    // With no gateway secret, the assistant's tools refuse by the secret's name and save nothing.
    let runs_before = store.data.keys().filter(|k| k.starts_with(b"u/")).count();
    for (tool, a) in [("garderobe_ask", json!({"message": "What should I wear?", "clientTurnId": "codex-ask-0001"})), ("garderobe_research", json!({"topic": "Loafers", "clientRequestId": "codex-res-0001"}))] {
        let refused = call(&mut store, access, tool, a).await;
        assert_eq!(error_of(&refused)["code"], "module_unavailable", "{tool}");
        assert!(error_of(&refused)["message"].as_str().unwrap().contains("WARDROBE_AI_GATEWAY"), "{tool}");
    }
    assert_eq!(store.data.keys().filter(|k| k.starts_with(b"u/")).count(), runs_before);
    // Recommending is a read: a read-only connection gets validated options, and nothing is published.
    let rec = call(&mut store, access, "garderobe_recommend", json!({"date": "2026-09-11", "count": 2, "clientRequestId": "codex-rec-0001"})).await;
    assert_eq!(rec["structuredContent"]["options"].as_array().unwrap().len(), 2, "{rec}");
    assert!(rec["content"][0]["text"].as_str().unwrap().starts_with("2 validated option(s) for 2026-09-11: "));
    let refused = call(&mut store, access, "garderobe_recommend", json!({"date": "2026-09-11", "count": 3, "clientRequestId": "codex-rec-0001"})).await;
    assert_eq!(error_of(&refused)["code"], "idempotency_key_reuse");
    // The repeat names the run, and garderobe_run reads it back with the same options.
    let again = call(&mut store, access, "garderobe_recommend", json!({"date": "2026-09-11", "count": 2, "clientRequestId": "codex-rec-0001"})).await;
    let run_id = again["structuredContent"]["runId"].as_str().unwrap().to_string();
    let followed = call(&mut store, access, "garderobe_run", json!({"runId": run_id})).await;
    let run = &followed["structuredContent"]["run"];
    assert_eq!((run["kind"].clone(), run["state"].clone(), run["result"]["options"].clone()), (json!("recommendation"), json!("completed"), rec["structuredContent"]["options"].clone()), "{followed}");
    assert_eq!(followed["content"][0]["text"], format!("Run {run_id} is completed"));
    let unknown = call(&mut store, access, "garderobe_run", json!({"runId": "run_000000000000000000000000"})).await;
    assert_eq!(error_of(&unknown)["code"], "not_found");
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
    let list = send(&mut store, T0, "GET", "/v1/assistants", Some(&owner), vec![]).await;
    assert_eq!(list.json["grants"][0]["status"], "revoked");

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
async fn pruning_and_refresh_at_the_idle_boundary_never_lose_the_refreshed_grant() {
    let mut store = MemStore::default();
    let owner = format!("Bearer {OWNER}");
    // Slot 0: a real connection. Slots 1..: consents never exchanged.
    let (client, tokens) = connect(&mut store, false).await;
    for _ in 1..MAX_GRANTS {
        consent(&mut store, &client, "wardrobe.read", false).await;
    }
    let r0 = tokens["refresh_token"].as_str().unwrap().to_string();
    let refresh = |rt: &str| form(&[("grant_type", "refresh_token"), ("refresh_token", rt), ("client_id", &client)]);

    // At the last instant its refresh token is accepted, the client refreshes.
    // Run that real refresh on a copy to get the exact record it commits.
    let at_refresh = T0 + REFRESH_IDLE_MS;
    let mut other = store.clone();
    let refreshed = send(&mut other, at_refresh, "POST", "/oauth/token", None, refresh(&r0)).await;
    assert_eq!(refreshed.status, 200, "{}", refreshed.text);
    let committed = other.data[b"o/grant/0".as_slice()].clone();

    // One millisecond later a consent prunes: by its clock slot 0 is idle
    // too long, so it reads slot 0 as free. The refresh commits between that
    // read and the compare-and-swap.
    store.interleave = Some((GRANTS_EPOCH_KEY.to_vec(), other.changes_since(&store)));
    let at_prune = at_refresh + 1;
    let ch = challenge();
    let mut params = authorize_params(&client, &ch, "wardrobe.read");
    params.extend([("owner_token", OWNER), ("decision", "allow")]);
    let fits = send(&mut store, at_prune, "POST", "/oauth/authorize", None, signed(&params, at_prune)).await;
    assert_eq!(fits.status, 302, "{}", fits.text);
    assert!(store.interleave.is_none(), "the refresh committed mid-prune");

    // The overwrite of slot 0 was refused; the new grant took slot 1.
    assert_eq!(store.data[b"o/grant/0".as_slice()], committed, "the refreshed grant is intact");
    assert!(fits.header("location").unwrap().contains("code=wac.grt_0001"), "{:?}", fits.header("location"));
    // And the client's new refresh token keeps working.
    let r1 = refreshed.json["refresh_token"].as_str().unwrap();
    assert_eq!(send(&mut store, at_prune + 1, "POST", "/oauth/token", None, refresh(r1)).await.status, 200);
    let list = send(&mut store, at_prune + 1, "GET", "/v1/assistants", Some(&owner), vec![]).await;
    let active = list.json["grants"].as_array().unwrap().iter().filter(|c| c["status"] == "active").count();
    assert_eq!(active, 2, "the refreshed grant and the new one");
}

#[tokio::test]
async fn concurrent_deliveries_of_one_consent_create_one_grant() {
    let mut store = MemStore::default();
    let owner = format!("Bearer {OWNER}");
    // Slot 0: an older live connection.
    let (client, _) = connect(&mut store, false).await;
    let list = send(&mut store, T0, "GET", "/v1/assistants", Some(&owner), vec![]).await;
    let old = list.json["grants"][0]["grantId"].as_str().unwrap().to_string();
    let t = T0 + CONSENT_FORM_TTL_MS + CLOCK_SKEW_MS + 10;
    let ch = challenge();
    let mut params = authorize_params(&client, &ch, "wardrobe.read");
    params.extend([("owner_token", OWNER), ("decision", "allow")]);

    // Delivery B, on a copy: the owner disconnects the old connection, which
    // frees slot 0, and B creates its grant there.
    let mut other = store.clone();
    assert_eq!(send(&mut other, t, "POST", &format!("/v1/assistants/{old}/disconnect"), Some(&owner), vec![]).await.status, 200);
    let b = send_as(&mut other, t, "POST", "/oauth/authorize", None, signed(&params, t), "consent-c").await;
    assert!(b.header("location").unwrap().contains("code=wac.grt_0000"), "{:?}", b.header("location"));

    // Delivery A of the same consent read slot 0 as live and chose slot 1;
    // B's records commit between A's read and A's write.
    store.interleave = Some((GRANTS_EPOCH_KEY.to_vec(), other.changes_since(&store)));
    let a = send_as(&mut store, t, "POST", "/oauth/authorize", None, signed(&params, t), "consent-c").await;
    assert!(store.interleave.is_none(), "B committed mid-allocation");
    assert_eq!(a.header("location"), b.header("location"), "A answers with B's code");
    assert_eq!(store.count(b"o/grant/"), 1, "one grant, in slot 0");
}

#[tokio::test]
async fn a_redelivered_consent_or_exchange_is_answered_again_not_repeated() {
    let mut store = MemStore::default();
    let owner = format!("Bearer {OWNER}");
    let client = register(&mut store).await;
    let ch = challenge();
    let mut params = authorize_params(&client, &ch, "wardrobe.read");
    params.extend([("owner_token", OWNER), ("decision", "allow")]);

    // The queue delivers the consent twice (the first acknowledgement was lost).
    let first = send_as(&mut store, T0, "POST", "/oauth/authorize", None, signed(&params, T0), "consent-1").await;
    let again = send_as(&mut store, T0 + 500, "POST", "/oauth/authorize", None, signed(&params, T0), "consent-1").await;
    assert_eq!((first.status, again.status), (302, 302));
    assert_eq!(first.header("location"), again.header("location"), "the same code, not a second grant");
    let list = send(&mut store, T0, "GET", "/v1/assistants", Some(&owner), vec![]).await;
    assert_eq!(list.json["grants"].as_array().unwrap().len(), 1);
    let location = first.header("location").unwrap().to_string();
    let code = location.split("code=").nth(1).unwrap().split('&').next().unwrap().to_string();

    // The exchange is delivered twice: the same tokens, and the grant lives.
    let body = form(&[("grant_type", "authorization_code"), ("code", &code), ("redirect_uri", REDIRECT), ("client_id", &client), ("code_verifier", VERIFIER)]);
    let t1 = send_as(&mut store, T0 + 1_000, "POST", "/oauth/token", None, body.clone(), "exchange-1").await;
    let t2 = send_as(&mut store, T0 + 2_000, "POST", "/oauth/token", None, body.clone(), "exchange-1").await;
    assert_eq!((t1.status, t2.status), (200, 200), "{}", t2.text);
    assert_eq!((t1.json["access_token"].clone(), t1.json["refresh_token"].clone()), (t2.json["access_token"].clone(), t2.json["refresh_token"].clone()));
    assert_eq!((t1.json["expires_in"].clone(), t2.json["expires_in"].clone()), (json!(ACCESS_TTL_MS / 1000), json!(ACCESS_TTL_MS / 1000 - 1)), "the redelivery reports the token's remaining life");
    let access = t1.json["access_token"].as_str().unwrap().to_string();
    assert_eq!(rpc(&mut store, T0 + 2_000, &access, 1, "ping", json!({})).await.status, 200);

    // The client refreshes, then the refresh is redelivered after the client
    // has already rotated again: answered with what it issued, no revocation.
    let rt = t1.json["refresh_token"].as_str().unwrap().to_string();
    let refresh = |t: &str| form(&[("grant_type", "refresh_token"), ("refresh_token", t), ("client_id", &client)]);
    let r1 = send_as(&mut store, T0 + 3_000, "POST", "/oauth/token", None, refresh(&rt), "refresh-1").await;
    assert_eq!(r1.status, 200);
    let next = r1.json["refresh_token"].as_str().unwrap().to_string();
    let r2 = send(&mut store, T0 + 4_000, "POST", "/oauth/token", None, refresh(&next)).await;
    assert_eq!(r2.status, 200);
    let late = send_as(&mut store, T0 + 5_000, "POST", "/oauth/token", None, refresh(&rt), "refresh-1").await;
    assert_eq!((late.status, late.json["refresh_token"].clone()), (200, r1.json["refresh_token"].clone()), "{}", late.text);
    let newest = r2.json["refresh_token"].as_str().unwrap().to_string();
    assert_eq!(send(&mut store, T0 + 6_000, "POST", "/oauth/token", None, refresh(&newest)).await.status, 200, "the grant is still live");

    // The same spent code in a different request is still a replay.
    let replay = send(&mut store, T0 + 7_000, "POST", "/oauth/token", None, body).await;
    assert_eq!(replay.status, 400);
    let list = send(&mut store, T0 + 7_000, "GET", "/v1/assistants", Some(&owner), vec![]).await;
    assert_eq!(list.json["grants"][0]["status"], "revoked");
}

#[tokio::test]
async fn retries_of_a_replaced_token_never_push_out_a_redelivery_and_a_dead_answer_is_refused() {
    let mut store = MemStore::default();
    let owner = format!("Bearer {OWNER}");
    let (client, tokens) = connect(&mut store, false).await;
    let r0 = tokens["refresh_token"].as_str().unwrap().to_string();
    let refresh = |t: &str| form(&[("grant_type", "refresh_token"), ("refresh_token", t), ("client_id", &client)]);
    // R0 is replaced, then retried until it holds MAX_SUCCESSORS unused successors.
    let first = send_as(&mut store, T0 + 1_000, "POST", "/oauth/token", None, refresh(&r0), "retry-0").await;
    assert_eq!(first.status, 200);
    for i in 1..MAX_SUCCESSORS as u64 {
        assert_eq!(send(&mut store, T0 + 1_000 + i, "POST", "/oauth/token", None, refresh(&r0)).await.status, 200);
    }
    // One more retry is refused without ending anything.
    let over = send(&mut store, T0 + 2_000, "POST", "/oauth/token", None, refresh(&r0)).await;
    assert_eq!((over.status, over.json["error"].clone()), (400, json!("invalid_grant")), "{}", over.text);
    let list = send(&mut store, T0 + 2_000, "GET", "/v1/assistants", Some(&owner), vec![]).await;
    assert_eq!(list.json["grants"][0]["status"], "active");
    // The first delivery is still recognised: the same answer, nothing changed.
    let before = store.clone();
    let again = send_as(&mut store, T0 + 3_000, "POST", "/oauth/token", None, refresh(&r0), "retry-0").await;
    assert_eq!((again.status, again.json["refresh_token"].clone()), (200, first.json["refresh_token"].clone()), "{}", again.text);
    assert_eq!(again.json["expires_in"], json!((ACCESS_TTL_MS - 2_000) / 1000));
    assert!(store.same_records(&before), "a redelivery changes no record");
    // Delivered again after its access token expired: refused, still nothing changed.
    let r1 = first.json["refresh_token"].as_str().unwrap().to_string();
    let late = send_as(&mut store, T0 + 1_000 + ACCESS_TTL_MS, "POST", "/oauth/token", None, refresh(&r0), "retry-0").await;
    assert_eq!((late.status, late.json["error"].clone()), (400, json!("invalid_grant")), "{}", late.text);
    assert!(store.same_records(&before));
    // The client's newest token still works.
    assert_eq!(send(&mut store, T0 + 1_000 + ACCESS_TTL_MS, "POST", "/oauth/token", None, refresh(&r1)).await.status, 200);
}

#[tokio::test]
async fn a_late_consent_redelivery_never_recreates_a_disconnected_grant() {
    let mut store = MemStore::default();
    let owner = format!("Bearer {OWNER}");
    let client = register(&mut store).await;
    let ch = challenge();
    let mut params = authorize_params(&client, &ch, "wardrobe.read");
    params.extend([("owner_token", OWNER), ("decision", "allow")]);
    let first = send_as(&mut store, T0, "POST", "/oauth/authorize", None, signed(&params, T0), "consent-9").await;
    assert_eq!(first.status, 302);
    let list = send(&mut store, T0, "GET", "/v1/assistants", Some(&owner), vec![]).await;
    let grant = list.json["grants"][0]["grantId"].as_str().unwrap().to_string();
    assert_eq!(send(&mut store, T0 + 1, "POST", &format!("/v1/assistants/{grant}/disconnect"), Some(&owner), vec![]).await.status, 200);

    // Inside the form's lifetime the disconnected grant keeps its slot: a
    // redelivery is answered from it (its code exchanges for nothing) and a
    // new consent takes another slot.
    let again = send_as(&mut store, T0 + 1_000, "POST", "/oauth/authorize", None, signed(&params, T0), "consent-9").await;
    assert_eq!(first.header("location"), again.header("location"));
    let code = again.header("location").unwrap().split("code=").nth(1).unwrap().split('&').next().unwrap().to_string();
    assert_eq!(exchange(&mut store, &client, &code, VERIFIER).await.status, 400);
    let other = send(&mut store, T0 + 2_000, "POST", "/oauth/authorize", None, signed(&params, T0 + 2_000)).await;
    assert!(other.header("location").unwrap().contains("code=wac.grt_0001"), "{:?}", other.header("location"));

    // After it, the slot may be reused, and the redelivery is refused.
    let late = T0 + CONSENT_FORM_TTL_MS + CLOCK_SKEW_MS + 1;
    let before = store.clone();
    let r = send_as(&mut store, late, "POST", "/oauth/authorize", None, signed(&params, T0), "consent-9").await;
    assert_eq!((r.status, r.header("location")), (400, None), "{}", r.text);
    assert!(store.same_records(&before), "nothing was created");
}

#[tokio::test]
async fn a_redelivered_exchange_is_answered_while_its_tokens_are_usable_and_refused_after() {
    let mut store = MemStore::default();
    let owner = format!("Bearer {OWNER}");
    let client = register(&mut store).await;
    let code = consent(&mut store, &client, "wardrobe.read", false).await;
    let body = form(&[("grant_type", "authorization_code"), ("code", &code), ("redirect_uri", REDIRECT), ("client_id", &client), ("code_verifier", VERIFIER)]);
    let t = send_as(&mut store, T0, "POST", "/oauth/token", None, body.clone(), "x-1").await;
    assert_eq!(t.status, 200, "{}", t.text);
    let r0 = t.json["refresh_token"].as_str().unwrap().to_string();
    let refresh = |t: &str| form(&[("grant_type", "refresh_token"), ("refresh_token", t), ("client_id", &client)]);
    // R0 is replaced and retried to its limit: MAX_SUCCESSORS more access tokens.
    let first = send(&mut store, T0 + 1_000, "POST", "/oauth/token", None, refresh(&r0)).await;
    for i in 1..MAX_SUCCESSORS as u64 {
        assert_eq!(send(&mut store, T0 + 1_000 + i, "POST", "/oauth/token", None, refresh(&r0)).await.status, 200);
    }
    // R0 is the replaced token inside its window: the exchange's answer is still usable.
    let before = store.clone();
    let again = send_as(&mut store, T0 + 2_000, "POST", "/oauth/token", None, body.clone(), "x-1").await;
    assert_eq!((again.status, again.json["access_token"].clone(), again.json["refresh_token"].clone()), (200, t.json["access_token"].clone(), t.json["refresh_token"].clone()), "{}", again.text);
    assert!(store.same_records(&before));
    // Once a successor is used R0 is retired: the answer is refused, not
    // handed out to trip a replay, and the grant lives on.
    let r1 = first.json["refresh_token"].as_str().unwrap().to_string();
    assert_eq!(send(&mut store, T0 + 3_000, "POST", "/oauth/token", None, refresh(&r1)).await.status, 200);
    let before = store.clone();
    let stale = send_as(&mut store, T0 + 4_000, "POST", "/oauth/token", None, body, "x-1").await;
    assert_eq!((stale.status, stale.json["error"].clone()), (400, json!("invalid_grant")), "{}", stale.text);
    assert!(store.same_records(&before));
    let list = send(&mut store, T0 + 4_000, "GET", "/v1/assistants", Some(&owner), vec![]).await;
    assert_eq!(list.json["grants"][0]["status"], "active");
}

#[tokio::test]
async fn a_replaced_refresh_token_is_retried_only_within_its_fixed_window() {
    let mut store = MemStore::default();
    let owner = format!("Bearer {OWNER}");
    let (client, tokens) = connect(&mut store, false).await;
    let r0 = tokens["refresh_token"].as_str().unwrap().to_string();
    let refresh = |t: &str| form(&[("grant_type", "refresh_token"), ("refresh_token", t), ("client_id", &client)]);
    // R0 is replaced at T0 + 1s; its retry window ends PREVIOUS_RETRY_MS later.
    assert_eq!(send(&mut store, T0 + 1_000, "POST", "/oauth/token", None, refresh(&r0)).await.status, 200);
    // Retries inside the window work, and do not move the deadline.
    assert_eq!(send(&mut store, T0 + 1_000 + PREVIOUS_RETRY_MS - 1, "POST", "/oauth/token", None, refresh(&r0)).await.status, 200);
    let after = send(&mut store, T0 + 1_000 + PREVIOUS_RETRY_MS + 1, "POST", "/oauth/token", None, refresh(&r0)).await;
    assert_eq!((after.status, after.json["error"].clone()), (400, json!("invalid_grant")));
    let list = send(&mut store, T0 + 1_000 + PREVIOUS_RETRY_MS + 1, "GET", "/v1/assistants", Some(&owner), vec![]).await;
    assert_eq!(list.json["grants"][0]["status"], "revoked", "late reuse of a replaced token is a replay");

    // Inside the window, using a successor ends the replaced token at once.
    let mut store = MemStore::default();
    let (client, tokens) = connect(&mut store, false).await;
    let r0 = tokens["refresh_token"].as_str().unwrap().to_string();
    let refresh = |t: &str| form(&[("grant_type", "refresh_token"), ("refresh_token", t), ("client_id", &client)]);
    let first = send(&mut store, T0 + 1_000, "POST", "/oauth/token", None, refresh(&r0)).await;
    let r1 = first.json["refresh_token"].as_str().unwrap().to_string();
    assert_eq!(send(&mut store, T0 + 2_000, "POST", "/oauth/token", None, refresh(&r1)).await.status, 200);
    let old = send(&mut store, T0 + 3_000, "POST", "/oauth/token", None, refresh(&r0)).await;
    assert_eq!((old.status, old.json["error"].clone()), (400, json!("invalid_grant")), "the successor was used");
    let list = send(&mut store, T0 + 3_000, "GET", "/v1/assistants", Some(&owner), vec![]).await;
    assert_eq!(list.json["grants"][0]["status"], "revoked");
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
    let full = send(&mut store, T0, "POST", "/oauth/authorize", None, signed(&params, T0)).await;
    assert_eq!(full.status, 409, "{}", full.text);

    // Once the codes expire unused (and their consent forms with them) they
    // can produce no token (listed as revoked: the contract has no expired
    // state, and nobody revoked them), and a new consent fits.
    let later = T0 + CONSENT_FORM_TTL_MS + CLOCK_SKEW_MS + 1;
    let list = send(&mut store, later, "GET", "/v1/assistants", Some(&owner), vec![]).await;
    let statuses: Vec<&str> = list.json["grants"].as_array().unwrap().iter().map(|c| c["status"].as_str().unwrap()).collect();
    assert_eq!(statuses.len(), MAX_GRANTS);
    assert_eq!(statuses.iter().filter(|s| **s == "revoked").count(), MAX_GRANTS - 1);
    assert_eq!(statuses.iter().filter(|s| **s == "active").count(), 1);
    let revoked = list.json["grants"].as_array().unwrap().iter().filter(|c| c["status"] == "revoked").collect::<Vec<_>>();
    assert!(revoked.iter().all(|c| c["revokedAt"].is_null()), "expired, not revoked by anyone: {}", list.text);
    assert_eq!(list.json["grants"][0]["status"], "active", "active grants are listed first: {}", list.text);
    let fits = send(&mut store, later, "POST", "/oauth/authorize", None, signed(&params, later)).await;
    assert_eq!(fits.status, 302, "{}", fits.text);
    let list = send(&mut store, later, "GET", "/v1/assistants", Some(&owner), vec![]).await;
    let statuses: Vec<&str> = list.json["grants"].as_array().unwrap().iter().map(|c| c["status"].as_str().unwrap()).collect();
    assert_eq!((statuses.len(), statuses.iter().filter(|s| **s == "active").count()), (MAX_GRANTS, 2), "the new grant took an expired grant's slot");
    assert_eq!(store.count(b"o/grant/"), MAX_GRANTS, "storage stays at the slots");

    // A refresh token idle for 90 days: the connection can produce no token and is listed as revoked.
    let idle = T0 + REFRESH_IDLE_MS + 1;
    let list = send(&mut store, idle, "GET", "/v1/assistants", Some(&owner), vec![]).await;
    assert!(list.json["grants"].as_array().unwrap().iter().all(|c| c["status"] == "revoked"), "{}", list.text);
}

#[tokio::test]
async fn the_owner_disconnects_and_the_next_request_is_refused() {
    let mut store = MemStore::default();
    let (client, tokens) = connect(&mut store, true).await;
    let access = tokens["access_token"].as_str().unwrap();
    let owner = format!("Bearer {OWNER}");
    let list = send(&mut store, T0, "GET", "/v1/assistants", Some(&owner), vec![]).await;
    let c = list.json["grants"][0].clone();
    // `AssistantGrant`: exactly the contract's fields.
    let mut keys: Vec<&str> = c.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, vec!["access", "clientDomain", "clientId", "clientName", "clientUri", "grantId", "grantedAt", "lastUsedAt", "revokedAt", "scopes", "status", "version"]);
    assert_eq!((c["clientName"].clone(), c["access"].clone(), c["status"].clone(), c["scopes"].clone()), (json!("Codex"), json!("read_write"), json!("active"), json!(["wardrobe.read", "wardrobe.write"])));
    assert!(c["lastUsedAt"].is_string() && c["revokedAt"].is_null() && c["version"].as_u64().unwrap() >= 1, "{c}");
    assert!(!list.text.contains("hash"), "{}", list.text);
    let grant = c["grantId"].as_str().unwrap();

    let gone = send(&mut store, T0, "POST", &format!("/v1/assistants/{grant}/disconnect"), Some(&owner), vec![]).await;
    assert_eq!((gone.status, gone.json["status"].clone(), gone.json["grantId"].clone()), (200, json!("revoked"), json!(grant)));
    assert!(gone.json["revokedAt"].is_string(), "{}", gone.text);
    // Malformed disconnect paths are not found, never a crash.
    for bad in ["/v1/assistants/disconnect", "/v1/assistants//disconnect", "/v1/assistants/a/b/disconnect"] {
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
        let t = Tokens { owner: Some(OWNER.into()), assistant: None, public_origin: origin, ..Default::default() };
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
