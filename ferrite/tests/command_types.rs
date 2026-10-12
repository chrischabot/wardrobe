//! `GET /v1/command-types` (`CommandTypeList`): the command types this port executes, described as the
//! TypeScript registry describes them and narrowed to what the port's handlers accept. Each published
//! payload field is sent through `POST /v1/commands` to show the handler accepts it as a field, and an
//! unpublished one to show it is refused by name, so the list cannot claim more or less than the port.
//!
//! The store is an in-memory test double of the APE binding; nothing is committed by these requests.

use std::collections::BTreeMap;
use std::io;

use ferrite_app::serde_json::{self, json, Value};
use ferrite_app::IngressRequest;
use wardrobe::api::{self, Store, Tokens};
use wardrobe::ledger;

const OWNER: &str = "owner-token-for-tests";
const ASSISTANT: &str = "assistant-token-for-tests";
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

async fn send(store: &mut MemStore, token: Option<&str>, method: &str, path: &str, body: Value) -> (u16, Value) {
    let bytes = if body.is_null() { Vec::new() } else { serde_json::to_vec(&body).unwrap() };
    let mut req = IngressRequest::new(method, path, bytes);
    if let Some(token) = token {
        req.headers = vec![("authorization".into(), format!("Bearer {token}"))];
    }
    let tokens = Tokens { owner: Some(OWNER.into()), assistant: Some(ASSISTANT.into()), public_origin: Some("http://127.0.0.1:8787".into()) };
    let reply = api::handle(store, &tokens, T0, &req).await;
    let (_, bytes) = reply.content();
    (reply.status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn type_of<'a>(list: &'a Value, kind: &str) -> &'a Value {
    list["types"].as_array().unwrap().iter().find(|t| t["type"] == kind).unwrap_or_else(|| panic!("{kind} is not listed"))
}

#[tokio::test]
async fn the_list_names_exactly_the_ported_commands_as_the_typescript_registry_describes_them() {
    let mut store = MemStore::default();
    let (status, list) = send(&mut store, Some(OWNER), "GET", "/v1/command-types", Value::Null).await;
    assert_eq!(status, 200, "{list}");
    assert_eq!(list["contractVersion"], api::CONTRACT_VERSION);
    let mut ported: Vec<&str> = ledger::COMMAND_TYPES.to_vec();
    ported.sort_unstable();
    let listed: Vec<&str> = list["types"].as_array().unwrap().iter().map(|t| t["type"].as_str().unwrap()).collect();
    assert_eq!(listed, ported, "sorted by type, as registry.types() is");
    for t in list["types"].as_array().unwrap() {
        let keys: Vec<&str> = t.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys.len(), 6, "{t}");
        for k in ["type", "class", "requiredScope", "authorizations", "consequential", "payloadSchema"] {
            assert!(keys.contains(&k), "{k} missing from {t}");
        }
        assert_eq!(t["requiredScope"], "write", "{t}");
        // Nothing this port executes waits for the owner when a connected assistant sends it.
        assert_eq!(t["consequential"], false, "{t}");
        assert_eq!(t["payloadSchema"]["type"], "object", "{t}");
        assert_eq!(t["payloadSchema"]["additionalProperties"], false, "{t}");
    }
    // The owner's reports are observations; a choice, a swap and an undo are edits (handlers in
    // packages/domain and packages/daily).
    for kind in ["care.mark_dirty", "care.washed", "laundry.collect", "laundry.return", "wear.record"] {
        assert_eq!(type_of(&list, kind)["class"], "observation", "{kind}");
    }
    for kind in ["board.select", "board.swap_slot", "command.undo"] {
        assert_eq!(type_of(&list, kind)["class"], "edit", "{kind}");
    }
    let wear = type_of(&list, "wear.record");
    assert_eq!(wear["authorizations"], json!(["owner_tap", "owner_statement"]));
    assert_eq!(wear["payloadSchema"]["required"], json!(["wearingDate", "garmentIds"]));
    assert_eq!(wear["payloadSchema"]["properties"]["garmentIds"]["minItems"], 1);
    // A publication is a system command the TypeScript service also lets a schedule or a standing
    // policy authorize; this port has neither, so only the owner's tap or statement is offered, and
    // the run fingerprint it does not accept is not published.
    let publish = type_of(&list, "board.publish");
    assert_eq!(publish["class"], "system");
    assert_eq!(publish["authorizations"], json!(["owner_tap", "owner_statement"]));
    assert!(publish["payloadSchema"]["properties"].get("requestFingerprint").is_none(), "{publish}");
    assert_eq!(publish["payloadSchema"]["required"], json!(["localDate", "options", "requestedCount"]));
    assert_eq!(type_of(&list, "board.select")["payloadSchema"]["required"], json!(["boardId", "optionId"]));
}

#[tokio::test]
async fn a_connected_assistant_reads_the_same_list_and_an_unsigned_request_is_refused() {
    let mut store = MemStore::default();
    let (_, owner) = send(&mut store, Some(OWNER), "GET", "/v1/command-types", Value::Null).await;
    let (status, assistant) = send(&mut store, Some(ASSISTANT), "GET", "/v1/command-types", Value::Null).await;
    assert_eq!((status, &assistant), (200, &owner));
    let (status, body) = send(&mut store, None, "GET", "/v1/command-types", Value::Null).await;
    assert_eq!(status, 401, "{body}");
    let (status, body) = send(&mut store, Some("not-a-token"), "GET", "/v1/command-types", Value::Null).await;
    assert_eq!(status, 401, "{body}");
}

/// The payload a command needs before its handler checks the fields at all.
fn base(kind: &str) -> Value {
    match kind {
        "board.select" | "board.swap_slot" => json!({"boardId": "brd_never_published"}),
        _ => json!({}),
    }
}

async fn refusal(store: &mut MemStore, kind: &str, payload: Value, n: usize) -> String {
    let envelope = json!({"type": kind, "payload": payload, "idempotencyKey": format!("command-types-{kind}-{n}"), "authorization": "owner_tap", "source": {"channel": "ios"}});
    let (status, body) = send(store, Some(OWNER), "POST", "/v1/commands", envelope).await;
    assert_ne!(status, 200, "{kind}: a malformed payload was accepted: {body}");
    body.to_string()
}

#[tokio::test]
async fn every_published_payload_field_is_one_the_handler_accepts_and_no_other_is() {
    let mut store = MemStore::default();
    let (_, list) = send(&mut store, Some(OWNER), "GET", "/v1/command-types", Value::Null).await;
    let mut n = 0;
    for t in list["types"].as_array().unwrap() {
        let kind = t["type"].as_str().unwrap();
        let props = t["payloadSchema"]["properties"].as_object().unwrap();
        assert!(!props.is_empty(), "{kind}");
        for field in props.keys() {
            // A value of the wrong type: refused for its value (or for another field), never as an
            // unknown field.
            let mut payload = base(kind);
            payload[field] = json!(true);
            n += 1;
            let body = refusal(&mut store, kind, payload, n).await;
            assert!(!body.contains("not a field of this command"), "{kind}.{field} is published but refused as a field: {body}");
        }
        let mut payload = base(kind);
        payload["notPublished"] = json!(true);
        n += 1;
        let body = refusal(&mut store, kind, payload, n).await;
        assert!(body.contains("notPublished: not a field of this command"), "{kind}: {body}");
    }
    // Nothing was written by any of them.
    let (_, receipts) = send(&mut store, Some(OWNER), "GET", "/v1/commands", Value::Null).await;
    assert_eq!(receipts["receipts"], json!([]), "{receipts}");
}
