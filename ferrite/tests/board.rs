//! The day board through the command service (`api::execute`, `api::read_today`):
//! publish with validation against the owner's real inventory, choose and
//! undo, swap and undo (including a chain of swaps), expected board versions,
//! and the refusals that write nothing.
//!
//! The store is an in-memory test double of the APE binding (the same
//! guarded-commit semantics); the garments and rules are the real seed.

use std::collections::BTreeMap;
use std::io;

use ferrite_app::serde_json::{json, Value};
use wardrobe::api::{self, Principal, Store, ASSISTANT, OWNER};
use wardrobe::board::colour_family;
use wardrobe::seed::catalogue;

const T0: u64 = 1_789_000_000_000; // 2026-09-10T00:26:40Z
const DAY: &str = "2026-09-11";

// Real garments from the owner's inventory.
const OXFORD_BLUE: &str = "gmt_3894b6a6295908d5e687af4f"; // Lightweight oxford — blue
const OXFORD_PINK: &str = "gmt_41c2da80e7f41e5dc6a4340b"; // Lightweight oxford — pink
const PIMA_WHITE: &str = "gmt_2d22145b2318255c0a0f6f2d"; // Pima oxford — white (heavy oxford)
const CANCLINI: &str = "gmt_45d928c9831bc5eb71a701db"; // layering only
const AKITA_CREAM: &str = "gmt_0bd82c642c7606199361d3d4";
const GREY_CHINO: &str = "gmt_b8744c2627cd88a3b937f851";
const SOCK_BISCUIT: &str = "gmt_9eb32f6a40ea3e5e4dee484b";
const SOCK_GREY: &str = "gmt_67d3228f744d17138e400729";
const BED_SOCK: &str = "gmt_8c8b983912a6effbc6b33a86"; // indoor only
const NB_GREY: &str = "gmt_14bc4338d6760f6a13434b2f";
const NB_OLIVE: &str = "gmt_185ccf753d109848f21f7cec";
const REIMS: &str = "gmt_a8fe5fe3a6c0754361249bf8"; // welted: excluded while sneakers-only holds
const BELT_BROWN: &str = "gmt_6335e17bcb19fb15f77c31bf";
const BELT_BLACK: &str = "gmt_4f778d8afb62d536e5fc036b";
const GAMES_JACKET: &str = "gmt_0573b00364cad2ee03e8b70f"; // Drake's Navy Cotton-Linen Games

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

fn outfit(top: &str, bottom: &str, socks: &str, shoes: &str, belt: &str) -> Value {
    json!({"slots": [{"role": "top", "garmentId": top}, {"role": "bottom", "garmentId": bottom}, {"role": "belt", "garmentId": belt}, {"role": "socks", "garmentId": socks}, {"role": "footwear", "garmentId": shoes}], "reason": ""})
}

fn two_outfits() -> Value {
    json!([outfit(OXFORD_BLUE, AKITA_CREAM, SOCK_BISCUIT, NB_GREY, BELT_BROWN), outfit(OXFORD_PINK, GREY_CHINO, SOCK_GREY, NB_OLIVE, BELT_BLACK)])
}

async fn run(store: &mut MemStore, who: Principal, now: u64, kind: &str, payload: Value, key: &str, versions: Option<Value>) -> Result<Value, wardrobe::ledger::CmdError> {
    let (auth, channel) = if who == OWNER { ("owner_tap", "ios") } else { ("owner_statement", "mcp") };
    let mut env = json!({"type": kind, "payload": payload, "idempotencyKey": key, "authorization": auth, "source": {"channel": channel}});
    if let Some(v) = versions {
        env["expectedVersions"] = v;
    }
    api::execute(store, who, now, &env).await
}

async fn board(store: &mut MemStore) -> Value {
    api::read_today(store, T0 + 5_000, Some(DAY)).await.unwrap()["board"].clone()
}

fn pieces(board: &Value) -> Vec<String> {
    let mut out: Vec<String> = board["options"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| format!("{}={}", o["optionId"].as_str().unwrap(), o["garments"].as_array().unwrap().iter().map(|g| format!("{}:{}", g["role"].as_str().unwrap(), g["garmentId"].as_str().unwrap())).collect::<Vec<_>>().join(",")))
        .collect();
    out.sort();
    out
}

fn versions(b: &Value) -> Option<Value> {
    Some(json!({format!("board:{}", b["boardId"].as_str().unwrap()): b["revision"]}))
}

async fn published(store: &mut MemStore) -> Value {
    let r = run(store, OWNER, T0, "board.publish", json!({"localDate": DAY, "requestedCount": 2, "options": two_outfits()}), "publish-0001", None).await.unwrap();
    assert_eq!(r["undo"]["available"], false);
    board(store).await
}

#[tokio::test]
async fn a_published_board_reads_back_as_the_today_document() {
    let mut store = MemStore::default();
    let empty = api::read_today(&mut store, T0, Some(DAY)).await.unwrap();
    assert_eq!((empty["board"].clone(), empty["emptyReason"].is_string()), (Value::Null, true));
    assert_eq!(api::read_today(&mut store, T0, None).await.unwrap_err().code, "invalid_command", "no owner timezone: the day must be named");

    let r = run(&mut store, OWNER, T0, "board.publish", json!({"localDate": DAY, "requestedCount": 2, "options": two_outfits()}), "publish-0001", None).await.unwrap();
    assert_eq!(r["summary"], "Board for 2026-09-11 published (revision 1): 2 outfits");
    assert_eq!(r["affected"][0]["kind"], "board");
    let b = board(&mut store).await;
    assert_eq!((b["revision"].clone(), b["validity"].clone(), b["dayLine"].clone()), (json!(1), json!("limited"), json!("Friday 11 September")));
    assert_eq!(b["options"].as_array().unwrap().len(), 2);
    assert_eq!(b["options"][0]["name"], "Lightweight oxford — blue with Akita slub 5-pocket — cream");
    // The reason is built from record names, never invented, and states no temperature.
    assert_eq!(b["options"][0]["reason"], "Warm against cool: Lightweight oxford — blue over Akita slub 5-pocket — cream.");
    assert!(b["notice"].as_str().unwrap().contains("forecast is unavailable") && b["notice"].as_str().unwrap().contains("Calendar is not connected"));
    assert_eq!((b["freshness"]["weather"].clone(), b["freshness"]["calendar"].clone()), (json!("unavailable"), json!("not_connected")));
    assert_eq!(b["selection"], Value::Null);
    // A prose reason with an item code is replaced by the factual one.
    let mut o = two_outfits();
    o[0]["reason"] = json!(format!("Wear {OXFORD_BLUE} today"));
    run(&mut store, OWNER, T0, "board.publish", json!({"localDate": DAY, "reason": "refresh", "requestedCount": 2, "options": o}), "publish-0002", None).await.unwrap();
    let b = board(&mut store).await;
    assert!(!b["options"][0]["reason"].as_str().unwrap().contains("gmt_"));
    // New options are named in the changes.
    assert_eq!(b["revision"], 2);
    assert!(b["changes"].as_array().unwrap().iter().any(|c| c.as_str().unwrap().contains("was withdrawn") || c.as_str().unwrap().contains("is new")));

    // Option identities stay when the same options are republished with their IDs.
    let ids: Vec<Value> = b["options"].as_array().unwrap().iter().map(|o| o["optionId"].clone()).collect();
    let mut again = two_outfits();
    again[0]["optionId"] = ids[0].clone();
    again[1]["optionId"] = ids[1].clone();
    run(&mut store, OWNER, T0, "board.publish", json!({"localDate": DAY, "reason": "refresh", "requestedCount": 2, "options": again}), "publish-0003", None).await.unwrap();
    let b = board(&mut store).await;
    assert_eq!(b["revision"], 3);
    assert_eq!(b["options"].as_array().unwrap().iter().map(|o| o["optionId"].clone()).collect::<Vec<_>>(), ids);
    assert_eq!(b["options"][1]["changedInRevision"], false, "the same pieces under the same ID are unchanged");

    // One existing ID on two different outfits names only the first; the second gets its own ID.
    let mut twice = two_outfits();
    twice[0]["optionId"] = ids[0].clone();
    twice[1]["optionId"] = ids[0].clone();
    run(&mut store, OWNER, T0, "board.publish", json!({"localDate": DAY, "reason": "refresh", "requestedCount": 2, "options": twice}), "publish-0004", None).await.unwrap();
    let b = board(&mut store).await;
    let (a, c) = (b["options"][0]["optionId"].clone(), b["options"][1]["optionId"].clone());
    assert_eq!(a, ids[0]);
    assert_ne!(c, a, "option IDs on one board are distinct");
}

#[tokio::test]
async fn a_board_read_after_a_wash_report_says_which_outfit_is_no_longer_wearable() {
    let mut store = MemStore::default();
    let b0 = published(&mut store).await;
    assert!(b0["options"].as_array().unwrap().iter().all(|o| o["qualification"].is_null()));
    let board_id = b0["boardId"].as_str().unwrap().to_string();
    let first = b0["options"][0]["optionId"].as_str().unwrap().to_string();
    // The only blue oxford goes in the wash after the board was published.
    run(&mut store, OWNER, T0 + 1_000, "care.mark_dirty", json!({"items": [{"garmentId": OXFORD_BLUE}]}), "dirty-after-pub", None).await.unwrap();
    let b1 = board(&mut store).await;
    assert_eq!(b1["validity"], "degraded");
    assert!(b1["options"][0]["qualification"].as_str().unwrap().contains("awaiting care"), "{}", b1["options"][0]);
    assert!(b1["options"][1]["qualification"].is_null());
    assert_eq!(b1["freshness"]["wardrobeRevision"], 2, "checked against the stock as it is now");
    // It cannot be chosen; the other outfit can.
    let before = store.clone();
    let e = run(&mut store, ASSISTANT, T0 + 2_000, "board.select", json!({"boardId": board_id, "optionId": first}), "select-stale-01", None).await.unwrap_err();
    assert_eq!(e.code, "precondition_failed");
    assert_eq!(store.data, before.data, "a refused choice writes nothing");
    let second = b0["options"][1]["optionId"].as_str().unwrap().to_string();
    assert!(run(&mut store, ASSISTANT, T0 + 2_000, "board.select", json!({"boardId": board_id, "optionId": second}), "select-stale-02", None).await.is_ok());
}

#[tokio::test]
async fn publishing_validates_every_option_against_the_owners_wardrobe_and_rules() {
    let mut store = MemStore::default();
    let bad = [
        (outfit(OXFORD_BLUE, AKITA_CREAM, SOCK_BISCUIT, REIMS, BELT_BROWN), "footwear_restricted"),
        (outfit(OXFORD_BLUE, AKITA_CREAM, BED_SOCK, NB_GREY, BELT_BROWN), "conditional_not_requested"),
        (outfit(CANCLINI, AKITA_CREAM, SOCK_BISCUIT, NB_GREY, BELT_BROWN), "layering_only"),
        (json!({"slots": [{"role": "top", "garmentId": OXFORD_BLUE}, {"role": "bottom", "garmentId": AKITA_CREAM}, {"role": "footwear", "garmentId": NB_GREY}], "reason": ""}), "socks_required"),
        (outfit(AKITA_CREAM, OXFORD_BLUE, SOCK_BISCUIT, NB_GREY, BELT_BROWN), "role_mismatch"),
    ];
    for (i, (o, code)) in bad.iter().enumerate() {
        let e = run(&mut store, OWNER, T0, "board.publish", json!({"localDate": DAY, "requestedCount": 1, "options": [o]}), &format!("publish-bad-{i:04}"), None).await.unwrap_err();
        assert_eq!(e.code, "precondition_failed", "{code}");
        assert!(e.details["dropped"][0]["violations"].to_string().contains(code), "{code}: {}", e.details);
    }
    assert!(store.data.is_empty(), "a refused publication writes nothing");

    // An indoor-only sock is admitted when the owner names it.
    let mut named = outfit(OXFORD_BLUE, AKITA_CREAM, BED_SOCK, NB_GREY, BELT_BROWN);
    named["explicitGarmentIds"] = json!([BED_SOCK]);
    assert!(run(&mut store, OWNER, T0, "board.publish", json!({"localDate": DAY, "requestedCount": 1, "options": [named]}), "publish-named-01", None).await.is_ok());

    // Without a forecast the 14-16 °C jacket rule cannot be ruled out: a jacket over a heavy oxford is
    // not offered, unless the owner named the jacket; over a lightweight oxford it is fine.
    let jacket = |top: &str| {
        let mut o = outfit(top, GREY_CHINO, SOCK_GREY, NB_OLIVE, BELT_BLACK);
        o["slots"].as_array_mut().unwrap().push(json!({"role": "outer", "garmentId": GAMES_JACKET}));
        o
    };
    let e = run(&mut store, OWNER, T0, "board.publish", json!({"localDate": "2026-09-12", "requestedCount": 1, "options": [jacket(PIMA_WHITE)]}), "publish-jacket-1", None).await.unwrap_err();
    assert!(e.details.to_string().contains("jacket_band_unverified"));
    let mut asked = jacket(PIMA_WHITE);
    asked["explicitGarmentIds"] = json!([GAMES_JACKET]);
    assert!(run(&mut store, OWNER, T0, "board.publish", json!({"localDate": "2026-09-12", "requestedCount": 1, "options": [asked]}), "publish-jacket-2", None).await.is_ok());
    assert!(run(&mut store, OWNER, T0, "board.publish", json!({"localDate": "2026-09-13", "requestedCount": 1, "options": [jacket(OXFORD_PINK)]}), "publish-jacket-3", None).await.is_ok());

    // A shirt in the wash is not offered; a dropped option is replaced from the reserves.
    run(&mut store, OWNER, T0, "care.mark_dirty", json!({"items": [{"garmentId": OXFORD_BLUE}]}), "dirty-blue-0001", None).await.unwrap();
    let r = run(&mut store, OWNER, T0, "board.publish", json!({"localDate": "2026-09-14", "requestedCount": 1, "options": [outfit(OXFORD_BLUE, AKITA_CREAM, SOCK_BISCUIT, NB_GREY, BELT_BROWN)], "reserves": [outfit(OXFORD_PINK, GREY_CHINO, SOCK_GREY, NB_OLIVE, BELT_BLACK)]}), "publish-dirty-01", None).await.unwrap();
    assert_eq!((r["result"]["offered"].clone(), r["result"]["dropped"].as_array().unwrap().len()), (json!(1), 1));
    assert!(r["result"]["dropped"][0]["violations"][0].as_str().unwrap().contains("awaiting care"));
}

#[tokio::test]
async fn a_publication_for_an_empty_day_never_replaces_a_board_published_meanwhile() {
    let mut store = MemStore::default();
    // Two publishers both read an empty day and publish with expectedBoardRevision 0.
    let first = json!({"localDate": DAY, "requestedCount": 2, "options": two_outfits(), "expectedBoardRevision": 0});
    run(&mut store, OWNER, T0, "board.publish", first, "publish-empty-1", None).await.unwrap();
    let b = board(&mut store).await;
    let before = store.clone();
    let mut other = two_outfits();
    other.as_array_mut().unwrap().truncate(1);
    let e = run(&mut store, ASSISTANT, T0 + 1, "board.publish", json!({"localDate": DAY, "requestedCount": 1, "options": other, "expectedBoardRevision": 0}), "publish-empty-2", None).await.unwrap_err();
    assert_eq!((e.code, e.details["boardChanged"].clone(), e.details["currentRevision"].clone()), ("precondition_failed", json!(true), json!(1)));
    assert_eq!(store.data, before.data, "the board published first stands and nothing was written");
    assert_eq!(pieces(&board(&mut store).await), pieces(&b));
}

#[tokio::test]
async fn publication_refusals() {
    let mut store = MemStore::default();
    let base = || json!({"localDate": DAY, "requestedCount": 2, "options": two_outfits()});
    let cases: Vec<(Value, &str)> = vec![
        ({ let mut p = base(); p["localDate"] = json!("2026-09-08"); p }, "invalid_command"),
        ({ let mut p = base(); p["localDate"] = json!("2026-10-30"); p }, "invalid_command"),
        ({ let mut p = base(); p["weatherSnapshotId"] = json!("wsn_x"); p }, "not_found"),
        ({ let mut p = base(); p["brief"] = json!({"include": [OXFORD_BLUE]}); p }, "invalid_command"),
        ({ let mut p = base(); p["scope"] = json!("trip:t1"); p }, "invalid_command"),
        ({ let mut p = base(); p["requestedCount"] = json!(9); p }, "invalid_command"),
        ({ let mut p = base(); p["expectedBoardRevision"] = json!(3); p }, "precondition_failed"),
        ({ let mut p = base(); p["options"] = json!([outfit(OXFORD_BLUE, AKITA_CREAM, SOCK_BISCUIT, NB_GREY, BELT_BROWN), outfit(OXFORD_BLUE, GREY_CHINO, SOCK_GREY, NB_OLIVE, BELT_BLACK)]); p["requestedCount"] = json!(2); p }, "ok-one"),
    ];
    for (i, (p, code)) in cases.into_iter().enumerate() {
        let r = run(&mut store, OWNER, T0, "board.publish", p, &format!("publish-ref-{i:04}"), None).await;
        if code == "ok-one" {
            // The same shirt twice on one board: the second is dropped, and the shortage is stated.
            let r = r.unwrap();
            assert_eq!(r["result"]["offered"], 1);
            assert_eq!(board(&mut store).await["validity"], "degraded");
        } else {
            assert_eq!(r.unwrap_err().code, code, "case {i}");
            assert!(store.data.is_empty(), "case {i} wrote something");
        }
    }
}

#[tokio::test]
async fn a_connected_assistant_chooses_and_undoes_and_the_board_is_exactly_as_before() {
    let mut store = MemStore::default();
    let b0 = published(&mut store).await;
    let second = b0["options"][1]["optionId"].as_str().unwrap().to_string();
    let board_id = b0["boardId"].as_str().unwrap().to_string();

    let r = run(&mut store, ASSISTANT, T0 + 1_000, "board.select", json!({"boardId": board_id, "optionId": second}), "select-00001", versions(&b0)).await.unwrap();
    assert_eq!((r["actor"].clone(), r["channel"].clone()), (json!("assistant"), json!("mcp")));
    assert_eq!(r["summary"], "Chosen for 2026-09-11: option 2 (an intention, not a recorded wear)");
    assert_eq!(r["affected"][0], json!({"kind": "board", "id": board_id, "version": 1}), "a choice does not advance the revision");
    let b1 = board(&mut store).await;
    assert_eq!((b1["selection"]["optionId"].clone(), b1["selection"]["footwearGarmentId"].clone()), (json!(second), json!(NB_OLIVE)));
    // Choosing is not wearing: no stock moved.
    assert!(api::read_wardrobe(&mut store, T0, None).await.unwrap()["items"].as_array().unwrap().iter().all(|i| i["balances"]["dirty"] == 0));

    let undo = run(&mut store, ASSISTANT, T0 + 2_000, "command.undo", json!({"commandId": r["commandId"]}), "undo-select-1", versions(&b1)).await.unwrap();
    assert_eq!(undo["summary"], "Undone: Chosen for 2026-09-11: option 2 (an intention, not a recorded wear). Selection restored to what it was");
    assert_eq!(undo["result"]["undoneCommandId"], r["commandId"]);
    let b2 = board(&mut store).await;
    assert_eq!((b2["selection"].clone(), pieces(&b2)), (Value::Null, pieces(&b0)));

    // A choice made after another one cannot be taken back out of order.
    let a = run(&mut store, OWNER, T0 + 3_000, "board.select", json!({"boardId": board_id, "optionId": second}), "select-00002", None).await.unwrap();
    run(&mut store, OWNER, T0 + 4_000, "board.select", json!({"boardId": board_id, "optionId": Value::Null}), "select-00003", None).await.unwrap();
    assert_eq!(run(&mut store, OWNER, T0 + 5_000, "command.undo", json!({"commandId": a["commandId"]}), "undo-select-2", None).await.unwrap_err().code, "conflict");
    // An option that is not on the board, or a shoe that is not one of its choices.
    assert_eq!(run(&mut store, OWNER, T0, "board.select", json!({"boardId": board_id, "optionId": "opt_nope"}), "select-00004", None).await.unwrap_err().code, "not_found");
    assert_eq!(run(&mut store, OWNER, T0, "board.select", json!({"boardId": board_id, "optionId": second, "footwearGarmentId": NB_GREY}), "select-00005", None).await.unwrap_err().code, "invalid_command");
    assert_eq!(run(&mut store, OWNER, T0, "board.select", json!({"boardId": "brd_nope", "optionId": second}), "select-00006", None).await.unwrap_err().code, "not_found");
    // A stale board version is a conflict and writes nothing.
    let before = store.clone();
    let e = run(&mut store, ASSISTANT, T0, "board.select", json!({"boardId": board_id, "optionId": second}), "select-00007", Some(json!({format!("board:{board_id}"): 7}))).await.unwrap_err();
    assert_eq!(e.code, "conflict");
    assert_eq!(store.data, before.data);
}

#[tokio::test]
async fn a_swap_applies_at_once_never_falls_back_to_navy_and_its_undo_restores_the_board() {
    let mut store = MemStore::default();
    let b0 = published(&mut store).await;
    let board_id = b0["boardId"].as_str().unwrap().to_string();
    let first = b0["options"][0]["optionId"].as_str().unwrap().to_string();
    let second = b0["options"][1]["optionId"].as_str().unwrap().to_string();
    // The owner's choice of option 2 survives a swap in option 1.
    run(&mut store, OWNER, T0, "board.select", json!({"boardId": board_id, "optionId": second}), "select-swap-01", None).await.unwrap();
    let b0 = board(&mut store).await;

    let swap = run(&mut store, ASSISTANT, T0 + 1_000, "board.swap_slot", json!({"boardId": board_id, "optionId": first, "role": "top"}), "swap-000001", versions(&b0)).await.unwrap();
    assert_eq!(swap["affected"][0]["version"], 2);
    assert_eq!(swap["result"]["weatherBasis"], "unavailable");
    let new_top = swap["result"]["garmentId"].as_str().unwrap().to_string();
    let g = catalogue().get(&new_top).unwrap();
    assert_ne!(new_top, OXFORD_BLUE);
    assert_ne!(new_top, OXFORD_PINK, "a top already offered in another option is avoided");
    assert_ne!(colour_family(g.colour.as_deref()), "navy", "never fall back to navy while another top validates");
    assert_eq!(g.attr_str("fabricClass"), "lightweight_oxford", "the register of the piece it replaces is kept first");
    assert!(swap["summary"].as_str().unwrap().starts_with("Option 1 for 2026-09-11: Lightweight oxford — blue swapped for "));
    let b1 = board(&mut store).await;
    assert_eq!(b1["revision"], 2);
    assert_eq!(b1["selection"]["optionId"], json!(second));
    assert_eq!(b1["options"][0]["changedInRevision"], true);

    // A second swap of the same option, then undoing out of order is refused; in order it unwinds.
    let swap2 = run(&mut store, OWNER, T0 + 2_000, "board.swap_slot", json!({"boardId": board_id, "optionId": first, "role": "bottom", "garmentId": "gmt_7333fee5bf3bc6e3415776f5"}), "swap-000002", None).await.unwrap();
    assert_eq!(swap2["result"]["replacedGarmentId"], AKITA_CREAM);
    let b2 = board(&mut store).await;
    assert_eq!(run(&mut store, OWNER, T0 + 3_000, "command.undo", json!({"commandId": swap["commandId"]}), "undo-swap-01", None).await.unwrap_err().code, "conflict");
    run(&mut store, OWNER, T0 + 3_000, "command.undo", json!({"commandId": swap2["commandId"]}), "undo-swap-02", versions(&b2)).await.unwrap();
    let b3 = board(&mut store).await;
    assert_eq!((b3["revision"].clone(), pieces(&b3)), (json!(4), pieces(&b1)));
    let undo = run(&mut store, ASSISTANT, T0 + 4_000, "command.undo", json!({"commandId": swap["commandId"]}), "undo-swap-03", versions(&b3)).await.unwrap();
    assert!(undo["summary"].as_str().unwrap().contains("swap undone; the outfits of revision 1 are back (Lightweight oxford — blue is back)"));
    let b4 = board(&mut store).await;
    assert_eq!(b4["revision"], 5, "an undo publishes a new revision; history keeps both");
    assert_eq!((pieces(&b4), b4["selection"].clone()), (pieces(&b0), b0["selection"].clone()), "the board, its choice and every option's pieces are as before");

    // The owner's own pick is validated as given: a restricted shoe is refused and nothing changes.
    let before = store.clone();
    let e = run(&mut store, OWNER, T0 + 5_000, "board.swap_slot", json!({"boardId": board_id, "optionId": first, "role": "footwear", "garmentId": REIMS}), "swap-000003", None).await.unwrap_err();
    assert_eq!(e.code, "precondition_failed");
    assert!(e.message.contains("sneakers-only restriction"));
    assert_eq!(store.data, before.data);
    // A publication offers no undo.
    let publish_id = api::receipts_page(&mut store, 200).await.unwrap().0.iter().find(|r| r["type"] == "board.publish").unwrap()["commandId"].clone();
    assert_eq!(run(&mut store, OWNER, T0, "command.undo", json!({"commandId": publish_id}), "undo-publish-1", None).await.unwrap_err().code, "not_undoable");
}

#[tokio::test]
async fn receipts_of_board_commands_replay_and_a_corrupt_board_is_refused() {
    let mut store = MemStore::default();
    let b0 = published(&mut store).await;
    let board_id = b0["boardId"].as_str().unwrap().to_string();
    let first = b0["options"][0]["optionId"].as_str().unwrap().to_string();
    let p = json!({"boardId": board_id, "optionId": first});
    let a = run(&mut store, ASSISTANT, T0, "board.select", p.clone(), "select-replay-1", None).await.unwrap();
    let b = run(&mut store, ASSISTANT, T0 + 9, "board.select", p, "select-replay-1", None).await.unwrap();
    assert_eq!((b["replayed"].clone(), b["commandId"].clone()), (json!(true), a["commandId"].clone()));
    // Every stored record reads back through the validator.
    for r in api::receipts_page(&mut store, 200).await.unwrap().0 {
        assert_eq!(r["outcome"], "committed");
    }
    store.data.insert(format!("b/{board_id}").into_bytes(), b"{\"v\":1}".to_vec());
    assert_eq!(api::read_today(&mut store, T0, Some(DAY)).await.unwrap_err().code, "internal");
    assert_eq!(run(&mut store, OWNER, T0, "board.select", json!({"boardId": board_id, "optionId": first}), "select-corrupt1", None).await.unwrap_err().code, "internal");
}

const NAVY_TROUSER: &str = "gmt_58fb8730a65c17ad9bc80215"; // Di Sondrio faded navy lightweight (trousers), two pairs
const TODAY: &str = "2026-09-10";

fn navy_outfit() -> Value {
    outfit(OXFORD_BLUE, NAVY_TROUSER, SOCK_BISCUIT, NB_GREY, BELT_BROWN)
}

#[tokio::test]
async fn trousers_worn_inside_the_seven_day_horizon_are_not_offered_and_a_choice_of_them_is_refused() {
    let mut store = MemStore::default();
    // A board for tomorrow published before anything is worn offers the navy trousers.
    let options = json!([navy_outfit(), outfit(OXFORD_PINK, GREY_CHINO, SOCK_GREY, NB_OLIVE, BELT_BLACK)]);
    run(&mut store, OWNER, T0, "board.publish", json!({"localDate": DAY, "requestedCount": 2, "options": options}), "publish-0001", None).await.unwrap();
    let b = board(&mut store).await;
    let navy_option = b["options"][0]["optionId"].as_str().unwrap().to_string();
    assert_eq!(b["options"][0]["qualification"], Value::Null);
    // One pair is worn today; the other is still clean, so only the horizon keeps them out.
    let wear = run(&mut store, OWNER, T0 + 1_000, "wear.record", json!({"wearingDate": TODAY, "garmentIds": [NAVY_TROUSER]}), "wear-0001", None).await.unwrap();
    let b = board(&mut store).await;
    let q = b["options"][0]["qualification"].as_str().unwrap();
    assert!(q.contains("Di Sondrio faded navy lightweight was worn on 2026-09-10, inside the 7-day repeat horizon"), "{q}");
    assert_eq!(b["validity"], "degraded");
    // Choosing that outfit is refused and writes nothing; the other one can be chosen.
    let before = store.clone();
    let e = run(&mut store, OWNER, T0 + 2_000, "board.select", json!({"boardId": b["boardId"], "optionId": navy_option}), "select-0001", None).await.unwrap_err();
    assert_eq!(e.code, "precondition_failed");
    assert_eq!(e.details["violations"][0]["code"], "repeat_within_horizon");
    assert_eq!(e.details["violations"][0]["ruleKey"], "variety.repeat_horizon");
    assert_eq!(store.data, before.data);
    // A new publication drops it with the rule named, for every day up to seven days on.
    for (date, key) in [(DAY, "publish-0002"), ("2026-09-17", "publish-0003")] {
        let r = run(&mut store, OWNER, T0 + 3_000, "board.publish", json!({"localDate": date, "requestedCount": 2, "options": [navy_outfit(), outfit(OXFORD_PINK, GREY_CHINO, SOCK_GREY, NB_OLIVE, BELT_BLACK)]}), key, None).await.unwrap();
        assert_eq!(r["result"]["offered"], 1, "{date}");
        assert!(r["result"]["dropped"][0]["violations"][0].as_str().unwrap().starts_with("repeat_within_horizon: "), "{}", r["result"]["dropped"]);
    }
    // Eight days on the wear is outside the horizon, and the outfit is offered again.
    let r = run(&mut store, OWNER, T0 + 4_000, "board.publish", json!({"localDate": "2026-09-18", "requestedCount": 1, "options": [navy_outfit()]}), "publish-0004", None).await.unwrap();
    assert_eq!(r["result"]["offered"], 1);
    // Undoing the wear lifts the horizon at once: the first board reads as wearable again.
    run(&mut store, OWNER, T0 + 5_000, "command.undo", json!({"commandId": wear["commandId"]}), "undo-wear-0001", None).await.unwrap();
    let b = board(&mut store).await;
    assert!(b["options"].as_array().unwrap().iter().all(|o| o["qualification"].is_null()), "{}", b["options"]);
}
