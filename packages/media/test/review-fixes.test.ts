import { beforeAll, describe, expect, it } from "vitest";
import { all, first, isCommandError } from "@garderobe/domain";
import type { TestOwner } from "@garderobe/domain/testing";
import {
  authorizeUpload, dispatchMediaJobs, getComposition, getGarmentMedia, getMediaStorageStatus, openCompositePreview, receiveUploadContent, requestCompositePreview, runMediaJob, runMediaMaintenance,
} from "../src/index.ts";
import { execSystem } from "../src/exec.ts";
import { encodePng } from "../src/image/index.ts";
import { createMediaHarness, syntheticShirt, syntheticTrousers, type MediaHarness } from "../src/testing/index.ts";

// Regression tests for the independent review of this package (findings H1, M1, M2).
// SYNTHETIC TEST IMAGES on synthetic fixture garments. The storage outage is simulated by a proxy around the
// real local R2 bucket whose delete() throws; the exporter is a TEST DOUBLE used only to act mid-render.

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return isCommandError(e) ? e.code : `threw:${String(e)}`;
  }
}

const OUTFIT = [{ role: "top", garmentId: "shirt-moss" }, { role: "bottom", garmentId: "trouser-olive" }] as const;

describe("review H1: a preview rendered across a deletion is never stored or served", () => {
  let h: MediaHarness;
  const compositesOf = async (o: TestOwner) => (await h.bindings.MEDIA_BUCKET.list({ prefix: `u/${o.userId}/composites/` })).objects.map((x) => x.key);

  beforeAll(async () => {
    h = await createMediaHarness();
  });

  it("discards the preview when the photo is deleted and purged while the render already holds its bytes", async () => {
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (H1 mid-render)" });
    const shirt = await h.upload(owner, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 256 }), demo: true });
    await h.upload(owner, { garmentId: "trouser-olive", raster: syntheticTrousers({ size: 256 }), demo: true });
    await h.settle(owner);
    let acted = 0;
    // Called by the render job after it has read the garment images and before it stores anything.
    h.deps.previewExporter = {
      name: "test-double-exporter",
      async renderSvgToPng() {
        if (acted++ === 0) {
          const receipt = await owner.exec("media.delete_asset", { assetId: shirt.asset!.assetId });
          expect(await runMediaJob(h.rt, owner.userId, String(receipt.result.purgeJobId))).toBe("succeeded"); // the deletion's purge finishes first
        }
        return { ok: false, reason: "use the built-in compositor" };
      },
    };
    const { receipt, manifestHash } = await requestCompositePreview(h.rt, owner.principal(), { slots: [...OUTFIT] });
    await h.settle(owner);
    h.deps.previewExporter = undefined;
    expect(acted).toBe(1);

    const composition = await getComposition(h.rt, owner.principal(), manifestHash);
    expect(composition.preview).toMatchObject({ state: "none", sha256: null, renderedAt: null, failure: "an image it used was deleted" });
    expect(await code(openCompositePreview(h.rt, owner.principal(), manifestHash))).toBe("not_found");
    expect(await code(openCompositePreview(h.rt, owner.principal(), manifestHash, "svg"))).toBe("not_found");
    expect(await compositesOf(owner)).toEqual([]); // neither the PNG nor the SVG scene is in storage
    const job = await first<{ state: string; result_json: string }>(h.db, "SELECT state, result_json FROM media_jobs WHERE user_id = ? AND job_id = ?", owner.userId, String(receipt.result.jobId));
    expect(job!.state).toBe("succeeded");
    expect(JSON.parse(job!.result_json)).toMatchObject({ discarded: true });
    expect(await all(h.db, "SELECT 1 FROM commands WHERE user_id = ? AND type = 'media.record_composite'", owner.userId)).toHaveLength(0);
    expect((await h.service.listReceipts(owner.principal(), { kind: "outfit_composite", entityId: manifestHash })).map((r) => r.type)).toContain("media.discard_composite");
  });

  it("record_composite itself refuses a finished render whose image is gone, and purges what the render wrote", async () => {
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (H1 record)" });
    const shirt = await h.upload(owner, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 256 }), demo: true });
    await h.settle(owner);
    // The preview is requested but its job has not been delivered yet (nothing dispatches the outbox here).
    const requested = await owner.exec("media.request_composite_preview", { slots: [...OUTFIT] });
    const hash = String(requested.result.manifestHash);
    const jobId = String(requested.result.jobId);
    // A render that raced the deletion has already written its files...
    const png = `u/${owner.userId}/composites/${hash}.png`, svg = `u/${owner.userId}/composites/${hash}.svg`;
    await h.bindings.MEDIA_BUCKET.put(png, await encodePng(syntheticShirt({ size: 64 })));
    await h.bindings.MEDIA_BUCKET.put(svg, "<svg/>");
    // ...case 1: the image is deleted and the composite was invalidated by that deletion.
    await owner.exec("media.delete_asset", { assetId: shirt.asset!.assetId });
    const recorded = await execSystem(h.rt, owner.userId, "media.record_composite", { manifestHash: hash, jobId, previewKey: png, previewSha256: "a".repeat(64), previewBytes: 100, svgKey: svg, renderer: "raced" }, `raced-record:${jobId}`);
    expect(recorded.summary).toBe("The outfit preview was discarded: an image it used was deleted");
    expect(recorded.result).toMatchObject({ discarded: true });
    await h.settle(owner);
    expect(await compositesOf(owner)).toEqual([]);
    expect((await getComposition(h.rt, owner.principal(), hash)).preview.state).toBe("none");
    expect(await code(openCompositePreview(h.rt, owner.principal(), hash))).toBe("not_found");

    // ...case 2: the composite still says "queued" but a rendition it names is no longer active (replaced).
    const second = await h.createSyntheticOwner({ displayName: "Synthetic owner (H1 replaced rendition)" });
    await h.upload(second, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 256 }), demo: true });
    await h.settle(second);
    const again = await second.exec("media.request_composite_preview", { slots: [...OUTFIT] });
    const hash2 = String(again.result.manifestHash);
    await h.db.prepare("UPDATE media_renditions SET status = 'superseded' WHERE user_id = ? AND kind = 'cutout'").bind(second.userId).run();
    const key2 = `u/${second.userId}/composites/${hash2}.png`;
    await h.bindings.MEDIA_BUCKET.put(key2, await encodePng(syntheticShirt({ size: 64 })));
    const stale = await execSystem(h.rt, second.userId, "media.record_composite", { manifestHash: hash2, jobId: String(again.result.jobId), previewKey: key2, previewSha256: "b".repeat(64), previewBytes: 100, svgKey: null, renderer: "raced" }, `raced-record:${again.result.jobId}`);
    expect(stale.result).toMatchObject({ discarded: true, reason: "an image it used was deleted or replaced while the preview was being prepared" });
    await h.settle(second);
    expect(await compositesOf(second)).toEqual([]);
    expect((await getComposition(h.rt, second.principal(), hash2)).preview).toMatchObject({ state: "none", failure: "an image it used was deleted or replaced while the preview was being prepared" });
  });
});

describe("review M1 and M2: a deletion's files always leave storage, and a failing removal is shown", () => {
  let h: MediaHarness;
  let outage = false;

  beforeAll(async () => {
    h = await createMediaHarness();
    const real = h.deps.bucket;
    // SIMULATED R2 delete outage around the real local bucket.
    h.deps.bucket = new Proxy(real, {
      get(target, prop) {
        if (prop === "delete" && outage) return async () => { throw new Error("storage unavailable (simulated outage)"); };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });

  it("M1: a purge that keeps failing is never abandoned, is reported, and completes once storage answers again", async () => {
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (M1 outage)" });
    const up = await h.upload(owner, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 256 }), demo: true });
    await h.settle(owner);
    const prefix = `u/${owner.userId}/assets/${up.asset!.assetId}/`;
    expect((await h.bindings.MEDIA_BUCKET.list({ prefix })).objects).toHaveLength(4);
    expect(await getMediaStorageStatus(h.rt, owner.principal())).toMatchObject({ deletionsPending: 0, deletionsFailing: 0, note: "Everything that was deleted has been removed from storage." });

    outage = true;
    const receipt = await owner.exec("media.delete_asset", { assetId: up.asset!.assetId });
    const jobId = String(receipt.result.purgeJobId);
    // More attempts than the job's limit of three: it is retried, never recorded as dead.
    for (let i = 0; i < 5; i++) expect(await runMediaJob(h.rt, owner.userId, jobId)).toBe("retry");
    const stuck = await first<{ state: string; attempts: number; last_error: string }>(h.db, "SELECT state, attempts, last_error FROM media_jobs WHERE user_id = ? AND job_id = ?", owner.userId, jobId);
    expect(stuck).toMatchObject({ state: "queued", last_error: "storage unavailable (simulated outage)" });
    expect(stuck!.attempts).toBeGreaterThanOrEqual(5);
    expect((await h.bindings.MEDIA_BUCKET.list({ prefix })).objects).toHaveLength(4); // the files really are still there
    // The image is no longer shown or served meanwhile, and the owner can see that its files are not gone yet.
    expect((await getGarmentMedia(h.rt, owner.principal(), "shirt-moss")).image.hasRealImage).toBe(false);
    const status = await getMediaStorageStatus(h.rt, owner.principal());
    expect(status).toMatchObject({ deletionsPending: 1, deletionsFailing: 1, lastError: "storage unavailable (simulated outage)" });
    expect(status.note).toMatch(/could not be completed yet and are retried automatically.*stored files have not been removed/);
    expect(await code(getMediaStorageStatus(h.rt, owner.principal({ scopes: [] })))).toBe("forbidden");

    // The maintenance sweep retries it and reports the fault while it lasts.
    h.clock.advanceMinutes(10);
    const during = await runMediaMaintenance(h.rt, { startDiscovery: false });
    expect(during.purgesOutstanding).toBeGreaterThanOrEqual(1);
    expect(during.errors.join(" ")).toMatch(/deletion\(s\) have not left storage yet .*storage unavailable/);
    expect((await h.bindings.MEDIA_BUCKET.list({ prefix })).objects).toHaveLength(4);

    // Storage answers again: the next sweep finishes the deletion without anyone asking.
    outage = false;
    h.clock.advanceMinutes(10);
    await runMediaMaintenance(h.rt, { startDiscovery: false });
    await h.settle(owner);
    expect((await h.bindings.MEDIA_BUCKET.list({ prefix })).objects).toHaveLength(0);
    expect((await first<{ state: string }>(h.db, "SELECT state FROM media_jobs WHERE user_id = ? AND job_id = ?", owner.userId, jobId))!.state).toBe("succeeded");
    expect(await getMediaStorageStatus(h.rt, owner.principal())).toMatchObject({ deletionsPending: 0, deletionsFailing: 0, lastError: null });
    const afterwards = await runMediaMaintenance(h.rt, { startDiscovery: false });
    expect(afterwards.purgesOutstanding).toBe(0);
    expect(afterwards.errors).toEqual([]);
  });

  it("M1: a job whose queue message was lost is picked up by the sweep even though a queue is configured", async () => {
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (M1 lost message)" });
    const up = await h.upload(owner, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 128 }), demo: true });
    await h.settle(owner);
    await owner.exec("media.delete_asset", { assetId: up.asset!.assetId });
    // The message never reaches the queue (acknowledged in the outbox without being sent).
    await h.db.prepare("UPDATE outbox SET state = 'acknowledged' WHERE user_id = ? AND topic = 'media.job'").bind(owner.userId).run();
    expect((await dispatchMediaJobs(h.rt)).sent).toBe(0);
    // A fresh job is left to the queue consumer; an idle one is run by the sweep.
    await runMediaMaintenance(h.rt, { startDiscovery: false });
    expect((await h.bindings.MEDIA_BUCKET.list({ prefix: `u/${owner.userId}/assets/` })).objects.length).toBeGreaterThan(0);
    h.clock.advanceMinutes(6);
    expect((await runMediaMaintenance(h.rt, { startDiscovery: false })).staleJobsRun).toBeGreaterThanOrEqual(1);
    expect((await h.bindings.MEDIA_BUCKET.list({ prefix: `u/${owner.userId}/assets/` })).objects).toHaveLength(0);
  });

  it("M2: a disabled account's deleted files and unfinished upload bytes are still removed, and nothing else runs for it", async () => {
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (M2 disabled)" });
    const up = await h.upload(owner, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 256 }), demo: true });
    await h.settle(owner);
    const receipt = await owner.exec("media.delete_asset", { assetId: up.asset!.assetId });
    // An upload whose bytes arrived but which was never finalized, and one photo still waiting to be processed.
    const png = await encodePng(syntheticShirt({ size: 128 }));
    const { authorization } = await authorizeUpload(h.rt, owner.principal(), { intent: "garment_photo", garmentId: "shirt-gold", contentType: "image/png", byteLength: png.length, demo: true, idempotencyKey: "m2-unfinished-upload" });
    await receiveUploadContent(h.rt, { uploadId: authorization.uploadId, token: new URLSearchParams(authorization.url.split("?")[1]).get("token")!, body: png, contentLength: png.length, contentType: "image/png" });
    const pending = await h.upload(owner, { garmentId: "shirt-slate", raster: syntheticShirt({ size: 128 }), demo: true });
    const staging = `u/${owner.userId}/staging/${authorization.uploadId}`;
    expect(await h.bindings.MEDIA_BUCKET.head(staging)).not.toBeNull();

    await h.db.prepare("UPDATE users SET status = 'disabled' WHERE user_id = ?").bind(owner.userId).run();
    // Work that would create something is not done for a disabled account...
    expect(await runMediaJob(h.rt, owner.userId, pending.jobId!)).toBe("skipped");
    expect(await all(h.db, "SELECT 1 FROM media_renditions WHERE user_id = ? AND asset_id = ? AND kind != 'original'", owner.userId, pending.asset!.assetId)).toHaveLength(0);
    // ...but the purge of what was deleted runs: it only removes data.
    expect(await runMediaJob(h.rt, owner.userId, String(receipt.result.purgeJobId))).toBe("succeeded");
    expect((await h.bindings.MEDIA_BUCKET.list({ prefix: `u/${owner.userId}/assets/${up.asset!.assetId}/` })).objects).toHaveLength(0);
    const job = await first<{ state: string; result_json: string }>(h.db, "SELECT state, result_json FROM media_jobs WHERE user_id = ? AND job_id = ?", owner.userId, String(receipt.result.purgeJobId));
    expect(job!.state).toBe("succeeded");
    expect(JSON.parse(job!.result_json)).toMatchObject({ deletedObjects: 4, accountDisabled: true });
    // No command was executed for the disabled account to do so.
    expect(await all(h.db, "SELECT 1 FROM commands WHERE user_id = ? AND type = 'media.complete_job' AND payload_json LIKE ?", owner.userId, `%${receipt.result.purgeJobId}%`)).toHaveLength(0);

    // The sweep removes the unfinished upload's bytes once its authorization has lapsed; the record is left as it is.
    h.clock.advanceMinutes(120); // past the ten-minute authorization and the hour of grace
    const swept = await runMediaMaintenance(h.rt, { startDiscovery: false });
    expect(swept.stagingObjectsRemoved).toBeGreaterThanOrEqual(1);
    expect(await h.bindings.MEDIA_BUCKET.head(staging)).toBeNull();
    expect((await first<{ state: string }>(h.db, "SELECT state FROM media_uploads WHERE user_id = ? AND upload_id = ?", owner.userId, authorization.uploadId))!.state).toBe("authorized");
    // Leave nothing queued for a disabled account behind.
    await h.db.prepare("UPDATE media_jobs SET state = 'dead' WHERE user_id = ? AND state IN ('queued', 'running')").bind(owner.userId).run();
    await h.db.prepare("UPDATE outbox SET state = 'acknowledged' WHERE user_id = ?").bind(owner.userId).run();
  });
});
