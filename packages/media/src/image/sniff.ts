/** Header-only image probing: format by magic bytes, dimensions, animation and EXIF facts. Never decodes pixels. */

export type ImageFormat = "png" | "jpeg" | "webp" | "heic" | "avif" | "gif";

export interface ImageProbe {
  format: ImageFormat;
  contentType: string;
  width: number | null;
  height: number | null;
  hasAlpha: boolean | null;
  animated: boolean;
  exif: { present: boolean; orientation: number | null; hasGps: boolean };
}

const NO_EXIF = { present: false, orientation: null, hasGps: false } as const;

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let s = "";
  for (let i = offset; i < offset + length && i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

function u32be(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}

function u16be(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!;
}

/** Parse a TIFF block (the body of an Exif APP1 segment after "Exif\0\0") for Orientation and a GPS IFD pointer. */
export function parseExifTiff(tiff: Uint8Array): { orientation: number | null; hasGps: boolean } | null {
  if (tiff.length < 8) return null;
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  const be = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!le && !be) return null;
  const u16 = (o: number) => (le ? tiff[o]! | (tiff[o + 1]! << 8) : (tiff[o]! << 8) | tiff[o + 1]!);
  const u32 = (o: number) => (le ? (tiff[o]! | (tiff[o + 1]! << 8) | (tiff[o + 2]! << 16) | (tiff[o + 3]! << 24)) >>> 0 : u32be(tiff, o));
  if (u16(2) !== 42) return null;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return null;
  const count = u16(ifd);
  let orientation: number | null = null;
  let hasGps = false;
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) break;
    const tag = u16(entry);
    if (tag === 0x0112) {
      const value = u16(entry + 8);
      if (value >= 1 && value <= 8) orientation = value;
    } else if (tag === 0x8825) {
      hasGps = u32(entry + 8) !== 0;
    }
  }
  return { orientation, hasGps };
}

function probePng(b: Uint8Array): ImageProbe | null {
  if (b.length < 33 || ascii(b, 12, 4) !== "IHDR") return null;
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  const colourType = b[25]!;
  if (width === 0 || height === 0) return null;
  let animated = false;
  let hasAlpha = colourType === 4 || colourType === 6;
  // Bounded scan of chunk headers before the first IDAT for acTL (APNG) and tRNS.
  let o = 33;
  for (let guard = 0; guard < 64 && o + 8 <= b.length; guard++) {
    const len = u32be(b, o);
    const type = ascii(b, o + 4, 4);
    if (type === "IDAT" || type === "IEND") break;
    if (type === "acTL") animated = true;
    if (type === "tRNS") hasAlpha = true;
    o += 12 + len;
  }
  return { format: "png", contentType: "image/png", width, height, hasAlpha, animated, exif: { ...NO_EXIF } };
}

function probeJpeg(b: Uint8Array): ImageProbe | null {
  let o = 2;
  let width: number | null = null;
  let height: number | null = null;
  let exif: ImageProbe["exif"] = { ...NO_EXIF };
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return null;
    let marker = b[o + 1]!;
    while (marker === 0xff && o + 2 < b.length) {
      o++;
      marker = b[o + 1]!;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      o += 2;
      continue;
    }
    if (marker === 0xd9) break;
    const len = u16be(b, o + 2);
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (o + 9 > b.length) return null;
      height = u16be(b, o + 5);
      width = u16be(b, o + 7);
      break;
    }
    if (marker === 0xe1 && ascii(b, o + 4, 6) === "Exif\0\0") {
      const parsed = parseExifTiff(b.subarray(o + 10, Math.min(b.length, o + 2 + len)));
      exif = { present: true, orientation: parsed?.orientation ?? null, hasGps: parsed?.hasGps ?? false };
    }
    if (marker === 0xda) break;
    o += 2 + len;
  }
  if (!width || !height) return null;
  return { format: "jpeg", contentType: "image/jpeg", width, height, hasAlpha: false, animated: false, exif };
}

function probeWebp(b: Uint8Array): ImageProbe | null {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 4);
  const base = { format: "webp" as const, contentType: "image/webp" };
  if (chunk === "VP8X") {
    const flags = b[20]!;
    const width = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16));
    const height = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16));
    return { ...base, width, height, hasAlpha: (flags & 0x10) !== 0, animated: (flags & 0x02) !== 0, exif: { present: (flags & 0x08) !== 0, orientation: null, hasGps: false } };
  }
  if (chunk === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { ...base, width: (b[26]! | (b[27]! << 8)) & 0x3fff, height: (b[28]! | (b[29]! << 8)) & 0x3fff, hasAlpha: false, animated: false, exif: { ...NO_EXIF } };
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
    return { ...base, width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, hasAlpha: ((bits >>> 28) & 1) === 1, animated: false, exif: { ...NO_EXIF } };
  }
  return null;
}

function probeGif(b: Uint8Array): ImageProbe | null {
  if (b.length < 13) return null;
  const width = b[6]! | (b[7]! << 8);
  const height = b[8]! | (b[9]! << 8);
  if (width === 0 || height === 0) return null;
  // Bounded walk over blocks counting image descriptors.
  let o = 13;
  if (b[10]! & 0x80) o += 3 * (1 << ((b[10]! & 7) + 1));
  let frames = 0;
  for (let guard = 0; guard < 4096 && o < b.length && frames < 2; guard++) {
    const block = b[o]!;
    if (block === 0x3b) break;
    if (block === 0x21) {
      o += 2;
      while (o < b.length && b[o]! !== 0) o += b[o]! + 1;
      o++;
    } else if (block === 0x2c) {
      frames++;
      const packed = b[o + 9] ?? 0;
      o += 10;
      if (packed & 0x80) o += 3 * (1 << ((packed & 7) + 1));
      o++;
      while (o < b.length && b[o]! !== 0) o += b[o]! + 1;
      o++;
    } else break;
  }
  return { format: "gif", contentType: "image/gif", width, height, hasAlpha: null, animated: frames > 1, exif: { ...NO_EXIF } };
}

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

function probeIsoBmff(b: Uint8Array): ImageProbe | null {
  const size = u32be(b, 0);
  if (size < 16 || size > b.length) return null;
  const brands = [ascii(b, 8, 4)];
  for (let o = 16; o + 4 <= size; o += 4) brands.push(ascii(b, o, 4));
  const major = brands[0]!;
  let format: "heic" | "avif" | null = null;
  if (AVIF_BRANDS.has(major)) format = "avif";
  else if (HEIC_BRANDS.has(major)) format = brands.some((x) => AVIF_BRANDS.has(x)) && !brands.some((x) => x.startsWith("he")) ? "avif" : "heic";
  if (!format) return null;
  // Bounded scan for the first 'ispe' (image spatial extents) box.
  let width: number | null = null;
  let height: number | null = null;
  const limit = Math.min(b.length - 20, 256 * 1024);
  for (let o = size; o < limit; o++) {
    if (b[o] === 0x69 && b[o + 1] === 0x73 && b[o + 2] === 0x70 && b[o + 3] === 0x65) {
      const w = u32be(b, o + 8);
      const h = u32be(b, o + 12);
      if (w > 0 && h > 0) {
        width = w;
        height = h;
      }
      break;
    }
  }
  const animated = major === "msf1" || major === "avis" || major === "hevc" || major === "hevx";
  return { format, contentType: format === "heic" ? "image/heic" : "image/avif", width, height, hasAlpha: null, animated, exif: { ...NO_EXIF } };
}

/** Identify an image from its bytes. Returns null when the bytes are not a supported image or the header is truncated. */
export function probeImage(bytes: Uint8Array): ImageProbe | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG" && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return probePng(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return probeJpeg(bytes);
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return probeWebp(bytes);
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return probeGif(bytes);
  if (ascii(bytes, 4, 4) === "ftyp") return probeIsoBmff(bytes);
  return null;
}
