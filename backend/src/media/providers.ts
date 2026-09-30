/**
 * Provider interfaces for the visual catalogue pipeline (spec section 11). Real adapters (Exa/Tavily
 * image search, Browser Run, a background-removal model, an image-editing model, a vision analyzer)
 * implement these; tests and local runs use the fakes in fakes.ts. No provider decides adoption or
 * fidelity: those are deterministic checks in fidelity.ts over the analyzer's descriptors.
 */

/** What an analyzer reports about one garment image. */
export interface ImageDescriptor {
  /** Garment type seen (shirt, trousers, jacket, coat, shoes, ...). */
  garmentKind: string;
  /** Dominant colours, most prominent first, as #RRGGBB. */
  dominantColours: string[];
  pattern: string | null;
  /** Counted details: pockets, buttons, seams, eyelets ... */
  details: Record<string, number>;
  /** Silhouette class (e.g. shirt-long-sleeve, trousers-straight, coat-long). */
  silhouette: string;
  /** Components present (collar, placket, cuffs, belt loops, laces ...). */
  components: string[];
  clipped: boolean;
  halo: boolean;
  pose: 'front_flat' | 'on_body' | 'angled' | 'unknown';
  background: 'transparent' | 'neutral' | 'busy';
  width: number | null;
  height: number | null;
}

export interface ImageAnalyzer {
  readonly name: string;
  describe(bytes: Uint8Array, contentType: string): Promise<ImageDescriptor>;
}

export interface CutoutResult {
  image: Uint8Array;
  mask: Uint8Array | null;
}

export interface BackgroundRemover {
  readonly name: string;
  cutout(bytes: Uint8Array, contentType: string): Promise<CutoutResult>;
}

/** Constraints passed with every generative edit: the edit must preserve the garment. */
export interface EditConstraints {
  preserve: ('colour' | 'pattern_scale' | 'pockets' | 'buttons' | 'seams' | 'silhouette')[];
  target: 'front_flat_catalogue';
  background: '#FFFFFF';
}

export interface ImageEditor {
  readonly name: string;
  edit(bytes: Uint8Array, contentType: string, constraints: EditConstraints): Promise<{ image: Uint8Array }>;
}

/** Garment facts a search uses. Identifiers rank first. */
export interface GarmentSearchFacts {
  garmentId: string;
  name: string;
  category: string;
  maker: string | null;
  productName: string | null;
  productCode: string | null;
  color: string | null;
  fabric: string | null;
  attributes: Record<string, unknown>;
}

export type SearchStrategy = 'purchase_source' | 'manufacturer_archive' | 'identifier_search';

export interface ImageCandidate {
  imageUrl: string;
  pageUrl: string;
  pageTitle: string;
  /** Identifiers read from the source page behind the image (never from the image result alone). */
  pageIdentifiers: { productCode?: string | null; maker?: string | null; productName?: string | null; colourway?: string | null; generation?: string | null };
  /** True when the page needed a browser session (counts against the per-garment allowance). */
  viaBrowser: boolean;
  /** A provider's own confidence number. Recorded, never used to promote a candidate. */
  providerConfidence?: number | null;
  permittedUse?: string | null;
}

export interface ProductImageSearch {
  readonly name: string;
  /** Where the strategy looks this time; a retry must use a different source key. */
  sourceKey(facts: GarmentSearchFacts, strategy: SearchStrategy): string | null;
  find(facts: GarmentSearchFacts, strategy: SearchStrategy, maxPages: number): Promise<ImageCandidate[]>;
}

export interface ImageFetcher {
  readonly name: string;
  fetchImage(url: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
}

/** Optional provider for imagined whole-outfit renderings. Output is always labelled and never a catalogue image. */
export interface ImageGenerator {
  readonly name: string;
  generate(prompt: string): Promise<{ image: Uint8Array }>;
}

export interface MediaProviders {
  search?: ProductImageSearch | null;
  fetcher?: ImageFetcher | null;
  analyzer?: ImageAnalyzer | null;
  cutout?: BackgroundRemover | null;
  editor?: ImageEditor | null;
  generator?: ImageGenerator | null;
}
