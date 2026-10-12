//! Saved runs: `garderobe_run` and `GET /v1/runs/{id}` over the run records at `u/<runId>`.
//!
//! Test double: an in-memory map stands in for the app's APE store. Every run here is written by the
//! real composer from the owner's real inventory; the damaged records are those runs with one field
//! changed.

use std::collections::BTreeMap;
use std::io;

use ferrite_app::serde_json::{self, json, Map, Value};
use wardrobe::api::Store;
use wardrobe::recommend::{self, RecommendInput};
use wardrobe::runs::{self, parse_input, RunInput};

const T0: u64 = 1_789_000_000_000;
const DAY: &str = "2026-09-11";

#[derive(Default, Clone)]
struct MemStore {
    data: BTreeMap<Vec<u8>, Vec<u8>>,
    reads: Vec<Vec<u8>>,
}

impl Store for MemStore {
    async fn get(&mut self, key: &[u8]) -> io::Result<Option<Vec<u8>>> {
        self.reads.push(key.to_vec());
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

fn action(run_id: &str, action: &str) -> RunInput {
    RunInput { run_id: run_id.into(), action: action.into(), input_id: None, choice_id: None, text: None }
}

async fn recommendation(store: &mut MemStore) -> (String, Value) {
    let input = RecommendInput { client_request_id: "rec-00000001".into(), date: DAY.into(), brief: None, count: Some(2) };
    let first = recommend::recommend(store, "mcp:grant_a", T0, &input).await.unwrap();
    (recommend::run_id_for("recommendation", "mcp:grant_a", "rec-00000001"), first)
}

#[tokio::test]
async fn a_recommendation_run_reads_back_as_the_contract_run() {
    let mut store = MemStore::default();
    let (run_id, first) = recommendation(&mut store).await;
    let out = runs::act(&mut store, &action(&run_id, "status")).await.unwrap();
    assert_eq!(out, json!({"run": {
        "runId": run_id, "kind": "recommendation", "state": "completed", "createdAt": "2026-09-10T00:26:40Z", "updatedAt": "2026-09-10T00:26:40Z",
        "activity": null, "lastEventId": 2, "pendingInput": null, "receipts": [], "proposals": [],
        "result": {"reply": null, "options": first["options"], "board": null, "research": null, "exportId": null, "importId": null},
        "error": null,
    }, "stopped": []}));
    assert_eq!(runs::summary(&action(&run_id, "status"), &out), format!("Run {run_id} is completed"));
    // The REST read is the same run.
    assert_eq!(runs::get(&mut store, &run_id).await.unwrap(), out["run"]);

    // The finished run is answered unchanged by cancel, and nothing is written.
    let before = store.data.clone();
    let cancelled = runs::act(&mut store, &action(&run_id, "cancel")).await.unwrap();
    assert_eq!(cancelled, out);
    assert_eq!(runs::summary(&action(&run_id, "cancel"), &cancelled), format!("Run {run_id} is completed."));
    // Nothing runs in the background: resume is refused, and no run waits for an answer.
    assert_eq!(runs::act(&mut store, &action(&run_id, "resume")).await.unwrap_err().code, "precondition_failed");
    assert_eq!(runs::act(&mut store, &action(&run_id, "respond")).await.unwrap_err().code, "invalid_command");
    let mut respond = action(&run_id, "respond");
    respond.input_id = Some("input_1".into());
    assert_eq!(runs::act(&mut store, &respond).await.unwrap_err().message, "this run is not waiting for input");
    assert_eq!(store.data, before);
}

#[tokio::test]
async fn unknown_malformed_and_damaged_runs_are_refused() {
    let mut store = MemStore::default();
    for act in ["status", "cancel", "resume"] {
        assert_eq!(runs::act(&mut store, &action("run_000000000000000000000000", act)).await.unwrap_err().code, "not_found", "{act}");
    }
    // An ID this server never issues is not looked up at all: no key outside `u/run_…` is read.
    store.reads.clear();
    for bad in ["../ledger", "ledger", "run_", "run_0123456789ABCDEF01234567", "run_0123456789abcdef0123456", "run_0123456789abcdef01234567/x"] {
        assert_eq!(runs::act(&mut store, &action(bad, "status")).await.unwrap_err().code, "not_found", "{bad}");
        assert_eq!(runs::act(&mut store, &action(bad, "cancel")).await.unwrap_err().code, "not_found", "{bad}");
    }
    assert!(store.reads.is_empty(), "{:?}", store.reads);

    let (run_id, _) = recommendation(&mut store).await;
    let key = runs::run_key(&run_id);
    let good: Value = serde_json::from_slice(&store.data[&key]).unwrap();
    let mut damaged: Vec<(String, Value)> = Vec::new();
    // Every field missing in turn.
    for k in good.as_object().unwrap().keys() {
        let mut r = good.clone();
        r.as_object_mut().unwrap().remove(k);
        damaged.push((format!("no {k}"), r));
    }
    let mut set = |what: &str, k: &str, v: Value| {
        let mut r = good.clone();
        r[k] = v;
        damaged.push((what.to_string(), r));
    };
    set("an extra field", "extra", json!(1));
    set("another version", "v", json!(2));
    set("another run's ID", "runId", json!("run_111111111111111111111111"));
    set("another kind", "kind", json!("export"));
    set("an unfinished state", "state", json!("running"));
    set("an unknown state", "state", json!("done"));
    set("createdAt not a time", "createdAt", json!("yesterday"));
    // The three times are one instant as written: a different valid time in any one is damage.
    set("only updatedAt moved", "updatedAt", json!("2026-09-11T08:00:00Z"));
    set("only createdAt moved", "createdAt", json!("2026-09-09T08:00:00Z"));
    let mut moved = good["result"].clone();
    moved["readAt"] = json!("2026-09-11T08:00:00Z");
    set("only the answer's readAt moved", "result", moved);
    set("an activity", "activity", json!("composing"));
    set("another event ID", "lastEventId", json!(3));
    set("a pending input", "pendingInput", json!({"inputId": "i", "question": "q", "choices": [], "actionId": null}));
    set("receipts [null]", "receipts", json!([null]));
    set("a receipt", "receipts", json!([{"commandId": "c", "type": "t", "outcome": "committed", "summary": "s", "undoAvailable": false}]));
    set("receipts null", "receipts", Value::Null);
    set("proposals [null]", "proposals", json!([null]));
    set("proposals null", "proposals", Value::Null);
    set("an empty connection", "connection", json!(""));
    set("a short request ID", "clientRequestId", json!("short"));
    set("a request hash not hex", "requestHash", json!("x".repeat(64)));
    set("an error", "error", json!({"code": "x", "message": "m", "resumable": false}));
    set("a damaged answer", "result", json!({"options": [null]}));
    set("no answer", "result", Value::Null);
    damaged.push(("not an object".into(), json!("x")));
    assert!(damaged.len() > 30);
    for (what, run) in damaged {
        store.data.insert(key.clone(), serde_json::to_vec(&run).unwrap());
        let before = store.data.clone();
        for act in ["status", "cancel"] {
            assert_eq!(runs::act(&mut store, &action(&run_id, act)).await.unwrap_err().code, "internal", "{what} ({act})");
        }
        assert_eq!(store.data, before, "{what}: nothing written");
    }
    // The undamaged record still reads.
    store.data.insert(key.clone(), serde_json::to_vec(&good).unwrap());
    assert!(runs::get(&mut store, &run_id).await.is_ok());
}

#[test]
fn the_arguments_are_the_contract_and_nothing_else() {
    let args = |v: Value| -> Map<String, Value> { v.as_object().unwrap().clone() };
    let parsed = parse_input(&args(json!({"runId": "run_0123456789abcdef01234567"}))).unwrap();
    assert_eq!(parsed, action("run_0123456789abcdef01234567", "status"));
    let full = parse_input(&args(json!({"runId": "r", "action": "respond", "inputId": "i", "choiceId": "c", "text": "yes"}))).unwrap();
    assert_eq!((full.input_id.as_deref(), full.choice_id.as_deref(), full.text.as_deref()), (Some("i"), Some("c"), Some("yes")));
    for bad in [json!({}), json!({"runId": 3}), json!({"runId": "r", "action": "delete"}), json!({"runId": "r", "owner": "x"}), json!({"runId": "r", "text": "é".repeat(4001)})] {
        assert_eq!(parse_input(&args(bad.clone())).unwrap_err().code, "invalid_command", "{bad}");
    }
    assert!(parse_input(&args(json!({"runId": "r", "text": "é".repeat(4000)}))).is_ok());
}
