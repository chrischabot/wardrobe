//! Studio's reads, ported from packages/media/src/studio/reads.ts and shared.ts: the selectors and
//! opening outfit Studio browses (`GET /v1/studio`), the authoritative check of a finished combination
//! (`POST /v1/studio/validate`), suggestions around the pieces the owner locked (`POST
//! /v1/studio/suggest`, with the daily service's `suggestOutfits`) and the deterministic composition of
//! an outfit (`POST /v1/studio/compose`, packages/media/src/compose/manifest.ts). None of them writes
//! anything.
//!
//! Studio never decides eligibility or rules itself: validation is the daily service's validator
//! (`board::validate`, the port of `validateCandidate`), with the one rule that is Studio's own (a
//! shopping candidate is not owned stock, so it can be explored but never worn or planned) and the
//! Explore downgrade of "not wearable today" findings to advisories (`EXPLORE_ADVISORY`).
//!
//! What this port leaves out (see README.md, "Studio"): there is no media, so every garment is a
//! labelled text tile (`missing`) and no preview is ever rendered or stored; the Studio commands
//! (saving a combination, planning a day, requesting a preview) are not ported, so the saved
//! combinations and day plans are always empty.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use ferrite_app::serde_json::{self, json, Map, Value};

use crate::api::{read_ledger, Store};
use crate::board::{self, Day, Slot, ROLES};
use crate::canonical::canonical;
use crate::ledger::{CmdError, Ledger};
use crate::seed::{catalogue, Catalogue, Garment};
use crate::sha256::hex_digest;
use crate::time::{instant, local_date, owner_day, parse_local_date};

const SELECTOR_ROLES: &[&str] = &["top", "bottom", "footwear", "outer", "mid_layer", "one_piece", "socks", "belt", "neckwear", "accessory"];
const PRIMARY_ROLES: &[&str] = &["top", "bottom", "footwear", "outer"];
/// Codes that describe "not wearable today" rather than "not an outfit"; advisory in Explore
/// (`EXPLORE_ADVISORY` in packages/daily/src/validate.ts).
pub(crate) const EXPLORE_ADVISORY: &[&str] = &[
    "unavailable", "restricted", "not_packed", "conditional_not_requested", "thermal_too_warm", "thermal_too_cold", "fabric_rule",
    "jacket_band_requires_lightweight_oxford", "jacket_band_unverified", "too_warm_together", "outerwear_ceiling", "repeat_within_horizon", "footwear_restricted", "paired_footwear_required",
];
/// `StudioValidation.validator`: the daily service's validator is the one mounted.
pub const VALIDATOR_NAME: &str = "daily-service";
/// Slots one Studio request may carry (the contract sets no upper bound; this port does).
pub const MAX_SLOTS: usize = 24;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    ForToday,
    Explore,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::ForToday => "for_today",
            Mode::Explore => "explore",
        }
    }
    fn parse(v: Option<&str>) -> Result<Mode, CmdError> {
        match v {
            None | Some("for_today") => Ok(Mode::ForToday),
            Some("explore") => Ok(Mode::Explore),
            Some(_) => Err(invalid("mode: expected for_today or explore")),
        }
    }
}

/// A product under consideration (`StudioShoppingCandidate`). It is never owned stock.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub id: String,
    pub label: String,
    pub source_url: Option<String>,
}

/// One slot of a Studio outfit (`StudioSlot`): exactly one of a garment or a shopping candidate.
#[derive(Debug, Clone, PartialEq)]
pub struct StudioSlot {
    pub role: String,
    pub garment_id: Option<String>,
    pub candidate: Option<Candidate>,
    pub locked: bool,
}

impl StudioSlot {
    fn to_json(&self) -> Value {
        json!({
            "role": self.role,
            "garmentId": self.garment_id,
            "shoppingCandidate": self.candidate.as_ref().map(|c| json!({"candidateId": c.id, "label": c.label, "sourceUrl": c.source_url})),
            "locked": self.locked,
        })
    }
}

fn invalid(message: impl Into<String>) -> CmdError {
    CmdError::new("invalid_command", message)
}

fn units(s: &str) -> usize {
    s.encode_utf16().count()
}

/// A string of 1 to `max` UTF-16 units (zod's `.min(1).max(max)`).
fn bounded(v: Option<&Value>, max: usize) -> Option<String> {
    match v {
        Some(Value::String(s)) if (1..=max).contains(&units(s)) => Some(s.clone()),
        _ => None,
    }
}

/// The `slots` of a Studio request (`StudioSlot[]`, at least one). Fields the contract does not name
/// are ignored, as the TypeScript route's schema strips them.
pub fn parse_slots(v: Option<&Value>) -> Result<Vec<StudioSlot>, CmdError> {
    let items = match v {
        Some(Value::Array(a)) if !a.is_empty() && a.len() <= MAX_SLOTS => a,
        _ => return Err(invalid(format!("slots: expected 1 to {MAX_SLOTS} slots"))),
    };
    let mut out = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let Some(o) = item.as_object() else { return Err(invalid(format!("slots[{i}]: expected an object"))) };
        let role = match o.get("role").and_then(Value::as_str) {
            Some(r) if ROLES.contains(&r) => r.to_string(),
            _ => return Err(invalid(format!("slots[{i}].role: expected one of {}", ROLES.join(", ")))),
        };
        let garment_id = match o.get("garmentId") {
            None | Some(Value::Null) => None,
            v => Some(bounded(v, 64).ok_or_else(|| invalid(format!("slots[{i}].garmentId: expected a garment ID or null")))?),
        };
        let candidate = match o.get("shoppingCandidate") {
            None | Some(Value::Null) => None,
            Some(Value::Object(c)) => {
                let id = bounded(c.get("candidateId"), 128).ok_or_else(|| invalid(format!("slots[{i}].shoppingCandidate.candidateId: expected 1 to 128 characters")))?;
                let label = bounded(c.get("label"), 200).ok_or_else(|| invalid(format!("slots[{i}].shoppingCandidate.label: expected 1 to 200 characters")))?;
                let source_url = match c.get("sourceUrl") {
                    None | Some(Value::Null) => None,
                    Some(Value::String(s)) if units(s) <= 2000 => Some(s.clone()),
                    Some(_) => return Err(invalid(format!("slots[{i}].shoppingCandidate.sourceUrl: expected at most 2000 characters or null"))),
                };
                Some(Candidate { id, label, source_url })
            }
            Some(_) => return Err(invalid(format!("slots[{i}].shoppingCandidate: expected an object or null"))),
        };
        let locked = match o.get("locked") {
            None => false,
            Some(Value::Bool(b)) => *b,
            Some(_) => return Err(invalid(format!("slots[{i}].locked: expected true or false"))),
        };
        out.push(StudioSlot { role, garment_id, candidate, locked });
    }
    // `resolveSlots`: checked before any garment is looked up.
    if out.iter().any(|s| s.garment_id.is_some() == s.candidate.is_some()) {
        return Err(invalid("each slot holds exactly one garment or one shopping candidate"));
    }
    Ok(out)
}

/// The slots resolved against the owner's garments (`ResolvedSlots`). Lock flags are presentation
/// state and are dropped.
pub struct Resolved {
    pub slots: Vec<StudioSlot>,
    pub garment_slots: Vec<Slot>,
    pub has_candidate: bool,
}

/// `resolveSlots`: an ID that is not one of the owner's garments is `not_found`, naming every one.
pub fn resolve(cat: &Catalogue, slots: &[StudioSlot]) -> Result<Resolved, CmdError> {
    let mut missing: Vec<&str> = Vec::new();
    for id in slots.iter().filter_map(|s| s.garment_id.as_deref()) {
        if cat.get(id).is_none() && !missing.contains(&id) {
            missing.push(id);
        }
    }
    if !missing.is_empty() {
        let plural = if missing.len() > 1 { "s" } else { "" };
        return Err(CmdError::with("not_found", format!("unknown garment{plural}: {}; nothing was written", missing.join(", ")), json!({"missing": missing})));
    }
    Ok(Resolved {
        slots: slots.iter().map(|s| StudioSlot { locked: false, ..s.clone() }).collect(),
        garment_slots: slots.iter().filter_map(|s| s.garment_id.as_ref().map(|id| Slot { role: s.role.clone(), garment_id: id.clone() })).collect(),
        has_candidate: slots.iter().any(|s| s.candidate.is_some()),
    })
}

fn violation(code: &str, message: &str, blocking: bool) -> Value {
    json!({"code": code, "message": message, "garmentIds": [], "severity": if blocking { "blocking" } else { "advisory" }, "ruleKey": null})
}

/// `validateResolved`: the daily validator's verdict on the garments, then Studio's own rule about
/// shopping candidates (`StudioValidation`). The day validated for is `day`'s.
pub fn validation(day: &Day<'_>, resolved: &Resolved, mode: Mode, for_date: &str, wardrobe_revision: u64, now_ms: u64) -> Value {
    let mut violations: Vec<Value> = Vec::new();
    if !resolved.garment_slots.is_empty() {
        for v in board::validate(day, &resolved.garment_slots, &[], &[]).violations {
            let mut v = v;
            if mode == Mode::Explore && v.blocking && EXPLORE_ADVISORY.contains(&v.code) {
                v.blocking = false;
            }
            violations.push(v.to_json());
        }
    } else if mode == Mode::ForToday {
        violations.push(violation("incomplete_outfit", "There is no owned garment in this outfit", true));
    }
    if resolved.has_candidate {
        violations.push(violation("shopping_candidate_not_owned", "This outfit includes a shopping candidate, which is not owned and cannot be worn or planned", mode == Mode::ForToday));
    }
    let valid = !violations.iter().any(|v| v["severity"] == "blocking");
    json!({
        "valid": valid,
        "wearableOn": if mode == Mode::ForToday { Value::String(for_date.to_string()) } else { Value::Null },
        "violations": violations,
        "validator": VALIDATOR_NAME,
        "wardrobeRevision": wardrobe_revision,
        "checkedAt": instant(now_ms),
    })
}

/// One garment's availability as the selectors report it (`GarmentAvailability`, from
/// `estimateGarment`, with this port's binary stock: a garment is available when a clean unit is at
/// home). A laundered garment no wash or return has been reported for since the import is
/// `estimated` (`import_cleanliness_unverified`), as the estimator's import prior makes it.
pub struct Availability {
    pub status: &'static str,
    pub hard_excluded: bool,
    pub reasons: Vec<&'static str>,
}

pub fn availability(day: &Day<'_>, ledger: &Ledger, g: &Garment) -> Availability {
    let mut reasons: Vec<&'static str> = Vec::new();
    if g.acquisition == "incoming" {
        reasons.push("not_owned_yet");
    }
    if g.acquisition == "disposed" {
        reasons.push("disposed");
    }
    // The profile's healing restriction covers the footwear it does not allow; nothing in this port can lift it.
    if g.roles.iter().any(|r| r == "footwear") && board::sneakers_only_excludes(day.cat, g).is_some() {
        reasons.push("restricted");
    }
    if g.planning_policy == "excluded" {
        reasons.push("planning_excluded");
    }
    let stock = day.stock.of(&g.id);
    if g.acquisition == "owned" && stock.clean == 0 {
        reasons.push("no_units_at_home");
        if stock.dirty > 0 {
            reasons.push("observed_dirty");
        }
        if let Some(batches) = day.stock.service.get(&g.id).filter(|m| m.values().any(|h| h.quantity > 0)) {
            reasons.push(if batches.values().any(|h| h.quantity > 0 && h.held) { "laundry_exception" } else { "in_service_batch" });
        }
        if day.stock.on_trips(&g.id) > 0 {
            reasons.push("on_trip");
        }
    }
    if !reasons.is_empty() {
        return Availability { status: "unavailable", hard_excluded: true, reasons };
    }
    let verified = ledger.events.iter().any(|e| e.voided_by.is_none() && e.garment_id == g.id && matches!(e.kind.as_str(), "wash" | "washed" | "return"));
    let unverified = g.care_channel != "none" && !verified;
    if unverified {
        reasons.push("import_cleanliness_unverified");
    }
    let occasional = g.planning_policy == "occasional";
    let indoor = g.attr_true("indoorOnly");
    if occasional {
        reasons.push("planning_occasional");
    }
    if indoor {
        reasons.push("indoor_only");
    }
    let status = if occasional || indoor { "conditional" } else if unverified { "estimated" } else { "available" };
    Availability { status, hard_excluded: false, reasons }
}

/// The opening outfit: Studio's first suggestion for the day with nothing locked (top, bottom, footwear
/// and socks), offered only when it validates for today; otherwise none.
fn opening(day: &Day<'_>, for_date: &str, wardrobe_revision: u64, now_ms: u64) -> Vec<Value> {
    suggestions(day, &[], Mode::ForToday, for_date, 1, wardrobe_revision, now_ms).first().and_then(|s| s["slots"].as_array().cloned()).unwrap_or_default()
}

/// `suggestStudioOutfits` over the daily service's `suggestOutfits`: up to `limit` outfits composed
/// around the locked garment slots, each keeping every locked piece in its role and nothing else in a
/// locked role. A suggestion keeps only the open roles (the roles of the unlocked slots, and top,
/// bottom and footwear, less the locked roles), the locked ones and socks, even when every role is
/// locked (TypeScript then keeps the whole composed outfit); suggestions that then coincide are one.
/// Each is validated as `POST /v1/studio/validate` validates, and only a valid one is offered. Locked
/// pieces are named explicitly to the composer, so an occasional or indoor-only piece can be built
/// around (it is still validated like any other piece).
pub fn suggestions(day: &Day<'_>, slots: &[StudioSlot], mode: Mode, for_date: &str, limit: usize, wardrobe_revision: u64, now_ms: u64) -> Vec<Value> {
    let locked: Vec<Slot> = slots.iter().filter(|s| s.locked).filter_map(|s| s.garment_id.as_ref().map(|id| Slot { role: s.role.clone(), garment_id: id.clone() })).collect();
    let locked_roles: Vec<&str> = locked.iter().map(|s| s.role.as_str()).collect();
    let mut open: Vec<&str> = Vec::new();
    for role in slots.iter().filter(|s| !s.locked).map(|s| s.role.as_str()).chain(["top", "bottom", "footwear"]) {
        if !open.contains(&role) {
            open.push(role);
        }
    }
    open.retain(|r| !locked_roles.contains(r));
    let explicit: Vec<String> = locked.iter().map(|s| s.garment_id.clone()).collect();
    let opts = crate::recommend::ComposeOpts { locked: &locked, explicit: &explicit, explore: mode == Mode::Explore };
    let composed = crate::recommend::compose_with(day, for_date, limit, 0, &opts);
    let is_locked = |s: &Slot| locked.iter().any(|l| l.role == s.role && l.garment_id == s.garment_id);
    let holds = |list: &[Slot]| locked.iter().all(|l| list.iter().any(|s| s.role == l.role && s.garment_id == l.garment_id));
    let keep = |role: &str| matches!(role, "top" | "bottom" | "footwear" | "socks") || locked_roles.contains(&role) || open.contains(&role);
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut out = Vec::new();
    for o in &composed.options {
        if !holds(&o.slots) {
            continue;
        }
        let kept: Vec<Slot> = o.slots.iter().filter(|s| keep(&s.role)).cloned().collect();
        let mut key: Vec<String> = kept.iter().map(|s| format!("{}:{}", s.role, s.garment_id)).collect();
        key.sort();
        if !seen.insert(key.join("|")) {
            continue;
        }
        // Studio's own check: every locked piece in its role, and no other piece in a locked role.
        if !holds(&kept) || kept.iter().any(|s| locked_roles.contains(&s.role.as_str()) && !is_locked(s)) {
            continue;
        }
        let studio_slots: Vec<StudioSlot> = kept.iter().map(|s| StudioSlot { role: s.role.clone(), garment_id: Some(s.garment_id.clone()), candidate: None, locked: is_locked(s) }).collect();
        let Ok(resolved) = resolve(day.cat, &studio_slots) else { continue };
        let verdict = validation(day, &resolved, mode, for_date, wardrobe_revision, now_ms);
        if verdict["valid"] == true {
            out.push(json!({"slots": studio_slots.iter().map(StudioSlot::to_json).collect::<Vec<_>>(), "reason": o.reason, "validation": verdict}));
        }
    }
    out
}

/// `StudioResponse` for one day: the selectors, the opening outfit, and the saved combinations and
/// day plans (none: the Studio commands are not ported).
pub fn studio_document(cat: &Catalogue, ledger: &Ledger, mode: Mode, for_date: &str, now_ms: u64) -> Value {
    let day = Day::of(cat, ledger, for_date);
    // `listInventory` order: category, name, garment ID.
    let mut garments: Vec<&Garment> = cat.garments.iter().collect();
    garments.sort_by(|a, b| (a.category.as_bytes(), a.name.as_bytes(), a.id.as_bytes()).cmp(&(b.category.as_bytes(), b.name.as_bytes(), b.id.as_bytes())));
    let assessed: Vec<(&Garment, Availability)> = garments.into_iter().map(|g| (g, availability(&day, ledger, g))).collect();
    let selectors: Vec<Value> = SELECTOR_ROLES
        .iter()
        .map(|role| {
            let items: Vec<Value> = assessed
                .iter()
                .filter(|(g, _)| g.roles.iter().any(|r| r == role) && g.acquisition != "disposed")
                .filter_map(|(g, a)| {
                    let eligible = g.acquisition == "owned" && !a.hard_excluded && (a.status == "available" || a.status == "estimated");
                    if mode == Mode::ForToday && !eligible {
                        return None;
                    }
                    let marker = if g.acquisition == "incoming" { "incoming" } else if eligible { "owned" } else { "seasonal_or_stored" };
                    Some(json!({"garmentId": g.id, "shoppingCandidate": null, "name": g.name, "category": g.category, "marker": marker, "eligibleToday": eligible, "availabilityStatus": a.status, "reasons": a.reasons, "image": null}))
                })
                .collect();
            json!({"role": role, "primary": PRIMARY_ROLES.contains(role), "items": items})
        })
        .collect();
    json!({
        "mode": mode.as_str(),
        "forDate": for_date,
        "selectors": selectors,
        "opening": opening(&day, for_date, ledger.revision, now_ms),
        "wardrobeRevision": ledger.revision,
        "readAt": instant(now_ms),
        "combinations": [],
        "dayPlans": [],
    })
}

fn day_or_today(date: Option<&str>, now_ms: u64) -> Result<String, CmdError> {
    match date {
        None => Ok(local_date(owner_day(now_ms))),
        Some(d) if parse_local_date(d).is_some() => Ok(d.to_string()),
        Some(_) => Err(CmdError::with("invalid_command", "date: expected the day as YYYY-MM-DD", json!({"issues": ["date: expected YYYY-MM-DD"]}))),
    }
}

/// `GET /v1/studio[?mode=][&date=]`: for the owner's day now when no date is named.
pub async fn read<S: Store>(store: &mut S, now_ms: u64, mode: Option<&str>, date: Option<&str>) -> Result<Value, CmdError> {
    let mode = Mode::parse(mode)?;
    let for_date = day_or_today(date, now_ms)?;
    let (_, ledger) = read_ledger(store).await?;
    Ok(studio_document(catalogue(), &ledger, mode, &for_date, now_ms))
}

fn body_object(body: &[u8]) -> Result<Map<String, Value>, CmdError> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(Map::new());
    }
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(o)) => Ok(o),
        Ok(_) => Err(invalid("the request body must be a JSON object")),
        Err(_) => Err(invalid("the request body is not valid JSON")),
    }
}

/// The fields of a `StudioOutfitRequest` other than its slots: the mode, the day if named, and the
/// number of suggestions asked for (1 to 10).
fn outfit_request(o: &Map<String, Value>) -> Result<(Mode, Option<&str>, Option<usize>), CmdError> {
    let mode = match o.get("mode") {
        None => Mode::ForToday,
        Some(Value::String(m)) => Mode::parse(Some(m))?,
        Some(_) => return Err(invalid("mode: expected for_today or explore")),
    };
    let date = match o.get("date") {
        None => None,
        Some(Value::String(d)) => Some(d.as_str()),
        Some(_) => return Err(invalid("date: expected the day as YYYY-MM-DD")),
    };
    let limit = match o.get("limit") {
        None => None,
        Some(limit) => match crate::canonical::whole(limit) {
            Some(n @ 1..=10) => Some(n as usize),
            _ => return Err(invalid("limit: expected a whole number from 1 to 10")),
        },
    };
    Ok((mode, date, limit))
}

/// `POST /v1/studio/validate` (`StudioOutfitRequest` → `StudioValidation`): the authoritative check of
/// a finished combination for the day (the owner's day now when none is named). Nothing is saved,
/// planned or worn.
pub async fn validate<S: Store>(store: &mut S, now_ms: u64, body: &[u8]) -> Result<Value, CmdError> {
    let o = body_object(body)?;
    let (mode, date, _) = outfit_request(&o)?;
    let slots = parse_slots(o.get("slots"))?;
    let for_date = day_or_today(date, now_ms)?;
    let cat = catalogue();
    let resolved = resolve(cat, &slots)?;
    let (_, ledger) = read_ledger(store).await?;
    let day = Day::of(cat, &ledger, &for_date);
    Ok(validation(&day, &resolved, mode, &for_date, ledger.revision, now_ms))
}

/// `POST /v1/studio/suggest` (`StudioOutfitRequest` → `{suggestions: StudioSuggestion[]}`): "find
/// something that works with this", for the day (the owner's day now when none is named), five by
/// default. Locked slots come back exactly as given. Nothing is saved, planned or worn.
pub async fn suggest<S: Store>(store: &mut S, now_ms: u64, body: &[u8]) -> Result<Value, CmdError> {
    let o = body_object(body)?;
    let (mode, date, limit) = outfit_request(&o)?;
    let slots = parse_slots(o.get("slots"))?;
    let for_date = day_or_today(date, now_ms)?;
    let cat = catalogue();
    resolve(cat, &slots)?;
    let (_, ledger) = read_ledger(store).await?;
    let day = Day::of(cat, &ledger, &for_date);
    Ok(json!({"suggestions": suggestions(&day, &slots, mode, &for_date, limit.unwrap_or(5), ledger.revision, now_ms)}))
}

// ───────────────────────────── composition ─────────────────────────────

pub const TEMPLATE_VERSION: &str = "layout-1";
const ROLE_ORDER: &[&str] = &["outer", "one_piece", "top", "mid_layer", "bottom", "footwear", "socks", "belt", "neckwear", "accessory"];

#[derive(Clone, Copy)]
struct Frame {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    z: i64,
}

const fn frame(x: f64, y: f64, width: f64, height: f64, z: i64) -> Frame {
    Frame { x, y, width, height, z }
}

struct Main {
    top: Frame,
    bottom: Frame,
    footwear: Frame,
    one_piece: Frame,
}

const CENTRE: Main = Main { top: frame(0.22, 0.04, 0.56, 0.36, 30), bottom: frame(0.26, 0.4, 0.48, 0.4, 20), footwear: frame(0.3, 0.81, 0.4, 0.16, 40), one_piece: frame(0.22, 0.04, 0.56, 0.76, 25) };
// With an outer layer the main column moves right and the outer layer sits beside it, partly layered.
const RIGHT: Main = Main { top: frame(0.4, 0.05, 0.5, 0.34, 30), bottom: frame(0.43, 0.39, 0.44, 0.4, 20), footwear: frame(0.45, 0.8, 0.38, 0.16, 40), one_piece: frame(0.4, 0.05, 0.5, 0.74, 25) };
const OUTER_LONG: Frame = frame(0.02, 0.05, 0.44, 0.8, 10);
const OUTER_SHORT: Frame = frame(0.02, 0.05, 0.44, 0.48, 10);

/// Category-based relative size inside a slot box (`CATEGORY_SCALE`).
fn category_scale(category: &str) -> f64 {
    match category {
        "shirt" | "knitwear" | "trousers" | "outerwear" | "footwear" | "one_piece" => 1.0,
        "tee" => 0.92,
        "socks" | "accessory" => 0.85,
        "belt" | "tie" | "other" => 0.9,
        "scarf" => 0.95,
        "pocket_square" => 0.7,
        _ => 0.9,
    }
}

fn role_label(role: &str) -> &'static str {
    match role {
        "top" => "Top",
        "mid_layer" => "Layer",
        "bottom" => "Bottom",
        "outer" => "Outer layer",
        "footwear" => "Footwear",
        "socks" => "Socks",
        "belt" => "Belt",
        "neckwear" => "Neckwear",
        "accessory" => "Accessory",
        _ => "One-piece",
    }
}

fn role_rank(role: &str) -> usize {
    ROLE_ORDER.iter().position(|r| *r == role).unwrap_or(ROLE_ORDER.len())
}

/// Printable ASCII in the primary order of the root collation `localeCompare` uses (CLDR root, the
/// same for en-US), letters case-folded. Read from ICU 78.2 with `Intl.Collator`.
const ASCII_PRIMARY: &[u8] = b" _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789abcdefghijklmnopqrstuvwxyz";

fn primary_rank(b: u8) -> usize {
    let folded = b.to_ascii_lowercase();
    ASCII_PRIMARY.iter().position(|c| *c == folded).unwrap_or(ASCII_PRIMARY.len())
}

/// One string's collation key: each character's primary weight, then whether it is upper case.
/// A printable-ASCII character weighs `(0, its root-collation rank)`; Ferrite apps have no collation
/// tables, so any other character weighs `(1, its code point)`, after every printable-ASCII one.
fn collation_key(s: &str) -> (Vec<(u8, u32)>, Vec<bool>) {
    s.chars()
        .map(|c| {
            let weight = if (' '..='~').contains(&c) { (0, primary_rank(c as u8) as u32) } else { (1, c as u32) };
            (weight, c.is_ascii_uppercase())
        })
        .unzip()
}

/// `String.prototype.localeCompare` for printable-ASCII strings: every character's primary weight
/// first (punctuation, then digits, then letters regardless of case; a prefix sorts first), then case
/// (lower before upper) at the first character that differs only in case. This model agreed with
/// ICU 78.2's `localeCompare` on 200,000 random pairs of printable-ASCII strings. Any other character
/// sorts by code point after printable ASCII (see `collation_key`). Each string is compared through
/// its own key, so this is a total order whatever strings meet: sorting never depends on input order.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    let (pa, ca) = collation_key(a);
    let (pb, cb) = collation_key(b);
    pa.cmp(&pb).then_with(|| ca.cmp(&cb)).then_with(|| a.cmp(b))
}

/// One slot as the composer lays it out (`ComposeSlot`). This port has no media, so no slot carries
/// an image.
struct ComposeSlot {
    role: String,
    garment_id: Option<String>,
    candidate_id: Option<String>,
    name: String,
    category: String,
    outer_length: Option<String>,
}

/// `isLongOuter`: the recorded length, else a coat word in the name (`\b(coat|overcoat|...)\b`, any case).
fn is_long_outer(slot: &ComposeSlot) -> bool {
    match slot.outer_length.as_deref() {
        Some("long") => return true,
        Some("short") => return false,
        _ => {}
    }
    const LONG: &[&str] = &["coat", "overcoat", "trench", "parka", "mac", "raincoat", "duffle", "ulster"];
    slot.name.to_ascii_lowercase().split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).any(|w| LONG.contains(&w))
}

fn choose_template(slots: &[ComposeSlot]) -> &'static str {
    let has = |role: &str| slots.iter().any(|s| s.role == role);
    let outer = slots.iter().find(|s| s.role == "outer");
    if has("one_piece") {
        return if outer.is_some() { "one_piece_with_outer" } else { "one_piece" };
    }
    if let Some(o) = outer {
        return if is_long_outer(o) { "separates_with_long_coat" } else { "separates_with_jacket" };
    }
    if has("mid_layer") || slots.iter().any(|s| s.role == "top" && s.category == "knitwear") {
        return "separates_with_knitwear";
    }
    "separates"
}

/// `Math.round(n * 10000) / 10000` (the values are never negative).
fn round4(n: f64) -> f64 {
    (n * 10000.0).round() / 10000.0
}

/// A number as JavaScript writes it: a whole number without a fraction.
fn num(f: f64) -> Value {
    if f.fract() == 0.0 && f.abs() < 9.0e15 {
        json!(f as i64)
    } else {
        json!(f)
    }
}

/// `buildManifest`: the same slots always give the same manifest.
fn build_manifest(input: Vec<ComposeSlot>) -> Value {
    let mut slots = input;
    let key = |s: &ComposeSlot| s.garment_id.clone().or_else(|| s.candidate_id.clone()).unwrap_or_default();
    slots.sort_by(|a, b| role_rank(&a.role).cmp(&role_rank(&b.role)).then_with(|| locale_compare(&key(a), &key(b))));
    let template = choose_template(&slots);
    let with_outer = slots.iter().any(|s| s.role == "outer");
    let main = if with_outer { &RIGHT } else { &CENTRE };
    let has_mid = slots.iter().any(|s| s.role == "mid_layer");
    let side_x = if with_outer { 0.9 } else { 0.8 };
    let side_w = if with_outer { 0.095 } else { 0.17 };
    let mut counters: BTreeMap<String, i64> = BTreeMap::new();
    let mut layers: Vec<(i64, usize, Value)> = Vec::new();
    for slot in &slots {
        let n = *counters.get(&slot.role).unwrap_or(&0);
        counters.insert(slot.role.clone(), n + 1);
        let mut b = match slot.role.as_str() {
            // Under knitwear the shirt shows as a smaller piece tucked behind the main top position.
            "top" if has_mid => frame(main.top.x - 0.1, main.top.y - 0.02, main.top.width * 0.62, main.top.height * 0.7, 28),
            "top" | "mid_layer" => main.top,
            "bottom" => main.bottom,
            "one_piece" => main.one_piece,
            "footwear" => main.footwear,
            "outer" => {
                if is_long_outer(slot) {
                    OUTER_LONG
                } else {
                    OUTER_SHORT
                }
            }
            "socks" => frame(if with_outer { 0.84 } else { 0.72 }, 0.85, 0.15, 0.12, 41),
            "belt" => frame(side_x, 0.42, side_w, 0.07, 42),
            "neckwear" => frame(side_x, 0.06, side_w, 0.2, 43),
            _ => frame(side_x, 0.52, side_w, 0.11, 44),
        };
        if n > 0 {
            let nf = n as f64;
            b = Frame { x: (b.x - 0.012 * nf).max(0.0), y: (0.98 - b.height).min(b.y + (b.height * 0.5 + 0.02) * nf), z: b.z + n, ..b };
        }
        let scale = category_scale(&slot.category);
        let w = b.width * scale;
        let h = b.height * scale;
        let label = if slot.candidate_id.is_some() { "shopping_candidate" } else { "missing" };
        layers.push((
            b.z,
            role_rank(&slot.role),
            json!({
                "role": slot.role,
                "garmentId": slot.garment_id,
                "shoppingCandidateId": slot.candidate_id,
                "name": slot.name,
                "assetId": null,
                "renditionId": null,
                "renditionVersion": null,
                "renditionSha256": null,
                "imageLabel": label,
                "x": num(round4(b.x + (b.width - w) / 2.0)),
                "y": num(round4(b.y + (b.height - h) / 2.0)),
                "width": num(round4(w)),
                "height": num(round4(h)),
                "scale": num(scale),
                "z": b.z,
            }),
        ));
    }
    layers.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    let caption: Vec<String> = slots
        .iter()
        .map(|s| format!("{}: {}{}", role_label(&s.role), s.name, if s.candidate_id.is_some() { " (shopping candidate, not owned)" } else { " (no photo yet)" }))
        .collect();
    json!({
        "templateVersion": TEMPLATE_VERSION,
        "template": template,
        "canvas": {"width": 900, "height": 1200, "background": "#FFFFFF"},
        "layers": layers.into_iter().map(|l| l.2).collect::<Vec<_>>(),
        "caption": if caption.is_empty() { "Empty outfit".to_string() } else { format!("{}.", caption.join(". ")) },
    })
}

/// `Composition` for resolved slots: the manifest, its hash (SHA-256 of the canonical JSON, as
/// `manifestHash`), and the state of its preview, which is always `none` here: previews are never
/// requested or rendered on this server.
pub fn composition(cat: &Catalogue, resolved: &Resolved) -> Value {
    let compose: Vec<ComposeSlot> = resolved
        .slots
        .iter()
        .map(|s| match (&s.garment_id, &s.candidate) {
            (Some(id), _) => {
                let g = cat.get(id);
                let outer_length = g.map(|g| g.attr_str("outerLength")).filter(|l| *l == "long" || *l == "short").map(str::to_string);
                ComposeSlot { role: s.role.clone(), garment_id: Some(id.clone()), candidate_id: None, name: g.map_or_else(|| id.clone(), |g| g.name.clone()), category: g.map_or_else(|| "other".to_string(), |g| g.category.clone()), outer_length }
            }
            (None, c) => {
                let c = c.as_ref();
                ComposeSlot { role: s.role.clone(), garment_id: None, candidate_id: c.map(|c| c.id.clone()), name: c.map(|c| c.label.clone()).unwrap_or_default(), category: "other".into(), outer_length: None }
            }
        })
        .collect();
    let manifest = build_manifest(compose);
    let hash = hex_digest(canonical(&manifest).as_bytes());
    let layers = manifest["layers"].as_array().cloned().unwrap_or_default();
    let missing: Vec<Value> = layers.iter().filter(|l| l["imageLabel"] == "missing" && l["garmentId"].is_string()).map(|l| l["garmentId"].clone()).collect();
    let mut labels: Vec<&str> = Vec::new();
    if layers.iter().any(|l| l["imageLabel"] == "shopping_candidate") {
        labels.push("Shopping candidate");
    }
    if layers.iter().any(|l| l["imageLabel"] == "missing") {
        labels.push("No photo yet");
    }
    json!({
        "manifestHash": hash,
        "manifest": manifest,
        "preview": {"state": "none", "sha256": null, "renderedAt": null, "failure": null},
        "missingImages": missing,
        "labels": labels,
    })
}

/// `POST /v1/studio/compose` (`StudioComposeRequest` → `Composition`). Read only.
pub fn compose(body: &[u8]) -> Result<Value, CmdError> {
    let o = body_object(body)?;
    let slots = parse_slots(o.get("slots"))?;
    let cat = catalogue();
    let resolved = resolve(cat, &slots)?;
    Ok(composition(cat, &resolved))
}

/// `GET /v1/studio/compositions/{hash}[/preview]`: a composition is kept only when a preview is
/// requested, which this server does not do, so there is never one to read.
pub fn stored_composition(rest: &str) -> CmdError {
    if rest.ends_with("/preview") {
        CmdError::new("not_found", "no rendered preview for this outfit")
    } else {
        CmdError::new("not_found", "no such outfit preview for this owner")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_role_ids_sort_as_locale_compare_sorts_them() {
        // The expected order is node's `[...ids].sort((a, b) => a.localeCompare(b))` (ICU 78.2, en-US).
        let ids = ["cand-B", "cand_b", "Cand-a", "cand.a", "cand a", "cand-a", "CAND-A", "cand-10", "cand-9", "cand-a1", "cand#1", "cand$1", "gmt_0abc", "cand~", "cand|", "Cand-A", "cand-ab", "cand-Ab", "cand-aB", "cand", "cand-"];
        let want = ["cand", "cand a", "cand_b", "cand-", "cand-10", "cand-9", "cand-a", "Cand-a", "Cand-A", "CAND-A", "cand-a1", "cand-ab", "cand-aB", "cand-Ab", "cand-B", "cand.a", "cand#1", "cand|", "cand~", "cand$1", "gmt_0abc"];
        let mut sorted = ids.to_vec();
        sorted.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(sorted, want);
        // The seed's garment IDs (gmt_ and lower-case hex) sort as their bytes do.
        let mut hex = ["gmt_9f", "gmt_0a", "gmt_a0", "gmt_09"];
        hex.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(hex, ["gmt_09", "gmt_0a", "gmt_9f", "gmt_a0"]);
        assert_eq!(locale_compare("same", "same"), Ordering::Equal);
    }

    #[test]
    fn ordering_is_total_when_ascii_and_other_ids_meet() {
        // ASCII-only and non-ASCII IDs in one role must still sort the same whatever the request order.
        let ids = ["a", "B", "[é", "é", "cand-é", "cand-e", "Cand-é", "b", "A", "z", "", "cand", "ü1", "[", "日本"];
        for x in ids {
            for y in ids {
                assert_eq!(locale_compare(x, y), locale_compare(y, x).reverse(), "{x:?} vs {y:?}");
                assert_eq!(locale_compare(x, y) == Ordering::Equal, x == y, "{x:?} vs {y:?}");
                for z in ids {
                    if locale_compare(x, y) == Ordering::Less && locale_compare(y, z) == Ordering::Less {
                        assert_eq!(locale_compare(x, z), Ordering::Less, "{x:?} < {y:?} < {z:?}");
                    }
                }
            }
        }
        // The reviewer's cycle: printable ASCII keeps localeCompare's "[" < "a" < "B".
        let want = ["[é", "a", "B"];
        for order in [["a", "B", "[é"], ["B", "[é", "a"], ["[é", "B", "a"]] {
            let mut sorted = order.to_vec();
            sorted.sort_by(|a, b| locale_compare(a, b));
            assert_eq!(sorted, want);
        }
    }
}
