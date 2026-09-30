import { COMMAND_CLASS, CommandEnvelope, type CommandReceipt, type CommandType, type OperationReceipt } from '@garderobe/contracts';
import { canonicalJson, sha256Hex } from '../domain/hash.js';
import { parseJson } from '../domain/db.js';
import type { Principal } from '../domain/principal.js';
import type { Env } from '../env.js';
import { signState, verifyState } from '../auth/jose.js';
import { executeCommand } from '../api/operations.js';
import { appendEvent, createRun, setRunStatus } from '../api/runs.js';
import { getRunRow } from '../api/runs.js';
import { HttpError } from '../api/http.js';
import { now } from '../api/services.js';
import { getBoard } from '../domain/boards.js';
import { runAccountOperation, type AccountOperation } from '../api/portability.js';

/** An account operation (export, import, recovery kit) waiting for the owner's confirmation. */
export interface OperationEnvelope {
  idempotencyKey: string;
  operation: AccountOperation;
}
type PendingEnvelope = CommandEnvelope | OperationEnvelope;
const isOperationEnvelope = (e: PendingEnvelope): e is OperationEnvelope => 'operation' in e && !!(e as OperationEnvelope).operation;

/**
 * Durable pending actions (spec section 13, "MCP 0728 protocol contract"): one record per request for
 * owner input, answered either by an MCP `input_required` retry or natively (app/web). The stored
 * envelope (idempotency key, expected versions) is what executes; the answer can only fill the
 * question asked. A retry with an altered request, an expired record or a repeated answer never
 * duplicates an effect: resolution is recorded once and later retries return the same receipt.
 */

export const PENDING_TTL_MS = 10 * 60_000;

/** Commands that ask the owner to confirm before an MCP client executes them. */
export const CONFIRM_COMMANDS: ReadonlySet<CommandType> = new Set<CommandType>(['dispose_item', 'lift_restriction', 'edit_style_profile', 'undo', 'reconcile_quantity', 'advance_lifecycle_project']);

export interface InputQuestion {
  kind: 'confirm' | 'choose_footwear';
  prompt: string;
  choices: { id: string; label: string }[];
}

export interface PendingRow {
  user_id: string;
  pending_id: string;
  run_id: string | null;
  surface: string;
  kind: string;
  prompt: string;
  choices_json: string;
  envelope_json: string;
  request_hash: string;
  idempotency_key: string;
  status: 'pending' | 'resolved' | 'expired' | 'cancelled';
  response_json: string | null;
  command_id: string | null;
  expires_at: string;
  created_at: string;
}

function describeCommand(c: { type: string } & Record<string, unknown>): string {
  return c.type.replace(/_/g, ' ');
}

/** Whether an MCP command needs owner input first, and what to ask. */
export async function questionFor(env: Env, principal: Principal, envelope: CommandEnvelope): Promise<InputQuestion | null> {
  const c = envelope.command;
  if (c.type === 'select_option' && !c.footwearGarmentId) {
    let board;
    try {
      board = await getBoard(env.DB, principal, c.boardId);
    } catch {
      return null; // the command service reports the missing board
    }
    const option = board.options.find((o) => o.optionId === c.optionId);
    const shoes = option?.slots.filter((s) => s.role === 'footwear') ?? [];
    if (shoes.length > 1) {
      const names = new Map<string, string>();
      for (const o of board.document?.options ?? []) for (const g of o.garments) names.set(g.garmentId, g.name);
      return { kind: 'choose_footwear', prompt: 'This outfit has two shoes. Which will you wear?', choices: shoes.map((s) => ({ id: s.garmentId, label: names.get(s.garmentId) ?? s.garmentId })) };
    }
    return null;
  }
  if (CONFIRM_COMMANDS.has(c.type)) {
    return { kind: 'confirm', prompt: `Confirm: ${describeCommand(c as never)} in Garderobe? This is recorded with a receipt${COMMAND_CLASS[c.type] === 'compensation' ? '' : ' and can be undone where the change allows it'}.`, choices: [{ id: 'confirm', label: 'Yes, do it' }, { id: 'decline', label: 'No' }] };
  }
  return null;
}

export async function requestHash(args: unknown): Promise<string> {
  return sha256Hex(canonicalJson(args));
}

/** Creates (or finds) the pending record for this command identity and returns it with its signed state. */
export async function openPending(env: Env, principal: Principal, input: { envelope: PendingEnvelope; question: InputQuestion; surface: 'mcp' | 'app' | 'web'; args: unknown; grantRef: string | null; secret: string }): Promise<{ row: PendingRow; state: string }> {
  const hash = await requestHash(input.args);
  const userId = principal.userId;
  const existing = await env.DB.prepare('SELECT * FROM pending_actions WHERE user_id = ? AND idempotency_key = ? AND kind = ?').bind(userId, input.envelope.idempotencyKey, input.question.kind).first<PendingRow>();
  let row = existing;
  if (row && row.request_hash !== hash) throw new HttpError(409, 'idempotency_key_reused', 'This idempotency key is already waiting for input on a different request');
  if (!row) {
    const pendingId = `pnd_${crypto.randomUUID().replace(/-/g, '')}`;
    const runId = await createRun(env.DB, userId, {
      kind: 'command_confirmation',
      status: 'input_required',
      input: { idempotencyKey: input.envelope.idempotencyKey, commandType: isOperationEnvelope(input.envelope) ? input.envelope.operation.type : input.envelope.command.type },
    });
    const at = now();
    await env.DB.prepare(
      `INSERT INTO pending_actions (user_id, pending_id, run_id, surface, kind, prompt, choices_json, envelope_json, request_hash, idempotency_key, grant_ref, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT (user_id, idempotency_key, kind) DO NOTHING`,
    )
      .bind(userId, pendingId, runId, input.surface, input.question.kind, input.question.prompt, JSON.stringify(input.question.choices), JSON.stringify(input.envelope), hash, input.envelope.idempotencyKey, input.grantRef, new Date(Date.parse(at) + PENDING_TTL_MS).toISOString(), at)
      .run();
    row = await env.DB.prepare('SELECT * FROM pending_actions WHERE user_id = ? AND idempotency_key = ? AND kind = ?').bind(userId, input.envelope.idempotencyKey, input.question.kind).first<PendingRow>();
    if (!row) throw new Error('pending action not recorded');
    if (row.request_hash !== hash) throw new HttpError(409, 'idempotency_key_reused', 'This idempotency key is already waiting for input on a different request');
    if (row.run_id) await appendEvent(env.DB, userId, row.run_id, `needs_input:${row.pending_id}`, 'needs_input', { prompt: row.prompt, choices: input.question.choices, pendingActionId: row.pending_id });
  }
  const state = await signState(input.secret, { p: row.pending_id, u: userId, h: hash, exp: Date.parse(row.expires_at) });
  return { row, state };
}

export async function verifyPendingState(env: Env, principal: Principal, secret: string, state: string, args: unknown, grantRef: string | null = null): Promise<PendingRow | { error: string; message: string }> {
  const s = await verifyState<{ p: string; u: string; h: string; exp: number }>(secret, state);
  if (!s) return { error: 'invalid_request_state', message: 'The request state is invalid; start the command again.' };
  if (s.u !== principal.userId) return { error: 'invalid_request_state', message: 'The request state belongs to another connection.' };
  if (s.h !== (await requestHash(args))) return { error: 'request_altered', message: 'The retried request differs from the one that asked for input; nothing was changed.' };
  const row = await env.DB.prepare('SELECT * FROM pending_actions WHERE user_id = ? AND pending_id = ?').bind(principal.userId, s.p).first<PendingRow & { grant_ref: string | null }>();
  if (!row) return { error: 'invalid_request_state', message: 'No such pending action.' };
  // An account operation (export, import, recovery) is answered only by the connection that asked (or natively in Garderobe).
  if (grantRef && row.grant_ref && row.grant_ref !== grantRef && isOperationEnvelope(parseJson<PendingEnvelope>(row.envelope_json, {} as never))) {
    return { error: 'invalid_request_state', message: 'The request state belongs to another connection.' };
  }
  return row;
}

export type PendingOutcome =
  | { status: 'executed'; receipt: CommandReceipt | null; operation: OperationReceipt | null; pendingId: string; runId: string | null }
  | { status: 'declined'; pendingId: string; runId: string | null }
  | { status: 'expired'; pendingId: string; runId: string | null }
  | { status: 'invalid_choice'; pendingId: string; runId: string | null; message: string };

async function executeAccountOperation(env: Env, principal: Principal, row: PendingRow & { grant_ref?: string | null }, envelope: OperationEnvelope): Promise<OperationReceipt> {
  const surface = row.surface === 'mcp' ? 'mcp' : row.surface === 'web' ? 'web' : 'app';
  return runAccountOperation(env, principal, envelope.operation, envelope.idempotencyKey, { surface, grantRef: row.grant_ref ?? null });
}

/**
 * Resolves a pending action exactly once. A resolved record returns its stored receipt (the command
 * service replays it by idempotency key); a later, different answer changes nothing.
 */
export async function resolvePending(env: Env, ctx: ExecutionContext | undefined, principal: Principal, row: PendingRow, choiceId: string | null): Promise<PendingOutcome> {
  const base = { pendingId: row.pending_id, runId: row.run_id };
  const stored = parseJson<PendingEnvelope>(row.envelope_json, null as unknown as PendingEnvelope);
  if (isOperationEnvelope(stored)) return resolveOperation(env, principal, row, stored, choiceId);
  const envelope = stored;
  if (row.status === 'resolved') {
    const receipt = await executeCommand(env, ctx, principal, parseJson(row.response_json, { envelope }).envelope ?? envelope, (row.surface === 'mcp' ? 'mcp' : row.surface === 'web' ? 'web' : 'app') as never);
    return { status: 'executed', receipt, operation: null, ...base };
  }
  if (row.status === 'cancelled') return { status: 'declined', ...base };
  if (row.status === 'expired' || row.expires_at <= now()) {
    await env.DB.prepare("UPDATE pending_actions SET status = 'expired' WHERE user_id = ? AND pending_id = ? AND status = 'pending'").bind(principal.userId, row.pending_id).run();
    if (row.run_id) {
      await appendEvent(env.DB, principal.userId, row.run_id, 'finished', 'run_finished', { messageId: null, status: 'cancelled', message: null });
      await setRunStatus(env.DB, principal.userId, row.run_id, 'cancelled', { reason: 'expired' });
    }
    return { status: 'expired', ...base };
  }
  const choices = parseJson<{ id: string }[]>(row.choices_json, []);
  if (row.kind === 'confirm' && choiceId === 'decline') choiceId = null;
  if (choiceId === null) {
    const r = await env.DB.prepare("UPDATE pending_actions SET status = 'cancelled', resolved_at = ? WHERE user_id = ? AND pending_id = ? AND status = 'pending'").bind(now(), principal.userId, row.pending_id).run();
    if (!r.meta.changes) return resolvePending(env, ctx, principal, (await reload(env, principal, row.pending_id))!, choiceId);
    if (row.run_id) {
      await appendEvent(env.DB, principal.userId, row.run_id, 'finished', 'run_finished', { messageId: null, status: 'cancelled', message: null });
      await setRunStatus(env.DB, principal.userId, row.run_id, 'cancelled', { reason: 'declined' });
    }
    return { status: 'declined', ...base };
  }
  if (!choices.some((c) => c.id === choiceId)) return { status: 'invalid_choice', message: `Choose one of: ${choices.map((c) => c.id).join(', ')}`, ...base };
  const finalEnvelope: CommandEnvelope = row.kind === 'choose_footwear' && envelope.command.type === 'select_option' ? { ...envelope, command: { ...envelope.command, footwearGarmentId: choiceId } } : envelope;
  // Claim the record before executing so a concurrent answer cannot run a second, different command.
  const claim = await env.DB.prepare("UPDATE pending_actions SET status = 'resolved', response_json = ?, resolved_at = ? WHERE user_id = ? AND pending_id = ? AND status = 'pending'")
    .bind(JSON.stringify({ choiceId, envelope: finalEnvelope }), now(), principal.userId, row.pending_id)
    .run();
  if (!claim.meta.changes) return resolvePending(env, ctx, principal, (await reload(env, principal, row.pending_id))!, choiceId);
  const surface = row.surface === 'mcp' ? 'mcp' : row.surface === 'web' ? 'web' : 'app';
  const receipt = await executeCommand(env, ctx, principal, finalEnvelope, surface);
  await env.DB.prepare('UPDATE pending_actions SET command_id = ? WHERE user_id = ? AND pending_id = ?').bind(receipt.commandId, principal.userId, row.pending_id).run();
  if (row.run_id) {
    await appendEvent(env.DB, principal.userId, row.run_id, `receipt:${receipt.commandId}`, 'command_receipt', { receipt });
    await appendEvent(env.DB, principal.userId, row.run_id, 'finished', 'run_finished', { messageId: null, status: receipt.outcome === 'committed' || receipt.outcome === 'merged' ? 'finished' : 'failed', message: null });
    await setRunStatus(env.DB, principal.userId, row.run_id, receipt.outcome === 'committed' || receipt.outcome === 'merged' ? 'finished' : 'failed', { commandIds: [receipt.commandId] });
  }
  return { status: 'executed', receipt, operation: null, ...base };
}

async function closeRun(env: Env, principal: Principal, runId: string | null, status: 'cancelled' | 'finished' | 'failed', reason: Record<string, unknown>): Promise<void> {
  if (!runId) return;
  await appendEvent(env.DB, principal.userId, runId, 'finished', 'run_finished', { messageId: null, status, message: null });
  await setRunStatus(env.DB, principal.userId, runId, status, reason);
}

/**
 * The same once-only resolution for an account operation. Run events and the run result carry only
 * the operation type and its outcome, never an export, a link or a recovery code.
 */
async function resolveOperation(env: Env, principal: Principal, row: PendingRow, envelope: OperationEnvelope, choiceId: string | null): Promise<PendingOutcome> {
  const base = { pendingId: row.pending_id, runId: row.run_id };
  if (row.status === 'resolved') {
    const operation = await executeAccountOperation(env, principal, row, envelope);
    return { status: 'executed', receipt: null, operation, ...base };
  }
  if (row.status === 'cancelled') return { status: 'declined', ...base };
  if (row.status === 'expired' || row.expires_at <= now()) {
    const r = await env.DB.prepare("UPDATE pending_actions SET status = 'expired' WHERE user_id = ? AND pending_id = ? AND status = 'pending'").bind(principal.userId, row.pending_id).run();
    if (r.meta.changes) await closeRun(env, principal, row.run_id, 'cancelled', { reason: 'expired' });
    return { status: 'expired', ...base };
  }
  if (choiceId === 'decline') choiceId = null;
  if (choiceId === null) {
    const r = await env.DB.prepare("UPDATE pending_actions SET status = 'cancelled', resolved_at = ? WHERE user_id = ? AND pending_id = ? AND status = 'pending'").bind(now(), principal.userId, row.pending_id).run();
    if (!r.meta.changes) return resolvePending(env, undefined, principal, (await reload(env, principal, row.pending_id))!, choiceId);
    await closeRun(env, principal, row.run_id, 'cancelled', { reason: 'declined', operation: envelope.operation.type });
    return { status: 'declined', ...base };
  }
  if (choiceId !== 'confirm') return { status: 'invalid_choice', message: 'Choose one of: confirm, decline', ...base };
  const claim = await env.DB.prepare("UPDATE pending_actions SET status = 'resolved', response_json = ?, resolved_at = ? WHERE user_id = ? AND pending_id = ? AND status = 'pending'")
    .bind(JSON.stringify({ choiceId, operation: envelope.operation.type }), now(), principal.userId, row.pending_id)
    .run();
  if (!claim.meta.changes) return resolvePending(env, undefined, principal, (await reload(env, principal, row.pending_id))!, choiceId);
  try {
    const operation = await executeAccountOperation(env, principal, row, envelope);
    await closeRun(env, principal, row.run_id, 'finished', { operation: envelope.operation.type, outcome: 'executed' });
    return { status: 'executed', receipt: null, operation, ...base };
  } catch (err) {
    await closeRun(env, principal, row.run_id, 'failed', { operation: envelope.operation.type, outcome: 'refused', code: err instanceof HttpError ? err.code : err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'error' });
    throw err;
  }
}

async function reload(env: Env, principal: Principal, pendingId: string): Promise<PendingRow | null> {
  return env.DB.prepare('SELECT * FROM pending_actions WHERE user_id = ? AND pending_id = ?').bind(principal.userId, pendingId).first<PendingRow>();
}

/** Native answer (app/web, or garderobe_run respond): the same record an MCP retry resolves. */
export async function answerRun(env: Env, ctx: ExecutionContext | undefined, principal: Principal, runId: string, choiceId: string | null): Promise<PendingOutcome> {
  const run = await getRunRow(env.DB, principal.userId, runId);
  if (!run) throw new HttpError(404, 'not_found', `No run ${runId}`);
  const row = await env.DB.prepare('SELECT * FROM pending_actions WHERE user_id = ? AND run_id = ? ORDER BY created_at DESC LIMIT 1').bind(principal.userId, runId).first<PendingRow>();
  if (!row) throw new HttpError(409, 'invalid_state', 'This run is not waiting for input');
  return resolvePending(env, ctx, principal, row, choiceId);
}
