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
/// Why an undo offers no undo of its own (handlers/undo.ts).
pub const ALREADY_AN_UNDO: &str = "this is already an undo; repeat the original action instead";
/// Bounds this port applies to a command payload's lists (the TypeScript
/// contracts leave them to the 4 MB body limit, which Ferrite does not have).
pub const MAX_ITEMS: usize = 200;
pub const MAX_QUANTITY: u64 = 999;
/// Command IDs kept in the ledger's recent list, newest first.
pub const RECENT_LIMIT: usize = 200;

/// The command types this port executes. Anything else is `unknown_command`.
pub const COMMAND_TYPES: &[&str] = &["care.mark_dirty", "command.undo", "board.publish", "board.select", "board.swap_slot", "laundry.collect", "laundry.return"];
/// Laundry batches kept in the ledger; the oldest closed ones make room.
pub const MAX_BATCHES: usize = 60;

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

/// One journaled stock event of a garment (`stock_events` in TypeScript):
/// `dirty` (an owner's wash report), `pickup` and `return` of a service
/// laundry batch, and `wash` (back clean without a recorded pickup).
#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub id: String,
    pub garment_id: String,
    pub kind: String,
    pub batch_id: Option<String>,
    pub quantity: u32,
    /// Units a return names as still away (`return` only).
    pub still_away: u32,
    pub at_ms: u64,
    pub seq: u64,
    pub command_id: String,
    pub voided_by: Option<String>,
}

pub const EVENT_KINDS: &[&str] = &["dirty", "pickup", "return", "wash"];

/// One garment of a laundry batch (`laundry_batch_items`).
#[derive(Debug, Clone, PartialEq)]
pub struct BatchItem {
    pub garment_id: String,
    pub quantity: u32,
    pub returned: u32,
    pub still_away: u32,
}

/// A service laundry batch (`laundry_batches`): `collected`,
/// `partially_returned` (something is still away) or `returned`; a pickup
/// that was undone stays on record, withdrawn.
#[derive(Debug, Clone, PartialEq)]
pub struct Batch {
    pub batch_id: String,
    pub status: String,
    pub picked_up_at_ms: u64,
    pub returned_at_ms: Option<u64>,
    pub command_id: String,
    pub withdrawn_by: Option<String>,
    pub version: u64,
    pub items: Vec<BatchItem>,
}

impl Batch {
    pub fn open(&self) -> bool {
        self.withdrawn_by.is_none() && (self.status == "collected" || self.status == "partially_returned")
    }
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
    /// The day boards (`crate::board`), each stored under `b/<boardId>`.
    pub boards: Vec<BoardRef>,
    /// Service laundry batches, oldest first, at most [`MAX_BATCHES`].
    pub batches: Vec<Batch>,
}

/// Where a day's board is stored: one entry per (scope, day).
#[derive(Debug, Clone, PartialEq)]
pub struct BoardRef {
    pub board_id: String,
    pub scope: String,
    pub local_date: String,
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
                "id": e.id, "garmentId": e.garment_id, "kind": e.kind, "batchId": e.batch_id, "quantity": e.quantity,
                "stillAway": e.still_away, "atMs": e.at_ms, "seq": e.seq, "commandId": e.command_id, "voidedBy": e.voided_by,
            })).collect::<Vec<_>>(),
            "versions": self.versions,
            "recent": self.recent,
            "boards": self.boards.iter().map(|b| json!({"boardId": b.board_id, "scope": b.scope, "localDate": b.local_date})).collect::<Vec<_>>(),
            "batches": self.batches.iter().map(|b| json!({
                "batchId": b.batch_id, "status": b.status, "pickedUpAtMs": b.picked_up_at_ms, "returnedAtMs": b.returned_at_ms,
                "commandId": b.command_id, "withdrawnBy": b.withdrawn_by, "version": b.version,
                "items": b.items.iter().map(|i| json!({"garmentId": i.garment_id, "quantity": i.quantity, "returned": i.returned, "stillAway": i.still_away})).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
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
        fn opt_st(v: &Value, k: &str) -> Option<Option<String>> {
            match v.get(k) {
                None | Some(Value::Null) => Some(None),
                Some(Value::String(s)) => Some(Some(s.clone())),
                _ => None,
            }
        }
        fn opt_u(v: &Value, k: &str) -> Option<Option<u64>> {
            match v.get(k) {
                None | Some(Value::Null) => Some(None),
                Some(x) => x.as_u64().map(Some),
            }
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
            // Events written before laundry was ported are wash reports.
            let kind = match e.get("kind") {
                None => "dirty".to_string(),
                Some(k) => k.as_str().filter(|k| EVENT_KINDS.contains(k))?.to_string(),
            };
            let batch_id = opt_st(e, "batchId")?;
            if (kind == "pickup" || kind == "return") != batch_id.is_some() {
                return None;
            }
            events.push(Event {
                id: st(e, "id")?,
                garment_id: st(e, "garmentId")?,
                kind,
                batch_id,
                quantity: u32::try_from(u(e, "quantity")?).ok()?,
                still_away: u32::try_from(opt_u(e, "stillAway")?.unwrap_or(0)).ok()?,
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
        // Ledgers written before boards (or laundry) were ported have no index: none exist.
        let mut boards = Vec::new();
        if let Some(list) = v.get("boards") {
            for b in list.as_array()? {
                boards.push(BoardRef { board_id: st(b, "boardId")?, scope: st(b, "scope")?, local_date: st(b, "localDate")? });
            }
        }
        let mut batches = Vec::new();
        if let Some(list) = v.get("batches") {
            for b in list.as_array()? {
                let mut items = Vec::new();
                for i in b.get("items")?.as_array()? {
                    let n = |k: &str| u(i, k).and_then(|x| u32::try_from(x).ok());
                    items.push(BatchItem { garment_id: st(i, "garmentId")?, quantity: n("quantity")?, returned: n("returned")?, still_away: n("stillAway")? });
                }
                let status = st(b, "status").filter(|s| ["collected", "partially_returned", "returned"].contains(&s.as_str()))?;
                batches.push(Batch {
                    batch_id: st(b, "batchId")?,
                    status,
                    picked_up_at_ms: u(b, "pickedUpAtMs")?,
                    returned_at_ms: opt_u(b, "returnedAtMs")?,
                    command_id: st(b, "commandId")?,
                    withdrawn_by: opt_st(b, "withdrawnBy")?,
                    version: u(b, "version")?,
                    items,
                });
            }
        }
        Some(Ledger { revision: u(v, "revision")?, next_seq: u(v, "nextSeq")?, events, versions, recent, boards, batches })
    }

    pub fn batch(&self, id: &str) -> Option<&Batch> {
        self.batches.iter().find(|b| b.batch_id == id)
    }

    pub fn batch_mut(&mut self, id: &str) -> Option<&mut Batch> {
        self.batches.iter_mut().find(|b| b.batch_id == id)
    }

    /// The board of this scope and day, if one was published.
    pub fn board_for(&self, scope: &str, local_date: &str) -> Option<&BoardRef> {
        self.boards.iter().find(|b| b.scope == scope && b.local_date == local_date)
    }

    pub fn garment_version(&self, id: &str) -> u64 {
        self.versions.get(&format!("garment:{id}")).copied().unwrap_or(1)
    }

    pub(crate) fn bump_garment(&mut self, id: &str) -> u64 {
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

/// Units a service laundry batch holds of one garment (`state.service` in TypeScript).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Holding {
    pub quantity: u32,
    /// A return named it still away: it stays away until reported back.
    pub held: bool,
    pub picked_up_at_ms: u64,
}

#[derive(Debug, Clone, Default)]
pub struct Replay {
    pub stock: BTreeMap<String, Stock>,
    /// What each garment's batches hold, by batch ID.
    pub service: BTreeMap<String, BTreeMap<String, Holding>>,
    /// Units each event moved.
    pub moved: BTreeMap<String, u32>,
    /// Units a wash report took back from the laundry, by the batch each came from.
    pub pulled: BTreeMap<String, BTreeMap<String, u32>>,
    /// Repairs by the event that needed them, in replay order.
    pub repairs: Vec<(String, String)>,
}

impl Replay {
    pub fn of(&self, garment_id: &str) -> Stock {
        self.stock.get(garment_id).cloned().unwrap_or_default()
    }

    /// Units of a garment at the laundry service, in every batch.
    pub fn at_service(&self, garment_id: &str) -> u32 {
        self.service.get(garment_id).map_or(0, |m| m.values().map(|h| h.quantity).sum())
    }

    /// Units of a garment one batch holds.
    pub fn held_in(&self, garment_id: &str, batch_id: &str) -> u32 {
        self.service.get(garment_id).and_then(|m| m.get(batch_id)).map_or(0, |h| h.quantity)
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

/// The replay as it stood at `at_ms`: only the events that happened by then (an event journaled now
/// at that same instant sorts after them, by sequence). Used to size a back-dated observation.
pub fn replay_until(cat: &Catalogue, events: &[Event], at_ms: u64) -> Replay {
    let upto: Vec<Event> = events.iter().filter(|e| e.at_ms <= at_ms).cloned().collect();
    replay(cat, &upto)
}

/// Replay every unvoided event, in the order the events happened, over the
/// imported baseline (every owned unit clean, as the importer records them),
/// with the rules of `stock/replay.ts`:
/// - `dirty` moves clean units to the hamper; one that has none clean but is
///   recorded at the laundry is pulled back from there (the owner has it);
/// - `pickup` moves hamper units into its batch;
/// - `return` moves its batch's units back clean, less those named still away
///   (which stay in the batch, held);
/// - `wash` moves hamper units back clean.
pub fn replay(cat: &Catalogue, events: &[Event]) -> Replay {
    let mut out = Replay::default();
    for g in &cat.garments {
        out.stock.insert(g.id.clone(), Stock { clean: g.quantity, dirty: 0 });
    }
    let mut ordered: Vec<&Event> = events.iter().filter(|e| e.voided_by.is_none()).collect();
    ordered.sort_by_key(|e| (e.at_ms, e.seq));
    for e in ordered {
        let (Some(g), Some(st)) = (cat.get(&e.garment_id), out.stock.get_mut(&e.garment_id)) else { continue };
        let held = out.service.entry(e.garment_id.clone()).or_default();
        let moved = match e.kind.as_str() {
            "pickup" => {
                let q = e.quantity.min(st.dirty);
                st.dirty -= q;
                if q > 0 {
                    let h = held.entry(e.batch_id.clone().unwrap_or_default()).or_insert(Holding { quantity: 0, held: false, picked_up_at_ms: e.at_ms });
                    h.quantity += q;
                }
                q
            }
            "return" => {
                let batch = e.batch_id.clone().unwrap_or_default();
                match held.get_mut(&batch) {
                    None => 0,
                    Some(h) => {
                        let q = e.quantity.min(h.quantity);
                        h.quantity -= q;
                        st.clean += q;
                        if h.quantity == 0 {
                            held.remove(&batch);
                        } else if e.still_away > 0 {
                            h.held = true;
                        }
                        q
                    }
                }
            }
            "wash" => {
                let q = e.quantity.min(st.dirty);
                st.dirty -= q;
                st.clean += q;
                q
            }
            _ => {
                let mut q = e.quantity.min(st.clean);
                st.clean -= q;
                st.dirty += q;
                // The owner has it in the hamper: a unit the ledger had at the laundry is with him.
                while q < e.quantity {
                    let Some(batch) = held.iter().filter(|(_, h)| h.quantity > 0).min_by_key(|(id, h)| (h.picked_up_at_ms, (*id).clone())).map(|(id, _)| id.clone()) else { break };
                    let h = held.get_mut(&batch).expect("holding just found");
                    h.quantity -= 1;
                    if h.quantity == 0 {
                        held.remove(&batch);
                    }
                    *out.pulled.entry(e.id.clone()).or_default().entry(batch.clone()).or_default() += 1;
                    st.dirty += 1;
                    q += 1;
                    out.repairs.push((e.id.clone(), format!("{}: the ledger had this item at the laundry; the wash report establishes it is with the owner", g.name)));
                }
                if q < e.quantity {
                    out.repairs.push((e.id.clone(), format!("{}: no clean unit was left to put in the wash; the count stays at what is owned", g.name)));
                }
                q
            }
        };
        out.moved.insert(e.id.clone(), moved);
    }
    out.service.retain(|_, m| !m.is_empty());
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

pub(crate) fn invalid(command: &str, issue: impl Into<String>) -> CmdError {
    CmdError::with("invalid_command", format!("invalid payload for '{command}'"), json!({"issues": [issue.into()]}))
}

pub(crate) fn only_keys(payload: &Value, command: &str, allowed: &[&str]) -> Result<(), CmdError> {
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
pub(crate) fn load<'c>(cat: &'c Catalogue, ids: &[String]) -> Result<Vec<&'c Garment>, CmdError> {
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
pub(crate) fn affected(ledger: &mut Ledger, touched: &BTreeSet<String>) -> Vec<Value> {
    touched.iter().map(|id| json!({"kind": "garment", "id": id, "version": ledger.bump_garment(id)})).collect()
}

// ───────────────────────────── commands ─────────────────────────────

/// Journal one event of this command and return its ID.
pub(crate) fn journal(ctx: &Ctx<'_>, ledger: &mut Ledger, garment_id: &str, kind: &str, batch_id: Option<&str>, quantity: u32, still_away: u32) -> String {
    let n = ledger.events.iter().filter(|e| e.command_id == ctx.command_id).count();
    let id = format!("sev_{}_{}", ctx.command_id.trim_start_matches("cmd_"), n + 1);
    ledger.events.push(Event {
        id: id.clone(),
        garment_id: garment_id.to_string(),
        kind: kind.to_string(),
        batch_id: batch_id.map(str::to_string),
        quantity,
        still_away,
        at_ms: ctx.occurred_at_ms,
        seq: ledger.next_seq,
        command_id: ctx.command_id.to_string(),
        voided_by: None,
    });
    ledger.next_seq += 1;
    id
}

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
        event_ids.push(journal(ctx, ledger, &g.id, "dirty", None, *q, 0));
        names.push(g.name.clone());
        touched.insert(g.id.clone());
    }
    let after = replay(ctx.cat, &ledger.events);
    other_bags_changed(ctx, ledger, &before, &after)?;
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

/// The checks every undo makes before its handler plans it (handlers/undo.ts):
/// the action exists, was not undone already, and offered an undo. Returns its undo data.
pub fn undo_precheck(original: Option<&StoredCommand>, target: &str) -> Result<Value, CmdError> {
    let Some(original) = original else {
        return Err(CmdError::with("not_found", "there is no such action to undo", json!({"commandId": target})));
    };
    if let Some(by) = &original.undone_by {
        return Err(CmdError::with("not_undoable", "that action was already undone", json!({"undoneBy": by})));
    }
    match &original.undo {
        Ok(d) => Ok(d.clone()),
        Err(reason) => Err(CmdError::with("not_undoable", reason.clone(), json!({"commandId": target}))),
    }
}

/// `command.undo` of a wash report: a compensating command. The original is
/// never deleted; `crate::api` links the two in the same commit.
pub fn command_undo(ctx: &Ctx<'_>, ledger: &mut Ledger, original: Option<&StoredCommand>, target: &str) -> Result<Plan, CmdError> {
    let data = undo_precheck(original, target)?;
    let Some(original) = original else { return Err(CmdError::new("not_found", "there is no such action to undo")) };
    if original.kind != "care.mark_dirty" {
        return Err(CmdError::with("not_undoable", "this action has no automatic undo", json!({"commandId": target, "type": original.kind})));
    }
    let voided = void_events(ctx, ledger, &data, target)?;
    let changed = others_changed(ctx, ledger, &data, &voided);
    if !changed.is_empty() {
        return Err(CmdError::with(
            "not_undoable",
            format!("something recorded since relies on that report ({}), such as a laundry pickup that collected the piece. The report stays in the record; correct it instead; nothing was written", name_list(&changed)),
            json!({"commandId": target}),
        ));
    }
    let affected = affected(ledger, &voided.touched);
    Ok(Plan {
        outcome: "committed",
        summary: undone_summary(&original.summary, UNDO_STOCK_SUMMARY),
        affected,
        repairs: voided.after.new_repairs_since(&voided.before),
        result: json!({"undoneCommandId": target}),
        undo: Err(ALREADY_AN_UNDO.to_string()),
    })
}

/// "Undone: <the original summary>. <what the undo did>".
pub fn undone_summary(original_summary: &str, text: &str) -> String {
    let original = if original_summary.is_empty() { "an earlier action" } else { original_summary.trim_end_matches('.') };
    format!("Undone: {original}. {text}")
}

/// What voiding a command's events did to the replay.
pub struct Voided {
    pub before: Replay,
    pub after: Replay,
    pub touched: BTreeSet<String>,
}

/// Void the events an undoable stock command journaled, as named by its undo
/// data, and replay. The undo data must name exactly the events this very
/// command journaled, each once; anything else would restore nothing, part of
/// the action, or the wrong thing, under a committed receipt.
pub fn void_events(ctx: &Ctx<'_>, ledger: &mut Ledger, data: &Value, target: &str) -> Result<Voided, CmdError> {
    let ids = arr(data, "stockEventIds");
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
    Ok(Voided { before, after, touched })
}

/// Whether one event's effect differs between two replays: what it moved, which laundry batch any
/// units it took back came from, and the repairs it needed.
fn effect_changed(id: &str, before: &Replay, after: &Replay) -> bool {
    let ids = [id.to_string()];
    before.moved.get(id) != after.moved.get(id) || before.pulled.get(id) != after.pulled.get(id) || before.repairs_of(&ids) != after.repairs_of(&ids)
}

/// Batches record what their pickups and returns moved. An observation dated earlier must not change
/// what another command's pickup or return moved, or that bag's record would disagree with the stock;
/// such a report is refused (nothing is written) and names the pieces concerned. A report at the
/// present time always sorts after them and is never refused here.
pub(crate) fn other_bags_changed(ctx: &Ctx<'_>, ledger: &Ledger, before: &Replay, after: &Replay) -> Result<(), CmdError> {
    let mut names: Vec<String> = Vec::new();
    for e in ledger.events.iter().filter(|e| e.voided_by.is_none() && e.command_id != ctx.command_id && (e.kind == "pickup" || e.kind == "return")) {
        if before.moved.get(&e.id) != after.moved.get(&e.id) {
            let name = ctx.cat.get(&e.garment_id).map_or_else(|| e.garment_id.clone(), |g| g.name.clone());
            if !names.contains(&name) {
                names.push(name);
            }
        }
    }
    if names.is_empty() {
        return Ok(());
    }
    Err(CmdError::with(
        "precondition_failed",
        format!("at the time given, this would change what a laundry bag is recorded with ({}); give a later time, or undo that bag's record first; nothing was written", name_list(&names)),
        json!({"reason": "changes_another_batch", "occurredAt": crate::time::instant(ctx.occurred_at_ms)}),
    ))
}

/// Undo is exact or refused: voiding a command's events must not change what any other event moved,
/// took back from which batch, or repaired, whether that event was recorded after it or happened
/// after it (a back-dated report reinterprets one already on record; a pickup took the unit a wash
/// report put in the hamper). Returns the names of the garments whose other records would read differently.
pub(crate) fn others_changed(ctx: &Ctx<'_>, ledger: &Ledger, data: &Value, voided: &Voided) -> Vec<String> {
    let own: Vec<&str> = arr(data, "stockEventIds").iter().filter_map(Value::as_str).collect();
    let mut names: Vec<String> = Vec::new();
    for e in ledger.events.iter().filter(|e| e.voided_by.is_none() && !own.contains(&e.id.as_str())) {
        let changed = effect_changed(&e.id, &voided.before, &voided.after);
        let name = ctx.cat.get(&e.garment_id).map_or_else(|| e.garment_id.clone(), |g| g.name.clone());
        if changed && !names.contains(&name) {
            names.push(name);
        }
    }
    names
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
            item.insert("balances".into(), json!({"clean": st.clean, "dirty": st.dirty, "service": r.at_service(&g.id)}));
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
