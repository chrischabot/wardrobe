//! The reads Today opens on, through `api::handle` as the iOS client sends them: `GET /v1/today`
//! with no date (the owner's day now, in his timezone, across the summer-time change) and
//! `GET /v1/weather`, which says plainly that no forecast was requested because no home city is set.
//! The response carries the API's status, source freshness list and wardrobe revision
//! (`TodayResponse`), so the client can tell a board built without a forecast or Calendar.
//!
//! The store is an in-memory test double of the APE binding (the same guarded-commit semantics);
//! the garments are the real seed.

use std::collections::BTreeMap;
use std::io;

use ferrite_app::serde_json::{self, json, Value};
use ferrite_app::IngressRequest;
use wardrobe::api::{self, Store, Tokens};
use wardrobe::time::parse_instant;

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

fn outfit(top: &str, bottom: &str, socks: &str, shoes: &str) -> Value {
    json!({"slots": [{"role": "top", "garmentId": top}, {"role": "bottom", "garmentId": bottom}, {"role": "socks", "garmentId": socks}, {"role": "footwear", "garmentId": shoes}], "reason": ""})
}

#[tokio::test]
async fn today_without_a_date_is_the_owners_day_in_london() {
    let mut store = MemStore::default();
    // 23:30 UTC is 00:30 the next day in British Summer Time, and still the same day in winter.
    for (now, day) in [("2026-09-10T23:30:00Z", "2026-09-11"), ("2026-09-10T22:59:59Z", "2026-09-10"), ("2026-11-10T23:30:00Z", "2026-11-10"), ("2026-10-25T00:30:00Z", "2026-10-25"), ("2026-03-29T00:30:00Z", "2026-03-29")] {
        let (status, today) = send(&mut store, at(now), OWNER, "GET", "/v1/today", Value::Null).await;
        assert_eq!(status, 200, "{now}: {today}");
        assert_eq!((today["localDate"].clone(), today["timezone"].clone()), (json!(day), json!("Europe/London")), "{now}");
        assert_eq!((today["status"].clone(), today["board"].clone(), today["freshness"].clone(), today["runId"].clone(), today["wardrobeRevision"].clone()), (json!("none"), Value::Null, json!([]), Value::Null, json!(0)));
        assert_eq!(today["emptyReason"], "No board has been published for this day yet.");
        assert_eq!(today["readAt"], now);
    }
    // A named day is read as named; `scope` may be home or a trip (an unknown trip has no board), and
    // an evening board is refused rather than answered with the day's board.
    let (status, named) = send(&mut store, at("2026-09-10T23:30:00Z"), OWNER, "GET", "/v1/today?date=2026-12-25&scope=home", Value::Null).await;
    assert_eq!((status, named["localDate"].clone()), (200, json!("2026-12-25")));
    let (status, trip) = send(&mut store, at("2026-09-10T23:30:00Z"), OWNER, "GET", "/v1/today?scope=trip:trp_1", Value::Null).await;
    assert_eq!((status, trip["status"].clone(), trip["board"].clone()), (200, json!("none"), Value::Null), "{trip}");
    for (path, words) in [("/v1/today?scope=trip:trp_1:evening", "evening boards are not ported"), ("/v1/today?scope=office", "expected home or trip"), ("/v1/today?date=2026-02-29", "YYYY-MM-DD")] {
        let (status, e) = send(&mut store, at("2026-09-10T23:30:00Z"), OWNER, "GET", path, Value::Null).await;
        assert_eq!((status, e["error"]["code"].clone()), (400, json!("invalid_command")), "{path}: {e}");
        assert!(e["error"]["message"].as_str().unwrap().contains(words), "{path}: {e}");
    }
}

#[tokio::test]
async fn todays_board_says_what_it_was_built_without() {
    let mut store = MemStore::default();
    let publish = json!({"type": "board.publish", "idempotencyKey": "owner-publish-1", "authorization": "owner_tap", "source": {"channel": "ios"}, "payload": {"localDate": "2026-09-11", "requestedCount": 2, "options": [
        outfit("gmt_3894b6a6295908d5e687af4f", "gmt_0bd82c642c7606199361d3d4", "gmt_9eb32f6a40ea3e5e4dee484b", "gmt_14bc4338d6760f6a13434b2f"),
        outfit("gmt_41c2da80e7f41e5dc6a4340b", "gmt_b8744c2627cd88a3b937f851", "gmt_67d3228f744d17138e400729", "gmt_185ccf753d109848f21f7cec"),
    ]}});
    let (status, receipt) = send(&mut store, at("2026-09-10T18:00:00Z"), OWNER, "POST", "/v1/commands", publish).await;
    assert_eq!(status, 200, "{receipt}");

    // Just after midnight in London the app opens on the 11th's board without naming the day.
    let (status, today) = send(&mut store, at("2026-09-10T23:05:00Z"), OWNER, "GET", "/v1/today", Value::Null).await;
    assert_eq!(status, 200, "{today}");
    let board = &today["board"];
    assert_eq!((today["status"].clone(), today["localDate"].clone(), board["localDate"].clone(), board["timezone"].clone()), (json!("ready"), json!("2026-09-11"), json!("2026-09-11"), json!("Europe/London")));
    assert_eq!(board["options"].as_array().unwrap().len(), 2);
    assert_eq!(today["wardrobeRevision"], 1);
    let freshness = today["freshness"].as_array().unwrap();
    let row = |source: &str| freshness.iter().find(|f| f["source"] == source).cloned().unwrap_or_else(|| panic!("no {source} row: {today}"));
    assert_eq!(freshness.iter().map(|f| f["source"].as_str().unwrap()).collect::<Vec<_>>(), vec!["board", "wardrobe", "style", "weather", "calendar"]);
    assert_eq!(row("board"), json!({"source": "board", "state": "fresh", "checkedAt": "2026-09-10T18:00:00Z", "revision": 1, "detail": board["notice"]}));
    assert_eq!(row("wardrobe"), json!({"source": "wardrobe", "state": "fresh", "checkedAt": "2026-09-10T18:00:00Z", "revision": 1, "detail": null}));
    assert_eq!(row("style")["state"], "fresh");
    assert_eq!(row("weather"), json!({"source": "weather", "state": "unavailable", "checkedAt": null, "revision": null, "detail": "No usable forecast."}));
    assert_eq!(row("calendar"), json!({"source": "calendar", "state": "not_connected", "checkedAt": null, "revision": null, "detail": "Calendar is not connected."}));

    // A later change to the wardrobe shows as the revision the board is checked against now.
    let dirty = json!({"type": "care.mark_dirty", "idempotencyKey": "owner-dirty-1", "authorization": "owner_tap", "source": {"channel": "ios"}, "payload": {"items": [{"garmentId": "gmt_3894b6a6295908d5e687af4f"}]}});
    let (status, receipt) = send(&mut store, at("2026-09-10T23:06:00Z"), OWNER, "POST", "/v1/commands", dirty).await;
    assert_eq!(status, 200, "{receipt}");
    let (_, today) = send(&mut store, at("2026-09-10T23:07:00Z"), OWNER, "GET", "/v1/today", Value::Null).await;
    assert_eq!((today["wardrobeRevision"].clone(), today["freshness"][1]["revision"].clone(), today["freshness"][0]["revision"].clone()), (json!(2), json!(2), json!(1)));
}

#[tokio::test]
async fn weather_says_no_forecast_was_requested_and_keeps_nothing() {
    let mut store = MemStore::default();
    let before = store.data.clone();
    let now = "2026-09-10T23:30:00Z";
    let (status, w) = send(&mut store, at(now), OWNER, "GET", "/v1/weather", Value::Null).await;
    assert_eq!(status, 200, "{w}");
    let id = w["snapshotId"].as_str().unwrap().to_string();
    assert!(id.len() == 36 && id.starts_with("wxs_") && id[4..].bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "{id}");
    assert_eq!((w["localDate"].clone(), w["location"]["timezone"].clone(), w["fetchedAt"].clone()), (json!("2026-09-11"), json!("Europe/London"), json!(now)));
    assert_eq!((w["freshness"].clone(), w["ageMinutes"].clone(), w["missingFields"].clone(), w["hours"].clone(), w["alerts"].clone()), (json!("unavailable"), Value::Null, json!(["forecast"]), json!([]), Value::Null));
    assert_eq!((w["line"].clone(), w["limitation"].clone()), (json!("Weather unavailable"), json!("No home city is set, so no forecast was requested.")));
    let windows: Vec<(String, String, String)> = w["windows"].as_array().unwrap().iter().map(|x| (x["name"].as_str().unwrap().into(), x["fromLocalTime"].as_str().unwrap().into(), x["toLocalTime"].as_str().unwrap().into())).collect();
    assert_eq!(windows, [("departure", "08:00", "09:00"), ("daytime", "08:00", "19:00"), ("evening_return", "17:00", "20:00"), ("evening", "18:00", "23:00")].map(|(a, b, c)| (a.to_string(), b.to_string(), c.to_string())));
    // Nothing is a number: a missing forecast is never read as zero degrees, dry or calm.
    for window in w["windows"].as_array().unwrap() {
        assert_eq!(window["coveredHours"], 0);
        for field in ["minC", "maxC", "apparentMinC", "apparentMaxC", "maxPrecipitationProbabilityPct", "precipitationMm", "maxWindGustKmh"] {
            assert_eq!(window[field], Value::Null, "{field}");
        }
    }
    let c = &w["conditions"];
    assert_eq!((c["freshness"].clone(), c["snapshotId"].clone(), c["segment"].clone()), (json!("unavailable"), json!(id), json!("day")));
    for field in ["peakC", "peakInterval", "departureC", "departureInterval", "eveningReturnC", "maxPrecipitationProbabilityPct", "precipitationMm", "rainLikelyFromHour", "maxWindGustKmh"] {
        assert_eq!(c[field], Value::Null, "{field}");
    }

    // A named day, a connected assistant's read token, and a fresh snapshot ID each time.
    let (status, named) = send(&mut store, at(now), ASSISTANT, "GET", "/v1/weather?date=2026-12-25", Value::Null).await;
    assert_eq!((status, named["localDate"].clone()), (200, json!("2026-12-25")));
    assert_ne!(named["snapshotId"], json!(id));
    let (status, e) = send(&mut store, at(now), OWNER, "GET", "/v1/weather?date=2026-02-30", Value::Null).await;
    assert_eq!((status, e["error"]["code"].clone()), (400, json!("invalid_command")));
    let (status, _) = send(&mut store, at(now), "not-a-token", "GET", "/v1/weather", Value::Null).await;
    assert_eq!(status, 401);
    // Reading the weather records nothing (`weather.record_snapshot` is not ported).
    assert_eq!(store.data, before);
}
