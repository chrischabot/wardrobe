//! The versioned availability estimator, ported from packages/domain/src/availability/estimator.ts with
//! its input as `buildEstimatorInput` (packages/domain/src/queries.ts) builds it: `GET /v1/availability`
//! and the `availability` view of `garderobe_inventory`. Probability without status interrogation:
//! observed facts (the replayed balances, the healing restriction, acquisition and planning policy) plus
//! an estimate of unreported routine wear from the outfits offered since the last baseline. Uncertainty
//! is never a hard exclusion, never creates units and never touches recorded wear. The parameters are
//! the specification's documented hypotheses (`DEFAULT_OWNER_SETTINGS.estimator`), not calibrated.
//!
//! Where this port's records differ from the TypeScript tables, and what that means:
//! - there is no `exposure_sets` table: the open option sets are derived from the stored day boards
//!   ([`board_exposures`]), as `planRevisionWrite` writes them (one set per board revision; neckwear
//!   left out; a shoe with alternatives becomes an alternative group; the choice and its shoe carried),
//!   with the same lifecycle: a set is not written for a day whose wear was already recorded when the
//!   revision was published, a newer revision supersedes it, and a counted wear of one of its garments
//!   resolves it (an undone wear reopens it);
//! - no weekly laundry baseline is ported, so `lastBaseline` is null and the cutoff for unreported wear
//!   is the pattern horizon (14 days before the day asked about) for both care channels, and no unit is
//!   clean only by inference (`cleanInferred` is 0);
//! - a deliberate departure from TypeScript, whose cutoff comes only from the weekly baseline: a wash or
//!   laundry return the owner reported that brought every unit of a garment back clean moves that
//!   garment's cutoff to the owner's day of that report, so outfits offered before it no longer count
//!   against it ([`Input::observed_from`]);
//! - stock is at home (clean or in the hamper), in a service batch or packed for a trip; storage and the
//!   tailor are not ported, so `in_storage` and `at_tailor` never occur.

use std::collections::BTreeMap;

use ferrite_app::serde_json::{json, Value};

use crate::board::{self, Board};
use crate::ledger::{Ledger, Replay};
use crate::seed::{Catalogue, Garment};
use crate::time::{instant, local_date, owner_day, parse_local_date};

/// `AVAILABILITY_MODEL_VERSION` (packages/contracts/src/version.ts).
pub const MODEL_VERSION: &str = "availability-estimator/1.0.0";
/// `variety.patternHorizonDays` default: without a baseline, older unreported wear no longer counts.
pub const PATTERN_HORIZON_DAYS: i64 = 14;

/// `EstimatorParams`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Params {
    /// Probability the owner dresses from the board at all.
    pub p_use_board: f64,
    /// Probability a chosen option is the one worn.
    pub p_follow_selection: f64,
    /// Probability an imported unit no wash or return was reported for is clean.
    pub import_clean_prior: f64,
}

/// `DEFAULT_OWNER_SETTINGS.estimator`: no settings command is ported, so these are the owner's.
pub const PARAMS: Params = Params { p_use_board: 0.85, p_follow_selection: 0.9, import_clean_prior: 0.8 };

/// One option of an offered set (`ExposureOption`).
#[derive(Debug, Clone, PartialEq)]
pub struct ExposureOption {
    pub option_id: String,
    /// Garments certain to be worn if this option is worn.
    pub garment_ids: Vec<String>,
    /// Alternatives sharing the option's probability (the shoe and its alternatives).
    pub alternative_groups: Vec<Vec<String>>,
}

/// `EstimatorExposureSet`: mutually exclusive options offered for one day, wear not yet observed.
#[derive(Debug, Clone, PartialEq)]
pub struct ExposureSet {
    pub exposure_id: String,
    pub local_date: String,
    /// Overrides `p_use_board` when set.
    pub p_use: Option<f64>,
    pub selected_option_id: Option<String>,
    pub chosen_alternatives: Vec<String>,
    pub options: Vec<ExposureOption>,
}

/// A JavaScript `Map`: insertion order kept, a repeated key adds to its entry in place.
fn add<K: PartialEq>(map: &mut Vec<(K, f64)>, key: K, p: f64) {
    match map.iter_mut().find(|(k, _)| *k == key) {
        Some((_, v)) => *v += p,
        None => map.push((key, p)),
    }
}

/// `exposureOutcomes`: the worn-garment sets one exposure set can end in, with probabilities summing
/// to at most 1 (the rest is a different, unreported outfit or no wear).
pub fn exposure_outcomes(set: &ExposureSet, params: &Params) -> Vec<(f64, Vec<String>)> {
    let mut outcomes: Vec<(f64, Vec<String>)> = Vec::new();
    let mut expand = |option: &ExposureOption, probability: f64, chosen: &[String]| {
        let mut combos: Vec<(f64, Vec<String>)> = vec![(probability, option.garment_ids.clone())];
        for group in &option.alternative_groups {
            let picked: Vec<&String> = group.iter().filter(|id| chosen.contains(id)).collect();
            let choices: Vec<&String> = if picked.is_empty() { group.iter().collect() } else { picked };
            let n = choices.len() as f64;
            let mut next = Vec::with_capacity(combos.len() * choices.len());
            for (p, ids) in &combos {
                for id in &choices {
                    let mut with = ids.clone();
                    with.push((*id).clone());
                    next.push((p / n, with));
                }
            }
            combos = next;
        }
        outcomes.extend(combos);
    };
    match set.selected_option_id.as_ref().and_then(|id| set.options.iter().find(|o| &o.option_id == id)) {
        Some(selected) => expand(selected, params.p_follow_selection, &set.chosen_alternatives),
        None => {
            let p_use = set.p_use.unwrap_or(params.p_use_board);
            let n = set.options.len() as f64;
            for option in &set.options {
                expand(option, p_use / n, &[]);
            }
        }
    }
    outcomes
}

/// `selectionProbability`: options are summed, never double-charged.
pub fn selection_probability(set: &ExposureSet, garment_id: &str, params: &Params) -> f64 {
    let mut p = 0.0;
    for (q, ids) in exposure_outcomes(set, params) {
        if ids.iter().any(|id| id == garment_id) {
            p += q;
        }
    }
    p.min(1.0)
}

/// `inferredWearByDate`: per local date, the probability the garment was worn without a report (at
/// most one wear per date), from `cutoff` on.
pub fn inferred_wear_by_date(garment_id: &str, exposures: &[ExposureSet], params: &Params, cutoff: Option<&str>) -> Vec<(String, f64)> {
    let mut by_date: Vec<(String, f64)> = Vec::new();
    for set in exposures {
        if cutoff.map_or(false, |c| set.local_date.as_str() < c) {
            continue;
        }
        let p = selection_probability(set, garment_id, params);
        if p <= 0.0 {
            continue;
        }
        match by_date.iter_mut().find(|(d, _)| *d == set.local_date) {
            Some((_, q)) => *q = 1.0 - (1.0 - *q) * (1.0 - p),
            None => by_date.push((set.local_date.clone(), 1.0 - (1.0 - 0.0) * (1.0 - p))),
        }
    }
    by_date.sort_by(|a, b| a.0.cmp(&b.0));
    by_date
}

/// One stock balance (`BalanceRow`): `clean`, `dirty`, `service` (`ref` the batch) or `trip` (`ref` the
/// trip, `<trip>#dirty` for units already worn there).
#[derive(Debug, Clone, PartialEq)]
pub struct Balance {
    pub bucket: &'static str,
    pub reference: String,
    pub quantity: u32,
    pub held: bool,
}

/// `toBalances`: the non-zero balances of a garment, clean, then the hamper, then each service batch
/// in the order it was picked up, then each trip in the order it was first packed for (its clean units,
/// then its worn ones).
pub fn balances(stock: &Replay, garment_id: &str) -> Vec<Balance> {
    let st = stock.of(garment_id);
    let mut out = Vec::new();
    if st.clean > 0 {
        out.push(Balance { bucket: "clean", reference: String::new(), quantity: st.clean, held: false });
    }
    if st.dirty > 0 {
        out.push(Balance { bucket: "dirty", reference: String::new(), quantity: st.dirty, held: false });
    }
    if let Some(batches) = stock.service.get(garment_id) {
        let mut held: Vec<(&String, &crate::ledger::Holding)> = batches.iter().filter(|(_, h)| h.quantity > 0).collect();
        held.sort_by(|a, b| (a.1.picked_up_at_ms, a.0).cmp(&(b.1.picked_up_at_ms, b.0)));
        for (batch, h) in held {
            out.push(Balance { bucket: "service", reference: batch.clone(), quantity: h.quantity, held: h.held });
        }
    }
    for (trip, s) in stock.trips.get(garment_id).map(Vec::as_slice).unwrap_or(&[]) {
        if s.clean > 0 {
            out.push(Balance { bucket: "trip", reference: trip.clone(), quantity: s.clean, held: false });
        }
        if s.dirty > 0 {
            out.push(Balance { bucket: "trip", reference: format!("{trip}#dirty"), quantity: s.dirty, held: false });
        }
    }
    out
}

/// `hardReasons`: what excludes a garment until an observation or an applicable event changes the
/// fact, with the restrictions that cover it. Studio's selectors read the same reasons.
pub fn hard_reasons(cat: &Catalogue, stock: &Replay, g: &Garment) -> (Vec<&'static str>, Vec<String>) {
    let mut reasons: Vec<&'static str> = Vec::new();
    let mut restriction_ids: Vec<String> = Vec::new();
    if g.acquisition == "incoming" {
        reasons.push("not_owned_yet");
    }
    if g.acquisition == "disposed" {
        reasons.push("disposed");
    }
    // The profile's healing restriction covers the footwear it does not allow; nothing in this port lifts it.
    if g.roles.iter().any(|r| r == "footwear") && board::sneakers_only_excludes(cat, g).is_some() {
        restriction_ids.push(cat.healing_restriction_id.clone());
        reasons.push("restricted");
    }
    if g.planning_policy == "excluded" {
        reasons.push("planning_excluded");
    }
    let st = stock.of(&g.id);
    if g.acquisition == "owned" && st.clean == 0 {
        reasons.push("no_units_at_home");
        if st.dirty > 0 {
            reasons.push("observed_dirty");
        }
        if let Some(batches) = stock.service.get(&g.id).filter(|m| m.values().any(|h| h.quantity > 0)) {
            reasons.push(if batches.values().any(|h| h.quantity > 0 && h.held) { "laundry_exception" } else { "in_service_batch" });
        }
        if stock.on_trips(&g.id) > 0 {
            reasons.push("on_trip");
        }
    }
    (reasons, restriction_ids)
}

/// Imported stock whose cleanliness no wash, return or count has established since (no laundry
/// baseline is ported to assume it).
pub fn import_unverified(ledger: &Ledger, g: &Garment) -> bool {
    g.care_channel != "none" && !ledger.events.iter().any(|e| e.voided_by.is_none() && e.garment_id == g.id && matches!(e.kind.as_str(), "wash" | "washed" | "return"))
}

/// `EstimatorInput`, over the catalogue: the replayed stock, the import evidence and the open sets.
pub struct Input<'a> {
    pub cat: &'a Catalogue,
    pub ledger: &'a Ledger,
    pub stock: Replay,
    pub params: Params,
    pub exposures: Vec<ExposureSet>,
    /// The first local date whose unreported wear still matters (both care channels).
    pub cutoff: String,
    /// By garment, the owner's day of the latest report that every unit of the garment is clean: a wash
    /// he reported (of all its units) or a laundry return that brought every unit back. Unreported wear
    /// before that day no longer matters for it.
    pub observed_from: BTreeMap<String, String>,
}

impl<'a> Input<'a> {
    /// The input for a fresh wear on `for_date`, given the open sets (from [`board_exposures`]).
    pub fn new(cat: &'a Catalogue, ledger: &'a Ledger, for_date: &str, exposures: Vec<ExposureSet>) -> Input<'a> {
        let stock = crate::ledger::replay(cat, &ledger.events);
        let mut observed_from: BTreeMap<String, String> = BTreeMap::new();
        for e in ledger.events.iter().filter(|e| e.voided_by.is_none() && matches!(e.kind.as_str(), "wash" | "washed" | "return")) {
            let Some(g) = cat.get(&e.garment_id) else { continue };
            // A journaled wash or return always moved what it reports (a report that moved nothing is not
            // written), so the units it speaks for are the units it moved.
            if stock.moved.get(&e.id).copied().unwrap_or(0) < g.quantity.max(1) {
                continue;
            }
            let day = local_date(owner_day(e.at_ms));
            let entry = observed_from.entry(g.id.clone()).or_default();
            if day > *entry {
                *entry = day;
            }
        }
        Input { cat, ledger, stock, params: PARAMS, exposures, cutoff: horizon(for_date), observed_from }
    }

    /// The cutoff for a garment: the later of the pattern horizon and its last full observation; none for
    /// a garment that is never laundered (it is not tracked).
    fn cutoff_for(&self, g: &Garment) -> Option<&str> {
        if g.care_channel == "none" {
            return None;
        }
        match self.observed_from.get(&g.id) {
            Some(day) if day.as_str() > self.cutoff.as_str() => Some(day.as_str()),
            _ => Some(self.cutoff.as_str()),
        }
    }

    fn clean(&self, id: &str) -> u32 {
        self.stock.of(id).clean
    }
}

/// The pattern horizon of `for_date`: the cutoff while no laundry baseline exists.
pub fn horizon(for_date: &str) -> String {
    parse_local_date(for_date).map(|d| local_date(d - PATTERN_HORIZON_DAYS)).unwrap_or_default()
}

/// `jointAvailability`: the exact joint probability that every listed garment still has a clean unit
/// at home for a fresh wear, over the shared option outcomes (garments offered together are
/// correlated, not multiplied as independent). A hard-excluded garment makes it 0 and is listed.
pub fn joint_availability(input: &Input<'_>, garment_ids: &[&str]) -> (f64, Vec<String>) {
    let mut unique: Vec<&str> = Vec::new();
    for id in garment_ids {
        if !unique.contains(id) {
            unique.push(id);
        }
    }
    let mut hard_excluded: Vec<String> = Vec::new();
    // (garment, clean units, cutoff)
    let mut tracked: Vec<(&str, u32, Option<&str>)> = Vec::new();
    let mut prior = 1.0;
    for id in unique {
        let Some(g) = input.cat.get(id) else {
            hard_excluded.push(id.to_string());
            continue;
        };
        if !hard_reasons(input.cat, &input.stock, g).0.is_empty() {
            hard_excluded.push(id.to_string());
            continue;
        }
        if g.care_channel == "none" {
            continue; // never laundered: present means wearable
        }
        if import_unverified(input.ledger, g) {
            prior *= input.params.import_clean_prior;
        }
        tracked.push((id, input.clean(id), input.cutoff_for(g)));
    }
    if !hard_excluded.is_empty() {
        return (0.0, hard_excluded);
    }
    if tracked.is_empty() || tracked.len() > 63 {
        return (prior, hard_excluded);
    }
    let index = |id: &str| tracked.iter().position(|t| t.0 == id);
    let mut dates: Vec<&str> = input.exposures.iter().map(|e| e.local_date.as_str()).collect();
    dates.sort();
    dates.dedup();
    // Unreported-wear count per tracked garment, capped at its clean quantity (the cap is unavailable).
    let mut states: Vec<(Vec<u32>, f64)> = vec![(vec![0; tracked.len()], 1.0)];
    for date in dates {
        // Which tracked garments were worn that date (a bitmask), over the date's independent sets.
        let mut masks: Vec<(u64, f64)> = vec![(0, 1.0)];
        for set in input.exposures.iter().filter(|e| e.local_date == date) {
            let mut set_masks: Vec<(u64, f64)> = Vec::new();
            let mut used = 0.0;
            for (p, ids) in exposure_outcomes(set, &input.params) {
                let mut mask = 0u64;
                for id in &ids {
                    if let Some(i) = index(id) {
                        if !tracked[i].2.map_or(false, |c| date < c) {
                            mask |= 1 << i;
                        }
                    }
                }
                add(&mut set_masks, mask, p);
                used += p;
            }
            add(&mut set_masks, 0, (1.0 - used).max(0.0));
            let mut next: Vec<(u64, f64)> = Vec::new();
            for (m1, p1) in &masks {
                for (m2, p2) in &set_masks {
                    add(&mut next, m1 | m2, p1 * p2);
                }
            }
            masks = next;
        }
        let mut next_states: Vec<(Vec<u32>, f64)> = Vec::new();
        for (counts, p) in &states {
            for (mask, pm) in &masks {
                if *pm == 0.0 {
                    continue;
                }
                let next: Vec<u32> = counts.iter().enumerate().map(|(i, c)| tracked[i].1.min(c + ((mask >> i) & 1) as u32)).collect();
                add(&mut next_states, next, p * pm);
            }
        }
        states = next_states;
    }
    let mut ok = 0.0;
    for (counts, p) in &states {
        if counts.iter().enumerate().all(|(i, c)| *c < tracked[i].1) {
            ok += p;
        }
    }
    ((ok * prior).min(1.0).max(0.0), hard_excluded)
}

/// A probability as JavaScript writes it: a whole number without a fraction.
fn num(p: f64) -> Value {
    if p.fract() == 0.0 && p.abs() < 1e15 {
        json!(p as i64)
    } else {
        json!(p)
    }
}

/// `cleanBasis`: how the clean units at home are known. No unit is clean only by inference here.
fn clean_basis(ledger: &Ledger, g: &Garment, clean: u32) -> String {
    let units = format!("{clean} clean unit{} at home", if clean == 1 { "" } else { "s" });
    if g.care_channel != "none" && import_unverified(ledger, g) {
        return format!("{units} (ledger balance as imported; no wash or return has been reported for it)");
    }
    format!("{units} (observed ledger balance)")
}

/// What [`estimate`] says of one garment, for the readers that need only the verdict (Studio).
pub struct Verdict {
    pub status: &'static str,
    pub hard_excluded: bool,
    pub reasons: Vec<&'static str>,
    pub p_available: f64,
}

/// `estimateGarment`: the verdict and its `GarmentAvailability` document.
pub fn estimate(input: &Input<'_>, g: &Garment) -> (Verdict, Value) {
    let (mut reasons, restriction_ids) = hard_reasons(input.cat, &input.stock, g);
    let hard_excluded = !reasons.is_empty();
    let clean = input.clean(&g.id);
    let inferred = if g.care_channel == "none" { Vec::new() } else { inferred_wear_by_date(&g.id, &input.exposures, &input.params, input.cutoff_for(g)) };
    let mut basis: Vec<String> = Vec::new();
    let mut p_available = 0.0;
    let mut status = "unavailable";
    if !hard_excluded {
        p_available = joint_availability(input, &[g.id.as_str()]).0;
        basis.push(clean_basis(input.ledger, g, clean));
        if g.care_channel != "none" && import_unverified(input.ledger, g) {
            reasons.push("import_cleanliness_unverified");
            basis.push("cleanliness imported without an observation; treated as an estimate until a laundry baseline or owner report".into());
        }
        if !inferred.is_empty() {
            reasons.push("estimated_possibly_worn");
            basis.push(format!("offered on {} unreported day{} since the last laundry baseline", inferred.len(), if inferred.len() == 1 { "" } else { "s" }));
        }
        let occasional = g.planning_policy == "occasional";
        let indoor = g.attr_true("indoorOnly");
        if occasional {
            reasons.push("planning_occasional");
        }
        if indoor {
            reasons.push("indoor_only");
        }
        status = if occasional || indoor { "conditional" } else if p_available < 1.0 { "estimated" } else { "available" };
    } else {
        basis.push(format!("excluded: {}", reasons.join(", ")));
    }
    let doc = json!({
        "garmentId": g.id,
        "status": status,
        "hardExcluded": hard_excluded,
        "pAvailable": num(p_available),
        "inferredWear": inferred.iter().map(|(d, p)| json!({"localDate": d, "probability": num(*p)})).collect::<Vec<_>>(),
        "reasons": reasons,
        "restrictionIds": restriction_ids,
        "acquisition": g.acquisition,
        "planningPolicy": g.planning_policy,
        "balances": balances(&input.stock, &g.id).iter().map(|b| json!({"bucket": b.bucket, "ref": b.reference, "quantity": b.quantity})).collect::<Vec<_>>(),
        // Every clean unit here was observed or imported; none is clean only by the weekly inference.
        "cleanObserved": clean,
        "basis": basis,
    });
    (Verdict { status, hard_excluded, reasons, p_available }, doc)
}

/// The garments in `listInventory`'s order: category, name, garment ID (SQLite's byte order).
pub fn ordered(cat: &Catalogue) -> Vec<&Garment> {
    let mut garments: Vec<&Garment> = cat.garments.iter().collect();
    garments.sort_by(|a, b| (a.category.as_bytes(), a.name.as_bytes(), a.id.as_bytes()).cmp(&(b.category.as_bytes(), b.name.as_bytes(), b.id.as_bytes())));
    garments
}

/// `getAvailability` (`AvailabilitySnapshot`): every garment's availability for a fresh wear on
/// `for_date`.
pub fn snapshot(input: &Input<'_>, for_date: &str, now_ms: u64) -> Value {
    let garments: Vec<Value> = ordered(input.cat).into_iter().map(|g| estimate(input, g).1).collect();
    json!({
        "modelVersion": MODEL_VERSION,
        "forDate": for_date,
        "computedAt": instant(now_ms),
        "wardrobeRevision": input.ledger.revision,
        "parameters": {"pUseBoard": input.params.p_use_board, "pFollowSelection": input.params.p_follow_selection, "parameterStatus": "hypothesis"},
        // No weekly service-laundry baseline is ported.
        "lastBaseline": null,
        "garments": garments,
    })
}

/// Whether a board scope is a day's (not an evening's): the boards whose options are an exposure.
pub fn day_scope(scope: &str) -> bool {
    !scope.ends_with(":evening")
}

/// The open option sets of the boards given (any read: the caller loads those the ledger indexes) for
/// days in `[from, before)`, as `planRevisionWrite`, `wear.record` and its undo leave `exposure_sets`:
/// - one set per board, its current revision's offered options, in option-ID order with each option's
///   garments in ID order (the order the TypeScript reads `exposure_items` back in);
/// - an option's neckwear is left out, and its shoe with the alternatives forms one alternative group;
/// - the choice is carried, with its shoe when the option has alternatives;
/// - no set when the revision was written while a counted wear of that day was active (`writeExposure`,
///   recorded on the revision when it was written; a revision stored before the port recorded it falls
///   back to a report of that day, still standing, recorded before its publication);
/// - resolved, so left out, when a counted wear of that day is of one of its garments.
pub fn board_exposures(ledger: &Ledger, boards: &[Board], from: &str, before: &str) -> Vec<ExposureSet> {
    let mut sets: Vec<(String, String, ExposureSet)> = Vec::new();
    for b in boards {
        if !day_scope(&b.scope) || b.status != "active" || b.local_date.as_str() < from || b.local_date.as_str() >= before {
            continue;
        }
        let Some(rev) = b.current() else { continue };
        if rev.offered.is_empty() {
            continue;
        }
        let wrote_exposure = match rev.write_exposure {
            Some(written) => written,
            None => !ledger.observations.iter().any(|o| o.wearing_date == b.local_date && o.retracted_by.is_none() && o.reported_at_ms < rev.published_at_ms),
        };
        if !wrote_exposure {
            continue;
        }
        let mut options: Vec<ExposureOption> = rev
            .offered
            .iter()
            .map(|o| {
                let footwear = o.slot("footwear");
                let group: Vec<String> = match footwear {
                    Some(f) if !o.footwear_alternatives.is_empty() => std::iter::once(f.to_string()).chain(o.footwear_alternatives.iter().cloned()).collect(),
                    _ => Vec::new(),
                };
                let mut seen: Vec<String> = Vec::new();
                let mut garment_ids: Vec<String> = Vec::new();
                for s in o.slots.iter().filter(|s| s.role != "neckwear" && !(!group.is_empty() && s.role == "footwear")) {
                    if !seen.contains(&s.garment_id) {
                        seen.push(s.garment_id.clone());
                        garment_ids.push(s.garment_id.clone());
                    }
                }
                let mut alternatives: Vec<String> = Vec::new();
                for id in &group {
                    if !seen.contains(id) {
                        seen.push(id.clone());
                        alternatives.push(id.clone());
                    }
                }
                garment_ids.sort();
                alternatives.sort();
                ExposureOption { option_id: o.option_id.clone(), garment_ids, alternative_groups: if alternatives.is_empty() { Vec::new() } else { vec![alternatives] } }
            })
            .collect();
        options.sort_by(|a, c| a.option_id.cmp(&c.option_id));
        let items: Vec<&String> = options.iter().flat_map(|o| o.garment_ids.iter().chain(o.alternative_groups.iter().flatten())).collect();
        let resolved = ledger.wears.iter().any(|w| w.active && w.wearing_date == b.local_date && items.contains(&&w.garment_id));
        if resolved {
            continue;
        }
        let selected = b.selected_option_id.as_ref().and_then(|id| rev.offered.iter().find(|o| &o.option_id == id));
        let chosen = match (selected, &b.selected_footwear_id) {
            (Some(o), Some(f)) if !o.footwear_alternatives.is_empty() => vec![f.clone()],
            _ => Vec::new(),
        };
        let set = ExposureSet {
            exposure_id: format!("{}:r{}", b.board_id, rev.revision),
            local_date: b.local_date.clone(),
            p_use: None,
            selected_option_id: selected.map(|o| o.option_id.clone()),
            chosen_alternatives: chosen,
            options,
        };
        sets.push((b.local_date.clone(), set.exposure_id.clone(), set));
    }
    // `ORDER BY local_date, exposure_id`.
    sets.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
    sets.into_iter().map(|(_, _, s)| s).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(id: &str, date: &str, options: &[(&str, &[&str], &[&str])], selected: Option<&str>, chosen: &[&str]) -> ExposureSet {
        ExposureSet {
            exposure_id: id.into(),
            local_date: date.into(),
            p_use: None,
            selected_option_id: selected.map(str::to_string),
            chosen_alternatives: chosen.iter().map(|s| s.to_string()).collect(),
            options: options
                .iter()
                .map(|(o, ids, alts)| ExposureOption {
                    option_id: o.to_string(),
                    garment_ids: ids.iter().map(|s| s.to_string()).collect(),
                    alternative_groups: if alts.is_empty() { Vec::new() } else { vec![alts.iter().map(|s| s.to_string()).collect()] },
                })
                .collect(),
        }
    }

    /// The estimator's own model: options of one set are exclusive and summed, alternatives share their
    /// option's probability, and a selection moves the mass to the chosen option.
    #[test]
    fn options_are_summed_and_alternatives_share_their_option() {
        let s = set("e1", "2026-10-01", &[("a", &["top", "chino"], &["nb", "reims"]), ("b", &["top2", "chino"], &[])], None, &[]);
        assert_eq!(selection_probability(&s, "chino", &PARAMS), 0.85, "in both options: 0.425 + 0.425, never charged twice");
        assert_eq!(selection_probability(&s, "top", &PARAMS), 0.425);
        assert_eq!(selection_probability(&s, "nb", &PARAMS), 0.2125);
        let chosen = set("e1", "2026-10-01", &[("a", &["top", "chino"], &["nb", "reims"]), ("b", &["top2", "chino"], &[])], Some("a"), &["nb"]);
        assert_eq!(selection_probability(&chosen, "nb", &PARAMS), 0.9);
        assert_eq!(selection_probability(&chosen, "reims", &PARAMS), 0.0);
        assert_eq!(selection_probability(&chosen, "top2", &PARAMS), 0.0);
        // Two sets on one day combine as independent chances of one wear, not two.
        let other = set("e2", "2026-10-01", &[("c", &["chino"], &[])], None, &[]);
        let by_date = inferred_wear_by_date("chino", &[s, other], &PARAMS, None);
        assert_eq!(by_date.len(), 1);
        assert!((by_date[0].1 - (1.0 - 0.15 * 0.15)).abs() < 1e-12);
    }
}
