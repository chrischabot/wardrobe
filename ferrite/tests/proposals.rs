//! The owner's proposals through the request handler: `GET /v1/proposals` and
//! `POST /v1/proposals/{id}/decision`. Only the owner in the app lists or decides them; a connected
//! assistant is refused (`owner_in_app_required`), so it can never confirm what it proposed. This port
//! creates no proposals (none of its commands waits for the owner), so the list is empty and a decision,
//! once the request is valid, names a proposal that does not exist. Nothing is written either way.
//!
//! The store is an in-memory test double of the APE binding (the same guarded-commit semantics).

use std::collections::BTreeMap;
use std::io;

use ferrite_app::serde_json::{self, json, Value};
use ferrite_app::IngressRequest;
use wardrobe::api::{self, Store, Tokens};

const OWNER_TOKEN: &str = "owner-token-for-tests";
const ASSISTANT_TOKEN: &str = "assistant-token-for-tests";
const T0: u64 = 1_789_000_000_000; // 2026-09-10T00:26:40Z

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

async fn send(store: &mut MemStore, token: Option<&str>, method: &str, path: &str, body: &str) -> (u16, Value) {
    let mut req = IngressRequest::new(method, path, body.as_bytes().to_vec());
    if let Some(t) = token {
        req.headers = vec![("authorization".into(), format!("Bearer {t}"))];
    }
    let tokens = Tokens { owner: Some(OWNER_TOKEN.into()), assistant: Some(ASSISTANT_TOKEN.into()), public_origin: None, ..Default::default() };
    let reply = api::handle(store, &tokens, T0, &req).await;
    let (_, bytes) = reply.content();
    (reply.status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test]
async fn the_owner_reads_an_empty_list_and_a_decision_names_no_proposal() {
    let mut store = MemStore::default();
    for path in ["/v1/proposals", "/v1/proposals?state=pending", "/v1/proposals?state=all"] {
        let (status, list) = send(&mut store, Some(OWNER_TOKEN), "GET", path, "").await;
        assert_eq!((status, list), (200, json!({"proposals": [], "pending": 0, "readAt": "2026-09-10T00:26:40Z"})), "{path}");
    }
    let (status, e) = send(&mut store, Some(OWNER_TOKEN), "GET", "/v1/proposals?state=decided", "").await;
    assert_eq!((status, e["error"]["code"].clone()), (400, json!("invalid_command")));

    for decision in [r#"{"decision": "confirm"}"#, r#"{"decision": "reject"}"#, r#"{"decision": "confirm", "acknowledgedRestrictionIds": ["rst_profile_sneakers_only"]}"#] {
        let (status, e) = send(&mut store, Some(OWNER_TOKEN), "POST", "/v1/proposals/prp_0123/decision", decision).await;
        assert_eq!((status, e["error"]["code"].clone(), e["error"]["message"].clone()), (404, json!("not_found"), json!("that proposal was not found")), "{decision}");
    }
    // A malformed decision is refused before any proposal is looked up.
    for (body, reason) in [
        (r#"{"decision": "approve"}"#, None),
        (r#"{}"#, None),
        ("not json", None),
        (r#"{"decision": "confirm", "acknowledgedRestrictionIds": []}"#, None),
        (r#"{"decision": "reject", "acknowledgedRestrictionIds": ["rst_profile_sneakers_only"]}"#, Some("acknowledgement_on_reject")),
    ] {
        let (status, e) = send(&mut store, Some(OWNER_TOKEN), "POST", "/v1/proposals/prp_0123/decision", body).await;
        assert_eq!((status, e["error"]["code"].clone()), (400, json!("invalid_command")), "{body}: {e}");
        if let Some(r) = reason {
            assert_eq!(e["error"]["details"]["reason"], r);
        }
    }
    assert!(store.data.is_empty(), "nothing was written");
}

#[tokio::test]
async fn a_connected_assistant_can_neither_list_nor_decide_a_proposal() {
    let mut store = MemStore::default();
    let (status, e) = send(&mut store, Some(ASSISTANT_TOKEN), "GET", "/v1/proposals", "").await;
    assert_eq!((status, e["error"]["code"].clone(), e["error"]["details"]["reason"].clone()), (403, json!("forbidden"), json!("owner_in_app_required")));
    // Refused before the body is read: even a well-formed confirmation of its own request.
    for body in [r#"{"decision": "confirm"}"#, "not json"] {
        let (status, e) = send(&mut store, Some(ASSISTANT_TOKEN), "POST", "/v1/proposals/prp_0123/decision", body).await;
        assert_eq!((status, e["error"]["details"]["reason"].clone()), (403, json!("owner_in_app_required")), "{body}");
    }
    // Without a sign-in at all, nothing is answered.
    let (status, _) = send(&mut store, None, "GET", "/v1/proposals", "").await;
    assert_eq!(status, 401);
    // Other paths under /v1/proposals are not routes.
    for (method, path) in [("POST", "/v1/proposals//decision"), ("GET", "/v1/proposals/prp_0123"), ("POST", "/v1/proposals/prp_0123/confirm")] {
        let (status, e) = send(&mut store, Some(OWNER_TOKEN), method, path, r#"{"decision": "confirm"}"#).await;
        assert_eq!((status, e["error"]["message"].clone()), (404, json!("no such route")), "{method} {path}");
    }
    assert!(store.data.is_empty(), "nothing was written");
}
