/**
 * Byte-level image validation for uploads and derivatives (spec section 11, "Storage and privacy").
 * The backend validates every upload itself: magic bytes must match the declared type, dimensions
 * must be sane, and derivatives are stripped of location-bearing metadata (EXIF/XMP/IPTC, PNG text
 * chunks). No image library is needed for these checks.
 */

export interface SniffResult {
  contentType: 'image/png' | 'image/jpeg' | 'image/heic' | 'image/svg+xml' | null;
  width: number | null;
  height: number | null;
}

export const MIN_SIDE = 16;
export const MAX_SIDE = 12_000;

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function u32(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}
function u16(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!;
}
function ascii(b: Uint8Array, o: number, n: number): string {
  return String.fromCharCode(...b.subarray(o, o + n));
}

export function isPng(b: Uint8Array): boolean {
  return b.length >= 24 && PNG_SIG.every((v, i) => b[i] === v) && ascii(b, 12, 4) === 'IHDR';
}
export function isJpeg(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}
export function isHeic(b: Uint8Array): boolean {
  if (b.length < 12 || ascii(b, 4, 4) !== 'ftyp') return false;
  return ['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(ascii(b, 8, 4));
}

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      o += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null;
    const len = u16(b, o + 2);
    if (len < 2) return null;
    const sof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (sof && o + 9 <= b.length) return { height: u16(b, o + 5), width: u16(b, o + 7) };
    o += 2 + len;
  }
  return null;
}

const SVG_DIM = /^<svg\b[^>]*?\swidth="(\d+(?:\.\d+)?)"[^>]*?\sheight="(\d+(?:\.\d+)?)"/;

export function sniff(bytes: Uint8Array): SniffResult {
  if (isPng(bytes)) return { contentType: 'image/png', width: u32(bytes, 16), height: u32(bytes, 20) };
  if (isJpeg(bytes)) {
    const s = jpegSize(bytes);
    return { contentType: 'image/jpeg', width: s?.width ?? null, height: s?.height ?? null };
  }
  if (isHeic(bytes)) return { contentType: 'image/heic', width: null, height: null };
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096))).replace(/^\uFEFF/, '').replace(/^<\?xml[^>]*\?>\s*/, '').trimStart();
  if (head.startsWith('<svg')) {
    const m = SVG_DIM.exec(head);
    return { contentType: 'image/svg+xml', width: m ? Math.round(Number(m[1])) : null, height: m ? Math.round(Number(m[2])) : null };
  }
  return { contentType: null, width: null, height: null };
}

export type ValidationProblem = { code: string; message: string };

/** Raster validation for owner uploads. SVG is never accepted from an upload. */
export function validateRaster(bytes: Uint8Array, declared: string, maxBytes: number): { ok: true; sniffed: SniffResult } | { ok: false; problem: ValidationProblem } {
  if (bytes.length === 0) return { ok: false, problem: { code: 'empty', message: 'The upload is empty' } };
  if (bytes.length > maxBytes) return { ok: false, problem: { code: 'too_large', message: `The upload is larger than the ${maxBytes} bytes authorized` } };
  const s = sniff(bytes);
  if (!s.contentType || s.contentType === 'image/svg+xml') return { ok: false, problem: { code: 'not_an_image', message: 'The upload is not a JPEG, PNG or HEIC image' } };
  if (s.contentType !== declared) return { ok: false, problem: { code: 'type_mismatch', message: `Declared ${declared} but the bytes are ${s.contentType}` } };
  if (s.contentType !== 'image/heic') {
    if (s.width === null || s.height === null) return { ok: false, problem: { code: 'unreadable', message: 'The image dimensions could not be read' } };
    if (Math.min(s.width, s.height) < MIN_SIDE || Math.max(s.width, s.height) > MAX_SIDE) {
      return { ok: false, problem: { code: 'bad_dimensions', message: `Image dimensions ${s.width}×${s.height} are outside ${MIN_SIDE}–${MAX_SIDE} px` } };
    }
  }
  return { ok: true, sniffed: s };
}

/**
 * Remove metadata that can carry location or device identity from a derivative. JPEG: APP1 (EXIF,
 * XMP), APP13 (IPTC) and comments. PNG: eXIf, tEXt, iTXt, zTXt and tIME chunks. Other formats are
 * returned unchanged and reported as not stripped (HEIC derivatives go through the image transformer).
 */
export function stripLocationMetadata(bytes: Uint8Array): { bytes: Uint8Array; stripped: boolean; removed: string[] } {
  if (isJpeg(bytes)) {
    const out: Uint8Array[] = [bytes.subarray(0, 2)];
    const removed: string[] = [];
    let o = 2;
    while (o + 4 <= bytes.length && bytes[o] === 0xff) {
      const marker = bytes[o + 1]!;
      if (marker === 0xda) break; // start of scan: copy the rest verbatim
      const len = u16(bytes, o + 2);
      const seg = bytes.subarray(o, o + 2 + len);
      if (marker === 0xe1 || marker === 0xed || marker === 0xfe) removed.push(`0xFF${marker.toString(16).toUpperCase()}`);
      else out.push(seg);
      o += 2 + len;
    }
    out.push(bytes.subarray(o));
    return { bytes: concat(out), stripped: true, removed };
  }
  if (isPng(bytes)) {
    const out: Uint8Array[] = [bytes.subarray(0, 8)];
    const removed: string[] = [];
    let o = 8;
    while (o + 12 <= bytes.length) {
      const len = u32(bytes, o);
      const type = ascii(bytes, o + 4, 4);
      const chunk = bytes.subarray(o, o + 12 + len);
      if (['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME'].includes(type)) removed.push(type);
      else out.push(chunk);
      o += 12 + len;
      if (type === 'IEND') break;
    }
    return { bytes: concat(out), stripped: true, removed };
  }
  if (bytes.length && sniff(bytes).contentType === 'image/svg+xml') return { bytes, stripped: true, removed: [] };
  return { bytes, stripped: false, removed: [] };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export async function sha256Bytes(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes instanceof Uint8Array ? bytes.slice().buffer : bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
