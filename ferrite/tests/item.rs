//! The item page, `GET /v1/items/{garmentId}` (`ItemResponse`), through `api::handle` as the iOS client
//! sends it, on the owner's real inventory rows: the record as the importer planned it, the healing
//! restriction where it covers the garment, balances and movements as the ledger replays them after
//! wash, laundry and wear reports, counted wears, and the estimator's availability for the owner's day
//! (`estimateGarment`, as `GET /v1/availability` gives it).
//!
//! The store is an in-memory test double of the APE binding (the same guarded-commit semantics); the
//! garments are the real seed.

use std::collections::BTreeMap;
use std::io;

use ferrite_app::serde_json::{self, json, Value};
use ferrite_app::IngressRequest;
use wardrobe::api::{self, Principal, Store, Tokens, OWNER};
use wardrobe::board;
use wardrobe::seed::{catalogue, healing_restriction};

const OWNER_TOKEN: &str = "owner-token-for-tests";
const ASSISTANT_TOKEN: &str = "assistant-token-for-tests";
const T0: u64 = 1_789_000_000_000; // 2026-09-10T00:26:40Z
const HOUR: u64 = 3_600_000;
const TODAY: &str = "2026-09-10";
const YESTERDAY: &str = "2026-09-09";

// Real garments from the owner's inventory.
const REIMS: &str = "gmt_a8fe5fe3a6c0754361249bf8"; // welted: excluded while the sneakers-only restriction holds
const NB_GREY: &str = "gmt_14bc4338d6760f6a13434b2f"; // sneaker, never laundered
const OXFORD_BLUE: &str = "gmt_3894b6a6295908d5e687af4f"; // service laundry, one unit
const GREY_CHINO: &str = "gmt_b8744c2627cd88a3b937f851";

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

async fn get(store: &mut MemStore, now: u64, token: Option<&str>, path: &str) -> (u16, Value) {
    let mut req = IngressRequest::new("GET", path, Vec::new());
    if let Some(token) = token {
        req.headers = vec![("authorization".into(), format!("Bearer {token}"))];
    }
    let tokens = Tokens { owner: Some(OWNER_TOKEN.into()), assistant: Some(ASSISTANT_TOKEN.into()), public_origin: None, ..Default::default() };
    let reply = api::handle(store, &tokens, now, &req).await;
    let (_, bytes) = reply.content();
    (reply.status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn item(store: &mut MemStore, now: u64, id: &str) -> Value {
    let (status, body) = get(store, now, Some(OWNER_TOKEN), &format!("/v1/items/{id}")).await;
    assert_eq!(status, 200, "{id}: {body}");
    body
}

async fn run(store: &mut MemStore, who: Principal, now: u64, kind: &str, payload: Value, key: &str) -> Value {
    let env = json!({"type": kind, "payload": payload, "idempotencyKey": key, "authorization": "owner_tap", "source": {"channel": "ios"}});
    let receipt = api::execute(store, who, now, &env).await.unwrap_or_else(|e| panic!("{kind}: {e:?}"));
    assert_eq!(receipt["outcome"], "committed", "{kind}: {receipt}");
    receipt
}

fn kinds(movements: &Value) -> Vec<(String, Value, Value, u64)> {
    movements.as_array().unwrap().iter().map(|m| (m["kind"].as_str().unwrap().to_string(), m["from"].clone(), m["to"].clone(), m["quantity"].as_u64().unwrap())).collect()
}

#[tokio::test]
async fn every_imported_garment_reads_as_the_importer_recorded_it() {
    let mut store = MemStore::default();
    let cat = catalogue();
    let now = T0 + 10 * HOUR;
    for g in &cat.garments {
        let body = item(&mut store, now, &g.id).await;
        let d = &body["detail"];
        let garment = &d["garment"];
        assert_eq!((garment["garmentId"].as_str(), garment["name"].as_str(), garment["category"].as_str()), (Some(g.id.as_str()), Some(g.name.as_str()), Some(g.category.as_str())));
        assert_eq!((garment["maker"].clone(), garment["product"].clone(), garment["size"].clone()), (json!(g.maker), json!(g.product), json!(g.size)), "{}", g.name);
        assert_eq!((garment["version"].clone(), garment["isSynthetic"].clone(), garment["createdAt"].clone()), (json!(1), json!(false), json!("2026-09-14T00:00:00Z")));
        // The owner's name is the first alias; every fact the importer recorded is listed, each with its
        // provenance, and the import status quotes the sheet's line.
        assert_eq!(d["aliases"][0], json!({"aliasId": g.aliases[0].alias_id, "garmentId": g.id, "phrase": g.name, "kind": "owner_name"}));
        assert_eq!(d["facts"].as_array().unwrap().len(), g.facts.len());
        let status = d["facts"].as_array().unwrap().iter().find(|f| f["attribute"] == "import_status").unwrap_or_else(|| panic!("{}: no import status", g.name));
        assert_eq!(status["source"]["kind"], "import");
        assert!(status["source"]["ref"].as_str().unwrap().ends_with(&format!("#line:{}", g.source_rows[0])), "{status}");
        // Imported stock is all clean and owned; nothing was worn or moved since.
        assert_eq!(d["balances"], json!([{"bucket": "clean", "ref": "", "quantity": g.quantity}]));
        assert_eq!(d["totalOwnedUnits"], g.quantity);
        assert_eq!(kinds(&d["movements"]), vec![("receive".to_string(), Value::Null, json!("clean"), u64::from(g.quantity))]);
        assert_eq!(d["movements"][0]["basis"], "import");
        assert_eq!((d["recordedWearCount"].clone(), d["lastRecordedWear"].clone(), d["recentWears"].clone()), (json!(0), Value::Null, json!([])));
        assert!(d["wearCountCaveat"].as_str().unwrap().contains("never unworn"));
        // The healing restriction is listed exactly where Studio and the boards exclude the shoe.
        let restricted = g.roles.iter().any(|r| r == "footwear") && board::sneakers_only_excludes(cat, g).is_some();
        assert_eq!(!d["restrictions"].as_array().unwrap().is_empty(), restricted, "{}", g.name);
        assert_eq!((body["media"].clone(), body["mediaAvailable"].clone(), body["knownCombinations"].clone()), (Value::Null, json!(false), json!([])));
        // Availability is the estimator's: excluded is 0; never laundered is 1; laundered stock no wash or
        // return has been reported for since the import carries the import prior (0.8) with no boards.
        let a = &body["availability"];
        let p = a["pAvailable"].as_f64().unwrap();
        if a["hardExcluded"] == json!(true) {
            assert_eq!((p, a["status"].as_str()), (0.0, Some("unavailable")), "{}", g.name);
        } else if g.care_channel == "none" {
            assert_eq!(p, 1.0, "{}", g.name);
        } else {
            assert_eq!(p, 0.8, "{}", g.name);
            assert!(a["reasons"].as_array().unwrap().contains(&json!("import_cleanliness_unverified")), "{a}");
        }
        assert_eq!(a["balances"], d["balances"]);
    }
}

#[tokio::test]
async fn a_restricted_shoe_and_a_sneaker_read_their_exact_availability() {
    let mut store = MemStore::default();
    let now = T0 + 10 * HOUR;
    let reims = item(&mut store, now, REIMS).await;
    assert_eq!(reims["detail"]["restrictions"], json!([healing_restriction()]));
    let r = &reims["detail"]["restrictions"][0];
    assert_eq!((r["restrictionId"].clone(), r["kind"].clone(), r["status"].clone(), r["requiredEvidence"].clone(), r["expectedEnd"].clone()), (json!("rst_profile_sneakers_only"), json!("healing"), json!("active"), json!("owner_statement"), Value::Null));
    assert_eq!(r["source"]["kind"], "profile_passage");
    let a = &reims["availability"];
    assert_eq!((a["status"].clone(), a["hardExcluded"].clone(), a["pAvailable"].as_f64(), a["restrictionIds"].clone()), (json!("unavailable"), json!(true), Some(0.0), json!(["rst_profile_sneakers_only"])));
    assert!(a["reasons"].as_array().unwrap().contains(&json!("restricted")), "{a}");
    assert_eq!(a["basis"][0].as_str().unwrap(), format!("excluded: {}", a["reasons"].as_array().unwrap().iter().map(|r| r.as_str().unwrap()).collect::<Vec<_>>().join(", ")));

    let nb = item(&mut store, now, NB_GREY).await;
    let a = &nb["availability"];
    assert_eq!(nb["detail"]["restrictions"], json!([]));
    assert_eq!((a["status"].clone(), a["hardExcluded"].clone(), a["pAvailable"].as_f64(), a["reasons"].clone(), a["inferredWear"].clone()), (json!("available"), json!(false), Some(1.0), json!([]), json!([])));
    assert_eq!(a["basis"], json!(["1 clean unit at home (observed ledger balance)"]));

    // The assistant reads the same page; a request without a sign-in does not.
    let (status, by_assistant) = get(&mut store, now, Some(ASSISTANT_TOKEN), &format!("/v1/items/{NB_GREY}")).await;
    assert_eq!((status, by_assistant["detail"].clone()), (200, nb["detail"].clone()));
    let (status, _) = get(&mut store, now, None, &format!("/v1/items/{NB_GREY}")).await;
    assert_eq!(status, 401);
}

#[tokio::test]
async fn a_shirt_follows_its_wash_and_laundry_reports() {
    let mut store = MemStore::default();
    let now = T0 + 10 * HOUR;
    let fresh = item(&mut store, now, OXFORD_BLUE).await;
    let a = &fresh["availability"];
    assert_eq!((a["status"].clone(), a["pAvailable"].as_f64(), a["reasons"].clone()), (json!("estimated"), Some(0.8), json!(["import_cleanliness_unverified"])));

    let dirty = run(&mut store, OWNER, now, "care.mark_dirty", json!({"items": [{"garmentId": OXFORD_BLUE}]}), "item-dirty-1").await;
    let page = item(&mut store, now + 1, OXFORD_BLUE).await;
    let d = &page["detail"];
    assert_eq!(d["garment"]["version"], 2);
    assert_eq!(d["balances"], json!([{"bucket": "dirty", "ref": "", "quantity": 1}]));
    assert_eq!(d["totalOwnedUnits"], 1);
    let wash = &d["movements"][1];
    assert_eq!((wash["kind"].clone(), wash["from"].clone(), wash["to"].clone(), wash["quantity"].clone(), wash["basis"].clone()), (json!("mark_dirty"), json!("clean"), json!("dirty"), json!(1), json!("observed")));
    assert_eq!(dirty["result"]["units"], 1);
    // With nothing clean at home the exclusion is exact.
    let a = &page["availability"];
    assert_eq!((a["hardExcluded"].clone(), a["pAvailable"].as_f64(), a["reasons"].clone(), a["cleanObserved"].clone()), (json!(true), Some(0.0), json!(["no_units_at_home", "observed_dirty"]), json!(0)));
    assert_eq!(a["balances"], d["balances"]);

    run(&mut store, OWNER, now + HOUR, "laundry.collect", json!({}), "item-collect-1").await;
    let away = item(&mut store, now + HOUR, OXFORD_BLUE).await;
    let b = &away["detail"]["balances"];
    assert_eq!((b[0]["bucket"].clone(), b[0]["quantity"].clone(), b.as_array().unwrap().len()), (json!("service"), json!(1), 1));
    assert!(b[0]["ref"].as_str().unwrap().len() > 0, "a batch balance names its batch: {b}");
    assert_eq!(away["availability"]["reasons"], json!(["no_units_at_home", "in_service_batch"]));

    run(&mut store, OWNER, now + 2 * HOUR, "laundry.return", json!({}), "item-return-1").await;
    let back = item(&mut store, now + 2 * HOUR, OXFORD_BLUE).await;
    assert_eq!(back["detail"]["balances"], json!([{"bucket": "clean", "ref": "", "quantity": 1}]));
    assert_eq!(
        kinds(&back["detail"]["movements"]),
        vec![
            ("receive".to_string(), Value::Null, json!("clean"), 1),
            ("mark_dirty".to_string(), json!("clean"), json!("dirty"), 1),
            ("pickup".to_string(), json!("dirty"), json!("service"), 1),
            ("return".to_string(), json!("service"), json!("clean"), 1),
        ]
    );
    // Back clean from a reported return: available, with no import prior left.
    let a = &back["availability"];
    assert_eq!((a["status"].clone(), a["pAvailable"].as_f64(), a["reasons"].clone()), (json!("available"), Some(1.0), json!([])));
}

#[tokio::test]
async fn wears_read_back_newest_first_and_an_undone_wear_stays_listed_as_retracted() {
    let mut store = MemStore::default();
    let now = T0 + 10 * HOUR;
    run(&mut store, OWNER, now, "wear.record", json!({"wearingDate": YESTERDAY, "garmentIds": [GREY_CHINO]}), "item-wear-1").await;
    let today = run(&mut store, OWNER, now + HOUR, "wear.record", json!({"wearingDate": TODAY, "garmentIds": [GREY_CHINO]}), "item-wear-2").await;
    let page = item(&mut store, now + HOUR, GREY_CHINO).await;
    let d = &page["detail"];
    assert_eq!((d["recordedWearCount"].clone(), d["lastRecordedWear"].clone()), (json!(2), json!(TODAY)));
    assert_eq!(
        d["recentWears"],
        json!([
            {"garmentId": GREY_CHINO, "wearingDate": TODAY, "observationCount": 1, "status": "active"},
            {"garmentId": GREY_CHINO, "wearingDate": YESTERDAY, "observationCount": 1, "status": "active"},
        ])
    );
    assert_eq!(kinds(&d["movements"])[1], ("wear".to_string(), json!("clean"), json!("dirty"), 1));

    run(&mut store, OWNER, now + 2 * HOUR, "command.undo", json!({"commandId": today["commandId"]}), "item-undo-1").await;
    let page = item(&mut store, now + 2 * HOUR, GREY_CHINO).await;
    let d = &page["detail"];
    assert_eq!((d["recordedWearCount"].clone(), d["lastRecordedWear"].clone()), (json!(1), json!(YESTERDAY)));
    assert_eq!(d["recentWears"][0]["status"], "retracted");
    assert_eq!(d["recentWears"][1]["status"], "active");
}

#[tokio::test]
async fn an_unknown_garment_or_path_is_not_found() {
    let mut store = MemStore::default();
    let (status, e) = get(&mut store, T0, Some(OWNER_TOKEN), "/v1/items/gmt_nope").await;
    assert_eq!((status, e["error"]["code"].clone(), e["error"]["message"].clone()), (404, json!("not_found"), json!("no garment 'gmt_nope' in this wardrobe")));
    for path in ["/v1/items/", &format!("/v1/items/{REIMS}/media")] {
        let (status, e) = get(&mut store, T0, Some(OWNER_TOKEN), path).await;
        assert_eq!((status, e["error"]["message"].clone()), (404, json!("no such route")), "{path}");
    }
    // Nothing was written by any read.
    assert!(store.data.is_empty());
}
