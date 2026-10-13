//! Trips and packing proposals through the command path, as the iOS client and a connected assistant
//! send them: `trip.create` applies at once with a receipt and an undo that cancels the trip,
//! `trip.update` and `trip.cancel` apply at once without one, and `POST /v1/trips/{id}/packing-proposal`
//! records a proposal (`trip.record_packing_proposal`) that packs nothing. `GET /v1/trips` and
//! `GET /v1/trips/{id}` read them back.
//!
//! The store is an in-memory test double of the APE binding (the same guarded-commit semantics); the
//! garments and their clean counts are the real seed.

use std::collections::{BTreeMap, BTreeSet};
use std::io;

use ferrite_app::serde_json::{self, json, Value};
use ferrite_app::IngressRequest;
use wardrobe::api::{self, Store, Tokens};
use wardrobe::board::Day;
use wardrobe::ledger::Ledger;
use wardrobe::seed::catalogue;
use wardrobe::time::parse_instant;
use wardrobe::trips::{self, Trip, MAX_PROPOSAL_BYTES};

const OWNER: &str = "owner-token-for-tests";
const ASSISTANT: &str = "assistant-token-for-tests";

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

fn now() -> u64 {
    parse_instant("2026-10-12T09:00:00Z").unwrap()
}

async fn send<S: Store>(store: &mut S, token: &str, method: &str, path: &str, body: Value) -> (u16, Value) {
    let bytes = if body.is_null() { Vec::new() } else { serde_json::to_vec(&body).unwrap() };
    let mut req = IngressRequest::new(method, path, bytes);
    req.headers = vec![("authorization".into(), format!("Bearer {token}"))];
    let tokens = Tokens { owner: Some(OWNER.into()), assistant: Some(ASSISTANT.into()), public_origin: None, ..Default::default() };
    let reply = api::handle(store, &tokens, now(), &req).await;
    let (_, bytes) = reply.content();
    (reply.status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn command(store: &mut MemStore, key: &str, kind: &str, payload: Value) -> (u16, Value) {
    command_with(store, key, kind, payload, json!({})).await
}

async fn command_with(store: &mut MemStore, key: &str, kind: &str, payload: Value, expected: Value) -> (u16, Value) {
    let envelope = json!({"type": kind, "payload": payload, "idempotencyKey": key, "expectedVersions": expected, "authorization": "owner_tap", "source": {"channel": "ios"}});
    send(store, OWNER, "POST", "/v1/commands", envelope).await
}

async fn trip_list(store: &mut MemStore) -> Vec<Value> {
    let (status, body) = send(store, OWNER, "GET", "/v1/trips", Value::Null).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body.as_object().unwrap().len(), 1, "{body}");
    body["trips"].as_array().unwrap().clone()
}

async fn trip(store: &mut MemStore, id: &str) -> Value {
    let (status, body) = send(store, OWNER, "GET", &format!("/v1/trips/{id}"), Value::Null).await;
    assert_eq!(status, 200, "{body}");
    body
}

async fn propose<S: Store>(store: &mut S, token: &str, trip_id: &str, client: &str) -> (u16, Value) {
    send(store, token, "POST", &format!("/v1/trips/{trip_id}/packing-proposal"), json!({"clientRequestId": client})).await
}

fn lisbon() -> Value {
    json!({
        "tripId": "trp_lisbon", "name": "Lisbon", "departsOn": "2026-10-20", "returnsOn": "2026-10-23",
        "destinations": [{"label": "Lisbon", "latitude": 38.7223, "longitude": -9.1393, "timezone": "Europe/Lisbon", "from": "2026-10-20", "to": "2026-10-23"}],
        "occasions": [{"localDate": "2026-10-21", "label": "Dinner with Ana", "segment": "evening"}],
        "luggage": {"label": "the carry-on", "maxPieces": 30},
        "source": {"kind": "owner_statement"},
    })
}

fn with(base: &Value, key: &str, value: Value) -> Value {
    let mut p = base.clone();
    p[key] = value;
    p
}

fn error(body: &Value) -> (Value, String) {
    (body["error"]["code"].clone(), body["error"]["message"].as_str().unwrap_or_default().to_string())
}

/// Everything the error says: its message and, for an invalid payload, each issue.
fn said(body: &Value) -> String {
    body["error"].to_string()
}

/// The wardrobe as `GET /v1/wardrobe` reads it, without the revision every command moves.
async fn garments(store: &mut MemStore) -> Value {
    let (_, mut wardrobe) = send(store, OWNER, "GET", "/v1/wardrobe", Value::Null).await;
    wardrobe.as_object_mut().unwrap().remove("wardrobeRevision");
    wardrobe
}

#[tokio::test]
async fn a_trip_is_recorded_at_once_with_its_defaults_and_reads_back_with_nothing_packed() {
    let mut store = MemStore::default();
    let untouched = garments(&mut MemStore::default()).await;
    let (status, receipt) = command(&mut store, "trip-0001", "trip.create", lisbon()).await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(receipt["outcome"], "committed");
    assert_eq!(receipt["summary"], "Trip \u{201c}Lisbon\u{201d} recorded: 2026-10-20 to 2026-10-23, Lisbon. Nothing is packed until you say so");
    assert_eq!(receipt["result"], json!({"tripId": "trp_lisbon"}));
    assert_eq!(receipt["undo"]["available"], true, "applies at once with an undo (2026-10-05)");

    let listed = trip_list(&mut store).await;
    assert_eq!(listed.len(), 1);
    assert_eq!(
        listed[0],
        json!({
            "tripId": "trp_lisbon", "version": 1, "name": "Lisbon", "departsOn": "2026-10-20", "returnsOn": "2026-10-23",
            "destinations": [{"label": "Lisbon", "latitude": 38.7223, "longitude": -9.1393, "timezone": "Europe/Lisbon", "from": "2026-10-20", "to": "2026-10-23"}],
            "occasions": [{"localDate": "2026-10-21", "label": "Dinner with Ana", "register": "none", "segment": "evening"}],
            "luggage": {"label": "the carry-on", "maxPieces": 30}, "laundry": [], "status": "planned", "packed": [], "proposal": null,
        })
    );
    assert_eq!(trip(&mut store, "trp_lisbon").await, listed[0]);
    let (status, missing) = send(&mut store, OWNER, "GET", "/v1/trips/trp_nowhere", Value::Null).await;
    assert_eq!((status, error(&missing).0), (404, json!("not_found")), "{missing}");

    // The same request replays; the same key with a different coordinate is another request.
    let (_, replay) = command(&mut store, "trip-0001", "trip.create", lisbon()).await;
    assert_eq!((replay["replayed"].clone(), replay["commandId"].clone()), (json!(true), receipt["commandId"].clone()));
    let mut moved = lisbon();
    moved["destinations"][0]["longitude"] = json!(-9.1394);
    let (status, reuse) = command(&mut store, "trip-0001", "trip.create", moved).await;
    assert_eq!((status, error(&reuse).0), (409, json!("idempotency_key_reuse")), "{reuse}");

    // A trip with the same ID under a new key is refused, and nothing else was written.
    let (status, twice) = command(&mut store, "trip-0002", "trip.create", lisbon()).await;
    assert_eq!(status, 409, "{twice}");
    assert_eq!(error(&twice), (json!("precondition_failed"), "there is already a trip 'trp_lisbon'; nothing was written".into()));
    assert_eq!(trip_list(&mut store).await.len(), 1);
    assert_eq!(garments(&mut store).await, untouched, "a trip changes no garment");
}

#[tokio::test]
async fn undoing_a_trip_cancels_it_and_a_trip_without_an_id_gets_a_generated_one() {
    let mut store = MemStore::default();
    let mut payload = lisbon();
    payload.as_object_mut().unwrap().remove("tripId");
    let (status, receipt) = command(&mut store, "trip-undo-0001", "trip.create", payload).await;
    assert_eq!(status, 200, "{receipt}");
    let id = receipt["result"]["tripId"].as_str().unwrap().to_string();
    assert!(id.starts_with("trp_") && id.len() > 4, "{id}");

    let (status, undone) = command(&mut store, "trip-undo-0002", "command.undo", json!({"commandId": receipt["commandId"]})).await;
    assert_eq!(status, 200, "{undone}");
    assert_eq!(undone["summary"], format!("Undone: {}. Trip removed", receipt["summary"].as_str().unwrap().trim_end_matches('.')));
    assert_eq!(undone["result"], json!({"undoneCommandId": receipt["commandId"]}));
    assert_eq!(undone["undo"]["available"], false);
    let t = trip(&mut store, &id).await;
    assert_eq!((t["status"].clone(), t["version"].clone()), (json!("cancelled"), json!(2)));
    let (status, twice) = command(&mut store, "trip-undo-0003", "command.undo", json!({"commandId": receipt["commandId"]})).await;
    assert_eq!((status, error(&twice).0), (409, json!("not_undoable")), "{twice}");
    // A cancelled trip gets no proposal.
    let (status, body) = propose(&mut store, OWNER, &id, "pack-undo-0001").await;
    assert_eq!((status, error(&body).0), (404, json!("not_found")), "{body}");
}

#[tokio::test]
async fn an_edit_and_a_cancellation_apply_at_once_and_a_stale_version_is_refused() {
    let mut store = MemStore::default();
    let york = json!({
        "tripId": "trp_york", "name": "York", "departsOn": "2026-11-02", "returnsOn": "2026-11-03",
        "destinations": [{"label": "York", "timezone": "Europe/London", "from": "2026-11-02", "to": "2026-11-03"}], "source": {"kind": "owner_statement"},
    });
    assert_eq!(command(&mut store, "york-0001", "trip.create", york).await.0, 200);

    let changes = json!({"tripId": "trp_york", "changes": {"returnsOn": "2026-11-04", "name": "York and Leeds"}});
    let (status, edited) = command_with(&mut store, "york-0002", "trip.update", changes.clone(), json!({"trip:trp_york": 1})).await;
    assert_eq!(status, 200, "{edited}");
    assert_eq!(edited["summary"], "Trip \u{201c}York and Leeds\u{201d} updated: name, returnsOn", "named in the schema's order");
    assert_eq!(edited["result"], json!({"tripId": "trp_york", "version": 2}));
    assert_eq!(edited["undo"], json!({"available": false, "reason": trips::UPDATE_NO_UNDO}));
    let t = trip(&mut store, "trp_york").await;
    assert_eq!((t["name"].clone(), t["returnsOn"].clone(), t["version"].clone()), (json!("York and Leeds"), json!("2026-11-04"), json!(2)));

    let (status, stale) = command_with(&mut store, "york-0003", "trip.update", json!({"tripId": "trp_york", "changes": {"name": "Leeds"}}), json!({"trip:trp_york": 1})).await;
    assert_eq!(status, 409, "{stale}");
    for (key, changes, says) in [
        ("york-0004", json!({"returnsOn": "2026-11-01"}), "the return date is before the departure date"),
        ("york-0005", json!({"destinations": [{"label": "Leeds", "timezone": "Europe/London", "from": "2026-11-01", "to": "2026-11-02"}]}), "the stay in Leeds is outside the trip dates"),
        ("york-0006", json!({}), "changes: at least one change is required"),
        ("york-0007", json!({"status": "cancelled"}), "changes.status: not a field here"),
    ] {
        let (status, body) = command(&mut store, key, "trip.update", json!({"tripId": "trp_york", "changes": changes})).await;
        assert_eq!(status, 400, "{body}");
        assert!(said(&body).contains(says), "expected '{says}' in {body}");
    }
    assert_eq!(trip(&mut store, "trp_york").await["version"], 2, "nothing was written");

    let (status, cancelled) = command(&mut store, "york-0008", "trip.cancel", json!({"tripId": "trp_york"})).await;
    assert_eq!(status, 200, "{cancelled}");
    assert_eq!(cancelled["summary"], "Trip \u{201c}York and Leeds\u{201d} cancelled");
    assert_eq!(cancelled["result"], json!({"tripId": "trp_york", "stillPacked": 0}));
    assert_eq!(cancelled["undo"], json!({"available": false, "reason": trips::CANCEL_NO_UNDO}));
    let (status, again) = command(&mut store, "york-0009", "trip.cancel", json!({"tripId": "trp_york"})).await;
    assert_eq!(status, 200, "{again}");
    assert_eq!((again["outcome"].clone(), again["summary"].clone(), again["result"].clone()), (json!("noop"), json!("That trip was already cancelled"), json!({})));
    assert_eq!(trip(&mut store, "trp_york").await["version"], 3, "a noop writes no version");

    let (status, body) = command(&mut store, "york-0010", "trip.update", json!({"tripId": "trp_york", "changes": {"name": "Leeds"}})).await;
    assert_eq!((status, error(&body)), (404, (json!("not_found"), "no active trip 'trp_york'".into())));
    let (status, body) = command(&mut store, "york-0011", "trip.cancel", json!({"tripId": "trp_nowhere"})).await;
    assert_eq!((status, error(&body)), (404, (json!("not_found"), "no trip 'trp_nowhere'".into())));
}

#[tokio::test]
async fn an_invalid_trip_is_refused_and_writes_nothing() {
    let mut store = MemStore::default();
    let base = lisbon();
    let mut destination = base["destinations"][0].clone();
    destination["timezone"] = json!("europe/lisbon");
    let mut long = base.clone();
    long["returnsOn"] = json!("2026-11-20");
    long["destinations"][0]["to"] = json!("2026-11-20");
    let mut no_source = base.clone();
    no_source.as_object_mut().unwrap().remove("source");
    let huge_label = "\u{1f9f3}".repeat(200);
    let mut huge = base.clone();
    huge["occasions"] = json!((0..62).map(|_| json!({"localDate": "2026-10-21", "label": huge_label})).collect::<Vec<_>>());
    huge["laundry"] = json!((0..31).map(|_| json!({"localDate": "2026-10-22", "note": "\u{1f9fa}".repeat(500)})).collect::<Vec<_>>());
    for (n, payload, code, says) in [
        (1, with(&base, "returnsOn", json!("2026-10-19")), "invalid_command", "the return date is before the departure date"),
        (2, long, "invalid_command", "a trip on this server is at most 31 days"),
        (3, with(&base, "destinations", json!([destination])), "invalid_command", "destinations[0].timezone: not a known IANA timezone"),
        (4, with(&base, "tripId", json!("trp lisbon")), "invalid_command", "a trip ID may contain only letters, digits, '-' and '_'"),
        (5, no_source, "invalid_command", "source: expected where this came from"),
        (6, with(&base, "destinations", json!([])), "invalid_command", "destinations: expected a list of 1 to 10 entries"),
        (7, with(&base, "luggage", json!({"label": "bag", "maxPieces": 0})), "invalid_command", "luggage.maxPieces"),
        (8, with(&base, "luggage", json!({"label": "bag", "maxPieces": 2.5})), "invalid_command", "a trip destination's latitude and longitude may be any coordinate"),
        (9, with(&base, "source", json!({"kind": "rumour"})), "invalid_command", "source.kind: expected one of"),
        (10, huge, "invalid_command", "the trip is larger than this server keeps (48 KiB at most)"),
    ] {
        let (status, body) = command(&mut store, &format!("bad-{n:04}"), "trip.create", payload).await;
        assert_eq!((status, error(&body).0), (400, json!(code)), "case {n}: {body}");
        assert!(said(&body).contains(says), "case {n}: expected '{says}' in {body}");
    }
    // A coordinate is accepted as JavaScript writes it, negative and fractional alike.
    let mut southern = with(&base, "tripId", json!("trp_south"));
    southern["destinations"][0]["latitude"] = json!(-33.8688);
    southern["destinations"][0]["longitude"] = json!(151.2093);
    southern["destinations"][0]["timezone"] = json!("Australia/Sydney");
    let (status, body) = command(&mut store, "bad-0011", "trip.create", southern).await;
    assert_eq!(status, 200, "{body}");
    let ids: Vec<Value> = trip_list(&mut store).await.iter().map(|t| t["tripId"].clone()).collect();
    assert_eq!(ids, [json!("trp_south")], "only the valid trip was written");
}

#[tokio::test]
async fn a_packing_proposal_is_recorded_from_the_stock_at_home_and_packs_nothing() {
    let mut store = MemStore::default();
    assert_eq!(command(&mut store, "pack-trip-0001", "trip.create", lisbon()).await.0, 200);
    let before = garments(&mut store).await;

    let (status, proposal) = propose(&mut store, OWNER, "trp_lisbon", "pack-0001").await;
    assert_eq!(status, 200, "{proposal}");
    let keys: BTreeSet<&str> = proposal.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, BTreeSet::from(["tripId", "revision", "createdAt", "items", "days", "repeatExceptionForTrip", "weather", "notes"]));
    assert_eq!((proposal["tripId"].clone(), proposal["revision"].clone(), proposal["createdAt"].clone()), (json!("trp_lisbon"), json!(1), json!("2026-10-12T09:00:00Z")));
    assert_eq!(proposal["repeatExceptionForTrip"], true);

    // Four days and the evening of the dinner, each a complete outfit of the owner's garments.
    let days = proposal["days"].as_array().unwrap();
    let planned: Vec<(&str, &str)> = days.iter().map(|d| (d["localDate"].as_str().unwrap(), d["segment"].as_str().unwrap())).collect();
    assert_eq!(planned, [("2026-10-20", "day"), ("2026-10-21", "day"), ("2026-10-21", "evening"), ("2026-10-22", "day"), ("2026-10-23", "day")], "{proposal}");
    assert_eq!(days[2]["occasion"], "Dinner with Ana");
    let items = proposal["items"].as_array().unwrap();
    let packed: BTreeMap<&str, u64> = items.iter().map(|i| (i["garmentId"].as_str().unwrap(), i["quantity"].as_u64().unwrap())).collect();
    assert_eq!(packed.len(), items.len(), "each garment is listed once");
    for d in days {
        let roles: Vec<&str> = d["slots"].as_array().unwrap().iter().map(|s| s["role"].as_str().unwrap()).collect();
        assert!(roles.contains(&"top") && roles.contains(&"bottom") && roles.contains(&"footwear"), "{d}");
        for s in d["slots"].as_array().unwrap() {
            assert!(packed.contains_key(s["garmentId"].as_str().unwrap()), "{s} is worn but not in the bag");
        }
        assert!(!d["reason"].as_str().unwrap().is_empty(), "{d}");
    }
    let cat = catalogue();
    let home = Day::of(cat, &Ledger::default(), "2026-10-20");
    for i in items {
        let id = i["garmentId"].as_str().unwrap();
        assert_eq!(i["name"], cat.get(id).unwrap().name, "{i}");
        if i["role"] == "socks" {
            assert!(packed[id] <= u64::from(home.stock.of(id).clean.max(1)), "no more pairs than are clean at home: {i}");
        } else {
            assert_eq!(packed[id], 1, "{i}");
        }
    }
    let weather = proposal["weather"].as_array().unwrap();
    assert_eq!(weather.len(), 4);
    assert!(weather.iter().all(|w| w["label"] == "Lisbon" && w["freshness"] == "unavailable" && w["line"] == "Weather unavailable"), "{weather:?}");
    let notes: Vec<&str> = proposal["notes"].as_array().unwrap().iter().map(|n| n.as_str().unwrap()).collect();
    assert!(notes.contains(&"Some destination forecasts are stale or unavailable; those days were proposed without a verified forecast."), "{notes:?}");
    assert_eq!(notes.last(), Some(&"Pieces are reused deliberately across days. That exception to the repeat rule applies to this trip only."));
    assert!(notes.iter().any(|n| n.starts_with("The outfit worn on 2026-10-20 for the journey is not packed, so it does not count against the carry-on")), "{notes:?}");

    // The proposal is kept on the trip; nothing is packed and no garment changed.
    let t = trip(&mut store, "trp_lisbon").await;
    assert_eq!(t["packed"], json!([]));
    assert_eq!(t["proposal"], proposal);
    assert_eq!(t["version"], 1, "a proposal is not an edit of the trip");
    assert_eq!(garments(&mut store).await, before);

    // The same request replays its revision; a new request is the next revision.
    let (status, replay) = propose(&mut store, OWNER, "trp_lisbon", "pack-0001").await;
    assert_eq!((status, &replay), (200, &proposal));
    let (status, second) = propose(&mut store, OWNER, "trp_lisbon", "pack-0002").await;
    assert_eq!((status, second["revision"].clone()), (200, json!(2)), "{second}");
    assert_eq!(second["items"], proposal["items"], "the same stock proposes the same bag");
    assert_eq!(trip(&mut store, "trp_lisbon").await["proposal"]["revision"], 2);

    // The receipt says it is only a proposal.
    let (_, listed) = send(&mut store, OWNER, "GET", "/v1/commands?limit=1", Value::Null).await;
    let receipt = listed["receipts"].as_array().and_then(|c| c.first()).cloned().unwrap_or(Value::Null);
    assert_eq!(receipt["type"], "trip.record_packing_proposal", "{listed}");
    let summary = receipt["summary"].as_str().unwrap();
    assert!(summary.starts_with("Packing proposed for \u{201c}Lisbon\u{201d}: ") && summary.ends_with("for 5 outfits, with the travel-day outfit worn. This is a proposal; nothing is packed until you say so"), "{summary}");
    assert_eq!(receipt["undo"], json!({"available": false, "reason": trips::PROPOSAL_NO_UNDO}));

    for (body, says) in [(json!({"clientRequestId": "short"}), "clientRequestId"), (json!({"clientRequestId": "pack-0003", "tripId": "x"}), "tripId")] {
        let (status, refused) = send(&mut store, OWNER, "POST", "/v1/trips/trp_lisbon/packing-proposal", body).await;
        assert_eq!(status, 400, "{refused}");
        assert!(said(&refused).contains(says), "{refused}");
    }
    let (status, body) = propose(&mut store, OWNER, "trp_nowhere", "pack-0004").await;
    assert_eq!((status, error(&body)), (404, (json!("not_found"), "no active trip 'trp_nowhere'".into())));
}

#[tokio::test]
async fn a_retransmission_answers_with_the_recorded_proposal_whatever_changed_since() {
    let mut store = MemStore::default();
    assert_eq!(command(&mut store, "retry-trip-0001", "trip.create", lisbon()).await.0, 200);
    let (status, first) = propose(&mut store, OWNER, "trp_lisbon", "retry-pack-0001").await;
    assert_eq!(status, 200, "{first}");
    let bottom = first["items"].as_array().unwrap().iter().find(|i| i["role"] == "bottom").unwrap()["garmentId"].clone();

    // The trousers it packed go in the hamper, the trip is renamed, then cancelled: the same request
    // still answers with what it recorded, and plans nothing again.
    assert_eq!(command(&mut store, "retry-dirty-0001", "care.mark_dirty", json!({"items": [{"garmentId": bottom}]})).await.0, 200);
    assert_eq!(propose(&mut store, OWNER, "trp_lisbon", "retry-pack-0001").await, (200, first.clone()));
    assert_eq!(command(&mut store, "retry-trip-0002", "trip.update", json!({"tripId": "trp_lisbon", "changes": {"name": "Lisbon and Sintra"}})).await.0, 200);
    assert_eq!(propose(&mut store, OWNER, "trp_lisbon", "retry-pack-0001").await, (200, first.clone()));
    assert_eq!(command(&mut store, "retry-trip-0003", "trip.cancel", json!({"tripId": "trp_lisbon"})).await.0, 200);
    assert_eq!(propose(&mut store, OWNER, "trp_lisbon", "retry-pack-0001").await, (200, first.clone()));
    let (status, body) = propose(&mut store, OWNER, "trp_lisbon", "retry-pack-0002").await;
    assert_eq!((status, error(&body).0), (404, json!("not_found")), "a new request for a cancelled trip: {body}");

    // The request ID belongs to the trip it was sent for.
    let mut york = lisbon();
    york["tripId"] = json!("trp_york");
    assert_eq!(command(&mut store, "retry-trip-0004", "trip.create", york).await.0, 200);
    let (status, body) = propose(&mut store, OWNER, "trp_york", "retry-pack-0001").await;
    assert_eq!((status, error(&body).0), (409, json!("idempotency_key_reuse")), "{body}");
    assert_eq!(trip(&mut store, "trp_york").await["proposal"], Value::Null);
}

/// The store double with one concurrent write: the first ledger read after the route has read the
/// trip sees `swap` instead, as if another request had committed in between.
struct Racing {
    inner: MemStore,
    swap: Option<MemStore>,
    trip_read: bool,
}

impl Store for Racing {
    async fn get(&mut self, key: &[u8]) -> io::Result<Option<Vec<u8>>> {
        if key.starts_with(b"trip/") {
            self.trip_read = true;
        } else if key == b"ledger" && self.trip_read {
            if let Some(s) = self.swap.take() {
                self.inner = s;
            }
        }
        self.inner.get(key).await
    }
    async fn commit_n_if(&mut self, guard: &[u8], expected: Option<&[u8]>, entries: &[(&[u8], &[u8])]) -> io::Result<Result<(), Option<Vec<u8>>>> {
        self.inner.commit_n_if(guard, expected, entries).await
    }
}

#[tokio::test]
async fn a_plan_read_before_a_concurrent_change_is_never_recorded_and_is_planned_again() {
    let mut before = MemStore::default();
    assert_eq!(command(&mut before, "race-trip-0001", "trip.create", lisbon()).await.0, 200);
    // Meanwhile the trip is shortened by a day.
    let mut after = before.clone();
    let shorter = json!({"tripId": "trp_lisbon", "changes": {"returnsOn": "2026-10-22", "destinations": [{"label": "Lisbon", "timezone": "Europe/Lisbon", "from": "2026-10-20", "to": "2026-10-22"}]}});
    assert_eq!(command(&mut after, "race-trip-0002", "trip.update", shorter).await.0, 200);

    let mut racing = Racing { inner: before, swap: Some(after), trip_read: false };
    let (status, proposal) = propose(&mut racing, OWNER, "trp_lisbon", "race-pack-0001").await;
    assert_eq!(status, 200, "{proposal}");
    assert!(racing.swap.is_none(), "the concurrent write happened during the request");
    let dates: BTreeSet<&str> = proposal["days"].as_array().unwrap().iter().map(|d| d["localDate"].as_str().unwrap()).collect();
    assert_eq!(dates, BTreeSet::from(["2026-10-20", "2026-10-21", "2026-10-22"]), "planned for the trip as it now stands: {proposal}");
    assert_eq!(proposal["weather"].as_array().unwrap().len(), 3);
    assert_eq!(proposal["revision"], 1, "the stale plan was never recorded");
    let t = trip(&mut racing.inner, "trp_lisbon").await;
    assert_eq!((t["version"].clone(), t["proposal"].clone()), (json!(2), proposal));
}

#[tokio::test]
async fn days_left_without_socks_are_stated_in_one_note_that_fits_the_proposal() {
    let mut store = MemStore::default();
    let cat = catalogue();
    let home = Day::of(cat, &Ledger::default(), "2026-12-01");
    let occasions: Vec<Value> = (1..=31).map(|d| json!({"localDate": format!("2026-12-{d:02}"), "label": "Dinner", "segment": "evening"})).collect();
    let december = json!({
        "tripId": "trp_december", "name": "December away", "departsOn": "2026-12-01", "returnsOn": "2026-12-31",
        "destinations": [{"label": "Copenhagen", "timezone": "Europe/Copenhagen", "from": "2026-12-01", "to": "2026-12-31"}],
        "occasions": occasions, "source": {"kind": "owner_statement"},
    });
    // Every pair of socks goes in the hamper but one of the pair the planner picks first.
    let mut unchanged = december.clone();
    unchanged.as_object_mut().unwrap().remove("tripId");
    let first_plan = trips::propose(cat, &Ledger::default(), &stored_trip(unchanged));
    let keep = first_plan["days"][0]["slots"].as_array().unwrap().iter().find(|s| s["role"] == "socks").unwrap()["garmentId"].as_str().unwrap().to_string();
    let mut dirty = Vec::new();
    for g in cat.garments.iter().filter(|g| g.roles.iter().any(|r| r == "socks")) {
        let clean = home.stock.of(&g.id).clean;
        let n = if g.id == keep { clean - 1 } else { clean };
        if n > 0 {
            dirty.push(json!({"garmentId": g.id, "quantity": n}));
        }
    }
    let (status, body) = command(&mut store, "socks-dirty-0001", "care.mark_dirty", json!({"items": dirty})).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(command(&mut store, "socks-trip-0001", "trip.create", december).await.0, 200);
    let (status, proposal) = propose(&mut store, OWNER, "trp_december", "socks-pack-0001").await;
    assert_eq!(status, 200, "{proposal}");
    let notes: Vec<&str> = proposal["notes"].as_array().unwrap().iter().map(|n| n.as_str().unwrap()).collect();
    let shortfall: Vec<&&str> = notes.iter().filter(|n| n.starts_with("No clean pair of socks is left for ")).collect();
    assert_eq!(shortfall.len(), 1, "{notes:?}");
    assert!(shortfall[0].contains(" more:") && shortfall[0].contains("more clean pairs are needed before then"), "{}", shortfall[0]);
    assert!(notes.len() <= 10 && notes.iter().all(|n| n.chars().count() <= 1_000), "{notes:?}");
    let socks_days = proposal["days"].as_array().unwrap().iter().filter(|d| d["slots"].as_array().unwrap().iter().any(|s| s["role"] == "socks")).count();
    assert!(socks_days <= 2, "one clean pair covers one day and its evening: {socks_days}");
}

#[tokio::test]
async fn a_proposal_naming_a_garment_the_owner_does_not_have_is_refused() {
    let mut store = MemStore::default();
    assert_eq!(command(&mut store, "made-up-0001", "trip.create", lisbon()).await.0, 200);
    let payload = json!({
        "tripId": "trp_lisbon", "items": [{"garmentId": "gmt_invented", "name": "A coat", "role": "outer", "quantity": 1}],
        "days": [], "weather": [], "notes": [],
    });
    let (status, body) = command(&mut store, "made-up-0002", "trip.record_packing_proposal", payload).await;
    assert_eq!((status, error(&body)), (404, (json!("not_found"), "unknown garment: gmt_invented".into())));
    assert_eq!(trip(&mut store, "trp_lisbon").await["proposal"], Value::Null);
}

#[tokio::test]
async fn a_connected_assistant_relays_a_trip_and_asks_for_a_proposal_but_cannot_tap() {
    let mut store = MemStore::default();
    let relayed = json!({"type": "trip.create", "payload": lisbon(), "idempotencyKey": "assistant-trip-0001", "authorization": "owner_statement", "source": {"channel": "mcp"}});
    let receipt = api::execute(&mut store, api::ASSISTANT, now(), &relayed).await.unwrap();
    assert_eq!((receipt["outcome"].clone(), receipt["actor"].clone(), receipt["undo"]["available"].clone()), (json!("committed"), json!("assistant"), json!(true)));
    let mut tap = relayed.clone();
    tap["authorization"] = json!("owner_tap");
    tap["idempotencyKey"] = json!("assistant-trip-0002");
    assert_eq!(api::execute(&mut store, api::ASSISTANT, now(), &tap).await.unwrap_err().code, "forbidden");
    let (status, proposal) = propose(&mut store, ASSISTANT, "trp_lisbon", "assistant-pack-0001").await;
    assert_eq!((status, proposal["revision"].clone()), (200, json!(1)), "{proposal}");
    let (status, listed) = send(&mut store, ASSISTANT, "GET", "/v1/trips", Value::Null).await;
    assert_eq!((status, listed["trips"][0]["proposal"]["revision"].clone()), (200, json!(1)));
}

fn stored_trip(payload: Value) -> Trip {
    let input = trips::parse_create(&payload).unwrap();
    Trip {
        trip_id: "trp_planner".into(), version: 1, name: input.name, departs_on: input.departs_on, returns_on: input.returns_on,
        destinations: input.destinations, occasions: input.occasions, luggage: input.luggage, laundry: input.laundry,
        status: "planned".into(), source: input.source, proposal_revision: 0, command_id: "cmd_planner".into(),
        created_at: "2026-10-12T09:00:00Z".into(), updated_at: "2026-10-12T09:00:00Z".into(),
    }
}

#[test]
fn the_longest_trip_with_an_evening_every_day_fits_in_one_proposal_and_never_overcounts_socks() {
    let occasions: Vec<Value> = (1..=31).map(|d| json!({"localDate": format!("2026-12-{d:02}"), "label": "Dinner", "segment": "evening"})).collect();
    let trip = stored_trip(json!({
        "name": "December away", "departsOn": "2026-12-01", "returnsOn": "2026-12-31",
        "destinations": [{"label": "Copenhagen", "timezone": "Europe/Copenhagen", "from": "2026-12-01", "to": "2026-12-31"}],
        "occasions": occasions, "laundry": [{"localDate": "2026-12-15"}], "source": {"kind": "owner_statement"},
    }));
    let cat = catalogue();
    let ledger = Ledger::default();
    let payload = trips::propose(cat, &ledger, &trip);
    let input = trips::parse_proposal(cat, &payload).unwrap_or_else(|e| panic!("the planner wrote a payload its own command refuses: {e:?}"));
    assert_eq!(input.days.len(), 62, "every day and every evening");
    assert_eq!(input.weather.len(), 31);
    let record = json!({"tripId": trip.trip_id, "revision": 1, "createdAt": "2026-10-12T09:00:00Z", "items": input.items, "days": input.days, "repeatExceptionForTrip": true, "weather": input.weather, "notes": input.notes});
    assert!(record.to_string().len() <= MAX_PROPOSAL_BYTES, "{} bytes", record.to_string().len());
    assert!(input.notes.iter().any(|n| n.starts_with("Laundry opportunities on the trip are estimates")), "{:?}", input.notes);

    let home = Day::of(cat, &ledger, "2026-12-01");
    let mut sock_days: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for d in &input.days {
        for s in d["slots"].as_array().unwrap() {
            if s["role"] == "socks" {
                sock_days.entry(s["garmentId"].as_str().unwrap().to_string()).or_default().insert(d["localDate"].as_str().unwrap().to_string());
            }
        }
    }
    for (id, dates) in &sock_days {
        assert!(dates.len() as u32 <= home.stock.of(id).clean.max(1), "{id} is planned for {} days with {} clean pairs", dates.len(), home.stock.of(id).clean);
    }
    for d in input.days.iter().filter(|d| d["segment"] == "evening") {
        let day = input.days.iter().find(|x| x["localDate"] == d["localDate"] && x["segment"] == "day").unwrap();
        let socks = |x: &Value| x["slots"].as_array().unwrap().iter().find(|s| s["role"] == "socks").map(|s| s["garmentId"].clone());
        if socks(d).is_some() && socks(day).is_some() {
            assert_eq!(socks(d), socks(day), "an evening keeps the day's socks when it can: {d}");
        }
    }
}

#[test]
fn over_a_luggage_limit_the_shortfall_is_stated() {
    let trip = stored_trip(json!({
        "name": "Weekend", "departsOn": "2026-10-24", "returnsOn": "2026-10-26",
        "destinations": [{"label": "Bath", "timezone": "Europe/London", "from": "2026-10-24", "to": "2026-10-26"}],
        "luggage": {"label": "a small backpack", "maxPieces": 2}, "source": {"kind": "owner_statement"},
    }));
    let payload = trips::propose(catalogue(), &Ledger::default(), &trip);
    let notes: Vec<&str> = payload["notes"].as_array().unwrap().iter().map(|n| n.as_str().unwrap()).collect();
    let pieces = trips::packed_pieces(payload["items"].as_array().unwrap(), payload["days"].as_array().unwrap(), "2026-10-24");
    assert!(pieces > 2, "{payload}");
    assert!(notes.contains(&format!("This is {pieces} pieces against a limit of 2 for a small backpack, with the trousers, jacket, shoes and belt reused across days and the travel-day outfit worn rather than packed.").as_str()), "{notes:?}");
}
