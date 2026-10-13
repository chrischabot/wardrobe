//! Packing for a trip, ported from packages/domain (handlers/garments.ts, `stock.pack` and
//! `stock.unpack`) and the packed list of a trip read (`readTrip` in packages/daily/src/trips.ts).
//!
//! What is packed is what the owner says he packed: an owner observation that applies at once with a
//! receipt and an undo (2026-10-05 contract). A packing proposal is never packed. Packing is accepted
//! only for a trip that is still planned (the TypeScript entity check registered by the trips
//! workstream, adversarial defect L13-1); unpacking needs no trip check, and it brings a laundered
//! piece home awaiting care, never declared clean. The stock rules are those of `ledger::replay`.

use std::collections::{BTreeMap, BTreeSet};

use ferrite_app::serde_json::{json, Value};

use crate::canonical::whole;
use crate::ledger::{affected, bump_changed_batches, invalid, items, journal, load, name_list, only_keys, other_bags_changed, replay, CmdError, Ctx, Ledger, Plan, Replay, MAX_ITEMS, MAX_QUANTITY};
use crate::seed::Catalogue;
use crate::trips::Trip;

pub const PACK: &str = "stock.pack";
pub const UNPACK: &str = "stock.unpack";
/// The payload fields `stock.pack` and `stock.unpack` accept, published by `GET /v1/command-types`.
pub const PACK_FIELDS: &[&str] = &["tripId", "items"];
pub const UNPACK_FIELDS: &[&str] = &["tripId", "items"];
/// The longest trip ID a packing report may name (a trip record's ID is at most 64 characters).
pub const MAX_TRIP_ID: usize = 128;
const NOTHING_CHANGED: &str = "nothing changed";

/// A `stock.pack` payload, validated: the trip and each garment with the units packed (default 1).
pub struct PackInput {
    pub trip_id: String,
    pub items: Vec<(String, u32)>,
}

/// A `stock.unpack` payload, validated: the trip and, when named, each garment with the units
/// unpacked (`None`: every unit of it packed for the trip). Without `items`, everything packed for the
/// trip is unpacked.
pub struct UnpackInput {
    pub trip_id: String,
    pub items: Option<Vec<(String, Option<u32>)>>,
}

fn trip_id(cmd: &str, payload: &Value) -> Result<String, CmdError> {
    match payload.get("tripId") {
        Some(Value::String(s)) if !s.is_empty() && s.chars().count() <= MAX_TRIP_ID => Ok(s.clone()),
        Some(Value::String(s)) if !s.is_empty() => Err(invalid(cmd, format!("tripId: at most {MAX_TRIP_ID} characters"))),
        _ => Err(invalid(cmd, "tripId: expected a trip ID")),
    }
}

pub fn parse_pack(payload: &Value) -> Result<PackInput, CmdError> {
    only_keys(payload, PACK, PACK_FIELDS)?;
    let trip_id = trip_id(PACK, payload)?;
    Ok(PackInput { trip_id, items: items(payload, PACK)? })
}

pub fn parse_unpack(payload: &Value) -> Result<UnpackInput, CmdError> {
    only_keys(payload, UNPACK, UNPACK_FIELDS)?;
    let trip_id = trip_id(UNPACK, payload)?;
    // An optional field is absent or set; an explicit null is not "absent", so it is refused.
    let items = match payload.get("items") {
        None => None,
        Some(Value::Array(a)) if a.len() <= MAX_ITEMS => {
            let mut out = Vec::new();
            for (i, item) in a.iter().enumerate() {
                let Some(obj) = item.as_object() else { return Err(invalid(UNPACK, format!("items[{i}]: expected an object"))) };
                let id = match obj.get("garmentId").and_then(Value::as_str) {
                    Some(s) if !s.is_empty() && s.len() <= 64 => s.to_string(),
                    _ => return Err(invalid(UNPACK, format!("items[{i}].garmentId: expected a garment ID (1 to 64 characters)"))),
                };
                let q = match obj.get("quantity") {
                    None => None,
                    Some(x) => match whole(x) {
                        Some(q) if (1..=MAX_QUANTITY).contains(&q) => Some(q as u32),
                        _ => return Err(invalid(UNPACK, format!("items[{i}].quantity: expected a whole number from 1 to {MAX_QUANTITY}"))),
                    },
                };
                out.push((id, q));
            }
            Some(out)
        }
        Some(Value::Array(_)) => return Err(invalid(UNPACK, format!("items: at most {MAX_ITEMS} entries"))),
        Some(_) => return Err(invalid(UNPACK, "items: expected an array, or leave it out to unpack everything packed for the trip")),
    };
    Ok(UnpackInput { trip_id, items })
}

/// Text that came in with a record (a trip's name), as it appears inside a receipt summary
/// (`quoted` in handlers/common.ts): on one line, its own quotation marks flattened, its length
/// bounded in UTF-16 units, inside typographic quotation marks.
pub fn quoted(value: &str, max: usize) -> String {
    let spaced: String = value.chars().map(|c| if c.is_control() || c == '\u{2028}' || c == '\u{2029}' { ' ' } else { c }).collect();
    let flat: String = spaced.chars().map(|c| if matches!(c, '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' | '\u{00AB}' | '\u{00BB}' | '\u{FF02}' | '"') { '\'' } else { c }).collect();
    let space = |c: char| c.is_whitespace() || c == '\u{FEFF}';
    let clean = flat.split(space).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ");
    if clean.encode_utf16().count() <= max {
        return format!("\u{201C}{clean}\u{201D}");
    }
    let mut cut = String::new();
    let mut units = 0;
    for c in clean.chars() {
        if units + c.len_utf16() > max.saturating_sub(1) {
            break;
        }
        units += c.len_utf16();
        cut.push(c);
    }
    format!("\u{201C}{}\u{2026}\u{201D}", cut.trim_end_matches(space))
}

/// Journal one packing event of this command for the trip and return its ID.
fn journal_trip(ctx: &Ctx<'_>, ledger: &mut Ledger, garment_id: &str, kind: &str, quantity: u32, trip_id: &str) -> String {
    let id = journal(ctx, ledger, garment_id, kind, None, quantity, 0);
    if let Some(e) = ledger.events.last_mut() {
        e.trip_id = Some(trip_id.to_string());
    }
    id
}

/// `stock.pack`: "I packed it for the trip". Refused, writing nothing, for a trip that does not exist
/// (`not_found`, before anything else) or is no longer planned (`precondition_failed`).
pub fn pack(ctx: &Ctx<'_>, ledger: &mut Ledger, trip: Option<&Trip>, input: PackInput) -> Result<Plan, CmdError> {
    let Some(trip) = trip else {
        return Err(CmdError::with("not_found", "nothing was packed: there is no such trip", json!({"tripId": input.trip_id})));
    };
    if trip.status != "planned" {
        let state = if trip.status == "cancelled" { "cancelled" } else { "no longer a planned trip" };
        return Err(CmdError::with("precondition_failed", format!("nothing was packed: {} is {state}", trip.name), json!({"reason": "trip_not_packable", "tripId": input.trip_id})));
    }
    let garments = load(ctx.cat, &input.items.iter().map(|i| i.0.clone()).collect::<Vec<_>>())?;
    let before = replay(ctx.cat, &ledger.events);
    let mut event_ids = Vec::new();
    let mut names = Vec::new();
    let mut touched = BTreeSet::new();
    for ((_, q), g) in input.items.iter().zip(garments.iter()) {
        event_ids.push(journal_trip(ctx, ledger, &g.id, "pack", *q, &input.trip_id));
        names.push(g.name.clone());
        touched.insert(g.id.clone());
    }
    let after = replay(ctx.cat, &ledger.events);
    other_bags_changed(ctx, ledger, &before, &after)?;
    let mut affected = affected(ledger, &touched);
    // A unit the ledger had at the laundry and the owner packed came back out of its bag.
    affected.extend(bump_changed_batches(ledger, &before, &after));
    Ok(Plan {
        outcome: "committed",
        summary: format!("Packed for {}: {}", quoted(&trip.name, 64), name_list(&names)),
        affected,
        repairs: after.new_repairs_since(&before),
        result: json!({"tripId": input.trip_id, "packed": input.items.len()}),
        undo: Ok(json!({"stockEventIds": event_ids})),
    })
}

/// `stock.unpack`: "I unpacked". Without `items`, every garment packed for the trip comes home (by
/// garment ID). A named garment with nothing (or nothing more) packed for the trip is left out and
/// named as such; a report that would bring nothing home is a `noop` with nothing written.
pub fn unpack(ctx: &Ctx<'_>, ledger: &mut Ledger, trip: Option<&Trip>, input: UnpackInput) -> Result<Plan, CmdError> {
    let words = trip.map_or_else(|| "the trip".to_string(), |t| quoted(&t.name, 64));
    let before = replay(ctx.cat, &ledger.events);
    // The suitcase as the unpacking finds it: replay orders events by time, and this command's events
    // come after every recorded event at or before its time (its sequence numbers are the highest).
    let earlier: Vec<_> = ledger.events.iter().filter(|e| e.at_ms <= ctx.occurred_at_ms).cloned().collect();
    let then = replay(ctx.cat, &earlier);
    let explicit = input.items.is_some();
    let requested: Vec<(String, Option<u32>)> = match input.items {
        Some(items) => items,
        None => then.trips.iter().filter(|(_, l)| l.iter().any(|(t, s)| *t == input.trip_id && s.clean + s.dirty > 0)).map(|(g, _)| (g.clone(), None)).collect(),
    };
    let garments = load(ctx.cat, &requested.iter().map(|i| i.0.clone()).collect::<Vec<_>>())?;
    // What each named garment still has in this suitcase, as the items are taken in order.
    let mut left: BTreeMap<String, u32> = BTreeMap::new();
    let mut items = Vec::new();
    let mut absent: Vec<String> = Vec::new();
    for ((_, q), g) in requested.iter().zip(garments.iter()) {
        let have = left.entry(g.id.clone()).or_insert_with(|| {
            let s = then.in_trip(&g.id, &input.trip_id);
            s.clean + s.dirty
        });
        if *have == 0 {
            if !absent.contains(&g.name) {
                absent.push(g.name.clone());
            }
            continue;
        }
        *have -= q.map_or(*have, |q| q.min(*have));
        items.push((g, *q));
    }
    if items.is_empty() {
        let summary = if explicit { format!("Nothing named is packed for {words}: {}", name_list(&absent)) } else { format!("Nothing was packed for {words}") };
        return Ok(Plan { outcome: "noop", summary, affected: vec![], repairs: vec![], result: json!({}), undo: Err(NOTHING_CHANGED.into()) });
    }
    let mut event_ids = Vec::new();
    let mut names = Vec::new();
    let mut touched = BTreeSet::new();
    for (g, q) in &items {
        event_ids.push(journal_trip(ctx, ledger, &g.id, "unpack", q.unwrap_or(0), &input.trip_id));
        names.push(g.name.clone());
        touched.insert(g.id.clone());
    }
    let after = replay(ctx.cat, &ledger.events);
    // By construction each event brings a unit home; a replay that disagrees is not committed.
    if event_ids.iter().any(|id| after.moved.get(id).copied().unwrap_or(0) == 0) {
        return Err(CmdError::with("internal", "the unpacking could not be placed in the record; nothing was written", json!({"retryable": false})));
    }
    other_bags_changed(ctx, ledger, &before, &after)?;
    let mut affected = affected(ledger, &touched);
    affected.extend(bump_changed_batches(ledger, &before, &after));
    let not_packed = if absent.is_empty() { String::new() } else { format!("; nothing (more) packed for it: {}", name_list(&absent)) };
    Ok(Plan {
        outcome: "committed",
        summary: format!("Unpacked from {words}: {}; laundered pieces are awaiting care, not marked clean{not_packed}", name_list(&names)),
        affected,
        repairs: after.new_repairs_since(&before),
        result: json!({"tripId": input.trip_id, "unpacked": items.len()}),
        undo: Ok(json!({"stockEventIds": event_ids})),
    })
}

/// The trip's `packed` list (`readTrip`): each garment packed for it, by name (SQLite's binary
/// order) then ID, with its clean units and those already worn or packed while awaiting care.
pub fn packed(cat: &Catalogue, r: &Replay, trip_id: &str) -> Vec<Value> {
    let mut rows: Vec<(&str, &str, u32, u32)> = cat
        .garments
        .iter()
        .filter_map(|g| {
            let s = r.in_trip(&g.id, trip_id);
            (s.clean + s.dirty > 0).then_some((g.name.as_str(), g.id.as_str(), s.clean, s.dirty))
        })
        .collect();
    rows.sort_by(|a, b| a.0.cmp(b.0).then_with(|| a.1.cmp(b.1)));
    rows.into_iter().map(|(name, id, clean, worn)| json!({"garmentId": id, "name": name, "clean": clean, "worn": worn})).collect()
}

#[cfg(test)]
mod tests {
    use super::quoted;

    #[test]
    fn quoted_flattens_and_bounds_like_the_typescript_helper() {
        assert_eq!(quoted("Lisbon", 64), "\u{201C}Lisbon\u{201D}");
        assert_eq!(quoted("  The \u{201C}big\u{201D}\n trip ", 64), "\u{201C}The 'big' trip\u{201D}");
        assert_eq!(quoted("abcdef", 4), "\u{201C}abc\u{2026}\u{201D}");
        assert_eq!(quoted("ab   cdef", 4), "\u{201C}ab\u{2026}\u{201D}");
    }
}
