/**
 * Removal of files a job wrote that no live record names (migration 0405). Every write a job run makes is
 * recorded as an intent before it starts and marked settled when it finishes (see `gatedRuntime` in jobs.ts). A
 * write still under way when its run was stopped can land at any later moment, after a newer attempt finished or
 * after the image was deleted and its files purged.
 *
 * A key is looked at once every intent on it is past its own `settle_after` (fixed at write time from the bounds of
 * the run that wrote it, so a later change of the lease setting cannot shorten it) and no writer of it holds a live
 * lease. A file that a live record (an active rendition, or an outfit preview) names is kept. Any other file is
 * removed under a durable cleanup claim: while the claim stands, no job can start a write to that key (its intent
 * insert is refused and the job is retried later), so a newer run cannot publish the key during the removal.
 *
 * Intents are retired only once their write is known to have finished (settled). An unsettled intent stays
 * watched, and the key is checked again by later sweeps (least recently checked first), so a write that lands late
 * is removed - also after the key was kept once and its image deleted since. An unsettled intent is dropped one day
 * after its write began: a write cannot land after the Worker invocation that issued it has ended, and no
 * invocation runs that long.
 */
import { all, first, prepare, stmt, toInstant, type Stmt as Statement } from "@garderobe/domain";
import { assertOwnedKey } from "./keys.ts";
import { limitsOf, type MediaRuntime } from "./runtime.ts";

/** How long an unsettled intent is watched after its write began. Longer than any Worker invocation can run. */
export const ABANDONED_WRITE_WATCH_MS = 86_400_000;

/** An intent this old belongs to a run that has certainly stopped: its deadline, draining and finishing are each bounded in lease periods. */
export function writeSettleMs(rt: MediaRuntime): number {
  return 6 * limitsOf(rt.deps).jobLeaseSeconds * 1000;
}

/** The error a job write fails with while the sweep is removing the file at that key; the job is retried later. */
export class WriteCleanupInProgressError extends Error {
  constructor() {
    super("a stale copy of this file is being removed now, so it cannot be written yet; the job is tried again later");
    this.name = "WriteCleanupInProgressError";
  }
}

export interface WriteIntentOwner { userId: string; jobId: string; attempt: number }

/** SQL (two parameters: user, key): a cleanup claim on this key is live (at the time bound as the third parameter). */
const CLEANUP_LIVE = "EXISTS (SELECT 1 FROM media_write_cleanups WHERE user_id = ? AND object_key = ? AND expires_at > ?)";

/**
 * The precondition every job result that publishes stored files carries: none of those files is being removed by
 * the sweep now. A result checked in the same commit as its writes either commits before the sweep's claim (and
 * the sweep, which checks references again under its claim, keeps the file) or is refused while the claim stands
 * (the job is retried and writes the file again once the removal is over). This also covers a result command that
 * was dispatched before its writer's lease expired and arrives late.
 */
export function cleanupFence(userId: string, keys: readonly string[], now: string) {
  const unique = [...new Set(keys)];
  return {
    label: "none of the files this result names is being removed as a stale copy now",
    sql: unique.length === 0 ? "1 = 1" : `NOT EXISTS (SELECT 1 FROM media_write_cleanups WHERE user_id = ? AND object_key IN (${unique.map(() => "?").join(",")}) AND expires_at > ?)`,
    params: unique.length === 0 ? [] : [userId, ...unique, now],
    class: "state" as const,
  };
}

/** Record a write before it starts. Refused (throws) while the sweep holds a cleanup claim on the key. Returns the write's own intent id. */
export async function recordWriteIntent(rt: MediaRuntime, w: WriteIntentOwner, objectKey: string): Promise<string> {
  assertOwnedKey(w.userId, objectKey);
  const nowMs = rt.clock();
  const now = toInstant(nowMs);
  const writeId = crypto.randomUUID();
  const res = await prepare(rt.db, stmt(
    `INSERT INTO media_write_intents (user_id, object_key, job_id, job_attempt, write_id, created_at, settle_after, settled_at, checked_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, NULL, NULL WHERE NOT ${CLEANUP_LIVE}`,
    w.userId, objectKey, w.jobId, w.attempt, writeId, now, toInstant(nowMs + writeSettleMs(rt)),
    w.userId, objectKey, now,
  )).run();
  if ((res.meta?.changes ?? 0) === 0) throw new WriteCleanupInProgressError();
  return writeId;
}

/** Mark one recorded write finished (stored, failed or never started): it can no longer land later. */
export async function settleWriteIntent(rt: MediaRuntime, w: WriteIntentOwner, objectKey: string, writeId: string): Promise<void> {
  await prepare(rt.db, stmt("UPDATE media_write_intents SET settled_at = ? WHERE user_id = ? AND object_key = ? AND write_id = ?", toInstant(rt.clock()), w.userId, objectKey, writeId)).run();
}

/** The precondition every job result carries: none of the attempt's files was removed by the sweep (media_swept_attempts). */
export function sweptAttemptFence(userId: string, jobId: string, attempt: number) {
  return {
    label: "no file this run wrote was removed as an abandoned write",
    sql: "NOT EXISTS (SELECT 1 FROM media_swept_attempts WHERE user_id = ? AND job_id = ? AND job_attempt = ?)",
    params: [userId, jobId, attempt],
    class: "state" as const,
  };
}

/** SQL (five parameters: user, key, user, key, key): a live record names this file. */
const REFERENCED = `(EXISTS (SELECT 1 FROM media_renditions r JOIN media_assets a ON a.user_id = r.user_id AND a.asset_id = r.asset_id
                      WHERE r.user_id = ? AND r.object_key = ? AND r.status != 'deleted' AND a.status NOT IN ('deleted', 'rejected'))
  OR EXISTS (SELECT 1 FROM outfit_composites c WHERE c.user_id = ? AND (c.preview_key = ? OR c.svg_key = ?)))`;

/** SQL (four parameters: user, key, now, now): a writer of this key may still be running (its intent is not yet past settle_after, or its job attempt holds a live lease). */
const WRITER_LIVE = `EXISTS (SELECT 1 FROM media_write_intents i WHERE i.user_id = ? AND i.object_key = ? AND (i.settle_after >= ?
    OR EXISTS (SELECT 1 FROM media_jobs j WHERE j.user_id = i.user_id AND j.job_id = i.job_id AND j.attempts = i.job_attempt AND j.state = 'running' AND j.lease_until > ?)))`;

export interface AbandonedWriteSweep {
  /** Files kept because a live record names them. */
  kept: number;
  /** Files removed because no live record names them (a watched key with no file behind it is not counted). */
  removed: number;
}

export async function sweepAbandonedWrites(rt: MediaRuntime, opts: { limit?: number } = {}): Promise<AbandonedWriteSweep> {
  const nowMs = rt.clock();
  const now = toInstant(nowMs);
  const watchedBefore = toInstant(nowMs - ABANDONED_WRITE_WATCH_MS);
  // Keys whose every intent is past its settle time; never-checked keys first, then the least recently checked,
  // so watched keys cannot crowd newer ones out of a limited batch.
  const due = await all<{ user_id: string; object_key: string }>(
    rt.db,
    `SELECT user_id, object_key FROM media_write_intents GROUP BY user_id, object_key HAVING MAX(settle_after) < ?
      ORDER BY MAX(checked_at IS NOT NULL), MAX(COALESCE(checked_at, '')), MIN(created_at) LIMIT ?`,
    now, opts.limit ?? 500,
  );
  const out: AbandonedWriteSweep = { kept: 0, removed: 0 };
  // Swept attempts that can no longer report (their job is not running under them any more) need no fence.
  await prepare(rt.db, stmt("DELETE FROM media_swept_attempts WHERE NOT EXISTS (SELECT 1 FROM media_jobs j WHERE j.user_id = media_swept_attempts.user_id AND j.job_id = media_swept_attempts.job_id AND j.attempts = media_swept_attempts.job_attempt AND j.state = 'running')")).run();
  /** The writes on a key already known to have finished; read before the key's storage is checked. */
  const settledIds = async (userId: string, key: string): Promise<string[]> =>
    (await all<{ write_id: string }>(rt.db, "SELECT write_id FROM media_write_intents WHERE user_id = ? AND object_key = ? AND settled_at IS NOT NULL", userId, key)).map((r) => r.write_id);
  /**
   * Retire only the intents whose write had finished before this check of the key began (a write that settles
   * during the check may have landed after it, so it stays for the next sweep), and unsettled ones past the
   * watch. The rest are marked checked.
   */
  const retire = (userId: string, key: string, settled: string[]): Statement[] => [
    ...(settled.length > 0 ? [stmt(`DELETE FROM media_write_intents WHERE user_id = ? AND object_key = ? AND write_id IN (${settled.map(() => "?").join(",")})`, userId, key, ...settled)] : []),
    stmt("DELETE FROM media_write_intents WHERE user_id = ? AND object_key = ? AND settled_at IS NULL AND settle_after < ? AND created_at < ?", userId, key, now, watchedBefore),
    stmt("UPDATE media_write_intents SET checked_at = ? WHERE user_id = ? AND object_key = ?", now, userId, key),
  ];
  const run = async (statements: Statement[]) => {
    for (const s of statements) await prepare(rt.db, s).run();
  };
  for (const { user_id: userId, object_key: key } of due) {
    assertOwnedKey(userId, key);
    const settledBefore = await settledIds(userId, key);
    const live = await first<{ referenced: number; writer: number }>(rt.db, `SELECT ${REFERENCED} AS referenced, ${WRITER_LIVE} AS writer`, userId, key, userId, key, key, userId, key, now, now);
    if (live?.writer === 1) continue; // a run that may still be writing this key: left alone for now
    if (live?.referenced === 1) {
      await run(retire(userId, key, settledBefore));
      out.kept++;
      continue;
    }
    // Claim the key for removal, only while no writer may be running. From now until the claim is released, no job
    // can start a write to it (recordWriteIntent is refused). The claim is released as soon as the removal has
    // completed; if this sweep stops first, the claim lapses only after ABANDONED_WRITE_WATCH_MS, longer than any
    // Worker invocation runs, so a removal still pending can no longer land once a new writer is admitted. Each
    // claim is taken at its own moment, not the start of the batch.
    const claimedMs = rt.clock();
    const claimedAt = toInstant(claimedMs);
    const claim = await prepare(rt.db, stmt(
      `INSERT INTO media_write_cleanups (user_id, object_key, claimed_at, expires_at)
       SELECT ?, ?, ?, ? WHERE NOT ${WRITER_LIVE}
       ON CONFLICT (user_id, object_key) DO UPDATE SET claimed_at = excluded.claimed_at, expires_at = excluded.expires_at WHERE media_write_cleanups.expires_at <= excluded.claimed_at`,
      userId, key, claimedAt, toInstant(claimedMs + ABANDONED_WRITE_WATCH_MS),
      userId, key, claimedAt, claimedAt,
    )).run();
    if ((claim.meta?.changes ?? 0) === 0) continue;
    let completed = false;
    try {
      // Read before the storage check: only writes already finished now are known to be covered by it.
      const settled = await settledIds(userId, key);
      // Checked again under the claim: a record committed meanwhile keeps the file. (A result that commits after
      // the claim is refused by its cleanup fence.)
      const still = await first<{ n: number }>(rt.db, `SELECT ${REFERENCED} AS n`, userId, key, userId, key, key);
      if (still?.n === 1) {
        await run(retire(userId, key, settled));
        out.kept++;
        completed = true;
        continue;
      }
      // Before the removal (still under the claim): every run that wrote this key is marked swept, so a result of
      // theirs arriving at any later moment, even after the claim is released, is refused in its commit. (Only
      // attempts still current can report at all; a superseded attempt is refused by the job fence already.)
      await prepare(rt.db, stmt("INSERT INTO media_swept_attempts (user_id, job_id, job_attempt, swept_at) SELECT DISTINCT i.user_id, i.job_id, i.job_attempt, ? FROM media_write_intents i WHERE i.user_id = ? AND i.object_key = ? AND EXISTS (SELECT 1 FROM media_jobs j WHERE j.user_id = i.user_id AND j.job_id = i.job_id AND j.attempts = i.job_attempt AND j.state = 'running') ON CONFLICT DO NOTHING", claimedAt, userId, key)).run();
      if (await rt.deps.bucket.head(key)) {
        await rt.deps.bucket.delete(key);
        out.removed++;
      }
      completed = true;
      await run(retire(userId, key, settled));
    } finally {
      // Released only once nothing this sweep started on the key can still land; otherwise it is left to lapse.
      if (completed) await prepare(rt.db, stmt("DELETE FROM media_write_cleanups WHERE user_id = ? AND object_key = ? AND claimed_at = ?", userId, key, claimedAt)).run();
    }
  }
  return out;
}
