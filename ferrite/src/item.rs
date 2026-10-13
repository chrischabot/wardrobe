//! The item page's read, `GET /v1/items/{garmentId}` (`ItemResponse` in packages/contracts/src/ext/api.ts),
//! ported from `readItem` (apps/worker/src/routes/core.ts) and `getGarmentDetail`
//! (packages/domain/src/queries.ts): the garment's record as imported, its aliases and facts, its
//! balances and movements as the ledger replays them, the restrictions that cover it, its counted wears,
//! and its availability. Nothing is written.
//!
//! What this port answers differently (README.md, "Item page"):
//! - availability is the estimator's (`availability::estimate`, as `getAvailability` gives it) for the
//!   owner's day now, weighed against the outfits offered and not reported (see "Availability");
//! - there is no media module, so `media` is `null` with `mediaAvailable: false`, and no combinations
//!   are stored, so `knownCombinations` is empty;
//! - the import's records carry the profile's date (`seed::imported_at`), and `updatedAt` stays that
//!   date: this port does not store when a garment's version last changed;
//! - no garment measurements are recorded (none are ported), so `measurements` is empty.

use ferrite_app::serde_json::{json, Value};

use crate::api::Store;
use crate::ledger::{CmdError, Ledger, Replay};
use crate::seed::{catalogue, healing_restriction, imported_at, Garment};
use crate::time::{instant, local_date, owner_day};

/// `ZERO_WEAR_CAVEAT` in packages/domain/src/queries.ts.
pub const WEAR_COUNT_CAVEAT: &str = "Recorded wears start when reliable logging began; zero recorded wears means not logged, never unworn, and says nothing about condition.";
/// Counted wears the page lists, newest first (`LIMIT 60`).
pub const RECENT_WEARS: usize = 60;

/// The garment an item path names: `/v1/items/<garmentId>` with nothing after it.
pub fn target(path: &str) -> Option<&str> {
    path.strip_prefix("/v1/items/").filter(|id| !id.is_empty() && !id.contains('/'))
}

/// `GET /v1/items/{garmentId}`.
pub async fn read<S: Store>(store: &mut S, now_ms: u64, garment_id: &str) -> Result<Value, CmdError> {
    let cat = catalogue();
    let g = cat.get(garment_id).ok_or_else(|| CmdError::new("not_found", format!("no garment '{garment_id}' in this wardrobe")))?;
    let for_date = local_date(owner_day(now_ms));
    let (ledger, exposures) = crate::api::exposures_for(store, &for_date).await?;
    let input = crate::availability::Input::new(cat, &ledger, &for_date, exposures);
    let balances = balances(&input.stock, g);
    let availability = crate::availability::estimate(&input, g).1;
    Ok(json!({
        "detail": detail(&ledger, &input.stock, g, balances),
        "availability": availability,
        "media": null,
        "mediaAvailable": false,
        "knownCombinations": [],
        "readAt": instant(now_ms),
    }))
}

/// The garment's balances as `stock_balances` holds them (`toBalances`), ordered by bucket and then
/// ref (SQLite's byte order): clean, dirty, each laundry batch, each trip (`<trip>` for clean packed
/// units, `<trip>#dirty` for worn ones). Only nonzero quantities.
fn balances(stock: &Replay, g: &Garment) -> Vec<(&'static str, String, u32)> {
    let st = stock.of(&g.id);
    let mut rows = vec![("clean", String::new(), st.clean), ("dirty", String::new(), st.dirty)];
    if let Some(batches) = stock.service.get(&g.id) {
        rows.extend(batches.iter().map(|(batch, h)| ("service", batch.clone(), h.quantity)));
    }
    let mut trips: Vec<(&'static str, String, u32)> = Vec::new();
    for (trip, s) in stock.trips.get(&g.id).map(Vec::as_slice).unwrap_or(&[]) {
        trips.push(("trip", trip.clone(), s.clean));
        trips.push(("trip", format!("{trip}#dirty"), s.dirty));
    }
    trips.sort_by(|a, b| a.1.as_bytes().cmp(b.1.as_bytes()));
    rows.extend(trips);
    rows.retain(|r| r.2 > 0);
    rows
}

fn balances_json(rows: &[(&'static str, String, u32)]) -> Value {
    json!(rows.iter().map(|(bucket, r, q)| json!({"bucket": bucket, "ref": r, "quantity": q})).collect::<Vec<_>>())
}

/// Whether a restriction's scope covers the garment (`restrictionCovers` in
/// packages/domain/src/availability/estimator.ts): named in `garmentIds`, or matching every field set
/// in any one `anyOf` clause.
pub fn covers(scope: &Value, g: &Garment) -> bool {
    if scope["garmentIds"].as_array().map_or(false, |ids| ids.iter().any(|id| id.as_str() == Some(g.id.as_str()))) {
        return true;
    }
    scope["anyOf"].as_array().map_or(false, |clauses| {
        clauses.iter().any(|clause| {
            let mut checks = Vec::new();
            if let Some(c) = clause.get("category").and_then(Value::as_str) {
                checks.push(c == g.category);
            }
            if let Some(kinds) = clause.get("footwearKinds").and_then(Value::as_array) {
                let kind = g.attr_str("footwearKind");
                checks.push(!kind.is_empty() && kinds.iter().any(|k| k.as_str() == Some(kind)));
            }
            if let Some(models) = clause.get("models").and_then(Value::as_array) {
                let model = g.attr_str("model").to_lowercase();
                checks.push(!model.is_empty() && models.iter().any(|m| m.as_str().map(str::to_lowercase).as_deref() == Some(model.as_str())));
            }
            !checks.is_empty() && checks.iter().all(|c| *c)
        })
    })
}

/// The event kind as the TypeScript journal names it: a wash report is `mark_dirty` there and the
/// owner's "I washed it" is `wash`.
fn journal_kind(kind: &str) -> &str {
    match kind {
        "dirty" => "mark_dirty",
        "washed" => "wash",
        other => other,
    }
}

fn detail(ledger: &Ledger, stock: &Replay, g: &Garment, rows: Vec<(&'static str, String, u32)>) -> Value {
    let imported = imported_at();
    let garment = json!({
        "userId": "owner",
        "garmentId": g.id,
        "version": ledger.garment_version(&g.id),
        "name": g.name,
        "category": g.category,
        "roles": g.roles,
        "maker": g.maker,
        "product": g.product,
        "fabric": g.fabric,
        "colour": g.colour,
        "pattern": g.pattern,
        "size": g.size,
        "careChannel": g.care_channel,
        "acquisition": g.acquisition,
        "planningPolicy": g.planning_policy,
        "planningReason": g.planning_reason,
        "condition": g.condition,
        "seasonNote": g.season_note,
        "thermal": g.thermal,
        "attributes": g.attributes,
        "isSynthetic": false,
        "mergedInto": null,
        "wearLoggingSince": null,
        "createdAt": imported,
        "updatedAt": imported,
    });
    let aliases: Vec<Value> = g.aliases.iter().map(|a| json!({"aliasId": a.alias_id, "garmentId": g.id, "phrase": a.phrase, "kind": a.kind})).collect();
    let facts: Vec<Value> = g
        .facts
        .iter()
        .map(|f| json!({"factId": f["factId"], "garmentId": g.id, "attribute": f["attribute"], "value": f["value"], "source": f["source"], "scope": f["scope"], "supersededBy": null, "recordedAt": imported}))
        .collect();
    let restriction = healing_restriction();
    let restrictions: Vec<Value> = if covers(&restriction["scope"], g) { vec![restriction.clone()] } else { Vec::new() };
    let total: u32 = rows.iter().map(|r| r.2).sum();

    let counted: Vec<&crate::ledger::Wear> = ledger.wears.iter().filter(|w| w.garment_id == g.id && w.active).collect();
    let last = counted.iter().map(|w| w.wearing_date.as_str()).max();
    let mut recent: Vec<&crate::ledger::Wear> = ledger.wears.iter().filter(|w| w.garment_id == g.id).collect();
    recent.sort_by(|a, b| b.wearing_date.cmp(&a.wearing_date));
    let recent: Vec<Value> = recent
        .into_iter()
        .take(RECENT_WEARS)
        .map(|w| {
            json!({
                "garmentId": g.id,
                "wearingDate": w.wearing_date,
                "observationCount": ledger.active_reports(&g.id, &w.wearing_date).max(1),
                "status": if w.active { "active" } else { "retracted" },
            })
        })
        .collect();

    // The import's opening stock first (`receive`, basis `import`, as `garment.create` journals it),
    // then every move of the garment's events in replay order. Every event here records the owner's
    // own report (or the assistant relaying it): this port infers no movement.
    let mut movements = vec![json!({
        "eventId": format!("import:{}:{}", catalogue().import_run_id, g.id),
        "kind": "receive",
        "from": null,
        "to": "clean",
        "quantity": g.quantity,
        "basis": "import",
        "occurredAt": imported,
        "note": null,
    })];
    for m in stock.movements.iter().filter(|m| m.garment_id == g.id) {
        let Some(e) = ledger.events.iter().find(|e| e.id == m.event_id) else { continue };
        movements.push(json!({
            "eventId": e.id,
            "kind": journal_kind(&e.kind),
            "from": m.from,
            "to": m.to,
            "quantity": m.quantity,
            "basis": "observed",
            "occurredAt": instant(e.at_ms),
            "note": m.note,
        }));
    }

    json!({
        "garment": garment,
        "aliases": aliases,
        "facts": facts,
        "balances": balances_json(&rows),
        "totalOwnedUnits": total,
        "restrictions": restrictions,
        "recordedWearCount": counted.len(),
        "lastRecordedWear": last,
        "wearCountCaveat": WEAR_COUNT_CAVEAT,
        "recentWears": recent,
        "movements": movements,
        "measurements": [],
    })
}

