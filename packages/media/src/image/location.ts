/**
 * A photograph without its location data.
 *
 * A camera file can say where it was taken in several places: the GPS block of its Exif data, an XMP
 * packet, IPTC fields, maker notes, a comment, a second picture or a clip appended after the image. Rather
 * than hunt for each, the file is written again with only what is needed to show the picture: the
 * compressed image data exactly as it is (nothing is decoded, so nothing is lost), its colour profile, and
 * for a JPEG the one Exif field that says which way up it is. Everything else is left out.
 *
 * JPEG, PNG and WebP can be rewritten this way. HEIC and AVIF cannot be rewritten here, so the answer for
 * them is "cannot": the caller then withholds the file instead of passing it on as it is.
 */
import { probeImage } from "./sniff.ts";

export type LocationFree =
  /** `bytes` shows the same picture and carries no metadata; `changed` says whether anything had to be left out. */
  | { ok: true; bytes: Uint8Array; contentType: string; changed: boolean }
  | { ok: false; reason: string };

function ascii(b: Uint8Array, offset: number, length: number): string {
  let s = "";
  for (let i = offset; i < offset + length && i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}

const u32be = (b: Uint8Array, o: number): number => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const u32le = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** An Exif segment holding the Orientation field and nothing else. */
function orientationSegment(orientation: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xe1, 0x00, 0x22, // APP1, 34 bytes including this length
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF, first directory at 8
    0x00, 0x01, // one field
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation & 0xff, 0x00, 0x00, // Orientation, SHORT, count 1
    0x00, 0x00, 0x00, 0x00, // no further directory
  ]);
}

/**
 * JPEG: keeps the tables, frame and scan segments, JFIF (APP0), an ICC profile (APP2 "ICC_PROFILE") and the
 * Adobe colour transform (APP14). Leaves out every other application segment (Exif and XMP in APP1,
 * multi-picture data in APP2, IPTC in APP13, maker segments), comments, and whatever follows the end of the
 * image. The orientation is carried over in an Exif segment of its own.
 */
function jpegWithoutMetadata(b: Uint8Array, orientation: number | null): Uint8Array {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw new Error("not a JPEG");
  const kept: Uint8Array[] = [];
  let o = 2;
  let sawScan = false;
  while (o + 1 < b.length) {
    if (b[o] !== 0xff) throw new Error("invalid JPEG segment marker");
    const marker = b[o + 1]!;
    if (marker === 0xff) {
      o++; // fill byte
      continue;
    }
    if (marker === 0xd9) break; // end of image: nothing after it is carried over
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      kept.push(b.subarray(o, o + 2));
      o += 2;
      continue;
    }
    if (o + 4 > b.length) throw new Error("truncated JPEG segment");
    const len = (b[o + 2]! << 8) | b[o + 3]!;
    const end = o + 2 + len;
    if (len < 2 || end > b.length) throw new Error("truncated JPEG segment");
    if (marker === 0xda) {
      // A scan: its header, then entropy-coded data up to the next marker that is not a restart marker.
      let p = end;
      while (p < b.length) {
        if (b[p] !== 0xff) {
          p++;
          continue;
        }
        if (p + 1 >= b.length) {
          p = b.length;
          break;
        }
        const next = b[p + 1]!;
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) p += 2;
        else if (next === 0xff) p++;
        else break;
      }
      kept.push(b.subarray(o, p));
      o = p;
      sawScan = true;
      continue;
    }
    const application = marker >= 0xe0 && marker <= 0xef;
    const keep = application ? marker === 0xe0 || marker === 0xee || (marker === 0xe2 && ascii(b, o + 4, 12) === "ICC_PROFILE\0") : marker !== 0xfe;
    if (keep) kept.push(b.subarray(o, end));
    o = end;
  }
  if (!sawScan) throw new Error("the JPEG holds no image data");
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  // JFIF, when present, stays first; the orientation follows it.
  const first = kept[0];
  const jfifFirst = first !== undefined && first.length >= 4 && first[0] === 0xff && first[1] === 0xe0;
  if (jfifFirst) parts.push(kept.shift()!);
  if (orientation !== null && orientation >= 2 && orientation <= 8) parts.push(orientationSegment(orientation));
  parts.push(...kept, new Uint8Array([0xff, 0xd9]));
  return join(parts);
}

/** PNG chunks that are needed to draw the picture in its colours. Text, Exif and time chunks are not among them. */
const PNG_KEPT = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "cICP", "sBIT", "bKGD", "pHYs", "acTL", "fcTL", "fdAT"]);

function pngWithoutMetadata(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let o = 8;
  let ended = false;
  while (o + 12 <= b.length) {
    const len = u32be(b, o);
    const type = ascii(b, o + 4, 4);
    const end = o + 12 + len;
    if (end > b.length) throw new Error("truncated PNG chunk");
    if (PNG_KEPT.has(type)) parts.push(b.subarray(o, end));
    o = end;
    if (type === "IEND") {
      ended = true; // nothing after the end of the image is carried over
      break;
    }
  }
  if (!ended) throw new Error("the PNG has no end chunk");
  return join(parts);
}

/** WebP chunks that hold the picture, its transparency, animation and colour profile. "EXIF" and "XMP " are not among them. */
const WEBP_KEPT = new Set(["VP8X", "VP8 ", "VP8L", "ALPH", "ANIM", "ANMF", "ICCP"]);

function webpWithoutMetadata(b: Uint8Array): Uint8Array {
  if (ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") throw new Error("not a WebP file");
  const riffEnd = Math.min(b.length, 8 + u32le(b, 4));
  const chunks: Uint8Array[] = [];
  let o = 12;
  while (o + 8 <= riffEnd) {
    const type = ascii(b, o, 4);
    const size = u32le(b, o + 4);
    if (o + 8 + size > riffEnd) throw new Error("truncated WebP chunk");
    if (WEBP_KEPT.has(type)) {
      const chunk = new Uint8Array(8 + size + (size & 1)); // chunks are padded to an even length
      chunk.set(b.subarray(o, o + 8 + size));
      // The extended header says whether Exif (0x08) and XMP (0x04) chunks follow; they no longer do.
      if (type === "VP8X" && size >= 1) chunk[8] = chunk[8]! & ~0x0c;
      chunks.push(chunk);
    }
    o += 8 + size + (size & 1);
  }
  if (!chunks.some((c) => ascii(c, 0, 4) === "VP8 " || ascii(c, 0, 4) === "VP8L" || ascii(c, 0, 4) === "ANMF")) throw new Error("the WebP file holds no image data");
  const body = join(chunks);
  const header = new Uint8Array(12);
  header.set(b.subarray(0, 12));
  const riffSize = 4 + body.length;
  header[4] = riffSize & 0xff;
  header[5] = (riffSize >>> 8) & 0xff;
  header[6] = (riffSize >>> 16) & 0xff;
  header[7] = (riffSize >>> 24) & 0xff;
  return join([header, body]);
}

/**
 * The same picture with no location data and no other metadata, or the reason there is none. Lossless:
 * the compressed image data is copied, never decoded. A file that already carries nothing extra comes
 * back byte for byte (`changed: false`).
 */
export function withoutLocation(bytes: Uint8Array): LocationFree {
  const probe = probeImage(bytes);
  if (!probe) return { ok: false, reason: "the file is not a recognised image" };
  try {
    let out: Uint8Array;
    if (probe.format === "jpeg") out = jpegWithoutMetadata(bytes, probe.exif.orientation);
    else if (probe.format === "png") out = pngWithoutMetadata(bytes);
    else if (probe.format === "webp") out = webpWithoutMetadata(bytes);
    else return { ok: false, reason: `location data cannot be removed from ${probe.contentType} here` };
    // The rewritten file must still be the same kind of picture of the same size.
    const check = probeImage(out);
    if (!check || check.format !== probe.format || check.width !== probe.width || check.height !== probe.height) return { ok: false, reason: "the file could not be rewritten without its metadata" };
    return { ok: true, bytes: out, contentType: probe.contentType, changed: !same(out, bytes) };
  } catch (e) {
    return { ok: false, reason: `the file could not be rewritten without its metadata (${String((e as Error).message ?? e).slice(0, 120)})` };
  }
}
