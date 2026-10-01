/**
 * AI Search projection (specification section 6): the D1 outbox and the conversation index are projected
 * into the owner's private AI Search instance. Idempotent by source ID and revision; the coverage watermark
 * and the outbox acknowledgement advance only after the service reports the item searchable (an accepted
 * upload is not yet a searchable item). Every document is rebuilt from the CURRENT canonical record, so a
 * forgotten or superseded source is removed rather than indexed. The managed service's internal model calls
 * cannot be authorized one by one: the job takes one conservative reservation under the `search` budget and
 * settles it afterwards.
 */
import { acknowledgeOutbox, all, first, getSettings, isCommandError, localDateOf, newId, prepare, readOutbox, stmt, systemPrincipalFor, toInstant, type CommandService, type Db } from "@garderobe/domain";
import { DEFAULT_DAILY_BUDGETS } from "../inference/registry.ts";
import { splitDocument, type SearchDocument, type SearchIndexPort } from "./ai-search.ts";

export const SEARCH_TOPICS = ["search.index", "search.delete", "garment"];
/** Conservative allowance per document for the service's embedding work (micro-USD); a bound, not a price claim. */
export const SEARCH_RESERVATION_PER_DOCUMENT_MICROUSD = 200;

async function forgotten(db: Db, userId: string, kind: string, id: string): Promise<boolean> {
  return (await first(db, "SELECT 1 AS x FROM source_tombstones WHERE user_id = ? AND source_kind = ? AND source_id = ?", userId, kind, id)) !== null;
}

/** Build the search document for a record from its current canonical row, or null when it must not be indexed. */
export async function buildSearchDocument(db: Db, userId: string, entityKind: string, entityId: string): Promise<SearchDocument | null> {
  if (entityKind === "garment") {
    const g = await first<any>(db, "SELECT garment_id, version, name, category, maker, fabric, colour, pattern, acquisition, updated_at, removed_reason FROM garments WHERE user_id = ? AND garment_id = ?", userId, entityId);
    if (!g || g.removed_reason) return null;
    // Descriptive facts only: eligibility and stock always come from D1, never from the index.
    return { sourceId: `garment:${g.garment_id}`, sourceVersion: g.version, kind: "garment", occurredAt: g.updated_at, entityId: g.garment_id, body: `Garment record: ${g.name}. Category: ${g.category}. ${[g.maker, g.colour, g.fabric, g.pattern].filter(Boolean).join(", ")}. Source: wardrobe record ${g.garment_id} (version ${g.version}). Ownership and availability are not stated here.` };
  }
  if (entityKind === "order") {
    const o = await first<any>(db, "SELECT order_id, version, merchant, order_number, ordered_on, updated_at FROM orders WHERE user_id = ? AND order_id = ?", userId, entityId);
    if (!o) return null;
    const lines = await all<any>(db, "SELECT product_name, product_code, size, colour, state FROM order_lines WHERE user_id = ? AND order_id = ?", userId, entityId);
    return { sourceId: `order:${o.order_id}`, sourceVersion: o.version, kind: "order", occurredAt: o.updated_at, entityId: o.order_id, body: `Purchase evidence: ${o.merchant} order ${o.order_number}${o.ordered_on ? ` placed ${o.ordered_on}` : ""}. Lines: ${lines.map((l) => `${l.product_name}${l.product_code ? ` (${l.product_code})` : ""}${l.size ? `, size ${l.size}` : ""}${l.colour ? `, ${l.colour}` : ""} - ${l.state}`).join("; ")}. An order is not an arrival. Source: order ${o.order_id}.` };
  }
  if (entityKind === "product") {
    const p = await first<any>(db, "SELECT product_id, version, name, maker, url, note, updated_at FROM products WHERE user_id = ? AND product_id = ?", userId, entityId);
    if (!p) return null;
    return { sourceId: `product:${p.product_id}`, sourceVersion: p.version, kind: "product", occurredAt: p.updated_at, entityId: p.product_id, body: `Product investigation (a shopping candidate, not owned): ${p.name}${p.maker ? ` by ${p.maker}` : ""}. ${p.note ?? ""} Source: ${p.url ?? `product ${p.product_id}`}.` };
  }
  if (entityKind === "research_note") {
    if (await forgotten(db, userId, "research_note", entityId)) return null;
    const n = await first<any>(db, "SELECT note_id, version, topic, body, claims_json, updated_at, status FROM research_notes WHERE user_id = ? AND note_id = ?", userId, entityId);
    if (!n || n.status !== "active") return null;
    return { sourceId: `research_note:${n.note_id}`, sourceVersion: n.version, kind: "research_note", occurredAt: n.updated_at, entityId: n.note_id, body: `Research note: ${n.topic}\n${n.body}\nClaims with their status and citations: ${n.claims_json}` };
  }
  if (entityKind === "memory_conclusion") {
    if (await forgotten(db, userId, "memory_conclusion", entityId)) return null;
    const m = await first<any>(db, "SELECT conclusion_id, version, kind, text, speaker, status, source_message_ids_json, updated_at FROM memory_conclusions WHERE user_id = ? AND conclusion_id = ?", userId, entityId);
    if (!m || m.status !== "active") return null;
    return { sourceId: `memory_conclusion:${m.conclusion_id}`, sourceVersion: m.version, kind: "memory_conclusion", occurredAt: m.updated_at, entityId: m.conclusion_id, body: `Remembered conclusion (${m.kind}), said by the ${m.speaker}: ${m.text}\nSource messages: ${m.source_message_ids_json}` };
  }
  if (entityKind === "comfort_feedback") {
    if (await forgotten(db, userId, "comfort_feedback", entityId)) return null;
    const f = await first<any>(db, "SELECT feedback_id, text, kind, activity, scope, status, created_at FROM comfort_feedback WHERE user_id = ? AND feedback_id = ?", userId, entityId);
    if (!f || f.status !== "active") return null;
    return { sourceId: `comfort_feedback:${f.feedback_id}`, sourceVersion: 1, kind: "comfort_feedback", occurredAt: f.created_at, entityId: f.feedback_id, body: `Comfort observation by the owner (${f.kind}): "${f.text}"${f.activity ? ` during ${f.activity}` : ""}${f.scope ? `; scope: ${f.scope}` : "; applies to that occasion only"}.` };
  }
  return null;
}

export interface SearchProjectionResult {
  uploaded: number;
  removed: number;
  pending: number;
  acknowledged: number;
  conversationPosition: number;
  skippedForBudget: boolean;
}

export async function runSearchProjection(db: Db, service: CommandService, port: SearchIndexPort, opts: { userId: string; nowMs: number; gatewayId: string; limit?: number }): Promise<SearchProjectionResult> {
  const { userId } = opts;
  const limit = opts.limit ?? 50;
  const entries = (await readOutbox(db, { topics: SEARCH_TOPICS, limit: 500 })).filter((e) => e.userId === userId).slice(0, limit);
  const state = await first<{ search_uploaded_position: number }>(db, "SELECT search_uploaded_position FROM conversation_index_state WHERE user_id = ? AND conversation_id = ?", userId, userId);
  const episodes = await all<any>(db, "SELECT message_id, position, speaker, authored_at, channel, entity_ids_json, excerpt FROM conversation_index WHERE user_id = ? AND position > ? ORDER BY position LIMIT ?", userId, state?.search_uploaded_position ?? 0, limit);
  const result: SearchProjectionResult = { uploaded: 0, removed: 0, pending: 0, acknowledged: 0, conversationPosition: state?.search_uploaded_position ?? 0, skippedForBudget: false };
  if (entries.length === 0 && episodes.length === 0) return result;

  // One bounded job-level reservation before the managed service is invoked.
  const system = await systemPrincipalFor(db, userId, "search-projection", "system");
  const reservationId = newId("rsv");
  const { settings } = await getSettings(db, system);
  const custom = (settings.extensions["assistant"] as { budgets?: Record<string, number> } | undefined)?.budgets ?? {};
  const reserved = (entries.length + episodes.length) * SEARCH_RESERVATION_PER_DOCUMENT_MICROUSD;
  try {
    await service.execute(system, {
      type: "inference.reserve",
      payload: { reservationId, runId: newId("run"), task: "semantic_indexing", budgetClass: "search", profileId: "search-embedding", attempt: 1, reservedMicroUsd: reserved, budgetDay: localDateOf(opts.nowMs, settings.timezone), dailyLimitMicroUsd: custom["search"] ?? DEFAULT_DAILY_BUDGETS.search, parent: { kind: "job", id: "search-projection" }, gatewayId: opts.gatewayId },
      idempotencyKey: `inference-reserve:${reservationId}`,
      authorization: "system_schedule",
      source: { channel: "system" },
    });
  } catch (e) {
    if (isCommandError(e) && e.code === "precondition_failed") return { ...result, skippedForBudget: true, pending: entries.length + episodes.length };
    throw e;
  }

  const done: number[] = [];
  for (const entry of entries) {
    const kind = entry.topic === "garment" ? "garment" : entry.entityKind;
    const sourceId = `${kind}:${entry.entityId}`;
    const doc = entry.topic === "search.delete" ? null : await buildSearchDocument(db, userId, kind, entry.entityId);
    if (!doc) {
      // Deleted, forgotten or no longer indexable: remove whatever the index holds for this source.
      await port.remove(kind === "message" ? `message:${entry.entityId}` : sourceId);
      result.removed++;
      done.push(entry.seq);
      continue;
    }
    let searchable = true;
    for (const part of splitDocument(doc)) {
      const r = await port.upsert(part);
      if (r.status !== "searchable") searchable = false;
    }
    if (searchable) {
      result.uploaded++;
      done.push(entry.seq);
    } else result.pending++;
  }
  if (done.length > 0) await acknowledgeOutbox(db, done, opts.nowMs);
  result.acknowledged = done.length;

  let position = result.conversationPosition;
  let contiguous = true;
  for (const e of episodes) {
    if (await forgotten(db, userId, "message", e.message_id)) {
      await port.remove(`message:${e.message_id}`);
      if (contiguous) position = e.position;
      continue;
    }
    const r = await port.upsert({
      sourceId: `message:${e.message_id}`,
      sourceVersion: 1,
      kind: "conversation_episode",
      occurredAt: e.authored_at,
      entityId: null,
      body: `Conversation message ${e.message_id}, said by the ${e.speaker} on ${e.authored_at}${e.channel ? ` via ${e.channel}` : ""}. Entities: ${e.entity_ids_json}.\n"${e.excerpt}"\nLink: garderobe://conversation/${userId}/message/${e.message_id}`,
    });
    if (r.status === "searchable") {
      result.uploaded++;
      if (contiguous) position = e.position;
    } else {
      // The watermark never passes an item that is not yet searchable.
      contiguous = false;
      result.pending++;
    }
  }
  if (position !== result.conversationPosition) {
    await prepare(db, stmt("UPDATE conversation_index_state SET search_uploaded_position = ?, updated_at = ? WHERE user_id = ? AND conversation_id = ?", position, toInstant(opts.nowMs), userId, userId)).run();
    result.conversationPosition = position;
  }
  await service.execute(system, {
    type: "inference.settle",
    payload: { reservationId, outcome: result.uploaded > 0 ? "settled" : "released", actualMicroUsd: result.uploaded * SEARCH_RESERVATION_PER_DOCUMENT_MICROUSD },
    idempotencyKey: `inference-settle:${reservationId}`,
    authorization: "system_schedule",
    source: { channel: "system" },
  });
  return result;
}
