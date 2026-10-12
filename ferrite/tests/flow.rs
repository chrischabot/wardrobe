//! The first slice end to end, through the app's request queue and its APE
//! store on the local harness (Forge planes, in-process): the owner's real
//! inventory read, "in the wash" applied at once with a receipt, a repeated
//! request answered from its receipt, and the change taken back with undo, by
//! the owner's app and by a connected assistant, as the 2026-10-05 contract
//! requires.

use ferrite_app::serde_json::{self, json, Value};
use ferrite_app_test::{ingress, TestEnv, TestHarness};

const OWNER: &str = "test-owner-token";
const ASSISTANT: &str = "test-assistant-token";

async fn start() -> TestEnv {
    let env = TestHarness::new().with_queue("requests").with_queue("replies").with_ape("state").build().await;
    env.run_app(|ctx| async move { wardrobe::serve(ctx, wardrobe::Tokens { owner: Some(OWNER.into()), assistant: Some(ASSISTANT.into()), ..Default::default() }).await });
    env
}

async fn call(env: &TestEnv, token: &str, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
    let bytes = body.map(|b| serde_json::to_vec(&b).unwrap()).unwrap_or_default();
    let mut req = ingress::request(method, path, "", bytes);
    req.headers = vec![("authorization".into(), format!("Bearer {token}"))];
    let reply = env.handle(req).await.expect("a reply");
    let value: Value = serde_json::from_slice(&reply.body).unwrap_or(Value::Null);
    (reply.status, value)
}

fn command(kind: &str, payload: Value, key: &str, authorization: &str, channel: &str) -> Value {
    json!({"type": kind, "payload": payload, "idempotencyKey": key, "authorization": authorization, "source": {"channel": channel}})
}

fn item<'a>(page: &'a Value, id: &str) -> &'a Value {
    page["items"].as_array().unwrap().iter().find(|i| i["garmentId"] == id).expect(id)
}

/// Two single-unit garments that are laundered, from the owner's inventory.
fn two_shirts(page: &Value) -> (String, String) {
    let ids: Vec<String> = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["careChannel"] == "service" && i["quantity"] == 1)
        .map(|i| i["garmentId"].as_str().unwrap().to_string())
        .take(2)
        .collect();
    (ids[0].clone(), ids[1].clone())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inventory_receipt_replay_and_undo() {
    let env = start().await;

    // The owner's inventory: every imported row, every unit clean at import.
    let (status, page) = call(&env, OWNER, "GET", "/v1/wardrobe", None).await;
    assert_eq!(status, 200, "{page}");
    assert_eq!(page["items"].as_array().unwrap().len(), 127);
    assert_eq!(page["counts"]["ownedUnits"], 144);
    assert_eq!(page["source"]["sha256"], "ca9a5e06edbb2646ad91f102cb242a81b1776bd39e86e99300c0eb387254c946");
    assert_eq!(page["wardrobeRevision"], 0);
    let (a, b) = two_shirts(&page);
    assert_eq!(item(&page, &a)["balances"], json!({"clean": 1, "dirty": 0}));

    // "Both are in the wash", relayed by the connected assistant: applied at once.
    let dirty = command("care.mark_dirty", json!({"items": [{"garmentId": a}, {"garmentId": b}]}), "mcp-dirty-0001", "owner_statement", "mcp");
    let (status, receipt) = call(&env, ASSISTANT, "POST", "/v1/commands", Some(dirty.clone())).await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(receipt["outcome"], "committed");
    assert!(receipt["summary"].as_str().unwrap().starts_with("In the wash: "));
    assert_eq!(receipt["result"], json!({"units": 2}));
    assert_eq!(receipt["undo"], json!({"available": true, "reason": null}));
    assert_eq!(receipt["wardrobeRevision"], 1);
    assert_eq!((receipt["actor"].clone(), receipt["channel"].clone()), (json!("assistant"), json!("mcp")));
    let dirty_id = receipt["commandId"].as_str().unwrap().to_string();

    // The same request again is answered from its receipt; nothing runs twice.
    let (status, again) = call(&env, ASSISTANT, "POST", "/v1/commands", Some(dirty)).await;
    assert_eq!((status, again["commandId"].clone(), again["replayed"].clone()), (200, json!(dirty_id), json!(true)));
    // The same key with a different body is refused.
    let changed = command("care.mark_dirty", json!({"items": [{"garmentId": a}]}), "mcp-dirty-0001", "owner_statement", "mcp");
    let (status, reuse) = call(&env, ASSISTANT, "POST", "/v1/commands", Some(changed)).await;
    assert_eq!((status, reuse["error"]["code"].clone()), (409, json!("idempotency_key_reuse")));

    let (_, page) = call(&env, OWNER, "GET", "/v1/wardrobe", None).await;
    assert_eq!(item(&page, &a)["balances"], json!({"clean": 0, "dirty": 1}));
    assert_eq!(item(&page, &a)["version"], 2);
    assert_eq!(page["wardrobeRevision"], 1);

    // The assistant cannot claim a tap, which only the owner's own app makes.
    let tap = command("command.undo", json!({"commandId": dirty_id}), "mcp-undo-tap-01", "owner_tap", "mcp");
    let (status, refused) = call(&env, ASSISTANT, "POST", "/v1/commands", Some(tap)).await;
    assert_eq!((status, refused["error"]["code"].clone()), (403, json!("forbidden")));

    // "Undo that", tapped in the owner's app.
    let undo = command("command.undo", json!({"commandId": dirty_id}), "app-undo-0001", "owner_tap", "ios");
    let (status, undone) = call(&env, OWNER, "POST", "/v1/commands", Some(undo)).await;
    assert_eq!(status, 200, "{undone}");
    assert_eq!(undone["summary"], format!("Undone: {}. The quantities are as they were before", receipt["summary"].as_str().unwrap()));
    assert_eq!(undone["undo"]["available"], false);
    assert_eq!(undone["result"]["undoneCommandId"], dirty_id.as_str());

    let (_, page) = call(&env, OWNER, "GET", "/v1/wardrobe", None).await;
    assert_eq!(item(&page, &a)["balances"], json!({"clean": 1, "dirty": 0}));
    assert_eq!(item(&page, &b)["balances"], json!({"clean": 1, "dirty": 0}));

    // The original receipt now says its undo was used, and a second undo is refused.
    let (status, original) = call(&env, OWNER, "GET", &format!("/v1/commands/{dirty_id}"), None).await;
    assert_eq!(status, 200);
    assert_eq!(original["undo"], json!({"available": false, "reason": "this action was already undone"}));
    let twice = command("command.undo", json!({"commandId": dirty_id}), "mcp-undo-0002", "owner_statement", "mcp");
    let (status, refused) = call(&env, ASSISTANT, "POST", "/v1/commands", Some(twice)).await;
    assert_eq!((status, refused["error"]["message"].clone()), (409, json!("that action was already undone")));

    // Every receipt is listed, newest first; refused requests wrote nothing.
    let (_, list) = call(&env, OWNER, "GET", "/v1/commands", None).await;
    let kinds: Vec<&str> = list["receipts"].as_array().unwrap().iter().map(|r| r["type"].as_str().unwrap()).collect();
    assert_eq!(kinds, vec!["command.undo", "care.mark_dirty"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refusals_write_nothing() {
    let env = start().await;
    let (_, page) = call(&env, OWNER, "GET", "/v1/wardrobe", None).await;
    let shoe = page["items"].as_array().unwrap().iter().find(|i| i["careChannel"] == "none").unwrap()["garmentId"].as_str().unwrap().to_string();
    let (a, _) = two_shirts(&page);

    let never = command("care.mark_dirty", json!({"items": [{"garmentId": shoe}]}), "app-dirty-shoe", "owner_tap", "ios");
    let (status, e) = call(&env, OWNER, "POST", "/v1/commands", Some(never)).await;
    assert_eq!((status, e["error"]["code"].clone()), (409, json!("precondition_failed")));

    let unknown = command("laundry.collect", json!({}), "app-collect-0001", "owner_tap", "ios");
    let (status, e) = call(&env, OWNER, "POST", "/v1/commands", Some(unknown)).await;
    assert_eq!((status, e["error"]["code"].clone()), (400, json!("unknown_command")));

    let wrong_channel = command("care.mark_dirty", json!({"items": [{"garmentId": a}]}), "app-dirty-0001", "owner_tap", "mcp");
    let (status, e) = call(&env, OWNER, "POST", "/v1/commands", Some(wrong_channel)).await;
    assert_eq!((status, e["error"]["code"].clone()), (403, json!("forbidden")));

    let fraction = command("care.mark_dirty", json!({"items": [{"garmentId": a, "quantity": 1.5}]}), "app-dirty-0002", "owner_tap", "ios");
    let (status, e) = call(&env, OWNER, "POST", "/v1/commands", Some(fraction)).await;
    assert_eq!((status, e["error"]["code"].clone()), (400, json!("invalid_command")));

    let missing = command("command.undo", json!({"commandId": "cmd_nope"}), "app-undo-0001", "owner_tap", "ios");
    let (status, e) = call(&env, OWNER, "POST", "/v1/commands", Some(missing)).await;
    assert_eq!((status, e["error"]["code"].clone()), (404, json!("not_found")));

    let (status, e) = call(&env, "not-a-token", "GET", "/v1/wardrobe", None).await;
    assert_eq!((status, e["error"]["code"].clone()), (401, json!("unauthenticated")));

    let (_, after) = call(&env, OWNER, "GET", "/v1/wardrobe", None).await;
    assert_eq!(after["wardrobeRevision"], 0);
    let (_, list) = call(&env, OWNER, "GET", "/v1/commands", None).await;
    assert_eq!(list["receipts"], json!([]));
}
