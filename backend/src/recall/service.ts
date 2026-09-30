import { assertPrincipal, type Principal } from '../domain/principal.js';
import { withoutPastedSecrets } from '../assistant/secrets.js';
import { localDateOf } from '../domain/time.js';
import { rangeInstants, resolveDateRange, type DateRange } from './dates.js';
import { extractJudgments } from './judgments.js';
import type { SearchIndex } from './search-index.js';
import { indexTerms, queryTerms } from './text.js';

/**
 * Source-grounded, dated recall over the continuous conversation (spec section 6).
 *
 * - Think Session is canonical for transcript text. This service keeps a rebuildable D1 projection
 *   (recall_messages, recall_judgments) and drives a search index from it with two cursors:
 *   source_seq (projected) and indexed_seq (upload confirmed searchable).
 * - A query merges index candidates with unindexed recent source rows, resolves every candidate
 *   against the canonical projection and tombstones (a stale index cannot resurrect a deleted fact),
 *   and says when coverage is not exhaustive.
 * - Judgments keep speaker: the owner's liking is distinct from the assistant's recommendation. Later
 *   returns and fit reversals are reported separately. Historical liking never implies ownership.
 */

export interface ProjectedMessage {
  messageId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  authoredAt: string;
  channel?: string | null;
  eventAt?: string | null;
  entityIds?: string[];
}

export interface RecallQuery {
  query: string;
  from?: string;
  to?: string;
  category?: string;
  limit?: number;
  timezone: string;
  now: string;
}

export interface RecallHit {
  messageId: string;
  authoredAt: string;
  localDate: string;
  speaker: string;
  quote: string;
  judgments: { kind: string; speaker: string; subject: string; quote: string }[];
  context: { before: string | null; after: string | null };
  link: string;
  score: number;
}

export interface RecallResult {
  query: string;
  range: DateRange | null;
  hits: RecallHit[];
  laterReversals: { kind: string; subject: string; quote: string; authoredAt: string; messageId: string }[];
  coverage: { sourceSeq: number; indexedSeq: number; exhaustive: boolean; supplementedFromSource: number; index: string };
  notes: string[];
}

interface Row {
  message_id: string;
  seq: number;
  speaker: string;
  authored_at: string;
  text: string;
  terms: string;
  revision: number;
}

const CONVERSATION = 'main';
const SPEAKER: Record<ProjectedMessage['role'], 'owner' | 'assistant' | 'system' | 'tool'> = { user: 'owner', assistant: 'assistant', system: 'system', tool: 'tool' };

export class RecallService {
  constructor(
    private readonly db: D1Database,
    private readonly index: SearchIndex,
  ) {}

  private async watermark(userId: string): Promise<{ sourceSeq: number; indexedSeq: number }> {
    const w = await this.db.prepare('SELECT source_seq, indexed_seq FROM recall_watermarks WHERE user_id = ? AND index_name = ?').bind(userId, this.index.name).first<{ source_seq: number; indexed_seq: number }>();
    const max = await this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM recall_messages WHERE user_id = ?').bind(userId).first<{ n: number }>();
    return { sourceSeq: max?.n ?? 0, indexedSeq: w?.indexed_seq ?? 0 };
  }

  /** Project canonical messages. Idempotent on message id; tombstoned sources are never re-projected. */
  async project(userId: string, messages: ProjectedMessage[]): Promise<number> {
    let added = 0;
    for (const m of messages) {
      // Pasted credentials never reach recall or the search index (ADV-17).
      const text = withoutPastedSecrets(m.text).trim();
      if (!text) continue;
      const tomb = await this.db.prepare('SELECT 1 AS x FROM recall_tombstones WHERE user_id = ? AND source_id = ?').bind(userId, m.messageId).first();
      if (tomb) continue;
      const res = await this.db
        .prepare(
          `INSERT INTO recall_messages (user_id, message_id, seq, conversation_id, role, speaker, channel, authored_at, event_at, text, terms, entity_ids_json, revision)
           SELECT ?, ?, COALESCE((SELECT MAX(seq) FROM recall_messages WHERE user_id = ?), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1
           WHERE NOT EXISTS (SELECT 1 FROM recall_messages WHERE user_id = ? AND message_id = ?)`,
        )
        .bind(userId, m.messageId, userId, CONVERSATION, m.role, SPEAKER[m.role], m.channel ?? null, m.authoredAt, m.eventAt ?? null, text, ` ${indexTerms(text).join(' ')} `, JSON.stringify(m.entityIds ?? []), userId, m.messageId)
        .run();
      if (!res.meta.changes) continue;
      added++;
      if (m.role === 'user' || m.role === 'assistant') {
        for (const j of extractJudgments(text, m.role === 'user' ? 'owner' : 'assistant')) {
          await this.db
            .prepare('INSERT INTO recall_judgments (user_id, judgment_id, message_id, speaker, kind, subject, category, quote, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(userId, `jdg_${crypto.randomUUID().replace(/-/g, '')}`, m.messageId, j.speaker, j.kind, j.subject, j.category, j.quote, m.authoredAt)
            .run();
        }
      }
    }
    return added;
  }

  /**
   * Advance the index from its watermark. Uploads the next source rows, confirms their status, and
   * moves indexed_seq only over a contiguous run of confirmed rows. Safe to repeat after a crash:
   * uploads are keyed by source id and revision.
   */
  async catchUp(userId: string, opts: { max?: number } = {}): Promise<{ uploaded: number; sourceSeq: number; indexedSeq: number }> {
    const { sourceSeq, indexedSeq } = await this.watermark(userId);
    const { results } = await this.db
      .prepare('SELECT message_id, seq, speaker, authored_at, text, revision FROM recall_messages WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .bind(userId, indexedSeq, opts.max ?? 200)
      .all<Row>();
    if (!results.length) return { uploaded: 0, sourceSeq, indexedSeq };
    let uploaded = 0;
    let newIndexed = indexedSeq;
    try {
      const docs = results.map((r) => ({ sourceId: r.message_id, revision: r.revision, kind: 'conversation', occurredAt: r.authored_at, body: `${r.speaker} (${r.authored_at.slice(0, 10)}): ${r.text}` }));
      const { accepted } = await this.index.upload(userId, docs);
      uploaded = accepted.length;
    } finally {
      const status = await this.index.status(userId, results.map((r) => r.message_id));
      for (const r of results) {
        if (status[r.message_id] !== 'indexed') break;
        newIndexed = r.seq;
      }
      await this.db
        .prepare(
          `INSERT INTO recall_watermarks (user_id, index_name, source_seq, indexed_seq, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (user_id, index_name) DO UPDATE SET source_seq = excluded.source_seq, indexed_seq = MAX(recall_watermarks.indexed_seq, excluded.indexed_seq), updated_at = excluded.updated_at`,
        )
        .bind(userId, this.index.name, sourceSeq, newIndexed, new Date().toISOString())
        .run();
    }
    return { uploaded, sourceSeq, indexedSeq: newIndexed };
  }

  async search(principal: Principal, q: RecallQuery): Promise<RecallResult> {
    assertPrincipal(principal);
    const userId = principal.userId;
    const notes: string[] = ['Historical liking does not imply ownership or current stock; check the wardrobe ledger for that.'];
    const range: DateRange | null = q.from || q.to ? { from: q.from ?? '0000-01-01', to: q.to ?? '9999-12-31', expression: 'explicit dates', ambiguous: null } : resolveDateRange(q.query, q.now, q.timezone);
    if (range?.ambiguous) notes.push(`Date: ${range.ambiguous}.`);
    const bounds = range ? rangeInstants(range) : { fromIso: undefined, toIso: undefined };
    const { terms, concepts } = queryTerms(q.query);
    const temporalWords = new Set(['last', 'july', 'june', 'august', 'month', 'week', 'year', 'january', 'february', 'march', 'april', 'may', 'september', 'october', 'november', 'december', 'much', 'so', 'did', 'like', 'liked', 'love', 'loved']);
    const contentTerms = terms.filter((t) => !temporalWords.has(t));
    const wantsPositive = concepts.includes('@positive');
    const categoryConcept = q.category ? `@${q.category}` : concepts.find((c) => ['@footwear', '@shirt', '@trousers', '@jacket', '@knit'].includes(c));
    const searchTerms = [...contentTerms, ...concepts.filter((c) => c !== '@positive' && c !== '@negative')];

    const { sourceSeq, indexedSeq } = await this.watermark(userId);
    const indexHits = searchTerms.length ? await this.index.query(userId, { terms: searchTerms, fromIso: bounds.fromIso, toIso: bounds.toIso, limit: 50 }) : [];
    const { results: unindexed } = await this.db
      .prepare('SELECT message_id FROM recall_messages WHERE user_id = ? AND seq > ? AND authored_at >= ? AND authored_at <= ?')
      .bind(userId, indexedSeq, bounds.fromIso ?? '0000', bounds.toIso ?? '9999')
      .all<{ message_id: string }>();
    // Liked judgments in range are candidates too (the owner's enthusiasm may not repeat the noun).
    const { results: judgedIds } = wantsPositive
      ? await this.db
          .prepare("SELECT DISTINCT message_id FROM recall_judgments WHERE user_id = ? AND speaker = 'owner' AND kind = 'liked' AND occurred_at >= ? AND occurred_at <= ?")
          .bind(userId, bounds.fromIso ?? '0000', bounds.toIso ?? '9999')
          .all<{ message_id: string }>()
      : { results: [] as { message_id: string }[] };
    const candidateIds = [...new Set([...indexHits.map((h) => h.sourceId), ...unindexed.map((u) => u.message_id), ...judgedIds.map((j) => j.message_id)])];

    // Resolve against canonical projection and tombstones.
    const rows: Row[] = [];
    for (let i = 0; i < candidateIds.length; i += 50) {
      const chunk = candidateIds.slice(i, i + 50);
      if (!chunk.length) continue;
      const { results } = await this.db
        .prepare(
          `SELECT m.message_id, m.seq, m.speaker, m.authored_at, m.text, m.terms, m.revision FROM recall_messages m
           WHERE m.user_id = ? AND m.message_id IN (${chunk.map(() => '?').join(',')})
           AND NOT EXISTS (SELECT 1 FROM recall_tombstones t WHERE t.user_id = m.user_id AND t.source_id = m.message_id)`,
        )
        .bind(userId, ...chunk)
        .all<Row>();
      rows.push(...results);
    }
    const inRange = rows.filter((r) => !range || (localDateOf(r.authored_at, q.timezone) >= range.from && localDateOf(r.authored_at, q.timezone) <= range.to));
    const ids = inRange.map((r) => r.message_id);
    const judgments = new Map<string, { kind: string; speaker: string; subject: string; quote: string; category: string | null }[]>();
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const { results } = await this.db
        .prepare(`SELECT message_id, kind, speaker, subject, quote, category FROM recall_judgments WHERE user_id = ? AND message_id IN (${chunk.map(() => '?').join(',')}) AND superseded_by IS NULL`)
        .bind(userId, ...chunk)
        .all<{ message_id: string; kind: string; speaker: string; subject: string; quote: string; category: string | null }>();
      for (const j of results) judgments.set(j.message_id, [...(judgments.get(j.message_id) ?? []), j]);
    }
    const scored = inRange
      .map((r) => {
        let score = 0;
        for (const t of contentTerms) if (r.terms.includes(` ${t} `)) score += 1;
        if (categoryConcept && r.terms.includes(` ${categoryConcept} `)) score += 3;
        const js = judgments.get(r.message_id) ?? [];
        if (wantsPositive && js.some((j) => j.speaker === 'owner' && j.kind === 'liked')) score += 3;
        if (wantsPositive && r.speaker === 'assistant') score -= 2; // the owner's liking, not the assistant's suggestion
        if (categoryConcept && !r.terms.includes(` ${categoryConcept} `)) score -= 2;
        return { r, score, js };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.r.seq - b.r.seq)
      .slice(0, q.limit ?? 8);

    const hits: RecallHit[] = [];
    for (const { r, score, js } of scored) {
      const around = await this.db
        .prepare('SELECT seq, speaker, text FROM recall_messages WHERE user_id = ? AND seq IN (?, ?) ORDER BY seq')
        .bind(userId, r.seq - 1, r.seq + 1)
        .all<{ seq: number; speaker: string; text: string }>();
      const before = around.results.find((a) => a.seq === r.seq - 1);
      const after = around.results.find((a) => a.seq === r.seq + 1);
      hits.push({
        messageId: r.message_id,
        authoredAt: r.authored_at,
        localDate: localDateOf(r.authored_at, q.timezone),
        speaker: r.speaker,
        quote: r.text.slice(0, 600),
        judgments: js.map((j) => ({ kind: j.kind, speaker: j.speaker, subject: j.subject, quote: j.quote })),
        context: { before: before ? `${before.speaker}: ${before.text.slice(0, 300)}` : null, after: after ? `${after.speaker}: ${after.text.slice(0, 300)}` : null },
        link: `garderobe://conversation/${r.message_id}`,
        score,
      });
    }

    // Later returns / fit reversals / rejections of the same subjects, reported separately.
    const subjects = hits.flatMap((h) => h.judgments.filter((j) => j.speaker === 'owner' && j.kind === 'liked').map((j) => j.subject.toLowerCase()));
    const laterReversals: RecallResult['laterReversals'] = [];
    if (subjects.length && range) {
      const { results } = await this.db
        .prepare(
          `SELECT j.kind, j.subject, j.quote, j.occurred_at, j.message_id FROM recall_judgments j WHERE j.user_id = ? AND j.speaker = 'owner' AND j.kind IN ('returned', 'fit_reversal', 'rejected') AND j.occurred_at > ?
           AND NOT EXISTS (SELECT 1 FROM recall_tombstones t WHERE t.user_id = j.user_id AND t.source_id = j.message_id) ORDER BY j.occurred_at`,
        )
        .bind(userId, bounds.toIso ?? '9999')
        .all<{ kind: string; subject: string; quote: string; occurred_at: string; message_id: string }>();
      for (const j of results) {
        const generic = ['shoe', 'shoes', 'sneaker', 'sneakers', 'trainer', 'trainers', 'boot', 'boots', 'footwear', 'loafer', 'loafers', 'derby', 'derbies', 'the', 'and'];
        const words = j.subject.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !generic.includes(w));
        const quoteLower = j.quote.toLowerCase();
        if (subjects.some((s) => s.split(/\s+/).some((w) => w.length > 2 && !generic.includes(w) && (quoteLower.includes(w) || words.includes(w))))) {
          laterReversals.push({ kind: j.kind, subject: j.subject, quote: j.quote, authoredAt: j.occurred_at, messageId: j.message_id });
        }
      }
    }
    const exhaustive = indexedSeq >= sourceSeq;
    if (!exhaustive) notes.push(`Search indexing is behind by ${sourceSeq - indexedSeq} message(s); recent messages were read directly from the source history, but results may not be exhaustive.`);
    return { query: q.query, range, hits, laterReversals, coverage: { sourceSeq, indexedSeq, exhaustive, supplementedFromSource: unindexed.length, index: this.index.name }, notes };
  }

  /**
   * Forget a source: immediate read-time tombstone, projection and index removal, and invalidation of
   * compaction checkpoints that cover it (their summaries may contain the fact). Physical erasure of
   * the Session row is performed by the assistant actor and recorded separately.
   */
  async forget(userId: string, sourceId: string, reason: string): Promise<{ invalidatedCheckpoints: string[] }> {
    const now = new Date().toISOString();
    await this.db.prepare('INSERT INTO recall_tombstones (user_id, source_id, reason, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').bind(userId, sourceId, reason, now).run();
    await this.db.batch([
      this.db.prepare('DELETE FROM recall_judgments WHERE user_id = ? AND message_id = ?').bind(userId, sourceId),
      this.db.prepare('DELETE FROM recall_messages WHERE user_id = ? AND message_id = ?').bind(userId, sourceId),
    ]);
    await this.index.remove(userId, [sourceId]).catch(() => undefined);
    const { results } = await this.db
      .prepare("SELECT checkpoint_id FROM compaction_checkpoints WHERE user_id = ? AND status = 'active' AND covered_ids_json LIKE ?")
      .bind(userId, `%"${sourceId}"%`)
      .all<{ checkpoint_id: string }>();
    for (const c of results) {
      await this.db.prepare("UPDATE compaction_checkpoints SET status = 'invalidated', reason = ? WHERE user_id = ? AND checkpoint_id = ?").bind(`source ${sourceId} deleted`, userId, c.checkpoint_id).run();
    }
    return { invalidatedCheckpoints: results.map((r) => r.checkpoint_id) };
  }

  async markErased(userId: string, sourceId: string): Promise<void> {
    await this.db.prepare("UPDATE recall_tombstones SET erasure_status = 'complete' WHERE user_id = ? AND source_id = ?").bind(userId, sourceId).run();
  }

  async tombstones(userId: string): Promise<string[]> {
    const { results } = await this.db.prepare('SELECT source_id FROM recall_tombstones WHERE user_id = ?').bind(userId).all<{ source_id: string }>();
    return results.map((r) => r.source_id);
  }
}
