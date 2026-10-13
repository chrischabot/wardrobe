import { describe, expect, it } from "vitest";
import { all, isCommandError } from "@garderobe/domain";
import type { TestOwner } from "@garderobe/domain/testing";
import { exportMediaData, importMediaData, listMediaDeletions, readExportFile } from "../src/index.ts";
import { createMediaHarness, holdTestImportLock, syntheticShirt, type MediaHarness } from "../src/testing/index.ts";

// Import commands are bound to the package and the plan holding the owner's import lock, and a superseded or
// interrupted import never leaves a withheld image in storage nor removes a file the winning import relies on.
// SYNTHETIC TEST IMAGES and test records only. Storage wrappers below are TEST DOUBLES around the real local R2
// bucket that change only WHEN a write lands, to reproduce the races.

const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (isCommandError(e) ? e.code : `threw:${String(e)}`));
const importer = (o: TestOwner) => o.principal({ channel: "import", actor: "system", scopes: ["read", "write", "admin"] });
const digest = (c: string) => c.repeat(32);

/** SYNTHETIC TEST BYTES standing in for a stored picture file. */
const syntheticShirtPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** Wrap the harness bucket: `around(name, args, real)` decides how each call of `name` runs. TEST DOUBLE. */
function wrapBucket(h: MediaHarness, around: (name: string, args: unknown[], call: () => Promise<unknown>) => Promise<unknown>): () => void {
  const real = h.deps.bucket;
  h.deps.bucket = new Proxy(real, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if (typeof value !== "function") return value;
      const fn = (value as (...a: unknown[]) => Promise<unknown>).bind(target);
      return (...args: unknown[]) => around(String(key), args, () => fn(...args));
    },
  });
  return () => {
    h.deps.bucket = real;
  };
}

/** A source owner with two images, one of them deleted after its package was made. */
async function sourceWithWithheldImage(h: MediaHarness) {
  const source = await h.createSyntheticOwner({ displayName: "Synthetic owner (import source)" });
  await h.upload(source, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 128 }), demo: true });
  const doomed = await h.upload(source, { garmentId: "shirt-gold", raster: syntheticShirt({ size: 160 }), demo: true });
  await h.settle(source);
  const data = await exportMediaData(h.rt, source.principal());
  // The package's files as they were when it was made (a backup keeps them), read before the deletion.
  const files = new Map<string, ArrayBuffer | null>();
  for (const f of data.assets) files.set(String(f.file), await readExportFile(h.rt, source.principal(), String(f.file)));
  await source.exec("media.delete_asset", { assetId: doomed.asset!.assetId });
  await h.settle(source);
  const deletions = await listMediaDeletions(h.rt, source.principal());
  const read = async (file: string) => files.get(file) ?? null;
  return { source, data, deletions, read, doomedAssetId: doomed.asset!.assetId };
}

/** A source owner with exactly one image (SYNTHETIC), and its package. */
async function onePicturePackage(h: MediaHarness, label: string) {
  const source = await h.createSyntheticOwner({ displayName: `Synthetic owner (one-picture source ${label})` });
  const up = await h.upload(source, { garmentId: "shirt-moss", raster: syntheticShirt({ size: label === "first" ? 128 : 150 }), demo: true });
  await h.settle(source);
  const data = await exportMediaData(h.rt, source.principal());
  return { data, read: (file: string) => readExportFile(h.rt, source.principal(), file), assetId: up.asset!.assetId };
}

async function liveFilesPresent(h: MediaHarness, owner: TestOwner): Promise<number> {
  const rows = await all<{ object_key: string }>(h.db, "SELECT r.object_key FROM media_renditions r JOIN media_assets a ON a.user_id = r.user_id AND a.asset_id = r.asset_id WHERE r.user_id = ? AND r.status = 'active' AND a.status = 'active'", owner.userId);
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) expect(await h.deps.bucket.head(r.object_key), r.object_key).not.toBeNull();
  return rows.length;
}

describe("import commands are bound to the package and the plan holding the owner's lock", () => {
  it("refuses a command whose plan no longer holds the lock, and one that names its package without its plan", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (import lock)" });
    // TEST SETUP: a run of the same package with a different plan took the owner's lock over.
    await h.db.prepare("INSERT INTO media_import_locks (user_id, package_digest, plan_digest, created_at) VALUES (?, ?, ?, ?)").bind(owner.userId, digest("a"), digest("c"), h.clock.iso()).run();
    const run = (payload: Record<string, unknown>, key: string) => h.service.execute(importer(owner), { type: "media.import_records", payload: { part: "garmentMedia", rows: { garmentMedia: [{ garment_id: "shirt-moss", image_state: "not_started", primary_asset_id: null, version: 1, updated_at: h.clock.iso() }] }, ...payload }, idempotencyKey: key, expectedVersions: {}, authorization: "data_import", source: { channel: "import" } });
    expect(await code(run({ importDigest: digest("a"), importPlanDigest: digest("b") }, "superseded-plan"))).toBe("precondition_failed");
    expect(await code(run({ importDigest: digest("a") }, "package-only"))).toBe("invalid_command");
    expect(await code(run({}, "no-import-named"))).toBe("invalid_command"); // there is no lock-free import
    expect(await code(run({ importDigest: digest("a"), importPlanDigest: digest("c") }, "current-plan"))).toBe("ok");
  });

  it("stores every imported file under a key rebuilt from its verified bytes", async () => {
    const h = await createMediaHarness();
    const source = await h.createSyntheticOwner({ displayName: "Synthetic owner (content keys source)" });
    await h.upload(source, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 128 }), demo: true });
    await h.settle(source);
    const data = await exportMediaData(h.rt, source.principal());
    const target = await h.createSyntheticOwner({ displayName: "Synthetic owner (content keys target)" });
    const result = await importMediaData(h.rt, importer(target), data, (file) => readExportFile(h.rt, source.principal(), file));
    expect([result.missing, result.mismatched, result.rejected]).toEqual([[], [], []]);
    const stored = await all<{ object_key: string; sha256: string }>(h.db, "SELECT object_key, sha256 FROM media_renditions WHERE user_id = ? AND status != 'deleted'", target.userId);
    expect(stored.length).toBe(data.assets.length);
    for (const r of stored) {
      expect(r.object_key).toContain(`-${r.sha256.slice(0, 16)}.`);
      expect((await h.deps.bucket.head(r.object_key))?.customMetadata?.sha256).toBe(r.sha256);
    }
  });

  it("refuses every later command of an import, in its own commit, once any other media command was written for the owner after the lock", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (change after the lock)" });
    const lock = await holdTestImportLock(h.db, owner.userId, h.clock.iso());
    const run = (garmentId: string, key: string) =>
      h.service.execute(importer(owner), { type: "media.import_records", payload: { part: "garmentMedia", rows: { garmentMedia: [{ garment_id: garmentId, image_state: "not_started", primary_asset_id: null, version: 1, updated_at: h.clock.iso() }] }, importDigest: lock.importDigest, importPlanDigest: lock.importPlanDigest }, idempotencyKey: key, expectedVersions: {}, authorization: "data_import", source: { channel: "import" } });
    expect(await code(run("shirt-moss", lock.key("first")))).toBe("ok");
    // TEST SETUP: a media command that is not one of this import's own (another key) commits after the lock was taken.
    expect(await code(run("shirt-gold", "some-other-writer"))).toBe("ok");
    expect(await code(run("shirt-slate", lock.key("second")))).toBe("precondition_failed");
    expect(await all(h.db, "SELECT garment_id FROM garment_media WHERE user_id = ? AND garment_id = 'shirt-slate'", owner.userId)).toEqual([]);
  });
});

describe("withheld images and superseded writes", () => {
  it("removes a file a superseded run left for an image the package withholds, once the import's records are in", async () => {
    const h = await createMediaHarness();
    const { data, deletions, read, doomedAssetId } = await sourceWithWithheldImage(h);
    const target = await h.createSyntheticOwner({ displayName: "Synthetic owner (withheld target)" });
    // TEST SETUP: a superseded run of another plan stored the withheld image's file before it noticed it lost the lock.
    const stray = `u/${target.userId}/assets/${doomedAssetId}/original-0123456789abcdef.png`;
    await h.deps.bucket.put(stray, syntheticShirtPng);
    const result = await importMediaData(h.rt, importer(target), data, read, { deletions });
    expect(result.deletionsApplied.filesWithheld).toBeGreaterThan(0);
    expect(await h.deps.bucket.head(stray)).toBeNull();
    await liveFilesPresent(h, target);
  });

  it("removes a file another run left for an image the package itself records as deleted before it was made, also on a repeat", async () => {
    const h = await createMediaHarness();
    const source = await h.createSyntheticOwner({ displayName: "Synthetic owner (package tombstone source)" });
    await h.upload(source, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 128 }), demo: true });
    const gone = await h.upload(source, { garmentId: "shirt-gold", raster: syntheticShirt({ size: 160 }), demo: true });
    await h.settle(source);
    await source.exec("media.delete_asset", { assetId: gone.asset!.assetId });
    await h.settle(source);
    const data = await exportMediaData(h.rt, source.principal());
    expect((data.records.deletedAssets ?? []).map((d) => d.assetId)).toContain(gone.asset!.assetId);
    const read = (file: string) => readExportFile(h.rt, source.principal(), file);
    const target = await h.createSyntheticOwner({ displayName: "Synthetic owner (package tombstone target)" });
    const stray = `u/${target.userId}/assets/${gone.asset!.assetId}/original-0123456789abcdef.png`;
    await h.deps.bucket.put(stray, syntheticShirtPng); // TEST SETUP: left by a superseded run of another package
    await importMediaData(h.rt, importer(target), data, read);
    expect(await h.deps.bucket.head(stray)).toBeNull();
    await h.deps.bucket.put(stray, syntheticShirtPng); // TEST SETUP: a late write landed after the clean-up
    await expect(importMediaData(h.rt, importer(target), data, read)).rejects.toMatchObject({ code: "precondition_failed" });
    expect(await h.deps.bucket.head(stray)).toBeNull();
    await liveFilesPresent(h, target);
  });

  it("a package whose own tombstone names an image it also holds as live imports that image only as deleted, without its files", async () => {
    const h = await createMediaHarness();
    const source = await h.createSyntheticOwner({ displayName: "Synthetic owner (tombstone beside a live record)" });
    await h.upload(source, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 128 }), demo: true });
    const both = await h.upload(source, { garmentId: "shirt-gold", raster: syntheticShirt({ size: 160 }), demo: true });
    await h.settle(source);
    const exported = await exportMediaData(h.rt, source.principal());
    const id = both.asset!.assetId;
    // TEST SETUP: the package carries a tombstone for an image whose older live record and files it also holds.
    const data = { ...exported, records: { ...exported.records, deletedAssets: [...(exported.records.deletedAssets ?? []), { assetId: id, deletedAt: exported.exportedAt }] } };
    const target = await h.createSyntheticOwner({ displayName: "Synthetic owner (tombstone beside a live record, target)" });
    const result = await importMediaData(h.rt, importer(target), data, (file) => readExportFile(h.rt, source.principal(), file));
    expect(result.deletionsApplied.filesWithheld).toBeGreaterThan(0);
    expect(await all(h.db, "SELECT status FROM media_assets WHERE user_id = ? AND asset_id = ?", target.userId, id)).toEqual([{ status: "deleted" }]);
    expect(await all(h.db, "SELECT 1 FROM media_renditions WHERE user_id = ? AND asset_id = ? AND status != 'deleted'", target.userId, id)).toEqual([]);
    expect((await h.deps.bucket.list({ prefix: `u/${target.userId}/assets/${id}/` })).objects).toEqual([]);
    await liveFilesPresent(h, target);
  });

  it("a superseded run's write that lands after the winning import finished never removes a file the winner relies on", async () => {
    const h = await createMediaHarness();
    const { data, deletions, read } = await sourceWithWithheldImage(h);
    const target = await h.createSyntheticOwner({ displayName: "Synthetic owner (late write target)" });
    // Run A imports the package without the journal; run B, a different package (with the journal), takes the lock
    // over and finishes completely while A's first write is still under way. A's write lands only afterwards, at a
    // key B also wrote (keys are content-addressed), and A then finds it has lost the lock.
    let aWrites = 0;
    let inB = false;
    const restore = wrapBucket(h, async (name, _args, call) => {
      if (name !== "put" || inB || aWrites++ > 0) return call();
      inB = true;
      try {
        await importMediaData(h.rt, importer(target), data, read, { deletions });
      } finally {
        inB = false;
      }
      return call(); // A's delayed write lands now, over B's file
    });
    await expect(importMediaData(h.rt, importer(target), data, read)).rejects.toMatchObject({ code: "precondition_failed" });
    restore();
    expect(aWrites).toBe(1);
    // Every file of every image B imported is still there.
    await liveFilesPresent(h, target);
  });

  it("a superseded run's late write of an image the winner withholds is removed by that run once the winner's records are in", async () => {
    const h = await createMediaHarness();
    const { data, deletions, read, doomedAssetId } = await sourceWithWithheldImage(h);
    const target = await h.createSyntheticOwner({ displayName: "Synthetic owner (late withheld write target)" });
    // Run A (no journal) still imports the image B withholds. B runs to completion, clean-up included, before A's
    // write of that image lands.
    let inB = false;
    let delayed = false;
    const restore = wrapBucket(h, async (name, args, call) => {
      if (name !== "put" || inB || delayed || !String(args[0]).includes(`/assets/${doomedAssetId}/`)) return call();
      delayed = true;
      inB = true;
      try {
        await importMediaData(h.rt, importer(target), data, read, { deletions });
      } finally {
        inB = false;
      }
      return call();
    });
    await expect(importMediaData(h.rt, importer(target), data, read)).rejects.toMatchObject({ code: "precondition_failed" });
    restore();
    expect(delayed).toBe(true);
    expect((await h.deps.bucket.list({ prefix: `u/${target.userId}/assets/${doomedAssetId}/` })).objects).toEqual([]);
    await liveFilesPresent(h, target);
  });

  it("an import that stopped after its records committed but before its clean-up finishes the clean-up when run again, then refuses the repeat", async () => {
    const h = await createMediaHarness();
    const { data, deletions, read, doomedAssetId } = await sourceWithWithheldImage(h);
    const target = await h.createSyntheticOwner({ displayName: "Synthetic owner (interrupted clean-up target)" });
    const stray = `u/${target.userId}/assets/${doomedAssetId}/original-0123456789abcdef.png`;
    await h.deps.bucket.put(stray, syntheticShirtPng); // TEST SETUP: left by a superseded run
    // TEST DOUBLE: the run stops at its first storage listing, which only the clean-up makes, after every record committed.
    let stopped = false;
    const restore = wrapBucket(h, async (name, _args, call) => {
      if (name === "list" && !stopped) {
        stopped = true;
        throw new Error("simulated stop before the clean-up");
      }
      return call();
    });
    await expect(importMediaData(h.rt, importer(target), data, read, { deletions })).rejects.toThrow(/simulated stop/);
    restore();
    expect(await h.deps.bucket.head(stray)).not.toBeNull();
    const before = await all(h.db, "SELECT asset_id, status FROM media_assets WHERE user_id = ? ORDER BY asset_id", target.userId);
    expect(before.length).toBeGreaterThan(0);
    await expect(importMediaData(h.rt, importer(target), data, read, { deletions })).rejects.toMatchObject({ code: "precondition_failed" });
    expect(await h.deps.bucket.head(stray)).toBeNull();
    expect(await all(h.db, "SELECT asset_id, status FROM media_assets WHERE user_id = ? ORDER BY asset_id", target.userId)).toEqual(before);
    await liveFilesPresent(h, target);
  });

  it("a later change to the owner's media does not stop the repeat's clean-up, and a different package is still refused untouched", async () => {
    const h = await createMediaHarness();
    const { data, deletions, read, doomedAssetId } = await sourceWithWithheldImage(h);
    const target = await h.createSyntheticOwner({ displayName: "Synthetic owner (repeat after a change)" });
    await importMediaData(h.rt, importer(target), data, read, { deletions });
    const stray = `u/${target.userId}/assets/${doomedAssetId}/original-0123456789abcdef.png`;
    await h.deps.bucket.put(stray, syntheticShirtPng); // TEST SETUP: a superseded run's write landed after the clean-up
    await h.upload(target, { garmentId: "shirt-slate", raster: syntheticShirt({ size: 140 }), demo: true }); // the owner moves on
    await h.settle(target);
    await expect(importMediaData(h.rt, importer(target), data, read, { deletions })).rejects.toMatchObject({ code: "precondition_failed" });
    expect(await h.deps.bucket.head(stray)).toBeNull();
    // Another package (the same records without the journal) is refused before it reads or writes anything.
    await expect(importMediaData(h.rt, importer(target), data, read)).rejects.toMatchObject({ code: "precondition_failed" });
    await liveFilesPresent(h, target);
  });

  it("a superseded run's file for an image the winning package never mentions is removed by the winner's clean-up", async () => {
    const h = await createMediaHarness();
    const first = await onePicturePackage(h, "first");
    const second = await onePicturePackage(h, "second");
    const target = await h.createSyntheticOwner({ displayName: "Synthetic owner (abandoned import target)" });
    // TEST DOUBLE: run A stops for good right after its first write landed (as if its process died).
    let crashed = false;
    const restore = wrapBucket(h, async (name, _args, call) => {
      if (name !== "put" || crashed) return call();
      crashed = true;
      await call();
      throw new Error("simulated crash after a write");
    });
    await expect(importMediaData(h.rt, importer(target), first.data, first.read)).rejects.toThrow(/simulated crash/);
    restore();
    const abandoned = `u/${target.userId}/assets/${first.assetId}/`;
    expect((await h.deps.bucket.list({ prefix: abandoned })).objects.length).toBe(1);
    // Run B, a different package with an unrelated image, takes the lock over (the owner holds no records) and finishes.
    await importMediaData(h.rt, importer(target), second.data, second.read);
    expect((await h.deps.bucket.list({ prefix: abandoned })).objects).toEqual([]);
    await liveFilesPresent(h, target);
  });

  it("a superseded run's write that lands after the winner's clean-up, for an image the winner never mentions, is removed by that run", async () => {
    const h = await createMediaHarness();
    const first = await onePicturePackage(h, "first");
    const second = await onePicturePackage(h, "second");
    const target = await h.createSyntheticOwner({ displayName: "Synthetic owner (late abandoned write target)" });
    // TEST DOUBLE: run A's first write is held until run B (another package, another image) has finished completely.
    let inB = false;
    let delayed = false;
    const restore = wrapBucket(h, async (name, _args, call) => {
      if (name !== "put" || inB || delayed) return call();
      delayed = true;
      inB = true;
      try {
        await importMediaData(h.rt, importer(target), second.data, second.read);
      } finally {
        inB = false;
      }
      return call();
    });
    await expect(importMediaData(h.rt, importer(target), first.data, first.read)).rejects.toMatchObject({ code: "precondition_failed" });
    restore();
    expect(delayed).toBe(true);
    expect((await h.deps.bucket.list({ prefix: `u/${target.userId}/assets/${first.assetId}/` })).objects).toEqual([]);
    await liveFilesPresent(h, target);
  });
});
