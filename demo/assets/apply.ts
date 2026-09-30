import type { MediaService } from '@garderobe/backend/media';
import { DEMO_ASSET_GENERATOR_VERSION, DEMO_LABEL, placeholderSvg } from './placeholders.js';

/**
 * Give every garment of one owner that has no image yet a DEMO placeholder catalogue image, through
 * the media service (private R2 + D1 metadata, asset class `demo_placeholder`, label "Demo
 * placeholder", verified = false). Idempotent: garments that already have any linked image — a real
 * photograph or an earlier placeholder — are skipped. Real photographs added later replace the
 * placeholder as the catalogue image; the placeholder never counts as a verified asset.
 */
export interface ApplyDemoAssetsResult {
  created: number;
  skipped: number;
  assetIds: string[];
}

export async function applyDemoPlaceholders(db: D1Database, media: MediaService, opts: { garmentIds?: string[] } = {}): Promise<ApplyDemoAssetsResult> {
  const userId = media.principal.userId;
  const { results } = await db
    .prepare(
      `SELECT g.garment_id, g.name, g.category, g.color, g.pattern, g.fabric FROM garments g
       WHERE g.user_id = ? AND g.acquisition <> 'disposed'
         AND NOT EXISTS (SELECT 1 FROM garment_media gm WHERE gm.user_id = g.user_id AND gm.garment_id = g.garment_id)
       ORDER BY g.name, g.garment_id`,
    )
    .bind(userId)
    .all<{ garment_id: string; name: string; category: string; color: string | null; pattern: string | null; fabric: string | null }>();
  const wanted = opts.garmentIds ? new Set(opts.garmentIds) : null;
  const out: ApplyDemoAssetsResult = { created: 0, skipped: 0, assetIds: [] };
  for (const g of results) {
    if (wanted && !wanted.has(g.garment_id)) {
      out.skipped++;
      continue;
    }
    const p = placeholderSvg(g);
    const asset = await media.ingest({
      bytes: new TextEncoder().encode(p.svg),
      kind: 'source',
      assetClass: 'demo_placeholder',
      garmentId: g.garment_id,
      link: 'catalogue',
      verified: false,
      label: DEMO_LABEL,
      transformation: { op: 'placeholder_generation', provider: DEMO_ASSET_GENERATOR_VERSION, params: { pattern: p.pattern, colours: p.colours, kind: p.kind } },
      provenance: { permittedUse: 'Generated demo drawing; not a photograph of the garment', evidence: { demo: true, generator: DEMO_ASSET_GENERATOR_VERSION } },
    });
    out.created++;
    out.assetIds.push(asset.assetId);
  }
  return out;
}
