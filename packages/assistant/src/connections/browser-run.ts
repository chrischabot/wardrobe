/**
 * Browser Run adapter: the page-retrieval backend of the extraction router, over the Worker binding's
 * Quick Actions (specification section 10).
 *
 * Contract verified against Cloudflare's Browser Run documentation (Quick Actions pages, last updated
 * 20 July 2026): `env.BROWSER.quickAction(action, options)` with actions "markdown", "content", "links",
 * "snapshot", "screenshot"; options `url`, `gotoOptions.waitUntil`, `rejectResourceTypes`,
 * `visibleLinksOnly`; the documented result is `{ success, result }` (a string for markdown and content,
 * a string array for links, `{ screenshot, content }` for snapshot). The documentation's Worker examples
 * return the call's value directly from `fetch`, so the binding may hand back a Response carrying that
 * JSON: both shapes are accepted. Wrangler binding: `"browser": { "binding": "BROWSER" }`, compatibility
 * date 2026-03-24 or later; the binding does not run in local development.
 *
 * NOT verified against a live binding from this workstream. Quick Actions are stateless single-page reads:
 * there is no session, no click and no form here. An interactive request is refused, so the router records
 * that the method could not do it rather than pretending a size or colour was selected.
 */
import { ConnectionError } from "./mcp.ts";
import { assertPublicHttpsUrl } from "../research/web/url.ts";
import type { BrowserFetchBackend, BrowserRenderRequest, BrowserRenderResponse } from "../research/web/extract-types.ts";

export type BrowserQuickAction = "markdown" | "content" | "links" | "snapshot" | "screenshot" | "pdf";

/** The part of the Browser Run binding this adapter uses. */
export interface BrowserRunBinding {
  quickAction(action: BrowserQuickAction, options: Record<string, unknown>): Promise<unknown>;
}

export interface BrowserRunOptions {
  /** Called before each paid browser request; return false to refuse (budget, kill switch). */
  admit?: (action: BrowserQuickAction, url: string) => Promise<boolean> | boolean;
  /** Upper bound on browser requests through this backend instance. */
  maxCalls?: number;
  maxContentChars?: number;
}

async function unwrap<T>(value: unknown): Promise<T> {
  let body: unknown = value;
  if (value && typeof (value as Response).json === "function" && typeof (value as Response).status === "number") {
    const response = value as Response;
    if (!response.ok) throw new ConnectionError(response.status === 429 ? "rate_limited" : "upstream", `Browser Run answered ${response.status}`);
    body = await response.json();
  }
  const envelope = body as { success?: boolean; result?: unknown; errors?: { message?: string }[] } | null;
  if (!envelope || typeof envelope !== "object" || !("result" in envelope)) throw new ConnectionError("upstream", "Browser Run answered in an unexpected shape");
  if (envelope.success === false) throw new ConnectionError("upstream", `Browser Run failed: ${String(envelope.errors?.[0]?.message ?? "no reason given").slice(0, 200)}`);
  return envelope.result as T;
}

export interface BrowserRunBackend extends BrowserFetchBackend {
  /** A screenshot plus the rendered HTML, for visual evidence kept privately. The image is never sent on by this adapter. */
  capture(url: string, timeoutMs?: number): Promise<{ screenshotBase64: string; html: string }>;
  /** A PDF or a PNG screenshot of the page as bytes, to keep as private evidence of volatile content. */
  document(url: string, kind: "pdf" | "screenshot", timeoutMs?: number): Promise<{ bytes: Uint8Array; contentType: string }>;
  /** Visible links of a page (candidates only; nothing is followed). */
  links(url: string, timeoutMs?: number): Promise<string[]>;
  readonly callsMade: number;
}

export function createBrowserRunBackend(binding: BrowserRunBinding, options: BrowserRunOptions = {}): BrowserRunBackend {
  let calls = 0;
  const maxChars = options.maxContentChars ?? 200_000;
  const run = async <T>(action: BrowserQuickAction, url: string, timeoutMs: number, extra: Record<string, unknown> = {}): Promise<T> => {
    // Private, loopback and non-HTTPS targets are refused before a browser is ever asked.
    const safe = assertPublicHttpsUrl(url);
    if (options.maxCalls !== undefined && calls >= options.maxCalls) throw new ConnectionError("call_limit", "the browser call limit for this run was reached");
    if (options.admit && !(await options.admit(action, safe))) throw new ConnectionError("not_admitted", "browser use is not available right now (budget or switch)");
    calls++;
    const call = binding.quickAction(action, { url: safe, gotoOptions: { waitUntil: "networkidle0", timeout: timeoutMs }, ...extra });
    const timer = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new ConnectionError("timeout", "the browser did not answer in time")), timeoutMs + 2_000));
    return unwrap<T>(await Promise.race([call, timer]));
  };
  return {
    get callsMade() {
      return calls;
    },
    async render(req: BrowserRenderRequest): Promise<BrowserRenderResponse> {
      if (req.interactive) throw new ConnectionError("not_supported", "interactive browsing (selecting a size or colour) is not available through Quick Actions; the variant was not selected");
      const markdown = await run<string>("markdown", req.url, req.timeoutMs, { rejectResourceTypes: ["image", "media", "font"] });
      const content = String(markdown ?? "").slice(0, maxChars);
      const images = [...content.matchAll(/!\[[^\]]*\]\((https:\/\/[^\s)]+)\)/g)].map((m) => m[1]!).slice(0, 40);
      // A quick action reports neither the final URL after redirects nor any selected option: both stay as requested / unknown.
      return { finalUrl: assertPublicHttpsUrl(req.url), content, images: [...new Set(images)], selectedVariant: null };
    },
    async capture(url, timeoutMs = 20_000) {
      const result = await run<{ screenshot?: string; content?: string }>("snapshot", url, timeoutMs);
      return { screenshotBase64: String(result?.screenshot ?? ""), html: String(result?.content ?? "").slice(0, maxChars) };
    },
    async document(url, kind, timeoutMs = 30_000) {
      const safe = assertPublicHttpsUrl(url);
      if (options.maxCalls !== undefined && calls >= options.maxCalls) throw new ConnectionError("call_limit", "the browser call limit for this run was reached");
      if (options.admit && !(await options.admit(kind, safe))) throw new ConnectionError("not_admitted", "browser use is not available right now (budget or switch)");
      calls++;
      const value = await binding.quickAction(kind, { url: safe, gotoOptions: { waitUntil: "networkidle0", timeout: timeoutMs } });
      // These two actions answer with the file itself, not a JSON envelope.
      if (!(value instanceof Response)) throw new ConnectionError("upstream", "Browser Run answered in an unexpected shape");
      if (!value.ok) throw new ConnectionError(value.status === 429 ? "rate_limited" : "upstream", `Browser Run answered ${value.status}`);
      const contentType = value.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) throw new ConnectionError("upstream", "Browser Run answered with an error instead of a file");
      const bytes = new Uint8Array(await value.arrayBuffer());
      if (bytes.length > 20_000_000) throw new ConnectionError("too_large", "the capture is larger than this connection accepts");
      return { bytes, contentType: contentType || (kind === "pdf" ? "application/pdf" : "image/png") };
    },
    async links(url, timeoutMs = 20_000) {
      const result = await run<string[]>("links", url, timeoutMs, { visibleLinksOnly: true });
      return (Array.isArray(result) ? result : []).filter((l): l is string => typeof l === "string").slice(0, 500);
    },
  };
}
