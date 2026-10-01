import { describe, expect, it } from "vitest";
import { createDohResolver, createPurchaseLinkProvider, evaluateCandidate, extractProductPage, isPrivateAddress, refuseUrl, safeFetch, sameDocument } from "../src/index.ts";
import type { DiscoveryGarment, HostResolver } from "../src/index.ts";

// Regression tests for the independent review of this package (findings M5, L1, L2).
// Every fetch and every DNS answer here is a FIXTURE: no network is used. The default resolver (DNS over
// HTTPS against the real service) is exercised only through a fixture response in this file.

const boot: DiscoveryGarment = { garmentId: "g", name: "Drake's Clifford boot", category: "footwear", maker: "Drake's", product: "Clifford boot", colour: "Brown", pattern: null, fabric: null, size: null, codes: [], model: null, purchaseLink: "https://www.shop.example.org/products/clifford-boot-brown", cut: null };
const productPage = (product: Record<string, unknown> | null, extraHead = "") => `<html><head>${extraHead}${product ? `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", ...product })}</script>` : ""}</head></html>`;
const html = (body: string, status = 200, headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" }) => new Response(body, { status, headers });
const publicDns: HostResolver = async () => ["93.184.216.34"];

describe("review M5: a recorded purchase link proves nothing about a page it now redirects to", () => {
  const search = (fetchImpl: typeof fetch, garment = boot) =>
    createPurchaseLinkProvider({ fetchImpl, resolver: publicDns, now: () => Date.parse("2026-09-15T08:00:00Z") }).search({ strategy: "purchase_source", garment, text: garment.purchaseLink! }, { maxPages: 12, maxBrowserSessions: 2 });
  const redirecting = (finalBody: string): typeof fetch => async (url) =>
    String(url).includes("/products/clifford-boot-brown") ? new Response(null, { status: 301, headers: { location: "/collections/new-in" } }) : html(finalBody);

  it("tells the same document from another one", () => {
    expect(sameDocument("https://www.shop.example.org/products/clifford-boot-brown", "https://shop.example.org/products/clifford-boot-brown/?utm_source=x#top")).toBe(true);
    expect(sameDocument("https://www.shop.example.org/products/clifford-boot-brown", "https://www.shop.example.org/collections/new-in")).toBe(false);
    expect(sameDocument("https://www.shop.example.org/products/clifford-boot-brown", "https://other.example.org/products/clifford-boot-brown")).toBe(false);
    expect(sameDocument("not a url", "https://www.shop.example.org/")).toBe(false);
  });

  it("a link that redirects to another product is not the recorded purchase page and is not adopted", async () => {
    const result = await search(redirecting(productPage({ name: "Suede Chukka Sneaker", color: "Brown", image: "/img/chukka.jpg" })));
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]).toMatchObject({ pageUrl: "https://www.shop.example.org/collections/new-in", sourceClass: "other", recordedPurchaseLink: false });
    const evaluation = evaluateCandidate(boot, result.pages[0]!);
    expect(evaluation).toMatchObject({ decision: "rejected", rejectionReasons: ["insufficient_identity_evidence"] });
    expect(evaluation.evidence).toMatchObject({ recordedPurchasePage: false });
  });

  it("a page with only an Open Graph banner yields no candidate at all, whether or not the garment's colour is recorded", async () => {
    const banner = productPage(null, '<meta property="og:image" content="/img/site-banner.jpg"><meta property="og:title" content="New in">');
    expect((await search(redirecting(banner))).pages).toEqual([]);
    expect((await search(redirecting(banner), { ...boot, colour: null })).pages).toEqual([]);
    // Also when the link did NOT redirect: a banner is not a product photograph.
    expect((await search(async () => html(banner))).pages).toEqual([]);
    expect(extractProductPage(banner, boot.purchaseLink!, "2026-09-15T08:00:00Z", boot.purchaseLink!)).toBeNull();
  });

  it("even on the recorded page itself, the page must name the maker or the product", async () => {
    // The shop reused the URL for something else: same document, different product, no maker stated.
    const reused = await search(async () => html(productPage({ name: "Suede Chukka Sneaker", color: "Brown", image: "/img/chukka.jpg" })));
    expect(reused.pages[0]).toMatchObject({ sourceClass: "purchase_source", recordedPurchaseLink: true });
    expect(evaluateCandidate(boot, reused.pages[0]!)).toMatchObject({ decision: "rejected", rejectionReasons: ["insufficient_identity_evidence"] });
    // The genuine page: adopted on the recorded link plus the maker and product it names.
    const genuine = await search(async () => html(productPage({ name: "Clifford Boot", color: "Brown", brand: { "@type": "Brand", name: "Drake's" }, image: "/img/clifford.jpg" })));
    expect(evaluateCandidate(boot, genuine.pages[0]!)).toMatchObject({ decision: "eligible", evidence: { recordedPurchasePage: true, makerMatch: true, productMatch: true } });
    // The genuine page without a stated colourway still goes to the owner, as before.
    const unstated = await search(async () => html(productPage({ name: "Clifford Boot", brand: "Drake's", image: "/img/clifford.jpg" })));
    expect(evaluateCandidate(boot, unstated.pages[0]!).decision).toBe("needs_review");
  });
});

describe("review L1: a public-looking name that points at a private address is refused", () => {
  it("classifies resolved addresses", () => {
    for (const address of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.9", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fd00::1", "fc00::abcd", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.5", "64:ff9b::10.0.0.5", "2001:db8::1", "not-an-address"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "::ffff:93.184.216.34"]) expect(isPrivateAddress(address), address).toBe(false);
  });

  it("refuses wildcard-DNS names outright", () => {
    for (const url of ["https://127.0.0.1.nip.io/x", "https://localtest.me/", "https://app.localtest.me/", "https://10-0-0-5.sslip.io/a.jpg", "https://anything.lvh.me/"]) expect(refuseUrl(url), url).toBe("private_or_local_host");
    expect(refuseUrl("https://snip.io.example.org/")).toBeNull(); // only the services themselves, not look-alike labels elsewhere
  });

  it("checks where the name resolves before fetching, at every redirect hop, and fails closed", async () => {
    const requested: string[] = [];
    const ok: typeof fetch = async (url) => {
      requested.push(String(url));
      return new Response(new Uint8Array([1, 2, 3]));
    };
    const dns = (table: Record<string, string[] | Error>): HostResolver => async (host) => {
      const answer = table[host];
      if (answer instanceof Error) throw answer;
      return answer ?? [];
    };
    const get = (url: string, resolver: HostResolver, fetchImpl = ok) => safeFetch(url, { maxBytes: 1000, accept: "*/*", fetchImpl, resolver });

    expect(await get("https://cdn.shop-one.org/a.jpg", dns({ "cdn.shop-one.org": ["93.184.216.34"] }))).toMatchObject({ ok: true, finalUrl: "https://cdn.shop-one.org/a.jpg" });
    for (const addresses of [["127.0.0.1"], ["10.0.0.5"], ["169.254.169.254"], ["::1"], ["fd00::1"], ["93.184.216.34", "192.168.0.7"]]) {
      requested.length = 0;
      expect(await get("https://innocent.shop-two.org/a.jpg", dns({ "innocent.shop-two.org": addresses }))).toEqual({ ok: false, reason: "refused (private or local host: the name resolves to a private or local address)" });
      expect(requested).toEqual([]); // nothing was sent to it
    }
    expect(await get("https://gone.shop-three.org/a.jpg", dns({}))).toEqual({ ok: false, reason: "refused (the host does not resolve to any address)" });
    expect(await get("https://flaky.shop-four.org/a.jpg", dns({ "flaky.shop-four.org": new Error("DNS lookup failed (HTTP 503)") }))).toMatchObject({ ok: false, reason: expect.stringMatching(/^refused \(the host could not be resolved: DNS lookup failed/) });

    // A public page that redirects to a name pointing inside is stopped at the hop.
    requested.length = 0;
    const hop: typeof fetch = async (url) => {
      requested.push(String(url));
      return new Response(null, { status: 302, headers: { location: "https://metadata.shop-five.org/latest" } });
    };
    expect(await get("https://www.shop-five.org/a", dns({ "www.shop-five.org": ["93.184.216.34"], "metadata.shop-five.org": ["169.254.169.254"] }), hop)).toMatchObject({ ok: false, reason: expect.stringContaining("resolves to a private or local address") });
    expect(requested).toEqual(["https://www.shop-five.org/a"]);
  });

  it("the DNS-over-HTTPS resolver asks for A and AAAA records and returns every address, or fails", async () => {
    const asked: string[] = [];
    const doh: typeof fetch = async (url, init) => {
      asked.push(String(url));
      expect(new Headers(init?.headers).get("accept")).toBe("application/dns-json");
      const type = new URL(String(url)).searchParams.get("type");
      return Response.json(type === "A" ? { Status: 0, Answer: [{ name: "x", type: 5, data: "alias.example.net." }, { name: "x", type: 1, data: "10.0.0.5" }] } : { Status: 0, Answer: [{ name: "x", type: 28, data: "2606:4700::1" }] });
    };
    expect(await createDohResolver({ fetchImpl: doh })("rebind.shop-six.org")).toEqual(["10.0.0.5", "2606:4700::1"]);
    expect(asked).toEqual(["https://cloudflare-dns.com/dns-query?name=rebind.shop-six.org&type=A", "https://cloudflare-dns.com/dns-query?name=rebind.shop-six.org&type=AAAA"]);
    expect(await createDohResolver({ fetchImpl: async () => Response.json({ Status: 3 }) })("nx.shop-six.org")).toEqual([]);
    await expect(createDohResolver({ fetchImpl: async () => new Response("busy", { status: 503 }) })("x.shop-six.org")).rejects.toThrow(/HTTP 503/);
    await expect(createDohResolver({ fetchImpl: async () => Response.json({ Status: 2 }) })("x.shop-six.org")).rejects.toThrow(/status 2/);
    // Wired together: the resolver's answer stops the fetch.
    const sent: string[] = [];
    const target: typeof fetch = async (url) => {
      sent.push(String(url));
      return new Response("secret");
    };
    expect(await safeFetch("https://rebind.shop-six.org/a", { maxBytes: 100, accept: "*/*", fetchImpl: target, resolver: createDohResolver({ fetchImpl: doh }) })).toMatchObject({ ok: false });
    expect(sent).toEqual([]);
  });
});

describe("review L2: the product-page fetch only reads HTML", () => {
  it("refuses a response that is not an HTML document, and still honours size limits", async () => {
    const provider = (fetchImpl: typeof fetch) => createPurchaseLinkProvider({ fetchImpl, resolver: publicDns }).search({ strategy: "purchase_source", garment: boot, text: boot.purchaseLink! }, { maxPages: 12, maxBrowserSessions: 2 });
    const page = productPage({ name: "Clifford Boot", brand: "Drake's", color: "Brown", image: "/img/clifford.jpg" });
    for (const type of ["image/png", "application/json", "application/octet-stream", "text/plain"]) {
      const result = await provider(async () => html(page, 200, { "content-type": type }));
      expect(result.pages, type).toEqual([]);
      expect(result.error).toBe(`the recorded purchase link could not be read: unexpected content type '${type}'`);
    }
    expect((await provider(async () => new Response(new TextEncoder().encode(page)))).error).toBe("the recorded purchase link could not be read: unexpected content type 'none'");
    expect((await provider(async () => html(page, 200, { "content-type": "application/xhtml+xml" }))).pages).toHaveLength(1);
    expect((await provider(async () => html(page))).pages).toHaveLength(1);
    // An HTML body beyond the limit is still cut off.
    expect((await provider(async () => html("x".repeat(3 * 1024 * 1024)))).error).toMatch(/response larger than the size limit/);
  });
});
