import { LAYOUT_VERSION, type AssetClass, type CompositionItem, type CompositionManifest, type CompositionTemplate, type GarmentRole, type RenditionKind } from '@garderobe/contracts';

/**
 * Deterministic outfit layout, version `outfit-layout/1` (spec section 11, "Outfit composition
 * without redrawing the clothes"). A pure function of the outfit's garment roles and their verified
 * assets: top and trousers in the main column, shoes beneath, outerwear beside (or partially
 * layered), knitwear beside the shirt, belt on the waistline, tie or scarf and socks in fixed
 * positions. Templates cover short jackets, long coats and one-piece garments. Sizing is by
 * category; a garment without an image keeps its place as a labelled outline.
 *
 * Same inputs → byte-identical manifest: input order does not matter, every number is an integer,
 * and nothing reads the clock or randomness. Changing any box, rule or ordering here requires a new
 * LAYOUT_VERSION.
 */

export interface LayoutGarment {
  garmentId: string;
  role: GarmentRole;
  name: string;
  category: string;
  alternativeGroup?: string | null;
  /** 'long' for coats and anything recorded as long; drives the long-coat template. */
  length?: 'long' | 'short' | null;
}

export interface LayoutAsset {
  assetId: string;
  kind: RenditionKind;
  assetClass: AssetClass;
  sha256: string;
  width: number | null;
  height: number | null;
  label: string | null;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

export const CANVAS = { width: 1200, height: 1500 } as const;

const ROLE_ORDER: GarmentRole[] = ['outer_layer', 'mid_layer', 'one_piece', 'base_top', 'bottom', 'belt', 'accessory', 'socks', 'footwear'];

const COMMON: Partial<Record<GarmentRole, Box>> = {
  base_top: { x: 390, y: 90, w: 420, h: 480, z: 40 },
  bottom: { x: 420, y: 590, w: 360, h: 600, z: 30 },
  belt: { x: 450, y: 560, w: 300, h: 56, z: 50 },
  accessory: { x: 70, y: 110, w: 190, h: 380, z: 60 },
  socks: { x: 150, y: 1230, w: 160, h: 170, z: 70 },
  footwear: { x: 450, y: 1220, w: 300, h: 200, z: 80 },
};

const TEMPLATE_BOXES: Record<CompositionTemplate, Partial<Record<GarmentRole, Box>>> = {
  separates: { ...COMMON, mid_layer: { x: 840, y: 140, w: 320, h: 400, z: 35 } },
  separates_layered: { ...COMMON, outer_layer: { x: 760, y: 90, w: 400, h: 540, z: 20 }, mid_layer: { x: 830, y: 660, w: 320, h: 380, z: 35 } },
  separates_long_coat: { ...COMMON, outer_layer: { x: 790, y: 90, w: 370, h: 1080, z: 20 }, mid_layer: { x: 60, y: 560, w: 300, h: 360, z: 35 } },
  one_piece: {
    ...COMMON,
    one_piece: { x: 370, y: 90, w: 460, h: 1080, z: 30 },
    outer_layer: { x: 840, y: 90, w: 330, h: 540, z: 20 },
    mid_layer: { x: 840, y: 660, w: 320, h: 380, z: 35 },
  },
};

export function templateFor(garments: LayoutGarment[]): CompositionTemplate {
  if (garments.some((g) => g.role === 'one_piece')) return 'one_piece';
  const outer = garments.find((g) => g.role === 'outer_layer');
  if (!outer) return 'separates';
  if (outer.length === 'long' || (outer.length !== 'short' && outer.category === 'coat')) return 'separates_long_coat';
  return 'separates_layered';
}

/** Fit an image of the given proportions inside a box (contain), centred horizontally, top-aligned for tops and outerwear. */
function fit(box: Box, asset: LayoutAsset | null, role: GarmentRole): { x: number; y: number; w: number; h: number } {
  if (!asset?.width || !asset.height) return { x: box.x, y: box.y, w: box.w, h: box.h };
  const scale = Math.min(box.w / asset.width, box.h / asset.height);
  const w = Math.max(1, Math.round(asset.width * scale));
  const h = Math.max(1, Math.round(asset.height * scale));
  const x = box.x + Math.floor((box.w - w) / 2);
  const topAligned = role === 'base_top' || role === 'outer_layer' || role === 'mid_layer' || role === 'one_piece' || role === 'bottom';
  const y = topAligned ? box.y : box.y + Math.floor((box.h - h) / 2);
  return { x, y, w, h };
}

export class LayoutError extends Error {}

/**
 * Build the composition manifest. `assets` maps garment IDs to their chosen asset (or null when the
 * garment has no usable image). Imagined renderings and composites are refused: a composition only
 * arranges assets of the actual garments.
 */
export function layoutOutfit(garments: readonly LayoutGarment[], assets: Readonly<Record<string, LayoutAsset | null>>): CompositionManifest {
  const pieces = garments
    .filter((g) => ROLE_ORDER.includes(g.role))
    .slice()
    .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || (a.alternativeGroup ?? '').localeCompare(b.alternativeGroup ?? '') || a.garmentId.localeCompare(b.garmentId));
  const ids = pieces.map((p) => p.garmentId);
  if (new Set(ids).size !== ids.length) throw new LayoutError('A garment appears twice in the outfit');
  for (const p of pieces) {
    const a = assets[p.garmentId];
    if (a && (a.assetClass === 'imagined_rendering' || a.assetClass === 'composite')) throw new LayoutError(`${p.name}: an imagined rendering or composite cannot stand in for a garment`);
  }
  const template = templateFor(pieces);
  const boxes = TEMPLATE_BOXES[template];
  const items: CompositionItem[] = [];
  const footwear = pieces.filter((p) => p.role === 'footwear');
  for (const p of pieces) {
    let box = boxes[p.role];
    if (!box) continue;
    if (p.role === 'footwear' && footwear.length > 1) {
      // Alternatives side by side beneath the trousers, in a stable order.
      const i = footwear.indexOf(p);
      const n = footwear.length;
      const gap = 24;
      const w = Math.floor((box.w * 1.6 - gap * (n - 1)) / n);
      const start = Math.round(CANVAS.width / 2 - (w * n + gap * (n - 1)) / 2);
      box = { ...box, x: start + i * (w + gap), w };
    }
    const asset = assets[p.garmentId] ?? null;
    const r = fit(box, asset, p.role);
    items.push({
      garmentId: p.garmentId,
      role: p.role,
      name: p.name,
      assetId: asset?.assetId ?? null,
      renditionKind: asset?.kind ?? null,
      renditionSha256: asset?.sha256 ?? null,
      assetClass: asset?.assetClass ?? null,
      label: asset ? asset.label : 'No photo yet',
      placeholder: !asset,
      x: r.x,
      y: r.y,
      width: r.w,
      height: r.h,
      z: box.z,
      alternativeGroup: p.alternativeGroup ?? null,
    });
  }
  items.sort((a, b) => a.z - b.z || a.x - b.x || a.garmentId.localeCompare(b.garmentId));
  const labels = [...new Set(items.map((i) => i.label).filter((l): l is string => Boolean(l)))].sort();
  return { layoutVersion: LAYOUT_VERSION, template, canvas: { width: CANVAS.width, height: CANVAS.height, background: '#FFFFFF' }, items, labels, imagined: false };
}

/** Canonical JSON (sorted keys) of a manifest: the input to its content hash. */
export function canonicalManifestJson(m: CompositionManifest): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]));
    return v;
  };
  return JSON.stringify(sort(m));
}

export async function manifestHash(m: CompositionManifest): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalManifestJson(m)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
