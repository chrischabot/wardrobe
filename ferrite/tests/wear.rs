//! Wear records through the command service (`api::execute`): a garment is
//! counted once per wearing date however many reports arrive, a repeat merges
//! and keeps its provenance, further units used are a total for the day, each
//! report has its undo, and the day's record reads back on Today and in the
//! wear history.
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
const TODAY: &str = "2026-09-10";
const YESTERDAY: &str = "2026-09-09";

// Real garments from the owner's inventory.
const OXFORD_BLUE: &str = "gmt_3894b6a6295908d5e687af4f"; // service laundry, one unit
const GREY_CHINO: &str = "gmt_b8744c2627cd88a3b937f851";
const SOCK_GREY: &str = "gmt_67d3228f744d17138e400729"; // hand-washed, three units
const NB_GREY: &str = "gmt_14bc4338d6760f6a13434b2f"; // sneaker, never laundered
const CLIFFORD_BOOT: &str = "gmt_a1cec1a08c0d07b696a9fffa"; // boot: excluded while the sneakers-only restriction holds

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

async fn wore(store: &mut MemStore, who: Principal, now: u64, date: &str, ids: &[&str], key: &str) -> Value {
    run(store, who, now, "wear.record", json!({"wearingDate": date, "garmentIds": ids}), key).await.unwrap()
}

async fn undo(store: &mut MemStore, who: Principal, now: u64, receipt: &Value, key: &str) -> Result<Value, wardrobe::ledger::CmdError> {
    run(store, who, now, "command.undo", json!({"commandId": receipt["commandId"]}), key).await
}

async fn balances(store: &mut MemStore, id: &str) -> (u64, u64, u64) {
    let w = api::read_wardrobe(store, T0, None).await.unwrap();
    let item = w["items"].as_array().unwrap().iter().find(|i| i["garmentId"] == id).unwrap().clone();
    let b = &item["balances"];
    (b["clean"].as_u64().unwrap(), b["dirty"].as_u64().unwrap(), b["service"].as_u64().unwrap())
}

async fn day_record(store: &mut MemStore, date: &str) -> Vec<String> {
    let view = api::read_today(store, T0 + 10 * HOUR, Some(date)).await.unwrap();
    view["dayRecord"].as_array().unwrap().iter().map(|l| l["garmentId"].as_str().unwrap().to_string()).collect()
}

async fn revision(store: &mut MemStore) -> u64 {
    api::read_wardrobe(store, T0, None).await.unwrap()["wardrobeRevision"].as_u64().unwrap()
}

#[tokio::test]
async fn a_wear_is_counted_once_per_garment_and_day_and_a_repeat_from_another_surface_merges() {
    let mut store = MemStore::default();
    let now = T0 + 10 * HOUR;
    let first = wore(&mut store, OWNER, now, YESTERDAY, &[OXFORD_BLUE, GREY_CHINO], "wear-0001").await;
    assert_eq!(first["outcome"], "committed");
    assert_eq!(first["result"]["counted"], json!([OXFORD_BLUE, GREY_CHINO]));
    assert_eq!(first["result"]["merged"], json!([]));
    assert!(first["summary"].as_str().unwrap().starts_with("Recorded for 2026-09-09: "), "{}", first["summary"]);
    assert_eq!(first["undo"]["available"], true);
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, (0, 1, 0));

    // The connected assistant relays the same wear (a new key): one counted wear, the report kept.
    let again = wore(&mut store, ASSISTANT, now + HOUR, YESTERDAY, &[OXFORD_BLUE], "wear-0002").await;
    assert_eq!(again["outcome"], "merged");
    assert_eq!(again["result"]["counted"], json!([]));
    assert_eq!(again["result"]["merged"], json!([OXFORD_BLUE]));
    assert!(again["summary"].as_str().unwrap().starts_with("Already recorded for 2026-09-09"), "{}", again["summary"]);
    assert_eq!(again["undo"]["available"], true);
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, (0, 1, 0));

    // The same garment twice in one report is one wear; a mixed report says what merged.
    let mixed = wore(&mut store, OWNER, now + 2 * HOUR, YESTERDAY, &[OXFORD_BLUE, OXFORD_BLUE, NB_GREY], "wear-0003").await;
    assert_eq!(mixed["result"]["counted"], json!([NB_GREY]));
    assert_eq!(mixed["result"]["merged"], json!([OXFORD_BLUE]));
    assert!(mixed["summary"].as_str().unwrap().ends_with("(1 already recorded that day, counted once)"), "{}", mixed["summary"]);

    // The history keeps every report with its channel; the counted wear is one.
    let (record, _) = api::read_history(&mut store, Some(YESTERDAY), None, None).await.unwrap();
    let blue = record["garments"].as_array().unwrap().iter().find(|g| g["garmentId"] == OXFORD_BLUE).unwrap().clone();
    assert_eq!(blue["observationCount"], 3);
    let channels: Vec<&str> = record["observations"].as_array().unwrap().iter().filter(|o| o["garmentId"] == OXFORD_BLUE).map(|o| o["channel"].as_str().unwrap()).collect();
    assert_eq!(channels, vec!["ios", "mcp", "ios"]);
    assert_eq!(day_record(&mut store, YESTERDAY).await.len(), 3);

    // Worn again the next day with no clean unit: recorded, the unit stays in the hamper.
    let next = wore(&mut store, OWNER, now + 3 * HOUR, TODAY, &[OXFORD_BLUE], "wear-0004").await;
    assert_eq!(next["result"]["counted"], json!([OXFORD_BLUE]));
    assert!(next["repairs"].as_array().unwrap().iter().any(|r| r.as_str().unwrap().contains("no clean unit")), "{}", next["repairs"]);
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, (0, 1, 0));
    let (range, _) = api::read_history(&mut store, None, Some((YESTERDAY, TODAY)), Some(OXFORD_BLUE)).await.unwrap();
    assert_eq!(range["wears"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn undoing_a_report_withdraws_the_wear_only_when_no_other_report_of_it_stands() {
    let mut store = MemStore::default();
    let now = T0 + 10 * HOUR;
    let a = wore(&mut store, OWNER, now, YESTERDAY, &[OXFORD_BLUE], "wear-0001").await;
    let b = wore(&mut store, ASSISTANT, now + HOUR, YESTERDAY, &[OXFORD_BLUE], "wear-0002").await;
    // Undo the first report while the second stands: the wear stays, so does the unit in the hamper.
    let u = undo(&mut store, OWNER, now + 2 * HOUR, &a, "undo-wear-0001").await.unwrap();
    assert_eq!(u["summary"], "Wear record for 2026-09-09 undone (0 counted wears withdrawn)");
    assert_eq!(u["undo"]["available"], false);
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, (0, 1, 0));
    assert_eq!(day_record(&mut store, YESTERDAY).await, vec![OXFORD_BLUE.to_string()]);
    // Undo the last report standing (made by the assistant, undone by it): the wear and the unit go back.
    let u2 = undo(&mut store, ASSISTANT, now + 3 * HOUR, &b, "undo-wear-0002").await.unwrap();
    assert_eq!(u2["summary"], "Wear record for 2026-09-09 undone (1 counted wear withdrawn)");
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, (1, 0, 0));
    assert!(day_record(&mut store, YESTERDAY).await.is_empty());
    let (record, _) = api::read_history(&mut store, Some(YESTERDAY), None, None).await.unwrap();
    assert_eq!(record["garments"], json!([]));
    assert!(record["observations"].as_array().unwrap().iter().all(|o| o["status"] == "retracted"));
    // An undo is not undone, and the same undo again is refused.
    assert_eq!(undo(&mut store, OWNER, now + 4 * HOUR, &u2, "undo-wear-0003").await.unwrap_err().code, "not_undoable");
    assert_eq!(undo(&mut store, OWNER, now + 4 * HOUR, &b, "undo-wear-0004").await.unwrap_err().code, "not_undoable");
    // A new report after the undo counts again.
    let c = wore(&mut store, OWNER, now + 5 * HOUR, YESTERDAY, &[OXFORD_BLUE], "wear-0005").await;
    assert_eq!(c["result"]["counted"], json!([OXFORD_BLUE]));
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, (0, 1, 0));
}

#[tokio::test]
async fn further_units_used_are_a_total_for_the_garment_and_day() {
    let mut store = MemStore::default();
    let now = T0 + 10 * HOUR;
    let p = |extra: u32| json!({"wearingDate": YESTERDAY, "garmentIds": [SOCK_GREY], "additionalUnits": [{"garmentId": SOCK_GREY, "quantity": extra}]});
    let a = run(&mut store, OWNER, now, "wear.record", p(1), "wear-0001").await.unwrap();
    assert_eq!(a["result"]["additionalUnitEvents"], 1);
    assert_eq!(balances(&mut store, SOCK_GREY).await, (1, 2, 0));
    // The same report again consumes nothing further.
    let b = run(&mut store, ASSISTANT, now + HOUR, "wear.record", p(1), "wear-0002").await.unwrap();
    assert_eq!(b["outcome"], "merged");
    assert_eq!(b["result"]["additionalUnitsAlreadyRecorded"], 1);
    assert_eq!(balances(&mut store, SOCK_GREY).await, (1, 2, 0));
    // Two further units in total: one more is used.
    let c = run(&mut store, OWNER, now + 2 * HOUR, "wear.record", p(2), "wear-0003").await.unwrap();
    assert_eq!(c["outcome"], "committed");
    assert_eq!(c["result"]["additionalUnitEvents"], 1);
    assert_eq!(c["result"]["additionalUnitsAlreadyRecorded"], 1);
    assert_eq!(balances(&mut store, SOCK_GREY).await, (0, 3, 0));
    // Undoing that report restores only the unit it used.
    undo(&mut store, OWNER, now + 3 * HOUR, &c, "undo-wear-0003").await.unwrap();
    assert_eq!(balances(&mut store, SOCK_GREY).await, (1, 2, 0));
}

#[tokio::test]
async fn a_never_laundered_pair_moves_nothing_and_restricted_footwear_is_recorded_with_a_repair() {
    let mut store = MemStore::default();
    let now = T0 + 10 * HOUR;
    let boots = wore(&mut store, OWNER, now, YESTERDAY, &[CLIFFORD_BOOT], "wear-0001").await;
    assert_eq!(boots["result"]["counted"], json!([CLIFFORD_BOOT]));
    let repairs: Vec<&str> = boots["repairs"].as_array().unwrap().iter().map(|r| r.as_str().unwrap()).collect();
    assert!(repairs.iter().any(|r| r.contains("worn while restricted") && r.contains("the restriction is unchanged")), "{repairs:?}");
    assert_eq!(balances(&mut store, CLIFFORD_BOOT).await, (1, 0, 0));
    let sneakers = wore(&mut store, OWNER, now + HOUR, YESTERDAY, &[NB_GREY], "wear-0002").await;
    assert_eq!(sneakers["repairs"], json!([]));
    assert_eq!(balances(&mut store, NB_GREY).await, (1, 0, 0));
}

#[tokio::test]
async fn a_wear_pulls_a_piece_back_from_the_laundry_and_is_not_undone_once_a_pickup_relies_on_it() {
    let mut store = MemStore::default();
    // In the hamper, then collected: the ledger has it at the laundry.
    run(&mut store, OWNER, T0, "care.mark_dirty", json!({"items": [{"garmentId": OXFORD_BLUE}]}), "dirty-0001").await.unwrap();
    run(&mut store, OWNER, T0 + HOUR, "laundry.collect", json!({}), "collect-0001").await.unwrap();
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, (0, 0, 1));
    let w = wore(&mut store, OWNER, T0 + 2 * HOUR, TODAY, &[OXFORD_BLUE], "wear-0001").await;
    assert!(w["repairs"].as_array().unwrap().iter().any(|r| r.as_str().unwrap().contains("at the laundry")), "{}", w["repairs"]);
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, (0, 1, 0));
    undo(&mut store, OWNER, T0 + 3 * HOUR, &w, "undo-wear-0001").await.unwrap();
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, (0, 0, 1));

    // Collected in the afternoon, reported worn today later: the wear is now, after the pickup, so
    // the shirt is pulled back from the laundry (not ordered at noon, before the pickup).
    let mut store = MemStore::default();
    let afternoon = T0 + 14 * HOUR; // 2026-09-10T14:26Z
    run(&mut store, OWNER, T0, "care.mark_dirty", json!({"items": [{"garmentId": OXFORD_BLUE}]}), "dirty-0001").await.unwrap();
    run(&mut store, OWNER, afternoon, "laundry.collect", json!({}), "collect-0001").await.unwrap();
    let w = wore(&mut store, OWNER, afternoon + 2 * HOUR, TODAY, &[OXFORD_BLUE], "wear-0001").await;
    assert!(w["repairs"].as_array().unwrap().iter().any(|r| r.as_str().unwrap().contains("at the laundry")), "{}", w["repairs"]);
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, (0, 1, 0));

    // Worn today, then a pickup: the shirt is on the body, so the bag does not take it.
    let mut store = MemStore::default();
    wore(&mut store, OWNER, T0 + HOUR, TODAY, &[GREY_CHINO], "wear-0001").await;
    let c = run(&mut store, OWNER, T0 + 2 * HOUR, "laundry.collect", json!({}), "collect-0001").await.unwrap();
    assert_eq!(c["outcome"], "noop");
    assert_eq!(balances(&mut store, GREY_CHINO).await, (0, 1, 0));

    // Worn today with a further unit: both are on the owner, so neither goes in the bag nor is washed.
    let mut store = MemStore::default();
    const NAVY_TROUSER: &str = "gmt_58fb8730a65c17ad9bc80215"; // service laundry, two units
    run(&mut store, OWNER, T0 + HOUR, "wear.record", json!({"wearingDate": TODAY, "garmentIds": [NAVY_TROUSER], "additionalUnits": [{"garmentId": NAVY_TROUSER, "quantity": 1}]}), "wear-0001").await.unwrap();
    assert_eq!(balances(&mut store, NAVY_TROUSER).await, (0, 2, 0));
    let c = run(&mut store, OWNER, T0 + 2 * HOUR, "laundry.collect", json!({}), "collect-0001").await.unwrap();
    assert_eq!(c["outcome"], "noop");
    let r = run(&mut store, OWNER, T0 + 3 * HOUR, "laundry.return", json!({}), "return-0001").await.unwrap();
    assert_eq!(r["outcome"], "noop");
    assert_eq!(balances(&mut store, NAVY_TROUSER).await, (0, 2, 0));

    // Worn yesterday, then picked up: withdrawing the wear would empty the pickup, so it stays.
    let mut store = MemStore::default();
    let w = wore(&mut store, OWNER, T0 + HOUR, YESTERDAY, &[GREY_CHINO], "wear-0001").await;
    let c = run(&mut store, OWNER, T0 + 2 * HOUR, "laundry.collect", json!({}), "collect-0001").await.unwrap();
    assert_eq!(c["result"]["units"], 1);
    let before = revision(&mut store).await;
    let e = undo(&mut store, OWNER, T0 + 3 * HOUR, &w, "undo-wear-0001").await.unwrap_err();
    assert_eq!(e.code, "conflict");
    assert_eq!(revision(&mut store).await, before);
    assert_eq!(day_record(&mut store, YESTERDAY).await, vec![GREY_CHINO.to_string()]);
}

fn batch_versions(receipt: &Value) -> Vec<u64> {
    receipt["affected"].as_array().unwrap().iter().filter(|a| a["kind"] == "laundry_batch").map(|a| a["version"].as_u64().unwrap()).collect()
}

#[tokio::test]
async fn a_further_unit_is_a_different_unit_and_a_bag_it_comes_from_moves_to_a_new_version() {
    let mut store = MemStore::default();
    const NAVY_TROUSER: &str = "gmt_58fb8730a65c17ad9bc80215"; // service laundry, two units
    // One pair in the hamper, then collected: one clean at home, one at the laundry.
    run(&mut store, OWNER, T0, "care.mark_dirty", json!({"items": [{"garmentId": NAVY_TROUSER}]}), "dirty-0001").await.unwrap();
    let c = run(&mut store, OWNER, T0 + HOUR, "laundry.collect", json!({}), "collect-0001").await.unwrap();
    assert_eq!(batch_versions(&c), vec![1]);
    assert_eq!(balances(&mut store, NAVY_TROUSER).await, (1, 0, 1));
    // Both pairs worn today: the wear takes the clean pair, the further unit is the pair at the
    // laundry (not the one just worn), so both are with the owner and the bag moves on a version.
    let w = run(&mut store, OWNER, T0 + 2 * HOUR, "wear.record", json!({"wearingDate": TODAY, "garmentIds": [NAVY_TROUSER], "additionalUnits": [{"garmentId": NAVY_TROUSER, "quantity": 1}]}), "wear-0001").await.unwrap();
    assert_eq!(balances(&mut store, NAVY_TROUSER).await, (0, 2, 0));
    assert_eq!(batch_versions(&w), vec![2], "{}", w["affected"]);
    // The undo puts the pair back in the bag, and the bag moves on again.
    let u = undo(&mut store, OWNER, T0 + 3 * HOUR, &w, "undo-wear-0001").await.unwrap();
    assert_eq!(balances(&mut store, NAVY_TROUSER).await, (1, 0, 1));
    assert_eq!(batch_versions(&u), vec![3], "{}", u["affected"]);
    // A wear that touches no bag names none.
    let plain = wore(&mut store, OWNER, T0 + 4 * HOUR, TODAY, &[GREY_CHINO], "wear-0002").await;
    assert!(batch_versions(&plain).is_empty());
}

fn ledger_of(store: &MemStore) -> wardrobe::ledger::Ledger {
    let bytes = store.data.get(b"ledger".as_slice()).expect("a ledger");
    wardrobe::ledger::Ledger::from_json(&ferrite_app::serde_json::from_slice(bytes).unwrap()).expect("a readable ledger")
}

/// (id, atMs, seq, voided) of every further-unit event, in journal order.
fn extra_events(store: &MemStore) -> Vec<(String, u64, u64, bool)> {
    ledger_of(store).events.iter().filter(|e| e.kind == "extra_unit").map(|e| (e.id.clone(), e.at_ms, e.seq, e.voided_by.is_some())).collect()
}

fn socks(date: &str, total: u32) -> Value {
    json!({"wearingDate": date, "garmentIds": [SOCK_GREY], "additionalUnits": [{"garmentId": SOCK_GREY, "quantity": total}]})
}

// The rule (README, "Wear records"): withdrawing a report voids exactly that report's own further-
// unit increment and nothing else; no surviving event is consolidated, re-timed or recreated. If
// that would leave a standing report uncovered or change how another record was classified, the
// undo is refused with `conflict`.

#[tokio::test]
async fn rule_the_latest_further_unit_is_withdrawn_exactly_and_event_times_are_preserved() {
    let mut store = MemStore::default();
    let now = T0 + 10 * HOUR;
    let a = run_at(&mut store, OWNER, now, Some(T0 + HOUR), "wear.record", socks(TODAY, 1), "wear-0001").await.unwrap();
    let c = run_at(&mut store, OWNER, now, Some(T0 + 3 * HOUR), "wear.record", socks(TODAY, 2), "wear-0002").await.unwrap();
    assert_eq!(c["result"]["additionalUnitEvents"], 1);
    assert_eq!(balances(&mut store, SOCK_GREY).await, (0, 3, 0));
    let before = extra_events(&store);
    assert_eq!(before.len(), 2);
    let u = undo(&mut store, OWNER, now + HOUR, &c, "undo-wear-0002").await.unwrap();
    assert_eq!(u["outcome"], "committed");
    assert_eq!(balances(&mut store, SOCK_GREY).await, (1, 2, 0));
    // Only the later increment is voided; the earlier keeps its ID, time and place; nothing new.
    let after = extra_events(&store);
    assert_eq!(after.len(), 2, "the undo journals no event");
    assert_eq!(after[0], before[0]);
    assert_eq!((&after[1].0, after[1].1, after[1].2, after[1].3), (&before[1].0, before[1].1, before[1].2, true));
    assert!(ledger_of(&store).events.iter().all(|e| e.command_id != u["commandId"].as_str().unwrap()));
    // The first report then goes too, exactly.
    undo(&mut store, OWNER, now + 2 * HOUR, &a, "undo-wear-0001").await.unwrap();
    assert_eq!(balances(&mut store, SOCK_GREY).await, (3, 0, 0));
}

#[tokio::test]
async fn rule_an_earlier_further_unit_a_later_record_depends_on_is_refused_as_conflict() {
    let now = T0 + 10 * HOUR;
    // Yesterday two pairs (one further); a second report of the wear alone keeps the wear standing.
    // Today two pairs again: the last clean pair, and a further one with none clean (a repair).
    let mut store = MemStore::default();
    let a = run(&mut store, OWNER, now, "wear.record", socks(YESTERDAY, 1), "wear-0001").await.unwrap();
    wore(&mut store, ASSISTANT, now, YESTERDAY, &[SOCK_GREY], "wear-0002").await;
    let t = run(&mut store, OWNER, now + HOUR, "wear.record", socks(TODAY, 1), "wear-0003").await.unwrap();
    assert!(t["repairs"].as_array().unwrap().iter().any(|r| r.as_str().unwrap().contains("no clean unit")), "{}", t["repairs"]);
    let before = (revision(&mut store).await, extra_events(&store));
    // Withdrawing yesterday's further pair would turn today's repair into a clean pair used: refused.
    let e = undo(&mut store, OWNER, now + 2 * HOUR, &a, "undo-wear-0001").await.unwrap_err();
    assert_eq!(e.code, "conflict", "{}", e.message);
    assert_eq!((revision(&mut store).await, extra_events(&store)), before);
    // Once today's report is undone, yesterday's is withdrawn exactly.
    undo(&mut store, OWNER, now + 3 * HOUR, &t, "undo-wear-0003").await.unwrap();
    undo(&mut store, OWNER, now + 4 * HOUR, &a, "undo-wear-0001").await.unwrap();
    assert_eq!(balances(&mut store, SOCK_GREY).await, (2, 1, 0));

    // A standing report whose total the increment covers relies on it too: undo that one first.
    let mut store = MemStore::default();
    let a = run(&mut store, OWNER, now, "wear.record", socks(YESTERDAY, 1), "wear-0001").await.unwrap();
    let b = run(&mut store, ASSISTANT, now + HOUR, "wear.record", socks(YESTERDAY, 1), "wear-0002").await.unwrap();
    assert_eq!(b["outcome"], "merged");
    let e = undo(&mut store, OWNER, now + 2 * HOUR, &a, "undo-wear-0001").await.unwrap_err();
    assert_eq!(e.code, "conflict", "{}", e.message);
    assert_eq!(balances(&mut store, SOCK_GREY).await, (1, 2, 0));
    undo(&mut store, ASSISTANT, now + 3 * HOUR, &b, "undo-wear-0002").await.unwrap();
    undo(&mut store, OWNER, now + 4 * HOUR, &a, "undo-wear-0001").await.unwrap();
    assert_eq!(balances(&mut store, SOCK_GREY).await, (3, 0, 0));
}

#[tokio::test]
async fn rule_an_unrelated_later_record_does_not_block_the_undo() {
    let mut store = MemStore::default();
    let now = T0 + 10 * HOUR;
    let a = run(&mut store, OWNER, now, "wear.record", socks(YESTERDAY, 1), "wear-0001").await.unwrap();
    // Later records of other garments, and a report of the socks' wear with no further unit.
    wore(&mut store, OWNER, now + HOUR, TODAY, &[GREY_CHINO], "wear-0002").await;
    run(&mut store, OWNER, now + HOUR, "care.mark_dirty", json!({"items": [{"garmentId": OXFORD_BLUE}]}), "dirty-0001").await.unwrap();
    wore(&mut store, ASSISTANT, now + 2 * HOUR, YESTERDAY, &[SOCK_GREY], "wear-0003").await;
    let u = undo(&mut store, OWNER, now + 3 * HOUR, &a, "undo-wear-0001").await.unwrap();
    assert_eq!(u["outcome"], "committed");
    // The further pair is clean again; the wear the other report stands for stays.
    assert_eq!(balances(&mut store, SOCK_GREY).await, (2, 1, 0));
    assert_eq!(balances(&mut store, GREY_CHINO).await, (0, 1, 0));
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, (0, 1, 0));
}

#[tokio::test]
async fn a_pickup_holds_back_one_unit_for_a_unit_worn_on_successive_days() {
    let mut store = MemStore::default();
    const NAVY_TROUSER: &str = "gmt_58fb8730a65c17ad9bc80215"; // service laundry, two units
    let now = T0 + 10 * HOUR;
    // Both pairs in the hamper two days ago; one pair worn yesterday and again today (repairs: no clean pair).
    run_at(&mut store, OWNER, now, Some(T0 - 48 * HOUR), "care.mark_dirty", json!({"items": [{"garmentId": NAVY_TROUSER, "quantity": 2}]}), "dirty-0001").await.unwrap();
    wore(&mut store, OWNER, now, YESTERDAY, &[NAVY_TROUSER], "wear-0001").await;
    wore(&mut store, OWNER, now + HOUR, TODAY, &[NAVY_TROUSER], "wear-0002").await;
    assert_eq!(balances(&mut store, NAVY_TROUSER).await, (0, 2, 0));
    // A pickup yesterday afternoon: one pair is on the owner (the same pair both days), one goes.
    let c = run_at(&mut store, OWNER, now + 2 * HOUR, Some(T0 - 10 * HOUR), "laundry.collect", json!({}), "collect-0001").await.unwrap();
    assert_eq!(c["result"]["units"], 1, "{}", c["result"]);
    assert_eq!(balances(&mut store, NAVY_TROUSER).await, (0, 1, 1));
}

#[tokio::test]
async fn wear_refusals_write_nothing() {
    let mut store = MemStore::default();
    let now = T0 + 10 * HOUR;
    let cases: Vec<(Value, Option<u64>, &str)> = vec![
        (json!({"wearingDate": "2026-09-12", "garmentIds": [OXFORD_BLUE]}), None, "invalid_command"),
        (json!({"wearingDate": YESTERDAY, "garmentIds": [OXFORD_BLUE], "tripId": "trip_1"}), None, "invalid_command"),
        (json!({"wearingDate": YESTERDAY, "garmentIds": []}), None, "invalid_command"),
        (json!({"wearingDate": "2026-02-30", "garmentIds": [OXFORD_BLUE]}), None, "invalid_command"),
        (json!({"wearingDate": YESTERDAY, "garmentIds": [OXFORD_BLUE], "colour": "blue"}), None, "invalid_command"),
        (json!({"wearingDate": YESTERDAY, "garmentIds": [OXFORD_BLUE], "additionalUnits": [{"garmentId": SOCK_GREY, "quantity": 0}]}), None, "invalid_command"),
        // A further unit of a garment not reported as worn.
        (json!({"wearingDate": YESTERDAY, "garmentIds": [OXFORD_BLUE], "additionalUnits": [{"garmentId": SOCK_GREY, "quantity": 1}]}), None, "invalid_command"),
        (json!({"wearingDate": YESTERDAY, "garmentIds": ["gmt_not_a_garment"]}), None, "not_found"),
        // A stated time more than a day before the wearing date began.
        (json!({"wearingDate": TODAY, "garmentIds": [OXFORD_BLUE]}), Some(T0 - 3 * 24 * HOUR), "invalid_command"),
    ];
    for (i, (payload, occurred, code)) in cases.into_iter().enumerate() {
        let e = run_at(&mut store, OWNER, now, occurred, "wear.record", payload.clone(), &format!("refused-{i:04}")).await.unwrap_err();
        assert_eq!(e.code, code, "{payload}");
    }
    assert_eq!(revision(&mut store).await, 0);
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, (1, 0, 0));
    assert_eq!(balances(&mut store, SOCK_GREY).await, (3, 0, 0));
}

#[tokio::test]
async fn stored_wear_undo_data_that_does_not_match_the_journal_is_refused_as_corrupt() {
    let mut store = MemStore::default();
    let r = wore(&mut store, OWNER, T0 + 10 * HOUR, YESTERDAY, &[OXFORD_BLUE], "wear-0001").await;
    let key = format!("c/{}", r["commandId"].as_str().unwrap()).into_bytes();
    let good: Value = ferrite_app::serde_json::from_slice(store.data.get(&key).unwrap()).unwrap();
    // Shapes the validator refuses: every read of the record is then internal, not a partial receipt.
    for (what, path, bad) in [
        ("no reports", "/undo/data/observationIds", json!([])),
        ("date", "/undo/data/wearingDate", json!("yesterday")),
        ("events", "/undo/data/stockEventIds", json!([3])),
        ("result", "/receipt/result/counted", json!([null])),
        ("result without reports", "/receipt/result/observationIds", json!([])),
        ("repeated report", "/receipt/result/observationIds", json!(["obs_a_1", "obs_a_1"])),
        ("counted and merged", "/receipt/result/merged", json!([OXFORD_BLUE])),
        ("merged outcome that counted", "/receipt/outcome", json!("merged")),
        ("committed outcome that counted nothing", "/receipt/result/counted", json!([])),
        ("result date not the undo's", "/receipt/result/wearingDate", json!("2026-09-01")),
        ("result reports not the undo's", "/receipt/result/observationIds", json!(["obs_unrelated_1"])),
        ("further-unit count not the undo's", "/receipt/result/additionalUnitEvents", json!(1)),
        ("repeated report in the undo", "/undo/data/observationIds", json!(["obs_a_1", "obs_a_1"])),
    ] {
        let mut record = good.clone();
        *record.pointer_mut(path).unwrap_or_else(|| panic!("{what}")) = bad;
        store.data.insert(key.clone(), record.to_string().into_bytes());
        assert_eq!(api::receipts_page(&mut store, 10).await.unwrap_err().code, "internal", "{what}");
    }
    // Well-formed and self-consistent but naming reports this command did not make: the undo is
    // refused against the journal, nothing written.
    let mut record = good.clone();
    *record.pointer_mut("/undo/data/observationIds").unwrap() = json!(["obs_someone_else_1"]);
    *record.pointer_mut("/receipt/result/observationIds").unwrap() = json!(["obs_someone_else_1"]);
    store.data.insert(key.clone(), record.to_string().into_bytes());
    assert!(api::receipts_page(&mut store, 10).await.is_ok());
    let e = undo(&mut store, OWNER, T0 + 11 * HOUR, &r, "undo-wear-0001").await.unwrap_err();
    assert_eq!(e.code, "internal");
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, (0, 1, 0));

    // One further-unit event named twice, with a count to match: refused on read.
    let mut store = MemStore::default();
    let r = run(&mut store, OWNER, T0 + 10 * HOUR, "wear.record", socks(YESTERDAY, 1), "wear-0001").await.unwrap();
    let key = format!("c/{}", r["commandId"].as_str().unwrap()).into_bytes();
    let good: Value = ferrite_app::serde_json::from_slice(store.data.get(&key).unwrap()).unwrap();
    let event = good.pointer("/undo/data/stockEventIds/0").unwrap().clone();
    let mut record = good.clone();
    *record.pointer_mut("/undo/data/stockEventIds").unwrap() = json!([event, event]);
    *record.pointer_mut("/receipt/result/additionalUnitEvents").unwrap() = json!(2);
    store.data.insert(key.clone(), record.to_string().into_bytes());
    assert_eq!(api::receipts_page(&mut store, 10).await.unwrap_err().code, "internal");
    store.data.insert(key, good.to_string().into_bytes());
    assert!(api::receipts_page(&mut store, 10).await.is_ok());
}
