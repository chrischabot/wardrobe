/**
 * Bounded search investigation over injected providers: budget, source
 * de-duplication, provider failover with recorded reduced coverage, and an
 * explicit unresolved reason. Results are candidates only.
 */
import { assertPublicHttpsUrl, canonicalizeUrl, redactSecretsInUrl } from "./url.ts";

export interface SearchProvider {
  name: string;
  search(query: string): Promise<{ results: { url: string; title: string; snippet: string }[] }>;
}

export interface CandidateResult {
  /** Secret-redacted source URL. */
  url: string;
  canonicalUrl: string;
  title: string;
  snippet: string;
  provider: string;
  query: string;
  /**
   * Snippets and result images can identify candidates; they never establish
   * an exact purchasable variant. The product page must be inspected.
   */
  evidenceLevel: "candidate";
}

export interface SearchStepResult {
  /** Provider that answered, or null when no provider was called or all failed. */
  provider: string | null;
  /** New, de-duplicated candidates added by this query. */
  added: CandidateResult[];
  unresolvedReason: string | null;
}

export interface InvestigationReport {
  results: CandidateResult[];
  queriesUsed: number;
  maxQueries: number;
  maxResults: number;
  /** One entry per provider that failed, for example "exa: timeout". */
  reducedCoverage: string[];
  resolved: boolean;
  /** Set when the budget ended or every provider failed without the investigation being marked resolved. */
  unresolvedReason: string | null;
}

export interface SearchInvestigationOptions {
  providers: SearchProvider[];
  maxQueries: number;
  maxResults: number;
}

function redactMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/https?:\/\/[^\s"'<>]+/g, (match) => redactSecretsInUrl(match));
}

export class SearchInvestigation {
  private readonly providers: SearchProvider[];
  private readonly maxQueries: number;
  private readonly maxResults: number;
  private readonly failedProviders = new Set<string>();
  private readonly reducedCoverage: string[] = [];
  private readonly results = new Map<string, CandidateResult>();
  private queriesUsed = 0;
  private resolved = false;

  constructor(options: SearchInvestigationOptions) {
    if (!Number.isInteger(options.maxQueries) || options.maxQueries < 1) throw new RangeError("maxQueries must be a positive integer");
    if (!Number.isInteger(options.maxResults) || options.maxResults < 1) throw new RangeError("maxResults must be a positive integer");
    this.providers = [...options.providers];
    this.maxQueries = options.maxQueries;
    this.maxResults = options.maxResults;
  }

  /** The caller found what it needed on an inspected page; no unresolved reason is reported. */
  markResolved(): void {
    this.resolved = true;
  }

  /**
   * Runs one query against the first available provider, switching to the
   * next when one fails. A failed provider is not retried in this
   * investigation and is recorded as reduced coverage. Does nothing once the
   * budget has ended.
   */
  async search(query: string): Promise<SearchStepResult> {
    const blocked = this.budgetReason() ?? this.providerReason();
    if (blocked !== null) return { provider: null, added: [], unresolvedReason: blocked };
    this.queriesUsed += 1;

    for (const provider of this.providers) {
      if (this.failedProviders.has(provider.name)) continue;
      let found: { url: string; title: string; snippet: string }[];
      try {
        found = (await provider.search(query)).results;
      } catch (error) {
        this.failedProviders.add(provider.name);
        this.reducedCoverage.push(`${provider.name}: ${redactMessage(error)}`);
        continue;
      }
      const added: CandidateResult[] = [];
      for (const item of found) {
        if (this.results.size >= this.maxResults) break;
        const candidate = this.toCandidate(item, provider.name, query);
        if (candidate === null || this.results.has(candidate.canonicalUrl)) continue;
        this.results.set(candidate.canonicalUrl, candidate);
        added.push(candidate);
      }
      return { provider: provider.name, added, unresolvedReason: this.unresolvedReason() };
    }
    return { provider: null, added: [], unresolvedReason: this.unresolvedReason() };
  }

  report(): InvestigationReport {
    return {
      results: [...this.results.values()],
      queriesUsed: this.queriesUsed,
      maxQueries: this.maxQueries,
      maxResults: this.maxResults,
      reducedCoverage: [...this.reducedCoverage],
      resolved: this.resolved,
      unresolvedReason: this.unresolvedReason(),
    };
  }

  private toCandidate(item: { url: string; title: string; snippet: string }, provider: string, query: string): CandidateResult | null {
    let url: string;
    try {
      url = redactSecretsInUrl(assertPublicHttpsUrl(item.url));
    } catch {
      return null; // A result that is not a public HTTPS page is not a usable source.
    }
    return { url, canonicalUrl: canonicalizeUrl(url), title: item.title, snippet: item.snippet, provider, query, evidenceLevel: "candidate" };
  }

  private providerReason(): string | null {
    if (this.providers.length === 0) return "no search provider is available";
    if (this.providers.every((provider) => this.failedProviders.has(provider.name))) return "every search provider failed";
    return null;
  }

  private budgetReason(): string | null {
    if (this.queriesUsed >= this.maxQueries) return `search budget ended: ${this.maxQueries} queries used`;
    if (this.results.size >= this.maxResults) return `search budget ended: ${this.maxResults} results collected`;
    return null;
  }

  private unresolvedReason(): string | null {
    if (this.resolved) return null;
    return this.providerReason() ?? this.budgetReason();
  }
}

export type ImageBackfillStrategy =
  | "order_original_url"
  | "maker_catalogue_and_archives"
  | "exact_product_code"
  | "reputable_retailers"
  | "alternative_search_coverage"
  | "rendered_or_interactive_pages"
  | "request_photograph";

export interface ImageBackfillStep {
  strategy: ImageBackfillStrategy;
  /** False when the input this strategy needs was not supplied; the step is then skipped. */
  applicable: boolean;
  detail: string;
}

/**
 * The ordered strategies for finding an item's image. Requesting a photograph
 * is always last. A similar garment is never substituted as an exact match.
 */
export function imageBackfillPlan(input: { orderUrl?: string; maker?: string; productCode?: string }): ImageBackfillStep[] {
  const orderUrl = input.orderUrl?.trim() ?? "";
  const maker = input.maker?.trim() ?? "";
  const code = input.productCode?.trim() ?? "";
  const hasIdentity = maker !== "" || code !== "";
  const subject = [maker, code].filter((part) => part !== "").join(" ");
  return [
    {
      strategy: "order_original_url",
      applicable: orderUrl !== "",
      detail: orderUrl !== "" ? `open the order's original URL ${redactSecretsInUrl(orderUrl)}` : "no order URL is known",
    },
    {
      strategy: "maker_catalogue_and_archives",
      applicable: maker !== "",
      detail: maker !== "" ? `look in ${maker}'s catalogue and archives` : "no maker is known",
    },
    {
      strategy: "exact_product_code",
      applicable: code !== "",
      detail: code !== "" ? `search for the exact product code "${code}"` : "no product code is known",
    },
    {
      strategy: "reputable_retailers",
      applicable: hasIdentity,
      detail: hasIdentity ? `look for ${subject} at reputable retailers` : "no maker or product code is known",
    },
    {
      strategy: "alternative_search_coverage",
      applicable: hasIdentity,
      detail: hasIdentity ? `repeat the search for ${subject} with another search provider` : "no maker or product code is known",
    },
    {
      strategy: "rendered_or_interactive_pages",
      applicable: orderUrl !== "" || hasIdentity,
      detail: "render or interact with the candidate pages in the browser for lazy-loaded or variant-specific images",
    },
    { strategy: "request_photograph", applicable: true, detail: "ask the owner for a photograph of the item" },
  ];
}
