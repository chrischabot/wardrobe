//! The command service against a store that fails on purpose (a test double
//! for the APE binding, standing in for lost responses and failed reads that
//! the local harness cannot produce): whenever it cannot be settled whether a
//! request was written, the answer says the outcome is unknown, never that
//! nothing was written; and a request another executor committed is replayed,
//! not applied twice.

use std::collections::BTreeMap;
use std::io;

use ferrite_app::serde_json::{json, Value};
use wardrobe::api::{self, Store, ASSISTANT};
use wardrobe::ledger::Ledger;
use wardrobe::seed::catalogue;

#[derive(Default, Clone)]
struct FakeStore {
    data: BTreeMap<Vec<u8>, Vec<u8>>,
    /// Reads of the ledger fail.
    fail_ledger_reads: bool,
    /// Reads of idempotency markers (`i/...`) fail.
    fail_marker_reads: bool,
    /// The next N commits are applied but answer with a transport error.
    lose_commit_responses: usize,
    /// Every commit answers with a transport error and is not applied.
    drop_commits: bool,
    /// On the first marker read: answer "absent", then the store becomes this
    /// state, as if another executor committed right after that read.
    after_first_marker_read: Option<BTreeMap<Vec<u8>, Vec<u8>>>,
    commits: usize,
}

fn transport() -> io::Error {
    io::Error::new(io::ErrorKind::Other, "connection reset")
}

impl Store for FakeStore {
    async fn get(&mut self, key: &[u8]) -> io::Result<Option<Vec<u8>>> {
        if key == b"ledger" && self.fail_ledger_reads {
            return Err(transport());
        }
        if key.starts_with(b"i/") {
            if self.fail_marker_reads {
                return Err(transport());
            }
            if let Some(next) = self.after_first_marker_read.take() {
                let answer = self.data.get(key).cloned();
                self.data = next;
                return Ok(answer);
            }
        }
        Ok(self.data.get(key).cloned())
    }

    async fn commit_n_if(&mut self, guard: &[u8], expected: Option<&[u8]>, entries: &[(&[u8], &[u8])]) -> io::Result<Result<(), Option<Vec<u8>>>> {
        if self.drop_commits {
            return Err(transport());
        }
        let current = self.data.get(guard).cloned();
        if current.as_deref() != expected {
            return Ok(Err(current));
        }
        for (k, v) in entries {
            self.data.insert(k.to_vec(), v.to_vec());
        }
        self.commits += 1;
        if self.lose_commit_responses > 0 {
            self.lose_commit_responses -= 1;
            return Err(transport());
        }
        Ok(Ok(()))
    }
}

const NOW: u64 = 1_789_000_000_000;

fn shirt() -> String {
    shirts(1).remove(0)
}

fn shirts(n: usize) -> Vec<String> {
    catalogue().garments.iter().filter(|g| g.care_channel == "service" && g.quantity == 1).take(n).map(|g| g.id.clone()).collect()
}

fn dirty_two(key: &str) -> Value {
    let items: Vec<Value> = shirts(2).into_iter().map(|id| json!({"garmentId": id})).collect();
    json!({"type": "care.mark_dirty", "payload": {"items": items}, "idempotencyKey": key, "authorization": "owner_statement", "source": {"channel": "mcp"}})
}

fn dirty(key: &str) -> Value {
    json!({"type": "care.mark_dirty", "payload": {"items": [{"garmentId": shirt()}]}, "idempotencyKey": key, "authorization": "owner_statement", "source": {"channel": "mcp"}})
}

fn undo(target: &str, key: &str) -> Value {
    json!({"type": "command.undo", "payload": {"commandId": target}, "idempotencyKey": key, "authorization": "owner_statement", "source": {"channel": "mcp"}})
}

fn ledger_of(store: &FakeStore) -> Ledger {
    store.data.get(b"ledger".as_slice()).map(|b| Ledger::from_json(&ferrite_app::serde_json::from_slice(b).unwrap()).expect("a ledger")).unwrap_or_default()
}

fn assert_unknown(result: Result<Value, wardrobe::ledger::CmdError>) {
    let e = result.expect_err("an unknown outcome");
    assert_eq!((e.code, e.details["outcome"].clone()), ("internal", json!("unknown")), "{e:?}");
    assert!(!e.message.contains("nothing was written"), "{}", e.message);
}

#[tokio::test]
async fn a_marker_that_cannot_be_read_is_an_unknown_outcome_on_the_first_attempt() {
    let mut store = FakeStore { fail_marker_reads: true, ..FakeStore::default() };
    assert_unknown(api::execute(&mut store, ASSISTANT, NOW, &dirty("key-marker-01")).await);
    assert_eq!(store.commits, 0);

    // The same holds when an earlier executor did commit this request.
    let mut store = FakeStore::default();
    api::execute(&mut store, ASSISTANT, NOW, &dirty("key-marker-02")).await.unwrap();
    store.fail_marker_reads = true;
    assert_unknown(api::execute(&mut store, ASSISTANT, NOW, &dirty("key-marker-02")).await);
    assert_eq!(store.commits, 1);
}

#[tokio::test]
async fn a_marker_whose_receipt_or_own_record_is_unreadable_is_an_unknown_outcome() {
    // Receipt missing behind a valid marker.
    let mut store = FakeStore::default();
    let receipt = api::execute(&mut store, ASSISTANT, NOW, &dirty("key-broken-01")).await.unwrap();
    let ckey = format!("c/{}", receipt["commandId"].as_str().unwrap()).into_bytes();
    store.data.remove(&ckey);
    assert_unknown(api::execute(&mut store, ASSISTANT, NOW, &dirty("key-broken-01")).await);
    // Receipt unreadable.
    store.data.insert(ckey, b"{not json".to_vec());
    assert_unknown(api::execute(&mut store, ASSISTANT, NOW, &dirty("key-broken-01")).await);
    // Marker unreadable: neither a key reuse nor a fresh write.
    let mut store = FakeStore::default();
    let first = api::execute(&mut store, ASSISTANT, NOW, &dirty("key-broken-02")).await.unwrap();
    let marker_key = store.data.keys().find(|k| k.starts_with(b"i/")).unwrap().clone();
    for garbage in [b"garbage".to_vec(), b"{}".to_vec(), b"null".to_vec()] {
        store.data.insert(marker_key.clone(), garbage);
        assert_unknown(api::execute(&mut store, ASSISTANT, NOW, &dirty("key-broken-02")).await);
    }
    assert_eq!(store.commits, 1);
    // A matching marker pointing at a hollow receipt is not a success.
    let mut store = FakeStore::default();
    let r = api::execute(&mut store, ASSISTANT, NOW, &dirty("key-broken-03")).await.unwrap();
    store.data.insert(format!("c/{}", r["commandId"].as_str().unwrap()).into_bytes(), br#"{"receipt":{}}"#.to_vec());
    assert_unknown(api::execute(&mut store, ASSISTANT, NOW, &dirty("key-broken-03")).await);
    // A receipt missing any one field it was written with is not a success either.
    let mut store = FakeStore::default();
    let r = api::execute(&mut store, ASSISTANT, NOW, &dirty("key-broken-04")).await.unwrap();
    let ckey = format!("c/{}", r["commandId"].as_str().unwrap()).into_bytes();
    let full: Value = ferrite_app::serde_json::from_slice(&store.data[&ckey]).unwrap();
    assert_eq!(api::execute(&mut store, ASSISTANT, NOW, &dirty("key-broken-04")).await.unwrap()["replayed"], true);
    for field in [
        "commandId", "type", "outcome", "summary", "affected", "externalEffectState", "effects", "undo", "repairs",
        "result", "occurredAt", "recordedAt", "wardrobeRevision", "replayed", "actor", "channel", "contractVersion",
    ] {
        let mut hollow = full.clone();
        hollow["receipt"].as_object_mut().unwrap().remove(field);
        store.data.insert(ckey.clone(), hollow.to_string().into_bytes());
        assert_unknown(api::execute(&mut store, ASSISTANT, NOW, &dirty("key-broken-04")).await);
    }
    // Likewise each field of the record around the receipt.
    for field in ["receipt", "requestHash", "payload", "authorization", "undo", "undoneBy", "undoes"] {
        let mut hollow = full.clone();
        hollow.as_object_mut().unwrap().remove(field);
        store.data.insert(ckey.clone(), hollow.to_string().into_bytes());
        assert_unknown(api::execute(&mut store, ASSISTANT, NOW, &dirty("key-broken-04")).await);
    }
    // And fields present but malformed.
    for (path, bad) in [
        (vec!["receipt", "undo"], json!({})),
        (vec!["receipt", "undo", "available"], json!("yes")),
        (vec!["receipt", "outcome"], json!("refused")),
        (vec!["receipt", "wardrobeRevision"], json!(-1)),
        (vec!["receipt", "type"], json!("command.undo")),
        (vec!["receipt", "result"], json!({})),
        (vec!["receipt", "result", "units"], json!("1")),
        (vec!["receipt", "result", "extra"], json!(1)),
        (vec!["undo"], json!({})),
        (vec!["undo", "data"], json!({})),
        (vec!["undo", "data", "stockEventIds"], json!([])),
        (vec!["requestHash"], json!("abc")),
        (vec!["undoneBy"], json!(7)),
    ] {
        let mut hollow = full.clone();
        let (last, parents) = path.split_last().unwrap();
        let mut at = &mut hollow;
        for p in parents {
            at = &mut at[*p];
        }
        at[*last] = bad;
        store.data.insert(ckey.clone(), hollow.to_string().into_bytes());
        assert_unknown(api::execute(&mut store, ASSISTANT, NOW, &dirty("key-broken-04")).await);
    }
    // The untouched record still replays.
    store.data.insert(ckey.clone(), full.to_string().into_bytes());
    assert_eq!(api::execute(&mut store, ASSISTANT, NOW, &dirty("key-broken-04")).await.unwrap()["replayed"], true);
    assert_eq!(store.commits, 1);
    let _ = first;
}

#[tokio::test]
async fn an_undo_whose_original_record_is_malformed_is_refused_and_writes_nothing() {
    let mut base = FakeStore::default();
    let original = api::execute(&mut base, ASSISTANT, NOW, &dirty_two("key-badundo-01")).await.unwrap();
    assert_eq!(original["result"]["units"], 2);
    let target = original["commandId"].as_str().unwrap().to_string();
    let ckey = format!("c/{target}").into_bytes();
    let full: Value = ferrite_app::serde_json::from_slice(&base.data[&ckey]).unwrap();
    let ids = full["undo"]["data"]["stockEventIds"].as_array().unwrap().clone();
    assert_eq!(ids.len(), 2);
    let mut cases: Vec<Value> = [
        json!({}),
        json!({"data": {}}),
        json!({"data": {"stockEventIds": []}}),
        json!({"data": {"stockEventIds": ["evt_not_in_the_journal"]}}),
        // Part of the action, or one event twice: an undo that restores only part.
        json!({"data": {"stockEventIds": [ids[0].clone()]}}),
        json!({"data": {"stockEventIds": [ids[0].clone(), ids[0].clone()]}}),
        json!({"data": {"stockEventIds": [ids[0].clone(), ids[1].clone(), "evt_extra"]}}),
        json!(null),
    ]
    .into_iter()
    .map(|bad| {
        let mut broken = full.clone();
        broken["undo"] = bad;
        broken
    })
    .collect();
    // A dirty report that claims to have no undo, with a receipt that agrees.
    let mut no_undo = full.clone();
    no_undo["undo"] = json!({"unavailableReason": "no"});
    no_undo["receipt"]["undo"] = json!({"available": false, "reason": "no"});
    cases.push(no_undo);
    for broken in cases {
        let mut store = base.clone();
        store.commits = 0;
        store.data.insert(ckey.clone(), broken.to_string().into_bytes());
        let before = store.data.clone();
        let e = api::execute(&mut store, ASSISTANT, NOW + 1, &undo(&target, "key-badundo-02")).await.expect_err("refused");
        assert_eq!(e.code, "internal", "{}: {e:?}", broken["undo"]);
        assert_eq!(store.commits, 0, "{}", broken["undo"]);
        assert!(store.data == before, "{}: the store changed", broken["undo"]);
    }
    // The intact record is undone in full.
    let mut store = base.clone();
    let done = api::execute(&mut store, ASSISTANT, NOW + 1, &undo(&target, "key-badundo-02")).await.unwrap();
    assert_eq!(done["affected"].as_array().unwrap().len(), 2);
    assert!(ledger_of(&store).events.iter().all(|e| e.voided_by.is_some()));
}

#[tokio::test]
async fn a_malformed_undo_record_is_an_unknown_outcome_on_replay() {
    let mut store = FakeStore::default();
    let original = api::execute(&mut store, ASSISTANT, NOW, &dirty("key-undorec-01")).await.unwrap();
    let target = original["commandId"].as_str().unwrap().to_string();
    let done = api::execute(&mut store, ASSISTANT, NOW + 1, &undo(&target, "key-undorec-02")).await.unwrap();
    let ukey = format!("c/{}", done["commandId"].as_str().unwrap()).into_bytes();
    let full: Value = ferrite_app::serde_json::from_slice(&store.data[&ukey]).unwrap();
    assert_eq!(api::execute(&mut store, ASSISTANT, NOW + 1, &undo(&target, "key-undorec-02")).await.unwrap()["replayed"], true);
    let mut no_target = full.clone();
    no_target["receipt"]["result"] = json!({});
    let mut other_target = full.clone();
    other_target["receipt"]["result"] = json!({"undoneCommandId": "cmd_other"});
    let mut undoable = full.clone();
    undoable["undo"] = json!({"data": {"stockEventIds": ["evt_x"]}});
    undoable["receipt"]["undo"] = json!({"available": true, "reason": null});
    let mut no_undoes = full.clone();
    no_undoes["undoes"] = json!(null);
    for broken in [no_target, other_target, undoable, no_undoes] {
        store.data.insert(ukey.clone(), broken.to_string().into_bytes());
        assert_unknown(api::execute(&mut store, ASSISTANT, NOW + 1, &undo(&target, "key-undorec-02")).await);
    }
    assert_eq!(store.commits, 2);
}

#[tokio::test]
async fn a_retry_of_a_committed_request_is_replayed_even_when_the_ledger_cannot_be_read() {
    let mut store = FakeStore::default();
    let first = api::execute(&mut store, ASSISTANT, NOW, &dirty("key-ledger-01")).await.unwrap();
    store.fail_ledger_reads = true;
    let again = api::execute(&mut store, ASSISTANT, NOW, &dirty("key-ledger-01")).await.unwrap();
    assert_eq!((again["commandId"].clone(), again["replayed"].clone()), (first["commandId"].clone(), json!(true)));
    // With a corrupt ledger too.
    store.fail_ledger_reads = false;
    store.data.insert(b"ledger".to_vec(), b"{}".to_vec());
    assert_eq!(api::execute(&mut store, ASSISTANT, NOW, &dirty("key-ledger-01")).await.unwrap()["replayed"], true);
    // And with the marker unreadable as well, the outcome is unknown.
    store.fail_marker_reads = true;
    assert_unknown(api::execute(&mut store, ASSISTANT, NOW, &dirty("key-ledger-01")).await);
    // A new request is refused and nothing is written.
    store.fail_marker_reads = false;
    assert_eq!(api::execute(&mut store, ASSISTANT, NOW, &dirty("key-ledger-02")).await.unwrap_err().code, "internal");
    assert_eq!(store.commits, 1);
}

fn get(path: &str) -> ferrite_app::IngressRequest {
    ferrite_app::IngressRequest {
        stream_open: false,
        correlation_id: String::new(),
        idempotency_key: String::new(),
        route: "/v1/".into(),
        path: path.into(),
        method: "GET".into(),
        headers: vec![("authorization".into(), "Bearer owner-token".into())],
        body: vec![],
        deadline_ms: 0,
        reply_to: String::new(),
        published_ms: 0,
        native_caller: None,
        auth_context: None,
        verified_host: None,
    }
}

#[tokio::test]
async fn a_report_that_moves_nothing_reads_back_replays_and_undoes() {
    let tokens = api::Tokens { owner: Some("owner-token".into()), assistant: None, ..Default::default() };
    let mut store = FakeStore::default();
    api::execute(&mut store, ASSISTANT, NOW, &dirty("key-zero-0001")).await.unwrap();
    let second = api::execute(&mut store, ASSISTANT, NOW + 1, &dirty("key-zero-0002")).await.unwrap();
    assert_eq!(second["result"]["units"], 0);
    let id = second["commandId"].as_str().unwrap().to_string();
    assert_eq!(api::execute(&mut store, ASSISTANT, NOW + 1, &dirty("key-zero-0002")).await.unwrap()["replayed"], true);
    assert_eq!(api::handle(&mut store, &tokens, NOW, &get(&format!("/v1/commands/{id}"))).await.status, 200);
    let list = api::handle(&mut store, &tokens, NOW, &get("/v1/commands")).await;
    assert_eq!((list.status, list.body["receipts"].as_array().map(Vec::len)), (200, Some(2)));
    let undone = api::execute(&mut store, ASSISTANT, NOW + 2, &undo(&id, "key-zero-0003")).await.unwrap();
    assert_eq!(undone["outcome"], "committed");
}

#[tokio::test]
async fn a_corrupt_record_is_an_error_when_read_never_absent_or_partial() {
    let tokens = api::Tokens { owner: Some("owner-token".into()), assistant: None, ..Default::default() };
    let mut store = FakeStore::default();
    let r = api::execute(&mut store, ASSISTANT, NOW, &dirty("key-get-0001")).await.unwrap();
    let id = r["commandId"].as_str().unwrap().to_string();
    let ckey = format!("c/{id}").into_bytes();
    let full = store.data[&ckey].clone();
    let ok = api::handle(&mut store, &tokens, NOW, &get(&format!("/v1/commands/{id}"))).await;
    assert_eq!((ok.status, ok.body["commandId"].clone()), (200, json!(id)));
    let mut hollow: Value = ferrite_app::serde_json::from_slice(&full).unwrap();
    hollow["receipt"].as_object_mut().unwrap().remove("affected");
    for corrupt in [b"{not json".to_vec(), b"{}".to_vec(), hollow.to_string().into_bytes()] {
        store.data.insert(ckey.clone(), corrupt);
        let one = api::handle(&mut store, &tokens, NOW, &get(&format!("/v1/commands/{id}"))).await;
        assert_eq!((one.status, one.body["error"]["code"].clone()), (500, json!("internal")), "{}", one.body);
        let list = api::handle(&mut store, &tokens, NOW, &get("/v1/commands")).await;
        assert_eq!(list.status, 500, "{}", list.body);
    }
    // A record the ledger lists but the store lacks is corrupt too.
    store.data.remove(&ckey);
    assert_eq!(api::handle(&mut store, &tokens, NOW, &get("/v1/commands")).await.status, 500);
    // An ID that was never written is simply not found.
    assert_eq!(api::handle(&mut store, &tokens, NOW, &get("/v1/commands/cmd_never")).await.status, 404);
}

#[tokio::test]
async fn a_corrupt_ledger_is_refused_and_never_overwritten() {
    for corrupt in [b"{}".to_vec(), b"null".to_vec(), b"not json".to_vec()] {
        let mut store = FakeStore::default();
        store.data.insert(b"ledger".to_vec(), corrupt.clone());
        let e = api::execute(&mut store, ASSISTANT, NOW, &dirty("key-corrupt-01")).await.expect_err("refused");
        assert_eq!(e.code, "internal");
        assert_eq!(store.commits, 0);
        assert_eq!(store.data.get(b"ledger".as_slice()), Some(&corrupt));
    }
}

#[tokio::test]
async fn a_commit_whose_response_was_lost_is_replayed_not_repeated() {
    let mut store = FakeStore { lose_commit_responses: 1, ..FakeStore::default() };
    let receipt = api::execute(&mut store, ASSISTANT, NOW, &dirty("key-lost-0001")).await.unwrap();
    assert_eq!(receipt["replayed"], true);
    assert_eq!(store.commits, 1);
    let l = ledger_of(&store);
    assert_eq!((l.revision, l.events.len()), (1, 1));
}

#[tokio::test]
async fn a_commit_that_is_never_confirmed_is_an_unknown_outcome() {
    let mut store = FakeStore { drop_commits: true, ..FakeStore::default() };
    assert_unknown(api::execute(&mut store, ASSISTANT, NOW, &dirty("key-drop-0001")).await);
}

#[tokio::test]
async fn the_same_request_committed_by_another_executor_is_replayed() {
    // What the other executor's commit leaves behind.
    let mut other = FakeStore::default();
    let winner = api::execute(&mut other, ASSISTANT, NOW, &dirty("key-race-0001")).await.unwrap();

    // This executor reads the ledger and an absent marker, then the other commits.
    let mut store = FakeStore { after_first_marker_read: Some(other.data.clone()), ..FakeStore::default() };
    let receipt = api::execute(&mut store, ASSISTANT, NOW, &dirty("key-race-0001")).await.unwrap();
    assert_eq!((receipt["commandId"].clone(), receipt["replayed"].clone()), (winner["commandId"].clone(), json!(true)));
    assert_eq!((store.commits, ledger_of(&store).events.len()), (0, 1));
}

#[tokio::test]
async fn an_undo_committed_by_another_executor_is_replayed_not_refused() {
    let mut base = FakeStore::default();
    let original = api::execute(&mut base, ASSISTANT, NOW, &dirty("key-undo-0001")).await.unwrap();
    let target = original["commandId"].as_str().unwrap().to_string();
    let mut other = base.clone();
    let winner = api::execute(&mut other, ASSISTANT, NOW + 1, &undo(&target, "key-undo-0002")).await.unwrap();

    // Planning sees the original already undone (by the same request): the
    // marker turns that refusal into the winner's receipt.
    let mut store = FakeStore { after_first_marker_read: Some(other.data.clone()), ..base.clone() };
    store.commits = 0;
    let receipt = api::execute(&mut store, ASSISTANT, NOW + 1, &undo(&target, "key-undo-0002")).await.unwrap();
    assert_eq!((receipt["commandId"].clone(), receipt["replayed"].clone()), (winner["commandId"].clone(), json!(true)));
    assert_eq!(store.commits, 0);
}
