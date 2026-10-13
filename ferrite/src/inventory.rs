//! The Wardrobe tab, `GET /v1/wardrobe` (`InventoryPage`), ported from `listInventory`
//! (packages/domain/src/queries.ts) with its query as `parseInventoryQuery` (apps/worker/src/routes/core.ts)
//! reads it: every garment with its record, aliases, balances, owned units, availability and recorded
//! wears, filtered and searched, in category, name and ID order, as a complete snapshot or in pages
//! whose `total`, `complete` and `nextCursor` are always explicit. Nothing is written.
//!
//! Availability is the estimator's for the day asked about (`forDate`, else the owner's day now), the same
//! document `GET /v1/availability` and the item page give a garment. The `available` count is the owned
//! garments whose status is `available` or `estimated`.
//!
//! What this port's records make simpler: every imported garment is owned (none is incoming, disposed or
//! merged), so `incoming` and `retired` count 0 and `includeDisposed` changes nothing; there are no
//! storage or tailor buckets, so those locations match nothing.

use ferrite_app::serde_json::{json, Value};

use crate::api::Store;
use crate::ledger::CmdError;
use crate::seed::catalogue;
use crate::selection::normalize_phrase;
use crate::time::{instant, local_date, owner_day, parse_local_date};

/// `InventoryQuery.limit` bound.
pub const MAX_LIMIT: u64 = 500;
const ACQUISITIONS: &[&str] = &["incoming", "owned", "disposed"];
const STATUSES: &[&str] = &["available", "estimated", "conditional", "unavailable"];
const LOCATIONS: &[&str] = &["home", "storage", "tailor", "trip", "service"];

/// A parsed `InventoryQuery`.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Query {
    pub search: Option<String>,
    pub category: Option<String>,
    pub acquisition: Option<String>,
    pub availability: Option<String>,
    pub colour: Option<String>,
    pub location: Option<String>,
    pub include_disposed: bool,
    pub limit: Option<u64>,
    pub cursor: Option<String>,
    pub for_date: Option<String>,
}

fn invalid(issue: impl Into<String>) -> CmdError {
    CmdError::with("invalid_command", "the inventory query is invalid", json!({"issues": [issue.into()]}))
}

/// JavaScript's `Number(text)` for a string (ECMAScript `StringToNumber`): surrounding white space is
/// ignored, an empty string is 0, `Infinity` with an optional sign, a `0x`/`0o`/`0b` integer (no sign), or a
/// decimal literal with an optional sign, fraction and exponent. Anything else is NaN (`None`).
pub fn js_number(text: &str) -> Option<f64> {
    let t = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if t.is_empty() {
        return Some(0.0);
    }
    match t {
        "Infinity" | "+Infinity" => return Some(f64::INFINITY),
        "-Infinity" => return Some(f64::NEG_INFINITY),
        _ => {}
    }
    let radix = |digits: &str, base: u32| -> Option<f64> {
        if digits.is_empty() {
            return None;
        }
        digits.chars().try_fold(0.0f64, |n, c| c.to_digit(base).map(|d| n * f64::from(base) + f64::from(d)))
    };
    for (prefix, base) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = t.strip_prefix(prefix) {
            return radix(digits, base);
        }
    }
    // StrDecimalLiteral: [+-] (digits [. digits?] | . digits) [(e|E) [+-] digits]
    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
    let (mantissa, exponent) = match body.find(['e', 'E']) {
        Some(i) => (&body[..i], Some(&body[i + 1..])),
        None => (body, None),
    };
    let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    let mantissa_ok = digits(int) && digits(frac) && !(int.is_empty() && frac.is_empty());
    let exponent_ok = exponent.map_or(true, |e| {
        let e = e.strip_prefix(['+', '-']).unwrap_or(e);
        !e.is_empty() && digits(e)
    });
    if !mantissa_ok || !exponent_ok {
        return None;
    }
    t.parse::<f64>().ok()
}

/// `Number.isInteger`: finite and whole.
fn whole(n: f64) -> bool {
    n.is_finite() && n.trunc() == n
}

/// `parseInventoryQuery`: the query string as `URLSearchParams` decodes it (the last value of a repeated
/// key wins; unknown keys are ignored), `limit` read as `Number(limit)` and `includeDisposed` as `true`
/// or not.
pub fn parse_query(raw_query: &str) -> Result<Query, CmdError> {
    let pairs = crate::oauth::form_decode(raw_query).ok_or_else(|| invalid("the query string does not decode"))?;
    let get = |key: &str| pairs.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v.clone());
    let one_of = |key: &str, allowed: &[&str]| -> Result<Option<String>, CmdError> {
        match get(key) {
            None => Ok(None),
            Some(v) if allowed.contains(&v.as_str()) => Ok(Some(v)),
            Some(_) => Err(invalid(format!("{key}: expected one of {}", allowed.join(", ")))),
        }
    };
    // `z.number().int().positive().max(500)` over `Number(text)`: "50", " 50 ", "5e1" and "0x32" are 50.
    let limit = match get("limit") {
        None => None,
        Some(text) => match js_number(&text) {
            Some(n) if whole(n) && n >= 1.0 && n <= MAX_LIMIT as f64 => Some(n as u64),
            _ => return Err(invalid(format!("limit: expected a whole number from 1 to {MAX_LIMIT}"))),
        },
    };
    let for_date = match get("forDate") {
        None => None,
        Some(d) if parse_local_date(&d).is_some() => Some(d),
        Some(_) => return Err(invalid("forDate: expected the day as YYYY-MM-DD")),
    };
    Ok(Query {
        search: get("search"),
        // An empty category filters nothing, as `query.category && ...` reads it.
        category: get("category").filter(|c| !c.is_empty()),
        acquisition: one_of("acquisition", ACQUISITIONS)?,
        availability: one_of("availability", STATUSES)?,
        colour: get("colour"),
        location: one_of("location", LOCATIONS)?,
        include_disposed: get("includeDisposed").as_deref() == Some("true"),
        limit,
        cursor: get("cursor"),
        for_date,
    })
}

/// The offset a cursor names, as `listInventory` reads it: no cursor (or an empty one, which is falsy) is
/// 0; otherwise `Number(cursor)` must be a non-negative integer ("100", "1e2" and "0x64" are 100). An
/// offset too large to hold is past any end.
fn offset_of(cursor: Option<&str>) -> Result<usize, CmdError> {
    match cursor {
        None | Some("") => Ok(0),
        Some(c) => match js_number(c) {
            Some(n) if whole(n) && n >= 0.0 => Ok(if n >= usize::MAX as f64 { usize::MAX } else { n as usize }),
            _ => Err(CmdError::new("invalid_command", "invalid cursor")),
        },
    }
}

/// `GET /v1/wardrobe[?search=&category=&acquisition=&availability=&colour=&location=&includeDisposed=&limit=&cursor=&forDate=]`.
pub async fn page<S: Store>(store: &mut S, now_ms: u64, q: &Query) -> Result<Value, CmdError> {
    let offset = offset_of(q.cursor.as_deref())?;
    let cat = catalogue();
    let for_date = q.for_date.clone().unwrap_or_else(|| local_date(owner_day(now_ms)));
    let (ledger, exposures) = crate::api::exposures_for(store, &for_date).await?;
    let input = crate::availability::Input::new(cat, &ledger, &for_date, exposures);
    let needle = q.search.as_deref().map(normalize_phrase);
    let colour = q.colour.as_deref().map(normalize_phrase);
    let (mut owned, mut available, mut incoming, mut retired) = (0u64, 0u64, 0u64, 0u64);
    let mut items: Vec<Value> = Vec::new();
    for g in crate::availability::ordered(cat) {
        let (verdict, doc) = crate::availability::estimate(&input, g);
        match g.acquisition.as_str() {
            "owned" => owned += 1,
            "incoming" => incoming += 1,
            "disposed" => retired += 1,
            _ => {}
        }
        if g.acquisition == "owned" && matches!(verdict.status, "available" | "estimated") {
            available += 1;
        }
        if g.acquisition == "disposed" && !q.include_disposed && q.acquisition.as_deref() != Some("disposed") {
            continue;
        }
        if q.category.as_deref().is_some_and(|c| c != g.category) || q.acquisition.as_deref().is_some_and(|a| a != g.acquisition) || q.availability.as_deref().is_some_and(|s| s != verdict.status) {
            continue;
        }
        if let Some(c) = &colour {
            if !normalize_phrase(g.colour.as_deref().unwrap_or("")).contains(c.as_str()) {
                continue;
            }
        }
        let balances = doc["balances"].as_array().cloned().unwrap_or_default();
        if let Some(location) = q.location.as_deref() {
            let buckets: &[&str] = match location {
                "home" => &["clean", "dirty"],
                "storage" => &["storage"],
                "tailor" => &["tailor"],
                "trip" => &["trip"],
                _ => &["service"],
            };
            if !balances.iter().any(|b| b["bucket"].as_str().is_some_and(|x| buckets.contains(&x)) && b["quantity"].as_u64().unwrap_or(0) > 0) {
                continue;
            }
        }
        if let Some(n) = &needle {
            // Every word of the phrase occurs in the normalized name, maker, product, colour, fabric or an
            // alias (a substring, as `haystack.includes(word)` finds it).
            let mut parts: Vec<String> = [Some(g.name.as_str()), g.maker.as_deref(), g.product.as_deref(), g.colour.as_deref(), g.fabric.as_deref()].iter().map(|p| normalize_phrase(p.unwrap_or(""))).collect();
            parts.extend(g.aliases.iter().map(|a| normalize_phrase(&a.phrase)));
            let haystack = parts.join(" | ");
            if !n.split(' ').all(|word| haystack.contains(word)) {
                continue;
            }
        }
        let counted: Vec<&crate::ledger::Wear> = ledger.wears.iter().filter(|w| w.garment_id == g.id && w.active).collect();
        let total: u64 = balances.iter().filter(|b| b["bucket"] != "gone" && b["bucket"] != "incoming").map(|b| b["quantity"].as_u64().unwrap_or(0)).sum();
        items.push(json!({
            "garment": crate::item::garment_json(&ledger, g),
            "aliases": g.aliases.iter().map(|a| a.phrase.clone()).collect::<Vec<_>>(),
            "balances": balances,
            "totalOwnedUnits": total,
            "availability": doc,
            "recordedWearCount": counted.len(),
            "lastRecordedWear": counted.iter().map(|w| w.wearing_date.as_str()).max(),
        }));
    }
    let total = items.len();
    let (page, complete, next): (Vec<Value>, bool, Option<String>) = match q.limit {
        // Without a limit the result is the complete snapshot, whatever the cursor.
        None => (items, true, None),
        Some(limit) => {
            let page: Vec<Value> = items.into_iter().skip(offset).take(limit as usize).collect();
            let end = offset.saturating_add(page.len());
            (page, offset == 0 && end >= total, (end < total).then(|| end.to_string()))
        }
    };
    Ok(json!({
        "items": page,
        "total": total,
        "complete": complete,
        "nextCursor": next,
        "counts": {"owned": owned, "available": available, "incoming": incoming, "retired": retired},
        "wardrobeRevision": ledger.revision,
        "readAt": instant(now_ms),
    }))
}
