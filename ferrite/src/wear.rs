//! Wear records, ported from packages/domain (handlers/wear-care.ts, `wear.record`) and the reads of
//! `queries.ts` (`getDailyRecord`, `listCountedWears`).
//!
//! "I am wearing it" / "I wore it yesterday" is an authoritative owner observation: it applies at
//! once with a receipt and an undo, from the owner's app or a connected assistant relaying the owner's
//! words (2026-10-05 contract). A garment is counted once per wearing date: a second report of the
//! same garment and date (another device, a connected assistant, a retry under a new key) is kept with
//! its provenance and merges, consuming no further unit. Further interchangeable units used that day
//! (`additionalUnits`, a second pair of socks) are a total for the garment and day, so the same report
//! again consumes nothing further.
//!
//! Not ported: laundry exceptions a wear settles, the option sets of the day's board a wear resolves
//! (the board keeps no exposure sets yet), `wear.amend`, and the owner's timezone (see `wear_time`).
//! A wear on a trip (`tripId`) uses the units packed for it first (`ledger::replay`); the trip is not
//! looked up, as in the TypeScript service, so a trip with nothing packed is a wear at home.

use std::collections::BTreeSet;

use ferrite_app::serde_json::{json, Map, Value};

use crate::board;
use crate::canonical::whole;
use crate::ledger::{
    affected, bump_changed_batches, invalid, journal, load, name_list, only_keys, other_bags_changed, others_changed, replay, CmdError, Ctx, Ledger, Observation, Plan, StoredCommand, Voided,
    Wear, MAX_ITEMS, MAX_QUANTITY,
};
use crate::seed::Catalogue;
use crate::time::{instant, latest_day, local_date, parse_local_date};

const T: &str = "wear.record";
const DAY_MS: i64 = 86_400_000;
const HOUR_MS: i64 = 3_600_000;
const MAX_TEXT: usize = 2_000;
/// The undo of a wear record cannot itself be undone.
pub const WEAR_UNDO_NOT_UNDOABLE: &str = "this is already an undo; record the wear again if it happened";
/// What an observation records as its timezone while the owner's timezone is not ported.
const NO_TIMEZONE: &str = "not set";

/// A `wear.record` payload, validated.
pub struct WearInput {
    pub wearing_date: String,
    pub days: i64,
    pub garment_ids: Vec<String>,
    pub timezone: Option<String>,
    pub segment: Option<String>,
    pub additional: Vec<(String, u32)>,
    /// The trip the wear was on, if any: its packed units are used first.
    pub trip_id: Option<String>,
    pub note: Option<String>,
}

fn text(payload: &Value, key: &str, max: usize) -> Result<Option<String>, CmdError> {
    match payload.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.chars().count() <= max => Ok(Some(s.clone())),
        _ => Err(invalid(T, format!("{key}: expected a string of at most {max} characters, or null"))),
    }
}

fn garment_id(v: &Value) -> Option<String> {
    v.as_str().filter(|s| !s.is_empty() && s.len() <= 64).map(str::to_string)
}

/// The payload fields `wear.record` accepts, published by `GET /v1/command-types`.
pub const RECORD_FIELDS: &[&str] = &["wearingDate", "garmentIds", "timezone", "segment", "additionalUnits", "tripId", "note"];

pub fn parse(payload: &Value) -> Result<WearInput, CmdError> {
    only_keys(payload, T, RECORD_FIELDS)?;
    let wearing_date = payload.get("wearingDate").and_then(Value::as_str).unwrap_or_default().to_string();
    let Some(days) = parse_local_date(&wearing_date) else { return Err(invalid(T, "wearingDate: expected a date, YYYY-MM-DD")) };
    let ids = match payload.get("garmentIds") {
        Some(Value::Array(a)) if a.is_empty() => return Err(invalid(T, "garmentIds: at least one garment is required")),
        Some(Value::Array(a)) if a.len() <= MAX_ITEMS => a,
        Some(Value::Array(_)) => return Err(invalid(T, format!("garmentIds: at most {MAX_ITEMS} entries"))),
        _ => return Err(invalid(T, "garmentIds: expected an array of garment IDs")),
    };
    let mut garment_ids = Vec::new();
    for (i, v) in ids.iter().enumerate() {
        let Some(id) = garment_id(v) else { return Err(invalid(T, format!("garmentIds[{i}]: expected a garment ID (1 to 64 characters)"))) };
        garment_ids.push(id);
    }
    let mut additional: Vec<(String, u32)> = Vec::new();
    match payload.get("additionalUnits") {
        None | Some(Value::Null) => {}
        Some(Value::Array(a)) if a.len() <= MAX_ITEMS => {
            for (i, x) in a.iter().enumerate() {
                let ok_keys = x.as_object().map_or(false, |o| o.keys().all(|k| k == "garmentId" || k == "quantity"));
                let id = x.get("garmentId").and_then(garment_id);
                let q = x.get("quantity").and_then(whole).filter(|q| (1..=MAX_QUANTITY).contains(q));
                match (ok_keys, id, q) {
                    (true, Some(id), Some(q)) => match additional.iter_mut().find(|(g, _)| *g == id) {
                        // The same garment twice in one report is one total.
                        Some(e) => e.1 = e.1.max(q as u32),
                        None => additional.push((id, q as u32)),
                    },
                    _ => return Err(invalid(T, format!("additionalUnits[{i}]: expected {{garmentId, quantity}} with a whole quantity from 1 to {MAX_QUANTITY}"))),
                }
            }
        }
        _ => return Err(invalid(T, format!("additionalUnits: expected an array of at most {MAX_ITEMS} entries"))),
    }
    // An empty trip ID names no trip, as `tripId ? ... : ...` reads it in the TypeScript replay.
    let trip_id = match payload.get("tripId") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.is_empty() => None,
        Some(Value::String(s)) if s.chars().count() <= crate::packing::MAX_TRIP_ID => Some(s.clone()),
        _ => return Err(invalid(T, format!("tripId: expected a trip ID of at most {} characters, or null", crate::packing::MAX_TRIP_ID))),
    };
    // A further unit is of a garment worn that day: it must be reported as worn too, so the day's
    // record and history account for every unit the report uses.
    if let Some(i) = additional.iter().position(|(g, _)| !garment_ids.contains(g)) {
        return Err(invalid(T, format!("additionalUnits[{i}]: a further unit is of a garment worn that day; name {} in garmentIds too", additional[i].0)));
    }
    Ok(WearInput {
        wearing_date,
        days,
        garment_ids,
        timezone: text(payload, "timezone", 64)?,
        segment: text(payload, "segment", 200)?,
        additional,
        trip_id,
        note: text(payload, "note", MAX_TEXT)?,
    })
}

/// When a wear on `days` happened, for event ordering (`wearOccurredAt`): a stated time, which must
/// not be more than a day before the wearing date began; otherwise now for today, or local noon of a
/// past date. No owner timezone is ported, so "the day began" is the earliest any timezone starts
/// that date (UTC+14), "today" is any date it still is somewhere on Earth (from UTC-12), and "noon"
/// is noon UTC.
fn wear_time(ctx: &Ctx<'_>, input: &WearInput, explicit: bool) -> Result<u64, CmdError> {
    let midnight = input.days * DAY_MS;
    if explicit {
        let earliest = midnight - 14 * HOUR_MS - DAY_MS;
        if (ctx.occurred_at_ms as i64) < earliest {
            return Err(CmdError::with(
                "invalid_command",
                "the time given for this wear is before its wearing date; leave the time out or give one on that day",
                json!({"reason": "occurred_before_wearing_date", "wearingDate": input.wearing_date, "occurredAt": instant(ctx.occurred_at_ms)}),
            ));
        }
        return Ok(ctx.occurred_at_ms);
    }
    if input.days >= crate::time::earliest_day(ctx.now_ms) {
        return Ok(ctx.now_ms);
    }
    let noon = (midnight + 12 * HOUR_MS).max(0) as u64;
    Ok(noon.min(ctx.now_ms))
}

fn name(cat: &Catalogue, id: &str) -> String {
    cat.get(id).map_or_else(|| id.to_string(), |g| g.name.clone())
}

fn new_id(ctx: &Ctx<'_>, prefix: &str, n: usize) -> String {
    format!("{prefix}_{}_{n}", ctx.command_id.trim_start_matches("cmd_"))
}

/// `wear.record`. `channel` is the connection the report came through (provenance), and `explicit`
/// whether the envelope stated `occurredAt`.
pub fn record(ctx: &Ctx<'_>, ledger: &mut Ledger, payload: &Value, channel: &str, explicit: bool) -> Result<Plan, CmdError> {
    let input = parse(payload)?;
    if input.days > latest_day(ctx.now_ms) {
        return Err(CmdError::with(
            "invalid_command",
            "a wear cannot be recorded for a future date; choose an outfit instead",
            json!({"wearingDate": input.wearing_date, "today": local_date(latest_day(ctx.now_ms))}),
        ));
    }
    let mut requested: Vec<String> = Vec::new();
    for id in input.garment_ids.iter().chain(input.additional.iter().map(|(g, _)| g)) {
        if !requested.contains(id) {
            requested.push(id.clone());
        }
    }
    load(ctx.cat, &requested)?;
    let mut distinct: Vec<String> = Vec::new();
    for id in &input.garment_ids {
        if !distinct.contains(id) {
            distinct.push(id.clone());
        }
    }
    let at = wear_time(ctx, &input, explicit)?;
    let wctx = Ctx { cat: ctx.cat, command_id: ctx.command_id, now_ms: ctx.now_ms, occurred_at_ms: at };
    let date = input.wearing_date.clone();
    let before = replay(ctx.cat, &ledger.events);

    let mut counted: Vec<String> = Vec::new();
    let mut merged: Vec<String> = Vec::new();
    let mut observation_ids: Vec<String> = Vec::new();
    let mut repairs_extra: Vec<String> = Vec::new();
    for g in &distinct {
        let obs = new_id(ctx, "obs", observation_ids.len() + 1);
        observation_ids.push(obs.clone());
        // Every report is kept with its provenance, including duplicates from another client.
        ledger.observations.push(Observation {
            id: obs,
            garment_id: g.clone(),
            wearing_date: date.clone(),
            occurred_at_ms: at,
            reported_at_ms: ctx.now_ms,
            timezone: input.timezone.clone().unwrap_or_else(|| NO_TIMEZONE.to_string()),
            channel: channel.to_string(),
            segment: input.segment.clone(),
            note: input.note.clone(),
            command_id: ctx.command_id.to_string(),
            retracted_by: None,
            additional_units: input.additional.iter().find(|(x, _)| x == g).map_or(0, |(_, q)| *q),
        });
        if ledger.wear(g, &date).map_or(false, |w| w.active) {
            // Same garment, same wearing date: one counted wear. The report merges; no further unit is consumed.
            merged.push(g.clone());
            continue;
        }
        let event = journal(&wctx, ledger, g, "wear", None, 1, 0);
        if let Some(e) = ledger.events.last_mut() {
            e.wearing_date = Some(date.clone());
            e.trip_id = input.trip_id.clone();
        }
        match ledger.wears.iter_mut().find(|w| w.garment_id == *g && w.wearing_date == date) {
            Some(w) => {
                w.active = true;
                w.stock_event_id = event;
            }
            None => ledger.wears.push(Wear { garment_id: g.clone(), wearing_date: date.clone(), stock_event_id: event, active: true }),
        }
        counted.push(g.clone());
        if let Some(garment) = ctx.cat.get(g) {
            if garment.roles.iter().any(|r| r == "footwear") {
                if let Some(rule) = board::sneakers_only_excludes(ctx.cat, garment) {
                    repairs_extra.push(format!("{}: worn while restricted ({}); the wear is recorded and the restriction is unchanged", garment.name, rule.key));
                }
            }
        }
    }

    // Extra units are a total for the garment and day, like the wear itself.
    let mut extra_ids: Vec<String> = Vec::new();
    let mut already_recorded: u32 = 0;
    for (g, q) in &input.additional {
        let prior: u32 = ledger
            .events
            .iter()
            .filter(|e| e.kind == "extra_unit" && e.voided_by.is_none() && e.garment_id == *g && e.wearing_date.as_deref() == Some(date.as_str()))
            .map(|e| e.quantity)
            .sum();
        let further = q.saturating_sub(prior);
        already_recorded += q - further;
        if further == 0 {
            continue;
        }
        let event = journal(&wctx, ledger, g, "extra_unit", None, further, 0);
        if let Some(e) = ledger.events.last_mut() {
            e.wearing_date = Some(date.clone());
            e.trip_id = input.trip_id.clone();
        }
        extra_ids.push(event);
    }

    let after = replay(ctx.cat, &ledger.events);
    other_bags_changed(ctx, ledger, &before, &after)?;
    let touched: BTreeSet<String> = distinct.iter().chain(input.additional.iter().map(|(g, _)| g)).cloned().collect();
    let mut affected = affected(ledger, &touched);
    affected.extend(bump_changed_batches(ledger, &before, &after));
    let names: Vec<String> = distinct.iter().map(|g| name(ctx.cat, g)).collect();
    let all_merged = counted.is_empty() && extra_ids.is_empty();
    let summary = if all_merged {
        format!("Already recorded for {date}: {}. The report was merged; nothing was counted twice", name_list(&names))
    } else if merged.is_empty() {
        format!("Recorded for {date}: {}", name_list(&names))
    } else {
        format!("Recorded for {date}: {} ({} already recorded that day, counted once)", name_list(&names), merged.len())
    };
    let mut repairs = after.new_repairs_since(&before);
    repairs.extend(repairs_extra);
    Ok(Plan {
        outcome: if all_merged { "merged" } else { "committed" },
        summary,
        affected,
        repairs,
        result: json!({
            "wearingDate": date,
            "counted": counted,
            "merged": merged,
            "observationIds": observation_ids,
            "additionalUnitEvents": extra_ids.len(),
            "additionalUnitsAlreadyRecorded": already_recorded,
        }),
        undo: Ok(json!({"observationIds": observation_ids, "wearingDate": date, "stockEventIds": extra_ids})),
    })
}

fn corrupt(target: &str) -> CmdError {
    CmdError::with("internal", "the stored undo data of that action does not match the wardrobe's journal; nothing was written", json!({"retryable": false, "commandId": target}))
}

/// The undo of `wear.record`: each report this command made is withdrawn. Where it was the only
/// report of that wear, the counted wear and the unit it consumed are withdrawn too (the counted
/// wear is one record, kept while any report of it stands); where another report of the same wear
/// stands, only this report is.
///
/// Further units follow one rule: the undo voids exactly the increments this command journaled and
/// nothing else; it never consolidates, re-times or recreates a surviving event. It is refused
/// with `conflict`, writing nothing, when that would leave a report still standing with a total
/// the remaining increments no longer cover (undo that report first), or would change what any
/// other record moved, took back from the laundry or repaired (a later wear that consumed a unit,
/// a pickup that collected the worn shirt).
pub fn undo_record(ctx: &Ctx<'_>, ledger: &mut Ledger, original: &StoredCommand, data: &Value, target: &str) -> Result<Plan, CmdError> {
    let date = data["wearingDate"].as_str().unwrap_or_default().to_string();
    let named_obs: BTreeSet<&str> = data["observationIds"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let own_obs: BTreeSet<&str> = ledger.observations.iter().filter(|o| o.command_id == target).map(|o| o.id.as_str()).collect();
    let named_extra: BTreeSet<&str> = data["stockEventIds"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let own_extra: BTreeSet<&str> = ledger.events.iter().filter(|e| e.command_id == target && e.kind == "extra_unit").map(|e| e.id.as_str()).collect();
    let dates_match = ledger.observations.iter().filter(|o| o.command_id == target).all(|o| o.wearing_date == date);
    if named_obs.is_empty() || named_obs != own_obs || named_extra != own_extra || !dates_match {
        return Err(corrupt(target));
    }
    let named_obs: Vec<String> = named_obs.into_iter().map(str::to_string).collect();
    let named_extra: Vec<String> = named_extra.into_iter().map(str::to_string).collect();

    let before = replay(ctx.cat, &ledger.events);
    let mut voided_ids: Vec<String> = Vec::new();
    let mut touched: BTreeSet<String> = BTreeSet::new();
    let mut withdrawn = 0usize;
    for id in &named_obs {
        let Some(i) = ledger.observations.iter().position(|o| &o.id == id) else { continue };
        if ledger.observations[i].retracted_by.is_some() {
            continue;
        }
        let g = ledger.observations[i].garment_id.clone();
        let standing = ledger.active_reports(&g, &date);
        ledger.observations[i].retracted_by = Some(ctx.command_id.to_string());
        touched.insert(g.clone());
        if standing > 1 {
            // Another report of the same wear stands; only this report is withdrawn.
            continue;
        }
        let Some(w) = ledger.wears.iter_mut().find(|w| w.garment_id == g && w.wearing_date == date && w.active) else { continue };
        // This was the only report of that wear: the counted wear and its stock effect are withdrawn.
        w.active = false;
        let event = w.stock_event_id.clone();
        withdrawn += 1;
        if let Some(e) = ledger.events.iter_mut().find(|e| e.id == event && e.voided_by.is_none()) {
            e.voided_by = Some(ctx.command_id.to_string());
            voided_ids.push(event);
        }
    }
    // Further units: exactly this command's own increments are voided.
    for e in ledger.events.iter_mut().filter(|e| named_extra.contains(&e.id) && e.voided_by.is_none()) {
        e.voided_by = Some(ctx.command_id.to_string());
        touched.insert(e.garment_id.clone());
        voided_ids.push(e.id.clone());
    }
    // A report still standing that gives a total the remaining increments do not cover relies on them.
    let mut extra_garments: BTreeSet<String> = ledger.events.iter().filter(|e| named_extra.contains(&e.id)).map(|e| e.garment_id.clone()).collect();
    extra_garments.extend(ledger.observations.iter().filter(|o| o.command_id == target).map(|o| o.garment_id.clone()));
    for g in &extra_garments {
        let needed = ledger.reported_additional(g, &date);
        let have: u32 = ledger
            .events
            .iter()
            .filter(|e| e.kind == "extra_unit" && e.voided_by.is_none() && e.garment_id == *g && e.wearing_date.as_deref() == Some(date.as_str()))
            .map(|e| e.quantity)
            .sum();
        if have < needed {
            return Err(CmdError::with(
                "conflict",
                format!("another report still standing says {needed} further unit{} of {} {} used on {date}, and this report recorded them; undo that report first; nothing was written", if needed == 1 { "" } else { "s" }, name(ctx.cat, g), if needed == 1 { "was" } else { "were" }),
                json!({"commandId": target, "garmentId": g}),
            ));
        }
    }
    let after = replay(ctx.cat, &ledger.events);
    let voided = Voided { before, after, touched };
    let changed = others_changed(ctx, ledger, &json!({"stockEventIds": voided_ids}), &voided);
    if !changed.is_empty() {
        return Err(CmdError::with(
            "conflict",
            format!("something recorded since relies on that wear ({}), such as a later wear or a laundry pickup that used the piece. The record stays; undo that first or correct it instead; nothing was written", name_list(&changed)),
            json!({"commandId": target}),
        ));
    }
    let mut affected = affected(ledger, &voided.touched);
    affected.extend(bump_changed_batches(ledger, &voided.before, &voided.after));
    let _ = original;
    Ok(Plan {
        outcome: "committed",
        summary: format!("Wear record for {date} undone ({withdrawn} counted wear{} withdrawn)", if withdrawn == 1 { "" } else { "s" }),
        affected,
        repairs: voided.after.new_repairs_since(&voided.before),
        result: json!({"undoneCommandId": target}),
        undo: Err(WEAR_UNDO_NOT_UNDOABLE.to_string()),
    })
}

// ───────────────────────────── reads ─────────────────────────────

/// The garments counted as worn on a date, ordered by category and name (as `getDailyRecord`).
fn counted_on<'c>(cat: &'c Catalogue, ledger: &Ledger, date: &str) -> Vec<&'c crate::seed::Garment> {
    let mut list: Vec<&crate::seed::Garment> = ledger.wears.iter().filter(|w| w.active && w.wearing_date == date).filter_map(|w| cat.get(&w.garment_id)).collect();
    list.sort_by(|a, b| (a.category.as_str(), a.name.as_str()).cmp(&(b.category.as_str(), b.name.as_str())));
    list
}

/// `TodayView.dayRecord`: the garments recorded as worn that day, as board lines.
pub fn day_record(cat: &Catalogue, ledger: &Ledger, date: &str) -> Vec<Value> {
    counted_on(cat, ledger, date).into_iter().map(|g| board::line(cat, g.roles.first().map_or("accessory", String::as_str), &g.id)).collect()
}

/// `DailyRecord`: what was recorded as worn on a date, the counted garments and every report kept.
pub fn daily_record(cat: &Catalogue, ledger: &Ledger, date: &str) -> Value {
    let reports: Vec<&Observation> = ledger.observations.iter().filter(|o| o.wearing_date == date).collect();
    let garments: Vec<Value> = counted_on(cat, ledger, date)
        .into_iter()
        .map(|g| {
            let mut segments: Vec<String> = Vec::new();
            for o in reports.iter().filter(|o| o.garment_id == g.id && o.retracted_by.is_none()) {
                if let Some(s) = &o.segment {
                    if !segments.contains(s) {
                        segments.push(s.clone());
                    }
                }
            }
            json!({"garmentId": g.id, "name": g.name, "observationCount": ledger.active_reports(&g.id, date), "segments": segments})
        })
        .collect();
    let observations: Vec<Value> = reports
        .iter()
        .map(|o| {
            let mut m = Map::new();
            m.insert("observationId".into(), json!(o.id));
            m.insert("garmentId".into(), json!(o.garment_id));
            m.insert("wearingDate".into(), json!(o.wearing_date));
            m.insert("occurredAt".into(), json!(instant(o.occurred_at_ms)));
            m.insert("reportedAt".into(), json!(instant(o.reported_at_ms)));
            m.insert("timezone".into(), json!(o.timezone));
            m.insert("channel".into(), json!(o.channel));
            m.insert("segment".into(), json!(o.segment));
            m.insert("status".into(), json!(if o.retracted_by.is_some() { "retracted" } else { "active" }));
            m.insert("commandId".into(), json!(o.command_id));
            Value::Object(m)
        })
        .collect();
    json!({"wearingDate": date, "garments": garments, "observations": observations})
}

/// Counted wears from `from` to `to` inclusive (as `listCountedWears`), optionally of one garment.
pub fn counted_wears(ledger: &Ledger, from: &str, to: &str, garment: Option<&str>) -> Vec<Value> {
    let mut list: Vec<&Wear> = ledger.wears.iter().filter(|w| w.active && w.wearing_date.as_str() >= from && w.wearing_date.as_str() <= to && garment.map_or(true, |g| w.garment_id == g)).collect();
    list.sort_by(|a, b| (a.wearing_date.as_str(), a.garment_id.as_str()).cmp(&(b.wearing_date.as_str(), b.garment_id.as_str())));
    list.into_iter().map(|w| json!({"garmentId": w.garment_id, "wearingDate": w.wearing_date, "observationCount": ledger.active_reports(&w.garment_id, &w.wearing_date)})).collect()
}
