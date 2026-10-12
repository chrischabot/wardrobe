//! Recommendations (`garderobe_recommend`, `POST /v1/recommendations` in preview mode): validated
//! outfit options for a day, composed by the deterministic composer of packages/daily/src/compose.ts
//! and checked by the same validator as a published board (`crate::board::validate`). Nothing is
//! published and nothing is logged as worn.
//!
//! A recommendation is a durable run, as in apps/worker/src/routes/daily.ts: the run is keyed by the
//! connection and its client request ID, so a retransmission returns the recorded result and a
//! different request under the same ID is refused.
//!
//! What this port leaves out, and why (README.md, "Recommendations"):
//! - no composition model is connected, so the deterministic composer (the specification's tested
//!   fallback) composes every option and a brief's words are not read; the note says so;
//! - no forecast or Calendar: temperatures are unknown (the composer's season fit is the same for
//!   every piece, the jacket band cannot be ruled out, no scarf day), and no option suits an event;
//! - the probabilistic availability estimator is not ported: a piece with a clean unit at home is
//!   available, one without is not offered;
//! - no comfort feedback, no coming week's selections and no recently shown combinations rank pieces;
//! - the seed of the reproducible tie-breaks names the one owner of this app (`OWNER_SEED`) where the
//!   TypeScript build uses the owner's user ID, so the same day ranks differently there.

use std::collections::{BTreeMap, BTreeSet};

use ferrite_app::serde_json::{json, Map, Value};

use crate::api::{read_ledger, Store};
use crate::board::{self, factual_reason, garment_violations, neutral_families, role_accepts, slot_of, validate, Day, Slot, Validation, COOL, NEUTRAL, SATURATED, WARM};
use crate::canonical::canonical;
use crate::ledger::CmdError;
use crate::seed::{catalogue, Catalogue, Garment};
use crate::sha256::hex_digest;
use crate::time::{instant, parse_instant, parse_local_date};

/// The owner part of every seeded tie-break (`ctx.userId` in compose.ts).
pub const OWNER_SEED: &str = "owner";
/// `NUMBER_WORDS` in compose.ts.
const NUMBER_WORDS: [&str; 9] = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];
/// `LINE_ORDER` in packages/daily/src/service.ts.
const LINE_ORDER: [&str; 9] = ["outer", "mid_layer", "top", "one_piece", "bottom", "belt", "socks", "footwear", "accessory"];
const BRIEF_NOT_READ: &str = "The brief was not read: no composition model is connected to this server, so these options come from the deterministic composer.";

/// `seededUnit`: a deterministic 32-bit hash of the parts, in [0, 1), for reproducible tie-breaking.
pub fn seeded_unit(parts: &[&str]) -> f64 {
    let mut h: u32 = 2_166_136_261;
    for ch in parts.join("\u{1f}").chars() {
        h ^= ch as u32;
        h = h.wrapping_mul(16_777_619);
    }
    h ^= h >> 15;
    h = h.wrapping_mul(2_246_822_507);
    h ^= h >> 13;
    f64::from(h % 100_000) / 100_000.0
}

/// JavaScript truthiness of an attribute value.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().map_or(false, |x| x != 0.0),
        Some(_) => true,
    }
}

/// One garment as the composer weighs it (`PoolGarment`).
struct Pg<'a> {
    g: &'a Garment,
    /// `colourFamily(colour || name)`.
    family: &'static str,
    neutrals: Vec<&'static str>,
    /// `rotation`: twice the chance a clean unit is at home, less one when worn inside the fortnight.
    rotation: f64,
    clean: u32,
}

impl Pg<'_> {
    fn id(&self) -> &str {
        &self.g.id
    }
}

/// `seasonFit` with an unknown temperature: no garment in the seed carries season words, so every
/// piece is "all-season" (0.5).
const SEASON_FIT: f64 = 0.5;

#[derive(Default)]
struct Usage {
    footwear: BTreeMap<String, u32>,
    outers: BTreeMap<String, u32>,
    socks: BTreeMap<String, u32>,
    index: usize,
}

fn used(m: &BTreeMap<String, u32>, id: &str) -> f64 {
    f64::from(m.get(id).copied().unwrap_or(0))
}

struct Pools<'a> {
    tops: Vec<&'a Pg<'a>>,
    bottoms: Vec<&'a Pg<'a>>,
    outers: Vec<&'a Pg<'a>>,
    footwear: Vec<&'a Pg<'a>>,
    socks: Vec<&'a Pg<'a>>,
    belts: Vec<&'a Pg<'a>>,
    neckwear: Vec<&'a Pg<'a>>,
}

/// One composed option with the validation it passed.
pub struct Composed {
    pub slots: Vec<Slot>,
    pub alternatives: Vec<String>,
    pub reason: String,
    pub validation: Validation,
}

pub struct Composition {
    pub options: Vec<Composed>,
    pub reserves: Vec<Composed>,
    pub requested: usize,
    pub notice: Option<String>,
    pub pairs_considered: usize,
}

struct Composer<'a> {
    date: &'a str,
    neutral_max: Option<usize>,
    jacket_fabric: Option<String>,
    sock_class: Option<String>,
}

/// `pick`: the first garment with the highest score.
fn pick<'a>(list: &[&'a Pg<'a>], score: impl Fn(&Pg<'_>) -> f64) -> Option<&'a Pg<'a>> {
    let mut best = None;
    let mut best_score = f64::NEG_INFINITY;
    for g in list {
        let s = score(g);
        if s > best_score {
            best = Some(*g);
            best_score = s;
        }
    }
    best
}

impl<'a> Composer<'a> {
    /// `exceedsNeutralLimit`: adding `g` to the settled pieces takes one of its neutrals over the limit.
    fn exceeds(&self, g: &Pg<'_>, settled: &[Option<&Pg<'_>>]) -> bool {
        let Some(max) = self.neutral_max else { return false };
        let mut seen: BTreeSet<&str> = BTreeSet::from([g.id()]);
        let mut others: Vec<&Vec<&'static str>> = Vec::new();
        for s in settled.iter().flatten() {
            if seen.insert(s.id()) {
                others.push(&s.neutrals);
            }
        }
        g.neutrals.iter().any(|f| others.iter().filter(|o| o.contains(f)).count() + 1 > max)
    }

    /// `withinNeutralLimit`: the pieces that keep the limit, or the whole pool when none does.
    fn within(&self, pool: &[&'a Pg<'a>], settled: &[Option<&Pg<'_>>]) -> Vec<&'a Pg<'a>> {
        let kept: Vec<&'a Pg<'a>> = pool.iter().copied().filter(|g| !self.exceeds(g, settled)).collect();
        if kept.is_empty() { pool.to_vec() } else { kept }
    }

    fn seeded(&self, seed: &str, id: &str) -> f64 {
        seeded_unit(&[seed, id])
    }

    /// `chooseOuter` with an unknown outdoor temperature.
    fn choose_outer(&self, pools: &Pools<'a>, top: &Pg<'_>, bottom: &Pg<'_>, usage: &Usage, seed: &str) -> Option<&'a Pg<'a>> {
        // The 14-16 C band cannot be ruled out without a forecast: a jacket goes over the required shirt only.
        if let Some(required) = &self.jacket_fabric {
            if top.g.attr_str("fabricClass") != required {
                return None;
            }
        }
        let (shoes, socks) = (&pools.footwear, &pools.socks);
        let within = self.within(&pools.outers, &[Some(top), Some(bottom)]);
        let leaves_shoe: Vec<&'a Pg<'a>> = if shoes.is_empty() { within.clone() } else { within.iter().copied().filter(|o| shoes.iter().any(|f| !self.exceeds(f, &[Some(o), Some(top), Some(bottom)]))).collect() };
        let leaves_both: Vec<&'a Pg<'a>> = if socks.is_empty() {
            leaves_shoe.clone()
        } else {
            leaves_shoe
                .iter()
                .copied()
                .filter(|o| {
                    let base = [Some(*o), Some(top), Some(bottom)];
                    let choices: Vec<Option<&Pg<'_>>> = if shoes.is_empty() { vec![None] } else { shoes.iter().filter(|f| !self.exceeds(f, &base)).map(|f| Some(*f)).collect() };
                    choices.iter().any(|f| socks.iter().any(|s| !self.exceeds(s, &[Some(*o), Some(top), Some(bottom), *f])))
                })
                .collect()
        };
        let list = if !leaves_both.is_empty() { leaves_both } else if !leaves_shoe.is_empty() { leaves_shoe } else { within };
        pick(&list, |g| {
            let mut s = SEASON_FIT * 1.5 + g.rotation - used(&usage.outers, g.id()) * 2.5 + self.seeded(seed, g.id()) * 0.6;
            if g.family == bottom.family {
                s -= 0.6;
            }
            if truthy(g.g.attributes.get("fitNote")) {
                s -= 0.5;
            }
            s
        })
    }

    /// `buildOutfit` around a top and a bottom (no locked pieces, no occasion, no paired-shoe format).
    fn build(&self, pools: &Pools<'a>, top: &'a Pg<'a>, bottom: &'a Pg<'a>, usage: &Usage) -> Option<(Vec<Slot>, Vec<String>)> {
        let seed = format!("{OWNER_SEED}|{}|{}|{}", self.date, top.id(), bottom.id());
        let slot = |role: &str, g: &Pg<'_>| Slot { role: role.into(), garment_id: g.id().into() };
        let mut slots = Vec::new();
        // `jacketWanted` with an unknown start: some options carry a layer that can come off.
        let outer = if usage.index % 2 == 0 { self.choose_outer(pools, top, bottom, usage, &seed) } else { None };
        if let Some(o) = outer {
            slots.push(slot("outer", o));
        }
        slots.push(slot("top", top));
        slots.push(slot("bottom", bottom));
        let mut upper: Vec<&str> = vec![top.family];
        if let Some(o) = outer {
            upper.push(o.family);
        }
        // The belt line's flourish: no scarf without a cold start; a tie whenever the top is a shirt.
        let ties: Vec<&'a Pg<'a>> = pools.neckwear.iter().copied().filter(|g| g.g.category != "scarf" && top.g.category == "shirt" && g.g.category == "tie").collect();
        let flourish = pick(&ties, |g| SEASON_FIT + if g.family != top.family { 0.5 } else { 0.0 } + if outer.map_or(false, |o| g.family == o.family) { -0.3 } else { 0.0 } + self.seeded(&seed, g.id()) * 0.5);
        let takes_sock_echo = |g: &Pg<'_>| NEUTRAL.contains(&g.family) && upper.contains(&g.family);
        let footwear_score = |g: &Pg<'_>| {
            g.rotation - used(&usage.footwear, g.id()) * 1.5 + if takes_sock_echo(g) { -0.6 } else if upper.contains(&g.family) { 0.8 } else { 0.0 } - if g.family == bottom.family { 0.3 } else { 0.0 }
                + if truthy(g.g.attributes.get("breakingIn")) { -0.5 } else { 0.0 }
                + self.seeded(&seed, g.id()) * 0.6
        };
        let worn: [Option<&Pg<'_>>; 3] = [outer, Some(top), Some(bottom)];
        let with = |extra: &[Option<&'a Pg<'a>>]| -> Vec<Option<&Pg<'_>>> { worn.iter().copied().chain(extra.iter().map(|x| x.map(|g| g as &Pg<'_>))).collect() };
        let leaves_sock_echo = |shoe: &'a Pg<'a>| {
            pools.socks.iter().any(|s| {
                self.sock_class.as_deref().map_or(true, |c| s.g.attr_str("fabricClass") == c) && s.family != "unknown" && upper.contains(&s.family) && s.family != bottom.family && !self.exceeds(s, &with(&[Some(shoe)]))
            })
        };
        let shoes = self.within(&pools.footwear, &worn);
        let leaving: Vec<&'a Pg<'a>> = shoes.iter().copied().filter(|shoe| pools.socks.iter().any(|s| !self.exceeds(s, &with(&[Some(*shoe)])))).collect();
        let base = if leaving.is_empty() { shoes } else { leaving };
        let kept: Vec<&'a Pg<'a>> = base.iter().copied().filter(|s| leaves_sock_echo(s)).collect();
        let footwear = pick(if kept.is_empty() { &base } else { &kept }, footwear_score)?;
        // The sock as the quiet rhyme or the single flash: echo a colour from higher up, not the trouser.
        let calm = !SATURATED.contains(&top.family) && !outer.map_or(false, |o| SATURATED.contains(&o.family));
        let sock_pool = self.within(&pools.socks, &with(&[Some(footwear)]));
        let socks = pick(&sock_pool, |g| {
            let mut s = 2.0 + SEASON_FIT - used(&usage.socks, g.id()) * if g.clean > 1 { 0.4 } else { 1.5 } + self.seeded(&seed, g.id()) * 0.5;
            if self.sock_class.as_deref().map_or(false, |c| g.g.attr_str("fabricClass") == c) {
                s += 2.0;
            }
            if upper.contains(&g.family) && g.family != bottom.family {
                s += 2.0;
            }
            if g.family == bottom.family {
                s -= 1.0;
            }
            if calm && SATURATED.contains(&g.family) {
                s += 0.9;
            }
            s
        })?;
        let belt_pool = self.within(&pools.belts, &with(&[Some(footwear), Some(socks)]));
        let belt = pick(&belt_pool, |g| {
            (if g.family == "brown" { 0.5 } else { 0.0 }) + (if upper.contains(&g.family) { 0.8 } else { 0.0 }) + (if g.family == "black" && (bottom.family == "grey" || bottom.family == "black") { 1.2 } else { 0.0 })
                + self.seeded(&seed, g.id()) * 0.2
        });
        if let Some(b) = belt {
            slots.push(slot("belt", b));
        }
        if let Some(f) = flourish {
            slots.push(slot("neckwear", f));
        }
        slots.push(slot("socks", socks));
        slots.push(slot("footwear", footwear));
        Some((slots, Vec::new()))
    }
}

/// `pairScore` (no recently shown combinations are read in this port).
fn pair_score(top: &Pg<'_>, bottom: &Pg<'_>) -> f64 {
    let (a, b) = (top.family, bottom.family);
    let mut score = 0.0;
    if a == b && NEUTRAL.contains(&a) {
        score -= 1.2;
    } else if a == b {
        score += 0.4;
    }
    if (WARM.contains(&a) && COOL.contains(&b)) || (COOL.contains(&a) && WARM.contains(&b)) {
        score += 1.4;
    }
    if SATURATED.contains(&a) && NEUTRAL.contains(&b) {
        score += 1.1;
    }
    if SATURATED.contains(&a) && SATURATED.contains(&b) && a != b {
        score -= 1.6;
    }
    score
}

fn key_of(slots: &[Slot]) -> String {
    let mut k: Vec<String> = slots.iter().map(|s| format!("{}:{}", s.role, s.garment_id)).collect();
    k.sort();
    k.join("|")
}

/// `composeBoard`'s deterministic part for `day` (which must carry its date): `requested` options and
/// up to `reserve_count` reserves, every one validated, never the same shirt twice.
pub fn compose(day: &Day<'_>, local_date: &str, requested: usize, reserve_count: usize) -> Composition {
    let cat: &Catalogue = day.cat;
    let date = parse_local_date(local_date);
    let fortnight = cat.active_rule("variety.nothing_repeats_inside_a_fortnight").and_then(|r| r.params["days"].as_i64()).unwrap_or(14);
    let horizon = cat.active_rule("variety.repeat_horizon").and_then(|r| r.params["days"].as_i64()).unwrap_or(7);
    let pool: Vec<Pg<'_>> = cat
        .garments
        .iter()
        .map(|g| {
            let clean = day.stock.of(&g.id).clean;
            // Counted wears in [date - max(fortnight, horizon), date], the board date included.
            let worn = date.map_or(false, |d| day.last_worn(&g.id, d - fortnight.max(horizon), d + 1).is_some());
            let text = g.colour.as_deref().filter(|c| !c.is_empty()).unwrap_or(&g.name);
            Pg { g, family: board::colour_family(Some(text)), neutrals: neutral_families(text), rotation: if clean > 0 { 2.0 } else { 0.0 } - if worn { 1.0 } else { 0.0 }, clean }
        })
        .collect();
    let mut sorted: Vec<&Pg<'_>> = pool.iter().collect();
    sorted.sort_by(|a, b| a.id().cmp(b.id()));
    let eligible = |role: &str| -> Vec<&Pg<'_>> { sorted.iter().copied().filter(|p| role_accepts(p.g, role) && garment_violations(day, p.id(), role, &[]).iter().all(|v| !v.blocking)).collect() };
    let pools = Pools {
        tops: eligible("top"),
        bottoms: eligible("bottom"),
        outers: eligible("outer"),
        footwear: eligible("footwear"),
        socks: eligible("socks"),
        belts: eligible("belt"),
        neckwear: eligible("neckwear"),
    };
    let composer = Composer {
        date: local_date,
        neutral_max: cat.active_rule("colour.no_neutral_three_times").and_then(|r| r.params["maxSameNeutralPerOutfit"].as_u64()).map(|n| n as usize),
        jacket_fabric: cat.active_rule("thermal.jacket_14_16_lightweight_oxford_only").and_then(|r| r.params["requiredShirtFabricClass"].as_str()).map(str::to_string),
        sock_class: cat.active_rule("socks.required").and_then(|r| r.params["defaultFabricClass"].as_str()).map(str::to_string),
    };
    let mut pairs: Vec<(&Pg<'_>, &Pg<'_>, f64)> = Vec::new();
    for top in &pools.tops {
        let top_score = top.rotation + SEASON_FIT * 1.5;
        for bottom in &pools.bottoms {
            let score = top_score + bottom.rotation + SEASON_FIT * 1.5 + pair_score(top, bottom) + seeded_unit(&[OWNER_SEED, local_date, top.id(), bottom.id()]) * 1.2;
            pairs.push((top, bottom, score));
        }
    }
    pairs.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.0.id().cmp(b.0.id())).then_with(|| a.1.id().cmp(b.1.id())));

    let mut chosen: Vec<Composed> = Vec::new();
    let mut usage = Usage::default();
    let mut used_tops: BTreeSet<String> = BTreeSet::new();
    let mut used_bottoms: BTreeSet<String> = BTreeSet::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let total = requested + reserve_count;
    let mut fill = |target: usize, distinct: bool, chosen: &mut Vec<Composed>| {
        for (top, bottom, _) in &pairs {
            if chosen.len() >= target {
                return;
            }
            if used_tops.contains(top.id()) || (distinct && used_bottoms.contains(bottom.id())) {
                continue;
            }
            let Some((mut slots, alternatives)) = composer.build(&pools, top, bottom, &usage) else { continue };
            let key = key_of(&slots);
            if seen.contains(&key) {
                continue;
            }
            let mut validation = validate(day, &slots, &alternatives, &[]);
            if !validation.valid() && slots.iter().any(|s| s.role == "outer") {
                // A layer that does not survive the combination check is dropped rather than the outfit.
                slots.retain(|s| s.role != "outer");
                validation = validate(day, &slots, &alternatives, &[]);
            }
            if !validation.valid() {
                continue;
            }
            seen.insert(key);
            for (m, role) in [(&mut usage.footwear, "footwear"), (&mut usage.outers, "outer"), (&mut usage.socks, "socks")] {
                if let Some(id) = slot_of(&slots, role) {
                    *m.entry(id.to_string()).or_default() += 1;
                }
            }
            used_tops.insert(top.id().to_string());
            used_bottoms.insert(bottom.id().to_string());
            usage.index += 1;
            chosen.push(Composed { reason: factual_reason(cat, &slots), slots, alternatives, validation });
        }
    };
    for distinct in [true, false] {
        fill(requested, distinct, &mut chosen);
    }
    for distinct in [true, false] {
        fill(total, distinct, &mut chosen);
    }
    let reserves = chosen.split_off(requested.min(chosen.len()));
    let options = chosen;
    let notice = (options.len() < requested).then(|| {
        let counts = [("shirts", pools.tops.len()), ("trousers", pools.bottoms.len()), ("pairs of shoes", pools.footwear.len()), ("pairs of socks", pools.socks.len())];
        let word = if options.len() == 1 { "outfit" } else { "outfits" };
        let count = NUMBER_WORDS.get(options.len()).map_or_else(|| options.len().to_string(), |w| w.to_string());
        if options.is_empty() {
            match counts.iter().find(|c| c.1 == 0) {
                Some((what, n)) => format!("No complete outfit is available for this day: {n} eligible {what}."),
                None => "No complete outfit is available for this day: no eligible combination passes every rule.".to_string(),
            }
        } else if pools.tops.len() <= options.len() {
            format!("{count} valid {word} today instead of {requested}: only {} eligible shirts.", pools.tops.len())
        } else {
            format!("{count} valid {word} today instead of {requested}: no further combination of eligible pieces passes every rule.")
        }
    });
    Composition { options, reserves, requested, notice, pairs_considered: pairs.len() }
}

/// `previewOptions`: composed options as `BoardOption`s, numbered, never published.
pub fn preview_options(cat: &Catalogue, options: &[Composed]) -> Vec<Value> {
    options
        .iter()
        .enumerate()
        .map(|(i, o)| {
            let top = slot_of(&o.slots, "top").or_else(|| slot_of(&o.slots, "one_piece"));
            let name = [top, slot_of(&o.slots, "bottom")].into_iter().flatten().map(|id| cat.get(id).map_or("", |g| g.name.as_str())).collect::<Vec<_>>().join(" with ");
            let mut lines: Vec<&Slot> = o.slots.iter().filter(|s| s.role != "neckwear").collect();
            // `indexOf` is -1 for a role outside the order, which sorts first; the sort is stable.
            lines.sort_by_key(|s| LINE_ORDER.iter().position(|r| *r == s.role).map_or(-1, |p| p as i64));
            json!({
                "optionId": format!("preview-{}", i + 1),
                "number": i + 1,
                "name": name,
                "reason": o.reason,
                "garments": lines.iter().map(|s| board::line(cat, &s.role, &s.garment_id)).collect::<Vec<_>>(),
                "footwearAlternatives": o.alternatives.iter().map(|id| board::line(cat, "footwear", id)).collect::<Vec<_>>(),
                "flourish": slot_of(&o.slots, "neckwear").map(|id| board::line(cat, "neckwear", id)),
                "suitsEventIds": [],
                // A repeat is stated only when the owner named a piece; no request here can.
                "qualification": null,
                "changedInRevision": false,
            })
        })
        .collect()
}

// ───────────────────────────── the request and its run ─────────────────────────────

/// A parsed `McpRecommendInput` / `RecommendRequest` in preview mode.
#[derive(Debug, Clone, PartialEq)]
pub struct RecommendInput {
    pub client_request_id: String,
    pub date: String,
    pub brief: Option<String>,
    pub count: Option<u64>,
}

fn invalid(message: impl Into<String>) -> CmdError {
    CmdError::new("invalid_command", message)
}

/// Parse the tool's arguments (`McpRecommendInput`, strict).
pub fn parse_input(args: &Map<String, Value>) -> Result<RecommendInput, CmdError> {
    if let Some(k) = args.keys().find(|k| !["brief", "date", "count", "clientRequestId"].contains(&k.as_str())) {
        return Err(invalid(format!("'{k}' is not an argument this server takes for this tool")));
    }
    let client_request_id = match args.get("clientRequestId") {
        Some(Value::String(s)) if (8..=128).contains(&s.chars().count()) => s.clone(),
        _ => return Err(invalid("clientRequestId: expected a stable request ID of 8 to 128 characters")),
    };
    let date = match args.get("date") {
        Some(Value::String(d)) if parse_local_date(d).is_some() => d.clone(),
        None => return Err(invalid("date: this server has no owner timezone yet, so the day must be named (YYYY-MM-DD)")),
        Some(_) => return Err(invalid("date: expected a date (YYYY-MM-DD)")),
    };
    let brief = match args.get("brief") {
        None => None,
        Some(Value::String(b)) if b.encode_utf16().count() <= 2000 => Some(b.clone()),
        Some(_) => return Err(invalid("brief: expected a string of at most 2000 characters")),
    };
    let count = match args.get("count") {
        None => None,
        Some(v) => match crate::canonical::whole(v) {
            Some(n) if (1..=8).contains(&n) => Some(n),
            _ => return Err(invalid("count: expected a whole number from 1 to 8")),
        },
    };
    Ok(RecommendInput { client_request_id, date, brief, count })
}

fn run_key(run_id: &str) -> Vec<u8> {
    format!("u/{run_id}").into_bytes()
}

/// The run of one client request on one connection: its ID is derived from both, so a
/// retransmission finds it without an index.
pub fn run_id_for(kind: &str, connection: &str, client_request_id: &str) -> String {
    let h = hex_digest(format!("{kind}\u{1f}{connection}\u{1f}{client_request_id}").as_bytes());
    format!("run_{}", &h[..24])
}

fn request_hash(input: &RecommendInput) -> String {
    hex_digest(canonical(&json!({"date": input.date, "brief": input.brief, "count": input.count})).as_bytes())
}

/// The default number of options (`board.daily_entry_format` defaultOptionCount, else 5).
fn default_count(cat: &Catalogue) -> u64 {
    cat.active_rule("board.daily_entry_format").and_then(|r| r.params["defaultOptionCount"].as_u64()).filter(|n| (1..=8).contains(n)).unwrap_or(5)
}

/// Whether a saved run's `result` is a whole recommendation answer: every field present (a missing
/// field is not read as null) and of its type, the date and read time parseable, and every option
/// shaped as `preview_options` writes it, naming garments of the catalogue.
fn stored_answer_ok(r: &Value) -> bool {
    let Some(m) = r.as_object() else { return false };
    let has = |k: &str| m.contains_key(k);
    const RESULT_FIELDS: [&str; 7] = ["localDate", "options", "board", "insufficient", "note", "wardrobeRevision", "readAt"];
    if m.len() != RESULT_FIELDS.len() || !RESULT_FIELDS.iter().all(|k| has(k)) {
        return false;
    }
    // A line is exactly what `board::line` writes for its role and garment (the catalogue is static).
    let line_ok = |l: &Value| match (l["role"].as_str(), l["garmentId"].as_str()) {
        (Some(role), Some(id)) => catalogue().get(id).is_some() && *l == board::line(catalogue(), role, id),
        _ => false,
    };
    let option_ok = |o: &Value| {
        let Some(om) = o.as_object() else { return false };
        const OPTION_FIELDS: [&str; 10] = ["optionId", "number", "name", "reason", "garments", "footwearAlternatives", "flourish", "suitsEventIds", "qualification", "changedInRevision"];
        // Exactly the composer's fields: a field it never writes is not returned as part of an answer.
        om.len() == OPTION_FIELDS.len() && OPTION_FIELDS.iter().all(|k| om.contains_key(*k))
            && o["optionId"].is_string()
            && o["number"].is_u64()
            && o["name"].is_string()
            && o["reason"].is_string()
            && o["garments"].as_array().map_or(false, |g| !g.is_empty() && g.iter().all(line_ok))
            && o["footwearAlternatives"].as_array().map_or(false, |g| g.iter().all(line_ok))
            && (o["flourish"].is_null() || line_ok(&o["flourish"]))
            // A preview option suits no calendar event and states no repeat (`preview_options`).
            && o["suitsEventIds"] == json!([])
            && o["qualification"].is_null()
            && o["changedInRevision"] == false
    };
    r["localDate"].as_str().map_or(false, |d| parse_local_date(d).is_some())
        && r["options"].as_array().map_or(false, |a| a.len() <= 8 && a.iter().all(option_ok))
        && r["board"].is_null()
        && r["insufficient"].is_boolean()
        && (r["note"].is_null() || r["note"].is_string())
        && r["wardrobeRevision"].is_u64()
        && r["readAt"].as_str().map_or(false, |t| parse_instant(t).is_some())
}

/// `runRecommendation` in preview mode for a connection (`connection` names the grant): composes,
/// records the run, and answers the `RecommendResponse`. A repeat of the request ID answers from
/// the run (with its `runId`); the same ID for a different request is refused. A repeat answers
/// with the `wardrobeRevision` and `readAt` the options were composed from, never the current
/// ledger's, so an earlier recommendation does not present itself as reflecting later reports.
pub async fn recommend<S: Store>(store: &mut S, connection: &str, now_ms: u64, input: &RecommendInput) -> Result<Value, CmdError> {
    let run_id = run_id_for("recommendation", connection, &input.client_request_id);
    let key = run_key(&run_id);
    let hash = request_hash(input);
    let respond = |run: &Value, run_id: Option<&str>| -> Result<Value, CmdError> {
        let ok = run["kind"] == "recommendation" && run["connection"] == connection && run["clientRequestId"] == input.client_request_id.as_str();
        if !ok {
            return Err(CmdError::with("internal", "the stored recommendation run is not this request's; nothing was read", json!({"retryable": false})));
        }
        if run["requestHash"] != hash.as_str() {
            return Err(CmdError::with("idempotency_key_reuse", "that request ID was already used for a different request", json!({"runId": run["runId"]})));
        }
        let r = &run["result"];
        if run["state"] != "completed" || !stored_answer_ok(r) {
            return Err(CmdError::with("internal", "the stored recommendation run is incomplete; ask again with a new request ID", json!({"retryable": false})));
        }
        Ok(json!({
            "state": "completed", "runId": run_id, "localDate": r["localDate"], "options": r["options"], "board": null,
            "insufficient": r["insufficient"], "note": r["note"], "wardrobeRevision": r["wardrobeRevision"], "readAt": r["readAt"],
        }))
    };
    let stored = store.get(&key).await.map_err(|_| CmdError::with("internal", "the recommendation run could not be read just now; try again", json!({"retryable": true})))?;
    if let Some(bytes) = stored {
        let run: Value = ferrite_app::serde_json::from_slice(&bytes).map_err(|_| CmdError::with("internal", "the stored recommendation run is unreadable", json!({"retryable": false})))?;
        return respond(&run, Some(&run_id));
    }
    // Only a new composition needs the wardrobe as it stands.
    let (_, ledger) = read_ledger(store).await?;
    let cat = catalogue();
    let day = Day::of(cat, &ledger, &input.date);
    let requested = input.count.unwrap_or_else(|| default_count(cat)) as usize;
    // Preview mode keeps no reserves (service.ts).
    let composed = compose(&day, &input.date, requested, 0);
    let options = preview_options(cat, &composed.options);
    let mut notes: Vec<String> = composed.notice.iter().cloned().collect();
    if input.brief.as_deref().map_or(false, |b| !b.trim().is_empty()) {
        notes.push(BRIEF_NOT_READ.to_string());
    }
    let note = (!notes.is_empty()).then(|| notes.join(" "));
    let at = instant(now_ms);
    let result = json!({
        "localDate": input.date, "options": options, "board": null, "insufficient": composed.options.len() < requested, "note": note,
        "wardrobeRevision": ledger.revision, "readAt": at,
    });
    let run = json!({
        "v": 1, "runId": run_id, "kind": "recommendation", "state": "completed", "createdAt": at, "updatedAt": at,
        "activity": null, "lastEventId": 2, "connection": connection, "clientRequestId": input.client_request_id,
        "requestHash": hash, "result": result, "error": null,
    });
    let bytes = ferrite_app::serde_json::to_vec(&run).map_err(|_| CmdError::with("internal", "the recommendation could not be recorded", json!({"retryable": true})))?;
    match store.commit_n_if(&key, None, &[(&key, &bytes)]).await {
        // Finished inside the request: the run records the result, and the answer names no run.
        Ok(Ok(())) => respond(&run, None),
        // The same request arrived concurrently and its run was recorded first: answer from it.
        Ok(Err(Some(current))) => {
            let earlier: Value = ferrite_app::serde_json::from_slice(&current).map_err(|_| CmdError::with("internal", "the stored recommendation run is unreadable", json!({"retryable": false})))?;
            respond(&earlier, Some(&run_id))
        }
        Ok(Err(None)) | Err(_) => Err(CmdError::with("internal", "the recommendation could not be saved; ask again with a new request ID", json!({"runId": run_id, "retryable": true}))),
    }
}

/// The tool's one-line summary (apps/worker/src/mcp/server.ts).
pub fn summary(response: &Value) -> String {
    let date = response["localDate"].as_str().unwrap_or("");
    let note = response["note"].as_str();
    let names: Vec<&str> = response["options"].as_array().map(|a| a.iter().filter_map(|o| o["name"].as_str()).collect()).unwrap_or_default();
    if names.is_empty() {
        format!("No valid option for {date}. {}", note.unwrap_or("")).trim_end().to_string()
    } else {
        format!("{} validated option(s) for {date}: {}{}", names.len(), names.join("; "), note.map_or(String::new(), |n| format!(". {n}")))
    }
}
