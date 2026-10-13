//! Trips and packing proposals (specification section 10), ported from packages/daily/src/trips.ts:
//! `trip.create` (and its undo), `trip.update`, `trip.cancel` and `trip.record_packing_proposal`,
//! the trip as `GET /v1/trips` reads it, and the planner behind `POST /v1/trips/{id}/packing-proposal`.
//!
//! A packing proposal is only a proposal: what is physically packed is what the owner's `stock.pack`
//! observations say (`crate::packing`), read back from the stock ledger into each trip's `packed`
//! list. Nothing is ever packed by this module.
//!
//! Each trip is its own record (`trip/<tripId>`) and each proposal revision its own
//! (`tp/<tripId>/<revision>`), written in the ledger's guarded commit. The ledger keeps every trip's
//! version (`Ledger::trips`), so `expectedVersions` `trip:<id>` is checked without a read and the list
//! read never scans.
//!
//! The planner is this port's own and simpler than `proposePacking`: each day (and each evening with
//! an evening occasion) is composed by the port's recommender with the trip's repeat exception, and
//! the trousers, jacket, shoes and belt already in the bag are kept for the next day when the outfit
//! still validates with them. It has no weather (every day is proposed without a forecast, and says
//! so), applies no occasion register, and does not plan further reuse to fit a luggage limit: over a
//! limit, the optional flourishes are left out and the shortfall is stated.

use std::collections::{BTreeMap, BTreeSet};

use ferrite_app::serde_json::{json, Map, Value};

use crate::board::{self, Day, Slot};
use crate::canonical::{js_number, whole};
use crate::ledger::{invalid, only_keys, undone_summary, CmdError, Ctx, Ledger, Plan, ALREADY_AN_UNDO};
use crate::recommend;
use crate::seed::Catalogue;
use crate::time::{instant, local_date, parse_instant, parse_local_date};

const CREATE: &str = "trip.create";
const UPDATE: &str = "trip.update";
const CANCEL: &str = "trip.cancel";
const PROPOSE: &str = "trip.record_packing_proposal";
const STORED: &str = "the stored trip";

/// The payload fields each command accepts, published by `GET /v1/command-types`.
pub const CREATE_FIELDS: &[&str] = &["tripId", "name", "departsOn", "returnsOn", "destinations", "occasions", "luggage", "laundry", "source"];
pub const UPDATE_FIELDS: &[&str] = &["tripId", "changes"];
pub const CANCEL_FIELDS: &[&str] = &["tripId"];
pub const PROPOSAL_FIELDS: &[&str] = &["tripId", "items", "days", "weather", "notes"];
/// What `trip.update` may change, in the order the TypeScript schema lists them (its receipt names
/// the changed fields in this order).
const CHANGE_FIELDS: &[&str] = &["name", "departsOn", "returnsOn", "destinations", "occasions", "luggage", "laundry"];
/// `SourceRef.kind` in packages/contracts/src/primitives.ts.
const SOURCE_KINDS: &[&str] = &["owner_statement", "receipt", "maker_specification", "photograph", "body_measurement", "research_page", "import", "model_inference", "profile_passage", "system"];

/// Most trips kept, cancelled ones included (this port's bound: the ledger holds every trip's version).
pub const MAX_TRIPS: usize = 60;
/// Longest trip, in days (this port's bound: a proposal record must stay small).
pub const MAX_DAYS: i64 = 31;
const MAX_DESTINATIONS: usize = 10;
const MAX_OCCASIONS: usize = 62;
const MAX_LAUNDRY: usize = 31;
const MAX_TEXT: usize = 200;
const MAX_NOTE: usize = 500;
const MAX_ITEMS: usize = 200;
const MAX_PLAN_DAYS: usize = 62;
const MAX_SLOTS: usize = 12;
const MAX_NOTES: usize = 50;
const MAX_LONG_TEXT: usize = 1_000;
/// Largest proposal record kept, as JSON.
pub const MAX_PROPOSAL_BYTES: usize = 48 * 1024;
/// Largest trip record kept, as JSON (the store keeps a record of at most 64 KiB; every text bound
/// holds and the trip can still be larger when its text is mostly multibyte characters).
pub const MAX_TRIP_BYTES: usize = 48 * 1024;
/// How many generated IDs a trip may try before the command is refused (see `new_id`).
pub const ID_ATTEMPTS: usize = 8;

pub const UPDATE_NO_UNDO: &str = "edit the trip again instead";
pub const CANCEL_NO_UNDO: &str = "create the trip again instead";
pub const PROPOSAL_NO_UNDO: &str = "ask for a new proposal instead";
const NOTHING_CHANGED: &str = "nothing changed";

pub fn key(trip_id: &str) -> Vec<u8> {
    format!("trip/{trip_id}").into_bytes()
}

pub fn proposal_key(trip_id: &str, revision: u64) -> Vec<u8> {
    format!("tp/{trip_id}/{revision}").into_bytes()
}

// ─────────────────────────────── parsing ───────────────────────────────

fn text(cmd: &str, v: Option<&Value>, field: &str, min: usize, max: usize) -> Result<String, CmdError> {
    match v {
        Some(Value::String(s)) if (min..=max).contains(&s.chars().count()) => Ok(s.clone()),
        _ => Err(invalid(cmd, format!("{field}: expected text of {min} to {max} characters"))),
    }
}

fn date(cmd: &str, v: Option<&Value>, field: &str) -> Result<String, CmdError> {
    match v {
        Some(Value::String(d)) if parse_local_date(d).is_some() => Ok(d.clone()),
        _ => Err(invalid(cmd, format!("{field}: expected a date, YYYY-MM-DD"))),
    }
}

fn list<'a>(cmd: &str, v: Option<&'a Value>, field: &str, min: usize, max: usize) -> Result<&'a [Value], CmdError> {
    match v {
        Some(Value::Array(a)) if (min..=max).contains(&a.len()) => Ok(a.as_slice()),
        _ => Err(invalid(cmd, format!("{field}: expected a list of {min} to {max} entries"))),
    }
}

fn keys_of<'a>(cmd: &str, v: &'a Value, at: &str, allowed: &[&str]) -> Result<&'a Map<String, Value>, CmdError> {
    let Some(o) = v.as_object() else { return Err(invalid(cmd, format!("{at}: expected an object"))) };
    match o.keys().find(|k| !allowed.contains(&k.as_str())) {
        Some(k) => Err(invalid(cmd, format!("{at}.{k}: not a field here"))),
        None => Ok(o),
    }
}

fn one_of(cmd: &str, v: Option<&Value>, field: &str, allowed: &[&str], default: Option<&str>) -> Result<String, CmdError> {
    match (v, default) {
        (None, Some(d)) => Ok(d.to_string()),
        (Some(Value::String(s)), _) if allowed.contains(&s.as_str()) => Ok(s.clone()),
        _ => Err(invalid(cmd, format!("{field}: expected one of {}", allowed.join(", ")))),
    }
}

/// An IANA timezone name as far as this server can tell without a timezone database: `UTC`, or one
/// to three `/`-separated parts, each starting with a capital letter (`Europe/London`,
/// `America/Argentina/Buenos_Aires`, `Etc/GMT+1`). The name is not looked up.
pub fn timezone_ok(tz: &str) -> bool {
    let parts: Vec<&str> = tz.split('/').collect();
    (1..=64).contains(&tz.len())
        && parts.len() <= 3
        && parts.iter().all(|p| {
            p.bytes().next().map_or(false, |b| b.is_ascii_uppercase()) && p.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'+'))
        })
}

/// `TripDestination`: `{label, latitude?, longitude?, timezone, from, to}`.
fn destination(cmd: &str, v: &Value, at: &str) -> Result<Value, CmdError> {
    let o = keys_of(cmd, v, at, &["label", "latitude", "longitude", "timezone", "from", "to"])?;
    let mut out = Map::new();
    out.insert("label".into(), json!(text(cmd, o.get("label"), &format!("{at}.label"), 1, MAX_TEXT)?));
    for k in ["latitude", "longitude"] {
        match o.get(k) {
            None => {}
            Some(Value::Number(n)) if n.as_f64().map_or(false, |f| js_number(f).is_some()) => {
                out.insert(k.into(), Value::Number(n.clone()));
            }
            Some(_) => return Err(invalid(cmd, format!("{at}.{k}: expected a coordinate (a number from 0.000001 to 10^21 in size, or 0)"))),
        }
    }
    match o.get("timezone") {
        Some(Value::String(tz)) if timezone_ok(tz) => out.insert("timezone".into(), json!(tz)),
        _ => return Err(invalid(cmd, format!("{at}.timezone: not a known IANA timezone"))),
    };
    out.insert("from".into(), json!(date(cmd, o.get("from"), &format!("{at}.from"))?));
    out.insert("to".into(), json!(date(cmd, o.get("to"), &format!("{at}.to"))?));
    Ok(Value::Object(out))
}

/// `TripOccasion`: `{localDate, label, register = "none", segment = "day"}`.
fn occasion(cmd: &str, v: &Value, at: &str) -> Result<Value, CmdError> {
    let o = keys_of(cmd, v, at, &["localDate", "label", "register", "segment"])?;
    Ok(json!({
        "localDate": date(cmd, o.get("localDate"), &format!("{at}.localDate"))?,
        "label": text(cmd, o.get("label"), &format!("{at}.label"), 1, MAX_TEXT)?,
        "register": one_of(cmd, o.get("register"), &format!("{at}.register"), &["smart", "practical", "none"], Some("none"))?,
        "segment": one_of(cmd, o.get("segment"), &format!("{at}.segment"), &["day", "evening"], Some("day"))?,
    }))
}

/// `luggage`: `null`, or `{label, maxPieces = null}` with a positive whole limit.
fn luggage(cmd: &str, v: Option<&Value>) -> Result<Value, CmdError> {
    match v {
        None | Some(Value::Null) => Ok(Value::Null),
        Some(l) => {
            let o = keys_of(cmd, l, "luggage", &["label", "maxPieces"])?;
            let max = match o.get("maxPieces") {
                None | Some(Value::Null) => Value::Null,
                Some(n) => match whole(n) {
                    Some(n) if n >= 1 => json!(n),
                    _ => return Err(invalid(cmd, "luggage.maxPieces: expected a whole number of at least 1, or null")),
                },
            };
            Ok(json!({"label": text(cmd, o.get("label"), "luggage.label", 0, MAX_TEXT)?, "maxPieces": max}))
        }
    }
}

/// A laundry opportunity: `{localDate, note = null}`.
fn laundry_entry(cmd: &str, v: &Value, at: &str) -> Result<Value, CmdError> {
    let o = keys_of(cmd, v, at, &["localDate", "note"])?;
    let note = match o.get("note") {
        None | Some(Value::Null) => Value::Null,
        Some(_) => json!(text(cmd, o.get("note"), &format!("{at}.note"), 0, MAX_NOTE)?),
    };
    Ok(json!({"localDate": date(cmd, o.get("localDate"), &format!("{at}.localDate"))?, "note": note}))
}

/// `SourceRef`: `{kind, ref?, observedAt?, note?}`.
fn source(cmd: &str, v: Option<&Value>) -> Result<Value, CmdError> {
    let Some(v) = v else { return Err(invalid(cmd, "source: expected where this came from, {kind}")) };
    let o = keys_of(cmd, v, "source", &["kind", "ref", "observedAt", "note"])?;
    let mut out = Map::new();
    out.insert("kind".into(), json!(one_of(cmd, o.get("kind"), "source.kind", SOURCE_KINDS, None)?));
    for k in ["ref", "note"] {
        if o.contains_key(k) {
            out.insert(k.into(), json!(text(cmd, o.get(k), &format!("source.{k}"), 0, MAX_NOTE)?));
        }
    }
    match o.get("observedAt") {
        None => {}
        Some(Value::String(t)) if parse_instant(t).is_some() => {
            out.insert("observedAt".into(), json!(t));
        }
        Some(_) => return Err(invalid(cmd, "source.observedAt: expected UTC ISO 8601 instant")),
    }
    Ok(Value::Object(out))
}

fn destinations(cmd: &str, v: Option<&Value>, field: &str) -> Result<Vec<Value>, CmdError> {
    list(cmd, v, field, 1, MAX_DESTINATIONS)?.iter().enumerate().map(|(i, d)| destination(cmd, d, &format!("{field}[{i}]"))).collect()
}

fn occasions(cmd: &str, v: Option<&Value>, field: &str) -> Result<Vec<Value>, CmdError> {
    list(cmd, v, field, 0, MAX_OCCASIONS)?.iter().enumerate().map(|(i, o)| occasion(cmd, o, &format!("{field}[{i}]"))).collect()
}

fn laundry(cmd: &str, v: Option<&Value>, field: &str) -> Result<Vec<Value>, CmdError> {
    list(cmd, v, field, 0, MAX_LAUNDRY)?.iter().enumerate().map(|(i, l)| laundry_entry(cmd, l, &format!("{field}[{i}]"))).collect()
}

fn trip_id(cmd: &str, v: Option<&Value>) -> Result<String, CmdError> {
    text(cmd, v, "tripId", 1, 128)
}

/// `checkDestinations`, and this port's length bound.
fn check_dates(departs_on: &str, returns_on: &str, destinations: &[Value]) -> Result<(), CmdError> {
    if returns_on < departs_on {
        return Err(CmdError::new("invalid_command", "the return date is before the departure date"));
    }
    let span = parse_local_date(returns_on).unwrap_or(0) - parse_local_date(departs_on).unwrap_or(0) + 1;
    if span > MAX_DAYS {
        return Err(CmdError::new("invalid_command", format!("a trip on this server is at most {MAX_DAYS} days")));
    }
    for d in destinations {
        let (label, from, to) = (d["label"].as_str().unwrap_or(""), d["from"].as_str().unwrap_or(""), d["to"].as_str().unwrap_or(""));
        if to < from {
            return Err(CmdError::new("invalid_command", format!("the stay in {label} ends before it starts")));
        }
        if from < departs_on || to > returns_on {
            return Err(CmdError::new("invalid_command", format!("the stay in {label} is outside the trip dates")));
        }
    }
    Ok(())
}

/// A `trip.create` payload, validated (`TripCreate`, with its defaults applied).
#[derive(Debug, Clone)]
pub struct CreateInput {
    pub trip_id: Option<String>,
    pub name: String,
    pub departs_on: String,
    pub returns_on: String,
    pub destinations: Vec<Value>,
    pub occasions: Vec<Value>,
    pub luggage: Value,
    pub laundry: Vec<Value>,
    pub source: Value,
}

pub fn parse_create(payload: &Value) -> Result<CreateInput, CmdError> {
    only_keys(payload, CREATE, CREATE_FIELDS)?;
    let trip_id = match payload.get("tripId") {
        None => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => return Err(invalid(CREATE, "tripId: expected a trip ID")),
    };
    Ok(CreateInput {
        trip_id,
        name: text(CREATE, payload.get("name"), "name", 1, MAX_TEXT)?,
        departs_on: date(CREATE, payload.get("departsOn"), "departsOn")?,
        returns_on: date(CREATE, payload.get("returnsOn"), "returnsOn")?,
        destinations: destinations(CREATE, payload.get("destinations"), "destinations")?,
        occasions: if payload.get("occasions").is_some() { occasions(CREATE, payload.get("occasions"), "occasions")? } else { Vec::new() },
        luggage: luggage(CREATE, payload.get("luggage"))?,
        laundry: if payload.get("laundry").is_some() { laundry(CREATE, payload.get("laundry"), "laundry")? } else { Vec::new() },
        source: source(CREATE, payload.get("source"))?,
    })
}

/// A `trip.update` payload: the trip and its changes, in [`CHANGE_FIELDS`] order.
#[derive(Debug, Clone)]
pub struct UpdateInput {
    pub trip_id: String,
    pub changes: Vec<(&'static str, Value)>,
}

pub fn parse_update(payload: &Value) -> Result<UpdateInput, CmdError> {
    only_keys(payload, UPDATE, UPDATE_FIELDS)?;
    let id = trip_id(UPDATE, payload.get("tripId"))?;
    let Some(c) = payload.get("changes") else { return Err(invalid(UPDATE, "changes: at least one change is required")) };
    let o = keys_of(UPDATE, c, "changes", CHANGE_FIELDS)?;
    let mut changes = Vec::new();
    for field in CHANGE_FIELDS {
        if !o.contains_key(*field) {
            continue;
        }
        let at = format!("changes.{field}");
        let v = o.get(*field);
        let value = match *field {
            "name" => json!(text(UPDATE, v, &at, 1, MAX_TEXT)?),
            "departsOn" | "returnsOn" => json!(date(UPDATE, v, &at)?),
            "destinations" => json!(destinations(UPDATE, v, &at)?),
            "occasions" => json!(occasions(UPDATE, v, &at)?),
            "luggage" => luggage(UPDATE, v)?,
            _ => json!(laundry(UPDATE, v, &at)?),
        };
        changes.push((*field, value));
    }
    if changes.is_empty() {
        return Err(invalid(UPDATE, "changes: at least one change is required"));
    }
    Ok(UpdateInput { trip_id: id, changes })
}

pub fn parse_cancel(payload: &Value) -> Result<String, CmdError> {
    only_keys(payload, CANCEL, CANCEL_FIELDS)?;
    trip_id(CANCEL, payload.get("tripId"))
}

/// A `trip.record_packing_proposal` payload, validated (`TripRecordPackingProposal`).
#[derive(Debug, Clone)]
pub struct ProposalInput {
    pub trip_id: String,
    pub items: Vec<Value>,
    pub days: Vec<Value>,
    pub weather: Vec<Value>,
    pub notes: Vec<String>,
}

fn garment(cmd: &str, cat: &Catalogue, v: Option<&Value>, at: &str) -> Result<String, CmdError> {
    match v.and_then(Value::as_str) {
        Some(id) if cat.get(id).is_some() => Ok(id.to_string()),
        Some(id) if !id.is_empty() && id.len() <= 64 => Err(CmdError::with("not_found", format!("unknown garment: {id}"), json!({"missing": [id]}))),
        _ => Err(invalid(cmd, format!("{at}: expected a garment ID"))),
    }
}

fn role(cmd: &str, v: Option<&Value>, at: &str) -> Result<String, CmdError> {
    one_of(cmd, v, at, board::ROLES, None)
}

pub fn parse_proposal(cat: &Catalogue, payload: &Value) -> Result<ProposalInput, CmdError> {
    only_keys(payload, PROPOSE, PROPOSAL_FIELDS)?;
    let id = trip_id(PROPOSE, payload.get("tripId"))?;
    let mut items = Vec::new();
    for (i, it) in list(PROPOSE, payload.get("items"), "items", 0, MAX_ITEMS)?.iter().enumerate() {
        let at = format!("items[{i}]");
        let o = keys_of(PROPOSE, it, &at, &["garmentId", "name", "role", "quantity"])?;
        let quantity = match o.get("quantity").and_then(whole) {
            Some(q) if (1..=999).contains(&q) => q,
            _ => return Err(invalid(PROPOSE, format!("{at}.quantity: expected a whole number from 1 to 999"))),
        };
        items.push(json!({
            "garmentId": garment(PROPOSE, cat, o.get("garmentId"), &format!("{at}.garmentId"))?,
            "name": text(PROPOSE, o.get("name"), &format!("{at}.name"), 0, MAX_TEXT)?,
            "role": role(PROPOSE, o.get("role"), &format!("{at}.role"))?,
            "quantity": quantity,
        }));
    }
    let mut days = Vec::new();
    for (i, d) in list(PROPOSE, payload.get("days"), "days", 0, MAX_PLAN_DAYS)?.iter().enumerate() {
        let at = format!("days[{i}]");
        let o = keys_of(PROPOSE, d, &at, &["localDate", "segment", "occasion", "slots", "reason"])?;
        let occasion = match o.get("occasion") {
            Some(Value::Null) => Value::Null,
            v @ Some(Value::String(_)) => json!(text(PROPOSE, v, &format!("{at}.occasion"), 0, MAX_TEXT)?),
            _ => return Err(invalid(PROPOSE, format!("{at}.occasion: expected text or null"))),
        };
        let mut slots = Vec::new();
        for (j, s) in list(PROPOSE, o.get("slots"), &format!("{at}.slots"), 0, MAX_SLOTS)?.iter().enumerate() {
            let sat = format!("{at}.slots[{j}]");
            let so = keys_of(PROPOSE, s, &sat, &["role", "garmentId"])?;
            slots.push(json!({"role": role(PROPOSE, so.get("role"), &format!("{sat}.role"))?, "garmentId": garment(PROPOSE, cat, so.get("garmentId"), &format!("{sat}.garmentId"))?}));
        }
        days.push(json!({
            "localDate": date(PROPOSE, o.get("localDate"), &format!("{at}.localDate"))?,
            "segment": one_of(PROPOSE, o.get("segment"), &format!("{at}.segment"), &["day", "evening"], None)?,
            "occasion": occasion,
            "slots": slots,
            "reason": text(PROPOSE, o.get("reason"), &format!("{at}.reason"), 0, MAX_LONG_TEXT)?,
        }));
    }
    let mut weather = Vec::new();
    for (i, w) in list(PROPOSE, payload.get("weather"), "weather", 0, MAX_PLAN_DAYS)?.iter().enumerate() {
        let at = format!("weather[{i}]");
        let o = keys_of(PROPOSE, w, &at, &["localDate", "label", "freshness", "line"])?;
        weather.push(json!({
            "localDate": date(PROPOSE, o.get("localDate"), &format!("{at}.localDate"))?,
            "label": text(PROPOSE, o.get("label"), &format!("{at}.label"), 0, MAX_TEXT)?,
            "freshness": one_of(PROPOSE, o.get("freshness"), &format!("{at}.freshness"), &["fresh", "stale", "unavailable"], None)?,
            "line": text(PROPOSE, o.get("line"), &format!("{at}.line"), 0, MAX_NOTE)?,
        }));
    }
    let notes = match payload.get("notes") {
        None => Vec::new(),
        v => list(PROPOSE, v, "notes", 0, MAX_NOTES)?.iter().enumerate().map(|(i, n)| text(PROPOSE, Some(n), &format!("notes[{i}]"), 0, MAX_LONG_TEXT)).collect::<Result<_, _>>()?,
    };
    Ok(ProposalInput { trip_id: id, items, days, weather, notes })
}

// ─────────────────────────────── the record ───────────────────────────────

/// One stored trip (a `trips` row, with the latest proposal's revision).
#[derive(Debug, Clone, PartialEq)]
pub struct Trip {
    pub trip_id: String,
    pub version: u64,
    pub name: String,
    pub departs_on: String,
    pub returns_on: String,
    pub destinations: Vec<Value>,
    pub occasions: Vec<Value>,
    pub luggage: Value,
    pub laundry: Vec<Value>,
    pub status: String,
    pub source: Value,
    /// The latest packing proposal's revision, 0 before the first.
    pub proposal_revision: u64,
    /// The command that created the trip (its undo cancels the trip).
    pub command_id: String,
    pub created_at: String,
    pub updated_at: String,
}

const TRIP_FIELDS: &[&str] = &[
    "tripId", "version", "name", "departsOn", "returnsOn", "destinations", "occasions", "luggage", "laundry", "status", "source", "proposalRevision", "commandId", "createdAt", "updatedAt",
];

impl Trip {
    pub fn to_json(&self) -> Value {
        json!({
            "tripId": self.trip_id, "version": self.version, "name": self.name, "departsOn": self.departs_on, "returnsOn": self.returns_on,
            "destinations": self.destinations, "occasions": self.occasions, "luggage": self.luggage, "laundry": self.laundry,
            "status": self.status, "source": self.source, "proposalRevision": self.proposal_revision, "commandId": self.command_id,
            "createdAt": self.created_at, "updatedAt": self.updated_at,
        })
    }

    /// A stored trip this code wrote: every field present, each list exactly as the command parsers
    /// write it. Anything else is `None`.
    pub fn from_json(v: &Value, trip_id: &str) -> Option<Trip> {
        let o = v.as_object()?;
        if o.len() != TRIP_FIELDS.len() || !TRIP_FIELDS.iter().all(|f| o.contains_key(*f)) {
            return None;
        }
        let st = |k: &str| v[k].as_str().map(str::to_string);
        let destinations = self::destinations(STORED, Some(&v["destinations"]), "destinations").ok()?;
        let occasions = self::occasions(STORED, Some(&v["occasions"]), "occasions").ok()?;
        let laundry = self::laundry(STORED, Some(&v["laundry"]), "laundry").ok()?;
        let luggage = self::luggage(STORED, Some(&v["luggage"])).ok()?;
        let source = self::source(STORED, Some(&v["source"])).ok()?;
        let trip = Trip {
            trip_id: st("tripId").filter(|id| id == trip_id)?,
            version: v["version"].as_u64().filter(|n| *n >= 1)?,
            name: st("name").filter(|n| !n.is_empty())?,
            departs_on: st("departsOn").filter(|d| parse_local_date(d).is_some())?,
            returns_on: st("returnsOn").filter(|d| parse_local_date(d).is_some())?,
            destinations,
            occasions,
            luggage,
            laundry,
            status: st("status").filter(|s| s == "planned" || s == "cancelled")?,
            source,
            proposal_revision: v["proposalRevision"].as_u64()?,
            command_id: st("commandId").filter(|c| c.starts_with("cmd_"))?,
            created_at: st("createdAt").filter(|t| parse_instant(t).is_some())?,
            updated_at: st("updatedAt").filter(|t| parse_instant(t).is_some())?,
        };
        // Each list as stored must be exactly what its parser writes for it.
        let same = trip.destinations.as_slice() == v["destinations"].as_array()?.as_slice()
            && trip.occasions.as_slice() == v["occasions"].as_array()?.as_slice()
            && trip.laundry.as_slice() == v["laundry"].as_array()?.as_slice()
            && trip.luggage == v["luggage"]
            && trip.source == v["source"];
        same.then_some(trip)
    }

    /// The trip as `GET /v1/trips` reads it (`Trip`), with what is packed for it (`packing::packed`).
    pub fn view(&self, proposal: Option<Value>, packed: Vec<Value>) -> Value {
        json!({
            "tripId": self.trip_id, "version": self.version, "name": self.name, "departsOn": self.departs_on, "returnsOn": self.returns_on,
            "destinations": self.destinations, "occasions": self.occasions, "luggage": self.luggage, "laundry": self.laundry,
            "status": self.status, "packed": packed, "proposal": proposal,
        })
    }

    /// `destinationFor`: the stay covering `date`, else the first destination.
    pub fn destination_for(&self, date: &str) -> &Value {
        self.destinations
            .iter()
            .find(|d| d["from"].as_str().map_or(false, |f| f <= date) && d["to"].as_str().map_or(false, |t| date <= t))
            .unwrap_or(&self.destinations[0])
    }
}

/// A stored proposal this code wrote for `trip_id` at `revision`.
pub fn proposal_from_json(v: &Value, trip_id: &str, revision: u64) -> Option<Value> {
    let o = v.as_object()?;
    let fields = ["tripId", "revision", "createdAt", "items", "days", "repeatExceptionForTrip", "weather", "notes"];
    let ok = o.len() == fields.len()
        && fields.iter().all(|f| o.contains_key(*f))
        && v["tripId"] == trip_id
        && v["revision"].as_u64() == Some(revision)
        && v["createdAt"].as_str().map_or(false, |t| parse_instant(t).is_some())
        && v["repeatExceptionForTrip"] == true
        && ["items", "days", "weather", "notes"].iter().all(|k| v[*k].is_array());
    ok.then(|| v.clone())
}

fn id_ok(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The ID a new trip gets when the payload names none (`ctx.newId("trp")`). `attempt` is 0 for the
/// first choice; a caller-supplied ID may already hold that name, so later attempts add a suffix.
pub fn new_id(ctx: &Ctx<'_>, attempt: usize) -> String {
    let base = format!("trp_{}", ctx.command_id.trim_start_matches("cmd_"));
    if attempt == 0 { base } else { format!("{base}_{attempt}") }
}

fn active<'t>(trip: Option<&'t Trip>, trip_id: &str) -> Result<&'t Trip, CmdError> {
    trip.filter(|t| t.status == "planned").ok_or_else(|| CmdError::with("not_found", format!("no active trip '{trip_id}'"), json!({"tripId": trip_id})))
}

fn affected(trip: &Trip) -> Value {
    json!({"kind": "trip", "id": trip.trip_id, "version": trip.version})
}

fn fits(cmd: &str, trip: &Trip) -> Result<(), CmdError> {
    if trip.to_json().to_string().len() > MAX_TRIP_BYTES {
        return Err(invalid(cmd, format!("the trip is larger than this server keeps ({} KiB at most); shorten its labels or notes", MAX_TRIP_BYTES / 1024)));
    }
    Ok(())
}

// ─────────────────────────────── commands ───────────────────────────────

/// `trip.create`: the trip is recorded as planned; nothing is packed.
pub fn create(ctx: &Ctx<'_>, ledger: &mut Ledger, input: CreateInput) -> Result<(Plan, Trip), CmdError> {
    check_dates(&input.departs_on, &input.returns_on, &input.destinations)?;
    let trip_id = match input.trip_id {
        Some(id) => id,
        None => (0..ID_ATTEMPTS)
            .map(|a| new_id(ctx, a))
            .find(|id| !ledger.trips.contains_key(id))
            .ok_or_else(|| CmdError::with("conflict", "no free ID for the trip; send a tripId of your own. Nothing was written", json!({"reason": "trip_id_taken"})))?,
    };
    if !id_ok(&trip_id) {
        return Err(CmdError::new("invalid_command", "a trip ID may contain only letters, digits, '-' and '_'"));
    }
    if ledger.trips.contains_key(&trip_id) {
        return Err(CmdError::with("precondition_failed", format!("there is already a trip '{trip_id}'; nothing was written"), json!({"failed": "the trip ID is new"})));
    }
    if ledger.trips.len() >= MAX_TRIPS {
        return Err(CmdError::with(
            "precondition_failed",
            format!("this server keeps at most {MAX_TRIPS} trips; nothing was written"),
            json!({"reason": "too_many_trips", "limit": MAX_TRIPS}),
        ));
    }
    let now = instant(ctx.now_ms);
    let labels: Vec<&str> = input.destinations.iter().filter_map(|d| d["label"].as_str()).collect();
    let trip = Trip {
        trip_id: trip_id.clone(),
        version: 1,
        name: input.name,
        departs_on: input.departs_on,
        returns_on: input.returns_on,
        destinations: input.destinations.clone(),
        occasions: input.occasions,
        luggage: input.luggage,
        laundry: input.laundry,
        status: "planned".into(),
        source: input.source,
        proposal_revision: 0,
        command_id: ctx.command_id.to_string(),
        created_at: now.clone(),
        updated_at: now,
    };
    fits(CREATE, &trip)?;
    ledger.trips.insert(trip_id.clone(), 1);
    let plan = Plan {
        outcome: "committed",
        summary: format!("Trip \u{201c}{}\u{201d} recorded: {} to {}, {}. Nothing is packed until you say so", trip.name, trip.departs_on, trip.returns_on, labels.join(", ")),
        affected: vec![affected(&trip)],
        repairs: vec![],
        result: json!({"tripId": trip_id}),
        undo: Ok(json!({"tripId": trip_id})),
    };
    Ok((plan, trip))
}

/// The trip an undo of `trip.create` names in its undo data.
pub fn undo_target_trip(data: &Value) -> Option<&str> {
    data.get("tripId").and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// `command.undo` of `trip.create`: the trip is cancelled (`planUndo`), unless pieces are packed for
/// it (`packed` units, worn or not): those are unpacked first.
pub fn undo_create(ctx: &Ctx<'_>, ledger: &mut Ledger, trip: Option<&Trip>, packed: u32, original_summary: &str, target: &str) -> Result<(Plan, Trip), CmdError> {
    let Some(trip) = trip.filter(|t| t.command_id == target) else {
        return Err(CmdError::with("internal", "the trip that action recorded cannot be read; nothing was written", json!({"retryable": false, "commandId": target})));
    };
    if packed > 0 {
        return Err(CmdError::with("not_undoable", "pieces are packed for this trip; unpack them first", json!({"commandId": target, "tripId": trip.trip_id})));
    }
    let next = Trip { status: "cancelled".into(), version: trip.version + 1, updated_at: instant(ctx.now_ms), ..trip.clone() };
    ledger.trips.insert(next.trip_id.clone(), next.version);
    let plan = Plan {
        outcome: "committed",
        summary: undone_summary(original_summary, "Trip removed"),
        affected: vec![affected(&next)],
        repairs: vec![],
        result: json!({"undoneCommandId": target}),
        undo: Err(ALREADY_AN_UNDO.into()),
    };
    Ok((plan, next))
}

/// `trip.update`: the named fields of a planned trip change. It has no undo; the owner edits again.
pub fn update(ctx: &Ctx<'_>, ledger: &mut Ledger, trip: Option<&Trip>, input: UpdateInput) -> Result<(Plan, Trip), CmdError> {
    let current = active(trip, &input.trip_id)?;
    let mut next = current.clone();
    for (field, value) in &input.changes {
        match *field {
            "name" => next.name = value.as_str().unwrap_or_default().to_string(),
            "departsOn" => next.departs_on = value.as_str().unwrap_or_default().to_string(),
            "returnsOn" => next.returns_on = value.as_str().unwrap_or_default().to_string(),
            "destinations" => next.destinations = value.as_array().cloned().unwrap_or_default(),
            "occasions" => next.occasions = value.as_array().cloned().unwrap_or_default(),
            "luggage" => next.luggage = value.clone(),
            _ => next.laundry = value.as_array().cloned().unwrap_or_default(),
        }
    }
    check_dates(&next.departs_on, &next.returns_on, &next.destinations)?;
    next.version = current.version + 1;
    next.updated_at = instant(ctx.now_ms);
    fits(UPDATE, &next)?;
    ledger.trips.insert(next.trip_id.clone(), next.version);
    let keys: Vec<&str> = input.changes.iter().map(|(k, _)| *k).collect();
    let plan = Plan {
        outcome: "committed",
        summary: format!("Trip \u{201c}{}\u{201d} updated: {}", next.name, keys.join(", ")),
        affected: vec![affected(&next)],
        repairs: vec![],
        result: json!({"tripId": next.trip_id, "version": next.version}),
        undo: Err(UPDATE_NO_UNDO.into()),
    };
    Ok((plan, next))
}

/// `trip.cancel`: a cancelled trip is a noop. It has no undo; the owner creates the trip again. What
/// is packed for it (`still_packed` units) stays recorded as packed until he unpacks it.
pub fn cancel(ctx: &Ctx<'_>, ledger: &mut Ledger, trip_id: &str, trip: Option<&Trip>, still_packed: u32) -> Result<(Plan, Option<Trip>), CmdError> {
    let Some(current) = trip else {
        return Err(CmdError::with("not_found", format!("no trip '{trip_id}'"), json!({"tripId": trip_id})));
    };
    if current.status == "cancelled" {
        let plan = Plan { outcome: "noop", summary: "That trip was already cancelled".into(), affected: vec![], repairs: vec![], result: json!({}), undo: Err(NOTHING_CHANGED.into()) };
        return Ok((plan, None));
    }
    let next = Trip { status: "cancelled".into(), version: current.version + 1, updated_at: instant(ctx.now_ms), ..current.clone() };
    ledger.trips.insert(next.trip_id.clone(), next.version);
    let plan = Plan {
        outcome: "committed",
        summary: format!("Trip \u{201c}{}\u{201d} cancelled{}", next.name, if still_packed > 0 { "; its packed pieces stay recorded as packed until you unpack them" } else { "" }),
        affected: vec![affected(&next)],
        repairs: vec![],
        result: json!({"tripId": next.trip_id, "stillPacked": still_packed}),
        undo: Err(CANCEL_NO_UNDO.into()),
    };
    Ok((plan, Some(next)))
}

/// `wornOnTravelDay`: the garments of the departure day's daytime outfit, worn for the journey.
fn worn_on_travel_day(days: &[Value], travel_date: &str) -> BTreeSet<String> {
    days.iter()
        .find(|d| d["localDate"] == travel_date && d["segment"] == "day")
        .and_then(|d| d["slots"].as_array())
        .map(|slots| slots.iter().filter_map(|s| s["garmentId"].as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

/// `packedPieces`: every unit the trip needs, less the one unit of each garment worn on the travel day.
pub fn packed_pieces(items: &[Value], days: &[Value], travel_date: &str) -> u64 {
    let worn = worn_on_travel_day(days, travel_date);
    items
        .iter()
        .map(|i| {
            let q = i["quantity"].as_u64().unwrap_or(0);
            q.saturating_sub(u64::from(i["garmentId"].as_str().map_or(false, |g| worn.contains(g))))
        })
        .sum()
}

/// `trip.record_packing_proposal`: the next proposal revision is kept. It is a proposal, never packed.
/// Returns the plan, the trip with its new proposal revision, and the proposal record.
pub fn record_proposal(ctx: &Ctx<'_>, trip: Option<&Trip>, input: ProposalInput) -> Result<(Plan, Trip, Value), CmdError> {
    let current = active(trip, &input.trip_id)?;
    let revision = current.proposal_revision + 1;
    let proposal = json!({
        "tripId": current.trip_id, "revision": revision, "createdAt": instant(ctx.now_ms), "items": input.items, "days": input.days,
        "repeatExceptionForTrip": true, "weather": input.weather, "notes": input.notes,
    });
    if proposal.to_string().len() > MAX_PROPOSAL_BYTES {
        return Err(invalid(PROPOSE, format!("the proposal is larger than this server keeps ({} KiB at most)", MAX_PROPOSAL_BYTES / 1024)));
    }
    let pieces = packed_pieces(&input.items, &input.days, &current.departs_on);
    let worn = !worn_on_travel_day(&input.days, &current.departs_on).is_empty();
    let next = Trip { proposal_revision: revision, ..current.clone() };
    let plan = Plan {
        outcome: "committed",
        summary: format!(
            "Packing proposed for \u{201c}{}\u{201d}: {pieces} pieces to pack for {} outfits{}. This is a proposal; nothing is packed until you say so",
            current.name,
            input.days.len(),
            if worn { ", with the travel-day outfit worn" } else { "" }
        ),
        affected: vec![json!({"kind": "trip_packing_proposal", "id": current.trip_id, "version": revision})],
        repairs: vec![],
        result: json!({"tripId": current.trip_id, "revision": revision}),
        undo: Err(PROPOSAL_NO_UNDO.into()),
    };
    Ok((plan, next, proposal))
}

/// `GET /v1/trips`: every trip, by departure date then ID (`ORDER BY departs_on, trip_id`).
pub fn listing(mut trips: Vec<(Trip, Option<Value>, Vec<Value>)>) -> Value {
    trips.sort_by(|a, b| a.0.departs_on.cmp(&b.0.departs_on).then_with(|| a.0.trip_id.cmp(&b.0.trip_id)));
    json!({"trips": trips.into_iter().map(|(t, p, packed)| t.view(p, packed)).collect::<Vec<_>>()})
}

// ─────────────────────────────── the planner ───────────────────────────────

/// Pieces kept from the bag for the next day while the outfit still validates, and on how many days
/// at most (`LEVELS[0]` of `proposePacking`: trousers on two days, the rest without a limit).
const REUSED: [(&str, u32); 4] = [("bottom", 2), ("outer", u32::MAX), ("footwear", u32::MAX), ("belt", u32::MAX)];
/// Roles that only carry an optional flourish, left out first over a luggage limit.
const OPTIONAL_FLOURISH: [&str; 2] = ["neckwear", "accessory"];
/// Options composed for each day, the one that reuses most of the bag proposed.
const CANDIDATES: usize = 4;

struct Item {
    garment_id: String,
    name: String,
    role: String,
    quantity: u64,
}

struct DayPlan {
    date: String,
    segment: &'static str,
    occasion: Option<String>,
    slots: Vec<Slot>,
    reason: String,
}

impl DayPlan {
    fn to_json(&self) -> Value {
        json!({
            "localDate": self.date, "segment": self.segment, "occasion": self.occasion,
            "slots": self.slots.iter().map(|s| json!({"role": s.role, "garmentId": s.garment_id})).collect::<Vec<_>>(),
            "reason": self.reason,
        })
    }
}

fn slot_garment<'s>(slots: &'s [Slot], role: &str) -> Option<&'s str> {
    slots.iter().find(|s| s.role == role).map(|s| s.garment_id.as_str())
}

/// The `trip.record_packing_proposal` payload for `trip`, composed from the ledger's stock at home.
pub fn propose(cat: &Catalogue, ledger: &Ledger, trip: &Trip) -> Value {
    // The trip's repeat exception: no repeat horizon is checked (`allowRepeat`); recorded wears still
    // shape rotation through `worn`.
    let base = Day::of(cat, ledger, &trip.departs_on);
    let day = Day { cat, stock: base.stock, local_date: None, worn: base.worn };
    let clean = |id: &str| u64::from(day.stock.of(id).clean);
    let (start, end) = (parse_local_date(&trip.departs_on).unwrap_or(0), parse_local_date(&trip.returns_on).unwrap_or(0));
    let mut items: Vec<Item> = Vec::new();
    let mut days: Vec<DayPlan> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    // Days that got no outfit, and days planned without socks: each stated once, in one note.
    let mut no_outfit: Vec<String> = Vec::new();
    let mut no_socks: Vec<String> = Vec::new();
    let mut reuse: BTreeMap<&str, (String, u32)> = BTreeMap::new();
    let mut top_days: BTreeMap<String, u32> = BTreeMap::new();
    // Days each sock is planned for: a pair is worn for one day.
    let mut sock_days: BTreeMap<String, u64> = BTreeMap::new();
    let socks: Vec<&str> = cat.garments.iter().filter(|g| board::role_accepts(g, "socks") && clean(&g.id) > 0).map(|g| g.id.as_str()).collect();

    for n in start..=end {
        let date = local_date(n);
        let has_evening = trip.occasions.iter().any(|o| o["localDate"] == date.as_str() && o["segment"] == "evening");
        for segment in ["day", "evening"].into_iter().take(if has_evening { 2 } else { 1 }) {
            let occasion = trip.occasions.iter().find(|o| o["localDate"] == date.as_str() && o["segment"] == segment).and_then(|o| o["label"].as_str()).map(str::to_string);
            let place = if segment == "evening" { format!("{date} (evening)") } else { date.clone() };
            let earlier_today: Vec<Slot> = days.iter().find(|d| d.date == date && d.segment == "day").map(|d| d.slots.clone()).unwrap_or_default();
            let exhausted = |id: &str, sock_days: &BTreeMap<String, u64>| sock_days.get(id).copied().unwrap_or(0) >= clean(id).max(1);
            let composition = recommend::compose(&day, &date, CANDIDATES, 0);
            // The option that keeps most of what is already in the bag, without repeating a shirt or
            // planning a pair of socks no clean pair is left for; the first of equals.
            let mut best: Option<(&recommend::Composed, i64)> = None;
            for o in &composition.options {
                let mut score = 0i64;
                for s in &o.slots {
                    match s.role.as_str() {
                        "top" if top_days.contains_key(&s.garment_id) => score -= 3,
                        "socks" if slot_garment(&earlier_today, "socks") != Some(s.garment_id.as_str()) && exhausted(&s.garment_id, &sock_days) => score -= 5,
                        "top" | "socks" => {}
                        _ if items.iter().any(|i| i.garment_id == s.garment_id) => score += 1,
                        _ => {}
                    }
                }
                if best.as_ref().map_or(true, |(_, b)| score > *b) {
                    best = Some((o, score));
                }
            }
            let Some((option, _)) = best else {
                no_outfit.push(place);
                continue;
            };
            let mut slots = option.slots.clone();
            let mut alternatives = option.alternatives.clone();
            // Keep `garment` in `role` when the outfit still validates with it.
            let try_keep = |slots: &mut Vec<Slot>, alternatives: &mut Vec<String>, role: &str, garment: &str| -> bool {
                let Some(pos) = slots.iter().position(|s| s.role == role) else { return false };
                if slots[pos].garment_id == garment {
                    return true;
                }
                let mut candidate = slots.clone();
                candidate[pos].garment_id = garment.to_string();
                let alts: Vec<String> = if role == "footwear" { Vec::new() } else { alternatives.clone() };
                if board::validate(&day, &candidate, &alts, &[]).valid() {
                    *slots = candidate;
                    *alternatives = alts;
                    true
                } else {
                    false
                }
            };
            // An evening keeps the day's trousers and socks.
            let mut locked: Vec<&str> = Vec::new();
            for role in ["bottom", "socks"] {
                if let Some(id) = slot_garment(&earlier_today, role) {
                    if try_keep(&mut slots, &mut alternatives, role, id) {
                        locked.push(role);
                    }
                }
            }
            for (role, limit) in REUSED {
                if locked.contains(&role) {
                    continue;
                }
                if let Some((id, uses)) = reuse.get(role) {
                    if *uses < limit {
                        try_keep(&mut slots, &mut alternatives, role, &id.clone());
                    }
                }
            }
            // A pair of socks already planned for every clean pair at home is replaced, or left out.
            if let Some(sock) = slot_garment(&slots, "socks").map(str::to_string) {
                if slot_garment(&earlier_today, "socks") != Some(sock.as_str()) && exhausted(&sock, &sock_days) {
                    let replaced = socks.iter().filter(|id| !exhausted(id, &sock_days)).any(|id| try_keep(&mut slots, &mut alternatives, "socks", id));
                    if !replaced {
                        slots.retain(|s| s.role != "socks");
                        no_socks.push(place.clone());
                    }
                }
            }
            for s in &slots {
                let same_day = days.iter().any(|d| d.date == date && d.slots.iter().any(|x| x.garment_id == s.garment_id));
                let pos = match items.iter().position(|i| i.garment_id == s.garment_id) {
                    Some(p) => p,
                    None => {
                        let name = cat.get(&s.garment_id).map(|g| g.name.clone()).unwrap_or_default();
                        items.push(Item { garment_id: s.garment_id.clone(), name, role: s.role.clone(), quantity: 0 });
                        items.len() - 1
                    }
                };
                if s.role == "socks" {
                    // Interchangeable units are counted per wearing day, up to the clean pairs at home.
                    if !same_day {
                        *sock_days.entry(s.garment_id.clone()).or_default() += 1;
                        items[pos].quantity = (items[pos].quantity + 1).min(clean(&s.garment_id).max(1));
                    }
                } else {
                    items[pos].quantity = 1;
                }
                if s.role == "top" && !same_day {
                    *top_days.entry(s.garment_id.clone()).or_default() += 1;
                }
                if let Some(role) = REUSED.iter().map(|(r, _)| *r).find(|r| *r == s.role) {
                    match reuse.get_mut(role) {
                        Some((id, uses)) if *id == s.garment_id => *uses += u32::from(!same_day),
                        _ => {
                            reuse.insert(role, (s.garment_id.clone(), 1));
                        }
                    }
                }
            }
            // The alternative shoe of the paired format is carried, so it is packed (once).
            for id in &alternatives {
                if slots.iter().any(|s| s.garment_id == *id) || items.iter().any(|i| i.garment_id == *id) {
                    continue;
                }
                if let Some(g) = cat.get(id) {
                    items.push(Item { garment_id: id.clone(), name: g.name.clone(), role: "footwear".into(), quantity: 1 });
                }
            }
            let reason = board::factual_reason(cat, &slots);
            days.push(DayPlan { date: date.clone(), segment, occasion, slots, reason });
        }
    }

    if !no_outfit.is_empty() {
        notes.push(format!("No complete valid outfit could be proposed for {} from what is available at home.", places(&no_outfit)));
    }
    if !no_socks.is_empty() {
        let one = no_socks.len() == 1;
        notes.push(format!(
            "No clean pair of socks is left for {}: every clean pair at home that suits {} is already planned for an earlier day of the trip. The rest of {} planned without socks; {} needed before then.",
            places(&no_socks),
            if one { "it" } else { "them" },
            if one { "that day is" } else { "those days are" },
            if one { "one more clean pair is".to_string() } else { format!("{} more clean pairs are", no_socks.len()) },
        ));
    }
    let item_json = |items: &[Item]| -> Vec<Value> { items.iter().map(|i| json!({"garmentId": i.garment_id, "name": i.name, "role": i.role, "quantity": i.quantity})).collect() };
    let day_json = |days: &[DayPlan]| -> Vec<Value> { days.iter().map(DayPlan::to_json).collect() };
    let limit = trip.luggage.get("maxPieces").and_then(Value::as_u64);
    let bag = trip.luggage.get("label").and_then(Value::as_str).unwrap_or("the luggage").to_string();
    let mut pieces = packed_pieces(&item_json(&items), &day_json(&days), &trip.departs_on);
    // Over a limit, the optional flourishes are left out one at a time (`withoutOptionalFlourishes`).
    let mut left_out: Vec<String> = Vec::new();
    if let Some(l) = limit {
        let flourishes: Vec<String> = items.iter().filter(|i| OPTIONAL_FLOURISH.contains(&i.role.as_str())).map(|i| i.garment_id.clone()).collect();
        for id in flourishes {
            if pieces <= l {
                break;
            }
            if let Some(pos) = items.iter().position(|i| i.garment_id == id) {
                left_out.push(items.remove(pos).name);
            }
            for d in days.iter_mut() {
                d.slots.retain(|s| s.garment_id != id);
            }
            pieces = packed_pieces(&item_json(&items), &day_json(&days), &trip.departs_on);
        }
    }
    let (items, days) = (item_json(&items), day_json(&days));
    if !left_out.is_empty() {
        notes.push(format!("To save space in {bag}, the optional {} {} left out.", left_out.join(" and "), if left_out.len() == 1 { "is" } else { "are" }));
    }
    if let Some(l) = limit {
        if !worn_on_travel_day(&days, &trip.departs_on).is_empty() {
            notes.push(format!(
                "The outfit worn on {} for the journey is not packed, so it does not count against {bag}: {pieces} {} packed.",
                trip.departs_on,
                if pieces == 1 { "piece is" } else { "pieces are" }
            ));
        }
        if pieces > l {
            notes.push(format!("This is {pieces} pieces against a limit of {l} for {bag}, with the trousers, jacket, shoes and belt reused across days and the travel-day outfit worn rather than packed."));
        }
    }
    let weather: Vec<Value> = (start..=end)
        .map(|n| {
            let date = local_date(n);
            let label = trip.destination_for(&date)["label"].clone();
            json!({"localDate": date, "label": label, "freshness": "unavailable", "line": "Weather unavailable"})
        })
        .collect();
    // No forecast is read in this port, so every day was proposed without one.
    notes.push("Some destination forecasts are stale or unavailable; those days were proposed without a verified forecast.".into());
    if !trip.laundry.is_empty() {
        notes.push("Laundry opportunities on the trip are estimates until a wash is reported; the proposal does not count on them.".into());
    }
    notes.push("Pieces are reused deliberately across days. That exception to the repeat rule applies to this trip only.".into());
    json!({"tripId": trip.trip_id, "items": items, "days": days, "weather": weather, "notes": notes})
}

/// Places named in one note: the first [`PLACES_NAMED`], then how many more.
const PLACES_NAMED: usize = 8;

fn places(list: &[String]) -> String {
    let named = list.iter().take(PLACES_NAMED).cloned().collect::<Vec<_>>().join(", ");
    match list.len().saturating_sub(PLACES_NAMED) {
        0 => named,
        more => format!("{named} and {more} more"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timezone_names_are_checked_for_their_form() {
        for tz in ["Europe/London", "UTC", "America/Argentina/Buenos_Aires", "Etc/GMT+1", "America/Port-au-Prince", "EST5EDT"] {
            assert!(timezone_ok(tz), "{tz}");
        }
        for tz in ["", "europe/london", "Europe/", "/London", "Europe London", "A/B/C/D", "Europe/L\u{f6}ndon"] {
            assert!(!timezone_ok(tz), "{tz}");
        }
    }

    #[test]
    fn a_stored_trip_round_trips_and_a_changed_list_is_refused() {
        let payload = json!({
            "name": "Paris", "departsOn": "2026-10-20", "returnsOn": "2026-10-22",
            "destinations": [{"label": "Paris", "latitude": 48.8566, "longitude": 2.3522, "timezone": "Europe/Paris", "from": "2026-10-20", "to": "2026-10-22"}],
            "occasions": [{"localDate": "2026-10-21", "label": "Dinner", "segment": "evening"}], "source": {"kind": "owner_statement"},
        });
        let input = parse_create(&payload).unwrap();
        assert_eq!(input.occasions[0]["register"], "none", "the default is applied");
        let trip = Trip {
            trip_id: "trp_1".into(), version: 1, name: input.name, departs_on: input.departs_on, returns_on: input.returns_on,
            destinations: input.destinations, occasions: input.occasions, luggage: input.luggage, laundry: input.laundry,
            status: "planned".into(), source: input.source, proposal_revision: 0, command_id: "cmd_1".into(),
            created_at: "2026-10-12T09:00:00Z".into(), updated_at: "2026-10-12T09:00:00Z".into(),
        };
        assert_eq!(Trip::from_json(&trip.to_json(), "trp_1"), Some(trip.clone()));
        assert_eq!(Trip::from_json(&trip.to_json(), "trp_2"), None);
        let mut bad = trip.to_json();
        bad["occasions"][0].as_object_mut().unwrap().remove("register");
        assert_eq!(Trip::from_json(&bad, "trp_1"), None, "a list its parser would rewrite");
        let mut bad = trip.to_json();
        bad["destinations"][0]["timezone"] = json!("nowhere");
        assert_eq!(Trip::from_json(&bad, "trp_1"), None);
    }
}
