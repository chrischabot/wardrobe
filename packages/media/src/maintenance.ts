/**
 * Scheduled upkeep, called from the Worker's daily/hourly sweep:
 *   - expire unfinished uploads and delete their staging bytes;
 *   - remove full-resolution selfie originals past the owner's photo-history setting;
 *   - start (and pace) background image discovery for garments never investigated;
 *   - put committed jobs on the queue and re-run jobs whose lease expired.
 * Every state change goes through the command service under the verified owner.
 */
import { all, isCommandError, toInstant } from "@garderobe/domain";
import { execSystem } from "./exec.ts";
import { dispatchMediaJobs, runQueuedMediaJobs } from "./jobs.ts";
import type { MediaRuntime } from "./runtime.ts";
import { FINALIZE_GRACE_MS } from "./commands/uploads.ts";
import { DISCOVERY_BATCH } from "./commands/discovery.ts";

export interface MaintenanceResult {
  expiredUploads: number;
  selfieOriginalsRemoved: number;
  discoveryQueued: number;
  jobsDispatched: number;
  staleJobsRun: number;
  errors: string[];
}

export async function runMediaMaintenance(rt: MediaRuntime, opts: { startDiscovery?: boolean } = {}): Promise<MaintenanceResult> {
  const now = toInstant(rt.clock());
  const result: MaintenanceResult = { expiredUploads: 0, selfieOriginalsRemoved: 0, discoveryQueued: 0, jobsDispatched: 0, staleJobsRun: 0, errors: [] };
  const attempt = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      result.errors.push(`${what}: ${isCommandError(e) ? `${e.code}: ${e.message}` : String((e as Error)?.message ?? e)}`.slice(0, 300));
    }
  };
  const day = now.slice(0, 10);

  // 1. Uploads never finalized: the authorization (plus grace) has lapsed.
  const cutoff = toInstant(rt.clock() - FINALIZE_GRACE_MS);
  const stale = await all<{ user_id: string; upload_id: string }>(rt.db, "SELECT m.user_id, m.upload_id FROM media_uploads m JOIN users u ON u.user_id = m.user_id WHERE u.status = 'active' AND m.state = 'authorized' AND m.expires_at < ? ORDER BY m.expires_at LIMIT 200", cutoff);
  const byUser = new Map<string, string[]>();
  for (const s of stale) byUser.set(s.user_id, [...(byUser.get(s.user_id) ?? []), s.upload_id]);
  for (const [userId, uploadIds] of byUser) {
    await attempt("expire uploads", async () => {
      const receipt = await execSystem(rt, userId, "media.expire_uploads", { uploadIds }, `expire-uploads:${userId}:${uploadIds[0]}:${uploadIds.length}`);
      result.expiredUploads += Number(receipt.result.expired ?? 0);
    });
  }

  // 2. Selfie originals past retention (the reduced outfit-history copy is kept).
  const due = await all<{ user_id: string; asset_id: string }>(
    rt.db,
    "SELECT a.user_id, a.asset_id FROM media_assets a JOIN users u ON u.user_id = a.user_id WHERE u.status = 'active' AND a.kind = 'selfie' AND a.status IN ('active', 'processing') AND a.original_purged_at IS NULL AND a.retain_original_until IS NOT NULL AND a.retain_original_until <= ? ORDER BY a.retain_original_until LIMIT 200",
    now,
  );
  const dueByUser = new Map<string, string[]>();
  for (const d of due) dueByUser.set(d.user_id, [...(dueByUser.get(d.user_id) ?? []), d.asset_id]);
  for (const [userId, assetIds] of dueByUser) {
    await attempt("selfie retention", async () => {
      const receipt = await execSystem(rt, userId, "media.apply_retention", { assetIds: assetIds.slice(0, 100) }, `retention:${userId}:${day}:${assetIds[0]}`);
      result.selfieOriginalsRemoved += Number(receipt.result.purgedOriginals ?? 0);
    });
  }

  // 3. Image discovery starts in the background for garments that were never investigated. Garments already
  //    deferred or in Photos needed are not re-queued here: a retry needs a new source or the owner's request.
  if (opts.startDiscovery !== false) {
    const fresh = await all<{ user_id: string; garment_id: string }>(
      rt.db,
      `SELECT g.user_id, g.garment_id FROM garments g JOIN users u ON u.user_id = g.user_id LEFT JOIN garment_media m ON m.user_id = g.user_id AND m.garment_id = g.garment_id
        WHERE u.status = 'active' AND g.acquisition != 'disposed' AND g.merged_into IS NULL AND g.removed_reason IS NULL AND g.is_synthetic = 0 AND m.garment_id IS NULL
        ORDER BY g.user_id, g.garment_id LIMIT 400`,
    );
    const freshByUser = new Map<string, string[]>();
    for (const f of fresh) freshByUser.set(f.user_id, [...(freshByUser.get(f.user_id) ?? []), f.garment_id]);
    for (const [userId, garmentIds] of freshByUser) {
      await attempt("start discovery", async () => {
        const batch = garmentIds.slice(0, DISCOVERY_BATCH);
        const receipt = await execSystem(rt, userId, "media.request_discovery", { garmentIds: batch, retry: false }, `discovery:${userId}:${day}:${batch[0]}`);
        result.discoveryQueued += Number(receipt.result.queued ?? 0);
      });
    }
  }

  // 4. Queue what was committed; run what a lost message or a crashed consumer left behind.
  await attempt("dispatch", async () => {
    result.jobsDispatched = (await dispatchMediaJobs(rt)).sent;
  });
  if (!rt.deps.queue) {
    await attempt("run jobs", async () => {
      const ran = await runQueuedMediaJobs(rt, { limit: 10 });
      result.staleJobsRun = ran.succeeded + ran.dead + ran.retry;
    });
  }
  return result;
}
