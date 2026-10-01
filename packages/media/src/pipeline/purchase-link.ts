/**
 * Discovery step 1: inspect the garment's own stored purchase link. Fetches that one page directly (no
 * browser session), and reads the product's structured data (JSON-LD `Product`) and Open Graph image.
 * The page is untrusted source material: only data fields are extracted, as plain strings.
 */
import type { DiscoveryCandidatePage, DiscoveryProvider } from "../adapters.ts";
import { safeFetch } from "./safe-fetch.ts";

function text(value: unknown, max = 300): string | null {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim().slice(0, max) || null;
  if (typeof value === "number") return String(value);
  return null;
}

function firstImage(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = firstImage(v);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") return firstImage((value as { url?: unknown; contentUrl?: unknown }).url ?? (value as { contentUrl?: unknown }).contentUrl);
  return null;
}

function findProducts(node: unknown, out: Record<string, unknown>[], depth = 0): void {
  if (!node || typeof node !== "object" || depth > 6) return;
  if (Array.isArray(node)) {
    for (const n of node.slice(0, 50)) findProducts(n, out, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  const type = obj["@type"];
  if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) out.push(obj);
  if (obj["@graph"]) findProducts(obj["@graph"], out, depth + 1);
}

function metaContent(html: string, property: string): string | null {
  const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]*>`, "i");
  const tag = pattern.exec(html)?.[0];
  if (!tag) return null;
  const content = /content=["']([^"']*)["']/i.exec(tag)?.[1];
  return content ? content.replace(/&amp;/g, "&").trim() : null;
}

/** Extract product identity and an image from a product page's HTML. Pure; exported for tests. */
export function extractProductPage(html: string, pageUrl: string, retrievedAt: string): DiscoveryCandidatePage | null {
  const products: Record<string, unknown>[] = [];
  const scripts = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  let seen = 0;
  for (const m of scripts) {
    if (++seen > 20) break;
    try {
      findProducts(JSON.parse(m[1]!.trim()), products);
    } catch {
      // malformed structured data is ignored
    }
  }
  const product = products[0] ?? null;
  const rawImage = (product ? firstImage(product.image) : null) ?? metaContent(html, "og:image");
  if (!rawImage) return null;
  let imageUrl: string;
  try {
    imageUrl = new URL(rawImage, pageUrl).toString();
  } catch {
    return null;
  }
  const brand = product?.brand;
  const codes = [text(product?.sku, 80), text(product?.mpn, 80), text(product?.productID, 80)].filter((c): c is string => !!c);
  return {
    pageUrl,
    imageUrl,
    title: text(product?.name) ?? metaContent(html, "og:title")?.slice(0, 300) ?? null,
    sourceClass: "purchase_source",
    recordedPurchaseLink: true,
    identifiers: {
      productCodes: codes,
      maker: text(typeof brand === "object" && brand !== null ? (brand as { name?: unknown }).name : brand, 120),
      productName: text(product?.name),
      colourway: text(product?.color, 120),
    },
    retrievedAt,
  };
}

export function createPurchaseLinkProvider(opts: { fetchImpl?: typeof fetch; now?: () => number } = {}): DiscoveryProvider {
  return {
    name: "recorded-purchase-link",
    strategies: ["purchase_source"],
    usesBrowser: false,
    async search(query) {
      const link = query.garment.purchaseLink;
      if (!link) return { pages: [], browserSessions: 0, browserSeconds: 0 };
      const page = await safeFetch(link, { maxBytes: 2 * 1024 * 1024, accept: "text/html,application/xhtml+xml", fetchImpl: opts.fetchImpl });
      if (!page.ok) return { pages: [], browserSessions: 0, browserSeconds: 0, error: `the recorded purchase link could not be read: ${page.reason}` };
      const html = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(page.bytes);
      const candidate = extractProductPage(html, page.finalUrl, new Date((opts.now ?? Date.now)()).toISOString().replace(/\.\d{3}Z$/, "Z"));
      return { pages: candidate ? [candidate] : [], browserSessions: 0, browserSeconds: 0 };
    },
  };
}
