//! Optional comfort feedback, ported from packages/assistant (commands/feedback.ts, and
//! `listComfortFeedback` in queries.ts): `feedback.record` ("too warm on the train"), its undo, and
//! `feedback.retract`, plus the read behind `GET /v1/feedback`.
//!
//! An observation is linked only to what is actually known; missing context stays null. It never
//! becomes a universal ban by itself: its scope stays the reported occasion unless the owner states a
//! wider one. The receipt never repeats the owner's words, only the kind and the garments' names.
//!
//! Each note is its own record (`fb/<feedbackId>`), written in the same guarded commit as the ledger
//! and the receipt. The ledger keeps only the IDs of the notes still active, so the list read never
//! scans; a withdrawn note leaves the index and its record stays, marked `retracted`.
//!
//! Not ported: a painful note does not yet repair future outfits (packages/daily repair.ts), and
//! notes are not indexed for search (no AI Search here).

use ferrite_app::serde_json::{json, Map, Value};

use crate::ledger::{invalid, load, name_list, only_keys, undone_summary, CmdError, Ctx, Ledger, Plan, ALREADY_AN_UNDO};
use crate::time::{instant, parse_instant, parse_local_date};

const RECORD: &str = "feedback.record";
const RETRACT: &str = "feedback.retract";

/// The payload fields each command accepts, published by `GET /v1/command-types`.
pub const RECORD_FIELDS: &[&str] = &["feedbackId", "text", "kind", "garmentIds", "wearingDate", "activity", "layer", "conditions", "scope", "sourceRef"];
pub const RETRACT_FIELDS: &[&str] = &["feedbackId", "reason"];

/// `ComfortKind` and the word a receipt uses for it (`KIND_LABEL`).
pub const KINDS: &[(&str, &str)] = &[
    ("too_warm", "too warm"),
    ("too_cold", "too cold"),
    ("scratchy", "scratchy"),
    ("pain", "painful"),
    ("tight", "tight"),
    ("loose", "loose"),
    ("restrictive", "restrictive"),
    ("other_discomfort", "uncomfortable"),
    ("positive", "comfortable"),
];

/// Most notes active at once (this port's bound: the ledger indexes the active ones).
pub const MAX_ACTIVE: usize = 100;
/// Most garments one note names (the TypeScript contract sets no maximum).
pub const MAX_GARMENTS: usize = 50;
/// Largest `conditions` object, as compact JSON (the TypeScript contract sets no maximum).
pub const MAX_CONDITIONS_BYTES: usize = 4_096;
/// The reason an undone note's receipt gives for having no undo of its own (`NO_UNDO("already an undo")`).
pub const UNDO_OF_UNDO: &str = ALREADY_AN_UNDO;
/// Why a withdrawal has no undo (feedback.ts).
pub const RETRACT_NO_UNDO: &str = "record the observation again to restore it";
/// Why a repeated note (or withdrawal) has no undo.
pub const NOTHING_CHANGED: &str = "nothing changed";

pub fn key(feedback_id: &str) -> Vec<u8> {
    format!("fb/{feedback_id}").into_bytes()
}

/// One stored note (`comfort_feedback` with its `comfort_feedback_garments`).
#[derive(Debug, Clone, PartialEq)]
pub struct Note {
    pub feedback_id: String,
    pub text: String,
    pub kind: String,
    pub garment_ids: Vec<String>,
    pub wearing_date: Option<String>,
    pub activity: Option<String>,
    pub layer: Option<String>,
    pub conditions: Value,
    pub scope: Option<String>,
    pub source_ref: Option<String>,
    pub status: String,
    pub version: u64,
    pub command_id: String,
    pub created_at: String,
}

const NOTE_FIELDS: &[&str] = &[
    "feedbackId", "text", "kind", "garmentIds", "wearingDate", "activity", "layer", "conditions", "scope", "sourceRef", "status", "version", "commandId", "createdAt",
];

impl Note {
    pub fn to_json(&self) -> Value {
        json!({
            "feedbackId": self.feedback_id, "text": self.text, "kind": self.kind, "garmentIds": self.garment_ids,
            "wearingDate": self.wearing_date, "activity": self.activity, "layer": self.layer, "conditions": self.conditions,
            "scope": self.scope, "sourceRef": self.source_ref, "status": self.status, "version": self.version,
            "commandId": self.command_id, "createdAt": self.created_at,
        })
    }

    /// A stored note this code wrote, every field present and of its type; anything else is `None`.
    pub fn from_json(v: &Value, feedback_id: &str) -> Option<Note> {
        let o = v.as_object()?;
        if o.len() != NOTE_FIELDS.len() || !NOTE_FIELDS.iter().all(|f| o.contains_key(*f)) {
            return None;
        }
        let st = |k: &str| v[k].as_str().map(str::to_string);
        let opt = |k: &str| match &v[k] {
            Value::Null => Some(None),
            Value::String(s) => Some(Some(s.clone())),
            _ => None,
        };
        let wearing_date = match &v["wearingDate"] {
            Value::Null => None,
            Value::String(d) if parse_local_date(d).is_some() => Some(d.clone()),
            _ => return None,
        };
        let note = Note {
            feedback_id: st("feedbackId").filter(|id| id == feedback_id)?,
            text: st("text").filter(|t| !t.is_empty())?,
            kind: st("kind").filter(|k| KINDS.iter().any(|(x, _)| x == k))?,
            garment_ids: v["garmentIds"].as_array()?.iter().map(|g| g.as_str().map(str::to_string)).collect::<Option<Vec<_>>>()?,
            wearing_date,
            activity: opt("activity")?,
            layer: opt("layer")?,
            conditions: v["conditions"].as_object().map(|m| Value::Object(m.clone()))?,
            scope: opt("scope")?,
            source_ref: opt("sourceRef")?,
            status: st("status").filter(|s| s == "active" || s == "retracted")?,
            version: v["version"].as_u64().filter(|n| *n >= 1)?,
            command_id: st("commandId").filter(|c| c.starts_with("cmd_"))?,
            created_at: st("createdAt").filter(|t| parse_instant(t).is_some())?,
        };
        Some(note)
    }

    /// The note as `GET /v1/feedback` lists it (`ComfortFeedback`).
    pub fn view(&self) -> Value {
        json!({
            "feedbackId": self.feedback_id, "text": self.text, "kind": self.kind, "pain": self.kind == "pain",
            "garmentIds": self.garment_ids, "wearingDate": self.wearing_date, "activity": self.activity, "layer": self.layer,
            "conditions": self.conditions, "scope": self.scope, "status": self.status, "createdAt": self.created_at,
        })
    }
}

/// A `feedback.record` payload, validated (`FeedbackRecord`).
#[derive(Debug, Clone)]
pub struct RecordInput {
    pub feedback_id: Option<String>,
    pub text: String,
    pub kind: String,
    pub garment_ids: Vec<String>,
    pub wearing_date: Option<String>,
    pub activity: Option<String>,
    pub layer: Option<String>,
    pub conditions: Value,
    pub scope: Option<String>,
    pub source_ref: Option<String>,
}

fn opt_text(command: &str, payload: &Value, key: &str, max: usize) -> Result<Option<String>, CmdError> {
    match payload.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.chars().count() <= max => Ok(Some(s.clone())),
        _ => Err(invalid(command, format!("{key}: expected a string of at most {max} characters, or null"))),
    }
}

/// An ID the contract allows (`Id`: 1 to 128 characters).
fn feedback_id(command: &str, v: Option<&Value>, required: bool) -> Result<Option<String>, CmdError> {
    match v {
        None if !required => Ok(None),
        Some(Value::String(s)) if !s.is_empty() && s.chars().count() <= 128 => Ok(Some(s.clone())),
        _ => Err(invalid(command, "feedbackId: expected an ID of 1 to 128 characters")),
    }
}

pub fn parse_record(payload: &Value) -> Result<RecordInput, CmdError> {
    only_keys(payload, RECORD, RECORD_FIELDS)?;
    let text = match payload.get("text") {
        Some(Value::String(s)) if !s.is_empty() && s.chars().count() <= 2_000 => s.clone(),
        _ => return Err(invalid(RECORD, "text: expected the owner's words, 1 to 2000 characters")),
    };
    let kind = match payload.get("kind").and_then(Value::as_str) {
        Some(k) if KINDS.iter().any(|(x, _)| *x == k) => k.to_string(),
        _ => return Err(invalid(RECORD, format!("kind: expected one of {}", KINDS.iter().map(|(k, _)| *k).collect::<Vec<_>>().join(", ")))),
    };
    let mut garment_ids: Vec<String> = Vec::new();
    match payload.get("garmentIds") {
        None => {}
        Some(Value::Array(a)) if a.len() <= MAX_GARMENTS => {
            for (i, g) in a.iter().enumerate() {
                match g.as_str() {
                    Some(s) if !s.is_empty() && s.len() <= 64 => {
                        if !garment_ids.iter().any(|x| x == s) {
                            garment_ids.push(s.to_string());
                        }
                    }
                    _ => return Err(invalid(RECORD, format!("garmentIds[{i}]: expected a garment ID (1 to 64 characters)"))),
                }
            }
        }
        Some(_) => return Err(invalid(RECORD, format!("garmentIds: expected an array of at most {MAX_GARMENTS} garment IDs"))),
    }
    let wearing_date = match payload.get("wearingDate") {
        None | Some(Value::Null) => None,
        Some(Value::String(d)) if parse_local_date(d).is_some() => Some(d.clone()),
        _ => return Err(invalid(RECORD, "wearingDate: expected a date, YYYY-MM-DD, or null")),
    };
    let conditions = match payload.get("conditions") {
        None => json!({}),
        Some(Value::Object(m)) if Value::Object(m.clone()).to_string().len() <= MAX_CONDITIONS_BYTES => Value::Object(m.clone()),
        Some(Value::Object(_)) => return Err(invalid(RECORD, format!("conditions: at most {MAX_CONDITIONS_BYTES} bytes as JSON"))),
        Some(_) => return Err(invalid(RECORD, "conditions: expected an object")),
    };
    Ok(RecordInput {
        feedback_id: feedback_id(RECORD, payload.get("feedbackId"), false)?,
        text,
        kind,
        garment_ids,
        wearing_date,
        activity: opt_text(RECORD, payload, "activity", 200)?,
        layer: opt_text(RECORD, payload, "layer", 100)?,
        conditions,
        scope: opt_text(RECORD, payload, "scope", 300)?,
        source_ref: opt_text(RECORD, payload, "sourceRef", 500)?,
    })
}

/// How many generated IDs a note may try before the command is refused (see `new_id`).
pub const ID_ATTEMPTS: usize = 8;

/// The ID a new note gets when the payload names none (`ctx.newId("cfb")`). `attempt` is 0 for the
/// first choice; a caller-supplied ID may already hold that name, so later attempts add a suffix.
pub fn new_id(ctx: &Ctx<'_>, attempt: usize) -> String {
    let base = format!("cfb_{}", ctx.command_id.trim_start_matches("cmd_"));
    if attempt == 0 { base } else { format!("{base}_{attempt}") }
}

fn label(kind: &str) -> &'static str {
    KINDS.iter().find(|(k, _)| *k == kind).map_or("uncomfortable", |(_, l)| *l)
}

/// `feedback.record` under `feedback_id`, the ID the payload names or a free generated one.
/// `existing` is the stored note of that ID, if any: a note already recorded under it (or already
/// listed in this commit) is a noop, whatever the payload says now, and nothing in the payload is
/// looked up. Returns the plan and the note to write.
pub fn record(ctx: &Ctx<'_>, ledger: &mut Ledger, input: RecordInput, feedback_id: String, existing: Option<&Note>) -> Result<(Plan, Option<Note>), CmdError> {
    if existing.is_some() || ledger.feedback.iter().any(|id| *id == feedback_id) {
        let plan = Plan {
            outcome: "noop",
            summary: "That observation was already noted".into(),
            affected: vec![],
            repairs: vec![],
            result: json!({"feedbackId": feedback_id}),
            undo: Err(NOTHING_CHANGED.into()),
        };
        return Ok((plan, None));
    }
    if ledger.feedback.len() >= MAX_ACTIVE {
        return Err(CmdError::with(
            "precondition_failed",
            format!("there are already {MAX_ACTIVE} active comfort notes; withdraw one that no longer applies first. Nothing was written"),
            json!({"reason": "too_many_comfort_notes", "limit": MAX_ACTIVE}),
        ));
    }
    let garments = load(ctx.cat, &input.garment_ids)?;
    let names: Vec<String> = garments.iter().map(|g| g.name.clone()).collect();
    let subject = if names.is_empty() { "what you wore".to_string() } else { name_list(&names) };
    let verb = if names.len() > 1 { "were" } else { "was" };
    let place = input.scope.as_ref().or(input.activity.as_ref()).map_or(String::new(), |w| format!(" ({})", one_line(w)));
    let note = Note {
        feedback_id: feedback_id.clone(),
        text: input.text,
        kind: input.kind.clone(),
        garment_ids: input.garment_ids.clone(),
        wearing_date: input.wearing_date,
        activity: input.activity,
        layer: input.layer,
        conditions: input.conditions,
        scope: input.scope.clone(),
        source_ref: input.source_ref,
        status: "active".into(),
        version: 1,
        command_id: ctx.command_id.to_string(),
        created_at: instant(ctx.occurred_at_ms),
    };
    ledger.feedback.push(feedback_id.clone());
    let mut affected = vec![json!({"kind": "comfort_feedback", "id": feedback_id, "version": 1})];
    affected.extend(input.garment_ids.iter().map(|g| json!({"kind": "garment_feedback", "id": g, "version": 1})));
    let plan = Plan {
        outcome: "committed",
        // The owner's wording is not repeated in the receipt, so withdrawing the note leaves no copy here.
        summary: format!("Noted: {subject} {verb} {}{place}. Applied to that context only", label(&input.kind)),
        affected,
        repairs: vec![],
        result: json!({"feedbackId": feedback_id, "garmentIds": input.garment_ids, "pain": input.kind == "pain", "scope": input.scope}),
        undo: Ok(json!({"feedbackId": feedback_id})),
    };
    Ok((plan, Some(note)))
}

/// A scope or activity as it may appear inside a receipt: one line, control characters removed, cut
/// short (`named` in commands/common.ts keeps such values from reading as the system's own words).
fn one_line(s: &str) -> String {
    let clean: String = s.chars().map(|c| if c.is_control() || c == '\u{2028}' || c == '\u{2029}' { ' ' } else { c }).collect();
    let words: Vec<&str> = clean.split_whitespace().collect();
    let joined = words.join(" ");
    if joined.chars().count() > 60 {
        format!("{}\u{2026}", joined.chars().take(59).collect::<String>().trim_end())
    } else {
        joined
    }
}

pub fn parse_retract(payload: &Value) -> Result<String, CmdError> {
    only_keys(payload, RETRACT, RETRACT_FIELDS)?;
    match payload.get("reason") {
        None | Some(Value::Null) | Some(Value::String(_)) => {}
        _ => return Err(invalid(RETRACT, "reason: expected a string or null")),
    }
    if payload.get("reason").and_then(Value::as_str).map_or(false, |r| r.chars().count() > 2_000) {
        return Err(invalid(RETRACT, "reason: at most 2000 characters"));
    }
    Ok(feedback_id(RETRACT, payload.get("feedbackId"), true)?.unwrap_or_default())
}

fn withdraw(ledger: &mut Ledger, note: &Note) -> Note {
    ledger.feedback.retain(|id| *id != note.feedback_id);
    Note { status: "retracted".into(), version: note.version + 1, ..note.clone() }
}

/// `feedback.retract`: the note no longer affects suggestions. It cannot be undone; the owner records
/// the observation again instead.
pub fn retract(ledger: &mut Ledger, feedback_id: &str, existing: Option<&Note>) -> Result<(Plan, Option<Note>), CmdError> {
    let Some(note) = existing else {
        return Err(CmdError::with("not_found", format!("no comfort note '{feedback_id}'; nothing was written"), json!({"feedbackId": feedback_id})));
    };
    if note.status != "active" {
        let plan = Plan {
            outcome: "noop",
            summary: "That comfort note was already withdrawn".into(),
            affected: vec![],
            repairs: vec![],
            result: json!({"feedbackId": feedback_id}),
            undo: Err(NOTHING_CHANGED.into()),
        };
        return Ok((plan, None));
    }
    let next = withdraw(ledger, note);
    let plan = Plan {
        outcome: "committed",
        summary: "Comfort note withdrawn; it no longer affects suggestions".into(),
        affected: vec![json!({"kind": "comfort_feedback", "id": feedback_id, "version": next.version})],
        repairs: vec![],
        result: json!({"feedbackId": feedback_id}),
        undo: Err(RETRACT_NO_UNDO.into()),
    };
    Ok((plan, Some(next)))
}

/// The note an undo of `feedback.record` names in its undo data.
pub fn undo_target_note(data: &Value) -> Option<&str> {
    data.get("feedbackId").and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// `command.undo` of `feedback.record`: the note is withdrawn (`planUndo`). A note the owner already
/// withdrew stays withdrawn and nothing else changes.
pub fn undo_record(ledger: &mut Ledger, existing: Option<&Note>, original_summary: &str, target: &str) -> Result<(Plan, Option<Note>), CmdError> {
    let Some(note) = existing.filter(|n| n.command_id == target) else {
        return Err(CmdError::with(
            "internal",
            "the comfort note that action recorded cannot be read; nothing was written",
            json!({"retryable": false, "commandId": target}),
        ));
    };
    let (affected, next) = if note.status == "active" {
        let next = withdraw(ledger, note);
        (vec![json!({"kind": "comfort_feedback", "id": note.feedback_id, "version": next.version})], Some(next))
    } else {
        (vec![], None)
    };
    let plan = Plan {
        outcome: "committed",
        summary: undone_summary(original_summary, "Comfort note withdrawn"),
        affected,
        repairs: vec![],
        result: json!({"undoneCommandId": target}),
        undo: Err(UNDO_OF_UNDO.into()),
    };
    Ok((plan, next))
}

/// The notes `GET /v1/feedback` lists: the active ones, newest first, those naming `garment` when given.
pub fn listing(notes: Vec<Note>, garment: Option<&str>) -> Value {
    let mut notes: Vec<Note> = notes.into_iter().filter(|n| n.status == "active" && garment.map_or(true, |g| n.garment_ids.iter().any(|x| x == g))).collect();
    // `ORDER BY created_at DESC`; notes of the same instant keep the newest-recorded first.
    notes.reverse();
    notes.sort_by(|a, b| parse_instant(&b.created_at).cmp(&parse_instant(&a.created_at)));
    let mut out = Map::new();
    out.insert("feedback".into(), Value::Array(notes.iter().map(Note::view).collect()));
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receipt_text_keeps_a_scope_on_one_short_line() {
        assert_eq!(one_line("commute\nby   train"), "commute by train");
        let long = "x".repeat(80);
        assert_eq!(one_line(&long).chars().count(), 60);
        assert!(one_line(&long).ends_with('\u{2026}'));
    }

    #[test]
    fn a_stored_note_round_trips_and_anything_else_is_refused() {
        let note = Note {
            feedback_id: "cfb_1".into(),
            text: "too warm on the train".into(),
            kind: "too_warm".into(),
            garment_ids: vec!["gmt_a".into()],
            wearing_date: Some("2026-10-12".into()),
            activity: None,
            layer: None,
            conditions: json!({"rain": true}),
            scope: Some("commute by train".into()),
            source_ref: None,
            status: "active".into(),
            version: 1,
            command_id: "cmd_1".into(),
            created_at: "2026-10-12T08:00:00.000Z".into(),
        };
        assert_eq!(Note::from_json(&note.to_json(), "cfb_1"), Some(note.clone()));
        assert_eq!(Note::from_json(&note.to_json(), "cfb_2"), None, "the record of another ID");
        let mut bad = note.to_json();
        bad["kind"] = json!("itchy");
        assert_eq!(Note::from_json(&bad, "cfb_1"), None);
        let mut extra = note.to_json();
        extra["admin"] = json!(true);
        assert_eq!(Note::from_json(&extra, "cfb_1"), None);
    }
}
