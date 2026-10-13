//! Optional comfort feedback through the command path, as the iOS client and a connected assistant
//! send it: `feedback.record` applies at once with a receipt and an undo (owner decision of
//! 2026-10-05), `feedback.retract` withdraws a note for good, and `GET /v1/feedback` lists the notes
//! still active, newest first.
//!
//! The store is an in-memory test double of the APE binding (the same guarded-commit semantics); the
//! garments are the real seed.

use std::collections::BTreeMap;
use std::io;

use ferrite_app::serde_json::{self, json, Value};
use ferrite_app::IngressRequest;
use wardrobe::api::{self, Store, Tokens};
use wardrobe::feedback::MAX_ACTIVE;
use wardrobe::seed::catalogue;
use wardrobe::sha256::hex_digest;
use wardrobe::time::parse_instant;

const OWNER: &str = "owner-token-for-tests";
const ASSISTANT: &str = "assistant-token-for-tests";
const OXFORD_BLUE: &str = "gmt_3894b6a6295908d5e687af4f";
const NB_GREY: &str = "gmt_14bc4338d6760f6a13434b2f";
const GREY_CHINO: &str = "gmt_b8744c2627cd88a3b937f851";

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

fn now() -> u64 {
    parse_instant("2026-10-12T09:00:00Z").unwrap()
}

async fn send(store: &mut MemStore, token: &str, method: &str, path: &str, body: Value) -> (u16, Value) {
    let bytes = if body.is_null() { Vec::new() } else { serde_json::to_vec(&body).unwrap() };
    let mut req = IngressRequest::new(method, path, bytes);
    req.headers = vec![("authorization".into(), format!("Bearer {token}"))];
    let tokens = Tokens { owner: Some(OWNER.into()), assistant: Some(ASSISTANT.into()), public_origin: None, ..Default::default() };
    let reply = api::handle(store, &tokens, now(), &req).await;
    let (_, bytes) = reply.content();
    (reply.status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn command(store: &mut MemStore, key: &str, kind: &str, payload: Value) -> (u16, Value) {
    let envelope = json!({"type": kind, "payload": payload, "idempotencyKey": key, "authorization": "owner_tap", "source": {"channel": "ios"}});
    send(store, OWNER, "POST", "/v1/commands", envelope).await
}

async fn notes(store: &mut MemStore, query: &str) -> Vec<Value> {
    let (status, body) = send(store, OWNER, "GET", &format!("/v1/feedback{query}"), Value::Null).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body.as_object().unwrap().len(), 1, "{body}");
    body["feedback"].as_array().unwrap().clone()
}

async fn revision(store: &mut MemStore) -> u64 {
    let (_, wardrobe) = send(store, OWNER, "GET", "/v1/wardrobe", Value::Null).await;
    wardrobe["wardrobeRevision"].as_u64().unwrap_or_else(|| panic!("no revision in {wardrobe}"))
}

fn name(id: &str) -> String {
    catalogue().get(id).unwrap().name.clone()
}

#[tokio::test]
async fn a_note_applies_at_once_lists_without_the_owners_words_in_the_receipt_and_undo_withdraws_it() {
    let mut store = MemStore::default();
    let words = "these shoes hurt after an hour";
    let (status, receipt) = command(&mut store, "feedback-0001", "feedback.record", json!({"text": words, "kind": "pain", "garmentIds": [NB_GREY], "wearingDate": "2026-10-11", "activity": "walking to the station"})).await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(receipt["outcome"], "committed");
    assert_eq!(receipt["summary"], format!("Noted: {} was painful (walking to the station). Applied to that context only", name(NB_GREY)));
    assert!(!receipt.to_string().contains(words), "the receipt repeats the owner's words: {receipt}");
    let feedback_id = receipt["result"]["feedbackId"].as_str().unwrap().to_string();
    assert!(feedback_id.starts_with("cfb_"), "{feedback_id}");
    assert_eq!(receipt["result"], json!({"feedbackId": feedback_id, "garmentIds": [NB_GREY], "pain": true, "scope": null}));
    assert_eq!(receipt["undo"], json!({"available": true, "reason": null}));
    assert_eq!(receipt["affected"], json!([{"kind": "comfort_feedback", "id": feedback_id, "version": 1}, {"kind": "garment_feedback", "id": NB_GREY, "version": 1}]));

    let listed = notes(&mut store, "").await;
    assert_eq!(listed.len(), 1);
    assert_eq!(
        listed[0],
        json!({
            "feedbackId": feedback_id, "text": words, "kind": "pain", "pain": true, "garmentIds": [NB_GREY], "wearingDate": "2026-10-11",
            "activity": "walking to the station", "layer": null, "conditions": {}, "scope": null, "status": "active", "createdAt": "2026-10-12T09:00:00Z",
        })
    );
    assert_eq!(notes(&mut store, &format!("?garmentId={NB_GREY}")).await.len(), 1);
    assert!(notes(&mut store, &format!("?garmentId={OXFORD_BLUE}")).await.is_empty(), "a note about other garments is not listed for this one");

    // The same request again replays its receipt; the same note under a new key is a noop with no undo.
    let (_, replay) = command(&mut store, "feedback-0001", "feedback.record", json!({"text": words, "kind": "pain", "garmentIds": [NB_GREY], "wearingDate": "2026-10-11", "activity": "walking to the station"})).await;
    assert_eq!((replay["replayed"].clone(), replay["commandId"].clone()), (json!(true), receipt["commandId"].clone()));
    let (status, again) = command(&mut store, "feedback-0002", "feedback.record", json!({"feedbackId": feedback_id, "text": "something else", "kind": "positive"})).await;
    assert_eq!(status, 200, "{again}");
    assert_eq!((again["outcome"].clone(), again["summary"].clone(), again["result"].clone()), (json!("noop"), json!("That observation was already noted"), json!({"feedbackId": feedback_id})));
    assert_eq!(again["undo"], json!({"available": false, "reason": "nothing changed"}));
    assert_eq!(notes(&mut store, "").await[0]["kind"], "pain", "the stored note is unchanged");

    let (status, undone) = command(&mut store, "feedback-0003", "command.undo", json!({"commandId": receipt["commandId"]})).await;
    assert_eq!(status, 200, "{undone}");
    assert_eq!(undone["summary"], format!("Undone: {}. Comfort note withdrawn", receipt["summary"].as_str().unwrap().trim_end_matches('.')));
    assert_eq!(undone["result"], json!({"undoneCommandId": receipt["commandId"]}));
    assert_eq!(undone["undo"]["available"], false);
    assert!(notes(&mut store, "").await.is_empty(), "a withdrawn note no longer lists");
    let (_, original) = send(&mut store, OWNER, "GET", &format!("/v1/commands/{}", receipt["commandId"].as_str().unwrap()), Value::Null).await;
    assert_eq!(original["undo"], json!({"available": false, "reason": "this action was already undone"}));
    let (status, twice) = command(&mut store, "feedback-0004", "command.undo", json!({"commandId": receipt["commandId"]})).await;
    assert_eq!((status, twice["error"]["code"].clone()), (409, json!("not_undoable")), "{twice}");
}

#[tokio::test]
async fn a_withdrawal_is_final_and_a_missing_note_writes_nothing() {
    let mut store = MemStore::default();
    let (status, missing) = command(&mut store, "retract-0001", "feedback.retract", json!({"feedbackId": "cfb_nope"})).await;
    assert_eq!((status, missing["error"]["code"].clone()), (404, json!("not_found")), "{missing}");
    assert_eq!(revision(&mut store).await, 0, "nothing was written");

    let (_, a) = command(&mut store, "retract-0002", "feedback.record", json!({"feedbackId": "cfb_collar", "text": "collar scratched all day", "kind": "scratchy", "garmentIds": [OXFORD_BLUE], "scope": "office days"})).await;
    assert_eq!(a["result"]["scope"], "office days");
    let (_, b) = command(&mut store, "retract-0003", "feedback.record", json!({"text": "too warm on the train", "kind": "too_warm", "garmentIds": [GREY_CHINO, OXFORD_BLUE], "conditions": {"heating": true}})).await;
    assert_eq!(b["summary"], format!("Noted: {}, {} were too warm. Applied to that context only", name(GREY_CHINO), name(OXFORD_BLUE)));
    let listed = notes(&mut store, "").await;
    let ids: Vec<&str> = listed.iter().map(|n| n["feedbackId"].as_str().unwrap()).collect();
    assert_eq!(ids, [b["result"]["feedbackId"].as_str().unwrap(), "cfb_collar"], "newest first");
    assert_eq!(notes(&mut store, &format!("?garmentId={OXFORD_BLUE}")).await.len(), 2);

    let (status, withdrawn) = command(&mut store, "retract-0004", "feedback.retract", json!({"feedbackId": "cfb_collar", "reason": "it was the new shirt"})).await;
    assert_eq!(status, 200, "{withdrawn}");
    assert_eq!(withdrawn["summary"], "Comfort note withdrawn; it no longer affects suggestions");
    assert_eq!(withdrawn["undo"], json!({"available": false, "reason": "record the observation again to restore it"}));
    assert_eq!(withdrawn["affected"], json!([{"kind": "comfort_feedback", "id": "cfb_collar", "version": 2}]));
    assert_eq!(notes(&mut store, "").await.len(), 1);
    let (_, again) = command(&mut store, "retract-0005", "feedback.retract", json!({"feedbackId": "cfb_collar"})).await;
    assert_eq!((again["outcome"].clone(), again["summary"].clone()), (json!("noop"), json!("That comfort note was already withdrawn")));
    // Undoing the note after its withdrawal changes nothing more, and it stays withdrawn.
    let (status, undone) = command(&mut store, "retract-0006", "command.undo", json!({"commandId": a["commandId"]})).await;
    assert_eq!(status, 200, "{undone}");
    assert_eq!(undone["affected"], json!([]));
    assert_eq!(notes(&mut store, "").await.len(), 1);
    // A note already on record under that ID is not recorded again, even after its withdrawal.
    let (_, repeat) = command(&mut store, "retract-0007", "feedback.record", json!({"feedbackId": "cfb_collar", "text": "collar scratched again", "kind": "scratchy"})).await;
    assert_eq!(repeat["outcome"], "noop");
}

#[tokio::test]
async fn invalid_notes_are_refused_and_nothing_is_written() {
    let mut store = MemStore::default();
    for (key, payload, code, says) in [
        ("invalid-0001", json!({"text": "hurts", "kind": "pain", "garmentIds": ["gmt_not_mine"]}), "not_found", "unknown garment: gmt_not_mine"),
        ("invalid-0002", json!({"text": "hurts", "kind": "itchy"}), "invalid_command", "kind: expected one of"),
        ("invalid-0003", json!({"text": "", "kind": "pain"}), "invalid_command", "text:"),
        ("invalid-0004", json!({"text": "hurts", "kind": "pain", "wearingDate": "yesterday"}), "invalid_command", "wearingDate"),
        ("invalid-0005", json!({"text": "hurts", "kind": "pain", "conditions": {"x": "y".repeat(5000)}}), "invalid_command", "conditions: at most"),
        ("invalid-0006", json!({"text": "hurts", "kind": "pain", "admin": true}), "invalid_command", "admin: not a field"),
    ] {
        let (status, body) = command(&mut store, key, "feedback.record", payload).await;
        assert_ne!(status, 200, "{body}");
        assert_eq!(body["error"]["code"], code, "{body}");
        assert!(body.to_string().contains(says), "expected '{says}' in {body}");
    }
    assert_eq!(revision(&mut store).await, 0);
    assert!(notes(&mut store, "").await.is_empty());
}

#[tokio::test]
async fn a_connected_assistant_relays_the_owners_note_but_cannot_tap() {
    let mut store = MemStore::default();
    let relayed = json!({"type": "feedback.record", "payload": {"text": "the oxford collar scratched", "kind": "scratchy", "garmentIds": [OXFORD_BLUE]}, "idempotencyKey": "assistant-0001", "authorization": "owner_statement", "source": {"channel": "mcp"}});
    let receipt = api::execute(&mut store, api::ASSISTANT, now(), &relayed).await.unwrap();
    assert_eq!((receipt["outcome"].clone(), receipt["actor"].clone(), receipt["channel"].clone()), (json!("committed"), json!("assistant"), json!("mcp")));
    assert_eq!(receipt["undo"]["available"], true, "applies at once with an undo (2026-10-05)");
    let mut tap = relayed.clone();
    tap["authorization"] = json!("owner_tap");
    tap["idempotencyKey"] = json!("assistant-0002");
    assert_eq!(api::execute(&mut store, api::ASSISTANT, now(), &tap).await.unwrap_err().code, "forbidden");
    // The assistant's undo of its own relayed note is the owner's word too, and is allowed.
    let undo = json!({"type": "command.undo", "payload": {"commandId": receipt["commandId"]}, "idempotencyKey": "assistant-0003", "authorization": "owner_statement", "source": {"channel": "mcp"}});
    assert_eq!(api::execute(&mut store, api::ASSISTANT, now(), &undo).await.unwrap()["outcome"], "committed");
    assert!(notes(&mut store, "").await.is_empty());
}

#[tokio::test]
async fn active_notes_are_bounded_and_a_withdrawal_makes_room() {
    let mut store = MemStore::default();
    for i in 0..MAX_ACTIVE {
        let (status, body) = command(&mut store, &format!("bound-{i:04}"), "feedback.record", json!({"feedbackId": format!("cfb_{i}"), "text": "fine", "kind": "positive"})).await;
        assert_eq!(status, 200, "{body}");
    }
    let (status, full) = command(&mut store, "bound-full", "feedback.record", json!({"text": "one more", "kind": "positive"})).await;
    assert_eq!((status, full["error"]["details"]["reason"].clone()), (409, json!("too_many_comfort_notes")), "{full}");
    command(&mut store, "bound-retract", "feedback.retract", json!({"feedbackId": "cfb_0"})).await;
    let (status, body) = command(&mut store, "bound-again", "feedback.record", json!({"text": "one more", "kind": "positive"})).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(notes(&mut store, "").await.len(), MAX_ACTIVE);
}

#[tokio::test]
async fn a_generated_id_never_lands_on_a_note_a_caller_already_named() {
    let mut store = MemStore::default();
    // The ID the next request would generate on its first attempt (`new_command_id` in api.rs).
    let cmd_hex = hex_digest(format!("collide-0002\u{0}{}\u{0}1", now()).as_bytes())[..32].to_string();
    let taken = format!("cfb_{cmd_hex}");
    let (_, first) = command(&mut store, "collide-0001", "feedback.record", json!({"feedbackId": taken, "text": "collar scratched", "kind": "scratchy"})).await;
    assert_eq!(first["outcome"], "committed", "{first}");
    let (status, second) = command(&mut store, "collide-0002", "feedback.record", json!({"text": "too warm on the train", "kind": "too_warm"})).await;
    assert_eq!((status, second["outcome"].clone()), (200, json!("committed")), "{second}");
    assert_eq!(second["commandId"], format!("cmd_{cmd_hex}"), "the prediction above matches the executor");
    assert_eq!(second["result"]["feedbackId"], format!("{taken}_1"), "the next free ID");
    let listed = notes(&mut store, "").await;
    let kinds: Vec<(&str, &str)> = listed.iter().map(|n| (n["feedbackId"].as_str().unwrap(), n["kind"].as_str().unwrap())).collect();
    let next = format!("{taken}_1");
    assert_eq!(kinds, [(next.as_str(), "too_warm"), (taken.as_str(), "scratchy")], "neither note overwrote the other");
    assert_eq!(revision(&mut store).await, 2, "the ledger still reads");
}

#[tokio::test]
async fn a_repeat_of_a_recorded_id_is_a_noop_before_anything_in_it_is_looked_up() {
    let mut store = MemStore::default();
    command(&mut store, "repeat-0001", "feedback.record", json!({"feedbackId": "cfb_shoe", "text": "fine", "kind": "positive", "garmentIds": [NB_GREY]})).await;
    let (status, repeat) = command(&mut store, "repeat-0002", "feedback.record", json!({"feedbackId": "cfb_shoe", "text": "hurts", "kind": "pain", "garmentIds": ["gmt_not_mine"]})).await;
    assert_eq!((status, repeat["outcome"].clone(), repeat["result"].clone()), (200, json!("noop"), json!({"feedbackId": "cfb_shoe"})), "{repeat}");
    assert_eq!(notes(&mut store, "").await[0]["garmentIds"], json!([NB_GREY]));
}

#[tokio::test]
async fn a_tampered_note_record_is_refused_rather_than_read_as_absent() {
    let mut store = MemStore::default();
    command(&mut store, "tamper-0001", "feedback.record", json!({"feedbackId": "cfb_t", "text": "fine", "kind": "positive"})).await;
    store.data.insert(b"fb/cfb_t".to_vec(), br#"{"feedbackId":"cfb_t"}"#.to_vec());
    let (status, body) = send(&mut store, OWNER, "GET", "/v1/feedback", Value::Null).await;
    assert_eq!((status, body["error"]["code"].clone()), (500, json!("internal")), "{body}");
    let (status, body) = command(&mut store, "tamper-0002", "feedback.retract", json!({"feedbackId": "cfb_t"})).await;
    assert_eq!((status, body["error"]["code"].clone()), (500, json!("internal")), "{body}");
}
