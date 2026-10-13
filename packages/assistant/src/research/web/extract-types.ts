/**
 * Injected interfaces, result types and the per-domain method cache used by
 * the ExtractionRouter. Vendor specifics stay behind the backends; the
 * request type deliberately has no generated-answer option. Re-exported from
 * extract.ts.
 */
import type { Completeness, EvidenceEnvelope, ExpectedField, ExtractionMethod } from "./evidence.ts";

export const TAVILY_MAX_URLS_PER_CALL = 20;
export const DEFAULT_TAVILY_TIMEOUT_MS = 30_000;
export const MAX_TAVILY_TIMEOUT_MS = 60_000;
export const DEFAULT_BROWSER_TIMEOUT_MS = 45_000;
export const MAX_BROWSER_TIMEOUT_MS = 120_000;
export const DEFAULT_METHOD_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface TavilyExtractRequest {
  urls: string[];
  depth: "basic" | "advanced";
  /** Image URLs are always requested for asset discovery. */
  includeImages: true;
  timeoutMs: number;
}

export interface TavilyExtractResponse {
  results: { url: string; content: string; images?: string[] }[];
  failed: { url: string; error: string }[];
}

export interface TavilyExtractBackend {
  extract(req: TavilyExtractRequest): Promise<TavilyExtractResponse>;
}

export interface BrowserRenderRequest {
  url: string;
  interactive: boolean;
  timeoutMs: number;
}

export interface BrowserRenderResponse {
  finalUrl: string;
  content: string;
  images: string[];
  selectedVariant: EvidenceEnvelope["selectedVariant"];
}

export interface BrowserFetchBackend {
  render(req: BrowserRenderRequest): Promise<BrowserRenderResponse>;
}

export type ExtractionNeed = "readable_copy" | "size_chart_text" | "variant_state" | "visual" | "interactive";

export interface ExtractRequest {
  urls: string[];
  need: ExtractionNeed;
  expectedFields: ExpectedField[];
}

export interface ExtractionAttempt {
  method: ExtractionMethod;
  /** `error` means the backend call or that URL failed; the others come from content classification. */
  outcome: Completeness | "error";
  reason: string;
  missingFields: string[];
}

export interface ResolvedExtraction {
  status: "resolved";
  url: string;
  evidence: EvidenceEnvelope;
}

export interface UnresolvedExtraction {
  status: "unresolved";
  url: string;
  reason: string;
  attempts: ExtractionAttempt[];
}

export type ExtractionResult = ResolvedExtraction | UnresolvedExtraction;

/** Remembers which extraction method last succeeded for a domain, for a bounded period. */
export interface MethodCache {
  get(domain: string, nowMs: number): ExtractionMethod | null;
  set(domain: string, method: ExtractionMethod, nowMs: number): void;
}

export class InMemoryMethodCache implements MethodCache {
  private readonly entries = new Map<string, { method: ExtractionMethod; expiresAt: number }>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_METHOD_CACHE_TTL_MS) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError("ttlMs must be a positive number");
    this.ttlMs = ttlMs;
  }

  get(domain: string, nowMs: number): ExtractionMethod | null {
    const key = domain.toLowerCase();
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (nowMs >= entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    return entry.method;
  }

  set(domain: string, method: ExtractionMethod, nowMs: number): void {
    this.entries.set(domain.toLowerCase(), { method, expiresAt: nowMs + this.ttlMs });
  }
}

export interface ExtractionRouterDeps {
  tavily: TavilyExtractBackend;
  browser: BrowserFetchBackend;
  /** Milliseconds since the Unix epoch. */
  clock: () => number;
  /** Defaults to an InMemoryMethodCache with a 7 day expiry. */
  cache?: MethodCache;
  /** Clamped to 1 s .. MAX_TAVILY_TIMEOUT_MS. */
  tavilyTimeoutMs?: number;
  /** Clamped to 1 s .. MAX_BROWSER_TIMEOUT_MS. */
  browserTimeoutMs?: number;
}

export function clampTimeout(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 1_000), max);
}

/** Rejects when the promise does not settle within `timeoutMs`. */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
