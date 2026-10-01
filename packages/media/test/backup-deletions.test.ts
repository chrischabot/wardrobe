import { beforeAll, describe, expect, it } from "vitest";
import { all, first, isCommandError } from "@garderobe/domain";
import type { TestOwner } from "@garderobe/domain/testing";
import { exportMediaData, getAsset, getGarmentMedia, importMediaData, listMediaDeletions, listMediaJobs, openAssetImage, readExportFile, replayMediaDeletions, runMediaMaintenance, type MediaDeletionJournal, type MediaExport } from "../src/index.ts";
import { createMediaHarness, syntheticShirt, syntheticTrousers, type MediaHarness } from "../src/testing/index.ts";

// SYNTHETIC TEST IMAGES on synthetic fixture garments (labelled demo placeholders).
// The "backup" here is a STAND-IN for the API workstream's backup package: the media export records plus a
// copy of every listed file held in memory. It exercises the functions that package's code calls; the real
// package, its bucket and its retention sweep are the API workstream's and are not run here.

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return isCommandError(e) ? e.code : `threw:${String(e)}`;
  }
}

describe("a deleted image does not come back from a backup taken before the deletion", () => {
  let h: MediaHarness;
  let source: TestOwner;
  let backup: { data: MediaExport; files: Map<string, Uint8Array> };
  let journal: MediaDeletionJournal;
  let shirtAsset: string;
  let trouserAsset: string;
  let selfieAsset: string;
  const importer = (o: TestOwner) => o.principal({ channel: "import", actor: "system", scopes: ["read", "write", "admin"] });
  const objectsOf = async (o: TestOwner, assetId: string) => (await h.bindings.MEDIA_BUCKET.list({ prefix: `u/${o.userId}/assets/${assetId}/` })).objects.map((x) => x.key.split("/").pop()!.split("-")[0]).sort();

  beforeAll(async () => {
    h = await createMediaHarness();
    source = await h.createSyntheticOwner({ displayName: "Synthetic owner (backup source)" });
    shirtAsset = (await h.upload(source, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 256 }), demo: true })).asset!.assetId;
    trouserAsset = (await h.upload(source, { garmentId: "trouser-olive", raster: syntheticTrousers({ size: 256 }), demo: true })).asset!.assetId;
    selfieAsset = (await h.upload(source, { intent: "selfie", raster: syntheticShirt({ size: 200 }), wearingDate: "2026-09-14" })).asset!.assetId;
    await h.settle(source);

    // The backup is taken while all three images exist.
    const data = await exportMediaData(h.rt, source.principal());
    const files = new Map<string, Uint8Array>();
    for (const f of data.assets) files.set(f.file, new Uint8Array((await readExportFile(h.rt, source.principal(), f.file))!));
    backup = { data, files };
    expect(await listMediaDeletions(h.rt, source.principal())).toMatchObject({ format: "garderobe-media-deletions/1", deletedAssets: [], purgedOriginals: [] });

    // Afterwards the owner deletes the shirt photo, and the selfie's full-resolution original lapses.
    await source.exec("media.delete_asset", { assetId: shirtAsset });
    h.clock.advance(91 * 86_400_000);
    expect((await runMediaMaintenance(h.rt, { startDiscovery: false })).selfieOriginalsRemoved).toBe(1);
    await h.settle(source);
    journal = await listMediaDeletions(h.rt, source.principal());
  });

  it("the journal names exactly what the earlier backup still holds and must not bring back", async () => {
    expect(journal.deletedAssets).toHaveLength(1);
    expect(journal.deletedAssets[0]).toMatchObject({ assetId: shirtAsset, deletedAt: expect.any(String) });
    const inBackup = backup.data.assets.filter((f) => f.assetId === shirtAsset);
    expect(inBackup.map((f) => f.kind).sort()).toEqual(["catalogue", "cutout", "mask", "original"]);
    expect([...journal.deletedAssets[0]!.files].sort()).toEqual(inBackup.map((f) => f.file).sort());
    expect([...journal.deletedAssets[0]!.renditionIds].sort()).toEqual(inBackup.map((f) => f.renditionId).sort());
    const original = backup.data.assets.find((f) => f.assetId === selfieAsset && f.kind === "original")!;
    expect(journal.purgedOriginals).toEqual([{ assetId: selfieAsset, renditionId: original.renditionId, purgedAt: expect.any(String), file: original.file }]);
    expect(JSON.stringify(journal)).not.toContain(source.userId); // package-relative paths, never storage keys
    // The live bytes are gone already; only the backup copy is left, which is why the journal exists.
    expect(await objectsOf(source, shirtAsset)).toEqual([]);
    expect(await objectsOf(source, selfieAsset)).toEqual(["display"]);
    expect(backup.files.has(original.file)).toBe(true);
    // It is the owner's own record: another owner's journal is empty. It is an operational record for backup
    // code, so a read-only connection (an assistant) does not get it.
    const stranger = await h.createSyntheticOwner({ displayName: "Synthetic owner (backup stranger)" });
    expect(await listMediaDeletions(h.rt, stranger.principal())).toMatchObject({ deletedAssets: [], purgedOriginals: [] });
    expect(await code(listMediaDeletions(h.rt, source.principal({ scopes: [] })))).toBe("forbidden");
    expect(await code(listMediaDeletions(h.rt, source.principal({ actor: "assistant", channel: "mcp", scopes: ["read"] })))).toBe("forbidden");
  });

  it("restoring with the journal never writes the deleted bytes back and leaves the garment honestly without an image", async () => {
    const target = await h.createSyntheticOwner({ displayName: "Synthetic owner (restore with journal)" });
    const read: string[] = [];
    const result = await importMediaData(h.rt, importer(target), backup.data, async (key) => {
      read.push(key);
      return backup.files.get(key) ?? null;
    }, { deletions: journal });
    await h.settle(target);
    expect(result.missing).toEqual([]);
    expect(result.mismatched).toEqual([]);
    expect(result.deletionsApplied).toEqual({ assetsDeleted: 1, originalsPurged: 1, filesWithheld: 5 });
    // The deleted files were not even read from the package, and nothing of them is in storage.
    const withheld = new Set([...journal.deletedAssets[0]!.files, journal.purgedOriginals[0]!.file]);
    expect(read.some((key) => withheld.has(key))).toBe(false);
    expect(read.length).toBe(backup.data.assets.length - 5);
    expect(await objectsOf(target, shirtAsset)).toEqual([]);
    expect(await objectsOf(target, selfieAsset)).toEqual(["display"]);

    const shirt = await getGarmentMedia(h.rt, target.principal(), "shirt-moss");
    expect(shirt.assets).toEqual([]);
    expect(shirt).toMatchObject({ imageState: "not_started", image: { hasRealImage: false, renditionId: null, missingImageNote: "No photo yet" } });
    expect(await code(openAssetImage(h.rt, target.principal(), shirtAsset))).toBe("not_found");
    // What was not deleted is restored intact.
    expect((await getGarmentMedia(h.rt, target.principal(), "trouser-olive")).image).toMatchObject({ assetId: trouserAsset, renditionKind: "cutout" });
    expect((await openAssetImage(h.rt, target.principal(), selfieAsset)).contentType).toBe("image/jpeg");
    await expect(openAssetImage(h.rt, target.principal(), selfieAsset, { variant: "original" })).rejects.toThrow(/no longer kept/);
    // The restored owner's own journal carries the deletions forward to any backup taken from now on.
    const carried = await listMediaDeletions(h.rt, target.principal());
    expect(carried.deletedAssets.map((d) => d.assetId)).toEqual([shirtAsset]);
    expect(carried.purgedOriginals.map((d) => d.assetId)).toEqual([selfieAsset]);
    // The deleted image arrives as a tombstone record only: every deletion is in the ledger, attributed to the
    // import, with no file ever written and therefore nothing left to purge.
    expect(await first<{ status: string; status_reason: string }>(h.db, "SELECT status, status_reason FROM media_assets WHERE user_id = ? AND asset_id = ?", target.userId, shirtAsset)).toEqual({ status: "deleted", status_reason: "deleted after the restored backup was taken" });
    expect((await all<{ status: string }>(h.db, "SELECT status FROM media_renditions WHERE user_id = ? AND asset_id = ?", target.userId, shirtAsset)).every((r) => r.status === "deleted")).toBe(true);
    expect(await listMediaJobs(h.rt, target.principal())).toEqual([]);
    // Record counts equal the package's, so a restore check that compares counts still holds.
    expect((await all(h.db, "SELECT 1 FROM media_assets WHERE user_id = ?", target.userId)).length).toBe(backup.data.records.assets.length);
    expect((await all(h.db, "SELECT 1 FROM media_renditions WHERE user_id = ?", target.userId)).length).toBe(backup.data.records.renditions.length);
  });

  it("an import made without the journal brings the image back, and replaying the journal deletes it again", async () => {
    const target = await h.createSyntheticOwner({ displayName: "Synthetic owner (restore, then replay)" });
    await importMediaData(h.rt, importer(target), backup.data, async (key) => backup.files.get(key) ?? null);
    // This is the hazard the journal closes: the old backup still held the photo.
    expect((await getGarmentMedia(h.rt, target.principal(), "shirt-moss")).image.assetId).toBe(shirtAsset);
    expect(await objectsOf(target, shirtAsset)).toEqual(["catalogue", "cutout", "mask", "original"]);
    expect(await objectsOf(target, selfieAsset)).toEqual(["display", "original"]);

    // Only the owner or the system completes a restore.
    expect(await code(replayMediaDeletions(h.rt, target.principal({ actor: "assistant", channel: "mcp" }), journal))).toBe("forbidden");
    expect(await replayMediaDeletions(h.rt, target.principal(), journal)).toEqual({ assetsDeleted: 1, originalsPurged: 1 });
    await h.settle(target);
    expect(await objectsOf(target, shirtAsset)).toEqual([]);
    expect(await objectsOf(target, selfieAsset)).toEqual(["display"]);
    expect((await getGarmentMedia(h.rt, target.principal(), "shirt-moss")).image).toMatchObject({ hasRealImage: false, renditionId: null });
    expect(await code(getAsset(h.rt, target.principal(), shirtAsset))).toBe("not_found"); // review L6: a deleted image's metadata is not returned
    expect(await first<{ status: string; status_reason: string }>(h.db, "SELECT status, status_reason FROM media_assets WHERE user_id = ? AND asset_id = ?", target.userId, shirtAsset)).toEqual({ status: "deleted", status_reason: "deleted after the restored backup was taken" });
    expect((await h.service.listReceipts(target.principal(), { kind: "media_asset", entityId: shirtAsset })).map((r) => r.type)).toContain("media.reapply_deletions");
    expect((await getAsset(h.rt, target.principal(), trouserAsset)).status).toBe("active");
    // Repeating it changes nothing; a journal naming images this owner does not have deletes nothing.
    expect(await replayMediaDeletions(h.rt, target.principal(), journal)).toEqual({ assetsDeleted: 0, originalsPurged: 0 });
    const commands = await all(h.db, "SELECT 1 FROM commands WHERE user_id = ? AND type = 'media.reapply_deletions'", target.userId);
    expect(commands).toHaveLength(1);
    const other = await h.createSyntheticOwner({ displayName: "Synthetic owner (unrelated)" });
    const theirs = (await h.upload(other, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 128 }), demo: true })).asset!.assetId;
    await h.settle(other);
    expect(await replayMediaDeletions(h.rt, other.principal(), journal)).toEqual({ assetsDeleted: 0, originalsPurged: 0 });
    expect((await getAsset(h.rt, other.principal(), theirs)).status).toBe("active");
    expect(await code(replayMediaDeletions(h.rt, target.principal(), { ...journal, format: "something-else" } as never))).toBe("invalid_command");
  });

  it("a backup taken after the deletions holds neither file, and a selfie keeps its reduced copy through a restore", async () => {
    const later = await exportMediaData(h.rt, source.principal());
    expect(later.assets.some((f) => f.assetId === shirtAsset)).toBe(false);
    expect(later.assets.filter((f) => f.assetId === selfieAsset).map((f) => f.kind)).toEqual(["display"]);
    expect(later.records.deletedAssets.map((d) => d.assetId)).toEqual([shirtAsset]);
    // The purged original travels as a record without a file, so the copy derived from it keeps its recorded source.
    expect(later.records.renditions.filter((r) => r.asset_id === selfieAsset).map((r) => [r.kind, r.status]).sort()).toEqual([["display", "active"], ["original", "deleted"]]);
    const target = await h.createSyntheticOwner({ displayName: "Synthetic owner (restore of later backup)" });
    const result = await importMediaData(h.rt, importer(target), later, (file) => readExportFile(h.rt, source.principal(), file));
    expect([result.missing, result.mismatched]).toEqual([[], []]);
    const selfie = await getAsset(h.rt, target.principal(), selfieAsset);
    expect(selfie.renditions.map((r) => [r.kind, r.status]).sort()).toEqual([["display", "active"], ["original", "deleted"]]);
    expect((await openAssetImage(h.rt, target.principal(), selfieAsset)).contentType).toBe("image/jpeg");
    expect(await objectsOf(target, selfieAsset)).toEqual(["display"]);
  });
});
