/**
 * The media job runner. Jobs live in the `media_jobs` ledger; the queue only carries their identifiers.
 * Delivery is at-least-once, so a job is claimed with a lease before it runs and every handler is
 * idempotent (deterministic object keys, idempotent result commands).
 */
import { acknowledgeOutbox, all, first, isCommandError, json, prepare, readOutbox, stmt, toInstant } from "@garderobe/domain";
import type { MediaJobStatus } from "@garderobe/contracts/ext/media";
import type { Principal } from "@garderobe/domain";
import { assertPrincipal, requireScope } from "@garderobe/domain";
import { execSystem } from "./exec.ts";
import { assertOwnedKey } from "./keys.ts";
import { limitsOf, type MediaQueueMessage, type MediaRuntime } from "./runtime.ts";
import type { MediaJobKind } from "./store.ts";
import { runNormalizeJob } from "./pipeline/normalize.ts";
import { runDiscoveryJob } from "./pipeline/discovery.ts";
import { runRenderJob } from "./pipeline/render.ts";
import { thumbnailCacheUrl } from "./delivery.ts";
import { MEDIA_THUMBNAIL_WIDTHS } from "@garderobe/contracts/ext/media";

export interface JobRow {
  user_id: string;
  job_id: string;
  kind: MediaJobKind;
  subject_id: string;
  state: "queued" | "running" | "succeeded" | "failed" | "dead";
  attempts: number;
  max_attempts: number;
  payload_json: string;
  last_error: string | null;
  updated_at: string;
}

export type JobRunResult = "succeeded" | "skipped" | "retry" | "dead";

/** Move committed `media.job` outbox entries onto the queue, then acknowledge them. Safe to call repeatedly. */
export async function dispatchMediaJobs(rt: MediaRuntime, opts: { limit?: number } = {}): Promise<{ sent: number; queueAvailable: boolean }> {
  if (!rt.deps.queue) return { sent: 0, queueAvailable: false };
  const entries = await readOutbox(rt.db, { topics: ["media.job"], limit: opts.limit ?? 100 });
  if (entries.length === 0) return { sent: 0, queueAvailable: true };
  for (let i = 0; i < entries.length; i += 50) {
    const part = entries.slice(i, i + 50);
    await rt.deps.queue.sendBatch(part.map((e) => ({ body: { kind: "media.job" as const, userId: e.userId, jobId: e.entityId } })));
    // Acknowledge only after the queue accepted the batch; a crash in between re-sends, and the lease dedupes.
    await acknowledgeOutbox(rt.db, part.map((e) => e.seq), rt.clock());
  }
  return { sent: entries.length, queueAvailable: true };
}

async function claim(rt: MediaRuntime, userId: string, jobId: string): Promise<JobRow | null> {
  const nowMs = rt.clock();
  const now = toInstant(nowMs);
  const lease = toInstant(nowMs + limitsOf(rt.deps).jobLeaseSeconds * 1000);
  const res = await prepare(
    rt.db,
    stmt(
      "UPDATE media_jobs SET state = 'running', attempts = attempts + 1, lease_until = ?, updated_at = ? WHERE user_id = ? AND job_id = ? AND (state = 'queued' OR (state = 'running' AND lease_until < ?))",
      lease, now, userId, jobId, now,
    ),
  ).run();
  if ((res.meta?.changes ?? 0) !== 1) return null;
  return first<JobRow>(rt.db, "SELECT user_id, job_id, kind, subject_id, state, attempts, max_attempts, payload_json, last_error, updated_at FROM media_jobs WHERE user_id = ? AND job_id = ?", userId, jobId);
}

async function runPurge(rt: MediaRuntime, job: JobRow, ownerActive: boolean): Promise<void> {
  const payload = json<{ keys?: string[]; cacheShas?: string[] }>(job.payload_json, {});
  const keys = payload.keys ?? [];
  // Every key is re-checked against the job's owner before anything is deleted.
  for (const key of keys) assertOwnedKey(job.user_id, key);
  for (let i = 0; i < keys.length; i += 500) await rt.deps.bucket.delete(keys.slice(i, i + 500));
  let cachePurged = 0;
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  if (cache) {
    for (const sha of payload.cacheShas ?? []) {
      for (const width of MEDIA_THUMBNAIL_WIDTHS) if (await cache.delete(thumbnailCacheUrl(job.user_id, sha, width))) cachePurged++;
    }
  }
  const result = { deletedObjects: keys.length, cacheEntriesPurged: cachePurged };
  if (ownerActive) {
    await execSystem(rt, job.user_id, "media.complete_job", { jobId: job.job_id, result }, `job-done:${job.job_id}`);
    return;
  }
  // A disabled account accepts no commands, but its deleted files must still leave storage. Only the job
  // ledger's own bookkeeping is written here (as claiming a lease does); no wardrobe record changes.
  await prepare(rt.db, stmt("UPDATE media_jobs SET state = 'succeeded', result_json = ?, last_error = NULL, lease_until = NULL, updated_at = ? WHERE user_id = ? AND job_id = ? AND state = 'running'", JSON.stringify({ ...result, accountDisabled: true }), toInstant(rt.clock()), job.user_id, job.job_id)).run();
}

/** Run one job. Never throws for job-level failures: they are recorded on the job and surfaced. */
export async function runMediaJob(rt: MediaRuntime, userId: string, jobId: string): Promise<JobRunResult> {
  const owner = await first<{ status: string }>(rt.db, "SELECT status FROM users WHERE user_id = ?", userId);
  if (!owner) return "skipped";
  const ownerActive = owner.status === "active";
  if (!ownerActive) {
    // The job's verified owner is rechecked before any effect: a disabled account gets none - except the
    // removal of files that were already deleted, which only takes data away and must not wait.
    const kind = await first<{ kind: string }>(rt.db, "SELECT kind FROM media_jobs WHERE user_id = ? AND job_id = ?", userId, jobId);
    if (kind?.kind !== "purge_objects") return "skipped";
  }
  const job = await claim(rt, userId, jobId);
  if (!job) return "skipped";
  try {
    if (job.kind === "normalize") await runNormalizeJob(rt, job);
    else if (job.kind === "discover") await runDiscoveryJob(rt, job);
    else if (job.kind === "render_composite") await runRenderJob(rt, job);
    else await runPurge(rt, job, ownerActive);
    return "succeeded";
  } catch (e) {
    const message = (isCommandError(e) ? `${e.code}: ${e.message}` : String((e as Error)?.message ?? e)).slice(0, 500);
    // A purge is never given up: the owner was told the files are being removed. It stays queued with its
    // error, is retried by every maintenance sweep, and is reported until it succeeds.
    if (job.kind !== "purge_objects" && job.attempts >= job.max_attempts) {
      await execSystem(rt, userId, "media.fail_job", { jobId, error: message }, `job-failed:${jobId}`);
      return "dead";
    }
    await prepare(rt.db, stmt("UPDATE media_jobs SET state = 'queued', last_error = ?, lease_until = NULL, updated_at = ? WHERE user_id = ? AND job_id = ? AND state = 'running'", message, toInstant(rt.clock()), userId, jobId)).run();
    return "retry";
  }
}

function isJobMessage(body: unknown): body is MediaQueueMessage {
  const b = body as MediaQueueMessage | null;
  return !!b && typeof b === "object" && b.kind === "media.job" && typeof b.userId === "string" && typeof b.jobId === "string";
}

/** Queue consumer: call from the Worker's `queue(batch, env)` handler. */
export async function handleMediaQueue(rt: MediaRuntime, batch: MessageBatch<unknown>): Promise<{ results: Record<JobRunResult | "malformed", number> }> {
  const results: Record<JobRunResult | "malformed", number> = { succeeded: 0, skipped: 0, retry: 0, dead: 0, malformed: 0 };
  for (const message of batch.messages) {
    if (!isJobMessage(message.body)) {
      results.malformed++;
      message.ack(); // an unparseable message can never succeed; do not redeliver it
      continue;
    }
    const outcome = await runMediaJob(rt, message.body.userId, message.body.jobId);
    results[outcome]++;
    if (outcome === "retry") message.retry({ delaySeconds: 5 });
    else message.ack();
  }
  return { results };
}

/**
 * Run queued jobs directly from the ledger (scheduled sweep, or a deployment without a queue binding).
 * Also picks up jobs whose lease expired after a crash. With `idleForMs`, only jobs nobody has touched
 * for that long are taken: a job whose queue message was lost or whose retries ran out, without racing
 * the queue consumer for work it is about to do.
 *
 * Two separate selections, each with its own `limit`, so neither can crowd the other out:
 *   - removals of deleted files, for every account whatever its status, least recently tried first, so a
 *     removal that keeps failing does not hold back the others;
 *   - all other work, for ACTIVE accounts only. A disabled account's other jobs stay queued (they resume
 *     if the account is enabled again) but are never selected, so they cannot occupy the sweep.
 */
export async function runQueuedMediaJobs(rt: MediaRuntime, opts: { limit?: number; userId?: string; idleForMs?: number } = {}): Promise<Record<JobRunResult, number>> {
  const now = toInstant(rt.clock());
  const idleBefore = toInstant(rt.clock() - (opts.idleForMs ?? 0));
  const due = "((j.state = 'queued' AND j.updated_at <= ?) OR (j.state = 'running' AND j.lease_until < ?))";
  const forUser = opts.userId ? "AND j.user_id = ?" : "";
  const params = opts.userId ? [idleBefore, now, opts.userId] : [idleBefore, now];
  const limit = opts.limit ?? 10;
  const purges = await all<{ user_id: string; job_id: string }>(
    rt.db,
    `SELECT j.user_id, j.job_id FROM media_jobs j WHERE ${due} AND j.kind = 'purge_objects' ${forUser} ORDER BY j.updated_at, j.created_at, j.job_id LIMIT ?`,
    ...params,
    limit,
  );
  const others = await all<{ user_id: string; job_id: string }>(
    rt.db,
    `SELECT j.user_id, j.job_id FROM media_jobs j JOIN users u ON u.user_id = j.user_id WHERE ${due} AND j.kind != 'purge_objects' AND u.status = 'active' ${forUser} ORDER BY j.created_at, j.job_id LIMIT ?`,
    ...params,
    limit,
  );
  const out: Record<JobRunResult, number> = { succeeded: 0, skipped: 0, retry: 0, dead: 0 };
  for (const r of [...purges, ...others]) out[await runMediaJob(rt, r.user_id, r.job_id)]++;
  return out;
}

export interface MediaStorageStatus {
  /** Deletions the owner asked for whose stored files have not been removed yet. */
  deletionsPending: number;
  /** Of those, how many have failed at least once. */
  deletionsFailing: number;
  oldestPendingSince: string | null;
  lastError: string | null;
  note: string;
}

/** Whether everything the owner deleted has actually left storage. A failing removal is shown, never hidden. */
export async function getMediaStorageStatus(rt: MediaRuntime, principal: Principal): Promise<MediaStorageStatus> {
  assertPrincipal(principal);
  requireScope(principal, "read");
  const rows = await all<{ created_at: string; last_error: string | null; attempts: number }>(rt.db, "SELECT created_at, last_error, attempts FROM media_jobs WHERE user_id = ? AND kind = 'purge_objects' AND state IN ('queued', 'running', 'failed', 'dead') ORDER BY created_at", principal.userId);
  const failing = rows.filter((r) => r.last_error !== null);
  return {
    deletionsPending: rows.length,
    deletionsFailing: failing.length,
    oldestPendingSince: rows[0]?.created_at ?? null,
    lastError: failing.length > 0 ? failing[failing.length - 1]!.last_error : null,
    note:
      rows.length === 0
        ? "Everything that was deleted has been removed from storage."
        : failing.length > 0
          ? `${failing.length} deletion(s) could not be completed yet and are retried automatically; the image is no longer shown or served, but its stored files have not been removed.`
          : `${rows.length} deletion(s) are being completed.`,
  };
}

export async function listMediaJobs(rt: MediaRuntime, principal: Principal, opts: { limit?: number; state?: JobRow["state"] } = {}): Promise<MediaJobStatus[]> {
  assertPrincipal(principal);
  requireScope(principal, "read");
  const rows = await all<JobRow>(
    rt.db,
    `SELECT user_id, job_id, kind, subject_id, state, attempts, max_attempts, payload_json, last_error, updated_at FROM media_jobs WHERE user_id = ? ${opts.state ? "AND state = ?" : ""} ORDER BY updated_at DESC, job_id LIMIT ?`,
    ...(opts.state ? [principal.userId, opts.state] : [principal.userId]),
    Math.min(opts.limit ?? 50, 200),
  );
  return rows.map((r) => ({ jobId: r.job_id, kind: r.kind, subjectId: r.subject_id, state: r.state, attempts: r.attempts, lastError: r.last_error, updatedAt: r.updated_at }));
}
