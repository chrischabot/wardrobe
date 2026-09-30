import { indexTerms } from './text.js';

/**
 * Search index behind the recall projection. Production: one private Cloudflare AI Search instance
 * per internal user id (resolved from the authenticated identity, never from a client). Local and
 * tests: LocalSearchIndex over D1. Both are driven by the same watermark: an accepted upload is not
 * searchable until its status reports it indexed.
 */
export interface RecallDoc {
  sourceId: string;
  revision: number;
  kind: string;
  occurredAt: string;
  body: string;
}

export interface SearchIndex {
  readonly name: string;
  upload(userId: string, docs: RecallDoc[]): Promise<{ accepted: string[] }>;
  status(userId: string, sourceIds: string[]): Promise<Record<string, 'indexed' | 'pending' | 'failed'>>;
  query(userId: string, q: { terms: string[]; fromIso?: string; toIso?: string; limit: number }): Promise<{ sourceId: string; score: number }[]>;
  remove(userId: string, sourceIds: string[]): Promise<void>;
}

export class LocalSearchIndex implements SearchIndex {
  readonly name = 'local-d1';
  /** Test hooks: fail uploads after N docs (simulated crash) or keep uploads pending (simulated lag). */
  failAfter: number | null = null;
  holdPending = false;
  constructor(private readonly db: D1Database) {}

  async upload(userId: string, docs: RecallDoc[]): Promise<{ accepted: string[] }> {
    const accepted: string[] = [];
    for (const d of docs) {
      if (this.failAfter !== null && accepted.length >= this.failAfter) throw new Error('simulated index outage');
      await this.db
        .prepare(
          `INSERT INTO recall_index_docs (user_id, source_id, revision, kind, occurred_at, terms, body, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (user_id, source_id) DO UPDATE SET revision = excluded.revision, terms = excluded.terms, body = excluded.body, occurred_at = excluded.occurred_at, status = excluded.status
           WHERE excluded.revision >= recall_index_docs.revision`,
        )
        .bind(userId, d.sourceId, d.revision, d.kind, d.occurredAt, ` ${indexTerms(d.body).join(' ')} `, d.body.slice(0, 4000), this.holdPending ? 'pending' : 'indexed')
        .run();
      accepted.push(d.sourceId);
    }
    return { accepted };
  }

  async status(userId: string, sourceIds: string[]) {
    const out: Record<string, 'indexed' | 'pending' | 'failed'> = {};
    if (!sourceIds.length) return out;
    const { results } = await this.db
      .prepare(`SELECT source_id, status FROM recall_index_docs WHERE user_id = ? AND source_id IN (${sourceIds.map(() => '?').join(',')})`)
      .bind(userId, ...sourceIds)
      .all<{ source_id: string; status: 'indexed' | 'pending' }>();
    for (const id of sourceIds) out[id] = 'failed';
    for (const r of results) out[r.source_id] = r.status;
    return out;
  }

  async query(userId: string, q: { terms: string[]; fromIso?: string; toIso?: string; limit: number }) {
    const { results } = await this.db
      .prepare(`SELECT source_id, terms FROM recall_index_docs WHERE user_id = ? AND status = 'indexed' AND occurred_at >= ? AND occurred_at <= ?`)
      .bind(userId, q.fromIso ?? '0000', q.toIso ?? '9999')
      .all<{ source_id: string; terms: string }>();
    return results
      .map((r) => ({ sourceId: r.source_id, score: q.terms.reduce((n, t) => n + (r.terms.includes(` ${t} `) ? (t.startsWith('@') ? 2 : 1) : 0), 0) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, q.limit);
  }

  async remove(userId: string, sourceIds: string[]): Promise<void> {
    for (const id of sourceIds) await this.db.prepare('DELETE FROM recall_index_docs WHERE user_id = ? AND source_id = ?').bind(userId, id).run();
  }
}

/**
 * Adapter for a per-user AI Search instance, written against the documented Workers binding shape
 * (namespace -> instance -> items.upload / items.get / search). Not exercised against a live
 * instance in this workstream; the deployment probe must validate it before search coverage is
 * reported. Retrieval only: no service-generated answers on the recall path.
 */
export interface AiSearchInstanceLike {
  items: {
    upload(input: { name: string; content: string; metadata: Record<string, string> }[]): Promise<unknown>;
    get(name: string): Promise<{ status?: string } | null>;
    delete(name: string): Promise<unknown>;
  };
  search(input: { query: string; max_num_results: number; filters?: unknown; rewrite_query?: boolean }): Promise<{ data?: { filename?: string; score?: number; attributes?: Record<string, string> }[] }>;
}

export class AiSearchIndex implements SearchIndex {
  readonly name = 'ai-search';
  constructor(private readonly instanceFor: (userId: string) => AiSearchInstanceLike) {}

  async upload(userId: string, docs: RecallDoc[]) {
    const inst = this.instanceFor(userId);
    await inst.items.upload(
      docs.map((d) => ({
        name: `${d.sourceId}.md`,
        content: d.body,
        metadata: { kind: d.kind, occurred_at: d.occurredAt, entity_id: '', source_id: d.sourceId, source_version: String(d.revision) },
      })),
    );
    return { accepted: docs.map((d) => d.sourceId) };
  }

  async status(userId: string, sourceIds: string[]) {
    const inst = this.instanceFor(userId);
    const out: Record<string, 'indexed' | 'pending' | 'failed'> = {};
    for (const id of sourceIds) {
      const item = await inst.items.get(`${id}.md`).catch(() => null);
      out[id] = item?.status === 'completed' || item?.status === 'indexed' ? 'indexed' : item ? 'pending' : 'failed';
    }
    return out;
  }

  async query(userId: string, q: { terms: string[]; fromIso?: string; toIso?: string; limit: number }) {
    const inst = this.instanceFor(userId);
    const filters = q.fromIso || q.toIso ? { type: 'and', filters: [{ type: 'gte', key: 'occurred_at', value: q.fromIso ?? '0000' }, { type: 'lte', key: 'occurred_at', value: q.toIso ?? '9999' }] } : undefined;
    const res = await inst.search({ query: q.terms.map((t) => t.replace(/^@/, '')).join(' '), max_num_results: q.limit, filters, rewrite_query: false });
    return (res.data ?? []).map((d) => ({ sourceId: d.attributes?.source_id ?? (d.filename ?? '').replace(/\.md$/, ''), score: d.score ?? 0 })).filter((d) => d.sourceId);
  }

  async remove(userId: string, sourceIds: string[]) {
    const inst = this.instanceFor(userId);
    for (const id of sourceIds) await inst.items.delete(`${id}.md`).catch(() => undefined);
  }
}
