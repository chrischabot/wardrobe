import { describe, expect, it } from "vitest";
import { all } from "@garderobe/domain";
import type { TestOwner } from "@garderobe/domain/testing";
import { exportMediaData, getComposition, importMediaData, openCompositePreview, readExportFile, requestCompositePreview } from "../src/index.ts";
import { decodePng } from "../src/image/index.ts";
import { createMediaHarness, syntheticShirt, syntheticTrousers } from "../src/testing/index.ts";

// Review of 93207a48: the upload byte limit bounds originals only, generated files have their own limit; an import
// writes only files of renditions it imports, orders images by each rendition's own source, and runs no clean-up
// when it wrote nothing. SYNTHETIC TEST IMAGES (labelled demo placeholders) and test records only, on real local R2.

const importer = (o: TestOwner) => o.principal({ channel: "import", actor: "system", scopes: ["read", "write", "admin"] });

describe("generated files are bounded by their own limit, not the upload limit", () => {
  it("a composite draws an approved generated image larger than the upload limit", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (generated limit, composite)" });
    await h.upload(owner, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 320 }), demo: true });
    await h.settle(owner);
    const slots = [{ role: "top" as const, garmentId: "shirt-moss" }];
    const { manifestHash } = await requestCompositePreview(h.rt, owner.principal(), { slots });
    const layer = (await getComposition(h.rt, owner.principal(), manifestHash)).manifest.layers.find((l) => l.role === "top")!;
    const drawn = await all<{ kind: string; byte_length: number }>(h.db, "SELECT kind, byte_length FROM media_renditions WHERE user_id = ? AND rendition_id = ?", owner.userId, layer.renditionId);
    expect(drawn[0]!.kind).not.toBe("original");
    // TEST SETUP: the upload limit is now far below the generated file's size; the generated-file limit is unchanged.
    h.deps.limits = { ...(h.deps.limits ?? {}), maxUploadBytes: 1024 };
    expect(drawn[0]!.byte_length).toBeGreaterThan(1024);
    await h.settle(owner);
    const done = await getComposition(h.rt, owner.principal(), manifestHash);
    expect(done.preview.state).toBe("rendered");
    const raster = await decodePng(new Uint8Array(await new Response((await openCompositePreview(h.rt, owner.principal(), manifestHash)).body).arrayBuffer()));
    // The shirt is drawn (the synthetic shirt's blue), not replaced by a missing-image outline.
    const top = done.manifest.layers.find((l) => l.role === "top")!;
    const edge = Math.min(top.width * raster.width, top.height * raster.height);
    const x = Math.round(top.x * raster.width + (top.width * raster.width - edge) / 2 + edge * 0.36);
    const y = Math.round(top.y * raster.height + (top.height * raster.height - edge) / 2 + edge * 0.8);
    expect(raster.data[(y * raster.width + x) * 4 + 2]!).toBeGreaterThan(raster.data[(y * raster.width + x) * 4]! + 60);
  });

  it("an import keeps a generated file larger than the upload limit while originals stay bounded by it", async () => {
    const h = await createMediaHarness();
    const source = await h.createSyntheticOwner({ displayName: "Synthetic owner (generated limit, import source)" });
    await h.upload(source, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 128 }), demo: true });
    await h.settle(source);
    const data = await exportMediaData(h.rt, source.principal());
    const originalBytes = Math.max(...data.assets.filter((f) => f.kind === "original").map((f) => f.byteLength));
    const derived = data.assets.filter((f) => f.kind !== "original");
    expect(derived.length).toBeGreaterThan(0);
    expect(Math.max(...derived.map((f) => f.byteLength))).toBeGreaterThan(originalBytes); // the case under test
    // TEST SETUP: the upload limit is exactly the largest original.
    h.deps.limits = { ...(h.deps.limits ?? {}), maxUploadBytes: originalBytes };
    const target = await h.createSyntheticOwner({ displayName: "Synthetic owner (generated limit, import target)" });
    const result = await importMediaData(h.rt, importer(target), data, (file) => readExportFile(h.rt, source.principal(), file));
    expect(result.rejected).toEqual([]);
    expect(result.imported.files).toBe(data.assets.length);
    // One byte less and the original itself is refused.
    h.deps.limits = { ...(h.deps.limits ?? {}), maxUploadBytes: originalBytes - 1 };
    const other = await h.createSyntheticOwner({ displayName: "Synthetic owner (generated limit, import target 2)" });
    const refused = await importMediaData(h.rt, importer(other), data, (file) => readExportFile(h.rt, source.principal(), file));
    expect(refused.rejected.length).toBeGreaterThan(0);
    expect(refused.rejected.every((f) => data.assets.find((a) => a.file === f)?.kind === "original")).toBe(true);
  });
});

describe("an import writes only what it imports, in rendition-source order", () => {
  it("a verified derived file whose source did not come through is not written", async () => {
    const h = await createMediaHarness();
    const source = await h.createSyntheticOwner({ displayName: "Synthetic owner (dropped rendition source)" });
    const up = await h.upload(source, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 128 }), demo: true });
    await h.settle(source);
    const data = await exportMediaData(h.rt, source.principal());
    const id = up.asset!.assetId;
    const original = data.assets.find((f) => f.assetId === id && f.kind === "original")!;
    expect(data.assets.some((f) => f.assetId === id && f.kind !== "original")).toBe(true);
    const target = await h.createSyntheticOwner({ displayName: "Synthetic owner (dropped rendition source, target)" });
    // TEST SETUP: the original's file is missing from the package; every derived file of the image is intact.
    const result = await importMediaData(h.rt, importer(target), data, async (file) => (file === original.file ? null : readExportFile(h.rt, source.principal(), file)));
    expect(result.missing).toEqual([original.file]);
    expect(result.imported.files).toBe(0);
    expect(await all(h.db, "SELECT 1 FROM media_assets WHERE user_id = ? AND asset_id = ?", target.userId, id)).toEqual([]);
    expect((await h.deps.bucket.list({ prefix: `u/${target.userId}/assets/${id}/` })).objects).toEqual([]);
  });

  it("an image whose rendition is made from another image's rendition is imported after it, across commands", async () => {
    const h = await createMediaHarness();
    const source = await h.createSyntheticOwner({ displayName: "Synthetic owner (cross-image rendition source)" });
    // 26 images: more than one import command holds (25 images each).
    const ups = [];
    for (let i = 0; i < 26; i++) ups.push(await h.upload(source, { garmentId: i % 2 ? "shirt-moss" : "trouser-olive", raster: i % 2 ? syntheticShirt({ size: 64 + i }) : syntheticTrousers({ size: 64 + i }), demo: true }));
    await h.settle(source);
    const exported = await exportMediaData(h.rt, source.principal());
    const dependent = ups[0]!.asset!.assetId;
    const base = ups[25]!.asset!.assetId;
    const baseOriginal = exported.records.renditions.find((r) => r.asset_id === base && r.kind === "original")!;
    // TEST SETUP: the first image's derived rendition names the LAST image's original as its source, with no
    // image-level link between them; the first image is listed first, the last image last.
    const data = { ...exported, records: { ...exported.records, renditions: exported.records.renditions.map((r) => (r.asset_id === dependent && r.kind !== "original" && r.source_rendition_id ? { ...r, source_rendition_id: baseOriginal.rendition_id } : r)) } };
    data.records.assets = [...data.records.assets.filter((a) => a.asset_id === dependent), ...data.records.assets.filter((a) => a.asset_id !== dependent && a.asset_id !== base), ...data.records.assets.filter((a) => a.asset_id === base)];
    expect(data.records.assets.find((a) => a.asset_id === dependent)?.derived_from_asset_id ?? null).toBeNull();
    const target = await h.createSyntheticOwner({ displayName: "Synthetic owner (cross-image rendition source, target)" });
    const result = await importMediaData(h.rt, importer(target), data, (file) => readExportFile(h.rt, source.principal(), file));
    expect([result.missing, result.mismatched, result.rejected]).toEqual([[], [], []]);
    const linked = await all<{ source_rendition_id: string }>(h.db, "SELECT source_rendition_id FROM media_renditions WHERE user_id = ? AND asset_id = ? AND kind != 'original'", target.userId, dependent);
    expect(linked.map((r) => r.source_rendition_id)).toContain(baseOriginal.rendition_id);

    // The image-level link alone orders too: an image derived from the last-listed image, with no rendition made
    // from it, is still committed after it.
    const child = ups[1]!.asset!.assetId;
    const byLink = { ...exported, records: { ...exported.records, assets: [...exported.records.assets.filter((a) => a.asset_id === child).map((a) => ({ ...a, derived_from_asset_id: base })), ...exported.records.assets.filter((a) => a.asset_id !== child && a.asset_id !== base), ...exported.records.assets.filter((a) => a.asset_id === base)] } };
    const linkTarget = await h.createSyntheticOwner({ displayName: "Synthetic owner (image-level link, target)" });
    const linkResult = await importMediaData(h.rt, importer(linkTarget), byLink, (file) => readExportFile(h.rt, source.principal(), file));
    expect([linkResult.missing, linkResult.mismatched, linkResult.rejected]).toEqual([[], [], []]);
    const order = await all<{ asset_id: string; derived_from_asset_id: string | null }>(h.db, "SELECT asset_id, derived_from_asset_id FROM media_assets WHERE user_id = ? AND asset_id IN (?, ?) ORDER BY rowid", linkTarget.userId, child, base);
    expect(order.map((r) => r.asset_id)).toEqual([base, child]);
    expect(order.find((r) => r.asset_id === child)?.derived_from_asset_id).toBe(base);

    // An image derived from itself is a cycle: refused before anything is written.
    const selfLinked = { ...exported, records: { ...exported.records, assets: exported.records.assets.map((a) => (a.asset_id === child ? { ...a, derived_from_asset_id: child } : a)) } };
    const selfTarget = await h.createSyntheticOwner({ displayName: "Synthetic owner (image-level self link, target)" });
    await expect(importMediaData(h.rt, importer(selfTarget), selfLinked, (file) => readExportFile(h.rt, source.principal(), file))).rejects.toMatchObject({ code: "invalid_command" });
    expect((await h.deps.bucket.list({ prefix: `u/${selfTarget.userId}/` })).objects).toEqual([]);
    expect(await all(h.db, "SELECT 1 FROM media_assets WHERE user_id = ?", selfTarget.userId)).toEqual([]);
    expect(await all(h.db, "SELECT 1 FROM media_import_locks WHERE user_id = ?", selfTarget.userId)).toEqual([]);
  });

  it("an import that writes nothing runs no clean-up, so it cannot remove another import's files", async () => {
    const h = await createMediaHarness();
    const empty = await h.createSyntheticOwner({ displayName: "Synthetic owner (empty package source)" });
    const data = await exportMediaData(h.rt, empty.principal());
    expect(data.assets).toEqual([]);
    const target = await h.createSyntheticOwner({ displayName: "Synthetic owner (empty package target)" });
    // TEST SETUP: another import (another plan) has written a file whose record it has not committed yet.
    const inFlight = `u/${target.userId}/assets/asset_in_flight/original-0123456789abcdef.png`;
    await h.deps.bucket.put(inFlight, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]), { customMetadata: { imported: "true", importPlan: "f".repeat(32), assetId: "asset_in_flight" } });
    await importMediaData(h.rt, importer(target), data, async () => null);
    expect(await h.deps.bucket.head(inFlight)).not.toBeNull();
  });

  it("an import whose lock no longer names it after its records are in stops without cleaning; one that still holds it cleans", async () => {
    const h = await createMediaHarness();
    const source = await h.createSyntheticOwner({ displayName: "Synthetic owner (lost lock before clean-up, source)" });
    await h.upload(source, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 128 }), demo: true });
    await h.settle(source);
    const data = await exportMediaData(h.rt, source.principal());
    const read = (file: string) => readExportFile(h.rt, source.principal(), file);
    const abandoned = (o: TestOwner) => `u/${o.userId}/assets/asset_abandoned/original-0123456789abcdef.png`;
    const putAbandoned = (o: TestOwner) => h.deps.bucket.put(abandoned(o), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]), { customMetadata: { imported: "true", importPlan: "e".repeat(32), assetId: "asset_abandoned" } });

    // Control: an import that keeps its lock removes a superseded run's file for an image it has no record of.
    const kept = await h.createSyntheticOwner({ displayName: "Synthetic owner (lock kept, target)" });
    await putAbandoned(kept);
    await importMediaData(h.rt, importer(kept), data, read);
    expect(await h.deps.bucket.head(abandoned(kept))).toBeNull();

    // TEST DOUBLE around the real D1 binding: the statement that sets the clean-up marker is replaced by one that
    // rewrites the owner's lock to another package and plan, as if ownership changed exactly when clean-up began.
    const lost = await h.createSyntheticOwner({ displayName: "Synthetic owner (lock lost, target)" });
    await putAbandoned(lost);
    const db = h.rt.db;
    const realPrepare = db.prepare.bind(db);
    let swapped = 0;
    db.prepare = ((sql: string) => {
      if (!sql.startsWith("UPDATE media_import_locks SET cleanup_started_at")) return realPrepare(sql);
      swapped++;
      return realPrepare(`UPDATE media_import_locks SET package_digest = '${"d".repeat(32)}', plan_digest = '${"d".repeat(32)}' WHERE user_id = ?2 AND ?1 IS NOT NULL AND ?3 IS NOT NULL AND ?4 IS NOT NULL`);
    }) as typeof db.prepare;
    try {
      await expect(importMediaData(h.rt, importer(lost), data, read)).rejects.toMatchObject({ code: "precondition_failed", message: expect.stringMatching(/clean-up was not run/) });
    } finally {
      db.prepare = realPrepare;
    }
    expect(swapped).toBe(1);
    // Every record was committed; only the clean-up was withheld.
    expect((await all(h.db, "SELECT 1 FROM media_assets WHERE user_id = ?", lost.userId)).length).toBeGreaterThan(0);
    expect(await h.deps.bucket.head(abandoned(lost))).not.toBeNull();
  });
});
