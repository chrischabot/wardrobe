//! Trip-day boards (`board.publish` with a `trip:<tripId>` scope, `GET /v1/today?scope=trip:<tripId>`,
//! and recommendations for a day inside a packed trip), as `prepareTripDayBoard`, `assembleContext`
//! with a trip scope and `recommend`'s `packedTripOn` define them: only what is packed for the trip is
//! offered, a unit already worn there is not offered again, no repeat horizon applies, the trip must
//! still be planned and the day inside it, and the home board is untouched.
//!
//! The store is an in-memory test double of the APE binding (the same guarded-commit semantics); the
//! garments, their unit counts and the rules are the real seed. No model, forecast or Calendar is read.

use std::collections::{BTreeMap, BTreeSet};
use std::io;

use ferrite_app::serde_json::{self, json, Value};
use ferrite_app::IngressRequest;
use wardrobe::api::{self, Store, Tokens};
use wardrobe::board::{Day, TripPlan};
use wardrobe::ledger::{Ledger, Stock};
use wardrobe::seed::catalogue;
use wardrobe::time::parse_instant;

const OWNER: &str = "owner-token-for-tests";
const ASSISTANT: &str = "assistant-token-for-tests";

const OXFORD_BLUE: &str = "gmt_3894b6a6295908d5e687af4f";
const OXFORD_PINK: &str = "gmt_41c2da80e7f41e5dc6a4340b";
const GREY_CHINO: &str = "gmt_b8744c2627cd88a3b937f851";
const AKITA_CREAM: &str = "gmt_0bd82c642c7606199361d3d4";
const NB_GREY: &str = "gmt_14bc4338d6760f6a13434b2f";
const SOCK_GREY: &str = "gmt_67d3228f744d17138e400729";
const SOCK_BISCUIT: &str = "gmt_9eb32f6a40ea3e5e4dee484b";

const BEFORE: &str = "2026-10-12T09:00:00Z";
const TRIP: &str = "trip:trp_lisbon";

#[derive(Default, Clone, PartialEq)]
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

async fn send(store: &mut MemStore, at: &str, token: &str, method: &str, path: &str, body: Value) -> (u16, Value) {
    let bytes = if body.is_null() { Vec::new() } else { serde_json::to_vec(&body).unwrap() };
    let mut req = IngressRequest::new(method, path, bytes);
    req.headers = vec![("authorization".into(), format!("Bearer {token}"))];
    let tokens = Tokens { owner: Some(OWNER.into()), assistant: Some(ASSISTANT.into()), public_origin: None, ..Default::default() };
    let reply = api::handle(store, &tokens, parse_instant(at).unwrap(), &req).await;
    let (_, bytes) = reply.content();
    (reply.status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn command(store: &mut MemStore, at: &str, key: &str, kind: &str, payload: Value) -> (u16, Value) {
    let envelope = json!({"type": kind, "payload": payload, "idempotencyKey": key, "authorization": "owner_tap", "source": {"channel": "ios"}});
    send(store, at, OWNER, "POST", "/v1/commands", envelope).await
}

async fn ok(store: &mut MemStore, at: &str, key: &str, kind: &str, payload: Value) -> Value {
    let (status, receipt) = command(store, at, key, kind, payload).await;
    assert_eq!(status, 200, "{kind}: {receipt}");
    receipt
}

fn lisbon() -> Value {
    json!({
        "tripId": "trp_lisbon", "name": "Lisbon", "departsOn": "2026-10-20", "returnsOn": "2026-10-23",
        "destinations": [{"label": "Lisbon", "latitude": 38.7223, "longitude": -9.1393, "timezone": "Europe/Lisbon", "from": "2026-10-20", "to": "2026-10-23"}],
        "source": {"kind": "owner_statement"},
    })
}

/// The Lisbon trip, created and packed at `at` with these garments (one unit each, three pairs of the
/// grey socks).
async fn packed_trip(store: &mut MemStore, at: &str, ids: &[&str]) {
    ok(store, at, "trip-0001", "trip.create", lisbon()).await;
    let items: Vec<Value> = ids.iter().map(|id| if *id == SOCK_GREY { json!({"garmentId": id, "quantity": 3}) } else { json!({"garmentId": id}) }).collect();
    ok(store, at, "pack-0001", "stock.pack", json!({"tripId": "trp_lisbon", "items": items})).await;
}

fn outfit(top: &str, bottom: &str, socks: &str, shoes: &str) -> Value {
    json!({"slots": [{"role": "top", "garmentId": top}, {"role": "bottom", "garmentId": bottom}, {"role": "socks", "garmentId": socks}, {"role": "footwear", "garmentId": shoes}], "reason": ""})
}

fn violations(result: &Value) -> String {
    result["dropped"].to_string()
}

/// Every garment an option names (a board option's or a recommendation's `garments`).
fn ids_of(option: &Value) -> Vec<String> {
    option["garments"].as_array().unwrap().iter().map(|g| g["garmentId"].as_str().unwrap().to_string()).collect()
}

fn piece(option: &Value, role: &str) -> String {
    option["garments"].as_array().unwrap().iter().find(|g| g["role"] == role).unwrap()["garmentId"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn a_trip_day_board_offers_only_what_is_packed_and_today_reads_it_by_scope() {
    let mut store = MemStore::default();
    packed_trip(&mut store, BEFORE, &[OXFORD_BLUE, AKITA_CREAM, SOCK_BISCUIT, NB_GREY]).await;

    // The grey chinos and grey socks stayed at home: an option that needs them is not offered on the
    // trip, and the reason says so.
    let r = ok(&mut store, BEFORE, "publish-trip-1", "board.publish", json!({"localDate": "2026-10-21", "scope": TRIP, "requestedCount": 2, "options": [
        outfit(OXFORD_BLUE, AKITA_CREAM, SOCK_BISCUIT, NB_GREY),
        outfit(OXFORD_BLUE, GREY_CHINO, SOCK_GREY, NB_GREY),
    ]})).await;
    assert_eq!((r["result"]["scope"].clone(), r["result"]["offered"].clone()), (json!(TRIP), json!(1)), "{}", r["result"]);
    assert!(violations(&r["result"]).contains("not packed for this trip"), "{}", r["result"]);

    // Today reads the trip's board by its scope; the home board for that day is untouched.
    let (status, trip_today) = send(&mut store, BEFORE, OWNER, "GET", "/v1/today?date=2026-10-21&scope=trip:trp_lisbon", Value::Null).await;
    assert_eq!(status, 200, "{trip_today}");
    assert_eq!((trip_today["status"].clone(), trip_today["board"]["scope"].clone(), trip_today["board"]["boardId"].clone()), (json!("ready"), json!(TRIP), r["result"]["boardId"].clone()), "{trip_today}");
    assert_eq!(ids_of(&trip_today["board"]["options"][0]), vec![OXFORD_BLUE, AKITA_CREAM, SOCK_BISCUIT, NB_GREY]);
    let (_, home_today) = send(&mut store, BEFORE, OWNER, "GET", "/v1/today?date=2026-10-21", Value::Null).await;
    assert_eq!((home_today["status"].clone(), home_today["board"].clone()), (json!("none"), Value::Null), "{home_today}");

    // The packed shirt's only unit is in the suitcase, so the home board cannot offer it either way round.
    let (status, e) = command(&mut store, BEFORE, "publish-home-1", "board.publish", json!({"localDate": "2026-10-21", "requestedCount": 1, "options": [outfit(OXFORD_BLUE, GREY_CHINO, SOCK_GREY, NB_GREY)]})).await;
    assert_eq!((status, e["error"]["code"].clone()), (409, json!("precondition_failed")), "{e}");
    assert!(e["error"]["details"]["dropped"].to_string().contains("no clean unit at home"), "{e}");
}

#[tokio::test]
async fn a_unit_worn_on_the_trip_is_not_offered_again_and_no_repeat_horizon_applies() {
    let mut store = MemStore::default();
    // Worn at home on the 15th and washed on the 16th: inside the seven-day horizon, the home board
    // refuses the chinos again.
    ok(&mut store, "2026-10-15T20:00:00Z", "wear-home-1", "wear.record", json!({"wearingDate": "2026-10-15", "garmentIds": [AKITA_CREAM]})).await;
    ok(&mut store, "2026-10-16T09:00:00Z", "washed-1", "care.washed", json!({"items": [{"garmentId": AKITA_CREAM}]})).await;
    let r = ok(&mut store, "2026-10-16T10:00:00Z", "publish-home-1", "board.publish", json!({"localDate": "2026-10-17", "requestedCount": 2, "options": [
        outfit(OXFORD_BLUE, AKITA_CREAM, SOCK_GREY, NB_GREY),
        outfit(OXFORD_PINK, GREY_CHINO, SOCK_GREY, NB_GREY),
    ]})).await;
    assert!(violations(&r["result"]).contains("repeat_within_horizon"), "{}", r["result"]);

    packed_trip(&mut store, "2026-10-17T09:00:00Z", &[OXFORD_BLUE, OXFORD_PINK, AKITA_CREAM, SOCK_GREY, NB_GREY]).await;
    // On the first day of the trip he wears the pink shirt with the grey socks and the sneakers.
    ok(&mut store, "2026-10-20T20:00:00Z", "wear-trip-1", "wear.record", json!({"wearingDate": "2026-10-20", "garmentIds": [OXFORD_PINK, SOCK_GREY, NB_GREY], "tripId": "trp_lisbon"})).await;

    // The worn shirt is not offered again on the trip; the chinos are, inside the home horizon; the
    // sneakers are never laundered and the socks have two clean pairs left, so both are offered again.
    let r = ok(&mut store, "2026-10-20T21:00:00Z", "publish-trip-1", "board.publish", json!({"localDate": "2026-10-21", "scope": TRIP, "requestedCount": 2, "options": [
        outfit(OXFORD_PINK, AKITA_CREAM, SOCK_GREY, NB_GREY),
        outfit(OXFORD_BLUE, AKITA_CREAM, SOCK_GREY, NB_GREY),
    ]})).await;
    assert_eq!(r["result"]["offered"], 1, "{}", r["result"]);
    let dropped = violations(&r["result"]);
    assert!(dropped.contains("already worn on this trip") && !dropped.contains("repeat_within_horizon"), "{dropped}");
    let (_, today) = send(&mut store, "2026-10-20T21:00:00Z", OWNER, "GET", "/v1/today?date=2026-10-21&scope=trip:trp_lisbon", Value::Null).await;
    assert_eq!(ids_of(&today["board"]["options"][0]), vec![OXFORD_BLUE, AKITA_CREAM, SOCK_GREY, NB_GREY], "{today}");
}

#[tokio::test]
async fn a_trip_board_needs_a_planned_trip_and_a_day_inside_it() {
    let mut store = MemStore::default();
    ok(&mut store, BEFORE, "trip-0001", "trip.create", lisbon()).await;
    let publish = |scope: &str, date: &str| json!({"localDate": date, "scope": scope, "requestedCount": 1, "options": [outfit(OXFORD_BLUE, AKITA_CREAM, SOCK_BISCUIT, NB_GREY)]});
    let before = store.clone();
    for (i, (scope, date, status, code, words)) in [
        ("trip:trp_nowhere", "2026-10-21", 404, "not_found", "no active trip 'trp_nowhere'"),
        (TRIP, "2026-10-24", 400, "invalid_command", "that date is outside the trip"),
        (TRIP, "2026-10-19", 400, "invalid_command", "that date is outside the trip"),
        ("trip:trp_lisbon:evening", "2026-10-21", 400, "invalid_command", "evening boards are not ported"),
        ("trip:", "2026-10-21", 400, "invalid_command", "expected home or trip:<tripId>"),
    ]
    .into_iter()
    .enumerate()
    {
        let (s, e) = command(&mut store, BEFORE, &format!("publish-bad-{i:04}"), "board.publish", publish(scope, date)).await;
        assert_eq!((s, e["error"]["code"].clone()), (status, json!(code)), "{scope} {date}: {e}");
        assert!(e["error"].to_string().contains(words), "{scope} {date}: {e}");
    }
    assert!(store == before, "a refused publication writes nothing");

    // A cancelled trip has no day boards any more.
    ok(&mut store, BEFORE, "cancel-0001", "trip.cancel", json!({"tripId": "trp_lisbon"})).await;
    let (s, e) = command(&mut store, BEFORE, "publish-cancelled", "board.publish", publish(TRIP, "2026-10-21")).await;
    assert_eq!((s, e["error"]["code"].clone()), (404, json!("not_found")), "{e}");
}

#[tokio::test]
async fn recommendations_for_a_day_of_a_packed_trip_compose_from_the_suitcase_and_publish_its_board() {
    let mut store = MemStore::default();
    let suitcase = [OXFORD_BLUE, OXFORD_PINK, AKITA_CREAM, GREY_CHINO, SOCK_GREY, NB_GREY];
    let packed_ids: BTreeSet<String> = suitcase.iter().map(|s| s.to_string()).collect();

    // A planned trip with nothing packed yet is answered from home.
    ok(&mut store, BEFORE, "trip-0001", "trip.create", lisbon()).await;
    let (status, home) = send(&mut store, BEFORE, OWNER, "POST", "/v1/recommendations", json!({"clientRequestId": "rec-home-0001", "date": "2026-10-21", "count": 3})).await;
    assert_eq!(status, 200, "{home}");
    assert!(home["options"].as_array().unwrap().iter().flat_map(ids_of).any(|id| !packed_ids.contains(&id)), "{home}");

    let items: Vec<Value> = suitcase.iter().map(|id| if *id == SOCK_GREY { json!({"garmentId": id, "quantity": 3}) } else { json!({"garmentId": id}) }).collect();
    ok(&mut store, BEFORE, "pack-0001", "stock.pack", json!({"tripId": "trp_lisbon", "items": items})).await;

    // Once packed, a day of the trip is composed from the suitcase alone and published as the trip's board.
    let (status, made) = send(&mut store, BEFORE, OWNER, "POST", "/v1/recommendations", json!({"clientRequestId": "rec-trip-0001", "date": "2026-10-21", "count": 2, "mode": "board"})).await;
    assert_eq!(status, 200, "{made}");
    let options = made["board"]["options"].as_array().unwrap();
    assert!(!options.is_empty(), "{made}");
    for o in options {
        assert!(ids_of(o).iter().all(|id| packed_ids.contains(id)), "an option drew on home stock: {o}");
    }
    assert_eq!(made["board"]["scope"], TRIP, "{made}");
    // A retransmission answers from the run and the publication's receipt (a trip board's receipt
    // reads back like a home board's), and the command is listed.
    let (status, again) = send(&mut store, BEFORE, OWNER, "POST", "/v1/recommendations", json!({"clientRequestId": "rec-trip-0001", "date": "2026-10-21", "count": 2, "mode": "board"})).await;
    assert_eq!((status, again["board"]["boardId"].clone(), again["board"]["revision"].clone()), (200, made["board"]["boardId"].clone(), json!(1)), "{again}");
    let (status, listed) = send(&mut store, BEFORE, OWNER, "GET", "/v1/commands", Value::Null).await;
    assert_eq!(status, 200, "{listed}");
    assert!(listed.to_string().contains("board.publish"), "{listed}");
    let (_, trip_today) = send(&mut store, BEFORE, OWNER, "GET", "/v1/today?date=2026-10-21&scope=trip:trp_lisbon", Value::Null).await;
    assert_eq!(trip_today["board"]["boardId"], made["board"]["boardId"]);
    let (_, home_today) = send(&mut store, BEFORE, OWNER, "GET", "/v1/today?date=2026-10-21", Value::Null).await;
    assert_eq!(home_today["board"], Value::Null, "the home board is untouched");

    // A preview for the trip says nothing about home, and the day after the trip is home again: the
    // packed shirts (their only units are in the suitcase) are not offered there.
    let (_, preview) = send(&mut store, BEFORE, ASSISTANT, "POST", "/v1/recommendations", json!({"clientRequestId": "rec-trip-0002", "date": "2026-10-22", "count": 2})).await;
    assert!(preview["options"].as_array().unwrap().iter().flat_map(ids_of).all(|id| packed_ids.contains(&id)), "{preview}");
    let (_, after) = send(&mut store, BEFORE, OWNER, "POST", "/v1/recommendations", json!({"clientRequestId": "rec-home-0002", "date": "2026-10-24", "count": 5})).await;
    let after_ids: Vec<String> = after["options"].as_array().unwrap().iter().flat_map(ids_of).collect();
    assert!(!after_ids.is_empty() && !after_ids.iter().any(|id| id == OXFORD_BLUE || id == OXFORD_PINK), "{after}");
}

#[tokio::test]
async fn a_piece_the_packing_proposal_plans_again_is_offered_again_within_its_planned_days() {
    let mut store = MemStore::default();
    ok(&mut store, BEFORE, "trip-0001", "trip.create", lisbon()).await;
    let item = |id: &str, role: &str, quantity: u32| json!({"garmentId": id, "name": "", "role": role, "quantity": quantity});
    let day = |date: &str, top: &str| json!({"localDate": date, "segment": "day", "occasion": null, "slots": outfit(top, AKITA_CREAM, SOCK_GREY, NB_GREY)["slots"], "reason": ""});
    let items = json!([item(OXFORD_BLUE, "top", 1), item(OXFORD_PINK, "top", 1), item(AKITA_CREAM, "bottom", 1), item(SOCK_GREY, "socks", 3), item(NB_GREY, "footwear", 1)]);
    // The proposal he packs to plans the chinos for two days and each shirt for one.
    ok(&mut store, "2026-10-12T09:30:00Z", "proposal-0001", "trip.record_packing_proposal", json!({"tripId": "trp_lisbon", "items": items, "days": [day("2026-10-20", OXFORD_PINK), day("2026-10-21", OXFORD_BLUE)], "weather": []})).await;
    let packed: Vec<Value> = [OXFORD_BLUE, OXFORD_PINK, AKITA_CREAM, SOCK_GREY, NB_GREY].iter().map(|id| if *id == SOCK_GREY { json!({"garmentId": id, "quantity": 3}) } else { json!({"garmentId": id}) }).collect();
    ok(&mut store, "2026-10-12T10:00:00Z", "pack-0001", "stock.pack", json!({"tripId": "trp_lisbon", "items": packed})).await;
    // A proposal recorded after packing plans the pink shirt on every day; he did not pack to it.
    ok(&mut store, "2026-10-12T11:00:00Z", "proposal-0002", "trip.record_packing_proposal", json!({"tripId": "trp_lisbon", "items": items, "days": [day("2026-10-20", OXFORD_PINK), day("2026-10-21", OXFORD_PINK), day("2026-10-22", OXFORD_PINK)], "weather": []})).await;

    ok(&mut store, "2026-10-20T20:00:00Z", "wear-trip-1", "wear.record", json!({"wearingDate": "2026-10-20", "garmentIds": [OXFORD_PINK, AKITA_CREAM, SOCK_GREY, NB_GREY], "tripId": "trp_lisbon"})).await;

    // The chinos worn on the first day are still in the suitcase and planned for a second: offered
    // again. The pink shirt is a shirt planned once (and only the ignored proposal plans it again).
    let r = ok(&mut store, "2026-10-20T21:00:00Z", "publish-trip-1", "board.publish", json!({"localDate": "2026-10-21", "scope": TRIP, "requestedCount": 2, "options": [
        outfit(OXFORD_BLUE, AKITA_CREAM, SOCK_GREY, NB_GREY),
        outfit(OXFORD_PINK, AKITA_CREAM, SOCK_GREY, NB_GREY),
    ]})).await;
    assert_eq!(r["result"]["offered"], 1, "{}", r["result"]);
    let dropped = violations(&r["result"]);
    assert!(dropped.contains("already worn on this trip") && dropped.contains("oxford — pink") && !dropped.contains("Akita"), "{dropped}");
    // Today checks the board against the same stock, so the chinos option still reads as offered.
    let (_, today) = send(&mut store, "2026-10-20T21:00:00Z", OWNER, "GET", "/v1/today?date=2026-10-21&scope=trip:trp_lisbon", Value::Null).await;
    assert_eq!(ids_of(&today["board"]["options"][0]), vec![OXFORD_BLUE, AKITA_CREAM, SOCK_GREY, NB_GREY], "{today}");
    assert!(!today.to_string().contains("already worn on this trip"), "{today}");

    // On the day itself, the pink shirt the proposal plans for that one day is not offered again once
    // worn; the chinos planned for two days are.
    let r = ok(&mut store, "2026-10-20T21:30:00Z", "publish-trip-same-day", "board.publish", json!({"localDate": "2026-10-20", "scope": TRIP, "requestedCount": 2, "options": [
        outfit(OXFORD_PINK, AKITA_CREAM, SOCK_GREY, NB_GREY),
        outfit(OXFORD_BLUE, AKITA_CREAM, SOCK_GREY, NB_GREY),
    ]})).await;
    assert_eq!(r["result"]["offered"], 1, "{}", r["result"]);
    let dropped = violations(&r["result"]);
    assert!(dropped.contains("oxford — pink is not available: already worn on this trip") && !dropped.contains("Akita"), "{dropped}");

    // Reported dirty after packing, the chinos are not offered again whatever the plan says.
    let mut dirty = store.clone();
    ok(&mut dirty, "2026-10-20T22:00:00Z", "dirty-0001", "care.mark_dirty", json!({"items": [{"garmentId": AKITA_CREAM}]})).await;
    let (status, e) = command(&mut dirty, "2026-10-20T22:30:00Z", "publish-trip-dirty", "board.publish", json!({"localDate": "2026-10-21", "scope": TRIP, "requestedCount": 1, "options": [outfit(OXFORD_BLUE, AKITA_CREAM, SOCK_GREY, NB_GREY)]})).await;
    assert_eq!((status, e["error"]["code"].clone()), (409, json!("precondition_failed")), "{e}");
    assert!(e["error"]["details"]["dropped"].to_string().contains("Akita slub 5-pocket — cream is not available"), "{e}");

    // Worn on both planned days, the chinos have no budget left on the third.
    ok(&mut store, "2026-10-21T20:00:00Z", "wear-trip-2", "wear.record", json!({"wearingDate": "2026-10-21", "garmentIds": [AKITA_CREAM, SOCK_GREY, NB_GREY], "tripId": "trp_lisbon"})).await;
    let (status, e) = command(&mut store, "2026-10-21T21:00:00Z", "publish-trip-3", "board.publish", json!({"localDate": "2026-10-22", "scope": TRIP, "requestedCount": 1, "options": [outfit(OXFORD_BLUE, AKITA_CREAM, SOCK_GREY, NB_GREY)]})).await;
    assert_eq!((status, e["error"]["code"].clone()), (409, json!("precondition_failed")), "{e}");
    let dropped = e["error"]["details"]["dropped"].to_string();
    assert!(dropped.contains("Akita slub 5-pocket — cream is not available: already worn on this trip") && !dropped.contains("oxford"), "{dropped}");
}

#[tokio::test]
async fn planned_reuse_never_offers_more_units_than_the_proposal_packs() {
    const WALNUT: &str = "gmt_ff25dfaf5876e58a551fe11d"; // two units
    let mut store = MemStore::default();
    ok(&mut store, BEFORE, "trip-0001", "trip.create", lisbon()).await;
    ok(&mut store, BEFORE, "pack-0001", "stock.pack", json!({"tripId": "trp_lisbon", "items": [{"garmentId": WALNUT, "quantity": 2}]})).await;
    ok(&mut store, "2026-10-20T20:00:00Z", "wear-trip-1", "wear.record", json!({"wearingDate": "2026-10-20", "garmentIds": [WALNUT], "tripId": "trp_lisbon"})).await;
    let ledger = Ledger::from_json(&serde_json::from_slice(&store.data[b"ledger".as_slice()]).unwrap()).unwrap();
    let packed_seq = ledger.events.iter().find(|e| e.kind == "pack").unwrap().seq;
    let plan = |quantity: u32| {
        let day = |date: &str| json!({"localDate": date, "slots": [{"role": "bottom", "garmentId": WALNUT}]});
        let proposal = json!({"items": [{"garmentId": WALNUT, "quantity": quantity}], "days": [day("2026-10-20"), day("2026-10-21")]});
        TripPlan::from_proposal("2026-10-20", Some(&proposal), packed_seq)
    };
    let on_the_21st = |plan: &TripPlan| Day::for_trip(catalogue(), &ledger, "trp_lisbon", "2026-10-21", Some(plan)).stock.of(WALNUT);
    // One unit clean and one worn: a proposal that packs one unit re-offers none of the worn ones, one
    // that packs two re-offers the worn unit, and without a plan the worn unit stays worn.
    assert_eq!(on_the_21st(&plan(1)), Stock { clean: 1, dirty: 1 });
    assert_eq!(on_the_21st(&plan(2)), Stock { clean: 2, dirty: 0 });
    assert_eq!(Day::for_trip(catalogue(), &ledger, "trp_lisbon", "2026-10-21", None).stock.of(WALNUT), Stock { clean: 1, dirty: 1 });
}

#[tokio::test]
async fn a_unit_packed_while_awaiting_care_is_never_made_wearable_by_planned_reuse() {
    const WALNUT: &str = "gmt_ff25dfaf5876e58a551fe11d"; // two units
    let mut store = MemStore::default();
    ok(&mut store, BEFORE, "trip-0001", "trip.create", lisbon()).await;
    // One pair goes in the hamper at home, and both pairs are packed: one clean, one not.
    ok(&mut store, "2026-10-12T08:00:00Z", "dirty-0001", "care.mark_dirty", json!({"items": [{"garmentId": WALNUT}]})).await;
    ok(&mut store, BEFORE, "pack-0001", "stock.pack", json!({"tripId": "trp_lisbon", "items": [{"garmentId": WALNUT, "quantity": 2}]})).await;
    ok(&mut store, "2026-10-20T20:00:00Z", "wear-trip-1", "wear.record", json!({"wearingDate": "2026-10-20", "garmentIds": [WALNUT], "tripId": "trp_lisbon"})).await;
    let ledger = Ledger::from_json(&serde_json::from_slice(&store.data[b"ledger".as_slice()]).unwrap()).unwrap();
    let packed_seq = ledger.events.iter().find(|e| e.kind == "pack").unwrap().seq;
    let day = |date: &str| json!({"localDate": date, "slots": [{"role": "bottom", "garmentId": WALNUT}]});
    let proposal = json!({"items": [{"garmentId": WALNUT, "quantity": 2}], "days": [day("2026-10-20"), day("2026-10-21")]});
    let plan = TripPlan::from_proposal("2026-10-20", Some(&proposal), packed_seq);
    // Both are in the worn count, but only the pair worn on the trip is offered again.
    assert_eq!(Day::for_trip(catalogue(), &ledger, "trp_lisbon", "2026-10-21", None).stock.of(WALNUT), Stock { clean: 0, dirty: 2 });
    assert_eq!(Day::for_trip(catalogue(), &ledger, "trp_lisbon", "2026-10-21", Some(&plan)).stock.of(WALNUT), Stock { clean: 1, dirty: 1 });
}

#[tokio::test]
async fn a_unit_worn_unpacked_and_packed_again_is_counted_once_by_planned_reuse() {
    const WALNUT: &str = "gmt_ff25dfaf5876e58a551fe11d"; // two units
    let mut store = MemStore::default();
    ok(&mut store, BEFORE, "trip-0001", "trip.create", lisbon()).await;
    // One pair is packed and worn on the trip, then unpacked into the hamper at home.
    ok(&mut store, BEFORE, "pack-0001", "stock.pack", json!({"tripId": "trp_lisbon", "items": [{"garmentId": WALNUT}]})).await;
    ok(&mut store, "2026-10-20T20:00:00Z", "wear-trip-1", "wear.record", json!({"wearingDate": "2026-10-20", "garmentIds": [WALNUT], "tripId": "trp_lisbon"})).await;
    ok(&mut store, "2026-10-20T21:00:00Z", "unpack-0001", "stock.unpack", json!({"tripId": "trp_lisbon"})).await;
    // Both pairs go back in: the clean one and the worn one, which travels not clean. The clean pair
    // is worn on the 21st, so two pairs are worn in the suitcase but only one was worn there.
    ok(&mut store, "2026-10-20T22:00:00Z", "pack-0002", "stock.pack", json!({"tripId": "trp_lisbon", "items": [{"garmentId": WALNUT, "quantity": 2}]})).await;
    ok(&mut store, "2026-10-21T20:00:00Z", "wear-trip-2", "wear.record", json!({"wearingDate": "2026-10-21", "garmentIds": [WALNUT], "tripId": "trp_lisbon"})).await;
    let ledger = Ledger::from_json(&serde_json::from_slice(&store.data[b"ledger".as_slice()]).unwrap()).unwrap();
    let packed_seq = ledger.events.iter().filter(|e| e.kind == "pack").map(|e| e.seq).max().unwrap();
    let day = |date: &str| json!({"localDate": date, "slots": [{"role": "bottom", "garmentId": WALNUT}]});
    let proposal = json!({"items": [{"garmentId": WALNUT, "quantity": 2}], "days": [day("2026-10-20"), day("2026-10-21"), day("2026-10-22")]});
    let plan = TripPlan::from_proposal("2026-10-20", Some(&proposal), packed_seq);
    assert_eq!(Day::for_trip(catalogue(), &ledger, "trp_lisbon", "2026-10-22", None).stock.of(WALNUT), Stock { clean: 0, dirty: 2 });
    // The first wear's unit left the suitcase: only the pair worn on the 21st is offered again.
    assert_eq!(Day::for_trip(catalogue(), &ledger, "trp_lisbon", "2026-10-22", Some(&plan)).stock.of(WALNUT), Stock { clean: 1, dirty: 1 });
}

#[tokio::test]
async fn a_swap_on_a_trip_board_picks_from_the_suitcase() {
    let mut store = MemStore::default();
    packed_trip(&mut store, BEFORE, &[OXFORD_BLUE, OXFORD_PINK, AKITA_CREAM, SOCK_GREY, NB_GREY]).await;
    let r = ok(&mut store, BEFORE, "publish-trip-1", "board.publish", json!({"localDate": "2026-10-21", "scope": TRIP, "requestedCount": 1, "options": [outfit(OXFORD_BLUE, AKITA_CREAM, SOCK_GREY, NB_GREY)]})).await;
    let board_id = r["result"]["boardId"].as_str().unwrap().to_string();
    let option_id = r["result"]["optionIds"][0].clone();
    // The only other shirt in the suitcase is the pink one; the owner's other shirts are at home.
    let (status, swapped) = send(&mut store, BEFORE, OWNER, "POST", &format!("/v1/boards/{board_id}/swap"), json!({"clientRequestId": "swap-00000001", "optionId": option_id, "role": "top"})).await;
    assert_eq!(status, 200, "{swapped}");
    let now = swapped["board"]["options"].as_array().unwrap().iter().find(|o| o["optionId"] == option_id).unwrap().clone();
    assert_eq!(piece(&now, "top"), OXFORD_PINK, "{now}");
    // Nothing else in the suitcase can take the trousers' place: the swap is refused, not filled from home.
    let (status, e) = send(&mut store, BEFORE, OWNER, "POST", &format!("/v1/boards/{board_id}/swap"), json!({"clientRequestId": "swap-00000002", "optionId": option_id, "role": "bottom"})).await;
    assert_ne!(status, 200, "{e}");
    let (_, today) = send(&mut store, BEFORE, OWNER, "GET", "/v1/today?date=2026-10-21&scope=trip:trp_lisbon", Value::Null).await;
    assert_eq!(piece(&today["board"]["options"][0], "bottom"), AKITA_CREAM, "{today}");
}
