/**
 * Mandatory context (specification section 7). A recommendation run, a validation and a repair all
 * start from this server-built snapshot: the day, weather by time window, calendar context, the
 * complete inventory with availability, the full style profile and rules, the recent fortnight's wear,
 * the coming week's selections and recently shown combinations. A model never has to ask for it.
 */
import { DEFAULT_OWNER_SETTINGS, OwnerSettings } from "@garderobe/contracts";
import type { StyleContext, StyleRule } from "@garderobe/contracts";
import { CalendarSnapshot, DailySettings, DayBrief, WeatherSnapshot } from "@garderobe/contracts/ext/daily";
import type { DayConditions, ValidationMode } from "@garderobe/contracts/ext/daily";
import {
  AVAILABILITY_MODEL_VERSION_OR_DEFAULT,
} from "./version.ts";
import { addDays, all, buildEstimatorInput, deepMerge, estimateAll, first, getStyleContext, isCommandError, json, localDateOf, type BalanceRow, type Db, type EstimatorRestriction, type Principal } from "@garderobe/domain";
import { colourFamily, parseScope, unknownConditions, type ComfortObservation, type ContextSource, type PoolGarment, type RecommendationContext } from "./model.ts";
import { buildRuleSet } from "./rules.ts";

/**
 * State the current command is about to commit, laid over what D1 still shows. Used by the in-commit
 * board repair so options are validated against the wardrobe as it will be after the batch.
 */
export interface Overlay {
  balances?: Map<string, BalanceRow[]>;
  planningPolicy?: Map<string, "normal" | "occasional" | "excluded">;
  addRestrictions?: EstimatorRestriction[];
  removeRestrictionIds?: Set<string>;
  /** Garments that stop existing as wearable records (merged away, removed as fabricated). */
  unavailable?: Set<string>;
  addWears?: { garmentId: string; wearingDate: string }[];
  removeWears?: { garmentId: string; wearingDate: string }[];
}

export interface AssembleOptions {
  localDate: string;
  nowMs: number;
  scope?: string;
  mode?: ValidationMode;
  brief?: DayBrief;
  /** Explicit conditions (a board revision's stored basis). Otherwise the latest stored snapshot for the date is used. */
  conditions?: DayConditions;
  weather?: WeatherSnapshot | null;
  calendar?: CalendarSnapshot | null;
  overlay?: Overlay;
  /** Dated comfort observations to carry into ranking and the model context. */
  comfort?: ComfortObservation[];
  /** Skip the full profile text (validation and repair need rules, not prose). */
  withoutProfileText?: boolean;
}

export interface OwnerRow {
  settings: OwnerSettings;
  settingsVersion: number;
  wardrobeRevision: number;
  styleRevision: number;
  status: string;
}

export async function loadOwner(db: Db, userId: string): Promise<OwnerRow> {
  const row = await first<{ status: string; wardrobe_revision: number | null; style_revision: number | null; settings_json: string | null; version: number | null }>(
    db,
    `SELECT u.status, s.wardrobe_revision, s.style_revision, o.settings_json, o.version
       FROM users u LEFT JOIN owner_state s ON s.user_id = u.user_id LEFT JOIN owner_settings o ON o.user_id = u.user_id
      WHERE u.user_id = ?`,
    userId,
  );
  if (!row) throw new Error("unknown owner");
  return {
    status: row.status,
    settings: OwnerSettings.parse(deepMerge(DEFAULT_OWNER_SETTINGS, json(row.settings_json, {}))),
    settingsVersion: row.version ?? 0,
    wardrobeRevision: row.wardrobe_revision ?? 0,
    styleRevision: row.style_revision ?? 0,
  };
}

export function dailySettings(settings: OwnerSettings): DailySettings {
  const raw = settings.extensions["daily"];
  const parsed = DailySettings.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DailySettings.parse({});
}

export async function latestWeatherSnapshot(db: Db, userId: string, localDate: string, trip: boolean): Promise<WeatherSnapshot | null> {
  const row = await first<{ snapshot_json: string }>(
    db,
    `SELECT snapshot_json FROM weather_snapshots WHERE user_id = ? AND local_date = ? AND ${trip ? "purpose = 'trip'" : "purpose != 'trip'"} ORDER BY created_at DESC, snapshot_id DESC LIMIT 1`,
    userId,
    localDate,
  );
  return row ? WeatherSnapshot.parse(JSON.parse(row.snapshot_json)) : null;
}

export async function weatherSnapshotById(db: Db, userId: string, snapshotId: string): Promise<WeatherSnapshot | null> {
  const row = await first<{ snapshot_json: string }>(db, "SELECT snapshot_json FROM weather_snapshots WHERE user_id = ? AND snapshot_id = ?", userId, snapshotId);
  return row ? WeatherSnapshot.parse(JSON.parse(row.snapshot_json)) : null;
}

export async function latestCalendarSnapshot(db: Db, userId: string, localDate: string): Promise<CalendarSnapshot | null> {
  const row = await first<{ snapshot_json: string }>(db, "SELECT snapshot_json FROM calendar_snapshots WHERE user_id = ? AND local_date = ? ORDER BY created_at DESC, snapshot_id DESC LIMIT 1", userId, localDate);
  return row ? CalendarSnapshot.parse(JSON.parse(row.snapshot_json)) : null;
}

export async function calendarSnapshotById(db: Db, userId: string, snapshotId: string): Promise<CalendarSnapshot | null> {
  const row = await first<{ snapshot_json: string }>(db, "SELECT snapshot_json FROM calendar_snapshots WHERE user_id = ? AND snapshot_id = ?", userId, snapshotId);
  return row ? CalendarSnapshot.parse(JSON.parse(row.snapshot_json)) : null;
}

async function loadRules(db: Db, userId: string): Promise<StyleRule[]> {
  const rows = await all<any>(db, "SELECT * FROM style_rules WHERE user_id = ? AND is_current = 1 AND status != 'retired' ORDER BY key", userId);
  return rows.map((r) => ({ ruleId: r.rule_id, version: r.version, key: r.key, kind: r.kind, status: r.status, params: json(r.params_json, {}), interpretation: r.interpretation, passages: json(r.passages_json, []), origin: r.origin, createdAt: r.created_at }));
}

/** Assemble the context for one owner and day. `principal` must be the authenticated owner of `userId`. */
export async function assembleContext(db: Db, principal: Principal, opts: AssembleOptions): Promise<RecommendationContext> {
  const userId = principal.userId;
  const owner = await loadOwner(db, userId);
  const settings = owner.settings;
  const daily = dailySettings(settings);
  const scope = opts.scope ?? "home";
  const parsedScope = parseScope(scope);
  const overlay = opts.overlay ?? {};
  const brief = DayBrief.parse({ ...(opts.brief ?? {}), ...(parsedScope.evening ? { segment: "evening" } : {}) });
  const localDate = opts.localDate;

  // Trip timezone governs "today" for a trip board.
  let timezone = settings.timezone;
  let tripDepartsOn: string | null = null;
  if (parsedScope.tripId) {
    const trip = await first<{ departs_on: string; destinations_json: string }>(db, "SELECT departs_on, destinations_json FROM trips WHERE user_id = ? AND trip_id = ?", userId, parsedScope.tripId);
    if (trip) {
      tripDepartsOn = trip.departs_on;
      const destinations = json<{ timezone: string; from: string; to: string }[]>(trip.destinations_json, []);
      timezone = (destinations.find((d) => d.from <= localDate && localDate <= d.to) ?? destinations[0])?.timezone ?? timezone;
    }
  }
  const today = localDateOf(opts.nowMs, timezone);

  const { input, lastBaseline, garmentRows } = await buildEstimatorInput(db, userId, localDate, settings);

  // Lay the committing command's state over what D1 shows.
  for (const g of input.garments) {
    const b = overlay.balances?.get(g.garmentId);
    if (b) g.balances = b;
    const policy = overlay.planningPolicy?.get(g.garmentId);
    if (policy) g.planningPolicy = policy;
    if (overlay.unavailable?.has(g.garmentId)) g.merged = true;
  }
  if (overlay.removeRestrictionIds?.size) input.restrictions = input.restrictions.filter((r) => !overlay.removeRestrictionIds!.has(r.restrictionId));
  if (overlay.addRestrictions?.length) input.restrictions = [...input.restrictions, ...overlay.addRestrictions];

  // Trip scope: only the physically packed subset is wearable, home stock cannot leak in, and a
  // home laundry baseline never clears uncertainty about clothes in a suitcase.
  const packedClean = new Map<string, number>();
  const storage = new Map<string, number>();
  for (const g of input.garments) {
    storage.set(g.garmentId, g.balances.filter((b) => b.bucket === "storage").reduce((n, b) => n + b.quantity, 0));
    if (parsedScope.tripId) {
      const clean = g.balances.filter((b) => b.bucket === "trip" && b.ref === parsedScope.tripId).reduce((n, b) => n + b.quantity, 0);
      packedClean.set(g.garmentId, clean);
    }
  }
  if (parsedScope.tripId) {
    const tripId = parsedScope.tripId;
    for (const g of input.garments) {
      const clean = packedClean.get(g.garmentId) ?? 0;
      const worn = g.balances.filter((b) => b.bucket === "trip" && b.ref === `${tripId}#dirty`).reduce((n, b) => n + b.quantity, 0);
      g.balances = [
        ...(clean > 0 ? [{ bucket: "clean" as const, ref: "", quantity: clean, held: false }] : []),
        ...(worn > 0 ? [{ bucket: "dirty" as const, ref: "", quantity: worn, held: false }] : []),
      ];
    }
    const from = tripDepartsOn ?? addDays(localDate, -settings.variety.patternHorizonDays);
    input.cutoffDateByChannel = { service: from, handwash: from };
    input.exposures = input.exposures.filter((e) => e.localDate >= from);
  }

  const availability = new Map(estimateAll(input).map((a) => [a.garmentId, a]));

  const horizonStart = addDays(localDate, -Math.max(settings.variety.patternHorizonDays, settings.variety.repeatHorizonDays));
  let wears = await all<{ garmentId: string; wearingDate: string }>(
    db,
    "SELECT garment_id AS garmentId, wearing_date AS wearingDate FROM daily_wears WHERE user_id = ? AND status = 'active' AND wearing_date >= ? AND wearing_date <= ? ORDER BY wearing_date, garment_id",
    userId, horizonStart, localDate,
  );
  if (overlay.removeWears?.length) wears = wears.filter((w) => !overlay.removeWears!.some((r) => r.garmentId === w.garmentId && r.wearingDate === w.wearingDate));
  for (const w of overlay.addWears ?? []) {
    if (w.wearingDate >= horizonStart && w.wearingDate <= localDate && !wears.some((x) => x.garmentId === w.garmentId && x.wearingDate === w.wearingDate)) wears.push(w);
  }
  const wornByGarment = new Map<string, string[]>();
  for (const w of wears) wornByGarment.set(w.garmentId, [...(wornByGarment.get(w.garmentId) ?? []), w.wearingDate].sort());

  const garments = new Map<string, PoolGarment>();
  for (const r of garmentRows) {
    if (r.merged_into !== null) continue;
    const avail = availability.get(r.garment_id);
    if (!avail) continue;
    garments.set(r.garment_id, {
      garmentId: r.garment_id,
      name: r.name,
      category: r.category,
      roles: json(r.roles_json, []),
      colour: r.colour,
      fabric: r.fabric,
      maker: r.maker,
      pattern: r.pattern,
      careChannel: r.care_channel,
      attributes: json(r.attributes_json, {}),
      thermal: json(r.thermal_json, null),
      seasonNote: r.season_note,
      availability: avail,
      wornDates: wornByGarment.get(r.garment_id) ?? [],
      colourFamily: colourFamily(r.colour ?? r.name),
      packedClean: packedClean.get(r.garment_id) ?? 0,
      inStorage: storage.get(r.garment_id) ?? 0,
    });
  }

  const ruleRows = await loadRules(db, userId);
  const activeRestrictionIds = new Set(input.restrictions.map((r) => r.restrictionId));
  const rules = buildRuleSet(ruleRows, { activeRestrictionIds, repeatHorizonDays: settings.variety.repeatHorizonDays, patternHorizonDays: settings.variety.patternHorizonDays });

  let style: StyleContext | null = null;
  if (!opts.withoutProfileText) {
    try {
      style = await getStyleContext(db, principal, { forDate: localDate });
    } catch (e) {
      if (!(isCommandError(e) && e.code === "not_found")) throw e;
    }
  }

  const weather = opts.weather !== undefined ? opts.weather : await latestWeatherSnapshot(db, userId, localDate, parsedScope.base === "trip");
  const calendar = opts.calendar !== undefined ? opts.calendar : await latestCalendarSnapshot(db, userId, localDate);
  const segment = brief.segment;
  let conditions = opts.conditions ?? (weather && weather.conditions.segment === segment ? weather.conditions : null) ?? unknownConditions(segment);
  if (conditions.segment !== segment) conditions = { ...conditions, segment };

  // The coming week's selections (intentions, never reservations) and the fortnight's shown combinations.
  const selectedRows = await all<{ board_id: string; local_date: string; garment_id: string }>(
    db,
    `SELECT b.board_id, b.local_date, g.garment_id FROM boards b
       JOIN board_option_garments g ON g.user_id = b.user_id AND g.board_id = b.board_id AND g.revision = b.current_revision AND g.option_id = b.selected_option_id
      WHERE b.user_id = ? AND b.status = 'active' AND b.selected_option_id IS NOT NULL AND b.local_date >= ? AND b.local_date <= ? AND NOT (b.local_date = ? AND b.scope = ?) AND g.alternative = 0`,
    userId, today, addDays(localDate, 7), localDate, scope,
  );
  const futureSelections = new Map<string, { localDate: string; boardId: string; garmentIds: string[] }>();
  for (const r of selectedRows) {
    const entry = futureSelections.get(r.board_id) ?? { localDate: r.local_date, boardId: r.board_id, garmentIds: [] };
    entry.garmentIds.push(r.garment_id);
    futureSelections.set(r.board_id, entry);
  }
  const shownRows = await all<{ local_date: string; option_id: string; board_id: string; garment_id: string; role: string }>(
    db,
    `SELECT b.local_date, o.option_id, b.board_id, g.garment_id, g.role FROM boards b
       JOIN board_options o ON o.user_id = b.user_id AND o.board_id = b.board_id AND o.revision = b.current_revision AND o.state = 'offered'
       JOIN board_option_garments g ON g.user_id = o.user_id AND g.board_id = o.board_id AND g.revision = o.revision AND g.option_id = o.option_id
      WHERE b.user_id = ? AND b.local_date >= ? AND b.local_date <= ? AND NOT (b.local_date = ? AND b.scope = ?) AND g.alternative = 0 AND g.role IN ('top', 'bottom', 'footwear')`,
    userId, addDays(localDate, -settings.variety.patternHorizonDays), addDays(localDate, 7), localDate, scope,
  );
  const shown = new Map<string, { localDate: string; topId: string | null; bottomId: string | null; footwearId: string | null }>();
  for (const r of shownRows) {
    const key = `${r.board_id}:${r.option_id}`;
    const entry = shown.get(key) ?? { localDate: r.local_date, topId: null, bottomId: null, footwearId: null };
    if (r.role === "top") entry.topId = r.garment_id;
    if (r.role === "bottom") entry.bottomId = r.garment_id;
    if (r.role === "footwear") entry.footwearId = r.garment_id;
    shown.set(key, entry);
  }

  const sources: ContextSource[] = [
    { name: "wardrobe", revision: String(owner.wardrobeRevision), status: "read" },
    { name: "style", revision: String(owner.styleRevision), status: style ? `profile v${style.document.version} sha256 ${style.document.contentSha256.slice(0, 12)}` : opts.withoutProfileText ? "rules only" : "no profile imported" },
    { name: "settings", revision: String(owner.settingsVersion), status: "read" },
    { name: "availability_model", revision: AVAILABILITY_MODEL_VERSION_OR_DEFAULT, status: lastBaseline ? `laundry baseline ${lastBaseline.cycleKey}` : "no laundry baseline applied yet" },
    { name: "weather", revision: weather?.fetchedAt ?? "none", status: weather ? weather.freshness : "unavailable" },
    { name: "calendar", revision: calendar?.readAt ?? "none", status: calendar ? calendar.status : "not_read" },
    { name: "wear_history", revision: `${horizonStart}..${localDate}`, status: `${wears.length} counted wears` },
  ];

  return {
    userId,
    localDate,
    today,
    timezone,
    nowMs: opts.nowMs,
    scope,
    tripId: parsedScope.tripId,
    mode: opts.mode ?? "for_today",
    garments,
    estimator: input,
    conditions,
    weather,
    calendar,
    style,
    rules,
    settings,
    daily,
    brief,
    wears,
    futureSelections: [...futureSelections.values()],
    recentlyShown: [...shown.values()],
    comfort: opts.comfort ?? [],
    revisions: { wardrobeRevision: owner.wardrobeRevision, styleRevision: owner.styleRevision, settingsVersion: owner.settingsVersion },
    sources,
  };
}
