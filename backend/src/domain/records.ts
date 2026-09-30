import type { Garment, GarmentAttributes, StockBalance, StockBucket } from '@garderobe/contracts';
import { notFound } from './errors.js';
import { parseJson } from './db.js';

/** Row shapes and mappers shared by domain modules. Every loader takes the owner's userId. */

export interface GarmentRow {
  user_id: string;
  garment_id: string;
  name: string;
  category: string;
  roles_json: string;
  maker: string | null;
  product_name: string | null;
  product_code: string | null;
  fabric: string | null;
  color: string | null;
  color_family: string | null;
  pattern: string | null;
  size_label: string | null;
  care_channel: string;
  laundry_policy: string;
  tracking: string;
  acquisition: string;
  disposal_reason: string | null;
  planning_policy: string;
  condition: string;
  location: string;
  location_detail: string | null;
  attributes_json: string;
  notes: string | null;
  wear_logging_since: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

export function rowToGarment(r: GarmentRow): Garment {
  return {
    garmentId: r.garment_id,
    name: r.name,
    category: r.category as Garment['category'],
    roles: parseJson<Garment['roles']>(r.roles_json, []),
    maker: r.maker,
    productName: r.product_name,
    productCode: r.product_code,
    fabric: r.fabric,
    color: r.color,
    colorFamily: r.color_family,
    pattern: r.pattern,
    sizeLabel: r.size_label,
    careChannel: r.care_channel as Garment['careChannel'],
    laundryPolicy: r.laundry_policy as Garment['laundryPolicy'],
    tracking: r.tracking as Garment['tracking'],
    acquisition: r.acquisition as Garment['acquisition'],
    disposalReason: r.disposal_reason as Garment['disposalReason'],
    planningPolicy: r.planning_policy as Garment['planningPolicy'],
    condition: r.condition as Garment['condition'],
    location: r.location as Garment['location'],
    locationDetail: r.location_detail,
    attributes: parseJson<GarmentAttributes>(r.attributes_json, {}),
    notes: r.notes,
    wearLoggingSince: r.wear_logging_since,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function loadGarment(db: D1Database, userId: string, garmentId: string): Promise<GarmentRow | null> {
  return db.prepare('SELECT * FROM garments WHERE user_id = ? AND garment_id = ?').bind(userId, garmentId).first<GarmentRow>();
}

export async function requireGarment(db: D1Database, userId: string, garmentId: string): Promise<GarmentRow> {
  const row = await loadGarment(db, userId, garmentId);
  if (!row) throw notFound('garment', garmentId);
  return row;
}

export async function loadGarments(db: D1Database, userId: string, garmentIds: readonly string[]): Promise<Map<string, GarmentRow>> {
  const out = new Map<string, GarmentRow>();
  const unique = [...new Set(garmentIds)];
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const { results } = await db
      .prepare(`SELECT * FROM garments WHERE user_id = ? AND garment_id IN (${chunk.map(() => '?').join(',')})`)
      .bind(userId, ...chunk)
      .all<GarmentRow>();
    for (const r of results) out.set(r.garment_id, r);
  }
  return out;
}

export async function requireGarments(db: D1Database, userId: string, garmentIds: readonly string[]): Promise<Map<string, GarmentRow>> {
  const rows = await loadGarments(db, userId, garmentIds);
  for (const id of garmentIds) if (!rows.has(id)) throw notFound('garment', id);
  return rows;
}

export interface LotRow {
  user_id: string;
  lot_id: string;
  garment_id: string;
  clean_qty: number;
  worn_qty: number;
  hamper_qty: number;
  laundry_qty: number;
  storage_qty: number;
  away_qty: number;
  retired_qty: number;
  units_json: string;
  replay_notes_json: string;
  version: number;
  updated_at: string;
}

export function lotCounts(l: LotRow): Record<StockBucket, number> {
  return {
    clean: l.clean_qty,
    worn: l.worn_qty,
    hamper: l.hamper_qty,
    laundry: l.laundry_qty,
    storage: l.storage_qty,
    away: l.away_qty,
    retired: l.retired_qty,
  };
}

export function balanceOf(garmentId: string, lots: LotRow[]): StockBalance {
  const buckets: Record<StockBucket, number> = { clean: 0, worn: 0, hamper: 0, laundry: 0, storage: 0, away: 0, retired: 0 };
  let version = 1;
  for (const l of lots) {
    const c = lotCounts(l);
    for (const k of Object.keys(buckets) as StockBucket[]) buckets[k] += c[k];
    version = Math.max(version, l.version);
  }
  const totalOwned = buckets.clean + buckets.worn + buckets.hamper + buckets.laundry + buckets.storage + buckets.away;
  return { garmentId, buckets, totalOwned, version };
}

export async function loadLots(db: D1Database, userId: string, garmentIds: readonly string[]): Promise<LotRow[]> {
  const unique = [...new Set(garmentIds)];
  const out: LotRow[] = [];
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const { results } = await db
      .prepare(`SELECT * FROM stock_lots WHERE user_id = ? AND garment_id IN (${chunk.map(() => '?').join(',')}) ORDER BY lot_id`)
      .bind(userId, ...chunk)
      .all<LotRow>();
    out.push(...results);
  }
  return out;
}

export async function loadAllLots(db: D1Database, userId: string): Promise<LotRow[]> {
  const { results } = await db.prepare('SELECT * FROM stock_lots WHERE user_id = ?').bind(userId).all<LotRow>();
  return results;
}

export function garmentLabel(r: Pick<GarmentRow, 'name'>): string {
  return r.name;
}
