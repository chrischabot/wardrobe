//! Service laundry, ported from packages/domain (handlers/wear-care.ts):
//! `laundry.collect` (the pickup: what was awaiting the service goes into a
//! batch) and `laundry.return` (the bag is back: the batch's pieces are clean,
//! less the ones the owner names as still away), each with its undo.
//!
//! Both are owner observations: they apply at once with a receipt and an
//! undo, from the owner's app or a connected assistant (routine actions under
//! the 2026-10-05 contract). Quantities are what the replay moved.
//!
//! Not ported: missed-cycle returns, lost-item and delayed exceptions
//! (`laundry.report_exception`), the weekly laundry reset, and wear records
//! (so nothing is held back from collection as "being worn today").

use std::collections::BTreeSet;

use ferrite_app::serde_json::{json, Value};

use crate::canonical::whole;
use crate::ledger::{
    affected, invalid, journal, load, name_list, only_keys, replay, replay_until, undone_summary, void_events, Batch, BatchItem, CmdError, Ctx, Ledger, Plan,
    StoredCommand, ALREADY_AN_UNDO, MAX_BATCHES, MAX_ITEMS, MAX_QUANTITY, UNDO_STOCK_SUMMARY,
};
use crate::time::instant;

const NOTHING_CHANGED: &str = "nothing changed";
/// A bag picked up within this long before a return report is this week's.
const CYCLE_MS: u64 = 5 * 86_400_000;

fn plural(n: u32) -> &'static str {
    if n == 1 { "" } else { "s" }
}

fn noop(summary: impl Into<String>, result: Value) -> Plan {
    Plan { outcome: "noop", summary: summary.into(), affected: vec![], repairs: vec![], result, undo: Err(NOTHING_CHANGED.into()) }
}

fn batch_id_field(p: &Value, cmd: &str) -> Result<Option<String>, CmdError> {
    match p.get("batchId") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') => Ok(Some(s.clone())),
        _ => Err(invalid(cmd, "batchId: expected a batch ID (1 to 64 letters, digits, '_' or '-')")),
    }
}

fn id_list(p: &Value, cmd: &str, field: &str) -> Result<Vec<String>, CmdError> {
    match p.get(field) {
        None | Some(Value::Null) => Ok(vec![]),
        Some(Value::Array(a)) if a.len() <= MAX_ITEMS => a
            .iter()
            .enumerate()
            .map(|(i, x)| match x.as_str() {
                Some(s) if !s.is_empty() && s.len() <= 64 => Ok(s.to_string()),
                _ => Err(invalid(cmd, format!("{field}[{i}]: expected a garment ID"))),
            })
            .collect(),
        _ => Err(invalid(cmd, format!("{field}: expected at most {MAX_ITEMS} garment IDs"))),
    }
}

/// `[{garmentId, quantity}]`; `default` is the quantity when it is left out (`None`: required).
fn quantities(p: &Value, cmd: &str, field: &str, default: Option<u32>) -> Result<Vec<(String, u32)>, CmdError> {
    let list = match p.get(field) {
        None | Some(Value::Null) => return Ok(vec![]),
        Some(Value::Array(a)) if a.len() <= MAX_ITEMS => a,
        _ => return Err(invalid(cmd, format!("{field}: expected at most {MAX_ITEMS} entries"))),
    };
    let mut out: Vec<(String, u32)> = Vec::new();
    for (i, x) in list.iter().enumerate() {
        only_keys(x, cmd, &["garmentId", "quantity"]).map_err(|_| invalid(cmd, format!("{field}[{i}]: expected {{garmentId, quantity}}")))?;
        let id = match x.get("garmentId").and_then(Value::as_str) {
            Some(s) if !s.is_empty() && s.len() <= 64 => s.to_string(),
            _ => return Err(invalid(cmd, format!("{field}[{i}].garmentId: expected a garment ID"))),
        };
        let q = match (x.get("quantity"), default) {
            (None | Some(Value::Null), Some(d)) => d,
            (None | Some(Value::Null), None) => return Err(invalid(cmd, format!("{field}[{i}].quantity: required"))),
            (Some(v), _) => match whole(v) {
                Some(q) if (1..=MAX_QUANTITY).contains(&q) => q as u32,
                _ => return Err(invalid(cmd, format!("{field}[{i}].quantity: expected a whole number from 1 to {MAX_QUANTITY}"))),
            },
        };
        if out.iter().any(|(g, _)| *g == id) {
            return Err(invalid(cmd, format!("{field}[{i}]: that garment is already listed")));
        }
        out.push((id, q));
    }
    Ok(out)
}

/// What was awaiting the laundry service at the time this command observes: the dirty units of
/// service-laundered garments, by name. A back-dated report is sized as things stood then.
fn collectable(ctx: &Ctx<'_>, ledger: &Ledger) -> Vec<(String, String, u32)> {
    let r = replay_until(ctx.cat, &ledger.events, ctx.occurred_at_ms);
    let mut rows: Vec<(String, String, u32)> = ctx
        .cat
        .garments
        .iter()
        .filter(|g| g.care_channel == "service")
        .map(|g| (g.id.clone(), g.name.clone(), r.of(&g.id).dirty))
        .filter(|(_, _, q)| *q > 0)
        .collect();
    rows.sort_by(|a, b| (&a.1, &a.0).cmp(&(&b.1, &b.0)));
    rows
}

fn batch_affected(b: &Batch) -> Value {
    json!({"kind": "laundry_batch", "id": b.batch_id, "version": b.version})
}

/// Keep at most [`MAX_BATCHES`]: the oldest closed batches make room; open ones are never dropped.
fn make_room(ledger: &mut Ledger) -> Result<(), CmdError> {
    while ledger.batches.len() >= MAX_BATCHES {
        let Some(i) = ledger.batches.iter().position(|b| !b.open()) else {
            return Err(CmdError::new("precondition_failed", format!("{MAX_BATCHES} laundry batches are still out; report the returns of earlier batches first")));
        };
        ledger.batches.remove(i);
    }
    Ok(())
}

/// A batch ID is used once for the life of the wardrobe: a batch dropped from the bounded list
/// keeps its ID through its journaled stock events, which are never removed (a withdrawn pickup's
/// events stay, voided).
fn batch_id_used(ledger: &Ledger, id: &str) -> bool {
    ledger.batch(id).is_some() || ledger.events.iter().any(|e| e.batch_id.as_deref() == Some(id))
}

// Undo is exact or refused: voiding an observation must not change what any other report moved or
// repaired (see `ledger::others_changed`).
use crate::ledger::others_changed as later_reports_changed;

fn relied_on(names: &[String], batch_id: Option<&str>) -> CmdError {
    CmdError::with(
        "not_undoable",
        format!("something has been recorded since that laundry came back ({}), such as a wash report or a later return of the same bag. The return stays in the record; correct the item instead (mark it dirty, or report it still away)", name_list(names)),
        json!({"batchId": batch_id}),
    )
}

// Batches record what their pickups and returns moved: an observation dated earlier that would change
// another bag's record is refused (see `ledger::other_bags_changed`).
use crate::ledger::other_bags_changed;

/// `laundry.collect`: the service picked up the laundry.
pub fn collect(ctx: &Ctx<'_>, ledger: &mut Ledger, p: &Value) -> Result<Plan, CmdError> {
    const T: &str = "laundry.collect";
    only_keys(p, T, &["batchId", "exclude", "include"])?;
    let asked_batch = batch_id_field(p, T)?;
    if asked_batch.as_deref().map_or(false, |id| id.starts_with("lb_")) {
        return Err(invalid(T, "batchId: IDs starting with 'lb_' are made by the app; choose another"));
    }
    let exclude = id_list(p, T, "exclude")?;
    let include = quantities(p, T, "include", None)?;
    let included = load(ctx.cat, &include.iter().map(|(g, _)| g.clone()).collect::<Vec<_>>())?;
    if let Some(g) = included.iter().find(|g| g.care_channel != "service") {
        return Err(CmdError::with("precondition_failed", format!("{} does not go to the laundry service", g.name), json!({"garmentId": g.id})));
    }
    let mut picked: Vec<(String, u32)> = collectable(ctx, ledger).into_iter().filter(|(id, _, _)| !exclude.contains(id)).map(|(id, _, q)| (id, q)).collect();
    for (id, q) in &include {
        match picked.iter_mut().find(|(g, _)| g == id) {
            Some(x) => x.1 = *q,
            None => picked.push((id.clone(), *q)),
        }
    }
    let empty = json!({"batchId": null, "units": 0, "members": []});
    if picked.is_empty() {
        return Ok(noop("Nothing was awaiting collection", empty));
    }
    let batch_id = match asked_batch {
        Some(id) if batch_id_used(ledger, &id) => return Err(CmdError::with("precondition_failed", "that laundry batch ID is already in use", json!({"batchId": id}))),
        Some(id) => id,
        None => {
            // Generated IDs live under `lb_`, which an owner-supplied ID may not use, and are checked
            // against every ID ever used all the same.
            let stem = format!("lb_{}", ctx.command_id.trim_start_matches("cmd_").chars().take(24).collect::<String>());
            let mut id = stem.clone();
            let mut n = 1;
            while batch_id_used(ledger, &id) {
                n += 1;
                id = format!("{stem}_{n}");
            }
            id
        }
    };
    let before = replay(ctx.cat, &ledger.events);
    let events: Vec<(String, String)> = picked.iter().map(|(g, q)| (g.clone(), journal(ctx, ledger, g, "pickup", Some(&batch_id), *q, 0))).collect();
    let after = replay(ctx.cat, &ledger.events);
    other_bags_changed(ctx, ledger, &before, &after)?;
    let mut members = Vec::new();
    let mut units = 0;
    for (g, eid) in &events {
        let moved = after.moved.get(eid).copied().unwrap_or(0);
        if moved > 0 {
            units += moved;
            members.push(BatchItem { garment_id: g.clone(), quantity: moved, returned: 0, still_away: 0 });
        }
    }
    if units == 0 {
        // Nothing was in the hamper to collect at the time given: nothing is journaled.
        ledger.events.retain(|e| e.command_id != ctx.command_id);
        return Ok(noop("Nothing was awaiting collection", empty));
    }
    make_room(ledger)?;
    let touched: BTreeSet<String> = members.iter().map(|m| m.garment_id.clone()).collect();
    // Events that moved nothing are not part of the batch, and are not journaled.
    let kept: Vec<String> = events.iter().filter(|(g, _)| touched.contains(g)).map(|(_, e)| e.clone()).collect();
    ledger.events.retain(|e| e.command_id != ctx.command_id || kept.contains(&e.id));
    let batch = Batch {
        batch_id: batch_id.clone(),
        status: "collected".into(),
        picked_up_at_ms: ctx.occurred_at_ms,
        returned_at_ms: None,
        command_id: ctx.command_id.to_string(),
        withdrawn_by: None,
        version: 1,
        items: members.clone(),
    };
    let mut affected = affected(ledger, &touched);
    affected.push(batch_affected(&batch));
    ledger.batches.push(batch);
    Ok(Plan {
        outcome: "committed",
        summary: format!("Laundry collected: {units} item{} in the batch", plural(units)),
        affected,
        repairs: after.new_repairs_since(&before),
        result: json!({"batchId": batch_id, "units": units, "members": members.iter().map(|m| json!({"garmentId": m.garment_id, "quantity": m.quantity})).collect::<Vec<_>>()}),
        undo: Ok(json!({"stockEventIds": kept, "batchId": batch_id})),
    })
}

/// The undo of a pickup: withdrawn while the batch is still out; once it is back, the return is corrected instead.
pub fn undo_collect(ctx: &Ctx<'_>, ledger: &mut Ledger, original: &StoredCommand, data: &Value, target: &str) -> Result<Plan, CmdError> {
    let batch_id = data["batchId"].as_str().unwrap_or_default().to_string();
    match ledger.batch(&batch_id) {
        Some(b) if b.withdrawn_by.is_none() && b.status == "collected" => {}
        Some(b) if b.withdrawn_by.is_none() => {
            return Err(CmdError::with(
                "not_undoable",
                "that laundry has already come back; report what is wrong with the return instead (an item still away, or mark an item dirty)",
                json!({"batchId": batch_id, "status": b.status}),
            ))
        }
        _ => return Err(CmdError::with("not_undoable", "that pickup is no longer on record as an open batch", json!({"batchId": batch_id}))),
    }
    let voided = void_events(ctx, ledger, data, target)?;
    // Withdrawing it must not reinterpret another bag or report (for example a back-dated pickup
    // into this bag that left another bag's pickup collecting nothing).
    let changed = later_reports_changed(ctx, ledger, data, &voided);
    if !changed.is_empty() {
        return Err(CmdError::with(
            "not_undoable",
            format!("another record relies on this pickup ({}), such as another bag's pickup or a later report. The pickup stays in the record; report the return instead; nothing was written", name_list(&changed)),
            json!({"batchId": batch_id}),
        ));
    }
    let mut affected = affected(ledger, &voided.touched);
    let b = ledger.batch_mut(&batch_id).expect("batch checked above");
    b.withdrawn_by = Some(ctx.command_id.to_string());
    b.version += 1;
    affected.push(batch_affected(b));
    Ok(Plan {
        outcome: "committed",
        summary: undone_summary(&original.summary, "Laundry pickup withdrawn; the items are awaiting collection again"),
        affected,
        repairs: voided.after.new_repairs_since(&voided.before),
        result: json!({"undoneCommandId": target}),
        undo: Err(ALREADY_AN_UNDO.into()),
    })
}

/// `laundry.return`: the laundry is back. Completes the returning batch (the named one, or the oldest
/// one still out), less what the owner names as still away; with no batch on record, the owner's word
/// stands and what was awaiting the service is clean.
pub fn return_batch(ctx: &Ctx<'_>, ledger: &mut Ledger, p: &Value) -> Result<Plan, CmdError> {
    const T: &str = "laundry.return";
    only_keys(p, T, &["batchId", "stillAway"])?;
    let asked_batch = batch_id_field(p, T)?;
    let still_away = quantities(p, T, "stillAway", Some(1))?;
    load(ctx.cat, &still_away.iter().map(|(g, _)| g.clone()).collect::<Vec<_>>())?;
    let batch = match &asked_batch {
        Some(id) => Some(ledger.batches.iter().find(|b| &b.batch_id == id && b.withdrawn_by.is_none()).cloned().ok_or_else(|| CmdError::new("not_found", format!("no laundry batch '{id}'")))?),
        // The bag that was out at the time given (oldest first): one still out, or one recorded
        // back since (refused below: a return is never dated before the bag's last return). With
        // none, the oldest bag still out (refused below if it was collected after that time).
        None => {
            let at = ctx.occurred_at_ms;
            let out_then = |b: &&Batch| b.withdrawn_by.is_none() && b.picked_up_at_ms <= at && (b.open() || b.returned_at_ms.map_or(false, |r| r > at));
            ledger
                .batches
                .iter()
                .filter(out_then)
                .min_by_key(|b| (b.picked_up_at_ms, b.batch_id.clone()))
                .or_else(|| ledger.batches.iter().filter(|b| b.open()).min_by_key(|b| (b.picked_up_at_ms, b.batch_id.clone())))
                .cloned()
        }
    };
    let before = replay(ctx.cat, &ledger.events);
    let Some(batch) = batch else { return return_without_batch(ctx, ledger, &still_away, before) };
    // A bag cannot come back before it was collected.
    if ctx.occurred_at_ms < batch.picked_up_at_ms {
        return Err(CmdError::with(
            "invalid_command",
            "the time given for this return is before the bag was collected; leave the time out or give one after the pickup",
            json!({"reason": "return_before_pickup", "batchId": batch.batch_id, "pickedUpAt": instant(batch.picked_up_at_ms), "occurredAt": instant(ctx.occurred_at_ms)}),
        ));
    }
    // Returns of one bag are recorded in time order, so the batch's record (what has come back) is
    // what it was at the time given. A return dated before the last one is refused; undo that one
    // first if its time was wrong.
    if let Some(last) = batch.returned_at_ms.filter(|r| ctx.occurred_at_ms < *r) {
        return Err(CmdError::with(
            "invalid_command",
            "this bag is already recorded as back at a later time; a return cannot be dated before that. If that time is wrong, undo that return first",
            json!({"reason": "return_before_last_return", "batchId": batch.batch_id, "returnedAt": instant(last), "occurredAt": instant(ctx.occurred_at_ms)}),
        ));
    }
    if batch.status == "returned" {
        return Ok(noop("That batch was already returned", json!({"batchId": batch.batch_id, "returned": 0, "stillAway": 0})));
    }
    if let Some((g, _)) = still_away.iter().find(|(g, _)| !batch.items.iter().any(|i| &i.garment_id == g)) {
        return Err(CmdError::with("precondition_failed", "an item named as still away was not in this batch; nothing was written", json!({"garmentId": g, "batchId": batch.batch_id})));
    }
    // Planned against the batch's record, counted from what the replay moved: a unit another report
    // already accounted for is no longer in the bag and is not claimed to have come back. The bag's
    // contents are read as they were at the time of the return, so a back-dated return still counts a
    // unit a later report took out of the bag.
    let at = replay_until(ctx.cat, &ledger.events, ctx.occurred_at_ms);
    let mut planned: Vec<(BatchItem, u32, u32, String)> = Vec::new();
    for item in &batch.items {
        let outstanding = item.quantity.saturating_sub(item.returned);
        if outstanding == 0 {
            continue;
        }
        let asked = still_away.iter().find(|(g, _)| *g == item.garment_id).map_or(0, |(_, q)| *q);
        let away = asked.min(outstanding);
        // A unit named as still away is taken from what the bag holds first.
        let back = outstanding.min(at.held_in(&item.garment_id, &batch.batch_id)).saturating_sub(away);
        let eid = journal(ctx, ledger, &item.garment_id, "return", Some(&batch.batch_id), back, away);
        planned.push((item.clone(), outstanding, away, eid));
    }
    let after = replay(ctx.cat, &ledger.events);
    other_bags_changed(ctx, ledger, &before, &after)?;
    let at_after = replay_until(ctx.cat, &ledger.events, ctx.occurred_at_ms);
    let (mut returned, mut away_total) = (0u32, 0u32);
    let mut away_names = Vec::new();
    let mut notes = Vec::new();
    let mut undo_items = Vec::new();
    let mut next_items = batch.items.clone();
    let mut touched = BTreeSet::new();
    for (item, outstanding, away_asked, eid) in &planned {
        let name = ctx.cat.get(&item.garment_id).map_or_else(|| item.garment_id.clone(), |g| g.name.clone());
        let held_before = before.held_in(&item.garment_id, &batch.batch_id);
        let back = after.moved.get(eid).copied().unwrap_or(0);
        let away = (*away_asked).min(at_after.held_in(&item.garment_id, &batch.batch_id));
        returned += back;
        away_total += away;
        touched.insert(item.garment_id.clone());
        if away > 0 {
            away_names.push(name.clone());
        }
        if outstanding.saturating_sub(back + away) > 0 {
            notes.push(format!("{name}: not counted as returned; another report had already accounted for it, so it was no longer in this bag"));
        }
        let n = next_items.iter_mut().find(|i| i.garment_id == item.garment_id).expect("item of this batch");
        undo_items.push(json!({
            "garmentId": item.garment_id, "returnedBefore": item.returned, "stillAwayBefore": item.still_away,
            "returnedAfter": item.returned + back, "stillAwayAfter": away, "heldBefore": held_before,
        }));
        n.returned = item.returned + back;
        n.still_away = away;
    }
    let status = if away_total > 0 { "partially_returned" } else { "returned" };
    let mut affected = affected(ledger, &touched);
    let b = ledger.batch_mut(&batch.batch_id).expect("batch read above");
    b.status = status.into();
    b.returned_at_ms = Some(ctx.occurred_at_ms);
    b.items = next_items;
    b.version += 1;
    affected.push(batch_affected(b));
    let mut summary = if returned > 0 { format!("Laundry returned: {returned} item{} clean", plural(returned)) } else { "Laundry returned: nothing came back clean".to_string() };
    if away_total > 0 {
        summary.push_str(&format!("; still away: {}", name_list(&away_names)));
    }
    let mut repairs = after.new_repairs_since(&before);
    repairs.extend(notes);
    Ok(Plan {
        outcome: "committed",
        summary,
        affected,
        repairs,
        result: json!({"batchId": batch.batch_id, "returned": returned, "stillAway": away_total}),
        undo: Ok(json!({
            "stockEventIds": planned.iter().map(|x| x.3.clone()).collect::<Vec<_>>(),
            "batchId": batch.batch_id,
            "batchBefore": {"status": batch.status, "returnedAt": batch.returned_at_ms.map(instant)},
            "statusAfter": status,
            "returnedAtAfter": instant(ctx.occurred_at_ms),
            "items": undo_items,
        })),
    })
}

/// No batch is out: the same return said again is not a second return; otherwise the owner's word is
/// the physical fact and everything awaiting the service, less what is still away, is clean.
fn return_without_batch(ctx: &Ctx<'_>, ledger: &mut Ledger, still_away: &[(String, u32)], before: crate::ledger::Replay) -> Result<Plan, CmdError> {
    let empty = json!({"batchId": null, "returned": 0, "stillAway": 0});
    let at = ctx.occurred_at_ms;
    let already = ledger.batches.iter().any(|b| b.withdrawn_by.is_none() && b.status == "returned" && b.picked_up_at_ms <= at && b.picked_up_at_ms + CYCLE_MS > at);
    if already {
        return Ok(noop("That laundry is already recorded as back; anything put in the hamper since the pickup is still awaiting the service", empty));
    }
    let mut events = Vec::new();
    for (g, _, dirty) in collectable(ctx, ledger) {
        let away = still_away.iter().find(|(x, _)| *x == g).map_or(0, |(_, q)| *q);
        let q = dirty.saturating_sub(away);
        if q > 0 {
            events.push((g.clone(), journal(ctx, ledger, &g, "wash", None, q, 0)));
        }
    }
    if events.is_empty() {
        return Ok(noop("No laundry was recorded as away or awaiting the service", empty));
    }
    let after = replay(ctx.cat, &ledger.events);
    other_bags_changed(ctx, ledger, &before, &after)?;
    let moved: u32 = events.iter().map(|(_, e)| after.moved.get(e).copied().unwrap_or(0)).sum();
    if moved == 0 {
        ledger.events.retain(|e| e.command_id != ctx.command_id);
        return Ok(noop("Nothing came back clean: at the time given for this return nothing was awaiting the service", empty));
    }
    let touched: BTreeSet<String> = events.iter().map(|(g, _)| g.clone()).collect();
    let affected = affected(ledger, &touched);
    Ok(Plan {
        outcome: "committed",
        summary: format!("Laundry returned: {moved} item{} clean (no pickup had been recorded; your report stands)", plural(moved)),
        affected,
        repairs: after.new_repairs_since(&before),
        result: json!({"batchId": null, "returned": moved, "stillAway": 0}),
        undo: Ok(json!({"stockEventIds": events.iter().map(|(_, e)| e.clone()).collect::<Vec<_>>()})),
    })
}

/// The undo of a return: withdrawn exactly or not at all. With a batch, every item must be held by the
/// batch again as it was before the return once its events are voided; anything recorded since that
/// speaks for one of those units (a wash report, a later return) keeps the return in the record.
pub fn undo_return(ctx: &Ctx<'_>, ledger: &mut Ledger, original: &StoredCommand, data: &Value, target: &str) -> Result<Plan, CmdError> {
    let Some(batch_id) = data.get("batchId").and_then(Value::as_str).map(str::to_string) else {
        let voided = void_events(ctx, ledger, data, target)?;
        let changed = later_reports_changed(ctx, ledger, data, &voided);
        if !changed.is_empty() {
            return Err(relied_on(&changed, None));
        }
        let affected = affected(ledger, &voided.touched);
        return Ok(Plan {
            outcome: "committed",
            summary: undone_summary(&original.summary, UNDO_STOCK_SUMMARY),
            affected,
            repairs: voided.after.new_repairs_since(&voided.before),
            result: json!({"undoneCommandId": target}),
            undo: Err(ALREADY_AN_UNDO.into()),
        });
    };
    let Some(batch) = ledger.batches.iter().find(|b| b.batch_id == batch_id && b.withdrawn_by.is_none()).cloned() else {
        return Err(CmdError::with("not_undoable", "that laundry batch is no longer on record", json!({"batchId": batch_id})));
    };
    let items = data["items"].as_array().cloned().unwrap_or_default();
    let n = |v: &Value, k: &str| v[k].as_u64().unwrap_or(0) as u32;
    // The batch is exactly as the return left it.
    let unchanged = Some(batch.status.as_str()) == data["statusAfter"].as_str()
        && batch.returned_at_ms.map(instant).as_deref() == data["returnedAtAfter"].as_str()
        && items.iter().all(|i| batch.items.iter().any(|b| Some(b.garment_id.as_str()) == i["garmentId"].as_str() && b.returned == n(i, "returnedAfter") && b.still_away == n(i, "stillAwayAfter")));
    if !unchanged {
        return Err(CmdError::with("conflict", "that laundry batch has changed since it was returned; nothing was written", json!({"batchId": batch_id})));
    }
    let voided = void_events(ctx, ledger, data, target)?;
    let mut moved: Vec<String> = items
        .iter()
        .filter(|i| voided.after.held_in(i["garmentId"].as_str().unwrap_or_default(), &batch_id) != n(i, "heldBefore"))
        .map(|i| ctx.cat.get(i["garmentId"].as_str().unwrap_or_default()).map_or_else(|| i["garmentId"].to_string(), |g| g.name.clone()))
        .collect();
    for name in later_reports_changed(ctx, ledger, data, &voided) {
        if !moved.contains(&name) {
            moved.push(name);
        }
    }
    if !moved.is_empty() {
        return Err(relied_on(&moved, Some(&batch_id)));
    }
    let mut affected = affected(ledger, &voided.touched);
    let b = ledger.batch_mut(&batch_id).expect("batch read above");
    b.status = data["batchBefore"]["status"].as_str().unwrap_or("collected").to_string();
    b.returned_at_ms = data["batchBefore"]["returnedAt"].as_str().and_then(crate::time::parse_instant);
    for i in &items {
        if let Some(x) = b.items.iter_mut().find(|x| Some(x.garment_id.as_str()) == i["garmentId"].as_str()) {
            x.returned = n(i, "returnedBefore");
            x.still_away = n(i, "stillAwayBefore");
        }
    }
    b.version += 1;
    affected.push(batch_affected(b));
    Ok(Plan {
        outcome: "committed",
        summary: undone_summary(&original.summary, UNDO_STOCK_SUMMARY),
        affected,
        repairs: voided.after.new_repairs_since(&voided.before),
        result: json!({"undoneCommandId": target}),
        undo: Err(ALREADY_AN_UNDO.into()),
    })
}
