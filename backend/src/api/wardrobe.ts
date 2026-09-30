import {
  API_VERSION,
  CONTRACTS_VERSION,
  WardrobeQueryParams,
  type GarmentRole,
  type ItemCombination,
  type ItemDetail,
  type AvailabilityEstimate,
  type TemperaturePreview,
  type WardrobeItem,
  type WardrobePage,
} from '@garderobe/contracts';
import type { Env } from '../env.js';
import type { Principal } from '../domain/principal.js';
import { getItemDetail, listWardrobe } from '../domain/queries.js';
import { addDays } from '../domain/time.js';
import { getDailyBoard } from '../recommend/publish.js';
import { thermalBand } from '../recommend/garments.js';
import { RecommendationService } from '../recommend/service.js';
import { HttpError } from './http.js';
import { garmentMedia } from './media.js';
import { now, ownerToday } from './services.js';

/** GET /v1/wardrobe, GET /v1/items/{id}, GET /v1/wardrobe/temperature-preview. */

export function parseWardrobeQuery(params: URLSearchParams): WardrobeQueryParams {
  const raw: Record<string, string> = {};
  for (const [k, v] of params) if (v !== '') raw[k] = v;
  return WardrobeQueryParams.parse(raw);
}

/**
 * The daily service's home estimates for today (the same eligibility and clean-unit estimate the
 * composer uses: packed units are not at home, and a home laundry reset never washes a suitcase).
 * Built without weather or calendar calls. Falls back to the plain estimator if context assembly fails.
 */
export async function homeEstimates(env: Env, principal: Principal): Promise<Map<string, AvailabilityEstimate> | undefined> {
  try {
    const { date } = await ownerToday(env, principal);
    const rec = new RecommendationService({ db: env.DB, principal, weather: null, calendar: null, clock: now });
    const ctx = await rec.context({ date, purpose: 'day' });
    const out = new Map<string, AvailabilityEstimate>();
    for (const g of ctx.wardrobe) if (g.estimate) out.set(g.garmentId, g.estimate);
    return out;
  } catch (err) {
    console.warn('home estimates unavailable; using the plain estimator', err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

async function allItems(env: Env, principal: Principal, q?: string, category?: string): Promise<{ items: WardrobeItem[]; counts: WardrobePage['counts'] }> {
  const estimates = await homeEstimates(env, principal);
  const items: WardrobeItem[] = [];
  let cursor: string | null = null;
  let counts: WardrobePage['counts'] | null = null;
  for (let guard = 0; guard < 100; guard++) {
    const page: WardrobePage = await listWardrobe(env.DB, principal, { q, category, limit: 500, cursor, asOf: now(), homeEstimates: estimates });
    items.push(...page.items);
    counts ??= page.counts;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return { items, counts: counts ?? { owned: 0, available: 0, incoming: 0, retired: 0 } };
}

export async function wardrobePage(env: Env, principal: Principal, query: WardrobeQueryParams, origin: string): Promise<WardrobePage> {
  const { items, counts } = await allItems(env, principal, query.q, query.category);
  const filtered = items.filter((i) => {
    const g = i.garment;
    switch (query.availability) {
      case 'available':
        if (!i.availability.available) return false;
        break;
      case 'unavailable':
        if (i.availability.available || g.acquisition !== 'owned') return false;
        break;
      case 'incoming':
        if (g.acquisition !== 'incoming') return false;
        break;
      case 'retired':
        if (g.acquisition !== 'disposed') return false;
        break;
      default:
        break;
    }
    if (query.colorFamily && (g.colorFamily ?? '').toLowerCase() !== query.colorFamily.toLowerCase()) return false;
    if (query.season && !(Array.isArray(g.attributes.season) && (g.attributes.season as string[]).includes(query.season))) return false;
    if (query.location && g.location !== query.location) return false;
    if (query.lastWornBefore && i.lastRecordedWear !== null && i.lastRecordedWear >= query.lastWornBefore) return false;
    return true;
  });
  const limit = query.limit ?? 500;
  const offset = query.cursor ? Number.parseInt(query.cursor, 10) : 0;
  if (!Number.isFinite(offset) || offset < 0) throw new HttpError(422, 'validation_failed', 'Invalid cursor');
  const pageItems = filtered.slice(offset, offset + limit);
  const media = await garmentMedia(env, principal, pageItems.map((i) => i.garment.garmentId), origin);
  const next = offset + limit < filtered.length ? String(offset + limit) : null;
  return {
    schemaVersion: CONTRACTS_VERSION,
    apiVersion: API_VERSION,
    items: pageItems.map((i) => ({ ...i, media: media.get(i.garment.garmentId) ?? null })),
    total: filtered.length,
    complete: offset === 0 && next === null,
    nextCursor: next,
    counts,
    asOf: now(),
  };
}

export async function itemCombinations(env: Env, principal: Principal, garmentId: string): Promise<ItemCombination[]> {
  const { date } = await ownerToday(env, principal);
  const out: ItemCombination[] = [];
  for (const d of [date, addDays(date, 1)]) {
    const board = await getDailyBoard(env.DB, principal, d, 'day');
    if (!board || board.status !== 'published') continue;
    for (const o of board.options) {
      if (o.status !== 'offerable') continue;
      if (!o.slots.some((s) => s.garmentId === garmentId)) continue;
      const doc = board.document?.options.find((x) => x.optionId === o.optionId);
      out.push({ boardId: board.boardId, boardDate: board.boardDate, boardRevision: o.revision, optionId: o.optionId, position: o.position, why: doc?.why ?? null, garmentIds: o.slots.map((s) => s.garmentId) });
    }
  }
  return out;
}

export async function itemDetail(env: Env, principal: Principal, garmentId: string, origin: string): Promise<ItemDetail> {
  const { date, timezone } = await ownerToday(env, principal);
  const detail = await getItemDetail(env.DB, principal, garmentId, { targetDate: date, timezone, asOf: now(), homeEstimates: await homeEstimates(env, principal) });
  const media = await garmentMedia(env, principal, [garmentId], origin);
  return { ...detail, item: { ...detail.item, media: media.get(garmentId) ?? null }, combinations: await itemCombinations(env, principal, garmentId) };
}

const PREVIEW_ROLES: GarmentRole[] = ['outer_layer', 'mid_layer', 'base_top', 'bottom', 'one_piece', 'socks'];

/** A simulation only: which owned pieces suit a hypothetical temperature. Reads, never writes. */
export async function temperaturePreview(env: Env, principal: Principal, temperatureC: number): Promise<TemperaturePreview> {
  if (!Number.isFinite(temperatureC) || temperatureC < -40 || temperatureC > 50) throw new HttpError(422, 'validation_failed', 'temperatureC must be a number between -40 and 50');
  const { items } = await allItems(env, principal);
  const preview: TemperaturePreview['items'] = [];
  for (const i of items) {
    const g = i.garment;
    if (g.acquisition !== 'owned' || g.planningPolicy === 'excluded') continue;
    const role = PREVIEW_ROLES.find((r) => g.roles.includes(r));
    if (!role) continue;
    const fabricClass = typeof g.attributes.fabricClass === 'string' ? g.attributes.fabricClass : null;
    const band = thermalBand(g.attributes as Record<string, unknown>, fabricClass, g.category);
    const wearable = temperatureC >= band.minC && temperatureC <= band.maxC;
    const basisNote = role === 'outer_layer' ? 'Outerwear is judged against the temperature when you leave.' : 'Judged against the warmest part of the day.';
    preview.push({ garmentId: g.garmentId, name: g.name, role, wearable, inStorage: g.location === 'storage', note: `${basisNote} Range ${band.minC}–${band.maxC} °C: ${band.basis}.` });
  }
  return {
    schemaVersion: CONTRACTS_VERSION,
    simulation: true,
    temperatureC,
    basis: 'peak',
    items: preview,
    note: `Simulation at ${temperatureC} °C. Nothing was changed; availability, cleanliness and today's forecast are not considered.`,
  };
}
