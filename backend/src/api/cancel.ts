import { CONTRACTS_VERSION, type CancelRunResponse } from '@garderobe/contracts';
import type { Env } from '../env.js';
import type { Principal } from '../domain/principal.js';
import { assistantFor } from '../assistant/index.js';
import { HttpError } from './http.js';
import { appendEvent, getRunRow, isTerminal, runStatus, setRunStatus } from './runs.js';
import { answerRun } from '../mcp/pending.js';

/**
 * POST /v1/runs/{id}/cancel and garderobe_run cancel: stop remaining work. Effects that already
 * committed stay committed and are reported (undo is a separate compensating command).
 */
export async function cancelRun(env: Env, ctx: ExecutionContext | undefined, principal: Principal, runId: string): Promise<CancelRunResponse> {
  const run = await getRunRow(env.DB, principal.userId, runId);
  if (!run) throw new HttpError(404, 'not_found', `No run ${runId}`);
  const before = await runStatus(env.DB, principal, runId);
  if (isTerminal(before.status)) {
    return { schemaVersion: CONTRACTS_VERSION, runId, status: before.status, committedEffects: (before.receipts ?? []).map((r) => ({ operation: r.commandType, commandId: r.commandId })), stopped: [] };
  }
  if (run.kind === 'conversation_turn') {
    const stopped = await (await assistantFor(env, principal)).stop('cancelled by owner');
    const after = await runStatus(env.DB, principal, runId);
    return {
      schemaVersion: CONTRACTS_VERSION,
      runId,
      status: after.status,
      committedEffects: stopped.committedEffects.filter((e) => e.turnId === run.parent_ref).map((e) => ({ operation: e.operation, commandId: e.commandId })),
      stopped: stopped.cancelledTurns.includes(run.parent_ref ?? '') ? ['assistant reply'] : [],
    };
  }
  if (run.kind === 'command_confirmation') {
    await answerRun(env, ctx, principal, runId, null);
    const after = await runStatus(env.DB, principal, runId);
    return { schemaVersion: CONTRACTS_VERSION, runId, status: after.status, committedEffects: (after.receipts ?? []).map((r) => ({ operation: r.commandType, commandId: r.commandId })), stopped: after.status === 'cancelled' ? ['pending confirmation'] : [] };
  }
  await appendEvent(env.DB, principal.userId, runId, 'finished', 'run_finished', { messageId: null, status: 'cancelled', message: null });
  await setRunStatus(env.DB, principal.userId, runId, 'cancelled');
  const after = await runStatus(env.DB, principal, runId);
  return { schemaVersion: CONTRACTS_VERSION, runId, status: after.status, committedEffects: [], stopped: ['remaining work'] };
}
