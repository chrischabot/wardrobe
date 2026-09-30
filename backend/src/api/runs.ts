import {
  CONTRACTS_VERSION,
  type CommandReceipt,
  type ConversationMessage,
  type PendingAction,
  type RunEvent,
  type RunState,
  type RunStatus,
} from '@garderobe/contracts';
import type { Principal } from '../domain/principal.js';
import { getReceipt } from '../domain/commands/service.js';
import { parseJson } from '../domain/db.js';
import { HttpError } from './http.js';
import { now } from './services.js';

/**
 * Durable runs and their ordered, replayable event projection (spec section 13).
 *
 * A run is a `runs` row. Conversation runs project the Think turn ledger (assistant_turns) and the
 * action intents it committed; other runs (MCP recommend/research jobs) append their own events.
 * Events have per-run sequence numbers (the SSE `id`), are deduplicated by a semantic key, and are
 * retained up to RETAINED_EVENTS per run. A cursor older than the retained window gets a `snapshot`
 * event instead of a silent gap. The projection is derived state; the transcript stays in Think.
 */

export const RETAINED_EVENTS = 200;

export interface RunRow {
  user_id: string;
  run_id: string;
  kind: string;
  status: string;
  parent_ref: string | null;
  input_json: string;
  result_json: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

interface TurnRow {
  turn_id: string;
  client_turn_id: string;
  status: string;
  user_message_id: string;
  channel: string;
  result_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export function newRunId(): string {
  return `run_${crypto.randomUUID().replace(/-/g, '')}`;
}

export async function createRun(db: D1Database, userId: string, input: { runId?: string; kind: string; parentRef?: string | null; status?: RunState; input?: Record<string, unknown>; result?: Record<string, unknown> | null }): Promise<string> {
  const runId = input.runId ?? newRunId();
  const at = now();
  await db
    .prepare('INSERT INTO runs (user_id, run_id, kind, status, parent_ref, input_json, result_json, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT (user_id, run_id) DO NOTHING')
    .bind(userId, runId, input.kind, input.status ?? 'queued', input.parentRef ?? null, JSON.stringify(input.input ?? {}), input.result ? JSON.stringify(input.result) : null, at, at)
    .run();
  return runId;
}

export async function getRunRow(db: D1Database, userId: string, runId: string): Promise<RunRow | null> {
  if (!/^run_[A-Za-z0-9_-]{4,80}$/.test(runId)) return null;
  return db.prepare('SELECT * FROM runs WHERE user_id = ? AND run_id = ?').bind(userId, runId).first<RunRow>();
}

export async function runForTurn(db: D1Database, userId: string, turnId: string): Promise<RunRow | null> {
  return db.prepare("SELECT * FROM runs WHERE user_id = ? AND parent_ref = ? AND kind = 'conversation_turn'").bind(userId, turnId).first<RunRow>();
}

export async function setRunStatus(db: D1Database, userId: string, runId: string, status: RunState, result?: Record<string, unknown> | null): Promise<void> {
  const terminal = "status NOT IN ('finished', 'cancelled', 'failed')";
  if (result !== undefined) {
    await db.prepare(`UPDATE runs SET status = ?, result_json = ?, updated_at = ?, version = version + 1 WHERE user_id = ? AND run_id = ? AND ${terminal}`).bind(status, result ? JSON.stringify(result) : null, now(), userId, runId).run();
  } else {
    await db.prepare(`UPDATE runs SET status = ?, updated_at = ?, version = version + 1 WHERE user_id = ? AND run_id = ? AND ${terminal}`).bind(status, now(), userId, runId).run();
  }
}

/** Appends an event once per key; returns its sequence number. */
export async function appendEvent(db: D1Database, userId: string, runId: string, key: string, type: string, data: Record<string, unknown>): Promise<number | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await db.prepare('SELECT seq FROM run_events WHERE user_id = ? AND run_id = ? AND event_key = ?').bind(userId, runId, key).first<{ seq: number }>();
    if (existing) return existing.seq;
    const max = await db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM run_events WHERE user_id = ? AND run_id = ?').bind(userId, runId).first<{ m: number }>();
    const seq = (max?.m ?? 0) + 1;
    const res = await db
      .prepare('INSERT OR IGNORE INTO run_events (user_id, run_id, seq, event_key, type, data_json, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(userId, runId, seq, key, type, JSON.stringify(data), now())
      .run();
    if (res.meta.changes) {
      if (seq > RETAINED_EVENTS) await db.prepare('DELETE FROM run_events WHERE user_id = ? AND run_id = ? AND seq <= ?').bind(userId, runId, seq - RETAINED_EVENTS).run();
      return seq;
    }
  }
  return null;
}

function textOfResult(result: string | null): { messageId: string | null; text: string } {
  const r = parseJson<{ messageId?: string; text?: string } | null>(result, null);
  return { messageId: r?.messageId ?? null, text: r?.text ?? '' };
}

async function turnReceipts(db: D1Database, principal: Principal, turnId: string): Promise<CommandReceipt[]> {
  const { results } = await db
    .prepare("SELECT command_id FROM action_intents WHERE user_id = ? AND parent_ref = ? AND status = 'committed' AND command_id IS NOT NULL ORDER BY created_at")
    .bind(principal.userId, turnId)
    .all<{ command_id: string }>();
  const out: CommandReceipt[] = [];
  for (const r of results) {
    const receipt = await getReceipt(db, principal, r.command_id);
    if (receipt) out.push(receipt);
  }
  return out;
}

function assistantMessage(turn: TurnRow, runId: string, receipts: CommandReceipt[]): ConversationMessage | null {
  const { messageId, text } = textOfResult(turn.result_json);
  if (!messageId && turn.status !== 'cancelled' && turn.status !== 'failed') return null;
  const status: ConversationMessage['status'] = turn.status === 'completed' ? 'complete' : turn.status === 'cancelled' ? 'stopped' : turn.status === 'failed' ? 'failed' : 'streaming';
  return {
    messageId: messageId ?? `pending_${turn.turn_id}`,
    clientTurnId: null,
    role: 'assistant',
    createdAt: turn.updated_at,
    sourceChannel: turn.channel,
    status,
    parts: [...(text ? [{ type: 'text' as const, text }] : []), ...receipts.map((r) => ({ type: 'receipt' as const, commandId: r.commandId, summary: r.summary }))],
    runId,
  };
}

const TURN_STATE: Record<string, RunState> = { queued: 'queued', running: 'running', completed: 'finished', cancelled: 'cancelled', failed: 'failed', deterministic: 'finished' };

/** Brings a conversation run's events and status up to date with the durable turn ledger. */
async function syncConversationRun(db: D1Database, principal: Principal, run: RunRow): Promise<{ state: RunState; message: ConversationMessage | null; receipts: CommandReceipt[] }> {
  const turn = await db.prepare('SELECT * FROM assistant_turns WHERE user_id = ? AND turn_id = ?').bind(principal.userId, run.parent_ref).first<TurnRow>();
  if (!turn) return { state: 'failed', message: null, receipts: [] };
  const userId = principal.userId;
  const state = TURN_STATE[turn.status] ?? 'running';
  await appendEvent(db, userId, run.run_id, 'started', 'run_started', { messageId: turn.user_message_id, clientTurnId: turn.client_turn_id });
  if (state !== 'queued') await appendEvent(db, userId, run.run_id, 'activity:context', 'activity', { text: 'Reading your wardrobe, profile and today’s board' });
  const receipts = await turnReceipts(db, principal, turn.turn_id);
  for (const r of receipts) await appendEvent(db, userId, run.run_id, `receipt:${r.commandId}`, 'command_receipt', { receipt: r });
  const message = assistantMessage(turn, run.run_id, receipts);
  if (state === 'finished' || state === 'cancelled' || state === 'failed') {
    const { messageId, text } = textOfResult(turn.result_json);
    if (text && messageId) await appendEvent(db, userId, run.run_id, 'text', 'text_delta', { messageId, delta: text });
    await appendEvent(db, userId, run.run_id, 'finished', 'run_finished', { messageId, status: state, message });
  }
  if (run.status !== state) await setRunStatus(db, userId, run.run_id, state, message ? { messageId: message.messageId } : null);
  return { state, message, receipts };
}

export async function pendingActionForRun(db: D1Database, userId: string, runId: string): Promise<PendingAction | null> {
  const p = await db
    .prepare("SELECT * FROM pending_actions WHERE user_id = ? AND run_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(userId, runId)
    .first<{ pending_id: string; prompt: string; choices_json: string; status: string; expires_at: string; envelope_json: string; idempotency_key: string }>();
  if (!p) return null;
  const envelope = parseJson<{ command?: { type?: string }; operation?: { type?: string } }>(p.envelope_json, {});
  const status = p.status === 'pending' && p.expires_at <= now() ? 'expired' : p.status;
  return {
    pendingActionId: p.pending_id,
    prompt: p.prompt,
    choices: parseJson(p.choices_json, []),
    status: status as PendingAction['status'],
    expiresAt: p.expires_at,
    commandType: envelope.command?.type ?? envelope.operation?.type ?? null,
    idempotencyKey: p.idempotency_key,
  };
}

export async function runStatus(db: D1Database, principal: Principal, runId: string): Promise<RunStatus> {
  const run = await getRunRow(db, principal.userId, runId);
  if (!run) throw new HttpError(404, 'not_found', `No run ${runId}`);
  let state = run.status as RunState;
  let message: ConversationMessage | null = null;
  let receipts: CommandReceipt[] = [];
  if (run.kind === 'conversation_turn') ({ state, message, receipts } = await syncConversationRun(db, principal, run));
  else {
    const ids = parseJson<{ commandIds?: string[] }>(run.result_json, {}).commandIds ?? [];
    for (const id of ids) {
      const r = await getReceipt(db, principal, id);
      if (r) receipts.push(r);
    }
  }
  const last = await db.prepare('SELECT MAX(seq) AS m FROM run_events WHERE user_id = ? AND run_id = ?').bind(principal.userId, runId).first<{ m: number | null }>();
  const fresh = (await getRunRow(db, principal.userId, runId))!;
  return {
    schemaVersion: CONTRACTS_VERSION,
    runId,
    kind: run.kind,
    status: state,
    lastEventId: last?.m ? String(last.m) : null,
    messageId: message?.messageId ?? null,
    message,
    receipts,
    pendingAction: await pendingActionForRun(db, principal.userId, runId),
    createdAt: run.created_at,
    updatedAt: fresh.updated_at,
    result: parseJson<Record<string, unknown> | null>(fresh.result_json, null),
  };
}

export function isTerminal(state: string): boolean {
  return state === 'finished' || state === 'cancelled' || state === 'failed';
}

/**
 * Events after a cursor. When the cursor predates the retained window (or is unparseable), the
 * response starts with a snapshot of the current state so the client replaces rather than appends.
 */
export async function eventsAfter(db: D1Database, principal: Principal, runId: string, cursor: string | null): Promise<{ events: RunEvent[]; snapshot: RunEvent | null; lastSeq: number }> {
  const status = await runStatus(db, principal, runId);
  const bounds = await db.prepare('SELECT MIN(seq) AS lo, MAX(seq) AS hi FROM run_events WHERE user_id = ? AND run_id = ?').bind(principal.userId, runId).first<{ lo: number | null; hi: number | null }>();
  const lo = bounds?.lo ?? 1;
  const hi = bounds?.hi ?? 0;
  let after = 0;
  let snapshot: RunEvent | null = null;
  if (cursor !== null) {
    const n = /^\d{1,9}$/.test(cursor) ? Number(cursor) : Number.NaN;
    if (!Number.isFinite(n) || n > hi || n < lo - 1) {
      snapshot = { eventId: String(hi), runId, type: 'snapshot', at: now(), data: { message: status.message, status: status.status } };
      after = hi;
    } else after = n;
  }
  const { results } = await db
    .prepare('SELECT seq, type, data_json, at FROM run_events WHERE user_id = ? AND run_id = ? AND seq > ? ORDER BY seq')
    .bind(principal.userId, runId, after)
    .all<{ seq: number; type: string; data_json: string; at: string }>();
  return { events: results.map((r) => ({ eventId: String(r.seq), runId, type: r.type, at: r.at, data: parseJson(r.data_json, {}) })), snapshot, lastSeq: hi };
}

function sseFrame(e: RunEvent): string {
  return `id: ${e.eventId}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
}

/**
 * The SSE projection. Replays events after Last-Event-ID (or `?cursor=`), then follows the run until
 * it finishes or `maxMs` passes; the client reconnects with its last id. Heartbeat comments keep
 * intermediaries from closing an idle stream.
 */
export function sseResponse(db: D1Database, principal: Principal, runId: string, cursor: string | null, opts: { maxMs?: number; pollMs?: number } = {}): Response {
  const maxMs = opts.maxMs ?? 25_000;
  const pollMs = opts.pollMs ?? 250;
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const run = async () => {
    const started = Date.now();
    let position = cursor;
    let lastBeat = Date.now();
    try {
      await writer.write(encoder.encode('retry: 1000\n\n'));
      for (;;) {
        const { events, snapshot } = await eventsAfter(db, principal, runId, position);
        if (snapshot) await writer.write(encoder.encode(sseFrame(snapshot)));
        for (const e of events) await writer.write(encoder.encode(sseFrame(e)));
        const lastId = events.length ? events[events.length - 1]!.eventId : snapshot ? snapshot.eventId : position;
        position = lastId ?? position ?? '0';
        const finished = events.some((e) => e.type === 'run_finished') || (snapshot && isTerminal(String((snapshot.data as { status?: string }).status)));
        if (finished) break;
        if (Date.now() - started > maxMs) break;
        if (Date.now() - lastBeat > 10_000) {
          await writer.write(encoder.encode(': keep-alive\n\n'));
          lastBeat = Date.now();
        }
        await new Promise((r) => setTimeout(r, pollMs));
        // A run that is already terminal but has no finish event yet is completed on the next pass.
      }
    } catch (err) {
      console.warn('SSE stream ended', err instanceof Error ? err.message : String(err));
    } finally {
      await writer.close().catch(() => undefined);
    }
  };
  void run();
  return new Response(readable, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' } });
}
