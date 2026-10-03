import { AVAILABILITY_MODEL_VERSION, DEFAULT_OWNER_SETTINGS, OwnerSettings, STYLE_PRECEDENCE_STATEMENT, InventoryQuery } from "@garderobe/contracts";
import type {
  AliasResolution,
  AvailabilitySnapshot,
  CareChannel,
  DailyRecord,
  Garment,
  GarmentAvailability,
  GarmentDetail,
  InventoryItem,
  InventoryPage,
  JointAvailability,
  Measurement,
  Restriction,
  StockBalance,
  StyleContext,
  WearObservation,
} from "@garderobe/contracts";
import { all, allIn, first, json, type Db } from "./db.ts";
import { CommandError } from "./errors.ts";
import { assertPrincipal, requireScope, type Principal } from "./principal.ts";
import { addDays, deepMerge, localDateOf, normalizePhrase, toInstant } from "./util.ts";
import { estimateAll, jointAvailability, restrictionCovers, type EstimatorExposureSet, type EstimatorGarment, type EstimatorInput, type EstimatorRestriction } from "./availability/estimator.ts";
import { explainGarmentStock } from "./stock/planner.ts";
import type { BalanceRow } from "./stock/replay.ts";
import { listStyleFactConflicts } from "./handlers/style-facts.ts";

/**
 * Read API. Every function requires an authenticated Principal and qualifies every query with its
 * user ID; there is no way to pass an owner in a filter. Reads never mutate.
 */

function guard(principal: Principal): string {
  assertPrincipal(principal);
  requireScope(principal, "read");
  return principal.userId;
}

function rowToGarment(userId: string, r: any): Garment {
  return {
    userId,
    garmentId: r.garment_id,
    version: r.version,
    name: r.name,
    category: r.category,
    roles: json(r.roles_json, []),
    maker: r.maker,
    product: r.product,
    fabric: r.fabric,
    colour: r.colour,
    pattern: r.pattern,
    size: r.size,
    careChannel: r.care_channel,
    acquisition: r.acquisition,
    planningPolicy: r.planning_policy,
    planningReason: r.planning_reason,
    condition: r.condition,
    seasonNote: r.season_note,
    thermal: json(r.thermal_json, null),
    attributes: json(r.attributes_json, {}),
    isSynthetic: r.is_synthetic === 1,
    mergedInto: r.merged_into,
    wearLoggingSince: r.wear_logging_since,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToMeasurement(m: any): Measurement {
  return { measurementId: m.measurement_id, subject: m.subject, garmentId: m.garment_id, key: m.key, value: m.value, unit: m.unit, convention: m.convention, qualifier: m.qualifier, measuredOn: m.measured_on, source: json(m.source_json, { kind: "system" }), passage: json(m.passage_json, null), supersededBy: m.superseded_by };
}

function rowToRestriction(r: any): Restriction {
  return {
    restrictionId: r.restriction_id,
    kind: r.kind,
    scope: json(r.scope_json, {}),
    reason: r.reason,
    startsAt: r.starts_at,
    expectedEnd: r.expected_end,
    requiredEvidence: r.required_evidence,
    status: r.status,
    resolvedAt: r.resolved_at,
    source: json(r.source_json, { kind: "system" }),
  };
}

export async function getOwnerState(db: Db, principal: Principal): Promise<{ wardrobeRevision: number; styleRevision: number; settings: OwnerSettings; settingsVersion: number }> {
  const userId = guard(principal);
  const row = await first<{ wardrobe_revision: number; style_revision: number; settings_json: string; version: number }>(
    db,
    "SELECT s.wardrobe_revision, s.style_revision, o.settings_json, o.version FROM owner_state s JOIN owner_settings o ON o.user_id = s.user_id WHERE s.user_id = ?",
    userId,
  );
  if (!row) throw new CommandError("not_found", "unknown owner");
  return { wardrobeRevision: row.wardrobe_revision, styleRevision: row.style_revision, settings: OwnerSettings.parse(deepMerge(DEFAULT_OWNER_SETTINGS, json(row.settings_json, {}))), settingsVersion: row.version };
}

export async function listRestrictions(db: Db, principal: Principal, opts: { status?: "active" | "resolved" } = {}): Promise<Restriction[]> {
  const userId = guard(principal);
  const rows = opts.status
    ? await all(db, "SELECT * FROM restrictions WHERE user_id = ? AND status = ? ORDER BY julianday(starts_at), rowid", userId, opts.status)
    : await all(db, "SELECT * FROM restrictions WHERE user_id = ? ORDER BY julianday(starts_at), rowid", userId);
  return rows.map(rowToRestriction);
}

/* ------------------------------------------------------------------ */
/* Availability                                                         */
/* ------------------------------------------------------------------ */

export async function buildEstimatorInput(db: Db, userId: string, forDate: string, settings: OwnerSettings): Promise<{ input: EstimatorInput; lastBaseline: { cycleKey: string; cutoffAt: string } | null; garmentRows: any[] }> {
  const garmentRows = await all<any>(db, "SELECT * FROM garments WHERE user_id = ? AND removed_reason IS NULL ORDER BY category, name, garment_id", userId);
  const balanceRows = await all<{ garment_id: string; bucket: BalanceRow["bucket"]; ref: string; quantity: number; held: number }>(db, "SELECT garment_id, bucket, ref, quantity, held FROM stock_balances WHERE user_id = ?", userId);
  const balances = new Map<string, BalanceRow[]>();
  for (const b of balanceRows) {
    const list = balances.get(b.garment_id) ?? [];
    list.push({ bucket: b.bucket, ref: b.ref, quantity: b.quantity, held: b.held === 1 });
    balances.set(b.garment_id, list);
  }
  const imported = await all<{ garment_id: string; at: string }>(db, "SELECT garment_id, occurred_at AS at FROM stock_events WHERE user_id = ? AND kind = 'receive' AND basis = 'import' AND voided_by_command_id IS NULL GROUP BY garment_id HAVING julianday(occurred_at) = MIN(julianday(occurred_at))", userId);
  const verified = new Set(
    (await all<{ garment_id: string }>(db, "SELECT DISTINCT garment_id FROM stock_events WHERE user_id = ? AND kind IN ('wash', 'return', 'reconcile') AND voided_by_command_id IS NULL AND garment_id IS NOT NULL", userId)).map((r) => r.garment_id),
  );
  const cycles = await all<{ channel: CareChannel; cycle_key: string; cutoff_at: string; baseline_at: string }>(
    db,
    "SELECT channel, cycle_key, cutoff_at, baseline_at FROM laundry_cycles c WHERE user_id = ? AND cycle_key = (SELECT MAX(cycle_key) FROM laundry_cycles WHERE user_id = c.user_id AND channel = c.channel)",
    userId,
  );
  const lastCycle = new Map(cycles.map((c) => [c.channel, c]));
  const importedAt = new Map(imported.map((r) => [r.garment_id, r.at]));

  const garments: EstimatorGarment[] = garmentRows.map((r) => {
    const at = importedAt.get(r.garment_id);
    const cycle = lastCycle.get(r.care_channel);
    const unverified = at !== undefined && r.care_channel !== "none" && !verified.has(r.garment_id) && !(cycle && Date.parse(cycle.baseline_at) > Date.parse(at));
    return {
      garmentId: r.garment_id,
      category: r.category,
      careChannel: r.care_channel,
      acquisition: r.acquisition,
      planningPolicy: r.planning_policy,
      merged: r.merged_into !== null,
      attributes: json(r.attributes_json, {}),
      balances: balances.get(r.garment_id) ?? [],
      importCleanlinessUnverified: unverified,
      cleanInferred: Number(r.clean_inferred ?? 0),
      importNeverObserved: at !== undefined && r.care_channel !== "none" && !verified.has(r.garment_id),
    };
  });

  const restrictionRows = await all<any>(db, "SELECT restriction_id, kind, scope_json FROM restrictions WHERE user_id = ? AND status = 'active'", userId);
  const restrictions: EstimatorRestriction[] = restrictionRows.map((r) => ({ restrictionId: r.restriction_id, kind: r.kind, scope: json(r.scope_json, {}) }));

  // Without a baseline for a channel, unreported wear older than the pattern horizon no longer counts.
  const horizon = addDays(forDate, -settings.variety.patternHorizonDays);
  const cutoffDateByChannel: Partial<Record<CareChannel, string>> = {};
  for (const channel of ["service", "handwash"] as const) {
    const c = lastCycle.get(channel);
    const cutoff = c ? localDateOf(Date.parse(c.cutoff_at), settings.timezone) : horizon;
    cutoffDateByChannel[channel] = cutoff > horizon ? cutoff : horizon;
  }
  const earliest = Object.values(cutoffDateByChannel).sort()[0]!;
  const setRows = await all<any>(
    db,
    "SELECT exposure_id, local_date, p_use, selected_option_id, chosen_alternatives_json FROM exposure_sets WHERE user_id = ? AND status IN ('open', 'selected') AND local_date >= ? AND local_date < ? ORDER BY local_date, exposure_id",
    userId, earliest, forDate,
  );
  const itemRows = setRows.length
    ? await allIn<{ exposure_id: string; option_id: string; garment_id: string; alt_group: number }>(db, "SELECT exposure_id, option_id, garment_id, alt_group FROM exposure_items WHERE user_id = ? AND exposure_id IN (:ids) ORDER BY option_id, alt_group, garment_id", [userId], setRows.map((s) => s.exposure_id))
    : [];
  const exposures: EstimatorExposureSet[] = setRows.map((s) => {
    const options = new Map<string, { optionId: string; garmentIds: string[]; groups: Map<number, string[]> }>();
    for (const i of itemRows.filter((x) => x.exposure_id === s.exposure_id)) {
      const o = options.get(i.option_id) ?? { optionId: i.option_id, garmentIds: [] as string[], groups: new Map<number, string[]>() };
      if (i.alt_group === 0) o.garmentIds.push(i.garment_id);
      else o.groups.set(i.alt_group, [...(o.groups.get(i.alt_group) ?? []), i.garment_id]);
      options.set(i.option_id, o);
    }
    return {
      exposureId: s.exposure_id,
      localDate: s.local_date,
      pUse: s.p_use,
      selectedOptionId: s.selected_option_id,
      chosenAlternatives: json(s.chosen_alternatives_json, []),
      options: [...options.values()].map((o) => ({ optionId: o.optionId, garmentIds: o.garmentIds, alternativeGroups: [...o.groups.values()] })),
    };
  });
  const service = lastCycle.get("service");
  return {
    input: { forDate, params: settings.estimator, garments, restrictions, exposures, cutoffDateByChannel },
    lastBaseline: service ? { cycleKey: service.cycle_key, cutoffAt: service.cutoff_at } : null,
    garmentRows,
  };
}

/** Availability of every garment for a fresh wear on `forDate` (default: today in the owner's timezone). */
export async function getAvailability(db: Db, principal: Principal, opts: { forDate?: string; nowMs?: number } = {}): Promise<AvailabilitySnapshot> {
  guard(principal);
  const state = await getOwnerState(db, principal);
  const nowMs = opts.nowMs ?? Date.now();
  const forDate = opts.forDate ?? localDateOf(nowMs, state.settings.timezone);
  const { input, lastBaseline } = await buildEstimatorInput(db, principal.userId, forDate, state.settings);
  return {
    modelVersion: AVAILABILITY_MODEL_VERSION,
    forDate,
    computedAt: toInstant(nowMs),
    wardrobeRevision: state.wardrobeRevision,
    parameters: { pUseBoard: state.settings.estimator.pUseBoard, pFollowSelection: state.settings.estimator.pFollowSelection, parameterStatus: "hypothesis" },
    lastBaseline,
    garments: estimateAll(input),
  };
}

/** Joint probability that a whole outfit is available, accounting for garments offered together. */
export async function getJointAvailability(db: Db, principal: Principal, garmentIds: string[], opts: { forDate?: string; nowMs?: number } = {}): Promise<JointAvailability> {
  guard(principal);
  const state = await getOwnerState(db, principal);
  const forDate = opts.forDate ?? localDateOf(opts.nowMs ?? Date.now(), state.settings.timezone);
  const { input } = await buildEstimatorInput(db, principal.userId, forDate, state.settings);
  const r = jointAvailability(input, garmentIds);
  return { garmentIds, pAllAvailable: r.pAllAvailable, hardExcluded: r.hardExcluded, modelVersion: AVAILABILITY_MODEL_VERSION };
}

/* ------------------------------------------------------------------ */
/* Inventory                                                            */
/* ------------------------------------------------------------------ */

function ownedTotal(balances: StockBalance[]): number {
  return balances.filter((b) => b.bucket !== "gone" && b.bucket !== "incoming").reduce((n, b) => n + b.quantity, 0);
}

/**
 * Search or list the wardrobe. Without `limit` the result is the complete snapshot (`complete: true`).
 * With `limit`, `total`, `complete` and `nextCursor` are explicit so a page is never mistaken for the whole.
 */
export async function listInventory(db: Db, principal: Principal, queryInput: InventoryQuery = {}, opts: { nowMs?: number } = {}): Promise<InventoryPage> {
  const userId = guard(principal);
  const query = InventoryQuery.parse(queryInput);
  const state = await getOwnerState(db, principal);
  const nowMs = opts.nowMs ?? Date.now();
  const forDate = query.forDate ?? localDateOf(nowMs, state.settings.timezone);
  const { input, garmentRows } = await buildEstimatorInput(db, userId, forDate, state.settings);
  const availability = new Map(estimateAll(input).map((a) => [a.garmentId, a]));
  const aliasRows = await all<{ garment_id: string; phrase: string; normalized: string }>(db, "SELECT garment_id, phrase, normalized FROM garment_aliases WHERE user_id = ? AND removed_at IS NULL", userId);
  const aliases = new Map<string, { phrase: string; normalized: string }[]>();
  for (const a of aliasRows) aliases.set(a.garment_id, [...(aliases.get(a.garment_id) ?? []), a]);
  const wearRows = await all<{ garment_id: string; n: number; last: string }>(db, "SELECT garment_id, COUNT(*) AS n, MAX(wearing_date) AS last FROM daily_wears WHERE user_id = ? AND status = 'active' GROUP BY garment_id", userId);
  const wears = new Map(wearRows.map((w) => [w.garment_id, w]));

  const needle = query.search ? normalizePhrase(query.search) : null;
  const items: InventoryItem[] = [];
  const counts = { owned: 0, available: 0, incoming: 0, retired: 0 };
  for (const r of garmentRows) {
    if (r.merged_into) continue;
    const garment = rowToGarment(userId, r);
    const avail = availability.get(r.garment_id)!;
    if (garment.acquisition === "owned") counts.owned++;
    if (garment.acquisition === "incoming") counts.incoming++;
    if (garment.acquisition === "disposed") counts.retired++;
    if (garment.acquisition === "owned" && (avail.status === "available" || avail.status === "estimated")) counts.available++;

    if (garment.acquisition === "disposed" && !query.includeDisposed && query.acquisition !== "disposed") continue;
    if (query.category && garment.category !== query.category) continue;
    if (query.acquisition && garment.acquisition !== query.acquisition) continue;
    if (query.availability && avail.status !== query.availability) continue;
    if (query.colour && !normalizePhrase(garment.colour ?? "").includes(normalizePhrase(query.colour))) continue;
    if (query.location) {
      const bucket = { home: ["clean", "dirty"], storage: ["storage"], tailor: ["tailor"], trip: ["trip"], service: ["service"] }[query.location];
      if (!avail.balances.some((b) => bucket.includes(b.bucket) && b.quantity > 0)) continue;
    }
    const garmentAliases = aliases.get(r.garment_id) ?? [];
    if (needle) {
      const haystack = [garment.name, garment.maker ?? "", garment.product ?? "", garment.colour ?? "", garment.fabric ?? "", ...garmentAliases.map((a) => a.phrase)].map(normalizePhrase).join(" | ");
      if (!needle.split(" ").every((word) => haystack.includes(word))) continue;
    }
    const w = wears.get(r.garment_id);
    items.push({
      garment,
      aliases: garmentAliases.map((a) => a.phrase),
      balances: avail.balances,
      totalOwnedUnits: ownedTotal(avail.balances),
      availability: avail,
      recordedWearCount: w?.n ?? 0,
      lastRecordedWear: w?.last ?? null,
    });
  }
  const total = items.length;
  const offset = query.cursor ? Number(query.cursor) : 0;
  if (!Number.isInteger(offset) || offset < 0) throw new CommandError("invalid_command", "invalid cursor");
  const page = query.limit ? items.slice(offset, offset + query.limit) : items;
  const end = offset + page.length;
  return {
    items: page,
    total,
    complete: !query.limit ? true : offset === 0 && end >= total,
    nextCursor: query.limit && end < total ? String(end) : null,
    counts,
    wardrobeRevision: state.wardrobeRevision,
    readAt: toInstant(nowMs),
  };
}

const ZERO_WEAR_CAVEAT = "Recorded wears start when reliable logging began; zero recorded wears means not logged, never unworn, and says nothing about condition.";

export async function getGarmentDetail(db: Db, principal: Principal, garmentId: string): Promise<GarmentDetail> {
  const userId = guard(principal);
  const r = await first<any>(db, "SELECT * FROM garments WHERE user_id = ? AND garment_id = ?", userId, garmentId);
  if (!r) throw new CommandError("not_found", `no garment '${garmentId}' in this wardrobe`);
  const garment = rowToGarment(userId, r);
  const [aliasRows, factRows, balanceRows, wearAgg, recent, restrictionRows, measurementRows] = await Promise.all([
    all<any>(db, "SELECT alias_id, garment_id, phrase, kind FROM garment_aliases WHERE user_id = ? AND garment_id = ? AND removed_at IS NULL ORDER BY julianday(created_at), rowid", userId, garmentId),
    all<any>(db, "SELECT * FROM garment_facts WHERE user_id = ? AND garment_id = ? ORDER BY julianday(recorded_at), rowid", userId, garmentId),
    all<any>(db, "SELECT bucket, ref, quantity FROM stock_balances WHERE user_id = ? AND garment_id = ? ORDER BY bucket, ref", userId, garmentId),
    first<{ n: number; last: string | null }>(db, "SELECT COUNT(*) AS n, MAX(wearing_date) AS last FROM daily_wears WHERE user_id = ? AND garment_id = ? AND status = 'active'", userId, garmentId),
    all<any>(db, "SELECT garment_id, wearing_date, observation_count, status FROM daily_wears WHERE user_id = ? AND garment_id = ? ORDER BY wearing_date DESC LIMIT 60", userId, garmentId),
    all<any>(db, "SELECT * FROM restrictions WHERE user_id = ? AND status = 'active'", userId),
    all<any>(db, "SELECT * FROM measurements WHERE user_id = ? AND subject = 'garment' AND garment_id = ? AND superseded_by IS NULL ORDER BY key", userId, garmentId),
  ]);
  const replay = await explainGarmentStock(db, userId, garmentId, garment.careChannel);
  const balances: StockBalance[] = balanceRows.map((b) => ({ bucket: b.bucket, ref: b.ref, quantity: b.quantity }));
  return {
    garment,
    aliases: aliasRows.map((a) => ({ aliasId: a.alias_id, garmentId: a.garment_id, phrase: a.phrase, kind: a.kind })),
    facts: factRows.map((f) => ({ factId: f.fact_id, garmentId: f.garment_id, attribute: f.attribute, value: json(f.value_json, null), source: json(f.source_json, { kind: "system" }), scope: f.scope, supersededBy: f.superseded_by, recordedAt: f.recorded_at })),
    balances,
    totalOwnedUnits: ownedTotal(balances),
    restrictions: restrictionRows.map(rowToRestriction).filter((x) => restrictionCovers(x.scope, { garmentId, category: garment.category, attributes: garment.attributes })),
    recordedWearCount: wearAgg?.n ?? 0,
    lastRecordedWear: wearAgg?.last ?? null,
    wearCountCaveat: ZERO_WEAR_CAVEAT,
    recentWears: recent.map((w) => ({ garmentId: w.garment_id, wearingDate: w.wearing_date, observationCount: Math.max(1, w.observation_count), status: w.status })),
    movements: replay.movements.map((m) => ({ eventId: m.eventId, kind: m.kind, from: m.from, to: m.to, quantity: m.quantity, basis: m.basis, occurredAt: toInstant(m.occurredAtMs), note: m.note })),
    measurements: measurementRows.map(rowToMeasurement),
  };
}

/**
 * Resolve a phrase ("the wide-stripe shirt", "PCF4340") to garments. Exact alias matches win; otherwise
 * every garment whose names contain all the words. More than one match is reported as ambiguous with the
 * distinguishing facts - it is never silently resolved to the first result.
 */
export async function resolveAlias(db: Db, principal: Principal, phrase: string): Promise<AliasResolution> {
  const userId = guard(principal);
  const needle = normalizePhrase(phrase);
  if (!needle) return { phrase, matches: [], ambiguous: false };
  const rows = await all<{ garment_id: string; name: string; colour: string | null; fabric: string | null; size: string | null; maker: string | null; phrase: string; normalized: string }>(
    db,
    `SELECT g.garment_id, g.name, g.colour, g.fabric, g.size, g.maker, a.phrase, a.normalized
       FROM garment_aliases a JOIN garments g ON g.user_id = a.user_id AND g.garment_id = a.garment_id
      WHERE a.user_id = ? AND a.removed_at IS NULL AND g.merged_into IS NULL AND g.removed_reason IS NULL AND g.acquisition != 'disposed'`,
    userId,
  );
  const describe = (r: (typeof rows)[number]) => [r.colour, r.fabric, r.maker, r.size].filter(Boolean).join(" / ");
  const collect = (pred: (r: (typeof rows)[number]) => boolean) => {
    const seen = new Map<string, { garmentId: string; name: string; matchedOn: string; distinguishing: string }>();
    for (const r of rows) if (pred(r) && !seen.has(r.garment_id)) seen.set(r.garment_id, { garmentId: r.garment_id, name: r.name, matchedOn: r.phrase, distinguishing: describe(r) });
    return [...seen.values()];
  };
  let matches = collect((r) => r.normalized === needle);
  if (matches.length === 0) {
    const words = needle.split(" ");
    matches = collect((r) => words.every((w) => r.normalized.split(" ").includes(w)));
  }
  return { phrase, matches, ambiguous: matches.length > 1 };
}

/* ------------------------------------------------------------------ */
/* Wear history                                                         */
/* ------------------------------------------------------------------ */

function rowToObservation(o: any): WearObservation {
  return { observationId: o.observation_id, garmentId: o.garment_id, wearingDate: o.wearing_date, occurredAt: o.occurred_at, reportedAt: o.reported_at, timezone: o.timezone, channel: o.channel, segment: o.segment, status: o.status, commandId: o.command_id };
}

/** What was actually worn on a date: counted garments plus every retained report. */
export async function getDailyRecord(db: Db, principal: Principal, wearingDate: string): Promise<DailyRecord> {
  const userId = guard(principal);
  const counted = await all<any>(
    db,
    "SELECT w.garment_id, w.observation_count, g.name FROM daily_wears w JOIN garments g ON g.user_id = w.user_id AND g.garment_id = w.garment_id WHERE w.user_id = ? AND w.wearing_date = ? AND w.status = 'active' ORDER BY g.category, g.name",
    userId, wearingDate,
  );
  const observations = (await all<any>(db, "SELECT * FROM wear_observations WHERE user_id = ? AND wearing_date = ? ORDER BY julianday(reported_at), rowid", userId, wearingDate)).map(rowToObservation);
  return {
    wearingDate,
    garments: counted.map((c) => ({
      garmentId: c.garment_id,
      name: c.name,
      observationCount: c.observation_count,
      segments: [...new Set(observations.filter((o) => o.garmentId === c.garment_id && o.status === "active" && o.segment).map((o) => o.segment!))],
    })),
    observations,
  };
}

/** Counted wears in a date range (inclusive). Used for the seven-day repeat and fourteen-day pattern checks. */
export async function listCountedWears(db: Db, principal: Principal, range: { from: string; to: string }): Promise<{ garmentId: string; wearingDate: string; observationCount: number }[]> {
  const userId = guard(principal);
  const rows = await all<any>(db, "SELECT garment_id, wearing_date, observation_count FROM daily_wears WHERE user_id = ? AND status = 'active' AND wearing_date >= ? AND wearing_date <= ? ORDER BY wearing_date, garment_id", userId, range.from, range.to);
  return rows.map((r) => ({ garmentId: r.garment_id, wearingDate: r.wearing_date, observationCount: r.observation_count }));
}

/* ------------------------------------------------------------------ */
/* Laundry                                                              */
/* ------------------------------------------------------------------ */

export interface LaundryState {
  awaitingService: { garmentId: string; name: string; quantity: number }[];
  awaitingHandwash: { garmentId: string; name: string; quantity: number }[];
  batches: { batchId: string; status: string; pickedUpAt: string; returnedAt: string | null; returnBasis: string | null; items: { garmentId: string; name: string; quantity: number; returnedQuantity: number; stillAway: number }[] }[];
  exceptions: { exceptionId: string; kind: string; garmentId: string | null; cycleKey: string | null; quantity: number; occurredAt: string }[];
  cycles: { channel: string; cycleKey: string; cutoffAt: string; baselineAt: string }[];
}

/** The Laundry sheet's data: both care channels separately, actual batch membership, open exceptions. */
export async function getLaundryState(db: Db, principal: Principal): Promise<LaundryState> {
  const userId = guard(principal);
  const dirty = await all<any>(
    db,
    "SELECT g.garment_id, g.name, g.care_channel, b.quantity FROM stock_balances b JOIN garments g ON g.user_id = b.user_id AND g.garment_id = b.garment_id WHERE b.user_id = ? AND b.bucket = 'dirty' AND b.quantity > 0 ORDER BY g.name",
    userId,
  );
  const batches = await all<any>(db, "SELECT * FROM laundry_batches WHERE user_id = ? AND withdrawn_at IS NULL ORDER BY julianday(picked_up_at) DESC, rowid DESC LIMIT 12", userId);
  const items = batches.length
    ? await allIn<any>(db, "SELECT i.*, g.name FROM laundry_batch_items i JOIN garments g ON g.user_id = i.user_id AND g.garment_id = i.garment_id WHERE i.user_id = ? AND i.batch_id IN (:ids) ORDER BY g.name", [userId], batches.map((b) => b.batch_id))
    : [];
  const exceptions = await all<any>(db, "SELECT * FROM laundry_exceptions WHERE user_id = ? AND status = 'active' ORDER BY julianday(occurred_at), rowid", userId);
  const cycles = await all<any>(db, "SELECT channel, cycle_key, cutoff_at, baseline_at FROM laundry_cycles WHERE user_id = ? ORDER BY cycle_key DESC LIMIT 8", userId);
  const pool = (channel: string) => dirty.filter((d) => d.care_channel === channel).map((d) => ({ garmentId: d.garment_id, name: d.name, quantity: d.quantity }));
  return {
    awaitingService: pool("service"),
    awaitingHandwash: pool("handwash"),
    batches: batches.map((b) => ({
      batchId: b.batch_id,
      status: b.status,
      pickedUpAt: b.picked_up_at,
      returnedAt: b.returned_at,
      returnBasis: b.return_basis,
      items: items.filter((i) => i.batch_id === b.batch_id).map((i) => ({ garmentId: i.garment_id, name: i.name, quantity: i.quantity, returnedQuantity: i.returned_quantity, stillAway: i.still_away })),
    })),
    exceptions: exceptions.map((e) => ({ exceptionId: e.exception_id, kind: e.kind, garmentId: e.garment_id, cycleKey: e.cycle_key, quantity: e.quantity, occurredAt: e.occurred_at })),
    cycles: cycles.map((c) => ({ channel: c.channel, cycleKey: c.cycle_key, cutoffAt: c.cutoff_at, baselineAt: c.baseline_at })),
  };
}

/* ------------------------------------------------------------------ */
/* Style                                                                */
/* ------------------------------------------------------------------ */

/**
 * The complete active taste context: the full profile text (never a summary), then its active
 * amendments, current rules, standing directions, the day's briefs, dated measurements and the
 * precedence statement. Read at turn start; versioned by `styleRevision` (cache only by that key).
 */
export async function getStyleContext(db: Db, principal: Principal, opts: { forDate?: string; documentId?: string } = {}): Promise<StyleContext> {
  const userId = guard(principal);
  const documentId = opts.documentId ?? "owner-profile";
  const doc = await first<any>(db, "SELECT * FROM style_documents WHERE user_id = ? AND document_id = ? AND status = 'active'", userId, documentId);
  if (!doc) throw new CommandError("not_found", "no active style document; import the owner's profile first");
  const [amendments, rules, directions, briefs, measurements, sizes, state, conflicts] = await Promise.all([
    all<any>(db, "SELECT * FROM style_amendments WHERE user_id = ? AND document_id = ? AND status = 'active' ORDER BY julianday(created_at), rowid", userId, documentId),
    all<any>(db, "SELECT * FROM style_rules WHERE user_id = ? AND is_current = 1 AND status != 'retired' ORDER BY key", userId),
    all<any>(db, "SELECT * FROM standing_directions WHERE user_id = ? AND status = 'active' ORDER BY julianday(created_at), rowid", userId),
    opts.forDate ? all<any>(db, "SELECT * FROM temporary_briefs WHERE user_id = ? AND status = 'active' AND local_date = ? ORDER BY julianday(created_at), rowid", userId, opts.forDate) : Promise.resolve([]),
    all<any>(db, "SELECT * FROM measurements WHERE user_id = ? AND superseded_by IS NULL ORDER BY subject, key", userId),
    all<any>(db, "SELECT * FROM size_experiences WHERE user_id = ? AND retired_at IS NULL ORDER BY maker, julianday(created_at), rowid", userId),
    first<{ style_revision: number }>(db, "SELECT style_revision FROM owner_state WHERE user_id = ?", userId),
    listStyleFactConflicts(db, principal, { documentId }),
  ]);
  return {
    document: { documentId: doc.document_id, version: doc.version, title: doc.title, content: doc.content, contentSha256: doc.content_sha256, byteLength: doc.byte_length, status: doc.status, createdAt: doc.created_at },
    amendments: amendments.map((a) => ({ amendmentId: a.amendment_id, documentId: a.document_id, basedOnVersion: a.based_on_version, text: a.text, kind: a.kind, status: a.status, source: json(a.source_json, { kind: "system" }), createdAt: a.created_at })),
    rules: rules.map((r) => ({ ruleId: r.rule_id, version: r.version, key: r.key, kind: r.kind, status: r.status, params: json(r.params_json, {}), interpretation: r.interpretation, passages: json(r.passages_json, []), origin: r.origin, createdAt: r.created_at })),
    directions: directions.map((d) => ({ directionId: d.direction_id, version: d.version, text: d.text, scope: d.scope, checkKey: d.check_key, status: d.status, source: json(d.source_json, { kind: "system" }), createdAt: d.created_at })),
    briefs: briefs.map((b) => ({ briefId: b.brief_id, localDate: b.local_date, text: b.text, status: b.status, source: json(b.source_json, { kind: "system" }), createdAt: b.created_at })),
    measurements: measurements.map(rowToMeasurement),
    sizeExperiences: sizes.map((s) => ({ sizeExperienceId: s.size_experience_id, maker: s.maker, productFamily: s.product_family, sizeLabel: s.size_label, note: s.note, notedOn: s.noted_on, passage: json(s.passage_json, null) })),
    factConflicts: conflicts,
    precedence: STYLE_PRECEDENCE_STATEMENT,
    styleRevision: state?.style_revision ?? 0,
  };
}

/** Every version of the style document, newest first (for My style history and export). */
export async function listStyleDocumentVersions(db: Db, principal: Principal, documentId = "owner-profile"): Promise<{ version: number; contentSha256: string; byteLength: number; status: string; createdAt: string }[]> {
  const userId = guard(principal);
  const rows = await all<any>(db, "SELECT version, content_sha256, byte_length, status, created_at FROM style_documents WHERE user_id = ? AND document_id = ? ORDER BY version DESC", userId, documentId);
  return rows.map((r) => ({ version: r.version, contentSha256: r.content_sha256, byteLength: r.byte_length, status: r.status, createdAt: r.created_at }));
}

export type { GarmentAvailability };
