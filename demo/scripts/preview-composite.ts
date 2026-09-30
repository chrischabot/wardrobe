/**
 * Writes sample DEMO outfit composites (deterministic layout outfit-layout/1 over DEMO placeholder
 * flat-lays of the owner's real garments) to demo/assets/generated/sample-outfit-*.svg.
 * Run from garderobe/: npx tsx demo/scripts/preview-composite.ts
 * Pure: no D1, R2 or provider is involved; the backend produces the same SVG from stored assets.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GarmentRole } from '@garderobe/contracts';
import { layoutOutfit, renderCompositeSvg, type EmbeddedImage, type LayoutAsset } from '@garderobe/backend/visual';
import { DEMO_LABEL, placeholderSvg } from '../assets/placeholders.js';

interface G {
  role: GarmentRole;
  name: string;
  category: string;
  color: string;
  alternativeGroup?: string;
}

const OUTFITS: Record<string, G[]> = {
  layered: [
    { role: 'base_top', name: 'Lightweight oxford — light blue wide stripe', category: 'shirt', color: 'Light blue wide stripe' },
    { role: 'bottom', name: 'Di Sondrio walnut chino', category: 'trousers', color: 'Walnut' },
    { role: 'outer_layer', name: 'ISTO Linen Work Jacket — clay', category: 'jacket', color: 'Clay (reddish)' },
    { role: 'socks', name: 'Merino — golden yellow', category: 'socks', color: 'Golden Yellow' },
    { role: 'footwear', name: 'NB 990v4 — grey', category: 'sneakers', color: 'Grey' },
    { role: 'belt', name: "Anderson's belt — brown", category: 'belt', color: 'Brown' },
    { role: 'accessory', name: 'Silk knit tie — rust', category: 'tie', color: 'Rust' },
  ],
  'long-coat': [
    { role: 'base_top', name: 'Flannel plaid — rust+grey', category: 'shirt', color: 'Rust+grey' },
    { role: 'bottom', name: 'Joseph Turner flannel — charcoal', category: 'trousers', color: 'Charcoal' },
    { role: 'outer_layer', name: "PWVC General's Overcoat", category: 'coat', color: 'Navy' },
    { role: 'socks', name: 'Merino — deep forest green', category: 'socks', color: 'Deep Forest Green' },
    { role: 'footwear', name: 'NB 990v4 — olive/cream', category: 'sneakers', color: 'Olive/cream', alternativeGroup: 'footwear' },
    { role: 'footwear', name: 'Paraboot Michael Cerf — marron', category: 'shoes', color: 'Marron', alternativeGroup: 'footwear' },
    { role: 'accessory', name: 'Joseph Turner cashmere scarf', category: 'scarf', color: 'Grey check' },
  ],
};

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'generated');
mkdirSync(out, { recursive: true });
for (const [name, outfit] of Object.entries(OUTFITS)) {
  const images = new Map<string, EmbeddedImage>();
  const assets: Record<string, LayoutAsset> = {};
  const garments = outfit.map((g, i) => {
    const id = `g_demo${i}`;
    const p = placeholderSvg(g);
    assets[id] = { assetId: `med_demo${i}`, kind: 'source', assetClass: 'demo_placeholder', sha256: `demo${i}`, width: p.width, height: p.height, label: DEMO_LABEL };
    images.set(`med_demo${i}`, { contentType: 'image/svg+xml', base64: Buffer.from(p.svg).toString('base64') });
    return { garmentId: id, role: g.role, name: g.name, category: g.category, alternativeGroup: g.alternativeGroup ?? null };
  });
  writeFileSync(join(out, `sample-outfit-${name}.svg`), renderCompositeSvg(layoutOutfit(garments, assets), images));
  console.log(`Wrote sample-outfit-${name}.svg`);
}
