//! Studio's reads through `api::handle` as the iOS client sends them: the selectors and opening outfit
//! (`GET /v1/studio`), the authoritative check of a combination (`POST /v1/studio/validate`) and the
//! deterministic composition (`POST /v1/studio/compose`). Reading changes nothing.
//!
//! The store is an in-memory test double of the APE binding (the same guarded-commit semantics);
//! the garments are the real seed.

use std::collections::BTreeMap;
use std::io;

use ferrite_app::serde_json::{self, json, Value};
use ferrite_app::IngressRequest;
use wardrobe::api::{self, Store, Tokens};
use wardrobe::canonical::canonical;
use wardrobe::sha256::hex_digest;
use wardrobe::time::parse_instant;

const OWNER: &str = "owner-token-for-tests";
const ASSISTANT: &str = "assistant-token-for-tests";

const SHIRT: &str = "gmt_3894b6a6295908d5e687af4f";
const TROUSERS: &str = "gmt_0bd82c642c7606199361d3d4";
const SOCKS: &str = "gmt_9eb32f6a40ea3e5e4dee484b";
const SNEAKERS: &str = "gmt_14bc4338d6760f6a13434b2f"; // NB 990v4 grey, never laundered
const REIMS: &str = "gmt_a8fe5fe3a6c0754361249bf8"; // Paraboot Reims, welted: under the sneakers-only restriction
const COAT: &str = "gmt_c8c5f3b201ef344b0a8a1864"; // DBF Grandfather Coat
const BENCHED: &str = "gmt_d49a3ac887977cf682915c01"; // DBF Traveler linen, benched: too large
const BED_SOCK: &str = "gmt_8c8b983912a6effbc6b33a86"; // indoor only

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

fn at(instant: &str) -> u64 {
    parse_instant(instant).unwrap()
}

async fn send(store: &mut MemStore, now_ms: u64, token: &str, method: &str, path: &str, body: Value) -> (u16, Value) {
    let bytes = if body.is_null() { Vec::new() } else { serde_json::to_vec(&body).unwrap() };
    let mut req = IngressRequest::new(method, path, bytes);
    req.headers = vec![("authorization".into(), format!("Bearer {token}"))];
    let tokens = Tokens { owner: Some(OWNER.into()), assistant: Some(ASSISTANT.into()), public_origin: None, ..Default::default() };
    let reply = api::handle(store, &tokens, now_ms, &req).await;
    let (_, bytes) = reply.content();
    (reply.status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn slot(role: &str, id: &str) -> Value {
    json!({"role": role, "garmentId": id})
}

fn outfit(shoes: &str) -> Vec<Value> {
    vec![slot("top", SHIRT), slot("bottom", TROUSERS), slot("socks", SOCKS), slot("footwear", shoes)]
}

fn item<'a>(doc: &'a Value, role: &str, id: &str) -> Option<&'a Value> {
    doc["selectors"].as_array().unwrap().iter().find(|s| s["role"] == role)?["items"].as_array().unwrap().iter().find(|i| i["garmentId"] == id)
}

fn codes(v: &Value) -> Vec<(String, String)> {
    v["violations"].as_array().unwrap().iter().map(|x| (x["code"].as_str().unwrap().to_string(), x["severity"].as_str().unwrap().to_string())).collect()
}

#[tokio::test]
async fn for_today_studio_offers_only_what_can_be_worn_and_an_outfit_to_start_from() {
    let mut store = MemStore::default();
    let now = at("2026-09-10T23:30:00Z");
    let (status, doc) = send(&mut store, now, OWNER, "GET", "/v1/studio", Value::Null).await;
    assert_eq!(status, 200, "{doc}");
    // The owner's day in London, nothing saved yet, read without writing anything.
    assert_eq!((doc["mode"].clone(), doc["forDate"].clone(), doc["wardrobeRevision"].clone(), doc["readAt"].clone()), (json!("for_today"), json!("2026-09-11"), json!(0), json!("2026-09-10T23:30:00Z")));
    assert_eq!((doc["combinations"].clone(), doc["dayPlans"].clone()), (json!([]), json!([])));
    assert!(store.data.is_empty(), "reading Studio wrote nothing");
    let roles: Vec<(&str, bool)> = doc["selectors"].as_array().unwrap().iter().map(|s| (s["role"].as_str().unwrap(), s["primary"].as_bool().unwrap())).collect();
    assert_eq!(roles, vec![("top", true), ("bottom", true), ("footwear", true), ("outer", true), ("mid_layer", false), ("one_piece", false), ("socks", false), ("belt", false), ("neckwear", false), ("accessory", false)]);
    for s in doc["selectors"].as_array().unwrap() {
        for i in s["items"].as_array().unwrap() {
            assert_eq!((i["eligibleToday"].clone(), i["marker"].clone(), i["image"].clone()), (json!(true), json!("owned"), Value::Null), "{i}");
        }
    }
    // Sneakers are wearable; the welted shoes the healing restriction excludes, the benched coat and the
    // indoor-only bed sock are not offered for today.
    assert_eq!(item(&doc, "footwear", SNEAKERS).map(|i| (i["availabilityStatus"].clone(), i["reasons"].clone())), Some((json!("available"), json!([]))));
    assert!(item(&doc, "footwear", REIMS).is_none() && item(&doc, "outer", BENCHED).is_none() && item(&doc, "socks", BED_SOCK).is_none());
    // A laundered shirt nobody has reported washing since the import is an estimate, and still eligible.
    assert_eq!(item(&doc, "top", SHIRT).map(|i| (i["availabilityStatus"].clone(), i["reasons"].clone())), Some((json!("estimated"), json!(["import_cleanliness_unverified"]))));

    // The opening outfit is a complete, valid outfit of eligible garments, nothing locked.
    let opening = doc["opening"].as_array().unwrap().clone();
    let mut opened: Vec<&str> = opening.iter().map(|s| s["role"].as_str().unwrap()).collect();
    opened.sort();
    assert_eq!(opened, vec!["bottom", "footwear", "socks", "top"], "{opening:?}");
    for s in &opening {
        assert_eq!((s["locked"].clone(), s["shoppingCandidate"].clone()), (json!(false), Value::Null));
        assert!(item(&doc, s["role"].as_str().unwrap(), s["garmentId"].as_str().unwrap()).is_some(), "{s}");
    }
    let (status, v) = send(&mut store, now, OWNER, "POST", "/v1/studio/validate", json!({"slots": opening})).await;
    assert_eq!((status, v["valid"].clone(), v["wearableOn"].clone()), (200, json!(true), json!("2026-09-11")), "{v}");

    // Once the shirt is in the hamper it leaves today's selector, and Explore says why.
    let dirty = json!({"type": "care.mark_dirty", "idempotencyKey": "studio-dirty-1", "authorization": "owner_tap", "source": {"channel": "ios"}, "payload": {"items": [{"garmentId": SHIRT}]}});
    assert_eq!(send(&mut store, now, OWNER, "POST", "/v1/commands", dirty).await.0, 200);
    let (_, doc) = send(&mut store, now + 1_000, OWNER, "GET", "/v1/studio?mode=for_today", Value::Null).await;
    assert!(item(&doc, "top", SHIRT).is_none());
    assert_eq!(doc["wardrobeRevision"], 1);
    let (status, explore) = send(&mut store, now + 1_000, OWNER, "GET", "/v1/studio?mode=explore&date=2026-09-12", Value::Null).await;
    assert_eq!((status, explore["mode"].clone(), explore["forDate"].clone()), (200, json!("explore"), json!("2026-09-12")));
    let view = |role: &str, id: &str| item(&explore, role, id).map(|i| (i["marker"].clone(), i["eligibleToday"].clone(), i["availabilityStatus"].clone(), i["reasons"].clone()));
    assert_eq!(view("top", SHIRT), Some((json!("seasonal_or_stored"), json!(false), json!("unavailable"), json!(["no_units_at_home", "observed_dirty"]))));
    assert_eq!(view("footwear", REIMS), Some((json!("seasonal_or_stored"), json!(false), json!("unavailable"), json!(["restricted"]))));
    assert_eq!(view("outer", BENCHED), Some((json!("seasonal_or_stored"), json!(false), json!("unavailable"), json!(["planning_excluded"]))));
    assert_eq!(view("socks", BED_SOCK), Some((json!("seasonal_or_stored"), json!(false), json!("conditional"), json!(["import_cleanliness_unverified", "indoor_only"]))));
    assert_eq!(view("footwear", SNEAKERS), Some((json!("owned"), json!(true), json!("available"), json!([]))));

    // A connected assistant's read token reads it too; a bad mode or date is refused.
    assert_eq!(send(&mut store, now, ASSISTANT, "GET", "/v1/studio", Value::Null).await.0, 200);
    for (path, words) in [("/v1/studio?mode=dream", "for_today or explore"), ("/v1/studio?date=2026-02-30", "YYYY-MM-DD")] {
        let (status, e) = send(&mut store, now, OWNER, "GET", path, Value::Null).await;
        assert_eq!((status, e["error"]["code"].clone()), (400, json!("invalid_command")), "{path}: {e}");
        assert!(e["error"]["message"].as_str().unwrap().contains(words), "{path}: {e}");
    }
    assert_eq!(send(&mut store, now, "not-a-token", "GET", "/v1/studio", Value::Null).await.0, 401);
}

#[tokio::test]
async fn validation_is_the_daily_validator_with_studios_own_rules() {
    let mut store = MemStore::default();
    let now = at("2026-09-10T12:00:00Z");
    let check = |mode: &str, slots: Vec<Value>| json!({"mode": mode, "date": "2026-09-11", "slots": slots});

    let (status, ok) = send(&mut store, now, OWNER, "POST", "/v1/studio/validate", check("for_today", outfit(SNEAKERS))).await;
    assert_eq!(status, 200, "{ok}");
    assert_eq!((ok["valid"].clone(), ok["wearableOn"].clone(), ok["validator"].clone(), ok["wardrobeRevision"].clone(), ok["checkedAt"].clone()), (json!(true), json!("2026-09-11"), json!("daily-service"), json!(0), json!("2026-09-10T12:00:00Z")));
    assert!(codes(&ok).iter().all(|(_, s)| s == "advisory"), "{ok}");

    // The welted shoes are not wearable today while the restriction holds; in Explore the same finding is advisory.
    let (_, today) = send(&mut store, now, OWNER, "POST", "/v1/studio/validate", check("for_today", outfit(REIMS))).await;
    assert_eq!(today["valid"], false);
    let restricted = today["violations"].as_array().unwrap().iter().find(|v| v["code"] == "footwear_restricted").cloned().unwrap_or_else(|| panic!("{today}"));
    assert_eq!((restricted["severity"].clone(), restricted["garmentIds"].clone(), restricted["ruleKey"].clone()), (json!("blocking"), json!([REIMS]), json!("footwear.sneakers_only_until_healed")));
    let (_, explore) = send(&mut store, now, OWNER, "POST", "/v1/studio/validate", check("explore", outfit(REIMS))).await;
    assert_eq!((explore["valid"].clone(), explore["wearableOn"].clone()), (json!(true), Value::Null), "{explore}");
    assert!(codes(&explore).contains(&("footwear_restricted".into(), "advisory".into())), "{explore}");

    // "Not an outfit" stays blocking in Explore: there is no sockless option.
    let sockless = vec![slot("top", SHIRT), slot("bottom", TROUSERS), slot("footwear", SNEAKERS)];
    for mode in ["for_today", "explore"] {
        let (_, v) = send(&mut store, now, OWNER, "POST", "/v1/studio/validate", check(mode, sockless.clone())).await;
        assert!(v["valid"] == false && codes(&v).contains(&("socks_required".into(), "blocking".into())), "{mode}: {v}");
    }

    // A shopping candidate is explored, never worn: blocking for today, advisory in Explore.
    let jacket = json!({"role": "outer", "shoppingCandidate": {"candidateId": "cand-chore-1", "label": "Navy chore jacket", "sourceUrl": "https://shop.example.test/chore"}});
    let mut with_candidate = outfit(SNEAKERS);
    with_candidate.push(jacket.clone());
    let (_, v) = send(&mut store, now, OWNER, "POST", "/v1/studio/validate", check("for_today", with_candidate.clone())).await;
    assert!(v["valid"] == false && codes(&v).contains(&("shopping_candidate_not_owned".into(), "blocking".into())), "{v}");
    let (_, v) = send(&mut store, now, OWNER, "POST", "/v1/studio/validate", check("explore", with_candidate)).await;
    assert!(v["valid"] == true && codes(&v).contains(&("shopping_candidate_not_owned".into(), "advisory".into())), "{v}");
    let (_, v) = send(&mut store, now, OWNER, "POST", "/v1/studio/validate", check("for_today", vec![jacket.clone()])).await;
    assert_eq!(codes(&v), vec![("incomplete_outfit".to_string(), "blocking".to_string()), ("shopping_candidate_not_owned".to_string(), "blocking".to_string())]);

    // Garments that are not the owner's are named and nothing is checked; malformed slots are refused.
    let (status, e) = send(&mut store, now, OWNER, "POST", "/v1/studio/validate", json!({"slots": [slot("top", "gmt_nope"), slot("bottom", TROUSERS), slot("socks", "gmt_nope"), slot("footwear", "gmt_other")]})).await;
    assert_eq!((status, e["error"]["code"].clone(), e["error"]["details"]["missing"].clone()), (404, json!("not_found"), json!(["gmt_nope", "gmt_other"])), "{e}");
    for (body, words) in [
        (json!({"slots": []}), "slots: expected 1 to 24"),
        (json!({"slots": [{"role": "top", "garmentId": SHIRT, "shoppingCandidate": {"candidateId": "c1", "label": "x"}}]}), "exactly one garment or one shopping candidate"),
        (json!({"slots": [{"role": "top"}]}), "exactly one garment or one shopping candidate"),
        (json!({"slots": [{"role": "hat", "garmentId": SHIRT}]}), "slots[0].role"),
        (json!({"mode": "dream", "slots": outfit(SNEAKERS)}), "for_today or explore"),
        (json!({"date": "11/09/2026", "slots": outfit(SNEAKERS)}), "YYYY-MM-DD"),
        (json!({"limit": 11, "slots": outfit(SNEAKERS)}), "limit"),
    ] {
        let (status, e) = send(&mut store, now, OWNER, "POST", "/v1/studio/validate", body.clone()).await;
        assert_eq!((status, e["error"]["code"].clone()), (400, json!("invalid_command")), "{body}: {e}");
        assert!(e["error"]["message"].as_str().unwrap().contains(words), "{body}: {e}");
    }
    assert!(store.data.is_empty(), "validation wrote nothing");
}

#[tokio::test]
async fn compose_lays_out_the_outfit_the_same_way_every_time_with_text_tiles() {
    let mut store = MemStore::default();
    let now = at("2026-09-10T12:00:00Z");
    let mut slots = outfit(SNEAKERS);
    slots.push(slot("outer", COAT));
    let (status, c) = send(&mut store, now, OWNER, "POST", "/v1/studio/compose", json!({"slots": slots})).await;
    assert_eq!(status, 200, "{c}");
    let m = &c["manifest"];
    assert_eq!((m["templateVersion"].clone(), m["template"].clone(), m["canvas"].clone()), (json!("layout-1"), json!("separates_with_long_coat"), json!({"width": 900, "height": 1200, "background": "#FFFFFF"})));
    let layers = m["layers"].as_array().unwrap();
    let order: Vec<(&str, i64)> = layers.iter().map(|l| (l["role"].as_str().unwrap(), l["z"].as_i64().unwrap())).collect();
    assert_eq!(order, vec![("outer", 10), ("bottom", 20), ("top", 30), ("footwear", 40), ("socks", 41)]);
    // The long coat sits beside the main column at full size; socks are scaled for their category.
    assert_eq!(layers[0], json!({"role": "outer", "garmentId": COAT, "shoppingCandidateId": null, "name": "DBF Grandfather Coat", "assetId": null, "renditionId": null, "renditionVersion": null, "renditionSha256": null, "imageLabel": "missing", "x": 0.02, "y": 0.05, "width": 0.44, "height": 0.8, "scale": 1, "z": 10}));
    assert_eq!((layers[4]["width"].clone(), layers[4]["height"].clone(), layers[4]["scale"].clone()), (json!(0.1275), json!(0.102), json!(0.85)));
    // No photos on this server: every garment is a labelled text tile, and nothing was rendered.
    assert!(layers.iter().all(|l| l["imageLabel"] == "missing"));
    assert_eq!((c["labels"].clone(), c["preview"].clone()), (json!(["No photo yet"]), json!({"state": "none", "sha256": null, "renderedAt": null, "failure": null})));
    assert_eq!(c["missingImages"], json!([COAT, TROUSERS, SHIRT, SNEAKERS, SOCKS]));
    let caption = m["caption"].as_str().unwrap();
    assert!(caption.starts_with("Outer layer: DBF Grandfather Coat (no photo yet). Top: ") && caption.ends_with(" (no photo yet)."), "{caption}");

    // The hash is the SHA-256 of the canonical manifest: the same outfit in any order gives the same
    // hash, and changing one garment changes it.
    let hash = c["manifestHash"].as_str().unwrap().to_string();
    assert_eq!(hash, hex_digest(canonical(m).as_bytes()));
    let mut reordered = outfit(SNEAKERS);
    reordered.insert(0, slot("outer", COAT));
    reordered.reverse();
    let (_, again) = send(&mut store, now, OWNER, "POST", "/v1/studio/compose", json!({"slots": reordered})).await;
    assert_eq!(again["manifestHash"], json!(hash));
    let (_, other) = send(&mut store, now, OWNER, "POST", "/v1/studio/compose", json!({"slots": outfit(REIMS)})).await;
    assert_ne!(other["manifestHash"], json!(hash));
    assert_eq!(other["manifest"]["template"], "separates");

    // A shopping candidate is shown as one, never as owned stock.
    let (_, cand) = send(&mut store, now, OWNER, "POST", "/v1/studio/compose", json!({"slots": [slot("top", SHIRT), {"role": "outer", "shoppingCandidate": {"candidateId": "cand-chore-1", "label": "Navy chore jacket"}}]})).await;
    let outer = &cand["manifest"]["layers"][0];
    assert_eq!((outer["imageLabel"].clone(), outer["garmentId"].clone(), outer["shoppingCandidateId"].clone()), (json!("shopping_candidate"), Value::Null, json!("cand-chore-1")));
    assert_eq!((cand["manifest"]["template"].clone(), cand["labels"].clone(), cand["missingImages"].clone()), (json!("separates_with_jacket"), json!(["Shopping candidate", "No photo yet"]), json!([SHIRT])));
    assert!(cand["manifest"]["caption"].as_str().unwrap().starts_with("Outer layer: Navy chore jacket (shopping candidate, not owned). "));

    // No preview is ever stored, so there is none to read by its hash.
    for (path, words) in [(format!("/v1/studio/compositions/{hash}"), "no such outfit preview"), (format!("/v1/studio/compositions/{hash}/preview"), "no rendered preview")] {
        let (status, e) = send(&mut store, now, OWNER, "GET", &path, Value::Null).await;
        assert_eq!((status, e["error"]["code"].clone()), (404, json!("not_found")), "{path}: {e}");
        assert!(e["error"]["message"].as_str().unwrap().contains(words), "{path}: {e}");
    }
    assert!(store.data.is_empty(), "composing wrote nothing");
}
