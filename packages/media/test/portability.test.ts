import { beforeAll, describe, expect, it } from "vitest";
import { outfitValidator, registerDaily } from "@garderobe/daily";
import { all, isCommandError } from "@garderobe/domain";
import type { TestOwner } from "@garderobe/domain/testing";
import {
  exportMediaData, getComposition, getGarmentMedia, importMediaData, listMediaJobs, listPhotosNeeded, listStudioCombinations, listStudioDayPlans, openAssetImage, requestCompositePreview, type DiscoveryProvider, type MediaExport,
} from "../src/index.ts";
import { encodePng } from "../src/image/index.ts";
import { createMediaHarness, syntheticShirt, syntheticTrousers, type MediaHarness } from "../src/testing/index.ts";

// SYNTHETIC TEST IMAGES on synthetic fixture garments (labelled demo placeholders). The search provider is a
// TEST DOUBLE that finds nothing, used only to put one garment into Photos needed before the export.

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return isCommandError(e) ? e.code : `threw:${String(e)}`;
  }
}

const OUTFIT = [{ role: "top", garmentId: "shirt-moss" }, { role: "bottom", garmentId: "trouser-olive" }, { role: "footwear", garmentId: "shoe-navy" }, { role: "socks", garmentId: "sock-navy" }] as const;
const emptySearch: DiscoveryProvider = { name: "test-double-search", strategies: ["maker_catalogue", "identifier_search"], usesBrowser: false, async search() { return { pages: [], browserSessions: 0, browserSeconds: 0 }; } };

describe("portable export and clean import of the visual wardrobe", () => {
  let h: MediaHarness;
  let source: TestOwner;
  let data: MediaExport;
  let shirtAsset: string;
  let trouserAsset: string;
  let deletedAsset: string;
  let combinationId: string;
  let planId: string;
  let previewHash: string;
  const importer = (o: TestOwner) => o.principal({ channel: "import", actor: "system", scopes: ["read", "write", "admin"] });
  const fromSource = async (key: string) => (await h.bindings.MEDIA_BUCKET.get(key))?.arrayBuffer() ?? null;
  const newTarget = async (name: string) => {
    const target = await h.createSyntheticOwner({ displayName: name });
    await target.exec("garment.create", { garmentId: "needs-photo", name: "fixture shirt without a photo", category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, maker: "Test Maker", product: "Oxford Shirt", colour: "Blue", isSynthetic: true, source: { kind: "system", note: "synthetic test fixture" } });
    return target;
  };

  beforeAll(async () => {
    h = await createMediaHarness({ adapters: { validator: outfitValidator, discoveryProviders: [emptySearch] }, extend: (registry) => registerDaily(registry) });
    source = await h.createSyntheticOwner({ displayName: "Synthetic owner (export source)" });
    await source.exec("garment.create", { garmentId: "needs-photo", name: "fixture shirt without a photo", category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, maker: "Test Maker", product: "Oxford Shirt", colour: "Blue", isSynthetic: true, source: { kind: "system", note: "synthetic test fixture" } });
    shirtAsset = (await h.upload(source, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 256 }), demo: true })).asset!.assetId;
    trouserAsset = (await h.upload(source, { garmentId: "trouser-olive", raster: syntheticTrousers({ size: 256 }), demo: true })).asset!.assetId;
    deletedAsset = (await h.upload(source, { garmentId: "shirt-gold", raster: syntheticShirt({ size: 128 }), demo: true })).asset!.assetId;
    await h.upload(source, { intent: "selfie", raster: syntheticShirt({ size: 200 }), wearingDate: "2026-09-14" });
    await source.exec("media.request_discovery", { garmentIds: ["needs-photo"] });
    await h.settle(source);
    await source.exec("media.delete_asset", { assetId: deletedAsset });
    // An upload that was authorized but never finalized: not part of anyone's records.
    await source.exec("media.authorize_upload", { intent: "attachment", contentType: "image/png", byteLength: 1000 });
    combinationId = String((await source.exec("studio.save_combination", { name: "Moss and olive", favourite: true, slots: OUTFIT, mode: "for_today" })).result.combinationId);
    planId = String((await source.exec("studio.plan_for_day", { localDate: "2026-09-16", combinationId })).result.planId);
    previewHash = (await requestCompositePreview(h.rt, source.principal(), { slots: [...OUTFIT] })).manifestHash;
    await h.settle(source);
    data = await exportMediaData(h.rt, source.principal());
  });

  it("exports documented records with provenance and checksummed files, and nothing secret or transient", async () => {
    expect(data.format).toBe("garderobe-media-export-1");
    expect(data.records.assets.map((a) => a.asset_id)).toEqual(expect.arrayContaining([shirtAsset, trouserAsset]));
    expect(data.records.assets.map((a) => a.asset_id)).not.toContain(deletedAsset);
    expect(data.records.deletedAssets).toEqual([{ assetId: deletedAsset, deletedAt: expect.any(String) }]); // a tombstone only
    // Every exported rendition names its source and its transformation steps; demo placeholders stay labelled.
    const shirtRenditions = data.records.renditions.filter((r) => r.asset_id === shirtAsset);
    expect(shirtRenditions.map((r) => r.kind).sort()).toEqual(["catalogue", "cutout", "mask", "original"]);
    const original = shirtRenditions.find((r) => r.kind === "original")!;
    const cutout = shirtRenditions.find((r) => r.kind === "cutout")!;
    expect(cutout.source_rendition_id).toBe(original.rendition_id);
    expect(JSON.parse(String(cutout.transformations_json)).map((t: { step: string }) => t.step)).toEqual(["decode", "uniform_background_flood_fill"]);
    expect(data.records.assets.find((a) => a.asset_id === shirtAsset)).toMatchObject({ is_demo: 1, kind: "owner_photo", garment_id: "shirt-moss" });
    expect(data.records.fidelityChecks.filter((f) => f.asset_id === shirtAsset)).toHaveLength(1);
    expect(data.records.garmentMedia.find((m) => m.garment_id === "needs-photo")).toMatchObject({ image_state: "photos_needed", photo_request: expect.stringMatching(/^A front-on photo of fixture shirt without a photo/) });
    expect(data.records.discoveryAttempts.filter((a) => a.garment_id === "needs-photo").length).toBeGreaterThan(0);
    expect(data.records.combinations.map((c) => c.combination_id)).toEqual([combinationId]);
    expect(data.records.dayPlans.map((p) => p.plan_id)).toEqual([planId]);
    expect(data.records.composites.map((c) => c.manifest_hash)).toContain(previewHash);

    // The file list is exactly the live renditions, each with the checksum of the bytes in private storage.
    expect(data.assets.map((f) => f.renditionId).sort()).toEqual(data.records.renditions.map((r) => String(r.rendition_id)).sort());
    for (const file of data.assets) {
      expect(file.r2Key.startsWith(`u/${source.userId}/assets/`)).toBe(true);
      const bytes = new Uint8Array((await fromSource(file.r2Key))!);
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
      expect([digest, bytes.length]).toEqual([file.sha256, file.byteLength]);
    }
    // Rendered previews (a rebuildable cache), staging bytes and deleted files are not in the package.
    expect(data.assets.some((f) => f.r2Key.includes("/composites/") || f.r2Key.includes("/staging/") || f.r2Key.includes(deletedAsset))).toBe(false);
    // No owner identifier columns, command references, upload authorizations, jobs, tokens or signing material.
    const text = JSON.stringify(data);
    expect(Object.keys(data.records).sort()).toEqual(["assets", "candidates", "combinationItems", "combinations", "composites", "dayPlanItems", "dayPlans", "deletedAssets", "discoveryAttempts", "fidelityChecks", "garmentMedia", "renditions"]);
    expect(text).not.toMatch(/"user_id"|"command_id"|"upload_id":"|token|signing|preview_key|lease_until/);
    expect(text).not.toContain(h.deps.signingKey);
    // Export is a read of one's own records only.
    expect(await code(exportMediaData(h.rt, source.principal({ scopes: [] })))).toBe("forbidden");
    const stranger = await h.createSyntheticOwner({ displayName: "Synthetic owner (export stranger)" });
    const theirs = await exportMediaData(h.rt, stranger.principal());
    expect([theirs.assets, theirs.records.assets, theirs.records.combinations, theirs.records.dayPlans]).toEqual([[], [], [], []]);
  });

  it("imports into an empty owner with every ID preserved, files re-keyed and verified, and nothing external replayed", async () => {
    const target = await newTarget("Synthetic owner (import target)");
    // Only the import authorization may write exported rows.
    expect(await code(importMediaData(h.rt, target.principal(), data, fromSource))).toBe("forbidden");
    const read: string[] = [];
    const result = await importMediaData(h.rt, importer(target), data, async (key) => {
      read.push(key);
      return fromSource(key);
    });
    expect(result).toEqual({ imported: { assets: data.records.assets.length, renditions: data.records.renditions.length, files: data.assets.length }, missing: [], mismatched: [], deletionsApplied: { assetsDeleted: 0, originalsPurged: 0, filesWithheld: 0 } });
    expect(read.sort()).toEqual(data.assets.map((f) => f.r2Key).sort());

    // The same asset and rendition identities, now under the importing owner's own prefix.
    const media = await getGarmentMedia(h.rt, target.principal(), "shirt-moss");
    expect(media).toMatchObject({ imageState: "resolved", image: { assetId: shirtAsset, isDemo: true, displayLabel: "Demo placeholder", hasRealImage: false, renditionKind: "cutout" } });
    expect(media.assets[0]!.fidelity).toHaveLength(1);
    const sourceMedia = await getGarmentMedia(h.rt, source.principal(), "shirt-moss");
    expect(media.assets[0]!.renditions.map((r) => [r.renditionId, r.kind, r.sha256, r.sourceRenditionId, r.transformations])).toEqual(sourceMedia.assets[0]!.renditions.map((r) => [r.renditionId, r.kind, r.sha256, r.sourceRenditionId, r.transformations]));
    const keys = await all<{ object_key: string }>(h.db, "SELECT object_key FROM media_renditions WHERE user_id = ?", target.userId);
    expect(keys.length).toBe(data.assets.length);
    expect(keys.every((k) => k.object_key.startsWith(`u/${target.userId}/assets/`))).toBe(true);
    const mine = new Uint8Array(await new Response((await openAssetImage(h.rt, target.principal(), shirtAsset, { variant: "original" })).body).arrayBuffer());
    const theirs = new Uint8Array(await new Response((await openAssetImage(h.rt, source.principal(), shirtAsset, { variant: "original" })).body).arrayBuffer());
    expect(mine).toEqual(theirs);
    expect(mine).toEqual(await encodePng(syntheticShirt({ size: 256 })));

    // Photos needed, combinations and plans arrive; the plan is flagged for a fresh check and re-validated on read.
    expect((await listPhotosNeeded(h.rt, target.principal())).map((p) => p.garmentId)).toEqual(["needs-photo"]);
    expect((await getGarmentMedia(h.rt, target.principal(), "shirt-gold")).image).toMatchObject({ hasRealImage: false, renditionId: null }); // the deleted image stays deleted
    expect(await listStudioCombinations(h.rt, target.principal())).toEqual([expect.objectContaining({ combinationId, name: "Moss and olive", favourite: true })]);
    const plans = await listStudioDayPlans(h.rt, target.principal());
    expect(plans).toEqual([expect.objectContaining({ planId, localDate: "2026-09-16", combinationId, needsRevalidation: true, revalidationReason: "imported: re-check against current availability", exposureId: null })]);
    expect(plans[0]!.validation).toMatchObject({ valid: true, validator: "daily-service" });
    // Nothing external is replayed: no job, no exposure, no rendered preview (the manifest is kept for rebuilding).
    expect(await listMediaJobs(h.rt, target.principal())).toEqual([]);
    expect(await all(h.db, "SELECT 1 FROM exposure_sets WHERE user_id = ?", target.userId)).toHaveLength(0);
    expect(await all(h.db, "SELECT 1 FROM outbox WHERE user_id = ? AND topic = 'media.job'", target.userId)).toHaveLength(0);
    expect((await getComposition(h.rt, target.principal(), previewHash)).preview.state).toBe("none");
    expect((await h.bindings.MEDIA_BUCKET.list({ prefix: `u/${target.userId}/composites/` })).objects).toHaveLength(0);
    // Every imported row is attributed to an import command with a receipt.
    const commands = await all<{ type: string }>(h.db, "SELECT DISTINCT type FROM commands WHERE user_id = ? AND command_id IN (SELECT command_id FROM media_assets WHERE user_id = ?)", target.userId, target.userId);
    expect(commands).toEqual([{ type: "media.import_records" }]);

    // A second import, or an import into an owner who already has media, is refused; the source is untouched.
    expect(await code(importMediaData(h.rt, importer(target), data, fromSource))).toBe("precondition_failed");
    expect(await code(importMediaData(h.rt, importer(source), data, fromSource))).toBe("precondition_failed");
    expect(await code(importMediaData(h.rt, importer(target), { ...data, format: "something-else" } as never, fromSource))).toBe("invalid_command");
    expect(await exportMediaData(h.rt, source.principal())).toEqual({ ...data, exportedAt: expect.any(String) });
    // A round trip is stable: exporting the imported owner gives the same records under the new owner's prefix.
    const again = await exportMediaData(h.rt, target.principal());
    expect(again.records.renditions.map((r) => [r.rendition_id, r.sha256, String(r.file).replace(target.userId, "X")])).toEqual(data.records.renditions.map((r) => [r.rendition_id, r.sha256, String(r.file).replace(source.userId, "X")]));
    expect(again.records.combinations.map((c) => [c.combination_id, c.slots_json, c.signature])).toEqual(data.records.combinations.map((c) => [c.combination_id, c.slots_json, c.signature]));
  });

  it("reports missing and altered files, imports nothing that depends on them, and leaves the garment honestly without an image", async () => {
    const target = await newTarget("Synthetic owner (import target, damaged package)");
    const shirtCatalogue = data.assets.find((f) => f.assetId === shirtAsset && f.kind === "catalogue")!;
    const trouserOriginal = data.assets.find((f) => f.assetId === trouserAsset && f.kind === "original")!;
    const result = await importMediaData(h.rt, importer(target), data, async (key) => {
      if (key === shirtCatalogue.r2Key) return null; // not in the package
      const bytes = await fromSource(key);
      if (key === trouserOriginal.r2Key && bytes) {
        const altered = new Uint8Array(bytes);
        altered[altered.length - 20] = altered[altered.length - 20]! ^ 0xff; // bytes that no longer match the checksum
        return altered;
      }
      return bytes;
    });
    expect(result.missing).toEqual([shirtCatalogue.r2Key]);
    expect(result.mismatched).toEqual([trouserOriginal.r2Key]);
    // The shirt keeps its verified files; only the missing catalogue view is absent.
    const shirt = await getGarmentMedia(h.rt, target.principal(), "shirt-moss");
    expect(shirt.assets[0]!.renditions.map((r) => r.kind).sort()).toEqual(["cutout", "mask", "original"]);
    expect(shirt.image.renditionKind).toBe("cutout");
    // The trousers' original failed verification: nothing derived from it is trusted, and no image is claimed.
    const trousers = await getGarmentMedia(h.rt, target.principal(), "trouser-olive");
    expect(trousers.assets).toEqual([]);
    expect(trousers).toMatchObject({ imageState: "not_started", image: { hasRealImage: false, renditionId: null, missingImageNote: "No photo yet" } });
    expect((await h.bindings.MEDIA_BUCKET.list({ prefix: `u/${target.userId}/assets/${trouserAsset}/original` })).objects).toHaveLength(0);
    expect(result.imported.assets).toBe(data.records.assets.length - 1);
  });
});
