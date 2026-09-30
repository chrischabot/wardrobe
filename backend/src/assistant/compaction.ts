import { createCompactFunction, type SessionMessage } from 'agents/sessions';
import { sha256Hex } from '../domain/hash.js';
import type { ModelService } from '../models/service.js';
import { PROMPT_VERSION } from './policy.js';

/**
 * Compaction policy (spec section 6, steps 1-5).
 *
 * - Summaries come from the application model service (task `compaction`), so every compaction is
 *   routed through AI Gateway and holds a budget reservation; an exhausted budget leaves the
 *   transcript untouched (Sessions treats a failing compaction as non-fatal).
 * - The summary is a navigation aid stored as a Session overlay; original rows are never deleted.
 * - The owner profile is not part of the message history (it is injected fresh as instructions on
 *   every turn), so compaction can never drop or rewrite it.
 * - Before activation the summary is validated: bounded size, and every Garderobe identifier it cites
 *   (g_, cmd_, ord_, prj_...) must occur in the covered messages. A checkpoint records the covered
 *   message ids, model, prompt version and summary hash; invalid summaries are recorded as rejected.
 */

export const COMPACTION_PROMPT = `You summarise an earlier part of a wardrobe conversation so the assistant can continue it.
Keep: unresolved requests, commitments made, exact garment/command/order ids, cited source links, open tool results, and the owner's latest corrections in his own words.
Do not restate the owner's profile (it is supplied separately in full), do not add advice, and do not state inventory facts as current truth: say "according to the conversation on <date>".`;

/** Begin compaction around 65% of the usable input allowance of the chat profile, leaving room for the mandatory context. */
export function compactThreshold(maxInputTokens: number, mandatoryContextTokens: number): number {
  return Math.max(8_000, Math.floor(maxInputTokens * 0.65) - mandatoryContextTokens);
}

const ID_PATTERN = /\b(?:g|cmd|ord|oln|prj|rst|brd|opt|obs)_[A-Za-z0-9]{8,}\b/g;

function messageText(m: SessionMessage): string {
  const parts = (m as unknown as { parts?: { type: string; text?: string; input?: unknown; output?: unknown }[] }).parts ?? [];
  return parts.map((p) => p.text ?? (p.input !== undefined ? JSON.stringify(p.input) : p.output !== undefined ? JSON.stringify(p.output) : '')).join('\n');
}

export function validateSummary(summary: string, covered: SessionMessage[]): string | null {
  if (!summary.trim()) return 'empty summary';
  if (summary.length > 24_000) return 'summary too long';
  const source = covered.map(messageText).join('\n');
  const invented = [...new Set(summary.match(ID_PATTERN) ?? [])].filter((id) => !source.includes(id));
  if (invented.length) return `summary cites identifiers not present in the covered messages: ${invented.join(', ')}`;
  return null;
}

export function createGarderobeCompaction(deps: { db: D1Database; userId: string; models: () => ModelService; now?: () => string; keepRecentTokens?: number }) {
  const now = deps.now ?? (() => new Date().toISOString());
  let lastModel = 'unknown';
  const base = createCompactFunction({
    keepRecentTokens: deps.keepRecentTokens ?? 8_000,
    summarize: async (prompt: string) => {
      const r = await deps.models().generate({
        task: 'compaction',
        prompt: [
          { role: 'system', content: COMPACTION_PROMPT },
          { role: 'user', content: [{ type: 'text', text: prompt }] },
        ],
        runRef: `compaction:${deps.userId}`,
        promptVersion: `${PROMPT_VERSION}/compaction`,
        dataClasses: ['conversation'],
        maxOutputTokens: 2_000,
      });
      lastModel = `${r.profileId}:${r.providerModel ?? r.apiModelId}`;
      return r.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');
    },
  });
  return async (messages: SessionMessage[]) => {
    const result = await base(messages);
    if (!result) return null;
    const from = messages.findIndex((m) => m.id === result.fromMessageId);
    const to = messages.findIndex((m) => m.id === result.toMessageId);
    const covered = from >= 0 && to >= from ? messages.slice(from, to + 1) : [];
    const problem = covered.length ? validateSummary(result.summary, covered) : 'covered range not found';
    const checkpointId = `ckp_${crypto.randomUUID().replace(/-/g, '')}`;
    const tokenEstimate = Math.ceil(covered.map(messageText).join('').length / 4);
    await deps.db
      .prepare(
        `INSERT INTO compaction_checkpoints (user_id, checkpoint_id, from_message_id, to_message_id, covered_count, token_estimate, model, prompt_version, summary_sha256, covered_ids_json, status, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        deps.userId,
        checkpointId,
        result.fromMessageId,
        result.toMessageId,
        covered.length,
        tokenEstimate,
        lastModel,
        `${PROMPT_VERSION}/compaction`,
        await sha256Hex(result.summary),
        JSON.stringify(covered.map((m) => m.id)),
        problem ? 'rejected' : 'active',
        problem,
        now(),
      )
      .run();
    return problem ? null : result;
  };
}
