import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, isCommandError, listInventory } from "@garderobe/domain";
import { exportMediaData, getComposition, heifWithoutMetadata, readExportFile, requestCompositePreview, withoutLocation, withoutLocationForConversion, type ImageTranscoder } from "../src/index.ts";
import { sourceOrder } from "../src/portability.ts";
import { decodePng, encodeJpeg, encodePng, probeImage, stripJpegMetadata } from "../src/image/index.ts";
import { parseExifTiff } from "../src/image/sniff.ts";
import { createMediaHarness, holdTestImportLock, syntheticShirt } from "../src/testing/index.ts";

// Regression tests for the open review notes on the location work: PNG and WebP keep which way up they are,
// WebP animation frames keep only their picture, HEIC loses its metadata items before any converter sees it,
// a large image-state import gets a typed answer, and a truncated JPEG is not reported as cleaned.
// SYNTHETIC TEST IMAGES; the Exif, XMP and HEIC structures are hand-built TEST DATA. The converter is a
// recording TEST DOUBLE standing in for the Cloudflare Images transcoder; the WebP picture data comes from the
// local runtime's implementation of the Images binding.

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
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const u16 = (n: number) => new Uint8Array([(n >>> 8) & 0xff, n & 0xff]);
const u32le = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
const u24le = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff]);
const code = async (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e) => {
      if (!isCommandError(e)) return `threw:${String(e)}`;
      if (e.code === "internal") return `internal: ${e.message} ${JSON.stringify(e.details ?? {})}`;
      return e.code;
    },
  );

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
const pngChunk = (type: string, data: Uint8Array) => concat(u32(data.length), ascii(type), data, u32(crc32(concat(ascii(type), data))));
const webpChunk = (type: string, payload: Uint8Array) => concat(ascii(type), u32le(payload.length), payload, payload.length & 1 ? new Uint8Array(1) : new Uint8Array(0));
const riff = (...chunks: Uint8Array[]) => {
  const body = concat(ascii("WEBP"), ...chunks);
  return concat(ascii("RIFF"), u32le(body.length), body);
};

/** TEST DATA: a TIFF block saying "rotate 90°" (orientation 6) that also points at a GPS block and carries a position text. */
function taggedTiff(): Uint8Array {
  return concat(
    ascii("MM"), u16(42), u32(8),
    u16(2),
    u16(0x0112), u16(3), u32(1), u16(6), u16(0),
    u16(0x8825), u16(4), u32(1), u32(38),
    u32(0),
    ascii("TEST-EXIF-GPS-POSITION"),
  );
}

function chunksOf(webp: Uint8Array): { type: string; payload: Uint8Array }[] {
  const out: { type: string; payload: Uint8Array }[] = [];
  let o = 12;
  while (o + 8 <= webp.length) {
    const type = latin1(webp.subarray(o, o + 4));
    const size = webp[o + 4]! | (webp[o + 5]! << 8) | (webp[o + 6]! << 16) | (webp[o + 7]! << 24);
    out.push({ type, payload: webp.subarray(o + 8, o + 8 + size) });
    o += 8 + size + (size & 1);
  }
  return out;
}

describe("review notes: PNG and WebP keep which way up they are", () => {
  it("PNG: the Exif chunk's position and GPS pointer are left out, its orientation goes on in an Exif chunk of its own before the image data", async () => {
    const plain = await encodePng(syntheticShirt({ size: 64 }));
    const tagged = concat(plain.subarray(0, 33), pngChunk("eXIf", taggedTiff()), pngChunk("tEXt", ascii("Comment\0TEST-PNG-TEXT-POSITION")), plain.subarray(33));
    const out = withoutLocation(tagged);
    expect(out).toMatchObject({ ok: true, changed: true });
    const bytes = (out as { bytes: Uint8Array }).bytes;
    expect(latin1(bytes)).not.toMatch(/TEST-[A-Z-]*POSITION/);
    const at = latin1(bytes).indexOf("eXIf");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(latin1(bytes).indexOf("IDAT"));
    const len = (bytes[at - 4]! << 24) | (bytes[at - 3]! << 16) | (bytes[at - 2]! << 8) | bytes[at - 1]!;
    expect(parseExifTiff(bytes.subarray(at + 4, at + 4 + len))).toEqual({ orientation: 6, hasGps: false });
    // The chunk is well formed (its checksum verifies), the pixels are the same and a second pass changes nothing.
    expect((await decodePng(bytes)).data).toEqual((await decodePng(plain)).data);
    expect(withoutLocation(bytes)).toMatchObject({ ok: true, changed: false });
    // A PNG whose Exif chunk says nothing about orientation gets none.
    const upright = withoutLocation(concat(plain.subarray(0, 33), pngChunk("eXIf", concat(ascii("MM"), u16(42), u32(8), u16(0), u32(0), ascii("TEST-X-POSITION"))), plain.subarray(33)));
    expect(latin1((upright as { bytes: Uint8Array }).bytes)).not.toContain("eXIf");
  });

  it("WebP: Exif and XMP chunks are left out, the orientation goes on in an Exif chunk of its own, and an animation frame keeps only its picture", async () => {
    const images = (env as unknown as { IMAGES: ImagesBinding }).IMAGES;
    const jpeg = encodeJpeg(syntheticShirt({ size: 64 }), 90);
    const made = new Uint8Array(await new Response((await images.input(new Response(jpeg).body!).output({ format: "image/webp", quality: 90 })).image()).arrayBuffer());
    const picture = chunksOf(made).filter((c) => c.type === "VP8 " || c.type === "VP8L" || c.type === "ALPH").map((c) => webpChunk(c.type, c.payload));
    expect(picture.length).toBeGreaterThan(0);
    const { width, height } = probeImage(made)!;
    const vp8x = (flags: number) => webpChunk("VP8X", concat(new Uint8Array([flags, 0, 0, 0]), u24le(width! - 1), u24le(height! - 1)));

    const still = riff(vp8x(0x08 | 0x04), ...picture, webpChunk("EXIF", taggedTiff()), webpChunk("XMP ", ascii("<x:xmpmeta>TEST-WEBP-XMP-POSITION</x:xmpmeta>")));
    const out = withoutLocation(still);
    expect(out).toMatchObject({ ok: true, changed: true });
    const bytes = (out as { bytes: Uint8Array }).bytes;
    expect(latin1(bytes)).not.toMatch(/TEST-[A-Z-]*POSITION/);
    const chunks = chunksOf(bytes);
    expect(chunks.map((c) => c.type)).toEqual(["VP8X", ...chunksOf(made).filter((c) => c.type !== "VP8X").map((c) => c.type), "EXIF"]);
    expect(chunks[0]!.payload[0]! & 0x0c).toBe(0x08); // Exif follows, XMP does not
    expect(parseExifTiff(chunks.at(-1)!.payload)).toEqual({ orientation: 6, hasGps: false });
    expect(withoutLocation(bytes)).toMatchObject({ ok: true, changed: false });

    // TEST DATA: an animation whose frame carries an XMP chunk beside its picture.
    const frameHeader = concat(u24le(0), u24le(0), u24le(width! - 1), u24le(height! - 1), u24le(100), new Uint8Array([0]));
    const animated = riff(
      vp8x(0x02),
      webpChunk("ANIM", new Uint8Array([255, 255, 255, 255, 0, 0])),
      webpChunk("ANMF", concat(frameHeader, webpChunk("XMP ", ascii("TEST-FRAME-XMP-POSITION")), ...picture, webpChunk("ICCP", ascii("TEST-FRAME-FOREIGN-POSITION")))),
    );
    const anim = withoutLocation(animated);
    expect(anim).toMatchObject({ ok: true, changed: true });
    const animBytes = (anim as { bytes: Uint8Array }).bytes;
    expect(latin1(animBytes)).not.toMatch(/TEST-[A-Z-]*POSITION/);
    const frame = chunksOf(animBytes).find((c) => c.type === "ANMF")!;
    expect(latin1(frame.payload.subarray(0, 16))).toBe(latin1(frameHeader));
    expect(latin1(frame.payload.subarray(16))).toBe(latin1(concat(...picture)));
    // A frame with no picture is refused, not passed on.
    expect(withoutLocation(riff(vp8x(0x02), webpChunk("ANIM", new Uint8Array(6)), webpChunk("ANMF", concat(frameHeader, webpChunk("XMP ", ascii("x"))))))).toMatchObject({ ok: false });
  });
});

/** TEST DATA: a HEIC file with an HEVC picture item (one length-prefixed slice unit and its coding configuration), an Exif item and an XMP item, each located through `iloc`. */
function heicFile(opts: { width: number; height: number; infeVersion?: number; exifLocation?: "present" | "absent" | "no_extents"; extraItem?: Uint8Array; extraMetaChild?: Uint8Array; extraTop?: Uint8Array; extraProperty?: Uint8Array; pictureName?: string; pictureUnits?: Uint8Array; ipmaTail?: Uint8Array; iinfCountDelta?: number; ftyp?: Uint8Array }): { bytes: Uint8Array; picture: Uint8Array } {
  const box = (type: string, ...payload: Uint8Array[]) => {
    const body = concat(...payload);
    return concat(u32(8 + body.length), ascii(type), body);
  };
  const full = (type: string, version: number, ...payload: Uint8Array[]) => box(type, new Uint8Array([version, 0, 0, 0]), ...payload);
  const v = opts.infeVersion ?? 2;
  const infe = (id: number, type: string, ...rest: Uint8Array[]) => (v >= 2 ? full("infe", v, u16(id), u16(0), ascii(type), ascii("\0"), ...rest) : full("infe", v, u16(id), u16(0), ascii("\0\0")));
  const picture = opts.pictureUnits ?? hevcUnit(1, ascii("TEST-HEVC-PICTURE-DATA-KEPT"));
  const exif = concat(u32(0), taggedTiff(), ascii("TEST-HEIC-GPS-POSITION"));
  const xmp = ascii("<x:xmpmeta>TEST-HEIC-XMP-POSITION</x:xmpmeta>");
  const ftyp = box("ftyp", opts.ftyp ?? concat(ascii("heic"), u32(0), ascii("mif1"), ascii("heic")));
  const exifLocation = opts.exifLocation ?? "present";
  const iloc = (at: number) =>
    full("iloc", 0, new Uint8Array([0x44, 0x00]), u16(exifLocation === "absent" ? 2 : 3),
      u16(1), u16(0), u16(1), u32(at), u32(picture.length),
      exifLocation === "absent" ? new Uint8Array(0) : exifLocation === "no_extents" ? concat(u16(2), u16(0), u16(0)) : concat(u16(2), u16(0), u16(1), u32(at + picture.length), u32(exif.length)),
      u16(3), u16(0), u16(1), u32(at + picture.length + exif.length), u32(xmp.length));
  const extraItem = opts.extraItem ?? new Uint8Array(0);
  const meta = (at: number) =>
    full("meta", 0,
      full("iinf", 0, u16((extraItem.length > 0 ? 4 : 3) + (opts.iinfCountDelta ?? 0)), v >= 2 ? full("infe", v, u16(1), u16(0), ascii("hvc1"), ascii(`${opts.pictureName ?? ""}\0`)) : infe(1, "hvc1"), infe(2, "Exif"), infe(3, "mime", ascii("application/rdf+xml\0")), extraItem),
      box("iprp",
        box("ipco", full("ispe", 0, u32(opts.width), u32(opts.height)), box("hvcC", hvcCBody()), opts.extraProperty ?? new Uint8Array(0)),
        full("ipma", 0, u32(1), u16(1), new Uint8Array([2, 0x81, 0x82]), opts.ipmaTail ?? new Uint8Array(0))),
      iloc(at),
      opts.extraMetaChild ?? new Uint8Array(0));
  const at = ftyp.length + meta(0).length + 8;
  return { bytes: concat(ftyp, meta(at), box("mdat", picture, exif, xmp), opts.extraTop ?? new Uint8Array(0)), picture };
}

/** TEST DATA: one HEVC NAL unit of the given type, preceded by its 4-byte length. */
function hevcUnit(type: number, payload: Uint8Array): Uint8Array {
  return concat(u32(payload.length + 2), new Uint8Array([type << 1, 0x01]), payload);
}

/** TEST DATA: an HEVC decoder configuration with 4-byte NAL lengths and no parameter-set arrays. */
function hvcCBody(): Uint8Array {
  const out = new Uint8Array(23);
  out[0] = 1;
  out[21] = 0xff; // reserved bits set, lengthSizeMinusOne = 3
  return out;
}

/** TEST DATA: one box of the given type and payload, for the HEIC variants. */
const heicBox = (type: string, ...payload: Uint8Array[]) => {
  const body = concat(...payload);
  return concat(u32(8 + body.length), ascii(type), body);
};
const heicInfe = (id: number, type: string, ...rest: Uint8Array[]) => heicBox("infe", new Uint8Array([2, 0, 0, 0]), u16(id), u16(0), ascii(type), ascii("\0"), ...rest);

describe("review notes: a HEIC photograph loses its location data before it goes to the converter", () => {
  it("blanks the Exif and XMP items in place, keeps the picture item, and refuses a file whose metadata it cannot locate", () => {
    const { bytes, picture } = heicFile({ width: 512, height: 512 });
    expect(probeImage(bytes)).toMatchObject({ format: "heic", width: 512, height: 512 });
    const out = heifWithoutMetadata(bytes);
    expect(out).toMatchObject({ ok: true, removedItems: 2 });
    const clean = (out as { bytes: Uint8Array }).bytes;
    expect(clean.length).toBe(bytes.length);
    expect(latin1(clean)).not.toMatch(/TEST-[A-Z-]*POSITION/);
    expect(latin1(clean)).toContain(latin1(picture));
    expect(latin1(clean)).not.toContain("Exif");
    expect(probeImage(clean)).toMatchObject({ format: "heic", width: 512, height: 512 });
    expect(withoutLocationForConversion(bytes, bytes.length)).toMatchObject({ ok: true });
    // A file above the size limit is never cleaned or handed on, whatever it holds.
    expect(withoutLocationForConversion(bytes, bytes.length - 1)).toMatchObject({ ok: false, reason: expect.stringMatching(/limit/) });
    // An item format that is not read here, and a file whose metadata lies outside it, are refused.
    expect(heifWithoutMetadata(heicFile({ width: 512, height: 512, infeVersion: 0 }).bytes)).toMatchObject({ ok: false });
    const cut = bytes.subarray(0, bytes.length - 20);
    expect(heifWithoutMetadata(cut)).toMatchObject({ ok: false });
  });

  it("refuses a HEIC whose metadata bytes it cannot prove removed, or that carries structures it does not read", () => {
    const size = { width: 512, height: 512 };
    // An Exif item with no location entry, or with one that lists no extents: renaming it would leave its bytes in place.
    for (const exifLocation of ["absent", "no_extents"] as const) {
      const { bytes } = heicFile({ ...size, exifLocation });
      expect(latin1(bytes)).toContain("TEST-HEIC-GPS-POSITION");
      expect(heifWithoutMetadata(bytes), exifLocation).toMatchObject({ ok: false, reason: expect.stringMatching(/no (stated )?location/) });
      expect(withoutLocationForConversion(bytes, 20 * 1024 * 1024), exifLocation).toMatchObject({ ok: false });
    }
    // A movie box (which can hold its own metadata), an unknown uuid, an XML box in the metadata, a non-XMP MIME item and an unknown item type.
    const variants: [string, Uint8Array][] = [
      ["moov", heicFile({ ...size, extraTop: heicBox("moov", heicBox("udta", ascii("TEST-MOVIE-GPS-POSITION"))) }).bytes],
      ["uuid", heicFile({ ...size, extraTop: heicBox("uuid", new Uint8Array(16).fill(7), ascii("TEST-UUID-POSITION")) }).bytes],
      ["xml", heicFile({ ...size, extraMetaChild: heicBox("xml ", new Uint8Array(4), ascii("<x>TEST-XML-POSITION</x>")) }).bytes],
      // An entity-group list is not read here, so whatever its groups (or unknown children) carry cannot be cleared: refused.
      ["grpl", heicFile({ ...size, extraMetaChild: heicBox("grpl", heicBox("altr", new Uint8Array(4), ascii("TEST-GRPL-POSITION"))) }).bytes],
      ["mime", heicFile({ ...size, extraItem: heicInfe(4, "mime", ascii("application/json\0")) }).bytes],
      ["uri", heicFile({ ...size, extraItem: heicInfe(4, "uri ", ascii("urn:test:position\0")) }).bytes],
      // A JPEG picture item is a whole JPEG stream that can carry its own Exif position: not cleaned here, so refused.
      ["jpeg item", heicFile({ ...size, extraItem: heicInfe(4, "jpeg") }).bytes],
      // HEVC SEI messages in the picture data can carry descriptive data: refused rather than passed on.
      ["sei", heicFile({ ...size, pictureUnits: concat(hevcUnit(39, ascii("TEST-SEI-POSITION")), hevcUnit(1, ascii("slice"))) }).bytes],
      ["unspecified unit", heicFile({ ...size, pictureUnits: hevcUnit(50, ascii("TEST-UNSPEC-POSITION")) }).bytes],
      ["reserved slice type", heicFile({ ...size, pictureUnits: hevcUnit(12, ascii("TEST-RSV-POSITION")) }).bytes],
      ["end marker with data", heicFile({ ...size, pictureUnits: concat(hevcUnit(1, ascii("slice")), hevcUnit(36, ascii("TEST-EOS-POSITION"))) }).bytes],
      // Item information in a version not read here, or with a count that does not match its entries.
      ["infe v4", heicFile({ ...size, extraItem: heicBox("infe", new Uint8Array([4, 0, 0, 0]), u16(4), u16(0), ascii("hvc1"), ascii("\0")) }).bytes],
      ["iinf count", heicFile({ ...size, iinfCountDelta: 1 }).bytes],
      // A file type box with a brand not read here, or a minor version that could carry anything.
      ["ftyp brand", heicFile({ ...size, ftyp: concat(ascii("heic"), u32(0), ascii("mif1"), ascii("TEST")) }).bytes],
      ["ftyp minor", heicFile({ ...size, ftyp: concat(ascii("heic"), ascii("GPS!"), ascii("mif1")) }).bytes],
      // Bytes after what the property associations, item references and primary item declare.
      ["ipma tail", heicFile({ ...size, ipmaTail: ascii("TEST-IPMA-POSITION") }).bytes],
      ["iref tail", heicFile({ ...size, extraMetaChild: heicBox("iref", new Uint8Array(4), heicBox("cdsc", u16(2), u16(1), u16(1), ascii("TEST-IREF-POSITION"))) }).bytes],
      ["pitm tail", heicFile({ ...size, extraMetaChild: heicBox("pitm", new Uint8Array(4), u16(1), ascii("TEST-PITM-POSITION")) }).bytes],
      // An embedded colour profile (free text), an unknown auxiliary image, a codec configuration not read here.
      ["icc", heicFile({ ...size, extraProperty: heicBox("colr", ascii("prof"), ascii("TEST-ICC-DESC-POSITION")) }).bytes],
      ["auxC", heicFile({ ...size, extraProperty: heicBox("auxC", new Uint8Array(4), ascii("urn:test:TEST-AUX-POSITION\0")) }).bytes],
      ["vvcC", heicFile({ ...size, extraProperty: heicBox("vvcC", ascii("TEST-VVC-POSITION")) }).bytes],
    ];
    for (const [label, bytes] of variants) expect(heifWithoutMetadata(bytes), label).toMatchObject({ ok: false });
    // Item descriptions are exactly their defined structure: anything after a picture or Exif item's name, a
    // protected item, or a MIME item with a content encoding or extra bytes is refused before anything else is read.
    const described: [string, Uint8Array][] = [
      ["picture item trailing bytes", heicFile({ ...size, extraItem: heicInfe(4, "hvc1", ascii("TEST-INFE-TRAIL-POSITION")) }).bytes],
      ["Exif item trailing bytes", heicFile({ ...size, extraItem: heicInfe(4, "Exif", ascii("TEST-INFE-EXIF-POSITION")) }).bytes],
      ["MIME item with an encoding", heicFile({ ...size, extraItem: heicInfe(4, "mime", ascii("application/rdf+xml\0gzip\0")) }).bytes],
      ["MIME item trailing bytes", heicFile({ ...size, extraItem: heicInfe(4, "mime", ascii("application/rdf+xml\0\0TEST-MIME-POSITION")) }).bytes],
    ];
    for (const [label, bytes] of described) expect(heifWithoutMetadata(bytes), label).toMatchObject({ ok: false, reason: expect.stringMatching(/description is not the structure/) });
    const protectedItem = heicFile({ ...size, extraItem: heicBox("infe", new Uint8Array([2, 0, 0, 0]), u16(4), u16(1), ascii("hvc1"), ascii("\0")) }).bytes;
    expect(heifWithoutMetadata(protectedItem)).toMatchObject({ ok: false, reason: expect.stringMatching(/protected item/) });
    // The same structures, exactly as their types define them, are accepted.
    const exact = heicFile({ ...size, extraMetaChild: concat(heicBox("iref", new Uint8Array(4), heicBox("cdsc", u16(2), u16(1), u16(1))), heicBox("pitm", new Uint8Array(4), u16(1))), extraProperty: heicBox("colr", ascii("nclx"), new Uint8Array(7)) });
    expect(heifWithoutMetadata(exact.bytes)).toMatchObject({ ok: true, removedItems: 2 });
    // Filler data is kept as filler, whatever it held.
    const filled = heicFile({ ...size, pictureUnits: concat(hevcUnit(1, ascii("slice")), hevcUnit(38, ascii("TEST-FILLER-POSITION"))) });
    const filledOut = heifWithoutMetadata(filled.bytes);
    expect(filledOut).toMatchObject({ ok: true });
    expect(latin1((filledOut as { bytes: Uint8Array }).bytes)).not.toMatch(/TEST-[A-Z-]*POSITION/);
    // A user-description property is not a picture property: refused.
    expect(heifWithoutMetadata(heicFile({ ...size, extraProperty: heicBox("udes", new Uint8Array(4), ascii("en\0TEST-UDES-POSITION\0\0\0")) }).bytes)).toMatchObject({ ok: false });
    // Padding (top level and inside the metadata box) and a picture item's free-text name are blanked, not passed on.
    const padded = heicFile({ ...size, pictureName: "TEST-ITEM-NAME-POSITION", extraMetaChild: heicBox("free", ascii("TEST-META-FREE-POSITION")), extraTop: heicBox("free", ascii("TEST-TOP-FREE-POSITION")) });
    const cleaned = heifWithoutMetadata(padded.bytes);
    expect(cleaned).toMatchObject({ ok: true, removedItems: 2 });
    const cleanedBytes = (cleaned as { bytes: Uint8Array }).bytes;
    expect(cleanedBytes.length).toBe(padded.bytes.length);
    expect(latin1(cleanedBytes)).not.toMatch(/TEST-[A-Z-]*POSITION/);
    expect(latin1(cleanedBytes)).toContain(latin1(padded.picture));
    expect(probeImage(cleanedBytes)).toMatchObject({ format: "heic", width: 512, height: 512 });
  });
});

describe("review round 3: exports read only live files, tombstones and file order survive an import, converter output is bounded", () => {
  it("does not read a deleted image's files while they wait for the purge, in either originals mode", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (export after delete)" });
    const up = await h.upload(owner, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 128 }), demo: true });
    await h.settle(owner);
    const data = await exportMediaData(h.rt, owner.principal());
    const files = data.assets.filter((f) => f.assetId === up.asset!.assetId);
    expect(files.length).toBeGreaterThan(1);
    expect(await readExportFile(h.rt, owner.principal(), files[0]!.file)).not.toBeNull();
    await owner.exec("media.delete_asset", { assetId: up.asset!.assetId });
    // The purge job has not run: the stored objects are still there, but nothing returns them.
    expect(await h.bindings.MEDIA_BUCKET.head(`u/${owner.userId}/${files[0]!.file}`)).not.toBeNull();
    for (const f of files) {
      expect(await readExportFile(h.rt, owner.principal(), f.file), f.kind).toBeNull();
      expect(await readExportFile(h.rt, owner.principal(), f.file, { originals: "as_supplied" }), f.kind).toBeNull();
    }
  });

  it("orders file records after their sources whatever the package order, and refuses a missing source or a cycle", () => {
    const at = "2026-09-14T08:00:00.000Z";
    const rows = [
      { rendition_id: "r-cutout", kind: "cutout", source_rendition_id: "r-edited", created_at: at },
      { rendition_id: "r-catalogue", kind: "catalogue", source_rendition_id: "r-cutout", created_at: at },
      { rendition_id: "r-edited", kind: "edited", source_rendition_id: "r-original", created_at: at },
      { rendition_id: "r-original", kind: "original", source_rendition_id: null, created_at: at },
    ];
    expect(sourceOrder(rows).map((r) => r.rendition_id)).toEqual(["r-original", "r-edited", "r-cutout", "r-catalogue"]);
    expect(() => sourceOrder(rows.slice(0, 3))).toThrow(/not in the same import/);
    expect(() => sourceOrder([{ rendition_id: "a", source_rendition_id: "b" }, { rendition_id: "b", source_rendition_id: "a" }])).toThrow(/from itself/);
    // A source committed by an earlier command of the same import (images are packed into several commands) is accepted.
    expect(sourceOrder([{ rendition_id: "r-cutout", source_rendition_id: "r-edited" }], new Set(["r-edited"])).map((r) => r.rendition_id)).toEqual(["r-cutout"]);
    expect(() => sourceOrder([{ rendition_id: "r-cutout", source_rendition_id: "r-edited" }], new Set(["r-other"]))).toThrow(/not in the same import/);
  });

  it("draws an oversized converter result as a missing image instead of decoding it", async () => {
    const calls: string[] = [];
    // TEST DATA: a valid small PNG whose header is patched to claim 20000 x 20000 pixels.
    const small = await encodePng(syntheticShirt({ size: 32 }));
    const huge = small.slice();
    huge.set(u32(20000), 16);
    huge.set(u32(20000), 20);
    huge.set(u32(crc32(huge.subarray(12, 29))), 29);
    const transcoder: ImageTranscoder = {
      name: "test-double-transcoder",
      version: "test",
      async toPng(input) {
        calls.push(String(input.maxEdge));
        // Normalization's request fails, so the HEIC original stays the garment's image; the preview's request gets the oversized picture.
        return calls.length === 1 ? { ok: false, reason: "TEST: conversion unavailable" } : { ok: true, png: huge };
      },
    };
    const h = await createMediaHarness({ adapters: { transcoder } });
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (bounded converter output)" });
    const { bytes } = heicFile({ width: 400, height: 400 });
    const up = await h.upload(owner, { garmentId: "shirt-moss", bytes, contentType: "image/heic", demo: true });
    expect(up.rejected).toBeNull();
    await h.settle(owner);
    expect(calls).toHaveLength(1);
    const preview = await requestCompositePreview(h.rt, owner.principal(), { slots: [{ role: "top", garmentId: "shirt-moss" }] });
    await h.settle(owner);
    expect(calls).toHaveLength(2); // the preview asked the converter for the HEIC picture
    expect((await getComposition(h.rt, owner.principal(), preview.manifestHash)).preview.state).toBe("rendered");
  });

  it("the normalization job hands the converter the cleaned file, and does not convert one it cannot clean", async () => {
    const seen: Uint8Array[] = [];
    const transcoder: ImageTranscoder = {
      name: "test-double-transcoder",
      version: "test",
      async toPng(input) {
        seen.push(input.bytes.slice());
        return { ok: true, png: await encodePng(syntheticShirt({ size: 256 })) };
      },
    };
    const h = await createMediaHarness({ adapters: { transcoder } });
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (HEIC before conversion)" });
    const { bytes, picture } = heicFile({ width: 512, height: 512 });
    const up = await h.upload(owner, { garmentId: "shirt-moss", bytes, contentType: "image/heic", demo: true });
    expect(up.rejected).toBeNull();
    await h.settle(owner);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.length).toBe(bytes.length);
    expect(latin1(seen[0]!)).not.toMatch(/TEST-[A-Z-]*POSITION/);
    expect(latin1(seen[0]!)).toContain(latin1(picture));

    const bad = heicFile({ width: 600, height: 600, infeVersion: 0 }).bytes;
    const second = await h.upload(owner, { garmentId: "shirt-gold", bytes: bad, contentType: "image/heic", demo: true });
    expect(second.rejected).toBeNull();
    await h.settle(owner);
    expect(seen).toHaveLength(1);
    const reasons = await all<{ status_reason: string | null; result_json: string | null }>(h.db, "SELECT a.status_reason, j.result_json FROM media_assets a LEFT JOIN media_jobs j ON j.user_id = a.user_id AND j.subject_id = a.asset_id WHERE a.user_id = ? AND a.asset_id = ?", owner.userId, second.asset!.assetId);
    expect(JSON.stringify(reasons)).toMatch(/location data could not be removed/);
  });

  it("a stored original above the upload size limit is not read, cleaned or sent to the converter", async () => {
    const seen: Uint8Array[] = [];
    const transcoder: ImageTranscoder = {
      name: "test-double-transcoder",
      version: "test",
      async toPng(input) {
        seen.push(input.bytes.slice());
        return { ok: true, png: await encodePng(syntheticShirt({ size: 256 })) };
      },
    };
    const h = await createMediaHarness({ adapters: { transcoder } });
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (oversized stored original)" });
    const { bytes } = heicFile({ width: 512, height: 512 });
    const up = await h.upload(owner, { garmentId: "shirt-moss", bytes, contentType: "image/heic", demo: true });
    expect(up.rejected).toBeNull();
    // TEST SETUP: the limit is lowered after finalization, so the stored original is now above it.
    h.deps.limits = { ...(h.deps.limits ?? {}), maxUploadBytes: bytes.length - 1 };
    await h.settle(owner);
    expect(seen).toHaveLength(0);
    const reasons = await all<{ status_reason: string | null; result_json: string | null }>(h.db, "SELECT a.status_reason, j.result_json FROM media_assets a LEFT JOIN media_jobs j ON j.user_id = a.user_id AND j.subject_id = a.asset_id WHERE a.user_id = ? AND a.asset_id = ?", owner.userId, up.asset!.assetId);
    expect(JSON.stringify(reasons)).toMatch(/larger than the \d+-byte limit/);
  });
});

describe("review notes: a large image-state import and a truncated JPEG", () => {
  it("imports image state for all 127 real garments in one command, and refuses a repeat with a typed answer", async () => {
    const h = await createMediaHarness();
    const { owner } = await h.createRealOwner();
    const ids = (await listInventory(h.db, owner.principal(), {}, { nowMs: h.clock.now() })).items.map((i) => i.garment.garmentId);
    expect(ids.length).toBe(127);
    const importer = owner.principal({ channel: "import", actor: "system", scopes: ["read", "write", "admin"] });
    const lock = await holdTestImportLock(h.db, owner.userId, h.clock.iso()); // TEST SETUP: the import holds the owner's lock
    const run = () =>
      h.service.execute(importer, {
        type: "media.import_records",
        payload: { part: "garmentMedia", importDigest: lock.importDigest, importPlanDigest: lock.importPlanDigest, rows: { garmentMedia: ids.map((garment_id) => ({ garment_id, image_state: "not_started", primary_asset_id: null, version: 1, updated_at: new Date().toISOString() })) } },
        idempotencyKey: lock.key(`big-import-${crypto.randomUUID()}`), expectedVersions: {}, authorization: "data_import", source: { channel: "import" },
      });
    expect(await code(run())).toBe("ok");
    expect(await all(h.db, "SELECT 1 FROM garment_media WHERE user_id = ?", owner.userId)).toHaveLength(127);
    expect(await code(run())).toBe("precondition_failed");
  });

  it("stripJpegMetadata refuses a JPEG cut short before its end marker or with a malformed scan header", () => {
    const plain = encodeJpeg(syntheticShirt({ size: 64 }), 90);
    expect(() => stripJpegMetadata(plain.subarray(0, plain.length - 2))).toThrow(/end marker/);
    const sos = plain.findIndex((b, i) => b === 0xff && plain[i + 1] === 0xda);
    const broken = plain.slice();
    broken[sos + 4] = 9; // nine components
    expect(() => stripJpegMetadata(broken)).toThrow(/scan header/);
    expect(stripJpegMetadata(plain).length).toBeGreaterThan(0);
  });
});
