import { sha256Hex } from '../domain/hash.js';
import { assertPrincipal, type Principal } from '../domain/principal.js';
import { UrlPolicyError, validateOutboundUrl } from '../connectors/url-policy.js';
import { wrapUntrusted } from '../connectors/untrusted.js';
import type { BrowserService, EvidenceEnvelope, PageExtractor, WebSearchProvider } from '../connectors/web.js';
import type { ModelService } from '../models/service.js';
import { ownerSizeFacts } from './owner-sizes.js';
import { productFacts, variantAvailability, type Availability, type ProductFacts } from './product.js';
import { sizeAdvice, type SizeAdviceInput } from './sizing.js';
import { purchaseVerdict, type OwnedItem, type VerdictInput } from './verdict.js';

/**
 * Product investigation and purchase judgment (spec section 10).
 *
 * Route by evidence needed: readable extraction first (Tavily basic, then advanced), Browser Run for
 * rendered or variant-dependent state; a known variant check goes straight to the browser. Every
 * observation is stored with canonical URL, final URL, method, time, variant and availability. Exact
 * variant availability is available/unavailable/unknown at an observed time; observations older
 * than the freshness window are reported stale and must be refreshed before a purchase.
 */

export const FRESHNESS_MS = 24 * 60 * 60 * 1000;

export interface ResearchProviders {
  search: WebSearchProvider[];
  extractor?: PageExtractor;
  browser?: BrowserService;
}

export interface InvestigationInput {
  url: string;
  size?: string;
  colour?: string;
  country?: string;
  projectRef?: string;
}

export interface Investigation {
  url: string;
  status: 'resolved' | 'unresolved' | 'blocked';
  product: { name?: string; brand?: string; material?: string } | null;
  requestedVariant: { size?: string; colour?: string };
  variant: { availability: Availability; observedAt: string; priceMinor?: number; currency?: string; sku?: string; reason: string } | null;
  sizeChart: ProductFacts['sizeChart'];
  sizeChartUnit?: 'cm' | 'in';
  evidence: { method: string; retrievedAt: string; completeness: string; failures: string[]; finalUrl: string }[];
  previousObservations: { observedAt: string; availability: string; stale: boolean; method: string }[];
  unresolved: string[];
  page: ReturnType<typeof wrapUntrusted> | null;
  note: string;
}

const methodCache = new Map<string, { method: 'extract' | 'browser'; until: number }>();

export class ResearchService {
  constructor(
    private readonly db: D1Database,
    private readonly userId: string,
    private readonly providers: ResearchProviders,
    private readonly deps: { now?: () => string; models?: () => ModelService } = {},
  ) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  async investigate(principal: Principal, input: InvestigationInput): Promise<Investigation> {
    assertPrincipal(principal);
    const want = { size: input.size, colour: input.colour };
    const base: Investigation = { url: input.url, status: 'unresolved', product: null, requestedVariant: want, variant: null, sizeChart: [], evidence: [], previousObservations: [], unresolved: [], page: null, note: 'Refresh availability and price on the page before any purchase.' };
    let url: URL;
    try {
      url = validateOutboundUrl(input.url);
    } catch (err) {
      return { ...base, status: 'blocked', unresolved: [err instanceof UrlPolicyError ? `Blocked destination: ${err.message}` : 'Invalid URL'] };
    }
    base.previousObservations = await this.previous(url.toString(), want);
    if (!this.providers.extractor && !this.providers.browser) return { ...base, unresolved: ['No extraction or browser capability is connected'] };

    const envelopes: EvidenceEnvelope[] = [];
    let facts: ProductFacts | null = null;
    const domain = url.hostname;
    const cached = methodCache.get(domain);
    const goBrowserFirst = Boolean(this.providers.browser) && cached !== undefined && cached.until > Date.now() && cached.method === 'browser';
    const consider = (e: EvidenceEnvelope) => {
      envelopes.push(e);
      if (e.completeness === 'failed') return;
      const f = productFacts(e.html ?? e.content);
      if (f.name || f.variants.length || f.productLevelAvailability !== 'unknown') facts = mergeFacts(facts, f);
    };
    if (!goBrowserFirst && this.providers.extractor) {
      const [basic] = await this.providers.extractor.extract([url.toString()], { depth: 'basic', includeImages: true });
      if (basic) consider(basic);
      if (!facts || (want.size && variantAvailability(facts, want).availability === 'unknown')) {
        const [adv] = await this.providers.extractor.extract([url.toString()], { depth: 'advanced', includeImages: true });
        if (adv) consider(adv);
      }
    }
    const needsVariant = Boolean(want.size || want.colour);
    if (this.providers.browser && (!facts || (needsVariant && variantAvailability(facts, want).availability === 'unknown'))) {
      const e = needsVariant ? await this.providers.browser.variantCheck(url.toString(), want) : await this.providers.browser.render(url.toString());
      consider(e);
      if (e.completeness !== 'failed') methodCache.set(domain, { method: 'browser', until: Date.now() + 6 * 3600_000 });
    } else if (facts) methodCache.set(domain, { method: 'extract', until: Date.now() + 6 * 3600_000 });

    base.evidence = envelopes.map((e) => ({ method: e.method, retrievedAt: e.retrievedAt, completeness: e.completeness, failures: e.failures, finalUrl: e.finalUrl }));
    const best = [...envelopes].reverse().find((e) => e.completeness !== 'failed');
    base.page = best ? wrapUntrusted(best.finalUrl, best.content.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 4000)) : null;
    if (!facts) {
      base.unresolved.push(envelopes.some((e) => e.failures.some((f) => /challenge/.test(f))) ? 'The shop returned a challenge page; human help is needed to view it.' : 'No product data could be extracted from the page.');
      await this.store(input, url.toString(), best ?? envelopes[envelopes.length - 1], 'unknown', null, 'failed');
      return base;
    }
    const f = facts as ProductFacts;
    const va = variantAvailability(f, want);
    const observedAt = best?.retrievedAt ?? this.now();
    base.product = { name: f.name, brand: f.brand, material: f.material };
    base.sizeChart = f.sizeChart;
    base.sizeChartUnit = f.sizeChartUnit;
    base.variant = { availability: va.availability, observedAt, priceMinor: va.variant?.priceMinor ?? f.priceMinor, currency: va.variant?.currency ?? f.currency, sku: va.variant?.sku, reason: va.reason };
    if (va.availability === 'unknown') base.unresolved.push(va.reason);
    if (!f.material) base.unresolved.push('Fabric composition not stated on the page.');
    base.status = va.availability === 'unknown' && needsVariant ? 'unresolved' : 'resolved';
    await this.store(input, url.toString(), best!, va.availability, { ...want, sku: va.variant?.sku, priceMinor: base.variant.priceMinor, currency: base.variant.currency }, best!.completeness);
    return base;
  }

  private async previous(canonicalUrl: string, want: { size?: string; colour?: string }) {
    const { results } = await this.db
      .prepare('SELECT retrieved_at, availability, method, variant_json FROM research_evidence WHERE user_id = ? AND canonical_url = ? ORDER BY retrieved_at DESC LIMIT 10')
      .bind(this.userId, canonicalUrl)
      .all<{ retrieved_at: string; availability: string; method: string; variant_json: string }>();
    const now = Date.parse(this.now());
    return results
      .filter((r) => {
        const v = JSON.parse(r.variant_json) as { size?: string; colour?: string };
        return (v.size ?? null) === (want.size ?? null) && (v.colour ?? null) === (want.colour ?? null);
      })
      .map((r) => ({ observedAt: r.retrieved_at, availability: r.availability, method: r.method, stale: now - Date.parse(r.retrieved_at) > FRESHNESS_MS }));
  }

  private async store(input: InvestigationInput, canonicalUrl: string, e: EvidenceEnvelope | undefined, availability: Availability, variant: Record<string, unknown> | null, completeness: string) {
    if (!e) return;
    await this.db
      .prepare(
        `INSERT INTO research_evidence (user_id, evidence_id, project_ref, canonical_url, final_url, method, retrieved_at, country, currency, price_minor, variant_json, availability, completeness, content_sha256, anchors_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        this.userId,
        `evd_${crypto.randomUUID().replace(/-/g, '')}`,
        input.projectRef ?? 'adhoc',
        canonicalUrl,
        e.finalUrl,
        e.method,
        e.retrievedAt,
        input.country ?? null,
        (variant?.currency as string | undefined) ?? null,
        (variant?.priceMinor as number | undefined) ?? null,
        JSON.stringify({ size: input.size, colour: input.colour, sku: variant?.sku }),
        availability,
        completeness,
        await sha256Hex(e.content),
        JSON.stringify(e.anchors),
      )
      .run();
  }

  /** Latest stored observation for a URL and variant, with staleness. */
  async latestObservation(canonicalUrl: string, want: { size?: string; colour?: string }) {
    return (await this.previous(canonicalUrl, want))[0] ?? null;
  }

  async sizeAdvice(principal: Principal, input: SizeAdviceInput) {
    assertPrincipal(principal);
    const { facts, profileVersion } = await ownerSizeFacts(this.db, principal.userId);
    return { ...sizeAdvice(input, facts), profileVersion };
  }

  async verdict(principal: Principal, input: VerdictInput) {
    assertPrincipal(principal);
    const doc = await this.db
      .prepare("SELECT body, version FROM style_documents WHERE user_id = ? AND is_current = 1 ORDER BY CASE source WHEN 'owner_supplied' THEN 0 WHEN 'owner_edit' THEN 1 ELSE 2 END LIMIT 1")
      .bind(principal.userId)
      .first<{ body: string; version: number }>();
    const { results } = await this.db
      .prepare('SELECT garment_id, name, category, color, acquisition, disposal_reason FROM garments WHERE user_id = ?')
      .bind(principal.userId)
      .all<{ garment_id: string; name: string; category: string; color: string | null; acquisition: string; disposal_reason: string | null }>();
    const owned: OwnedItem[] = results.map((r) => ({ garmentId: r.garment_id, name: r.name, category: r.category, color: r.color, acquisition: r.acquisition, disposalReason: r.disposal_reason }));
    const healing = await this.db.prepare("SELECT 1 AS x FROM restrictions WHERE user_id = ? AND kind = 'healing' AND lifted_at IS NULL").bind(principal.userId).first();
    return purchaseVerdict(input, doc?.body ?? '', doc?.version ?? null, owned, Boolean(healing));
  }
}

function mergeFacts(a: ProductFacts | null, b: ProductFacts): ProductFacts {
  if (!a) return b;
  return {
    name: a.name ?? b.name,
    brand: a.brand ?? b.brand,
    material: a.material ?? b.material,
    description: a.description ?? b.description,
    variants: b.variants.length ? b.variants : a.variants,
    productLevelAvailability: b.productLevelAvailability !== 'unknown' ? b.productLevelAvailability : a.productLevelAvailability,
    priceMinor: b.priceMinor ?? a.priceMinor,
    currency: b.currency ?? a.currency,
    sizeChart: a.sizeChart.length ? a.sizeChart : b.sizeChart,
    sizeChartUnit: a.sizeChartUnit ?? b.sizeChartUnit,
  };
}
