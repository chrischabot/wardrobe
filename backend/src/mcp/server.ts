import { acceptedContent, createMcpHandler, inputRequired, inputResponse, isLegacyRequest, McpServer, type CallToolResult, type ServerContext } from '@modelcontextprotocol/server';
import { CONTRACTS_VERSION, type CommandEnvelope, type CommandReceipt, DomainCommand, type RunStatus as RunStatusShape } from '@garderobe/contracts';
import type { Env } from '../env.js';
import { hasScope, ownerPrincipal, SCOPE_READ, SCOPE_WRITE, type Principal } from '../domain/principal.js';
import { DomainError } from '../domain/errors.js';
import { listDailyWears, resolveAlias } from '../domain/queries.js';
import { sha256Hex } from '../domain/hash.js';
import { assistantFor } from '../assistant/index.js';
import { createModelService } from '../assistant/runtime.js';
import { createResearchService } from '../research/index.js';
import { listStyleDocuments } from '../domain/style.js';
import { checkGrant, touchGrant, type GrantProps, type GrantRow } from '../auth/grants.js';
import { mcpOrigin, stateSecret } from '../auth/oauth.js';
import { apiError, errorResponse, HttpError } from '../api/http.js';
import { buildToday } from '../api/today.js';
import { itemDetail, wardrobePage } from '../api/wardrobe.js';
import { executeCommand, recommend } from '../api/operations.js';
import { submitTurn } from '../api/conversation.js';
import { isTerminal, pendingActionForRun, runStatus } from '../api/runs.js';
import { cancelRun } from '../api/cancel.js';
import { afterCommit, now } from '../api/services.js';
import { listCombinations, listComfort, listOrders, listProjects, listReturnDeadlines, listTrips, pauseState, runOperation, tripDetail, type TripOperation } from '../api/surface.js';
import { answerRun, openPending, questionFor, requestHash, resolvePending, verifyPendingState, type OperationEnvelope, type PendingOutcome } from './pending.js';
import { accountQuestion, accountTransfers, isAccountOperation, recoveryStatus, stagedPackage, withDeliveryLinks, type AccountOperation } from '../api/portability.js';
import {
  AskInput,
  AskOutput,
  CommandToolInput,
  CommandToolOutput,
  InventoryInput,
  InventoryOutput,
  RecommendOutput,
  RecommendToolInput,
  ResearchInput,
  ResearchOutput,
  RunInput,
  RunOutput,
  TodayInput,
  TodayOutput,
} from './schemas.js';

/**
 * The Garderobe MCP server (spec section 13) on @modelcontextprotocol/server 2.2.0: seven complete
 * operations over the same services as the native API. The owner and scopes come only from the
 * authenticated grant; nothing in a tool argument can name another owner. Served per request by
 * `createMcpHandler` for protocol revision 2026-07-28 (header/body routing checks by the SDK), with
 * the SDK's stateless 2025-era fallback as the 2025-11-25 compatibility adapter.
 */

export const MCP_SERVER_INFO = { name: 'garderobe', title: 'Garderobe', version: '1.0.0' } as const;
export const MODERN_PROTOCOL = '2026-07-28';
export const LEGACY_PROTOCOL = '2025-11-25';

export interface McpSession {
  principal: Principal;
  grant: GrantRow;
  origin: string;
  /** The protocol era of this request: 2026-07-28 (input_required retries) or the stateless 2025-11-25 adapter. */
  era?: 'modern' | 'legacy';
}

function result(structured: Record<string, unknown>, text: string): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function toolError(err: unknown): CallToolResult {
  const code = err instanceof DomainError ? err.code : err instanceof HttpError ? err.code : 'error';
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: 'text', text: `${code}: ${message}` }] };
}

async function guarded<T>(fn: () => Promise<T>): Promise<T | CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Error && err.name === 'ZodError') return toolError(new HttpError(422, 'validation_failed', err.message));
    return toolError(err);
  }
}

function conversationHandle(userId: string): Promise<string> {
  return sha256Hex(`conversation:${userId}`).then((h) => `cnv_${h.slice(0, 24)}`);
}

function summarizeReceipt(r: CommandReceipt): string {
  return `${r.outcome}${r.replayed ? ' (replayed)' : ''}: ${r.summary}${r.error ? ` [${r.error.code}: ${r.error.message}]` : ''}`;
}

/** The text of a finished run's reply (conversation turns and research topics). */
function runAnswerText(status: RunStatusShape): string | null {
  return status.message?.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n') || null;
}

/** The explicit next step for a run still in progress: which tool to call, with which arguments. */
export function followRun(runId: string): { tool: 'garderobe_run'; arguments: { runId: string; action: 'status' }; instruction: string } {
  return {
    tool: 'garderobe_run',
    arguments: { runId, action: 'status' },
    instruction: `The answer is not ready yet. Call garderobe_run with {"runId":"${runId}","action":"status"} in about 10 seconds; when its status is "finished" the answer is in its text and in message. Repeat while the status is "queued" or "running".`,
  };
}

export function buildMcpServer(env: Env, ctx: ExecutionContext | undefined, session: McpSession): McpServer {
  const { principal, origin } = session;
  const canWrite = hasScope(principal, SCOPE_WRITE);

  /** Polls a run until it settles or the budget runs out (the call's own time, not a background job). */
  async function awaitRun(runId: string, waitSeconds: number): Promise<RunStatusShape> {
    const deadline = Date.now() + waitSeconds * 1000;
    let status = await runStatus(env.DB, principal, runId);
    while (!isTerminal(status.status) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      status = await runStatus(env.DB, principal, runId);
    }
    return status;
  }
  const server = new McpServer(MCP_SERVER_INFO, {
    capabilities: { tools: {}, resources: {} },
    instructions:
      'Garderobe is the owner’s wardrobe companion. garderobe_today returns the prepared board (the same revision the Garderobe app shows). Use garderobe_command for changes; every change returns a verified receipt. Receipts, not prose, say what changed.' +
      (canWrite ? '' : ' This connection is read-only: commands come back as proposals the owner confirms in Garderobe.'),
  });

  server.registerTool(
    'garderobe_today',
    {
      title: 'Today’s outfits',
      description: 'The prepared board for a day: three to five validated outfits with the day line, weather, calendar status, the current selection and today’s recorded wears. The same revision the Garderobe app shows. Reading never recomposes the board.',
      inputSchema: TodayInput,
      outputSchema: TodayOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      guarded(async () => {
        const today = await buildToday(env, principal, { date: args.date, origin });
        const text = today.board?.document?.text ?? (today.board ? `Board revision ${today.board.currentRevision} for ${today.date}.` : `No board has been prepared for ${today.date} yet.`);
        return result(today as never, text);
      }),
  );

  server.registerTool(
    'garderobe_inventory',
    {
      title: 'Wardrobe inventory',
      description: 'Read garments, availability, facts, restrictions, recorded wears and receipts, or the complete inventory snapshot. Every page states whether it is complete and when it was read. Zero recorded wears means not recorded, not unworn.',
      inputSchema: InventoryInput,
      outputSchema: InventoryOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      guarded(async () => {
        const base = { schemaVersion: CONTRACTS_VERSION, view: args.view, asOf: now(), complete: true, total: 0, nextCursor: null as string | null, counts: null as never, items: [] as never[], item: null as never, wears: [] as never[], resolution: null as never, sources: [{ source: 'wardrobe', observedAt: now() }] };
        if (args.view === 'items' || args.view === 'snapshot') {
          const query = { q: args.q, category: args.category as never, availability: args.availability, cursor: args.view === 'snapshot' ? undefined : args.cursor, limit: args.view === 'snapshot' ? 500 : args.limit };
          const page = await wardrobePage(env, principal, query, origin);
          const items = [...page.items];
          let next = page.nextCursor;
          while (args.view === 'snapshot' && next) {
            const more = await wardrobePage(env, principal, { ...query, cursor: next }, origin);
            items.push(...more.items);
            next = more.nextCursor;
          }
          const out = { ...base, asOf: page.asOf, complete: args.view === 'snapshot' ? true : page.complete, total: page.total, nextCursor: args.view === 'snapshot' ? null : page.nextCursor, counts: page.counts, items };
          return result(out as never, `${items.length} of ${page.total} garments${out.complete ? ' (complete)' : ' (partial; continue with nextCursor)'}: ${items.slice(0, 40).map((i) => i.garment.name).join('; ')}${items.length > 40 ? '; …' : ''}`);
        }
        if (args.view === 'item') {
          if (!args.garmentId) throw new HttpError(422, 'validation_failed', 'garmentId is required for view=item');
          const item = await itemDetail(env, principal, args.garmentId, origin);
          return result({ ...base, total: 1, item } as never, `${item.item.garment.name}: ${item.item.availability.label}; ${item.item.recordedWearCount} recorded wears.`);
        }
        if (args.view === 'history') {
          const wears = await listDailyWears(env.DB, principal, { garmentId: args.garmentId, from: args.from, to: args.to });
          return result({ ...base, total: wears.length, wears } as never, `${wears.length} recorded wears.`);
        }
        const recordsView = async (records: Record<string, unknown>[], text: string) => result({ ...base, total: records.length, records } as never, text);
        switch (args.view) {
          case 'trips': {
            const t = await listTrips(env, principal);
            return recordsView(t.trips as never, `${t.trips.length} trips: ${t.trips.map((x) => `${x.name} (${x.status}, ${x.departsOn}–${x.returnsOn})`).join('; ')}`);
          }
          case 'trip': {
            if (!args.tripId) throw new HttpError(422, 'validation_failed', 'tripId is required for view=trip');
            const t = await tripDetail(env, principal, args.tripId);
            return recordsView([t as never], `${t.trip.name}: ${t.trip.status}; ${t.items.filter((i) => i.packedQty > i.unpackedQty).length} pieces in the suitcase.`);
          }
          case 'orders': {
            const o = await listOrders(env, principal);
            return recordsView(o.orders as never, `${o.orders.length} orders.`);
          }
          case 'returns': {
            const d = await listReturnDeadlines(env, principal, new URLSearchParams());
            return recordsView(d.deadlines as never, d.deadlines.length ? d.deadlines.map((x) => `${x.description} (${x.merchant}): ${x.kind} by ${x.deadlineAt}`).join('; ') : 'No open return deadlines.');
          }
          case 'projects': {
            const p = await listProjects(env, principal);
            return recordsView(p as never, `${p.length} lifecycle projects.`);
          }
          case 'combinations': {
            const c = await listCombinations(env, principal, new URLSearchParams());
            return recordsView(c.combinations as never, `${c.combinations.length} saved combinations and plans.`);
          }
          case 'comfort': {
            const c = await listComfort(env, principal, new URLSearchParams(args.garmentId ? { garmentId: args.garmentId } : {}));
            return recordsView(c.feedback as never, `${c.feedback.length} comfort reports.`);
          }
          case 'pause': {
            const p = await pauseState(env, principal);
            return recordsView([p as never], p.paused ? `Paused from ${p.current!.startsOn}${p.current!.resumeOn ? ` until ${p.current!.resumeOn}` : ''}.` : 'Garderobe is not paused.');
          }
          case 'recovery': {
            const s = await recoveryStatus(env, principal);
            return recordsView([s as never], `${s.hasActiveKit ? `A recovery code is set up (issued ${s.activeKitIssuedAt}).` : 'No recovery code is set up.'}${s.pendingCollection ? ` A new code is waiting to be collected in Garderobe until ${s.pendingCollection.expiresAt}.` : ''} Codes are never shown here.`);
          }
          case 'transfers': {
            const t = await accountTransfers(env, principal);
            const staged = t.transfers.filter((x) => x.kind === 'import_package' && x.status === 'staged');
            return recordsView(
              [...t.transfers.map((x) => ({ recordType: 'transfer', ...x })), ...t.audit.map((x) => ({ recordType: 'audit', ...x }))] as never,
              `${t.transfers.length} exports, import packages and recovery links; ${staged.length ? `staged for import: ${staged.map((x) => x.transferId).join(', ')}` : 'no import package is staged'}.`,
            );
          }
          default:
            break;
        }
        if (!args.phrase) throw new HttpError(422, 'validation_failed', 'phrase is required for view=resolve');
        const resolution = await resolveAlias(env.DB, principal, args.phrase);
        return result({ ...base, total: resolution.status === 'resolved' ? 1 : resolution.status === 'ambiguous' ? resolution.candidates.length : 0, resolution } as never, JSON.stringify(resolution));
      }),
  );

  server.registerTool(
    'garderobe_recommend',
    {
      title: 'Recommend outfits',
      description: 'Compose validated outfits for a date with an optional brief, occasion, count and pieces to include or exclude. Every option passes the same checks as the morning board (availability, weather, the owner’s hard rules). It previews; it does not replace the prepared board. May fetch the public weather forecast.',
      inputSchema: RecommendToolInput,
      outputSchema: RecommendOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      guarded(async () => {
        const r = await recommend(env, principal, args);
        return result(r as never, r.document.text);
      }),
  );

  server.registerTool(
    'garderobe_command',
    {
      title: 'Change the wardrobe',
      description:
        'Execute one typed Garderobe command (record_wear, mark_in_wash, laundry_collected, select_option, mark_arrived, set_restriction, pause_service, resume_service, …) and return the verified receipt with affected versions, or a service operation (create_trip, propose_packing, mark_packed, mark_unpacked, sync_email, export_data, import_data, issue_recovery_kit). The same idempotency key and request return the original result. Some commands ask the owner to confirm first; export, import and recovery always do, and their data, links and codes are delivered privately in Garderobe, never as content here.' +
        (canWrite ? '' : ' On this read-only connection the command is validated and returned as a proposal; nothing changes.'),
      inputSchema: CommandToolInput,
      outputSchema: CommandToolOutput,
      annotations: canWrite ? { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } : { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, mcpCtx) =>
      guarded(async () => {
        if (Boolean(args.command) === Boolean(args.operation)) throw new HttpError(422, 'validation_failed', 'Give exactly one of command or operation');
        if (args.operation) {
          if (!canWrite) {
            const account = isAccountOperation(args.operation);
            const out = { status: 'proposal' as const, receipt: null, proposal: { command: args.operation as unknown as Record<string, unknown>, reason: account ? 'This connection is read-only. Nothing was exported, imported or issued; the owner can do this in Garderobe or from a connection with write access, after confirming.' : 'This connection is read-only. Nothing was changed; the owner can do this in Garderobe.' }, runId: null, operation: null };
            return result(out, `Proposal only (read-only connection): ${args.operation.type}. Nothing was changed.`);
          }
          if (isAccountOperation(args.operation)) return accountOperation(args as typeof args & { operation: AccountOperation }, mcpCtx);
          const op = await runOperation(env, ctx, principal, args.operation as TripOperation, args.idempotencyKey);
          const summary = typeof op.result.summary === 'string' ? op.result.summary : `${op.operation} done`;
          return result({ status: 'executed', receipt: null, proposal: null, runId: null, operation: op }, `${summary}${op.replayed ? ' (replayed)' : ''}`);
        }
        const envelope: CommandEnvelope = { idempotencyKey: args.idempotencyKey, source: 'mcp', expectedVersions: args.expectedVersions, command: DomainCommand.parse(args.command) };
        if (!canWrite) {
          const out = { status: 'proposal' as const, receipt: null, proposal: { command: envelope.command as unknown as Record<string, unknown>, reason: 'This connection is read-only. Nothing was changed; the owner can make this change in Garderobe.' }, runId: null };
          return result(out, `Proposal only (read-only connection): ${envelope.command.type}. Nothing was changed.`);
        }
        const secret = stateSecret(env);
        const rawState = mcpCtx.mcpReq.requestState<string>();
        if (typeof rawState === 'string' && rawState) {
          const row = await verifyPendingState(env, principal, secret, rawState, args);
          if ('error' in row) throw new HttpError(422, row.error, row.message);
          const view = inputResponse(mcpCtx.mcpReq.inputResponses, 'answer');
          const answer = acceptedContent<{ choice?: string }>(mcpCtx.mcpReq.inputResponses, 'answer');
          const choice = view.kind === 'elicit' && view.action === 'accept' ? (typeof answer?.choice === 'string' ? answer.choice : null) : null;
          if (view.kind === 'missing' && row.status === 'pending') throw new HttpError(422, 'input_missing', 'The retry carried no answer to the question');
          const outcome = await resolvePending(env, ctx, principal, row, choice);
          if (outcome.status === 'invalid_choice') throw new HttpError(422, 'invalid_choice', outcome.message);
          if (outcome.status === 'executed' && outcome.receipt) return result({ status: 'executed', receipt: outcome.receipt, proposal: null, runId: outcome.runId }, summarizeReceipt(outcome.receipt));
          return result({ status: outcome.status, receipt: null, proposal: null, runId: outcome.runId }, outcome.status === 'declined' ? 'Not changed: the owner declined.' : 'Not changed: the question expired; send the command again.');
        }
        const question = await questionFor(env, principal, envelope);
        if (question) {
          const existing = await env.DB.prepare("SELECT * FROM pending_actions WHERE user_id = ? AND idempotency_key = ? AND kind = ? AND status = 'resolved'").bind(principal.userId, envelope.idempotencyKey, question.kind).first<{ request_hash: string }>();
          if (existing && existing.request_hash === (await requestHash(args))) {
            // Already answered (natively or by an earlier retry): return the original receipt.
            const outcome = await resolvePending(env, ctx, principal, existing as never, null);
            if (outcome.status === 'executed' && outcome.receipt) return result({ status: 'executed', receipt: outcome.receipt, proposal: null, runId: outcome.runId }, summarizeReceipt(outcome.receipt));
          }
          const { row, state } = await openPending(env, principal, { envelope, question, surface: 'mcp', args, grantRef: session.grant.grant_id, secret });
          return inputRequired({
            inputRequests: {
              answer: inputRequired.elicit({
                message: question.prompt,
                requestedSchema: {
                  type: 'object',
                  properties: { choice: { type: 'string', title: 'Answer', enum: question.choices.map((c) => c.id), enumNames: question.choices.map((c) => c.label) } as never },
                  required: ['choice'],
                },
              }),
            },
            requestState: state,
          }) as never;
          void row;
        }
        const receipt = await executeCommand(env, ctx, principal, envelope, 'mcp');
        return result({ status: 'executed', receipt, proposal: null, runId: null }, summarizeReceipt(receipt));
      }),
  );

  /**
   * Export, import and recovery through garderobe_command (the owner's request of 2026-09-29): write
   * scope (checked above), the owner's confirmation through the same pending-action flow as other
   * confirmed commands, once-only execution per idempotency key, and private delivery: the tool result
   * carries a link that opens only for the signed-in owner, never the record or a recovery code.
   */
  async function accountOperation(args: { idempotencyKey: string; operation: AccountOperation }, mcpCtx: ServerContext): Promise<CallToolResult> {
    const op = args.operation;
    const envelope: OperationEnvelope = { idempotencyKey: args.idempotencyKey, operation: op };
    const secret = stateSecret(env);
    const finish = async (outcome: PendingOutcome): Promise<CallToolResult> => {
      if (outcome.status === 'invalid_choice') throw new HttpError(422, 'invalid_choice', outcome.message);
      if (outcome.status !== 'executed' || !outcome.operation) {
        return result({ status: outcome.status === 'expired' ? 'expired' : 'declined', receipt: null, proposal: null, runId: outcome.runId, operation: null }, outcome.status === 'expired' ? 'Not done: the question expired; send the request again with a new idempotency key.' : 'Not done: the owner declined.');
      }
      const delivered = await withDeliveryLinks(env, principal, outcome.operation, origin);
      const r = delivered.result as { summary?: string; downloadUrl?: string; collectUrl?: string; expiresAt?: string };
      const link = r.downloadUrl ?? r.collectUrl;
      const text = `${r.summary ?? `${delivered.operation} done`}${delivered.replayed ? ' (replayed; nothing was repeated)' : ''}${link ? `\nPrivate link (opens only for the owner signed in to Garderobe, until ${r.expiresAt}): ${link}` : ''}`;
      return result({ status: 'executed', receipt: null, proposal: null, runId: outcome.runId, operation: delivered }, text);
    };
    const rawState = mcpCtx.mcpReq.requestState<string>();
    if (typeof rawState === 'string' && rawState) {
      const row = await verifyPendingState(env, principal, secret, rawState, args, session.grant.grant_id);
      if ('error' in row) throw new HttpError(422, row.error, row.message);
      const view = inputResponse(mcpCtx.mcpReq.inputResponses, 'answer');
      const answer = acceptedContent<{ choice?: string }>(mcpCtx.mcpReq.inputResponses, 'answer');
      const choice = view.kind === 'elicit' && view.action === 'accept' ? (typeof answer?.choice === 'string' ? answer.choice : null) : null;
      if (view.kind === 'missing' && row.status === 'pending') throw new HttpError(422, 'input_missing', 'The retry carried no answer to the question');
      return finish(await resolvePending(env, ctx, principal, row, choice));
    }
    const existing = await env.DB.prepare("SELECT * FROM pending_actions WHERE user_id = ? AND idempotency_key = ? AND kind = 'confirm'").bind(principal.userId, args.idempotencyKey).first<{ status: string; request_hash: string }>();
    if (existing && existing.request_hash !== (await requestHash(args))) throw new HttpError(409, 'idempotency_key_reused', 'This idempotency key was already used for a different request');
    // Already answered (by an earlier retry or natively in Garderobe): the original outcome, never a second effect.
    if (existing && existing.status !== 'pending') return finish(await resolvePending(env, ctx, principal, existing as never, null));
    if (existing && session.era === 'legacy' && (existing as unknown as { expires_at: string }).expires_at <= now()) return finish(await resolvePending(env, ctx, principal, existing as never, null));
    if (op.type === 'import_data') {
      const staged = await stagedPackage(env, principal, op.packageId);
      if (!staged) throw new HttpError(404, 'not_found', `No staged import package ${op.packageId}. The owner stages the export file in Garderobe first (POST /v1/import/packages).`);
      if (staged.status !== 'staged') throw new HttpError(409, 'invalid_state', `Package ${op.packageId} is ${staged.status}`);
    }
    const question = await accountQuestion(env, principal, op);
    const { row, state } = await openPending(env, principal, { envelope, question, surface: 'mcp', args, grantRef: session.grant.grant_id, secret });
    if (session.era === 'legacy') {
      // The stateless 2025-11-25 adapter cannot carry a question to the client, so the owner confirms in
      // Garderobe itself; the same call afterwards returns the outcome. Nothing runs before that.
      const confirmUrl = `${origin.replace(/\/+$/, '')}/confirm/${row.run_id}`;
      return result(
        { status: 'awaiting_owner', receipt: null, proposal: null, runId: row.run_id, operation: null, confirmation: { prompt: question.prompt, confirmUrl, expiresAt: row.expires_at } },
        `Waiting for the owner. Nothing has been done yet. The owner confirms in Garderobe (signed in): ${confirmUrl} — “${question.prompt}” Then call garderobe_command again with the same idempotencyKey and arguments to get the result.`,
      );
    }
    return inputRequired({
      inputRequests: {
        answer: inputRequired.elicit({
          message: question.prompt,
          requestedSchema: {
            type: 'object',
            properties: { choice: { type: 'string', title: 'Answer', enum: question.choices.map((c) => c.id), enumNames: question.choices.map((c) => c.label) } as never },
            required: ['choice'],
          },
        }),
      },
      requestState: state,
    }) as never;
  }

  server.registerTool(
    'garderobe_ask',
    {
      title: 'Ask Garderobe',
      description:
        'Send an open-ended request to the owner’s Garderobe assistant: the same continuous conversation, profile and wardrobe the app uses. Returns the answer with any receipts, or a run id when the answer takes longer.' +
        (canWrite ? ' It can make authorized changes under the same checks as the app.' : ' On this read-only connection it can read and propose, never change.'),
      inputSchema: AskInput,
      outputSchema: AskOutput,
      annotations: canWrite ? { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } : { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      guarded(async () => {
        const handle = await conversationHandle(principal.userId);
        if (args.conversation && args.conversation !== handle) throw new HttpError(403, 'forbidden', 'That conversation belongs to another connection');
        const clientTurnId = args.clientTurnId ?? `mcp:${crypto.randomUUID()}`;
        const { response } = await submitTurn(env, principal, { clientTurnId, text: args.text }, { channel: 'mcp', grant: { scopes: [...principal.scopes], authenticatedBy: 'mcp_oauth' } });
        const status = await awaitRun(response.runId, args.waitSeconds ?? 25);
        const turn = await env.DB.prepare('SELECT intent_json FROM assistant_turns WHERE user_id = ? AND client_turn_id = ?').bind(principal.userId, clientTurnId).first<{ intent_json: string }>();
        const blocked = turn ? ((JSON.parse(turn.intent_json) as { intent?: { blocked?: { family: string; reason: string }[] } }).intent?.blocked ?? []) : [];
        const answer = runAnswerText(status);
        const state = status.status === 'finished' ? 'answered' : status.status === 'failed' ? 'failed' : status.status === 'cancelled' ? 'cancelled' : 'running';
        if (status.receipts?.length) await afterCommit(env, ctx, principal.userId);
        const out = { status: state as 'answered', runId: response.runId, clientTurnId, conversation: handle, answer, receipts: status.receipts ?? [], blocked, ...(response.notice ? { notice: response.notice } : {}) };
        const note = response.notice ? `${response.notice.title}. ${response.notice.summary}\n\n` : '';
        return result(out, `${note}${answer ?? (state === 'running' ? followRun(response.runId).instruction : `The reply ${state}; see run ${response.runId} with garderobe_run.`)}`);
      }),
  );

  server.registerTool(
    'garderobe_research',
    {
      title: 'Research',
      description: 'Investigate a product page (variant availability, price, size chart), give size advice from the owner’s recorded sizes and a maker’s chart, give a purchase verdict against the existing wardrobe, or research a history/provenance/fit topic through the assistant. Sources are untrusted and cited.',
      inputSchema: ResearchInput,
      outputSchema: ResearchOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      guarded(async () => {
        const research = createResearchService(env, principal.userId, () => createModelService(env, principal.userId));
        if (args.kind === 'product') {
          if (!args.url) throw new HttpError(422, 'validation_failed', 'url is required for kind=product');
          const r = await research.service.investigate(principal, { url: args.url, size: args.size, colour: args.colour });
          return result({ kind: 'product', status: r.status, result: r as never, runId: null }, `${r.status}: ${r.product?.name ?? args.url}${r.unresolved.length ? ` (unresolved: ${r.unresolved.join('; ')})` : ''}`);
        }
        if (args.kind === 'size') {
          if (!args.maker || !args.category) throw new HttpError(422, 'validation_failed', 'maker and category are required for kind=size');
          const r = await research.service.sizeAdvice(principal, { maker: args.maker, category: args.category });
          return result({ kind: 'size', status: r.recommendation ? 'resolved' : 'unresolved', result: r as never, runId: null }, r.recommendation ?? 'No recorded size or chart for this maker yet.');
        }
        if (args.kind === 'verdict') {
          if (!args.description) throw new HttpError(422, 'validation_failed', 'description is required for kind=verdict');
          const r = await research.service.verdict(principal, { description: args.description, maker: args.maker, category: args.category, evidenceUrl: args.url });
          return result({ kind: 'verdict', status: 'resolved', result: r as never, runId: null }, JSON.stringify(r).slice(0, 2000));
        }
        if (!args.question) throw new HttpError(422, 'validation_failed', 'question is required for kind=topic');
        const { response } = await submitTurn(env, principal, { clientTurnId: `mcp-research:${crypto.randomUUID()}`, text: args.question }, { channel: 'mcp', grant: { scopes: [SCOPE_READ], authenticatedBy: 'mcp_oauth' } });
        // Wait for the answer within the call's budget; past it, say exactly how to fetch it (D3).
        const status = await awaitRun(response.runId, args.waitSeconds ?? 25);
        const answer = runAnswerText(status);
        if (status.status === 'finished' && answer) {
          return result({ kind: 'topic', status: 'answered', result: { messageId: status.messageId ?? response.messageId, answer }, runId: response.runId }, answer);
        }
        if (status.status === 'failed' || status.status === 'cancelled' || status.status === 'finished') {
          const failure = typeof status.result?.failure === 'string' ? status.result.failure : null;
          return result({ kind: 'topic', status: status.status === 'finished' ? 'failed' : status.status, result: { messageId: response.messageId, ...(failure ? { failure } : {}) }, runId: response.runId }, `The research ${status.status === 'cancelled' ? 'was cancelled' : 'did not produce an answer'}${failure ? ` (${failure})` : ''}. Nothing more will arrive for run ${response.runId}.`);
        }
        const next = followRun(response.runId);
        return result({ kind: 'topic', status: 'running', result: { messageId: response.messageId }, runId: response.runId, next }, `Still researching (run ${response.runId}). ${next.instruction}`);
      }),
  );

  server.registerTool(
    'garderobe_run',
    {
      title: 'Follow a run',
      description: 'Read the durable state of a Garderobe run (a conversation reply, research or a command waiting for the owner), answer the question it is waiting on, or cancel what remains. Committed changes stay committed.',
      inputSchema: RunInput,
      outputSchema: RunOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      guarded(async () => {
        if (args.action === 'cancel') {
          if (!canWrite) throw new DomainError('insufficient_scope', 'This connection is read-only');
          await cancelRun(env, ctx, principal, args.runId);
        } else if (args.action === 'respond') {
          if (!canWrite) throw new DomainError('insufficient_scope', 'This connection is read-only');
          const pending = await pendingActionForRun(env.DB, principal.userId, args.runId);
          // Export, import and recovery need the owner's own answer (the client's confirmation form or Garderobe), never the assistant's.
          if (pending?.commandType && isAccountOperation({ type: pending.commandType })) throw new HttpError(403, 'owner_confirmation_required', 'The owner confirms export, import and recovery themselves, in Garderobe or in the confirmation form; an assistant cannot answer for them.');
          const outcome = await answerRun(env, ctx, principal, args.runId, args.choice ?? null);
          if (outcome.status === 'invalid_choice') throw new HttpError(422, 'invalid_choice', outcome.message);
        }
        const status = await runStatus(env.DB, principal, args.runId);
        const answer = runAnswerText(status);
        const waiting = status.pendingAction?.status === 'pending' ? ` — waiting: ${status.pendingAction.prompt}` : '';
        const text =
          status.status === 'finished' && answer
            ? `Run ${status.runId}: finished.\n\n${answer}`
            : !isTerminal(status.status) && !waiting
              ? `Run ${status.runId}: ${status.status}. ${followRun(status.runId).instruction}`
              : `Run ${status.runId}: ${status.status}${waiting}`;
        return result(status as never, text);
      }),
  );

  server.registerResource(
    'owner-style-profile',
    'garderobe://style/current',
    { title: 'The owner’s style profile', description: 'The owner’s full profile, verbatim. Tools apply it whether or not it is read.', mimeType: 'text/markdown' },
    async (uri) => {
      const docs = await listStyleDocuments(env.DB, principal);
      return {
        contents: docs.map((d) => ({
          uri: uri.href,
          mimeType: 'text/markdown',
          text: d.integrity === 'mismatch' ? `> INTEGRITY WARNING: this stored profile does not match its recorded SHA-256 (${d.contentSha256}); it needs review.\n\n${d.body}` : d.body,
        })),
      };
    },
  );

  return server;
}

function allowedOrigin(env: Env, request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true; // server-to-server clients (Claude, ChatGPT connectors) send no Origin
  const allowed = [mcpOrigin(env, request), env.APP_ORIGIN].filter(Boolean).map((o) => o!.replace(/\/+$/, ''));
  return allowed.includes(origin.replace(/\/+$/, ''));
}

/**
 * The protected MCP endpoint. The OAuth provider has already validated the bearer token (audience,
 * expiry) and decrypted its props; this handler adds the application's grant decision from D1.
 */
export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      if (!allowedOrigin(env, request)) return apiError(403, 'forbidden_origin', 'This origin may not call the Garderobe MCP server');
      const props = (ctx as unknown as { props?: GrantProps }).props;
      const auth = (ctx as unknown as { auth?: { scope: string[]; clientId: string; token: string; expiresAt: number } }).auth;
      const check = await checkGrant(env.DB, props);
      const resourceMetadata = `${mcpOrigin(env, request)}/.well-known/oauth-protected-resource/mcp`;
      if (!check.ok) {
        return apiError(401, 'invalid_token', `This Garderobe connection is no longer authorized (${check.reason}). Reconnect from Garderobe.`, undefined, {
          'www-authenticate': `Bearer error="invalid_token", error_description="grant revoked", resource_metadata="${resourceMetadata}"`,
        });
      }
      const scopes = (auth?.scope ?? check.scopes).filter((s) => check.scopes.includes(s));
      if (!scopes.includes(SCOPE_READ)) return apiError(403, 'insufficient_scope', 'wardrobe:read is required', undefined, { 'www-authenticate': `Bearer error="insufficient_scope", scope="${SCOPE_READ}", resource_metadata="${resourceMetadata}"` });
      const principal = ownerPrincipal(check.grant.user_id, 'mcp_oauth', scopes);
      const legacy = request.method === 'POST' ? await isLegacyRequest(request.clone()).catch(() => false) : false;
      const session: McpSession = { principal, grant: check.grant, origin: env.APP_ORIGIN ?? new URL(request.url).origin, era: legacy ? 'legacy' : 'modern' };
      const handler = createMcpHandler(() => buildMcpServer(env, ctx, session), { legacy: 'stateless', onerror: (e) => console.warn('mcp', e.message) });
      const operation = request.headers.get('mcp-name') ?? request.headers.get('mcp-method') ?? request.method;
      ctx.waitUntil(touchGrant(env.DB, principal.userId, check.grant.grant_id, operation, now(), legacy ? LEGACY_PROTOCOL : (request.headers.get('mcp-protocol-version') ?? MODERN_PROTOCOL)).catch(() => undefined));
      return await handler.fetch(request, { authInfo: { token: auth?.token ?? '', clientId: auth?.clientId ?? check.grant.client_id, scopes, expiresAt: auth?.expiresAt } });
    } catch (err) {
      return errorResponse(err);
    }
  },
};
