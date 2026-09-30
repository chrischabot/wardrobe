/**
 * Deterministic product facts from retrieved pages: schema.org JSON-LD (Product, ProductGroup,
 * Offer, AggregateOffer) and a simple size-chart table parser. Anything not present stays unknown;
 * a live product page does not prove a size is purchasable.
 */

export type Availability = 'available' | 'unavailable' | 'unknown';

export interface VariantFact {
  size?: string;
  colour?: string;
  sku?: string;
  availability: Availability;
  priceMinor?: number;
  currency?: string;
}

export interface ProductFacts {
  name?: string;
  brand?: string;
  material?: string;
  description?: string;
  variants: VariantFact[];
  productLevelAvailability: Availability;
  priceMinor?: number;
  currency?: string;
  sizeChart: { label: string; measurements: Record<string, number> }[];
  sizeChartUnit?: 'cm' | 'in';
}

function availabilityOf(v: unknown): Availability {
  const s = String(v ?? '').toLowerCase();
  if (/instock|in_stock|limitedavailability|onlineonly|preorder/.test(s.replace(/\s|https?:\/\/schema\.org\//g, ''))) return 'available';
  if (/outofstock|soldout|discontinued/.test(s.replace(/\s|https?:\/\/schema\.org\//g, ''))) return 'unavailable';
  return 'unknown';
}

function minor(price: unknown): number | undefined {
  const n = typeof price === 'number' ? price : Number(String(price ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : undefined;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

export function jsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1]!.trim()) as unknown;
      const graph = (parsed as { '@graph'?: unknown[] })?.['@graph'];
      out.push(...(graph ? graph : asArray(parsed)));
    } catch {
      /* malformed block: ignored */
    }
  }
  return out;
}

type Node = Record<string, unknown>;

function typeIs(n: Node, t: string): boolean {
  return asArray(n['@type'] as string | string[]).some((x) => String(x).toLowerCase() === t.toLowerCase());
}

function offersOf(n: Node): Node[] {
  const offers = asArray(n.offers as Node | Node[]);
  return offers.flatMap((o) => (typeIs(o, 'AggregateOffer') ? asArray(o.offers as Node | Node[]).concat(o.offers ? [] : [o]) : [o]));
}

function variantFrom(p: Node): VariantFact {
  const offer = offersOf(p)[0];
  return {
    size: p.size !== undefined ? String((p.size as Node)?.name ?? p.size) : undefined,
    colour: p.color !== undefined ? String(p.color) : undefined,
    sku: p.sku !== undefined ? String(p.sku) : undefined,
    availability: offer ? availabilityOf(offer.availability) : 'unknown',
    priceMinor: offer ? minor(offer.price) : undefined,
    currency: offer?.priceCurrency ? String(offer.priceCurrency) : undefined,
  };
}

export function productFacts(html: string): ProductFacts {
  const facts: ProductFacts = { variants: [], productLevelAvailability: 'unknown', sizeChart: [] };
  for (const node of jsonLdBlocks(html) as Node[]) {
    if (!node || typeof node !== 'object') continue;
    if (typeIs(node, 'ProductGroup') || typeIs(node, 'Product')) {
      facts.name ??= node.name ? String(node.name) : undefined;
      facts.brand ??= node.brand ? String((node.brand as Node)?.name ?? node.brand) : undefined;
      facts.material ??= node.material ? String(node.material) : undefined;
      facts.description ??= node.description ? String(node.description).slice(0, 2000) : undefined;
      for (const v of asArray(node.hasVariant as Node | Node[])) facts.variants.push(variantFrom(v));
      if (typeIs(node, 'Product')) {
        const offers = offersOf(node);
        // Offers that name a size/colour are variant-level; a bare offer is product-level only.
        for (const o of offers) {
          const size = (o.itemOffered as Node | undefined)?.size ?? o.size ?? (o.name && /size/i.test(String(o.name)) ? String(o.name).replace(/.*size\s*/i, '') : undefined);
          if (size !== undefined) facts.variants.push({ size: String(size), colour: o.color ? String(o.color) : undefined, sku: o.sku ? String(o.sku) : undefined, availability: availabilityOf(o.availability), priceMinor: minor(o.price), currency: o.priceCurrency ? String(o.priceCurrency) : undefined });
          else {
            facts.productLevelAvailability = availabilityOf(o.availability);
            facts.priceMinor ??= minor(o.price);
            facts.currency ??= o.priceCurrency ? String(o.priceCurrency) : undefined;
          }
        }
        if (node.size || node.color) facts.variants.push(variantFrom(node));
      }
    }
  }
  const table = html.match(/<table[^>]*(?:size[-_ ]?chart|sizechart|measurements)[^>]*>([\s\S]*?)<\/table>/i);
  if (table) {
    const rows = [...table[1]!.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => [...r[1]!.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => c[1]!.replace(/<[^>]+>/g, '').trim()));
    const header = rows.shift();
    if (header && header.length > 1) {
      facts.sizeChartUnit = /\bin(ch(es)?)?\b|"/i.test(table[0]!) && !/\bcm\b/i.test(table[0]!) ? 'in' : 'cm';
      for (const r of rows) {
        const measurements: Record<string, number> = {};
        header.slice(1).forEach((h, i) => {
          const v = Number((r[i + 1] ?? '').replace(/[^0-9.]/g, ''));
          if (Number.isFinite(v) && (r[i + 1] ?? '').trim() !== '') measurements[h.toLowerCase()] = v;
        });
        if (r[0]) facts.sizeChart.push({ label: r[0], measurements });
      }
    }
  }
  return facts;
}

/** Availability of the exact requested variant; product-level stock never answers a size question. */
export function variantAvailability(facts: ProductFacts, want: { size?: string; colour?: string }): { availability: Availability; variant: VariantFact | null; reason: string } {
  const norm = (s?: string) => (s ?? '').toLowerCase().replace(/\s+/g, '');
  if (!want.size && !want.colour) return { availability: facts.productLevelAvailability, variant: null, reason: 'No variant requested; product-level availability only.' };
  const match = facts.variants.find((v) => (!want.size || norm(v.size) === norm(want.size)) && (!want.colour || !v.colour || norm(v.colour) === norm(want.colour)));
  if (!match) return { availability: 'unknown', variant: null, reason: facts.variants.length ? 'The requested size/colour is not listed among the observed variants.' : 'The page does not expose variant-level availability.' };
  if (want.colour && !match.colour) return { availability: 'unknown', variant: match, reason: 'The size is listed but the colour of that offer is not stated.' };
  return { availability: match.availability, variant: match, reason: 'Observed on the variant offer.' };
}
