import { parseJson } from '../domain/db.js';

/** Read-side queries for trips and packing (spec sections 5 and 10, "Trip and packing mode"). */

export interface TripDestination {
  label: string;
  latitude?: number;
  longitude?: number;
  timezone: string;
  /** Inclusive local dates at this destination; defaults to the whole trip. */
  from?: string;
  to?: string;
}

export interface TripRecord {
  tripId: string;
  name: string;
  departsOn: string;
  returnsOn: string;
  destinations: TripDestination[];
  timezone: string;
  luggage: string | null;
  laundryOpportunities: unknown[];
  status: 'planned' | 'packed' | 'completed' | 'cancelled';
  allowRepeats: boolean;
  occasions: { date: string; occasion: string; note?: string }[];
  packedAt: string | null;
  unpackedAt: string | null;
  version: number;
}

export interface TripItemRecord {
  garmentId: string;
  proposedQty: number;
  packedQty: number;
  unpackedQty: number;
  packedAt: string | null;
  unpackedAt: string | null;
}

interface TripRow {
  trip_id: string;
  name: string;
  departs_on: string;
  returns_on: string;
  destinations_json: string;
  timezone: string;
  luggage: string | null;
  laundry_opportunities_json: string;
  status: string;
  allow_repeats: number;
  occasions_json: string;
  packed_at: string | null;
  unpacked_at: string | null;
  version: number;
}

export function rowToTrip(r: TripRow): TripRecord {
  return {
    tripId: r.trip_id,
    name: r.name,
    departsOn: r.departs_on,
    returnsOn: r.returns_on,
    destinations: parseJson(r.destinations_json, []),
    timezone: r.timezone,
    luggage: r.luggage,
    laundryOpportunities: parseJson(r.laundry_opportunities_json, []),
    status: r.status as TripRecord['status'],
    allowRepeats: r.allow_repeats === 1,
    occasions: parseJson(r.occasions_json, []),
    packedAt: r.packed_at,
    unpackedAt: r.unpacked_at,
    version: r.version,
  };
}

export async function loadTrip(db: D1Database, userId: string, tripId: string): Promise<TripRecord | null> {
  const r = await db.prepare('SELECT * FROM trips WHERE user_id = ? AND trip_id = ?').bind(userId, tripId).first<TripRow>();
  return r ? rowToTrip(r) : null;
}

/** A packed trip whose dates cover the local date (the owner is away with the packed subset). */
export async function loadTripCovering(db: D1Database, userId: string, date: string): Promise<TripRecord | null> {
  const r = await db
    .prepare("SELECT * FROM trips WHERE user_id = ? AND status = 'packed' AND departs_on <= ? AND returns_on >= ? ORDER BY departs_on LIMIT 1")
    .bind(userId, date, date)
    .first<TripRow>();
  return r ? rowToTrip(r) : null;
}

export async function loadTripItems(db: D1Database, userId: string, tripId: string): Promise<TripItemRecord[]> {
  const { results } = await db
    .prepare('SELECT garment_id, proposed_qty, packed_qty, unpacked_qty, packed_at, unpacked_at FROM trip_items WHERE user_id = ? AND trip_id = ?')
    .bind(userId, tripId)
    .all<{ garment_id: string; proposed_qty: number; packed_qty: number; unpacked_qty: number; packed_at: string | null; unpacked_at: string | null }>();
  return results.map((r) => ({ garmentId: r.garment_id, proposedQty: r.proposed_qty, packedQty: r.packed_qty, unpackedQty: r.unpacked_qty, packedAt: r.packed_at, unpackedAt: r.unpacked_at }));
}

/** Units currently in a suitcase (packed and not yet unpacked), per garment. They are not at home. */
export async function loadUnitsInSuitcases(db: D1Database, userId: string): Promise<Map<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT i.garment_id, SUM(i.packed_qty - i.unpacked_qty) AS qty FROM trip_items i JOIN trips t ON t.user_id = i.user_id AND t.trip_id = i.trip_id
       WHERE i.user_id = ? AND t.status = 'packed' AND i.packed_qty > i.unpacked_qty GROUP BY i.garment_id`,
    )
    .bind(userId)
    .all<{ garment_id: string; qty: number }>();
  return new Map(results.map((r) => [r.garment_id, r.qty]));
}

/** Completed trips' packed windows, per garment (a home laundry reset does not wash clothes in a suitcase). */
export async function loadSuitcaseWindows(db: D1Database, userId: string): Promise<Map<string, { from: string; to: string }[]>> {
  const { results } = await db
    .prepare(
      `SELECT i.garment_id, COALESCE(i.packed_at, t.packed_at) AS packed_at, COALESCE(i.unpacked_at, t.unpacked_at) AS unpacked_at FROM trip_items i
       JOIN trips t ON t.user_id = i.user_id AND t.trip_id = i.trip_id WHERE i.user_id = ? AND i.packed_qty > 0 AND COALESCE(i.packed_at, t.packed_at) IS NOT NULL`,
    )
    .bind(userId)
    .all<{ garment_id: string; packed_at: string; unpacked_at: string | null }>();
  const out = new Map<string, { from: string; to: string }[]>();
  for (const r of results) {
    const list = out.get(r.garment_id) ?? [];
    list.push({ from: r.packed_at, to: r.unpacked_at ?? '9999-12-31T00:00:00.000Z' });
    out.set(r.garment_id, list);
  }
  return out;
}
