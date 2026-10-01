/**
 * The functions other workstreams mount: preparing and rebuilding boards, ad hoc recommendations,
 * outfit validation and suggestions for Studio, the temperature preview, and the background
 * replenishment sweep. Everything that writes does so through `board.publish` on the command service.
 */
import type { CommandReceipt, Role } from "@garderobe/contracts";
import { DayBrief, SuggestOutfitsInput, ValidateOutfitInput } from "@garderobe/contracts/ext/daily";
import type { BoardDocument, BoardGarmentLine, BoardOption, CalendarSnapshot, OutfitSlot, OutfitValidation, SuggestedOutfit, TemperaturePreview, WeatherSnapshot } from "@garderobe/contracts/ext/daily";
import { all, assertPrincipal, CommandError, first, isCommandError, json, localDateOf, newId, prepare, requireScope, stmt, type Db, type Principal } from "@garderobe/domain";
import { assembleContext, calendarSnapshotById, dailySettings, loadOwner, weatherSnapshotById } from "./context.ts";
import { WEATHER_ROLES } from "./boards.ts";
import { eligibleFor, factualReason } from "./compose.ts";
import { composeBoard, type ComposedOption, type ComposeDiagnostics } from "./compose.ts";
import { execAs, loadComfort, modelOf, nowOf, type DailyDeps } from "./deps.ts";
import { buildBoardDocument, getBoard, loadBoard, loadOptions, loadRevision, type BoardRow, type StoredOption } from "./document.ts";
import { parseScope, type RecommendationContext } from "./model.ts";
import { repairOptions } from "./repair.ts";
import { fetchWeatherSnapshot, readCalendarSnapshot } from "./snapshots.ts";
import { garmentViolations, validateCandidate } from "./validate.ts";

/* ------------------------------------------------------------------ */
/* Validation and Studio reads                                          */
/* ------------------------------------------------------------------ */

/**
 * Validate a combination against the owner's real stock, restrictions, rules and the stored forecast
 * for the date. Reads only; never fetches weather and never writes.
 */
export async function validateOutfit(db: Db, principal: Principal, input: ValidateOutfitInput & { nowMs?: number }): Promise<OutfitValidation> {
  assertPrincipal(principal);
  requireScope(principal, "read");
  const p = ValidateOutfitInput.parse(input);
  const rc = await assembleContext(db, principal, { localDate: p.forDate, nowMs: input.nowMs ?? Date.now(), scope: p.tripId ? `trip:${p.tripId}` : "home", mode: p.mode, withoutProfileText: true });
  return validateCandidate(rc, { slots: p.slots, footwearAlternatives: p.footwearAlternatives }, { allowRepeat: p.allowRepeat, explicitGarmentIds: p.explicitGarmentIds, ignoreBriefInclusions: true });
}

/** "Find something that works with this": fill the unlocked slots around the locked pieces. */
export async function suggestOutfits(db: Db, principal: Principal, input: SuggestOutfitsInput & { nowMs?: number }): Promise<SuggestedOutfit[]> {
  assertPrincipal(principal);
  requireScope(principal, "read");
  const p = SuggestOutfitsInput.parse(input);
  const rc = await assembleContext(db, principal, { localDate: p.forDate, nowMs: input.nowMs ?? Date.now(), scope: p.tripId ? `trip:${p.tripId}` : "home", mode: p.mode, withoutProfileText: true });
  const lockedIds = p.locked.map((s) => s.garmentId);
  const result = await composeBoard(rc, { locked: p.locked, count: p.limit, reserveCount: 0, validate: { ignoreBriefInclusions: true, explicitGarmentIds: lockedIds } });
  const keepRoles = new Set<Role>(["top", "bottom", "footwear", "socks", ...p.locked.map((s) => s.role), ...p.openRoles]);
  return result.options.map((o) => {
    const slots = p.openRoles.length > 0 ? o.slots.filter((s) => keepRoles.has(s.role)) : o.slots;
    const validation = slots.length === o.slots.length ? o.validation : validateCandidate(rc, { slots, footwearAlternatives: o.footwearAlternatives }, { ignoreBriefInclusions: true, explicitGarmentIds: lockedIds });
    return { slots, reason: o.reason, validation };
  });
}

export const outfitValidator = { validate: validateOutfit, suggest: suggestOutfits };

const THERMAL_CODES = new Set(["thermal_too_warm", "thermal_too_cold", "fabric_rule", "outerwear_ceiling"]);

/**
 * What becomes wearable at a chosen temperature, including pieces in seasonal storage. A SIMULATION:
 * it reads the ledger and changes nothing.
 */
export async function temperaturePreview(db: Db, principal: Principal, input: { temperatureC: number; nowMs?: number }): Promise<TemperaturePreview> {
  assertPrincipal(principal);
  requireScope(principal, "read");
  const nowMs = input.nowMs ?? Date.now();
  const owner = await loadOwner(db, principal.userId);
  const today = localDateOf(nowMs, owner.settings.timezone);
  const t = input.temperatureC;
  const rc = await assembleContext(db, principal, {
    localDate: today,
    nowMs,
    mode: "explore",
    withoutProfileText: true,
    conditions: { freshness: "fresh", snapshotId: null, peakC: t, peakInterval: "simulated", departureC: t, departureInterval: "simulated", eveningReturnC: t, maxPrecipitationProbabilityPct: null, precipitationMm: null, rainLikelyFromHour: null, maxWindGustKmh: null, segment: "day" },
  });
  const wearable: TemperaturePreview["wearable"] = [];
  const notWearable: TemperaturePreview["notWearable"] = [];
  for (const g of rc.garments.values()) {
    if (g.availability.acquisition !== "owned" || g.availability.planningPolicy === "excluded") continue;
    const role = g.roles[0];
    if (!role || !["top", "mid_layer", "bottom", "outer", "socks"].includes(role)) continue;
    const thermal = garmentViolations(rc, g.garmentId, role).filter((x) => THERMAL_CODES.has(x.code));
    if (thermal.length > 0) notWearable.push({ garmentId: g.garmentId, name: g.name, role, why: thermal[0]!.message });
    else wearable.push({ garmentId: g.garmentId, name: g.name, role, inStorage: g.inStorage > 0 && g.availability.cleanObserved === 0, basis: g.thermal ? g.thermal.source : g.seasonNote ? `no temperature limit recorded (sheet season: ${g.seasonNote})` : "no temperature limit recorded" });
  }
  return { simulation: true, label: `Simulation at ${t} °C. Actual availability, laundry and restrictions are unchanged.`, temperatureC: t, wearable, notWearable };
}

/* ------------------------------------------------------------------ */
/* Preparing a board                                                    */
/* ------------------------------------------------------------------ */

export interface PrepareBoardOptions {
  localDate: string;
  scope?: string;
  reason?: BoardDocument["reason"];
  brief?: DayBrief;
  count?: number;
  purpose: "evening_compose" | "morning_refresh" | "adhoc" | "trip" | "resume";
  /** Stable identity of this request; retries with the same key publish at most once. */
  idempotencyKey: string;
  nowMs?: number;
  /** Destination for a trip board's forecast. */
  location?: { label: string; latitude?: number; longitude?: number; timezone?: string };
  /** Use these snapshots instead of fetching. */
  weather?: WeatherSnapshot;
  calendar?: CalendarSnapshot | null;
  /** Offered options to keep exactly as they are (replenishment / refresh). */
  keep?: StoredOption[];
  avoidTops?: string[];
}

export interface PrepareBoardResult {
  board: BoardDocument | null;
  receipt: CommandReceipt | null;
  /** Why nothing was published, when nothing was. */
  note: string | null;
  requestedCount: number;
  diagnostics: ComposeDiagnostics | null;
}

function toPublishOption(o: ComposedOption) {
  return { ...(o.optionId ? { optionId: o.optionId } : {}), slots: o.slots, footwearAlternatives: o.footwearAlternatives, reason: o.reason, explanationSource: o.explanationSource, removedClaims: o.removedClaims, explicitGarmentIds: o.explicitGarmentIds ?? [], source: o.source, suitsEventIds: o.suitsEventIds };
}

function storedToComposed(rc: RecommendationContext, o: StoredOption): ComposedOption {
  return { optionId: o.optionId, slots: o.slots, footwearAlternatives: o.footwearAlternatives, reason: o.reason, explanationSource: o.evidence.explanationSource, removedClaims: o.evidence.removedClaims, explicitGarmentIds: o.evidence.explicitGarmentIds ?? [], source: o.evidence.source, suitsEventIds: o.suitsEventIds, validation: validateCandidate(rc, o, { requirePairedFootwear: true, explicitGarmentIds: o.evidence.explicitGarmentIds ?? [] }), jointAvailability: o.evidence.jointAvailability, score: 1000 };
}

/** Combinations the owner chose before: revalidated for the day, they still make a useful board without inference. */
async function approvedCombinations(db: Db, userId: string, localDate: string): Promise<{ slots: OutfitSlot[]; footwearAlternatives: string[]; reason: string }[]> {
  const rows = await all<{ slots_json: string; footwear_alternatives_json: string; reason: string }>(
    db,
    `SELECT o.slots_json, o.footwear_alternatives_json, o.reason FROM boards b
       JOIN board_options o ON o.user_id = b.user_id AND o.board_id = b.board_id AND o.revision = b.current_revision AND o.option_id = b.selected_option_id
      WHERE b.user_id = ? AND b.selected_option_id IS NOT NULL AND b.local_date < ? ORDER BY b.local_date DESC LIMIT 20`,
    userId, localDate,
  );
  return rows.map((r) => ({ slots: json<OutfitSlot[]>(r.slots_json, []), footwearAlternatives: json<string[]>(r.footwear_alternatives_json, []), reason: r.reason }));
}

/**
 * Assemble the context (weather and calendar are fetched here, never by a model), compose, and
 * publish through `board.publish`, which rechecks state. If the wardrobe changed underneath the
 * composition the stale candidates do not commit and a bounded recomposition uses the new state.
 */
export async function prepareBoard(deps: DailyDeps, principal: Principal, opts: PrepareBoardOptions): Promise<PrepareBoardResult> {
  assertPrincipal(principal);
  requireScope(principal, "write");
  const nowMs = nowOf(deps, opts.nowMs);
  const scope = opts.scope ?? "home";
  const parsed = parseScope(scope);
  const brief = DayBrief.parse({ ...(opts.brief ?? {}), ...(parsed.evening ? { segment: "evening" } : {}) });
  const weather = opts.weather ?? (await fetchWeatherSnapshot(deps, principal, { localDate: opts.localDate, purpose: opts.purpose, segment: brief.segment, location: opts.location, nowMs }));
  // A scheduled phase reads the calendar itself; an ad hoc request reuses a read inside the freshness threshold.
  const calendar = opts.calendar !== undefined ? opts.calendar : await readCalendarSnapshot(deps, principal, { localDate: opts.localDate, scope, nowMs, ...(opts.purpose === "adhoc" ? { maxAgeMinutes: dailySettings((await loadOwner(deps.db, principal.userId)).settings).calendarMaxAgeMinutes } : {}) });
  const approved = await approvedCombinations(deps.db, principal.userId, opts.localDate);
  const comfort = await loadComfort(deps, principal);

  let last: PrepareBoardResult = { board: null, receipt: null, note: null, requestedCount: 0, diagnostics: null };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const rc = await assembleContext(deps.db, principal, { localDate: opts.localDate, nowMs, scope, brief, weather, calendar, comfort });
    const keep = (opts.keep ?? []).map((o) => storedToComposed(rc, o)).filter((o) => o.validation.valid);
    const composed = await composeBoard(rc, { count: opts.count, model: modelOf(deps, principal), modelBudgetMs: deps.modelBudgetMs, maxModelAttempts: deps.maxModelAttempts ?? 2, deadlineAtMs: nowMs + 120_000, approved, keep, avoidTops: opts.avoidTops });
    last = { board: null, receipt: null, note: composed.notice, requestedCount: composed.requestedCount, diagnostics: composed.diagnostics };
    if (composed.options.length === 0) return last;
    try {
      const receipt = await execAs(deps, principal, "board.publish", {
        localDate: opts.localDate,
        scope,
        reason: opts.reason ?? "compose",
        options: composed.options.map(toPublishOption),
        reserves: composed.reserves.map(toPublishOption),
        brief,
        requestedCount: composed.requestedCount,
        weatherSnapshotId: weather.snapshotId,
        calendarSnapshotId: calendar?.snapshotId ?? null,
        notice: composed.notice,
        composedAgainst: { wardrobeRevision: rc.revisions.wardrobeRevision, styleRevision: rc.revisions.styleRevision },
      }, `${opts.idempotencyKey}:${attempt}`);
      const board = await loadBoard(deps.db, principal.userId, { date: opts.localDate, scope });
      last = { board: board ? await buildBoardDocument(deps.db, principal.userId, board) : null, receipt, note: composed.notice, requestedCount: composed.requestedCount, diagnostics: composed.diagnostics };
      const dropped = ((receipt.result as any)?.dropped ?? []) as unknown[];
      // Something went stale between composition and publication: recompose once more from the new state.
      if (dropped.length > 0 && Number((receipt.result as any)?.offered ?? 0) < composed.options.length && !receipt.replayed) continue;
      return last;
    } catch (e) {
      if (isCommandError(e) && e.code === "idempotency_key_reuse") {
        // The same request was already published; return what is there now.
        const board = await loadBoard(deps.db, principal.userId, { date: opts.localDate, scope });
        return { ...last, board: board ? await buildBoardDocument(deps.db, principal.userId, board) : null };
      }
      if (isCommandError(e) && e.code === "precondition_failed" && (e.details as any)?.dropped) continue; // every candidate went stale: recompose
      throw e;
    }
  }
  return last;
}

/* ------------------------------------------------------------------ */
/* Ad hoc recommendations                                               */
/* ------------------------------------------------------------------ */

export interface RecommendInput {
  clientRequestId: string;
  date?: string;
  brief?: Partial<DayBrief>;
  count?: number;
  lockedGarmentIds?: string[];
  occasionOnly?: boolean;
  mode: "preview" | "board";
  nowMs?: number;
}

export interface RecommendResult {
  state: "completed";
  options: BoardOption[];
  board: BoardDocument | null;
  insufficient: boolean;
  note: string | null;
}

const LINE_ORDER: Role[] = ["outer", "mid_layer", "top", "one_piece", "bottom", "belt", "socks", "footwear", "accessory"];

function previewOptions(rc: RecommendationContext, options: ComposedOption[]): BoardOption[] {
  const line = (garmentId: string, role: Role): BoardGarmentLine => ({ garmentId, role, name: rc.garments.get(garmentId)?.name ?? "Unknown garment", colour: rc.garments.get(garmentId)?.colour ?? null });
  return options.map((o, i) => {
    const top = o.slots.find((s) => s.role === "top" || s.role === "one_piece");
    const bottom = o.slots.find((s) => s.role === "bottom");
    const flourish = o.slots.find((s) => s.role === "neckwear");
    return {
      optionId: `preview-${i + 1}`,
      number: i + 1,
      name: [top, bottom].filter(Boolean).map((s) => rc.garments.get(s!.garmentId)?.name ?? "").join(" with "),
      reason: o.reason,
      garments: o.slots.filter((s) => s.role !== "neckwear").sort((a, b) => LINE_ORDER.indexOf(a.role) - LINE_ORDER.indexOf(b.role)).map((s) => line(s.garmentId, s.role)),
      footwearAlternatives: o.footwearAlternatives.map((id) => line(id, "footwear")),
      flourish: flourish ? line(flourish.garmentId, "neckwear") : null,
      suitsEventIds: o.suitsEventIds,
      qualification: null,
      changedInRevision: false,
    };
  });
}

/**
 * Request outfits with a brief, a date and a count. `preview` writes nothing; `board` publishes the
 * day's board (or its evening board for an evening brief). A requested count never justifies
 * unavailable garments: fewer valid options come back with a note.
 */
export async function recommend(deps: DailyDeps, principal: Principal, input: RecommendInput): Promise<RecommendResult> {
  assertPrincipal(principal);
  requireScope(principal, "read");
  const nowMs = nowOf(deps, input.nowMs);
  const owner = await loadOwner(deps.db, principal.userId);
  const localDate = input.date ?? localDateOf(nowMs, owner.settings.timezone);
  const brief = DayBrief.parse({ ...(input.brief ?? {}), requestedCount: input.count ?? input.brief?.requestedCount ?? null, include: [...new Set([...(input.brief?.include ?? []), ...(input.lockedGarmentIds ?? [])])], occasionOnly: input.occasionOnly ?? input.brief?.occasionOnly ?? false });
  const scope = brief.segment === "evening" ? "home:evening" : "home";

  if (input.mode === "preview") {
    const weather = await fetchWeatherSnapshot(deps, principal, { localDate, purpose: "adhoc", segment: brief.segment, nowMs, record: false });
    const calendar = await readCalendarSnapshot(deps, principal, { localDate, scope, nowMs, record: false });
    const rc = await assembleContext(deps.db, principal, { localDate, nowMs, scope, brief, weather, calendar, comfort: await loadComfort(deps, principal) });
    const composed = await composeBoard(rc, { model: modelOf(deps, principal), modelBudgetMs: deps.modelBudgetMs, maxModelAttempts: deps.maxModelAttempts ?? 2, reserveCount: 0, deadlineAtMs: nowMs + 120_000 });
    return { state: "completed", options: previewOptions(rc, composed.options), board: null, insufficient: composed.options.length < composed.requestedCount, note: composed.notice };
  }

  requireScope(principal, "write");
  const existing = await loadBoard(deps.db, principal.userId, { date: localDate, scope });
  if (existing?.status === "worn") {
    const doc = await buildBoardDocument(deps.db, principal.userId, existing);
    return { state: "completed", options: [], board: doc, insufficient: true, note: "The day's outfit is already recorded; ask for an evening outfit or amend the wear instead." };
  }
  try {
    const result = await prepareBoard(deps, principal, { localDate, scope, reason: existing ? "rebuild" : "compose", brief, purpose: "adhoc", idempotencyKey: `recommend:${input.clientRequestId}`, nowMs });
    return { state: "completed", options: result.board?.options ?? [], board: result.board, insufficient: (result.board?.options.length ?? 0) < result.requestedCount, note: result.board?.notice ?? result.note };
  } catch (e) {
    if (isCommandError(e) && e.code === "precondition_failed") {
      const board = await getBoard(deps.db, principal, { date: localDate, scope });
      return { state: "completed", options: [], board, insufficient: true, note: e.message };
    }
    throw e;
  }
}

/** Rebuild the whole day with fresh sources; the brief persists unless a new one is given. */
export async function rebuildDay(deps: DailyDeps, principal: Principal, input: { date: string; scope?: string; clientRequestId: string; brief?: DayBrief; nowMs?: number }): Promise<PrepareBoardResult> {
  const scope = input.scope ?? "home";
  const existing = await loadBoard(deps.db, principal.userId, { date: input.date, scope });
  const revision = existing ? await loadRevision(deps.db, principal.userId, existing.board_id, existing.current_revision) : null;
  return prepareBoard(deps, principal, { localDate: input.date, scope, reason: existing ? "rebuild" : "compose", brief: input.brief ?? revision?.brief, purpose: "adhoc", idempotencyKey: `rebuild-day:${input.clientRequestId}`, nowMs: input.nowMs });
}

function storedToPublish(o: StoredOption) {
  return { optionId: o.optionId, slots: o.slots, footwearAlternatives: o.footwearAlternatives, reason: o.reason, explanationSource: o.evidence.explanationSource, removedClaims: o.evidence.removedClaims, explicitGarmentIds: o.evidence.explicitGarmentIds ?? [], source: o.evidence.source, suitsEventIds: o.suitsEventIds };
}

async function boardContext(deps: DailyDeps, principal: Principal, board: BoardRow, nowMs: number, overrides: { weather?: WeatherSnapshot; calendar?: CalendarSnapshot | null } = {}) {
  const revision = (await loadRevision(deps.db, principal.userId, board.board_id, board.current_revision))!;
  const weather = overrides.weather ?? (revision.weather_snapshot_id ? await weatherSnapshotById(deps.db, principal.userId, revision.weather_snapshot_id) : null);
  const calendar = overrides.calendar !== undefined ? overrides.calendar : revision.calendar_snapshot_id ? await calendarSnapshotById(deps.db, principal.userId, revision.calendar_snapshot_id) : null;
  const rc = await assembleContext(deps.db, principal, { localDate: board.local_date, nowMs, scope: board.scope, brief: revision.brief, ...(overrides.weather ? {} : { conditions: revision.conditions }), weather, calendar, comfort: await loadComfort(deps, principal) });
  const stored = await loadOptions(deps.db, principal.userId, board.board_id, board.current_revision);
  return { revision, weather, calendar, rc, stored };
}

/** Rebuild one option; every other option, the brief and the sources stay as they are. */
export async function rebuildOption(deps: DailyDeps, principal: Principal, input: { boardId: string; optionId: string; clientRequestId: string; nowMs?: number }): Promise<{ board: BoardDocument; receipt: CommandReceipt | null; note: string | null }> {
  assertPrincipal(principal);
  requireScope(principal, "write");
  const nowMs = nowOf(deps, input.nowMs);
  const board = await loadBoard(deps.db, principal.userId, { boardId: input.boardId });
  if (!board) throw new Error("unknown board");
  const { revision, weather, calendar, rc, stored } = await boardContext(deps, principal, board, nowMs);
  const offered = stored.filter((o) => o.state === "offered");
  const target = offered.find((o) => o.optionId === input.optionId);
  const doc = async () => buildBoardDocument(deps.db, principal.userId, (await loadBoard(deps.db, principal.userId, { boardId: input.boardId }))!);
  if (!target) return { board: await doc(), receipt: null, note: "That option is not on the current board revision." };
  const keep = offered.filter((o) => o.optionId !== target.optionId).map((o) => storedToComposed(rc, o));
  const oldTop = target.slots.find((s) => s.role === "top")?.garmentId;
  const composed = await composeBoard(rc, { count: offered.length, reserveCount: 0, model: modelOf(deps, principal), modelBudgetMs: deps.modelBudgetMs, maxModelAttempts: deps.maxModelAttempts ?? 1, keep, avoidTops: oldTop && !revision.brief.include.includes(oldTop) ? [oldTop] : [] });
  const fresh = composed.options.find((o) => !o.optionId);
  if (!fresh) return { board: await doc(), receipt: null, note: "Nothing else eligible makes a different valid outfit today; the option is unchanged." };
  const options = offered.map((o) => (o.optionId === target.optionId ? toPublishOption(fresh) : storedToPublish(o)));
  const receipt = await execAs(deps, principal, "board.publish", {
    localDate: board.local_date, scope: board.scope, reason: "rebuild", options, reserves: stored.filter((o) => o.state === "reserve").map(storedToPublish), brief: revision.brief, requestedCount: revision.requested_count,
    weatherSnapshotId: weather?.snapshotId ?? null, calendarSnapshotId: calendar?.snapshotId ?? null, notice: null,
  }, `rebuild-option:${input.clientRequestId}`, { expectedVersions: { [`board:${board.board_id}`]: board.current_revision } });
  return { board: await doc(), receipt, note: null };
}

/** Destination of a trip board's day, for its forecast. */
async function boardLocation(db: Db, userId: string, board: BoardRow): Promise<{ label: string; latitude?: number; longitude?: number; timezone?: string } | undefined> {
  const { tripId } = parseScope(board.scope);
  if (!tripId) return undefined;
  const trip = await first<{ destinations_json: string }>(db, "SELECT destinations_json FROM trips WHERE user_id = ? AND trip_id = ?", userId, tripId);
  const destinations = json<{ label: string; latitude?: number; longitude?: number; timezone: string; from: string; to: string }[]>(trip?.destinations_json ?? "[]", []);
  return destinations.find((d) => d.from <= board.local_date && board.local_date <= d.to) ?? destinations[0];
}

/**
 * A forecast for a board whose stored one is past the freshness threshold (or absent). Returns a
 * snapshot only when the provider supplied something newer than what the board already holds; on an
 * outage the board keeps its basis and its stated limitation.
 */
export async function fresherForecast(deps: DailyDeps, principal: Principal, board: BoardRow, nowMs: number): Promise<WeatherSnapshot | null> {
  const revision = await loadRevision(deps.db, principal.userId, board.board_id, board.current_revision);
  if (!revision) return null;
  const owner = await loadOwner(deps.db, principal.userId);
  const maxAge = dailySettings(owner.settings).weatherMaxAgeMinutes;
  const stored = revision.weather_snapshot_id ? await weatherSnapshotById(deps.db, principal.userId, revision.weather_snapshot_id) : null;
  const storedAge = stored && stored.freshness !== "unavailable" ? (nowMs - Date.parse(stored.fetchedAt)) / 60_000 : Infinity;
  if (storedAge <= maxAge) return null;
  const trip = parseScope(board.scope).base === "trip";
  const snapshot = await fetchWeatherSnapshot(deps, principal, { localDate: board.local_date, purpose: trip ? "trip" : "adhoc", segment: revision.conditions.segment, location: await boardLocation(deps.db, principal.userId, board), nowMs });
  if (snapshot.freshness === "unavailable") return null;
  if (stored && stored.freshness !== "unavailable" && snapshot.fetchedAt <= stored.fetchedAt) return null;
  return snapshot;
}

/**
 * Swap one slot of an option. The weather service is consulted first when the slot depends on the
 * forecast and the board's stored forecast is past its freshness threshold, so the swap - and every
 * other option in the resulting revision - is validated against current conditions. If the provider
 * cannot be reached the swap still works against the last forecast, with its age stated on the board.
 */
export async function swapSlot(deps: DailyDeps, principal: Principal, input: { boardId: string; optionId: string; role: Role; garmentId?: string; clientRequestId: string; expectedRevision?: number; nowMs?: number }): Promise<{ board: BoardDocument; receipt: CommandReceipt }> {
  assertPrincipal(principal);
  requireScope(principal, "write");
  const nowMs = nowOf(deps, input.nowMs);
  const board = await loadBoard(deps.db, principal.userId, { boardId: input.boardId });
  if (!board) throw new CommandError("not_found", `no board '${input.boardId}'`);
  const snapshot = board.status === "active" && WEATHER_ROLES.has(input.role) ? await fresherForecast(deps, principal, board, nowMs) : null;
  const receipt = await execAs(
    deps,
    principal,
    "board.swap_slot",
    { boardId: input.boardId, optionId: input.optionId, role: input.role, ...(input.garmentId ? { garmentId: input.garmentId } : {}), ...(snapshot ? { weatherSnapshotId: snapshot.snapshotId } : {}) },
    `board-swap:${input.clientRequestId}`,
    input.expectedRevision !== undefined ? { expectedVersions: { [`board:${input.boardId}`]: input.expectedRevision } } : {},
  );
  return { board: await buildBoardDocument(deps.db, principal.userId, (await loadBoard(deps.db, principal.userId, { boardId: input.boardId }))!), receipt };
}

/**
 * Decision-scoped mandatory context for an ad hoc outfit question such as "what socks with this?":
 * the actual outfit, what is eligible for the slot in question today, the palette facts and the day's
 * constraints, loaded by the backend (weather included) before any model reasons. It reads the ledger
 * only for the decision at hand; a question that is not about an outfit does not call it.
 */
export async function decisionContext(deps: DailyDeps, principal: Principal, input: { localDate?: string; outfit: OutfitSlot[]; role: Role; tripId?: string; nowMs?: number }): Promise<{
  localDate: string;
  role: Role;
  weather: { line: string; freshness: string; fetchedAt: string; limitation: string | null };
  conditions: RecommendationContext["conditions"];
  outfit: { role: Role; garmentId: string; name: string; colour: string | null; colourFamily: string; fabric: string | null; known: boolean }[];
  candidates: { garmentId: string; name: string; colour: string | null; colourFamily: string; fabric: string | null; availability: string; valid: boolean; reason: string }[];
  rules: { key: string; version: number }[];
  text: string;
}> {
  assertPrincipal(principal);
  requireScope(principal, "read");
  const nowMs = nowOf(deps, input.nowMs);
  const owner = await loadOwner(deps.db, principal.userId);
  const localDate = input.localDate ?? localDateOf(nowMs, owner.settings.timezone);
  const canWrite = principal.scopes.includes("write") || principal.scopes.includes("admin");
  const weather = await fetchWeatherSnapshot(deps, principal, { localDate, purpose: input.tripId ? "trip" : "adhoc", nowMs, record: canWrite });
  const rc = await assembleContext(deps.db, principal, { localDate, nowMs, scope: input.tripId ? `trip:${input.tripId}` : "home", weather, withoutProfileText: true, comfort: await loadComfort(deps, principal) });
  const others = input.outfit.filter((s) => s.role !== input.role);
  const outfit = input.outfit.map((s) => {
    const g = rc.garments.get(s.garmentId);
    return { role: s.role, garmentId: s.garmentId, name: g?.name ?? "Unknown garment", colour: g?.colour ?? null, colourFamily: g?.colourFamily ?? "unknown", fabric: g?.fabric ?? null, known: !!g };
  });
  const candidates = eligibleFor(rc, input.role, { ignoreBriefInclusions: true })
    .filter((g) => !others.some((s) => s.garmentId === g.garmentId))
    .map((g) => {
      const slots = [...others, { role: input.role, garmentId: g.garmentId }];
      const validation = validateCandidate(rc, { slots }, { ignoreBriefInclusions: true });
      // Only problems this piece causes count here; the rest of the outfit is the owner's given.
      const valid = validation.violations.every((x) => x.severity !== "blocking" || !x.garmentIds.includes(g.garmentId));
      return { garmentId: g.garmentId, name: g.name, colour: g.colour, colourFamily: g.colourFamily, fabric: g.fabric, availability: g.availability.status, valid, reason: factualReason(rc, slots) };
    })
    .filter((c) => c.valid);
  const rules = rc.rules.versions.filter((r) => r.status === "active" && r.kind === "hard").map((r) => ({ key: r.key, version: r.version }));
  const text = [
    `Decision: which ${input.role.replace("_", " ")} for ${localDate}.`,
    weather.freshness === "unavailable" ? "The forecast is UNAVAILABLE; nothing may be assumed about temperature, rain or wind." : `${weather.line} (${weather.provider}, ${weather.freshness}).`,
    "Outfit as given:",
    ...outfit.map((o) => `- ${o.role}: ${o.name}${o.colour ? ` (${o.colour}; ${o.colourFamily.replace("_", " ")})` : ""}${o.known ? "" : " [not in the wardrobe]"}`),
    `Eligible ${input.role.replace("_", " ")} today (use the exact garmentId):`,
    ...(candidates.length ? candidates.map((c) => `- ${c.garmentId} | ${c.name} | ${c.colour ?? "colour unknown"} | ${c.fabric ?? "fabric unknown"} | ${c.availability}`) : ["(none)"]),
    `Hard rules in force: ${rules.map((r) => r.key).join(", ") || "(none)"}.`,
  ].join("\n");
  return { localDate, role: input.role, weather: { line: weather.line, freshness: weather.freshness, fetchedAt: weather.fetchedAt, limitation: weather.limitation }, conditions: rc.conditions, outfit, candidates, rules, text };
}

/* ------------------------------------------------------------------ */
/* Background replenishment                                             */
/* ------------------------------------------------------------------ */

export interface ReplenishResult {
  boardId: string;
  localDate: string;
  action: "none" | "repaired" | "replenished" | "refreshed";
  revision: number;
  offered: number;
}

/**
 * Revalidate one board against committed state (optionally under new weather and calendar snapshots),
 * repair what is invalid and fill any gap with newly composed complete options. Existing valid options
 * stay exactly as they are. Publishes a new revision only when something changed or `force` is set.
 */
export async function reviseBoard(deps: DailyDeps, principal: Principal, board: BoardRow, opts: { nowMs: number; reason: "repair" | "replenish" | "refresh" | "resume"; weather?: WeatherSnapshot; calendar?: CalendarSnapshot | null; force?: boolean; idempotencyKey: string }): Promise<ReplenishResult> {
  const { revision, weather, calendar, rc, stored } = await boardContext(deps, principal, board, opts.nowMs, { weather: opts.weather, calendar: opts.calendar });
  const outcome = repairOptions(rc, stored, revision.requested_count);
  const keep: ComposedOption[] = outcome.offered.map((o) => ({ optionId: o.optionId, slots: o.slots, footwearAlternatives: o.footwearAlternatives, reason: o.reason, explanationSource: o.evidence.explanationSource, removedClaims: o.evidence.removedClaims, explicitGarmentIds: o.evidence.explicitGarmentIds ?? [], source: o.evidence.source, suitsEventIds: o.suitsEventIds, validation: o.evidence.validation, jointAvailability: o.evidence.jointAvailability, score: 1000 }));
  const short = keep.length < revision.requested_count || outcome.reserves.length < rc.daily.reserveCount;
  let options = keep;
  let reserves: ComposedOption[] = outcome.reserves.map((o) => ({ optionId: o.optionId, slots: o.slots, footwearAlternatives: o.footwearAlternatives, reason: o.reason, explanationSource: o.evidence.explanationSource, removedClaims: o.evidence.removedClaims, explicitGarmentIds: o.evidence.explicitGarmentIds ?? [], source: o.evidence.source, suitsEventIds: o.suitsEventIds, validation: o.evidence.validation, jointAvailability: o.evidence.jointAvailability, score: 500 }));
  let added = 0;
  let notice: string | null = outcome.shortage;
  if (short) {
    const composed = await composeBoard(rc, { count: revision.requested_count, model: modelOf(deps, principal), modelBudgetMs: deps.modelBudgetMs, maxModelAttempts: deps.maxModelAttempts ?? 1, keep, deadlineAtMs: opts.nowMs + 60_000 });
    added = composed.options.length - keep.length;
    options = composed.options;
    if (composed.reserves.length >= reserves.length) reserves = composed.reserves;
    notice = composed.notice;
  }
  const dayScope = !parseScope(board.scope).evening;
  const missingExposure = dayScope && board.exposure_id === null && options.length > 0;
  const reservesChanged = reserves.length !== stored.filter((o) => o.state === "reserve").length;
  if (!outcome.changed && added === 0 && !opts.force && !missingExposure && !reservesChanged) {
    // Nothing to publish: clear the sweep flag (job bookkeeping, not a domain fact).
    if (board.needs_replenishment === 1) await prepare(deps.db, stmt("UPDATE boards SET needs_replenishment = 0 WHERE user_id = ? AND board_id = ? AND current_revision = ?", principal.userId, board.board_id, board.current_revision)).run();
    return { boardId: board.board_id, localDate: board.local_date, action: "none", revision: board.current_revision, offered: keep.length };
  }
  if (options.length === 0) {
    return { boardId: board.board_id, localDate: board.local_date, action: "none", revision: board.current_revision, offered: 0 };
  }
  const reason = opts.reason === "refresh" || opts.reason === "resume" ? opts.reason : added > 0 ? "replenish" : "repair";
  const receipt = await execAs(deps, principal, "board.publish", {
    localDate: board.local_date, scope: board.scope, reason, options: options.map(toPublishOption), reserves: reserves.map(toPublishOption), brief: revision.brief, requestedCount: revision.requested_count,
    weatherSnapshotId: weather?.snapshotId ?? null, calendarSnapshotId: calendar?.snapshotId ?? null, notice,
  }, opts.idempotencyKey);
  const result = receipt.result as { revision?: number; offered?: number };
  return { boardId: board.board_id, localDate: board.local_date, action: reason === "refresh" || reason === "resume" ? "refreshed" : reason === "replenish" ? "replenished" : "repaired", revision: Number(result.revision ?? board.current_revision), offered: Number(result.offered ?? options.length) };
}

/**
 * The background composer: fills boards the in-commit repair had to shrink and revalidates boards
 * flagged by changes it could not evaluate inside the commit. Existing valid options remain usable
 * throughout; a paused or removed day is left alone.
 */
export async function replenishBoards(deps: DailyDeps, principal: Principal, opts: { nowMs?: number; all?: boolean } = {}): Promise<ReplenishResult[]> {
  assertPrincipal(principal);
  requireScope(principal, "write");
  const nowMs = nowOf(deps, opts.nowMs);
  const owner = await loadOwner(deps.db, principal.userId);
  const today = localDateOf(nowMs, owner.settings.timezone);
  const boards = await all<BoardRow>(deps.db, `SELECT * FROM boards WHERE user_id = ? AND status = 'active' AND local_date >= ? ${opts.all ? "" : "AND needs_replenishment = 1"} ORDER BY local_date, scope`, principal.userId, today);
  const out: ReplenishResult[] = [];
  for (const board of boards) {
    const paused = await first<{ n: number }>(deps.db, "SELECT COUNT(*) AS n FROM service_pauses WHERE user_id = ? AND status = 'active' AND starts_on <= ? AND (resume_on IS NULL OR resume_on > ?)", principal.userId, board.local_date, board.local_date);
    if ((paused?.n ?? 0) > 0 && principal.actor === "system") continue;
    try {
      // A board last checked against a forecast past its freshness threshold is rechecked against a fresh one.
      const weather = deps.weather ? await fresherForecast(deps, principal, board, nowMs) : null;
      out.push(await reviseBoard(deps, principal, board, { nowMs, reason: weather ? "refresh" : "replenish", ...(weather ? { weather, force: true } : {}), idempotencyKey: `replenish:${board.board_id}:r${board.current_revision}:${newId("k")}` }));
    } catch (e) {
      if (!isCommandError(e)) throw e;
      out.push({ boardId: board.board_id, localDate: board.local_date, action: "none", revision: board.current_revision, offered: -1 });
    }
  }
  return out;
}
