//! The app routes the iOS client calls on Today and at launch, through `api::handle` as the client
//! sends them: `/v1/meta`, the offline replay `/v1/commands/batch`, `/v1/recommendations` in preview
//! and board mode, and `/v1/boards/{id}/swap`. Each change is the same command, receipt and undo as
//! `POST /v1/commands` runs; a retransmission answers from what was recorded and changes nothing.
//!
//! The store is an in-memory test double of the APE binding (the same guarded-commit semantics);
//! the garments are the real seed.

use std::collections::BTreeMap;
use std::io;

use ferrite_app::serde_json::{self, json, Value};
use ferrite_app::IngressRequest;
use wardrobe::api::{self, Store, Tokens};

const ORIGIN: &str = "http://127.0.0.1:8787";
const OWNER: &str = "owner-token-for-tests";
const ASSISTANT: &str = "assistant-token-for-tests";
const T0: u64 = 1_789_000_000_000; // 2026-09-10T00:26:40Z
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

fn tokens(origin: Option<&str>) -> Tokens {
    Tokens { owner: Some(OWNER.into()), assistant: Some(ASSISTANT.into()), public_origin: origin.map(str::to_string), ..Default::default() }
}

async fn send(store: &mut MemStore, token: &str, method: &str, path: &str, body: Value) -> (u16, Value) {
    let bytes = if body.is_null() { Vec::new() } else { serde_json::to_vec(&body).unwrap() };
    let mut req = IngressRequest::new(method, path, bytes);
    req.headers = vec![("authorization".into(), format!("Bearer {token}"))];
    let reply = api::handle(store, &tokens(Some(ORIGIN)), T0, &req).await;
    let (_, bytes) = reply.content();
    (reply.status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn raw(store: &mut MemStore, method: &str, path: &str, body: &[u8]) -> (u16, Value) {
    let mut req = IngressRequest::new(method, path, body.to_vec());
    req.headers = vec![("authorization".into(), format!("Bearer {OWNER}"))];
    let reply = api::handle(store, &tokens(Some(ORIGIN)), T0, &req).await;
    let (_, bytes) = reply.content();
    (reply.status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn command(kind: &str, payload: Value, key: &str) -> Value {
    json!({"type": kind, "payload": payload, "idempotencyKey": key, "authorization": "owner_tap", "source": {"channel": "ios"}})
}

fn top_of(option: &Value) -> String {
    option["garments"].as_array().unwrap().iter().find(|g| g["role"] == "top").unwrap()["garmentId"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn meta_names_versions_modules_and_the_mcp_endpoint() {
    let mut store = MemStore::default();
    let (status, meta) = send(&mut store, OWNER, "GET", "/v1/meta", Value::Null).await;
    assert_eq!(status, 200, "{meta}");
    assert_eq!((meta["apiVersion"].clone(), meta["contractVersion"].clone()), (json!("v1"), json!(api::CONTRACT_VERSION)));
    assert_eq!(meta["serverTime"], "2026-09-10T00:26:40Z");
    assert_eq!(meta["mcp"]["endpoint"], format!("{ORIGIN}/mcp"));
    assert_eq!(meta["mcp"]["authorizationServer"], ORIGIN);
    let media = meta["modules"].as_array().unwrap().iter().find(|m| m["name"] == "media").unwrap().clone();
    assert_eq!(media["mounted"], false, "media is not ported, and meta says so");
    // Signed in or not at all.
    let mut req = IngressRequest::new("GET", "/v1/meta", Vec::new());
    req.headers = vec![];
    assert_eq!(api::handle(&mut store, &tokens(Some(ORIGIN)), T0, &req).await.status, 401);
    // Without a valid public origin the MCP endpoint cannot be named: refused by the secret's name.
    for origin in [None, Some("not-an-origin"), Some("http://example.com")] {
        req.headers = vec![("authorization".into(), format!("Bearer {OWNER}"))];
        let reply = api::handle(&mut store, &tokens(origin), T0, &req).await;
        let (_, bytes) = reply.content();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(reply.status, 500, "{origin:?}");
        assert!(body["error"]["message"].as_str().unwrap().contains("WARDROBE_PUBLIC_ORIGIN"), "{body}");
    }
}

#[tokio::test]
async fn an_offline_replay_applies_each_command_independently_and_once() {
    let mut store = MemStore::default();
    let (_, page) = send(&mut store, OWNER, "GET", "/v1/wardrobe", Value::Null).await;
    let shirt = page["items"].as_array().unwrap().iter().find(|i| i["careChannel"] == "service" && i["quantity"] == 1).unwrap()["garmentId"].as_str().unwrap().to_string();
    let queued = json!({"commands": [
        command("care.mark_dirty", json!({"items": [{"garmentId": shirt}]}), "offline-0001"),
        command("care.mark_dirty", json!({"items": [{"garmentId": "gmt_not_a_garment"}]}), "offline-0002"),
        json!("not an envelope"),
        command("care.washed", json!({"items": [{"garmentId": shirt}]}), "offline-0003"),
    ]});
    let (status, out) = send(&mut store, OWNER, "POST", "/v1/commands/batch", queued.clone()).await;
    assert_eq!(status, 200, "{out}");
    let results = out["results"].as_array().unwrap();
    assert_eq!(results.len(), 4);
    assert_eq!((results[0]["status"].clone(), results[0]["idempotencyKey"].clone(), results[0]["receipt"]["outcome"].clone()), (json!("receipt"), json!("offline-0001"), json!("committed")));
    // A refusal is final and does not stop the commands after it.
    assert_eq!((results[1]["status"].clone(), results[1]["error"]["code"].clone(), results[1]["retryable"].clone()), (json!("error"), json!("not_found"), json!(false)));
    assert_eq!((results[2]["status"].clone(), results[2]["error"]["code"].clone(), results[2]["idempotencyKey"].clone()), (json!("error"), json!("invalid_command"), json!("")));
    assert_eq!(results[3]["receipt"]["type"], "care.washed");
    assert_eq!(out["wardrobeRevision"], 2);

    // The same replay again (the phone never saw the answer) applies nothing twice.
    let (_, again) = send(&mut store, OWNER, "POST", "/v1/commands/batch", queued).await;
    let again = again["results"].as_array().unwrap().clone();
    assert_eq!((again[0]["receipt"]["replayed"].clone(), again[0]["receipt"]["commandId"].clone()), (json!(true), results[0]["receipt"]["commandId"].clone()));
    assert_eq!(again[3]["receipt"]["replayed"], true);
    let (_, page) = send(&mut store, OWNER, "GET", "/v1/wardrobe", Value::Null).await;
    assert_eq!(page["wardrobeRevision"], 2);

    // A connected assistant replays under its own authorization rules: it cannot claim a tap.
    let (_, tapped) = send(&mut store, ASSISTANT, "POST", "/v1/commands/batch", json!({"commands": [command("care.mark_dirty", json!({"items": [{"garmentId": shirt}]}), "assistant-0001")]})).await;
    assert_eq!(tapped["results"][0]["error"]["code"], "forbidden");

    // The batch itself must be well formed; nothing is written when it is not.
    let before = store.clone();
    let too_many: Vec<Value> = (0..51).map(|i| command("care.mark_dirty", json!({"items": [{"garmentId": shirt}]}), &format!("offline-1{i:03}"))).collect();
    for (body, what) in [(json!({"commands": []}), "empty"), (json!({"commands": too_many}), "51 commands"), (json!({"commands": [], "extra": 1}), "an extra field"), (json!([1]), "not an object")] {
        let (status, e) = send(&mut store, OWNER, "POST", "/v1/commands/batch", body).await;
        assert_eq!((status, e["error"]["code"].clone()), (400, json!("invalid_command")), "{what}");
    }
    assert_eq!(raw(&mut store, "POST", "/v1/commands/batch", b"{not json").await.0, 400);
    assert!(store.data == before.data, "refused batches write nothing");
}

#[tokio::test]
async fn a_preview_recommends_without_publishing_and_board_mode_publishes_once() {
    let mut store = MemStore::default();
    let (status, preview) = send(&mut store, OWNER, "POST", "/v1/recommendations", json!({"clientRequestId": "recommend-0001", "date": DAY, "count": 2, "mode": "preview", "lockedGarmentIds": [], "occasionOnly": false})).await;
    assert_eq!(status, 200, "{preview}");
    assert_eq!((preview["state"].clone(), preview["board"].clone(), preview["options"].as_array().unwrap().len()), (json!("completed"), Value::Null, 2));
    let (_, today) = send(&mut store, OWNER, "GET", &format!("/v1/today?date={DAY}"), Value::Null).await;
    assert_eq!(today["board"], Value::Null, "a preview publishes nothing");

    // "Prepare today's board": the options are published as the day's board, with a receipt.
    let ask = json!({"clientRequestId": "compose-00001", "date": DAY, "mode": "board"});
    let (status, made) = send(&mut store, OWNER, "POST", "/v1/recommendations", ask.clone()).await;
    assert_eq!(status, 200, "{made}");
    let board = made["board"].clone();
    assert_eq!((board["localDate"].clone(), board["revision"].clone()), (json!(DAY), json!(1)));
    assert_eq!(made["options"], board["options"]);
    assert_eq!(made["wardrobeRevision"], 1);
    let (_, today) = send(&mut store, OWNER, "GET", &format!("/v1/today?date={DAY}"), Value::Null).await;
    assert_eq!(today["board"]["boardId"], board["boardId"]);
    let (_, receipts) = send(&mut store, OWNER, "GET", "/v1/commands", Value::Null).await;
    let publish = receipts["receipts"][0].clone();
    assert_eq!((publish["type"].clone(), publish["actor"].clone(), publish["outcome"].clone()), (json!("board.publish"), json!("owner"), json!("committed")));

    // The same request again answers from what was recorded: no second composition, no new revision.
    let (_, again) = send(&mut store, OWNER, "POST", "/v1/recommendations", ask).await;
    assert_eq!((again["board"]["boardId"].clone(), again["board"]["revision"].clone()), (board["boardId"].clone(), json!(1)));
    let (_, receipts) = send(&mut store, OWNER, "GET", "/v1/commands", Value::Null).await;
    assert_eq!(receipts["receipts"].as_array().unwrap().len(), 1);

    // What is not ported is refused by name, never ignored, and writes nothing.
    let before = store.clone();
    for (body, what) in [
        (json!({"clientRequestId": "recommend-0002", "date": DAY, "lockedGarmentIds": ["gmt_x"]}), "lockedGarmentIds"),
        (json!({"clientRequestId": "recommend-0003", "date": DAY, "occasionOnly": true}), "occasionOnly"),
        (json!({"clientRequestId": "recommend-0004", "date": DAY, "mode": "evening"}), "mode"),
        (json!({"clientRequestId": "recommend-0005"}), "date"),
        (json!({"clientRequestId": "recommend-0006", "date": DAY, "owner": "x"}), "owner"),
    ] {
        let (status, e) = send(&mut store, OWNER, "POST", "/v1/recommendations", body).await;
        assert_eq!((status, e["error"]["code"].clone()), (400, json!("invalid_command")), "{what}: {e}");
        assert!(e["error"]["message"].as_str().unwrap().contains(what), "{what}: {e}");
    }
    assert!(store.data == before.data);
}

#[tokio::test]
async fn the_launch_reads_say_what_this_server_holds() {
    let mut store = MemStore::default();
    let (status, me) = send(&mut store, OWNER, "GET", "/v1/me", Value::Null).await;
    assert_eq!(status, 200);
    assert_eq!((me["userId"].clone(), me["channel"].clone(), me["identities"].clone()), (json!("owner"), json!("ios"), json!([])));
    assert_eq!(me["recoveryKit"], json!({"present": false, "issuedAt": null}));
    let (_, as_assistant) = send(&mut store, ASSISTANT, "GET", "/v1/me", Value::Null).await;
    assert_eq!(as_assistant["channel"], "mcp");

    let (_, service) = send(&mut store, OWNER, "GET", "/v1/service", Value::Null).await;
    assert_eq!(service, json!({"paused": false, "pause": null, "returnDeadlinesActive": true}));

    let (status, settings) = send(&mut store, OWNER, "GET", "/v1/settings", Value::Null).await;
    assert_eq!(status, 200, "{settings}");
    assert_eq!((settings["version"].clone(), settings["profile"].clone(), settings["inference"].clone()), (json!(1), Value::Null, Value::Null));
    assert_eq!(settings["service"], service);
    assert_eq!(settings["settings"]["laundry"]["handwash"], json!({"mode": "owner_reported"}));
    let count = settings["settings"]["delivery"]["defaultOptionCount"].as_u64().unwrap();
    assert!((3..=5).contains(&count));
    // The count shown is the count a recommendation without one composes.
    let (_, rec) = send(&mut store, OWNER, "POST", "/v1/recommendations", json!({"clientRequestId": "recommend-0100", "date": DAY})).await;
    assert_eq!(rec["options"].as_array().unwrap().len() as u64, count, "{rec}");
}

#[tokio::test]
async fn laundry_shows_the_hamper_by_channel_and_the_bags_as_the_ledger_has_them() {
    let mut store = MemStore::default();
    let (_, empty) = send(&mut store, OWNER, "GET", "/v1/laundry", Value::Null).await;
    assert_eq!((empty["awaitingService"].clone(), empty["awaitingHandwash"].clone(), empty["batches"].clone()), (json!([]), json!([]), json!([])));
    assert_eq!((empty["exceptions"].clone(), empty["cycles"].clone(), empty["readAt"].clone()), (json!([]), json!([]), json!("2026-09-10T00:26:40Z")));

    let (_, page) = send(&mut store, OWNER, "GET", "/v1/wardrobe", Value::Null).await;
    let items = page["items"].as_array().unwrap();
    let pick = |channel: &str| items.iter().find(|i| i["careChannel"] == channel && i["quantity"].as_u64().unwrap() >= 2).unwrap()["garmentId"].as_str().unwrap().to_string();
    let (shirt, sock) = (pick("service"), pick("handwash"));
    send(&mut store, OWNER, "POST", "/v1/commands", command("care.mark_dirty", json!({"items": [{"garmentId": shirt, "quantity": 2}, {"garmentId": sock}]}), "dirty-0001")).await;
    let (_, l) = send(&mut store, OWNER, "GET", "/v1/laundry", Value::Null).await;
    assert_eq!(l["awaitingService"].as_array().unwrap().iter().map(|x| (x["garmentId"].clone(), x["quantity"].clone())).collect::<Vec<_>>(), vec![(json!(shirt), json!(2))]);
    assert_eq!(l["awaitingHandwash"][0]["garmentId"], sock);
    assert!(l["awaitingService"][0]["name"].as_str().map_or(false, |n| !n.is_empty()));

    // The laundry takes the bag: the hamper empties into it, and the bag is listed.
    let (status, c) = send(&mut store, OWNER, "POST", "/v1/commands", command("laundry.collect", json!({}), "collect-0001")).await;
    assert_eq!(status, 200, "{c}");
    let (_, l) = send(&mut store, OWNER, "GET", "/v1/laundry", Value::Null).await;
    assert_eq!(l["awaitingService"], json!([]));
    let bag = l["batches"][0].clone();
    assert_eq!((bag["status"].clone(), bag["returnedAt"].clone(), bag["returnBasis"].clone()), (json!("collected"), Value::Null, Value::Null));
    assert_eq!((bag["items"][0]["garmentId"].clone(), bag["items"][0]["quantity"].clone(), bag["items"][0]["stillAway"].clone()), (json!(shirt), json!(2), json!(0)));

    // An undone pickup is withdrawn and no longer listed, as in the TypeScript service.
    send(&mut store, OWNER, "POST", "/v1/commands", command("command.undo", json!({"commandId": c["commandId"]}), "undo-collect-01")).await;
    let (_, l) = send(&mut store, OWNER, "GET", "/v1/laundry", Value::Null).await;
    assert_eq!(l["batches"], json!([]));
    assert_eq!(l["awaitingService"][0]["quantity"], 2);
}

#[tokio::test]
async fn a_swap_changes_one_slot_with_a_receipt_and_answers_the_board_as_it_now_stands() {
    let mut store = MemStore::default();
    let (_, made) = send(&mut store, OWNER, "POST", "/v1/recommendations", json!({"clientRequestId": "compose-00001", "date": DAY, "count": 3, "mode": "board"})).await;
    let board = made["board"].clone();
    let board_id = board["boardId"].as_str().unwrap().to_string();
    let first = board["options"][0].clone();
    let option_id = first["optionId"].as_str().unwrap().to_string();
    let before_top = top_of(&first);

    let ask = json!({"clientRequestId": "swap-00000001", "optionId": option_id, "role": "top", "expectedRevision": 1});
    let (status, swapped) = send(&mut store, OWNER, "POST", &format!("/v1/boards/{board_id}/swap"), ask.clone()).await;
    assert_eq!(status, 200, "{swapped}");
    assert_eq!((swapped["receipt"]["type"].clone(), swapped["receipt"]["outcome"].clone()), (json!("board.swap_slot"), json!("committed")));
    assert_eq!(swapped["board"]["revision"], 2);
    let now = swapped["board"]["options"].as_array().unwrap().iter().find(|o| o["optionId"] == option_id.as_str()).unwrap().clone();
    assert_ne!(top_of(&now), before_top, "the shirt changed");
    assert_eq!(swapped["receipt"]["result"]["replacedGarmentId"], before_top);

    // A retransmission answers from the receipt; the board does not move again.
    let (_, again) = send(&mut store, OWNER, "POST", &format!("/v1/boards/{board_id}/swap"), ask).await;
    assert_eq!((again["receipt"]["replayed"].clone(), again["board"]["revision"].clone()), (json!(true), json!(2)));

    // The owner was looking at revision 1, which is gone: a clean conflict, nothing changed.
    let before = store.clone();
    let (status, stale) = send(&mut store, OWNER, "POST", &format!("/v1/boards/{board_id}/swap"), json!({"clientRequestId": "swap-00000002", "optionId": option_id, "role": "top", "expectedRevision": 1})).await;
    assert_eq!((status, stale["error"]["code"].clone()), (409, json!("conflict")), "{stale}");
    // Malformed requests and unknown boards change nothing either.
    for (path, body, code) in [
        (format!("/v1/boards/{board_id}/swap"), json!({"clientRequestId": "short", "optionId": option_id, "role": "top"}), "invalid_command"),
        (format!("/v1/boards/{board_id}/swap"), json!({"clientRequestId": "swap-00000003", "optionId": option_id, "role": "top", "expectedRevision": 0}), "invalid_command"),
        (format!("/v1/boards/{board_id}/swap"), json!({"clientRequestId": "swap-00000004", "optionId": option_id, "role": "top", "note": "x"}), "invalid_command"),
        ("/v1/boards/brd_unknown/swap".to_string(), json!({"clientRequestId": "swap-00000005", "optionId": option_id, "role": "top"}), "not_found"),
    ] {
        let (_, e) = send(&mut store, OWNER, "POST", &path, body).await;
        assert_eq!(e["error"]["code"], code, "{e}");
    }
    assert!(store.data == before.data, "refused swaps write nothing");

    // The swap undoes like any command.
    let (status, undo) = send(&mut store, OWNER, "POST", "/v1/commands", command("command.undo", json!({"commandId": swapped["receipt"]["commandId"]}), "undo-swap-0001")).await;
    assert_eq!(status, 200, "{undo}");
    let (_, today) = send(&mut store, OWNER, "GET", &format!("/v1/today?date={DAY}"), Value::Null).await;
    let restored = today["board"]["options"].as_array().unwrap().iter().find(|o| o["optionId"] == option_id.as_str()).unwrap().clone();
    assert_eq!(top_of(&restored), before_top);
}
