/**
 * Background job execution for the assistant lane. One idempotent runner, three ways to drive it:
 *   - the Worker's scheduled sweep (`runPendingAssistantJobs`), which works on every plan;
 *   - a Queue consumer (`handleAssistantJobQueue`), messages carrying only owner and job IDs;
 *   - a Workflow step (`runAssistantJobStep`), for runs that outlive one invocation.
 * The job row in D1 is the state: a job that is not `queued` is not started again, every write inside a
 * job is keyed by the job, and a stopped job reports the effects it had already committed.
 *
 * Research jobs created by `startResearch` run in their own task actor and are not handled here.
 */
import { all, first, json, systemPrincipalFor, type CommandService, type Db } from "@garderobe/domain";
import type { ModelService } from "../inference/service.ts";
import type { MailSource } from "../research/index.ts";
import { previewSheetImport, type LedgerGarment } from "../research/index.ts";
import type { SheetsClient } from "../connections/google.ts";
import { ConnectionError } from "../connections/mcp.ts";
import { runPurchaseInvestigation } from "./purchases.ts";

export interface AssistantJobDeps {
  db: Db;
  service: CommandService;
  models: ModelService;
  nowMs: number;
  /** The owner's mailbox through a connected Gmail connection, or null when none is connected. */
  mailFor?: (userId: string, connectionId: string) => Promise<(MailSource & { profile?: () => Promise<{ historyId: string }> }) | null>;
  sheetsFor?: (userId: string, connectionId: string) => Promise<SheetsClient | null>;
}

export type JobRunOutcome = { handled: true; state: string; detail?: string } | { handled: false; reason: string };

/** Kinds this runner executes. Other kinds belong to their own workstream's runner (media) or to a task actor. */
export const ASSISTANT_JOB_KINDS = ["email_investigation", "sheet_import"] as const;

export async function runAssistantJob(deps: AssistantJobDeps, userId: string, jobId: string): Promise<JobRunOutcome> {
  const job = await first<{ kind: string; state: string; params_json: string; title: string }>(deps.db, "SELECT kind, state, params_json, title FROM assistant_jobs WHERE user_id = ? AND job_id = ?", userId, jobId);
  if (!job) return { handled: false, reason: "no such job" };
  if (!(ASSISTANT_JOB_KINDS as readonly string[]).includes(job.kind)) return { handled: false, reason: `jobs of kind ${job.kind} are not run here` };
  // Delivered twice (queue redelivery, an overlapping sweep): only a queued job starts.
  if (job.state !== "queued") return { handled: true, state: job.state, detail: "already started" };
  const params = json<Record<string, unknown>>(job.params_json, {});
  const principal = await systemPrincipalFor(deps.db, userId, `job:${jobId}`, "system");
  const fail = async (reason: string): Promise<JobRunOutcome> => {
    await deps.service.execute(principal, { type: "job.update", payload: { jobId, state: "failed", unresolvedReason: reason }, idempotencyKey: `job:${jobId}:failed`, authorization: "system_schedule", source: { channel: "system", parentKind: "job", parentId: jobId } });
    return { handled: true, state: "failed", detail: reason };
  };
  const stopped = async () => (await first<{ state: string }>(deps.db, "SELECT state FROM assistant_jobs WHERE user_id = ? AND job_id = ?", userId, jobId))?.state === "cancelled";
  const connectionId = typeof params["connectionId"] === "string" ? (params["connectionId"] as string) : null;

  try {
    if (job.kind === "email_investigation") {
      const connection = connectionId
        ? await first<{ connection_id: string; status: string }>(deps.db, "SELECT connection_id, status FROM connections WHERE user_id = ? AND connection_id = ? AND kind = 'gmail'", userId, connectionId)
        : await first<{ connection_id: string; status: string }>(deps.db, "SELECT connection_id, status FROM connections WHERE user_id = ? AND kind = 'gmail' AND status = 'connected' ORDER BY created_at LIMIT 1", userId);
      if (!connection) return fail("no mailbox is connected; connect Gmail to search for purchases");
      if (connection.status !== "connected") return fail("the mailbox connection needs you to sign in again");
      const mail = (await deps.mailFor?.(userId, connection.connection_id)) ?? null;
      if (!mail) return fail("the mailbox could not be opened in this environment");
      const result = await runPurchaseInvestigation({ db: deps.db, service: deps.service, models: deps.models, mail, nowMs: deps.nowMs, shouldStop: stopped }, userId, jobId, { ...params, connectionId: connection.connection_id });
      return { handled: true, state: result.state };
    }
    // sheet_import: read the sheet and store a PREVIEW. Applying it is a separate, owner-authorized step.
    const spreadsheetId = typeof params["spreadsheetId"] === "string" ? (params["spreadsheetId"] as string) : null;
    const range = typeof params["range"] === "string" ? (params["range"] as string) : "A1:Z2000";
    if (!spreadsheetId || !connectionId) return fail("the sheet to import was not identified");
    const sheets = (await deps.sheetsFor?.(userId, connectionId)) ?? null;
    if (!sheets) return fail("the Sheets connection could not be opened in this environment");
    const rows = await sheets.readRecords(spreadsheetId, range);
    const existing: LedgerGarment[] = (await all<{ garment_id: string; name: string; quantity: number }>(deps.db, "SELECT g.garment_id, g.name, COALESCE((SELECT SUM(b.quantity) FROM stock_balances b WHERE b.user_id = g.user_id AND b.garment_id = g.garment_id AND b.bucket NOT IN ('incoming', 'gone')), 0) AS quantity FROM garments g WHERE g.user_id = ? AND g.acquisition = 'owned'", userId)).map((g) => ({ garmentId: g.garment_id, name: g.name, quantity: Number(g.quantity) }));
    const preview = previewSheetImport(rows, existing);
    await deps.service.execute(principal, {
      type: "job.update",
      payload: { jobId, state: "completed", resultRef: `job:${jobId}`, progress: { phase: "preview ready; nothing was applied", rows: rows.length, changes: preview.changes.slice(0, 200), duplicates: preview.duplicates, conflicts: preview.conflicts, unmappedColumns: preview.mapping.unmapped } },
      idempotencyKey: `job:${jobId}:settled`,
      authorization: "system_schedule",
      source: { channel: "system", parentKind: "job", parentId: jobId },
    });
    return { handled: true, state: "completed" };
  } catch (e) {
    if (e instanceof ConnectionError) return fail(e.code === "auth" ? "the connection was rejected; sign in again to continue" : e.message.slice(0, 280));
    // Anything else must not leave the job 'running' for ever (adversarial finding I05-4): it settles as
    // failed with a fixed reason. The error's own text is never stored: it could carry a key-bearing
    // address. Only when even that cannot be recorded is the error passed on.
    return fail("the work stopped on an internal error before it finished; nothing more was recorded. It can be asked for again").catch(() => {
      throw e;
    });
  }
}

/** Sweep entry: run every queued job of the kinds handled here, oldest and highest priority first. */
export async function runPendingAssistantJobs(deps: AssistantJobDeps, opts: { limit?: number } = {}): Promise<{ ran: { userId: string; jobId: string; state: string }[] }> {
  const rows = await all<{ user_id: string; job_id: string }>(deps.db, `SELECT user_id, job_id FROM assistant_jobs WHERE state = 'queued' AND kind IN (${ASSISTANT_JOB_KINDS.map(() => "?").join(",")}) ORDER BY priority, created_at LIMIT ?`, ...ASSISTANT_JOB_KINDS, opts.limit ?? 5);
  const ran: { userId: string; jobId: string; state: string }[] = [];
  for (const r of rows) {
    const outcome = await runAssistantJob(deps, r.user_id, r.job_id).catch(() => ({ handled: true as const, state: "error" }));
    if (outcome.handled) ran.push({ userId: r.user_id, jobId: r.job_id, state: outcome.state });
  }
  return { ran };
}

/** A queue message names a job. It carries no content and no authority. */
export interface AssistantJobMessage {
  userId: string;
  jobId: string;
}

interface QueueMessageLike<T> {
  body: T;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

/** Queue consumer: `queue(batch, env) { return handleAssistantJobQueue(batch.messages, deps) }`. */
export async function handleAssistantJobQueue(messages: readonly QueueMessageLike<AssistantJobMessage>[], deps: AssistantJobDeps): Promise<{ acked: number; retried: number }> {
  let acked = 0;
  let retried = 0;
  for (const message of messages) {
    const { userId, jobId } = message.body ?? ({} as AssistantJobMessage);
    if (typeof userId !== "string" || typeof jobId !== "string") {
      message.ack(); // malformed: nothing to retry
      acked++;
      continue;
    }
    try {
      await runAssistantJob(deps, userId, jobId);
      message.ack();
      acked++;
    } catch {
      message.retry({ delaySeconds: 30 });
      retried++;
    }
  }
  return { acked, retried };
}

interface WorkflowStepLike {
  do<T>(name: string, config: { retries?: { limit: number; delay: string | number; backoff?: "constant" | "linear" | "exponential" }; timeout?: string | number }, callback: () => Promise<T>): Promise<T>;
}

/**
 * Workflow body: `class AssistantJobWorkflow extends WorkflowEntrypoint { run(event, step) { return runAssistantJobStep(step, deps(this.env), event.payload) } }`.
 * The step is safe to retry: the job state decides whether anything is left to do.
 */
export async function runAssistantJobStep(step: WorkflowStepLike, deps: AssistantJobDeps, payload: AssistantJobMessage): Promise<JobRunOutcome> {
  return step.do(`assistant job ${payload.jobId}`, { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "15 minutes" }, () => runAssistantJob(deps, payload.userId, payload.jobId));
}
