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
import { recordWriteIntent, settleWriteIntent } from "./write-intents.ts";
import type { MediaJobKind } from "./store.ts";
import { runNormalizeJob } from "./pipeline/normalize.ts";
import { runDiscoveryJob } from "./pipeline/discovery.ts";
import { runRenderJob } from "./pipeline/render.ts";
import { legacyThumbnailCacheUrl, thumbnailCacheUrl } from "./delivery.ts";
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

/** Claims the job; returns the claimed row and the lease expiry this claim wrote (the same value as in the database). */
async function claim(rt: MediaRuntime, userId: string, jobId: string): Promise<{ job: JobRow; leaseUntilMs: number } | null> {
  const nowMs = rt.clock();
  const now = toInstant(nowMs);
  const leaseUntilMs = nowMs + limitsOf(rt.deps).jobLeaseSeconds * 1000;
  const lease = toInstant(leaseUntilMs);
  const res = await prepare(
    rt.db,
    stmt(
      "UPDATE media_jobs SET state = 'running', attempts = attempts + 1, lease_until = ?, updated_at = ? WHERE user_id = ? AND job_id = ? AND (state = 'queued' OR (state = 'running' AND lease_until < ? AND (attempts < max_attempts OR kind = 'purge_objects'))) RETURNING user_id, job_id, kind, subject_id, state, attempts, max_attempts, payload_json, last_error, updated_at",
      lease, now, userId, jobId, now,
    ),
  ).first<JobRow>();
  // An expired run whose attempts are used up is never claimed again: it is abandoned (abandonIfExhausted) or left
  // for the next sweep to abandon, so a refused abandonment cannot start an attempt beyond the job's limit.
  // The attempt and the expiry come from the same statement that claimed the job: never another runner's.
  return res ? { job: res, leaseUntilMs } : null;
}

/**
 * A job whose earlier attempts never reported back (the isolate ran out of memory or time while it held
 * the lease, so neither the retry nor the failure path ran) has still used one attempt each time. Once
 * the allowance is spent the job is recorded as failed instead of being started again: otherwise every
 * sweep would start the same crashing work for ever, and take the rest of the sweep down with it.
 * A removal of deleted files is exempt: it is never given up (see `runMediaJob`).
 */
async function abandonIfExhausted(rt: MediaRuntime, userId: string, jobId: string): Promise<boolean> {
  const stuck = await first<{ attempts: number }>(
    rt.db,
    "SELECT attempts FROM media_jobs WHERE user_id = ? AND job_id = ? AND kind != 'purge_objects' AND state = 'running' AND lease_until < ? AND attempts >= max_attempts",
    userId, jobId, toInstant(rt.clock()),
  );
  if (!stuck) return false;
  // Fenced in the command's own commit: still that expired, exhausted attempt (a runner that renewed meanwhile, or a
  // new claim, is never failed).
  try {
    await execSystem(rt, userId, "media.fail_job", { jobId, attempt: stuck.attempts, abandonExpiredBefore: toInstant(rt.clock()), error: `abandoned after ${stuck.attempts} attempts that started and never finished` }, `job-abandoned:${jobId}:${stuck.attempts}`);
  } catch (e) {
    if (isCommandError(e) && e.code === "precondition_failed") return false;
    throw e;
  }
  return true;
}

async function runPurge(rt: MediaRuntime, job: JobRow, ownerActive: boolean, gate: <T>(effect: () => Promise<T>) => Promise<T>): Promise<void> {
  const payload = json<{ keys?: string[]; cacheShas?: string[] }>(job.payload_json, {});
  const keys = payload.keys ?? [];
  // Every key is re-checked against the job's owner before anything is deleted.
  for (const key of keys) assertOwnedKey(job.user_id, key);
  for (let i = 0; i < keys.length; i += 500) await rt.deps.bucket.delete(keys.slice(i, i + 500));
  let cachePurged = 0;
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  if (cache) {
    for (const sha of payload.cacheShas ?? []) {
      for (const width of MEDIA_THUMBNAIL_WIDTHS) {
        if (await cache.delete(thumbnailCacheUrl(job.user_id, sha, width))) cachePurged++;
        if (await cache.delete(legacyThumbnailCacheUrl(job.user_id, sha, width))) cachePurged++;
      }
    }
  }
  const result = { deletedObjects: keys.length, cacheEntriesPurged: cachePurged };
  if (ownerActive) {
    // Fenced on this run's attempt in the command's own commit (see job-fence.ts).
    await execSystem(rt, job.user_id, "media.complete_job", { jobId: job.job_id, attempt: job.attempts, result }, `job-done:${job.job_id}:${job.attempts}`);
    return;
  }
  // A disabled account accepts no commands, but its deleted files must still leave storage. Only the job
  // ledger's own bookkeeping is written here (as claiming a lease does); no wardrobe record changes. It is one
  // of the run's gated effects (started only while the run is live, and drained before the job is handed
  // back), and only under this run's own claim.
  await gate(() => prepare(rt.db, stmt("UPDATE media_jobs SET state = 'succeeded', result_json = ?, last_error = NULL, lease_until = NULL, updated_at = ? WHERE user_id = ? AND job_id = ? AND state = 'running' AND attempts = ?", JSON.stringify({ ...result, accountDisabled: true }), toInstant(rt.clock()), job.user_id, job.job_id, job.attempts)).run());
}

/**
 * The longest one run of a job may take, in lease periods, by kind (five-minute lease by default: ten minutes
 * for one photograph's normalization or one preview, fifteen for a discovery investigation of up to three
 * searches with two one-minute browser sessions, or a removal of many files).
 */
const RUN_DEADLINE_LEASES: Record<MediaJobKind, number> = { normalize: 2, render_composite: 2, discover: 3, purge_objects: 3 };

/** The runner-level deadline of one run of a job of this kind, in milliseconds. */
export function runDeadlineMs(rt: MediaRuntime, kind: MediaJobKind): number {
  return (RUN_DEADLINE_LEASES[kind] ?? 2) * limitsOf(rt.deps).jobLeaseSeconds * 1000;
}

/** The error a run that passed its deadline fails with; it then takes the ordinary retry or failure path. */
export class JobDeadlineError extends Error {
  constructor(kind: MediaJobKind, ms: number) {
    super(`the ${kind.replace(/_/g, " ")} job ran past its ${Math.round(ms / 1000)}-second time limit and was given up`);
    this.name = "JobDeadlineError";
  }
}

/**
 * The runtime one run's work sees: every effect it can have (a command through the command service, a file
 * written to or deleted from the bucket) goes through a gate tied to the run's abort signal. Once the signal
 * fires (the deadline passed, or the run ended), no new effect starts, so work that carries on after its
 * provider finally answers changes nothing. Effects already under way are tracked, and the runner waits for
 * them (still holding the lease) before it hands the job back, so none of them can land on a later attempt's claim.
 */
function gatedRuntime(rt: MediaRuntime, signal: AbortSignal, holdsClaim: () => boolean, deadlineAtMs: number, onDeadline: () => Error, writer: { userId: string; jobId: string; attempt: number }): { rt: MediaRuntime; gate: <T>(effect: () => Promise<T>) => Promise<T>; inFlight: () => Promise<unknown>[] } {
  const pending = new Set<Promise<unknown>>();
  /** Why no effect may start now, or null while the run is live. */
  const refusal = (): Error | null => {
    if (signal.aborted) return signal.reason instanceof Error ? signal.reason : new Error("the run was stopped");
    // The deadline is read from the clock, not only from its timer: synchronous work or a long chain of resolved
    // promises can delay the timer, and no effect may start once the deadline has actually passed.
    if (rt.clock() >= deadlineAtMs) return onDeadline();
    // Only while this run's lease is known to be current: a renewal that failed or came too late stops every effect.
    if (!holdsClaim()) return new Error("this run no longer holds the job's lease");
    return null;
  };
  const admit = (): void => {
    const refused = refusal();
    if (refused) throw refused;
  };
  const gate = <T>(effect: () => Promise<T>): Promise<T> => {
    const refused = refusal();
    if (refused) return Promise.reject(refused);
    const p = effect();
    pending.add(p);
    p.then(() => pending.delete(p), () => pending.delete(p));
    return p;
  };
  const service = new Proxy(rt.service, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if (key === "execute") return (...args: unknown[]) => gate(() => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args));
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  const bucket = new Proxy(rt.deps.bucket, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      // Each write is recorded as an intent before it starts (migration 0405): if it lands after this run let
      // its lease go, the maintenance sweep removes the file unless a live record names it.
      if (key === "put") {
        return (...args: unknown[]) =>
          gate(async () => {
            const objectKey = String(args[0]);
            const writeId = await recordWriteIntent(rt, writer, objectKey);
            // Admission is checked again now that the intent is recorded: if the run stopped or lost its lease while
            // registering, the write never starts (and its intent is settled at once).
            const refused = refusal();
            if (refused) {
              await settleWriteIntent(rt, writer, objectKey, writeId).catch(() => undefined);
              throw refused;
            }
            try {
              return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
            } finally {
              // Bookkeeping only: the write has finished and can no longer land later. If this fails the intent stays
              // unsettled and is watched by the sweep (write-intents.ts).
              await settleWriteIntent(rt, writer, objectKey, writeId).catch(() => undefined);
            }
          });
      }
      if (key === "delete") return (...args: unknown[]) => gate(() => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args));
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  // The work's runtime carries the gate and the admission check itself (MediaRuntime.gate / .admit, runtime.ts): the
  // pipelines (runDiscoveryJob in particular) read them from the runtime they are given, never fall back to ungated.
  const jobRt: MediaRuntime = { ...rt, service, deps: { ...rt.deps, bucket }, gate, admit };
  return { rt: jobRt, gate, inFlight: () => [...pending] };
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
  if (ownerActive && (await abandonIfExhausted(rt, userId, jobId))) return "dead";
  const claimed = await claim(rt, userId, jobId);
  if (!claimed) return "skipped";
  const job = claimed.job;
  // Ownership of the job is the lease, and every effect of this run is fenced on it:
  //  - The claim and each renewal are written only under this run's attempt (state = 'running' AND attempts = N).
  //    Another runner can claim the job only once lease_until has passed, so while this run's lease is confirmed
  //    current nobody else can hold the job.
  //  - heldUntil is the expiry this run last WROTE (the claim's own value, then each renewal that matched its
  //    row). Renewals never overlap (one at a time), so the database never holds an earlier expiry than heldUntil.
  //  - A renewal that fails or matches no row means ownership is lost: the run is stopped at once.
  //  - Every effect of the work (command, bucket put or delete, the disabled-owner purge completion) passes a
  //    gate that admits it only while the run has not been stopped and heldUntil is at least a third of a lease
  //    away; renewals every third of a lease keep about two thirds of a lease in hand while the run is healthy.
  //  - The run has a deadline by job kind. At the deadline (or any failure, or lost ownership) the run is stopped:
  //    no new effect starts, effects already under way are drained while renewal keeps holding the lease, and
  //    before anything is written to finish the job the run re-confirms ownership with a renewal (see below).
  //    Renewal only ends when the run has finished with the job.
  const leaseMs = limitsOf(rt.deps).jobLeaseSeconds * 1000;
  const deadlineMs = runDeadlineMs(rt, job.kind);
  const controller = new AbortController();
  const stop = (reason: Error) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  let heldUntil = claimed.leaseUntilMs;
  const holdsClaim = () => rt.clock() + leaseMs / 3 < heldUntil;
  let renewing = true;
  let lost = false;
  let renewal: Promise<boolean> | null = null;
  /**
   * One renewal, never two at once. It extends the lease only while this run's attempt holds it AND the lease it
   * holds has not expired: a late renewal cannot revive a lapsed lease. Any failure or zero-row result is lost
   * ownership, which is final for this run.
   */
  const renewOnce = (): Promise<boolean> => {
    if (lost) return Promise.resolve(false);
    if (renewal) return renewal;
    const nowMs = rt.clock();
    const until = nowMs + leaseMs;
    const heldBefore = heldUntil;
    // Matches only this run's attempt holding exactly the lease it last wrote, still unexpired at the time the
    // renewal was sent. Because the update may reach the database later than that, its result is accepted only if
    // it arrived before that lease ran out: a renewal answered after expiry counts as lost ownership, so a lapsed
    // lease is never treated as revived (whatever the database did, the run stops and its lease then lapses).
    renewal = prepare(rt.db, stmt("UPDATE media_jobs SET lease_until = ? WHERE user_id = ? AND job_id = ? AND state = 'running' AND attempts = ? AND lease_until = ? AND lease_until > ?", toInstant(until), userId, jobId, job.attempts, toInstant(heldBefore), toInstant(nowMs)))
      .run()
      .then(
        (res) => {
          if ((res.meta?.changes ?? 0) === 1 && rt.clock() < heldBefore) {
            heldUntil = until;
            return true;
          }
          lost = true;
          stop(new Error("this run no longer holds the job (its lease lapsed, or it was reclaimed or finished)"));
          return false;
        },
        () => {
          lost = true;
          stop(new Error("the job's lease could not be renewed"));
          return false;
        },
      )
      .finally(() => {
        renewal = null;
      });
    return renewal;
  };
  // Renewal continues until this run has finished with the job (through draining and the finishing write), not
  // merely until its work stops.
  const renew = setInterval(() => {
    if (!renewing || lost) {
      clearInterval(renew);
      return;
    }
    void renewOnce();
  }, Math.max(100, Math.floor(leaseMs / 3)));
  const deadlineAtMs = rt.clock() + deadlineMs;
  const deadlineError = () => {
    const err = new JobDeadlineError(job.kind, deadlineMs);
    stop(err);
    return controller.signal.reason instanceof Error ? controller.signal.reason : err;
  };
  const deadline = setTimeout(deadlineError, deadlineMs);
  const pastDeadline = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }));
  const gated = gatedRuntime(rt, controller.signal, holdsClaim, deadlineAtMs, deadlineError, { userId, jobId, attempt: job.attempts });
  const work = async () => {
    const jrt = gated.rt;
    if (job.kind === "normalize") await runNormalizeJob(jrt, job);
    else if (job.kind === "discover") await runDiscoveryJob(jrt, job);
    else if (job.kind === "render_composite") await runRenderJob(jrt, job);
    else await runPurge(jrt, job, ownerActive, gated.gate);
  };
  /** What the job's current state means for this run, when it is no longer running under this run's attempt. */
  const currentOutcome = async (): Promise<JobRunResult> => {
    const row = await first<{ state: string; attempts: number }>(rt.db, "SELECT state, attempts FROM media_jobs WHERE user_id = ? AND job_id = ?", userId, jobId);
    if (!row || row.attempts !== job.attempts) return "skipped"; // another attempt holds it now
    if (row.state === "succeeded") return "succeeded";
    if (row.state === "failed" || row.state === "dead") return "dead";
    return "skipped";
  };
  try {
    await Promise.race([work(), pastDeadline]);
    return "succeeded";
  } catch (e) {
    stop(e instanceof Error ? e : new Error("the run failed"));
    // Effects already under way finish first, while renewal continues to hold the lease for them, but for at most
    // one lease period: an effect that never settles must not hold the job for ever. If they have not settled by
    // then, the run writes nothing more and lets its lease lapse so the job is reclaimed. A command still under way
    // is refused by the attempt fence; a file write still under way was recorded as an intent before it started,
    // and the maintenance sweep removes its file once it has landed unless a live record names it (write-intents.ts).
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      Promise.allSettled(gated.inFlight()).then(() => true),
      new Promise<boolean>((resolve) => (drainTimer = setTimeout(() => resolve(false), leaseMs))),
    ]);
    clearTimeout(drainTimer);
    // Finishing (every database call below, the confirming renewal included) is itself bounded by one lease: a
    // stalled database operation cannot hold the run for ever. Past the bound the run reports "skipped" and lets
    // its lease lapse; a finishing write that lands later is still fenced on this run's attempt.
    let finishTimer: ReturnType<typeof setTimeout> | undefined;
    /** Set when the finishing bound passes: from then on finish() starts no further write. */
    let finishAbandoned = false;
    const finish = async (): Promise<JobRunResult> => {
    if (!drained) return currentOutcome();
    // Finishing: ownership is confirmed by a renewal made now (it matches only this run's attempt holding an
    // unexpired lease). Renewal keeps running through the finishing write. If ownership is gone (an effect under
    // way completed the job, it failed, or the lease lapsed and another runner may hold it), nothing is written
    // and the job's actual state is reported.
    if (!(await renewOnce()) || !holdsClaim() || finishAbandoned) return finishAbandoned ? "skipped" : currentOutcome();
    const message = (isCommandError(e) ? `${e.code}: ${e.message}` : String((e as Error)?.message ?? e)).slice(0, 500);
    // A purge is never given up: the owner was told the files are being removed. It stays queued with its
    // error, is retried by every maintenance sweep, and is reported until it succeeds.
    if (job.kind !== "purge_objects" && job.attempts >= job.max_attempts) {
      // Fenced on this run's attempt inside the command's own commit (job-fence.ts): if the job completed or was
      // reclaimed meanwhile, the failure is refused and writes nothing.
      try {
        if (finishAbandoned) return "skipped";
        await execSystem(rt, userId, "media.fail_job", { jobId, attempt: job.attempts, error: message }, `job-failed:${jobId}:${job.attempts}`);
      } catch (failure) {
        // Refused or failed: if the job is no longer running under this attempt (it completed meanwhile), report that.
        const outcome = await currentOutcome();
        if (outcome === "skipped") throw failure;
        return outcome;
      }
      return "dead";
    }
    if (finishAbandoned) return "skipped";
    const requeued = await prepare(rt.db, stmt("UPDATE media_jobs SET state = 'queued', last_error = ?, lease_until = NULL, updated_at = ? WHERE user_id = ? AND job_id = ? AND state = 'running' AND attempts = ?", message, toInstant(rt.clock()), userId, jobId, job.attempts)).run();
    return (requeued.meta?.changes ?? 0) === 1 ? "retry" : currentOutcome();
    };
    try {
      return await Promise.race([finish(), new Promise<JobRunResult>((resolve) => (finishTimer = setTimeout(() => { finishAbandoned = true; resolve("skipped"); }, leaseMs)))]);
    } finally {
      clearTimeout(finishTimer);
    }
  } finally {
    stop(new Error("the run ended"));
    renewing = false;
    clearInterval(renew);
    clearTimeout(deadline);
  }
}

/** An identifier as this service writes them: printable, without spaces, of bounded length. Anything else cannot name a job. */
const MESSAGE_ID = /^[\x21-\x7e]{1,200}$/;

function isJobMessage(body: unknown): body is MediaQueueMessage {
  const b = body as MediaQueueMessage | null;
  return !!b && typeof b === "object" && !Array.isArray(b) && b.kind === "media.job" && typeof b.userId === "string" && typeof b.jobId === "string" && MESSAGE_ID.test(b.userId) && MESSAGE_ID.test(b.jobId);
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
    // One message's unexpected failure (storage or database unavailable for that job) is that message's
    // alone: it is retried by itself, and the rest of the batch is still worked through.
    let outcome: JobRunResult;
    try {
      outcome = await runMediaJob(rt, message.body.userId, message.body.jobId);
    } catch (e) {
      console.warn("media job message failed and will be retried", String((e as Error)?.message ?? e).slice(0, 200));
      outcome = "retry";
    }
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
