//! Returns and exchanges through the command path, as the iOS client and a connected assistant send
//! them: `return.open_case` records a case at once with a receipt and an undo that cancels it,
//! `return.update_case` changes it with an undo that puts it back, and `GET /v1/returns` reads the
//! cases back. Nothing leaves the wardrobe. `GET /v1/orders` is empty: purchase import is not ported.
//!
//! The store is an in-memory test double of the APE binding (the same guarded-commit semantics); the
//! garments are the real seed.

use std::collections::BTreeMap;
use std::io;

use ferrite_app::serde_json::{self, json, Value};
use ferrite_app::IngressRequest;
use wardrobe::api::{self, Store, Tokens};
use wardrobe::time::parse_instant;

const OWNER: &str = "owner-token-for-tests";
const ASSISTANT: &str = "assistant-token-for-tests";
const NB_GREY: &str = "gmt_14bc4338d6760f6a13434b2f";
const NB_OLIVE: &str = "gmt_185ccf753d109848f21f7cec";

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

async fn send(store: &mut MemStore, token: &str, method: &str, path: &str, body: Value) -> (u16, Value) {
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

async fn undo(store: &mut MemStore, key: &str, command_id: &Value) -> (u16, Value) {
    command(store, key, "command.undo", json!({"commandId": command_id})).await
}

async fn cases(store: &mut MemStore) -> Vec<Value> {
    let (status, body) = send(store, OWNER, "GET", "/v1/returns", Value::Null).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body.as_object().unwrap().len(), 1, "{body}");
    body["returns"].as_array().unwrap().clone()
}

async fn case(store: &mut MemStore, id: &str) -> Value {
    cases(store).await.into_iter().find(|c| c["caseId"] == id).unwrap_or_else(|| panic!("no case {id}"))
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

async fn receipt_count(store: &mut MemStore) -> usize {
    let (_, body) = send(store, OWNER, "GET", "/v1/commands", Value::Null).await;
    body["receipts"].as_array().map_or(0, Vec::len)
}

fn sourced_terms() -> Value {
    json!({"windowDays": 30, "concerns": "post", "triggerEvent": "delivery", "sourceRef": "https://shop.example/returns", "checkedOn": "2026-10-02"})
}

/// A case opened with sourced terms and the delivery date: its deadline is established.
async fn open_grey(store: &mut MemStore) -> Value {
    let payload = json!({"caseId": "ret_grey", "kind": "return", "garmentId": NB_GREY, "terms": sourced_terms(), "triggerDate": "2026-10-01", "timezone": "Europe/London", "refundExpectedMinor": 12000, "currency": "GBP"});
    let (status, receipt) = command(store, "open-grey-0001", "return.open_case", payload).await;
    assert_eq!(status, 200, "{receipt}");
    receipt
}

#[tokio::test]
async fn a_return_is_opened_at_once_as_the_ios_client_sends_it_and_nothing_leaves_the_wardrobe() {
    let mut store = MemStore::default();
    let untouched = garments(&mut MemStore::default()).await;
    // TripsReturnsModel.open: {kind, garmentId, timezone, reason}.
    let ios = json!({"kind": "return", "garmentId": NB_OLIVE, "timezone": "Europe/London", "reason": "Too narrow"});
    let (status, receipt) = command(&mut store, "open-olive-0001", "return.open_case", ios.clone()).await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(receipt["outcome"], "committed");
    assert_eq!(
        receipt["summary"],
        "Return opened for \u{201c}NB 990v4 \u{2014} olive/cream\u{201d}. Deadline unresolved: the return terms for this purchase have not been found yet. It stays in your wardrobe until it physically leaves"
    );
    let id = receipt["result"]["caseId"].as_str().unwrap().to_string();
    assert!(id.starts_with("ret_") && id.len() == 36, "{id}");
    assert_eq!(receipt["result"]["reminders"], json!([]), "reminders are not ported");
    assert_eq!(receipt["result"]["deadline"]["status"], "unresolved");
    assert_eq!(receipt["affected"], json!([{"kind": "return_case", "id": id, "version": 1}]));
    assert_eq!(receipt["undo"], json!({"available": true, "reason": null}));
    assert_eq!(garments(&mut store).await, untouched, "opening a return removes nothing");

    // A repeat of the same request is the same receipt, not a second case.
    let (status, replay) = command(&mut store, "open-olive-0001", "return.open_case", ios).await;
    assert_eq!((status, replay["commandId"].clone(), replay["replayed"].clone()), (200, receipt["commandId"].clone(), json!(true)));

    let opened = open_grey(&mut store).await;
    assert_eq!(
        opened["summary"],
        "Return opened for \u{201c}NB 990v4 \u{2014} grey\u{201d}. Deadline to post: 2026-10-31 (Europe/London). It stays in your wardrobe until it physically leaves"
    );
    // 30 days from 1 October ends at the end of 31 October, after the clocks went back.
    assert_eq!(
        opened["result"]["deadline"],
        json!({"status": "established", "at": "2026-11-01T00:00:00Z", "localDate": "2026-10-31", "timezone": "Europe/London", "concerns": "post", "reason": null})
    );
    let (status, exchange) = command(&mut store, "open-exchange-0001", "return.open_case", json!({"kind": "exchange", "garmentId": NB_GREY, "timezone": "UTC"})).await;
    assert_eq!(status, 200, "{exchange}");
    assert!(exchange["summary"].as_str().unwrap().starts_with("Exchange opened for \u{201c}NB 990v4 \u{2014} grey\u{201d}"), "{exchange}");

    // The established deadline first, then the newest case (all three opened at the same instant here, so by ID).
    let listed = cases(&mut store).await;
    assert_eq!(listed.len(), 3);
    assert_eq!(listed[0]["caseId"], "ret_grey");
    let olive = listed.iter().find(|c| c["caseId"] == id).unwrap();
    assert_eq!(
        olive,
        &json!({
            "caseId": id, "version": 1, "kind": "return", "state": "considering", "orderId": null, "lineId": null, "garmentId": NB_OLIVE,
            "quantity": 1, "terms": null, "triggerDate": null, "deadline": receipt["result"]["deadline"],
            "nextAction": null, "labelRef": null, "collectionPreference": null, "shipmentRef": null, "retailerReceivedOn": null,
            "refund": {"expectedMinor": null, "receivedMinor": 0, "state": "none", "currency": null},
            "exchangeIncoming": null, "stockDeparted": false, "createdAt": "2026-10-12T09:00:00Z", "updatedAt": "2026-10-12T09:00:00Z",
        })
    );
    assert_eq!(listed[0]["terms"]["text"], Value::Null, "the terms' text defaults to null");
    assert_eq!(listed[0]["refund"], json!({"expectedMinor": 12000, "receivedMinor": 0, "state": "none", "currency": "GBP"}));

    let (status, orders) = send(&mut store, OWNER, "GET", "/v1/orders", Value::Null).await;
    assert_eq!((status, orders), (200, json!({"orders": []})));
}

#[tokio::test]
async fn undoing_an_opening_cancels_the_case_only_while_it_is_as_it_was_opened() {
    let mut store = MemStore::default();
    let opened = open_grey(&mut store).await;
    let (status, undone) = undo(&mut store, "undo-open-0001", &opened["commandId"]).await;
    assert_eq!(status, 200, "{undone}");
    assert_eq!(
        undone["summary"],
        "Undone: Return opened for \u{201c}NB 990v4 \u{2014} grey\u{201d}. Deadline to post: 2026-10-31 (Europe/London). It stays in your wardrobe until it physically leaves. Return cancelled; the item stays as it was"
    );
    assert_eq!(undone["affected"], json!([{"kind": "return_case", "id": "ret_grey", "version": 2}]));
    assert_eq!(undone["undo"]["available"], false);
    let c = case(&mut store, "ret_grey").await;
    assert_eq!((c["state"].clone(), c["version"].clone()), (json!("cancelled"), json!(2)));
    let (status, again) = undo(&mut store, "undo-open-0002", &opened["commandId"]).await;
    assert_eq!(status, 409, "{again}");

    // Once a case has been updated, undoing its opening is refused: an update corrects it instead.
    let (_, opened) = command(&mut store, "open-olive-0001", "return.open_case", json!({"caseId": "ret_olive", "kind": "return", "garmentId": NB_OLIVE})).await;
    let (status, _) = command(&mut store, "update-olive-0001", "return.update_case", json!({"caseId": "ret_olive", "state": "requested"})).await;
    assert_eq!(status, 200);
    let (status, refused) = undo(&mut store, "undo-open-0003", &opened["commandId"]).await;
    assert_eq!((status, error(&refused)), (409, (json!("not_undoable"), "the return has been updated since it was opened; update it to cancel it instead".into())));
    assert_eq!(case(&mut store, "ret_olive").await["state"], "requested");
}

#[tokio::test]
async fn an_update_applies_at_once_checks_the_version_the_client_saw_and_undo_puts_the_case_back() {
    let mut store = MemStore::default();
    open_grey(&mut store).await;
    // TripsReturnsModel.update: {caseId, state, shipmentRef} at the version the client read.
    let posted = json!({"caseId": "ret_grey", "state": "posted", "shipmentRef": "RM123456789GB"});
    let (status, receipt) = command_with(&mut store, "post-grey-0001", "return.update_case", posted.clone(), json!({"return_case:ret_grey": 1})).await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(receipt["summary"], "\u{201c}NB 990v4 \u{2014} grey\u{201d}: Marked as posted. Shipment recorded.");
    assert_eq!(receipt["result"]["state"], "posted");
    assert_eq!(receipt["result"]["refund"], json!({"expectedMinor": 12000, "receivedMinor": 0, "state": "none"}));
    assert_eq!(receipt["undo"]["available"], true);
    let c = case(&mut store, "ret_grey").await;
    assert_eq!((c["version"].clone(), c["shipmentRef"].clone()), (json!(2), json!("RM123456789GB")));

    // A client that read version 1 is told it changed; a case that does not exist never matches.
    let (status, stale) = command_with(&mut store, "post-grey-0002", "return.update_case", json!({"caseId": "ret_grey", "state": "closed"}), json!({"return_case:ret_grey": 1})).await;
    assert_eq!((status, error(&stale).0), (409, json!("conflict")), "{stale}");
    let (status, absent) = command_with(&mut store, "post-grey-0003", "return.update_case", json!({"caseId": "ret_none", "state": "closed"}), json!({"return_case:ret_none": 1})).await;
    assert_eq!((status, error(&absent).0), (409, json!("conflict")), "{absent}");

    // A refund in full completes a return; a correction may be negative, but the total never goes below zero.
    let (status, refunded) = command(&mut store, "refund-grey-0001", "return.update_case", json!({"caseId": "ret_grey", "refundReceivedMinor": 12000, "refundSourceRef": "email from the shop"})).await;
    assert_eq!(status, 200, "{refunded}");
    assert_eq!(refunded["summary"], "\u{201c}NB 990v4 \u{2014} grey\u{201d}: Refund complete. Refund received so far GBP 120.00 of GBP 120.00 expected (full).");
    assert_eq!(refunded["result"]["state"], "refunded");
    let (status, corrected) = command(&mut store, "refund-grey-0002", "return.update_case", json!({"caseId": "ret_grey", "refundReceivedMinor": -2000})).await;
    assert_eq!(status, 200, "{corrected}");
    assert_eq!(corrected["summary"], "\u{201c}NB 990v4 \u{2014} grey\u{201d}: Refund received so far GBP 100.00 of GBP 120.00 expected (partial).");
    assert_eq!(case(&mut store, "ret_grey").await["refund"], json!({"expectedMinor": 12000, "receivedMinor": 10000, "state": "partial", "currency": "GBP"}));
    let before = receipt_count(&mut store).await;
    let (status, below) = command(&mut store, "refund-grey-0003", "return.update_case", json!({"caseId": "ret_grey", "refundReceivedMinor": -10001})).await;
    assert_eq!((status, error(&below)), (409, (json!("precondition_failed"), "a refund total cannot go below zero".into())));
    assert_eq!(receipt_count(&mut store).await, before, "nothing was written");

    // Undo of the correction puts the refund back exactly as it was.
    let (status, undone) = undo(&mut store, "undo-refund-0001", &corrected["commandId"]).await;
    assert_eq!(status, 200, "{undone}");
    let text = undone["summary"].as_str().unwrap();
    assert!(text.starts_with("Undone: \u{201c}NB 990v4 \u{2014} grey\u{201d}: Refund received so far GBP 100.00"), "{text}");
    assert!(text.ends_with("\u{201c}NB 990v4 \u{2014} grey\u{201d}: the return is back to how it was before that update (Refund complete)"), "{text}");
    assert_eq!(undone["undo"]["available"], false);
    let c = case(&mut store, "ret_grey").await;
    assert_eq!((c["version"].clone(), c["state"].clone(), c["refund"]["receivedMinor"].clone()), (json!(5), json!("refunded"), json!(12000)));
    assert_eq!(c["shipmentRef"], "RM123456789GB", "earlier updates stay");

    // An earlier update can no longer be undone: the case has moved on since.
    let (status, refused) = undo(&mut store, "undo-post-0001", &receipt["commandId"]).await;
    assert_eq!((status, error(&refused)), (409, (json!("not_undoable"), "the return has been updated again since; update it once more to correct it".into())));

    // New terms or a new trigger date recompute the deadline, in the case's own timezone.
    let (status, moved) = command(&mut store, "terms-grey-0001", "return.update_case", json!({"caseId": "ret_grey", "triggerDate": "2026-09-01"})).await;
    assert_eq!(status, 200, "{moved}");
    assert_eq!(moved["summary"], "\u{201c}NB 990v4 \u{2014} grey\u{201d}: Deadline to post: 2026-10-01 (Europe/London).");
    assert_eq!(moved["result"]["deadline"]["at"], "2026-10-01T23:00:00Z");
}

#[tokio::test]
async fn what_this_server_cannot_do_is_refused_by_name_and_nothing_is_written() {
    let mut store = MemStore::default();
    open_grey(&mut store).await;
    let before = receipt_count(&mut store).await;
    let base = json!({"kind": "return", "garmentId": NB_OLIVE});
    let with = |k: &str, v: Value| {
        let mut p = base.clone();
        p[k] = v;
        p
    };
    let refusals = [
        (with("orderId", json!("ord_1")), 400, "orderId: orders are not ported to this server yet; open the return for the garment"),
        (with("timezone", json!("America/New_York")), 400, "timezone: this server computes deadlines only in Europe/London and UTC"),
        (with("garmentId", Value::Null), 400, "a return needs the garment or the order line it concerns"),
        (with("garmentId", json!("gmt_invented")), 404, "no garment 'gmt_invented' in this wardrobe; nothing was written"),
        (with("caseId", json!("ret grey")), 400, "a return ID on this server may contain only letters, digits"),
        (with("caseId", json!("ret_grey")), 409, "there is already a return 'ret_grey'; nothing was written"),
        (with("kind", json!("refund")), 400, "kind: expected one of return, exchange"),
        (with("quantity", json!(0)), 400, "quantity: expected a whole number from 1 to 999"),
        (with("terms", json!({"windowDays": 30, "concerns": "post", "triggerEvent": "delivery", "checkedOn": "2026-10-02"})), 400, "terms.sourceRef"),
        (with("refundExpectedMinor", json!(12.5)), 400, "numbers in a command must be whole numbers"),
    ];
    for (n, (payload, status, says)) in refusals.into_iter().enumerate() {
        let (got, body) = command(&mut store, &format!("refused-open-{n:04}"), "return.open_case", payload.clone()).await;
        assert_eq!(got, status, "{payload}: {body}");
        assert!(said(&body).contains(says), "{payload}: expected '{says}' in {body}");
    }
    for (n, (payload, status, says)) in [
        (json!({"caseId": "ret_none", "state": "posted"}), 404, "no return 'ret_none'; nothing was written"),
        (json!({"caseId": "ret_grey", "state": "lost"}), 400, "state: expected one of"),
        (json!({"caseId": "ret_grey", "orderId": "ord_1"}), 400, "orderId"),
    ]
    .into_iter()
    .enumerate()
    {
        let (got, body) = command(&mut store, &format!("refused-update-{n:04}"), "return.update_case", payload.clone()).await;
        assert_eq!(got, status, "{payload}: {body}");
        assert!(said(&body).contains(says), "{payload}: expected '{says}' in {body}");
    }
    assert_eq!(receipt_count(&mut store).await, before, "no refusal wrote anything");
    assert_eq!(cases(&mut store).await.len(), 1);
}

#[tokio::test]
async fn a_connected_assistant_relays_a_return_and_reads_the_cases_but_cannot_tap() {
    let mut store = MemStore::default();
    let relayed = json!({
        "type": "return.open_case", "payload": {"caseId": "ret_relayed", "kind": "return", "garmentId": NB_OLIVE, "reason": "He said they pinch"},
        "idempotencyKey": "assistant-return-0001", "authorization": "owner_statement", "source": {"channel": "mcp"},
    });
    let receipt = api::execute(&mut store, api::ASSISTANT, now(), &relayed).await.unwrap();
    assert_eq!((receipt["outcome"].clone(), receipt["actor"].clone(), receipt["undo"]["available"].clone()), (json!("committed"), json!("assistant"), json!(true)));
    let mut tap = relayed.clone();
    tap["authorization"] = json!("owner_tap");
    tap["idempotencyKey"] = json!("assistant-return-0002");
    assert_eq!(api::execute(&mut store, api::ASSISTANT, now(), &tap).await.unwrap_err().code, "forbidden");
    let update = json!({
        "type": "return.update_case", "payload": {"caseId": "ret_relayed", "state": "requested"}, "expectedVersions": {"return_case:ret_relayed": 1},
        "idempotencyKey": "assistant-return-0003", "authorization": "owner_statement", "source": {"channel": "mcp"},
    });
    let updated = api::execute(&mut store, api::ASSISTANT, now(), &update).await.unwrap();
    assert_eq!(updated["summary"], "\u{201c}NB 990v4 \u{2014} olive/cream\u{201d}: Return requested. It is still in your wardrobe until it physically leaves");
    // The assistant can take back what it relayed.
    let undo = json!({"type": "command.undo", "payload": {"commandId": updated["commandId"]}, "idempotencyKey": "assistant-return-0004", "authorization": "owner_statement", "source": {"channel": "mcp"}});
    assert_eq!(api::execute(&mut store, api::ASSISTANT, now(), &undo).await.unwrap()["outcome"], "committed");
    let (status, listed) = send(&mut store, ASSISTANT, "GET", "/v1/returns", Value::Null).await;
    assert_eq!((status, listed["returns"][0]["state"].clone(), listed["returns"][0]["version"].clone()), (200, json!("considering"), json!(3)));
}
