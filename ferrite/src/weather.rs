//! `GET /v1/weather[?date=]` (`WeatherSnapshot`): the forecast behind the board's weather line.
//!
//! The TypeScript service (`fetchWeatherSnapshot` in packages/daily/src/snapshots.ts) asks a
//! weather provider for the owner's home city. The port has no home city (no settings command is
//! ported, so `homeLocation` is the default null) and no weather provider egress, so it answers what
//! that service answers for an owner without a home city: `buildWeatherSnapshot` with no forecast,
//! every value null, `freshness: "unavailable"` and the limitation saying why. Nothing is guessed.
//! The TypeScript route also records the snapshot (`weather.record_snapshot`); that command is not
//! ported, so the snapshot is answered and not kept.

use ferrite_app::serde_json::{json, Value};

use crate::time::{instant, OWNER_TIMEZONE};

/// `DailySettings` defaults (packages/contracts/src/ext/daily.ts) and the fixed evening-return
/// interval (`EVENING_RETURN_FROM`/`TO` in packages/daily/src/weather/assess.ts).
const WINDOWS: [(&str, &str, &str); 4] = [("departure", "08:00", "09:00"), ("daytime", "08:00", "19:00"), ("evening_return", "17:00", "20:00"), ("evening", "18:00", "23:00")];

/// Why there is no forecast: `resolveLocation`'s words for an owner without a home city.
pub const NO_HOME_CITY: &str = "No home city is set, so no forecast was requested.";

/// The snapshot for `local_date` (a valid `LocalDate`) at `now_ms`. `snapshot_id` is `wxs_` and 32
/// hex characters, as `newId("wxs")` writes it.
pub fn snapshot(local_date: &str, now_ms: u64, snapshot_id: &str) -> Value {
    let windows: Vec<Value> = WINDOWS
        .iter()
        .map(|(name, from, to)| {
            json!({
                "name": name, "fromLocalTime": from, "toLocalTime": to, "coveredHours": 0,
                "minC": null, "maxC": null, "apparentMinC": null, "apparentMaxC": null,
                "maxPrecipitationProbabilityPct": null, "precipitationMm": null, "maxWindGustKmh": null,
            })
        })
        .collect();
    json!({
        "snapshotId": snapshot_id,
        "localDate": local_date,
        "provider": "open-meteo",
        "attribution": "",
        "location": {"label": "unknown location", "latitude": 0, "longitude": 0, "timezone": OWNER_TIMEZONE},
        // Without a forecast there is no fetch time; the time of the attempt is given and ageMinutes stays null.
        "fetchedAt": instant(now_ms),
        "issuedAt": null,
        "coversFrom": null,
        "coversTo": null,
        "freshness": "unavailable",
        "ageMinutes": null,
        "missingFields": ["forecast"],
        "hours": [],
        "alerts": null,
        "windows": windows,
        "conditions": {
            "freshness": "unavailable", "snapshotId": snapshot_id,
            "peakC": null, "peakInterval": null, "departureC": null, "departureInterval": null, "eveningReturnC": null,
            "maxPrecipitationProbabilityPct": null, "precipitationMm": null, "rainLikelyFromHour": null, "maxWindGustKmh": null,
            "segment": "day",
        },
        "line": "Weather unavailable",
        "limitation": NO_HOME_CITY,
    })
}
