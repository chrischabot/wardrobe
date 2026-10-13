//! Returns and exchanges (specification section 11), ported from
//! packages/assistant/src/commands/returns.ts: `return.open_case` (and its undo, which cancels a
//! case still as it was opened), `return.update_case` (and its undo, which puts the case back as it
//! was before that update), and the cases as `GET /v1/returns` reads them (`listReturnCases`).
//!
//! Opening, requesting or posting a return removes nothing from the wardrobe: a piece leaves only
//! when its physical departure is recorded (`garment.retire`, not ported), so `stockDeparted` is
//! always false here.
//!
//! A deadline exists only when sourced terms and the real trigger date are both known
//! (`computeDeadline`); anything else is unresolved, with the reason. It is the end of the local
//! day `windowDays` after the trigger date, in the case's timezone. This server has no timezone
//! database, so a case's timezone is the owner's (Europe/London, with the British Summer Time rule
//! in `crate::time`) or UTC; any other is refused.
//!
//! Orders are not ported (`purchase.import_order`), so a case is opened for a garment, never for an
//! order line, and `return.link_exchange` is not ported. Reminders are effects, which this port does
//! not have: a case's receipt lists none and none is sent.
//!
//! Each case is its own record (`ret/<caseId>`), written in the ledger's guarded commit; the ledger
//! keeps every case's version (`Ledger::returns`), so `expectedVersions` `return_case:<id>` is checked
//! without a read.

use ferrite_app::serde_json::{json, Map, Value};

use crate::canonical::MAX_SAFE;
use crate::ledger::{invalid, only_keys, undone_summary, CmdError, Ctx, Ledger, Plan, ALREADY_AN_UNDO};
use crate::seed::Catalogue;
use crate::time::{instant, local_date, london_offset_secs, parse_instant, parse_local_date, OWNER_TIMEZONE};

const OPEN: &str = "return.open_case";
const UPDATE: &str = "return.update_case";
const STORED: &str = "the stored return";

/// The payload fields each command accepts, published by `GET /v1/command-types`.
pub const OPEN_FIELDS: &[&str] = &[
    "caseId", "kind", "orderId", "lineId", "garmentId", "quantity", "terms", "triggerDate", "timezone", "nextAction", "collectionPreference", "refundExpectedMinor", "currency", "reason",
];
pub const UPDATE_FIELDS: &[&str] = &[
    "caseId", "state", "terms", "triggerDate", "nextAction", "labelRef", "collectionPreference", "shipmentRef", "retailerReceivedOn", "refundExpectedMinor", "refundReceivedMinor",
    "refundSourceRef", "currency", "note",
];
/// `ReturnCaseState`.
pub const STATES: &[&str] = &["considering", "requested", "label_ready", "posted", "retailer_received", "refunded", "exchanged", "closed", "cancelled"];
/// The timezones a deadline can be computed in on this server.
pub const TIMEZONES: &[&str] = &[OWNER_TIMEZONE, "UTC"];

/// Most cases kept, cancelled and finished ones included (this port's bound).
pub const MAX_CASES: usize = 100;
/// Most notes one case keeps (a note per update, and one per refund).
pub const MAX_NOTES: usize = 50;
/// Largest case record kept, as JSON (an update's undo data holds the whole case as it was).
pub const MAX_CASE_BYTES: usize = 24 * 1024;
/// How many generated IDs a case may try before the command is refused (see `new_id`).
pub const ID_ATTEMPTS: usize = 8;
const MAX_TEXT: usize = 500;
const MAX_TERMS_TEXT: usize = 2_000;
const MAX_WINDOW_DAYS: u64 = 3_650;
const MAX_QUANTITY: u64 = 999;

/// Why an update's undo offers none of its own (returns.ts).
pub const UPDATE_UNDO_NO_UNDO: &str = "this is already an undo; repeat the original update instead";

pub fn key(case_id: &str) -> Vec<u8> {
    format!("ret/{case_id}").into_bytes()
}

// ─────────────────────────────── parsing ───────────────────────────────

fn text(cmd: &str, v: Option<&Value>, field: &str, min: usize, max: usize) -> Result<String, CmdError> {
    match v {
        Some(Value::String(s)) if (min..=max).contains(&s.chars().count()) => Ok(s.clone()),
        _ => Err(invalid(cmd, format!("{field}: expected text of {min} to {max} characters"))),
    }
}

/// Text or null; absent reads as null.
fn text_or_null(cmd: &str, v: Option<&Value>, field: &str, max: usize) -> Result<Option<String>, CmdError> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.chars().count() <= max => Ok(Some(s.clone())),
        _ => Err(invalid(cmd, format!("{field}: expected text of at most {max} characters, or null"))),
    }
}

/// A civil date from 1970-01-01 on.
fn date(cmd: &str, v: Option<&Value>, field: &str) -> Result<String, CmdError> {
    match v {
        Some(Value::String(d)) if parse_local_date(d).map_or(false, |n| n >= 0) => Ok(d.clone()),
        _ => Err(invalid(cmd, format!("{field}: expected a date, YYYY-MM-DD"))),
    }
}

fn date_or_null(cmd: &str, v: Option<&Value>, field: &str) -> Result<Option<String>, CmdError> {
    match v {
        None | Some(Value::Null) => Ok(None),
        v => date(cmd, v, field).map(Some),
    }
}

/// An amount in the currency's minor unit: any whole number, negative included (`MinorAmount`).
fn amount(cmd: &str, v: Option<&Value>, field: &str) -> Result<i64, CmdError> {
    let n = v.and_then(|v| v.as_i64().or_else(|| v.as_f64().filter(|f| f.fract() == 0.0 && f.abs() <= MAX_SAFE as f64).map(|f| f as i64)));
    match n {
        Some(n) if n.unsigned_abs() <= MAX_SAFE => Ok(n),
        _ => Err(invalid(cmd, format!("{field}: expected a whole amount in the currency's minor unit"))),
    }
}

fn amount_or_null(cmd: &str, v: Option<&Value>, field: &str) -> Result<Option<i64>, CmdError> {
    match v {
        None | Some(Value::Null) => Ok(None),
        v => amount(cmd, v, field).map(Some),
    }
}

/// An ISO 4217 code: three characters (`Currency`).
fn currency(cmd: &str, v: Option<&Value>, field: &str) -> Result<String, CmdError> {
    match v {
        Some(Value::String(s)) if s.encode_utf16().count() == 3 => Ok(s.clone()),
        _ => Err(invalid(cmd, format!("{field}: expected a three-letter currency code"))),
    }
}

fn one_of(cmd: &str, v: Option<&Value>, field: &str, allowed: &[&str]) -> Result<String, CmdError> {
    match v {
        Some(Value::String(s)) if allowed.contains(&s.as_str()) => Ok(s.clone()),
        _ => Err(invalid(cmd, format!("{field}: expected one of {}", allowed.join(", ")))),
    }
}

fn whole_in(cmd: &str, v: Option<&Value>, field: &str, max: u64) -> Result<u64, CmdError> {
    match v.and_then(crate::canonical::whole) {
        Some(n) if (1..=max).contains(&n) => Ok(n),
        _ => Err(invalid(cmd, format!("{field}: expected a whole number from 1 to {max}"))),
    }
}

/// `ReturnTerms`: `{windowDays, concerns, triggerEvent, sourceRef, checkedOn, text = null}`.
fn terms(cmd: &str, v: &Value, at: &str) -> Result<Value, CmdError> {
    let allowed = ["windowDays", "concerns", "triggerEvent", "sourceRef", "checkedOn", "text"];
    let Some(o) = v.as_object() else { return Err(invalid(cmd, format!("{at}: expected the return terms, or null"))) };
    if let Some(k) = o.keys().find(|k| !allowed.contains(&k.as_str())) {
        return Err(invalid(cmd, format!("{at}.{k}: not a field here")));
    }
    Ok(json!({
        "windowDays": whole_in(cmd, o.get("windowDays"), &format!("{at}.windowDays"), MAX_WINDOW_DAYS)?,
        "concerns": one_of(cmd, o.get("concerns"), &format!("{at}.concerns"), &["request", "post", "retailer_receipt"])?,
        "triggerEvent": one_of(cmd, o.get("triggerEvent"), &format!("{at}.triggerEvent"), &["delivery", "purchase", "dispatch"])?,
        "sourceRef": text(cmd, o.get("sourceRef"), &format!("{at}.sourceRef"), 1, MAX_TEXT)?,
        "checkedOn": date(cmd, o.get("checkedOn"), &format!("{at}.checkedOn"))?,
        "text": text_or_null(cmd, o.get("text"), &format!("{at}.text"), MAX_TERMS_TEXT)?,
    }))
}

fn case_id(cmd: &str, v: Option<&Value>) -> Result<String, CmdError> {
    text(cmd, v, "caseId", 1, 128)
}

/// A `return.open_case` payload, validated (`ReturnOpenCase`, with its defaults applied).
#[derive(Debug, Clone)]
pub struct OpenInput {
    pub case_id: Option<String>,
    pub kind: String,
    pub garment_id: String,
    pub quantity: u64,
    pub terms: Value,
    pub trigger_date: Option<String>,
    pub timezone: String,
    pub next_action: Option<String>,
    pub collection_preference: Option<String>,
    pub refund_expected: Option<i64>,
    pub currency: Option<String>,
    pub reason: Option<String>,
}

pub fn parse_open(payload: &Value) -> Result<OpenInput, CmdError> {
    only_keys(payload, OPEN, OPEN_FIELDS)?;
    let p = |k: &str| payload.get(k);
    let case_id = match p("caseId") {
        None => None,
        v => Some(case_id(OPEN, v)?),
    };
    for k in ["orderId", "lineId"] {
        if !matches!(p(k), None | Some(Value::Null)) {
            return Err(invalid(OPEN, format!("{k}: orders are not ported to this server yet; open the return for the garment")));
        }
    }
    let garment_id = match p("garmentId") {
        Some(Value::String(g)) if (1..=64).contains(&g.chars().count()) => g.clone(),
        None | Some(Value::Null) => return Err(CmdError::new("invalid_command", "a return needs the garment or the order line it concerns")),
        _ => return Err(invalid(OPEN, "garmentId: expected a garment ID")),
    };
    let timezone = match p("timezone") {
        None => OWNER_TIMEZONE.to_string(),
        Some(Value::String(tz)) if TIMEZONES.contains(&tz.as_str()) => tz.clone(),
        Some(_) => return Err(invalid(OPEN, format!("timezone: this server computes deadlines only in {} (it has no timezone database)", TIMEZONES.join(" and ")))),
    };
    Ok(OpenInput {
        case_id,
        kind: one_of(OPEN, p("kind"), "kind", &["return", "exchange"])?,
        garment_id,
        quantity: if p("quantity").is_some() { whole_in(OPEN, p("quantity"), "quantity", MAX_QUANTITY)? } else { 1 },
        terms: match p("terms") {
            None | Some(Value::Null) => Value::Null,
            Some(t) => terms(OPEN, t, "terms")?,
        },
        trigger_date: date_or_null(OPEN, p("triggerDate"), "triggerDate")?,
        timezone,
        next_action: text_or_null(OPEN, p("nextAction"), "nextAction", MAX_TEXT)?,
        collection_preference: text_or_null(OPEN, p("collectionPreference"), "collectionPreference", MAX_TEXT)?,
        refund_expected: amount_or_null(OPEN, p("refundExpectedMinor"), "refundExpectedMinor")?,
        currency: match p("currency") {
            None | Some(Value::Null) => None,
            v => Some(currency(OPEN, v, "currency")?),
        },
        reason: text_or_null(OPEN, p("reason"), "reason", MAX_TEXT)?,
    })
}

/// A `return.update_case` payload: each field present or not. A nullable text field sent as null
/// clears what was recorded (`Some(None)`).
#[derive(Debug, Clone, Default)]
pub struct UpdateInput {
    pub case_id: String,
    pub state: Option<String>,
    pub terms: Option<Value>,
    pub trigger_date: Option<String>,
    pub next_action: Option<Option<String>>,
    pub label_ref: Option<Option<String>>,
    pub collection_preference: Option<Option<String>>,
    pub shipment_ref: Option<Option<String>>,
    pub retailer_received_on: Option<String>,
    pub refund_expected: Option<i64>,
    pub refund_received: Option<i64>,
    pub refund_source_ref: Option<String>,
    pub currency: Option<String>,
    pub note: Option<Option<String>>,
}

pub fn parse_update(payload: &Value) -> Result<UpdateInput, CmdError> {
    only_keys(payload, UPDATE, UPDATE_FIELDS)?;
    let p = |k: &str| payload.get(k);
    let nullable = |k: &str| -> Result<Option<Option<String>>, CmdError> {
        match p(k) {
            None => Ok(None),
            v => text_or_null(UPDATE, v, k, MAX_TEXT).map(Some),
        }
    };
    Ok(UpdateInput {
        case_id: case_id(UPDATE, p("caseId"))?,
        state: match p("state") {
            None => None,
            v => Some(one_of(UPDATE, v, "state", STATES)?),
        },
        terms: match p("terms") {
            None => None,
            Some(t) => Some(terms(UPDATE, t, "terms")?),
        },
        trigger_date: match p("triggerDate") {
            None => None,
            v => Some(date(UPDATE, v, "triggerDate")?),
        },
        next_action: nullable("nextAction")?,
        label_ref: nullable("labelRef")?,
        collection_preference: nullable("collectionPreference")?,
        shipment_ref: nullable("shipmentRef")?,
        retailer_received_on: match p("retailerReceivedOn") {
            None => None,
            v => Some(date(UPDATE, v, "retailerReceivedOn")?),
        },
        refund_expected: match p("refundExpectedMinor") {
            None => None,
            v => Some(amount(UPDATE, v, "refundExpectedMinor")?),
        },
        refund_received: match p("refundReceivedMinor") {
            None => None,
            v => Some(amount(UPDATE, v, "refundReceivedMinor")?),
        },
        refund_source_ref: match p("refundSourceRef") {
            None => None,
            v => Some(text(UPDATE, v, "refundSourceRef", 0, MAX_TEXT)?),
        },
        currency: match p("currency") {
            None => None,
            v => Some(currency(UPDATE, v, "currency")?),
        },
        note: nullable("note")?,
    })
}

// ─────────────────────────────── deadlines ───────────────────────────────

/// The instant the local day `day` (days since 1970-01-01) ends in `tz` (`endOfLocalDateMs`): the
/// next day's local midnight. London changes its clock at 01:00 UTC, so the offset in force at the
/// next day's 00:00 UTC is the one in force at its local midnight.
fn end_of_local_day_ms(day: i64, tz: &str) -> u64 {
    let next = (day + 1).max(0) as u64 * 86_400_000;
    let offset = if tz == OWNER_TIMEZONE { london_offset_secs(next) as u64 } else { 0 };
    next.saturating_sub(offset * 1000)
}

/// `computeDeadline`: established only from sourced terms and the real trigger date.
pub fn compute_deadline(terms: &Value, trigger_date: Option<&str>, timezone: &str) -> Value {
    let unresolved = |reason: String| {
        json!({"status": "unresolved", "at": null, "localDate": null, "timezone": null, "concerns": terms.get("concerns").cloned().unwrap_or(Value::Null), "reason": reason})
    };
    if terms.is_null() {
        return unresolved("the return terms for this purchase have not been found yet".into());
    }
    if terms["sourceRef"].as_str().map_or(true, |s| s.trim().is_empty()) {
        return unresolved("the return terms have no source".into());
    }
    let Some(trigger) = trigger_date.and_then(parse_local_date) else {
        return unresolved(format!("the {} date is not known yet", terms["triggerEvent"].as_str().unwrap_or("trigger")));
    };
    let day = trigger + terms["windowDays"].as_i64().unwrap_or(0);
    json!({
        "status": "established", "at": instant(end_of_local_day_ms(day, timezone)), "localDate": local_date(day), "timezone": timezone,
        "concerns": terms["concerns"], "reason": null,
    })
}

/// `describeDeadline`.
fn describe_deadline(d: &Value) -> String {
    if d["status"] == "established" {
        let concerns = d["concerns"].as_str().unwrap_or_default();
        let what = if concerns == "retailer_receipt" { "reach the retailer" } else { concerns };
        return format!("Deadline to {what}: {} ({})", d["localDate"].as_str().unwrap_or_default(), d["timezone"].as_str().unwrap_or_default());
    }
    format!("Deadline unresolved: {}", d["reason"].as_str().unwrap_or_default())
}

/// `refundStateOf`.
pub fn refund_state(expected: Option<i64>, received: i64) -> &'static str {
    match expected {
        _ if received <= 0 => "none",
        None => "partial",
        Some(e) if received < e => "partial",
        Some(e) if received == e => "full",
        Some(_) => "over",
    }
}

/// `money` in commands/common.ts: `(minor / 100).toFixed(2)`, after the currency when there is one.
pub fn money(minor: Option<i64>, currency: Option<&str>) -> String {
    let Some(m) = minor else { return "an unknown amount".into() };
    let value = format!("{}{}.{:02}", if m < 0 { "-" } else { "" }, m.unsigned_abs() / 100, m.unsigned_abs() % 100);
    match currency {
        Some(c) => format!("{c} {value}"),
        None => value,
    }
}

/// `named` in commands/common.ts: a free-text value on one line, without double quotes, cut to
/// `max` UTF-16 units, in curly quotes, so it never reads as the system's own statement.
pub fn named(value: &str, max: usize) -> String {
    let mut flat = String::with_capacity(value.len());
    let mut space = false;
    for c in value.chars() {
        let c = match c {
            '\u{0}'..='\u{1f}' | '\u{7f}' | '\u{2028}' | '\u{2029}' => ' ',
            '\u{201c}' | '\u{201d}' | '"' => '\'',
            c => c,
        };
        if c.is_whitespace() {
            space = true;
            continue;
        }
        if space && !flat.is_empty() {
            flat.push(' ');
        }
        space = false;
        flat.push(c);
    }
    let units: usize = flat.chars().map(char::len_utf16).sum();
    if units <= max {
        return format!("\u{201c}{flat}\u{201d}");
    }
    let mut cut = String::new();
    let mut n = 0;
    for c in flat.chars() {
        if n + c.len_utf16() > max.saturating_sub(1) {
            break;
        }
        n += c.len_utf16();
        cut.push(c);
    }
    format!("\u{201c}{}\u{2026}\u{201d}", cut.trim_end())
}

fn state_label(state: &str) -> &str {
    match state {
        "requested" => "Return requested",
        "label_ready" => "Label ready",
        "posted" => "Marked as posted",
        "retailer_received" => "Retailer has received it",
        "refunded" => "Refund complete",
        "exchanged" => "Exchange complete",
        "closed" => "Closed",
        "cancelled" => "Cancelled",
        "considering" => "Back to considering",
        other => other,
    }
}

// ─────────────────────────────── the record ───────────────────────────────

/// One stored case (a `return_cases` row).
#[derive(Debug, Clone, PartialEq)]
pub struct Case {
    pub case_id: String,
    pub version: u64,
    pub kind: String,
    pub state: String,
    pub garment_id: String,
    pub quantity: u64,
    pub terms: Value,
    pub trigger_date: Option<String>,
    /// Always `compute_deadline(terms, trigger_date, deadline_timezone)`.
    pub deadline: Value,
    /// The timezone the deadline is computed in, kept while it is unresolved too.
    pub deadline_timezone: String,
    pub next_action: Option<String>,
    pub label_ref: Option<String>,
    pub collection_preference: Option<String>,
    pub shipment_ref: Option<String>,
    pub retailer_received_on: Option<String>,
    pub refund_expected: Option<i64>,
    pub refund_received: i64,
    pub currency: Option<String>,
    pub reason: Option<String>,
    /// `{at, note, sourceRef?}`, oldest first.
    pub notes: Vec<Value>,
    /// The command that opened the case.
    pub command_id: String,
    pub created_at: String,
    pub updated_at: String,
}

const CASE_FIELDS: &[&str] = &[
    "caseId", "version", "kind", "state", "garmentId", "quantity", "terms", "triggerDate", "deadline", "deadlineTimezone", "nextAction", "labelRef", "collectionPreference", "shipmentRef",
    "retailerReceivedOn", "refundExpectedMinor", "refundReceivedMinor", "currency", "reason", "notes", "commandId", "createdAt", "updatedAt",
];

fn note_ok(v: &Value) -> bool {
    let Some(o) = v.as_object() else { return false };
    let source = match o.get("sourceRef") {
        None => true,
        Some(s) => s.as_str().map_or(false, |s| s.chars().count() <= MAX_TEXT),
    };
    o.keys().all(|k| matches!(k.as_str(), "at" | "note" | "sourceRef"))
        && o.get("at").and_then(Value::as_str).and_then(parse_instant).is_some()
        && o.get("note").and_then(Value::as_str).map_or(false, |n| n.chars().count() <= MAX_TEXT)
        && source
}

impl Case {
    pub fn to_json(&self) -> Value {
        json!({
            "caseId": self.case_id, "version": self.version, "kind": self.kind, "state": self.state, "garmentId": self.garment_id, "quantity": self.quantity,
            "terms": self.terms, "triggerDate": self.trigger_date, "deadline": self.deadline, "deadlineTimezone": self.deadline_timezone,
            "nextAction": self.next_action, "labelRef": self.label_ref, "collectionPreference": self.collection_preference, "shipmentRef": self.shipment_ref,
            "retailerReceivedOn": self.retailer_received_on, "refundExpectedMinor": self.refund_expected, "refundReceivedMinor": self.refund_received,
            "currency": self.currency, "reason": self.reason, "notes": self.notes, "commandId": self.command_id, "createdAt": self.created_at, "updatedAt": self.updated_at,
        })
    }

    /// A stored case this code wrote: every field present and of its type, the terms exactly as
    /// their parser writes them, and the deadline exactly what they give. Anything else is `None`.
    pub fn from_json(v: &Value, case_id: &str) -> Option<Case> {
        let o = v.as_object()?;
        if o.len() != CASE_FIELDS.len() || !CASE_FIELDS.iter().all(|f| o.contains_key(*f)) {
            return None;
        }
        let s = |k: &str| v[k].as_str().map(str::to_string);
        let opt = |k: &str| -> Option<Option<String>> {
            match &v[k] {
                Value::Null => Some(None),
                Value::String(x) if x.chars().count() <= MAX_TEXT => Some(Some(x.clone())),
                _ => None,
            }
        };
        let opt_date = |k: &str| -> Option<Option<String>> {
            match &v[k] {
                Value::Null => Some(None),
                Value::String(d) if parse_local_date(d).map_or(false, |n| n >= 0) => Some(Some(d.clone())),
                _ => None,
            }
        };
        let terms = if v["terms"].is_null() { Value::Null } else { terms(STORED, &v["terms"], "terms").ok()? };
        let trigger_date = opt_date("triggerDate")?;
        let deadline_timezone = s("deadlineTimezone").filter(|tz| TIMEZONES.contains(&tz.as_str()))?;
        let refund_expected = match &v["refundExpectedMinor"] {
            Value::Null => None,
            n => Some(amount(STORED, Some(n), "refundExpectedMinor").ok()?),
        };
        let currency = match &v["currency"] {
            Value::Null => None,
            c => Some(currency(STORED, Some(c), "currency").ok()?),
        };
        let notes = v["notes"].as_array().filter(|n| n.len() <= MAX_NOTES && n.iter().all(note_ok))?.clone();
        let case = Case {
            case_id: s("caseId").filter(|id| id == case_id)?,
            version: v["version"].as_u64().filter(|n| *n >= 1)?,
            kind: s("kind").filter(|k| k == "return" || k == "exchange")?,
            state: s("state").filter(|st| STATES.contains(&st.as_str()))?,
            garment_id: s("garmentId").filter(|g| !g.is_empty())?,
            quantity: v["quantity"].as_u64().filter(|q| (1..=MAX_QUANTITY).contains(q))?,
            deadline: compute_deadline(&terms, trigger_date.as_deref(), &deadline_timezone),
            terms,
            trigger_date,
            deadline_timezone,
            next_action: opt("nextAction")?,
            label_ref: opt("labelRef")?,
            collection_preference: opt("collectionPreference")?,
            shipment_ref: opt("shipmentRef")?,
            retailer_received_on: opt_date("retailerReceivedOn")?,
            refund_expected,
            refund_received: v["refundReceivedMinor"].as_i64().filter(|n| (0..=MAX_SAFE as i64).contains(n))?,
            currency,
            reason: opt("reason")?,
            notes,
            command_id: s("commandId").filter(|c| c.starts_with("cmd_"))?,
            created_at: s("createdAt").filter(|t| parse_instant(t).is_some())?,
            updated_at: s("updatedAt").filter(|t| parse_instant(t).is_some())?,
        };
        (case.to_json() == *v).then_some(case)
    }

    /// The case as `GET /v1/returns` reads it (`ReturnCase`). There are no orders and no recorded
    /// departures here, so the order fields and the exchange's incoming line are null and
    /// `stockDeparted` is false.
    pub fn view(&self) -> Value {
        json!({
            "caseId": self.case_id, "version": self.version, "kind": self.kind, "state": self.state, "orderId": null, "lineId": null, "garmentId": self.garment_id,
            "quantity": self.quantity, "terms": self.terms, "triggerDate": self.trigger_date, "deadline": self.deadline,
            "nextAction": self.next_action, "labelRef": self.label_ref, "collectionPreference": self.collection_preference, "shipmentRef": self.shipment_ref,
            "retailerReceivedOn": self.retailer_received_on,
            "refund": {"expectedMinor": self.refund_expected, "receivedMinor": self.refund_received, "state": refund_state(self.refund_expected, self.refund_received), "currency": self.currency},
            "exchangeIncoming": null, "stockDeparted": false, "createdAt": self.created_at, "updatedAt": self.updated_at,
        })
    }

    fn label(&self, cat: &Catalogue) -> String {
        cat.get(&self.garment_id).map_or_else(|| "the item".to_string(), |g| g.name.clone())
    }
}

fn id_ok(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The ID a new case gets when the payload names none (`ctx.newId("ret")`). `attempt` is 0 for the
/// first choice; a caller-supplied ID may already hold that name, so later attempts add a suffix.
pub fn new_id(ctx: &Ctx<'_>, attempt: usize) -> String {
    let base = format!("ret_{}", ctx.command_id.trim_start_matches("cmd_"));
    if attempt == 0 { base } else { format!("{base}_{attempt}") }
}

fn affected(case: &Case) -> Value {
    json!({"kind": "return_case", "id": case.case_id, "version": case.version})
}

fn fits(cmd: &str, case: &Case) -> Result<(), CmdError> {
    if case.to_json().to_string().len() > MAX_CASE_BYTES {
        return Err(invalid(cmd, format!("the return is larger than this server keeps ({} KiB at most); shorten its notes", MAX_CASE_BYTES / 1024)));
    }
    Ok(())
}

fn not_undoable(message: &str, case_id: &str) -> CmdError {
    CmdError::with("not_undoable", message, json!({"caseId": case_id}))
}

// ─────────────────────────────── commands ───────────────────────────────

/// `return.open_case`: the case is recorded as `considering`; nothing leaves the wardrobe.
pub fn open(ctx: &Ctx<'_>, ledger: &mut Ledger, input: OpenInput) -> Result<(Plan, Case), CmdError> {
    let Some(garment) = ctx.cat.get(&input.garment_id) else {
        return Err(CmdError::with("not_found", format!("no garment '{}' in this wardrobe; nothing was written", input.garment_id), json!({"garmentId": input.garment_id})));
    };
    let case_id = match input.case_id {
        Some(id) => id,
        None => (0..ID_ATTEMPTS)
            .map(|a| new_id(ctx, a))
            .find(|id| !ledger.returns.contains_key(id))
            .ok_or_else(|| CmdError::with("conflict", "no free ID for the return; send a caseId of your own. Nothing was written", json!({"reason": "case_id_taken"})))?,
    };
    if !id_ok(&case_id) {
        return Err(CmdError::new("invalid_command", "a return ID on this server may contain only letters, digits, '-' and '_', at most 64"));
    }
    if ledger.returns.contains_key(&case_id) {
        return Err(CmdError::with("precondition_failed", format!("there is already a return '{case_id}'; nothing was written"), json!({"failed": "the case ID is new"})));
    }
    if ledger.returns.len() >= MAX_CASES {
        return Err(CmdError::with("precondition_failed", format!("this server keeps at most {MAX_CASES} returns; nothing was written"), json!({"reason": "too_many_returns", "limit": MAX_CASES})));
    }
    let deadline = compute_deadline(&input.terms, input.trigger_date.as_deref(), &input.timezone);
    let now = instant(ctx.now_ms);
    let case = Case {
        case_id: case_id.clone(),
        version: 1,
        kind: input.kind,
        state: "considering".into(),
        garment_id: input.garment_id,
        quantity: input.quantity,
        terms: input.terms,
        trigger_date: input.trigger_date,
        deadline: deadline.clone(),
        deadline_timezone: input.timezone,
        next_action: input.next_action,
        label_ref: None,
        collection_preference: input.collection_preference,
        shipment_ref: None,
        retailer_received_on: None,
        refund_expected: input.refund_expected,
        refund_received: 0,
        currency: input.currency,
        reason: input.reason,
        notes: vec![],
        command_id: ctx.command_id.to_string(),
        created_at: now.clone(),
        updated_at: now,
    };
    fits(OPEN, &case)?;
    ledger.returns.insert(case_id.clone(), 1);
    let plan = Plan {
        outcome: "committed",
        summary: format!(
            "{} opened for {}. {}. It stays in your wardrobe until it physically leaves",
            if case.kind == "exchange" { "Exchange" } else { "Return" },
            named(&garment.name, 60),
            describe_deadline(&deadline)
        ),
        affected: vec![affected(&case)],
        repairs: vec![],
        // Reminders are effects, which this port does not have.
        result: json!({"caseId": case_id, "deadline": deadline, "reminders": []}),
        undo: Ok(json!({"caseId": case_id, "version": 1})),
    };
    Ok((plan, case))
}

/// The case an undo names in its undo data.
pub fn undo_target_case(data: &Value) -> Option<&str> {
    data.get("caseId").and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// `command.undo` of `return.open_case`: the case is cancelled, only while it is exactly as it was
/// opened; later progress is corrected by an update.
pub fn undo_open(ctx: &Ctx<'_>, ledger: &mut Ledger, case: Option<&Case>, data: &Value, original_summary: &str, target: &str) -> Result<(Plan, Case), CmdError> {
    let id = undo_target_case(data).unwrap_or_default();
    let Some(case) = case else { return Err(not_undoable("that return is no longer on record", id)) };
    if case.state == "cancelled" {
        return Err(not_undoable("that return is already cancelled; nothing to take back", id));
    }
    let opened = data.get("version").and_then(Value::as_u64).unwrap_or(1);
    if case.version != opened {
        return Err(CmdError::with("not_undoable", "the return has been updated since it was opened; update it to cancel it instead", json!({"caseId": id, "version": case.version})));
    }
    let next = Case { state: "cancelled".into(), version: case.version + 1, updated_at: instant(ctx.now_ms), ..case.clone() };
    ledger.returns.insert(next.case_id.clone(), next.version);
    let plan = Plan {
        outcome: "committed",
        summary: undone_summary(original_summary, "Return cancelled; the item stays as it was"),
        affected: vec![affected(&next)],
        repairs: vec![],
        result: json!({"undoneCommandId": target}),
        undo: Err(ALREADY_AN_UNDO.into()),
    };
    Ok((plan, next))
}

/// `return.update_case`: the named fields change; a refund adds to what was received, and a full
/// refund of a return (with no state named) completes it. Undo puts the case back as it was.
pub fn update(ctx: &Ctx<'_>, ledger: &mut Ledger, case: Option<&Case>, input: UpdateInput) -> Result<(Plan, Case), CmdError> {
    let Some(row) = case else {
        return Err(CmdError::with("not_found", format!("no return '{}'; nothing was written", input.case_id), json!({"caseId": input.case_id})));
    };
    let terms = input.terms.clone().unwrap_or_else(|| row.terms.clone());
    let trigger_date = input.trigger_date.clone().or_else(|| row.trigger_date.clone());
    let deadline = compute_deadline(&terms, trigger_date.as_deref(), &row.deadline_timezone);
    let received = row.refund_received + input.refund_received.unwrap_or(0);
    if received < 0 {
        return Err(CmdError::with("precondition_failed", "a refund total cannot go below zero", json!({"failed": "a refund total cannot go below zero"})));
    }
    if received as u64 > MAX_SAFE {
        return Err(invalid(UPDATE, "refundReceivedMinor: the refund total is larger than this server counts"));
    }
    let expected = input.refund_expected.or(row.refund_expected);
    let currency = input.currency.clone().or_else(|| row.currency.clone());
    let mut state = input.state.clone().unwrap_or_else(|| row.state.clone());
    // A partial refund never closes the case by itself.
    if input.refund_received.is_some() && input.state.is_none() && refund_state(expected, received) == "full" && row.kind == "return" {
        state = "refunded".into();
    }

    let mut parts: Vec<String> = Vec::new();
    if state != row.state {
        parts.push(state_label(&state).to_string());
    }
    if input.terms.is_some() || input.trigger_date.is_some() {
        parts.push(describe_deadline(&deadline));
    }
    if input.refund_received.is_some() {
        let of = match expected {
            Some(e) => format!(" of {} expected ({})", money(Some(e), currency.as_deref()), refund_state(expected, received)),
            None => String::new(),
        };
        parts.push(format!("Refund received so far {}{of}", money(Some(received), currency.as_deref())));
    }
    if let Some(Some(next)) = &input.next_action {
        if !next.is_empty() {
            parts.push(format!("Next: {next}"));
        }
    }
    if matches!(&input.shipment_ref, Some(Some(s)) if !s.is_empty()) {
        parts.push("Shipment recorded".into());
    }
    if parts.is_empty() {
        parts.push("Details updated".into());
    }
    let stock_note = if state == "requested" || state == "label_ready" { " It is still in your wardrobe until it physically leaves" } else { "" };

    let now = instant(ctx.now_ms);
    let mut notes = row.notes.clone();
    if let Some(Some(note)) = &input.note {
        if !note.is_empty() {
            notes.push(json!({"at": now, "note": note}));
        }
    }
    if let Some(r) = input.refund_received {
        let mut n = Map::new();
        n.insert("at".into(), json!(now));
        n.insert("note".into(), json!(format!("refund {r}")));
        if let Some(source) = &input.refund_source_ref {
            n.insert("sourceRef".into(), json!(source));
        }
        notes.push(Value::Object(n));
    }
    if notes.len() > MAX_NOTES {
        return Err(CmdError::with(
            "precondition_failed",
            format!("this server keeps at most {MAX_NOTES} notes on a return; nothing was written"),
            json!({"reason": "too_many_notes", "limit": MAX_NOTES}),
        ));
    }
    let keep = |given: &Option<Option<String>>, was: &Option<String>| given.clone().unwrap_or_else(|| was.clone());
    let next = Case {
        version: row.version + 1,
        state: state.clone(),
        terms,
        trigger_date,
        deadline: deadline.clone(),
        next_action: keep(&input.next_action, &row.next_action),
        label_ref: keep(&input.label_ref, &row.label_ref),
        collection_preference: keep(&input.collection_preference, &row.collection_preference),
        shipment_ref: keep(&input.shipment_ref, &row.shipment_ref),
        retailer_received_on: input.retailer_received_on.clone().or_else(|| row.retailer_received_on.clone()),
        refund_expected: expected,
        refund_received: received,
        currency,
        notes,
        updated_at: now,
        ..row.clone()
    };
    fits(UPDATE, &next)?;
    ledger.returns.insert(next.case_id.clone(), next.version);
    let plan = Plan {
        outcome: "committed",
        summary: format!("{}: {}.{stock_note}", named(&row.label(ctx.cat), 60), parts.join(". ")),
        affected: vec![affected(&next)],
        repairs: vec![],
        result: json!({
            "caseId": next.case_id, "state": state, "deadline": deadline,
            "refund": {"expectedMinor": expected, "receivedMinor": received, "state": refund_state(expected, received)},
        }),
        // Everything this update can change, as it was before, so undo can put the case back exactly.
        undo: Ok(json!({"caseId": next.case_id, "version": next.version, "previous": row.to_json()})),
    };
    Ok((plan, next))
}

/// `command.undo` of `return.update_case`: the case as it was before that update, refused when it
/// was updated again since (a later update would be silently overwritten).
pub fn undo_update(ctx: &Ctx<'_>, ledger: &mut Ledger, case: Option<&Case>, data: &Value, original_summary: &str, target: &str) -> Result<(Plan, Case), CmdError> {
    let id = undo_target_case(data).unwrap_or_default();
    let Some(case) = case else { return Err(not_undoable("that return is no longer on record", id)) };
    if Some(case.version) != data.get("version").and_then(Value::as_u64) {
        return Err(not_undoable("the return has been updated again since; update it once more to correct it", id));
    }
    let Some(previous) = Case::from_json(&data["previous"], id).filter(|p| p.command_id == case.command_id && p.version + 1 == case.version) else {
        return Err(CmdError::with("internal", "the earlier state of that return cannot be read; nothing was written", json!({"retryable": false, "caseId": id})));
    };
    let next = Case { version: case.version + 1, updated_at: instant(ctx.now_ms), ..previous.clone() };
    ledger.returns.insert(next.case_id.clone(), next.version);
    let plan = Plan {
        outcome: "committed",
        summary: undone_summary(
            original_summary,
            &format!("{}: the return is back to how it was before that update ({})", named(&previous.label(ctx.cat), 60), state_label(&previous.state)),
        ),
        affected: vec![affected(&next)],
        repairs: vec![],
        result: json!({"undoneCommandId": target}),
        undo: Err(UPDATE_UNDO_NO_UNDO.into()),
    };
    Ok((plan, next))
}

/// `GET /v1/returns` (`ReturnList`): the soonest established deadline first, then the newest case
/// (`ORDER BY COALESCE(deadline_at, '9999') ASC, created_at DESC`), then by ID.
pub fn listing(mut cases: Vec<Case>) -> Value {
    let at = |c: &Case| c.deadline["at"].as_str().map(str::to_string).unwrap_or_else(|| "9999".into());
    cases.sort_by(|a, b| at(a).cmp(&at(b)).then_with(|| b.created_at.cmp(&a.created_at)).then_with(|| a.case_id.cmp(&b.case_id)));
    json!({"returns": cases.iter().map(Case::view).collect::<Vec<_>>()})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_deadline_is_the_end_of_the_local_day_in_london_or_utc() {
        let terms = json!({"windowDays": 30, "concerns": "post", "triggerEvent": "delivery", "sourceRef": "https://shop.example/returns", "checkedOn": "2026-10-01", "text": null});
        // 2026-10-01 + 30 = 2026-10-31, in Greenwich Mean Time (the clocks went back on 25 October).
        let d = compute_deadline(&terms, Some("2026-10-01"), "Europe/London");
        assert_eq!((d["localDate"].clone(), d["at"].clone()), (json!("2026-10-31"), json!("2026-11-01T00:00:00Z")));
        // 2026-09-01 + 30 = 2026-10-01, in British Summer Time.
        let d = compute_deadline(&terms, Some("2026-09-01"), "Europe/London");
        assert_eq!(d["at"], "2026-10-01T23:00:00Z");
        // The day before the clocks go back ends in summer time; the day they go forward ends in it too.
        assert_eq!(compute_deadline(&terms, Some("2026-09-24"), "Europe/London")["at"], "2026-10-24T23:00:00Z");
        assert_eq!(compute_deadline(&terms, Some("2026-02-27"), "Europe/London")["at"], "2026-03-29T23:00:00Z");
        assert_eq!(compute_deadline(&terms, Some("2026-02-26"), "Europe/London")["at"], "2026-03-29T00:00:00Z");
        assert_eq!(compute_deadline(&terms, Some("2026-09-01"), "UTC")["at"], "2026-10-02T00:00:00Z");
        let unresolved = compute_deadline(&terms, None, "Europe/London");
        assert_eq!(unresolved, json!({"status": "unresolved", "at": null, "localDate": null, "timezone": null, "concerns": "post", "reason": "the delivery date is not known yet"}));
        assert_eq!(compute_deadline(&Value::Null, Some("2026-09-01"), "UTC")["reason"], "the return terms for this purchase have not been found yet");
        let mut blank = terms.clone();
        blank["sourceRef"] = json!("   ");
        assert_eq!(compute_deadline(&blank, Some("2026-09-01"), "UTC")["reason"], "the return terms have no source");
    }

    #[test]
    fn amounts_and_names_read_as_the_typescript_helpers_write_them() {
        assert_eq!(money(Some(1005), Some("GBP")), "GBP 10.05");
        assert_eq!(money(Some(-5), None), "-0.05");
        assert_eq!(money(Some(0), Some("EUR")), "EUR 0.00");
        assert_eq!(money(None, Some("EUR")), "an unknown amount");
        assert_eq!(named("  NB 990v4 \u{2014} grey ", 60), "\u{201c}NB 990v4 \u{2014} grey\u{201d}");
        assert_eq!(named("a \"quoted\"\nname", 60), "\u{201c}a 'quoted' name\u{201d}");
        assert_eq!(named(&"x".repeat(70), 60), format!("\u{201c}{}\u{2026}\u{201d}", "x".repeat(59)));
        assert_eq!(refund_state(Some(1000), 0), "none");
        assert_eq!(refund_state(None, 10), "partial");
        assert_eq!(refund_state(Some(1000), 1000), "full");
        assert_eq!(refund_state(Some(1000), 1200), "over");
    }
}
