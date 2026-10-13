//! Settings routes the iOS client calls that touch no wardrobe record: notification devices
//! (`GET`/`POST /v1/devices`, `POST /v1/devices/{id}/remove`, as notifications/service.ts) and outbound
//! connections (`/v1/connections`, which this server cannot register, so there are none).
//!
//! The store is an in-memory test double of the APE binding (the same guarded-commit semantics). No
//! push is delivered and no outbound connection is made; the tokens below are synthetic hex, not
//! issued by Apple.

use std::collections::BTreeMap;
use std::io;

use ferrite_app::serde_json::{self, json, Value};
use ferrite_app::IngressRequest;
use wardrobe::api::{self, Store, Tokens};
use wardrobe::devices::MAX_DEVICES;
use wardrobe::time::parse_instant;

const OWNER: &str = "owner-token-for-tests";
const ASSISTANT: &str = "assistant-token-for-tests";
const AT: &str = "2026-10-12T09:00:00Z";
const LATER: &str = "2026-10-12T10:00:00Z";
const TOKEN: &str = "A0A1A2A3A4A5A6A7A8A9AAABACADAEAFB0B1B2B3B4B5B6B7B8B9BABBBCBDBEBF";
const OTHER_TOKEN: &str = "c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf";

#[derive(Default, Clone, PartialEq)]
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

async fn send(store: &mut MemStore, at: &str, token: &str, method: &str, path: &str, body: Value) -> (u16, Value) {
    let bytes = if body.is_null() { Vec::new() } else { serde_json::to_vec(&body).unwrap() };
    let mut req = IngressRequest::new(method, path, bytes);
    req.headers = vec![("authorization".into(), format!("Bearer {token}"))];
    let tokens = Tokens { owner: Some(OWNER.into()), assistant: Some(ASSISTANT.into()), public_origin: None, ..Default::default() };
    let reply = api::handle(store, &tokens, parse_instant(at).unwrap(), &req).await;
    let (_, bytes) = reply.content();
    (reply.status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn registration(device: &str, token: &str) -> Value {
    json!({"deviceId": device, "token": token, "environment": "development"})
}

#[tokio::test]
async fn a_device_registers_refreshes_moves_its_token_and_is_removed_and_its_token_is_never_returned() {
    let mut store = MemStore::default();
    let (status, empty) = send(&mut store, AT, OWNER, "GET", "/v1/devices", Value::Null).await;
    assert_eq!((status, empty), (200, json!({"deliveryConfigured": false, "devices": []})));

    let (status, device) = send(&mut store, AT, OWNER, "POST", "/v1/devices", registration("device-0000-aaaa", TOKEN)).await;
    assert_eq!((status, device), (200, json!({"deviceId": "device-0000-aaaa", "environment": "development", "status": "active", "disabledReason": null, "updatedAt": AT, "lastDeliveryAt": null})));
    let (_, listed) = send(&mut store, AT, OWNER, "GET", "/v1/devices", Value::Null).await;
    assert_eq!(listed["devices"], json!([{"deviceId": "device-0000-aaaa", "environment": "development", "status": "active", "disabledReason": null, "updatedAt": AT, "lastDeliveryAt": null}]));
    assert!(!listed.to_string().to_ascii_lowercase().contains(&TOKEN.to_ascii_lowercase()), "the token is never returned: {listed}");
    // Kept (lower-cased) for a later dispatcher, in the app's private storage only.
    assert!(String::from_utf8_lossy(&store.data[b"devices".as_slice()]).contains(&TOKEN.to_ascii_lowercase()));

    // The same device registering again is refreshed, not duplicated; the same token under a new
    // installation ID moves there (one phone, one registration).
    send(&mut store, LATER, OWNER, "POST", "/v1/devices", json!({"deviceId": "device-0000-aaaa", "token": OTHER_TOKEN, "environment": "production"})).await;
    let (_, listed) = send(&mut store, LATER, OWNER, "GET", "/v1/devices", Value::Null).await;
    assert_eq!((listed["devices"].as_array().unwrap().len(), listed["devices"][0]["environment"].clone(), listed["devices"][0]["updatedAt"].clone()), (1, json!("production"), json!(LATER)));
    send(&mut store, LATER, OWNER, "POST", "/v1/devices", registration("device-1111-bbbb", OTHER_TOKEN)).await;
    let (_, listed) = send(&mut store, LATER, OWNER, "GET", "/v1/devices", Value::Null).await;
    let ids: Vec<&str> = listed["devices"].as_array().unwrap().iter().map(|d| d["deviceId"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["device-1111-bbbb"]);

    let (status, removed) = send(&mut store, LATER, OWNER, "POST", "/v1/devices/device-1111-bbbb/remove", json!({})).await;
    assert_eq!((status, removed), (200, json!({"removed": true})));
    let (status, again) = send(&mut store, LATER, OWNER, "POST", "/v1/devices/device-1111-bbbb/remove", json!({})).await;
    assert_eq!((status, again), (200, json!({"removed": false})));
    assert_eq!(send(&mut store, LATER, OWNER, "GET", "/v1/devices", Value::Null).await.1["devices"], json!([]));
}

#[tokio::test]
async fn a_bad_registration_is_refused_and_writes_nothing() {
    let mut store = MemStore::default();
    for (body, says) in [
        (json!({"deviceId": "device-0000-aaaa", "token": "not-hex", "environment": "development"}), "not a device token"),
        (json!({"deviceId": "device-0000-aaaa", "token": "abcd", "environment": "development"}), "not a device token"),
        (json!({"deviceId": "short", "token": TOKEN, "environment": "development"}), "deviceId"),
        (json!({"deviceId": "device/0000/aaaa", "token": TOKEN, "environment": "development"}), "deviceId"),
        (json!({"deviceId": "device-0000-aaaa", "token": TOKEN, "environment": "staging"}), "environment"),
        (json!({"deviceId": "device-0000-aaaa", "token": TOKEN, "environment": "development", "label": "x"}), "'label' is not a field"),
        (json!([]), "JSON object"),
    ] {
        let (status, e) = send(&mut store, AT, OWNER, "POST", "/v1/devices", body.clone()).await;
        assert_eq!((status, e["error"]["code"].clone()), (400, json!("invalid_command")), "{body}: {e}");
        assert!(e["error"]["message"].as_str().unwrap().contains(says), "{body}: {e}");
    }
    assert!(store.data.is_empty(), "a refused registration writes nothing");

    // The server keeps a bounded number of devices; one more is refused, not silently dropped.
    for i in 0..MAX_DEVICES {
        let token = format!("{:064x}", i + 1);
        assert_eq!(send(&mut store, AT, OWNER, "POST", "/v1/devices", registration(&format!("device-{i:08}"), &token)).await.0, 200);
    }
    let (status, e) = send(&mut store, AT, OWNER, "POST", "/v1/devices", registration("device-overflow", OTHER_TOKEN)).await;
    assert_eq!((status, e["error"]["code"].clone()), (409, json!("precondition_failed")), "{e}");
    // An existing device still refreshes at the limit.
    assert_eq!(send(&mut store, LATER, OWNER, "POST", "/v1/devices", registration("device-00000000", OTHER_TOKEN)).await.0, 200);
}

#[tokio::test]
async fn connections_are_an_honest_empty_list_and_settings_routes_are_the_owners() {
    let mut store = MemStore::default();
    let (status, list) = send(&mut store, AT, OWNER, "GET", "/v1/connections", Value::Null).await;
    assert_eq!((status, list), (200, json!({"connections": [], "readAt": AT})));
    // Registering one says it is not ported; any connection named is not found.
    let (status, e) = send(&mut store, AT, OWNER, "POST", "/v1/connections", json!({"clientRequestId": "connect-00000001", "kind": "google_workspace", "name": "Google", "auth": {"type": "oauth"}})).await;
    assert_eq!((status, e["error"]["code"].clone()), (501, json!("module_unavailable")), "{e}");
    for (method, path) in [("POST", "/v1/connections/con_1/capabilities"), ("POST", "/v1/connections/con_1/disconnect"), ("POST", "/v1/connections/con_1/reconnect"), ("GET", "/v1/connections/con_1/calendars")] {
        let (status, e) = send(&mut store, AT, OWNER, method, path, json!({"enabled": []})).await;
        assert_eq!((status, e["error"]["code"].clone()), (404, json!("not_found")), "{path}: {e}");
    }
    // A connected assistant manages none of these.
    for (method, path) in [("GET", "/v1/devices"), ("POST", "/v1/devices"), ("POST", "/v1/devices/device-0000-aaaa/remove"), ("GET", "/v1/assistants"), ("POST", "/v1/assistants/grt_1/disconnect"), ("GET", "/v1/connections")] {
        let (status, e) = send(&mut store, AT, ASSISTANT, method, path, registration("device-0000-aaaa", TOKEN)).await;
        assert_eq!((status, e["error"]["code"].clone()), (403, json!("forbidden")), "{path}: {e}");
    }
    assert!(store.data.is_empty());
}
