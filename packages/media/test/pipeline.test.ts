import { beforeAll, describe, expect, it } from "vitest";
import { all, first, isCommandError } from "@garderobe/domain";
import type { TestOwner } from "@garderobe/domain/testing";
import { getGarmentMedia, listMediaJobs, openAssetImage, runMediaMaintenance, runMediaJob } from "../src/index.ts";
import type { ImageEditProvider } from "../src/index.ts";
import { decodeImage, decodePng, encodeJpeg, encodePng, probeImage } from "../src/image/index.ts";
import { createMediaHarness, syntheticClutteredPhoto, syntheticShirt, type MediaHarness } from "../src/testing/index.ts";
import { delivered } from "./worker.ts";

// SYNTHETIC TEST IMAGES on synthetic fixture garments throughout. The image editor below is a TEST DOUBLE
// standing in for the image-editing model behind the model service.

const faithfulEditor: ImageEditProvider = {
  name: "test-double-editor",
  async edit() {
    // Returns the same garment on a clean white background: a faithful catalogue-style edit.
    return { status: "ok", bytes: await encodePng(syntheticShirt({ size: 256 })), contentType: "image/png", model: "test-double-1", providerJobId: "job-1", reconstructsUnseen: true };
  },
};
const unfaithfulEditor: ImageEditProvider = {
  name: "test-double-editor",
  async edit() {
    // Changes the colourway and drops the buttons and pocket: must be rejected.
    return { status: "ok", bytes: await encodePng(syntheticShirt({ size: 256, body: [40, 150, 70], buttons: false, pocket: false })), contentType: "image/png", model: "test-double-1", providerJobId: "job-2", reconstructsUnseen: false };
  },
};

/** A shirt-coloured subject on the cluttered scene's exact layout, so a faithful edit keeps the same silhouette. */
function clutteredShirtPhoto() {
  const shirt = syntheticShirt({ size: 256 });
  const scene = syntheticClutteredPhoto(256);
  for (let p = 0; p < 256 * 256; p++) {
    const white = shirt.data[p * 4]! > 250 && shirt.data[p * 4 + 1]! > 250 && shirt.data[p * 4 + 2]! > 250;
    const x = p % 256, y = (p - x) / 256;
    const inBody = x >= 30 && x < 226 && y >= 38 && y < 226;
    if (!white || inBody) for (let c = 0; c < 4; c++) if (!white) scene.data[p * 4 + c] = shirt.data[p * 4 + c]!;
  }
  return scene;
}

describe("queue-driven normalization with fidelity checks (real local queue and R2)", () => {
  let h: MediaHarness;
  let owner: TestOwner;

  beforeAll(async () => {
    h = await createMediaHarness();
    owner = await h.createSyntheticOwner();
  });

  it("normalizes an upload through the queue: cutout, mask and catalogue view, each traceable to the original", async () => {
    const before = delivered.messages;
    const up = await h.upload(owner, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 320 }), demo: true });
    expect(up.jobId).toBeTruthy();
    expect((await getGarmentMedia(h.rt, owner.principal(), "shirt-moss")).imageState).toBe("searching");
    await h.settle(owner);
    expect(delivered.messages).toBeGreaterThan(before); // the local queue delivered to the consumer

    const media = await getGarmentMedia(h.rt, owner.principal(), "shirt-moss");
    expect(media.imageState).toBe("resolved");
    expect(media.lastFailure).toBeNull();
    const asset = media.assets[0]!;
    expect(asset.status).toBe("active");
    const byKind = Object.fromEntries(asset.renditions.map((r) => [r.kind, r]));
    expect(Object.keys(byKind).sort()).toEqual(["catalogue", "cutout", "mask", "original"]);
    expect(byKind.cutout!.sourceRenditionId).toBe(byKind.original!.renditionId);
    expect(byKind.catalogue!.sourceRenditionId).toBe(byKind.cutout!.renditionId);
    expect(byKind.cutout!.transformations.map((t) => t.step)).toEqual(["decode", "uniform_background_flood_fill"]);
    expect(byKind.cutout!.transformations.every((t) => !t.generative)).toBe(true);
    expect(byKind.cutout!.edited).toBe(false);
    expect(asset.fidelity).toHaveLength(1);
    expect(asset.fidelity[0]).toMatchObject({ subject: "cutout", verdict: "passed", renditionId: byKind.cutout!.renditionId, failed: [] });
    expect(asset.fidelity[0]!.checks).toHaveLength(6);
    // The image the app shows is the cutout, labelled as a demo placeholder (this is a fixture, not a real garment).
    expect(media.image).toMatchObject({ renditionKind: "cutout", isDemo: true, displayLabel: "Demo placeholder", hasRealImage: false });

    // Stored derivatives are real images in R2: the cutout is transparent, the catalogue view is an opaque square.
    const cut = await decodePng(new Uint8Array(await new Response((await openAssetImage(h.rt, owner.principal(), asset.assetId, { variant: "cutout" })).body).arrayBuffer()));
    expect(cut.data[3]).toBe(0);
    expect(cut.data[(160 * 320 + 160) * 4 + 3]).toBe(255);
    const cat = (await decodeImage(new Uint8Array(await new Response((await openAssetImage(h.rt, owner.principal(), asset.assetId, { variant: "catalogue" })).body).arrayBuffer()))).raster;
    expect([cat.width, cat.height]).toEqual([1200, 1200]);
    // The original is untouched and the staging copy is gone.
    expect((await h.bindings.MEDIA_BUCKET.list({ prefix: `u/${owner.userId}/staging/` })).objects).toHaveLength(0);
    const receipts = await h.service.listReceipts(owner.principal(), { kind: "media_asset", entityId: asset.assetId });
    expect(receipts.map((r) => r.type)).toContain("media.record_normalization");
  });

  it("strips location metadata from derivatives and records that the original carried it", async () => {
    const jpg = encodeJpeg(syntheticShirt({ size: 256 }), 92);
    // Splice in an Exif APP1 segment with a GPS IFD pointer.
    const tiff = new Uint8Array(8 + 2 + 12 + 4 + 6);
    const v = new DataView(tiff.buffer);
    tiff.set([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
    v.setUint16(8, 1, true);
    v.setUint16(10, 0x8825, true);
    v.setUint16(12, 4, true);
    v.setUint32(14, 1, true);
    v.setUint32(18, 26, true);
    const body = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]);
    const tagged = new Uint8Array([...jpg.subarray(0, 2), 0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body, ...jpg.subarray(2)]);
    expect(probeImage(tagged)!.exif.hasGps).toBe(true);

    const up = await h.upload(owner, { intent: "selfie", bytes: tagged, contentType: "image/jpeg", wearingDate: "2026-09-15" });
    expect(up.asset).toMatchObject({ kind: "selfie", hadLocationMetadata: true, garmentId: null });
    await h.settle(owner);
    const display = new Uint8Array(await new Response((await openAssetImage(h.rt, owner.principal(), up.asset!.assetId)).body).arrayBuffer());
    expect(probeImage(display)!.exif).toEqual({ present: false, orientation: null, hasGps: false });
    // A selfie gets a display copy only: no cutout, no garment link, and it never becomes a garment's image.
    const kinds = (await all<{ kind: string }>(h.db, "SELECT kind FROM media_renditions WHERE user_id = ? AND asset_id = ? ORDER BY kind", owner.userId, up.asset!.assetId)).map((r) => r.kind);
    expect(kinds).toEqual(["display", "original"]);
  });

  it("keeps the honest photo and says why when no cutout can be made", async () => {
    await h.upload(owner, { garmentId: "shirt-gold", raster: syntheticClutteredPhoto(256), demo: true });
    await h.settle(owner);
    const media = await getGarmentMedia(h.rt, owner.principal(), "shirt-gold");
    expect(media.assets[0]!.renditions.map((r) => r.kind).sort()).toEqual(["display", "original"]);
    expect(media.lastFailure).toMatch(/No cutout was made .*shown as taken/);
    expect(media.image.renditionKind).toBe("display");
    expect(media.imageState).toBe("resolved");
  });

  it("rejects an unfaithful edit, records the failed checks and surfaces them", async () => {
    h.deps.imageEditor = unfaithfulEditor;
    await owner.exec("garment.create", { garmentId: "shirt-edit-bad", name: "edit fixture shirt A", category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, isSynthetic: true, source: { kind: "system", note: "synthetic test fixture" } });
    const up = await h.upload(owner, { garmentId: "shirt-edit-bad", raster: clutteredShirtPhoto() });
    await h.settle(owner);
    const media = await getGarmentMedia(h.rt, owner.principal(), "shirt-edit-bad");
    const asset = media.assets.find((a) => a.assetId === up.asset!.assetId)!;
    // No edited rendition was stored; the failure is recorded with its checks and shown on the garment.
    expect(asset.renditions.map((r) => r.kind)).not.toContain("edited");
    const failed = asset.fidelity.find((f) => f.subject === "edit")!;
    expect(failed.verdict).toBe("failed");
    expect(failed.renditionId).toBeNull();
    expect(failed.failed).toEqual(expect.arrayContaining(["dominant_colours", "important_details"]));
    expect(media.lastFailure).toMatch(/edited rendition failed the fidelity check \(.*dominant colours.*\) and was discarded/);
    expect(asset.statusReason).toBe(media.lastFailure);
    const job = (await listMediaJobs(h.rt, owner.principal())).find((j) => j.subjectId === asset.assetId)!;
    expect(job.state).toBe("succeeded"); // the job did its work: it rejected the edit
    const stored = await first<{ result_json: string }>(h.db, "SELECT result_json FROM media_jobs WHERE user_id = ? AND job_id = ?", owner.userId, job.jobId);
    expect(JSON.parse(stored!.result_json).fidelityFailed).toContain("dominant_colours");
    // No object of a rejected edit is left in the bucket.
    expect((await h.bindings.MEDIA_BUCKET.list({ prefix: `u/${owner.userId}/assets/${asset.assetId}/edited` })).objects).toHaveLength(0);
  });

  it("accepts a faithful edit only as an edited, labelled derivative that is never evidence", async () => {
    h.deps.imageEditor = faithfulEditor;
    await owner.exec("garment.create", { garmentId: "shirt-edit-ok", name: "edit fixture shirt B", category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, isSynthetic: true, source: { kind: "system", note: "synthetic test fixture" } });
    const up = await h.upload(owner, { garmentId: "shirt-edit-ok", raster: clutteredShirtPhoto() });
    await h.settle(owner);
    h.deps.imageEditor = undefined;
    const media = await getGarmentMedia(h.rt, owner.principal(), "shirt-edit-ok");
    const asset = media.assets.find((a) => a.assetId === up.asset!.assetId)!;
    const edited = asset.renditions.find((r) => r.kind === "edited")!;
    expect(edited.edited).toBe(true);
    const step = edited.transformations.find((t) => t.step === "image_model_edit")!;
    expect(step).toMatchObject({ generative: true, tool: "test-double-editor" });
    expect(step.params).toMatchObject({ reconstructsUnseenParts: true, evidenceForFabricOrFit: false, preserve: ["colour", "pattern scale", "pockets", "buttons", "seams", "silhouette"] });
    // Everything derived from the edit inherits the edited flag, and the display label says so.
    expect(asset.renditions.filter((r) => r.kind === "cutout" || r.kind === "catalogue").every((r) => r.edited)).toBe(true);
    expect(media.image.displayLabel).toBe("Edited");
    expect(asset.fidelity.find((f) => f.subject === "edit")).toMatchObject({ verdict: "passed", renditionId: edited.renditionId });
    // The immutable original is still there, unedited.
    expect(asset.renditions.find((r) => r.kind === "original")).toMatchObject({ edited: false, status: "active" });
  });

  it("does not retry a paid edit with an unknown outcome", async () => {
    let calls = 0;
    h.deps.imageEditor = { name: "test-double-editor", async edit() { calls++; return { status: "unknown_outcome", providerJobId: "prov-77", reason: "the connection dropped after the request was sent" }; } };
    await owner.exec("garment.create", { garmentId: "shirt-edit-unknown", name: "edit fixture shirt C", category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, isSynthetic: true, source: { kind: "system", note: "synthetic test fixture" } });
    await h.upload(owner, { garmentId: "shirt-edit-unknown", raster: clutteredShirtPhoto() });
    await h.settle(owner);
    h.deps.imageEditor = undefined;
    expect(calls).toBe(1);
    expect((await getGarmentMedia(h.rt, owner.principal(), "shirt-edit-unknown")).lastFailure).toMatch(/unknown outcome \(provider job prov-77\); it was not retried and may have been charged/);
  });

  it("marks an unreadable image as unusable instead of showing it", async () => {
    const good = await encodePng(syntheticShirt({ size: 128 }));
    const corrupt = new Uint8Array(good);
    for (let i = 60; i < 90; i++) corrupt[i] = corrupt[i]! ^ 0xff; // breaks the image data; the header still looks fine
    const up = await h.upload(owner, { garmentId: "shirt-slate", bytes: corrupt, demo: true });
    expect(up.rejected).toBeNull(); // header-level validation passes
    await h.settle(owner);
    const media = await getGarmentMedia(h.rt, owner.principal(), "shirt-slate");
    expect(media.assets.find((a) => a.assetId === up.asset!.assetId)!.status).toBe("rejected");
    expect(media.image).toMatchObject({ hasRealImage: false, renditionId: null, missingImageNote: "No photo yet" });
    expect(media.lastFailure).toMatch(/could not be read \(corrupt\)/);
    expect(media.imageState).toBe("not_started");
  });

  it("runs each job once under duplicate delivery, and gives a disabled account no effects", async () => {
    const up = await h.upload(owner, { garmentId: "trouser-olive", raster: syntheticShirt({ size: 128 }), demo: true });
    // Deliver the same job three times directly, racing the queue.
    const outcomes = await Promise.all([runMediaJob(h.rt, owner.userId, up.jobId!), runMediaJob(h.rt, owner.userId, up.jobId!), runMediaJob(h.rt, owner.userId, up.jobId!)]);
    await h.settle(owner);
    expect(outcomes.filter((o) => o === "succeeded").length).toBeLessThanOrEqual(1);
    const cutouts = await all(h.db, "SELECT 1 FROM media_renditions WHERE user_id = ? AND asset_id = ? AND kind = 'cutout'", owner.userId, up.asset!.assetId);
    expect(cutouts).toHaveLength(1);
    expect(await all(h.db, "SELECT 1 FROM commands WHERE user_id = ? AND type = 'media.record_normalization' AND payload_json LIKE ?", owner.userId, `%${up.asset!.assetId}%`)).toHaveLength(1);

    const other = await h.createSyntheticOwner();
    const pending = await h.upload(other, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 128 }), demo: true });
    await h.db.prepare("UPDATE users SET status = 'disabled' WHERE user_id = ?").bind(other.userId).run();
    expect(await runMediaJob(h.rt, other.userId, pending.jobId!)).toBe("skipped");
    expect(await all(h.db, "SELECT 1 FROM media_renditions WHERE user_id = ? AND kind != 'original'", other.userId)).toHaveLength(0);
    await h.db.prepare("UPDATE media_jobs SET state = 'dead' WHERE user_id = ?").bind(other.userId).run(); // leave nothing queued for later tests
    await h.db.prepare("UPDATE outbox SET state = 'acknowledged' WHERE user_id = ?").bind(other.userId).run();
  });

  it("records and surfaces a job that keeps failing", async () => {
    const up = await h.upload(owner, { garmentId: "trouser-beige", raster: syntheticShirt({ size: 128 }), demo: true });
    // The original disappears from storage (an infrastructure fault): the job fails, retries, then is recorded as dead.
    const key = (await first<{ object_key: string }>(h.db, "SELECT object_key FROM media_renditions WHERE user_id = ? AND asset_id = ?", owner.userId, up.asset!.assetId))!.object_key;
    await h.bindings.MEDIA_BUCKET.delete(key);
    await h.settle(owner);
    const job = (await listMediaJobs(h.rt, owner.principal())).find((j) => j.jobId === up.jobId)!;
    expect(job).toMatchObject({ state: "dead", attempts: 3 });
    expect(job.lastError).toMatch(/original image is missing/);
    const media = await getGarmentMedia(h.rt, owner.principal(), "trouser-beige");
    expect(media.lastFailure).toMatch(/normalize did not complete: .*missing from storage/);
    expect(media.imageState).toBe("not_started"); // not left "searching" forever
    expect((await h.service.listReceipts(owner.principal(), { kind: "media_job", entityId: up.jobId! })).map((r) => r.type)).toEqual(["media.fail_job"]);
  });

  it("pipeline result commands are not available to clients", async () => {
    const attempt = owner.exec("media.record_normalization", { assetId: "x", jobId: "y", outcome: "normalized", renditions: [], fidelity: [], note: null }, { authorization: "system_schedule" });
    await expect(attempt).rejects.toSatisfy((e) => isCommandError(e) && e.code === "forbidden");
  });

  it("maintenance expires unfinished uploads and removes selfie originals past retention, keeping the history copy", async () => {
    const selfie = (await all<{ asset_id: string }>(h.db, "SELECT asset_id FROM media_assets WHERE user_id = ? AND kind = 'selfie'", owner.userId))[0]!;
    expect((await first<{ retain_original_until: string }>(h.db, "SELECT retain_original_until FROM media_assets WHERE user_id = ? AND asset_id = ?", owner.userId, selfie.asset_id))!.retain_original_until).toMatch(/^2026-12-/); // 90 days by default
    const stale = await owner.exec("media.authorize_upload", { intent: "attachment", contentType: "image/png", byteLength: 1000 });
    h.clock.advance(91 * 86_400_000);
    const result = await runMediaMaintenance(h.rt, { startDiscovery: false });
    expect(result.errors).toEqual([]);
    expect(result.selfieOriginalsRemoved).toBe(1);
    expect(result.expiredUploads).toBeGreaterThanOrEqual(1);
    await h.settle(owner);
    expect((await first<{ state: string }>(h.db, "SELECT state FROM media_uploads WHERE user_id = ? AND upload_id = ?", owner.userId, String(stale.result.uploadId)))!.state).toBe("rejected");
    const objects = (await h.bindings.MEDIA_BUCKET.list({ prefix: `u/${owner.userId}/assets/${selfie.asset_id}/` })).objects.map((o) => o.key.split("/").pop()!.split("-")[0]);
    expect(objects).toEqual(["display"]); // the full-resolution original is gone, the reduced copy stays
    await expect(openAssetImage(h.rt, owner.principal(), selfie.asset_id, { variant: "original" })).rejects.toThrow(/no longer kept/);
    expect((await openAssetImage(h.rt, owner.principal(), selfie.asset_id)).contentType).toBe("image/jpeg");
  });
});
