//! Naming and selecting garments, ported from packages/domain/src/queries.ts (`resolveAlias`) and
//! handlers/selection.ts (`selectGarments`, `previewGarmentSelection`): `GET /v1/wardrobe/resolve`,
//! `POST /v1/wardrobe/selection` and the `resolve` and `selection` views of `garderobe_inventory`.
//! Both only read.
//!
//! The aliases are the ones `garment.create` records for the import (the garment's name, then the
//! importer's phrases), generated into the seed with their normalized form by the importer's own
//! `normalizePhrase`. No command in this port renames a garment or adds an alias, so the seed is the
//! whole alias table. Only the phrase a caller sends is normalized here ([`normalize_phrase`]).

use ferrite_app::serde_json::{json, Map, Value};

use crate::fold_table::FOLD;
use crate::ledger::{CmdError, Ledger};
use crate::seed::{Catalogue, Garment};

/// `Category` in packages/contracts/src/garment.ts.
pub const CATEGORIES: &[&str] = &["shirt", "knitwear", "tee", "trousers", "outerwear", "footwear", "socks", "belt", "tie", "scarf", "pocket_square", "accessory", "one_piece", "other"];
const CARE_CHANNELS: &[&str] = &["service", "handwash", "none"];
const PLANNING_POLICIES: &[&str] = &["normal", "occasional", "excluded"];
/// `GarmentSelector.acquisition`: a disposed garment is never selected.
const SELECTABLE_ACQUISITIONS: &[&str] = &["incoming", "owned"];
/// `ResolveQuery.phrase` bound.
pub const MAX_PHRASE: usize = 200;

/// What one non-ASCII character becomes under `normalizePhrase`, from the generated [`FOLD`] table.
enum Folded {
    /// Its folded text: ASCII letters, digits and `+`, spaces for separators; empty when dropped.
    Text(&'static str),
    /// One ASCII character of an advancing run.
    Char(u8),
    /// A separator (anything the table does not list).
    Separator,
}

fn fold(c: char) -> Folded {
    let cp = c as u32;
    let i = FOLD.partition_point(|r| r.0 <= cp);
    let Some(&(first, last, step, text)) = i.checked_sub(1).map(|i| &FOLD[i]) else { return Folded::Separator };
    if cp > last {
        Folded::Separator
    } else if step == 0 {
        Folded::Text(text)
    } else {
        Folded::Char(text.as_bytes()[0] + (cp - first) as u8)
    }
}

/// `normalizePhrase` (packages/domain/src/util.ts): NFKD, the combining marks U+0300 to U+036F dropped,
/// lowercase, every run of anything but `a-z`, `0-9` and `+` one space, trimmed. Each non-ASCII code
/// point's result comes from `src/fold_table.rs`, generated from Node's own NFKD and lowercasing by
/// `scripts/build-fold-table.mjs`; tests/wardrobe_reads.rs checks the whole function against
/// `normalizePhrase` itself on every code point of the table and on random phrases.
pub fn normalize_phrase(phrase: &str) -> String {
    let mut out = String::with_capacity(phrase.len());
    let mut gap = false;
    let keep = |b: u8, out: &mut String, gap: &mut bool| {
        if *gap && !out.is_empty() {
            out.push(' ');
        }
        *gap = false;
        out.push(b as char);
    };
    for c in phrase.chars() {
        if c.is_ascii() {
            let l = c.to_ascii_lowercase();
            if l.is_ascii_lowercase() || l.is_ascii_digit() || l == '+' {
                keep(l as u8, &mut out, &mut gap);
            } else {
                gap = true;
            }
            continue;
        }
        match fold(c) {
            Folded::Separator => gap = true,
            Folded::Char(b) => keep(b, &mut out, &mut gap),
            Folded::Text(text) => {
                for b in text.bytes() {
                    if b == b' ' {
                        gap = true;
                    } else {
                        keep(b, &mut out, &mut gap);
                    }
                }
            }
        }
    }
    out
}

/// The garments a phrase can name: not disposed (every imported garment is owned; nothing in this
/// port merges or removes one).
fn nameable(g: &Garment) -> bool {
    g.acquisition != "disposed"
}

/// `resolveAlias`: exact alias matches win; otherwise every garment with an alias containing all the
/// words. More than one match is reported as ambiguous with the distinguishing facts, never resolved
/// to the first. Matches come in garment-ID order, each matched on its first alias in the order they
/// were recorded (the name first): the order SQLite reads the TypeScript query in, through the
/// `garment_aliases_garment` index (the query names no order; checked side by side).
pub fn resolve(cat: &Catalogue, phrase: &str) -> Value {
    let needle = normalize_phrase(phrase);
    if needle.is_empty() {
        return json!({"phrase": phrase, "matches": [], "ambiguous": false});
    }
    let mut garments: Vec<&Garment> = cat.garments.iter().filter(|g| nameable(g)).collect();
    garments.sort_by(|a, b| a.id.as_bytes().cmp(b.id.as_bytes()));
    let describe = |g: &Garment| [&g.colour, &g.fabric, &g.maker, &g.size].iter().filter_map(|v| v.as_deref()).filter(|v| !v.is_empty()).collect::<Vec<_>>().join(" / ");
    let collect = |pred: &dyn Fn(&str) -> bool| -> Vec<Value> {
        let mut out = Vec::new();
        for g in &garments {
            if let Some(a) = g.aliases.iter().find(|a| pred(&a.normalized)) {
                out.push(json!({"garmentId": g.id, "name": g.name, "matchedOn": a.phrase, "distinguishing": describe(g)}));
            }
        }
        out
    };
    let mut matches = collect(&|n| n == needle);
    if matches.is_empty() {
        let words: Vec<&str> = needle.split(' ').collect();
        matches = collect(&|n| {
            let have: Vec<&str> = n.split(' ').collect();
            words.iter().all(|w| have.contains(w))
        });
    }
    let ambiguous = matches.len() > 1;
    json!({"phrase": phrase, "matches": matches, "ambiguous": ambiguous})
}

/// The phrase of `GET /v1/wardrobe/resolve` (`ResolveQuery`), percent-decoded as a query string is.
pub fn resolve_phrase(raw_query: &str) -> Result<String, CmdError> {
    let Some(pairs) = crate::oauth::form_decode(raw_query) else {
        return Err(phrase_issue("phrase: the query string does not decode"));
    };
    let phrase = pairs.into_iter().find(|(k, _)| k == "phrase").map(|(_, v)| v);
    match phrase {
        // `z.string().min(1).max(200)` counts UTF-16 code units.
        Some(p) if !p.is_empty() && p.encode_utf16().count() <= MAX_PHRASE => Ok(p),
        Some(p) if !p.is_empty() => Err(phrase_issue("phrase: at most 200 characters")),
        _ => Err(phrase_issue("phrase: required, the words to resolve")),
    }
}

fn phrase_issue(text: &str) -> CmdError {
    CmdError::with("invalid_command", text, json!({"issues": [text]}))
}

fn issue(text: &str) -> CmdError {
    CmdError::with("invalid_command", "that selection is not valid", json!({"issues": [text]}))
}

/// A parsed `GarmentSelector`: every set criterion must match.
#[derive(Debug, Default)]
pub struct Selector {
    pub garment_ids: Option<Vec<String>>,
    pub category: Option<String>,
    pub search: Option<String>,
    pub maker: Option<String>,
    pub colour: Option<String>,
    pub fabric: Option<String>,
    pub care_channel: Option<String>,
    pub planning_policy: Option<String>,
    pub acquisition: Option<String>,
}

/// Parse a `GarmentSelector` as zod does: unknown keys are ignored, a named key must have its type (a
/// null is not "absent"), and at least one criterion is required.
pub fn parse_selector(v: &Value) -> Result<Selector, CmdError> {
    let Some(o) = v.as_object() else {
        return Err(issue("selector: expected an object"));
    };
    let mut issues: Vec<String> = Vec::new();
    let text = |o: &Map<String, Value>, key: &str, issues: &mut Vec<String>| -> Option<String> {
        match o.get(key) {
            None => None,
            Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
            Some(_) => {
                issues.push(format!("{key}: expected a non-empty string"));
                None
            }
        }
    };
    let choice = |o: &Map<String, Value>, key: &str, allowed: &[&str], issues: &mut Vec<String>| -> Option<String> {
        match o.get(key) {
            None => None,
            Some(Value::String(s)) if allowed.contains(&s.as_str()) => Some(s.clone()),
            Some(_) => {
                issues.push(format!("{key}: expected one of {}", allowed.join(", ")));
                None
            }
        }
    };
    let garment_ids = match o.get("garmentIds") {
        None => None,
        Some(Value::Array(a)) if !a.is_empty() && a.iter().all(|x| x.as_str().map_or(false, |s| !s.is_empty() && s.chars().count() <= 64)) => {
            Some(a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        }
        Some(_) => {
            issues.push("garmentIds: expected at least one garment ID (1 to 64 characters each)".into());
            None
        }
    };
    let s = Selector {
        garment_ids,
        category: choice(o, "category", CATEGORIES, &mut issues),
        search: text(o, "search", &mut issues),
        maker: text(o, "maker", &mut issues),
        colour: text(o, "colour", &mut issues),
        fabric: text(o, "fabric", &mut issues),
        care_channel: choice(o, "careChannel", CARE_CHANNELS, &mut issues),
        planning_policy: choice(o, "planningPolicy", PLANNING_POLICIES, &mut issues),
        acquisition: choice(o, "acquisition", SELECTABLE_ACQUISITIONS, &mut issues),
    };
    if !issues.is_empty() {
        return Err(CmdError::with("invalid_command", "that selection is not valid", json!({"issues": issues})));
    }
    let any = s.garment_ids.is_some()
        || [&s.category, &s.search, &s.maker, &s.colour, &s.fabric, &s.care_channel, &s.planning_policy, &s.acquisition].iter().any(|x| x.is_some());
    if !any {
        return Err(issue("a selector needs at least one criterion"));
    }
    Ok(s)
}

/// `selectGarments`: the garments the selector matches, ordered by category, name and garment ID
/// (SQLite's byte order). Naming an unknown garment refuses the whole selection.
pub fn select<'c>(cat: &'c Catalogue, s: &Selector) -> Result<Vec<&'c Garment>, CmdError> {
    let mut rows: Vec<&Garment> = cat.garments.iter().filter(|g| nameable(g)).collect();
    rows.sort_by(|a, b| (a.category.as_bytes(), a.name.as_bytes(), a.id.as_bytes()).cmp(&(b.category.as_bytes(), b.name.as_bytes(), b.id.as_bytes())));
    if let Some(ids) = &s.garment_ids {
        let mut missing: Vec<&str> = Vec::new();
        for id in ids {
            if !rows.iter().any(|g| &g.id == id) && !missing.contains(&id.as_str()) {
                missing.push(id);
            }
        }
        if !missing.is_empty() {
            let plural = if missing.len() > 1 { "s" } else { "" };
            return Err(CmdError::with("not_found", format!("unknown garment{plural}: {}; nothing was written", missing.join(", ")), json!({"missing": missing})));
        }
    }
    let contains = |value: Option<&str>, wanted: &str| normalize_phrase(value.unwrap_or("")).contains(&normalize_phrase(wanted));
    let words: Vec<String> = s.search.as_deref().map(|q| normalize_phrase(q).split(' ').filter(|w| !w.is_empty()).map(str::to_string).collect()).unwrap_or_default();
    Ok(rows
        .into_iter()
        .filter(|g| {
            if s.garment_ids.as_ref().map_or(false, |ids| !ids.contains(&g.id)) {
                return false;
            }
            if s.category.as_ref().map_or(false, |c| &g.category != c)
                || s.care_channel.as_ref().map_or(false, |c| &g.care_channel != c)
                || s.planning_policy.as_ref().map_or(false, |p| &g.planning_policy != p)
                || s.acquisition.as_ref().map_or(false, |a| &g.acquisition != a)
            {
                return false;
            }
            if s.maker.as_deref().map_or(false, |m| !contains(g.maker.as_deref(), m))
                || s.colour.as_deref().map_or(false, |c| !contains(g.colour.as_deref(), c))
                || s.fabric.as_deref().map_or(false, |f| !contains(g.fabric.as_deref(), f))
            {
                return false;
            }
            if !words.is_empty() {
                let mut parts: Vec<String> = [Some(g.name.as_str()), g.maker.as_deref(), g.product.as_deref(), g.colour.as_deref(), g.fabric.as_deref()].iter().map(|v| normalize_phrase(v.unwrap_or(""))).collect();
                parts.extend(g.aliases.iter().map(|a| a.normalized.clone()));
                let haystack = parts.join(" | ");
                if !words.iter().all(|w| haystack.contains(w.as_str())) {
                    return false;
                }
            }
            true
        })
        .collect())
}

/// `previewGarmentSelection` (`GarmentSelection`): what a bulk edit with this selector would touch.
pub fn preview(cat: &Catalogue, ledger: &Ledger, selector: &Value) -> Result<Value, CmdError> {
    let s = parse_selector(selector)?;
    let rows = select(cat, &s)?;
    let garments: Vec<Value> = rows.iter().map(|g| json!({"garmentId": g.id, "version": ledger.garment_version(&g.id), "name": g.name, "category": g.category})).collect();
    Ok(json!({"garments": garments, "count": rows.len(), "wardrobeRevision": ledger.revision}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_folds_what_nfkd_decomposes_and_separates_the_rest() {
        assert_eq!(normalize_phrase("Ļoţ Ŀa ŉ Ĳ"), "lot l a n ij");
        assert_eq!(normalize_phrase("Łódź"), "odz");
        assert_eq!(normalize_phrase("ḃlue ⓑⓛⓤⓔ 𝐁𝐥𝐮𝐞 Ⅻ ㎏"), "blue blue blue xii kg");
    }

    #[test]
    fn normalization_follows_normalize_phrase() {
        assert_eq!(normalize_phrase("  Drake's  Clifford — boot "), "drake s clifford boot");
        assert_eq!(normalize_phrase("Crème BRÛLÉE"), "creme brulee");
        assert_eq!(normalize_phrase("e\u{301}te\u{301}"), "ete");
        assert_eq!(normalize_phrase("C++ ½ ﬁt ＰＣＦ４３４０ ™"), "c++ 1 2 fit pcf4340 tm");
        assert_eq!(normalize_phrase("Ærø straße"), "r stra e");
        assert_eq!(normalize_phrase("—"), "");
    }
}
