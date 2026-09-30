import type { FidelityCheck, FidelityReport } from '@garderobe/contracts';
import type { GarmentSearchFacts, ImageCandidate, ImageDescriptor } from './providers.js';

/**
 * Deterministic image-fidelity and product-match checks (spec section 11). A model may describe an
 * image; only these rules decide whether a rendition keeps the garment's identity or whether a found
 * photograph is the exact product. An uncalibrated confidence number never promotes a candidate.
 */

export const FIDELITY_VERSION = 'image-fidelity/1';
/** CIE76 ΔE above which a dominant colour counts as changed. ~10 is a clearly visible difference. */
export const MAX_COLOUR_DELTA_E = 10;

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toLab([r, g, b]: [number, number, number]): [number, number, number] {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

export function deltaE(a: string, b: string): number | null {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  if (!ra || !rb) return null;
  const [l1, a1, b1] = toLab(ra);
  const [l2, a2, b2] = toLab(rb);
  return Math.round(Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2) * 100) / 100;
}

/**
 * Compare a derived rendition with its original. `poseMayChange` is true for a generative edit whose
 * purpose is a front-flat catalogue view; nothing else may change.
 */
export function checkFidelity(original: ImageDescriptor, derived: ImageDescriptor): FidelityReport {
  const checks: FidelityCheck[] = [];
  const add = (name: FidelityCheck['name'], passed: boolean, detail: string) => checks.push({ name, passed, detail });

  add('garment_identity', original.garmentKind === derived.garmentKind, original.garmentKind === derived.garmentKind ? `Still a ${derived.garmentKind}` : `Changed from ${original.garmentKind} to ${derived.garmentKind}`);

  let maxDe: number | null = null;
  const colourProblems: string[] = [];
  for (const c of original.dominantColours) {
    const distances = derived.dominantColours.map((d) => deltaE(c, d)).filter((x): x is number => x !== null);
    const best = distances.length ? Math.min(...distances) : null;
    if (best === null) colourProblems.push(`${c} missing`);
    else {
      maxDe = Math.max(maxDe ?? 0, best);
      if (best > MAX_COLOUR_DELTA_E) colourProblems.push(`${c} shifted (ΔE ${best})`);
    }
  }
  add('dominant_colours', colourProblems.length === 0, colourProblems.length ? `Colour changed: ${colourProblems.join(', ')}` : `Dominant colours kept (max ΔE ${maxDe ?? 0})`);

  const samePattern = (original.pattern ?? 'plain') === (derived.pattern ?? 'plain');
  add('pattern', samePattern, samePattern ? `Pattern kept (${original.pattern ?? 'plain'})` : `Pattern changed from ${original.pattern ?? 'plain'} to ${derived.pattern ?? 'plain'}`);

  const detailProblems = Object.entries(original.details)
    .filter(([k, n]) => (derived.details[k] ?? 0) !== n)
    .map(([k, n]) => `${k} ${n} → ${derived.details[k] ?? 0}`);
  add('details', detailProblems.length === 0, detailProblems.length ? `Details changed: ${detailProblems.join(', ')}` : 'Pockets, buttons and seams kept');

  add('silhouette', original.silhouette === derived.silhouette, original.silhouette === derived.silhouette ? 'Silhouette kept' : `Silhouette changed from ${original.silhouette} to ${derived.silhouette}`);
  add('clipping', !derived.clipped, derived.clipped ? 'Part of the garment is clipped' : 'Nothing clipped');
  add('halo', !derived.halo, derived.halo ? 'Background halo around the cutout' : 'No halo');
  const missing = original.components.filter((c) => !derived.components.includes(c));
  add('components', missing.length === 0, missing.length ? `Missing components: ${missing.join(', ')}` : 'All components present');

  return { passed: checks.every((c) => c.passed), checks, maxColourDeltaE: maxDe };
}

// ------------------------------------------------------------------ product identity

const CATEGORY_KIND: Record<string, string[]> = {
  shirt: ['shirt'],
  tshirt: ['tshirt', 'shirt'],
  polo: ['polo', 'shirt'],
  knitwear: ['knitwear', 'sweater'],
  sweatshirt: ['sweatshirt', 'knitwear'],
  trousers: ['trousers'],
  jeans: ['jeans', 'trousers'],
  shorts: ['shorts'],
  blazer: ['blazer', 'jacket'],
  jacket: ['jacket'],
  coat: ['coat', 'jacket'],
  overshirt: ['overshirt', 'shirt', 'jacket'],
  shoes: ['shoes'],
  sneakers: ['sneakers', 'shoes'],
  boots: ['boots', 'shoes'],
  socks: ['socks'],
  belt: ['belt'],
  scarf: ['scarf'],
  tie: ['tie'],
  hat: ['hat'],
};

const COLOUR_WORDS: [RegExp, string][] = [
  [/navy|ink/, 'navy'], [/black/, 'black'], [/white|ecru|off-white/, 'white'], [/cream/, 'cream'], [/beige|sand|stone|camel|khaki|tan/, 'beige'],
  [/brown|tobacco|chocolate|mocha|walnut/, 'brown'], [/grey|gray|charcoal/, 'grey'], [/olive|fatigue/, 'olive'], [/green|forest|sage|moss/, 'green'],
  [/rust|clay|brick|orange/, 'rust'], [/burgundy|wine|maroon/, 'burgundy'], [/pink|rose/, 'pink'], [/red/, 'red'], [/yellow|gold|ochre|mustard/, 'gold'],
  [/blue|indigo|denim|sky/, 'blue'],
];

export function colourWords(text: string | null | undefined): string[] {
  const t = (text ?? '').toLowerCase();
  return COLOUR_WORDS.filter(([re]) => re.test(t)).map(([, w]) => w);
}

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export interface CandidateDecision {
  decision: 'adopt' | 'uncertain' | 'reject';
  reasons: string[];
  evidence: { identifierMatch: boolean; makerMatch: boolean; nameMatch: boolean; colourwayMatch: boolean | null; qualityPassed: boolean; providerConfidenceIgnored: number | null };
}

export const MIN_CATALOGUE_SIDE = 600;

/**
 * Decide whether a candidate photograph shows the exact recorded garment. Adoption needs strong
 * identity evidence from the source page (exact product code, or maker + exact product name +
 * matching colourway) and passing quality checks. Wrong colourways, different generations and
 * different garment types are rejected; everything else is uncertain and never adopted automatically.
 */
export function matchCandidate(facts: GarmentSearchFacts, candidate: ImageCandidate, d: ImageDescriptor): CandidateDecision {
  const reasons: string[] = [];
  const id = candidate.pageIdentifiers;
  const identifierMatch = Boolean(facts.productCode && id.productCode && norm(facts.productCode) === norm(id.productCode));
  const makerMatch = Boolean(facts.maker && id.maker && norm(facts.maker) === norm(id.maker));
  const nameMatch = Boolean(facts.productName && id.productName && norm(facts.productName) === norm(id.productName));
  const wanted = colourWords(facts.color);
  const offered = colourWords(id.colourway);
  const colourwayMatch = wanted.length && offered.length ? offered.some((c) => wanted.includes(c)) && wanted.every((c) => offered.includes(c) || wanted.length > 1) : null;
  const genWanted = typeof facts.attributes.generation === 'string' ? facts.attributes.generation : typeof facts.attributes.model === 'string' ? facts.attributes.model : null;
  const kinds = CATEGORY_KIND[facts.category] ?? [facts.category];

  let reject = false;
  if (!kinds.includes(d.garmentKind)) {
    reasons.push(`The image shows a ${d.garmentKind}, not a ${facts.category}`);
    reject = true;
  }
  if (colourwayMatch === false) {
    reasons.push(`Wrong colourway: page says "${id.colourway}", the garment is ${facts.color}`);
    reject = true;
  }
  if (genWanted && id.generation && norm(genWanted) !== norm(id.generation)) {
    reasons.push(`Different generation: ${id.generation} vs ${genWanted}`);
    reject = true;
  }
  if (facts.productCode && id.productCode && !identifierMatch) {
    reasons.push(`Different product code: ${id.productCode} vs ${facts.productCode}`);
    reject = true;
  }
  const minSide = d.width && d.height ? Math.min(d.width, d.height) : 0;
  const qualityPassed = minSide >= MIN_CATALOGUE_SIDE && !d.clipped && d.background !== 'busy';
  if (!qualityPassed) reasons.push(`Image quality: ${minSide < MIN_CATALOGUE_SIDE ? `smallest side ${minSide}px < ${MIN_CATALOGUE_SIDE}px` : d.clipped ? 'garment clipped' : 'busy background'}`);
  const strong = identifierMatch || (makerMatch && nameMatch && colourwayMatch === true);
  if (!reject && !strong) reasons.push('Identity not established from the source page (lookalike)');
  const evidence = { identifierMatch, makerMatch, nameMatch, colourwayMatch, qualityPassed, providerConfidenceIgnored: candidate.providerConfidence ?? null };
  if (reject) return { decision: 'reject', reasons, evidence };
  if (strong && qualityPassed) return { decision: 'adopt', reasons: [identifierMatch ? 'Exact product code on the source page' : 'Maker, product name and colourway match on the source page'], evidence };
  return { decision: 'uncertain', reasons, evidence };
}

/** Exact-identifier candidates first, then pages naming maker and product, then the rest (stable). */
export function rankCandidates(facts: GarmentSearchFacts, candidates: ImageCandidate[]): ImageCandidate[] {
  const score = (c: ImageCandidate) =>
    (facts.productCode && c.pageIdentifiers.productCode && norm(facts.productCode) === norm(c.pageIdentifiers.productCode) ? 4 : 0) +
    (facts.maker && c.pageIdentifiers.maker && norm(facts.maker) === norm(c.pageIdentifiers.maker) ? 1 : 0) +
    (facts.productName && c.pageIdentifiers.productName && norm(facts.productName) === norm(c.pageIdentifiers.productName) ? 1 : 0) +
    (c.viaBrowser ? 0 : 0.5);
  return candidates.map((c, i) => ({ c, i, s: score(c) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.c);
}

/** One sentence describing the photograph that would resolve the garment. */
export function photoRequest(name: string, category: string): string {
  const detail: Record<string, string> = {
    shirt: 'collar, buttons and any pocket visible',
    tshirt: 'neckline and any print visible',
    polo: 'collar and placket visible',
    knitwear: 'the knit texture and neckline visible',
    sweatshirt: 'neckline and cuffs visible',
    trousers: 'waistband and pockets visible',
    jeans: 'the wash, waistband and pockets visible',
    shorts: 'waistband and pockets visible',
    blazer: 'lapels, buttons and pockets visible',
    jacket: 'collar, fastening and pockets visible',
    coat: 'the full length, collar and fastening visible',
    overshirt: 'collar, buttons and pockets visible',
    shoes: 'one shoe in side profile and the toe from above',
    sneakers: 'one shoe in side profile showing the sole and colours',
    boots: 'one boot in side profile showing the sole and lacing',
    socks: 'one sock laid flat showing its colour and pattern',
    belt: 'the buckle and a length of the strap',
    scarf: 'folded to show its pattern and colours',
    tie: 'laid flat showing its pattern and the tip',
    hat: 'from the front and side',
  };
  return `A front-on photo of the ${name} laid flat on a plain light background in daylight, with ${detail[category] ?? 'the whole piece visible'}.`;
}
