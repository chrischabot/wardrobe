import { describe, expect, it } from "vitest";
import jpeg from "jpeg-js";
import {
  alphaBounds, applyExifOrientation, assemblePng, compositeOver, createRaster, cropRaster, decodeImage, decodeJpeg, decodePng, encodeJpeg, encodePng, fitWithin, flipRaster,
  ImageDecodeError, probeImage, resizeRaster, rotateRaster, stripJpegMetadata, type Raster,
} from "../../src/image/index.ts";
import { syntheticShirt } from "../../src/testing/fixtures.ts";

function px(r: Raster, x: number, y: number): number[] {
  const i = (y * r.width + x) * 4;
  return [...r.data.subarray(i, i + 4)];
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A little-endian Exif APP1 segment with Orientation and, optionally, a GPS IFD pointer. */
function exifSegment(orientation: number, gps: boolean): Uint8Array {
  const entries = gps ? 2 : 1;
  const tiff = new Uint8Array(8 + 2 + entries * 12 + 4 + (gps ? 6 : 0));
  const v = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
  v.setUint16(8, entries, true);
  v.setUint16(10, 0x0112, true);
  v.setUint16(12, 3, true);
  v.setUint32(14, 1, true);
  v.setUint16(18, orientation, true);
  if (gps) {
    v.setUint16(22, 0x8825, true);
    v.setUint16(24, 4, true);
    v.setUint32(26, 1, true);
    v.setUint32(30, 8 + 2 + entries * 12 + 4, true);
  }
  const body = concat(new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0]), tiff);
  const seg = new Uint8Array(4 + body.length);
  seg.set([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff]);
  seg.set(body, 4);
  return seg;
}

function withExif(jpg: Uint8Array, orientation: number, gps: boolean): Uint8Array {
  return concat(jpg.subarray(0, 2), exifSegment(orientation, gps), jpg.subarray(2));
}

describe("PNG codec", () => {
  it("round-trips RGBA exactly and encodes deterministically without metadata", async () => {
    const src = syntheticShirt({ size: 64 });
    src.data[3] = 0;
    src.data[7] = 128;
    const a = await encodePng(src);
    const b = await encodePng(src);
    expect(a).toEqual(b);
    const back = await decodePng(a);
    expect(back.width).toBe(64);
    expect([...back.data]).toEqual([...src.data]);
    const text = new TextDecoder("latin1").decode(a);
    for (const chunk of ["tEXt", "eXIf", "iTXt", "tIME"]) expect(text.includes(chunk)).toBe(false);
  });

  it("decodes greyscale, 16-bit, palette with tRNS and low bit depths", async () => {
    const grey = await decodePng(await assemblePng({ width: 2, height: 1, depth: 8, colourType: 0 }, new Uint8Array([0, 10, 200])));
    expect(px(grey, 0, 0)).toEqual([10, 10, 10, 255]);
    expect(px(grey, 1, 0)).toEqual([200, 200, 200, 255]);

    const deep = await decodePng(await assemblePng({ width: 1, height: 1, depth: 16, colourType: 2 }, new Uint8Array([0, 0xab, 0xcd, 0x12, 0x34, 0xff, 0x00])));
    expect(px(deep, 0, 0)).toEqual([0xab, 0x12, 0xff, 255]);

    const pal = await decodePng(
      await assemblePng({ width: 2, height: 1, depth: 8, colourType: 3 }, new Uint8Array([0, 0, 1]), [
        { type: "PLTE", body: new Uint8Array([255, 0, 0, 0, 0, 255]) },
        { type: "tRNS", body: new Uint8Array([40]) },
      ]),
    );
    expect(px(pal, 0, 0)).toEqual([255, 0, 0, 40]);
    expect(px(pal, 1, 0)).toEqual([0, 0, 255, 255]);

    // 1-bit greyscale, 8 pixels in one byte: 10100000
    const bits = await decodePng(await assemblePng({ width: 8, height: 1, depth: 1, colourType: 0 }, new Uint8Array([0, 0b10100000])));
    expect([px(bits, 0, 0)[0], px(bits, 1, 0)[0], px(bits, 2, 0)[0]]).toEqual([255, 0, 255]);
  });

  it("decodes an Adam7 interlaced image", async () => {
    // 2x2 greyscale: pass 1 holds (0,0); pass 6 holds (1,0); pass 7 holds row 1.
    const filtered = new Uint8Array([0, 11, 0, 22, 0, 33, 44]);
    const out = await decodePng(await assemblePng({ width: 2, height: 2, depth: 8, colourType: 0, interlace: 1 }, filtered));
    expect([px(out, 0, 0)[0], px(out, 1, 0)[0], px(out, 0, 1)[0], px(out, 1, 1)[0]]).toEqual([11, 22, 33, 44]);
  });

  it("rejects a corrupted checksum, a truncated file, and an oversized header before inflating", async () => {
    const good = await encodePng(createRaster(4, 4, [1, 2, 3, 255]));
    const bad = new Uint8Array(good);
    bad[bad.length - 20]! ^= 0xff;
    await expect(decodePng(bad)).rejects.toMatchObject({ reason: "corrupt" });
    await expect(decodePng(good.subarray(0, good.length - 14))).rejects.toMatchObject({ reason: "corrupt" });
    // A tiny file claiming 50000 x 50000 pixels: refused from the header alone.
    const bomb = await assemblePng({ width: 50000, height: 50000, depth: 8, colourType: 6 }, new Uint8Array(8));
    await expect(decodePng(bomb)).rejects.toMatchObject({ reason: "too_large" });
    await expect(decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).rejects.toBeInstanceOf(ImageDecodeError);
  });
});

describe("JPEG codec and metadata", () => {
  const flat = createRaster(16, 8, [200, 40, 40, 255]);
  for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) flat.data.set([40, 40, 200, 255], (y * 16 + x) * 4);
  const jpg = encodeJpeg(flat, 95);

  it("decodes colours within tolerance", () => {
    const out = decodeJpeg(jpg);
    expect([out.width, out.height]).toEqual([16, 8]);
    const left = px(out, 2, 4), right = px(out, 13, 4);
    expect(left[2]! - left[0]!).toBeGreaterThan(100);
    expect(right[0]! - right[2]!).toBeGreaterThan(100);
  });

  it("turns the image upright using EXIF orientation and reports GPS presence", () => {
    const tagged = withExif(jpg, 6, true);
    const probe = probeImage(tagged)!;
    expect(probe.exif).toEqual({ present: true, orientation: 6, hasGps: true });
    const upright = decodeJpeg(tagged);
    expect([upright.width, upright.height]).toEqual([8, 16]);
    // Orientation 6 = rotate 90 degrees clockwise: the left (blue) half ends up on top.
    expect(px(upright, 4, 2)[2]!).toBeGreaterThan(150);
    expect(px(upright, 4, 13)[0]!).toBeGreaterThan(150);
    expect(decodeJpeg(tagged, { applyOrientation: false }).width).toBe(16);
  });

  it("strips EXIF and GPS losslessly", () => {
    const tagged = withExif(jpg, 1, true);
    const stripped = stripJpegMetadata(tagged);
    expect(probeImage(stripped)!.exif).toEqual({ present: false, orientation: null, hasGps: false });
    expect([...decodeJpeg(stripped).data]).toEqual([...decodeJpeg(jpg).data]);
    expect(() => stripJpegMetadata(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(ImageDecodeError);
  });

  it("refuses oversized and corrupt JPEGs", () => {
    expect(() => decodeJpeg(jpg, { maxPixels: 10 })).toThrow(/pixel limit/);
    const broken = new Uint8Array(jpg.subarray(0, Math.floor(jpg.length / 2)));
    expect(() => decodeJpeg(broken)).toThrow(ImageDecodeError);
  });

  it("decodeImage dispatches by content, not by claimed type, and declines formats needing a transcoder", async () => {
    expect((await decodeImage(jpg)).probe.format).toBe("jpeg");
    expect((await decodeImage(await encodePng(flat))).probe.format).toBe("png");
    const webp = new Uint8Array(40);
    webp.set([0x52, 0x49, 0x46, 0x46, 32, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0x10, 0, 0, 0, 99, 0, 0, 49, 0, 0]);
    await expect(decodeImage(webp)).rejects.toMatchObject({ reason: "unsupported_format" });
    await expect(decodeImage(new TextEncoder().encode("<svg onload=alert(1)></svg>    "))).rejects.toMatchObject({ reason: "unrecognized" });
  });
});

describe("probeImage", () => {
  it("reads PNG, WebP, GIF and HEIC headers", async () => {
    const png = probeImage(await encodePng(createRaster(7, 5)))!;
    expect([png.format, png.width, png.height, png.hasAlpha, png.animated]).toEqual(["png", 7, 5, true, false]);

    const webp = new Uint8Array(40);
    webp.set([0x52, 0x49, 0x46, 0x46, 32, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0x1a, 0, 0, 0, 99, 0, 0, 49, 0, 0]);
    const w = probeImage(webp)!;
    expect([w.format, w.width, w.height, w.animated, w.exif.present, w.hasAlpha]).toEqual(["webp", 100, 50, true, true, true]);

    const gif = new Uint8Array(32);
    gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 20, 0, 10, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, 20, 0, 10, 0, 0, 2, 0, 0x2c, 0, 0, 0, 0, 1, 0]);
    const g = probeImage(gif)!;
    expect([g.format, g.width, g.height, g.animated]).toEqual(["gif", 20, 10, true]);

    const heic = new Uint8Array(64);
    heic.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63]);
    heic.set([0, 0, 0, 20, 0x69, 0x73, 0x70, 0x65, 0, 0, 0, 0, 0, 0, 0x0f, 0xc0, 0, 0, 0x0b, 0xd0], 24);
    const h = probeImage(heic)!;
    expect([h.format, h.contentType, h.width, h.height]).toEqual(["heic", "image/heic", 4032, 3024]);
  });

  it("returns null for non-images and truncated headers", () => {
    expect(probeImage(new TextEncoder().encode("%PDF-1.7 not an image at all"))).toBeNull();
    expect(probeImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2, 3, 4, 5, 6]))).toBeNull();
    expect(probeImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]))).toBeNull();
    expect(probeImage(new Uint8Array(3))).toBeNull();
  });
});

describe("raster operations", () => {
  it("fits within a box without upscaling", () => {
    expect(fitWithin(4000, 3000, 1600, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(100, 50, 1600, 1600)).toEqual({ width: 100, height: 50 });
    expect(fitWithin(5000, 1, 100, 100)).toEqual({ width: 100, height: 1 });
  });

  it("resizes by area average without bleeding transparent colour", () => {
    const src = createRaster(4, 4, [0, 255, 0, 0]); // transparent green
    for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) src.data.set([200, 0, 0, 255], (y * 4 + x) * 4);
    const half = resizeRaster(src, 2, 2);
    expect(px(half, 0, 0)).toEqual([200, 0, 0, 255]);
    expect(px(half, 1, 0)[3]).toBe(0);
    const one = resizeRaster(src, 1, 1);
    expect(one.data[0]).toBe(200); // colour comes only from the opaque half
    expect(one.data[1]).toBe(0);
    expect(one.data[3]).toBe(128);
    const up = resizeRaster(createRaster(2, 2, [10, 20, 30, 255]), 5, 5);
    expect(px(up, 2, 2)).toEqual([10, 20, 30, 255]);
  });

  it("crops with clamping, rotates, flips and applies every EXIF orientation", () => {
    // 2x1: A B
    const ab = createRaster(2, 1);
    ab.data.set([1, 0, 0, 255, 2, 0, 0, 255]);
    expect(px(cropRaster(ab, 1, 0, 50, 50), 0, 0)[0]).toBe(2);
    const cw = rotateRaster(ab, 1);
    expect([cw.width, cw.height, px(cw, 0, 0)[0], px(cw, 0, 1)[0]]).toEqual([1, 2, 1, 2]);
    expect(px(rotateRaster(ab, 2), 0, 0)[0]).toBe(2);
    expect(px(rotateRaster(ab, 3), 0, 0)[0]).toBe(2);
    expect(px(flipRaster(ab, "h"), 0, 0)[0]).toBe(2);
    const first = (o: number) => {
      const r = applyExifOrientation(ab, o);
      return [r.width, px(r, 0, 0)[0]];
    };
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(first)).toEqual([[2, 1], [2, 2], [2, 2], [2, 1], [1, 1], [1, 1], [1, 2], [1, 2], [2, 1]]);
  });

  it("composites source-over and finds alpha bounds", () => {
    const dst = createRaster(3, 3, [0, 0, 0, 255]);
    const src = createRaster(2, 2, [255, 255, 255, 128]);
    compositeOver(dst, src, 2, 2); // only one pixel lands inside
    expect(px(dst, 2, 2)).toEqual([128, 128, 128, 255]);
    expect(px(dst, 1, 1)).toEqual([0, 0, 0, 255]);
    const sparse = createRaster(10, 10);
    sparse.data[(3 * 10 + 4) * 4 + 3] = 255;
    sparse.data[(6 * 10 + 7) * 4 + 3] = 255;
    expect(alphaBounds(sparse)).toEqual({ x: 4, y: 3, width: 4, height: 4 });
    expect(alphaBounds(createRaster(3, 3))).toBeNull();
  });

  it("jpeg-js is only used with typed arrays (no Buffer leaks into rasters)", () => {
    const enc = jpeg.encode({ data: new Uint8Array(4 * 4 * 4).fill(255), width: 4, height: 4 }, 80);
    expect(decodeJpeg(new Uint8Array(enc.data)).data).toBeInstanceOf(Uint8ClampedArray);
  });
});
