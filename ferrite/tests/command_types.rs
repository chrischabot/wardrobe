//! `GET /v1/command-types` (`CommandTypeList`): the command types this port executes, described as the
//! TypeScript registry describes them and narrowed to what the port's handlers accept. Valid payloads
//! that together use every published field are checked against the published schema and executed
//! through `POST /v1/commands`; an unpublished field and each value the schema narrows away are
//! refused by both, so the list cannot claim more or less than the port does.
//!
//! The store is an in-memory test double of the APE binding; the garments are the real seed.

use std::collections::BTreeMap;
use std::io;

use ferrite_app::serde_json::{self, json, Value};
use ferrite_app::IngressRequest;
use wardrobe::api::{self, Store, Tokens};
use wardrobe::ledger;

const OWNER: &str = "owner-token-for-tests";
const ASSISTANT: &str = "assistant-token-for-tests";
const T0: u64 = 1_789_000_000_000;

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

async fn send(store: &mut MemStore, token: Option<&str>, method: &str, path: &str, body: Value) -> (u16, Value) {
    let bytes = if body.is_null() { Vec::new() } else { serde_json::to_vec(&body).unwrap() };
    let mut req = IngressRequest::new(method, path, bytes);
    if let Some(token) = token {
        req.headers = vec![("authorization".into(), format!("Bearer {token}"))];
    }
    let tokens = Tokens { owner: Some(OWNER.into()), assistant: Some(ASSISTANT.into()), public_origin: Some("http://127.0.0.1:8787".into()), ..Default::default() };
    let reply = api::handle(store, &tokens, T0, &req).await;
    let (_, bytes) = reply.content();
    (reply.status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn type_of<'a>(list: &'a Value, kind: &str) -> &'a Value {
    list["types"].as_array().unwrap().iter().find(|t| t["type"] == kind).unwrap_or_else(|| panic!("{kind} is not listed"))
}

#[tokio::test]
async fn the_list_names_exactly_the_ported_commands_as_the_typescript_registry_describes_them() {
    let mut store = MemStore::default();
    let (status, list) = send(&mut store, Some(OWNER), "GET", "/v1/command-types", Value::Null).await;
    assert_eq!(status, 200, "{list}");
    assert_eq!(list["contractVersion"], api::CONTRACT_VERSION);
    let mut ported: Vec<&str> = ledger::COMMAND_TYPES.to_vec();
    ported.sort_unstable();
    let listed: Vec<&str> = list["types"].as_array().unwrap().iter().map(|t| t["type"].as_str().unwrap()).collect();
    assert_eq!(listed, ported, "sorted by type, as registry.types() is");
    for t in list["types"].as_array().unwrap() {
        let keys: Vec<&str> = t.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys.len(), 6, "{t}");
        for k in ["type", "class", "requiredScope", "authorizations", "consequential", "payloadSchema"] {
            assert!(keys.contains(&k), "{k} missing from {t}");
        }
        assert_eq!(t["requiredScope"], "write", "{t}");
        // Nothing this port executes waits for the owner when a connected assistant sends it.
        assert_eq!(t["consequential"], false, "{t}");
        assert_eq!(t["payloadSchema"]["type"], "object", "{t}");
        assert_eq!(t["payloadSchema"]["additionalProperties"], false, "{t}");
    }
    // The owner's reports are observations; a choice, a swap and an undo are edits (handlers in
    // packages/domain and packages/daily).
    for kind in ["care.mark_dirty", "care.washed", "feedback.record", "feedback.retract", "laundry.collect", "laundry.return", "stock.pack", "stock.unpack", "wear.record"] {
        assert_eq!(type_of(&list, kind)["class"], "observation", "{kind}");
    }
    for kind in ["board.select", "board.swap_slot", "command.undo", "return.open_case", "return.update_case", "trip.cancel", "trip.create", "trip.update"] {
        assert_eq!(type_of(&list, kind)["class"], "edit", "{kind}");
    }
    let wear = type_of(&list, "wear.record");
    assert_eq!(wear["authorizations"], json!(["owner_tap", "owner_statement"]));
    assert_eq!(wear["payloadSchema"]["required"], json!(["wearingDate", "garmentIds"]));
    assert_eq!(wear["payloadSchema"]["properties"]["garmentIds"]["minItems"], 1);
    // A publication is a system command the TypeScript service also lets a schedule or a standing
    // policy authorize; this port has neither, so only the owner's tap or statement is offered, and
    // the run fingerprint it does not accept is not published.
    let publish = type_of(&list, "board.publish");
    assert_eq!(publish["class"], "system");
    assert_eq!(publish["authorizations"], json!(["owner_tap", "owner_statement"]));
    assert!(publish["payloadSchema"]["properties"].get("requestFingerprint").is_none(), "{publish}");
    assert_eq!(publish["payloadSchema"]["required"], json!(["localDate", "options", "requestedCount"]));
    // A packing proposal is a system command too; this port records one only on the owner's request
    // or an assistant's relay of it.
    let proposal = type_of(&list, "trip.record_packing_proposal");
    assert_eq!(proposal["class"], "system");
    assert_eq!(proposal["authorizations"], json!(["owner_tap", "owner_statement"]));
    assert_eq!(type_of(&list, "trip.create")["payloadSchema"]["required"], json!(["name", "departsOn", "returnsOn", "destinations", "source"]));
    assert_eq!(type_of(&list, "board.select")["payloadSchema"]["required"], json!(["boardId", "optionId"]));
    // A wear may name the trip it was worn on; packing names a trip and what went into the suitcase,
    // unpacking a trip and, optionally, which pieces came home.
    assert_eq!(wear["payloadSchema"]["properties"]["tripId"], json!({"default": null, "type": ["string", "null"]}));
    assert_eq!(type_of(&list, "stock.pack")["payloadSchema"]["required"], json!(["tripId", "items"]));
    assert_eq!(type_of(&list, "stock.unpack")["payloadSchema"]["required"], json!(["tripId"]));
    // What the port categorically refuses is narrowed: the home board or a trip's day board (no evening
    // boards), the default brief, no weather or Calendar snapshot.
    assert_eq!(publish["payloadSchema"]["properties"]["scope"]["anyOf"], json!([{"const": "home"}, {"pattern": "^trip:[^:]+$", "maxLength": 133}]));
    assert_eq!(publish["payloadSchema"]["properties"]["weatherSnapshotId"]["type"], "null");
    assert!(type_of(&list, "board.swap_slot")["payloadSchema"]["properties"].get("weatherSnapshotId").is_none());
    // No orders: a return names a garment; a deadline is computed in London time or UTC only.
    let open = &type_of(&list, "return.open_case")["payloadSchema"]["properties"];
    assert_eq!(open["orderId"], json!({"type": "null", "default": null}));
    assert_eq!(open["garmentId"]["type"], "string");
    assert_eq!(open["timezone"], json!({"type": "string", "enum": ["Europe/London", "UTC"]}));
    assert_eq!(type_of(&list, "return.update_case")["payloadSchema"]["properties"]["refundReceivedMinor"]["minimum"], json!(-9007199254740991i64));
}

#[tokio::test]
async fn a_connected_assistant_reads_the_same_list_and_an_unsigned_request_is_refused() {
    let mut store = MemStore::default();
    let (_, owner) = send(&mut store, Some(OWNER), "GET", "/v1/command-types", Value::Null).await;
    let (status, assistant) = send(&mut store, Some(ASSISTANT), "GET", "/v1/command-types", Value::Null).await;
    assert_eq!((status, &assistant), (200, &owner));
    let (status, body) = send(&mut store, None, "GET", "/v1/command-types", Value::Null).await;
    assert_eq!(status, 401, "{body}");
    let (status, body) = send(&mut store, Some("not-a-token"), "GET", "/v1/command-types", Value::Null).await;
    assert_eq!(status, 401, "{body}");
}

/// A JSON Schema check for the keywords the published payload schemas use (`pattern` is not checked;
/// the handler's own date and ID checks cover it).
fn check(schema: &Value, v: &Value, at: &str) -> Result<(), String> {
    let fail = |why: &str| Err(format!("{at}: {why} ({v})"));
    if let Some(c) = schema.get("const") {
        if c != v {
            return fail(&format!("expected {c}"));
        }
    }
    if let Some(e) = schema.get("enum").and_then(Value::as_array) {
        if !e.contains(v) {
            return fail("not one of the enumerated values");
        }
    }
    if let Some(any) = schema.get("anyOf").and_then(Value::as_array) {
        if !any.iter().any(|s| check(s, v, at).is_ok()) {
            return fail("matches no anyOf branch");
        }
    }
    if let Some(t) = schema.get("type") {
        let types: Vec<&str> = match t {
            Value::String(s) => vec![s.as_str()],
            Value::Array(a) => a.iter().filter_map(Value::as_str).collect(),
            _ => vec![],
        };
        let is = |name: &str| match name {
            "object" => v.is_object(),
            "array" => v.is_array(),
            "string" => v.is_string(),
            "integer" => v.is_i64() || v.is_u64(),
            "number" => v.is_number(),
            "boolean" => v.is_boolean(),
            "null" => v.is_null(),
            _ => false,
        };
        if !types.iter().any(|name| is(name)) {
            return fail(&format!("expected type {t}"));
        }
    }
    if let Some(s) = v.as_str() {
        let n = s.chars().count() as u64;
        if schema.get("minLength").and_then(Value::as_u64).map_or(false, |m| n < m) || schema.get("maxLength").and_then(Value::as_u64).map_or(false, |m| n > m) {
            return fail("length out of bounds");
        }
    }
    if let Some(x) = v.as_f64() {
        let below = schema.get("minimum").and_then(Value::as_f64).map_or(false, |m| x < m) || schema.get("exclusiveMinimum").and_then(Value::as_f64).map_or(false, |m| x <= m);
        if below || schema.get("maximum").and_then(Value::as_f64).map_or(false, |m| x > m) {
            return fail("number out of bounds");
        }
    }
    if let Some(a) = v.as_array() {
        let n = a.len() as u64;
        if schema.get("minItems").and_then(Value::as_u64).map_or(false, |m| n < m) || schema.get("maxItems").and_then(Value::as_u64).map_or(false, |m| n > m) {
            return fail("item count out of bounds");
        }
        if let Some(items) = schema.get("items") {
            for (i, x) in a.iter().enumerate() {
                check(items, x, &format!("{at}[{i}]"))?;
            }
        }
    }
    if let Some(o) = v.as_object() {
        for r in schema.get("required").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            if !o.contains_key(r) {
                return fail(&format!("{r} is required"));
            }
        }
        let props = schema.get("properties").and_then(Value::as_object);
        for (k, x) in o {
            match props.and_then(|p| p.get(k)) {
                Some(s) => check(s, x, &format!("{at}.{k}"))?,
                None if schema.get("additionalProperties") == Some(&Value::Bool(false)) => return fail(&format!("{k} is not a published field")),
                None => {}
            }
        }
    }
    Ok(())
}

// Real garments of the owner's seed (the same outfits the dev flow publishes).
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

fn outfit(top: &str, bottom: &str, socks: &str, shoes: &str, belt: &str) -> Value {
    json!({"slots": [{"role": "top", "garmentId": top}, {"role": "bottom", "garmentId": bottom}, {"role": "belt", "garmentId": belt}, {"role": "socks", "garmentId": socks}, {"role": "footwear", "garmentId": shoes}], "reason": ""})
}

struct Run {
    store: MemStore,
    list: Value,
    n: usize,
    used: BTreeMap<String, Vec<String>>,
}

impl Run {
    fn schema(&self, kind: &str) -> Value {
        type_of(&self.list, kind)["payloadSchema"].clone()
    }
    async fn post(&mut self, kind: &str, payload: &Value) -> (u16, Value) {
        self.n += 1;
        let envelope = json!({"type": kind, "payload": payload, "idempotencyKey": format!("command-types-{:04}", self.n), "authorization": "owner_tap", "source": {"channel": "ios"}});
        send(&mut self.store, Some(OWNER), "POST", "/v1/commands", envelope).await
    }
    /// A payload the published schema accepts, which the port then executes.
    async fn accepted(&mut self, kind: &str, payload: Value) -> Value {
        check(&self.schema(kind), &payload, kind).unwrap_or_else(|e| panic!("the published schema refuses a payload the port should run: {e}"));
        let (status, receipt) = self.post(kind, &payload).await;
        assert_eq!(status, 200, "{kind} {payload}: {receipt}");
        self.used.entry(kind.to_string()).or_default().extend(payload.as_object().unwrap().keys().cloned());
        receipt
    }
    /// A payload the published schema refuses, which the port refuses too and records nothing for.
    async fn refused(&mut self, kind: &str, payload: Value, says: &str) {
        assert!(check(&self.schema(kind), &payload, kind).is_err(), "the published schema accepts {kind} {payload}");
        let (status, body) = self.post(kind, &payload).await;
        assert_ne!(status, 200, "{kind} {payload}: {body}");
        assert!(body.to_string().contains(says), "{kind} {payload}: expected '{says}' in {body}");
    }
}

fn with(base: &Value, key: &str, value: Value) -> Value {
    let mut p = base.clone();
    p[key] = value;
    p
}

#[tokio::test]
async fn payloads_the_published_schemas_accept_run_and_the_values_they_refuse_are_refused() {
    let mut store = MemStore::default();
    let (_, list) = send(&mut store, Some(OWNER), "GET", "/v1/command-types", Value::Null).await;
    let mut run = Run { store, list, n: 0, used: BTreeMap::new() };

    // A board, published with every field of board.publish.
    let publish = json!({
        "localDate": "2026-09-11", "scope": "home", "reason": "compose",
        "options": [outfit(OXFORD_BLUE, AKITA_CREAM, SOCK_BISCUIT, NB_GREY, BELT_BROWN)],
        "reserves": [outfit(OXFORD_PINK, GREY_CHINO, SOCK_GREY, NB_OLIVE, BELT_BLACK)],
        "brief": {"text": null, "segment": "day"}, "requestedCount": 1,
        "weatherSnapshotId": null, "calendarSnapshotId": null, "notice": "Published by the command-types test",
        "composedAgainst": {"wardrobeRevision": 0, "styleRevision": 0}, "expectedBoardRevision": 0,
    });
    for (key, value, says) in [
        ("scope", json!(7), "scope: expected home or trip:<tripId>"),
        ("brief", json!({"segment": "evening"}), "send the default brief"),
        ("weatherSnapshotId", json!("wx_1"), "unknown weather snapshot"),
        ("calendarSnapshotId", json!("cal_1"), "unknown calendar snapshot"),
        ("requestFingerprint", json!("0123456789abcdef"), "requestFingerprint: not a field of this command"),
    ] {
        run.refused("board.publish", with(&publish, key, value), says).await;
    }
    // A trip scope the schema admits is still refused for a trip that is not planned, and an evening
    // board (a trip ID with a ':' segment, which the schema's pattern excludes) is not ported.
    for (scope, says) in [("trip:trp_1", "no active trip 'trp_1'"), ("trip:trp_1:evening", "evening boards are not ported")] {
        let (status, body) = run.post("board.publish", &with(&publish, "scope", json!(scope))).await;
        assert_ne!(status, 200, "{scope}: {body}");
        assert!(body.to_string().contains(says), "{scope}: expected '{says}' in {body}");
    }
    let published = run.accepted("board.publish", publish).await;
    let board_id = published["result"]["boardId"].as_str().unwrap().to_string();
    let option_id = published["result"]["optionIds"][0].as_str().unwrap().to_string();

    let select = json!({"boardId": board_id, "optionId": option_id, "footwearGarmentId": null});
    run.refused("board.select", with(&select, "notPublished", json!(true)), "notPublished: not a field of this command").await;
    run.accepted("board.select", select).await;

    let swap = json!({"boardId": board_id, "optionId": option_id, "role": "socks", "garmentId": SOCK_GREY});
    run.refused("board.swap_slot", with(&swap, "weatherSnapshotId", json!("wx_1")), "unknown weather snapshot").await;
    let swapped = run.accepted("board.swap_slot", swap).await;

    let undo = json!({"commandId": swapped["commandId"], "reason": "Swapped by mistake"});
    run.refused("command.undo", with(&undo, "notPublished", json!(true)), "notPublished: not a field of this command").await;
    run.accepted("command.undo", undo).await;

    let wear = json!({"wearingDate": "2026-09-09", "garmentIds": [OXFORD_PINK], "timezone": "Europe/London", "segment": "day", "additionalUnits": [], "tripId": null, "note": "Worn to the office"});
    run.refused("wear.record", with(&wear, "tripId", json!(7)), "tripId: expected a trip ID").await;
    run.accepted("wear.record", wear).await;

    let dirty = json!({"items": [{"garmentId": GREY_CHINO, "quantity": 1}]});
    run.refused("care.mark_dirty", with(&dirty, "notPublished", json!(true)), "notPublished: not a field of this command").await;
    run.accepted("care.mark_dirty", dirty).await;

    let collect = json!({"batchId": "lb-command-types-1", "exclude": [], "include": []});
    run.refused("laundry.collect", with(&collect, "notPublished", json!(true)), "notPublished: not a field of this command").await;
    run.accepted("laundry.collect", collect).await;

    let back = json!({"batchId": "lb-command-types-1", "stillAway": []});
    run.refused("laundry.return", with(&back, "notPublished", json!(true)), "notPublished: not a field of this command").await;
    run.accepted("laundry.return", back).await;

    let washed = json!({"items": [{"garmentId": OXFORD_PINK}]});
    run.refused("care.washed", with(&washed, "notPublished", json!(true)), "notPublished: not a field of this command").await;
    run.accepted("care.washed", washed).await;
    run.accepted("care.washed", json!({"allOfChannel": "handwash"})).await;

    let note = json!({
        "feedbackId": "cfb_command_types", "text": "Too warm on the train", "kind": "too_warm", "garmentIds": [OXFORD_PINK],
        "wearingDate": "2026-09-09", "activity": "commute", "layer": "top", "conditions": {"heating": true}, "scope": "commute by train", "sourceRef": null,
    });
    run.refused("feedback.record", with(&note, "kind", json!("itchy")), "kind: expected one of").await;
    run.accepted("feedback.record", note).await;
    let retract = json!({"feedbackId": "cfb_command_types", "reason": "It was the heating"});
    run.refused("feedback.retract", with(&retract, "notPublished", json!(true)), "notPublished: not a field of this command").await;
    run.accepted("feedback.retract", retract).await;

    let trip = json!({
        "tripId": "trp_command_types", "name": "Lisbon", "departsOn": "2026-10-20", "returnsOn": "2026-10-22",
        "destinations": [{"label": "Lisbon", "latitude": 38.7223, "longitude": -9.1393, "timezone": "Europe/Lisbon", "from": "2026-10-20", "to": "2026-10-22"}],
        "occasions": [{"localDate": "2026-10-21", "label": "Dinner", "register": "smart", "segment": "evening"}],
        "luggage": {"label": "the carry-on", "maxPieces": 20}, "laundry": [{"localDate": "2026-10-21", "note": "hotel laundry"}],
        "source": {"kind": "owner_statement", "ref": "msg_1", "observedAt": "2026-09-09T08:00:00Z", "note": "said on the phone"},
    });
    run.refused("trip.create", with(&trip, "source", json!({"kind": "rumour"})), "source.kind: expected one of").await;
    run.refused("trip.create", with(&trip, "luggage", json!({"label": "bag", "maxPieces": 0})), "luggage.maxPieces").await;
    run.accepted("trip.create", trip).await;
    let update = json!({"tripId": "trp_command_types", "changes": {"name": "Lisbon and Porto"}});
    run.refused("trip.update", with(&update, "notPublished", json!(true)), "notPublished: not a field of this command").await;
    run.accepted("trip.update", update).await;
    let proposal = json!({
        "tripId": "trp_command_types",
        "items": [{"garmentId": OXFORD_BLUE, "name": "Blue oxford", "role": "top", "quantity": 1}],
        "days": [{"localDate": "2026-10-20", "segment": "day", "occasion": null, "slots": [{"role": "top", "garmentId": OXFORD_BLUE}], "reason": ""}],
        "weather": [{"localDate": "2026-10-20", "label": "Lisbon", "freshness": "unavailable", "line": "Weather unavailable"}],
        "notes": ["Proposed by the command-types test"],
    });
    run.refused("trip.record_packing_proposal", with(&proposal, "notPublished", json!(true)), "notPublished: not a field of this command").await;
    run.accepted("trip.record_packing_proposal", proposal).await;
    let pack = json!({"tripId": "trp_command_types", "items": [{"garmentId": OXFORD_BLUE, "quantity": 1}]});
    run.refused("stock.pack", with(&pack, "items", json!([])), "items: at least one item is required").await;
    run.accepted("stock.pack", pack).await;
    let unpack = json!({"tripId": "trp_command_types", "items": [{"garmentId": OXFORD_BLUE, "quantity": 1}]});
    run.refused("stock.unpack", with(&unpack, "tripId", json!("")), "tripId: expected a trip ID").await;
    run.accepted("stock.unpack", unpack).await;
    let cancel = json!({"tripId": "trp_command_types"});
    run.refused("trip.cancel", with(&cancel, "notPublished", json!(true)), "notPublished: not a field of this command").await;
    run.accepted("trip.cancel", cancel).await;

    let terms = json!({"windowDays": 30, "concerns": "post", "triggerEvent": "delivery", "sourceRef": "https://shop.example/returns", "checkedOn": "2026-09-08", "text": "30 days from delivery"});
    let open = json!({
        "caseId": "ret_command_types", "kind": "return", "orderId": null, "lineId": null, "garmentId": NB_OLIVE, "quantity": 1,
        "terms": terms, "triggerDate": "2026-09-05", "timezone": "Europe/London", "nextAction": "Print the label", "collectionPreference": "drop-off",
        "refundExpectedMinor": 12000, "currency": "GBP", "reason": "Too narrow",
    });
    run.refused("return.open_case", with(&open, "orderId", json!("ord_1")), "orders are not ported to this server yet").await;
    run.refused("return.open_case", with(&open, "timezone", json!("America/New_York")), "timezone: this server computes deadlines only in").await;
    run.refused("return.open_case", with(&open, "garmentId", Value::Null), "a return needs the garment").await;
    run.accepted("return.open_case", open).await;
    let update = json!({
        "caseId": "ret_command_types", "state": "posted", "terms": terms, "triggerDate": "2026-09-06", "nextAction": null, "labelRef": "label-1",
        "collectionPreference": null, "shipmentRef": "RM123456789GB", "retailerReceivedOn": "2026-09-08", "refundExpectedMinor": 12000,
        "refundReceivedMinor": 12500, "refundSourceRef": "email from the shop", "currency": "GBP", "note": "Posted at the counter",
    });
    run.refused("return.update_case", with(&update, "state", json!("lost")), "state: expected one of").await;
    run.accepted("return.update_case", update).await;
    // A correction to the refund received may be negative.
    run.accepted("return.update_case", json!({"caseId": "ret_command_types", "refundReceivedMinor": -500})).await;

    // Together the accepted payloads used every published field of every type.
    for t in run.list["types"].as_array().unwrap() {
        let kind = t["type"].as_str().unwrap();
        let used = run.used.get(kind).cloned().unwrap_or_default();
        for field in t["payloadSchema"]["properties"].as_object().unwrap().keys() {
            assert!(used.contains(field), "{kind}.{field} is published but no accepted payload used it");
        }
    }
}
