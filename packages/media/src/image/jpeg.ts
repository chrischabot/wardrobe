import jpeg from "jpeg-js";
import { DEFAULT_MAX_PIXELS, ImageDecodeError } from "./errors.ts";
import { applyExifOrientation, type Raster } from "./raster.ts";
import { probeImage } from "./sniff.ts";

/**
 * How many bytes of entropy-coded image data a JPEG carries across all its scans (0 when it has no scan,
 * or its scans are empty: headers up to SOS followed directly by the end marker). A header alone is not a
 * picture; a decoder may still "decode" it into a blank image, so this is checked on its own.
 */
export function jpegScanDataBytes(b: Uint8Array): number {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return 0;
  let total = 0;
  let o = 2;
  while (o + 1 < b.length) {
    if (b[o] !== 0xff) return total;
    const marker = b[o + 1]!;
    if (marker === 0xff) {
      o++;
      continue;
    }
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      o += 2;
      continue;
    }
    if (o + 4 > b.length) break;
    const len = (b[o + 2]! << 8) | b[o + 3]!;
    // A segment length counts its own two bytes; anything shorter is malformed, and nothing in it is picture data.
    if (len < 2) return 0;
    const end = o + 2 + len;
    if (end > b.length) break;
    if (marker === 0xda) {
      // The scan header: Ls, Ns (1 to 4 components), two bytes per component, then Ss, Se and Ah/Al.
      const components = len >= 3 ? b[o + 4]! : 0;
      if (components < 1 || components > 4 || len !== 6 + 2 * components) return 0;
      let p = end;
      while (p < b.length) {
        if (b[p] !== 0xff) {
          p++;
          total++;
          continue;
        }
        const next = p + 1 < b.length ? b[p + 1]! : -1;
        if (next === 0x00) {
          p += 2;
          total++; // a stuffed 0xFF data byte
        } else if (next >= 0xd0 && next <= 0xd7) p += 2;
        else if (next === 0xff) p++;
        else break;
      }
      o = p;
      continue;
    }
    o = end;
  }
  return total;
}

/** Decode a JPEG (pure JS). The pixel ceiling is checked from the header before any decoding. */
export function decodeJpeg(bytes: Uint8Array, opts: { maxPixels?: number; applyOrientation?: boolean } = {}): Raster {
  const probe = probeImage(bytes);
  if (!probe || probe.format !== "jpeg" || !probe.width || !probe.height) throw new ImageDecodeError("unrecognized", "not a JPEG");
  const maxPixels = opts.maxPixels ?? DEFAULT_MAX_PIXELS;
  if (probe.width * probe.height > maxPixels) throw new ImageDecodeError("too_large", `JPEG of ${probe.width}x${probe.height} exceeds the pixel limit`);
  if (jpegScanDataBytes(bytes) === 0) throw new ImageDecodeError("corrupt", "the JPEG holds no image data");
  let decoded: { width: number; height: number; data: Uint8Array };
  try {
    decoded = jpeg.decode(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      tolerantDecoding: false,
      maxResolutionInMP: Math.ceil(maxPixels / 1_000_000) + 1,
      maxMemoryUsageInMB: Math.ceil((maxPixels * 12) / (1024 * 1024)) + 64,
    });
  } catch (e) {
    throw new ImageDecodeError("corrupt", `JPEG could not be decoded: ${String((e as Error).message ?? e).slice(0, 200)}`);
  }
  const raster: Raster = { width: decoded.width, height: decoded.height, data: new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength) };
  const orientation = probe.exif.orientation;
  return opts.applyOrientation !== false && orientation ? applyExifOrientation(raster, orientation) : raster;
}

/** Encode an opaque JPEG. Alpha is flattened onto white first; no metadata is written. */
export function encodeJpeg(raster: Raster, quality = 90): Uint8Array {
  const flat = new Uint8Array(raster.data.length);
  for (let i = 0; i < flat.length; i += 4) {
    const a = raster.data[i + 3]! / 255;
    flat[i] = Math.round(raster.data[i]! * a + 255 * (1 - a));
    flat[i + 1] = Math.round(raster.data[i + 1]! * a + 255 * (1 - a));
    flat[i + 2] = Math.round(raster.data[i + 2]! * a + 255 * (1 - a));
    flat[i + 3] = 255;
  }
  const out = jpeg.encode({ data: flat, width: raster.width, height: raster.height }, quality);
  return new Uint8Array(out.data.buffer, out.data.byteOffset, out.data.byteLength);
}

/**
 * Lossless metadata removal: rewrites the segment list without APP1 (Exif/XMP), APP13 (IPTC), COM and the
 * other application segments, keeping APP0 (JFIF), APP2 (ICC profile) and APP14 (Adobe colour transform).
 * Every scan's entropy-coded data is copied untouched; segments between scans (a progressive or multi-scan
 * file) are filtered the same way, and nothing after the end-of-image marker is kept.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new ImageDecodeError("unrecognized", "not a JPEG");
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let o = 2;
  let sawScan = false;
  while (o + 1 < bytes.length) {
    if (bytes[o] !== 0xff) throw new ImageDecodeError("corrupt", "invalid JPEG segment marker");
    const marker = bytes[o + 1]!;
    if (marker === 0xff) {
      o++;
      continue;
    }
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(bytes.subarray(o, o + 2));
      o += 2;
      continue;
    }
    if (o + 4 > bytes.length) throw new ImageDecodeError("corrupt", "truncated JPEG segment");
    const len = (bytes[o + 2]! << 8) | bytes[o + 3]!;
    if (len < 2 || o + 2 + len > bytes.length) throw new ImageDecodeError("corrupt", "truncated JPEG segment");
    if (marker === 0xda) {
      // A scan: its header, then entropy-coded data up to the next marker that is not a stuffed byte or a restart.
      let p = o + 2 + len;
      while (p < bytes.length) {
        if (bytes[p] !== 0xff) {
          p++;
          continue;
        }
        if (p + 1 >= bytes.length) {
          p = bytes.length;
          break;
        }
        const next = bytes[p + 1]!;
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) p += 2;
        else if (next === 0xff) p++;
        else break;
      }
      parts.push(bytes.subarray(o, p));
      o = p;
      sawScan = true;
      continue;
    }
    const isApp = marker >= 0xe0 && marker <= 0xef;
    const keep = marker === 0xe0 || marker === 0xe2 || marker === 0xee || (!isApp && marker !== 0xfe);
    if (keep) parts.push(bytes.subarray(o, o + 2 + len));
    o += 2 + len;
  }
  if (!sawScan) throw new ImageDecodeError("corrupt", "the JPEG holds no image data");
  parts.push(new Uint8Array([0xff, 0xd9]));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
