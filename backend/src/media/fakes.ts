import { sha256Bytes, sniff } from './sniff.js';
import { rootDataAttributes } from './svg.js';
import type {
  BackgroundRemover,
  CutoutResult,
  EditConstraints,
  GarmentSearchFacts,
  ImageAnalyzer,
  ImageCandidate,
  ImageDescriptor,
  ImageEditor,
  ImageFetcher,
  ImageGenerator,
  ProductImageSearch,
  SearchStrategy,
} from './providers.js';

/**
 * Deterministic fakes for the visual pipeline. They operate on Garderobe's placeholder SVG format,
 * whose root element describes the drawn garment in data-* attributes (kind, colours, pattern,
 * details, silhouette, components, pose, background). The analyzer reads those attributes, and the
 * cutout and editor fakes really change them, so the fidelity checks run on genuine differences.
 * Raster images use descriptors registered by content hash.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function setRootData(svg: string, name: string, value: string): string {
  const re = new RegExp(`(<svg\\b[^>]*?)\\sdata-${name}="[^"]*"`);
  if (re.test(svg)) return svg.replace(re, `$1 data-${name}="${value}"`);
  return svg.replace(/<svg\b/, `<svg data-${name}="${value}"`);
}

export function descriptorFromSvg(svg: string): ImageDescriptor {
  const a = rootDataAttributes(svg);
  const s = sniff(enc.encode(svg));
  const details: Record<string, number> = {};
  for (const part of (a.details ?? '').split(';').filter(Boolean)) {
    const [k, v] = part.split(':');
    if (k) details[k] = Number(v ?? 0);
  }
  return {
    garmentKind: a.kind ?? 'unknown',
    dominantColours: (a.colours ?? '').split(',').filter(Boolean),
    pattern: a.pattern && a.pattern !== 'plain' ? a.pattern : null,
    details,
    silhouette: a.silhouette ?? 'unknown',
    components: (a.components ?? '').split(',').filter(Boolean),
    clipped: a.clipped === 'true',
    halo: a.halo === 'true',
    pose: (a.pose as ImageDescriptor['pose']) ?? 'unknown',
    background: (a.background as ImageDescriptor['background']) ?? 'neutral',
    width: s.width,
    height: s.height,
  };
}

export class FakeImageAnalyzer implements ImageAnalyzer {
  readonly name = 'fake-analyzer';
  readonly raster = new Map<string, ImageDescriptor>();
  calls = 0;
  async register(bytes: Uint8Array, d: ImageDescriptor): Promise<void> {
    this.raster.set(await sha256Bytes(bytes), d);
  }
  async describe(bytes: Uint8Array, contentType: string): Promise<ImageDescriptor> {
    this.calls++;
    if (contentType === 'image/svg+xml') return descriptorFromSvg(dec.decode(bytes));
    const d = this.raster.get(await sha256Bytes(bytes));
    if (!d) throw new Error('fake analyzer: no descriptor registered for this raster image');
    return d;
  }
}

export class FakeBackgroundRemover implements BackgroundRemover {
  readonly name = 'fake-cutout';
  calls = 0;
  constructor(private readonly opts: { halo?: boolean; clip?: boolean; fail?: boolean } = {}) {}
  async cutout(bytes: Uint8Array, contentType: string): Promise<CutoutResult> {
    this.calls++;
    if (this.opts.fail) throw new Error('fake cutout provider failure');
    if (contentType !== 'image/svg+xml') return { image: bytes, mask: null };
    let svg = dec.decode(bytes).replace(/<rect data-role="background"[^>]*\/>/g, '');
    svg = setRootData(svg, 'background', 'transparent');
    if (this.opts.halo) svg = setRootData(svg, 'halo', 'true');
    if (this.opts.clip) svg = setRootData(svg, 'clipped', 'true');
    const s = sniff(bytes);
    const w = s.width ?? 100;
    const h = s.height ?? 100;
    const mask = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" data-garderobe="mask"><rect width="${w}" height="${h}" fill="#000000"/></svg>`;
    return { image: enc.encode(svg), mask: enc.encode(mask) };
  }
}

export type FakeEditMode = 'faithful' | 'recolour' | 'drop_pockets' | 'change_silhouette' | 'change_pattern' | 'throw';

export class FakeImageEditor implements ImageEditor {
  readonly name = 'fake-editor';
  calls = 0;
  lastConstraints: EditConstraints | null = null;
  constructor(public mode: FakeEditMode = 'faithful') {}
  async edit(bytes: Uint8Array, contentType: string, constraints: EditConstraints): Promise<{ image: Uint8Array }> {
    this.calls++;
    this.lastConstraints = constraints;
    if (this.mode === 'throw') throw new Error('fake editor: provider error');
    if (contentType !== 'image/svg+xml') return { image: bytes };
    let svg = setRootData(dec.decode(bytes), 'pose', 'front_flat');
    const a = rootDataAttributes(svg);
    if (this.mode === 'recolour') {
      const first = (a.colours ?? '').split(',')[0] ?? '#000000';
      svg = setRootData(svg, 'colours', (a.colours ?? '').replace(first, '#1F2A44'));
      svg = svg.split(first).join('#1F2A44');
    }
    if (this.mode === 'drop_pockets') svg = setRootData(svg, 'details', (a.details ?? '').replace(/pockets:\d+/, 'pockets:0'));
    if (this.mode === 'change_silhouette') svg = setRootData(svg, 'silhouette', `${a.silhouette ?? 'x'}-cropped`);
    if (this.mode === 'change_pattern') svg = setRootData(svg, 'pattern', a.pattern === 'stripe' ? 'plain' : 'stripe');
    return { image: enc.encode(svg) };
  }
}

export class FakeProductImageSearch implements ProductImageSearch {
  readonly name = 'fake-image-search';
  readonly calls: { garmentId: string; strategy: SearchStrategy; maxPages: number; sourceKey: string | null }[] = [];
  private readonly sourceVersion = new Map<string, number>();
  constructor(private readonly byGarment: Record<string, Partial<Record<SearchStrategy, ImageCandidate[]>>> = {}, private readonly opts: { noPurchaseSource?: boolean } = {}) {}
  set(garmentId: string, strategy: SearchStrategy, candidates: ImageCandidate[]): void {
    (this.byGarment[garmentId] ??= {})[strategy] = candidates;
  }
  /** Simulate a new place to look (e.g. the owner supplied a new product link). */
  newSource(garmentId: string): void {
    this.sourceVersion.set(garmentId, (this.sourceVersion.get(garmentId) ?? 0) + 1);
  }
  sourceKey(facts: GarmentSearchFacts, strategy: SearchStrategy): string | null {
    if (strategy === 'purchase_source' && this.opts.noPurchaseSource) return null;
    return `${strategy}:${facts.garmentId}:v${this.sourceVersion.get(facts.garmentId) ?? 0}`;
  }
  async find(facts: GarmentSearchFacts, strategy: SearchStrategy, maxPages: number): Promise<ImageCandidate[]> {
    this.calls.push({ garmentId: facts.garmentId, strategy, maxPages, sourceKey: this.sourceKey(facts, strategy) });
    return (this.byGarment[facts.garmentId]?.[strategy] ?? []).slice(0, maxPages);
  }
}

export class FakeImageFetcher implements ImageFetcher {
  readonly name = 'fake-fetcher';
  readonly fetched: string[] = [];
  constructor(private readonly images: Map<string, { bytes: Uint8Array; contentType: string }> = new Map()) {}
  put(url: string, bytes: Uint8Array, contentType: string): void {
    this.images.set(url, { bytes, contentType });
  }
  async fetchImage(url: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    this.fetched.push(url);
    return this.images.get(url) ?? null;
  }
}

/** Produces a labelled SVG "imagined" look; used to prove imagined renderings stay out of the catalogue. */
export class FakeImageGenerator implements ImageGenerator {
  readonly name = 'fake-generator';
  async generate(prompt: string): Promise<{ image: Uint8Array }> {
    const safe = prompt.replace(/[^A-Za-z0-9 ,.-]/g, '').slice(0, 80);
    return {
      image: enc.encode(
        `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800" data-garderobe="imagined"><rect width="600" height="800" fill="#EEEEEE"/><text x="300" y="400" text-anchor="middle" font-size="20">Imagined: ${safe}</text></svg>`,
      ),
    };
  }
}
