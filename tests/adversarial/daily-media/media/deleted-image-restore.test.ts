/**
 * Media abuse: getting a deleted image back out of a backup.
 *
 * Specification section 11 ("deletion covers ... attachments, derived media and backups"), section 15
 * ("Backups preserve ... source assets ... with bounded retention"; a restore must not undo a deletion).
 *
 * The owner deletes a photograph AFTER a backup that holds it was taken. The cases then try every way that
 * backup, or a copy of its files, could put the photograph back: restoring the package at once, restoring it
 * where the deletion journal is missing, importing it over the account it came from, writing its records
 * with the import command directly, putting the files back into the bucket, and taking a new backup.
 *
 * Real: the Worker over HTTP (uploads, the deletion command, backups, download tickets, package import,
 * restore verification), its queue consumer, local D1, the private local media bucket and the private
 * export bucket. Stand-ins: test-signed sign-in assertions in place of Cloudflare Access. Two cases reach
 * into a bucket directly to simulate what only an operator or another deployment can do; each says
 * "TEST SETUP". Owners, garments and pictures are SYNTHETIC test fixtures.
 */
import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { APP_ORIGIN, provisionOwner, testApp, type TestOwner } from "@garderobe/worker/testing";
import { decodeImage } from "@garderobe/media/image";
import { cleanJpeg, cleanPng, everyServedCopy, objectKeys, rows, settleJobs, sha256, syntheticOwner, uploadClean, type AbuseOwner } from "./support.ts";

let source: AbuseOwner;
let doomed: { assetId: string; files: { key: string; sha256: string; bytes: Uint8Array; contentType: string }[] };
/** The hash of every form of the deleted photograph's files: as stored, and as written into the backup package. */
let doomedShas: Set<string>;
let keptAssetId: string;
let keptPixelsSha: string;
let backup: { backupId: string; restoreManifest: { ownerRef: string } & Record<string, unknown> };
let zip: Uint8Array;

/** The restored account, seen through the same helpers: same garment IDs as the source (a restore preserves them). */
const restoredAs = (o: TestOwner): AbuseOwner => ({ owner: o, label: "restored", garments: source.garments, slots: source.slots });

const pixelsSha = async (bytes: Uint8Array) => {
  const { raster } = await decodeImage(bytes);
  return sha256(new Uint8Array(raster.data.buffer, raster.data.byteOffset, raster.data.byteLength));
};

async function download(o: TestOwner, backupId: string): Promise<Uint8Array> {
  const ticket = await o.api.json("POST", `/v1/backups/${backupId}/ticket`, {});
  return new Uint8Array(await (await SELF.fetch(`${APP_ORIGIN}${ticket.url}`)).arrayBuffer());
}

async function restoreInto(target: TestOwner): Promise<{ status: number; report: any }> {
  const response = await target.api.request("POST", "/v1/imports", { raw: zip as unknown as BodyInit, headers: { "Content-Type": "application/zip" } });
  return { status: response.status, report: await response.json() };
}

/** The deleted photograph is not readable by this account in any form, and none of its bytes are in its storage. */
async function expectGoneFor(o: AbuseOwner, what: string): Promise<void> {
  await settleJobs(o.owner.userId);
  for (const copy of await everyServedCopy(o, doomed.assetId)) expect(copy.status, `${what}: ${copy.via}`).toBe(404);
  const item = await o.owner.api.get(`/v1/items/${source.garments.top.garmentId}/image`);
  expect(item.status, `${what}: garment image`).toBe(404);
  expect(((await item.json()) as any).error.details.missingImageNote, what).toBe("No photo yet");
  const detail = await o.owner.api.json("GET", `/v1/items/${source.garments.top.garmentId}`);
  expect(detail.media.image, what).toMatchObject({ hasRealImage: false, renditionId: null });
  for (const row of await rows<{ status: string }>("SELECT status FROM media_assets WHERE user_id = ? AND asset_id = ?", o.owner.userId, doomed.assetId)) expect(row.status, what).toBe("deleted");
  for (const row of await rows<{ status: string }>("SELECT status FROM media_renditions WHERE user_id = ? AND asset_id = ?", o.owner.userId, doomed.assetId)) expect(row.status, what).toBe("deleted");
  const app = await testApp();
  const keys = await objectKeys(o.owner.userId);
  expect(keys.filter((k) => k.includes(doomed.assetId)), `${what}: stored files`).toEqual([]);
  // Not under another name either: no stored file of this account has the bytes of a deleted file.
  for (const key of keys) expect(doomedShas.has(await sha256(new Uint8Array(await (await app.env.MEDIA_BUCKET!.get(key))!.arrayBuffer()))), `${what}: ${key}`).toBe(false);
}

/** What was not deleted came through the restore intact. */
async function expectKeptFor(o: AbuseOwner, what: string): Promise<void> {
  const served = await o.owner.api.get(`/v1/media/assets/${keptAssetId}?variant=original`);
  expect(served.status, what).toBe(200);
  expect(await pixelsSha(new Uint8Array(await served.arrayBuffer())), what).toBe(keptPixelsSha);
  expect((await o.owner.api.get(`/v1/items/${source.garments.bottom.garmentId}/image`)).status, what).toBe(200);
}

beforeAll(async () => {
  source = await syntheticOwner("R");
  const u = source.owner.userId;
  const kept = await uploadClean(source, await cleanPng(192, [30, 110, 70]), { role: "bottom" });
  keptAssetId = kept.assetId;
  const original = await source.owner.api.get(`/v1/media/assets/${keptAssetId}?variant=original`);
  keptPixelsSha = await pixelsSha(new Uint8Array(await original.arrayBuffer()));
  const photo = await uploadClean(source, cleanJpeg(192, [170, 40, 90]), { role: "top", declareType: "image/jpeg" });
  const app = await testApp();
  const files: (typeof doomed)["files"] = [];
  for (const r of await rows<{ object_key: string; sha256: string; content_type: string }>("SELECT object_key, sha256, content_type FROM media_renditions WHERE user_id = ? AND asset_id = ?", u, photo.assetId)) {
    files.push({ key: r.object_key, sha256: r.sha256, contentType: r.content_type, bytes: new Uint8Array(await (await app.env.MEDIA_BUCKET!.get(r.object_key))!.arrayBuffer()) });
  }
  doomed = { assetId: photo.assetId, files };
  expect(files.length).toBeGreaterThan(1);
  expect((await source.owner.api.get(`/v1/items/${source.garments.top.garmentId}/image`)).status).toBe(200);

  // The backup is taken while the photograph exists...
  backup = await source.owner.api.json("POST", "/v1/backups", { clientRequestId: `before-deletion-${crypto.randomUUID()}` });
  expect((backup as any).state, JSON.stringify(backup).slice(0, 400)).toBe("completed");
  zip = await download(source.owner, backup.backupId);
  doomedShas = new Set(doomed.files.map((f) => f.sha256));
  for (const [path, bytes] of Object.entries(unzipSync(zip))) if (path.startsWith("media/") && path.includes(doomed.assetId)) doomedShas.add(await sha256(bytes));
  // ...and the owner deletes it afterwards. No scheduled sweep runs between the deletion and the cases below.
  const deleted = await source.owner.api.command("media.delete_asset", { assetId: doomed.assetId });
  expect(deleted.status, await deleted.clone().text()).toBe(200);
  await settleJobs(u);
});

describe("a photograph deleted after a backup was taken", () => {
  it("is gone for its owner, while the earlier backup still holds its files", async () => {
    await expectGoneFor(source, "the owner after deleting");
    await expectKeptFor(source, "the owner after deleting");
    const packaged = Object.entries(unzipSync(zip)).filter(([path]) => path.startsWith("media/") && path.includes(doomed.assetId));
    // One packaged file per stored file (the supplied photograph is written without its metadata, so its
    // bytes may differ from the stored original; the derived files are byte for byte the stored ones).
    expect(packaged.length).toBe(doomed.files.length);
    const stored = new Set(doomed.files.map((f) => f.sha256));
    let identical = 0;
    for (const [, bytes] of packaged) if (stored.has(await sha256(bytes))) identical++;
    expect(identical).toBeGreaterThan(0);
    // The owner's deletion journal names it, by package-relative paths only: no storage key, no owner ID.
    const journal = await source.owner.api.json("GET", "/v1/backups/tombstones");
    expect(journal.mediaDeletions.deletedAssets.map((d: any) => d.assetId)).toContain(doomed.assetId);
    expect(JSON.stringify(journal)).not.toContain(source.owner.userId);
    // Another owner cannot read that journal, the backup, or a ticket for it.
    const stranger = await provisionOwner();
    expect(JSON.stringify(await stranger.api.json("GET", "/v1/backups/tombstones"))).not.toContain(doomed.assetId);
    expect((await stranger.api.json("GET", "/v1/backups")).backups).toEqual([]);
    expect((await stranger.api.post(`/v1/backups/${backup.backupId}/ticket`, {})).status).toBe(404);
  });

  // Regression: the journal a restore consulted was the copy written at the last sweep, so a photograph
  // deleted since then was written back to storage and shown again.
  it("does not come back when that backup is restored straight away, before any sweep", async () => {
    const target = await provisionOwner();
    const { status, report } = await restoreInto(target);
    expect(status, JSON.stringify(report).slice(0, 600)).toBe(200);
    expect(report).toMatchObject({ state: "completed", checksumsVerified: true, idsPreserved: true });
    await expectGoneFor(restoredAs(target), "restored at once");
    await expectKeptFor(restoredAs(target), "restored at once");
    // The restored account carries the deletion forward: a backup taken from it would not hold the files,
    // and its own journal names the photograph.
    const carried = await target.api.json("GET", "/v1/backups/tombstones");
    expect(carried.mediaDeletions.deletedAssets.map((d: any) => d.assetId)).toContain(doomed.assetId);
    // Nothing was left waiting to be removed either: the files were never written.
    expect(await rows("SELECT job_id FROM media_jobs WHERE user_id = ? AND kind = 'purge_objects' AND state != 'succeeded'", target.userId)).toEqual([]);
  });

  it("restored where the deletion journal is missing, is deleted again by restore verification and its files removed", async () => {
    const app = await testApp();
    const key = `backup-journals/${backup.restoreManifest.ownerRef}/tombstones.json`;
    // TEST SETUP: the journal kept beside the backups is taken away for the length of this case, as when the
    // package is restored in a deployment that never had it.
    const stored = await app.env.EXPORT_BUCKET.get(key);
    expect(stored, "the journal is kept beside the backup").not.toBeNull();
    const storedText = await stored!.text();
    const storedMeta = stored!.customMetadata ?? {};
    await app.env.EXPORT_BUCKET.delete(key);
    const target = await provisionOwner();
    try {
      const { status, report } = await restoreInto(target);
      expect(status, JSON.stringify(report).slice(0, 600)).toBe(200);
    } finally {
      await app.env.EXPORT_BUCKET.put(key, storedText, { httpMetadata: { contentType: "application/json" }, customMetadata: storedMeta });
    }
    await settleJobs(target.userId);
    // Without a journal the package is all the import can know, so the photograph may be back at this point.
    const cameBack = (await target.api.get(`/v1/media/assets/${doomed.assetId}`)).status === 200;

    // The owner's journal travels with the restore; verification applies it.
    const journal = await source.owner.api.json("GET", "/v1/backups/tombstones");
    const verified = await target.api.json("POST", "/v1/restore/verify", { restoreManifest: backup.restoreManifest, tombstones: journal });
    expect(verified.mediaDeletionsReplayed.assetsDeleted).toBe(cameBack ? 1 : 0);
    expect(verified.checks.find((c: any) => c.name === "images deleted after the backup stay deleted")).toMatchObject({ ok: true, actual: [] });
    await expectGoneFor(restoredAs(target), "after restore verification");
    await expectKeptFor(restoredAs(target), "after restore verification");
    // Verifying again deletes nothing further and brings nothing back.
    const again = await target.api.json("POST", "/v1/restore/verify", { restoreManifest: backup.restoreManifest, tombstones: journal });
    expect(again.mediaDeletionsReplayed).toEqual({ assetsDeleted: 0, originalsPurged: 0 });
    await expectGoneFor(restoredAs(target), "after verifying twice");
  });

  it("cannot be rolled back onto the account it was deleted from", async () => {
    const before = await objectKeys(source.owner.userId);
    const { status, report } = await restoreInto(source.owner);
    expect(status, JSON.stringify(report).slice(0, 300)).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    expect(await objectKeys(source.owner.userId)).toEqual(before);
    await expectGoneFor(source, "after importing over the same account");
    // Naming it in a deletion replay of someone else's does nothing to the owner's other photograph, and
    // a stranger replaying a journal that names the owner's kept photograph deletes nothing of the owner's.
    const stranger = await provisionOwner();
    const replay = await stranger.api.command("media.reapply_deletions", { assetIds: [keptAssetId, doomed.assetId] });
    expect(replay.status).toBeLessThan(500);
    await settleJobs();
    await expectKeptFor(source, "after a stranger's deletion replay");
  });

  it("cannot be written back with the import command directly: a record without a file this import verified is refused", async () => {
    const u = source.owner.userId;
    const before = { assets: await rows("SELECT asset_id, status FROM media_assets WHERE user_id = ? ORDER BY asset_id", u), renditions: await rows("SELECT rendition_id, status FROM media_renditions WHERE user_id = ? ORDER BY rendition_id", u), keys: await objectKeys(u) };
    const packagedMedia = JSON.parse(new TextDecoder().decode(unzipSync(zip)["records/media.json"]!));
    const records = (packagedMedia.records?.records ?? packagedMedia.records) as { assets: any[]; renditions: any[] };
    const asset = records.assets.find((a) => a.asset_id === doomed.assetId);
    const renditions = records.renditions.filter((r) => r.asset_id === doomed.assetId);
    expect(asset).toBeTruthy();
    const attempts: Record<string, unknown>[] = [
      { part: "assets", rows: { assets: [asset], renditions } },
      { part: "assets", rows: { assets: [{ ...asset, asset_id: "ast_reborn0000000000000000" }], renditions: renditions.map((r, i) => ({ ...r, asset_id: "ast_reborn0000000000000000", rendition_id: `rnd_reborn00000000000000${i}` })) } },
      { part: "garmentMedia", rows: { garmentMedia: [{ garment_id: source.garments.top.garmentId, image_state: "resolved", primary_asset_id: doomed.assetId, version: 99, updated_at: new Date().toISOString() }] } },
    ];
    // A fresh, empty account tries too: the files are not in ITS storage either.
    const fresh = await provisionOwner();
    for (const payload of attempts) {
      for (const who of [source.owner, fresh]) {
        for (const authorization of ["data_import", "owner_tap"]) {
          const response = await who.api.post("/v1/commands", { type: "media.import_records", payload, idempotencyKey: `reborn-${crypto.randomUUID()}`, expectedVersions: {}, authorization, source: { channel: "ios" } });
          const text = await response.text();
          expect(response.status, `${payload.part} as ${authorization}: ${text.slice(0, 300)}`).toBeGreaterThanOrEqual(400);
          expect(response.status, text.slice(0, 300)).toBeLessThan(500);
        }
      }
    }
    await settleJobs();
    expect(await rows("SELECT asset_id, status FROM media_assets WHERE user_id = ? ORDER BY asset_id", u)).toEqual(before.assets);
    expect(await rows("SELECT rendition_id, status FROM media_renditions WHERE user_id = ? ORDER BY rendition_id", u)).toEqual(before.renditions);
    expect(await objectKeys(u)).toEqual(before.keys);
    expect(await rows("SELECT 1 FROM media_assets WHERE user_id = ?", fresh.userId)).toEqual([]);
    expect(await objectKeys(fresh.userId)).toEqual([]);
    await expectGoneFor(source, "after direct import commands");
  });

  it("is not served, and not backed up again, when its files are put back into the bucket", async () => {
    const app = await testApp();
    const u = source.owner.userId;
    // TEST SETUP: the deleted files reappear at their old keys, as after an operator restores bucket objects
    // from a bucket-level copy. No request can do this.
    for (const f of doomed.files) await app.env.MEDIA_BUCKET!.put(f.key, f.bytes, { httpMetadata: { contentType: f.contentType }, customMetadata: { sha256: f.sha256 } });
    try {
      for (const copy of await everyServedCopy(source, doomed.assetId)) expect(copy.status, copy.via).toBe(404);
      expect((await source.owner.api.get(`/v1/items/${source.garments.top.garmentId}/image`)).status).toBe(404);
      for (const id of await rows<{ rendition_id: string }>("SELECT rendition_id FROM media_renditions WHERE user_id = ? AND asset_id = ?", u, doomed.assetId)) {
        expect((await source.owner.api.post(`/v1/media/renditions/${id.rendition_id}/sign`, {})).status).toBe(404);
      }
      // An outfit preview drawn now uses the garment's placeholder, not the stray file.
      const preview = await source.owner.api.json("POST", "/v1/studio/previews", { clientRequestId: `stray-${crypto.randomUUID()}`, slots: source.slots() });
      await settleJobs(u);
      const composition = JSON.stringify(await source.owner.api.json("GET", `/v1/studio/compositions/${preview.manifestHash}`));
      expect(composition).not.toContain(doomed.assetId);

      // A backup and a portable export taken now hold neither the files nor their bytes.
      const later = await source.owner.api.json("POST", "/v1/backups", { clientRequestId: `after-deletion-${crypto.randomUUID()}` });
      expect(later.state).toBe("completed");
      for (const [path, bytes] of Object.entries(unzipSync(await download(source.owner, later.backupId)))) {
        if (!path.startsWith("media/")) continue;
        expect(path.includes(doomed.assetId), path).toBe(false);
        expect(doomedShas.has(await sha256(bytes)), path).toBe(false);
      }
    } finally {
      // TEST CLEANUP: the stray files are taken away again.
      await app.env.MEDIA_BUCKET!.delete(doomed.files.map((f) => f.key));
    }
    await expectGoneFor(source, "after the stray files were removed");
    await expectKeptFor(source, "at the end");
  });
});
