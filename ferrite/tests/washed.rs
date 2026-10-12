//! `care.washed` ("I washed it", "Socks washed") through the command service (`api::execute`): a
//! counted or uncounted wash brings hamper units back clean, a unit the ledger had at the laundry
//! comes back too when the owner says so, "washed" without a count speaks for units reported still
//! away only when nothing was in the hamper, each with its exact undo; a report that moved nothing
//! writes nothing, and the refusals write nothing.
//!
//! The store is an in-memory test double of the APE binding (the same guarded-commit semantics);
//! the garments are the real seed.

use std::collections::BTreeMap;
use std::io;

use ferrite_app::serde_json::{json, Value};
use wardrobe::api::{self, Principal, Store, ASSISTANT, OWNER};

const T0: u64 = 1_789_000_000_000; // 2026-09-10T00:26:40Z
const HOUR: u64 = 3_600_000;

const OXFORD_BLUE: &str = "gmt_3894b6a6295908d5e687af4f"; // service, one unit
const OXFORD_PINK: &str = "gmt_41c2da80e7f41e5dc6a4340b"; // service, one unit
const SOCK_BISCUIT: &str = "gmt_9eb32f6a40ea3e5e4dee484b"; // hand-washed, two units
const NB_GREY: &str = "gmt_14bc4338d6760f6a13434b2f"; // footwear, never laundered

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

async fn run(store: &mut MemStore, who: Principal, now: u64, kind: &str, payload: Value, key: &str) -> Result<Value, wardrobe::ledger::CmdError> {
    let (auth, channel) = if who == OWNER { ("owner_tap", "ios") } else { ("owner_statement", "mcp") };
    api::execute(store, who, now, &json!({"type": kind, "payload": payload, "idempotencyKey": key, "authorization": auth, "source": {"channel": channel}})).await
}

async fn balances(store: &mut MemStore, id: &str) -> (u64, u64, u64) {
    let w = api::read_wardrobe(store, T0, None).await.unwrap();
    let item = w["items"].as_array().unwrap().iter().find(|i| i["garmentId"] == id).unwrap().clone();
    let b = &item["balances"];
    (b["clean"].as_u64().unwrap(), b["dirty"].as_u64().unwrap(), b["service"].as_u64().unwrap())
}

async fn undo(store: &mut MemStore, now: u64, receipt: &Value, key: &str) -> Value {
    run(store, OWNER, now, "command.undo", json!({"commandId": receipt["commandId"]}), key).await.unwrap()
}

#[tokio::test]
async fn socks_washed_brings_every_hand_washed_unit_back_clean_and_undo_puts_them_back() {
    let mut store = MemStore::default();
    run(&mut store, OWNER, T0, "care.mark_dirty", json!({"items": [{"garmentId": SOCK_BISCUIT, "quantity": 2}, {"garmentId": OXFORD_BLUE}]}), "dirty-0001").await.unwrap();
    assert_eq!(balances(&mut store, SOCK_BISCUIT).await, (0, 2, 0));

    // "Socks washed", relayed by a connected assistant: the hand-washed channel only.
    let w = run(&mut store, ASSISTANT, T0 + HOUR, "care.washed", json!({"allOfChannel": "handwash"}), "washed-0001").await.unwrap();
    assert_eq!((w["outcome"].clone(), w["actor"].clone()), (json!("committed"), json!("assistant")));
    assert!(w["summary"].as_str().unwrap().starts_with("Washed and clean: "), "{}", w["summary"]);
    assert_eq!(w["result"], json!({"washed": [SOCK_BISCUIT], "units": 2}));
    assert_eq!(w["undo"]["available"], true);
    assert_eq!(balances(&mut store, SOCK_BISCUIT).await, (2, 0, 0));
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, (0, 1, 0), "the service shirt is not hand-washed");

    // The same request again is the same receipt, not a second wash.
    let again = run(&mut store, ASSISTANT, T0 + 2 * HOUR, "care.washed", json!({"allOfChannel": "handwash"}), "washed-0001").await.unwrap();
    assert_eq!((again["commandId"].clone(), again["replayed"].clone()), (w["commandId"].clone(), json!(true)));

    let u = undo(&mut store, T0 + 3 * HOUR, &w, "undo-0001").await;
    assert_eq!(u["outcome"], "committed");
    assert!(u["summary"].as_str().unwrap().starts_with("Undone: Washed and clean: "), "{}", u["summary"]);
    assert_eq!(balances(&mut store, SOCK_BISCUIT).await, (0, 2, 0));
    // An undo is final.
    assert_eq!(run(&mut store, OWNER, T0 + 4 * HOUR, "command.undo", json!({"commandId": w["commandId"]}), "undo-0002").await.unwrap_err().code, "not_undoable");
}

#[tokio::test]
async fn a_counted_wash_moves_that_many_and_an_uncounted_one_the_rest() {
    let mut store = MemStore::default();
    run(&mut store, OWNER, T0, "care.mark_dirty", json!({"items": [{"garmentId": SOCK_BISCUIT, "quantity": 2}]}), "dirty-0001").await.unwrap();
    let one = run(&mut store, OWNER, T0 + HOUR, "care.washed", json!({"items": [{"garmentId": SOCK_BISCUIT, "quantity": 1}]}), "washed-0001").await.unwrap();
    assert_eq!(one["result"], json!({"washed": [SOCK_BISCUIT], "units": 1}));
    assert_eq!(balances(&mut store, SOCK_BISCUIT).await, (1, 1, 0));
    let rest = run(&mut store, OWNER, T0 + 2 * HOUR, "care.washed", json!({"items": [{"garmentId": SOCK_BISCUIT}]}), "washed-0002").await.unwrap();
    assert_eq!(rest["result"], json!({"washed": [SOCK_BISCUIT], "units": 1}));
    assert_eq!(balances(&mut store, SOCK_BISCUIT).await, (2, 0, 0));
    // Undoing the earlier one while the later one stands would change what the later one moved: refused.
    let e = run(&mut store, OWNER, T0 + 3 * HOUR, "command.undo", json!({"commandId": one["commandId"]}), "undo-0001").await.unwrap_err();
    assert_eq!(e.code, "not_undoable", "{}", e.message);
    assert_eq!(balances(&mut store, SOCK_BISCUIT).await, (2, 0, 0));
    // The later one undoes exactly.
    undo(&mut store, T0 + 4 * HOUR, &rest, "undo-0002").await;
    assert_eq!(balances(&mut store, SOCK_BISCUIT).await, (1, 1, 0));
}

#[tokio::test]
async fn a_listed_count_is_honoured_when_the_same_garment_is_also_in_the_named_channel() {
    let mut store = MemStore::default();
    run(&mut store, OWNER, T0, "care.mark_dirty", json!({"items": [{"garmentId": SOCK_BISCUIT, "quantity": 2}]}), "dirty-0001").await.unwrap();
    let w = run(&mut store, OWNER, T0 + HOUR, "care.washed", json!({"allOfChannel": "handwash", "items": [{"garmentId": SOCK_BISCUIT, "quantity": 1}]}), "washed-0001").await.unwrap();
    assert_eq!(w["result"], json!({"washed": [SOCK_BISCUIT], "units": 1}));
    assert_eq!(balances(&mut store, SOCK_BISCUIT).await, (1, 1, 0), "the count of 1 holds; the second pair stays in the hamper");
}

#[tokio::test]
async fn a_wash_of_what_was_not_awaiting_one_changes_nothing_and_writes_nothing() {
    let mut store = MemStore::default();
    // Nothing hand-washed is in the hamper.
    let n = run(&mut store, OWNER, T0, "care.washed", json!({"allOfChannel": "handwash"}), "washed-0001").await.unwrap();
    assert_eq!((n["outcome"].clone(), n["summary"].clone(), n["result"].clone()), (json!("noop"), json!("Nothing was awaiting a wash"), json!({"washed": [], "units": 0})));
    assert_eq!(n["undo"]["available"], false);
    // A clean shirt said to be washed: nothing moves, nothing is journaled.
    let before = api::read_wardrobe(&mut store, T0, None).await.unwrap();
    let s = run(&mut store, OWNER, T0 + HOUR, "care.washed", json!({"items": [{"garmentId": OXFORD_BLUE}]}), "washed-0002").await.unwrap();
    assert_eq!(s["outcome"], "noop");
    assert!(s["summary"].as_str().unwrap().contains("nothing changed"), "{}", s["summary"]);
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, (1, 0, 0));
    let after = api::read_wardrobe(&mut store, T0, None).await.unwrap();
    assert_eq!(before["items"], after["items"]);
}

#[tokio::test]
async fn washed_takes_units_back_from_the_laundry_and_uncounted_speaks_for_still_away_only_when_the_hamper_was_empty() {
    let mut store = MemStore::default();
    run(&mut store, OWNER, T0, "care.mark_dirty", json!({"items": [{"garmentId": OXFORD_BLUE}, {"garmentId": OXFORD_PINK}]}), "dirty-0001").await.unwrap();
    let c = run(&mut store, OWNER, T0 + HOUR, "laundry.collect", json!({}), "collect-0001").await.unwrap();
    let batch = c["result"]["batchId"].as_str().unwrap().to_string();
    // The blue shirt is at the laundry; the owner says he washed one: it is back and clean.
    let w = run(&mut store, OWNER, T0 + 2 * HOUR, "care.washed", json!({"items": [{"garmentId": OXFORD_BLUE, "quantity": 1}]}), "washed-0001").await.unwrap();
    assert_eq!(w["result"], json!({"washed": [OXFORD_BLUE], "units": 1}));
    assert!(w["repairs"].as_array().unwrap().iter().any(|r| r.as_str().unwrap().contains("away at the laundry")), "{}", w["repairs"]);
    assert!(w["affected"].as_array().unwrap().iter().any(|a| a["kind"] == "laundry_batch" && a["id"] == batch.as_str()), "the bag moves to a new version");
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, (1, 0, 0));
    undo(&mut store, T0 + 3 * HOUR, &w, "undo-0001").await;
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, (0, 0, 1));

    // The bag comes back with the pink shirt still away.
    run(&mut store, OWNER, T0 + 4 * HOUR, "laundry.return", json!({"stillAway": [{"garmentId": OXFORD_PINK}]}), "return-0001").await.unwrap();
    assert_eq!(balances(&mut store, OXFORD_PINK).await, (0, 0, 1));
    // "The pink shirt is washed", no count, nothing of it in the hamper: the unit reported still away is back.
    let p = run(&mut store, ASSISTANT, T0 + 5 * HOUR, "care.washed", json!({"items": [{"garmentId": OXFORD_PINK}]}), "washed-0002").await.unwrap();
    assert_eq!(p["result"], json!({"washed": [OXFORD_PINK], "units": 1}));
    assert_eq!(balances(&mut store, OXFORD_PINK).await, (1, 0, 0));
    undo(&mut store, T0 + 6 * HOUR, &p, "undo-0002").await;
    assert_eq!(balances(&mut store, OXFORD_PINK).await, (0, 0, 1));

    // "Socks washed" (by channel) never speaks for a service piece still away.
    let s = run(&mut store, OWNER, T0 + 7 * HOUR, "care.washed", json!({"allOfChannel": "service"}), "washed-0003").await.unwrap();
    assert_eq!(s["outcome"], "noop");
    assert_eq!(balances(&mut store, OXFORD_PINK).await, (0, 0, 1));
}

#[tokio::test]
async fn refusals_write_nothing() {
    let mut store = MemStore::default();
    run(&mut store, OWNER, T0, "care.mark_dirty", json!({"items": [{"garmentId": OXFORD_BLUE}]}), "dirty-0001").await.unwrap();
    let before = store.data.clone();
    for (what, payload, code) in [
        ("nothing named", json!({}), "invalid_command"),
        ("an empty list", json!({"items": []}), "invalid_command"),
        ("an unknown channel", json!({"allOfChannel": "dryclean"}), "invalid_command"),
        ("a zero count", json!({"items": [{"garmentId": OXFORD_BLUE, "quantity": 0}]}), "invalid_command"),
        ("a fraction", json!({"items": [{"garmentId": OXFORD_BLUE, "quantity": 1.5}]}), "invalid_command"),
        ("an extra field", json!({"items": [{"garmentId": OXFORD_BLUE}], "note": "x"}), "invalid_command"),
        ("a null count", json!({"items": [{"garmentId": OXFORD_BLUE, "quantity": null}]}), "invalid_command"),
        ("a null list beside a channel", json!({"items": null, "allOfChannel": "service"}), "invalid_command"),
        ("a null channel beside a list", json!({"items": [{"garmentId": OXFORD_BLUE}], "allOfChannel": null}), "invalid_command"),
        ("an extra item field", json!({"items": [{"garmentId": OXFORD_BLUE, "tripId": "t"}]}), "invalid_command"),
        ("an unknown garment", json!({"items": [{"garmentId": OXFORD_BLUE}, {"garmentId": "gmt_nope"}]}), "not_found"),
        ("shoes are never laundered", json!({"items": [{"garmentId": OXFORD_BLUE}, {"garmentId": NB_GREY}]}), "precondition_failed"),
    ] {
        let e = run(&mut store, OWNER, T0 + HOUR, "care.washed", payload, &format!("washed-{}", what.replace(' ', "-"))).await.unwrap_err();
        assert_eq!(e.code, code, "{what}: {}", e.message);
        assert_eq!(store.data, before, "{what}: nothing written");
    }
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, (0, 1, 0));
}
