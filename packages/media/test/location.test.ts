import { describe, expect, it } from "vitest";
import { isCommandError } from "@garderobe/domain";
import type { TestOwner } from "@garderobe/domain/testing";
import {
  exportMediaData, getAsset, getComposition, importMediaData, listMediaDeletions, openAssetImage, openCompositePreview, openRendition, readExportFile, requestCompositePreview, serveSignedMedia, signRenditionUrl, withoutLocation,
} from "../src/index.ts";
import { decodeJpeg, decodePng, encodeJpeg, encodePng, probeImage } from "../src/image/index.ts";
import { createMediaHarness, syntheticShirt, syntheticTrousers, type MediaHarness } from "../src/testing/index.ts";

/*
 * Location data is removed by default from every image that is shared or exported; the photograph as
 * supplied, with its location data, is released only when the owner asks for it.
 *
 * SYNTHETIC TEST IMAGES on synthetic fixture garments (labelled demo placeholders), stored in the local R2
 * bucket through the real upload path. The Exif, XMP, text and trailing blocks are hand-built TEST DATA
 * carrying recognisable markers; the WebP and HEIC files are structural TEST containers (headers and
 * chunks only, not decodable pictures). No real photograph or real position is involved.
 */

const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (isCommandError(e) ? e.code : `threw:${String(e)}`));
const bytesOf = async (b: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(b).arrayBuffer());
const tokenOf = (url: string) => url.split("/").pop()!;
const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("");
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const sha256 = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** TEST DATA: a little-endian Exif TIFF block with an Orientation field and a pointer to a GPS directory, as a phone camera writes. */
function exifTiff(orientation: number): Uint8Array {
  const tiff = new Uint8Array(8 + 2 + 24 + 4 + 8);
  const v = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
  v.setUint16(8, 2, true);
  v.setUint16(10, 0x0112, true); // Orientation, SHORT
  v.setUint16(12, 3, true);
  v.setUint32(14, 1, true);
  v.setUint16(18, orientation, true);
  v.setUint16(22, 0x8825, true); // GPS directory pointer, LONG
  v.setUint16(24, 4, true);
  v.setUint32(26, 1, true);
  v.setUint32(30, 38, true);
  return tiff;
}

const jpegSegment = (marker: number, body: Uint8Array) => concat(new Uint8Array([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body);

/** TEST DATA: the JPEG with everything a camera file can carry: Exif with a GPS pointer, an XMP packet, multi-picture data, a colour profile, a comment, and bytes after the end of the image. */
function loadedJpeg(jpg: Uint8Array, orientation = 6): Uint8Array {
  return concat(
    jpg.subarray(0, 2),
    jpegSegment(0xe1, concat(ascii("Exif\0\0"), exifTiff(orientation))),
    jpegSegment(0xe1, ascii("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta exif:GPSLatitude='TEST-XMP-POSITION'/>")),
    jpegSegment(0xe2, ascii("MPF\0TEST-MULTI-PICTURE")),
    jpegSegment(0xe2, ascii("ICC_PROFILE\0\x01\x01TEST-COLOUR-PROFILE")),
    jpegSegment(0xed, ascii("Photoshop 3.0\0TEST-IPTC-CITY")),
    jpegSegment(0xfe, ascii("TEST-COMMENT-POSITION")),
    jpg.subarray(2),
    ascii("TEST-TRAILING-POSITION"),
  );
}

/** The simple GPS-tagged JPEG the other suites use (Exif with a GPS pointer only). */
const gpsTagged = (jpg: Uint8Array) => concat(jpg.subarray(0, 2), jpegSegment(0xe1, concat(ascii("Exif\0\0"), exifTiff(1))), jpg.subarray(2));

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, body.length);
  out.set(ascii(type), 4);
  out.set(body, 8);
  v.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** TEST DATA: the PNG with an Exif chunk (GPS pointer), a text chunk and bytes after its end. */
const loadedPng = (png: Uint8Array) => concat(png.subarray(0, 33), pngChunk("eXIf", exifTiff(1)), pngChunk("tEXt", ascii("Comment\0TEST-PNG-POSITION")), png.subarray(33), ascii("TEST-TRAILING-POSITION"));

function riffChunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length + (body.length & 1));
  out.set(ascii(type));
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

/** TEST CONTAINER: an extended-format WebP file structure (not a decodable picture) declaring and carrying Exif and XMP chunks. */
function loadedWebp(width: number, height: number): Uint8Array {
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x0c; // Exif and XMP present
  vp8x.set([(width - 1) & 0xff, ((width - 1) >> 8) & 0xff, 0], 4);
  vp8x.set([(height - 1) & 0xff, ((height - 1) >> 8) & 0xff, 0], 7);
  const body = concat(ascii("WEBP"), riffChunk("VP8X", vp8x), riffChunk("VP8 ", ascii("TEST-IMAGE-DATA")), riffChunk("EXIF", exifTiff(1)), riffChunk("XMP ", ascii("TEST-XMP-POSITION")));
  const header = new Uint8Array(8);
  header.set(ascii("RIFF"));
  new DataView(header.buffer).setUint32(4, body.length, true);
  return concat(header, body);
}

/** TEST CONTAINER: the header of a HEIC file (brand and image size only, not a decodable picture). */
function heicShell(width: number, height: number): Uint8Array {
  const out = new Uint8Array(96);
  out.set([0, 0, 0, 24]);
  out.set(ascii("ftypheic"), 4);
  out.set(ascii("mif1heic"), 16);
  out.set(ascii("ispe"), 28);
  const v = new DataView(out.buffer);
  v.setUint32(36, width);
  v.setUint32(40, height);
  out.set(ascii("TEST-HEIC-POSITION"), 60);
  return out;
}

describe("withoutLocation: the same picture, nothing else", () => {
  it("JPEG: leaves out Exif GPS, XMP, IPTC, multi-picture data, comments and trailing bytes; keeps the image data, the colour profile and which way up it is", () => {
    const plain = encodeJpeg(syntheticShirt({ size: 128 }), 90);
    const loaded = loadedJpeg(plain, 6);
    expect(probeImage(loaded)!.exif).toEqual({ present: true, orientation: 6, hasGps: true });

    const clean = withoutLocation(loaded);
    if (!clean.ok) throw new Error(clean.reason);
    expect(clean.changed).toBe(true);
    expect(clean.contentType).toBe("image/jpeg");
    expect(probeImage(clean.bytes)).toMatchObject({ format: "jpeg", width: 128, height: 128, exif: { present: true, orientation: 6, hasGps: false } });
    const text = latin1(clean.bytes);
    for (const marker of ["TEST-XMP-POSITION", "GPSLatitude", "TEST-MULTI-PICTURE", "TEST-IPTC-CITY", "TEST-COMMENT-POSITION", "TEST-TRAILING-POSITION"]) expect(text, marker).not.toContain(marker);
    expect(text).toContain("TEST-COLOUR-PROFILE");
    // The picture is untouched: the same pixels before any turning, and turned the same way after.
    expect(decodeJpeg(clean.bytes, { applyOrientation: false }).data).toEqual(decodeJpeg(plain, { applyOrientation: false }).data);
    expect(decodeJpeg(clean.bytes).data).toEqual(decodeJpeg(loaded).data);
    // Doing it again changes nothing, and a JPEG this package writes itself carries nothing to leave out.
    expect(withoutLocation(clean.bytes)).toMatchObject({ ok: true, changed: false });
    const own = withoutLocation(plain);
    expect(own).toMatchObject({ ok: true, changed: false });
    expect(own.ok && own.bytes).toEqual(plain);
  });

  it("PNG: leaves out the Exif chunk, text chunks and trailing bytes, byte for byte the plain picture", async () => {
    const plain = await encodePng(syntheticTrousers({ size: 96 }));
    const loaded = loadedPng(plain);
    await decodePng(loaded.subarray(0, loaded.length - "TEST-TRAILING-POSITION".length)); // the test file is a valid PNG
    const clean = withoutLocation(loaded);
    if (!clean.ok) throw new Error(clean.reason);
    expect(clean.changed).toBe(true);
    expect(clean.bytes).toEqual(plain);
    expect(withoutLocation(plain)).toMatchObject({ ok: true, changed: false });
  });

  it("WebP (test container): leaves out the Exif and XMP chunks and clears their flags", () => {
    const loaded = loadedWebp(300, 200);
    expect(probeImage(loaded)).toMatchObject({ format: "webp", width: 300, height: 200, exif: { present: true } });
    const clean = withoutLocation(loaded);
    if (!clean.ok) throw new Error(clean.reason);
    expect(clean.changed).toBe(true);
    expect(probeImage(clean.bytes)).toMatchObject({ format: "webp", width: 300, height: 200, exif: { present: false } });
    const text = latin1(clean.bytes);
    expect(text).not.toContain("EXIF");
    expect(text).not.toContain("XMP ");
    expect(text).not.toContain("TEST-XMP-POSITION");
    expect(text).toContain("TEST-IMAGE-DATA");
    expect(new DataView(clean.bytes.buffer, clean.bytes.byteOffset).getUint32(4, true)).toBe(clean.bytes.length - 8);
    expect(clean.bytes.length % 2).toBe(0);
    expect(withoutLocation(clean.bytes)).toMatchObject({ ok: true, changed: false });
  });

  it("HEIC (test container) and anything unrecognised: says it cannot, rather than passing the file on", () => {
    expect(probeImage(heicShell(256, 256))).toMatchObject({ format: "heic", width: 256, height: 256 });
    expect(withoutLocation(heicShell(256, 256))).toMatchObject({ ok: false });
    expect(withoutLocation(ascii("this is not an image at all"))).toMatchObject({ ok: false });
    // A truncated JPEG is not rewritten into something else.
    const plain = encodeJpeg(syntheticShirt({ size: 64 }), 90);
    expect(withoutLocation(loadedJpeg(plain).subarray(0, 40))).toMatchObject({ ok: false });
  });
});

describe("signed and authenticated delivery: no location by default, the supplied photograph only when the owner asks", () => {
  const setup = async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (location)" });
    const tagged = loadedJpeg(encodeJpeg(syntheticShirt({ size: 256 }), 92), 1);
    expect(probeImage(tagged)!.exif.hasGps).toBe(true);
    const up = await h.upload(owner, { garmentId: "shirt-moss", bytes: tagged, contentType: "image/jpeg", demo: true });
    const assetId = up.asset!.assetId;
    const original = (await getAsset(h.rt, owner.principal(), assetId)).renditions.find((r) => r.kind === "original")!.renditionId;
    return { h, owner, tagged, assetId, original };
  };
  const carriesNothing = (bytes: Uint8Array) => {
    expect(probeImage(bytes)!.exif.hasGps).toBe(false);
    expect(latin1(bytes)).not.toMatch(/TEST-[A-Z-]*POSITION|GPSLatitude|TEST-IPTC-CITY/);
    expect(withoutLocation(bytes)).toMatchObject({ ok: true, changed: false });
  };
  const others = (owner: TestOwner) => [
    owner.principal({ actor: "assistant", channel: "mcp", scopes: ["read"] }),
    owner.principal({ actor: "assistant", channel: "mcp", scopes: ["read", "write", "admin"] }),
    owner.principal({ actor: "assistant", channel: "conversation", scopes: ["read", "write"] }),
    owner.principal({ actor: "owner", channel: "mcp", scopes: ["read", "write", "admin"] }),
    owner.principal({ actor: "system", channel: "system", scopes: ["read", "write", "admin"] }),
  ];

  it("the owner's own reads and links of the original carry no location unless the owner asked for it", async () => {
    const { h, owner, tagged, assetId, original } = await setup();
    const me = owner.principal();
    expect((await getAsset(h.rt, me, assetId)).hadLocationMetadata).toBe(true); // the app can tell the owner what the file holds

    // Default, before and after processing: the same picture, nothing else.
    for (const settled of [false, true]) {
      if (settled) await h.settle(owner);
      const byRendition = await openRendition(h.rt, me, original);
      expect(byRendition.etag).toMatch(/-noloc"$/);
      const reads = [await bytesOf(byRendition.body), await bytesOf((await openAssetImage(h.rt, me, assetId, { variant: "original" })).body), await bytesOf((await openAssetImage(h.rt, me, assetId)).body)];
      const linked = await serveSignedMedia(h.rt, tokenOf((await signRenditionUrl(h.rt, me, original)).url));
      expect(linked.status).toBe(200);
      expect(linked.headers.get("etag")).toMatch(/-noloc"$/);
      reads.push(new Uint8Array(await linked.arrayBuffer()));
      for (const bytes of reads) {
        carriesNothing(bytes);
        expect(bytes).not.toEqual(tagged);
      }
      // The original as written without metadata is still the full picture, losslessly.
      expect(decodeJpeg(reads[0]!).data).toEqual(decodeJpeg(tagged).data);
      // Values that are not the owner's explicit yes release nothing.
      expect(await bytesOf((await openRendition(h.rt, me, original, { withLocation: false })).body)).toEqual(reads[0]);
      for (const notYes of ["true", 1, "include", {}] as unknown as boolean[]) expect(await code(openRendition(h.rt, me, original, { withLocation: notYes })), String(notYes)).toBe("invalid_command");
    }

    // The owner's explicit choice: the photograph exactly as supplied.
    expect(await bytesOf((await openRendition(h.rt, me, original, { withLocation: true })).body)).toEqual(tagged);
    expect(await bytesOf((await openAssetImage(h.rt, me, assetId, { variant: "original", withLocation: true })).body)).toEqual(tagged);
    const released = await serveSignedMedia(h.rt, tokenOf((await signRenditionUrl(h.rt, me, original, { withLocation: true })).url));
    expect(released.status).toBe(200);
    expect(released.headers.get("etag")).not.toMatch(/-noloc/);
    expect(new Uint8Array(await released.arrayBuffer())).toEqual(tagged);
    // The choice applies to the stored photograph only, and never outside the app.
    expect(await code(openRendition(h.rt, me, original, { withLocation: true, width: 256 }))).toBe("invalid_command");
    expect(await code(signRenditionUrl(h.rt, me, original, { withLocation: true, width: 256 }))).toBe("invalid_command");
    for (const audience of ["calendar", "provider"] as const) expect(await code(signRenditionUrl(h.rt, me, original, { withLocation: true, audience }))).toBe("forbidden");
    // Asking for it on a derived copy releases nothing more: derived copies hold no location to release.
    const cutout = (await getAsset(h.rt, me, assetId)).renditions.find((r) => r.kind === "cutout")!.renditionId;
    carriesNothing(new Uint8Array(await (await serveSignedMedia(h.rt, tokenOf((await signRenditionUrl(h.rt, me, cutout, { withLocation: true })).url))).arrayBuffer()));
  });

  it("nobody but the owner in their own app can ask for the location: not an assistant, not the MCP channel, not the system", async () => {
    const { h, owner, assetId, original } = await setup();
    await h.settle(owner);
    for (const who of others(owner)) {
      const label = `${who.actor}/${who.channel}`;
      expect(await code(openRendition(h.rt, who, original, { withLocation: true })), label).toBe("forbidden");
      expect(await code(openAssetImage(h.rt, who, assetId, { variant: "original", withLocation: true })), label).toBe("forbidden");
      expect(await code(openAssetImage(h.rt, who, assetId, { withLocation: true })), label).toBe("forbidden");
      expect(await code(signRenditionUrl(h.rt, who, original, { withLocation: true })), label).toBe("forbidden");
      // Without the option they are where they were: the original is not theirs to open at all.
      expect(await code(openRendition(h.rt, who, original)), label).toBe("not_found");
      expect(await code(signRenditionUrl(h.rt, who, original)), label).toBe("not_found");
      carriesNothing(await bytesOf((await openAssetImage(h.rt, who, assetId)).body));
    }
  });

  it("every stored derived copy, the outfit preview and its scene carry no metadata at all", async () => {
    const { h, owner, assetId } = await setup();
    await h.upload(owner, { garmentId: "trouser-olive", bytes: loadedPng(await encodePng(syntheticTrousers({ size: 256 }))), contentType: "image/png", demo: true });
    await h.settle(owner);
    const me = owner.principal();
    const derived = (await getAsset(h.rt, me, assetId)).renditions.filter((r) => r.kind !== "original");
    expect(derived.map((r) => r.kind).sort()).toEqual(["catalogue", "cutout", "mask"]);
    for (const r of derived) carriesNothing(await bytesOf((await openRendition(h.rt, me, r.renditionId)).body));

    const slots = [{ role: "top" as const, garmentId: "shirt-moss" }, { role: "bottom" as const, garmentId: "trouser-olive" }];
    const { manifestHash } = await requestCompositePreview(h.rt, me, { slots });
    await h.settle(owner);
    expect((await getComposition(h.rt, me, manifestHash)).preview.state).toBe("rendered");
    carriesNothing(await bytesOf((await openCompositePreview(h.rt, me, manifestHash, "png")).body));
    const scene = latin1(await bytesOf((await openCompositePreview(h.rt, me, manifestHash, "svg")).body));
    expect(scene).not.toMatch(/data:|base64|POSITION|GPS/); // the scene names its images, it does not contain them

    // A preview drawn by an outside exporter (TEST DOUBLE returning a PNG that carries an Exif chunk and text) is stored without them.
    const outside = loadedPng(await encodePng(syntheticShirt({ size: 64 })));
    h.deps.previewExporter = { name: "test-double-exporter", renderSvgToPng: async () => ({ ok: true, png: outside }) };
    const again = await requestCompositePreview(h.rt, me, { slots: [{ role: "top" as const, garmentId: "shirt-moss" }] });
    await h.settle(owner);
    expect((await getComposition(h.rt, me, again.manifestHash)).preview.state).toBe("rendered");
    const preview = await bytesOf((await openCompositePreview(h.rt, me, again.manifestHash, "png")).body);
    expect(latin1(preview)).not.toContain("TEST-PNG-POSITION");
    expect(withoutLocation(preview)).toMatchObject({ ok: true, changed: false });
  });

  it("a photograph whose location cannot be removed (HEIC test container) is not shown as it is; the owner can still ask for it as supplied", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (location, HEIC)" });
    const heic = heicShell(256, 256);
    const up = await h.upload(owner, { garmentId: "shirt-moss", bytes: heic, contentType: "image/heic", demo: true });
    expect(up.rejected).toBeNull();
    const assetId = up.asset!.assetId;
    const me = owner.principal();
    const original = (await getAsset(h.rt, me, assetId)).renditions.find((r) => r.kind === "original")!.renditionId;
    expect(await code(openRendition(h.rt, me, original))).toBe("not_found");
    expect(await code(openAssetImage(h.rt, me, assetId, { variant: "original" }))).toBe("not_found");
    expect((await serveSignedMedia(h.rt, tokenOf((await signRenditionUrl(h.rt, me, original)).url))).status).toBe(404);
    expect(await bytesOf((await openRendition(h.rt, me, original, { withLocation: true })).body)).toEqual(heic);

    // The default export leaves it out and says so; the owner's explicit choice includes it.
    const byDefault = await exportMediaData(h.rt, me);
    expect(byDefault.withheldOriginals).toEqual([{ assetId, renditionId: original, reason: expect.stringContaining("image/heic") }]);
    expect(byDefault.assets.some((f) => f.renditionId === original)).toBe(false);
    expect(byDefault.records.renditions.find((r) => r.rendition_id === original)).toMatchObject({ status: "deleted" });
    const file = String(byDefault.records.renditions.find((r) => r.rendition_id === original)!.file);
    expect(await readExportFile(h.rt, me, file)).toBeNull();
    const chosen = await exportMediaData(h.rt, me, { originals: "as_supplied" });
    expect(chosen.withheldOriginals).toEqual([]);
    expect(new Uint8Array((await readExportFile(h.rt, me, chosen.assets.find((f) => f.renditionId === original)!.file, { originals: "as_supplied" }))!)).toEqual(heic);
  });
});

describe("portable export: originals leave without their location unless the owner chose otherwise", () => {
  it("the default package holds location-free originals whose checksums verify on import; the supplied files need the owner's choice", async () => {
    const h = await createMediaHarness();
    const source = await h.createSyntheticOwner({ displayName: "Synthetic owner (location export source)" });
    const tagged = loadedJpeg(encodeJpeg(syntheticShirt({ size: 256 }), 92), 1);
    const taggedPng = loadedPng(await encodePng(syntheticTrousers({ size: 256 })));
    const shirt = (await h.upload(source, { garmentId: "shirt-moss", bytes: tagged, contentType: "image/jpeg", demo: true })).asset!.assetId;
    await h.upload(source, { garmentId: "trouser-olive", bytes: taggedPng, contentType: "image/png", demo: true });
    await h.settle(source);
    const me = source.principal();

    const data = await exportMediaData(h.rt, me);
    expect(data.originals).toBe("location_removed");
    expect(data.withheldOriginals).toEqual([]);
    expect(data.records.assets.find((a) => a.asset_id === shirt)).toMatchObject({ had_location_metadata: 0 });
    expect(data.notes.join(" ")).toContain("without their location data");
    const originals = data.assets.filter((f) => f.kind === "original");
    expect(originals).toHaveLength(2);
    for (const file of data.assets) {
      const bytes = new Uint8Array((await readExportFile(h.rt, me, file.file))!);
      // The package's checksum describes exactly the bytes handed out, and its record says the same.
      expect([await sha256(bytes), bytes.length], file.file).toEqual([file.sha256, file.byteLength]);
      expect(data.records.renditions.find((r) => r.rendition_id === file.renditionId)).toMatchObject({ sha256: file.sha256, byte_length: file.byteLength });
      expect(file.location).toBe(file.kind === "original" ? "removed" : undefined);
      expect(probeImage(bytes)!.exif.hasGps).toBe(false);
      expect(latin1(bytes), file.file).not.toMatch(/TEST-[A-Z-]*POSITION|GPSLatitude|TEST-IPTC-CITY/);
      expect(withoutLocation(bytes), file.file).toMatchObject({ ok: true, changed: false });
    }
    expect(JSON.stringify(data)).not.toMatch(/POSITION|GPSLatitude/);

    // The default package imports cleanly into an empty owner, and what arrives holds no location either.
    const target = await h.createSyntheticOwner({ displayName: "Synthetic owner (location export target)" });
    const importer = target.principal({ channel: "import", actor: "system", scopes: ["read", "write", "admin"] });
    const result = await importMediaData(h.rt, importer, data, (file) => readExportFile(h.rt, me, file));
    expect([result.missing, result.mismatched, result.rejected]).toEqual([[], [], []]);
    expect(result.imported.files).toBe(data.assets.length);
    expect((await getAsset(h.rt, target.principal(), shirt)).hadLocationMetadata).toBe(false);
    const arrived = await bytesOf((await openAssetImage(h.rt, target.principal(), shirt, { variant: "original", withLocation: true })).body);
    expect(probeImage(arrived)!.exif.hasGps).toBe(false);
    expect(decodeJpeg(arrived).data).toEqual(decodeJpeg(tagged).data);

    // The owner's explicit choice: the supplied files, checksummed as stored.
    const chosen = await exportMediaData(h.rt, me, { originals: "as_supplied" });
    expect(chosen.originals).toBe("as_supplied");
    expect(chosen.records.assets.find((a) => a.asset_id === shirt)).toMatchObject({ had_location_metadata: 1 });
    const suppliedFile = chosen.assets.find((f) => f.assetId === shirt && f.kind === "original")!;
    expect(suppliedFile.location).toBe("as_supplied");
    const supplied = new Uint8Array((await readExportFile(h.rt, me, suppliedFile.file, { originals: "as_supplied" }))!);
    expect(supplied).toEqual(tagged);
    expect([await sha256(supplied), supplied.length]).toEqual([suppliedFile.sha256, suppliedFile.byteLength]);
    // Read without repeating the choice, the same path gives the location-free file.
    expect(probeImage(new Uint8Array((await readExportFile(h.rt, me, suppliedFile.file))!))!.exif.hasGps).toBe(false);

    // An assistant, and anything on the MCP channel, cannot make that choice; a backup run by the service itself can.
    for (const who of [source.principal({ actor: "assistant", channel: "mcp", scopes: ["read", "write", "admin"] }), source.principal({ actor: "assistant", channel: "conversation", scopes: ["read", "write"] }), source.principal({ actor: "owner", channel: "mcp", scopes: ["read", "write", "admin"] })]) {
      expect(await code(exportMediaData(h.rt, who, { originals: "as_supplied" }))).toBe("forbidden");
      expect(await code(readExportFile(h.rt, who, suppliedFile.file, { originals: "as_supplied" }))).toBe("forbidden");
      expect((await exportMediaData(h.rt, who)).originals).toBe("location_removed");
    }
    expect(await code(exportMediaData(h.rt, me, { originals: "everything" as never }))).toBe("invalid_command");
    const backup = source.principal({ actor: "system", channel: "system", scopes: ["read", "write"] });
    expect((await exportMediaData(h.rt, backup, { originals: "as_supplied" })).originals).toBe("as_supplied");
    expect((await exportMediaData(h.rt, backup)).originals).toBe("location_removed");

    // A package that passes off a file with metadata as a derived copy is refused that file.
    const forged = { ...data, assets: data.assets.map((f) => (f.assetId === shirt && f.kind === "catalogue" ? { ...f, sha256: "", byteLength: 0 } : f)) };
    const catalogue = forged.assets.find((f) => f.assetId === shirt && f.kind === "catalogue")!;
    catalogue.sha256 = await sha256(tagged);
    catalogue.byteLength = tagged.length;
    const second = await h.createSyntheticOwner({ displayName: "Synthetic owner (location export, forged package)" });
    const forgedResult = await importMediaData(h.rt, second.principal({ channel: "import", actor: "system", scopes: ["read", "write", "admin"] }), forged, async (file) => (file === catalogue.file ? tagged : readExportFile(h.rt, me, file)));
    expect(forgedResult.rejected).toEqual([catalogue.file]);

    // The deletion journal names images and package paths only; it holds no image bytes and no location.
    await source.exec("media.delete_asset", { assetId: shirt });
    const journal = await listMediaDeletions(h.rt, me);
    expect(journal.deletedAssets).toEqual([{ assetId: shirt, deletedAt: expect.any(String), renditionIds: expect.any(Array), files: expect.any(Array) }]);
    for (const file of journal.deletedAssets[0]!.files) expect(file).toMatch(/^assets\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/);
    expect(JSON.stringify(journal)).not.toMatch(/POSITION|GPS|data:|base64/);
  });
});
