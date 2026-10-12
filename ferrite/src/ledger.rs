//! The stock ledger and the one command of the first slice, ported from
//! packages/domain (stock/replay.ts, handlers/wear-care.ts, handlers/undo.ts):
//! `care.mark_dirty` ("it is in the wash", an owner observation) and the
//! `command.undo` that takes it back.
//!
//! Quantities are never stored directly: each garment's balances are the
//! replay of its journaled events over the imported baseline (every owned
//! unit clean), so an undo voids its command's events and replays, as the
//! TypeScript `StockPlanner` does. What a command reports is what the replay
//! moved, not what was asked for.
//!
//! Everything here is pure: `crate::api` reads the stored ledger, runs a plan
//! on a draft copy and commits the draft with the receipt in one guarded write.

use std::collections::{BTreeMap, BTreeSet};

use ferrite_app::serde_json::{json, Map, Value};

use crate::canonical::whole;
use crate::seed::{Catalogue, Garment};

/// Receipt text for an undone stock command (`UNDO_STOCK_SUMMARY` in handlers/common.ts).
pub const UNDO_STOCK_SUMMARY: &str = "The quantities are as they were before";
const ALREADY_AN_UNDO: &str = "this is already an undo; repeat the original action instead";
/// Bounds this port applies to a command payload's lists (the TypeScript
/// contracts leave them to the 4 MB body limit, which Ferrite does not have).
pub const MAX_ITEMS: usize = 200;
pub const MAX_QUANTITY: u64 = 999;
/// Command IDs kept in the ledger's recent list, newest first.
pub const RECENT_LIMIT: usize = 200;

/// The command types this slice executes. Anything else is `unknown_command`.
pub const COMMAND_TYPES: &[&str] = &["care.mark_dirty", "command.undo"];

// ───────────────────────────── errors ─────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct CmdError {
    pub code: &'static str,
    pub message: String,
    pub details: Value,
}

impl CmdError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        CmdError { code, message: message.into(), details: json!({}) }
    }
    pub fn with(code: &'static str, message: impl Into<String>, details: Value) -> Self {
        CmdError { code, message: message.into(), details }
    }
}

// ───────────────────────────── records ─────────────────────────────

/// One journaled "dirty" observation of a garment.
#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub id: String,
    pub garment_id: String,
    pub quantity: u32,
    pub at_ms: u64,
    pub seq: u64,
    pub command_id: String,
    pub voided_by: Option<String>,
}

/// The owner's whole mutable state for this slice: one record, committed
/// atomically with every command's receipt.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Ledger {
    pub revision: u64,
    pub next_seq: u64,
    pub events: Vec<Event>,
    /// Garment versions, keyed `garment:<id>`; a garment absent here is at
    /// version 1 (as created by the import).
    pub versions: BTreeMap<String, u64>,
    /// Command IDs, newest first, at most [`RECENT_LIMIT`].
    pub recent: Vec<String>,
}

fn arr<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v.get(k).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

impl Ledger {
    pub fn to_json(&self) -> Value {
        json!({
            "v": 1,
            "revision": self.revision,
            "nextSeq": self.next_seq,
            "events": self.events.iter().map(|e| json!({
                "id": e.id, "garmentId": e.garment_id, "quantity": e.quantity, "atMs": e.at_ms,
                "seq": e.seq, "commandId": e.command_id, "voidedBy": e.voided_by,
            })).collect::<Vec<_>>(),
            "versions": self.versions,
            "recent": self.recent,
        })
    }

    /// The stored ledger, or `None` when the record is not a ledger this code
    /// wrote: every field present and of its type. A corrupt record is never
    /// read as an empty ledger, so it is never overwritten by the next command.
    pub fn from_json(v: &Value) -> Option<Ledger> {
        fn u(v: &Value, k: &str) -> Option<u64> {
            v.get(k)?.as_u64()
        }
        fn st(v: &Value, k: &str) -> Option<String> {
            v.get(k)?.as_str().map(str::to_string)
        }
        if u(v, "v")? != 1 {
            return None;
        }
        let mut events = Vec::new();
        for e in v.get("events")?.as_array()? {
            let voided_by = match e.get("voidedBy")? {
                Value::Null => None,
                Value::String(by) => Some(by.clone()),
                _ => return None,
            };
            events.push(Event {
                id: st(e, "id")?,
                garment_id: st(e, "garmentId")?,
                quantity: u32::try_from(u(e, "quantity")?).ok()?,
                at_ms: u(e, "atMs")?,
                seq: u(e, "seq")?,
                command_id: st(e, "commandId")?,
                voided_by,
            });
        }
        let mut versions = BTreeMap::new();
        for (k, x) in v.get("versions")?.as_object()? {
            versions.insert(k.clone(), x.as_u64()?);
        }
        let mut recent = Vec::new();
        for x in v.get("recent")?.as_array()? {
            recent.push(x.as_str()?.to_string());
        }
        Some(Ledger { revision: u(v, "revision")?, next_seq: u(v, "nextSeq")?, events, versions, recent })
    }

    pub fn garment_version(&self, id: &str) -> u64 {
        self.versions.get(&format!("garment:{id}")).copied().unwrap_or(1)
    }

    fn bump_garment(&mut self, id: &str) -> u64 {
        let next = self.garment_version(id) + 1;
        self.versions.insert(format!("garment:{id}"), next);
        next
    }

    pub fn record_command(&mut self, command_id: &str) {
        self.recent.insert(0, command_id.to_string());
        self.recent.truncate(RECENT_LIMIT);
    }
}

// ───────────────────────────── replay ─────────────────────────────

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Stock {
    pub clean: u32,
    pub dirty: u32,
}

#[derive(Debug, Clone, Default)]
pub struct Replay {
    pub stock: BTreeMap<String, Stock>,
    /// Units each event moved from clean to dirty.
    pub moved: BTreeMap<String, u32>,
    /// Repairs by the event that needed them, in replay order.
    pub repairs: Vec<(String, String)>,
}

impl Replay {
    pub fn of(&self, garment_id: &str) -> Stock {
        self.stock.get(garment_id).cloned().unwrap_or_default()
    }

    /// The repairs of the given events only.
    pub fn repairs_of(&self, event_ids: &[String]) -> Vec<String> {
        self.repairs.iter().filter(|(id, _)| event_ids.contains(id)).map(|(_, r)| r.clone()).collect()
    }

    /// Repairs this replay needs that `before` did not: what a change itself
    /// caused, including repairs a back-dated event forces on a later one.
    pub fn new_repairs_since(&self, before: &Replay) -> Vec<String> {
        self.repairs.iter().filter(|r| !before.repairs.contains(r)).map(|(_, r)| r.clone()).collect()
    }
}

/// Replay every unvoided event, in the order the events happened, over the
/// imported baseline (every owned unit clean, as the importer records them).
pub fn replay(cat: &Catalogue, events: &[Event]) -> Replay {
    let mut out = Replay::default();
    for g in &cat.garments {
        out.stock.insert(g.id.clone(), Stock { clean: g.quantity, dirty: 0 });
    }
    let mut ordered: Vec<&Event> = events.iter().filter(|e| e.voided_by.is_none()).collect();
    ordered.sort_by_key(|e| (e.at_ms, e.seq));
    for e in ordered {
        let (Some(g), Some(st)) = (cat.get(&e.garment_id), out.stock.get_mut(&e.garment_id)) else { continue };
        let q = e.quantity.min(st.clean);
        st.clean -= q;
        st.dirty += q;
        out.moved.insert(e.id.clone(), q);
        if q < e.quantity {
            out.repairs.push((e.id.clone(), format!("{}: no clean unit was left to put in the wash; the count stays at what is owned", g.name)));
        }
    }
    out
}

// ───────────────────────────── planning ─────────────────────────────

/// What a command is about to do, built against a draft of the ledger.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub outcome: &'static str,
    pub summary: String,
    pub affected: Vec<Value>,
    pub repairs: Vec<String>,
    pub result: Value,
    /// `Ok(data)` when the command can be undone, `Err(reason)` otherwise.
    pub undo: Result<Value, String>,
}

pub struct Ctx<'a> {
    pub cat: &'a Catalogue,
    pub command_id: &'a str,
    pub now_ms: u64,
    pub occurred_at_ms: u64,
}

pub fn name_list(names: &[String]) -> String {
    const MAX: usize = 6;
    if names.len() <= MAX {
        names.join(", ")
    } else {
        format!("{} and {} more", names[..MAX].join(", "), names.len() - MAX)
    }
}

fn invalid(command: &str, issue: impl Into<String>) -> CmdError {
    CmdError::with("invalid_command", format!("invalid payload for '{command}'"), json!({"issues": [issue.into()]}))
}

fn only_keys(payload: &Value, command: &str, allowed: &[&str]) -> Result<(), CmdError> {
    let Some(obj) = payload.as_object() else { return Err(invalid(command, "expected an object")) };
    match obj.keys().find(|k| !allowed.contains(&k.as_str())) {
        Some(k) => Err(invalid(command, format!("{k}: not a field of this command"))),
        None => Ok(()),
    }
}

/// `items: [{garmentId, quantity = 1}]`, 1 to [`MAX_ITEMS`] entries.
fn items(payload: &Value, command: &str) -> Result<Vec<(String, u32)>, CmdError> {
    let list = match payload.get("items") {
        Some(Value::Array(a)) if a.is_empty() => return Err(invalid(command, "items: at least one item is required")),
        Some(Value::Array(a)) if a.len() <= MAX_ITEMS => a,
        Some(Value::Array(_)) => return Err(invalid(command, format!("items: at most {MAX_ITEMS} entries"))),
        _ => return Err(invalid(command, "items: expected an array")),
    };
    let mut out = Vec::new();
    for (i, item) in list.iter().enumerate() {
        if !item.is_object() {
            return Err(invalid(command, format!("items[{i}]: expected an object")));
        }
        let id = match item.get("garmentId").and_then(Value::as_str) {
            Some(s) if !s.is_empty() && s.len() <= 64 => s.to_string(),
            _ => return Err(invalid(command, format!("items[{i}].garmentId: expected a garment ID (1 to 64 characters)"))),
        };
        let q = match item.get("quantity") {
            None | Some(Value::Null) => 1,
            Some(x) => match whole(x) {
                Some(q) if (1..=MAX_QUANTITY).contains(&q) => q as u32,
                _ => return Err(invalid(command, format!("items[{i}].quantity: expected a whole number from 1 to {MAX_QUANTITY}"))),
            },
        };
        out.push((id, q));
    }
    Ok(out)
}

/// All-or-nothing garment lookup (`loadGarments`): any unknown ID fails the command.
fn load<'c>(cat: &'c Catalogue, ids: &[String]) -> Result<Vec<&'c Garment>, CmdError> {
    let mut missing: Vec<String> = Vec::new();
    let mut found = Vec::new();
    for id in ids {
        match cat.get(id) {
            Some(g) => found.push(g),
            None if !missing.contains(id) => missing.push(id.clone()),
            None => {}
        }
    }
    if !missing.is_empty() {
        let resolved: Vec<&str> = found.iter().map(|g| g.id.as_str()).collect();
        return Err(CmdError::with(
            "not_found",
            format!("unknown garment{}: {}; nothing was written", if missing.len() > 1 { "s" } else { "" }, missing.join(", ")),
            json!({"missing": missing, "resolved": resolved}),
        ));
    }
    Ok(found)
}

/// Bump every touched garment's version and list it as affected.
fn affected(ledger: &mut Ledger, touched: &BTreeSet<String>) -> Vec<Value> {
    touched.iter().map(|id| json!({"kind": "garment", "id": id, "version": ledger.bump_garment(id)})).collect()
}

// ───────────────────────────── commands ─────────────────────────────

/// `care.mark_dirty`: "it is in the wash" (an owner observation).
pub fn mark_dirty(ctx: &Ctx<'_>, ledger: &mut Ledger, payload: &Value) -> Result<Plan, CmdError> {
    const T: &str = "care.mark_dirty";
    only_keys(payload, T, &["items"])?;
    let asked = items(payload, T)?;
    let garments = load(ctx.cat, &asked.iter().map(|a| a.0.clone()).collect::<Vec<_>>())?;
    if let Some(g) = garments.iter().find(|g| g.care_channel == "none") {
        return Err(CmdError::with("precondition_failed", format!("{} is never laundered and cannot be put in the wash", g.name), json!({"garmentId": g.id})));
    }
    let before = replay(ctx.cat, &ledger.events);
    let mut event_ids = Vec::new();
    let mut names = Vec::new();
    let mut touched = BTreeSet::new();
    for ((_, q), g) in asked.iter().zip(garments.iter()) {
        let id = format!("sev_{}_{}", ctx.command_id.trim_start_matches("cmd_"), event_ids.len() + 1);
        ledger.events.push(Event {
            id: id.clone(),
            garment_id: g.id.clone(),
            quantity: *q,
            at_ms: ctx.occurred_at_ms,
            seq: ledger.next_seq,
            command_id: ctx.command_id.to_string(),
            voided_by: None,
        });
        ledger.next_seq += 1;
        event_ids.push(id);
        names.push(g.name.clone());
        touched.insert(g.id.clone());
    }
    let after = replay(ctx.cat, &ledger.events);
    let units: u32 = event_ids.iter().map(|id| after.moved.get(id).copied().unwrap_or(0)).sum();
    let affected = affected(ledger, &touched);
    Ok(Plan {
        outcome: "committed",
        summary: format!("In the wash: {}", name_list(&names)),
        affected,
        repairs: after.new_repairs_since(&before),
        result: json!({"units": units}),
        undo: Ok(json!({"stockEventIds": event_ids})),
    })
}

/// A stored command, as `crate::api` keeps it beside its receipt.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredCommand {
    pub command_id: String,
    pub kind: String,
    pub summary: String,
    pub undo: Result<Value, String>,
    pub undone_by: Option<String>,
}

/// `command.undo`: a compensating command. The original is never deleted;
/// `crate::api` links the two in the same commit.
pub fn command_undo(ctx: &Ctx<'_>, ledger: &mut Ledger, original: Option<&StoredCommand>, target: &str) -> Result<Plan, CmdError> {
    let Some(original) = original else {
        return Err(CmdError::with("not_found", "there is no such action to undo", json!({"commandId": target})));
    };
    if let Some(by) = &original.undone_by {
        return Err(CmdError::with("not_undoable", "that action was already undone", json!({"undoneBy": by})));
    }
    let data = match &original.undo {
        Ok(d) => d.clone(),
        Err(reason) => return Err(CmdError::with("not_undoable", reason.clone(), json!({"commandId": target}))),
    };
    if original.kind != "care.mark_dirty" {
        return Err(CmdError::with("not_undoable", "this action has no automatic undo", json!({"commandId": target, "type": original.kind})));
    }
    // The undo data must name exactly the events this very command journaled,
    // each once; anything else would restore nothing, part of the action, or
    // the wrong thing, under a committed receipt.
    let ids = arr(&data, "stockEventIds");
    let event_ids: Vec<String> = ids.iter().filter_map(|x| x.as_str().map(str::to_string)).collect();
    let mut named: Vec<&str> = event_ids.iter().map(String::as_str).collect();
    named.sort_unstable();
    let mut journaled: Vec<&str> = ledger.events.iter().filter(|e| e.command_id == target).map(|e| e.id.as_str()).collect();
    journaled.sort_unstable();
    let matches_journal = !ids.is_empty() && event_ids.len() == ids.len() && named == journaled;
    if !matches_journal {
        return Err(CmdError::with(
            "internal",
            "the stored undo data of that action does not match the wardrobe's journal; nothing was written",
            json!({"retryable": false, "commandId": target}),
        ));
    }
    let before = replay(ctx.cat, &ledger.events);
    let mut touched = BTreeSet::new();
    for e in ledger.events.iter_mut() {
        if event_ids.contains(&e.id) && e.voided_by.is_none() {
            e.voided_by = Some(ctx.command_id.to_string());
            touched.insert(e.garment_id.clone());
        }
    }
    let after = replay(ctx.cat, &ledger.events);
    let affected = affected(ledger, &touched);
    let original_summary = if original.summary.is_empty() { "an earlier action".to_string() } else { original.summary.trim_end_matches('.').to_string() };
    Ok(Plan {
        outcome: "committed",
        summary: format!("Undone: {original_summary}. {UNDO_STOCK_SUMMARY}"),
        affected,
        repairs: after.new_repairs_since(&before),
        result: json!({"undoneCommandId": target}),
        undo: Err(ALREADY_AN_UNDO.to_string()),
    })
}

/// Parse a `command.undo` payload into the target command ID.
pub fn undo_target(payload: &Value) -> Result<String, CmdError> {
    const T: &str = "command.undo";
    only_keys(payload, T, &["commandId", "reason"])?;
    match payload.get("reason") {
        None | Some(Value::Null) | Some(Value::String(_)) => {}
        _ => return Err(invalid(T, "reason: expected a string or null")),
    }
    match payload.get("commandId").and_then(Value::as_str) {
        Some(id) if !id.is_empty() && id.len() <= 64 => Ok(id.to_string()),
        _ => Err(invalid(T, "commandId: expected a command ID (1 to 64 characters)")),
    }
}

/// The current inventory: every garment with its balances as the ledger replays them.
pub fn inventory(cat: &Catalogue, ledger: &Ledger, category: Option<&str>) -> Vec<Value> {
    let r = replay(cat, &ledger.events);
    cat.garments
        .iter()
        .filter(|g| category.map_or(true, |c| g.category == c))
        .map(|g| {
            let st = r.of(&g.id);
            let mut item = Map::new();
            item.insert("garmentId".into(), json!(g.id));
            item.insert("name".into(), json!(g.name));
            item.insert("category".into(), json!(g.category));
            item.insert("careChannel".into(), json!(g.care_channel));
            item.insert("planningPolicy".into(), json!(g.planning_policy));
            item.insert("acquisition".into(), json!(g.acquisition));
            item.insert("quantity".into(), json!(g.quantity));
            item.insert("version".into(), json!(ledger.garment_version(&g.id)));
            item.insert("balances".into(), json!({"clean": st.clean, "dirty": st.dirty}));
            item.insert("sourceRows".into(), json!(g.source_rows));
            Value::Object(item)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::seed::catalogue;
    use ferrite_app::serde_json::json;

    fn id_of(name_prefix: &str) -> String {
        catalogue().garments.iter().find(|g| g.name.starts_with(name_prefix)).map(|g| g.id.clone()).expect(name_prefix)
    }

    /// Two single-unit garments that are laundered, from the owner's inventory.
    fn two_shirts() -> (String, String) {
        let shirts: Vec<&Garment> = catalogue().garments.iter().filter(|g| g.care_channel == "service" && g.quantity == 1).collect();
        (shirts[0].id.clone(), shirts[1].id.clone())
    }

    fn ctx(id: &'static str, at: u64) -> Ctx<'static> {
        Ctx { cat: catalogue(), command_id: id, now_ms: at, occurred_at_ms: at }
    }

    fn stored(id: &str, kind: &str, plan: &Plan) -> StoredCommand {
        StoredCommand { command_id: id.into(), kind: kind.into(), summary: plan.summary.clone(), undo: plan.undo.clone(), undone_by: None }
    }

    #[test]
    fn a_never_laundered_item_cannot_go_in_the_wash_and_nothing_is_written() {
        let (a, _) = two_shirts();
        let shoe = id_of("Paraboot Reims");
        let mut l = Ledger::default();
        let err = mark_dirty(&ctx("cmd_a", 1_000), &mut l, &json!({"items": [{"garmentId": a}, {"garmentId": shoe}]})).unwrap_err();
        assert_eq!(err.code, "precondition_failed");
        assert_eq!(err.message, "Paraboot Reims — noir (black) is never laundered and cannot be put in the wash");
        assert_eq!(l, Ledger::default());
    }

    #[test]
    fn an_unknown_garment_writes_nothing() {
        let (a, _) = two_shirts();
        let mut l = Ledger::default();
        let err = mark_dirty(&ctx("cmd_a", 1_000), &mut l, &json!({"items": [{"garmentId": a}, {"garmentId": "gmt_nope"}]})).unwrap_err();
        assert_eq!((err.code, err.message.as_str()), ("not_found", "unknown garment: gmt_nope; nothing was written"));
        assert_eq!(l, Ledger::default());
    }

    #[test]
    fn payload_validation() {
        let (a, _) = two_shirts();
        let mut l = Ledger::default();
        for bad in [json!({}), json!({"items": []}), json!({"items": [{"garmentId": a, "quantity": 0}]}), json!({"items": [{"garmentId": a, "quantity": 1.5}]}), json!({"items": [], "extra": 1})] {
            assert_eq!(mark_dirty(&ctx("cmd_a", 1), &mut l, &bad).unwrap_err().code, "invalid_command", "{bad}");
        }
        // A whole number written as a float is the same quantity to a JavaScript client.
        assert!(mark_dirty(&ctx("cmd_a", 1), &mut l, &json!({"items": [{"garmentId": a, "quantity": 1.0}]})).is_ok());
    }

    #[test]
    fn mark_dirty_then_undo_restores_the_balances() {
        let (a, b) = two_shirts();
        let cat = catalogue();
        let mut l = Ledger::default();
        let dirty = mark_dirty(&ctx("cmd_d", 1_000), &mut l, &json!({"items": [{"garmentId": a}, {"garmentId": b}]})).unwrap();
        assert!(dirty.summary.starts_with("In the wash: "));
        assert_eq!(dirty.result, json!({"units": 2}));
        assert_eq!(dirty.affected.len(), 2);
        let r = replay(cat, &l.events);
        assert_eq!(r.of(&a), Stock { clean: 0, dirty: 1 });

        let undo = command_undo(&ctx("cmd_u", 2_000), &mut l, Some(&stored("cmd_d", "care.mark_dirty", &dirty)), "cmd_d").unwrap();
        assert_eq!(undo.summary, format!("Undone: {}. {UNDO_STOCK_SUMMARY}", dirty.summary));
        assert_eq!(undo.undo, Err(ALREADY_AN_UNDO.to_string()));
        let r = replay(cat, &l.events);
        assert_eq!((r.of(&a), r.of(&b)), (Stock { clean: 1, dirty: 0 }, Stock { clean: 1, dirty: 0 }));
        assert_eq!(l.garment_version(&a), 3, "import, dirty, undo");
        assert_eq!(l.events.len(), 2, "voided, not deleted");
    }

    #[test]
    fn a_second_dirty_report_of_a_single_unit_moves_nothing_more() {
        let (a, _) = two_shirts();
        let mut l = Ledger::default();
        mark_dirty(&ctx("cmd_d1", 1_000), &mut l, &json!({"items": [{"garmentId": a}]})).unwrap();
        let again = mark_dirty(&ctx("cmd_d2", 2_000), &mut l, &json!({"items": [{"garmentId": a}]})).unwrap();
        assert_eq!(again.result, json!({"units": 0}));
        assert_eq!(again.repairs.len(), 1);
        assert_eq!(replay(catalogue(), &l.events).of(&a), Stock { clean: 0, dirty: 1 });
        // An earlier repair is not repeated on later receipts, for this garment or another.
        let (_, b) = two_shirts();
        let other = mark_dirty(&ctx("cmd_d3", 3_000), &mut l, &json!({"items": [{"garmentId": b}]})).unwrap();
        assert_eq!(other.repairs, Vec::<String>::new());
        let third = mark_dirty(&ctx("cmd_d4", 4_000), &mut l, &json!({"items": [{"garmentId": a}]})).unwrap();
        assert_eq!(third.repairs.len(), 1);
        let undo = command_undo(&ctx("cmd_u", 5_000), &mut l, Some(&stored("cmd_d3", "care.mark_dirty", &other)), "cmd_d3").unwrap();
        assert_eq!(undo.repairs, Vec::<String>::new());
    }

    #[test]
    fn a_back_dated_report_lists_the_repair_it_forces_on_a_later_one() {
        let (a, _) = two_shirts();
        let mut l = Ledger::default();
        let later = mark_dirty(&ctx("cmd_d1", 2_000), &mut l, &json!({"items": [{"garmentId": a}]})).unwrap();
        assert!(later.repairs.is_empty());
        let earlier = mark_dirty(&ctx("cmd_d2", 1_000), &mut l, &json!({"items": [{"garmentId": a}]})).unwrap();
        assert_eq!(earlier.result, json!({"units": 1}));
        assert_eq!(earlier.repairs.len(), 1, "the later report no longer finds a clean unit");
    }

    #[test]
    fn undo_refusals() {
        let mut l = Ledger::default();
        let mut original = StoredCommand { command_id: "cmd_x".into(), kind: "care.mark_dirty".into(), summary: "In the wash: x".into(), undo: Ok(json!({"stockEventIds": []})), undone_by: Some("cmd_y".into()) };
        assert_eq!(command_undo(&ctx("cmd_u", 1), &mut l, Some(&original), "cmd_x").unwrap_err().message, "that action was already undone");
        original.undone_by = None;
        original.undo = Err(ALREADY_AN_UNDO.into());
        assert_eq!(command_undo(&ctx("cmd_u", 1), &mut l, Some(&original), "cmd_x").unwrap_err().message, ALREADY_AN_UNDO);
        assert_eq!(command_undo(&ctx("cmd_u", 1), &mut l, None, "cmd_x").unwrap_err().code, "not_found");
    }

    #[test]
    fn the_ledger_round_trips_through_json() {
        let (a, _) = two_shirts();
        let mut l = Ledger::default();
        mark_dirty(&ctx("cmd_d", 1_000), &mut l, &json!({"items": [{"garmentId": a, "quantity": 1}]})).unwrap();
        l.record_command("cmd_d");
        assert_eq!(Ledger::from_json(&l.to_json()), Some(l.clone()));
        // A corrupt record is refused, never read as a fresh ledger.
        for corrupt in [json!(null), json!({}), json!({"v": 1}), json!("ledger")] {
            assert_eq!(Ledger::from_json(&corrupt), None, "{corrupt}");
        }
        let mut bad = l.to_json();
        bad["events"][0]["quantity"] = json!("one");
        assert_eq!(Ledger::from_json(&bad), None);
    }
}
