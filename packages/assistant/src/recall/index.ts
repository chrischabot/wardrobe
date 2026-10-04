/**
 * Durable recall (specification section 6).
 *
 * The Think Session holds the canonical transcript. This module maintains the rebuildable retrieval
 * projection in D1 (message ID, channel, authored time, entity IDs, terms and typed judgements that keep
 * their speaker) behind a watermark, and answers recall queries by exact date/entity/term search over it,
 * merged with AI Search candidates when that service is bound. Every candidate is resolved against the
 * current canonical projection row and the forget tombstones, so a stale index can reduce recall but can
 * never resurrect a forgotten fact. Typed judgements here are extracted lexically (deterministic, no
 * inference); semantic paraphrase beyond this lexicon is AI Search's job.
 */
import { isAboutSomeoneElse, ownerAuthoredText } from "../policy/voice.ts";
import type { JudgementKind, RecallHit, RecallResult } from "@garderobe/contracts/ext/assistant";
import { all, first, getSettings, localDateOf, normalizePhrase, prepare, sha256Hex, stmt, toInstant, type Db, type Principal, type Stmt } from "@garderobe/domain";
import { tombstonedIds } from "../queries.ts";
import type { SearchIndexPort } from "./ai-search.ts";
import { resolveDateRange } from "./temporal.ts";

export interface CanonicalMessage {
  messageId: string;
  position: number;
  role: "user" | "assistant" | "system";
  /** Owner-authored or assistant text only (attachments and tool payloads are not indexed as speech). */
  text: string;
  /** Everything else the message carries: attachments of an owner message, tool calls and results of an assistant message. Never recalled as speech; kept as terms so that forgetting can find reuse. */
  dataText?: string;
  authoredAt: string;
  channel: string | null;
  turnId: string | null;
}

const JUDGEMENT_PATTERNS: { kind: JudgementKind; re: RegExp }[] = [
  { kind: "rejected", re: /\b(hate[sd]?|can't stand|don't like|do not like|didn't like|not for me|dislike[sd]?|disappoint(?:ed|ing)|regret|awful|terrible|too (?:shiny|stiff|flimsy|cheap))\b/ },
  { kind: "liked", re: /\b(love[sd]?|adore[sd]?|like[sd]?|favou?rite|best (?:thing|pair|purchase|one)|perfect|brilliant|delighted|obsessed|so good|really good|great|fantastic|wonderful|happy with|pleased with|can't stop wearing)\b/ },
  { kind: "returned", re: /\b(return(?:ed|ing)|sent (?:it|them|those) back|send(?:ing)? (?:it|them|those) back|refund(?:ed)?|went back)\b/ },
  { kind: "ordered", re: /\b(ordered|bought|purchased|picked up a|just got|pre-?ordered)\b/ },
  { kind: "worn", re: /\b(wore|wearing|worn|had on|put on)\b/ },
  { kind: "discomfort", re: /\b(hurt[s]?|blister[s]?|scratch(?:y|es)?|itch(?:y|es)?|too (?:warm|hot|cold|tight)|rub(?:s|bed)?|pinch(?:es|ed)?|sore)\b/ },
  { kind: "considering", re: /\b(thinking about|considering|tempted by|wondering about|recommend|suggest|you might like|worth a look)\b/ },
];

/** Category words so a question about "shoes" finds a message that only says "loafers" or "on my feet". */
const TOPIC_LEXICON: Record<string, string[]> = {
  footwear: ["shoe", "shoes", "footwear", "sneaker", "sneakers", "trainer", "trainers", "boot", "boots", "loafer", "loafers", "derby", "derbies", "brogue", "brogues", "oxfords", "moccasin", "moccasins", "feet", "foot", "sole", "soles", "laces", "990", "990v4", "990v6", "pair"],
  shirt: ["shirt", "shirts", "oxford", "ocbd", "button-down", "collar", "poplin"],
  knitwear: ["sweater", "sweaters", "jumper", "jumpers", "cardigan", "cardigans", "knit", "knitwear", "shetland", "crewneck"],
  trousers: ["trousers", "trouser", "chinos", "jeans", "pants", "cords", "corduroys", "flannels"],
  outerwear: ["jacket", "jackets", "coat", "coats", "blazer", "blazers", "chore", "parka", "overshirt"],
  socks: ["sock", "socks"],
};
const STOP = new Set("the a an and or but so of to in on at for with from by is are was were be been it its this that these those i you he she we they my your me did do does what which who when where how much many very really just about any some as if then than them their our not no yes".split(" "));

function tokens(text: string): string[] {
  return normalizePhrase(text).split(" ").filter((w) => w.length > 1 && !STOP.has(w));
}
/** The index terms of a text (words and their stems), as stored in `conversation_index.terms`. */
export function termsOfText(text: string): string[] {
  const words = tokens(text);
  return [...new Set([...words, ...words.map(stem)])];
}
function stem(word: string): string {
  return word.length > 4 ? word.replace(/(ies|es|s|ed|ing)$/, "") : word;
}
/**
 * The one form every index term of a word reduces to: the stem of its stem, until it no longer changes
 * ("dresses", "dress" and "dres" are all "dres"). Two index terms are the same word exactly when this is equal.
 */
export function canonicalTerm(term: string): string {
  let current = term;
  for (let next = stem(current); next !== current; next = stem(current)) current = next;
  return current;
}
function topicsOf(words: string[]): string[] {
  return Object.entries(TOPIC_LEXICON).filter(([, list]) => words.some((w) => list.includes(w))).map(([topic]) => topic);
}
function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

export function extractJudgements(text: string): { kind: JudgementKind; subject: string }[] {
  const out: { kind: JudgementKind; subject: string }[] = [];
  for (const sentence of sentencesOf(text)) {
    const s = sentence.toLowerCase();
    for (const p of JUDGEMENT_PATTERNS) {
      if (!p.re.test(s)) continue;
      // "don't like" is a rejection, not a liking.
      if (p.kind === "liked" && JUDGEMENT_PATTERNS[0]!.re.test(s)) continue;
      out.push({ kind: p.kind, subject: sentence.slice(0, 300) });
    }
  }
  return out;
}

export interface EntityLexiconEntry {
  entityId: string;
  phrases: string[];
  /** Topic of the record (its category), so "those Michaels" is found by a question about shoes. */
  topic?: string | null;
}

/** Topics of the records a text names. */
function entityTopics(ids: string[], lexicon: EntityLexiconEntry[]): string[] {
  return [...new Set(ids.map((id) => lexicon.find((e) => e.entityId === id)?.topic).filter((t): t is string => !!t && t in TOPIC_LEXICON))];
}

function entitiesIn(text: string, lexicon: EntityLexiconEntry[]): string[] {
  const n = ` ${normalizePhrase(text)} `;
  const ids = new Set<string>();
  for (const e of lexicon) for (const p of e.phrases) if (p.length >= 4 && n.includes(` ${p} `)) ids.add(e.entityId);
  return [...ids];
}

/** Names and aliases of the owner's garments and shopping candidates, for entity linking. */
export async function loadEntityLexicon(db: Db, userId: string): Promise<EntityLexiconEntry[]> {
  const garments = await all<{ garment_id: string; name: string; category: string }>(db, "SELECT garment_id, name, category FROM garments WHERE user_id = ?", userId);
  const aliases = await all<{ garment_id: string; normalized: string }>(db, "SELECT garment_id, normalized FROM garment_aliases WHERE user_id = ?", userId);
  const products = await all<{ product_id: string; name: string }>(db, "SELECT product_id, name FROM products WHERE user_id = ?", userId);
  const map = new Map<string, Set<string>>();
  const add = (id: string, phrase: string) => {
    if (!map.has(id)) map.set(id, new Set());
    map.get(id)!.add(normalizePhrase(phrase));
  };
  for (const g of garments) add(g.garment_id, g.name);
  for (const a of aliases) add(a.garment_id, a.normalized);
  for (const p of products) add(p.product_id, p.name);
  const topic = new Map(garments.map((g) => [g.garment_id, g.category]));
  return [...map.entries()].map(([entityId, phrases]) => ({ entityId, phrases: [...phrases], topic: topic.get(entityId) ?? null }));
}

/**
 * Project canonical messages into the retrieval index. Idempotent per message (source hash), so a retry
 * or a rebuild from position 0 neither loses nor duplicates messages; the watermark only advances over
 * contiguously indexed positions.
 */
export async function indexMessages(db: Db, userId: string, conversationId: string, messages: CanonicalMessage[], opts: { nowMs: number; timezone: string; lexicon?: EntityLexiconEntry[] }): Promise<{ indexed: number; skipped: number; indexedPosition: number }> {
  const forgotten = await tombstonedIds(db, userId, "message");
  const lexicon = opts.lexicon ?? (await loadEntityLexicon(db, userId));
  const now = toInstant(opts.nowMs);
  let indexed = 0;
  let skipped = 0;
  const ordered = [...messages].sort((a, b) => a.position - b.position);
  for (const m of ordered) {
    if (m.role === "system" || (!m.text.trim() && !m.dataText) || forgotten.has(m.messageId)) {
      skipped++;
      continue;
    }
    const dataTerms = m.dataText ? termsOfText(m.dataText.slice(0, 60_000)).join(" ") : "";
    const hash = await sha256Hex(`${m.role}\u001f${m.text}\u001f${dataTerms}`);
    const existing = await first<{ source_hash: string; index_version: number }>(db, "SELECT source_hash, index_version FROM conversation_index WHERE user_id = ? AND message_id = ?", userId, m.messageId);
    if (existing?.source_hash === hash && Number(existing.index_version) >= CURRENT_INDEX_VERSION) {
      skipped++;
      continue;
    }
    const speaker = m.role === "user" ? "owner" : "assistant";
    const words = tokens(m.text);
    const authoredDate = localDateOf(Date.parse(m.authoredAt), opts.timezone);
    const entityIds = entitiesIn(m.text, lexicon);
    const terms = [...new Set([...words, ...words.map(stem), ...[...topicsOf(words), ...entityTopics(entityIds, lexicon)].map((t) => `topic:${t}`)])].join(" ");
    const batch: Stmt[] = [
      stmt("DELETE FROM conversation_judgements WHERE user_id = ? AND message_id = ?", userId, m.messageId),
      stmt(
        `INSERT INTO conversation_index (user_id, message_id, conversation_id, position, channel, turn_id, speaker, authored_at, authored_date, entity_ids_json, terms, data_terms, excerpt, source_hash, indexed_at, index_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${CURRENT_INDEX_VERSION})
         ON CONFLICT (user_id, message_id) DO UPDATE SET position = excluded.position, entity_ids_json = excluded.entity_ids_json, terms = excluded.terms, data_terms = excluded.data_terms, excerpt = excluded.excerpt, source_hash = excluded.source_hash, indexed_at = excluded.indexed_at, index_version = excluded.index_version`,
        userId, m.messageId, conversationId, m.position, m.channel, m.turnId, speaker, m.authoredAt, authoredDate, JSON.stringify(entityIds), terms, dataTerms, m.text.slice(0, 1200), hash, now,
      ),
    ];
    let n = 0;
    // A judgement is attributed to the owner only from the owner's own voice (relayed, quoted and pasted
    // passages are removed) and never from a sentence about somebody else's liking or buying.
    const judged = speaker === "owner" ? extractJudgements(ownerAuthoredText(m.text)).filter((j) => !isAboutSomeoneElse(j.subject)) : extractJudgements(m.text);
    for (const j of judged) {
      const jWords = tokens(j.subject);
      batch.push(
        stmt(
          "INSERT INTO conversation_judgements (user_id, judgement_id, message_id, speaker, kind, subject, subject_terms, entity_id, authored_at, authored_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          userId, `${m.messageId}:${n++}`, m.messageId, speaker, j.kind, j.subject, [...new Set([...jWords, ...jWords.map(stem), ...[...topicsOf(jWords), ...entityTopics(entitiesIn(j.subject, lexicon), lexicon)].map((t) => `topic:${t}`)])].join(" "), entitiesIn(j.subject, lexicon)[0] ?? null, m.authoredAt, authoredDate,
        ),
      );
    }
    await db.batch(batch.map((s) => prepare(db, s)));
    indexed++;
  }
  const maxPosition = ordered.reduce((p, m) => Math.max(p, m.position), 0);
  await prepare(
    db,
    stmt(
      `INSERT INTO conversation_index_state (user_id, conversation_id, indexed_position, indexed_through, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, conversation_id) DO UPDATE SET indexed_position = MAX(indexed_position, excluded.indexed_position), indexed_through = CASE WHEN excluded.indexed_position >= indexed_position THEN excluded.indexed_through ELSE indexed_through END, updated_at = excluded.updated_at`,
      userId, conversationId, maxPosition, ordered.length > 0 ? ordered[ordered.length - 1]!.authoredAt : null, now,
    ),
  ).run();
  const state = await first<{ indexed_position: number }>(db, "SELECT indexed_position FROM conversation_index_state WHERE user_id = ? AND conversation_id = ?", userId, conversationId);
  return { indexed, skipped, indexedPosition: state?.indexed_position ?? 0 };
}

/**
 * The version of index entries this indexer writes (2: with `data_terms`, migration 0204). Entries of an
 * earlier version are re-indexed once by the conversation actor (see `staleIndexEntries`).
 */
export const CURRENT_INDEX_VERSION = 2;

/** Whether any of the owner's index entries was written by an earlier version of the indexer. */
export async function staleIndexEntries(db: Db, userId: string): Promise<boolean> {
  return (await first(db, `SELECT 1 AS x FROM conversation_index WHERE user_id = ? AND index_version < ${CURRENT_INDEX_VERSION} LIMIT 1`, userId)) != null;
}

/** After a rebuild from the first message: entries the rebuild had nothing newer to write for are current too. */
export async function markIndexCurrent(db: Db, userId: string): Promise<void> {
  await prepare(db, stmt(`UPDATE conversation_index SET index_version = ${CURRENT_INDEX_VERSION} WHERE user_id = ? AND index_version < ${CURRENT_INDEX_VERSION}`, userId)).run();
}

export async function indexWatermark(db: Db, userId: string, conversationId: string): Promise<{ indexedPosition: number; indexedThrough: string | null }> {
  const row = await first<{ indexed_position: number; indexed_through: string | null }>(db, "SELECT indexed_position, indexed_through FROM conversation_index_state WHERE user_id = ? AND conversation_id = ?", userId, conversationId);
  return { indexedPosition: row?.indexed_position ?? 0, indexedThrough: row?.indexed_through ?? null };
}

function inferJudgement(text: string): JudgementKind | undefined {
  const t = text.toLowerCase();
  if (/\b(return|sent back|send back|refund)/.test(t)) return "returned";
  if (/\b(hate|dislike|didn't like|not like|reject)/.test(t)) return "rejected";
  if (/\b(like|liked|love|loved|favou?rite|enjoy|so much|keen on|rave|pleased|happy with|delighted|fond of|impressed)/.test(t)) return "liked";
  if (/\b(order|ordered|buy|bought|purchase)/.test(t)) return "ordered";
  if (/\b(hurt|uncomfortable|scratch|too warm|too cold)/.test(t)) return "discomfort";
  return undefined;
}

export interface RecallInput {
  text?: string;
  entityIds?: string[];
  from?: string;
  to?: string;
  judgement?: JudgementKind;
  speaker?: "owner" | "assistant";
  limit?: number;
}

export interface RecallDeps {
  nowMs: number;
  conversationId: string;
  /** Canonical messages after the index watermark, read directly from the source history. */
  unindexedSource?: () => Promise<CanonicalMessage[]>;
  searchIndex?: SearchIndexPort | null;
  /** Think Session full-text search: exact words in the source history, including material not yet indexed. */
  sessionSearch?: (query: string, limit: number) => Promise<{ messageId: string }[]>;
}

const CAVEAT = "These are things said in conversation. Liking, ordering or discussing something in the past does not mean it is owned or in stock now; check the wardrobe records for that.";

export async function recall(db: Db, principal: Principal, input: RecallInput, deps: RecallDeps): Promise<RecallResult> {
  const userId = principal.userId;
  const { settings } = await getSettings(db, principal);
  const text = input.text ?? "";
  const resolved = input.from && input.to ? { from: input.from, to: input.to, basis: "the dates given", ambiguity: null } : resolveDateRange(text, deps.nowMs, settings.timezone);
  const from = input.from ?? resolved?.from ?? "0000-01-01";
  const to = input.to ?? resolved?.to ?? "9999-12-31";
  const judgement = input.judgement ?? inferJudgement(text);
  const speaker = input.speaker ?? (/\b(did|do|have|had|was|am) i\b|\bi (liked|loved|said|wore|bought|ordered|returned|was|told)\b/.test(text.toLowerCase()) ? "owner" : undefined);
  const limit = input.limit ?? 10;

  const qWords = tokens(text).filter((w) => !/^(last|this|ago|january|february|march|april|june|july|august|september|october|november|december|year|month|week|summer|winter|spring|autumn)$/.test(w));
  const qTerms = new Set([...qWords, ...qWords.map(stem), ...topicsOf(qWords).map((t) => `topic:${t}`)]);
  const topicTerms = [...qTerms].filter((t) => t.startsWith("topic:"));

  const forgotten = await tombstonedIds(db, userId, "message");
  const watermark = await indexWatermark(db, userId, deps.conversationId);

  // Bring the unindexed tail in directly, so a lagging index is disclosed and still searched.
  let unindexed: CanonicalMessage[] = [];
  if (deps.unindexedSource) unindexed = (await deps.unindexedSource()).filter((m) => m.position > watermark.indexedPosition && !forgotten.has(m.messageId) && m.role !== "system");

  interface Row { message_id: string; position: number; channel: string | null; speaker: string; authored_at: string; authored_date: string; entity_ids_json: string; terms: string; excerpt: string }
  const rows = await all<Row>(db, "SELECT message_id, position, channel, speaker, authored_at, authored_date, entity_ids_json, terms, excerpt FROM conversation_index WHERE user_id = ? AND authored_date >= ? AND authored_date <= ? ORDER BY authored_at DESC LIMIT 4000", userId, from, to);
  const judgementRows = await all<{ message_id: string; speaker: string; kind: string; subject: string; subject_terms: string; entity_id: string | null; authored_at: string }>(
    db,
    "SELECT message_id, speaker, kind, subject, subject_terms, entity_id, authored_at FROM conversation_judgements WHERE user_id = ? ORDER BY authored_at",
    userId,
  );
  const judgementsByMessage = new Map<string, typeof judgementRows>();
  for (const j of judgementRows) {
    if (!judgementsByMessage.has(j.message_id)) judgementsByMessage.set(j.message_id, []);
    judgementsByMessage.get(j.message_id)!.push(j);
  }

  const lexicon = unindexed.length > 0 ? await loadEntityLexicon(db, userId) : [];
  const candidates: (Row & { origin: "source_history" | "ai_search" | "both"; live?: { kind: JudgementKind; subject: string }[] })[] = rows.map((r) => ({ ...r, origin: "source_history" as const }));
  for (const m of unindexed) {
    const date = localDateOf(Date.parse(m.authoredAt), settings.timezone);
    if (date < from || date > to) continue;
    const words = tokens(m.text);
    const ids = entitiesIn(m.text, lexicon);
    candidates.push({
      message_id: m.messageId, position: m.position, channel: m.channel, speaker: m.role === "user" ? "owner" : "assistant", authored_at: m.authoredAt, authored_date: date,
      entity_ids_json: JSON.stringify(ids), terms: [...new Set([...words, ...words.map(stem), ...[...topicsOf(words), ...entityTopics(ids, lexicon)].map((t) => `topic:${t}`)])].join(" "), excerpt: m.text.slice(0, 1200), origin: "source_history", live: extractJudgements(m.text),
    });
  }

  // AI Search candidates only count when they resolve to a current canonical row in range.
  if (deps.searchIndex && text.trim()) {
    try {
      const found = await deps.searchIndex.search(text, { limit: 30, from: `${from}T00:00:00Z`, to: `${to}T23:59:59Z`, kind: "conversation_episode" });
      for (const f of found) {
        const id = f.sourceId.replace(/^message:/, "").replace(/#\d+$/, "");
        const c = candidates.find((x) => x.message_id === id);
        if (c) c.origin = c.origin === "source_history" ? "both" : c.origin;
      }
    } catch {
      // Lexical and entity search stay available during an AI Search outage.
    }
  }

  // Session FTS confirms exact wording in the source history. It only raises rows that are already current
  // canonical candidates, so a forgotten or out-of-range message cannot enter through it.
  const ftsIds = new Set<string>();
  if (deps.sessionSearch && qWords.length > 0) {
    try {
      for (const hit of await deps.sessionSearch(qWords.join(" "), 40)) ftsIds.add(hit.messageId);
    } catch {
      // The index and the direct tail read stay available.
    }
  }

  const wantEntities = new Set(input.entityIds ?? []);
  const scored = candidates
    .filter((c) => !forgotten.has(c.message_id))
    .filter((c) => !speaker || c.speaker === speaker)
    .map((c) => {
      const terms = new Set(c.terms.split(" "));
      const js = c.live ? c.live.map((j) => ({ kind: j.kind as string, subject: j.subject, speaker: c.speaker, subject_terms: tokens(j.subject).join(" ") })) : (judgementsByMessage.get(c.message_id) ?? []);
      let score = 0;
      for (const t of qTerms) if (terms.has(t)) score += t.startsWith("topic:") ? 3 : 1;
      const entityIds = JSON.parse(c.entity_ids_json) as string[];
      if (wantEntities.size > 0) score += entityIds.filter((e) => wantEntities.has(e)).length * 4;
      const matchingJudgement = judgement ? js.some((j) => j.kind === judgement && (!speaker || j.speaker === speaker)) : false;
      if (judgement) score += matchingJudgement ? 4 : 0;
      if (c.origin === "both") score += 2;
      if (ftsIds.has(c.message_id)) score += 2;
      const topicOk = topicTerms.length === 0 || topicTerms.some((t) => terms.has(t));
      const entityOk = wantEntities.size === 0 || entityIds.some((e) => wantEntities.has(e));
      const judgementOk = !judgement || matchingJudgement;
      return { c, js, score, entityIds, ok: topicOk && entityOk && judgementOk && (score > 0 || (qTerms.size === 0 && wantEntities.size === 0 && !judgement)) };
    })
    .filter((x) => x.ok)
    .sort((a, b) => b.score - a.score || (a.c.authored_at < b.c.authored_at ? 1 : -1))
    .slice(0, limit);

  const positions = [...new Set(scored.flatMap(({ c }) => [c.position - 1, c.position + 1]))].filter((n) => n > 0);
  const byPosition = positions.length > 0 ? await all<{ message_id: string; position: number; speaker: string; authored_at: string; excerpt: string }>(db, `SELECT message_id, position, speaker, authored_at, excerpt FROM conversation_index WHERE user_id = ? AND conversation_id = ? AND position IN (${positions.map(() => "?").join(",")})`, userId, deps.conversationId, ...positions) : [];
  const productNames = new Map((await all<{ product_id: string; name: string }>(db, "SELECT product_id, name FROM products WHERE user_id = ?", userId)).map((p) => [p.product_id, p.name]));
  const hits: RecallHit[] = scored.map(({ c, js, entityIds }) => {
    const myTerms = new Set(c.terms.split(" ").filter((t) => t.length > 3 && !t.startsWith("topic:")));
    const myTopics = c.terms.split(" ").filter((t) => t.startsWith("topic:"));
    // Later returns, rejections or discomfort about the same thing are reported separately, never folded in.
    const later = judgementRows
      .filter((j) => j.authored_at > c.authored_at && !forgotten.has(j.message_id) && ["returned", "rejected", "discomfort"].includes(j.kind))
      .filter((j) => {
        if (j.entity_id && entityIds.includes(j.entity_id)) return true;
        const jt = j.subject_terms.split(" ");
        const sharedTopic = myTopics.some((t) => jt.includes(t));
        const sharedWords = jt.filter((t) => myTerms.has(t)).length;
        return sharedTopic && sharedWords >= 1;
      })
      .slice(0, 5)
      .map((j) => ({ kind: j.kind, messageId: j.message_id, authoredAt: j.authored_at, quote: j.subject }));
    const neighbours = byPosition.filter((n) => Math.abs(n.position - c.position) === 1 && !forgotten.has(n.message_id));
    return {
      surrounding: neighbours.map((n) => ({ messageId: n.message_id, speaker: n.speaker, authoredAt: n.authored_at, quote: n.excerpt.slice(0, 400) })),
      linkedInvestigations: entityIds.filter((e) => productNames.has(e)).map((e) => ({ productId: e, name: productNames.get(e)! })),
      messageId: c.message_id,
      authoredAt: c.authored_at,
      channel: c.channel,
      speaker: c.speaker as "owner" | "assistant",
      quote: c.excerpt,
      judgements: js.map((j) => ({ kind: j.kind as JudgementKind, subject: j.subject, speaker: j.speaker as "owner" | "assistant" })),
      entityIds,
      laterDevelopments: later,
      link: `garderobe://conversation/${deps.conversationId}/message/${c.message_id}`,
      origin: c.origin,
    };
  });

  const gap = unindexed.length;
  return {
    hits,
    resolvedRange: resolved ? { from: resolved.from, to: resolved.to, basis: resolved.basis } : input.from && input.to ? { from: input.from, to: input.to, basis: "the dates given" } : null,
    ambiguity: resolved?.ambiguity ?? null,
    indexGap: gap > 0 ? { unindexedMessages: gap, searchedSourceDirectly: true } : null,
    watermark: { indexedThrough: watermark.indexedThrough, unindexedMessages: gap },
    // Never stated as exhaustive when the caller could not supply the unindexed tail or the scan was capped.
    exhaustive: rows.length < 4000 && deps.unindexedSource !== undefined,
    caveat: CAVEAT,
  };
}
