//! Service laundry through the command service (`api::execute`): the pickup
//! collects what was awaiting the service into a batch, the return brings the
//! batch back clean less what is still away, each with its undo, from the
//! owner's app or a connected assistant, and the refusals that write nothing.
//!
//! The store is an in-memory test double of the APE binding (the same
//! guarded-commit semantics); the garments are the real seed.

use std::collections::BTreeMap;
use std::io;

use ferrite_app::serde_json::{json, Value};
use wardrobe::api::{self, Principal, Store, ASSISTANT, OWNER};
use wardrobe::time::instant;

const T0: u64 = 1_789_000_000_000; // 2026-09-10T00:26:40Z
const HOUR: u64 = 3_600_000;
const MINUTE: u64 = 60_000;

// Real garments from the owner's inventory (single units, laundered by the service unless noted).
const OXFORD_BLUE: &str = "gmt_3894b6a6295908d5e687af4f";
const OXFORD_PINK: &str = "gmt_41c2da80e7f41e5dc6a4340b";
const AKITA_CREAM: &str = "gmt_0bd82c642c7606199361d3d4";
const GREY_CHINO: &str = "gmt_b8744c2627cd88a3b937f851";
const SOCK_BISCUIT: &str = "gmt_9eb32f6a40ea3e5e4dee484b"; // hand-washed, two units
const SOCK_GREY: &str = "gmt_67d3228f744d17138e400729";
const NB_GREY: &str = "gmt_14bc4338d6760f6a13434b2f";
const NB_OLIVE: &str = "gmt_185ccf753d109848f21f7cec";
const BELT_BROWN: &str = "gmt_6335e17bcb19fb15f77c31bf";
const BELT_BLACK: &str = "gmt_4f778d8afb62d536e5fc036b";

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

async fn run_at(store: &mut MemStore, who: Principal, now: u64, occurred: Option<u64>, kind: &str, payload: Value, key: &str) -> Result<Value, wardrobe::ledger::CmdError> {
    let (auth, channel) = if who == OWNER { ("owner_tap", "ios") } else { ("owner_statement", "mcp") };
    let mut env = json!({"type": kind, "payload": payload, "idempotencyKey": key, "authorization": auth, "source": {"channel": channel}});
    if let Some(at) = occurred {
        env["occurredAt"] = json!(instant(at));
    }
    api::execute(store, who, now, &env).await
}

async fn run(store: &mut MemStore, who: Principal, now: u64, kind: &str, payload: Value, key: &str) -> Result<Value, wardrobe::ledger::CmdError> {
    run_at(store, who, now, None, kind, payload, key).await
}

async fn balances(store: &mut MemStore, id: &str) -> (u64, u64, u64) {
    let w = api::read_wardrobe(store, T0, None).await.unwrap();
    let item = w["items"].as_array().unwrap().iter().find(|i| i["garmentId"] == id).unwrap().clone();
    let b = &item["balances"];
    (b["clean"].as_u64().unwrap(), b["dirty"].as_u64().unwrap(), b["service"].as_u64().unwrap())
}

async fn dirty(store: &mut MemStore, now: u64, ids: &[&str], key: &str) {
    let items: Vec<Value> = ids.iter().map(|id| json!({"garmentId": id})).collect();
    run(store, OWNER, now, "care.mark_dirty", json!({"items": items}), key).await.unwrap();
}

#[tokio::test]
async fn a_pickup_and_a_return_move_the_pieces_through_the_laundry_and_still_away_stays_away() {
    let mut store = MemStore::default();
    dirty(&mut store, T0, &[OXFORD_BLUE, OXFORD_PINK, SOCK_BISCUIT], "dirty-0001").await;

    // Only what goes to the service is collected; the hand-washed socks stay in the hamper.
    let c = run(&mut store, ASSISTANT, T0 + HOUR, "laundry.collect", json!({}), "collect-0001").await.unwrap();
    assert_eq!((c["outcome"].clone(), c["actor"].clone(), c["channel"].clone()), (json!("committed"), json!("assistant"), json!("mcp")));
    assert_eq!(c["summary"], "Laundry collected: 2 items in the batch");
    assert_eq!(c["result"]["units"], 2);
    assert_eq!(c["undo"]["available"], true);
    let batch = c["result"]["batchId"].as_str().unwrap().to_string();
    assert!(c["affected"].as_array().unwrap().iter().any(|a| a == &json!({"kind": "laundry_batch", "id": batch, "version": 1})));
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, (0, 0, 1));
    assert_eq!(balances(&mut store, SOCK_BISCUIT).await, (1, 1, 0));

    // A shirt at the laundry is not offered on a board, and says why.
    let outfit = json!({"slots": [{"role": "top", "garmentId": OXFORD_BLUE}, {"role": "bottom", "garmentId": AKITA_CREAM}, {"role": "belt", "garmentId": BELT_BROWN}, {"role": "socks", "garmentId": SOCK_GREY}, {"role": "footwear", "garmentId": NB_GREY}], "reason": ""});
    let e = run(&mut store, OWNER, T0 + HOUR, "board.publish", json!({"localDate": "2026-09-11", "requestedCount": 1, "options": [outfit]}), "publish-0001").await.unwrap_err();
    assert!(e.details["dropped"][0]["violations"][0].as_str().unwrap().contains("at the laundry"), "{}", e.details);

    // The bag comes back with the pink shirt still away.
    let r = run(&mut store, OWNER, T0 + 50 * HOUR, "laundry.return", json!({"stillAway": [{"garmentId": OXFORD_PINK}]}), "return-0001").await.unwrap();
    assert_eq!(r["summary"], "Laundry returned: 1 item clean; still away: Lightweight oxford — pink");
    assert_eq!(r["result"], json!({"batchId": batch, "returned": 1, "stillAway": 1}));
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, (1, 0, 0));
    assert_eq!(balances(&mut store, OXFORD_PINK).await, (0, 0, 1));
    // The next return completes that batch (the oldest one still out).
    let r2 = run(&mut store, OWNER, T0 + 60 * HOUR, "laundry.return", json!({}), "return-0002").await.unwrap();
    assert_eq!(r2["result"], json!({"batchId": batch, "returned": 1, "stillAway": 0}));
    assert_eq!(balances(&mut store, OXFORD_PINK).await, (1, 0, 0));
    // The same return said again changes nothing.
    let again = run(&mut store, ASSISTANT, T0 + 61 * HOUR, "laundry.return", json!({}), "return-0003").await.unwrap();
    assert_eq!((again["outcome"].clone(), again["undo"]["available"].clone()), (json!("noop"), json!(false)));
    assert!(again["summary"].as_str().unwrap().starts_with("That laundry is already recorded as back"));
    // Every stored record reads back through the validator.
    for rc in api::receipts_page(&mut store, 200).await.unwrap().0 {
        assert!(rc["outcome"] == "committed" || rc["outcome"] == "noop");
    }
}

#[tokio::test]
async fn a_pickup_is_withdrawn_while_the_bag_is_out_and_a_return_is_undone_exactly() {
    let mut store = MemStore::default();
    dirty(&mut store, T0, &[OXFORD_BLUE, GREY_CHINO], "dirty-0001").await;
    let c = run(&mut store, OWNER, T0 + HOUR, "laundry.collect", json!({"batchId": "bag-1"}), "collect-0001").await.unwrap();
    let undo = run(&mut store, ASSISTANT, T0 + 2 * HOUR, "command.undo", json!({"commandId": c["commandId"]}), "undo-0001").await.unwrap();
    assert_eq!(undo["summary"], "Undone: Laundry collected: 2 items in the batch. Laundry pickup withdrawn; the items are awaiting collection again");
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, (0, 1, 0));
    assert_eq!(run(&mut store, OWNER, T0, "command.undo", json!({"commandId": c["commandId"]}), "undo-0002").await.unwrap_err().code, "not_undoable");
    // A withdrawn batch keeps its ID: it is not reused.
    assert_eq!(run(&mut store, OWNER, T0 + 3 * HOUR, "laundry.collect", json!({"batchId": "bag-1"}), "collect-0002").await.unwrap_err().code, "precondition_failed");

    let c2 = run(&mut store, OWNER, T0 + 3 * HOUR, "laundry.collect", json!({"batchId": "bag-2"}), "collect-0003").await.unwrap();
    let r = run(&mut store, OWNER, T0 + 40 * HOUR, "laundry.return", json!({"batchId": "bag-2", "stillAway": [{"garmentId": GREY_CHINO}]}), "return-0001").await.unwrap();
    // Once the bag is back, the pickup is no longer withdrawn; the return is corrected instead.
    let e = run(&mut store, OWNER, T0 + 41 * HOUR, "command.undo", json!({"commandId": c2["commandId"]}), "undo-0003").await.unwrap_err();
    assert_eq!(e.code, "not_undoable");
    assert!(e.message.contains("already come back"));
    run(&mut store, OWNER, T0 + 41 * HOUR, "command.undo", json!({"commandId": r["commandId"]}), "undo-0004").await.unwrap();
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, (0, 0, 1), "back at the laundry");
    assert_eq!(balances(&mut store, GREY_CHINO).await, (0, 0, 1));
    // And the pickup can be withdrawn again, since the bag is out.
    run(&mut store, OWNER, T0 + 42 * HOUR, "command.undo", json!({"commandId": c2["commandId"]}), "undo-0005").await.unwrap();
    assert_eq!(balances(&mut store, GREY_CHINO).await, (0, 1, 0));
}

#[tokio::test]
async fn a_return_is_not_undone_over_a_later_report_and_a_wash_report_pulls_a_piece_back_from_the_laundry() {
    let mut store = MemStore::default();
    dirty(&mut store, T0, &[OXFORD_BLUE], "dirty-0001").await;
    run(&mut store, OWNER, T0 + HOUR, "laundry.collect", json!({}), "collect-0001").await.unwrap();
    // The owner reports the shirt in the hamper while the ledger has it at the laundry: he has it.
    let d = run(&mut store, OWNER, T0 + 2 * HOUR, "care.mark_dirty", json!({"items": [{"garmentId": OXFORD_BLUE}]}), "dirty-0002").await.unwrap();
    assert_eq!(d["result"]["units"], 1);
    assert!(d["repairs"][0].as_str().unwrap().contains("the ledger had this item at the laundry"));
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, (0, 1, 0));
    run(&mut store, OWNER, T0 + 3 * HOUR, "command.undo", json!({"commandId": d["commandId"]}), "undo-0001").await.unwrap();

    let r = run(&mut store, OWNER, T0 + 40 * HOUR, "laundry.return", json!({}), "return-0001").await.unwrap();
    assert_eq!(r["result"]["returned"], 1);
    // Worn and in the hamper again after it came back: that report speaks for the unit, so the return stays.
    dirty(&mut store, T0 + 50 * HOUR, &[OXFORD_BLUE], "dirty-0003").await;
    let before = store.clone();
    let e = run(&mut store, OWNER, T0 + 51 * HOUR, "command.undo", json!({"commandId": r["commandId"]}), "undo-0002").await.unwrap_err();
    assert_eq!(e.code, "not_undoable");
    assert!(e.message.contains("something has been recorded since that laundry came back"), "{}", e.message);
    assert_eq!(store.data, before.data, "a refused undo writes nothing");
}

#[tokio::test]
async fn a_return_without_a_recorded_pickup_takes_the_owners_word() {
    let mut store = MemStore::default();
    dirty(&mut store, T0, &[OXFORD_BLUE, OXFORD_PINK], "dirty-0001").await;
    let r = run(&mut store, OWNER, T0 + HOUR, "laundry.return", json!({"stillAway": [{"garmentId": OXFORD_PINK}]}), "return-0001").await.unwrap();
    assert_eq!(r["summary"], "Laundry returned: 1 item clean (no pickup had been recorded; your report stands)");
    assert_eq!(r["result"], json!({"batchId": null, "returned": 1, "stillAway": 0}));
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, (1, 0, 0));
    assert_eq!(balances(&mut store, OXFORD_PINK).await, (0, 1, 0));
    run(&mut store, OWNER, T0 + 2 * HOUR, "command.undo", json!({"commandId": r["commandId"]}), "undo-0001").await.unwrap();
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, (0, 1, 0));
}

#[tokio::test]
async fn a_return_without_a_pickup_is_not_undone_over_a_report_that_relied_on_it() {
    let mut store = MemStore::default();
    dirty(&mut store, T0, &[OXFORD_BLUE], "dirty-0001").await;
    let r = run(&mut store, OWNER, T0 + HOUR, "laundry.return", json!({}), "return-0001").await.unwrap();
    assert_eq!(r["result"]["returned"], 1);
    // Worn again after it came back: that report took the unit the return made clean.
    dirty(&mut store, T0 + 2 * HOUR, &[OXFORD_BLUE], "dirty-0002").await;
    let before = store.clone();
    let e = run(&mut store, OWNER, T0 + 3 * HOUR, "command.undo", json!({"commandId": r["commandId"]}), "undo-0001").await.unwrap_err();
    assert_eq!(e.code, "not_undoable");
    assert!(e.message.contains("Lightweight oxford"), "{}", e.message);
    assert_eq!(store.data, before.data, "a refused undo writes nothing");
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, (0, 1, 0));
}

#[tokio::test]
async fn a_batch_id_is_never_used_twice_even_after_its_batch_is_dropped_from_the_list() {
    let mut store = MemStore::default();
    // More pickups than the ledger keeps batches for: the oldest closed ones are dropped.
    for i in 0..61u64 {
        let t = T0 + i * 3 * HOUR;
        dirty(&mut store, t, &[OXFORD_BLUE], &format!("dirty-{i:04}")).await;
        run(&mut store, OWNER, t + HOUR, "laundry.collect", json!({"batchId": format!("bag-{i}")}), &format!("collect-{i:04}")).await.unwrap();
        run(&mut store, OWNER, t + 2 * HOUR, "laundry.return", json!({"batchId": format!("bag-{i}")}), &format!("return-{i:04}")).await.unwrap();
    }
    let t = T0 + 61 * 3 * HOUR;
    dirty(&mut store, t, &[OXFORD_BLUE], "dirty-last").await;
    // bag-0 is no longer listed (a return naming it is not found), and its ID still cannot be reused.
    assert_eq!(run(&mut store, OWNER, t, "laundry.return", json!({"batchId": "bag-0"}), "return-old").await.unwrap_err().code, "not_found");
    let before = store.clone();
    let e = run(&mut store, OWNER, t + HOUR, "laundry.collect", json!({"batchId": "bag-0"}), "collect-reuse").await.unwrap_err();
    assert_eq!((e.code, e.details["batchId"].clone()), ("precondition_failed", json!("bag-0")));
    assert_eq!(store.data, before.data);
    assert!(run(&mut store, OWNER, t + HOUR, "laundry.collect", json!({"batchId": "bag-61"}), "collect-new").await.is_ok());
}

#[tokio::test]
async fn a_back_dated_return_counts_what_the_bag_held_at_that_time() {
    let mut store = MemStore::default();
    dirty(&mut store, T0, &[OXFORD_BLUE], "dirty-0001").await;
    let c = run(&mut store, OWNER, T0 + HOUR, "laundry.collect", json!({}), "collect-0001").await.unwrap();
    // A wash report at t3 while the ledger still had the shirt at the laundry pulls it back.
    dirty(&mut store, T0 + 30 * HOUR, &[OXFORD_BLUE], "dirty-0002").await;
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, (0, 1, 0));
    // Then the owner says the bag had come back at t2, before that report.
    let r = run_at(&mut store, OWNER, T0 + 31 * HOUR, Some(T0 + 20 * HOUR), "laundry.return", json!({}), "return-0001").await.unwrap();
    assert_eq!(r["result"], json!({"batchId": c["result"]["batchId"], "returned": 1, "stillAway": 0}));
    assert_eq!(r["summary"], "Laundry returned: 1 item clean");
    // Back clean at t2, worn and in the hamper at t3.
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, (0, 1, 0));
    let rc = api::receipts_page(&mut store, 50).await.unwrap().0;
    assert!(rc.iter().all(|x| x["outcome"] == "committed"));
    // The t3 report now reads differently (a plain wash report, no laundry pull), so undoing the
    // back-dated return would rewrite it: refused, and nothing is written.
    let before = store.clone();
    let e = run(&mut store, OWNER, T0 + 32 * HOUR, "command.undo", json!({"commandId": r["commandId"]}), "undo-0001").await.unwrap_err();
    assert_eq!(e.code, "not_undoable");
    assert_eq!(store.data, before.data);
    // The bag is back as of t2: a return dated before that is refused, not counted again.
    for (i, at) in [T0 + 10 * HOUR, T0 + 30 * MINUTE].into_iter().enumerate() {
        let e = run_at(&mut store, OWNER, T0 + 33 * HOUR, Some(at), "laundry.return", json!({"batchId": c["result"]["batchId"]}), &format!("return-early-{i}")).await.unwrap_err();
        let reason = if at < T0 + HOUR { "return_before_pickup" } else { "return_before_last_return" };
        assert_eq!((e.code, e.details["reason"].clone()), ("invalid_command", json!(reason)), "{i}");
    }
    // Said again with no time (now, after the return), it is a no-op.
    let again = run(&mut store, OWNER, T0 + 33 * HOUR, "laundry.return", json!({"batchId": c["result"]["batchId"]}), "return-again").await.unwrap();
    assert_eq!(again["outcome"], "noop");
}

#[tokio::test]
async fn a_back_dated_return_without_a_named_batch_finds_the_bag_that_was_out_then() {
    let mut store = MemStore::default();
    dirty(&mut store, T0, &[OXFORD_BLUE, OXFORD_PINK], "dirty-0001").await;
    run(&mut store, OWNER, T0 + HOUR, "laundry.collect", json!({"batchId": "bag-a"}), "collect-0001").await.unwrap();
    run(&mut store, OWNER, T0 + 200 * HOUR, "laundry.return", json!({}), "return-0001").await.unwrap();
    // Nothing is out now; a return dated while bag-a was out is about bag-a, and is refused as
    // earlier than its recorded return rather than taken as an unrelated wash.
    let before = store.clone();
    let e = run_at(&mut store, OWNER, T0 + 201 * HOUR, Some(T0 + 150 * HOUR), "laundry.return", json!({}), "return-0002").await.unwrap_err();
    assert_eq!((e.code, e.details["reason"].clone(), e.details["batchId"].clone()), ("invalid_command", json!("return_before_last_return"), json!("bag-a")));
    assert_eq!(store.data, before.data);
}

#[tokio::test]
async fn an_unnamed_back_dated_return_is_about_the_bag_that_was_out_then() {
    let mut store = MemStore::default();
    dirty(&mut store, T0, &[OXFORD_BLUE], "dirty-0001").await;
    run(&mut store, OWNER, T0 + 10 * HOUR, "laundry.collect", json!({"batchId": "bag-a"}), "collect-a").await.unwrap();
    run(&mut store, OWNER, T0 + 20 * HOUR, "laundry.return", json!({}), "return-a").await.unwrap();
    dirty(&mut store, T0 + 25 * HOUR, &[OXFORD_BLUE], "dirty-0002").await;
    run(&mut store, OWNER, T0 + 30 * HOUR, "laundry.collect", json!({"batchId": "bag-b"}), "collect-b").await.unwrap();
    // Dated while bag-a was out (bag-b is open now but was not collected yet): it is about bag-a.
    let before = store.clone();
    let e = run_at(&mut store, OWNER, T0 + 31 * HOUR, Some(T0 + 15 * HOUR), "laundry.return", json!({}), "return-early").await.unwrap_err();
    assert_eq!((e.code, e.details["reason"].clone(), e.details["batchId"].clone()), ("invalid_command", json!("return_before_last_return"), json!("bag-a")));
    assert_eq!(store.data, before.data);
    // Undated, it is bag-b's return.
    let r = run(&mut store, OWNER, T0 + 32 * HOUR, "laundry.return", json!({}), "return-b").await.unwrap();
    assert_eq!(r["result"], json!({"batchId": "bag-b", "returned": 1, "stillAway": 0}));
}

#[tokio::test]
async fn a_pickup_or_wash_report_is_not_undone_when_another_record_relies_on_it() {
    let mut store = MemStore::default();
    dirty(&mut store, T0, &[OXFORD_PINK], "dirty-0001").await;
    run(&mut store, OWNER, T0 + 20 * HOUR, "laundry.collect", json!({"batchId": "bag-x"}), "collect-x").await.unwrap();
    // A pickup reported later but dated earlier collects that unit into bag-y instead.
    let y = run_at(&mut store, OWNER, T0 + 21 * HOUR, Some(T0 + 10 * HOUR), "laundry.collect", json!({"batchId": "bag-y"}), "collect-y").await.unwrap();
    assert_eq!(y["result"]["units"], 1);
    run(&mut store, OWNER, T0 + 30 * HOUR, "laundry.return", json!({"batchId": "bag-x"}), "return-x").await.unwrap();
    // Withdrawing bag-y would put the unit back in bag-x, already recorded as returned: refused.
    let before = store.clone();
    let e = run(&mut store, OWNER, T0 + 31 * HOUR, "command.undo", json!({"commandId": y["commandId"]}), "undo-y-0001").await.unwrap_err();
    assert_eq!(e.code, "not_undoable", "{} {}", e.message, e.details);
    assert!(e.message.contains("another record relies on this pickup"), "{}", e.message);
    assert_eq!(store.data, before.data);
    // The unit is still recorded in bag-y, and its return brings it back.
    assert_eq!(balances(&mut store, OXFORD_PINK).await, (0, 0, 1));
    let r = run(&mut store, OWNER, T0 + 32 * HOUR, "laundry.return", json!({"batchId": "bag-y"}), "return-y").await.unwrap();
    assert_eq!(r["result"]["returned"], 1);

    // A wash report a pickup collected cannot be undone under it either.
    let d = run(&mut store, OWNER, T0 + 40 * HOUR, "care.mark_dirty", json!({"items": [{"garmentId": OXFORD_BLUE}]}), "dirty-0002").await.unwrap();
    run(&mut store, OWNER, T0 + 41 * HOUR, "laundry.collect", json!({}), "collect-z").await.unwrap();
    let before = store.clone();
    let e = run(&mut store, OWNER, T0 + 42 * HOUR, "command.undo", json!({"commandId": d["commandId"]}), "undo-dirty").await.unwrap_err();
    assert_eq!(e.code, "not_undoable");
    assert_eq!(store.data, before.data);
}

#[tokio::test]
async fn laundry_refusals_write_nothing() {
    let mut store = MemStore::default();
    // Nothing awaiting the service: a no-op with a receipt, nothing to undo.
    let n = run(&mut store, OWNER, T0, "laundry.collect", json!({}), "collect-0001").await.unwrap();
    assert_eq!((n["outcome"].clone(), n["summary"].clone(), n["undo"]["reason"].clone()), (json!("noop"), json!("Nothing was awaiting collection"), json!("nothing changed")));
    dirty(&mut store, T0, &[OXFORD_BLUE, OXFORD_PINK], "dirty-0001").await;
    let before = store.clone();
    let cases = [
        (json!({"include": [{"garmentId": SOCK_BISCUIT, "quantity": 1}]}), "precondition_failed"),
        (json!({"include": [{"garmentId": "gmt_nope", "quantity": 1}]}), "not_found"),
        (json!({"include": [{"garmentId": OXFORD_BLUE}]}), "invalid_command"),
        (json!({"batchId": "has space"}), "invalid_command"),
        (json!({"batchId": "lb_mine"}), "invalid_command"),
        (json!({"exclude": "all"}), "invalid_command"),
        (json!({"other": 1}), "invalid_command"),
    ];
    for (i, (p, code)) in cases.into_iter().enumerate() {
        assert_eq!(run(&mut store, OWNER, T0, "laundry.collect", p, &format!("collect-bad-{i:04}")).await.unwrap_err().code, code, "case {i}");
    }
    assert_eq!(store.data, before.data);
    run(&mut store, OWNER, T0 + HOUR, "laundry.collect", json!({"batchId": "bag-1", "exclude": [OXFORD_PINK]}), "collect-0002").await.unwrap();
    assert_eq!(balances(&mut store, OXFORD_PINK).await, (0, 1, 0), "excluded: still in the hamper");
    let before = store.clone();
    assert_eq!(run(&mut store, OWNER, T0 + 2 * HOUR, "laundry.return", json!({"batchId": "bag-9"}), "return-bad-1").await.unwrap_err().code, "not_found");
    assert_eq!(run(&mut store, OWNER, T0 + 2 * HOUR, "laundry.return", json!({"stillAway": [{"garmentId": OXFORD_PINK}]}), "return-bad-2").await.unwrap_err().code, "precondition_failed");
    let e = run_at(&mut store, OWNER, T0 + 2 * HOUR, Some(T0), "laundry.return", json!({}), "return-bad-3").await.unwrap_err();
    assert_eq!((e.code, e.details["reason"].clone()), ("invalid_command", json!("return_before_pickup")));
    assert_eq!(store.data, before.data);
}

#[tokio::test]
async fn a_board_swap_refuses_a_shirt_already_offered_in_another_option() {
    let mut store = MemStore::default();
    let outfit = |top: &str, bottom: &str, socks: &str, shoes: &str, belt: &str| json!({"slots": [{"role": "top", "garmentId": top}, {"role": "bottom", "garmentId": bottom}, {"role": "belt", "garmentId": belt}, {"role": "socks", "garmentId": socks}, {"role": "footwear", "garmentId": shoes}], "reason": ""});
    let p = run(&mut store, OWNER, T0, "board.publish", json!({"localDate": "2026-09-11", "requestedCount": 2, "options": [outfit(OXFORD_BLUE, AKITA_CREAM, SOCK_BISCUIT, NB_GREY, BELT_BROWN), outfit(OXFORD_PINK, GREY_CHINO, SOCK_GREY, NB_OLIVE, BELT_BLACK)]}), "publish-0001").await.unwrap();
    let board = p["result"]["boardId"].clone();
    let second = p["result"]["optionIds"][1].clone();
    let before = store.clone();
    let e = run(&mut store, OWNER, T0, "board.swap_slot", json!({"boardId": board, "optionId": second, "role": "top", "garmentId": OXFORD_BLUE}), "swap-0001").await.unwrap_err();
    assert_eq!(e.code, "precondition_failed");
    assert!(e.message.contains("already offered in option 1"), "{}", e.message);
    assert_eq!(store.data, before.data);
}

#[tokio::test]
async fn a_stored_board_result_with_an_unexpected_field_is_refused_as_corrupt() {
    let mut store = MemStore::default();
    let outfit = json!({"slots": [{"role": "top", "garmentId": OXFORD_BLUE}, {"role": "bottom", "garmentId": AKITA_CREAM}, {"role": "belt", "garmentId": BELT_BROWN}, {"role": "socks", "garmentId": SOCK_BISCUIT}, {"role": "footwear", "garmentId": NB_GREY}], "reason": ""});
    let p = run(&mut store, OWNER, T0, "board.publish", json!({"localDate": "2026-09-11", "requestedCount": 1, "options": [outfit]}), "publish-0001").await.unwrap();
    let s = run(&mut store, OWNER, T0, "board.select", json!({"boardId": p["result"]["boardId"], "optionId": p["result"]["optionIds"][0]}), "select-0001").await.unwrap();
    let key = format!("c/{}", s["commandId"].as_str().unwrap()).into_bytes();
    let mut record: Value = ferrite_app::serde_json::from_slice(store.data.get(&key).expect("record key c/<id>")).unwrap();
    record["receipt"]["result"]["extra"] = json!(1);
    store.data.insert(key, record.to_string().into_bytes());
    assert_eq!(api::receipts_page(&mut store, 10).await.unwrap_err().code, "internal");
}

#[tokio::test]
async fn a_stored_publication_with_a_malformed_dropped_entry_is_refused_as_corrupt() {
    let mut store = MemStore::default();
    let outfit = |top: &str, bottom: &str, socks: &str, shoes: &str, belt: &str| json!({"slots": [{"role": "top", "garmentId": top}, {"role": "bottom", "garmentId": bottom}, {"role": "belt", "garmentId": belt}, {"role": "socks", "garmentId": socks}, {"role": "footwear", "garmentId": shoes}], "reason": ""});
    dirty(&mut store, T0, &[OXFORD_BLUE], "dirty-0001").await;
    let p = run(&mut store, OWNER, T0, "board.publish", json!({"localDate": "2026-09-11", "requestedCount": 1, "options": [outfit(OXFORD_BLUE, AKITA_CREAM, SOCK_BISCUIT, NB_GREY, BELT_BROWN)], "reserves": [outfit(OXFORD_PINK, GREY_CHINO, SOCK_GREY, NB_OLIVE, BELT_BLACK)]}), "publish-0001").await.unwrap();
    assert_eq!(p["result"]["dropped"].as_array().unwrap().len(), 1);
    assert!(api::receipts_page(&mut store, 10).await.is_ok(), "the record as written reads back");
    let key = format!("c/{}", p["commandId"].as_str().unwrap()).into_bytes();
    let good: Value = ferrite_app::serde_json::from_slice(store.data.get(&key).unwrap()).unwrap();
    let cases = [
        ("null entry", json!(null)),
        ("number", json!(7)),
        ("no violations", json!({"position": "option 1", "violations": []})),
        ("extra field", json!({"position": "option 1", "violations": ["x"], "more": 1})),
    ];
    for (what, bad) in cases {
        let mut record = good.clone();
        record["receipt"]["result"]["dropped"][0] = bad;
        store.data.insert(key.clone(), record.to_string().into_bytes());
        assert_eq!(api::receipts_page(&mut store, 10).await.unwrap_err().code, "internal", "{what}");
    }
    let mut record = good.clone();
    record["receipt"]["result"]["scope"] = json!("elsewhere");
    store.data.insert(key.clone(), record.to_string().into_bytes());
    assert_eq!(api::receipts_page(&mut store, 10).await.unwrap_err().code, "internal", "scope");
}

#[tokio::test]
async fn a_stored_collection_with_a_malformed_member_is_refused_as_corrupt() {
    let mut store = MemStore::default();
    dirty(&mut store, T0, &[OXFORD_BLUE], "dirty-0001").await;
    let c = run(&mut store, OWNER, T0 + HOUR, "laundry.collect", json!({}), "collect-0001").await.unwrap();
    assert!(c["result"]["batchId"].as_str().unwrap().starts_with("lb_"));
    assert!(api::receipts_page(&mut store, 10).await.is_ok());
    let key = format!("c/{}", c["commandId"].as_str().unwrap()).into_bytes();
    let good: Value = ferrite_app::serde_json::from_slice(store.data.get(&key).unwrap()).unwrap();
    let cases = [
        ("null member", json!(null)),
        ("number", json!(3)),
        ("no quantity", json!({"garmentId": OXFORD_BLUE})),
        ("zero quantity", json!({"garmentId": OXFORD_BLUE, "quantity": 0})),
        ("extra field", json!({"garmentId": OXFORD_BLUE, "quantity": 1, "x": 1})),
    ];
    for (what, bad) in cases {
        let mut record = good.clone();
        record["receipt"]["result"]["members"][0] = bad;
        store.data.insert(key.clone(), record.to_string().into_bytes());
        assert_eq!(api::receipts_page(&mut store, 10).await.unwrap_err().code, "internal", "{what}");
    }
}
