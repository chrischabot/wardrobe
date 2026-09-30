import {
  CONTRACTS_VERSION,
  ConversationReference,
  TurnRequest,
  type ConversationMessage,
  type ConversationPage,
  type MessagePart,
  type TurnResponse,
} from '@garderobe/contracts';
import type { Env } from '../env.js';
import { findForgedOwnerFields, type Principal } from '../domain/principal.js';
import { DomainError } from '../domain/errors.js';
import { parseJson } from '../domain/db.js';
import { assistantFor } from '../assistant/index.js';
import { redactionNotice, type Redaction } from '../assistant/secrets.js';
import { HttpError } from './http.js';
import { createRun, runForTurn } from './runs.js';
import { now } from './services.js';

/**
 * Conversation turns and the transcript (spec section 13). Turns go into the owner's one continuous
 * Think conversation; the transcript is read from Think (canonical), with creation times and
 * channels from the D1 turn ledger and recall projection.
 */

export interface SubmitOptions {
  channel: 'conversation' | 'mcp' | 'web';
  grant: { scopes: string[]; authenticatedBy: string };
}

async function finalizedAttachments(env: Env, principal: Principal, ids: string[]): Promise<{ kind: 'image'; ref: string; mediaType: string }[]> {
  const out: { kind: 'image'; ref: string; mediaType: string }[] = [];
  for (const id of ids) {
    const row = await env.DB.prepare('SELECT upload_id, content_type, status FROM media_uploads WHERE user_id = ? AND upload_id = ?').bind(principal.userId, id).first<{ upload_id: string; content_type: string; status: string }>();
    if (!row) throw new HttpError(404, 'not_found', `No upload ${id}`);
    if (row.status !== 'finalized') throw new HttpError(422, 'upload_not_finalized', `Upload ${id} has not been finalized; complete it before attaching it`);
    out.push({ kind: 'image', ref: `upload:${row.upload_id}`, mediaType: row.content_type });
  }
  return out;
}

/** POST /v1/conversation/turns (and garderobe_ask). A repeated clientTurnId returns the existing turn. */
export async function submitTurn(env: Env, principal: Principal, raw: unknown, opts: SubmitOptions): Promise<{ response: TurnResponse; httpStatus: number }> {
  const forged = findForgedOwnerFields(raw);
  if (forged.length) throw new DomainError('forbidden_owner_field', 'Owner identity comes from the authenticated connection', { fields: forged });
  const req = TurnRequest.parse(raw);
  const attachments = await finalizedAttachments(env, principal, req.attachmentIds);
  const firstGarment = req.references.find((r) => r.kind === 'garment');
  const firstOption = req.references.find((r) => r.kind === 'option');
  const askAbout = firstOption && firstOption.kind === 'option' ? { kind: 'board_option' as const, id: firstOption.optionId } : firstGarment && firstGarment.kind === 'garment' ? { kind: 'garment' as const, id: firstGarment.garmentId } : null;
  const refNote = req.references.length
    ? `\n\n[Attached references: ${req.references.map((r) => (r.kind === 'garment' ? `garment ${r.garmentId}` : `board ${r.boardId} option ${r.optionId} (revision ${r.boardRevision})`)).join('; ')}]`
    : '';
  const text = (req.text.trim() || (attachments.length ? 'Photo attached.' : '')) + refNote;
  const captureIntent = req.intent === 'chat' ? null : req.intent;
  // A photo alone never authorizes a mutation: without an explicit log request, what_i_wore only compares.
  const grant = req.intent === 'what_i_wore' && !req.explicitLog ? { ...opts.grant, scopes: opts.grant.scopes.filter((s) => s !== 'wardrobe:write') } : opts.grant;
  const assistant = await assistantFor(env, principal);
  const input = { clientTurnId: req.clientTurnId, text, channel: opts.channel === 'web' ? ('web' as const) : opts.channel, attachments, captureIntent, askAbout, references: req.references, grant };
  const receipt = req.stopCurrent ? await assistant.stopAndSend(input) : await assistant.submitTurn(input);
  if (receipt.error) {
    const status = receipt.error.code === 'idempotency_key_reused' ? 409 : receipt.error.code === 'validation_failed' ? 422 : receipt.error.code === 'forbidden_owner_field' ? 400 : 422;
    throw new HttpError(status, receipt.error.code, receipt.error.message);
  }
  const turn = await env.DB.prepare('SELECT user_message_id FROM assistant_turns WHERE user_id = ? AND turn_id = ?').bind(principal.userId, receipt.turnId).first<{ user_message_id: string }>();
  let run = await runForTurn(env.DB, principal.userId, receipt.turnId);
  const runId = run?.run_id ?? (await createRun(env.DB, principal.userId, { kind: 'conversation_turn', parentRef: receipt.turnId, status: 'queued', input: { clientTurnId: req.clientTurnId, channel: opts.channel, ...(receipt.redacted?.length ? { redacted: receipt.redacted } : {}) } }));
  run ??= await runForTurn(env.DB, principal.userId, receipt.turnId);
  // ADV-17: a resent turn keeps the note, from the run recorded with the first submission.
  const redacted = receipt.redacted?.length ? receipt.redacted : (parseJson<{ redacted?: Redaction[] }>(run?.input_json, {}).redacted ?? []);
  return {
    response: {
      schemaVersion: CONTRACTS_VERSION,
      clientTurnId: req.clientTurnId,
      messageId: turn?.user_message_id ?? '',
      runId: run?.run_id ?? runId,
      status: receipt.existing ? 'existing' : 'accepted',
      ...(redacted.length ? { notice: { kind: 'secret_removed' as const, ...redactionNotice(redacted), redacted: redacted.map((r) => ({ kind: r.kind, count: r.count })) } } : {}),
    },
    httpStatus: receipt.existing ? 200 : 202,
  };
}

interface LedgerTurn {
  turn_id: string;
  client_turn_id: string;
  status: string;
  channel: string;
  user_message_id: string;
  result_json: string | null;
  created_at: string;
  updated_at: string;
}

function partsFor(role: string, text: string, metadata: Record<string, unknown> | null): MessagePart[] {
  const parts: MessagePart[] = [];
  if (metadata && metadata.kind === 'result_card' && metadata.card && typeof metadata.card === 'object') {
    const c = metadata.card as { kind?: string; title?: string; summary?: string; jobRef?: string };
    parts.push({ type: 'result_card', kind: String(c.kind ?? 'result'), title: String(c.title ?? ''), summary: String(c.summary ?? ''), jobRef: String(c.jobRef ?? '') });
    return parts;
  }
  if (text) parts.push({ type: 'text', text: role === 'user' ? text.replace(/\n\n\[Attached references: [^\]]*\]$/, '') : text });
  const atts = Array.isArray(metadata?.attachments) ? (metadata!.attachments as { ref?: string; mediaType?: string }[]) : [];
  for (const a of atts) {
    const m = /^upload:([a-z]{1,6}_[A-Za-z0-9_-]+)$/.exec(a.ref ?? '');
    if (m) parts.push({ type: 'attachment', uploadId: m[1]!, contentType: a.mediaType ?? 'image/jpeg', thumbnailUrl: null });
  }
  // Ask about this: the exact garment or board option the owner attached, stored with the message.
  const refs = Array.isArray(metadata?.references) ? (metadata!.references as unknown[]) : [];
  for (const r of refs) {
    const parsed = ConversationReference.safeParse(r);
    if (parsed.success) parts.push({ type: 'reference', reference: parsed.data });
  }
  return parts;
}

/** GET /v1/conversation/messages?before=&limit= or ?around=<messageId>&limit= */
export async function conversationPage(env: Env, principal: Principal, params: URLSearchParams): Promise<ConversationPage> {
  const limit = Math.min(Math.max(Number.parseInt(params.get('limit') ?? '30', 10) || 30, 1), 100);
  const before = params.get('before');
  const around = params.get('around');
  const assistant = await assistantFor(env, principal);
  const transcript = await assistant.rawTranscript(10_000);
  const { results: turns } = await env.DB.prepare('SELECT turn_id, client_turn_id, status, channel, user_message_id, result_json, created_at, updated_at FROM assistant_turns WHERE user_id = ?')
    .bind(principal.userId)
    .all<LedgerTurn>();
  const byUserMessage = new Map(turns.map((t) => [t.user_message_id, t]));
  const byReply = new Map<string, LedgerTurn>();
  for (const t of turns) {
    const r = parseJson<{ messageId?: string } | null>(t.result_json, null);
    if (r?.messageId) byReply.set(r.messageId, t);
  }
  const { results: times } = await env.DB.prepare('SELECT message_id, authored_at, channel FROM recall_messages WHERE user_id = ?').bind(principal.userId).all<{ message_id: string; authored_at: string; channel: string | null }>();
  const timeOf = new Map(times.map((t) => [t.message_id, t]));
  const runs = new Map<string, string>();
  const { results: runRows } = await env.DB.prepare("SELECT run_id, parent_ref FROM runs WHERE user_id = ? AND kind = 'conversation_turn'").bind(principal.userId).all<{ run_id: string; parent_ref: string }>();
  for (const r of runRows) runs.set(r.parent_ref, r.run_id);

  const messages: ConversationMessage[] = transcript
    .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
    .map((m) => {
      const meta = (m.metadata && typeof m.metadata === 'object' ? m.metadata : null) as Record<string, unknown> | null;
      const turn = byUserMessage.get(m.id) ?? byReply.get(m.id) ?? null;
      const rec = timeOf.get(m.id);
      const status: ConversationMessage['status'] =
        m.role === 'assistant' && turn ? (turn.status === 'cancelled' ? 'stopped' : turn.status === 'failed' ? 'failed' : turn.status === 'completed' ? 'complete' : 'streaming') : 'complete';
      return {
        messageId: m.id,
        clientTurnId: m.role === 'user' ? (turn?.client_turn_id ?? (typeof meta?.clientTurnId === 'string' ? meta.clientTurnId : null)) : null,
        role: m.role as ConversationMessage['role'],
        createdAt: rec?.authored_at ?? (m.role === 'user' ? turn?.created_at : turn?.updated_at) ?? now(),
        sourceChannel: (typeof meta?.sourceChannel === 'string' ? meta.sourceChannel : null) ?? rec?.channel ?? turn?.channel ?? (meta?.kind === 'result_card' ? 'system' : 'conversation'),
        status,
        parts: partsFor(m.role, m.text, meta),
        runId: turn ? (runs.get(turn.turn_id) ?? null) : null,
      };
    });

  let end = messages.length;
  let start: number;
  let after: string | null = null;
  if (around) {
    const idx = messages.findIndex((m) => m.messageId === around);
    if (idx < 0) throw new HttpError(404, 'not_found', `No message ${around}`);
    start = Math.max(0, idx - Math.floor(limit / 2));
    end = Math.min(messages.length, start + limit);
    after = end < messages.length ? messages[end - 1]!.messageId : null;
  } else {
    if (before) {
      const idx = messages.findIndex((m) => m.messageId === before);
      if (idx < 0) throw new HttpError(404, 'not_found', `No message ${before}`);
      end = idx;
    }
    start = Math.max(0, end - limit);
  }
  const page = messages.slice(start, end);
  const active = turns.filter((t) => t.status === 'queued' || t.status === 'running').sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  return {
    schemaVersion: CONTRACTS_VERSION,
    messages: page,
    before: start > 0 ? page[0]!.messageId : null,
    hasMore: start > 0,
    after,
    activeRunId: active ? (runs.get(active.turn_id) ?? null) : null,
  };
}
