import { prepare, stmt, toInstant } from "@garderobe/domain";
import type { App } from "./app.ts";

/**
 * Bounded retention of this workstream's own short-lived records: spent or expired one-time state,
 * old rate-limit windows, and export packages past their download window (the object and the job).
 */
export async function sweepExpired(app: App, nowMs: number): Promise<{ exportsExpired: number }> {
  const { db } = app;
  const now = toInstant(nowMs);
  const dayAgo = toInstant(nowMs - 86_400_000);
  const expired = await db.prepare("SELECT user_id, export_id, object_key FROM export_jobs WHERE expires_at IS NOT NULL AND expires_at <= ? AND state IN ('completed', 'completed_incomplete') LIMIT 50").bind(now).all<{ user_id: string; export_id: string; object_key: string | null }>();
  for (const job of expired.results) {
    if (job.object_key) await app.env.EXPORT_BUCKET.delete(job.object_key);
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
  return { exportsExpired: expired.results.length };
}
