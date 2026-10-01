/**
 * Adapter interfaces for capabilities this package does not own. Each one isolates a provider contract:
 * nothing here guesses a preview API, and an absent adapter is reported as unavailable in the job
 * result instead of being replaced by invented output.
 */
import type { Db, Principal } from "@garderobe/domain";
import type { Role } from "@garderobe/contracts";
import type { DiscoveryStrategy } from "@garderobe/contracts/ext/media";

/* ------------------------------ outfit validation ------------------------------ */

export interface ValidatorSlot {
  role: Role;
  garmentId: string;
}

export interface ValidatorViolation {
  code: string;
  message: string;
  garmentIds: string[];
  severity: "blocking" | "advisory";
  ruleKey?: string | null;
}

export interface ValidatorResult {
  valid: boolean;
  violations: ValidatorViolation[];
  evidence?: Record<string, unknown>;
}

/**
 * The daily service's validation interface (`outfitValidator` exported by `@garderobe/daily` matches
 * this shape). Studio never decides eligibility, availability or profile rules itself.
 */
export interface OutfitValidator {
  /** Shown in `StudioValidation.validator`. */
  name?: string;
  validate(db: Db, principal: Principal, input: { slots: ValidatorSlot[]; forDate: string; mode: "for_today" | "explore"; nowMs?: number }): Promise<ValidatorResult>;
  suggest?(
    db: Db,
    principal: Principal,
    input: { locked: ValidatorSlot[]; openRoles: Role[]; forDate: string; mode: "for_today" | "explore"; limit?: number },
  ): Promise<{ slots: ValidatorSlot[]; reason: string; validation?: ValidatorResult }[]>;
}

/* ------------------------------ image capabilities ------------------------------ */

/** Model-based background removal for photographs the deterministic cutout declines (cluttered backgrounds). */
export interface BackgroundRemover {
  name: string;
  version: string;
  /** Returns a PNG with transparency, or an explanation. Must not alter foreground pixels. */
  remove(input: { bytes: Uint8Array; contentType: string }): Promise<{ ok: true; png: Uint8Array } | { ok: false; reason: string }>;
}

/** Transcodes formats this package cannot decode itself (WebP, HEIC) to PNG. */
export interface ImageTranscoder {
  name: string;
  version: string;
  toPng(input: { bytes: Uint8Array; contentType: string; maxEdge: number }): Promise<{ ok: true; png: Uint8Array } | { ok: false; reason: string }>;
}

/** The explicit constraints every edit request carries (specification section 11). */
export const EDIT_CONSTRAINTS = ["colour", "pattern scale", "pockets", "buttons", "seams", "silhouette"] as const;

export interface ImageEditRequest {
  /** The ACTUAL image being edited - only this one image is ever supplied to the provider. */
  image: { bytes: Uint8Array; contentType: string };
  instruction: string;
  preserve: readonly string[];
  /** Stable key so a repeated job never pays for the same edit twice. */
  idempotencyKey: string;
}

export type ImageEditResult =
  | { status: "ok"; bytes: Uint8Array; contentType: string; model: string; providerJobId: string | null; reconstructsUnseen: boolean }
  | { status: "failed"; reason: string }
  /** A paid request whose outcome is unknown: it must be reconciled, never blindly retried. */
  | { status: "unknown_outcome"; providerJobId: string | null; reason: string };

/** A dedicated image-editing model behind the model service (AI Gateway). Provider-neutral. */
export interface ImageEditProvider {
  name: string;
  edit(request: ImageEditRequest): Promise<ImageEditResult>;
}

/* ------------------------------ discovery ------------------------------ */

export interface DiscoveryGarment {
  garmentId: string;
  name: string;
  category: string;
  maker: string | null;
  product: string | null;
  colour: string | null;
  pattern: string | null;
  fabric: string | null;
  size: string | null;
  /** Exact external codes recorded for the garment (fabric codes, product references). */
  codes: string[];
  /** Model / generation token recorded for the garment, e.g. "990v4". */
  model: string | null;
  purchaseLink: string | null;
  /** Recorded cut/fit descriptor, when the garment has one. */
  cut: string | null;
}

export interface DiscoveryQuery {
  strategy: DiscoveryStrategy;
  garment: DiscoveryGarment;
  /** Canonical query text; together with the strategy and provider it identifies an attempt. */
  text: string;
}

/** What a provider reports about one candidate page. Everything here is UNTRUSTED source material. */
export interface DiscoveryCandidatePage {
  pageUrl: string;
  imageUrl: string;
  title: string | null;
  sourceClass: "purchase_source" | "maker" | "retailer" | "other";
  identifiers: {
    productCodes?: string[];
    maker?: string | null;
    productName?: string | null;
    colourway?: string | null;
    generation?: string | null;
    cut?: string | null;
  };
  retrievedAt: string;
  /** Set only by a provider that fetched the garment's OWN stored purchase link (not a search result). */
  recordedPurchaseLink?: boolean;
  /** A model's self-reported confidence. Recorded, and NEVER used to adopt a candidate. */
  modelConfidence?: number;
}

export interface DiscoveryProviderResult {
  pages: DiscoveryCandidatePage[];
  browserSessions: number;
  browserSeconds: number;
  error?: string;
}

export interface DiscoveryProvider {
  name: string;
  strategies: DiscoveryStrategy[];
  /** True when the provider consumes Browser Run time (paced against the daily allowance). */
  usesBrowser: boolean;
  search(query: DiscoveryQuery, budget: { maxPages: number; maxBrowserSessions: number }): Promise<DiscoveryProviderResult>;
}

/** Fetches one candidate image. The default implementation enforces destination, redirect, time and size limits. */
export interface ImageFetcher {
  fetchImage(url: string, limits: { maxBytes: number }): Promise<{ ok: true; bytes: Uint8Array; contentType: string | null; finalUrl: string } | { ok: false; reason: string }>;
}

/* ------------------------------ preview export ------------------------------ */

/**
 * Optional alternative raster exporter (e.g. Browser Run rendering the SVG scene). The built-in
 * deterministic compositor is used when none is supplied.
 */
export interface RasterPreviewExporter {
  name: string;
  renderSvgToPng(input: { svg: string; width: number; height: number }): Promise<{ ok: true; png: Uint8Array } | { ok: false; reason: string }>;
}
