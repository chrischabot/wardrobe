import type { AssetClass, FidelityReport, MediaAsset, RenditionKind, Transformation } from '@garderobe/contracts';
import { parseJson } from '../domain/db.js';

/** D1 row of media_assets (0001 columns plus the 0020 provenance columns). */
export interface MediaAssetRow {
  user_id: string;
  asset_id: string;
  r2_key: string;
  kind: RenditionKind;
  source_asset_id: string | null;
  transformation_json: string;
  content_type: string;
  width: number | null;
  height: number | null;
  sha256: string | null;
  status: 'pending' | 'final' | 'rejected';
  created_at: string;
  asset_class: AssetClass;
  byte_length: number | null;
  source_url: string | null;
  source_page_url: string | null;
  retrieved_at: string | null;
  permitted_use: string | null;
  evidence_json: string;
  fidelity_json: string | null;
  label: string | null;
  rejection_reason: string | null;
  deleted_at: string | null;
}

export function assetId(): string {
  return `med_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function r2KeyFor(userId: string, id: string): string {
  return `u/${userId}/a/${id}`;
}

/** Classes that show the owner's actual garment faithfully enough to be a catalogue image without a caveat. */
export const FAITHFUL_CLASSES: readonly AssetClass[] = ['exact_product_photo', 'owner_photo', 'edited_rendition'];
/** Classes that may stand in for a garment in a composite (with their label). Imagined renderings never do. */
export const COMPOSABLE_CLASSES: readonly AssetClass[] = ['exact_product_photo', 'owner_photo', 'edited_rendition', 'illustration', 'demo_placeholder'];

export function defaultLabel(cls: AssetClass): string | null {
  switch (cls) {
    case 'illustration':
      return 'Illustration';
    case 'demo_placeholder':
      return 'Demo placeholder';
    case 'edited_rendition':
      return 'Edited';
    case 'imagined_rendering':
      return 'Imagined rendering, not your actual garments';
    default:
      return null;
  }
}

export function rowToAsset(r: MediaAssetRow, garmentIds: string[] = []): MediaAsset {
  return {
    assetId: r.asset_id,
    kind: r.kind,
    assetClass: r.asset_class,
    status: r.status,
    contentType: r.content_type,
    width: r.width,
    height: r.height,
    byteLength: r.byte_length,
    sha256: r.sha256,
    sourceAssetId: r.source_asset_id,
    transformations: transformationsOf(r),
    provenance: {
      sourceUrl: r.source_url,
      sourcePageUrl: r.source_page_url,
      retrievedAt: r.retrieved_at,
      permittedUse: r.permitted_use,
      evidence: parseJson<Record<string, unknown>>(r.evidence_json, {}),
    },
    fidelity: parseJson<FidelityReport | null>(r.fidelity_json, null),
    label: r.label,
    garmentIds,
    createdAt: r.created_at,
  };
}

export function transformationsOf(r: Pick<MediaAssetRow, 'transformation_json'>): Transformation[] {
  const t = parseJson<unknown>(r.transformation_json, []);
  // 0001 stored a single object; 0020 stores the chain.
  if (Array.isArray(t)) return t as Transformation[];
  return t && typeof t === 'object' && Object.keys(t).length ? [t as Transformation] : [];
}

export interface GarmentAssetRow extends MediaAssetRow {
  garment_id: string;
  link_role: 'catalogue' | 'supporting';
  verified: number;
  linked_at: string;
}

export async function loadGarmentAssetRows(db: D1Database, userId: string, garmentIds: readonly string[] | null): Promise<GarmentAssetRow[]> {
  const filter = garmentIds ? `AND gm.garment_id IN (SELECT value FROM json_each(?))` : '';
  const stmt = db.prepare(
    `SELECT ma.*, gm.garment_id, gm.role AS link_role, gm.verified, gm.created_at AS linked_at
     FROM garment_media gm JOIN media_assets ma ON ma.user_id = gm.user_id AND ma.asset_id = gm.asset_id
     WHERE gm.user_id = ? AND ma.status = 'final' AND ma.deleted_at IS NULL ${filter}
     ORDER BY gm.garment_id, gm.created_at, ma.asset_id`,
  );
  const { results } = await (garmentIds ? stmt.bind(userId, JSON.stringify(garmentIds)) : stmt.bind(userId)).all<GarmentAssetRow>();
  return results;
}

const KIND_RANK: Record<string, number> = { catalogue: 0, cutout: 1, source: 2 };

/**
 * The image that represents a garment: its catalogue link if final and composable, else the best
 * verified faithful rendition (catalogue view > cutout > original), else an illustration or demo
 * placeholder (labelled). An imagined rendering or a composite is never chosen.
 */
export function selectCatalogue(rows: GarmentAssetRow[]): GarmentAssetRow | null {
  const usable = rows.filter((r) => COMPOSABLE_CLASSES.includes(r.asset_class) && ['catalogue', 'cutout', 'source'].includes(r.kind));
  const linked = usable.find((r) => r.link_role === 'catalogue');
  if (linked) return linked;
  const faithful = usable
    .filter((r) => FAITHFUL_CLASSES.includes(r.asset_class) && r.verified === 1)
    .sort((a, b) => (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) || a.linked_at.localeCompare(b.linked_at) || a.asset_id.localeCompare(b.asset_id));
  if (faithful[0]) return faithful[0];
  const stand = usable
    .filter((r) => r.asset_class === 'illustration' || r.asset_class === 'demo_placeholder')
    .sort((a, b) => (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) || a.asset_id.localeCompare(b.asset_id));
  return stand[0] ?? null;
}

export function isVerifiedCatalogue(r: GarmentAssetRow | null): boolean {
  return Boolean(r && FAITHFUL_CLASSES.includes(r.asset_class) && r.verified === 1);
}
