//! `GET /v1/wardrobe/temperature-preview` (a simulation of what is wearable at a chosen temperature) and
//! `GET /v1/recovery` (the recovery screen's state), as the iOS client reads them.
//!
//! The store is an in-memory test double of the APE binding; the garments, their sheet temperature
//! bounds and the profile's rules are the real seed.

use std::collections::BTreeMap;
use std::io;

use ferrite_app::serde_json::{self, json, Value};
use ferrite_app::IngressRequest;
use wardrobe::api::{self, Store, Tokens};
use wardrobe::seed::catalogue;
use wardrobe::time::parse_instant;

const OWNER: &str = "owner-token-for-tests";
const ASSISTANT: &str = "assistant-token-for-tests";
const PIMA_CHARCOAL: &str = "gmt_5882e20c9798352bbfe3f5a3";
const PIMA_WHITE: &str = "gmt_2d22145b2318255c0a0f6f2d";
const PALERMO_NEUTRAL: &str = "gmt_0f461ad174c203925f407dd9";
const BLACK_CHORE: &str = "gmt_1b67b81380f5ac86b7a88b36";
const CAMEL_GAMES: &str = "gmt_638bcac4f1df41494e25af8c";
const MR_P_FIELD: &str = "gmt_2a5171cf2db5616807570b4d";

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

async fn preview(store: &mut MemStore, t: &str) -> Value {
    let (status, body) = send(store, OWNER, "GET", &format!("/v1/wardrobe/temperature-preview?temperatureC={t}"), Value::Null).await;
    assert_eq!(status, 200, "{body}");
    body
}

fn entry<'a>(list: &'a Value, id: &str) -> Option<&'a Value> {
    list.as_array().unwrap().iter().find(|e| e["garmentId"] == id)
}

#[tokio::test]
async fn at_30_degrees_the_sheets_limits_and_the_owners_basis_rules_decide_what_is_wearable() {
    let mut store = MemStore::default();
    // The iOS client sends `String(Double)`: "30.0".
    let p = preview(&mut store, "30.0").await;
    assert_eq!((p["simulation"].clone(), p["temperatureC"].clone()), (json!(true), json!(30)));
    assert_eq!(p["label"], "Simulation at 30 °C. Actual availability, laundry and restrictions are unchanged.");
    assert_eq!(p.as_object().unwrap().len(), 5);
    // A shirt's sheet limit is assessed against the daytime peak (thermal.base_layers_follow_daytime_peak).
    assert_eq!(
        entry(&p["notWearable"], PIMA_CHARCOAL),
        Some(&json!({"garmentId": PIMA_CHARCOAL, "name": "Pima oxford — charcoal", "role": "top", "why": "Pima oxford — charcoal is kept to 22 °C and below (peak 30 °C)"}))
    );
    // Outerwear against the outdoor temperature (thermal.outerwear_follows_morning).
    assert_eq!(entry(&p["notWearable"], BLACK_CHORE).unwrap()["why"], "Drake's Black Heavy Twill Chore is kept to 20 °C and below (30 °C when outdoors)");
    // 30 °C+ linen is wearable at exactly 30, and says where its limit came from.
    assert_eq!(
        entry(&p["wearable"], PALERMO_NEUTRAL),
        Some(&json!({
            "garmentId": PALERMO_NEUTRAL, "name": "Palermo linen drawstring — neutral", "role": "bottom", "inStorage": false,
            "basis": "inventory CSV Season/Notes: \"Hot (30°C+)\" / \"Semi-transparent; 30°C+ only\"",
        }))
    );
    let cat = catalogue();
    let roles = ["top", "mid_layer", "bottom", "outer", "socks"];
    let covered: Vec<&wardrobe::seed::Garment> = cat.garments.iter().filter(|g| g.acquisition == "owned" && g.planning_policy != "excluded" && roles.contains(&g.roles[0].as_str())).collect();
    let listed = p["wearable"].as_array().unwrap().len() + p["notWearable"].as_array().unwrap().len();
    assert_eq!(listed, covered.len(), "every owned garment in a covered first role, once");
    assert!(covered.len() > 60, "{}", covered.len());
    // Each list in the TypeScript query's order: category, name, garment ID.
    for list in [&p["wearable"], &p["notWearable"]] {
        let keys: Vec<(String, String, String)> = list.as_array().unwrap().iter().map(|e| {
            let g = cat.get(e["garmentId"].as_str().unwrap()).unwrap();
            assert!(roles.contains(&g.roles[0].as_str()) && g.roles[0] == e["role"].as_str().unwrap(), "{e}");
            (g.category.clone(), g.name.clone(), g.id.clone())
        }).collect();
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(keys, sorted);
    }
    // No footwear, belt or accessory is previewed.
    assert!(entry(&p["wearable"], "gmt_14bc4338d6760f6a13434b2f").is_none());
}

#[tokio::test]
async fn at_12_degrees_the_research_thresholds_stay_off_and_nothing_changes() {
    let mut store = MemStore::default();
    // A dirty shirt is still previewed: the simulation ignores laundry and availability.
    let dirty = json!({"type": "care.mark_dirty", "payload": {"items": [{"garmentId": PIMA_WHITE}]}, "idempotencyKey": "preview-dirty-0001", "authorization": "owner_tap", "source": {"channel": "ios"}});
    assert_eq!(send(&mut store, OWNER, "POST", "/v1/commands", dirty).await.0, 200);
    let before = store.data.clone();
    let p = preview(&mut store, "12").await;
    assert_eq!(store.data, before, "a preview writes nothing");
    assert!(entry(&p["wearable"], PIMA_WHITE).is_some(), "{p}");
    assert_eq!(entry(&p["notWearable"], PALERMO_NEUTRAL).unwrap()["why"], "Palermo linen drawstring — neutral is kept for 30 °C and above (peak 12 °C)");
    assert_eq!(entry(&p["wearable"], CAMEL_GAMES).unwrap()["basis"], "inventory CSV Season: \"10-22°C\"");
    // thermal.cotton_linen_from (28 °C and above) is pending reconciliation, so it is not applied.
    assert!(entry(&p["wearable"], MR_P_FIELD).is_some(), "{p}");
    assert!(!p.to_string().contains("(cotton linen)"), "no fabric-class rule is active for the owner");
    // A garment with no limit on the sheet says so, with its season text.
    let plain = p["wearable"].as_array().unwrap().iter().find(|e| e["basis"].as_str().unwrap().starts_with("no temperature limit recorded")).expect("a garment without a limit");
    let g = catalogue().get(plain["garmentId"].as_str().unwrap()).unwrap();
    let want = match &g.season_note {
        Some(s) => format!("no temperature limit recorded (sheet season: {s})"),
        None => "no temperature limit recorded".to_string(),
    };
    assert_eq!(plain["basis"], want);

    let p = preview(&mut store, "12.5").await;
    assert_eq!((p["temperatureC"].clone(), p["label"].clone()), (json!(12.5), json!("Simulation at 12.5 °C. Actual availability, laundry and restrictions are unchanged.")));
    let p = preview(&mut store, "-5").await;
    assert_eq!(entry(&p["notWearable"], CAMEL_GAMES).unwrap()["why"], "Drake's Camel Field Games is kept for 10 °C and above (-5 °C when outdoors)");

    for bad in ["", "abc", "51", "-41", "0x10", "1e-7"] {
        let (status, body) = send(&mut store, OWNER, "GET", &format!("/v1/wardrobe/temperature-preview?temperatureC={bad}"), Value::Null).await;
        assert_eq!((status, body["error"]["code"].clone()), (400, json!("invalid_command")), "{bad}: {body}");
    }
    let (status, _) = send(&mut store, OWNER, "GET", "/v1/wardrobe/temperature-preview", Value::Null).await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn the_recovery_screen_reports_todays_board_and_nothing_pending() {
    let mut store = MemStore::default();
    let (status, empty) = send(&mut store, OWNER, "GET", "/v1/recovery", Value::Null).await;
    assert_eq!(status, 200, "{empty}");
    assert_eq!(
        empty,
        json!({
            "lastBoard": null, "lastCalendarProjection": null, "pending": {"effects": 0, "runsNeedingInput": 0}, "connectionIssues": [], "actions": [],
            "diagnostics": {"environment": "ferrite", "modules": {"daily": true, "assistant": true, "media": false}, "noBoardReason": "No board has been published for this day yet."},
            "readAt": "2026-10-12T09:00:00Z",
        })
    );

    // Today's home board (the owner's day now, in London), published from the app.
    let outfit = json!({"slots": [
        {"role": "top", "garmentId": "gmt_3894b6a6295908d5e687af4f"}, {"role": "bottom", "garmentId": "gmt_0bd82c642c7606199361d3d4"},
        {"role": "belt", "garmentId": "gmt_6335e17bcb19fb15f77c31bf"}, {"role": "socks", "garmentId": "gmt_9eb32f6a40ea3e5e4dee484b"},
        {"role": "footwear", "garmentId": "gmt_14bc4338d6760f6a13434b2f"},
    ], "reason": ""});
    let publish = json!({"type": "board.publish", "payload": {"localDate": "2026-10-12", "requestedCount": 1, "options": [outfit]}, "idempotencyKey": "recovery-board-0001", "authorization": "owner_tap", "source": {"channel": "ios"}});
    let (status, receipt) = send(&mut store, OWNER, "POST", "/v1/commands", publish).await;
    assert_eq!(status, 200, "{receipt}");
    let (status, status_now) = send(&mut store, ASSISTANT, "GET", "/v1/recovery", Value::Null).await;
    assert_eq!(status, 200, "{status_now}");
    let board = &status_now["lastBoard"];
    assert_eq!((board["boardId"].clone(), board["localDate"].clone(), board["revision"].clone()), (receipt["result"]["boardId"].clone(), json!("2026-10-12"), json!(1)));
    assert_eq!(board["publishedAt"], "2026-10-12T09:00:00Z");
    assert_eq!(status_now["lastCalendarProjection"], json!({"state": "not_connected", "projectedRevision": null, "action": null}));
    assert_eq!(status_now["actions"], json!(["open_today"]));
    assert!(status_now["diagnostics"].get("noBoardReason").is_none(), "{status_now}");
}
