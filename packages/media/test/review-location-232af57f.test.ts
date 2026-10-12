import { describe, expect, it } from "vitest";
import { all, isCommandError } from "@garderobe/domain";
import { exportMediaData, getAsset, importMediaData, openRendition, purgeOwnerMediaCache, readExportFile, withoutLocation } from "../src/index.ts";
import { legacyThumbnailCacheUrl, thumbnailCacheUrl } from "../src/delivery.ts";
import { decodeJpeg, encodeJpeg, probeImage } from "../src/image/index.ts";
import { jpegScanDataBytes, stripJpegMetadata } from "../src/image/jpeg.ts";
import { createMediaHarness, syntheticShirt } from "../src/testing/index.ts";

// Regression tests for the review of commit 232af57f and for the adversarial defects MEDIA-ABUSE-1 and
// MEDIA-ABUSE-2. SYNTHETIC TEST IMAGES on labelled demo fixture garments; the HEIC file is a structural TEST
// container; the JFIF, Adobe and reserved segments are hand-built TEST DATA.

const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (isCommandError(e) ? e.code : `threw:${String(e)}`));
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("");
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const segment = (marker: number, body: Uint8Array) => concat(new Uint8Array([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body);
const sha256 = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

function heicShell(width: number, height: number): Uint8Array {
  const out = new Uint8Array(96);
  out.set([0, 0, 0, 24]);
  out.set(ascii("ftypheic"), 4);
  out.set(ascii("mif1heic"), 16);
  out.set(ascii("ispe"), 28);
  const v = new DataView(out.buffer);
  v.setUint32(24, 20);
  v.setUint32(36, width);
  v.setUint32(40, height);
  return out;
}

describe("review of 232af57f: the JPEG cleaner keeps only what draws the picture", () => {
  it("keeps the fixed fields of JFIF and Adobe, and leaves out a JFIF thumbnail, foreign APP0 and APP14 payloads and markers not needed to decode", () => {
    const plain = encodeJpeg(syntheticShirt({ size: 64 }), 90);
    const body = plain.subarray(2);
    const ownApp0 = body[0] === 0xff && body[1] === 0xe0 ? 2 + ((body[2]! << 8) | body[3]!) : 0;
    const loaded = concat(
      plain.subarray(0, 2),
      segment(0xe0, concat(ascii("JFIF\0"), new Uint8Array([1, 2, 0, 0, 72, 0, 72, 1, 1]), ascii("RGBTEST-JFIF-THUMB-POSITION"))),
      segment(0xe0, ascii("JFXX\0TEST-APP0-POSITION")),
      segment(0xee, concat(ascii("Adobe"), new Uint8Array([0, 100, 0, 0, 0, 0, 1]), ascii("TEST-APP14-POSITION"))),
      segment(0xee, ascii("Ducky\0TEST-APP14-FOREIGN-POSITION")),
      segment(0xf0, ascii("TEST-RESERVED-POSITION")),
      segment(0xc8, ascii("TEST-JPG-EXTENSION-POSITION")),
      body.subarray(ownApp0),
    );
    const out = withoutLocation(loaded);
    expect(out).toMatchObject({ ok: true, changed: true });
    const bytes = (out as { bytes: Uint8Array }).bytes;
    expect(latin1(bytes)).not.toMatch(/TEST-[A-Z0-9-]*POSITION/);
    // No JPG (C8) extension marker survives in the header part.
    const sos = bytes.findIndex((b, i) => b === 0xff && bytes[i + 1] === 0xda);
    expect(bytes.subarray(0, sos).some((b, i, a) => b === 0xff && a[i + 1] === 0xc8)).toBe(false);
    expect(latin1(bytes)).toContain("JFIF\0");
    expect(latin1(bytes)).toContain("Adobe");
    expect(decodeJpeg(bytes).data).toEqual(decodeJpeg(plain).data);
    expect(withoutLocation(bytes)).toMatchObject({ ok: true, changed: false });
  });
});

describe("review of 232af57f: packages never lose a photograph silently, and imports fail closed", () => {
  it("background work that does not say how originals leave is refused when a photograph would be left out", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (review 232af57f, HEIC)" });
    const up = await h.upload(owner, { garmentId: "shirt-moss", bytes: heicShell(256, 256), contentType: "image/heic", demo: true });
    expect(up.rejected).toBeNull();
    const original = (await getAsset(h.rt, owner.principal(), up.asset!.assetId)).renditions.find((r) => r.kind === "original")!.renditionId;
    const background = owner.principal({ actor: "system", channel: "system", scopes: ["read", "write"] });
    expect(await code(exportMediaData(h.rt, background))).toBe("precondition_failed");
    const backup = await exportMediaData(h.rt, background, { originals: "as_supplied" });
    expect(backup.withheldOriginals).toEqual([]);
    expect(backup.assets.some((f) => f.renditionId === original)).toBe(true);
    expect((await exportMediaData(h.rt, background, { originals: "location_removed" })).withheldOriginals).toHaveLength(1);
    expect((await exportMediaData(h.rt, owner.principal())).withheldOriginals).toHaveLength(1);
  });

  it("only the owner and the service's own background work can take originals as supplied; the import channel cannot", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (review 232af57f, who may)" });
    await h.upload(owner, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 64 }), demo: true });
    for (const channel of ["import", "conversation", "mcp"] as const) {
      expect(await code(exportMediaData(h.rt, owner.principal({ actor: "system", channel, scopes: ["read", "write", "admin"] }), { originals: "as_supplied" })), channel).toBe("forbidden");
    }
    for (const channel of ["system", "scheduled"] as const) {
      expect((await exportMediaData(h.rt, owner.principal({ actor: "system", channel, scopes: ["read", "write"] }), { originals: "as_supplied" })).originals, channel).toBe("as_supplied");
    }
  });

  it("a derived file whose metadata cannot be checked is refused on import, not stored to be served as it is", async () => {
    const h = await createMediaHarness();
    const source = await h.createSyntheticOwner({ displayName: "Synthetic owner (review 232af57f, import source)" });
    const up = await h.upload(source, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 256 }), demo: true });
    await h.settle(source);
    const me = source.principal();
    const data = await exportMediaData(h.rt, me);
    // A JPEG of headers only: it probes as a JPEG of the right kind (so the type checks pass), but its
    // metadata cannot be checked because it holds no scan. Only the fail-closed check can refuse it.
    const plain = encodeJpeg(syntheticShirt({ size: 256 }), 90);
    const unreadable = concat(plain.subarray(0, plain.findIndex((b, i) => b === 0xff && plain[i + 1] === 0xda)), new Uint8Array([0xff, 0xd9]));
    expect(probeImage(unreadable)).toMatchObject({ format: "jpeg", contentType: "image/jpeg" });
    expect(withoutLocation(unreadable)).toMatchObject({ ok: false });
    const forged = { ...data, assets: data.assets.map((f) => ({ ...f })) };
    const target = forged.assets.find((f) => f.assetId === up.asset!.assetId && f.kind === "catalogue")!;
    target.sha256 = await sha256(unreadable);
    target.byteLength = unreadable.length;
    const into = await h.createSyntheticOwner({ displayName: "Synthetic owner (review 232af57f, import target)" });
    const result = await importMediaData(h.rt, into.principal({ channel: "import", actor: "system", scopes: ["read", "write", "admin"] }), forged, async (file) => (file === target.file ? unreadable : readExportFile(h.rt, me, file)));
    expect(result.rejected).toEqual([target.file]);
    expect(result.mismatched).toEqual([]);
  });

  it("a thumbnail cached under the old key is never served, a fresh one is made without metadata, and purging clears both keys", async () => {
    const h = await createMediaHarness();
    expect(h.deps.images).toBeDefined();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (review 232af57f, thumbnail cache)" });
    const up = await h.upload(owner, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 400 }), demo: true });
    await h.settle(owner);
    const original = (await getAsset(h.rt, owner.principal(), up.asset!.assetId)).renditions.find((r) => r.kind === "original")!;
    const sha = (await all<{ sha256: string }>(h.db, "SELECT sha256 FROM media_renditions WHERE user_id = ? AND rendition_id = ?", owner.userId, original.renditionId))[0]!.sha256;
    // TEST DATA: what a thumbnail cached before the cleaner might hold, under the old key.
    const stale = ascii("RIFF....WEBPTEST-LEGACY-THUMBNAIL-POSITION");
    await caches.default.put(legacyThumbnailCacheUrl(owner.userId, sha, 160), new Response(stale, { headers: { "content-type": "image/webp", "cache-control": "max-age=86400" } }));
    const thumb = await openRendition(h.rt, owner.principal(), original.renditionId, { width: 160 });
    const served = new Uint8Array(await new Response(thumb.body).arrayBuffer());
    expect(latin1(served)).not.toContain("TEST-LEGACY-THUMBNAIL-POSITION");
    expect(probeImage(served)).toMatchObject({ format: "webp", width: 160 });
    expect(withoutLocation(served)).toMatchObject({ ok: true, changed: false });
    const fresh = await caches.default.match(thumbnailCacheUrl(owner.userId, sha, 160));
    expect(fresh).toBeDefined();
    await fresh?.arrayBuffer();
    expect(await purgeOwnerMediaCache(h.rt, owner.userId)).toEqual({ purged: 2 });
    expect(await caches.default.match(legacyThumbnailCacheUrl(owner.userId, sha, 160))).toBeUndefined();
    expect(await caches.default.match(thumbnailCacheUrl(owner.userId, sha, 160))).toBeUndefined();
  });
});

describe("MEDIA-ABUSE-1: a direct image-state import over existing state is a typed refusal", () => {
  it("refuses a garmentMedia record for a garment that already has image state with precondition_failed, and a missing or repeated garment with invalid_command, writing nothing", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (MEDIA-ABUSE-1)" });
    const up = await h.upload(owner, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 128 }), demo: true });
    const before = await all(h.db, "SELECT * FROM garment_media WHERE user_id = ? ORDER BY garment_id", owner.userId);
    expect(before.length).toBeGreaterThan(0);
    const importer = owner.principal({ channel: "import", actor: "system", scopes: ["read", "write", "admin"] });
    const record = { garment_id: "shirt-moss", image_state: "resolved", primary_asset_id: up.asset!.assetId, version: 99, updated_at: new Date().toISOString() };
    const run = (garmentMedia: Record<string, unknown>[]) =>
      h.service.execute(importer, { type: "media.import_records", payload: { part: "garmentMedia", rows: { garmentMedia } }, idempotencyKey: `abuse-1-${crypto.randomUUID()}`, expectedVersions: {}, authorization: "data_import", source: { channel: "import" } });
    expect(await code(run([record]))).toBe("precondition_failed");
    expect(await code(run([{ ...record, garment_id: "shirt-gold" }, { ...record, garment_id: "shirt-gold" }]))).toBe("invalid_command");
    expect(await code(run([{ ...record, garment_id: null }]))).toBe("invalid_command");
    expect(await all(h.db, "SELECT * FROM garment_media WHERE user_id = ? ORDER BY garment_id", owner.userId)).toEqual(before);
  });
});

describe("automatic review of 56b53eac: metadata between scans, and finalization never undoes a newer image choice", () => {
  it("stripJpegMetadata filters Exif, IPTC and comments that sit between scans, keeps every scan, and drops what follows the end", () => {
    const plain = encodeJpeg(syntheticShirt({ size: 64 }), 90);
    const sos = plain.findIndex((b, i) => b === 0xff && plain[i + 1] === 0xda);
    const eoi = plain.length - 2;
    // TEST DATA: a second (repeated) scan after metadata segments, as in a multi-scan file, and trailing bytes.
    const scan = plain.subarray(sos, eoi);
    const tagged = concat(
      plain.subarray(0, eoi),
      segment(0xe1, ascii("Exif\0\0TEST-INTERSCAN-GPS-POSITION")),
      segment(0xed, ascii("Photoshop 3.0\0TEST-INTERSCAN-IPTC-POSITION")),
      segment(0xfe, ascii("TEST-INTERSCAN-COMMENT-POSITION")),
      scan,
      new Uint8Array([0xff, 0xd9]),
      ascii("TEST-TRAILER-POSITION"),
    );
    const out = stripJpegMetadata(tagged);
    expect(latin1(out)).not.toMatch(/TEST-[A-Z-]*POSITION/);
    // Both scans are still there, byte for byte, and the file ends at its end marker.
    expect(out.filter((b, i) => b === 0xff && out[i + 1] === 0xda).length).toBe(2);
    expect(latin1(out)).toContain(latin1(scan));
    expect([...out.subarray(out.length - 2)]).toEqual([0xff, 0xd9]);
    expect(() => stripJpegMetadata(concat(plain.subarray(0, sos), new Uint8Array([0xff, 0xd9])))).toThrow(/no image data/);
  });

  it("a primary-image choice that commits while a new photo is being finalized is kept: finalization plans again from the newer state", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (finalize race)" });
    const a = await h.upload(owner, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 256 }), demo: true });
    const c = await h.upload(owner, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 300 }), demo: true });
    await h.settle(owner);
    const read = async () => (await all<{ primary_asset_id: string | null; image_state: string; version: number }>(h.db, "SELECT primary_asset_id, image_state, version FROM garment_media WHERE user_id = ? AND garment_id = 'shirt-moss'", owner.userId))[0]!;
    const before = await read();
    expect(before.image_state).toBe("resolved");
    const chosen = before.primary_asset_id === a.asset!.assetId ? c.asset!.assetId : a.asset!.assetId;

    // TEST SETUP: the owner's choice of the other photo commits right after finalization has read the garment's
    // image state and before its batch commits, by wrapping that one read on the shared database binding.
    const db = h.db as unknown as { prepare: (sql: string) => unknown };
    const original = db.prepare;
    const realPrepare = original.bind(db) as (sql: string) => { bind: (...p: unknown[]) => { first: <T>() => Promise<T | null>; run: () => Promise<unknown> } };
    let raced = 0;
    db.prepare = (sql: string) => {
      const statement = realPrepare(sql);
      if (raced > 0 || !sql.startsWith("SELECT garment_id, image_state, primary_asset_id")) return statement;
      return {
        ...statement,
        bind: (...params: unknown[]) => {
          const bound = statement.bind(...params);
          return {
            ...bound,
            first: async <T,>() => {
              const row = await bound.first<T>();
              if (raced++ === 0) await realPrepare("UPDATE garment_media SET primary_asset_id = ?, version = version + 1 WHERE user_id = ? AND garment_id = 'shirt-moss'").bind(chosen, owner.userId).run();
              return row;
            },
          };
        },
      };
    };
    try {
      const b = await h.upload(owner, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 320 }), demo: true });
      expect(b.rejected).toBeNull();
    } finally {
      db.prepare = original;
    }
    expect(raced).toBeGreaterThanOrEqual(1);
    const after = await read();
    expect(after.primary_asset_id).toBe(chosen);
    expect(after.image_state).toBe("resolved");
    expect(after.version).toBe(before.version + 2);
  });
});

describe("MEDIA-ABUSE-2: a JPEG with headers and no picture data is not an image", () => {
  it("counts no scan data, will not decode, and is finalized as rejected rather than becoming an asset", async () => {
    const jpg = encodeJpeg(syntheticShirt({ size: 128 }), 90);
    const sos = jpg.findIndex((b, i) => b === 0xff && jpg[i + 1] === 0xda);
    const sosEnd = sos + 2 + ((jpg[sos + 2]! << 8) | jpg[sos + 3]!);
    const headersOnly = concat(jpg.subarray(0, sos), new Uint8Array([0xff, 0xd9]));
    const emptyScan = concat(jpg.subarray(0, sosEnd), new Uint8Array([0xff, 0xd9]));
    // An SOS whose length field is too short, so a naive scanner would count the header as picture data.
    const shortSos = concat(jpg.subarray(0, sos), new Uint8Array([0xff, 0xda, 0x00, 0x00, 0xff, 0xd9]));
    expect(jpegScanDataBytes(jpg)).toBeGreaterThan(0);
    expect(jpegScanDataBytes(headersOnly)).toBe(0);
    expect(jpegScanDataBytes(emptyScan)).toBe(0);
    expect(jpegScanDataBytes(shortSos)).toBe(0);
    expect(() => decodeJpeg(headersOnly)).toThrow(/no image data/);
    expect(() => decodeJpeg(emptyScan)).toThrow(/no image data/);

    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (MEDIA-ABUSE-2)" });
    for (const bytes of [headersOnly, emptyScan, shortSos]) {
      const up = await h.upload(owner, { garmentId: "shirt-moss", bytes, contentType: "image/jpeg", demo: true });
      expect(up.rejected).toMatch(/no image data/);
      expect(up.asset).toBeNull();
    }
    await h.settle(owner);
    expect(await all(h.db, "SELECT asset_id FROM media_assets WHERE user_id = ? AND status = 'active'", owner.userId)).toEqual([]);
    // A real picture still goes through.
    expect((await h.upload(owner, { garmentId: "shirt-moss", bytes: jpg, contentType: "image/jpeg", demo: true })).rejected).toBeNull();
  });
});
