/**
 * ExtractionRouter: routes by the evidence needed. Readable copy and
 * size-chart text go Tavily basic -> Tavily advanced -> browser; variant,
 * visual and interactive needs go straight to the browser backend. Missing
 * fields produce another method or an explicit unresolved result, never
 * invented product facts.
 */
import { classifyExtraction } from "./evidence.ts";
import type { EvidenceEnvelope, ExpectedField, ExtractionClassification, ExtractionMethod } from "./evidence.ts";
import { assertPublicHttpsUrl, canonicalizeUrl, redactSecretsInUrl } from "./url.ts";
import {
  DEFAULT_BROWSER_TIMEOUT_MS,
  DEFAULT_TAVILY_TIMEOUT_MS,
  InMemoryMethodCache,
  MAX_BROWSER_TIMEOUT_MS,
  MAX_TAVILY_TIMEOUT_MS,
  TAVILY_MAX_URLS_PER_CALL,
  clampTimeout,
  withTimeout,
} from "./extract-types.ts";
import type {
  ExtractRequest,
  ExtractionAttempt,
  ExtractionNeed,
  ExtractionResult,
  ExtractionRouterDeps,
  MethodCache,
  TavilyExtractResponse,
} from "./extract-types.ts";

export * from "./extract-types.ts";
export * from "./tool-args.ts";

interface UrlState {
  url: string;
  domain: string;
  attempts: ExtractionAttempt[];
  evidence: EvidenceEnvelope | null;
}

interface Payload {
  finalUrl: string;
  content: string;
  images: string[];
  selectedVariant: EvidenceEnvelope["selectedVariant"];
}

const errorText = (error: unknown): string => redactText(error instanceof Error ? error.message : String(error));

/** Redacts key-bearing URLs inside free text such as backend error messages. */
export function redactText(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/g, (match) => redactSecretsInUrl(match));
}

function sameUrl(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return canonicalizeUrl(left) === canonicalizeUrl(right);
  } catch {
    return false;
  }
}

function imageCandidates(images: readonly string[]): { url: string }[] {
  const seen = new Set<string>();
  for (const image of images) {
    try {
      const parsed = new URL(image);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") seen.add(redactSecretsInUrl(image));
    } catch {
      // An unparseable image reference is not a candidate.
    }
  }
  return [...seen].map((url) => ({ url }));
}

function sourceAnchors(content: string, expectedFields: readonly ExpectedField[]): { label: string; quote: string }[] {
  const anchors: { label: string; quote: string }[] = [];
  for (const field of expectedFields) {
    const match = new RegExp(field.pattern.source, field.pattern.flags.replace(/[gy]/g, "")).exec(content);
    if (!match) continue;
    const start = Math.max(0, match.index - 60);
    const quote = content.slice(start, match.index + match[0].length + 60).replace(/\s+/g, " ").trim();
    anchors.push({ label: field.name, quote: quote.slice(0, 240) });
  }
  return anchors;
}

function observedVariant(variant: EvidenceEnvelope["selectedVariant"]): EvidenceEnvelope["selectedVariant"] {
  if (!variant) return null;
  const entries = Object.entries(variant).filter(([, value]) => typeof value === "string" && value.trim() !== "");
  return entries.length === 0 ? null : Object.fromEntries(entries);
}

function classify(payload: Payload, need: ExtractionNeed, expectedFields: ExpectedField[]): ExtractionClassification {
  if (need === "visual" && expectedFields.length === 0) {
    return imageCandidates(payload.images).length > 0
      ? { completeness: "complete", missingFields: [], reason: "visual evidence was captured" }
      : { completeness: "failed", missingFields: ["image"], reason: "no visual evidence was captured" };
  }
  const result = classifyExtraction(payload.content, expectedFields);
  if (need === "variant_state" && result.completeness !== "failed" && observedVariant(payload.selectedVariant) === null) {
    return {
      completeness: "partial",
      missingFields: [...result.missingFields, "selected_variant"],
      reason: "no selected variant was observed on the page",
    };
  }
  return result;
}

export class ExtractionRouter {
  private readonly deps: ExtractionRouterDeps;
  private readonly cache: MethodCache;
  private readonly tavilyTimeoutMs: number;
  private readonly browserTimeoutMs: number;

  constructor(deps: ExtractionRouterDeps) {
    this.deps = deps;
    this.cache = deps.cache ?? new InMemoryMethodCache();
    this.tavilyTimeoutMs = clampTimeout(deps.tavilyTimeoutMs, DEFAULT_TAVILY_TIMEOUT_MS, MAX_TAVILY_TIMEOUT_MS);
    this.browserTimeoutMs = clampTimeout(deps.browserTimeoutMs, DEFAULT_BROWSER_TIMEOUT_MS, MAX_BROWSER_TIMEOUT_MS);
  }

  /**
   * Returns one result per input URL, in input order. Throws UrlPolicyError
   * before any backend call when a URL is not a public HTTPS URL. URLs in
   * results are secret-redacted.
   */
  async extract(req: ExtractRequest): Promise<ExtractionResult[]> {
    const states: UrlState[] = req.urls.map((raw) => {
      const url = assertPublicHttpsUrl(raw);
      return { url, domain: new URL(url).hostname.toLowerCase(), attempts: [], evidence: null };
    });
    const pending = (list: UrlState[]): UrlState[] => list.filter((state) => state.evidence === null);

    if (req.need === "variant_state" || req.need === "visual" || req.need === "interactive") {
      for (const state of states) await this.runBrowser(state, req.need !== "visual", req);
    } else {
      const cached = new Map(states.map((state) => [state, this.cache.get(state.domain, this.deps.clock())]));
      const startsAt = (state: UrlState): "basic" | "advanced" | "browser" => {
        const method = cached.get(state);
        if (method === "tavily_advanced") return "advanced";
        return method === "browser_quick" || method === "browser_interactive" ? "browser" : "basic";
      };
      await this.runTavily("basic", states.filter((state) => startsAt(state) === "basic"), req);
      await this.runTavily("advanced", pending(states).filter((state) => startsAt(state) !== "browser"), req);
      for (const state of pending(states)) await this.runBrowser(state, false, req);
    }

    return states.map((state): ExtractionResult => {
      const url = redactSecretsInUrl(state.url);
      if (state.evidence) return { status: "resolved", url, evidence: state.evidence };
      const last = state.attempts[state.attempts.length - 1];
      const reason = last ? `${last.method}: ${last.reason}` : "no extraction method was attempted";
      return { status: "unresolved", url, reason, attempts: state.attempts };
    });
  }

  private async runTavily(depth: "basic" | "advanced", states: UrlState[], req: ExtractRequest): Promise<void> {
    const method: ExtractionMethod = depth === "basic" ? "tavily_basic" : "tavily_advanced";
    const unique = [...new Set(states.map((state) => state.url))];
    for (let start = 0; start < unique.length; start += TAVILY_MAX_URLS_PER_CALL) {
      const urls = unique.slice(start, start + TAVILY_MAX_URLS_PER_CALL);
      const batch = states.filter((state) => urls.includes(state.url));
      let response: TavilyExtractResponse;
      try {
        const call = this.deps.tavily.extract({ urls, depth, includeImages: true, timeoutMs: this.tavilyTimeoutMs });
        response = await withTimeout(call, this.tavilyTimeoutMs + 1_000, "Tavily extract");
      } catch (error) {
        for (const state of batch) this.fail(state, method, `extract call failed: ${errorText(error)}`);
        continue;
      }
      // Per-URL failures are inspected even though the call itself succeeded.
      for (const state of batch) {
        const failure = response.failed.find((entry) => sameUrl(entry.url, state.url));
        const result = response.results.find((entry) => sameUrl(entry.url, state.url));
        if (failure) this.fail(state, method, `per-URL failure: ${redactText(failure.error)}`);
        else if (!result) this.fail(state, method, "no result was returned for this URL");
        else {
          const payload = { finalUrl: result.url, content: result.content, images: result.images ?? [], selectedVariant: null };
          this.consider(state, method, payload, req);
        }
      }
    }
  }

  private async runBrowser(state: UrlState, interactive: boolean, req: ExtractRequest): Promise<void> {
    const method: ExtractionMethod = interactive ? "browser_interactive" : "browser_quick";
    try {
      const call = this.deps.browser.render({ url: state.url, interactive, timeoutMs: this.browserTimeoutMs });
      this.consider(state, method, await withTimeout(call, this.browserTimeoutMs + 1_000, "Browser render"), req);
    } catch (error) {
      this.fail(state, method, `render failed: ${errorText(error)}`);
    }
  }

  private fail(state: UrlState, method: ExtractionMethod, reason: string): void {
    state.attempts.push({ method, outcome: "error", reason, missingFields: [] });
  }

  private consider(state: UrlState, method: ExtractionMethod, payload: Payload, req: ExtractRequest): void {
    let finalUrl: string;
    try {
      finalUrl = assertPublicHttpsUrl(payload.finalUrl);
    } catch {
      this.fail(state, method, "the final URL is not a public HTTPS URL");
      return;
    }
    const verdict = classify(payload, req.need, req.expectedFields);
    const { completeness, missingFields, reason } = verdict;
    state.attempts.push({ method, outcome: completeness, reason, missingFields });
    if (completeness !== "complete") return;

    const now = this.deps.clock();
    this.cache.set(state.domain, method, now);
    const earlier = state.attempts.slice(0, -1);
    state.evidence = {
      canonicalUrl: canonicalizeUrl(redactSecretsInUrl(state.url)),
      finalUrl: redactSecretsInUrl(finalUrl),
      retrievedAt: new Date(now).toISOString(),
      content: payload.content,
      imageCandidates: imageCandidates(payload.images),
      selectedVariant: observedVariant(payload.selectedVariant),
      method,
      completeness,
      sourceAnchors: sourceAnchors(payload.content, req.expectedFields),
      failures: earlier.map((attempt) => ({ url: redactSecretsInUrl(state.url), reason: `${attempt.method}: ${attempt.reason}` })),
      extractor: method.startsWith("tavily") ? "tavily-extract" : "browser-run",
      missingFields,
    };
  }
}
