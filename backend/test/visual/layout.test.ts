import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { CompositionManifest, LAYOUT_VERSION } from '@garderobe/contracts';
import { canonicalManifestJson, CANVAS, layoutOutfit, LayoutError, manifestHash, type LayoutAsset, type LayoutGarment } from '../../src/visual/layout.js';
import { renderCompositeSvg, type EmbeddedImage } from '../../src/visual/render.js';
import { checkTrustedSvg } from '../../src/media/svg.js';
import { MediaService } from '../../src/media/service.js';
import { ok } from '../helpers/fixtures.js';
import { SIGNING_KEY, slotsOf, tokenOf, visualScenario } from '../helpers/visual.js';

const asset = (id: string, w = 600, h = 700, cls: LayoutAsset['assetClass'] = 'exact_product_photo', label: string | null = null): LayoutAsset => ({ assetId: id, kind: 'catalogue', assetClass: cls, sha256: `sha-${id}`, width: w, height: h, label });

const OUTFIT: LayoutGarment[] = [
  { garmentId: 'g_top', role: 'base_top', name: 'Lightweight oxford — gold', category: 'shirt' },
  { garmentId: 'g_bottom', role: 'bottom', name: 'Di Sondrio walnut chino', category: 'trousers' },
  { garmentId: 'g_outer', role: 'outer_layer', name: 'ISTO Linen Work Jacket — clay', category: 'jacket' },
  { garmentId: 'g_socks', role: 'socks', name: 'Merino — golden yellow', category: 'socks' },
  { garmentId: 'g_shoe1', role: 'footwear', name: 'NB 990v4 — grey', category: 'sneakers', alternativeGroup: 'footwear' },
  { garmentId: 'g_shoe2', role: 'footwear', name: 'Paraboot Michael — marron', category: 'shoes', alternativeGroup: 'footwear' },
  { garmentId: 'g_belt', role: 'belt', name: "Anderson's belt — brown", category: 'belt' },
  { garmentId: 'g_tie', role: 'accessory', name: 'Silk knit tie — rust', category: 'tie' },
];
const ASSETS: Record<string, LayoutAsset | null> = {
  g_top: asset('med_top'),
  g_bottom: asset('med_bottom', 500, 820),
  g_outer: asset('med_outer', 600, 720),
  g_socks: asset('med_socks', 320, 520, 'demo_placeholder', 'Demo placeholder'),
  g_shoe1: asset('med_shoe1', 700, 420),
  g_shoe2: null,
  g_belt: asset('med_belt', 760, 170, 'illustration', 'Illustration'),
  g_tie: asset('med_tie', 220, 760),
};

function shuffle<T>(xs: T[], seed: number): T[] {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe(`deterministic outfit layout (${LAYOUT_VERSION})`, () => {
  it('same inputs give a byte-identical manifest, hash and SVG, whatever the input order', async () => {
    const first = layoutOutfit(OUTFIT, ASSETS);
    const json = canonicalManifestJson(first);
    const hash = await manifestHash(first);
    const images = new Map<string, EmbeddedImage>(Object.values(ASSETS).filter((a): a is LayoutAsset => Boolean(a)).map((a) => [a.assetId, { contentType: 'image/png', base64: btoa(a.assetId) }]));
    const svg = renderCompositeSvg(first, images);
    for (let seed = 1; seed <= 25; seed++) {
      const m = layoutOutfit(shuffle(OUTFIT, seed), Object.fromEntries(shuffle(Object.entries(ASSETS), seed * 7)));
      expect(canonicalManifestJson(m)).toBe(json);
      expect(await manifestHash(m)).toBe(hash);
      expect(renderCompositeSvg(m, images)).toBe(svg);
    }
    expect(CompositionManifest.parse(first)).toBeTruthy();
    expect(first).toMatchObject({ layoutVersion: 'outfit-layout/1', canvas: { background: '#FFFFFF' }, imagined: false });
    // Pinned snapshot of the layout: changing any box or rule must mint a new LAYOUT_VERSION.
    expect(first.items.map((i) => `${i.role}:${i.x},${i.y},${i.width}x${i.height}@${i.z}`)).toMatchInlineSnapshot(`
      [
        "outer_layer:760,90,400x480@20",
        "bottom:420,590,360x590@30",
        "base_top:394,90,411x480@40",
        "belt:475,560,250x56@50",
        "accessory:110,110,110x380@60",
        "socks:177,1230,105x170@70",
        "footwear:360,1251,228x137@80",
        "footwear:612,1220,228x200@80",
      ]
    `);
  });

  it('main column, shoes beneath, outerwear beside; everything within the white canvas', () => {
    const m = layoutOutfit(OUTFIT, ASSETS);
    const by = (role: string) => m.items.filter((i) => i.role === role);
    const top = by('base_top')[0]!;
    const bottom = by('bottom')[0]!;
    const outer = by('outer_layer')[0]!;
    expect(m.template).toBe('separates_layered');
    expect(bottom.y).toBeGreaterThan(top.y);
    for (const shoe of by('footwear')) expect(shoe.y).toBeGreaterThan(bottom.y + bottom.height - 1);
    expect(outer.x).toBeGreaterThan(top.x);
    expect(outer.z).toBeLessThan(top.z); // outerwear sits behind the shirt it partially layers
    const [s1, s2] = by('footwear');
    expect(overlap(s1!, s2!)).toBe(false); // alternatives side by side
    for (const it of m.items) {
      expect(it.x).toBeGreaterThanOrEqual(0);
      expect(it.y).toBeGreaterThanOrEqual(0);
      expect(it.x + it.width).toBeLessThanOrEqual(CANVAS.width);
      expect(it.y + it.height).toBeLessThanOrEqual(CANVAS.height);
      for (const k of ['x', 'y', 'width', 'height', 'z'] as const) expect(Number.isInteger(it[k])).toBe(true);
    }
  });

  it('labels illustrations, demo placeholders and missing photos instead of pretending', () => {
    const m = layoutOutfit(OUTFIT, ASSETS);
    expect(m.labels).toEqual(['Demo placeholder', 'Illustration', 'No photo yet']);
    const missing = m.items.find((i) => i.garmentId === 'g_shoe2')!;
    expect(missing).toMatchObject({ assetId: null, placeholder: true, label: 'No photo yet' });
    const svg = renderCompositeSvg(m, new Map());
    expect(svg).toContain('No photo yet');
    expect(svg).toContain('Illustration');
    expect(checkTrustedSvg(svg)).toEqual({ ok: true, problems: [] });
  });

  it('a swap changes one asset reference: the other pieces keep their exact positions and renditions', async () => {
    const a = layoutOutfit(OUTFIT, ASSETS);
    const swapped = OUTFIT.map((g) => (g.garmentId === 'g_top' ? { ...g, garmentId: 'g_top2', name: 'Pima oxford — white' } : g));
    const b = layoutOutfit(swapped, { ...ASSETS, g_top2: asset('med_top2', 600, 700) });
    expect(await manifestHash(a)).not.toBe(await manifestHash(b));
    const rest = (m: typeof a) => m.items.filter((i) => i.role !== 'base_top').map((i) => JSON.stringify(i));
    expect(rest(b)).toEqual(rest(a));
  });

  it('templates: short jacket, long coat, knitwear beside the shirt, and dress/one-piece layouts', () => {
    const base = OUTFIT.filter((g) => g.role !== 'outer_layer');
    expect(layoutOutfit(base, ASSETS).template).toBe('separates');
    const coat = layoutOutfit([...base, { garmentId: 'g_coat', role: 'outer_layer', name: 'PWVC General’s Overcoat', category: 'coat' }], { ...ASSETS, g_coat: asset('med_coat', 400, 1000) });
    expect(coat.template).toBe('separates_long_coat');
    const coatItem = coat.items.find((i) => i.role === 'outer_layer')!;
    expect(coatItem.height).toBeGreaterThan(900);
    const jacket = layoutOutfit(OUTFIT, { ...ASSETS, g_outer: asset('med_outer', 400, 1000) }).items.find((i) => i.role === 'outer_layer')!;
    expect(jacket.height).toBeLessThan(coatItem.height); // a short jacket's box is shorter than a long coat's
    const knit = layoutOutfit([...base, { garmentId: 'g_knit', role: 'mid_layer', name: 'Shetland crew — moss', category: 'knitwear' }], { ...ASSETS, g_knit: asset('med_knit', 600, 650) });
    const k = knit.items.find((i) => i.role === 'mid_layer')!;
    expect(overlap(k, knit.items.find((i) => i.role === 'base_top')!)).toBe(false);
    const dress = layoutOutfit(
      [
        { garmentId: 'g_dress', role: 'one_piece', name: 'Linen shirt dress — sand', category: 'accessory' },
        { garmentId: 'g_shoe1', role: 'footwear', name: 'NB 990v4 — grey', category: 'sneakers' },
        { garmentId: 'g_outer', role: 'outer_layer', name: 'ISTO Linen Work Jacket — clay', category: 'jacket' },
      ],
      { g_dress: asset('med_dress', 500, 1100), g_shoe1: ASSETS.g_shoe1!, g_outer: ASSETS.g_outer! },
    );
    expect(dress.template).toBe('one_piece');
    expect(dress.items.map((i) => i.role).sort()).toEqual(['footwear', 'one_piece', 'outer_layer']);
    expect(dress.items.find((i) => i.role === 'one_piece')!.height).toBeGreaterThan(1000);
  });

  it('imagined renderings and composites can never stand in for a garment', () => {
    expect(() => layoutOutfit(OUTFIT, { ...ASSETS, g_top: asset('med_imagined', 600, 800, 'imagined_rendering') })).toThrow(LayoutError);
    expect(() => layoutOutfit(OUTFIT, { ...ASSETS, g_top: asset('med_comp', 600, 800, 'composite') })).toThrow(LayoutError);
    expect(() => layoutOutfit([...OUTFIT, OUTFIT[0]!], ASSETS)).toThrow(/twice/);
  });

  it('names are escaped: garment text cannot inject markup into the SVG', () => {
    const evil = OUTFIT.map((g) => (g.garmentId === 'g_shoe2' ? { ...g, name: '<script>alert(1)</script>" onload="x' } : g));
    const svg = renderCompositeSvg(layoutOutfit(evil, ASSETS), new Map());
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('onload="x');
    expect(checkTrustedSvg(svg).ok).toBe(true);
  });

  it('randomised outfits: always within the canvas, never overlapping in the main column, always deterministic', async () => {
    const pool: Record<string, LayoutGarment[]> = {
      base_top: [0, 1, 2, 3].map((i) => ({ garmentId: `g_t${i}`, role: 'base_top', name: `Shirt ${i}`, category: 'shirt' })),
      bottom: [0, 1, 2].map((i) => ({ garmentId: `g_b${i}`, role: 'bottom', name: `Trousers ${i}`, category: 'trousers' })),
      outer_layer: [
        { garmentId: 'g_o0', role: 'outer_layer', name: 'Jacket', category: 'jacket' },
        { garmentId: 'g_o1', role: 'outer_layer', name: 'Coat', category: 'coat' },
      ],
      footwear: [0, 1, 2].map((i) => ({ garmentId: `g_f${i}`, role: 'footwear', name: `Shoe ${i}`, category: 'sneakers', alternativeGroup: 'footwear' })),
      socks: [{ garmentId: 'g_s0', role: 'socks', name: 'Socks', category: 'socks' }],
    };
    let seed = 42;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 150; i++) {
      const outfit: LayoutGarment[] = [pool.base_top![rnd(4)]!, pool.bottom![rnd(3)]!, pool.socks![0]!];
      if (rnd(2)) outfit.push(pool.outer_layer![rnd(2)]!);
      const shoes = rnd(3) === 0 ? [pool.footwear![0]!, pool.footwear![1 + rnd(2)]!] : [{ ...pool.footwear![rnd(3)]!, alternativeGroup: null }];
      outfit.push(...shoes);
      const assets = Object.fromEntries(outfit.map((g) => [g.garmentId, rnd(4) === 0 ? null : asset(`med_${g.garmentId}`, 200 + rnd(900), 200 + rnd(1200))]));
      const m = layoutOutfit(outfit, assets);
      expect(canonicalManifestJson(layoutOutfit([...outfit].reverse(), assets))).toBe(canonicalManifestJson(m));
      for (const it of m.items) {
        expect(it.x >= 0 && it.y >= 0 && it.x + it.width <= CANVAS.width && it.y + it.height <= CANVAS.height).toBe(true);
      }
      const top = m.items.find((x) => x.role === 'base_top')!;
      const bottom = m.items.find((x) => x.role === 'bottom')!;
      expect(overlap(top, bottom)).toBe(false);
      const feet = m.items.filter((x) => x.role === 'footwear');
      for (let a = 0; a < feet.length; a++) for (let b = a + 1; b < feet.length; b++) expect(overlap(feet[a]!, feet[b]!)).toBe(false);
    }
  });
});

describe('stored outfit composites for real boards', () => {
  it('composes a published board option from its approved assets; cached by manifest hash; rendering is stable', async () => {
    const s = await visualScenario({ placeholders: true });
    const out = await s.rec.composeAndPublish({ date: '2026-10-06' });
    expect(out.published).toBe(true);
    const option = out.board!.options[0]!;
    const c1 = await s.composites.forOption(option.optionId);
    expect(c1.manifest.items.map((i) => i.garmentId).sort()).toEqual(option.slots.map((x) => x.garmentId).sort());
    expect(c1.manifest.items.every((i) => i.assetClass === 'demo_placeholder')).toBe(true);
    expect(c1.manifest.labels).toEqual(['Demo placeholder']);
    expect(c1.previewAssetId).toMatch(/^med_/);
    const c2 = await s.composites.forOption(option.optionId);
    expect(c2.previewAssetId).toBe(c1.previewAssetId);
    expect(c2.manifestHash).toBe(c1.manifestHash);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM media_assets WHERE user_id = ? AND asset_class = 'composite'").bind(s.userId).first<{ n: number }>();
    expect(n!.n).toBe(1);

    const preview = await MediaService.serveSigned({ db: env.DB, bucket: env.MEDIA, signingKey: SIGNING_KEY }, c1.previewAssetId!, tokenOf(c1.previewUrl!));
    const svg = await preview.text();
    expect(preview.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(checkTrustedSvg(svg)).toEqual({ ok: true, problems: [] });
    expect(svg).toContain('<rect width="1200" height="1500" fill="#FFFFFF"/>');
    expect(svg).toContain('data:image/svg+xml;base64,');
    expect(svg).not.toMatch(/href="https?:/);
    expect(await s.composites.renderStored(c1.manifest)).toBe(svg);
    expect(Object.keys(c1.assetUrls).sort()).toEqual(c1.manifest.items.map((i) => i.assetId!).sort());
  });

  it('a board shirt swap invalidates only that composite; the other pieces keep their renditions and places', async () => {
    const s = await visualScenario({ placeholders: true });
    const board = (await s.rec.composeAndPublish({ date: '2026-10-06' })).board!;
    const slots = slotsOf(board.options[0]!);
    const before = await s.composites.compose(slots);
    const top = slots.find((x) => x.role === 'base_top')!;
    const alt = (await s.studio.choices({ mode: 'today', date: '2026-10-06', role: 'base_top' })).items.find((i) => i.garmentId !== top.garmentId)!;
    const after = await s.composites.compose(slots.map((x) => (x.role === 'base_top' ? { ...x, garmentId: alt.garmentId } : x)));
    expect(after.manifestHash).not.toBe(before.manifestHash);
    expect(after.previewAssetId).not.toBe(before.previewAssetId);
    const rest = (m: typeof before.manifest) => m.items.filter((i) => i.role !== 'base_top').map((i) => `${i.garmentId}|${i.assetId}|${i.renditionSha256}|${i.x},${i.y}`);
    expect(rest(after.manifest)).toEqual(rest(before.manifest));
    // The earlier composite is still cached (used by the unswapped option).
    expect((await s.composites.compose(slots)).previewAssetId).toBe(before.previewAssetId);
  });

  it('a composite prefers a verified photograph over the demo placeholder once one exists', async () => {
    const s = await visualScenario({ placeholders: true });
    const shirt = await s.byName('Lightweight oxford — gold');
    const trousers = await s.byName('Di Sondrio beige chino');
    const slots = [{ garmentId: shirt, role: 'base_top' as const }, { garmentId: trousers, role: 'bottom' as const }];
    const a = await s.composites.manifestFor(slots);
    expect(a.manifest.items.find((i) => i.garmentId === shirt)!.assetClass).toBe('demo_placeholder');
    const real = await s.media.ingest({ bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="700" viewBox="0 0 600 700"><rect width="600" height="700" fill="#D9B44A"/></svg>'), kind: 'catalogue', assetClass: 'exact_product_photo', garmentId: shirt, link: 'catalogue', verified: true, transformation: { op: 'test', provider: null, params: {} } });
    const b = await s.composites.manifestFor(slots);
    expect(b.manifest.items.find((i) => i.garmentId === shirt)).toMatchObject({ assetId: real.assetId, assetClass: 'exact_product_photo', label: null });
    expect(b.manifestHash).not.toBe(a.manifestHash);
    expect((await s.media.garmentMedia([shirt])).get(shirt)).toMatchObject({ verified: true, catalogueAssetId: real.assetId, label: null });
  });

  it('an item name with markup is escaped in the stored composite', async () => {
    const s = await visualScenario({ placeholders: true });
    const r = await ok(s.principal, { type: 'add_item', explicit: true, name: 'Test <script>alert(1)</script> scarf', category: 'scarf', roles: ['accessory'], color: 'green' });
    const scarf = (r.facts as { garmentId: string }).garmentId;
    const trousers = await s.byName('Di Sondrio beige chino');
    const c = await s.composites.compose([{ garmentId: scarf, role: 'accessory' }, { garmentId: trousers, role: 'bottom' }]);
    const svg = await (await MediaService.serveSigned({ db: env.DB, bucket: env.MEDIA, signingKey: SIGNING_KEY }, c.previewAssetId!, tokenOf(c.previewUrl!))).text();
    expect(svg).not.toContain('<script');
    expect(checkTrustedSvg(svg).ok).toBe(true);
  });
});
