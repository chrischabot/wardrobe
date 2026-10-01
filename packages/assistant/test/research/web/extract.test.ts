import { describe, it, expect } from "vitest";
import {
  ExtractionRouter,
  InMemoryMethodCache,
  PrivateForwardingError,
  UrlPolicyError,
  assertNoPrivateForwarding,
  evidenceEnvelopeSchema,
  stripGeneratedAnswerOptions,
} from "../../../src/research/web/index.ts";
import type {
  BrowserFetchBackend,
  BrowserRenderRequest,
  BrowserRenderResponse,
  TavilyExtractBackend,
  TavilyExtractRequest,
  TavilyExtractResponse,
} from "../../../src/research/web/index.ts";

const GOOD = `# Tweed Overcoat\nA single-breasted overcoat cut from handwoven tweed with horn buttons and a half canvas.\nComposition: 100% wool.\nCare: dry clean only.`;
const NO_COMPOSITION = `# Tweed Overcoat\nA single-breasted overcoat cut from handwoven tweed with horn buttons and a half canvas.\nCare: dry clean only. Made in Scotland by a family mill.`;
const CHALLENGE = "Just a moment... Checking your browser before accessing shop.example.com.";
const FIELDS = [{ name: "composition", pattern: /composition:/i }];
const T0 = Date.parse("2025-03-10T12:00:00Z");

type Scripted = string | { error: string };

/** FAKE Tavily extract backend (test double): replays scripted content per URL and depth; no network. */
class FakeTavily implements TavilyExtractBackend {
  calls: TavilyExtractRequest[] = [];
  constructor(private readonly script: (url: string, depth: "basic" | "advanced") => Scripted) {}
  async extract(req: TavilyExtractRequest): Promise<TavilyExtractResponse> {
    this.calls.push(req);
    const response: TavilyExtractResponse = { results: [], failed: [] };
    for (const url of req.urls) {
      const scripted = this.script(url, req.depth);
      if (typeof scripted === "string") response.results.push({ url, content: scripted, images: [`${url}/main.jpg`] });
      else response.failed.push({ url, error: scripted.error });
    }
    return response;
  }
}

/** FAKE browser fetch backend (test double): replays a scripted render per URL; no browser is started. */
class FakeBrowser implements BrowserFetchBackend {
  calls: BrowserRenderRequest[] = [];
  constructor(private readonly script: (req: BrowserRenderRequest) => Partial<BrowserRenderResponse> | Error) {}
  async render(req: BrowserRenderRequest): Promise<BrowserRenderResponse> {
    this.calls.push(req);
    const scripted = this.script(req);
    if (scripted instanceof Error) throw scripted;
    return { finalUrl: req.url, content: GOOD, images: [], selectedVariant: null, ...scripted };
  }
}

function setup(tavilyScript: (url: string, depth: "basic" | "advanced") => Scripted, browserScript: (req: BrowserRenderRequest) => Partial<BrowserRenderResponse> | Error = () => ({})) {
  const time = { now: T0 };
  const tavily = new FakeTavily(tavilyScript);
  const browser = new FakeBrowser(browserScript);
  const router = new ExtractionRouter({ tavily, browser, clock: () => time.now, cache: new InMemoryMethodCache() });
  return { time, tavily, browser, router };
}

describe("ExtractionRouter with Tavily", () => {
  it("batches at most 20 URLs per call, always asks for images and bounds the timeout", async () => {
    const { tavily, router } = setup(() => GOOD);
    const urls = Array.from({ length: 45 }, (_, index) => `https://shop${index}.example.com/coat`);
    const results = await router.extract({ urls, need: "readable_copy", expectedFields: FIELDS });
    expect(tavily.calls.map((call) => call.urls.length)).toEqual([20, 20, 5]);
    expect(tavily.calls.every((call) => call.includeImages === true && call.depth === "basic")).toBe(true);
    expect(tavily.calls.every((call) => call.timeoutMs > 0 && call.timeoutMs <= 60_000)).toBe(true);
    expect(results.every((result) => result.status === "resolved")).toBe(true);
  });

  it("inspects per-URL failures in a successful call and records evidence for the rest", async () => {
    const bad = "https://blocked.example.com/coat";
    const { tavily, browser, router } = setup(
      (url) => (url === bad ? { error: "403 from origin" } : GOOD),
      () => new Error("navigation blocked"),
    );
    const [ok, failed] = await router.extract({ urls: ["https://shop.example.com/coat?utm_source=mail", bad], need: "readable_copy", expectedFields: FIELDS });
    expect(ok?.status).toBe("resolved");
    if (ok?.status !== "resolved") throw new Error("expected evidence");
    expect(evidenceEnvelopeSchema.safeParse(ok.evidence).success).toBe(true);
    expect(ok.evidence).toMatchObject({
      canonicalUrl: "https://shop.example.com/coat",
      method: "tavily_basic",
      extractor: "tavily-extract",
      retrievedAt: "2025-03-10T12:00:00.000Z",
      completeness: "complete",
      selectedVariant: null,
      failures: [],
    });
    expect(ok.evidence.imageCandidates).toHaveLength(1);
    expect(ok.evidence.sourceAnchors[0]?.quote).toContain("Composition: 100% wool.");

    expect(failed).toMatchObject({ status: "unresolved", url: bad });
    if (failed?.status !== "unresolved") throw new Error("expected unresolved");
    expect(failed.attempts.map((attempt) => [attempt.method, attempt.outcome])).toEqual([
      ["tavily_basic", "error"],
      ["tavily_advanced", "error"],
      ["browser_quick", "error"],
    ]);
    expect(failed.reason).toContain("navigation blocked");
    expect(failed).not.toHaveProperty("evidence");
    expect(tavily.calls.map((call) => [call.depth, call.urls])).toEqual([["basic", ["https://shop.example.com/coat?utm_source=mail", bad]], ["advanced", [bad]]]);
    expect(browser.calls).toHaveLength(1);
  });

  it("escalates basic -> advanced -> browser when fields are missing or content is a challenge", async () => {
    const { tavily, browser, router } = setup((_url, depth) => (depth === "basic" ? NO_COMPOSITION : CHALLENGE));
    const [result] = await router.extract({ urls: ["https://js-shop.example.com/coat"], need: "size_chart_text", expectedFields: FIELDS });
    expect(tavily.calls.map((call) => call.depth)).toEqual(["basic", "advanced"]);
    expect(browser.calls).toEqual([{ url: "https://js-shop.example.com/coat", interactive: false, timeoutMs: 45_000 }]);
    if (result?.status !== "resolved") throw new Error("expected evidence");
    expect(result.evidence.method).toBe("browser_quick");
    expect(result.evidence.extractor).toBe("browser-run");
    expect(result.evidence.failures.map((failure) => failure.reason)).toEqual([
      "tavily_basic: missing expected fields: composition",
      "tavily_advanced: bot challenge interstitial",
    ]);
  });

  it("stays unresolved with the missing field listed when no method finds it", async () => {
    const { router } = setup(() => NO_COMPOSITION, () => ({ content: NO_COMPOSITION }));
    const [result] = await router.extract({ urls: ["https://shop.example.com/coat"], need: "readable_copy", expectedFields: FIELDS });
    if (result?.status !== "unresolved") throw new Error("expected unresolved");
    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual(["partial", "partial", "partial"]);
    expect(result.attempts.every((attempt) => attempt.missingFields.includes("composition"))).toBe(true);
    expect(result.reason).toContain("composition");
  });

  it("caches the successful method per domain and forgets it after expiry", async () => {
    const { time, tavily, router } = setup((_url, depth) => (depth === "basic" ? CHALLENGE : GOOD));
    const request = (path: string) => router.extract({ urls: [`https://js-shop.example.com/${path}`], need: "readable_copy", expectedFields: FIELDS });
    await request("coat");
    expect(tavily.calls.map((call) => call.depth)).toEqual(["basic", "advanced"]);
    const [second] = await request("jacket");
    expect(tavily.calls.map((call) => call.depth)).toEqual(["basic", "advanced", "advanced"]);
    expect(second?.status === "resolved" && second.evidence.method).toBe("tavily_advanced");
    time.now = T0 + 7 * 24 * 3_600_000 + 1;
    await request("scarf");
    expect(tavily.calls.map((call) => call.depth)).toEqual(["basic", "advanced", "advanced", "basic", "advanced"]);
  });

  it("rejects a non-public URL before any backend call", async () => {
    const { tavily, browser, router } = setup(() => GOOD);
    await expect(router.extract({ urls: ["https://shop.example.com/a", "https://169.254.169.254/"], need: "readable_copy", expectedFields: [] })).rejects.toBeInstanceOf(UrlPolicyError);
    expect(tavily.calls).toHaveLength(0);
    expect(browser.calls).toHaveLength(0);
  });
});

describe("ExtractionRouter browser needs", () => {
  it("sends a variant need straight to the browser and records the observed variant", async () => {
    const { tavily, browser, router } = setup(() => GOOD, () => ({ selectedVariant: { size: "M", colour: "Navy", currency: "GBP" } }));
    const [result] = await router.extract({ urls: ["https://shop.example.com/coat"], need: "variant_state", expectedFields: [] });
    expect(tavily.calls).toHaveLength(0);
    expect(browser.calls).toEqual([{ url: "https://shop.example.com/coat", interactive: true, timeoutMs: 45_000 }]);
    if (result?.status !== "resolved") throw new Error("expected evidence");
    expect(result.evidence.method).toBe("browser_interactive");
    expect(result.evidence.selectedVariant).toEqual({ size: "M", colour: "Navy", currency: "GBP" });
  });

  it("is unresolved when no selected variant was observed", async () => {
    const { router } = setup(() => GOOD, () => ({ selectedVariant: null }));
    const [result] = await router.extract({ urls: ["https://shop.example.com/coat"], need: "variant_state", expectedFields: [] });
    if (result?.status !== "unresolved") throw new Error("expected unresolved");
    expect(result.attempts[0]?.missingFields).toEqual(["selected_variant"]);
  });

  it("uses a quick render for a visual need and requires an image", async () => {
    const { browser, router } = setup(() => GOOD, (req) => ({ content: "", images: req.url.endsWith("a") ? ["https://cdn.example.com/a.png"] : [] }));
    const results = await router.extract({ urls: ["https://shop.example.com/a", "https://shop.example.com/b"], need: "visual", expectedFields: [] });
    expect(browser.calls.every((call) => call.interactive === false)).toBe(true);
    expect(results.map((result) => result.status)).toEqual(["resolved", "unresolved"]);
  });
});

describe("tool argument guards", () => {
  it("strips generated-answer options at any depth and keeps the rest", () => {
    const args = { query: "tweed coat", include_answer: true, includeAnswer: "advanced", answer: true, summarize: true, summary: true, max_results: 5, options: { include_answer: true, depth: "basic" } };
    expect(stripGeneratedAnswerOptions(args)).toEqual({ query: "tweed coat", max_results: 5, options: { depth: "basic" } });
    expect(args.include_answer).toBe(true); // input is not mutated
  });

  it("refuses cookies, authorization headers, tokens and email bodies", () => {
    const refused = [
      { urls: ["https://shop.example.com"], cookies: "session=abc" },
      { urls: ["https://shop.example.com"], headers: { Authorization: "Bearer abc.def" } },
      { urls: ["https://shop.example.com"], headers: { "X-Forwarded": "Bearer abc.def" } },
      { urls: ["https://shop.example.com"], access_token: "ya29.abc" },
      { urls: ["https://shop.example.com"], context: { emailBody: "Dear customer, your order..." } },
    ];
    for (const args of refused) expect(() => assertNoPrivateForwarding(args), JSON.stringify(Object.keys(args))).toThrow(PrivateForwardingError);
    expect(() => assertNoPrivateForwarding({ urls: ["https://shop.example.com"], extract_depth: "advanced", cookies: "" })).not.toThrow();
  });
});
