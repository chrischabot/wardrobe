//! Studio's suggestions (`POST /v1/studio/suggest`, `suggestStudioOutfits` over the daily service's
//! `suggestOutfits`): outfits composed around the pieces the owner locked, each keeping every locked
//! piece in its role, trimmed to the roles the owner is working on, validated as `studio/validate`
//! validates, and offered only when valid. Nothing is written.
//!
//! The store is an in-memory test double of the APE binding (the same guarded-commit semantics); the
//! garments and rules are the real seed. No model or forecast is involved.

use std::collections::{BTreeMap, BTreeSet};
use std::io;

use ferrite_app::serde_json::{self, json, Value};
use ferrite_app::IngressRequest;
use wardrobe::api::{self, Store, Tokens};
use wardrobe::time::parse_instant;

const OWNER: &str = "owner-token-for-tests";
const ASSISTANT: &str = "assistant-token-for-tests";

const SHIRT: &str = "gmt_3894b6a6295908d5e687af4f"; // Lightweight oxford, blue
const TROUSERS: &str = "gmt_0bd82c642c7606199361d3d4"; // Akita slub 5-pocket, cream
const SNEAKERS: &str = "gmt_14bc4338d6760f6a13434b2f"; // NB 990v4 grey, never laundered
const REIMS: &str = "gmt_a8fe5fe3a6c0754361249bf8"; // Paraboot Reims, welted: under the sneakers-only restriction
const BELT_BROWN: &str = "gmt_6335e17bcb19fb15f77c31bf";
const TIE_NAVY: &str = "gmt_5ee75031c78621c039354b2e"; // Silk knit tie, navy
const SOCK_GREY: &str = "gmt_67d3228f744d17138e400729";

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

fn now() -> u64 {
    parse_instant("2026-09-10T23:30:00Z").unwrap() // the owner's 2026-09-11 in London
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

async fn suggest(store: &mut MemStore, body: Value) -> Vec<Value> {
    let (status, r) = send(store, OWNER, "POST", "/v1/studio/suggest", body).await;
    assert_eq!(status, 200, "{r}");
    r["suggestions"].as_array().unwrap().clone()
}

fn locked(role: &str, id: &str) -> Value {
    json!({"role": role, "garmentId": id, "locked": true})
}

fn roles(s: &Value) -> BTreeSet<String> {
    s["slots"].as_array().unwrap().iter().map(|x| x["role"].as_str().unwrap().to_string()).collect()
}

fn piece(s: &Value, role: &str) -> Option<Value> {
    s["slots"].as_array().unwrap().iter().find(|x| x["role"] == role).cloned()
}

#[tokio::test]
async fn suggestions_keep_the_locked_shirt_and_fill_the_open_roles_with_valid_outfits() {
    let mut store = MemStore::default();
    let list = suggest(&mut store, json!({"slots": [locked("top", SHIRT)]})).await;
    assert!(!list.is_empty() && list.len() <= 5, "five at most by default: {}", list.len());
    let mut seen = BTreeSet::new();
    for s in &list {
        // The locked shirt comes back exactly as given, in every suggestion.
        assert_eq!(piece(s, "top"), Some(json!({"role": "top", "garmentId": SHIRT, "shoppingCandidate": null, "locked": true})), "{s}");
        // Only the roles being worked on (top, bottom, footwear) and socks; nothing else is locked.
        assert_eq!(roles(s), ["bottom", "footwear", "socks", "top"].iter().map(|r| r.to_string()).collect::<BTreeSet<_>>(), "{s}");
        assert!(s["slots"].as_array().unwrap().iter().filter(|x| x["role"] != "top").all(|x| x["locked"] == false), "{s}");
        // Each is valid for the day, by the same validator as studio/validate, with a factual reason.
        assert_eq!((s["validation"]["valid"].clone(), s["validation"]["wearableOn"].clone(), s["validation"]["validator"].clone()), (json!(true), json!("2026-09-11"), json!("daily-service")), "{s}");
        assert!(!s["reason"].as_str().unwrap().is_empty());
        let (status, v) = send(&mut store, OWNER, "POST", "/v1/studio/validate", json!({"slots": s["slots"]})).await;
        assert_eq!((status, v["valid"].clone()), (200, json!(true)), "{v}");
        // Suggestions that would coincide once trimmed are one.
        assert!(seen.insert(s["slots"].to_string()), "a suggestion offered twice: {s}");
    }
    // A limit caps the count; nothing was written.
    assert_eq!(suggest(&mut store, json!({"slots": [locked("top", SHIRT)], "limit": 2})).await.len(), 2);
    assert!(store.data.is_empty(), "suggesting wrote nothing");
}

#[tokio::test]
async fn locked_trousers_and_shoes_stay_and_the_shirts_differ() {
    let mut store = MemStore::default();
    let list = suggest(&mut store, json!({"slots": [locked("bottom", TROUSERS), locked("footwear", SNEAKERS), {"role": "belt", "garmentId": BELT_BROWN, "locked": false}]})).await;
    assert!(list.len() >= 2, "{list:?}");
    let mut shirts = BTreeSet::new();
    for s in &list {
        assert_eq!(piece(s, "bottom").map(|x| (x["garmentId"].clone(), x["locked"].clone())), Some((json!(TROUSERS), json!(true))), "{s}");
        assert_eq!(piece(s, "footwear").map(|x| (x["garmentId"].clone(), x["locked"].clone())), Some((json!(SNEAKERS), json!(true))), "{s}");
        // The unlocked belt slot makes the belt a role being worked on, so the composer's belt is kept.
        assert!(roles(s).contains("belt"), "{s}");
        assert!(shirts.insert(piece(s, "top").unwrap()["garmentId"].to_string()), "the same shirt twice: {s}");
    }
}

#[tokio::test]
async fn with_top_bottom_and_shoes_locked_suggestions_hold_only_those_and_socks_and_never_repeat() {
    let mut store = MemStore::default();
    let list = suggest(&mut store, json!({"slots": [locked("top", SHIRT), locked("bottom", TROUSERS), locked("footwear", SNEAKERS)]})).await;
    assert!(!list.is_empty(), "the locked outfit itself is wearable today");
    let allowed: BTreeSet<String> = ["bottom", "footwear", "socks", "top"].iter().map(|r| r.to_string()).collect();
    let mut seen = BTreeSet::new();
    for s in &list {
        // No role is open, yet nothing the owner did not ask for (outer, belt, neckwear) is kept.
        assert!(roles(s).is_subset(&allowed), "{s}");
        for (role, id) in [("top", SHIRT), ("bottom", TROUSERS), ("footwear", SNEAKERS)] {
            assert_eq!(piece(s, role).map(|x| (x["garmentId"].clone(), x["locked"].clone())), Some((json!(id), json!(true))), "{s}");
        }
        assert_eq!(s["validation"]["valid"], true, "{s}");
        assert!(seen.insert(s["slots"].to_string()), "a suggestion offered twice once trimmed: {s}");
    }
}

#[tokio::test]
async fn a_locked_tie_is_kept_and_locked_in_every_suggestion_and_each_stays_valid() {
    // The tie counts towards the neutral allowance before the composer picks the rest, so the
    // suggestions built around it pass the same validation as studio/validate.
    let mut store = MemStore::default();
    let list = suggest(&mut store, json!({"slots": [locked("neckwear", TIE_NAVY)]})).await;
    assert!(!list.is_empty());
    for s in &list {
        assert_eq!(piece(s, "neckwear").map(|x| (x["garmentId"].clone(), x["locked"].clone())), Some((json!(TIE_NAVY), json!(true))), "{s}");
        assert_eq!(s["validation"]["valid"], true, "{s}");
        let (status, v) = send(&mut store, OWNER, "POST", "/v1/studio/validate", json!({"slots": s["slots"]})).await;
        assert_eq!((status, v["valid"].clone()), (200, json!(true)), "{v}");
    }
}

#[tokio::test]
async fn locked_shoes_and_socks_still_leave_room_for_the_open_belt() {
    // The locked shoe and sock count once each towards the neutral limit, so a belt is still chosen
    // for the open belt slot.
    let mut store = MemStore::default();
    let list = suggest(&mut store, json!({"slots": [locked("footwear", SNEAKERS), locked("socks", SOCK_GREY), {"role": "belt", "garmentId": BELT_BROWN, "locked": false}]})).await;
    assert!(!list.is_empty());
    for s in &list {
        assert_eq!(piece(s, "footwear").map(|x| x["garmentId"].clone()), Some(json!(SNEAKERS)), "{s}");
        assert_eq!(piece(s, "socks").map(|x| x["garmentId"].clone()), Some(json!(SOCK_GREY)), "{s}");
        assert!(piece(s, "belt").is_some(), "the open belt role is filled: {s}");
        assert_eq!(s["validation"]["valid"], true, "{s}");
    }
}

#[tokio::test]
async fn a_locked_piece_that_cannot_be_worn_today_gets_no_suggestion_except_in_explore() {
    let mut store = MemStore::default();
    // The welted Reims is out while the healing restriction holds: nothing is suggested for today.
    assert_eq!(suggest(&mut store, json!({"slots": [locked("footwear", REIMS)]})).await, Vec::<Value>::new());
    // Explore builds around it, and says it is not wearable today.
    let explore = suggest(&mut store, json!({"slots": [locked("footwear", REIMS)], "mode": "explore"})).await;
    assert!(!explore.is_empty());
    for s in &explore {
        assert_eq!(piece(s, "footwear").unwrap()["garmentId"], REIMS);
        assert_eq!((s["validation"]["valid"].clone(), s["validation"]["wearableOn"].clone()), (json!(true), Value::Null), "{s}");
        assert!(s["validation"]["violations"].as_array().unwrap().iter().any(|v| v["severity"] == "advisory" && v["garmentIds"].to_string().contains(REIMS)), "{s}");
    }
    // A shirt the owner put in the hamper cannot be built around today either.
    let dirty = json!({"type": "care.mark_dirty", "idempotencyKey": "suggest-dirty-1", "authorization": "owner_tap", "source": {"channel": "ios"}, "payload": {"items": [{"garmentId": SHIRT}]}});
    assert_eq!(send(&mut store, OWNER, "POST", "/v1/commands", dirty).await.0, 200);
    assert_eq!(suggest(&mut store, json!({"slots": [locked("top", SHIRT)]})).await, Vec::<Value>::new());
    // Without the lock, the hamper shirt is never suggested.
    let open = suggest(&mut store, json!({"slots": [{"role": "top", "garmentId": SHIRT}]})).await;
    assert!(!open.is_empty() && open.iter().all(|s| piece(s, "top").unwrap()["garmentId"] != SHIRT), "{open:?}");
}

#[tokio::test]
async fn malformed_requests_and_unknown_garments_are_refused_and_an_assistant_may_ask() {
    let mut store = MemStore::default();
    for (body, status, words) in [
        (json!({"slots": []}), 400, "slots: expected 1 to 24 slots"),
        (json!({"slots": [locked("top", SHIRT)], "limit": 11}), 400, "limit: expected a whole number from 1 to 10"),
        (json!({"slots": [locked("top", SHIRT)], "mode": "dream"}), 400, "for_today or explore"),
        (json!({"slots": [locked("top", SHIRT)], "date": "2026-02-30"}), 400, "YYYY-MM-DD"),
        (json!({"slots": [locked("top", "gmt_nobody")]}), 404, "unknown garment: gmt_nobody"),
    ] {
        let (s, e) = send(&mut store, OWNER, "POST", "/v1/studio/suggest", body.clone()).await;
        assert_eq!(s, status, "{body}: {e}");
        assert!(e.to_string().contains(words), "{body}: {e}");
    }
    let (status, r) = send(&mut store, ASSISTANT, "POST", "/v1/studio/suggest", json!({"slots": [locked("top", SHIRT)], "limit": 1})).await;
    assert_eq!((status, r["suggestions"].as_array().map(Vec::len)), (200, Some(1)), "{r}");
    assert!(store.data.is_empty());
}
