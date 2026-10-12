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
 * them is "cannot": the caller then withholds the file instead of passing it on as it is. Before a HEIC or
 * AVIF file goes to a converter, `heifWithoutMetadata` blanks its Exif and XMP items in place.
 */
import { parseExifTiff, probeImage } from "./sniff.ts";

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

/** A TIFF block holding the Orientation field and nothing else (the body of an Exif segment or chunk). */
function orientationTiff(orientation: number): Uint8Array {
  return new Uint8Array([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF, first directory at 8
    0x00, 0x01, // one field
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation & 0xff, 0x00, 0x00, // Orientation, SHORT, count 1
    0x00, 0x00, 0x00, 0x00, // no further directory
  ]);
}

/** An Exif segment holding the Orientation field and nothing else. */
function orientationSegment(orientation: number): Uint8Array {
  // APP1, 34 bytes including this length, then "Exif\0\0" and the TIFF block.
  return join([new Uint8Array([0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00]), orientationTiff(orientation)]);
}

/** The orientation (2 to 8) an Exif payload records, or null; the payload may or may not start with "Exif\0\0". */
function orientationOf(payload: Uint8Array): number | null {
  const tiff = ascii(payload, 0, 6) === "Exif\0\0" ? payload.subarray(6) : payload;
  const o = parseExifTiff(tiff)?.orientation ?? null;
  return o !== null && o >= 2 && o <= 8 ? o : null;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * JFIF (APP0) written again from its density fields only, with no thumbnail and nothing after them; null when
 * the segment is not a JFIF header (an APP0 under any other identifier is left out).
 */
function canonicalJfif(b: Uint8Array, o: number, end: number): Uint8Array | null {
  // FF E0, length, "JFIF\0", version (2), units (1), X density (2), Y density (2), thumbnail size (2)
  if (end - o < 18 || ascii(b, o + 4, 5) !== "JFIF\0") return null;
  const out = new Uint8Array(18);
  out.set([0xff, 0xe0, 0x00, 0x10]);
  out.set(b.subarray(o + 4, o + 16), 4);
  // No embedded thumbnail: it is a second picture, and could show anything.
  out[16] = 0;
  out[17] = 0;
  return out;
}

/** The Adobe colour-transform segment (APP14) written again from its fixed fields only; null for any other APP14. */
function canonicalAdobe(b: Uint8Array, o: number, end: number): Uint8Array | null {
  // FF EE, length 14, "Adobe", version (2), flags0 (2), flags1 (2), transform (1)
  if (end - o < 16 || ascii(b, o + 4, 5) !== "Adobe") return null;
  const out = new Uint8Array(16);
  out.set([0xff, 0xee, 0x00, 0x0e]);
  out.set(b.subarray(o + 4, o + 16), 4);
  return out;
}

/**
 * Non-application segments needed to decode the picture: frame headers (SOF0 to SOF15, which share the range
 * with DHT and DAC), quantization tables (DQT), restart interval (DRI) and number of lines (DNL). Any other
 * marker is left out, including JPG (C8), which is reserved for extensions and could carry anything.
 */
const isImageMarker = (marker: number): boolean => (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc8) || marker === 0xdb || marker === 0xdd || marker === 0xdc;

/**
 * JPEG: keeps the tables, frame and scan segments, a JFIF header (APP0) and the Adobe colour transform
 * (APP14), each rewritten from its fixed fields only, and an ICC profile (APP2 "ICC_PROFILE"). Leaves out
 * every other application segment (Exif and XMP in APP1, multi-picture data in APP2, IPTC in APP13, maker
 * segments, an APP0 or APP14 that is not JFIF or Adobe), comments, any marker that is not needed to decode the
 * picture, and whatever follows the end of the image. The orientation is carried over in an Exif segment of
 * its own.
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
    if (marker === 0xe0) {
      const jfif = canonicalJfif(b, o, end);
      if (jfif) kept.push(jfif);
    } else if (marker === 0xee) {
      const adobe = canonicalAdobe(b, o, end);
      if (adobe) kept.push(adobe);
    } else if (marker === 0xe2) {
      if (ascii(b, o + 4, 12) === "ICC_PROFILE\0") kept.push(b.subarray(o, end));
    } else if (isImageMarker(marker)) {
      kept.push(b.subarray(o, end));
    }
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

/**
 * PNG chunks that are needed to draw the picture in its colours. Text, Exif and time chunks are not among
 * them; which way up the picture is, when an Exif chunk records it, is carried over in an Exif chunk of its
 * own placed before the image data.
 */
const PNG_KEPT = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "cICP", "sBIT", "bKGD", "pHYs", "acTL", "fcTL", "fdAT"]);

function pngWithoutMetadata(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let o = 8;
  let ended = false;
  let orientation: number | null = null;
  let dataAt = -1;
  while (o + 12 <= b.length) {
    const len = u32be(b, o);
    const type = ascii(b, o + 4, 4);
    const end = o + 12 + len;
    if (end > b.length) throw new Error("truncated PNG chunk");
    if (type === "eXIf") orientation = orientationOf(b.subarray(o + 8, o + 8 + len)) ?? orientation;
    if (type === "IDAT" && dataAt < 0) dataAt = parts.length;
    if (PNG_KEPT.has(type)) parts.push(b.subarray(o, end));
    o = end;
    if (type === "IEND") {
      ended = true; // nothing after the end of the image is carried over
      break;
    }
  }
  if (!ended) throw new Error("the PNG has no end chunk");
  if (orientation !== null && dataAt > 0) parts.splice(dataAt, 0, pngChunk("eXIf", orientationTiff(orientation)));
  return join(parts);
}

/** WebP chunks that hold the picture, its transparency, animation and colour profile. "EXIF" and "XMP " are not among them. */
const WEBP_KEPT = new Set(["VP8X", "VP8 ", "VP8L", "ALPH", "ANIM", "ANMF", "ICCP"]);
/** Inside an animation frame only the picture and its transparency are kept; any other chunk there is left out. */
const WEBP_FRAME_KEPT = new Set(["ALPH", "VP8 ", "VP8L"]);

function webpChunk(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length + (payload.length & 1)); // chunks are padded to an even length
  for (let i = 0; i < 4; i++) out[i] = type.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, payload.length, true);
  out.set(payload, 8);
  return out;
}

/** An animation frame written again from its 16-byte frame header and its picture chunks only. */
function webpFrame(payload: Uint8Array): Uint8Array {
  if (payload.length < 16) throw new Error("truncated WebP animation frame");
  const parts: Uint8Array[] = [payload.subarray(0, 16)];
  let o = 16;
  let picture = false;
  while (o + 8 <= payload.length) {
    const type = ascii(payload, o, 4);
    const size = u32le(payload, o + 4);
    if (o + 8 + size > payload.length) throw new Error("truncated WebP frame chunk");
    if (WEBP_FRAME_KEPT.has(type)) {
      parts.push(webpChunk(type, payload.subarray(o + 8, o + 8 + size)));
      if (type !== "ALPH") picture = true;
    }
    o += 8 + size + (size & 1);
  }
  if (!picture) throw new Error("a WebP animation frame holds no image data");
  return webpChunk("ANMF", join(parts));
}

function webpWithoutMetadata(b: Uint8Array): Uint8Array {
  if (ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") throw new Error("not a WebP file");
  const riffEnd = Math.min(b.length, 8 + u32le(b, 4));
  const chunks: Uint8Array[] = [];
  let orientation: number | null = null;
  let o = 12;
  while (o + 8 <= riffEnd) {
    const type = ascii(b, o, 4);
    const size = u32le(b, o + 4);
    if (o + 8 + size > riffEnd) throw new Error("truncated WebP chunk");
    const payload = b.subarray(o + 8, o + 8 + size);
    if (type === "EXIF") orientation = orientationOf(payload) ?? orientation;
    else if (type === "ANMF") chunks.push(webpFrame(payload));
    else if (WEBP_KEPT.has(type)) {
      const chunk = webpChunk(type, payload);
      // The extended header says whether Exif (0x08) and XMP (0x04) chunks follow; they no longer do.
      if (type === "VP8X" && size >= 1) chunk[8] = chunk[8]! & ~0x0c;
      chunks.push(chunk);
    }
    o += 8 + size + (size & 1);
  }
  // Which way up the picture is goes on in an Exif chunk of its own, after the image data; it needs the extended header.
  const extended = chunks[0] !== undefined && ascii(chunks[0], 0, 4) === "VP8X";
  if (orientation !== null && extended) {
    chunks[0]![8] = chunks[0]![8]! | 0x08;
    chunks.push(webpChunk("EXIF", orientationTiff(orientation)));
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

/* ------------------------------ HEIC and AVIF (ISO base media files) ------------------------------ */

interface Box {
  type: string;
  start: number;
  /** First byte after the box header (size, type, and the 64-bit size when present). */
  body: number;
  end: number;
}

function boxesIn(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let o = from;
  while (o + 8 <= to) {
    let size = u32be(b, o);
    const type = ascii(b, o + 4, 4);
    let body = o + 8;
    if (size === 1) {
      if (o + 16 > to) throw new Error("truncated box header");
      size = u32be(b, o + 8) * 0x1_0000_0000 + u32be(b, o + 12);
      body = o + 16;
    } else if (size === 0) size = to - o;
    if (size < body - o || o + size > to) throw new Error(`the ${type} box overruns its container`);
    out.push({ type, start: o, body, end: o + size });
    o += size;
  }
  // Bytes after the last box that are too few to form one could hold anything: such a container is refused.
  if (o !== to) throw new Error("stray bytes follow the last box");
  return out;
}

function uintN(b: Uint8Array, o: number, size: number, end: number): number {
  if (o + size > end) throw new Error("truncated item location");
  if (size === 0) return 0;
  if (size === 4) return u32be(b, o);
  if (size === 8) {
    const v = u32be(b, o) * 0x1_0000_0000 + u32be(b, o + 4);
    if (!Number.isSafeInteger(v)) throw new Error("an item location is too large");
    return v;
  }
  throw new Error(`unsupported item location field size ${size}`);
}

/** A NUL-terminated string starting at `o` whose terminator lies before `end`, or null when there is none. */
function exactCstring(b: Uint8Array, o: number, end: number): { value: string; next: number } | null {
  let p = o;
  while (p < end && b[p] !== 0) p++;
  return p < end ? { value: ascii(b, o, p - o), next: p + 1 } : null;
}

function cstring(b: Uint8Array, o: number, end: number): { value: string; next: number } {
  let p = o;
  while (p < end && b[p] !== 0) p++;
  return { value: ascii(b, o, p - o), next: Math.min(end, p + 1) };
}

/** The UUID under which XMP is written as a top-level box. */
const XMP_UUID = "be7acfcb97a942e89c71999491e3afac";
/** File brands of HEIF and AVIF still images read here; any other brand names a format this cleaner does not know. */
const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "mif2", "msf1", "miaf", "avif", "avis", "avio", "MA1A", "MA1B", "MiHA", "MiHB", "MiHE", "MiPr", "MiAC", "MiCm", "iso8"]);
/** Top-level parts of a HEIF still image accepted for cleaning; any other part (a movie box, a fragment, an unknown uuid) refuses the file. */
const HEIF_TOP_LEVEL = new Set(["ftyp", "meta", "mdat", "free", "skip", "uuid"]);
/**
 * Item properties read here and the exact size each must have; any other property (a user description, an
 * alternative text, an embedded colour profile, a codec configuration not read here, an unknown box) refuses the file.
 * Properties whose size varies are checked in `checkProperty`.
 */
const HEIF_FIXED_PROPERTY_SIZES: Record<string, number> = { ispe: 12, irot: 1, imir: 1, clap: 32, pasp: 8, lsel: 2, a1op: 1, clli: 4, mdcv: 24, rloc: 12, amve: 8 };
/** Auxiliary image types read here (alpha and depth planes); any other names something this cleaner does not know. */
const HEIF_AUX_TYPES = new Set(["urn:mpeg:hevc:2015:auxid:1", "urn:mpeg:hevc:2015:auxid:2", "urn:mpeg:mpegB:cicp:systems:auxiliary:alpha", "urn:mpeg:mpegB:cicp:systems:auxiliary:depth"]);
/** HEVC NAL unit types allowed in a decoder configuration: parameter sets only (VPS, SPS, PPS). */
const HEVC_PARAMETER_SETS = new Set([32, 33, 34]);
/** AV1 OBU types allowed in picture data: sequence header, temporal delimiter, frame header, tile group, frame, redundant frame header. Padding (15) is cleared; metadata (5) and anything else refuses the file. */
const AV1_PICTURE_OBUS = new Set([1, 2, 3, 4, 6, 7]);

const printable = (t: string) => t.replace(/[^\x20-\x7e]/g, "?");

/** One item property: known, exactly the structure its type defines, and nothing descriptive. Collects the HEVC NAL length sizes it declares. */
function checkProperty(b: Uint8Array, prop: Box, hevcLengthSizes: Set<number>): string | null {
  const len = prop.end - prop.body;
  const fixed = HEIF_FIXED_PROPERTY_SIZES[prop.type];
  if (fixed !== undefined) return len === fixed ? null : `the '${printable(prop.type)}' property is not the size its type defines`;
  switch (prop.type) {
    case "free":
    case "skip":
      b.fill(0, prop.body, prop.end);
      return null;
    case "pixi":
      return len >= 5 && len === 5 + b[prop.body + 4]! ? null : "the pixel information property is not the size it declares";
    case "a1lx":
      return len >= 1 && len === 1 + 3 * ((b[prop.body]! & 1) ? 4 : 2) ? null : "the layer size property is not the size it declares";
    case "colr":
      // Only coded colour parameters; an embedded ICC profile carries free text and is not read here.
      return len === 11 && ascii(b, prop.body, 4) === "nclx" ? null : "the file carries a colour profile that is not read here";
    case "auxC": {
      // version and flags, then the type name ending in its terminator, and nothing after it (no subtype data).
      const zero = b.indexOf(0, prop.body + 4);
      if (len < 5 || zero !== prop.end - 1) return "the auxiliary image property holds data that is not read here";
      return HEIF_AUX_TYPES.has(ascii(b, prop.body + 4, zero - prop.body - 4)) ? null : "the file carries an auxiliary image of a kind that is not read here";
    }
    case "hvcC": {
      if (len < 23 || b[prop.body] !== 1) return "the HEVC configuration is not read here";
      const lengthSize = (b[prop.body + 21]! & 3) + 1;
      if (lengthSize === 3) return "the HEVC configuration declares an invalid NAL length size";
      hevcLengthSizes.add(lengthSize);
      let p = prop.body + 22;
      const arrays = b[p++]!;
      for (let a = 0; a < arrays; a++) {
        if (p + 3 > prop.end) return "the HEVC configuration is truncated";
        const type = b[p]! & 0x3f;
        const count = (b[p + 1]! << 8) | b[p + 2]!;
        p += 3;
        if (!HEVC_PARAMETER_SETS.has(type)) return "the HEVC configuration carries units other than parameter sets";
        for (let n = 0; n < count; n++) {
          if (p + 2 > prop.end) return "the HEVC configuration is truncated";
          const size = (b[p]! << 8) | b[p + 1]!;
          p += 2;
          if (size < 2 || p + size > prop.end || ((b[p]! >> 1) & 0x3f) !== type) return "the HEVC configuration holds a unit that is not what it declares";
          p += size;
        }
      }
      return p === prop.end ? null : "the HEVC configuration is followed by bytes that are not read here";
    }
    case "av1C":
      if (len < 4 || b[prop.body] !== 0x81) return "the AV1 configuration is not read here";
      return scanAv1(b, prop.body + 4, prop.end, new Set([1]));
  }
  return `the file carries an item property '${printable(prop.type)}' that is not read here`;
}

/** AV1 units in [from, to): each must be one of `allowed`; padding is cleared; anything else (metadata OBUs) refuses the file. */
function scanAv1(b: Uint8Array, from: number, to: number, allowed: Set<number>): string | null {
  let p = from;
  while (p < to) {
    const h = b[p]!;
    if (h & 0x80) return "the AV1 data is malformed";
    const type = (h >> 3) & 0x0f;
    let q = p + 1 + ((h >> 2) & 1);
    let size: number;
    if ((h >> 1) & 1) {
      size = 0;
      for (let i = 0; ; i++) {
        if (q >= to || i >= 8) return "the AV1 data is malformed";
        const byte = b[q++]!;
        size += (byte & 0x7f) * 2 ** (7 * i);
        if (!(byte & 0x80)) break;
      }
    } else size = to - q;
    if (q > to || q + size > to) return "the AV1 data is truncated";
    if (type === 15) b.fill(0, q, q + size);
    else if (!allowed.has(type)) return `the AV1 data carries a unit of type ${type} (metadata or a kind not read here)`;
    p = q + size;
  }
  return null;
}

/**
 * HEVC NAL units in [from, to), each preceded by its length. Only coded picture slices (types 0-9 and 16-21) and
 * parameter sets are kept as they are; an access-unit delimiter and end markers must be exactly their defined size;
 * filler data is overwritten with standard filler bytes; SEI messages, reserved and unspecified types refuse the file.
 */
function scanHevc(b: Uint8Array, from: number, to: number, lengthSize: number): string | null {
  let p = from;
  while (p < to) {
    if (p + lengthSize > to) return "the HEVC picture data is truncated";
    let size = 0;
    for (let i = 0; i < lengthSize; i++) size = size * 256 + b[p + i]!;
    p += lengthSize;
    if (size < 2 || p + size > to) return "the HEVC picture data does not divide into the units it declares";
    const type = (b[p]! >> 1) & 0x3f;
    if (type === 39 || type === 40) return "the picture data carries SEI messages, which can hold descriptive data and are not removed here";
    const slice = (type >= 0 && type <= 9) || (type >= 16 && type <= 21);
    if (slice || HEVC_PARAMETER_SETS.has(type)) {
      /* picture data and its parameters */
    } else if (type === 35) {
      if (size !== 3) return "an HEVC access-unit delimiter is not the size it must be";
    } else if (type === 36 || type === 37) {
      if (size !== 2) return "an HEVC end marker carries data";
    } else if (type === 38) {
      // Filler data: whatever it held is replaced by the filler pattern (0xFF bytes, then the stop bit).
      if (size > 2) {
        b.fill(0xff, p + 2, p + size - 1);
        b[p + size - 1] = 0x80;
      }
    } else return `the picture data carries a unit of type ${type}, which is not read here`;
    p += size;
  }
  return null;
}

/** Overwrites every byte of [from, to) that no kept range covers with zeros. */
function zeroOutside(b: Uint8Array, from: number, to: number, keep: [number, number][]): void {
  let at = from;
  for (const [s, e] of [...keep].sort((x, y) => x[0] - y[0])) {
    const start = Math.max(s, from);
    const end = Math.min(e, to);
    if (end <= start) continue;
    if (start > at) b.fill(0, at, start);
    at = Math.max(at, end);
  }
  if (at < to) b.fill(0, at, to);
}

/** XMP content types, compared exactly after any parameters are set aside. */
const XMP_CONTENT_TYPES = new Set(["application/rdf+xml", "application/xmp+xml"]);

/**
 * Blanks or checks the descriptive parts of a HEIF metadata box that are not items: padding is zeroed, the
 * handler's name is blanked, the primary item, item references and property associations must be exactly the
 * numbers their structure defines, item properties must be known picture properties of their exact structure,
 * and data references must point at this file. Returns a reason when the box holds something that cannot be made safe.
 */
function scrubMetaChildren(out: Uint8Array, children: Box[], hevcLengthSizes: Set<number>): string | null {
  for (const c of children) {
    if (c.type === "free" || c.type === "skip") out.fill(0, c.body, c.end);
    else if (c.type === "pitm") {
      if (c.end !== c.body + 4 + (out[c.body] === 0 ? 2 : 4) || out[c.body]! > 1) return "the primary item box is not the size it must be";
    } else if (c.type === "iref") {
      const v = out[c.body]!;
      if (v > 1 || c.body + 4 > c.end) return "the item references are in a format that is not read here";
      const idSize = v === 0 ? 2 : 4;
      for (const ref of boxesIn(out, c.body + 4, c.end)) {
        let p = ref.body + idSize;
        if (p + 2 > ref.end) return "an item reference is truncated";
        const count = (out[p]! << 8) | out[p + 1]!;
        p += 2 + count * idSize;
        if (p !== ref.end) return "an item reference is not the size it declares";
      }
    } else if (c.type === "hdlr") {
      // version/flags (4), pre_defined (4), handler type (4), reserved (12), then the name: the reserved
      // field and the whole name, to the end of the box, are cleared (an empty name).
      if (c.body + 24 > c.end) return "the handler box is truncated";
      out.fill(0, c.body + 12, c.end);
    } else if (c.type === "iprp") {
      for (const part of boxesIn(out, c.body, c.end)) {
        if (part.type === "ipma") {
          const v = out[part.body]!;
          const wide = (out[part.body + 3]! & 1) === 1;
          if (v > 1 || part.body + 8 > part.end) return "the item property associations are in a format that is not read here";
          let p = part.body + 4;
          const entries = u32be(out, p);
          p += 4;
          for (let i = 0; i < entries && p <= part.end; i++) {
            p += v < 1 ? 2 : 4;
            if (p + 1 > part.end) return "the item property associations are truncated";
            p += 1 + out[p]! * (wide ? 2 : 1);
          }
          if (p !== part.end) return "the item property associations are not the size they declare";
          continue;
        }
        if (part.type === "free" || part.type === "skip") {
          out.fill(0, part.body, part.end);
          continue;
        }
        if (part.type !== "ipco") return `the item properties hold a '${printable(part.type)}' part that is not read here`;
        for (const prop of boxesIn(out, part.body, part.end)) {
          const unsafe = checkProperty(out, prop, hevcLengthSizes);
          if (unsafe) return unsafe;
        }
      }
    } else if (c.type === "dinf") {
      for (const dref of boxesIn(out, c.body, c.end)) {
        if (dref.type !== "dref") return "the data information holds a part that is not read here";
        if (dref.body + 8 > dref.end) return "the data reference box is truncated";
        const entries = boxesIn(out, dref.body + 8, dref.end);
        if (u32be(out, dref.body + 4) !== entries.length) return "the data reference box does not hold the entries it declares";
        for (const entry of entries) {
          // Only a self-contained reference (flag 1: the data is in this file) carries no location string.
          if (entry.type !== "url " || entry.body + 4 > entry.end || (out[entry.body + 3]! & 1) !== 1) return "the file refers to data outside itself";
          // A self-contained entry needs nothing after its version and flags: anything there is cleared.
          out.fill(0, entry.body + 4, entry.end);
        }
      }
    }
  }
  return null;
}
/** Parts of the metadata box read or known to carry no metadata; another (an "xml " or "bxml" box, or an entity-group list "grpl", whose groups are not read here) refuses the file. */
const HEIF_META_CHILDREN = new Set(["hdlr", "pitm", "iloc", "iinf", "iprp", "iref", "idat", "dinf", "free", "skip"]);
/** Picture item types whose data is read here: HEVC and AV1 coded images (scanned unit by unit) and the derived grid, overlay and identity images (numbers only). */
const HEIF_PICTURE_ITEMS = new Set(["hvc1", "hev1", "hvt1", "av01", "grid", "iovl", "iden"]);

export type HeifClean = { ok: true; bytes: Uint8Array; removedItems: number } | { ok: false; reason: string };

/**
 * A HEIC or AVIF file with its Exif and XMP metadata items blanked in place, for a converter to read.
 * The file cannot be rewritten here, but its metadata items can be found (item information and item
 * location boxes) and their bytes overwritten with zeros; their item type is renamed so that a reader
 * skips them. Nothing moves, so every offset in the file stays valid and the picture data is untouched.
 * A file whose metadata cannot be located with certainty is refused (`ok: false`) rather than passed on.
 * A file with no metadata box is refused too: without item locations its pictures cannot be told apart from
 * other bytes, so nothing in it could be kept or cleared with certainty.
 */
export function heifWithoutMetadata(bytes: Uint8Array): HeifClean {
  try {
    const out = bytes.slice();
    const top = boxesIn(out, 0, out.length);
    let removedItems = 0;
    for (const box of top) {
      // Only the parts of a still image are accepted; anything else (a movie box, an unknown uuid) may carry metadata this cleaner does not read.
      if (!HEIF_TOP_LEVEL.has(box.type)) return { ok: false, reason: `the file holds a '${box.type.replace(/[^\x20-\x7e]/g, "?")}' part that is not read here` };
      if (box.type === "free" || box.type === "skip") out.fill(0, box.body, box.end); // padding may hold an older copy of anything
      if (box.type === "ftyp") {
        // Major brand, a minor version of zero, then compatible brands: every four bytes must be a brand read here.
        const len = box.end - box.body;
        if (len < 8 || (len - 8) % 4 !== 0 || u32be(out, box.body + 4) !== 0) return { ok: false, reason: "the file type box is not in a form read here" };
        for (let o = box.body; o < box.end; o += o === box.body ? 8 : 4) {
          if (!HEIF_BRANDS.has(ascii(out, o, 4))) return { ok: false, reason: "the file names a brand that is not read here" };
        }
      }
      if (box.type === "uuid") {
        if (box.end - box.body < 16) return { ok: false, reason: "the file holds a malformed uuid part" };
        const id = Array.from(out.subarray(box.body, box.body + 16), (x) => x.toString(16).padStart(2, "0")).join("");
        if (id !== XMP_UUID) return { ok: false, reason: "the file holds a uuid part that is not read here" };
        out.fill(0, box.body + 16, box.end);
        removedItems++;
      }
    }
    const metas = top.filter((x) => x.type === "meta");
    if (metas.length > 1) return { ok: false, reason: "the file has more than one metadata box" };
    const meta = metas[0];
    /** Picture data kept: absolute byte ranges inside the file's image data (mdat) and its item data (idat). */
    const keepFile: [number, number][] = [];
    const keepIdat: [number, number][] = [];
    let idatBox: Box | undefined;
    /** Every byte of the image data and item data that no picture item uses is cleared: it may hold an older copy of the metadata. */
    const finish = (): HeifClean => {
      for (const box of top) if (box.type === "mdat") zeroOutside(out, box.body, box.end, keepFile);
      if (idatBox) zeroOutside(out, idatBox.body, idatBox.end, keepIdat);
      return { ok: true, bytes: out, removedItems };
    };
    if (!meta) return { ok: false, reason: "the file has no metadata box, so its pictures cannot be located" };
    const children = boxesIn(out, meta.body + 4, meta.end); // meta is a full box: version and flags first
    for (const c of children) {
      if (!HEIF_META_CHILDREN.has(c.type)) return { ok: false, reason: `the file's metadata box holds a '${c.type.replace(/[^\x20-\x7e]/g, "?")}' part that is not read here` };
    }
    for (const t of ["iinf", "iloc", "idat"]) {
      if (children.filter((x) => x.type === t).length > 1) return { ok: false, reason: `the file has more than one '${t}' box` };
    }
    const hevcLengthSizes = new Set<number>();
    const unsafe = scrubMetaChildren(out, children, hevcLengthSizes);
    if (unsafe) return { ok: false, reason: unsafe };
    const iinf = children.find((x) => x.type === "iinf");
    const iloc = children.find((x) => x.type === "iloc");
    const idat = children.find((x) => x.type === "idat");
    idatBox = idat;

    // Which items are metadata: an "Exif" item, or a "mime" item whose content type is exactly XMP. Any other item
    // must be a picture item type read here; an unknown one (a "uri " item, other MIME content) is refused. Every
    // entry's descriptive strings after its type (name, content type, encoding) are cleared.
    const marked = new Map<number, number>(); // item ID -> offset of its item type
    const pictures = new Map<number, string>(); // item ID -> item type
    /** Every byte range of each picture item, to be checked for what its data carries. */
    const pictureRanges: { type: string; from: number; to: number }[] = [];
    if (iinf) {
      const infVersion = out[iinf.body]!;
      if (infVersion > 1) return { ok: false, reason: "the file uses an item information format that is not read here" };
      const declared = infVersion === 0 ? (out[iinf.body + 4]! << 8) | out[iinf.body + 5]! : u32be(out, iinf.body + 4);
      const entriesAt = iinf.body + 4 + (infVersion === 0 ? 2 : 4);
      const entries = boxesIn(out, entriesAt, iinf.end);
      if (entries.length !== declared) return { ok: false, reason: "the item information does not hold the entries it declares" };
      for (const infe of entries) {
        if (infe.type !== "infe") return { ok: false, reason: "the item information holds an entry that is not read here" };
        const version = out[infe.body]!;
        if (version !== 2 && version !== 3) return { ok: false, reason: "the file uses an item information format that is not read here" };
        let p = infe.body + 4;
        const itemId = version === 2 ? (out[p]! << 8) | out[p + 1]! : u32be(out, p);
        p += version === 2 ? 2 : 4;
        // A protected (encrypted) item cannot be inspected.
        if ((out[p]! << 8 | out[p + 1]!) !== 0) return { ok: false, reason: "the file carries a protected item, which is not read here" };
        p += 2; // protection index
        if (p + 4 > infe.end) throw new Error("truncated item information");
        const itemType = ascii(out, p, 4);
        const typeAt = p;
        if (marked.has(itemId) || pictures.has(itemId)) return { ok: false, reason: "an item is described twice" };
        if (itemType === "Exif") marked.set(itemId, typeAt);
        else if (itemType === "jpeg") {
          // A JPEG picture item is a complete JPEG stream, which can carry its own Exif (with a position) or XMP
          // segments. Those are not rewritten inside the HEIF here, so the file is refused rather than kept as it is.
          return { ok: false, reason: "the file carries a JPEG picture item, whose own metadata is not removed here" };
        } else if (itemType === "mime") {
          // Exactly: item name, content type and an optional content encoding, each terminated, and nothing after.
          const name = exactCstring(out, p + 4, infe.end);
          const type = name ? exactCstring(out, name.next, infe.end) : null;
          const encoding = type && type.next < infe.end ? exactCstring(out, type.next, infe.end) : null;
          const end = encoding ? encoding.next : type?.next;
          if (!type || end !== infe.end || (encoding && encoding.value !== "")) return { ok: false, reason: "a MIME item's description is not the structure read here" };
          if (!XMP_CONTENT_TYPES.has(type.value.split(";")[0]!.trim().toLowerCase())) return { ok: false, reason: "the file carries a MIME item that is not read here" };
          marked.set(itemId, typeAt);
        } else if (HEIF_PICTURE_ITEMS.has(itemType)) pictures.set(itemId, itemType);
        else return { ok: false, reason: `the file carries an item of type '${itemType.replace(/[^\x20-\x7e]/g, "?")}' that is not read here` };
        // A picture or Exif item's description is exactly its terminated item name; nothing may follow it.
        if (itemType !== "mime" && exactCstring(out, p + 4, infe.end)?.next !== infe.end) return { ok: false, reason: "an item's description is not the structure read here" };
        out.fill(0, p + 4, infe.end);
      }
    }
    if (marked.size > 0 && !iloc) return { ok: false, reason: "the file has metadata items but no item locations" };
    // Without item information and item locations no picture can be told apart from other bytes, so nothing could
    // be kept or cleared with certainty.
    if (!iinf || !iloc) return { ok: false, reason: "the file has no item information or no item locations, so its pictures cannot be located" };
    // A data reference index names an entry of the file's own data reference box (each one checked above to be
    // self-contained); 0 means this file. An index past the entries refers to data the file does not have.
    const dref = children.filter((x) => x.type === "dinf").flatMap((d) => boxesIn(out, d.body, d.end)).find((x) => x.type === "dref");
    const drefEntries = dref ? u32be(out, dref.body + 4) : 0;
    /** Picture items with at least one located extent. */
    const picturesLocated = new Set<number>();

    // Where each item's bytes are. Every extent is collected and checked before anything is changed: a
    // file-offset extent must lie inside an image-data (mdat) payload, an item-data extent inside the item data,
    // and no metadata extent may overlap a picture's. Then metadata extents are cleared, picture extents are
    // kept, and the rest is cleared by finish().
    const located = new Set<number>();
    const metaRanges: [number, number][] = [];
    const payloads = top.filter((x) => x.type === "mdat").map((x): [number, number] => [x.body, x.end]);
    const inside = (from: number, to: number, areas: [number, number][]) => areas.some(([s, e]) => from >= s && to <= e);
    if (iloc) {
      const v = out[iloc.body]!;
      if (v > 2) return { ok: false, reason: "the file uses an item location format that is not read here" };
      let p = iloc.body + 4;
      const offsetSize = out[p]! >> 4;
      const lengthSize = out[p]! & 0x0f;
      const baseOffsetSize = out[p + 1]! >> 4;
      const indexSize = v >= 1 ? out[p + 1]! & 0x0f : 0;
      p += 2;
      const itemCount = v < 2 ? (out[p]! << 8) | out[p + 1]! : u32be(out, p);
      p += v < 2 ? 2 : 4;
      for (let i = 0; i < itemCount; i++) {
        const itemId = v < 2 ? (out[p]! << 8) | out[p + 1]! : u32be(out, p);
        p += v < 2 ? 2 : 4;
        let method = 0;
        if (v >= 1) {
          method = out[p + 1]! & 0x0f;
          p += 2;
          // 0: file offset, 1: item data, 2: another item. Any other method places bytes where this cleaner cannot tell.
          if (method > 2) return { ok: false, reason: "an item is stored in a way that is not read here" };
        }
        const dataRef = (out[p]! << 8) | out[p + 1]!;
        p += 2; // data reference index
        if (dataRef > drefEntries) return { ok: false, reason: "an item refers to a data reference the file does not have" };
        const base = uintN(out, p, baseOffsetSize, iloc.end);
        p += baseOffsetSize;
        if (p + 2 > iloc.end) throw new Error("truncated item location");
        const extents = (out[p]! << 8) | out[p + 1]!;
        p += 2;
        const isMeta = marked.has(itemId);
        if (isMeta && located.has(itemId)) return { ok: false, reason: "a metadata item is located twice" };
        if (isMeta && extents === 0) return { ok: false, reason: "a metadata item has no stated location" };
        for (let e = 0; e < extents; e++) {
          p += indexSize;
          const offset = uintN(out, p, offsetSize, iloc.end);
          p += offsetSize;
          const length = uintN(out, p, lengthSize, iloc.end);
          p += lengthSize;
          if (!isMeta && !pictures.has(itemId)) continue; // bytes of an item nobody describes are not kept
          if (method === 2) {
            if (isMeta) return { ok: false, reason: "a metadata item is stored by reference to another item" };
            // A picture assembled from another item's bytes would have to be rebuilt to be read; it is not read here.
            return { ok: false, reason: "a picture item is built from another item's data, which is not read here" };
          }
          if (length === 0) return { ok: false, reason: isMeta ? "a metadata item's length is not stated" : "a picture item's length is not stated" };
          const origin = method === 1 ? (idat ? idat.body : -1) : 0;
          if (origin < 0) return { ok: false, reason: "an item refers to item data the file does not have" };
          const from = origin + base + offset;
          const areas: [number, number][] = method === 1 ? [[idat!.body, idat!.end]] : payloads;
          if (from < 0 || !inside(from, from + length, areas)) return { ok: false, reason: isMeta ? "a metadata item lies outside the file's data" : "a picture item lies outside the file's data" };
          (isMeta ? metaRanges : method === 1 ? keepIdat : keepFile).push([from, from + length]);
          if (!isMeta) {
            pictureRanges.push({ type: pictures.get(itemId)!, from, to: from + length });
            picturesLocated.add(itemId);
          }
        }
        if (isMeta) located.add(itemId);
      }
      // The location box must be exactly what it declares: bytes after the last item could hold anything.
      if (p !== iloc.end) return { ok: false, reason: "the item locations are followed by bytes that are not read here" };
    }
    // Every picture item that carries data must have been located: one without a location cannot be kept, and its
    // bytes would be cleared as unused. An identity item carries no data of its own.
    for (const [itemId, type] of pictures) {
      if (type !== "iden" && !picturesLocated.has(itemId)) return { ok: false, reason: "a picture item has no location in the file, so it cannot be kept" };
    }
    const overlaps = ([a, b]: [number, number], [c, d]: [number, number]) => a < d && c < b;
    if (metaRanges.some((m) => [...keepFile, ...keepIdat].some((k) => overlaps(m, k)))) return { ok: false, reason: "a metadata item shares bytes with a picture, so it cannot be removed without damaging the picture" };
    // What each picture's own data carries. Coded pictures are read unit by unit (an HEVC SEI message or an AV1
    // metadata unit can hold descriptive data and is not removed here, so it refuses the file); derived pictures
    // must be exactly the numbers their structure defines.
    if ([...pictures.values()].some((t) => t === "hvc1" || t === "hev1" || t === "hvt1") && hevcLengthSizes.size !== 1) return { ok: false, reason: "the HEVC pictures have no single coding configuration, so their data cannot be read" };
    const hevcLength = [...hevcLengthSizes][0] ?? 4;
    for (const r of pictureRanges) {
      const len = r.to - r.from;
      let why: string | null = null;
      if (r.type === "av01") why = scanAv1(out, r.from, r.to, AV1_PICTURE_OBUS);
      else if (r.type === "grid") why = len >= 4 && len === 4 + 2 * ((out[r.from + 1]! & 1) ? 4 : 2) ? null : "a grid picture is not the size its structure defines";
      else if (r.type === "iovl") {
        const field = (out[r.from + 1]! & 1) ? 4 : 2;
        const head = 2 + 8 + 2 * field;
        why = len >= head && (len - head) % (2 * field) === 0 ? null : "an overlay picture is not the size its structure defines";
      } else if (r.type === "iden") why = "an identity picture carries data of its own";
      else why = scanHevc(out, r.from, r.to, hevcLength);
      if (why) return { ok: false, reason: why };
    }
    for (const [from, to] of metaRanges) out.fill(0, from, to);
    for (const [itemId, typeAt] of marked) {
      // Every metadata item's bytes must have been found and blanked; renaming an item does not remove its data.
      if (!located.has(itemId)) return { ok: false, reason: "a metadata item has no location in the file, so its data could not be removed" };
      // A reader skips an item of a type it does not know; "hide" is not a defined item type.
      out.set([0x68, 0x69, 0x64, 0x65], typeAt);
      removedItems++;
    }
    return finish();
  } catch (e) {
    return { ok: false, reason: `the file's metadata could not be located (${String((e as Error).message ?? e).slice(0, 120)})` };
  }
}

/**
 * The bytes to hand a converter: a JPEG, PNG or WebP without its metadata, a HEIC or AVIF with its
 * metadata items blanked, or the reason neither can be done (the caller then does not convert it). A file
 * larger than `maxBytes` (the upload limit) is never cleaned or handed on.
 */
export function withoutLocationForConversion(bytes: Uint8Array, maxBytes: number): { ok: true; bytes: Uint8Array } | { ok: false; reason: string } {
  if (!(bytes.byteLength <= maxBytes)) return { ok: false, reason: `the file is larger than the ${maxBytes}-byte limit for images that are cleaned and converted` };
  const probe = probeImage(bytes);
  if (probe && (probe.format === "heic" || probe.format === "avif")) {
    const clean = heifWithoutMetadata(bytes);
    return clean.ok ? { ok: true, bytes: clean.bytes } : clean;
  }
  const clean = withoutLocation(bytes);
  return clean.ok ? { ok: true, bytes: clean.bytes } : { ok: false, reason: clean.reason };
}
