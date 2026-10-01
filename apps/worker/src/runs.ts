import type { Channel } from "@garderobe/contracts";
import type { RunKind } from "@garderobe/contracts/ext/api";
import { all, first, json, prepare, stmt, toInstant, type Db, type Principal, type Stmt } from "@garderobe/domain";
import type { z } from "zod";
import { requireAssistant, type App } from "./app.ts";
import { randomBytes, sha256Hex, toBase64Url } from "./crypto.ts";
import { ApiException } from "./errors.ts";
import { BASE_HEADERS } from "./http.ts";
import type { ApiRun, ApiRunEvent, ApiRunState } from "./ports.ts";

/**
 * Durable runs (specification section 13): `GET /v1/runs/{id}`, its event stream and cancel.
 *
 * `api_runs` binds every run ID to its owner and provider. Conversation and research runs are
 * projected from the assistant's durable turn state (this is not another transcript store); export and
 * import runs keep their own ordered event log here. A run is never looked up without its owner.
 */
type Kind = z.infer<typeof RunKind>;

const TERMINAL: ApiRunState[] = ["completed", "failed", "cancelled"];
export const isTerminal = (state: ApiRunState): boolean => TERMINAL.includes(state);

/** Events kept per run; older ones are trimmed and an older cursor receives a snapshot instead. */
export const RUN_EVENT_RETENTION = 500;

interface RunRow {
  run_id: string;
  kind: Kind;
  provider: "api" | "assistant";
  state: ApiRunState;
  activity: string | null;
  result_json: string | null;
  error_json: string | null;
  receipts_json: string;
  last_event_id: number;
  first_event_id: number;
  created_at: string;
  updated_at: string;
  request_hash: string | null;
}

const RUN_COLUMNS = "run_id, kind, provider, state, activity, result_json, error_json, receipts_json, last_event_id, first_event_id, created_at, updated_at, request_hash";

function rowToRun(row: RunRow): ApiRun {
  const result = json<Record<string, unknown> | null>(row.result_json, null);
  return {
    runId: row.run_id,
    kind: row.kind,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activity: row.activity,
    lastEventId: row.last_event_id,
    pendingInput: null,
    receipts: json(row.receipts_json, []),
    proposals: [],
    result: result === null ? null : { reply: null, options: [], board: null, research: null, exportId: null, importId: null, ...result },
    error: json(row.error_json, null),
  };
}

async function loadRow(db: Db, userId: string, runId: string): Promise<RunRow> {
  const row = await first<RunRow>(db, `SELECT ${RUN_COLUMNS} FROM api_runs WHERE user_id = ? AND run_id = ?`, userId, runId);
  if (!row) throw new ApiException("not_found", "that run was not found");
  return row;
}

/** Bind an assistant turn to its owner so it can be read, streamed and cancelled as a run. */
export async function registerAssistantRun(db: Db, principal: Principal, input: { runId: string; kind: Kind; state: ApiRunState; clientRequestId: string }, nowMs: number): Promise<void> {
  const now = toInstant(nowMs);
  await prepare(
    db,
    stmt(
      "INSERT INTO api_runs (user_id, run_id, kind, provider, state, client_request_id, channel, created_at, updated_at) VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      principal.userId,
      input.runId,
      input.kind,
      input.state,
      input.clientRequestId,
      principal.channel,
      now,
      now,
    ),
  ).run();
}

/**
 * Create a run this workstream executes. The same `clientRequestId` with the same request returns the
 * existing run (`replayed`); with a different request it is refused.
 */
export async function createApiRun(db: Db, input: { userId: string; kind: Kind; clientRequestId: string; request: unknown; channel: Channel; nowMs: number }): Promise<{ runId: string; replayed: boolean }> {
  const requestHash = await sha256Hex(JSON.stringify(input.request));
  const find = () => first<{ run_id: string; request_hash: string | null }>(db, "SELECT run_id, request_hash FROM api_runs WHERE user_id = ? AND kind = ? AND client_request_id = ?", input.userId, input.kind, input.clientRequestId);
  const existing = await find();
  const check = (row: { run_id: string; request_hash: string | null }) => {
    if (row.request_hash !== requestHash) throw new ApiException("idempotency_key_reuse", "that request ID was already used for a different request");
    return { runId: row.run_id, replayed: true };
  };
  if (existing) return check(existing);
  const runId = `run_${toBase64Url(randomBytes(12))}`;
  const now = toInstant(input.nowMs);
  await db.batch(
    [
      stmt(
        "INSERT INTO api_runs (user_id, run_id, kind, provider, state, client_request_id, request_hash, channel, last_event_id, created_at, updated_at) VALUES (?, ?, ?, 'api', 'running', ?, ?, ?, 1, ?, ?) ON CONFLICT DO NOTHING",
        input.userId,
        runId,
        input.kind,
        input.clientRequestId,
        requestHash,
        input.channel,
        now,
        now,
      ),
      stmt(
        "INSERT INTO api_run_events (user_id, run_id, event_id, type, at, data_json) SELECT ?, ?, 1, 'run_started', ?, ? WHERE EXISTS (SELECT 1 FROM api_runs WHERE user_id = ? AND run_id = ?)",
        input.userId,
        runId,
        now,
        JSON.stringify({ kind: input.kind }),
        input.userId,
        runId,
      ),
    ].map((s) => prepare(db, s)),
  );
  const row = (await find())!;
  return row.run_id === runId ? { runId, replayed: false } : check(row);
}

export interface RunPatch {
  state?: ApiRunState;
  activity?: string | null;
  result?: Record<string, unknown> | null;
  error?: { code: string; message: string; resumable: boolean } | null;
}

/** Statements appending one ordered event to an API-owned run and applying a state patch. */
export function runEventStatements(userId: string, runId: string, type: string, data: Record<string, unknown>, patch: RunPatch, nowMs: number): Stmt[] {
  const now = toInstant(nowMs);
  const sets: string[] = ["last_event_id = last_event_id + 1", "updated_at = ?"];
  const params: unknown[] = [now];
  if (patch.state !== undefined) {
    sets.push("state = ?");
    params.push(patch.state);
  }
  if (patch.activity !== undefined) {
    sets.push("activity = ?");
    params.push(patch.activity);
  }
  if (patch.result !== undefined) {
    sets.push("result_json = ?");
    params.push(patch.result === null ? null : JSON.stringify(patch.result));
  }
  if (patch.error !== undefined) {
    sets.push("error_json = ?");
    params.push(patch.error === null ? null : JSON.stringify(patch.error));
  }
  return [
    stmt(`UPDATE api_runs SET ${sets.join(", ")} WHERE user_id = ? AND run_id = ?`, ...params, userId, runId),
    stmt("INSERT INTO api_run_events (user_id, run_id, event_id, type, at, data_json) SELECT user_id, run_id, last_event_id, ?, ?, ? FROM api_runs WHERE user_id = ? AND run_id = ?", type, now, JSON.stringify(data), userId, runId),
    // Bounded retention: trim and remember the first retained ID so an older cursor gets a snapshot, not a gap.
    stmt("DELETE FROM api_run_events WHERE user_id = ? AND run_id = ? AND event_id <= (SELECT last_event_id FROM api_runs WHERE user_id = ? AND run_id = ?) - ?", userId, runId, userId, runId, RUN_EVENT_RETENTION),
    stmt("UPDATE api_runs SET first_event_id = MAX(first_event_id, last_event_id - ? + 1) WHERE user_id = ? AND run_id = ?", RUN_EVENT_RETENTION, userId, runId),
  ];
}

export async function appendRunEvent(db: Db, userId: string, runId: string, type: string, data: Record<string, unknown>, patch: RunPatch, nowMs: number): Promise<void> {
  await db.batch(runEventStatements(userId, runId, type, data, patch, nowMs).map((s) => prepare(db, s)));
}

export async function getRun(app: App, principal: Principal, runId: string): Promise<ApiRun> {
  const row = await loadRow(app.db, principal.userId, runId);
  if (row.provider === "assistant") {
    const run = await requireAssistant(app, "conversation runs").getRun(principal, runId);
    if (!run) throw new ApiException("not_found", "that run was not found");
    // Keep the registry's state current so the recovery screen can count runs waiting for input.
    if (run.state !== row.state) await prepare(app.db, stmt("UPDATE api_runs SET state = ?, updated_at = ? WHERE user_id = ? AND run_id = ?", run.state, toInstant(app.now()), principal.userId, runId)).run();
    return { ...run, kind: row.kind };
  }
  return rowToRun(row);
}

export async function readRunEvents(app: App, principal: Principal, runId: string, after: number): Promise<{ events: ApiRunEvent[]; expired: boolean }> {
  const row = await loadRow(app.db, principal.userId, runId);
  if (row.provider === "assistant") {
    const result = await requireAssistant(app, "conversation runs").runEvents(principal, runId, after);
    return { events: result.events.map((e) => (e.type === "run_started" ? { ...e, data: { kind: row.kind } } : e)), expired: result.expired };
  }
  const expired = after + 1 < row.first_event_id;
  const rows = await all<{ event_id: number; type: string; at: string; data_json: string }>(
    app.db,
    "SELECT event_id, type, at, data_json FROM api_run_events WHERE user_id = ? AND run_id = ? AND event_id > ? ORDER BY event_id LIMIT 500",
    principal.userId,
    runId,
    expired ? row.last_event_id : after,
  );
  return { events: rows.map((r) => ({ eventId: r.event_id, runId, type: r.type, at: r.at, data: json(r.data_json, {}) })), expired };
}

export async function cancelRun(app: App, principal: Principal, runId: string): Promise<{ run: ApiRun; stopped: string[] }> {
  const row = await loadRow(app.db, principal.userId, runId);
  if (row.provider === "assistant") {
    const result = await requireAssistant(app, "conversation runs").cancelRun(principal, runId);
    return { run: { ...result.run, kind: row.kind }, stopped: result.stopped };
  }
  if (isTerminal(row.state)) return { run: rowToRun(row), stopped: [] };
  await appendRunEvent(app.db, principal.userId, runId, "run_finished", { state: "cancelled" }, { state: "cancelled", activity: null }, app.now());
  return { run: rowToRun(await loadRow(app.db, principal.userId, runId)), stopped: [`The ${row.kind} was stopped before it finished.`] };
}

export async function answerRunInput(app: App, principal: Principal, runId: string, input: { inputId: string; choiceId?: string; text?: string }): Promise<ApiRun> {
  const row = await loadRow(app.db, principal.userId, runId);
  if (row.provider !== "assistant") throw new ApiException("precondition_failed", "this run is not waiting for input");
  const run = await requireAssistant(app, "conversation runs").answerInput(principal, runId, input);
  return { ...run, kind: row.kind };
}

/* ------------------------------------------------------------------ */
/* Server-sent events                                                   */
/* ------------------------------------------------------------------ */

const encoder = new TextEncoder();

export function sseFrame(event: ApiRunEvent): Uint8Array {
  return encoder.encode(`id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export interface StreamOptions {
  after: number;
  follow: boolean;
  /** Longest time one response stays open; the client reconnects with its last event ID. */
  maxOpenMs?: number;
  pollMs?: number;
}

/**
 * The run's event stream. Events carry ordered IDs; a reconnect resumes after `Last-Event-ID`. When
 * the cursor is older than the retained window the stream starts with a `snapshot` of the durable run
 * (never a silent gap). The stream closes when the run is terminal or after a bounded time; nothing
 * depends on it staying open, because the run and its result are durable.
 */
export function streamRunEvents(app: App, principal: Principal, runId: string, options: StreamOptions): Response {
  const maxOpenMs = options.maxOpenMs ?? 25_000;
  const pollMs = options.pollMs ?? 700;
  let cursor = options.after;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const startedAt = Date.now();
      try {
        controller.enqueue(encoder.encode("retry: 2000\n\n"));
        for (;;) {
          const { events, expired } = await readRunEvents(app, principal, runId, cursor);
          const run = await getRun(app, principal, runId);
          if (expired) {
            const snapshot: ApiRunEvent = { eventId: run.lastEventId, runId, type: "snapshot", at: toInstant(app.now()), data: { run, reason: "cursor_expired" } };
            controller.enqueue(sseFrame(snapshot));
            cursor = run.lastEventId;
          }
          for (const event of events) {
            if (event.eventId <= cursor) continue;
            controller.enqueue(sseFrame(event));
            cursor = event.eventId;
          }
          if (!options.follow || cancelled) break;
          if (isTerminal(run.state) && cursor >= run.lastEventId) break;
          if (Date.now() - startedAt > maxOpenMs) break;
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
      } catch (error) {
        const message = error instanceof ApiException ? error.message : "the stream ended unexpectedly; reconnect to continue";
        controller.enqueue(encoder.encode(`event: stream_error\ndata: ${JSON.stringify({ message })}\n\n`));
      }
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return new Response(stream, { status: 200, headers: { ...BASE_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
}
