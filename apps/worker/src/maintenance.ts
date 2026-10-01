import { prepare, stmt, toInstant, all } from "@garderobe/domain";
import type { App } from "./app.ts";
import { finishApiRun } from "./runs.ts";
import { restoreManifestKey } from "./export/job.ts";

/** A recommendation run still marked running after this long lost its background work (the isolate ended). */
const RECOMMENDATION_RUN_LIMIT_MS = 10 * 60_000;

/**
 * Bounded retention of this workstream's own short-lived records: spent or expired one-time state,
 * old rate-limit windows, and export packages past their download window (the object and the job).
 */
export async function sweepExpired(app: App, nowMs: number): Promise<{ exportsExpired: number }> {
  const { db } = app;
  const now = toInstant(nowMs);
  const dayAgo = toInstant(nowMs - 86_400_000);
  // The newest complete backup of an owner is kept even past its retention, so there is always one to restore.
  const expired = await db
    .prepare(
      `SELECT user_id, export_id, object_key, purpose FROM export_jobs j WHERE expires_at IS NOT NULL AND expires_at <= ? AND state IN ('completed', 'completed_incomplete')
         AND NOT (purpose = 'backup' AND export_id = (SELECT export_id FROM export_jobs n WHERE n.user_id = j.user_id AND n.purpose = 'backup' AND n.state IN ('completed', 'completed_incomplete') ORDER BY n.requested_at DESC LIMIT 1))
       LIMIT 50`,
    )
    .bind(now)
    .all<{ user_id: string; export_id: string; object_key: string | null; purpose: string }>();
  for (const job of expired.results) {
    if (job.object_key) await app.env.EXPORT_BUCKET.delete(job.object_key);
    if (job.purpose === "backup") await app.env.EXPORT_BUCKET.delete(restoreManifestKey(job.user_id, job.export_id));
    await db.batch(
      [
        stmt("DELETE FROM export_tickets WHERE user_id = ? AND export_id = ?", job.user_id, job.export_id),
        stmt("UPDATE export_jobs SET state = 'expired', object_key = NULL WHERE user_id = ? AND export_id = ?", job.user_id, job.export_id),
      ].map((s) => prepare(db, s)),
    );
  }
  await db.batch(
    [
      stmt("DELETE FROM auth_rate_limits WHERE window_start < ?", Math.floor(nowMs / 1000) - 2 * 86_400),
      stmt("DELETE FROM connection_oauth_states WHERE expires_at < ?", dayAgo),
      stmt("DELETE FROM identity_link_tickets WHERE expires_at < ?", dayAgo),
      stmt("DELETE FROM export_tickets WHERE expires_at < ?", dayAgo),
      stmt("UPDATE recovery_transactions SET status = 'expired' WHERE status = 'open' AND expires_at < ?", now),
    ].map((s) => prepare(db, s)),
  );
  // A run is never left "running" for ever: one whose work was lost is reported as failed, to be asked again.
  const lost = await all<{ user_id: string; run_id: string }>(db, "SELECT user_id, run_id FROM api_runs WHERE provider = 'api' AND kind = 'recommendation' AND state = 'running' AND updated_at < ? LIMIT 50", toInstant(nowMs - RECOMMENDATION_RUN_LIMIT_MS));
  for (const run of lost) {
    await finishApiRun(db, run.user_id, run.run_id, { state: "failed", error: { code: "internal", message: "The recommendation was interrupted before it finished. Ask again.", resumable: false } }, nowMs);
  }
  return { exportsExpired: expired.results.length };
}
