//! Evening boards (`home:evening`, `trip:<tripId>:evening`, `parseScope` in packages/daily/src/model.ts)
//! through the command service and `GET /v1/today?scope=`: an evening board is published, chosen from and
//! swapped like the day's board, each with its receipt and undo, alongside the day's board and
//! independent of it. Its brief is the evening one, and its options are not an exposure (TypeScript's
//! `writeExposure: !evening`), so they never lower availability.
//!
//! The store is an in-memory test double of the APE binding (the same guarded-commit semantics); the
//! garments and rules are the real seed.

use std::collections::BTreeMap;
use std::io;

use ferrite_app::serde_json::{self, json, Value};
use ferrite_app::IngressRequest;
use wardrobe::api::{self, Principal, Store, Tokens, ASSISTANT, OWNER};
use wardrobe::board::{parse_scope, scope_ok, scope_trip};

const OWNER_TOKEN: &str = "owner-token-for-tests";
const ASSISTANT_TOKEN: &str = "assistant-token-for-tests";
const T0: u64 = 1_789_000_000_000; // 2026-09-10T00:26:40Z
const DAY: &str = "2026-09-11";

// Real garments from the owner's inventory.
const OXFORD_BLUE: &str = "gmt_3894b6a6295908d5e687af4f";
const OXFORD_PINK: &str = "gmt_41c2da80e7f41e5dc6a4340b";
const AKITA_CREAM: &str = "gmt_0bd82c642c7606199361d3d4";
const GREY_CHINO: &str = "gmt_b8744c2627cd88a3b937f851";
const SOCK_BISCUIT: &str = "gmt_9eb32f6a40ea3e5e4dee484b";
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

fn outfit(top: &str, bottom: &str, socks: &str, shoes: &str, belt: &str) -> Value {
    json!({"slots": [{"role": "top", "garmentId": top}, {"role": "bottom", "garmentId": bottom}, {"role": "belt", "garmentId": belt}, {"role": "socks", "garmentId": socks}, {"role": "footwear", "garmentId": shoes}], "reason": ""})
}

fn two_outfits() -> Value {
    json!([outfit(OXFORD_BLUE, AKITA_CREAM, SOCK_BISCUIT, NB_GREY, BELT_BROWN), outfit(OXFORD_PINK, GREY_CHINO, SOCK_GREY, NB_OLIVE, BELT_BLACK)])
}

async fn run(store: &mut MemStore, who: Principal, now: u64, kind: &str, payload: Value, key: &str) -> Result<Value, wardrobe::ledger::CmdError> {
    let (auth, channel) = if who == OWNER { ("owner_tap", "ios") } else { ("owner_statement", "mcp") };
    api::execute(store, who, now, &json!({"type": kind, "payload": payload, "idempotencyKey": key, "authorization": auth, "source": {"channel": channel}})).await
}

async fn get(store: &mut MemStore, token: &str, path: &str) -> (u16, Value) {
    let mut req = IngressRequest::new("GET", path, Vec::new());
    req.headers = vec![("authorization".into(), format!("Bearer {token}"))];
    let tokens = Tokens { owner: Some(OWNER_TOKEN.into()), assistant: Some(ASSISTANT_TOKEN.into()), public_origin: None, ..Default::default() };
    let reply = api::handle(store, &tokens, T0 + 10_000, &req).await;
    let (_, bytes) = reply.content();
    (reply.status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn evening(store: &mut MemStore) -> Value {
    let (status, today) = get(store, OWNER_TOKEN, &format!("/v1/today?date={DAY}&scope=home:evening")).await;
    assert_eq!(status, 200, "{today}");
    today["board"].clone()
}

async fn day_board(store: &mut MemStore) -> Value {
    let (status, today) = get(store, OWNER_TOKEN, &format!("/v1/today?date={DAY}")).await;
    assert_eq!(status, 200, "{today}");
    today["board"].clone()
}

#[test]
fn the_four_board_scopes_parse_as_parse_scope_does() {
    assert_eq!(parse_scope("home"), Some((None, false)));
    assert_eq!(parse_scope("home:evening"), Some((None, true)));
    assert_eq!(parse_scope("trip:trp_porto"), Some((Some("trp_porto"), false)));
    assert_eq!(parse_scope("trip:trp_porto:evening"), Some((Some("trp_porto"), true)));
    assert_eq!(scope_trip("trip:trp_porto:evening"), Some("trp_porto"));
    for bad in ["home:night", "evening", "home:evening:evening", "trip:", "trip::evening", "trip:a:b", "trip:a:evening:x", "office"] {
        assert!(!scope_ok(bad), "{bad}");
    }
}

#[tokio::test]
async fn an_evening_board_is_published_chosen_and_swapped_beside_the_days_board() {
    let mut store = MemStore::default();
    // The day's board, then the evening's: two boards for one day.
    run(&mut store, OWNER, T0, "board.publish", json!({"localDate": DAY, "requestedCount": 2, "options": two_outfits()}), "publish-day-1").await.unwrap();
    let published = run(
        &mut store, OWNER, T0 + 1_000, "board.publish",
        json!({"localDate": DAY, "scope": "home:evening", "requestedCount": 2, "options": two_outfits(), "brief": {"segment": "evening"}}),
        "publish-eve-1",
    ).await.unwrap();
    assert_eq!(published["outcome"], "committed", "{published}");
    let eve = evening(&mut store).await;
    let day = day_board(&mut store).await;
    assert_ne!(eve["boardId"], day["boardId"], "one board per scope and day");
    assert_eq!((eve["scope"].clone(), eve["localDate"].clone(), eve["brief"]["segment"].clone(), eve["revision"].clone()), (json!("home:evening"), json!(DAY), json!("evening"), json!(1)));
    assert_eq!((day["scope"].clone(), day["brief"]["segment"].clone()), (json!("home"), json!("day")));
    assert_eq!(eve["options"].as_array().unwrap().len(), 2);

    // A choice on the evening board is the evening's alone, with its undo.
    let eve_id = eve["boardId"].as_str().unwrap().to_string();
    let second = eve["options"][1]["optionId"].as_str().unwrap().to_string();
    let chose = run(&mut store, ASSISTANT, T0 + 2_000, "board.select", json!({"boardId": eve_id, "optionId": second}), "select-eve-1").await.unwrap();
    assert_eq!(chose["undo"]["available"], true);
    assert_eq!(evening(&mut store).await["selection"]["optionId"], json!(second));
    assert_eq!(day_board(&mut store).await["selection"]["optionId"], Value::Null, "the day's board has no choice");
    run(&mut store, OWNER, T0 + 3_000, "command.undo", json!({"commandId": chose["commandId"]}), "undo-eve-1").await.unwrap();
    assert_eq!(evening(&mut store).await["selection"]["optionId"], Value::Null);

    // A swap writes a new evening revision with its receipt; its undo restores the outfits.
    let first = eve["options"][0]["optionId"].as_str().unwrap().to_string();
    let before = evening(&mut store).await["options"].clone();
    let swap = run(&mut store, OWNER, T0 + 4_000, "board.swap_slot", json!({"boardId": eve_id, "optionId": first, "role": "top"}), "swap-eve-1").await.unwrap();
    assert_eq!((swap["outcome"].clone(), swap["undo"]["available"].clone()), (json!("committed"), json!(true)), "{swap}");
    let swapped = evening(&mut store).await;
    assert_eq!(swapped["revision"], 2);
    assert_ne!(swapped["options"][0], before[0]);
    assert_eq!(day_board(&mut store).await["revision"], 1, "the day's board is untouched");
    run(&mut store, OWNER, T0 + 5_000, "command.undo", json!({"commandId": swap["commandId"]}), "undo-eve-2").await.unwrap();
    let restored = evening(&mut store).await;
    assert_eq!(restored["revision"], 3);
    let ids = |opts: &Value| opts.as_array().unwrap().iter().map(|o| o["garments"].clone()).collect::<Vec<_>>();
    assert_eq!(ids(&restored["options"]), ids(&before));

    // The connected assistant reads the evening board too.
    let (status, by_assistant) = get(&mut store, ASSISTANT_TOKEN, &format!("/v1/today?date={DAY}&scope=home:evening")).await;
    assert_eq!((status, by_assistant["board"]["boardId"].clone()), (200, json!(eve_id)));
}

#[tokio::test]
async fn evening_options_are_not_an_exposure_and_never_lower_availability() {
    let mut store = MemStore::default();
    run(&mut store, OWNER, T0, "board.publish", json!({"localDate": DAY, "scope": "home:evening", "requestedCount": 2, "options": two_outfits()}), "publish-eve-1").await.unwrap();
    let (_, snapshot) = get(&mut store, OWNER_TOKEN, "/v1/availability?date=2026-09-13").await;
    let blue = snapshot["garments"].as_array().unwrap().iter().find(|g| g["garmentId"] == OXFORD_BLUE).unwrap().clone();
    assert_eq!((blue["inferredWear"].clone(), blue["pAvailable"].clone()), (json!([]), json!(0.8)), "only the import prior: {blue}");
    // The same options on the day's board are an exposure.
    run(&mut store, OWNER, T0 + 1_000, "board.publish", json!({"localDate": DAY, "requestedCount": 2, "options": two_outfits()}), "publish-day-1").await.unwrap();
    let (_, snapshot) = get(&mut store, OWNER_TOKEN, "/v1/availability?date=2026-09-13").await;
    let blue = snapshot["garments"].as_array().unwrap().iter().find(|g| g["garmentId"] == OXFORD_BLUE).unwrap().clone();
    assert_eq!(blue["inferredWear"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn scopes_and_briefs_the_port_does_not_serve_are_refused_and_write_nothing() {
    let mut store = MemStore::default();
    for (payload, words) in [
        (json!({"localDate": DAY, "scope": "home:night", "requestedCount": 2, "options": two_outfits()}), "scope: expected home, home:evening"),
        (json!({"localDate": DAY, "requestedCount": 2, "options": two_outfits(), "brief": {"segment": "evening"}}), "segment evening only for an evening scope"),
        (json!({"localDate": DAY, "scope": "home:evening", "requestedCount": 2, "options": two_outfits(), "brief": {"segment": "evening", "text": "dinner"}}), "day briefs"),
        (json!({"localDate": DAY, "scope": "trip:trp_nope:evening", "requestedCount": 2, "options": two_outfits()}), "no active trip 'trp_nope'"),
    ] {
        let e = run(&mut store, OWNER, T0, "board.publish", payload.clone(), "publish-bad-1").await.unwrap_err();
        let said = format!("{} {}", e.message, e.details);
        assert!(said.contains(words), "{payload}: {} {said}", e.code);
    }
    assert!(store.data.is_empty(), "nothing was written");
    for path in [format!("/v1/today?date={DAY}&scope=home:night"), format!("/v1/today?date={DAY}&scope=evening")] {
        let (status, e) = get(&mut store, OWNER_TOKEN, &path).await;
        assert_eq!((status, e["error"]["code"].clone()), (400, json!("invalid_command")), "{path}");
    }
    // An evening with no board yet reads as none.
    let (status, empty) = get(&mut store, OWNER_TOKEN, &format!("/v1/today?date={DAY}&scope=home:evening")).await;
    assert_eq!((status, empty["status"].clone(), empty["board"].clone()), (200, json!("none"), Value::Null));
}
