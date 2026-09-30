import { API_VERSION, CONTRACTS_VERSION, type AliasResolution, type AvailabilityEstimate, type CommandReceipt, type DailyWear, type GarmentAlias, type ItemDetail, type WardrobeItem, type WardrobePage } from '@garderobe/contracts';
import { parseJson } from './db.js';
import { notFound } from './errors.js';
import { assertPrincipal, type Principal } from './principal.js';
import { balanceOf, loadAllLots, rowToGarment, type GarmentRow, type LotRow } from './records.js';
import { evaluateEligibility } from './availability.js';
import { listRestrictions, loadActiveRestrictions, restrictionMatches } from './restrictions.js';
import { hydrateReceipt } from './commands/service.js';
import { estimateAvailability } from './estimator.js';
import { normalizePhrase } from './catalog.js';
import { localDateOf } from './time.js';

/** Read models. Every query is scoped to the principal's internal user id. */

interface AliasRow {
  alias_id: string;
  garment_id: string;
  phrase: string;
  kind: string;
  source: string | null;
}

function toAlias(a: AliasRow): GarmentAlias {
  return { aliasId: a.alias_id, garmentId: a.garment_id, phrase: a.phrase, kind: a.kind as GarmentAlias['kind'], source: a.source };
}

export interface WardrobeQuery {
  category?: string;
  availability?: 'available' | 'unavailable' | 'any';
  acquisition?: 'owned' | 'incoming' | 'disposed' | 'any';
  q?: string;
  limit?: number;
  cursor?: string | null;
  /** Instant availability is evaluated at (defaults to now); callers with a controlled clock pass it. */
  asOf?: string;
  /**
   * Home-context estimates from the daily service (already net of packed units and of home laundry
   * resets that ran while a unit was in a suitcase). When given they replace the plain estimator.
   */
  homeEstimates?: Map<string, AvailabilityEstimate>;
}

const LAUNDERED = ['per_wear', 'single_wear_day'];

/** Units currently in a suitcase (packed trip, not yet unpacked), per garment: they are not at home. */
async function unitsInSuitcases(db: D1Database, userId: string): Promise<Map<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT i.garment_id, SUM(i.packed_qty - i.unpacked_qty) AS qty FROM trip_items i JOIN trips t ON t.user_id = i.user_id AND t.trip_id = i.trip_id
       WHERE i.user_id = ? AND t.status = 'packed' AND i.packed_qty > i.unpacked_qty GROUP BY i.garment_id`,
    )
    .bind(userId)
    .all<{ garment_id: string; qty: number }>();
  return new Map(results.map((r) => [r.garment_id, r.qty]));
}

/**
 * "Available now" at home, with the same gates the daily service's composer applies on top of hard
 * eligibility: units packed in a suitcase are not at home, and a laundered garment (per-wear or
 * single-wear-day) with no estimated clean unit is worn or in the wash.
 */
function homeAvailability(
  e: { label: string; available: boolean; reasons: string[] },
  g: GarmentRow,
  gl: LotRow[],
  estimate: { estimatedCleanUnits: number } | undefined,
  inSuitcase: number,
  netOfSuitcase = false,
): { label: string; available: boolean; reasons: string[] } {
  if (!e.available || g.acquisition !== 'owned') return e;
  const sum = (k: 'clean_qty' | 'worn_qty' | 'hamper_qty' | 'laundry_qty') => gl.reduce((n, l) => n + l[k], 0);
  const clean = estimate ? estimate.estimatedCleanUnits : sum('clean_qty');
  const atHome = netOfSuitcase ? clean : Math.max(0, clean - inSuitcase);
  if (inSuitcase > 0) {
    const physical = sum('clean_qty') + sum('worn_qty') + sum('hamper_qty');
    if (atHome === 0 || physical <= inSuitcase) {
      return { label: 'Packed for a trip', available: false, reasons: [...e.reasons, 'Packed for a trip (in the suitcase)'] };
    }
  }
  if (LAUNDERED.includes(g.laundry_policy) && atHome <= 0) {
    const label = sum('laundry_qty') > 0 && sum('hamper_qty') === 0 && sum('worn_qty') === 0 ? 'At the laundry' : sum('hamper_qty') > 0 ? 'In the wash' : sum('worn_qty') > 0 ? 'Worn, not washed yet' : 'No clean unit';
    return { label, available: false, reasons: [...e.reasons, 'No clean unit (worn or in the wash)'] };
  }
  return e;
}

export async function listWardrobe(db: D1Database, principal: Principal, query: WardrobeQuery = {}): Promise<WardrobePage> {
  assertPrincipal(principal);
  const userId = principal.userId;
  const { results: garments } = await db.prepare('SELECT * FROM garments WHERE user_id = ? ORDER BY category, name, garment_id').bind(userId).all<GarmentRow>();
  const lots = await loadAllLots(db, userId);
  const restrictions = await loadActiveRestrictions(db, userId);
  const { results: aliases } = await db.prepare('SELECT alias_id, garment_id, phrase, kind, source FROM garment_aliases WHERE user_id = ? AND retired_at IS NULL').bind(userId).all<AliasRow>();
  const { results: wears } = await db
    .prepare("SELECT garment_id, MAX(wearing_date) AS last, COUNT(*) AS n FROM daily_wears WHERE user_id = ? AND status = 'active' GROUP BY garment_id")
    .bind(userId)
    .all<{ garment_id: string; last: string; n: number }>();
  const wearBy = new Map(wears.map((w) => [w.garment_id, w]));
  const lotsBy = groupLots(lots);
  const q = query.q ? normalizePhrase(query.q) : '';
  const asOf = query.asOf ?? new Date().toISOString();
  const tz = (await db.prepare('SELECT timezone FROM owner_settings WHERE user_id = ?').bind(userId).first<{ timezone: string }>())?.timezone ?? 'Europe/London';
  const estimates = query.homeEstimates ?? new Map((await estimateAvailability(db, principal, { targetDate: localDateOf(asOf, tz), asOf })).map((x) => [x.garmentId, x]));
  const suitcase = await unitsInSuitcases(db, userId);

  const all: WardrobeItem[] = garments.map((g) => {
    const gl = lotsBy.get(g.garment_id) ?? [];
    const e = homeAvailability(evaluateEligibility(g, restrictions, { lots: gl }), g, gl, estimates.get(g.garment_id), suitcase.get(g.garment_id) ?? 0, Boolean(query.homeEstimates));
    return {
      garment: rowToGarment(g),
      aliases: aliases.filter((a) => a.garment_id === g.garment_id).map(toAlias),
      stock: balanceOf(g.garment_id, gl),
      availability: { label: e.label, available: e.available, reasons: e.reasons },
      lastRecordedWear: wearBy.get(g.garment_id)?.last ?? null,
      recordedWearCount: wearBy.get(g.garment_id)?.n ?? 0,
    };
  });
  const counts = {
    owned: all.filter((i) => i.garment.acquisition === 'owned').length,
    available: all.filter((i) => i.availability.available).length,
    incoming: all.filter((i) => i.garment.acquisition === 'incoming').length,
    retired: all.filter((i) => i.garment.acquisition === 'disposed').length,
  };
  const acquisition = query.acquisition ?? 'any';
  const filtered = all.filter((i) => {
    if (query.category && i.garment.category !== query.category) return false;
    if (acquisition !== 'any' && i.garment.acquisition !== acquisition) return false;
    if (query.availability === 'available' && !i.availability.available) return false;
    if (query.availability === 'unavailable' && i.availability.available) return false;
    if (q) {
      const hay = [i.garment.name, i.garment.maker ?? '', i.garment.productName ?? '', i.garment.productCode ?? '', i.garment.color ?? '', ...i.aliases.map((a) => a.phrase)].map(normalizePhrase).join(' | ');
      if (!q.split(' ').every((t) => hay.includes(t))) return false;
    }
    return true;
  });
  const limit = Math.min(Math.max(query.limit ?? 500, 1), 500);
  const offset = query.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0;
  const items = filtered.slice(offset, offset + limit);
  const next = offset + limit < filtered.length ? String(offset + limit) : null;
  return {
    schemaVersion: CONTRACTS_VERSION,
    apiVersion: API_VERSION,
    items,
    total: filtered.length,
    complete: next === null && offset === 0,
    nextCursor: next,
    counts,
    asOf,
  };
}

function groupLots(lots: LotRow[]): Map<string, LotRow[]> {
  const m = new Map<string, LotRow[]>();
  for (const l of lots) {
    const list = m.get(l.garment_id) ?? [];
    list.push(l);
    m.set(l.garment_id, list);
  }
  return m;
}

export async function listDailyWears(db: D1Database, principal: Principal, opts: { garmentId?: string; from?: string; to?: string; includeRetracted?: boolean } = {}): Promise<DailyWear[]> {
  assertPrincipal(principal);
  const where = ['user_id = ?'];
  const params: unknown[] = [principal.userId];
  if (opts.garmentId) (where.push('garment_id = ?'), params.push(opts.garmentId));
  if (opts.from) (where.push('wearing_date >= ?'), params.push(opts.from));
  if (opts.to) (where.push('wearing_date <= ?'), params.push(opts.to));
  if (!opts.includeRetracted) where.push("status = 'active'");
  const { results } = await db
    .prepare(`SELECT * FROM daily_wears WHERE ${where.join(' AND ')} ORDER BY wearing_date DESC, garment_id`)
    .bind(...params)
    .all<{ garment_id: string; wearing_date: string; timezone: string; first_occurred_at: string; observation_count: number; sources_json: string; segments_json: string; status: string; revision: number }>();
  return results.map((r) => ({
    garmentId: r.garment_id,
    wearingDate: r.wearing_date,
    timezone: r.timezone,
    firstOccurredAt: r.first_occurred_at,
    observationCount: r.observation_count,
    sources: parseJson(r.sources_json, []),
    segments: parseJson(r.segments_json, []),
    status: r.status as DailyWear['status'],
    revision: r.revision,
  }));
}

export async function getItemDetail(db: D1Database, principal: Principal, garmentId: string, opts: { targetDate?: string; timezone?: string; asOf?: string; homeEstimates?: Map<string, AvailabilityEstimate> } = {}): Promise<ItemDetail> {
  assertPrincipal(principal);
  const page = await listWardrobe(db, principal, { asOf: opts.asOf, homeEstimates: opts.homeEstimates });
  const item = page.items.find((i) => i.garment.garmentId === garmentId);
  if (!item) throw notFound('garment', garmentId);
  const g = await db.prepare('SELECT * FROM garments WHERE user_id = ? AND garment_id = ?').bind(principal.userId, garmentId).first<GarmentRow>();
  const restrictions = (await listRestrictions(db, principal)).filter((r) => restrictionMatches(r.scope, g!));
  const targetDate = opts.targetDate ?? localDateOf(opts.asOf ?? new Date(), opts.timezone ?? 'Europe/London');
  const estimate = opts.homeEstimates?.get(garmentId) ?? (await estimateAvailability(db, principal, { targetDate, asOf: opts.asOf, garmentIds: [garmentId] }))[0];
  return {
    schemaVersion: CONTRACTS_VERSION,
    item,
    restrictions,
    wearHistory: await listDailyWears(db, principal, { garmentId }),
    estimate: estimate ?? null,
    receipts: await listReceiptsForGarment(db, principal, garmentId),
  };
}

/**
 * Every receipt that affected a garment: the garment itself, its counted wears (`daily_wear`
 * `<garmentId>|<date>`), its stock lots (laundry, storage, reconciliation) and the wear observations
 * that list it. Newest first; receipts are never deleted.
 */
export async function listReceiptsForGarment(db: D1Database, principal: Principal, garmentId: string, limit = 100): Promise<CommandReceipt[]> {
  assertPrincipal(principal);
  const userId = principal.userId;
  const { results } = await db
    .prepare(
      `SELECT r.command_id, r.request_hash, r.receipt_json, r.undo_json, r.undone_by_command_id FROM command_receipts r
       WHERE r.user_id = ?1 AND r.command_id IN (
         SELECT e.command_id FROM command_receipt_entities e WHERE e.user_id = ?1 AND (
           (e.entity_type = 'garment' AND e.entity_id = ?2)
           OR (e.entity_type = 'daily_wear' AND e.entity_id LIKE ?3 ESCAPE '\\')
           OR (e.entity_type = 'stock_lot' AND e.entity_id IN (SELECT lot_id FROM stock_lots WHERE user_id = ?1 AND garment_id = ?2))
           OR (e.entity_type = 'wear_observation' AND e.entity_id IN (SELECT observation_id FROM observation_items WHERE user_id = ?1 AND garment_id = ?2))
         ))
       ORDER BY r.recorded_at DESC, r.command_id DESC LIMIT ?4`,
    )
    .bind(userId, garmentId, `${garmentId.replace(/[\\%_]/g, (c) => `\\${c}`)}|%`, limit)
    .all<{ command_id: string; request_hash: string; receipt_json: string; undo_json: string | null; undone_by_command_id: string | null }>();
  return Promise.all(results.map((r) => hydrateReceipt(db, userId, r)));
}

/**
 * Resolves an owner phrase ("the wide stripe", "rust sneakers", a PCF code) to garments. Ambiguity is
 * returned explicitly with distinguishing facts; the first match is never silently chosen.
 */
export async function resolveAlias(db: D1Database, principal: Principal, phrase: string, opts: { includeDisposed?: boolean } = {}): Promise<AliasResolution> {
  assertPrincipal(principal);
  const norm = normalizePhrase(phrase);
  const { results: garments } = await db
    .prepare(`SELECT garment_id, name, color, maker, size_label, category, acquisition FROM garments WHERE user_id = ? ${opts.includeDisposed ? '' : "AND acquisition <> 'disposed'"}`)
    .bind(principal.userId)
    .all<{ garment_id: string; name: string; color: string | null; maker: string | null; size_label: string | null; category: string; acquisition: string }>();
  const { results: aliases } = await db.prepare('SELECT garment_id, phrase_norm FROM garment_aliases WHERE user_id = ? AND retired_at IS NULL').bind(principal.userId).all<{ garment_id: string; phrase_norm: string }>();
  const byId = new Map(garments.map((g) => [g.garment_id, g]));
  let ids = new Set<string>([...aliases.filter((a) => a.phrase_norm === norm).map((a) => a.garment_id), ...garments.filter((g) => normalizePhrase(g.name) === norm).map((g) => g.garment_id)]);
  if (!ids.size) {
    const tokens = norm.split(' ').filter(Boolean);
    ids = new Set(
      garments
        .filter((g) => {
          const hay = [normalizePhrase(g.name), ...aliases.filter((a) => a.garment_id === g.garment_id).map((a) => a.phrase_norm)].join(' | ');
          return tokens.length > 0 && tokens.every((t) => hay.includes(t));
        })
        .map((g) => g.garment_id),
    );
  }
  const matches = [...ids].filter((id) => byId.has(id));
  if (matches.length === 0) {
    // Words the owner uses about a piece's recorded maker, colour or category ("rust sneakers",
    // "Paraboot shoes"), matched word by word so "boot" never matches inside "Paraboot".
    const tokens = norm.split(' ').filter((t) => t && !STOP_WORDS.has(t));
    const wordsOf = (g: (typeof garments)[number]) =>
      new Set(
        [g.name, g.maker ?? '', g.color ?? '', g.category, ...aliases.filter((a) => a.garment_id === g.garment_id).map((a) => a.phrase_norm)]
          .flatMap((s) => normalizePhrase(s).split(' '))
          .filter(Boolean)
          .map(singular),
      );
    const strict = tokens.length ? garments.filter((g) => tokens.every((t) => wordsOf(g).has(singular(t)))) : [];
    if (strict.length === 1) return { status: 'resolved', phrase, garmentId: strict[0]!.garment_id, name: strict[0]!.name };
    if (strict.length > 1) return ambiguous(phrase, strict);
    // A footwear word may stand for any of his footwear ("Paraboot boots" when his Paraboots are
    // derby shoes). Such a loose match is offered as a choice to confirm, even when there is only
    // one candidate, and never resolved silently.
    const loose =
      tokens.length > 1 && tokens.some((t) => FOOTWEAR_WORDS.has(singular(t))) && tokens.some((t) => !FOOTWEAR_WORDS.has(singular(t)))
        ? garments.filter((g) => FOOTWEAR_CATEGORIES.has(g.category) && tokens.every((t) => FOOTWEAR_WORDS.has(singular(t)) || wordsOf(g).has(singular(t))))
        : [];
    if (loose.length >= 1) return ambiguous(phrase, loose);
    return { status: 'not_found', phrase };
  }
  if (matches.length === 1) {
    const g = byId.get(matches[0]!)!;
    return { status: 'resolved', phrase, garmentId: g.garment_id, name: g.name };
  }
  return ambiguous(
    phrase,
    matches.map((id) => byId.get(id)!),
  );
}

const STOP_WORDS = new Set(['the', 'my', 'a', 'an']);
const FOOTWEAR_WORDS = new Set(['shoe', 'boot', 'sneaker', 'trainer', 'footwear']);
const FOOTWEAR_CATEGORIES = new Set(['shoes', 'boots', 'sneakers']);

/** "boots" -> "boot", "shoes" -> "shoe"; leaves "dress", "paraboot" and short words alone. */
function singular(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

function ambiguous(phrase: string, gs: { garment_id: string; name: string; color: string | null; maker: string | null; size_label: string | null; category: string }[]): AliasResolution {
  return {
    status: 'ambiguous',
    phrase,
    candidates: gs.map((g) => ({ garmentId: g.garment_id, name: g.name, distinguishing: [g.color, g.maker, g.size_label && g.size_label !== '-' ? `size ${g.size_label}` : null, g.category].filter(Boolean).join(', ') })),
  };
}
