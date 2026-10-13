//! Day boards: published, chosen from and swapped through the command
//! service, ported from packages/daily/src/boards.ts and validate.ts.
//!
//! A board has immutable revisions. Every published option is a complete
//! outfit that passed validation against the stock the same command read;
//! a choice is an intention tied to an option ID, never a wear. A board is
//! stored under `b/<boardId>` and committed with the ledger (the commit
//! guard) and the receipt in one write; the ledger indexes boards by day.
//!
//! What this port leaves out, and why (see README.md, "The board"):
//! - no forecast and no Calendar are read yet, so every board is published
//!   with that limitation stated, temperature rules are reported as not
//!   checked, and the 14-16 °C jacket rule cannot be ruled out: a jacket over
//!   anything but a lightweight oxford is offered only when it was named;
//! - recorded wears are checked against the seven-day repeat horizon of
//!   `variety.repeat_horizon` for the board's own date; no repeat exception
//!   exists yet on the home board (only the default brief is ported); a trip
//!   board checks no horizon (validate.ts: the trip is its own exception);
//! - the home board and trip-day boards (`trip:<tripId>`, drawn only from
//!   what is packed for that trip), the default day brief only (no evening
//!   boards), no pause, suppression, exposure sets, Calendar projection or
//!   repair;
//! - the sneaker and welted pair is dormant while the healing restriction
//!   holds, and nothing in this port can lift that restriction;
//! - the "same neutral three times" advisory and the composer's ranking are
//!   not ported: a replacement is chosen by the never-navy tier, then the
//!   fabric class of the piece it replaces, then garment ID.

use std::collections::{BTreeMap, BTreeSet};

use ferrite_app::serde_json::{json, Map, Value};

use crate::ledger::{invalid, only_keys, replay, CmdError, Ctx, Ledger, Plan, Replay, ALREADY_AN_UNDO};
use crate::seed::{Catalogue, Garment};
use crate::sha256::hex_digest;
use crate::time::{day_line, earliest_day, instant, latest_day, local_date, parse_instant, parse_local_date};

/// `Role` in packages/contracts/src/garment.ts.
pub const ROLES: &[&str] = &["top", "mid_layer", "bottom", "outer", "footwear", "socks", "belt", "neckwear", "accessory", "one_piece"];
const REQUIRED_ROLES: &[&str] = &["top", "bottom", "footwear", "socks"];
const SINGLE_ROLES: &[&str] = &["top", "mid_layer", "bottom", "outer", "footwear", "socks", "belt", "neckwear", "one_piece"];
/// Slots whose validity depends on the forecast (`WEATHER_ROLES`).
const WEATHER_ROLES: &[&str] = &["top", "mid_layer", "bottom", "outer", "socks", "footwear", "neckwear", "one_piece"];
/// `BoardPublish.reason`.
const REASONS: &[&str] = &["compose", "refresh", "repair", "replenish", "swap", "rebuild", "resume"];
const SOURCES: &[&str] = &["model", "deterministic", "reserve", "approved_combination", "owner_swap", "repair"];

/// Bounds of this port (the contracts bound the counts; lists inside an option are bounded here).
pub const MAX_OPTIONS: usize = 8;
pub const MAX_SLOTS: usize = 12;
pub const MAX_ALTERNATIVES: usize = 4;
/// `DailySettings.reserveCount` default.
pub const RESERVE_COUNT: usize = 3;
/// Revisions kept per board; an undo needing an older one says it is not recorded.
pub const REVISIONS_KEPT: usize = 16;
/// How far ahead a board may be published, in days past the latest date anywhere.
pub const MAX_DAYS_AHEAD: i64 = 14;
/// Index entries for days this far before the earliest date anywhere are dropped when a board is added.
pub const INDEX_KEPT_DAYS: i64 = 30;

const ALREADY_PUBLISHED: &str = "publish a new revision instead; earlier revisions stay in history";
const SOURCE_NOTICE: &str = "The forecast is unavailable, so temperature rules could not be checked. Calendar is not connected, so the day's events were not considered.";

// ───────────────────────────── records ─────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct Slot {
    pub role: String,
    pub garment_id: String,
}

/// One outfit on a board revision, with the evidence it was published on.
#[derive(Debug, Clone, PartialEq)]
pub struct Opt {
    /// Empty while a draft has not been given its ID.
    pub option_id: String,
    pub slots: Vec<Slot>,
    pub footwear_alternatives: Vec<String>,
    pub reason: String,
    pub suits_event_ids: Vec<String>,
    /// Pieces the owner put into this option himself.
    pub explicit: Vec<String>,
    pub source: String,
    pub explanation_source: String,
    pub removed_claims: Vec<String>,
    /// The validation's advisories (a published option has no blocking violation).
    pub violations: Vec<Value>,
    pub changed: bool,
}

impl Opt {
    pub fn slot(&self, role: &str) -> Option<&str> {
        slot_of(&self.slots, role)
    }
}

pub fn slot_of<'a>(slots: &'a [Slot], role: &str) -> Option<&'a str> {
    slots.iter().find(|s| s.role == role).map(|s| s.garment_id.as_str())
}

#[derive(Debug, Clone, PartialEq)]
pub struct Revision {
    pub revision: u64,
    pub reason: String,
    pub published_at_ms: u64,
    pub requested_count: u64,
    pub notice: Option<String>,
    pub changes: Vec<String>,
    pub command_id: String,
    pub offered: Vec<Opt>,
    pub reserves: Vec<Opt>,
    /// For the undo of a swap: (the swap's revision, the revision it restored).
    pub undo_of_swap: Option<(u64, u64)>,
    pub dropped: Vec<Value>,
    pub swap_weather_basis: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Board {
    pub board_id: String,
    pub scope: String,
    pub local_date: String,
    /// `active` (worn and suppressed are not reachable in this port yet).
    pub status: String,
    pub current_revision: u64,
    pub selected_option_id: Option<String>,
    pub selected_footwear_id: Option<String>,
    pub selected_at_ms: Option<u64>,
    /// Advances on every change of choice, including a choice dropped by a revision.
    pub selection_version: u64,
    /// The newest [`REVISIONS_KEPT`] revisions, oldest first.
    pub revisions: Vec<Revision>,
}

impl Board {
    pub fn revision(&self, n: u64) -> Option<&Revision> {
        self.revisions.iter().find(|r| r.revision == n)
    }
    pub fn current(&self) -> Option<&Revision> {
        self.revision(self.current_revision)
    }
}

fn opt_json(o: &Opt) -> Value {
    json!({
        "optionId": o.option_id,
        "slots": o.slots.iter().map(|s| json!({"role": s.role, "garmentId": s.garment_id})).collect::<Vec<_>>(),
        "footwearAlternatives": o.footwear_alternatives,
        "reason": o.reason,
        "suitsEventIds": o.suits_event_ids,
        "explicitGarmentIds": o.explicit,
        "source": o.source,
        "explanationSource": o.explanation_source,
        "removedClaims": o.removed_claims,
        "violations": o.violations,
        "changed": o.changed,
    })
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k)?.as_str().map(str::to_string)
}
fn u(v: &Value, k: &str) -> Option<u64> {
    v.get(k)?.as_u64()
}
fn ns(v: &Value, k: &str) -> Option<Option<String>> {
    match v.get(k)? {
        Value::Null => Some(None),
        Value::String(x) => Some(Some(x.clone())),
        _ => None,
    }
}
fn strs(v: &Value, k: &str) -> Option<Vec<String>> {
    v.get(k)?.as_array()?.iter().map(|x| x.as_str().map(str::to_string)).collect()
}

fn opt_from(v: &Value) -> Option<Opt> {
    let mut slots = Vec::new();
    for x in v.get("slots")?.as_array()? {
        slots.push(Slot { role: s(x, "role")?, garment_id: s(x, "garmentId")? });
    }
    let violations = v.get("violations")?.as_array()?.clone();
    if !violations.iter().all(Value::is_object) {
        return None;
    }
    Some(Opt {
        option_id: s(v, "optionId")?,
        slots,
        footwear_alternatives: strs(v, "footwearAlternatives")?,
        reason: s(v, "reason")?,
        suits_event_ids: strs(v, "suitsEventIds")?,
        explicit: strs(v, "explicitGarmentIds")?,
        source: s(v, "source")?,
        explanation_source: s(v, "explanationSource")?,
        removed_claims: strs(v, "removedClaims")?,
        violations,
        changed: v.get("changed")?.as_bool()?,
    })
}

impl Board {
    pub fn to_json(&self) -> Value {
        json!({
            "v": 1,
            "boardId": self.board_id,
            "scope": self.scope,
            "localDate": self.local_date,
            "status": self.status,
            "currentRevision": self.current_revision,
            "selectedOptionId": self.selected_option_id,
            "selectedFootwearId": self.selected_footwear_id,
            "selectedAtMs": self.selected_at_ms,
            "selectionVersion": self.selection_version,
            "revisions": self.revisions.iter().map(|r| json!({
                "revision": r.revision,
                "reason": r.reason,
                "publishedAtMs": r.published_at_ms,
                "requestedCount": r.requested_count,
                "notice": r.notice,
                "changes": r.changes,
                "commandId": r.command_id,
                "offered": r.offered.iter().map(opt_json).collect::<Vec<_>>(),
                "reserves": r.reserves.iter().map(opt_json).collect::<Vec<_>>(),
                "undoOfSwap": r.undo_of_swap.map(|(a, b)| json!({"revision": a, "restoredRevision": b})),
                "dropped": r.dropped,
                "swapWeatherBasis": r.swap_weather_basis,
            })).collect::<Vec<_>>(),
        })
    }

    /// The stored board, or `None` when the record is not one this code wrote
    /// (every field present and of its type, the current revision recorded).
    pub fn from_json(v: &Value) -> Option<Board> {
        if u(v, "v")? != 1 {
            return None;
        }
        let mut revisions = Vec::new();
        for r in v.get("revisions")?.as_array()? {
            let undo_of_swap = match r.get("undoOfSwap")? {
                Value::Null => None,
                x => Some((u(x, "revision")?, u(x, "restoredRevision")?)),
            };
            let mut offered = Vec::new();
            for o in r.get("offered")?.as_array()? {
                offered.push(opt_from(o)?);
            }
            let mut reserves = Vec::new();
            for o in r.get("reserves")?.as_array()? {
                reserves.push(opt_from(o)?);
            }
            revisions.push(Revision {
                revision: u(r, "revision")?,
                reason: s(r, "reason")?,
                published_at_ms: u(r, "publishedAtMs")?,
                requested_count: u(r, "requestedCount")?,
                notice: ns(r, "notice")?,
                changes: strs(r, "changes")?,
                command_id: s(r, "commandId")?,
                offered,
                reserves,
                undo_of_swap,
                dropped: r.get("dropped")?.as_array()?.clone(),
                swap_weather_basis: ns(r, "swapWeatherBasis")?,
            });
        }
        let selected_at_ms = match v.get("selectedAtMs")? {
            Value::Null => None,
            x => Some(x.as_u64()?),
        };
        let board = Board {
            board_id: s(v, "boardId")?,
            scope: s(v, "scope")?,
            local_date: s(v, "localDate")?,
            status: s(v, "status")?,
            current_revision: u(v, "currentRevision")?,
            selected_option_id: ns(v, "selectedOptionId")?,
            selected_footwear_id: ns(v, "selectedFootwearId")?,
            selected_at_ms,
            selection_version: u(v, "selectionVersion")?,
            revisions,
        };
        board.current()?;
        board.well_formed().then_some(board)
    }

    /// What every board this code writes satisfies: revisions numbered once each and within the
    /// kept bound, option IDs given and unique on a revision, slots of known roles, lists within the
    /// bounds publication enforces (a swap may add one slot per role), and a choice that is an
    /// option on the current revision, its shoe one of that option's.
    fn well_formed(&self) -> bool {
        let stored_slots = MAX_SLOTS + ROLES.len();
        if self.revisions.is_empty() || self.revisions.len() > REVISIONS_KEPT {
            return false;
        }
        let numbers: BTreeSet<u64> = self.revisions.iter().map(|r| r.revision).collect();
        if numbers.len() != self.revisions.len() || numbers.iter().any(|n| *n == 0 || *n > self.current_revision) {
            return false;
        }
        for r in &self.revisions {
            if r.offered.len() > MAX_OPTIONS || r.reserves.len() > MAX_OPTIONS {
                return false;
            }
            let mut ids = BTreeSet::new();
            for o in r.offered.iter().chain(r.reserves.iter()) {
                if o.option_id.is_empty() || !ids.insert(o.option_id.as_str()) {
                    return false;
                }
                if o.slots.is_empty()
                    || o.slots.len() > stored_slots
                    || o.explicit.len() > stored_slots
                    || o.footwear_alternatives.len() > MAX_ALTERNATIVES
                    || !o.slots.iter().all(|s| ROLES.contains(&s.role.as_str()) && !s.garment_id.is_empty())
                {
                    return false;
                }
            }
        }
        let Some(current) = self.current() else { return false };
        match (&self.selected_option_id, &self.selected_footwear_id) {
            (None, None) => true,
            (None, Some(_)) => false,
            (Some(id), shoe) => current.offered.iter().find(|o| &o.option_id == id).map_or(false, |o| {
                shoe.as_ref().map_or(true, |f| o.slot("footwear") == Some(f.as_str()) || o.footwear_alternatives.contains(f))
            }),
        }
    }
}

// ───────────────────────────── validation ─────────────────────────────

/// One finding of the validator (`OutfitViolation`).
#[derive(Debug, Clone, PartialEq)]
pub struct Violation {
    pub code: &'static str,
    pub message: String,
    pub garment_ids: Vec<String>,
    pub blocking: bool,
    pub rule_key: Option<String>,
}

impl Violation {
    fn new(code: &'static str, message: String, ids: Vec<String>) -> Violation {
        Violation { code, message, garment_ids: ids, blocking: true, rule_key: None }
    }
    fn rule(mut self, key: Option<&str>) -> Violation {
        self.rule_key = key.map(str::to_string);
        self
    }
    fn advisory(mut self) -> Violation {
        self.blocking = false;
        self
    }
    pub fn to_json(&self) -> Value {
        json!({"code": self.code, "message": self.message, "garmentIds": self.garment_ids, "severity": if self.blocking { "blocking" } else { "advisory" }, "ruleKey": self.rule_key})
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Validation {
    pub violations: Vec<Violation>,
}

impl Validation {
    pub fn valid(&self) -> bool {
        self.violations.iter().all(|v| !v.blocking)
    }
    pub fn blocking(&self) -> Vec<&Violation> {
        self.violations.iter().filter(|v| v.blocking).collect()
    }
    fn advisories(&self) -> Vec<Value> {
        self.violations.iter().filter(|v| !v.blocking).map(Violation::to_json).collect()
    }
}

/// What a board is validated against: the owner's garments, their stock as the ledger replays it, and
/// the counted wears the repeat horizon looks back over from the day validated for.
pub struct Day<'a> {
    pub cat: &'a Catalogue,
    pub stock: Replay,
    /// The day validated for, as days since the epoch; `None` checks no repeat horizon.
    pub local_date: Option<i64>,
    /// The wearing dates of every counted wear, by garment.
    pub worn: BTreeMap<String, Vec<i64>>,
    /// The trip a trip-day board is drawn for: `stock` is then what is packed for it.
    pub trip: Option<String>,
}

/// The trip a board scope names (`trip:<tripId>`, `parseScope` in model.ts), or `None` for the home
/// board and anything that is not a trip scope.
pub fn scope_trip(scope: &str) -> Option<&str> {
    scope.strip_prefix("trip:").filter(|id| !id.is_empty() && !id.contains(':') && id.chars().count() <= crate::packing::MAX_TRIP_ID)
}

/// Whether this port publishes boards of `scope`: the home board and a trip's day board (evening
/// boards are not ported).
pub fn scope_ok(scope: &str) -> bool {
    scope == "home" || scope_trip(scope).is_some()
}

/// Roles the packing proposal may reuse deliberately across days (`PLANNED_REUSE_ROLES` in
/// packages/daily/src/trip-day.ts, which lists the top as well): socks and everything else are worn
/// for one day.
pub const PLANNED_REUSE_ROLES: [&str; 5] = ["top", "bottom", "outer", "footwear", "belt"];

/// The deliberate reuse of the packing proposal the owner packed to (`plannedReuse` in trip-day.ts):
/// the newest proposal recorded no later than the newest packing report for the trip.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TripPlan {
    /// The trip's departure date; wears before it are not on the trip.
    pub departs_on: String,
    /// For each piece the proposal plans in a reusable role, the dates it plans it on (its wear budget
    /// for the trip) and the units the proposal packs of it (at least one).
    pub reuse: BTreeMap<String, (BTreeSet<String>, u32)>,
    /// The journal position of that packing report; a dirty report after it counts against re-wearing.
    pub packed_seq: u64,
}

impl TripPlan {
    /// The reuse `proposal` (a stored packing proposal) plans, or none without one.
    pub fn from_proposal(departs_on: &str, proposal: Option<&Value>, packed_seq: u64) -> TripPlan {
        let mut reuse: BTreeMap<String, (BTreeSet<String>, u32)> = BTreeMap::new();
        let Some(p) = proposal else {
            return TripPlan { departs_on: departs_on.to_string(), reuse, packed_seq };
        };
        for day in p["days"].as_array().into_iter().flatten() {
            let Some(date) = day["localDate"].as_str() else { continue };
            for slot in day["slots"].as_array().into_iter().flatten() {
                let (Some(role), Some(id)) = (slot["role"].as_str(), slot["garmentId"].as_str()) else { continue };
                if PLANNED_REUSE_ROLES.contains(&role) {
                    reuse.entry(id.to_string()).or_default().0.insert(date.to_string());
                }
            }
        }
        let items = p["items"].as_array();
        for (id, (_, units)) in reuse.iter_mut() {
            let quantity = items.and_then(|l| l.iter().find(|i| i["garmentId"] == id.as_str())).and_then(|i| i["quantity"].as_u64()).unwrap_or(1);
            *units = quantity.clamp(1, u64::from(u32::MAX)) as u32;
        }
        TripPlan { departs_on: departs_on.to_string(), reuse, packed_seq }
    }
}

fn counted_wears(ledger: &Ledger) -> BTreeMap<String, Vec<i64>> {
    let mut worn: BTreeMap<String, Vec<i64>> = BTreeMap::new();
    for w in ledger.wears.iter().filter(|w| w.active) {
        if let Some(d) = parse_local_date(&w.wearing_date) {
            worn.entry(w.garment_id.clone()).or_default().push(d);
        }
    }
    worn
}

impl<'a> Day<'a> {
    /// The day `local_date` against the ledger: its replayed stock and its active counted wears.
    pub fn of(cat: &'a Catalogue, ledger: &Ledger, local_date: &str) -> Day<'a> {
        Day { cat, stock: replay(cat, &ledger.events), local_date: parse_local_date(local_date), worn: counted_wears(ledger), trip: None }
    }

    /// A trip-day board's day (`assembleContext` with a trip scope): only what is packed for the trip
    /// is stock, a unit already worn on the trip counts as awaiting care, home stock and the laundry
    /// cannot leak in, and no repeat horizon is checked (validate.ts: a trip's reuse is its exception).
    ///
    /// The one exception is the reuse the packing proposal planned (`plan`): a piece worn on this trip
    /// is wearable again on `local_date` while the days it was worn before that day are fewer than the
    /// days the proposal plans it on, up to the units the proposal packs (clean units in the suitcase
    /// count against that allowance), unless the owner reported it dirty after packing. The planned
    /// days are a budget, not fixed dates.
    pub fn for_trip(cat: &'a Catalogue, ledger: &Ledger, trip_id: &str, local_date: &str, plan: Option<&TripPlan>) -> Day<'a> {
        let all = replay(cat, &ledger.events);
        let mut stock = Replay::default();
        for g in &cat.garments {
            stock.stock.insert(g.id.clone(), all.in_trip(&g.id, trip_id));
        }
        if let Some(plan) = plan.filter(|p| !p.reuse.is_empty() && !p.departs_on.is_empty()) {
            // A wear counts when its stock event names this trip; a wear whose event is not in the
            // journal is taken by its date (the LEFT JOIN in context.ts).
            let trip_of: BTreeMap<&str, Option<&str>> = ledger.events.iter().map(|e| (e.id.as_str(), e.trip_id.as_deref())).collect();
            let mut worn_on_trip: BTreeSet<&str> = BTreeSet::new();
            let mut days_before: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
            for w in ledger.wears.iter().filter(|w| w.active && w.wearing_date.as_str() >= plan.departs_on.as_str() && w.wearing_date.as_str() <= local_date) {
                match trip_of.get(w.stock_event_id.as_str()) {
                    None => {}
                    Some(Some(t)) if *t == trip_id => {}
                    Some(_) => continue,
                }
                worn_on_trip.insert(w.garment_id.as_str());
                if w.wearing_date.as_str() < local_date {
                    days_before.entry(w.garment_id.as_str()).or_default().insert(w.wearing_date.as_str());
                }
            }
            let reported_dirty: BTreeSet<&str> = ledger.events.iter().filter(|e| e.kind == "dirty" && e.voided_by.is_none() && e.seq > plan.packed_seq).map(|e| e.garment_id.as_str()).collect();
            for (id, (dates, units)) in &plan.reuse {
                let budget_left = dates.len().saturating_sub(days_before.get(id.as_str()).map_or(0, BTreeSet::len));
                if budget_left == 0 || !worn_on_trip.contains(id.as_str()) || reported_dirty.contains(id.as_str()) {
                    continue;
                }
                if let Some(st) = stock.stock.get_mut(id) {
                    // The proposal's units are the allowance for the piece on the trip, clean units
                    // still in the suitcase included: a worn unit is re-offered only up to it.
                    let rewearable = st.dirty.min(units.saturating_sub(st.clean));
                    st.clean += rewearable;
                    st.dirty -= rewearable;
                }
            }
        }
        Day { cat, stock, local_date: None, worn: counted_wears(ledger), trip: Some(trip_id.to_string()) }
    }

    /// The day a board of `scope` for `local_date` is validated against; `plan` is the trip's planned
    /// reuse (`crate::api::trip_plan`), read for a trip scope only.
    pub fn for_board(cat: &'a Catalogue, ledger: &Ledger, scope: &str, local_date: &str, plan: Option<&TripPlan>) -> Day<'a> {
        match scope_trip(scope) {
            Some(trip) => Day::for_trip(cat, ledger, trip, local_date, plan),
            None => Day::of(cat, ledger, local_date),
        }
    }

    /// Stock alone, with no date and no wear history (no repeat horizon is checked).
    pub fn undated(cat: &'a Catalogue, stock: Replay) -> Day<'a> {
        Day { cat, stock, local_date: None, worn: BTreeMap::new(), trip: None }
    }

    /// The latest counted wearing date of a garment in `[from, before)`.
    pub fn last_worn(&self, garment_id: &str, from: i64, before: i64) -> Option<i64> {
        self.worn.get(garment_id)?.iter().copied().filter(|d| *d >= from && *d < before).max()
    }
}

enum Availability {
    Excluded(Vec<&'static str>),
    Conditional,
    Available,
}

fn availability(day: &Day<'_>, g: &Garment) -> Availability {
    let mut reasons = Vec::new();
    if g.acquisition != "owned" {
        reasons.push(if g.acquisition == "incoming" { "ordered but not arrived" } else { "no longer owned" });
    }
    if g.planning_policy == "excluded" {
        reasons.push("excluded from planning");
    }
    let st = day.stock.of(&g.id);
    if st.clean == 0 {
        reasons.push(if day.trip.is_some() {
            if st.dirty > 0 {
                "already worn on this trip"
            } else {
                "not packed for this trip"
            }
        } else if st.dirty > 0 {
            "awaiting care"
        } else if day.stock.at_service(&g.id) > 0 {
            "at the laundry"
        } else {
            "no clean unit at home"
        });
    }
    if !reasons.is_empty() {
        Availability::Excluded(reasons)
    } else if g.planning_policy == "occasional" || g.attr_true("indoorOnly") {
        Availability::Conditional
    } else {
        Availability::Available
    }
}

fn role_words(role: &str) -> String {
    role.replacen('_', " ", 1)
}

/// `roleAccepts`: a shirt kept for layering may be a mid layer.
pub fn role_accepts(g: &Garment, role: &str) -> bool {
    if role == "mid_layer" {
        return g.roles.iter().any(|r| r == "mid_layer") || ((g.category == "shirt" || g.category == "knitwear") && g.attr_true("layeringOnly"));
    }
    g.roles.iter().any(|r| r == role)
}

const WATCH_KINDS: &[&str] = &["watch", "wristwatch", "smartwatch", "pocket_watch"];
const JEWELLERY_KINDS: &[&str] = &["jewellery", "jewelry", "ring", "bracelet", "necklace", "chain", "pendant", "cufflinks", "earring", "brooch", "bangle", "tie_clip"];
const NAME_BACKSTOP: &[&str] = &["watch", "watches", "bracelet", "necklace", "cufflink", "cufflinks"];
const ACCESSORY_NAME_BACKSTOP: &[&str] = &["wristwatch", "chronograph", "timepiece", "ring", "signet", "chain", "pendant", "earring", "earrings", "brooch", "bangle"];

/// `accessoryVerdict`: whether the "no watches or jewellery" rule covers this garment.
fn accessory_verdict(g: &Garment, excluded: &[String]) -> &'static str {
    let words: BTreeSet<String> = excluded.iter().map(|w| if w.eq_ignore_ascii_case("jewelry") { "jewellery".to_string() } else { w.to_lowercase() }).collect();
    let kind: String = g.attr_str("accessoryKind").trim().to_lowercase().split(|c: char| c.is_whitespace() || c == '-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("_");
    if !kind.is_empty() {
        let excluded = words.contains(&kind) || (words.contains("watch") && WATCH_KINDS.contains(&kind.as_str())) || (words.contains("jewellery") && JEWELLERY_KINDS.contains(&kind.as_str()));
        return if excluded { "excluded" } else { "allowed" };
    }
    let name = g.name.to_lowercase();
    // `jewel\w*` in the name backstop.
    if NAME_BACKSTOP.iter().any(|w| has_word(&name, w)) || has_word_prefix(&name, "jewel") {
        return "excluded";
    }
    if g.category == "accessory" {
        return if ACCESSORY_NAME_BACKSTOP.iter().any(|w| has_word(&name, w)) { "excluded" } else { "unclassified" };
    }
    "allowed"
}

/// `garmentViolations`: one garment in one role.
pub fn garment_violations(day: &Day<'_>, garment_id: &str, role: &str, explicit: &[String]) -> Vec<Violation> {
    let Some(g) = day.cat.get(garment_id) else {
        return vec![Violation::new("unknown_garment", "That garment is not in this wardrobe".into(), vec![garment_id.into()])];
    };
    let id = || vec![garment_id.to_string()];
    let mut out = Vec::new();
    if !role_accepts(g, role) {
        out.push(Violation::new("role_mismatch", format!("{} cannot be worn as {}", g.name, role_words(role)), id()));
    }
    if role == "top" && g.attr_true("layeringOnly") {
        out.push(Violation::new("layering_only", format!("{} is kept as a layering piece, not a base shirt", g.name), id()));
    }
    match availability(day, g) {
        Availability::Excluded(reasons) => out.push(Violation::new("unavailable", format!("{} is not available: {}", g.name, reasons.join(", ")), id())),
        Availability::Conditional if !explicit.iter().any(|e| e == garment_id) => {
            let indoor = g.attr_true("indoorOnly");
            let key = if indoor { day.cat.active_rule("socks.bed_socks_indoors_only").map(|r| r.key.as_str()) } else { None };
            out.push(Violation::new("conditional_not_requested", format!("{} is {} and is offered only on request", g.name, if indoor { "indoor-only" } else { "kept for occasional use" }), id()).rule(key));
        }
        _ => {}
    }
    // Sneakers only until the owner says his feet have healed: always in force here, because
    // nothing in this port can lift the restriction.
    if role == "footwear" {
        if let Some(rule) = sneakers_only_excludes(day.cat, g) {
            out.push(Violation::new("footwear_restricted", format!("{} is excluded while the sneakers-only restriction is active", g.name), id()).rule(Some(&rule.key)));
        }
    }
    if let Some(rule) = day.cat.active_rule("accessories.no_watches_or_jewellery") {
        let words: Vec<String> = rule.params["excluded"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
        match accessory_verdict(g, &words) {
            "excluded" => out.push(Violation::new("accessory_excluded", format!("{} is not suggested: watches and jewellery are absent by choice", g.name), id()).rule(Some(&rule.key))),
            "unclassified" => out.push(Violation::new("accessory_unclassified", format!("{} has no accessory kind recorded, so it cannot be checked against the rule that watches and jewellery are never suggested; record what kind of accessory it is first", g.name), id()).rule(Some(&rule.key))),
            _ => {}
        }
    }
    // Active fabric-class temperature rules cannot be checked without a forecast. (The profile's
    // research thresholds are pending reconciliation and stay off until the owner decides them.)
    let fabric = g.attr_str("fabricClass");
    for rule in day.cat.rules.iter().filter(|r| r.status == "active" && r.key.starts_with("thermal.")) {
        if !fabric.is_empty() && rule.params["fabricClass"].as_str() == Some(fabric) {
            out.push(Violation::new("thermal_unverified", format!("{} could not be checked against its {} temperature rule: the forecast is unavailable", g.name, role_words(fabric)), id()).rule(Some(&rule.key)).advisory());
        }
    }
    // Repeat horizon: recorded wear only (validate.ts). No exception reaches this port: the owner's
    // named-piece override and `allowRepeat` belong to day briefs, which are not ported yet.
    if let (Some(date), Some(rule)) = (day.local_date, day.cat.active_rule("variety.repeat_horizon")) {
        let days = rule.params["days"].as_i64().unwrap_or(7);
        let covered = rule.params["categories"].as_array().map_or(false, |a| a.iter().any(|c| c.as_str() == Some(g.category.as_str())));
        if covered {
            if let Some(hit) = day.last_worn(garment_id, date - days, date) {
                out.push(Violation::new("repeat_within_horizon", format!("{} was worn on {}, inside the {days}-day repeat horizon", g.name, local_date(hit)), id()).rule(Some(&rule.key)));
            }
        }
    }
    out
}

/// `validateCandidate`: every violation of a complete outfit, never just the first.
pub fn validate(day: &Day<'_>, slots: &[Slot], alternatives: &[String], explicit: &[String]) -> Validation {
    let mut out = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for id in slots.iter().map(|s| &s.garment_id).chain(alternatives.iter()) {
        if seen.contains(id) {
            out.push(Violation::new("duplicate_garment", "The same garment appears twice in one outfit".into(), vec![id.clone()]));
        } else {
            seen.push(id.clone());
        }
    }
    let in_role = |role: &str| slots.iter().filter(|s| s.role == role).map(|s| s.garment_id.clone()).collect::<Vec<_>>();
    for role in SINGLE_ROLES {
        let ids = in_role(role);
        if ids.len() > 1 {
            out.push(Violation::new("duplicate_role", format!("An outfit has one {}; alternatives go in the footwear alternatives", role_words(role)), ids));
        }
    }
    let one_piece = !in_role("one_piece").is_empty();
    for role in REQUIRED_ROLES {
        if !in_role(role).is_empty() || (one_piece && (*role == "top" || *role == "bottom")) {
            continue;
        }
        if *role == "socks" {
            let key = day.cat.active_rule("socks.required").map(|r| r.key.as_str());
            out.push(Violation::new("socks_required", "Every outfit includes socks; there is no sockless option".into(), vec![]).rule(key));
        } else {
            let code = match *role {
                "top" => "missing_top",
                "bottom" => "missing_bottom",
                _ => "missing_footwear",
            };
            out.push(Violation::new(code, format!("The outfit has no {role}"), vec![]));
        }
    }
    for slot in slots {
        out.extend(garment_violations(day, &slot.garment_id, &slot.role, explicit));
    }
    for id in alternatives {
        out.extend(garment_violations(day, id, "footwear", explicit));
    }
    let get = |role: &str| slot_of(slots, role).and_then(|id| day.cat.get(id));
    // 14-16 °C: a jacket goes over a lightweight oxford only, judged on the outdoor interval. With no
    // forecast the band cannot be ruled out, so the combination is not offered unless the jacket was named.
    if let (Some(rule), Some(outer)) = (day.cat.active_rule("thermal.jacket_14_16_lightweight_oxford_only"), get("outer")) {
        if outer.attr_true("jacketLike") || outer.category == "outerwear" {
            let required = rule.params["requiredShirtFabricClass"].as_str().unwrap_or("");
            // A one-piece outfit has no shirt under the jacket: the one-piece itself must qualify.
            let offenders: Vec<&Garment> = [get("top"), get("mid_layer"), get("one_piece")].into_iter().flatten().filter(|g| g.attr_str("fabricClass") != required).collect();
            if !offenders.is_empty() {
                let names = offenders.iter().map(|g| g.name.as_str()).collect::<Vec<_>>().join(" and ");
                let mut ids = vec![outer.id.clone()];
                ids.extend(offenders.iter().map(|g| g.id.clone()));
                let (min, max) = (rule.params["minC"].as_i64().unwrap_or(14), rule.params["maxC"].as_i64().unwrap_or(16));
                let v = Violation::new("jacket_band_unverified", format!("The {min}-{max} °C jacket rule could not be checked for {} over {names}: the forecast is unavailable", outer.name), ids).rule(Some(&rule.key));
                out.push(if explicit.contains(&outer.id) { v.advisory() } else { v });
            }
        }
    }
    if !one_piece && in_role("belt").is_empty() {
        out.push(Violation::new("missing_belt", "No belt is named".into(), vec![]).advisory());
    }
    Validation { violations: out }
}

// ───────────────────────────── colour and copy ─────────────────────────────

/// `ColourFamily` words in packages/daily/src/model.ts; the first family whose word appears wins.
const FAMILY_WORDS: &[(&str, &[&str])] = &[
    ("navy", &["navy", "indigo", "ink", "inky"]),
    ("black", &["black", "noir"]),
    ("pink", &["pink", "rose"]),
    ("red", &["red", "rust", "burgundy", "wine", "maroon", "brick", "cherry"]),
    ("yellow", &["gold", "golden", "yellow", "ochre"]),
    ("green", &["olive", "sage", "moss", "laurel", "evergreen", "forest", "pine", "fatigue", "emerald", "green", "khaki"]),
    ("brown", &["walnut", "brown", "tobacco", "mocha", "bark", "café", "cafe", "marron", "earth", "clay", "camel", "chestnut"]),
    ("blue", &["blue", "denim", "airforce"]),
    ("grey", &["grey", "gray", "charcoal", "slate", "pepper", "pow"]),
    ("light_neutral", &["beige", "sand", "stone", "cream", "bone", "natural", "biscuit", "tea", "off-white", "white", "almond", "ecru"]),
];
pub(crate) const SATURATED: &[&str] = &["red", "pink", "yellow", "green"];
pub(crate) const NEUTRAL: &[&str] = &["navy", "light_neutral", "brown", "grey", "black"];
pub(crate) const WARM: &[&str] = &["brown", "red", "pink", "yellow", "light_neutral"];
pub(crate) const COOL: &[&str] = &["navy", "blue", "green", "grey", "black"];

/// JavaScript's `\w`.
fn is_word(c: Option<char>) -> bool {
    c.map_or(false, |c| c.is_ascii_alphanumeric() || c == '_')
}

/// `/\bword\b/` as JavaScript matches it (a boundary is a change between `\w` and not `\w`).
fn has_word(text: &str, word: &str) -> bool {
    let (first, last) = (word.chars().next(), word.chars().last());
    text.match_indices(word).any(|(i, _)| {
        let before = text[..i].chars().last();
        let after = text[i + word.len()..].chars().next();
        is_word(before) != is_word(first) && is_word(last) != is_word(after)
    })
}

/// `/\bprefix\w*\b/`.
fn has_word_prefix(text: &str, prefix: &str) -> bool {
    text.match_indices(prefix).any(|(i, _)| !is_word(text[..i].chars().last()))
}

/// `colourFamily`: coarse family of a recorded colour; unknown stays unknown.
pub fn colour_family(colour: Option<&str>) -> &'static str {
    let text = colour.unwrap_or("").to_lowercase();
    if text.is_empty() {
        return "unknown";
    }
    FAMILY_WORDS.iter().find(|(_, words)| words.iter().any(|w| has_word(&text, w))).map_or("unknown", |(f, _)| f)
}

/// `neutralFamiliesOf`: every neutral family a recorded colour names (a two-colour piece counts towards each).
pub fn neutral_families(colour: &str) -> Vec<&'static str> {
    let text = colour.to_lowercase();
    FAMILY_WORDS.iter().filter(|(f, words)| NEUTRAL.contains(f) && words.iter().any(|w| has_word(&text, w))).map(|(f, _)| *f).collect()
}

fn family(g: &Garment) -> &'static str {
    colour_family(g.colour.as_deref())
}

/// `factualReason`: an explanation from record names only, inventing no styling rationale.
/// (No forecast is read in this port, so it never states a temperature.)
pub fn factual_reason(cat: &Catalogue, slots: &[Slot]) -> String {
    let g = |role: &str| slot_of(slots, role).and_then(|id| cat.get(id));
    let (top, bottom, outer, socks) = (g("top"), g("bottom"), g("outer"), g("socks"));
    let mut parts: Vec<String> = Vec::new();
    if let (Some(t), Some(b)) = (top, bottom) {
        let (a, c) = (family(t), family(b));
        let over = format!("{} over {}", t.name, b.name);
        parts.push(if a == "unknown" || c == "unknown" {
            over
        } else if (WARM.contains(&a) && COOL.contains(&c)) || (COOL.contains(&a) && WARM.contains(&c)) {
            format!("Warm against cool: {over}")
        } else if SATURATED.contains(&a) && NEUTRAL.contains(&c) {
            format!("One saturated voice in a calm frame: {over}")
        } else if a == c {
            format!("One colour at two depths: {over}")
        } else {
            over
        });
    }
    if let (Some(sk), Some(t)) = (socks, top) {
        let f = family(sk);
        if f != "unknown" && (f == family(t) || outer.map_or(false, |o| family(o) == f)) {
            parts.push("the sock echoes a colour from higher up".into());
        } else if SATURATED.contains(&f) {
            // "The single flash" only when no other piece is saturated too.
            let others_saturated = slots.iter().filter(|s| s.role != "socks").filter_map(|s| cat.get(&s.garment_id)).any(|x| SATURATED.contains(&family(x)));
            parts.push(if others_saturated { "the sock adds a further colour".into() } else { "the sock is the single flash".into() });
        }
    }
    let text = parts.join("; ");
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => format!("{}{}.", first.to_uppercase(), chars.as_str()),
        None => "A complete outfit from available pieces.".into(),
    }
}

/// `safeReason`: prose carrying item codes, percentages, links or markup is replaced by the factual reason.
fn safe_reason(cat: &Catalogue, text: &str, slots: &[Slot]) -> (String, bool) {
    let prose = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = prose.to_lowercase();
    let item_code = lower.match_indices("gmt_").any(|(i, _)| lower[i + 4..].chars().take_while(char::is_ascii_hexdigit).count() >= 6);
    let b = lower.as_bytes();
    let percent = (0..b.len()).any(|i| b[i].is_ascii_digit() && (b.get(i + 1) == Some(&b'%') || (b.get(i + 1).map_or(false, |c| c.is_ascii_whitespace()) && b.get(i + 2) == Some(&b'%'))));
    let unsafe_text = item_code || percent || lower.contains("http:") || lower.contains("https:") || prose.contains(['<', '>', '{', '}']);
    if prose.is_empty() || prose.encode_utf16().count() > 400 || unsafe_text {
        (factual_reason(cat, slots), true)
    } else {
        (prose, false)
    }
}

fn name_of(cat: &Catalogue, id: &str) -> String {
    cat.get(id).map_or_else(|| "a removed garment".to_string(), |g| g.name.clone())
}

fn top_with_bottom(cat: &Catalogue, o: &Opt) -> String {
    [o.slot("top"), o.slot("bottom")].into_iter().flatten().map(|id| name_of(cat, id)).collect::<Vec<_>>().join(" with ")
}

/// `describeChanges`: changed-item receipt lines between two offered sets, in ledger names.
pub fn describe_changes(cat: &Catalogue, before: &[Opt], after: &[Opt]) -> Vec<String> {
    let mut out = Vec::new();
    for (i, o) in after.iter().enumerate() {
        let n = i + 1;
        let Some(prev) = before.iter().find(|p| !o.option_id.is_empty() && p.option_id == o.option_id) else {
            if !before.is_empty() {
                out.push(format!("Option {n} is new: {}", top_with_bottom(cat, o)));
            }
            continue;
        };
        for s in &o.slots {
            match prev.slot(&s.role) {
                Some(old) if old != s.garment_id => out.push(format!("Option {n}: {} replaced by {}", name_of(cat, old), name_of(cat, &s.garment_id))),
                None => out.push(format!("Option {n}: {} added", name_of(cat, &s.garment_id))),
                _ => {}
            }
        }
        for s in &prev.slots {
            if o.slot(&s.role).is_none() {
                out.push(format!("Option {n}: {} removed", name_of(cat, &s.garment_id)));
            }
        }
        let in_slots = |opt: &Opt, id: &str| opt.slots.iter().any(|s| s.garment_id == id);
        for id in &o.footwear_alternatives {
            if !prev.footwear_alternatives.contains(id) && !in_slots(prev, id) {
                out.push(format!("Option {n}: {} added as the alternative shoe", name_of(cat, id)));
            }
        }
        for id in &prev.footwear_alternatives {
            if !o.footwear_alternatives.contains(id) && !in_slots(o, id) {
                out.push(format!("Option {n}: {} is no longer the alternative shoe", name_of(cat, id)));
            }
        }
    }
    for (i, p) in before.iter().enumerate() {
        if !after.iter().any(|o| o.option_id == p.option_id) {
            out.push(format!("Option {} ({}) was withdrawn", i + 1, top_with_bottom(cat, p)));
        }
    }
    out
}

/// `boardNotice`: the sources this port cannot read yet, then any shortage.
fn board_notice(shortage: Option<&str>) -> String {
    match shortage {
        Some(s) => format!("{SOURCE_NOTICE} {s}"),
        None => SOURCE_NOTICE.to_string(),
    }
}

fn shortage_line(offered: usize, requested: u64) -> Option<String> {
    ((offered as u64) < requested).then(|| format!("{offered} valid {} instead of {requested}.", if offered == 1 { "outfit" } else { "outfits" }))
}

// ───────────────────────────── payloads ─────────────────────────────

fn id_field(v: Option<&Value>, cmd: &str, field: &str) -> Result<String, CmdError> {
    match v.and_then(Value::as_str) {
        Some(x) if !x.is_empty() && x.len() <= 64 => Ok(x.to_string()),
        _ => Err(invalid(cmd, format!("{field}: expected an ID (1 to 64 characters)"))),
    }
}

fn str_list(v: Option<&Value>, cmd: &str, field: &str, max_items: usize, max_len: usize) -> Result<Vec<String>, CmdError> {
    let Some(v) = v else { return Ok(Vec::new()) };
    let bad = || invalid(cmd, format!("{field}: expected at most {max_items} strings of 1 to {max_len} characters"));
    let list = v.as_array().filter(|a| a.len() <= max_items).ok_or_else(bad)?;
    list.iter().map(|x| x.as_str().filter(|s| !s.is_empty() && s.chars().count() <= max_len).map(str::to_string).ok_or_else(bad)).collect()
}

fn enum_field(v: Option<&Value>, cmd: &str, field: &str, allowed: &[&str], default: &str) -> Result<String, CmdError> {
    match v {
        None => Ok(default.to_string()),
        Some(Value::String(x)) if allowed.contains(&x.as_str()) => Ok(x.clone()),
        _ => Err(invalid(cmd, format!("{field}: expected one of {}", allowed.join(", ")))),
    }
}

fn role_field(v: Option<&Value>, cmd: &str, field: &str) -> Result<String, CmdError> {
    match v.and_then(Value::as_str) {
        Some(r) if ROLES.contains(&r) => Ok(r.to_string()),
        _ => Err(invalid(cmd, format!("{field}: expected a role ({})", ROLES.join(", ")))),
    }
}

/// `PublishedOptionInput`.
fn option_input(v: &Value, cmd: &str, label: &str) -> Result<Opt, CmdError> {
    if !v.is_object() {
        return Err(invalid(cmd, format!("{label}: expected an object")));
    }
    only_keys(v, cmd, &["optionId", "slots", "footwearAlternatives", "reason", "explanationSource", "removedClaims", "explicitGarmentIds", "source", "suitsEventIds"])?;
    let option_id = match v.get("optionId") {
        None => String::new(),
        x => id_field(x, cmd, &format!("{label}.optionId"))?,
    };
    let list = match v.get("slots").and_then(Value::as_array) {
        Some(a) if !a.is_empty() && a.len() <= MAX_SLOTS => a,
        _ => return Err(invalid(cmd, format!("{label}.slots: expected 1 to {MAX_SLOTS} slots"))),
    };
    let mut slots = Vec::new();
    for (i, x) in list.iter().enumerate() {
        if !x.is_object() {
            return Err(invalid(cmd, format!("{label}.slots[{i}]: expected an object")));
        }
        only_keys(x, cmd, &["role", "garmentId"])?;
        slots.push(Slot { role: role_field(x.get("role"), cmd, &format!("{label}.slots[{i}].role"))?, garment_id: id_field(x.get("garmentId"), cmd, &format!("{label}.slots[{i}].garmentId"))? });
    }
    let reason = match v.get("reason").and_then(Value::as_str) {
        Some(r) if r.encode_utf16().count() <= 600 => r.to_string(),
        _ => return Err(invalid(cmd, format!("{label}.reason: expected a string of at most 600 characters"))),
    };
    Ok(Opt {
        option_id,
        slots,
        footwear_alternatives: str_list(v.get("footwearAlternatives"), cmd, &format!("{label}.footwearAlternatives"), MAX_ALTERNATIVES, 64)?,
        reason,
        suits_event_ids: str_list(v.get("suitsEventIds"), cmd, &format!("{label}.suitsEventIds"), 8, 128)?,
        explicit: str_list(v.get("explicitGarmentIds"), cmd, &format!("{label}.explicitGarmentIds"), MAX_SLOTS, 64)?,
        source: enum_field(v.get("source"), cmd, &format!("{label}.source"), SOURCES, "deterministic")?,
        explanation_source: enum_field(v.get("explanationSource"), cmd, &format!("{label}.explanationSource"), &["model_verified", "factual"], "factual")?,
        removed_claims: str_list(v.get("removedClaims"), cmd, &format!("{label}.removedClaims"), 20, 200)?,
        violations: Vec::new(),
        changed: false,
    })
}

/// The `board.publish` payload.
pub struct PublishInput {
    pub local_date: String,
    pub scope: String,
    reason: String,
    options: Vec<Opt>,
    reserves: Vec<Opt>,
    requested_count: u64,
    notice: Option<String>,
    expected_board_revision: Option<u64>,
}

/// The payload fields `board.publish`, `board.select` and `board.swap_slot` accept, published by
/// `GET /v1/command-types`. (`requestFingerprint` is not accepted: the port has no composition runs
/// to fingerprint.)
pub const PUBLISH_FIELDS: &[&str] = &["localDate", "scope", "reason", "options", "reserves", "brief", "requestedCount", "weatherSnapshotId", "calendarSnapshotId", "notice", "composedAgainst", "expectedBoardRevision"];
pub const SELECT_FIELDS: &[&str] = &["boardId", "optionId", "footwearGarmentId"];
pub const SWAP_FIELDS: &[&str] = &["boardId", "optionId", "role", "garmentId", "weatherSnapshotId"];

/// Parse a `board.publish` payload (`BoardPublish`), with this port's limits stated.
pub fn publish_input(p: &Value) -> Result<PublishInput, CmdError> {
    const T: &str = "board.publish";
    only_keys(p, T, PUBLISH_FIELDS)?;
    let local_date = match p.get("localDate").and_then(Value::as_str) {
        Some(d) if parse_local_date(d).is_some() => d.to_string(),
        _ => return Err(invalid(T, "localDate: expected a date (YYYY-MM-DD)")),
    };
    let scope = match p.get("scope") {
        None => "home".to_string(),
        Some(Value::String(x)) if scope_ok(x) => x.clone(),
        Some(Value::String(x)) if x.ends_with(":evening") => return Err(invalid(T, "scope: evening boards are not ported yet; publish the day's board")),
        Some(_) => return Err(invalid(T, "scope: expected home or trip:<tripId>")),
    };
    let list = |key: &str, required: bool| -> Result<Vec<Opt>, CmdError> {
        match p.get(key) {
            None if !required => Ok(Vec::new()),
            Some(Value::Array(a)) if a.len() <= MAX_OPTIONS => a.iter().enumerate().map(|(i, o)| option_input(o, T, &format!("{key}[{i}]"))).collect(),
            _ => Err(invalid(T, format!("{key}: expected at most {MAX_OPTIONS} options"))),
        }
    };
    let options = list("options", true)?;
    let reserves = list("reserves", false)?;
    // Only the default day brief: included and excluded pieces, occasions, repeat exceptions and
    // evening boards are not ported yet, so a brief that asks for one is refused, never ignored.
    if let Some(brief) = p.get("brief") {
        let defaults = json!({"text": null, "requestedCount": null, "include": [], "exclude": [], "occasionOnly": false, "allowRepeat": false, "segment": "day"});
        let ok = brief.as_object().map_or(false, |b| b.iter().all(|(k, v)| defaults.get(k) == Some(v)));
        if !ok {
            return Err(invalid(T, "brief: day briefs (named or excluded pieces, occasions, repeat exceptions, evenings) are not ported yet; send the default brief"));
        }
    }
    let requested_count = match p.get("requestedCount").and_then(crate::canonical::whole) {
        Some(n) if (1..=8).contains(&n) => n,
        _ => return Err(invalid(T, "requestedCount: expected a whole number from 1 to 8")),
    };
    for key in ["weatherSnapshotId", "calendarSnapshotId"] {
        match p.get(key) {
            None | Some(Value::Null) => {}
            // No snapshot can exist: weather and Calendar are not read in this port yet.
            Some(Value::String(_)) => return Err(CmdError::new("not_found", if key == "weatherSnapshotId" { "unknown weather snapshot" } else { "unknown calendar snapshot" })),
            Some(_) => return Err(invalid(T, format!("{key}: expected a snapshot ID or null"))),
        }
    }
    let notice = match p.get("notice") {
        None | Some(Value::Null) => None,
        Some(Value::String(n)) if n.chars().count() <= 400 => Some(n.clone()),
        Some(_) => return Err(invalid(T, "notice: expected a string of at most 400 characters or null")),
    };
    if let Some(c) = p.get("composedAgainst") {
        let ok = c.as_object().map_or(false, |m| m.len() == 2 && m.get("wardrobeRevision").and_then(Value::as_u64).is_some() && m.get("styleRevision").and_then(Value::as_u64).is_some());
        if !ok {
            return Err(invalid(T, "composedAgainst: expected {wardrobeRevision, styleRevision}"));
        }
    }
    let expected_board_revision = match p.get("expectedBoardRevision") {
        None => None,
        Some(x) => Some(crate::canonical::whole(x).ok_or_else(|| invalid(T, "expectedBoardRevision: expected a whole number"))?),
    };
    Ok(PublishInput {
        local_date,
        scope,
        reason: enum_field(p.get("reason"), T, "reason", REASONS, "compose")?,
        options,
        reserves,
        requested_count,
        notice,
        expected_board_revision,
    })
}

/// The board a `board.select` or `board.swap_slot` payload names.
pub fn named_board(kind: &str, p: &Value) -> Result<String, CmdError> {
    id_field(p.get("boardId"), kind, "boardId")
}

// ───────────────────────────── commands ─────────────────────────────

/// A planned board command: the receipt's plan and the board as it is to be stored.
pub struct Outcome {
    pub plan: Plan,
    pub board: Board,
    /// True when the board is new and must be added to the ledger's index.
    pub created: bool,
}

fn new_id(ctx: &Ctx<'_>, prefix: &str, n: usize) -> String {
    format!("{prefix}_{}", &hex_digest(format!("{}\u{0}{prefix}\u{0}{n}", ctx.command_id).as_bytes())[..24])
}

fn affected(board: &Board) -> Vec<Value> {
    vec![json!({"kind": "board", "id": board.board_id, "version": board.current_revision})]
}

fn no_board(id: &str) -> CmdError {
    CmdError::with("not_found", format!("no board '{id}'"), json!({"boardId": id}))
}

fn blockers_text(v: &Validation) -> String {
    v.blocking().iter().map(|x| x.message.as_str()).collect::<Vec<_>>().join("; ")
}

struct Draft {
    requested_count: u64,
    notice: Option<String>,
    changes: Vec<String>,
    offered: Vec<Opt>,
    reserves: Vec<Opt>,
    undo_of_swap: Option<(u64, u64)>,
    dropped: Vec<Value>,
    swap_weather_basis: Option<String>,
}

/// `planRevisionWrite`: the next revision, with the choice kept while its option is still offered.
fn write_revision(ctx: &Ctx<'_>, existing: Option<&Board>, scope: &str, day: &str, reason: String, mut d: Draft) -> Board {
    let mut board = existing.cloned().unwrap_or_else(|| Board {
        board_id: new_id(ctx, "brd", 0),
        scope: scope.to_string(),
        local_date: day.to_string(),
        status: "active".into(),
        current_revision: 0,
        selected_option_id: None,
        selected_footwear_id: None,
        selected_at_ms: None,
        selection_version: 0,
        revisions: Vec::new(),
    });
    let mut n = 0;
    for o in d.offered.iter_mut().chain(d.reserves.iter_mut()) {
        n += 1;
        if o.option_id.is_empty() {
            o.option_id = new_id(ctx, "opt", n);
        }
    }
    let selected = board.selected_option_id.as_ref().and_then(|id| d.offered.iter().find(|o| &o.option_id == id));
    let footwear = match (selected, &board.selected_footwear_id) {
        (Some(o), Some(f)) if o.slot("footwear") == Some(f.as_str()) || o.footwear_alternatives.contains(f) => Some(f.clone()),
        _ => None,
    };
    let selected_id = selected.map(|o| o.option_id.clone());
    // Dropping (or narrowing) the choice is itself a change of choice.
    if board.selected_option_id != selected_id || board.selected_footwear_id != footwear {
        board.selection_version += 1;
    }
    if selected_id.is_none() {
        board.selected_at_ms = None;
    }
    board.selected_option_id = selected_id;
    board.selected_footwear_id = footwear;
    board.current_revision += 1;
    board.revisions.push(Revision {
        revision: board.current_revision,
        reason,
        published_at_ms: ctx.now_ms,
        requested_count: d.requested_count,
        notice: d.notice,
        changes: d.changes,
        command_id: ctx.command_id.to_string(),
        offered: d.offered,
        reserves: d.reserves,
        undo_of_swap: d.undo_of_swap,
        dropped: d.dropped,
        swap_weather_basis: d.swap_weather_basis,
    });
    if board.revisions.len() > REVISIONS_KEPT {
        board.revisions.remove(0);
    }
    board
}

/// `board.publish`: revalidate every candidate against the stock this command read; publish the valid ones.
pub fn publish(ctx: &Ctx<'_>, day: &Day<'_>, existing: Option<&Board>, p: PublishInput) -> Result<Outcome, CmdError> {
    let current_revision = existing.map_or(0, |b| b.current_revision);
    if let Some(expected) = p.expected_board_revision {
        if expected != current_revision {
            return Err(CmdError::with(
                "precondition_failed",
                "the day's board changed while this one was being composed; nothing was published over it",
                json!({"boardChanged": true, "boardId": existing.map(|b| b.board_id.clone()), "currentRevision": current_revision}),
            ));
        }
    }
    // No owner timezone is ported, so "past" is past everywhere on Earth.
    let date = parse_local_date(&p.local_date).unwrap_or(i64::MIN);
    let earliest = earliest_day(ctx.now_ms);
    if date < earliest {
        return Err(CmdError::with("invalid_command", "a board cannot be published for a past day", json!({"localDate": p.local_date, "today": local_date(earliest)})));
    }
    if date > latest_day(ctx.now_ms) + MAX_DAYS_AHEAD {
        return Err(CmdError::with("invalid_command", format!("a board can be published at most {MAX_DAYS_AHEAD} days ahead"), json!({"localDate": p.local_date})));
    }
    let previous: Vec<Opt> = existing.and_then(Board::current).map(|r| r.offered.iter().chain(r.reserves.iter()).cloned().collect()).unwrap_or_default();
    let previous_offered: Vec<Opt> = existing.and_then(Board::current).map(|r| r.offered.clone()).unwrap_or_default();
    let mut dropped: Vec<Value> = Vec::new();
    let mut used_tops: BTreeSet<String> = BTreeSet::new();
    let mut used_keys: BTreeSet<String> = BTreeSet::new();
    // An existing option ID names one published option; a second candidate carrying it gets a new ID.
    let mut used_ids: BTreeSet<String> = BTreeSet::new();
    let mut accept = |input: &Opt, label: String| -> Option<Opt> {
        // An explicit request counts for a piece the candidate wears, in a slot or as a footwear choice.
        let explicit: Vec<String> = input.explicit.iter().filter(|id| input.slots.iter().any(|s| &s.garment_id == *id) || input.footwear_alternatives.contains(id)).cloned().collect();
        let validation = validate(day, &input.slots, &input.footwear_alternatives, &explicit);
        if !validation.valid() {
            dropped.push(json!({"position": label, "violations": validation.blocking().iter().map(|x| format!("{}: {}", x.code, x.message)).collect::<Vec<_>>()}));
            return None;
        }
        let top = input.slot("top").or_else(|| input.slot("one_piece")).map(str::to_string);
        let mut key: Vec<String> = input.slots.iter().map(|s| format!("{}:{}", s.role, s.garment_id)).collect();
        key.sort();
        let key = key.join("|");
        if top.as_ref().map_or(false, |t| used_tops.contains(t)) || used_keys.contains(&key) {
            dropped.push(json!({"position": label, "violations": ["duplicate: the same shirt is already offered on this board"]}));
            return None;
        }
        if let Some(t) = top {
            used_tops.insert(t);
        }
        used_keys.insert(key);
        let (reason, replaced) = safe_reason(day.cat, &input.reason, &input.slots);
        let prev = (!input.option_id.is_empty() && !used_ids.contains(&input.option_id)).then(|| previous.iter().find(|o| o.option_id == input.option_id)).flatten();
        if let Some(o) = prev {
            used_ids.insert(o.option_id.clone());
        }
        let same = prev.map_or(false, |o| o.slots == input.slots && o.footwear_alternatives == input.footwear_alternatives);
        Some(Opt {
            option_id: prev.map(|o| o.option_id.clone()).unwrap_or_default(),
            slots: input.slots.clone(),
            footwear_alternatives: input.footwear_alternatives.clone(),
            reason,
            suits_event_ids: input.suits_event_ids.clone(),
            explicit,
            source: input.source.clone(),
            explanation_source: if replaced { "factual".into() } else { input.explanation_source.clone() },
            removed_claims: input.removed_claims.clone(),
            violations: validation.advisories(),
            changed: existing.is_some() && !same,
        })
    };
    let mut offered: Vec<Opt> = p.options.iter().enumerate().filter_map(|(i, o)| accept(o, format!("option {}", i + 1))).collect();
    let mut pool: Vec<Opt> = p.reserves.iter().enumerate().filter_map(|(i, o)| accept(o, format!("reserve {}", i + 1))).collect();
    // A dropped option is replaced from the complete reserves; the count is never padded.
    while (offered.len() as u64) < p.requested_count.min(p.options.len() as u64) && !pool.is_empty() {
        let mut o = pool.remove(0);
        o.changed = existing.is_some();
        offered.push(o);
    }
    if offered.is_empty() {
        return Err(CmdError::with("precondition_failed", "no candidate is a valid outfit against the current wardrobe; nothing was published", json!({"dropped": dropped})));
    }
    pool.truncate(RESERVE_COUNT);
    let shortage = shortage_line(offered.len(), p.requested_count).map(|line| p.notice.clone().unwrap_or(line));
    let changes = match existing {
        None => Vec::new(),
        Some(_) if ["compose", "rebuild", "resume"].contains(&p.reason.as_str()) => vec!["The board was recomposed.".to_string()],
        Some(_) => describe_changes(day.cat, &previous_offered, &offered),
    };
    let n = offered.len();
    let reserves_n = pool.len();
    let draft = Draft {
        requested_count: p.requested_count,
        notice: Some(board_notice(shortage.as_deref())),
        changes,
        offered,
        reserves: pool,
        undo_of_swap: None,
        dropped: dropped.clone(),
        swap_weather_basis: None,
    };
    let board = write_revision(ctx, existing, &p.scope, &p.local_date, p.reason.clone(), draft);
    let revision = board.current_revision;
    let option_ids: Vec<String> = board.current().map(|r| r.offered.iter().map(|o| o.option_id.clone()).collect()).unwrap_or_default();
    let summary = format!(
        "Board for {} published (revision {revision}): {n} {}{}{}",
        p.local_date,
        if n == 1 { "outfit" } else { "outfits" },
        if (n as u64) < p.requested_count { format!(" of {} requested", p.requested_count) } else { String::new() },
        if dropped.is_empty() { String::new() } else { format!("; {} stale or invalid candidate{} not published", dropped.len(), if dropped.len() == 1 { "" } else { "s" }) },
    );
    let result = json!({
        "boardId": board.board_id, "revision": revision, "localDate": p.local_date, "scope": p.scope, "offered": n, "reserves": reserves_n,
        "requestedCount": p.requested_count, "dropped": dropped, "optionIds": option_ids, "exposureId": null,
    });
    Ok(Outcome { plan: Plan { outcome: "committed", summary, affected: affected(&board), repairs: vec![], result, undo: Err(ALREADY_PUBLISHED.into()) }, board, created: existing.is_none() })
}

fn offered_of(board: &Board) -> Vec<Opt> {
    board.current().map(|r| r.offered.clone()).unwrap_or_default()
}

/// `board.select`: choose an option (an intention, never a wear) or clear the choice.
pub fn select(ctx: &Ctx<'_>, day: &Day<'_>, board: Option<&Board>, p: &Value) -> Result<Outcome, CmdError> {
    const T: &str = "board.select";
    only_keys(p, T, SELECT_FIELDS)?;
    let board_id = named_board(T, p)?;
    let option_id = match p.get("optionId") {
        Some(Value::Null) => None,
        Some(x) => Some(id_field(Some(x), T, "optionId")?),
        None => return Err(invalid(T, "optionId: required (null clears the choice)")),
    };
    let footwear_asked = match p.get("footwearGarmentId") {
        None | Some(Value::Null) => None,
        x => Some(id_field(x, T, "footwearGarmentId")?),
    };
    let board = board.ok_or_else(|| no_board(&board_id))?;
    let options = offered_of(board);
    let option = match &option_id {
        None => None,
        Some(id) => Some(options.iter().find(|o| &o.option_id == id).ok_or_else(|| {
            CmdError::with("not_found", "that option is not on the current board revision; choose from the current board", json!({"revision": board.current_revision}))
        })?),
    };
    // Automatic repair is not ported, so a choice is checked against the stock this command read: an
    // outfit a later report made unwearable is not chosen.
    if let Some(o) = option {
        let now = validate(day, &o.slots, &o.footwear_alternatives, &o.explicit);
        if !now.valid() {
            let blockers: Vec<Value> = now.blocking().iter().map(|v| v.to_json()).collect();
            return Err(CmdError::with(
                "precondition_failed",
                format!("that outfit is no longer wearable as published: {}; nothing was chosen", blockers_text(&now)),
                json!({"violations": blockers, "optionId": o.option_id}),
            ));
        }
    }
    let mut footwear = None;
    if let Some(o) = option {
        let main = o.slot("footwear").map(str::to_string);
        footwear = footwear_asked.clone().or_else(|| if o.footwear_alternatives.is_empty() { main.clone() } else { None });
        if let Some(f) = &footwear {
            if Some(f) != main.as_ref() && !o.footwear_alternatives.contains(f) {
                return Err(invalid(T, "that shoe is not one of this option's footwear choices"));
            }
        }
    }
    let version = board.selection_version;
    let undo = json!({
        "boardId": board.board_id,
        "previousOptionId": board.selected_option_id,
        "previousFootwearId": board.selected_footwear_id,
        "previousAt": board.selected_at_ms.map(instant),
        "wrote": {"version": version + 1},
    });
    let mut next = board.clone();
    next.selected_option_id = option.map(|o| o.option_id.clone());
    next.selected_footwear_id = footwear.clone();
    next.selected_at_ms = option.map(|_| ctx.now_ms);
    next.selection_version = version + 1;
    let summary = match option {
        Some(o) => format!("Chosen for {}: option {} (an intention, not a recorded wear)", board.local_date, options.iter().position(|x| x.option_id == o.option_id).map_or(0, |i| i + 1)),
        None => format!("Selection cleared for {}", board.local_date),
    };
    let result = json!({"boardId": board.board_id, "revision": board.current_revision, "selectedOptionId": next.selected_option_id, "footwearGarmentId": footwear});
    Ok(Outcome { plan: Plan { outcome: "committed", summary, affected: affected(&next), repairs: vec![], result, undo: Ok(undo) }, board: next, created: false })
}

fn undo_summary(original_summary: &str, text: &str) -> String {
    let original = if original_summary.is_empty() { "an earlier action" } else { original_summary.trim_end_matches('.') };
    format!("Undone: {original}. {text}")
}

fn with_undone(mut result: Value, target: &str) -> Value {
    result["undoneCommandId"] = json!(target);
    result
}

/// The undo of a `board.select`: restore the earlier choice while this one is still the board's.
pub fn undo_select(_ctx: &Ctx<'_>, board: Option<&Board>, data: &Value, original_summary: &str, target: &str) -> Result<Outcome, CmdError> {
    let id = data["boardId"].as_str().unwrap_or_default();
    let board = board.ok_or_else(|| no_board(id))?;
    let Some(wrote) = data["wrote"]["version"].as_u64() else {
        return Err(CmdError::with("precondition_failed", "this choice was recorded before choices were versioned, so it cannot be told apart from a newer one; choose again instead of undoing", json!({"selectionUnversioned": true})));
    };
    if board.selection_version != wrote {
        return Err(CmdError::with("conflict", "the choice changed after this one; undo the newer choice first", json!({"selectedOptionId": board.selected_option_id})));
    }
    let options = offered_of(board);
    let previous = data["previousOptionId"].as_str();
    let option = previous.and_then(|p| options.iter().find(|o| o.option_id == p));
    let restorable = previous.is_none() || option.is_some();
    let mut footwear = None;
    if let Some(o) = option {
        let main = o.slot("footwear");
        footwear = match data["previousFootwearId"].as_str() {
            Some(f) if Some(f) == main || o.footwear_alternatives.iter().any(|a| a == f) => Some(f.to_string()),
            _ if o.footwear_alternatives.is_empty() => main.map(str::to_string),
            _ => None,
        };
    }
    let mut next = board.clone();
    next.selected_option_id = option.map(|o| o.option_id.clone());
    next.selected_footwear_id = footwear.clone();
    next.selected_at_ms = option.and_then(|_| data["previousAt"].as_str().and_then(parse_instant));
    next.selection_version = board.selection_version + 1;
    let text = if restorable { "Selection restored to what it was" } else { "Selection cleared: the earlier choice is no longer on the board" };
    let result = json!({"boardId": board.board_id, "revision": board.current_revision, "selectedOptionId": next.selected_option_id, "footwearGarmentId": footwear});
    Ok(Outcome {
        plan: Plan { outcome: "committed", summary: undo_summary(original_summary, text), affected: affected(&next), repairs: vec![], result: with_undone(result, target), undo: Err(ALREADY_AN_UNDO.into()) },
        board: next,
        created: false,
    })
}

/// `findReplacement`: another piece for one slot, keeping every other piece. A navy piece is taken
/// only when nothing else validates ("never fall back to navy").
fn find_replacement(day: &Day<'_>, option: &Opt, role: &str, avoid: &BTreeSet<String>, explicit: &[String]) -> Option<(Vec<Slot>, Validation)> {
    let original = option.slot(role).and_then(|id| day.cat.get(id));
    let navy = day.cat.active_rule("swap.never_fall_back_to_navy").and_then(|r| r.params["avoidColourFamilyOnSwap"].as_str());
    let mut ranked: Vec<(u8, u8, &Garment)> = day
        .cat
        .garments
        .iter()
        .filter(|g| role_accepts(g, role) && !option.slots.iter().any(|s| s.garment_id == g.id) && !avoid.contains(&g.id) && !option.footwear_alternatives.contains(&g.id))
        .filter(|g| garment_violations(day, &g.id, role, explicit).iter().all(|v| !v.blocking))
        .map(|g| {
            let tier = u8::from(navy.map_or(false, |f| family(g) == f));
            let same_fabric = original.map_or(false, |o| !g.attr_str("fabricClass").is_empty() && g.attr_str("fabricClass") == o.attr_str("fabricClass"));
            (tier, u8::from(!same_fabric), g)
        })
        .collect();
    ranked.sort_by(|a, b| (a.0, a.1, &a.2.id).cmp(&(b.0, b.1, &b.2.id)));
    for (_, _, g) in ranked {
        let slots = replace_slot(&option.slots, role, &g.id);
        let validation = validate(day, &slots, &option.footwear_alternatives, explicit);
        if validation.valid() {
            return Some((slots, validation));
        }
    }
    None
}

fn replace_slot(slots: &[Slot], role: &str, garment_id: &str) -> Vec<Slot> {
    if slots.iter().any(|s| s.role == role) {
        slots.iter().map(|s| if s.role == role { Slot { role: role.into(), garment_id: garment_id.into() } } else { s.clone() }).collect()
    } else {
        let mut out = slots.to_vec();
        out.push(Slot { role: role.into(), garment_id: garment_id.into() });
        out
    }
}

fn weather_basis(role: &str) -> &'static str {
    // No forecast is read in this port: a weather-affected swap is checked without one, stated as such.
    if WEATHER_ROLES.contains(&role) { "unavailable" } else { "not_weather_dependent" }
}

/// `board.swap_slot`: replace one piece of one option (the owner's pick, validated, or a replacement).
pub fn swap(ctx: &Ctx<'_>, day: &Day<'_>, board: Option<&Board>, p: &Value) -> Result<Outcome, CmdError> {
    const T: &str = "board.swap_slot";
    only_keys(p, T, SWAP_FIELDS)?;
    let board_id = named_board(T, p)?;
    let option_id = id_field(p.get("optionId"), T, "optionId")?;
    let role = role_field(p.get("role"), T, "role")?;
    let picked = match p.get("garmentId") {
        None => None,
        x => Some(id_field(x, T, "garmentId")?),
    };
    match p.get("weatherSnapshotId") {
        None => {}
        Some(Value::String(_)) => return Err(CmdError::new("not_found", "unknown weather snapshot")),
        Some(_) => return Err(invalid(T, "weatherSnapshotId: expected a snapshot ID")),
    }
    let board = board.ok_or_else(|| no_board(&board_id))?;
    let Some(revision) = board.current() else { return Err(no_board(&board_id)) };
    let offered = revision.offered.clone();
    let Some(option) = offered.iter().find(|o| o.option_id == option_id) else {
        return Err(CmdError::with("not_found", "that option is not on the current board revision", json!({"revision": board.current_revision})));
    };
    let mut avoid = BTreeSet::new();
    if role == "top" || role == "bottom" {
        for o in offered.iter().filter(|o| o.option_id != option_id) {
            if let Some(id) = o.slot(&role) {
                avoid.insert(id.to_string());
            }
        }
    }
    // `replace_slot` replaces the role's one slot; an outfit with two pieces in the role (two
    // accessories) does not say which one is meant.
    if option.slots.iter().filter(|s| s.role == role).count() > 1 {
        return Err(CmdError::with(
            "invalid_command",
            format!("this outfit has more than one {}, so which one to swap is ambiguous; nothing was changed", role_words(&role)),
            json!({"optionId": option_id, "role": role}),
        ));
    }
    let previous_id = option.slot(&role).map(str::to_string);
    let kept_explicit: Vec<String> = option.explicit.iter().filter(|id| Some(*id) != previous_id.as_ref()).cloned().collect();
    let (slots, validation, explicit) = match &picked {
        Some(gid) => {
            // A shirt already offered in another option is refused here as publication drops it there.
            let shirt_roles = ["top", "one_piece"];
            if shirt_roles.contains(&role.as_str()) {
                if let Some((i, _)) = offered.iter().enumerate().find(|(_, o)| o.option_id != option_id && shirt_roles.iter().any(|r| o.slot(r) == Some(gid.as_str()))) {
                    return Err(CmdError::with(
                        "precondition_failed",
                        format!("{} is already offered in option {}; choose another piece; nothing was changed", name_of(day.cat, gid), i + 1),
                        json!({"violations": [{"code": "duplicate", "garmentIds": [gid]}]}),
                    ));
                }
            }
            // The owner's own pick, validated as given: it admits an occasional piece, never absent or restricted stock.
            let slots = replace_slot(&option.slots, &role, gid);
            let mut explicit = kept_explicit.clone();
            explicit.push(gid.clone());
            let alternatives: Vec<String> = option.footwear_alternatives.iter().filter(|a| *a != gid).cloned().collect();
            let validation = validate(day, &slots, &alternatives, &explicit);
            if !validation.valid() {
                let blockers: Vec<Value> = validation.blocking().iter().map(|v| v.to_json()).collect();
                return Err(CmdError::with("precondition_failed", format!("that swap does not make a valid outfit: {}; nothing was changed", blockers_text(&validation)), json!({"violations": blockers})));
            }
            (slots, validation, explicit)
        }
        None => match find_replacement(day, option, &role, &avoid, &kept_explicit) {
            Some((slots, validation)) => (slots, validation, kept_explicit.clone()),
            None => return Err(CmdError::new("precondition_failed", format!("nothing else eligible can take that {} slot today; the option is unchanged", role_words(&role)))),
        },
    };
    let alternatives: Vec<String> = option.footwear_alternatives.iter().filter(|a| !slots.iter().any(|s| &s.garment_id == *a)).cloned().collect();
    let swapped = Opt {
        option_id: option.option_id.clone(),
        reason: factual_reason(day.cat, &slots),
        slots: slots.clone(),
        footwear_alternatives: alternatives,
        suits_event_ids: option.suits_event_ids.clone(),
        explicit,
        source: "owner_swap".into(),
        explanation_source: "factual".into(),
        removed_claims: vec![],
        violations: validation.advisories(),
        changed: true,
    };
    let next_offered: Vec<Opt> = offered.iter().map(|o| if o.option_id == option_id { swapped.clone() } else { Opt { changed: false, ..o.clone() } }).collect();
    let next_reserves: Vec<Opt> = revision
        .reserves
        .iter()
        .filter(|r| !r.slots.iter().any(|s| (s.role == "top" || s.role == "bottom") && slots.iter().any(|n| n.garment_id == s.garment_id)))
        .map(|r| Opt { changed: false, ..r.clone() })
        .collect();
    let basis = weather_basis(&role);
    let draft = Draft {
        requested_count: revision.requested_count,
        notice: revision.notice.clone(),
        changes: describe_changes(day.cat, &offered, &next_offered),
        offered: next_offered,
        reserves: next_reserves,
        undo_of_swap: None,
        dropped: vec![],
        swap_weather_basis: Some(basis.into()),
    };
    let next = write_revision(ctx, Some(board), &board.scope, &board.local_date, "swap".into(), draft);
    let new_id = slot_of(&slots, &role).unwrap_or_default().to_string();
    let n = offered.iter().position(|o| o.option_id == option_id).map_or(0, |i| i + 1);
    let summary = match &previous_id {
        Some(prev) => format!("Option {n} for {}: {} swapped for {}; the rest of the outfit is unchanged", board.local_date, name_of(day.cat, prev), name_of(day.cat, &new_id)),
        None => format!("Option {n} for {}: added {}; the rest of the outfit is unchanged", board.local_date, name_of(day.cat, &new_id)),
    };
    let result = json!({
        "boardId": board.board_id, "revision": next.current_revision, "optionId": option_id, "role": role, "garmentId": new_id,
        "replacedGarmentId": previous_id, "weatherBasis": basis, "weatherAgeMinutes": null,
    });
    let undo = json!({"boardId": board.board_id, "revisionBefore": board.current_revision, "revisionAfter": next.current_revision, "optionId": option_id, "role": role});
    Ok(Outcome { plan: Plan { outcome: "committed", summary, affected: affected(&next), repairs: vec![], result, undo: Ok(undo) }, board: next, created: false })
}

/// The undo of a `board.swap_slot`: publish the board as it was before the swap as a new revision,
/// only while the board still shows the swap (directly, or through undos that restored it) and every
/// earlier outfit, reserves included, is still valid now.
pub fn undo_swap(ctx: &Ctx<'_>, day: &Day<'_>, board: Option<&Board>, data: &Value, original_summary: &str, target: &str) -> Result<Outcome, CmdError> {
    let id = data["boardId"].as_str().unwrap_or_default();
    let board = board.ok_or_else(|| no_board(id))?;
    let (before_n, after_n) = (data["revisionBefore"].as_u64().unwrap_or(0), data["revisionAfter"].as_u64().unwrap_or(0));
    let option_id = data["optionId"].as_str().unwrap_or_default();
    let role = data["role"].as_str().unwrap_or_default();
    // The revision the board shows, seen through undo revisions; the walk strictly descends.
    let mut shown = board.current_revision;
    while shown != after_n {
        match board.revision(shown).and_then(|r| r.undo_of_swap) {
            Some((_, restored)) if restored < shown => shown = restored,
            _ => break,
        }
    }
    if shown != after_n {
        return Err(CmdError::with("conflict", "the board changed after this swap; undo the newer change first, or swap the piece back", json!({"revision": board.current_revision, "swapRevision": after_n})));
    }
    let Some(before_rev) = board.revision(before_n) else {
        return Err(CmdError::new("precondition_failed", "the board revision before the swap is not recorded"));
    };
    let Some(before) = before_rev.offered.iter().chain(before_rev.reserves.iter()).find(|o| o.option_id == option_id) else {
        return Err(CmdError::new("precondition_failed", "the option as it was before the swap is not recorded"));
    };
    let revalidate = |o: &Opt, reserve: bool| -> Result<Opt, CmdError> {
        let v = validate(day, &o.slots, &o.footwear_alternatives, &o.explicit);
        if !v.valid() {
            let blockers: Vec<Value> = v.blocking().iter().map(|x| x.to_json()).collect();
            return Err(CmdError::with(
                "precondition_failed",
                format!("the board as it was before the swap is no longer valid{}: {}; nothing was changed", if reserve { " (one of its reserve outfits)" } else { "" }, blockers_text(&v)),
                json!({"violations": blockers, "optionId": o.option_id}),
            ));
        }
        Ok(Opt { violations: v.advisories(), changed: !reserve && o.option_id == option_id, ..o.clone() })
    };
    let next_offered = before_rev.offered.iter().map(|o| revalidate(o, false)).collect::<Result<Vec<_>, _>>()?;
    let next_reserves = before_rev.reserves.iter().map(|o| revalidate(o, true)).collect::<Result<Vec<_>, _>>()?;
    let current_offered = offered_of(board);
    let requested = board.current().map_or(before_rev.requested_count, |r| r.requested_count);
    let basis = weather_basis(role);
    let back = before.slot(role).map(str::to_string);
    let n = next_offered.iter().position(|o| o.option_id == option_id).map_or(0, |i| i + 1);
    let draft = Draft {
        requested_count: requested,
        notice: Some(board_notice(shortage_line(next_offered.len(), requested).as_deref())),
        changes: describe_changes(day.cat, &current_offered, &next_offered),
        offered: next_offered,
        reserves: next_reserves,
        undo_of_swap: Some((after_n, before_n)),
        dropped: vec![],
        swap_weather_basis: Some(basis.into()),
    };
    let next = write_revision(ctx, Some(board), &board.scope, &board.local_date, "swap".into(), draft);
    let text = format!(
        "Option {n} for {}: swap undone; the outfits of revision {before_n} are back{}",
        board.local_date,
        back.as_ref().map_or(String::new(), |b| format!(" ({} is back)", name_of(day.cat, b))),
    );
    let result = json!({"boardId": board.board_id, "revision": next.current_revision, "optionId": option_id, "role": role, "garmentId": back, "weatherBasis": basis});
    Ok(Outcome {
        plan: Plan { outcome: "committed", summary: undo_summary(original_summary, &text), affected: affected(&next), repairs: vec![], result: with_undone(result, target), undo: Err(ALREADY_AN_UNDO.into()) },
        board: next,
        created: false,
    })
}

// ───────────────────────────── reading ─────────────────────────────

/// The sneakers-only healing restriction, when it is active and excludes this footwear: a kind it
/// does not allow, or an excluded model. Nothing in this port can lift it.
pub fn sneakers_only_excludes<'c>(cat: &'c Catalogue, g: &Garment) -> Option<&'c crate::seed::Rule> {
    let rule = cat.active_rule("footwear.sneakers_only_until_healed")?;
    let allowed = rule.params["allowedFootwearKinds"].as_array().cloned().unwrap_or_default();
    let excluded_models: Vec<String> = rule.params["excludedModels"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_lowercase).collect()).unwrap_or_default();
    let kind = g.attr_str("footwearKind");
    let model = g.attr_str("model").to_lowercase();
    (!allowed.iter().any(|k| k.as_str() == Some(kind)) || (!model.is_empty() && excluded_models.contains(&model))).then_some(rule)
}

/// One garment as a board line (`BoardGarmentLine`).
pub fn line(cat: &Catalogue, role: &str, id: &str) -> Value {
    let g = cat.get(id);
    json!({"garmentId": id, "role": role, "name": name_of(cat, id), "colour": g.and_then(|g| g.colour.clone())})
}

/// The board as the app and a connected assistant read it (`BoardDocument`). Automatic repair is not
/// ported, so every option is checked again against the stock read with the board (`day`): an option a
/// later report made unwearable carries a qualification saying why, and the board reads as degraded.
pub fn document(day: &Day<'_>, board: &Board, wardrobe_revision: u64) -> Value {
    let cat = day.cat;
    let Some(r) = board.current() else { return Value::Null };
    let mut stale = 0;
    let options: Vec<Value> = r
        .offered
        .iter()
        .enumerate()
        .map(|(i, o)| {
            let now = validate(day, &o.slots, &o.footwear_alternatives, &o.explicit);
            let qualification = (!now.valid()).then(|| {
                stale += 1;
                format!("No longer wearable as published: {}.", blockers_text(&now))
            });
            let name = match (o.slot("top"), o.slot("bottom"), o.slot("one_piece")) {
                (_, _, Some(one)) => name_of(cat, one),
                (Some(t), Some(b), _) => format!("{} with {}", name_of(cat, t), name_of(cat, b)),
                _ => format!("Option {}", i + 1),
            };
            json!({
                "optionId": o.option_id,
                "number": i + 1,
                "name": name,
                "reason": o.reason,
                "garments": o.slots.iter().filter(|s| s.role != "neckwear").map(|s| line(cat, &s.role, &s.garment_id)).collect::<Vec<_>>(),
                "footwearAlternatives": o.footwear_alternatives.iter().map(|id| line(cat, "footwear", id)).collect::<Vec<_>>(),
                "flourish": o.slot("neckwear").map(|id| line(cat, "neckwear", id)),
                "suitsEventIds": o.suits_event_ids,
                "qualification": qualification,
                "changedInRevision": o.changed,
            })
        })
        .collect();
    let selection = match (&board.selected_option_id, board.selected_at_ms) {
        (Some(id), Some(at)) => json!({"optionId": id, "footwearGarmentId": board.selected_footwear_id, "selectedAt": instant(at)}),
        (Some(id), None) => json!({"optionId": id, "footwearGarmentId": board.selected_footwear_id, "selectedAt": null}),
        _ => Value::Null,
    };
    json!({
        "boardId": board.board_id,
        "scope": board.scope,
        "localDate": board.local_date,
        // The owner's timezone is the default setting (no settings command is ported).
        "timezone": crate::time::OWNER_TIMEZONE,
        "revision": r.revision,
        "publishedAt": instant(r.published_at_ms),
        "reason": r.reason,
        "validity": if stale > 0 || (r.offered.len() as u64) < r.requested_count { "degraded" } else { "limited" },
        "dayLine": parse_local_date(&board.local_date).map(day_line).unwrap_or_default(),
        "weatherLine": null,
        "suitabilityLine": null,
        "notice": r.notice,
        "requestedCount": r.requested_count,
        "options": options,
        "selection": selection,
        "changes": r.changes,
        "brief": {"text": null, "requestedCount": null, "include": [], "exclude": [], "occasionOnly": false, "allowRepeat": false, "segment": "day"},
        "freshness": {
            "weather": "unavailable", "weatherSnapshotId": null, "weatherFetchedAt": null,
            "calendar": "not_connected", "calendarSnapshotId": null, "calendarReadAt": null,
            "wardrobeRevision": wardrobe_revision, "styleRevision": 0,
        },
        "calendarProjection": {"state": "not_connected", "projectedRevision": null, "action": null},
    })
}

/// `TodayResponse` for one day (`readToday` in apps/worker/src/routes/daily.ts: the daily service's
/// `TodayView` with the API's status, freshness list and wardrobe revision); `day_record` is what was
/// recorded as worn that day. The port composes no board in the background, so there is never a run.
pub fn today(stock: &Day<'_>, day: &str, board: Option<&Board>, day_record: Vec<Value>, wardrobe_revision: u64, now_ms: u64) -> Value {
    let doc = board.map_or(Value::Null, |b| document(stock, b, wardrobe_revision));
    let empty = doc.is_null().then_some("No board has been published for this day yet.");
    let mut freshness = Vec::new();
    if !doc.is_null() {
        let published = doc["publishedAt"].clone();
        let changes: Vec<&str> = doc["changes"].as_array().map(|c| c.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        freshness.push(json!({"source": "board", "state": "fresh", "checkedAt": published, "revision": doc["revision"], "detail": doc["notice"]}));
        // Every read checks the board's options against the stock of the same commit, so the
        // wardrobe revision shown is the current one.
        freshness.push(json!({"source": "wardrobe", "state": "fresh", "checkedAt": published, "revision": wardrobe_revision, "detail": if changes.is_empty() { Value::Null } else { json!(changes.join(" ")) }}));
        // No style command is ported: the style revision is always the one the board was built on.
        freshness.push(json!({"source": "style", "state": "fresh", "checkedAt": published, "revision": doc["freshness"]["styleRevision"], "detail": null}));
        freshness.push(json!({"source": "weather", "state": "unavailable", "checkedAt": null, "revision": null, "detail": "No usable forecast."}));
        freshness.push(json!({"source": "calendar", "state": "not_connected", "checkedAt": null, "revision": null, "detail": "Calendar is not connected."}));
    }
    let mut view = Map::new();
    view.insert("localDate".into(), json!(day));
    view.insert("timezone".into(), json!(crate::time::OWNER_TIMEZONE));
    view.insert("status".into(), json!(if doc.is_null() { "none" } else { "ready" }));
    view.insert("board".into(), doc);
    view.insert("dayRecord".into(), Value::Array(day_record));
    view.insert("paused".into(), Value::Null);
    view.insert("emptyReason".into(), json!(empty));
    view.insert("freshness".into(), Value::Array(freshness));
    view.insert("runId".into(), Value::Null);
    view.insert("wardrobeRevision".into(), json!(wardrobe_revision));
    view.insert("readAt".into(), json!(instant(now_ms)));
    Value::Object(view)
}
