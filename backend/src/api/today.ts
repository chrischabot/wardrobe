import { CONTRACTS_VERSION, type Board, type BoardDocument, type BoardGarment, type TodayResponse, type TodayWeather } from '@garderobe/contracts';
import type { Env } from '../env.js';
import type { Principal } from '../domain/principal.js';
import { getActiveSelection } from '../domain/boards.js';
import { listDailyWears } from '../domain/queries.js';
import { rowToGarment, type GarmentRow } from '../domain/records.js';
import { getDailyBoard } from '../recommend/publish.js';
import { loadTripCovering } from '../trips/store.js';
import { garmentMedia } from './media.js';
import { now, ownerToday } from './services.js';

/**
 * GET /v1/today and garderobe_today: one read model, so the app, the web board and every MCP client
 * see the same board revision. Reading never composes or publishes; the daily service does that.
 */

export function todayWeather(doc: BoardDocument | null | undefined): TodayWeather | null {
  if (!doc) return null;
  const w = doc.weather;
  return {
    locationLabel: w.locationLabel,
    status: w.status,
    observedAt: w.fetchedAt,
    morningTempC: w.departureTempC,
    peakTempC: w.peakTempC,
    rainStartsAt: w.rainStartsAt,
    precipitationProbability: w.rainProbabilityMax === null ? null : Math.max(0, Math.min(1, w.rainProbabilityMax / 100)),
    rainAmountMm: w.rainAmountMm,
    windKph: w.windSpeedMaxKmh,
    gustKph: w.windGustMaxKmh,
    summary: w.line,
    source: w.provider ?? 'unknown',
  };
}

export function boardGarmentIds(board: Board | null): string[] {
  if (!board) return [];
  const ids = new Set<string>();
  for (const o of board.options) for (const s of o.slots) ids.add(s.garmentId);
  for (const o of board.document?.options ?? []) for (const g of o.garments) ids.add(g.garmentId);
  return [...ids];
}

export async function displayGarments(env: Env, principal: Principal, ids: string[], origin: string): Promise<BoardGarment[]> {
  if (!ids.length) return [];
  const out: BoardGarment[] = [];
  const media = await garmentMedia(env, principal, ids, origin);
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const marks = chunk.map(() => '?').join(', ');
    const { results } = await env.DB.prepare(`SELECT * FROM garments WHERE user_id = ? AND garment_id IN (${marks})`).bind(principal.userId, ...chunk).all<GarmentRow>();
    const { results: aliases } = await env.DB.prepare(`SELECT garment_id, phrase FROM garment_aliases WHERE user_id = ? AND retired_at IS NULL AND garment_id IN (${marks})`)
      .bind(principal.userId, ...chunk)
      .all<{ garment_id: string; phrase: string }>();
    for (const r of results) {
      out.push({ ...rowToGarment(r), aliases: aliases.filter((a) => a.garment_id === r.garment_id).map((a) => a.phrase), media: media.get(r.garment_id) ?? null });
    }
  }
  const order = new Map(ids.map((id, i) => [id, i]));
  return out.sort((a, b) => (order.get(a.garmentId) ?? 0) - (order.get(b.garmentId) ?? 0));
}

export async function buildToday(env: Env, principal: Principal, opts: { date?: string; origin: string }): Promise<TodayResponse> {
  const t = await ownerToday(env, principal);
  const date = opts.date ?? t.date;
  // During a packed trip the day's board is the trip-day board (the daily service composes it from
  // the suitcase under purpose `trip:<id>`); otherwise the home board.
  const trip = await loadTripCovering(env.DB, principal.userId, date);
  const purpose = trip ? `trip:${trip.tripId}` : 'day';
  const board = await getDailyBoard(env.DB, principal, date, purpose);
  const doc = board?.document ?? null;
  const selection = board ? await getActiveSelection(env.DB, principal, board.boardId) : null;
  const recordedWears = await listDailyWears(env.DB, principal, { from: date, to: date });
  const calendarStatus = doc?.calendar.status;
  return {
    schemaVersion: CONTRACTS_VERSION,
    date,
    timezone: board?.timezone ?? t.timezone,
    board,
    selection,
    recordedWears,
    sources: [
      { source: 'board', status: board && board.status === 'published' ? 'fresh' : 'missing', observedAt: board?.publishedAt ?? null, revision: board ? String(board.currentRevision) : null },
      { source: 'weather', status: doc ? doc.weather.status : 'missing', observedAt: doc?.weather.fetchedAt ?? null, revision: null },
      {
        source: 'calendar',
        status: calendarStatus === 'read' || calendarStatus === 'empty' ? 'fresh' : calendarStatus === 'unavailable' ? 'unavailable' : 'missing',
        observedAt: doc?.calendar.fetchedAt ?? null,
        revision: null,
      },
      { source: 'wardrobe', status: 'fresh', observedAt: now(), revision: null },
    ],
    shortfall: doc?.shortfall ?? null,
    dayLine: doc?.dayLine ?? null,
    weather: todayWeather(doc),
    garments: await displayGarments(env, principal, boardGarmentIds(board), opts.origin),
    purpose,
    trip: trip ? { tripId: trip.tripId, name: trip.name, timezone: trip.timezone, departsOn: trip.departsOn, returnsOn: trip.returnsOn, destinations: trip.destinations.map((d) => d.label) } : null,
  };
}
