import { describe, it, expect } from "vitest";
import { SearchInvestigation, imageBackfillPlan } from "../../../src/research/web/index.ts";
import type { SearchProvider } from "../../../src/research/web/index.ts";

type Hit = { url: string; title: string; snippet: string };

const hit = (url: string, title = "Tweed coat"): Hit => ({ url, title, snippet: "Navy, size M in stock" });

/** FAKE search provider (test double): returns scripted results or throws; no network. */
class FakeProvider implements SearchProvider {
  queries: string[] = [];
  readonly name: string;
  private readonly script: (query: string) => Hit[] | Error;

  constructor(name: string, script: (query: string) => Hit[] | Error) {
    this.name = name;
    this.script = script;
  }

  async search(query: string): Promise<{ results: Hit[] }> {
    this.queries.push(query);
    const scripted = this.script(query);
    if (scripted instanceof Error) throw scripted;
    return { results: scripted };
  }
}

describe("SearchInvestigation", () => {
  it("types every result as a candidate and de-duplicates by canonical URL across queries", async () => {
    const provider = new FakeProvider("exa", (query) =>
      query === "first"
        ? [hit("https://shop.example.com/coat?utm_source=search"), hit("https://SHOP.example.com/coat/#reviews"), hit("https://maker.example.com/archive/coat")]
        : [hit("https://shop.example.com/coat?gclid=1"), hit("https://retailer.example.com/coat")],
    );
    const investigation = new SearchInvestigation({ providers: [provider], maxQueries: 5, maxResults: 50 });
    const first = await investigation.search("first");
    const second = await investigation.search("second");

    expect(first.added.map((result) => result.canonicalUrl)).toEqual(["https://shop.example.com/coat", "https://maker.example.com/archive/coat"]);
    expect(second.added.map((result) => result.canonicalUrl)).toEqual(["https://retailer.example.com/coat"]);
    const report = investigation.report();
    expect(report.results).toHaveLength(3);
    expect(report.results.every((result) => result.evidenceLevel === "candidate" && result.provider === "exa")).toBe(true);
    expect(report.unresolvedReason).toBeNull();
    expect(report.reducedCoverage).toEqual([]);
  });

  it("drops results that are not public HTTPS pages and redacts key-bearing URLs", async () => {
    const provider = new FakeProvider("exa", () => [hit("http://shop.example.com/coat"), hit("https://10.0.0.5/coat"), hit("https://shop.example.com/coat?token=abc123")]);
    const investigation = new SearchInvestigation({ providers: [provider], maxQueries: 2, maxResults: 10 });
    const step = await investigation.search("coat");
    expect(step.added).toHaveLength(1);
    expect(step.added[0]?.url).toBe("https://shop.example.com/coat?token=REDACTED");
  });

  it("fails over to the next provider and records reduced coverage", async () => {
    const exa = new FakeProvider("exa", () => new Error("429 from https://api.exa.example/search?api_key=SECRET"));
    const tavily = new FakeProvider("tavily", () => [hit("https://shop.example.com/coat")]);
    const investigation = new SearchInvestigation({ providers: [exa, tavily], maxQueries: 5, maxResults: 10 });

    const first = await investigation.search("tweed coat HT-4471");
    expect(first.provider).toBe("tavily");
    expect(first.added).toHaveLength(1);
    await investigation.search("tweed coat navy");

    expect(exa.queries).toEqual(["tweed coat HT-4471"]); // a failed provider is not retried
    expect(tavily.queries).toEqual(["tweed coat HT-4471", "tweed coat navy"]);
    const report = investigation.report();
    expect(report.reducedCoverage).toHaveLength(1);
    expect(report.reducedCoverage[0]).toContain("exa: 429");
    expect(report.reducedCoverage[0]).not.toContain("SECRET");
    expect(report.unresolvedReason).toBeNull();
  });

  it("reports an unresolved reason when every provider failed", async () => {
    const exa = new FakeProvider("exa", () => new Error("timeout"));
    const tavily = new FakeProvider("tavily", () => new Error("503"));
    const investigation = new SearchInvestigation({ providers: [exa, tavily], maxQueries: 5, maxResults: 10 });

    const step = await investigation.search("coat");
    expect(step).toEqual({ provider: null, added: [], unresolvedReason: "every search provider failed" });
    const again = await investigation.search("coat again");
    expect(again.unresolvedReason).toBe("every search provider failed");
    expect(exa.queries).toHaveLength(1);
    expect(tavily.queries).toHaveLength(1);
    expect(investigation.report()).toMatchObject({
      results: [],
      reducedCoverage: ["exa: timeout", "tavily: 503"],
      unresolvedReason: "every search provider failed",
    });
  });

  it("stops at the query budget with an explicit unresolved reason", async () => {
    let counter = 0;
    const provider = new FakeProvider("exa", () => [hit(`https://shop.example.com/item-${++counter}`)]);
    const investigation = new SearchInvestigation({ providers: [provider], maxQueries: 2, maxResults: 10 });

    expect((await investigation.search("one")).unresolvedReason).toBeNull();
    expect((await investigation.search("two")).unresolvedReason).toBe("search budget ended: 2 queries used");
    const refused = await investigation.search("three");
    expect(refused).toEqual({ provider: null, added: [], unresolvedReason: "search budget ended: 2 queries used" });
    expect(provider.queries).toEqual(["one", "two"]);
    expect(investigation.report().queriesUsed).toBe(2);
  });

  it("stops at the result budget", async () => {
    const provider = new FakeProvider("exa", () => Array.from({ length: 8 }, (_, index) => hit(`https://shop.example.com/item-${index}`)));
    const investigation = new SearchInvestigation({ providers: [provider], maxQueries: 10, maxResults: 3 });

    const step = await investigation.search("coat");
    expect(step.added).toHaveLength(3);
    expect(step.unresolvedReason).toBe("search budget ended: 3 results collected");
    await investigation.search("more coats");
    expect(provider.queries).toEqual(["coat"]);
  });

  it("reports no unresolved reason once the caller marks the investigation resolved", async () => {
    const provider = new FakeProvider("exa", () => [hit("https://shop.example.com/coat")]);
    const investigation = new SearchInvestigation({ providers: [provider], maxQueries: 1, maxResults: 10 });
    await investigation.search("coat");
    expect(investigation.report().unresolvedReason).toBe("search budget ended: 1 queries used");
    investigation.markResolved();
    expect(investigation.report()).toMatchObject({ resolved: true, unresolvedReason: null });
  });

  it("rejects an unbounded budget", () => {
    expect(() => new SearchInvestigation({ providers: [], maxQueries: 0, maxResults: 10 })).toThrow(RangeError);
    expect(() => new SearchInvestigation({ providers: [], maxQueries: 5, maxResults: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });
});

describe("imageBackfillPlan", () => {
  const ORDER = [
    "order_original_url",
    "maker_catalogue_and_archives",
    "exact_product_code",
    "reputable_retailers",
    "alternative_search_coverage",
    "rendered_or_interactive_pages",
    "request_photograph",
  ];

  it("returns the strategies in the design's order, ending with a photograph request", () => {
    const plan = imageBackfillPlan({ orderUrl: "https://shop.example.com/orders/1?token=abc", maker: "Harris", productCode: "HT-4471" });
    expect(plan.map((step) => step.strategy)).toEqual(ORDER);
    expect(plan.every((step) => step.applicable)).toBe(true);
    expect(plan[0]?.detail).toContain("token=REDACTED");
    expect(plan[2]?.detail).toContain('"HT-4471"');
  });

  it("keeps the order and marks strategies without their input as not applicable", () => {
    const plan = imageBackfillPlan({});
    expect(plan.map((step) => step.strategy)).toEqual(ORDER);
    expect(plan.map((step) => step.applicable)).toEqual([false, false, false, false, false, false, true]);
    expect(imageBackfillPlan({ maker: "Harris" }).map((step) => step.applicable)).toEqual([false, true, false, true, true, true, true]);
  });
});
