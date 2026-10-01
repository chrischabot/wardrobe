import jpeg from "jpeg-js";
import { DEFAULT_MAX_PIXELS, ImageDecodeError } from "./errors.ts";
import { applyExifOrientation, type Raster } from "./raster.ts";
import { probeImage } from "./sniff.ts";

/** Decode a JPEG (pure JS). The pixel ceiling is checked from the header before any decoding. */
export function decodeJpeg(bytes: Uint8Array, opts: { maxPixels?: number; applyOrientation?: boolean } = {}): Raster {
  const probe = probeImage(bytes);
  if (!probe || probe.format !== "jpeg" || !probe.width || !probe.height) throw new ImageDecodeError("unrecognized", "not a JPEG");
  const maxPixels = opts.maxPixels ?? DEFAULT_MAX_PIXELS;
  if (probe.width * probe.height > maxPixels) throw new ImageDecodeError("too_large", `JPEG of ${probe.width}x${probe.height} exceeds the pixel limit`);
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
 * The entropy-coded image data is copied untouched.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new ImageDecodeError("unrecognized", "not a JPEG");
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let o = 2;
  while (o + 4 <= bytes.length) {
    if (bytes[o] !== 0xff) throw new ImageDecodeError("corrupt", "invalid JPEG segment marker");
    const marker = bytes[o + 1]!;
    if (marker === 0xff) {
      o++;
      continue;
    }
    if (marker === 0xda) {
      // Start of scan: everything from here to the end is image data.
      parts.push(bytes.subarray(o));
      o = bytes.length;
      break;
    }
    const len = (bytes[o + 2]! << 8) | bytes[o + 3]!;
    if (len < 2 || o + 2 + len > bytes.length) throw new ImageDecodeError("corrupt", "truncated JPEG segment");
    const isApp = marker >= 0xe0 && marker <= 0xef;
    const keep = marker === 0xe0 || marker === 0xe2 || marker === 0xee || (!isApp && marker !== 0xfe);
    if (keep) parts.push(bytes.subarray(o, o + 2 + len));
    o += 2 + len;
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
