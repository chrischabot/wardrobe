/**
 * AI Search adapter (specification section 6, "AI Search is the retrieval service").
 *
 * Written against the Workers binding types shipped in the pinned `@cloudflare/workers-types`
 * (`AiSearchNamespace.get(name)` -> `AiSearchInstance` with `search()`, `items.upload()`, `items.get(id).info()`,
 * `items.delete()`); nothing here guesses a preview REST shape. One private instance per internal user ID,
 * resolved from the authenticated identity by trusted code - a client can never supply an instance name.
 * Retrieval only: service-generated answers, query rewriting, reranking and response caching are off, so
 * the answer is written by the assistant's own Gateway model from retrieved evidence. AI Search results are
 * candidates: every hit is resolved against the current canonical record before use.
 *
 * NOT verified on a deployed instance in this repository's tests (no AI Search binding exists locally);
 * the deployment probes own that.
 */

export interface SearchDocument {
  /** Stable source ID, e.g. `message:<id>` or `order:<id>`. */
  sourceId: string;
  sourceVersion: number;
  kind: "conversation_episode" | "garment" | "order" | "product" | "research_note" | "memory_conclusion" | "comfort_feedback";
  /** Normalized sortable instant (UTC ISO). */
  occurredAt: string;
  entityId: string | null;
  /** Speaker, judgement, dates and source link are kept in the body as well as in metadata. */
  body: string;
}

export interface SearchCandidate {
  sourceId: string;
  sourceVersion: number | null;
  kind: string | null;
  score: number;
  text: string;
}

export interface SearchIndexPort {
  /** Upload one document; resolves only when the service reports the item searchable or failed. */
  upsert(doc: SearchDocument): Promise<{ status: "searchable" | "accepted" | "error"; detail?: string }>;
  remove(sourceId: string): Promise<void>;
  search(query: string, opts: { limit: number; from?: string; to?: string; kind?: string }): Promise<SearchCandidate[]>;
}

/** The five supported custom metadata fields reserved by the specification. */
export const SEARCH_METADATA_FIELDS = ["kind", "occurred_at", "entity_id", "source_id", "source_version"] as const;

/** Bound below the service's upload limit; longer material is split into bounded documents by the caller. */
export const MAX_SEARCH_DOCUMENT_CHARS = 24_000;

export function instanceNameFor(environment: string, userId: string): string {
  if (!/^[a-z]+$/.test(environment)) throw new Error("invalid environment name");
  // Instance names are derived only from the verified internal user ID.
  return `garderobe-${environment}-${userId.toLowerCase().replace(/[^a-z0-9]/g, "-")}`.slice(0, 63);
}

export function itemKeyFor(sourceId: string): string {
  return `${sourceId.replace(/[^A-Za-z0-9:_-]/g, "_")}.md`;
}

export function splitDocument(doc: SearchDocument, maxChars = MAX_SEARCH_DOCUMENT_CHARS): SearchDocument[] {
  if (doc.body.length <= maxChars) return [doc];
  const out: SearchDocument[] = [];
  for (let i = 0, part = 1; i < doc.body.length; i += maxChars, part++) {
    out.push({ ...doc, sourceId: `${doc.sourceId}#${part}`, body: doc.body.slice(i, i + maxChars) });
  }
  return out;
}

/**
 * Administrative provisioning of one owner's private instance through the documented namespace binding
 * (`AiSearchNamespace.create`). Called only by trusted provisioning code with a verified internal user ID.
 * NOT exercised against a real account in this repository; the deployment probes validate it.
 */
export async function provisionSearchInstance(namespace: AiSearchNamespace, environment: string, userId: string, gatewayId: string): Promise<{ instance: string; created: boolean }> {
  const id = instanceNameFor(environment, userId);
  const existing = await namespace.list({ search: id });
  if (existing.result.some((i) => i.id === id)) return { instance: id, created: false };
  // The instance is associated with this environment's private AI Gateway; the service's own response cache stays off.
  await namespace.create({ id, ai_gateway_id: gatewayId, cache: false, rewrite_query: false, reranking: false, hybrid_search_enabled: true, custom_metadata: SEARCH_METADATA_FIELDS.map((field_name) => ({ field_name, data_type: "text" as const })) });
  return { instance: id, created: true };
}

/** Account deletion: remove the owner's whole AI Search instance. Reports `deleted: false` when there was none. */
export async function eraseSearchInstance(namespace: AiSearchNamespace, environment: string, userId: string): Promise<{ instance: string; deleted: boolean }> {
  const id = instanceNameFor(environment, userId);
  const existing = await namespace.list({ search: id });
  if (!existing.result.some((i) => i.id === id)) return { instance: id, deleted: false };
  await namespace.delete(id);
  return { instance: id, deleted: true };
}

export class AiSearchIndex implements SearchIndexPort {
  private readonly instance: AiSearchInstance;

  constructor(namespace: AiSearchNamespace, environment: string, userId: string) {
    this.instance = namespace.get(instanceNameFor(environment, userId));
  }

  async upsert(doc: SearchDocument): Promise<{ status: "searchable" | "accepted" | "error"; detail?: string }> {
    const info = await this.instance.items.uploadAndPoll(itemKeyFor(doc.sourceId), doc.body.slice(0, MAX_SEARCH_DOCUMENT_CHARS), {
      metadata: { kind: doc.kind, occurred_at: doc.occurredAt, entity_id: doc.entityId ?? "", source_id: doc.sourceId, source_version: String(doc.sourceVersion) },
      timeoutMs: 60_000,
    });
    // An accepted upload is not yet a searchable item: only `completed` advances the coverage watermark.
    if (info.status === "completed") return { status: "searchable" };
    if (info.status === "error") return { status: "error", detail: info.error ?? "indexing failed" };
    return { status: "accepted", detail: info.status };
  }

  async remove(sourceId: string): Promise<void> {
    const key = itemKeyFor(sourceId);
    const list = await this.instance.items.list({ per_page: 50, search: key } as never);
    for (const item of list.result) if (item.key === key) await this.instance.items.delete(item.id);
  }

  async search(query: string, opts: { limit: number; from?: string; to?: string; kind?: string }): Promise<SearchCandidate[]> {
    const filters: Record<string, unknown> = {};
    if (opts.from || opts.to) filters["occurred_at"] = { ...(opts.from ? { $gte: opts.from } : {}), ...(opts.to ? { $lte: opts.to } : {}) };
    if (opts.kind) filters["kind"] = { $eq: opts.kind };
    const res = await this.instance.search({
      query: query.slice(0, 1000),
      ai_search_options: {
        retrieval: { retrieval_type: "hybrid", max_num_results: Math.min(opts.limit, 50), ...(Object.keys(filters).length ? { filters: filters as never } : {}) },
        query_rewrite: { enabled: false },
        reranking: { enabled: false },
        cache: { enabled: false },
      },
    });
    return res.chunks.map((c) => {
      const meta = (c.item.metadata ?? {}) as Record<string, unknown>;
      const version = Number(meta["source_version"]);
      return { sourceId: String(meta["source_id"] ?? c.item.key.replace(/\.md$/, "")), sourceVersion: Number.isFinite(version) ? version : null, kind: typeof meta["kind"] === "string" ? (meta["kind"] as string) : null, score: c.score, text: c.text };
    });
  }
}
