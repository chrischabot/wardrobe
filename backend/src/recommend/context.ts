import type { AvailabilityEstimate, DailyWear, GarmentRole, StockBucket } from '@garderobe/contracts';
import { evaluateEligibility } from '../domain/availability.js';
import { parseJson } from '../domain/db.js';
import { estimateAvailability, probabilityFewerThan, poolOf } from '../domain/estimator.js';
import { listLaundryResets, loadSettings } from '../domain/laundry.js';
import { assertPrincipal, type Principal } from '../domain/principal.js';
import { listDailyWears } from '../domain/queries.js';
import type { GarmentRow, LotRow } from '../domain/records.js';
import { loadAllLots } from '../domain/records.js';
import { loadActiveRestrictions } from '../domain/restrictions.js';
import { getStyleContext, type StyleContext } from '../domain/style.js';
import { addDays } from '../domain/time.js';
import { interpretCalendarDay, readCalendarDay, type CalendarDayBrief, type CalendarSnapshot, type Occasion } from '../calendar/brief.js';
import type { CalendarSource } from '../calendar/types.js';
import { loadSuitcaseWindows, loadTripItems, loadUnitsInSuitcases, type TripDestination, type TripRecord } from '../trips/store.js';
import { DEFAULT_DAY_WINDOW, interpretDay, resolveLocation, thermalBasis, type DayWeather, type WearingWindow, type WeatherSkill } from '../weather/skill.js';
import type { WeatherLocation } from '../weather/types.js';
import { familiesOf, isStatementPiece, thermalBand, type WardrobeGarment } from './garments.js';
import { buildComfortContext, comfortEvidence, loadComfortObservations, type ComfortContext } from './comfort.js';
import { compileProfilePolicy, type ProfilePolicy } from './profile.js';

/**
 * Mandatory context (spec section 7): a server-built snapshot assembled by trusted code before any
 * composition, with or without a model. It contains the day and location, weather by time window,
 * calendar context, the complete wardrobe with eligibility and estimates (retrieval never silently
 * omits a category or status), the full style profile with rules, briefs and restrictions, the
 * recent fortnight's wears, the coming week's selections and recently shown combinations. Every
 * source carries an observation time or revision; missing calendar access is distinct from an empty
 * calendar and a stale forecast is distinct from a fresh one.
 */

export const CONTEXT_VERSION = 'mandatory-context/1';

export interface ComposeRequest {
  /** Local date of the board. */
  date: string;
  /** 'day' (home) or `trip:<tripId>`. */
  purpose?: string;
  /** Wearing interval and departure; `eveningOnly` for an explicitly evening-only outfit. */
  window?: Partial<WearingWindow>;
  /** A direct count request (1–10). It changes how many options are shown, never which garments qualify. */
  requestedCount?: number | null;
  /** Owner's explicit occasion for the day (wins over calendar inference); null = none. */
  occasion?: Occasion | null;
  /** Only an explicit request optimises every option for the occasion. */
  wholeBoardOccasion?: boolean;
  /** Garments the owner asked for (occasional pieces become eligible only this way). */
  include?: string[];
  /** Garments the owner does not want today. */
  exclude?: string[];
  briefText?: string | null;
  forceWeatherRefresh?: boolean;
  /** Weather location override for packing proposals (home stock, destination weather). */
  destination?: TripDestination | null;
  /** Variety seed; defaults to the date so composition is deterministic per day. */
  seed?: string;
}

export interface ContextDeps {
  db: D1Database;
  weather: WeatherSkill | null;
  calendar: CalendarSource | null;
  now: string;
}

export interface SourceStamp {
  source: 'wardrobe' | 'weather' | 'calendar' | 'style' | 'wears' | 'laundry';
  status: 'fresh' | 'stale' | 'missing' | 'unavailable';
  observedAt: string | null;
  revision: string | null;
  detail: string | null;
}

export interface MandatoryContext {
  contextVersion: typeof CONTEXT_VERSION;
  builtAt: string;
  day: { date: string; timezone: string; purpose: string; window: WearingWindow; requestedCount: number; defaultCount: number; briefText: string | null };
  location: WeatherLocation | null;
  weather: DayWeather;
  thermal: ReturnType<typeof thermalBasis>;
  calendar: { snapshot: CalendarSnapshot; brief: CalendarDayBrief; wholeBoardOccasion: boolean };
  style: StyleContext;
  policy: ProfilePolicy;
  wardrobe: WardrobeGarment[];
  byId: Map<string, WardrobeGarment>;
  request: { include: string[]; exclude: string[] };
  /** Owner comfort directions and observations, scoped to garment and today's situation. */
  comfort: ComfortContext;
  recentWears: DailyWear[];
  comingSelections: { date: string; optionId: string; garmentIds: string[] }[];
  recentlyShown: { date: string; garmentIds: string[][] }[];
  trip: { trip: TripRecord; packed: Map<string, number> } | null;
  sources: SourceStamp[];
  /** Count of availability-changing commands (board_revalidation effects) at build time; publication re-checks it. */
  watermark: number;
  seed: string;
}

export async function revalidationWatermark(db: D1Database, userId: string): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM command_effects WHERE user_id = ? AND kind = 'board_revalidation'").bind(userId).first<{ n: number }>();
  return r?.n ?? 0;
}

function mergeUnits(lots: LotRow[]): Record<StockBucket, string[]> {
  const out: Record<StockBucket, string[]> = { clean: [], worn: [], hamper: [], laundry: [], storage: [], away: [], retired: [] };
  for (const l of lots) {
    const u = parseJson<Partial<Record<StockBucket, string[]>>>(l.units_json, {});
    for (const k of Object.keys(out) as StockBucket[]) out[k].push(...(u[k] ?? []));
  }
  return out;
}

export async function assembleContext(deps: ContextDeps, principal: Principal, req: ComposeRequest, trip: TripRecord | null = null): Promise<MandatoryContext> {
  assertPrincipal(principal);
  const { db, now } = deps;
  const userId = principal.userId;
  const date = req.date;
  const watermark = await revalidationWatermark(db, userId);
  const settings = await loadSettings(db, principal);
  const destination = trip ? (trip.destinations.find((d) => (!d.from || d.from <= date) && (!d.to || d.to >= date)) ?? trip.destinations[0] ?? null) : (req.destination ?? null);
  const timezone = destination?.timezone ?? trip?.timezone ?? settings?.timezone ?? 'Europe/London';
  const window: WearingWindow = { ...DEFAULT_DAY_WINDOW, ...(req.window?.eveningOnly ? { start: '18:00', end: '23:00', departure: req.window.start ?? '18:00' } : {}), ...req.window } as WearingWindow;
  if (window.eveningOnly && !req.window?.departure) window.departure = window.start;
  const location = destination
    ? resolveLocation(destination.label, destination.latitude, destination.longitude, 'trip_destination')
    : resolveLocation(settings?.home_location_label ?? 'London', (settings as { home_latitude?: number | null } | null)?.home_latitude ?? null, (settings as { home_longitude?: number | null } | null)?.home_longitude ?? null);

  // Style: complete documents, rules, dated briefs, amendments and restrictions.
  const style = await getStyleContext(db, principal, date);
  const restrictionRows = await loadActiveRestrictions(db, userId);
  const policy = compileProfilePolicy(
    style,
    restrictionRows.map((r) => ({ restrictionId: r.restriction_id, ruleKey: r.rule_key })),
  );
  const defaultCount = settings?.daily_option_count ?? policy.defaultOptionCount;
  const requestedCount = req.requestedCount && req.requestedCount >= 1 ? Math.min(10, Math.floor(req.requestedCount)) : defaultCount;

  // Weather (skill invoked automatically; the model never has to ask).
  const weather: DayWeather = deps.weather
    ? await deps.weather.forecastForDay({ location, timezone, date, window, forceRefresh: req.forceWeatherRefresh })
    : interpretDay(null, date, timezone, window, 'missing', now, 'No weather provider configured', location?.label ?? 'Unknown');

  // Calendar (missing access is not an empty day).
  const snapshot = trip ? { status: 'not_connected' as const, fetchedAt: null, source: null, events: [], error: null } : await readCalendarDay(deps.calendar, date, timezone, now);
  const brief = interpretCalendarDay(snapshot, date, timezone, req.occasion !== undefined ? { explicitOccasion: req.occasion } : {});
  if (trip) {
    const occ = trip.occasions.find((o) => o.date === date);
    if (occ && ['formal', 'dinner', 'travel', 'outdoor'].includes(occ.occasion) && req.occasion === undefined) brief.occasion = occ.occasion as Occasion;
    brief.shapeOfDay = occ ? `${trip.name}: ${occ.note ?? occ.occasion}.` : `${trip.name}, packed wardrobe only.`;
  }

  // Wardrobe: every garment, with hard eligibility, estimates, wears, aliases and images.
  const { results: rows } = await db.prepare('SELECT * FROM garments WHERE user_id = ? ORDER BY name').bind(userId).all<GarmentRow>();
  const lots = await loadAllLots(db, userId);
  const estimates = new Map<string, AvailabilityEstimate>(
    (await estimateAvailability(db, principal, { targetDate: date, asOf: now, includeOccasional: true })).map((e) => [e.garmentId, e]),
  );
  const wears = await listDailyWears(db, principal, { from: addDays(date, -14), to: date });
  const { results: aliasRows } = await db
    .prepare("SELECT garment_id, phrase, kind FROM garment_aliases WHERE user_id = ? AND retired_at IS NULL AND kind IN ('owner_phrase', 'maker_name', 'maker_code') ORDER BY phrase")
    .bind(userId)
    .all<{ garment_id: string; phrase: string; kind: string }>();
  const { results: imageRows } = await db
    .prepare(
      `SELECT gm.garment_id, gm.asset_id, gm.role, gm.verified, ma.kind FROM garment_media gm JOIN media_assets ma ON ma.user_id = gm.user_id AND ma.asset_id = gm.asset_id
       WHERE gm.user_id = ? AND ma.status = 'final' ORDER BY gm.role, gm.created_at`,
    )
    .bind(userId)
    .all<{ garment_id: string; asset_id: string; role: 'catalogue' | 'supporting'; verified: number; kind: string }>();

  const inSuitcase = trip ? new Map<string, number>() : await loadUnitsInSuitcases(db, userId);
  const suitcaseWindows = trip ? new Map() : await loadSuitcaseWindows(db, userId);
  const resets = await listLaundryResets(db, principal);
  const packed = trip ? new Map((await loadTripItems(db, userId, trip.tripId)).filter((i) => i.packedQty - i.unpackedQty > 0).map((i) => [i.garmentId, i.packedQty - i.unpackedQty])) : null;

  const wardrobe: WardrobeGarment[] = rows.map((g) => {
    const attrs = parseJson<Record<string, unknown>>(g.attributes_json, {});
    const roles = parseJson<GarmentRole[]>(g.roles_json, []);
    const gl = lots.filter((l) => l.garment_id === g.garment_id);
    const eligibility = evaluateEligibility(g, restrictionRows, { includeOccasional: true, lots: gl });
    let estimate = estimates.get(g.garment_id) ?? null;
    const units = mergeUnits(gl);
    // Units in a suitcase are not at home.
    const away = inSuitcase.get(g.garment_id) ?? 0;
    if (away > 0 && estimate) {
      const physical = units.clean.length + units.worn.length + units.hamper.length;
      const remaining = Math.max(0, estimate.estimatedCleanUnits - away);
      if (remaining === 0 || physical <= away) {
        eligibility.available = false;
        eligibility.label = 'Packed for a trip';
        eligibility.reasons.push('Packed for a trip (in the suitcase)');
      }
      estimate = { ...estimate, estimatedCleanUnits: remaining, basis: [...estimate.basis, { kind: 'owner_exception', detail: `${away} unit(s) packed for a trip`, quantity: away }] };
    }
    // A home laundry reset does not wash clothes in a suitcase: undo reset credit for units dirtied while packed.
    const windows = suitcaseWindows.get(g.garment_id) as { from: string; to: string }[] | undefined;
    if (windows && estimate && estimate.eligible && (g.laundry_policy === 'per_wear' || g.laundry_policy === 'single_wear_day')) {
      const pool = poolOf(g.care_channel);
      const reset = resets.filter((r) => r.pool === pool && Date.parse(r.effectiveAt) <= Date.parse(now)).sort((a, b) => Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt))[0];
      if (reset) {
        const cutoff = Date.parse(reset.cutoffAt);
        // Collected (cutoff) while the unit was still packed: that cycle never washed it.
        const uncredited = [...units.worn, ...units.hamper].filter((t) => Date.parse(t) < cutoff && windows.some((w) => Date.parse(t) >= Date.parse(w.from) && cutoff < Date.parse(w.to))).length;
        const credited = estimate.basis.filter((b) => b.kind === 'weekly_reset').reduce((n, b) => n + (b.quantity ?? 0), 0);
        const remove = Math.min(uncredited, credited);
        if (remove > 0) {
          const clean = Math.max(0, estimate.estimatedCleanUnits - remove);
          const ps = estimate.basis.filter((b) => (b.kind === 'board_probability' || b.kind === 'selection') && typeof b.probability === 'number').map((b) => b.probability as number);
          estimate = {
            ...estimate,
            estimatedCleanUnits: clean,
            probabilityAvailable: probabilityFewerThan(ps, clean),
            likelyAvailable: probabilityFewerThan(ps, clean) >= 0.5,
            basis: [...estimate.basis, { kind: 'owner_exception', detail: `${remove} unit(s) worn on a trip: the home reset of ${reset.cycleKey} ran while they were in the suitcase, and unpacking is not washing`, quantity: remove }],
          };
        }
      }
    }
    const gw = wears.filter((w) => w.garmentId === g.garment_id && w.status === 'active').map((w) => w.wearingDate).sort();
    const families = familiesOf(g.color, g.color_family);
    const tags = Array.isArray(attrs.tags) ? (attrs.tags as string[]) : [];
    return {
      garmentId: g.garment_id,
      name: g.name,
      category: g.category,
      roles,
      maker: g.maker,
      color: g.color,
      colorFamily: g.color_family,
      families,
      pattern: g.pattern,
      fabric: g.fabric,
      fabricClass: typeof attrs.fabricClass === 'string' ? attrs.fabricClass : null,
      weight: typeof attrs.weight === 'string' ? attrs.weight : null,
      notes: g.notes,
      tags,
      attributes: attrs,
      acquisition: g.acquisition,
      planningPolicy: g.planning_policy,
      location: g.location,
      laundryPolicy: g.laundry_policy,
      careChannel: g.care_channel,
      tracking: g.tracking,
      eligibility,
      estimate,
      lastWornOn: gw.length ? gw[gw.length - 1]! : null,
      wornDates: gw,
      thermal: thermalBand(attrs, typeof attrs.fabricClass === 'string' ? attrs.fabricClass : null, g.category),
      footwearKind: roles.includes('footwear') ? (g.category === 'sneakers' ? 'sneaker' : attrs.construction === 'welted' ? 'welted' : 'other') : null,
      statement: isStatementPiece({ roles, families, color: g.color, name: g.name }),
      indoorOnly: attrs.indoorOnly === true || roles.includes('indoor'),
      aliases: aliasRows.filter((a) => a.garment_id === g.garment_id && a.kind !== 'maker_code' && a.phrase !== g.name).map((a) => a.phrase),
      makerCodes: [...new Set([g.product_code, ...aliasRows.filter((a) => a.garment_id === g.garment_id && a.kind === 'maker_code').map((a) => a.phrase)].filter((c): c is string => Boolean(c && c.trim())).map((c) => c.trim()))],
      images: imageRows.filter((i) => i.garment_id === g.garment_id).map((i) => ({ assetId: i.asset_id, kind: i.kind, role: i.role, verified: i.verified === 1 })),
    };
  });

  // Trip mode: only the packed subset exists; availability comes from packed quantities and trip wears.
  if (trip && packed) {
    for (const g of wardrobe) {
      const qty = packed.get(g.garmentId) ?? 0;
      if (qty <= 0) {
        g.eligibility = { ...g.eligibility, available: false, label: 'Not packed', reasons: [...g.eligibility.reasons, 'Not packed for this trip (left at home)'] };
        g.estimate = g.estimate ? { ...g.estimate, eligible: false, estimatedCleanUnits: 0, probabilityAvailable: 0, likelyAvailable: false } : null;
        continue;
      }
      const tripWears = g.wornDates.filter((d) => d >= trip.departsOn && d < date).length;
      const consumes = g.laundryPolicy === 'per_wear';
      const units = consumes ? Math.max(0, qty - tripWears) : qty;
      const eligible = g.eligibility.available && units > 0;
      g.estimate = {
        estimatorVersion: g.estimate?.estimatorVersion ?? 'availability-estimator/1',
        garmentId: g.garmentId,
        asOf: now,
        targetDate: date,
        eligible,
        exclusionReasons: eligible ? [] : [...g.eligibility.reasons, ...(units <= 0 ? ['All packed units worn on this trip'] : [])],
        estimatedCleanUnits: units,
        expectedInferredWears: 0,
        probabilityAvailable: eligible ? 1 : 0,
        likelyAvailable: eligible,
        basis: [{ kind: 'physical_clean', detail: `Trip packing: ${qty} packed, ${consumes ? tripWears : 0} worn on the trip; no home laundry reset applies in a suitcase`, quantity: units }],
      };
    }
  }

  const byId = new Map(wardrobe.map((g) => [g.garmentId, g]));

  // Coming week's selections and recently shown combinations.
  const { results: sel } = await db
    .prepare(
      `SELECT b.board_date, s.option_id, og.garment_id FROM selections s JOIN boards b ON b.user_id = s.user_id AND b.board_id = s.board_id
       JOIN option_garments og ON og.user_id = s.user_id AND og.option_id = s.option_id
       WHERE s.user_id = ? AND s.status = 'active' AND b.board_date > ? AND b.board_date <= ?`,
    )
    .bind(userId, date, addDays(date, 7))
    .all<{ board_date: string; option_id: string; garment_id: string }>();
  const comingSelections = [...new Set(sel.map((s) => s.option_id))].map((id) => ({
    date: sel.find((s) => s.option_id === id)!.board_date,
    optionId: id,
    garmentIds: sel.filter((s) => s.option_id === id).map((s) => s.garment_id),
  }));
  const { results: shown } = await db
    .prepare(
      `SELECT b.board_date, o.option_id, og.garment_id FROM boards b JOIN board_options o ON o.user_id = b.user_id AND o.board_id = b.board_id AND o.revision = b.current_revision
       JOIN option_garments og ON og.user_id = o.user_id AND og.option_id = o.option_id
       WHERE b.user_id = ? AND b.board_date >= ? AND b.board_date < ? AND o.status = 'offerable'`,
    )
    .bind(userId, addDays(date, -7), date)
    .all<{ board_date: string; option_id: string; garment_id: string }>();
  const shownDates = [...new Set(shown.map((s) => s.board_date))].sort();
  const recentlyShown = shownDates.map((d) => {
    const opts = [...new Set(shown.filter((s) => s.board_date === d).map((s) => s.option_id))];
    return { date: d, garmentIds: opts.map((o) => shown.filter((s) => s.option_id === o).map((s) => s.garment_id)) };
  });

  const sources: SourceStamp[] = [
    { source: 'wardrobe', status: 'fresh', observedAt: now, revision: `effects:${watermark}`, detail: `${wardrobe.length} garments` },
    { source: 'style', status: style.documents.length ? 'fresh' : 'missing', observedAt: style.documents[0]?.importedAt ?? null, revision: style.documents[0] ? `v${style.documents[0].version}:${style.documents[0].contentSha256.slice(0, 12)}` : null, detail: `${style.rules.length} rules, ${style.temporaryBriefs.length} dated briefs` },
    { source: 'weather', status: weather.summary.status, observedAt: weather.summary.fetchedAt, revision: weather.summary.issuedAt, detail: weather.summary.missingFields.join(', ') || null },
    { source: 'calendar', status: snapshot.status === 'read' || snapshot.status === 'empty' ? 'fresh' : snapshot.status === 'not_connected' ? 'missing' : 'unavailable', observedAt: snapshot.fetchedAt, revision: null, detail: snapshot.error ?? snapshot.status },
    { source: 'wears', status: 'fresh', observedAt: now, revision: null, detail: `${wears.length} counted wears in the last 14 days` },
    { source: 'laundry', status: 'fresh', observedAt: now, revision: resets[0]?.cycleKey ?? null, detail: resets[0] ? `latest weekly reset ${resets[0].pool} ${resets[0].cycleKey}` : 'no weekly reset applied yet' },
  ];

  // Comfort feedback: the day's situation from trusted text only (owner brief, dated owner briefs,
  // titles of calendar events that count, a trip's occasion note), never event descriptions.
  const situation = [
    req.briefText ?? null,
    ...style.temporaryBriefs.map((b) => b.statement),
    ...brief.events.filter((e) => e.weight > 0 && !e.ignoredBecause).map((e) => e.title),
    trip ? (trip.occasions.find((o) => o.date === date)?.note ?? null) : null,
  ].filter((x): x is string => Boolean(x && x.trim()));
  const comfort = buildComfortContext(style, await loadComfortObservations(db, userId), situation);

  return {
    contextVersion: CONTEXT_VERSION,
    builtAt: now,
    day: { date, timezone, purpose: req.purpose ?? (trip ? `trip:${trip.tripId}` : 'day'), window, requestedCount, defaultCount, briefText: req.briefText ?? null },
    location,
    weather,
    thermal: thermalBasis(weather),
    calendar: { snapshot, brief, wholeBoardOccasion: Boolean(req.wholeBoardOccasion) },
    style,
    policy,
    wardrobe,
    byId,
    request: { include: req.include ?? [], exclude: req.exclude ?? [] },
    comfort,
    recentWears: wears,
    comingSelections,
    recentlyShown,
    trip: trip && packed ? { trip, packed } : null,
    sources,
    watermark,
    seed: req.seed ?? `${userId}:${date}`,
  };
}

/** Compact, serialisable evidence of the context (stored with the board revision). */
export function contextEvidence(ctx: MandatoryContext): Record<string, unknown> {
  return {
    contextVersion: ctx.contextVersion,
    builtAt: ctx.builtAt,
    day: ctx.day,
    location: ctx.location,
    thermal: ctx.thermal,
    weather: ctx.weather.summary,
    weatherHours: ctx.weather.hours.map((h) => ({ local: h.local, t: h.temperatureC, pp: h.precipitationProbability, mm: h.precipitationMm, wind: h.windKmh, gust: h.gustKmh })),
    weatherSnapshot: ctx.weather.snapshot ? { provider: ctx.weather.snapshot.provider, fetchedAt: ctx.weather.snapshot.fetchedAt, issuedAt: ctx.weather.snapshot.issuedAt, coveredFrom: ctx.weather.snapshot.coveredFrom, coveredTo: ctx.weather.snapshot.coveredTo } : null,
    calendar: { status: ctx.calendar.snapshot.status, fetchedAt: ctx.calendar.snapshot.fetchedAt, error: ctx.calendar.snapshot.error, events: ctx.calendar.brief.events, occasion: ctx.calendar.brief.occasion },
    style: {
      documents: ctx.style.documents.map((d) => ({ documentId: d.documentId, version: d.version, sha256: d.contentSha256, byteLength: d.byteLength })),
      ruleKeys: ctx.style.rules.map((r) => r.ruleKey),
      briefs: ctx.policy.briefs,
      restrictions: ctx.style.restrictions.map((r) => ({ restrictionId: r.restrictionId, kind: r.kind, reason: r.reason })),
      dormantRuleKeys: ctx.style.dormantRuleKeys,
    },
    wardrobe: { garments: ctx.wardrobe.length, eligible: ctx.wardrobe.filter((g) => g.eligibility.available && (g.estimate?.eligible ?? false)).length },
    recentWears: ctx.recentWears.map((w) => ({ garmentId: w.garmentId, date: w.wearingDate })),
    comingSelections: ctx.comingSelections,
    recentlyShown: ctx.recentlyShown.length,
    trip: ctx.trip ? { tripId: ctx.trip.trip.tripId, packed: Object.fromEntries(ctx.trip.packed) } : null,
    sources: ctx.sources,
    watermark: ctx.watermark,
    comfort: comfortEvidence(ctx.comfort),
  };
}
