//! Recommendations (`garderobe_recommend` and `recommend::recommend`) on the owner's real inventory:
//! every option is a complete outfit the board validator accepts, nothing is published or logged,
//! a client request ID is a durable run (a repeat answers from it, a different request is refused),
//! and recorded wear and wash reports change what is offered.
//!
//! The store is an in-memory test double of the APE binding (the same guarded-commit semantics); the
//! garments and rules are the real seed. No model, forecast or Calendar is involved anywhere.

use std::collections::{BTreeMap, BTreeSet};
use std::io;

use ferrite_app::serde_json::{json, Map, Value};
use wardrobe::api::{self, Principal, Store, OWNER};
use wardrobe::recommend::{self, parse_input, seeded_unit, RecommendInput};
use wardrobe::seed::catalogue;

const T0: u64 = 1_789_000_000_000; // 2026-09-10T00:26:40Z
const TODAY: &str = "2026-09-10";
const DAY: &str = "2026-09-11";

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

fn input(id: &str, date: &str, count: Option<u64>) -> RecommendInput {
    RecommendInput { client_request_id: id.into(), date: date.into(), brief: None, count }
}

async fn run(store: &mut MemStore, who: Principal, now: u64, kind: &str, payload: Value, key: &str) -> Value {
    let (auth, channel) = if who == OWNER { ("owner_tap", "ios") } else { ("owner_statement", "mcp") };
    let env = json!({"type": kind, "payload": payload, "idempotencyKey": key, "authorization": auth, "source": {"channel": channel}});
    api::execute(store, who, now, &env).await.unwrap()
}

fn garments(option: &Value) -> Vec<(String, String)> {
    option["garments"].as_array().unwrap().iter().map(|g| (g["role"].as_str().unwrap().to_string(), g["garmentId"].as_str().unwrap().to_string())).collect()
}

fn piece(option: &Value, role: &str) -> Option<String> {
    garments(option).into_iter().find(|(r, _)| r == role).map(|(_, id)| id)
}

/// The option as a `board.publish` option: its garments and its flourish.
fn as_published(option: &Value) -> Value {
    let mut slots: Vec<Value> = garments(option).into_iter().map(|(role, id)| json!({"role": role, "garmentId": id})).collect();
    if let Some(f) = option["flourish"].as_object() {
        slots.push(json!({"role": "neckwear", "garmentId": f["garmentId"]}));
    }
    json!({"slots": slots, "reason": option["reason"]})
}

#[test]
fn the_seeded_tie_break_is_the_typescript_hash() {
    // Values computed by packages/daily/src/model.ts `seededUnit` under node.
    assert_eq!(seeded_unit(&["owner", "2026-09-11", "gmt_a", "gmt_b"]), 0.71013);
    assert_eq!(seeded_unit(&["owner|2026-09-11|x|y", "gmt_c"]), 0.17673);
    assert_eq!(seeded_unit(&["é—🙂"]), 0.90411);
    assert_eq!(seeded_unit(&[""]), 0.72289);
}

#[tokio::test]
async fn five_complete_validated_outfits_by_default_and_nothing_is_published_or_logged() {
    let mut store = MemStore::default();
    let r = recommend::recommend(&mut store, "mcp:grant_a", T0, &input("rec-00000001", DAY, None)).await.unwrap();
    assert_eq!((r["state"].clone(), r["runId"].clone(), r["board"].clone(), r["localDate"].clone()), (json!("completed"), Value::Null, Value::Null, json!(DAY)));
    let options = r["options"].as_array().unwrap();
    assert_eq!(options.len(), 5, "the profile's default option count");
    assert_eq!((r["insufficient"].clone(), r["note"].clone()), (json!(false), Value::Null));
    let cat = catalogue();
    let mut shirts = BTreeSet::new();
    for (i, o) in options.iter().enumerate() {
        assert_eq!(o["optionId"], format!("preview-{}", i + 1));
        assert_eq!(o["number"], i + 1);
        for role in ["top", "bottom", "socks", "footwear"] {
            assert!(piece(o, role).is_some(), "option {} has no {role}", i + 1);
        }
        // Sneakers only while the healing restriction holds; never the same shirt twice.
        let shoe = cat.get(&piece(o, "footwear").unwrap()).unwrap();
        assert_eq!(shoe.attr_str("footwearKind"), "sneaker", "{}", shoe.name);
        assert!(shirts.insert(piece(o, "top").unwrap()), "a shirt offered twice");
        // The title and the lines are record names.
        let top = cat.get(&piece(o, "top").unwrap()).unwrap();
        let bottom = cat.get(&piece(o, "bottom").unwrap()).unwrap();
        assert_eq!(o["name"], format!("{} with {}", top.name, bottom.name));
        // A jacket goes only over a lightweight oxford: the 14-16 C band cannot be ruled out.
        if piece(o, "outer").is_some() {
            assert_eq!(top.attr_str("fabricClass"), "lightweight_oxford", "{}", o);
        }
    }
    // Nothing was published or logged: no receipt, no ledger, no board; only the run is recorded.
    assert_eq!(store.data.keys().map(|k| String::from_utf8_lossy(&k[..2]).to_string()).collect::<Vec<_>>(), vec!["u/".to_string()]);
    assert_eq!(api::read_today(&mut store, T0, Some(DAY)).await.unwrap()["board"], Value::Null);
    // The owner can publish every option as it stands: the board validator accepts them all.
    let published = run(&mut store, OWNER, T0, "board.publish", json!({"localDate": DAY, "requestedCount": 5, "options": options.iter().map(as_published).collect::<Vec<_>>()}), "publish-0001").await;
    assert_eq!((published["result"]["offered"].clone(), published["result"]["dropped"].clone()), (json!(5), json!([])), "{}", published["result"]);
}

#[tokio::test]
async fn a_request_id_is_a_durable_run_and_the_composition_is_reproducible() {
    let mut store = MemStore::default();
    let first = recommend::recommend(&mut store, "mcp:grant_a", T0, &input("rec-00000001", DAY, Some(3))).await.unwrap();
    // A retransmission answers from the run, naming it, with the same options.
    let again = recommend::recommend(&mut store, "mcp:grant_a", T0 + 60_000, &input("rec-00000001", DAY, Some(3))).await.unwrap();
    assert_eq!(again["options"], first["options"]);
    assert!(again["runId"].as_str().unwrap().starts_with("run_"));
    assert_eq!(again["runId"].as_str().unwrap(), recommend::run_id_for("recommendation", "mcp:grant_a", "rec-00000001"));
    // The same ID for a different request is refused.
    let e = recommend::recommend(&mut store, "mcp:grant_a", T0, &input("rec-00000001", DAY, Some(4))).await.unwrap_err();
    assert_eq!(e.code, "idempotency_key_reuse");
    // Another connection's request ID is its own; the same state composes the same options.
    let other = recommend::recommend(&mut store, "mcp:grant_b", T0, &input("rec-00000001", DAY, Some(3))).await.unwrap();
    assert_eq!((other["runId"].clone(), other["options"].clone()), (Value::Null, first["options"].clone()));
    // Eight is the most a request may ask for, and the owner's 43 shirts give eight.
    let eight = recommend::recommend(&mut store, "mcp:grant_a", T0, &input("rec-00000002", DAY, Some(8))).await.unwrap();
    assert_eq!(eight["options"].as_array().unwrap().len(), 8);
    assert_eq!(eight["options"].as_array().unwrap()[..3], first["options"].as_array().unwrap()[..]);
}

#[tokio::test]
async fn worn_trousers_and_a_shirt_in_the_wash_are_not_recommended() {
    let mut store = MemStore::default();
    let before = recommend::recommend(&mut store, "mcp:grant_a", T0, &input("rec-00000001", DAY, Some(5))).await.unwrap();
    let first = &before["options"][0];
    let (shirt, trousers) = (piece(first, "top").unwrap(), piece(first, "bottom").unwrap());
    // The owner says he wore the trousers today and the shirt is in the wash.
    run(&mut store, OWNER, T0 + 1_000, "wear.record", json!({"wearingDate": TODAY, "garmentIds": [trousers]}), "wear-0001").await;
    run(&mut store, OWNER, T0 + 2_000, "care.mark_dirty", json!({"items": [{"garmentId": shirt}]}), "dirty-0001").await;
    let after = recommend::recommend(&mut store, "mcp:grant_a", T0 + 3_000, &input("rec-00000002", DAY, Some(8))).await.unwrap();
    for o in after["options"].as_array().unwrap() {
        assert_ne!(piece(o, "top").as_deref(), Some(shirt.as_str()), "a shirt in the wash was offered");
        assert_ne!(piece(o, "bottom").as_deref(), Some(trousers.as_str()), "trousers worn inside the seven-day horizon were offered");
    }
    // A repeat of the first request answers from its run with the state it was composed from:
    // the same options and revision 0, not the revision the two later reports made.
    let replayed = recommend::recommend(&mut store, "mcp:grant_a", T0 + 3_500, &input("rec-00000001", DAY, Some(5))).await.unwrap();
    assert_eq!((before["wardrobeRevision"].clone(), after["wardrobeRevision"].clone()), (json!(0), json!(2)));
    assert_eq!(replayed["options"], before["options"]);
    assert_eq!((replayed["wardrobeRevision"].clone(), replayed["readAt"].clone()), (json!(0), before["readAt"].clone()));
    // A week and a day on, the wear is outside the horizon; the shirt is still in the wash.
    let later = recommend::recommend(&mut store, "mcp:grant_a", T0 + 4_000, &input("rec-00000003", "2026-09-18", Some(8))).await.unwrap();
    assert!(later["options"].as_array().unwrap().iter().all(|o| piece(o, "top").as_deref() != Some(shirt.as_str())));
    // Recommending is a read: the ledger revision is what the two reports made it.
    assert_eq!(later["wardrobeRevision"], 2);
}

#[tokio::test]
async fn a_brief_is_said_to_be_unread_and_bad_arguments_are_refused() {
    let mut store = MemStore::default();
    let mut args = Map::new();
    args.insert("date".into(), json!(DAY));
    args.insert("clientRequestId".into(), json!("rec-00000009"));
    args.insert("brief".into(), json!("something for the office; wear the welted boots"));
    args.insert("count".into(), json!(2));
    let parsed = parse_input(&args).unwrap();
    let r = recommend::recommend(&mut store, "mcp:grant_a", T0, &parsed).await.unwrap();
    assert!(r["note"].as_str().unwrap().contains("The brief was not read"), "{}", r["note"]);
    assert!(recommend::summary(&r).starts_with("2 validated option(s) for 2026-09-11: "));
    // Asking for boots never makes them eligible.
    let cat = catalogue();
    assert!(r["options"].as_array().unwrap().iter().all(|o| cat.get(&piece(o, "footwear").unwrap()).unwrap().attr_str("footwearKind") == "sneaker"));
    for (key, value) in [("count", json!(0)), ("count", json!(9)), ("count", json!(1.5)), ("date", json!("2026-02-30")), ("clientRequestId", json!("short")), ("owner", json!("someone")), ("brief", json!("x".repeat(2001)))] {
        let mut bad = args.clone();
        bad.insert(key.into(), value.clone());
        assert_eq!(parse_input(&bad).unwrap_err().code, "invalid_command", "{key}={value}");
    }
    let mut undated = args.clone();
    undated.remove("date");
    assert!(parse_input(&undated).unwrap_err().message.contains("no owner timezone"));
}
