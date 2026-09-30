import type { ConnectionRegistry } from './registry.js';
import { detectInjection } from './untrusted.js';
import { validateOutboundUrl } from './url-policy.js';

/**
 * Web research connectors (spec section 10): Exa and Tavily search, Tavily Extract, and the Browser
 * Run capability family, all behind typed interfaces with a common evidence envelope. Search
 * snippets identify candidates; only an inspected page establishes an exact variant.
 *
 * Real adapters:
 *  - Exa and Tavily through their managed MCP connections (tool names discovered, not hard-coded;
 *    generated-answer and agent/research modes are never requested).
 *  - Browser Run Quick Actions over the documented REST API. Interactive sessions, Live View, WebMCP
 *    and crawl cancellation are exposed in the interface but reported `unverified` until a deployed
 *    capability probe enables them.
 * Tests and the simulation use FakeWeb.
 */

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  provider: string;
  publishedAt?: string;
}

export interface WebSearchProvider {
  readonly name: string;
  search(query: string, opts?: { maxResults?: number }): Promise<SearchResult[]>;
}

export type ExtractionMethod = 'tavily_basic' | 'tavily_advanced' | 'browser_run' | 'exa_fetch' | 'direct';

export interface EvidenceEnvelope {
  canonicalUrl: string;
  finalUrl: string;
  retrievedAt: string;
  method: ExtractionMethod;
  content: string;
  html?: string;
  imageCandidates: string[];
  selectedVariant: { size?: string; colour?: string } | null;
  completeness: 'complete' | 'partial' | 'failed';
  failures: string[];
  anchors: string[];
  suspicious: string[];
}

export interface PageExtractor {
  readonly name: string;
  extract(urls: string[], opts: { depth: 'basic' | 'advanced'; includeImages?: boolean }): Promise<EvidenceEnvelope[]>;
}

export type BrowserCapability = 'content' | 'markdown' | 'links' | 'snapshot' | 'screenshot' | 'pdf' | 'scrape' | 'crawl' | 'sessions' | 'actions' | 'live_view' | 'webmcp';

export interface BrowserService {
  readonly capabilities: Record<BrowserCapability, 'enabled' | 'unverified'>;
  render(url: string, opts?: { format?: 'content' | 'markdown' }): Promise<EvidenceEnvelope>;
  /** Interactive variant check: navigate, select colour and size, capture the rendered state. */
  variantCheck(url: string, variant: { size?: string; colour?: string }): Promise<EvidenceEnvelope>;
  crawl?(url: string, opts: { depth: number; limit: number }): Promise<{ jobId: string }>;
}

export function isChallengePage(text: string): boolean {
  return /\b(verify you are human|captcha|access denied|attention required|enable javascript and cookies|are you a robot)\b/i.test(text);
}

function envelope(url: string, method: ExtractionMethod, content: string, extra: Partial<EvidenceEnvelope> = {}): EvidenceEnvelope {
  const challenge = isChallengePage(content);
  return {
    canonicalUrl: url,
    finalUrl: extra.finalUrl ?? url,
    retrievedAt: extra.retrievedAt ?? new Date().toISOString(),
    method,
    content,
    html: extra.html,
    imageCandidates: extra.imageCandidates ?? [],
    selectedVariant: extra.selectedVariant ?? null,
    completeness: challenge || !content.trim() ? 'failed' : (extra.completeness ?? 'complete'),
    failures: [...(extra.failures ?? []), ...(challenge ? ['challenge page: navigation or challenge only'] : [])],
    anchors: extra.anchors ?? [],
    suspicious: detectInjection(content),
  };
}

/** Exa over its managed MCP connection; search/fetch tool names come from discovery. */
export class ExaMcpProvider implements WebSearchProvider {
  readonly name = 'exa';
  constructor(private readonly registry: ConnectionRegistry, private readonly namespace = 'exa') {}
  async search(query: string, opts: { maxResults?: number } = {}): Promise<SearchResult[]> {
    const conn = await this.registry.get(this.namespace);
    const toolName = conn.tools.find((t) => /search/i.test(t.name) && !/advanced|research|deep/i.test(t.name))?.name;
    if (!toolName) return [];
    const out = (await this.registry.call(this.namespace, toolName, { query, numResults: opts.maxResults ?? 8 })) as { content?: unknown };
    return parseResults(out.content, 'exa');
  }
}

/** Tavily over its managed MCP connection (credential resolved privately at dispatch). */
export class TavilyMcpProvider implements WebSearchProvider, PageExtractor {
  readonly name = 'tavily';
  constructor(private readonly registry: ConnectionRegistry, private readonly namespace = 'tavily') {}
  async search(query: string, opts: { maxResults?: number } = {}): Promise<SearchResult[]> {
    const out = (await this.registry.call(this.namespace, 'tavily_search', { query, max_results: opts.maxResults ?? 8, include_answer: false })) as { content?: unknown };
    return parseResults(out.content, 'tavily');
  }
  async extract(urls: string[], opts: { depth: 'basic' | 'advanced'; includeImages?: boolean }): Promise<EvidenceEnvelope[]> {
    const results: EvidenceEnvelope[] = [];
    for (let i = 0; i < urls.length; i += 20) {
      const batch = urls.slice(i, i + 20).map((u) => validateOutboundUrl(u).toString());
      const out = (await this.registry.call(this.namespace, 'tavily_extract', { urls: batch, extract_depth: opts.depth, include_images: opts.includeImages ?? true })) as { content?: unknown };
      const parsed = typeof out.content === 'string' ? safeJson(out.content) : out.content;
      const items = ((parsed as { results?: { url: string; raw_content?: string; images?: string[] }[] })?.results ?? []) as { url: string; raw_content?: string; images?: string[] }[];
      const failed = ((parsed as { failed_results?: { url: string; error?: string }[] })?.failed_results ?? []) as { url: string; error?: string }[];
      for (const it of items) results.push(envelope(it.url, opts.depth === 'basic' ? 'tavily_basic' : 'tavily_advanced', it.raw_content ?? '', { imageCandidates: it.images ?? [] }));
      for (const f of failed) results.push(envelope(f.url, opts.depth === 'basic' ? 'tavily_basic' : 'tavily_advanced', '', { failures: [f.error ?? 'extraction failed'] }));
    }
    return results;
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function parseResults(content: unknown, provider: string): SearchResult[] {
  const parsed = typeof content === 'string' ? safeJson(content) : content;
  const arr = Array.isArray(parsed) ? parsed : ((parsed as { results?: unknown[] })?.results ?? []);
  return (arr as { url?: string; title?: string; snippet?: string; content?: string; text?: string; publishedDate?: string }[])
    .filter((r) => typeof r.url === 'string')
    .map((r) => ({ url: r.url!, title: r.title ?? '', snippet: (r.snippet ?? r.content ?? r.text ?? '').slice(0, 500), provider, publishedAt: r.publishedDate }));
}

/** Browser Run Quick Actions (REST). Structured JSON extraction is done by the Gateway model, not /json. */
export class BrowserRunRestAdapter implements BrowserService {
  readonly capabilities: Record<BrowserCapability, 'enabled' | 'unverified'> = {
    content: 'enabled',
    markdown: 'enabled',
    links: 'enabled',
    snapshot: 'enabled',
    screenshot: 'enabled',
    pdf: 'enabled',
    scrape: 'enabled',
    crawl: 'unverified',
    sessions: 'unverified',
    actions: 'unverified',
    live_view: 'unverified',
    webmcp: 'unverified',
  };
  constructor(private readonly accountId: string, private readonly token: string, private readonly doFetch: typeof fetch = fetch) {}

  private async quick<T>(action: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.doFetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.accountId)}/browser-rendering/${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Browser Run ${action} ${res.status}`);
    return (await res.json()) as T;
  }

  async render(url: string, opts: { format?: 'content' | 'markdown' } = {}): Promise<EvidenceEnvelope> {
    validateOutboundUrl(url);
    const format = opts.format ?? 'content';
    const r = await this.quick<{ result?: string }>(format, { url });
    return envelope(url, 'browser_run', r.result ?? '', { html: format === 'content' ? r.result : undefined });
  }

  async variantCheck(url: string, variant: { size?: string; colour?: string }): Promise<EvidenceEnvelope> {
    // Without a verified interactive session, render the variant URL and report the selection as unobserved.
    const e = await this.render(url);
    return { ...e, selectedVariant: null, completeness: 'partial', failures: [...e.failures, `interactive selection of ${JSON.stringify(variant)} unverified in this adapter release`] };
  }
}

export interface FakePage {
  html: string;
  /** Content only visible after rendering (JavaScript-heavy shops). */
  renderedHtml?: string;
  /** Per-variant rendered state for interactive checks, keyed `colour|size`. */
  variants?: Record<string, string>;
  images?: string[];
  finalUrl?: string;
}

/** Deterministic fake web for tests and the simulation. */
export class FakeWeb implements WebSearchProvider, PageExtractor, BrowserService {
  readonly name = 'fake-web';
  readonly capabilities: Record<BrowserCapability, 'enabled' | 'unverified'> = { content: 'enabled', markdown: 'enabled', links: 'enabled', snapshot: 'enabled', screenshot: 'enabled', pdf: 'enabled', scrape: 'enabled', crawl: 'enabled', sessions: 'enabled', actions: 'enabled', live_view: 'unverified', webmcp: 'unverified' };
  readonly requests: { kind: string; url: string }[] = [];
  constructor(public pages: Record<string, FakePage> = {}, public results: SearchResult[] = [], public now: () => string = () => new Date().toISOString()) {}

  async search(query: string): Promise<SearchResult[]> {
    this.requests.push({ kind: 'search', url: query });
    return this.results;
  }

  async extract(urls: string[], opts: { depth: 'basic' | 'advanced' }): Promise<EvidenceEnvelope[]> {
    return urls.map((u) => {
      this.requests.push({ kind: `extract_${opts.depth}`, url: u });
      const p = this.pages[u];
      if (!p) return envelope(u, opts.depth === 'basic' ? 'tavily_basic' : 'tavily_advanced', '', { failures: ['404'], retrievedAt: this.now() });
      const html = opts.depth === 'advanced' ? (p.renderedHtml ?? p.html) : p.html;
      return envelope(u, opts.depth === 'basic' ? 'tavily_basic' : 'tavily_advanced', html.replace(/<script[\s\S]*?<\/script>/gi, (m) => (m.includes('ld+json') ? m : '')), { html, imageCandidates: p.images ?? [], finalUrl: p.finalUrl, retrievedAt: this.now() });
    });
  }

  async render(url: string): Promise<EvidenceEnvelope> {
    this.requests.push({ kind: 'render', url });
    const p = this.pages[url];
    const html = p ? (p.renderedHtml ?? p.html) : '';
    return envelope(url, 'browser_run', html, { html, imageCandidates: p?.images ?? [], finalUrl: p?.finalUrl, retrievedAt: this.now(), failures: p ? [] : ['404'] });
  }

  async variantCheck(url: string, variant: { size?: string; colour?: string }): Promise<EvidenceEnvelope> {
    this.requests.push({ kind: 'variant', url });
    const p = this.pages[url];
    const key = `${variant.colour ?? ''}|${variant.size ?? ''}`;
    const html = p?.variants?.[key];
    if (!p || !html) return envelope(url, 'browser_run', p?.renderedHtml ?? p?.html ?? '', { retrievedAt: this.now(), completeness: 'partial', failures: [`variant ${key} not selectable`] });
    return envelope(url, 'browser_run', html, { html, selectedVariant: variant, retrievedAt: this.now(), imageCandidates: p.images ?? [] });
  }
}
