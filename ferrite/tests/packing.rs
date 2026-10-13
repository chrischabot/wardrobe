//! Packing for a trip through the command path, as the iOS client and a connected assistant send it:
//! `stock.pack` and `stock.unpack` are the owner's observations of what went into and came out of the
//! suitcase, applied at once with a receipt and an undo; a wear may name the trip it was worn on, and
//! then the packed units are used first. `GET /v1/trips/{id}` lists what is packed, `GET /v1/wardrobe`
//! counts it under `trip`, and Studio says a garment whose every unit is packed is `on_trip`.
//!
//! The store is an in-memory test double of the APE binding (the same guarded-commit semantics); the
//! garments and their unit counts are the real seed.

use std::collections::BTreeMap;
use std::io;

use ferrite_app::serde_json::{self, json, Value};
use ferrite_app::IngressRequest;
use wardrobe::api::{self, Store, Tokens};
use wardrobe::ledger::Ledger;
use wardrobe::time::parse_instant;

const OWNER: &str = "owner-token-for-tests";
const ASSISTANT: &str = "assistant-token-for-tests";

// Real garments of the owner's seed: a service-laundered shirt and trousers (one unit each), sneakers
// that are never laundered (one pair) and hand-washed socks (three pairs).
const OXFORD_BLUE: &str = "gmt_3894b6a6295908d5e687af4f";
const GREY_CHINO: &str = "gmt_b8744c2627cd88a3b937f851";
const NB_GREY: &str = "gmt_14bc4338d6760f6a13434b2f";
const SOCK_GREY: &str = "gmt_67d3228f744d17138e400729";

const BEFORE: &str = "2026-10-12T09:00:00Z";

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

async fn send(store: &mut MemStore, at: &str, token: &str, method: &str, path: &str, body: Value) -> (u16, Value) {
    let bytes = if body.is_null() { Vec::new() } else { serde_json::to_vec(&body).unwrap() };
    let mut req = IngressRequest::new(method, path, bytes);
    req.headers = vec![("authorization".into(), format!("Bearer {token}"))];
    let tokens = Tokens { owner: Some(OWNER.into()), assistant: Some(ASSISTANT.into()), public_origin: None, ..Default::default() };
    let reply = api::handle(store, &tokens, parse_instant(at).unwrap(), &req).await;
    let (_, bytes) = reply.content();
    (reply.status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// An owner's command, tapped in the app at `at`, that must apply.
async fn ok(store: &mut MemStore, at: &str, key: &str, kind: &str, payload: Value) -> Value {
    let (status, receipt) = command(store, at, key, kind, payload).await;
    assert_eq!(status, 200, "{kind}: {receipt}");
    receipt
}

async fn command(store: &mut MemStore, at: &str, key: &str, kind: &str, payload: Value) -> (u16, Value) {
    let envelope = json!({"type": kind, "payload": payload, "idempotencyKey": key, "authorization": "owner_tap", "source": {"channel": "ios"}});
    send(store, at, OWNER, "POST", "/v1/commands", envelope).await
}

fn lisbon() -> Value {
    json!({
        "tripId": "trp_lisbon", "name": "Lisbon", "departsOn": "2026-10-20", "returnsOn": "2026-10-23",
        "destinations": [{"label": "Lisbon", "latitude": 38.7223, "longitude": -9.1393, "timezone": "Europe/Lisbon", "from": "2026-10-20", "to": "2026-10-23"}],
        "source": {"kind": "owner_statement"},
    })
}

async fn packed(store: &mut MemStore) -> Value {
    let (status, trip) = send(store, BEFORE, OWNER, "GET", "/v1/trips/trp_lisbon", Value::Null).await;
    assert_eq!(status, 200, "{trip}");
    trip["packed"].clone()
}

async fn balances(store: &mut MemStore, id: &str) -> Value {
    let (status, page) = send(store, BEFORE, OWNER, "GET", "/v1/wardrobe", Value::Null).await;
    assert_eq!(status, 200, "{page}");
    page["items"].as_array().unwrap().iter().find(|i| i["garmentId"] == id).unwrap()["balances"].clone()
}

fn b(clean: u32, dirty: u32, trip: u32) -> Value {
    json!({"clean": clean, "dirty": dirty, "service": 0, "trip": trip})
}

fn entry(id: &str, name: &str, clean: u32, worn: u32) -> Value {
    json!({"garmentId": id, "name": name, "clean": clean, "worn": worn})
}

fn repairs(receipt: &Value) -> Vec<String> {
    receipt["repairs"].as_array().unwrap().iter().map(|r| r.as_str().unwrap().to_string()).collect()
}

async fn wear(store: &mut MemStore, key: &str, date: &str, ids: &[&str], trip: Option<&str>) -> Value {
    let at = format!("{date}T20:00:00Z");
    ok(store, &at, key, "wear.record", json!({"wearingDate": date, "garmentIds": ids, "tripId": trip})).await
}

#[tokio::test]
async fn packing_applies_at_once_and_the_trip_lists_what_is_in_the_suitcase() {
    let mut store = MemStore::default();
    ok(&mut store, BEFORE, "trip-0001", "trip.create", lisbon()).await;
    let receipt = ok(&mut store, BEFORE, "pack-0001", "stock.pack", json!({"tripId": "trp_lisbon", "items": [{"garmentId": OXFORD_BLUE}, {"garmentId": NB_GREY}, {"garmentId": SOCK_GREY, "quantity": 2}]})).await;
    assert_eq!(receipt["outcome"], "committed");
    assert_eq!(receipt["summary"], "Packed for \u{201c}Lisbon\u{201d}: Lightweight oxford \u{2014} blue, NB 990v4 \u{2014} grey, Merino \u{2014} correct grey");
    assert_eq!(receipt["result"], json!({"tripId": "trp_lisbon", "packed": 3}));
    assert_eq!(receipt["undo"]["available"], true, "an observation applies at once with an undo (2026-10-05)");
    assert_eq!(repairs(&receipt), Vec::<String>::new());

    // By name, then ID; a packed unit is clean until it is worn on the trip.
    assert_eq!(
        packed(&mut store).await,
        json!([entry(OXFORD_BLUE, "Lightweight oxford \u{2014} blue", 1, 0), entry(SOCK_GREY, "Merino \u{2014} correct grey", 2, 0), entry(NB_GREY, "NB 990v4 \u{2014} grey", 1, 0)])
    );
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, b(0, 0, 1));
    assert_eq!(balances(&mut store, SOCK_GREY).await, b(1, 0, 2));

    // Studio: the shirt's only unit is in the suitcase; one pair of the socks is still at home.
    let (status, explore) = send(&mut store, BEFORE, OWNER, "GET", "/v1/studio?mode=explore&date=2026-10-12", Value::Null).await;
    assert_eq!(status, 200, "{explore}");
    let item = |role: &str, id: &str| explore["selectors"].as_array().unwrap().iter().find(|s| s["role"] == role).unwrap()["items"].as_array().unwrap().iter().find(|i| i["garmentId"] == id).cloned().unwrap();
    let shirt = item("top", OXFORD_BLUE);
    assert_eq!((shirt["availabilityStatus"].clone(), shirt["reasons"].clone()), (json!("unavailable"), json!(["no_units_at_home", "on_trip"])), "{shirt}");
    assert!(!item("socks", SOCK_GREY)["reasons"].as_array().unwrap().contains(&json!("on_trip")));
}

#[tokio::test]
async fn packing_for_a_trip_that_is_unknown_or_cancelled_is_refused_and_writes_nothing() {
    let mut store = MemStore::default();
    ok(&mut store, BEFORE, "trip-0001", "trip.create", lisbon()).await;
    ok(&mut store, BEFORE, "trip-0002", "trip.cancel", json!({"tripId": "trp_lisbon"})).await;
    let mut porto = lisbon();
    porto["tripId"] = json!("trp_porto");
    ok(&mut store, BEFORE, "trip-0003", "trip.create", porto).await;
    let snapshot = store.data.clone();
    let (status, body) = command(&mut store, BEFORE, "pack-0001", "stock.pack", json!({"tripId": "trp_nowhere", "items": [{"garmentId": OXFORD_BLUE}]})).await;
    assert_eq!((status, body["error"]["code"].clone(), body["error"]["message"].clone()), (404, json!("not_found"), json!("nothing was packed: there is no such trip")));
    let (status, body) = command(&mut store, BEFORE, "pack-0002", "stock.pack", json!({"tripId": "trp_lisbon", "items": [{"garmentId": OXFORD_BLUE}]})).await;
    assert_eq!((status, body["error"]["code"].clone(), body["error"]["message"].clone()), (409, json!("precondition_failed"), json!("nothing was packed: Lisbon is cancelled")));
    assert_eq!(body["error"]["details"]["reason"], "trip_not_packable", "{body}");
    // On a planned trip, an empty list, an unknown garment and an unpublished field are refused too.
    for (key, payload, code) in [
        ("pack-0003", json!({"tripId": "trp_porto", "items": []}), "invalid_command"),
        ("pack-0004", json!({"tripId": "trp_porto", "items": [{"garmentId": "gmt_not_a_garment"}]}), "not_found"),
        ("pack-0005", json!({"tripId": "trp_porto", "items": [{"garmentId": OXFORD_BLUE}], "bag": "carry-on"}), "invalid_command"),
        ("unpack-0001", json!({"tripId": "trp_porto", "items": null}), "invalid_command"),
    ] {
        let kind = if key.starts_with("pack") { "stock.pack" } else { "stock.unpack" };
        let (status, body) = command(&mut store, BEFORE, key, kind, payload).await;
        assert_ne!(status, 200, "{body}");
        assert_eq!(body["error"]["code"], code, "{body}");
    }
    assert_eq!(store.data, snapshot, "a refusal writes nothing");
}

#[tokio::test]
async fn a_wear_on_the_trip_uses_the_packed_units_and_a_second_wear_keeps_the_worn_unit_in_the_suitcase() {
    let mut store = MemStore::default();
    ok(&mut store, BEFORE, "trip-0001", "trip.create", lisbon()).await;
    ok(&mut store, BEFORE, "pack-0001", "stock.pack", json!({"tripId": "trp_lisbon", "items": [{"garmentId": OXFORD_BLUE}, {"garmentId": SOCK_GREY}]})).await;

    let first = wear(&mut store, "wear-0001", "2026-10-21", &[OXFORD_BLUE, SOCK_GREY], Some("trp_lisbon")).await;
    assert_eq!(repairs(&first), Vec::<String>::new());
    assert_eq!(packed(&mut store).await, json!([entry(OXFORD_BLUE, "Lightweight oxford \u{2014} blue", 0, 1), entry(SOCK_GREY, "Merino \u{2014} correct grey", 0, 1)]));
    assert_eq!(balances(&mut store, SOCK_GREY).await, b(2, 0, 1), "the pairs at home are untouched");

    // Worn again the next day: the same packed units, still in the suitcase; nothing at home is used.
    let second = wear(&mut store, "wear-0002", "2026-10-22", &[OXFORD_BLUE, SOCK_GREY], Some("trp_lisbon")).await;
    let said = repairs(&second);
    assert_eq!(said.len(), 2, "{said:?}");
    assert!(said.iter().all(|r| r.ends_with(": worn again on the trip; the packed unit stays in the suitcase, already worn")), "{said:?}");
    assert_eq!(balances(&mut store, SOCK_GREY).await, b(2, 0, 1));
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, b(0, 0, 1));

    // A garment that was not packed, worn on the trip, is counted from home.
    let chino = wear(&mut store, "wear-0003", "2026-10-22", &[GREY_CHINO], Some("trp_lisbon")).await;
    assert_eq!(repairs(&chino), Vec::<String>::new());
    assert_eq!(balances(&mut store, GREY_CHINO).await, b(0, 1, 0));

    // A trip ID that is not a string is refused.
    let (status, body) = command(&mut store, "2026-10-22T21:00:00Z", "wear-0004", "wear.record", json!({"wearingDate": "2026-10-22", "garmentIds": [GREY_CHINO], "tripId": 7})).await;
    assert_eq!((status, body["error"]["code"].clone()), (400, json!("invalid_command")), "{body}");
}

#[tokio::test]
async fn unpacking_brings_everything_home_without_declaring_it_clean() {
    let mut store = MemStore::default();
    ok(&mut store, BEFORE, "trip-0001", "trip.create", lisbon()).await;
    ok(&mut store, BEFORE, "pack-0001", "stock.pack", json!({"tripId": "trp_lisbon", "items": [{"garmentId": OXFORD_BLUE}, {"garmentId": NB_GREY}, {"garmentId": SOCK_GREY, "quantity": 2}]})).await;
    wear(&mut store, "wear-0001", "2026-10-21", &[OXFORD_BLUE, SOCK_GREY], Some("trp_lisbon")).await;

    // Relayed by the connected assistant: an observation, applied at once.
    let envelope = json!({"type": "stock.unpack", "payload": {"tripId": "trp_lisbon"}, "idempotencyKey": "mcp-unpack-0001", "authorization": "owner_statement", "source": {"channel": "mcp"}});
    let (status, receipt) = send(&mut store, "2026-10-24T09:00:00Z", ASSISTANT, "POST", "/v1/commands", envelope).await;
    assert_eq!(status, 200, "{receipt}");
    // Everything packed for the trip, by garment ID.
    assert_eq!(
        receipt["summary"],
        "Unpacked from \u{201c}Lisbon\u{201d}: NB 990v4 \u{2014} grey, Lightweight oxford \u{2014} blue, Merino \u{2014} correct grey; laundered pieces are awaiting care, not marked clean"
    );
    assert_eq!(receipt["result"], json!({"tripId": "trp_lisbon", "unpacked": 3}));
    assert_eq!(receipt["undo"]["available"], true);
    assert_eq!(packed(&mut store).await, json!([]));
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, b(0, 1, 0), "laundered: home awaiting care");
    assert_eq!(balances(&mut store, SOCK_GREY).await, b(1, 2, 0), "the unworn pair too is not declared clean");
    assert_eq!(balances(&mut store, NB_GREY).await, b(1, 0, 0), "never laundered: back in use");

    // Nothing is left to unpack.
    let again = ok(&mut store, "2026-10-24T09:05:00Z", "unpack-0002", "stock.unpack", json!({"tripId": "trp_lisbon"})).await;
    assert_eq!((again["outcome"].clone(), again["summary"].clone(), again["result"].clone()), (json!("noop"), json!("Nothing was packed for \u{201c}Lisbon\u{201d}"), json!({})));
    assert_eq!(again["undo"]["available"], false);
}

#[tokio::test]
async fn a_pack_is_undone_until_a_wear_on_the_trip_relies_on_it() {
    let mut store = MemStore::default();
    ok(&mut store, BEFORE, "trip-0001", "trip.create", lisbon()).await;
    let pack = ok(&mut store, BEFORE, "pack-0001", "stock.pack", json!({"tripId": "trp_lisbon", "items": [{"garmentId": OXFORD_BLUE}]})).await;
    let undone = ok(&mut store, BEFORE, "undo-0001", "command.undo", json!({"commandId": pack["commandId"]})).await;
    assert_eq!(undone["result"]["undoneCommandId"], pack["commandId"]);
    assert_eq!(packed(&mut store).await, json!([]));
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, b(1, 0, 0));

    let pack = ok(&mut store, BEFORE, "pack-0002", "stock.pack", json!({"tripId": "trp_lisbon", "items": [{"garmentId": OXFORD_BLUE}]})).await;
    wear(&mut store, "wear-0001", "2026-10-21", &[OXFORD_BLUE], Some("trp_lisbon")).await;
    let snapshot = store.data.clone();
    let (status, body) = command(&mut store, "2026-10-21T21:00:00Z", "undo-0002", "command.undo", json!({"commandId": pack["commandId"]})).await;
    assert_eq!((status, body["error"]["code"].clone()), (409, json!("not_undoable")), "{body}");
    assert!(body["error"]["message"].as_str().unwrap().contains("relies on that report"), "{body}");
    assert_eq!(store.data, snapshot);
}

#[tokio::test]
async fn packing_a_unit_awaiting_care_says_so_and_packing_again_never_cleans_a_worn_unit() {
    let mut store = MemStore::default();
    ok(&mut store, BEFORE, "trip-0001", "trip.create", lisbon()).await;
    ok(&mut store, BEFORE, "dirty-0001", "care.mark_dirty", json!({"items": [{"garmentId": OXFORD_BLUE}]})).await;
    let pack = ok(&mut store, BEFORE, "pack-0001", "stock.pack", json!({"tripId": "trp_lisbon", "items": [{"garmentId": OXFORD_BLUE}]})).await;
    assert_eq!(repairs(&pack), vec!["Lightweight oxford \u{2014} blue: packed a unit the ledger shows as awaiting care; it travels as not clean".to_string()]);
    assert_eq!(packed(&mut store).await, json!([entry(OXFORD_BLUE, "Lightweight oxford \u{2014} blue", 0, 1)]));
    ok(&mut store, BEFORE, "pack-0002", "stock.pack", json!({"tripId": "trp_lisbon", "items": [{"garmentId": OXFORD_BLUE}]})).await;
    assert_eq!(packed(&mut store).await, json!([entry(OXFORD_BLUE, "Lightweight oxford \u{2014} blue", 0, 1)]), "saying it again does not make it clean");
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, b(0, 0, 1));
}

#[tokio::test]
async fn a_cancelled_trip_keeps_its_packed_pieces_and_a_packed_trip_is_not_undone() {
    let mut store = MemStore::default();
    let created = ok(&mut store, BEFORE, "trip-0001", "trip.create", lisbon()).await;
    ok(&mut store, BEFORE, "pack-0001", "stock.pack", json!({"tripId": "trp_lisbon", "items": [{"garmentId": OXFORD_BLUE}]})).await;
    let (status, body) = command(&mut store, BEFORE, "undo-0001", "command.undo", json!({"commandId": created["commandId"]})).await;
    assert_eq!((status, body["error"]["code"].clone(), body["error"]["message"].clone()), (409, json!("not_undoable"), json!("pieces are packed for this trip; unpack them first")));

    let cancelled = ok(&mut store, BEFORE, "cancel-0001", "trip.cancel", json!({"tripId": "trp_lisbon"})).await;
    assert_eq!(cancelled["summary"], "Trip \u{201c}Lisbon\u{201d} cancelled; its packed pieces stay recorded as packed until you unpack them");
    assert_eq!(cancelled["result"], json!({"tripId": "trp_lisbon", "stillPacked": 1}));
    assert_eq!(packed(&mut store).await, json!([entry(OXFORD_BLUE, "Lightweight oxford \u{2014} blue", 1, 0)]));
    // Unpacking needs no planned trip.
    let unpacked = ok(&mut store, BEFORE, "unpack-0001", "stock.unpack", json!({"tripId": "trp_lisbon"})).await;
    assert_eq!(unpacked["result"], json!({"tripId": "trp_lisbon", "unpacked": 1}));
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, b(0, 1, 0));
}

#[tokio::test]
async fn a_wear_at_home_of_a_garment_whose_only_unit_is_packed_takes_it_out_of_the_suitcase() {
    let mut store = MemStore::default();
    ok(&mut store, BEFORE, "trip-0001", "trip.create", lisbon()).await;
    ok(&mut store, BEFORE, "pack-0001", "stock.pack", json!({"tripId": "trp_lisbon", "items": [{"garmentId": OXFORD_BLUE}, {"garmentId": NB_GREY}]})).await;
    let worn = wear(&mut store, "wear-0001", "2026-10-12", &[OXFORD_BLUE, NB_GREY], None).await;
    let said = repairs(&worn);
    assert_eq!(said.len(), 2, "{said:?}");
    assert!(said.iter().all(|r| r.ends_with(": the ledger had this item packed for a trip; the recorded wear establishes it is with the owner")), "{said:?}");
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, b(0, 1, 0));
    assert_eq!(balances(&mut store, NB_GREY).await, b(1, 0, 0));
    assert_eq!(packed(&mut store).await, json!([]));
}

#[tokio::test]
async fn a_unit_worn_on_one_trip_and_packed_for_another_travels_on_as_worn() {
    let mut store = MemStore::default();
    ok(&mut store, BEFORE, "trip-0001", "trip.create", lisbon()).await;
    let mut porto = lisbon();
    porto["tripId"] = json!("trp_porto");
    porto["name"] = json!("Porto");
    ok(&mut store, BEFORE, "trip-0002", "trip.create", porto).await;
    ok(&mut store, BEFORE, "pack-0001", "stock.pack", json!({"tripId": "trp_lisbon", "items": [{"garmentId": OXFORD_BLUE}]})).await;
    wear(&mut store, "wear-0001", "2026-10-21", &[OXFORD_BLUE], Some("trp_lisbon")).await;
    let moved = ok(&mut store, "2026-10-22T09:00:00Z", "pack-0002", "stock.pack", json!({"tripId": "trp_porto", "items": [{"garmentId": OXFORD_BLUE}]})).await;
    assert_eq!(repairs(&moved), vec!["Lightweight oxford \u{2014} blue: the ledger had this item packed for another trip; packing establishes it is in this suitcase".to_string()]);
    assert_eq!(packed(&mut store).await, json!([]), "it left the Lisbon suitcase");
    let (_, trip) = send(&mut store, BEFORE, OWNER, "GET", "/v1/trips/trp_porto", Value::Null).await;
    assert_eq!(trip["packed"], json!([entry(OXFORD_BLUE, "Lightweight oxford \u{2014} blue", 0, 1)]), "packing is not washing");
    // Unpacked at home it is awaiting care.
    ok(&mut store, "2026-10-24T09:00:00Z", "unpack-0001", "stock.unpack", json!({"tripId": "trp_porto"})).await;
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, b(0, 1, 0));
}

#[tokio::test]
async fn an_unpacking_that_names_what_is_not_in_the_suitcase_moves_only_what_is() {
    let mut store = MemStore::default();
    ok(&mut store, BEFORE, "trip-0001", "trip.create", lisbon()).await;
    ok(&mut store, BEFORE, "pack-0001", "stock.pack", json!({"tripId": "trp_lisbon", "items": [{"garmentId": OXFORD_BLUE}]})).await;

    // Nothing named is in the suitcase: a noop, nothing written, no undo.
    let snapshot = store.data.clone();
    let none = ok(&mut store, BEFORE, "unpack-0001", "stock.unpack", json!({"tripId": "trp_lisbon", "items": [{"garmentId": GREY_CHINO}, {"garmentId": NB_GREY, "quantity": 1}]})).await;
    assert_eq!((none["outcome"].clone(), none["result"].clone(), none["undo"]["available"].clone()), (json!("noop"), json!({}), json!(false)));
    assert_eq!(none["summary"], "Nothing named is packed for \u{201c}Lisbon\u{201d}: Di Sondrio grey chino, NB 990v4 \u{2014} grey");
    assert_eq!(balances(&mut store, GREY_CHINO).await, b(1, 0, 0));
    let ledger = |data: &BTreeMap<Vec<u8>, Vec<u8>>| serde_json::from_slice::<Value>(&data[b"ledger".as_slice()]).unwrap()["events"].clone();
    assert_eq!(ledger(&store.data), ledger(&snapshot), "no stock event is journaled");

    // One named piece is packed, one is not, and the packed one is named twice: one unit comes home.
    let some = ok(&mut store, BEFORE, "unpack-0002", "stock.unpack", json!({"tripId": "trp_lisbon", "items": [{"garmentId": OXFORD_BLUE}, {"garmentId": GREY_CHINO}, {"garmentId": OXFORD_BLUE}]})).await;
    assert_eq!(some["outcome"], "committed");
    assert_eq!(
        some["summary"],
        "Unpacked from \u{201c}Lisbon\u{201d}: Lightweight oxford \u{2014} blue; laundered pieces are awaiting care, not marked clean; nothing (more) packed for it: Di Sondrio grey chino, Lightweight oxford \u{2014} blue"
    );
    assert_eq!(some["result"], json!({"tripId": "trp_lisbon", "unpacked": 1}));
    assert_eq!(balances(&mut store, OXFORD_BLUE).await, b(0, 1, 0));
    assert_eq!(balances(&mut store, GREY_CHINO).await, b(1, 0, 0));
}

#[tokio::test]
async fn an_unpacking_dated_before_the_packing_finds_nothing_in_the_suitcase() {
    let mut store = MemStore::default();
    ok(&mut store, BEFORE, "trip-0001", "trip.create", lisbon()).await;
    ok(&mut store, BEFORE, "pack-0001", "stock.pack", json!({"tripId": "trp_lisbon", "items": [{"garmentId": OXFORD_BLUE}]})).await;
    let ledger = |store: &MemStore| serde_json::from_slice::<Value>(&store.data[b"ledger".as_slice()]).unwrap()["events"].clone();
    let events = ledger(&store);
    for (key, payload) in [("unpack-0001", json!({"tripId": "trp_lisbon"})), ("unpack-0002", json!({"tripId": "trp_lisbon", "items": [{"garmentId": OXFORD_BLUE}]}))] {
        // Reported as having happened the day before the shirt was packed.
        let envelope = json!({"type": "stock.unpack", "payload": payload, "idempotencyKey": key, "occurredAt": "2026-10-11T09:00:00Z", "authorization": "owner_tap", "source": {"channel": "ios"}});
        let (status, receipt) = send(&mut store, BEFORE, OWNER, "POST", "/v1/commands", envelope).await;
        assert_eq!(status, 200, "{receipt}");
        assert_eq!((receipt["outcome"].clone(), receipt["result"].clone()), (json!("noop"), json!({})), "{receipt}");
    }
    assert_eq!(ledger(&store), events, "no stock event is journaled");
    assert_eq!(packed(&mut store).await, json!([entry(OXFORD_BLUE, "Lightweight oxford \u{2014} blue", 1, 0)]));
}

#[tokio::test]
async fn a_never_laundered_piece_worn_on_the_trip_keeps_its_packing_from_being_undone() {
    let mut store = MemStore::default();
    ok(&mut store, BEFORE, "trip-0001", "trip.create", lisbon()).await;
    let pack = ok(&mut store, BEFORE, "pack-0001", "stock.pack", json!({"tripId": "trp_lisbon", "items": [{"garmentId": NB_GREY}]})).await;
    let worn = wear(&mut store, "wear-0001", "2026-10-21", &[NB_GREY], Some("trp_lisbon")).await;
    assert_eq!(repairs(&worn), Vec::<String>::new());
    assert_eq!(packed(&mut store).await, json!([entry(NB_GREY, "NB 990v4 \u{2014} grey", 1, 0)]), "sneakers are never laundered: still ready to wear");
    let (status, body) = command(&mut store, "2026-10-21T21:00:00Z", "undo-0001", "command.undo", json!({"commandId": pack["commandId"]})).await;
    assert_eq!((status, body["error"]["code"].clone()), (409, json!("not_undoable")), "{body}");
    assert_eq!(balances(&mut store, NB_GREY).await, b(0, 0, 1));
}

#[tokio::test]
async fn a_stored_pack_without_its_trip_is_unreadable() {
    let mut store = MemStore::default();
    ok(&mut store, BEFORE, "trip-0001", "trip.create", lisbon()).await;
    ok(&mut store, BEFORE, "pack-0001", "stock.pack", json!({"tripId": "trp_lisbon", "items": [{"garmentId": OXFORD_BLUE}]})).await;
    let stored: Value = serde_json::from_slice(&store.data[b"ledger".as_slice()]).unwrap();
    assert!(Ledger::from_json(&stored).is_some());
    let events = stored["events"].as_array().unwrap();
    let at = events.iter().position(|e| e["kind"] == "pack").unwrap();
    assert_eq!(events[at]["tripId"], "trp_lisbon");
    let mut broken = stored.clone();
    broken["events"][at].as_object_mut().unwrap().remove("tripId");
    assert!(Ledger::from_json(&broken).is_none(), "a pack names its suitcase");
    let mut broken = stored.clone();
    broken["events"][at]["kind"] = json!("dirty");
    assert!(Ledger::from_json(&broken).is_none(), "only packing, unpacking and a wear name a trip");
}
