import { DEFAULT_MAX_PIXELS, ImageDecodeError } from "./errors.ts";
import type { Raster } from "./raster.ts";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array, start: number, end: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function pipeThrough(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, limit?: number): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const writing = writer.write(bytes as unknown as BufferSource).then(() => writer.close());
  writing.catch(() => undefined);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (limit !== undefined && total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ImageDecodeError("corrupt", "PNG data inflates beyond its declared size");
    }
    chunks.push(value);
  }
  await writing;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function u32(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [
  { x0: 0, y0: 0, dx: 8, dy: 8 },
  { x0: 4, y0: 0, dx: 8, dy: 8 },
  { x0: 0, y0: 4, dx: 4, dy: 8 },
  { x0: 2, y0: 0, dx: 4, dy: 4 },
  { x0: 0, y0: 2, dx: 2, dy: 4 },
  { x0: 1, y0: 0, dx: 2, dy: 2 },
  { x0: 0, y0: 1, dx: 1, dy: 2 },
];

/** Reverse PNG scanline filters in place for one (sub)image; returns the offset after it. */
function unfilter(data: Uint8Array, offset: number, rows: number, rowBytes: number, bpp: number): number {
  let prev = -1;
  let o = offset;
  for (let y = 0; y < rows; y++) {
    if (o + 1 + rowBytes > data.length) throw new ImageDecodeError("corrupt", "PNG image data is truncated");
    const filter = data[o]!;
    const row = o + 1;
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? data[row + i - bpp]! : 0;
      const b = prev >= 0 ? data[prev + i]! : 0;
      const c = prev >= 0 && i >= bpp ? data[prev + i - bpp]! : 0;
      let add: number;
      switch (filter) {
        case 0:
          add = 0;
          break;
        case 1:
          add = a;
          break;
        case 2:
          add = b;
          break;
        case 3:
          add = (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          throw new ImageDecodeError("corrupt", "PNG uses an unknown filter type");
      }
      data[row + i] = (data[row + i]! + add) & 0xff;
    }
    prev = row;
    o = row + rowBytes;
  }
  return o;
}

/**
 * Decode a PNG: colour types 0, 2, 3, 4 and 6, bit depths 1-16 (16 is reduced to 8), tRNS transparency,
 * non-interlaced and Adam7. Chunk CRCs are verified and the pixel ceiling is enforced before inflating.
 */
export async function decodePng(bytes: Uint8Array, opts: { maxPixels?: number } = {}): Promise<Raster> {
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) throw new ImageDecodeError("unrecognized", "not a PNG");
  let o = 8;
  let width = 0, height = 0, depth = 0, colourType = 0, interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let sawHeader = false, sawEnd = false;
  while (o + 12 <= bytes.length) {
    const len = u32(bytes, o);
    if (o + 12 + len > bytes.length) throw new ImageDecodeError("corrupt", "PNG chunk is truncated");
    const type = String.fromCharCode(bytes[o + 4]!, bytes[o + 5]!, bytes[o + 6]!, bytes[o + 7]!);
    const body = bytes.subarray(o + 8, o + 8 + len);
    if (crc32(bytes, o + 4, o + 8 + len) !== u32(bytes, o + 8 + len)) throw new ImageDecodeError("corrupt", `PNG chunk ${type} fails its CRC`);
    if (type === "IHDR") {
      if (len !== 13) throw new ImageDecodeError("corrupt", "PNG header has the wrong length");
      width = u32(body, 0);
      height = u32(body, 4);
      depth = body[8]!;
      colourType = body[9]!;
      interlace = body[12]!;
      const validDepths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (width === 0 || height === 0 || !validDepths[colourType]?.includes(depth) || body[10] !== 0 || body[11] !== 0 || interlace > 1) throw new ImageDecodeError("corrupt", "PNG header is invalid");
      if (width * height > (opts.maxPixels ?? DEFAULT_MAX_PIXELS)) throw new ImageDecodeError("too_large", `PNG of ${width}x${height} exceeds the pixel limit`);
      sawHeader = true;
    } else if (!sawHeader) {
      throw new ImageDecodeError("corrupt", "PNG does not start with its header");
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") trns = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") {
      sawEnd = true;
      break;
    }
    o += 12 + len;
  }
  if (!sawHeader || !sawEnd || idat.length === 0) throw new ImageDecodeError("corrupt", "PNG is incomplete");
  if (colourType === 3 && !palette) throw new ImageDecodeError("corrupt", "PNG palette is missing");

  const channels = CHANNELS[colourType]!;
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const rowBytesFor = (w: number) => Math.ceil((w * bitsPerPixel) / 8);
  const passes = interlace === 1
    ? ADAM7.map((p) => ({ ...p, w: Math.ceil((width - p.x0) / p.dx), h: Math.ceil((height - p.y0) / p.dy) })).filter((p) => p.w > 0 && p.h > 0)
    : [{ x0: 0, y0: 0, dx: 1, dy: 1, w: width, h: height }];
  const expected = passes.reduce((n, p) => n + p.h * (1 + rowBytesFor(p.w)), 0);

  const compressed = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of idat) {
    compressed.set(c, at);
    at += c.length;
  }
  let raw: Uint8Array;
  try {
    raw = await pipeThrough(compressed, new DecompressionStream("deflate"), expected);
  } catch (e) {
    if (e instanceof ImageDecodeError) throw e;
    throw new ImageDecodeError("corrupt", "PNG image data could not be inflated");
  }
  if (raw.length < expected) throw new ImageDecodeError("corrupt", "PNG image data is truncated");

  const out = new Uint8ClampedArray(width * height * 4);
  const maxSample = (1 << Math.min(depth, 8)) - 1;
  const sample = (row: number, index: number): number => {
    if (depth === 8) return raw[row + index]!;
    if (depth === 16) return raw[row + index * 2]!;
    const bit = index * depth;
    return (raw[row + (bit >> 3)]! >> (8 - depth - (bit & 7))) & maxSample;
  };
  const sample16 = (row: number, index: number): number => (raw[row + index * 2]! << 8) | raw[row + index * 2 + 1]!;
  const trnsGrey = trns && colourType === 0 && trns.length >= 2 ? (trns[0]! << 8) | trns[1]! : -1;
  const trnsRgb = trns && colourType === 2 && trns.length >= 6 ? [(trns[0]! << 8) | trns[1]!, (trns[2]! << 8) | trns[3]!, (trns[4]! << 8) | trns[5]!] : null;

  let offset = 0;
  for (const p of passes) {
    const rowBytes = rowBytesFor(p.w);
    const start = offset;
    offset = unfilter(raw, offset, p.h, rowBytes, bpp);
    for (let py = 0; py < p.h; py++) {
      const row = start + py * (rowBytes + 1) + 1;
      for (let px = 0; px < p.w; px++) {
        const di = ((p.y0 + py * p.dy) * width + p.x0 + px * p.dx) * 4;
        let r: number, g: number, b: number, a = 255;
        if (colourType === 3) {
          const idx = sample(row, px);
          if (idx * 3 + 2 >= palette!.length) throw new ImageDecodeError("corrupt", "PNG palette index out of range");
          r = palette![idx * 3]!;
          g = palette![idx * 3 + 1]!;
          b = palette![idx * 3 + 2]!;
          if (trns && idx < trns.length) a = trns[idx]!;
        } else if (colourType === 0 || colourType === 4) {
          const v = sample(row, px * channels);
          r = g = b = depth < 8 ? Math.round((v * 255) / maxSample) : v;
          if (colourType === 4) a = sample(row, px * channels + 1);
          else if (trnsGrey >= 0 && (depth === 16 ? sample16(row, px) : v) === trnsGrey) a = 0;
        } else {
          r = sample(row, px * channels);
          g = sample(row, px * channels + 1);
          b = sample(row, px * channels + 2);
          if (colourType === 6) a = sample(row, px * channels + 3);
          else if (trnsRgb) {
            const full = depth === 16 ? [sample16(row, px * 3), sample16(row, px * 3 + 1), sample16(row, px * 3 + 2)] : [r, g, b];
            if (full[0] === trnsRgb[0] && full[1] === trnsRgb[1] && full[2] === trnsRgb[2]) a = 0;
          }
        }
        out[di] = r;
        out[di + 1] = g;
        out[di + 2] = b;
        out[di + 3] = a;
      }
    }
  }
  return { width, height, data: out };
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out, 4, 8 + body.length));
  return out;
}

/** Low-level PNG assembly from raw (already filtered) scanline data. Exported for building test fixtures. */
export async function assemblePng(header: { width: number; height: number; depth: number; colourType: number; interlace?: number }, filtered: Uint8Array, extra: { type: string; body: Uint8Array }[] = []): Promise<Uint8Array> {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, header.width);
  view.setUint32(4, header.height);
  ihdr[8] = header.depth;
  ihdr[9] = header.colourType;
  ihdr[12] = header.interlace ?? 0;
  const compressed = await pipeThrough(filtered, new CompressionStream("deflate"));
  const parts = [new Uint8Array(SIGNATURE), chunk("IHDR", ihdr), ...extra.map((e) => chunk(e.type, e.body)), chunk("IDAT", compressed), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Encode 8-bit RGBA with no ancillary chunks (no metadata). Identical rasters give identical bytes. */
export async function encodePng(raster: Raster): Promise<Uint8Array> {
  const { width, height, data } = raster;
  const stride = width * 4;
  const filtered = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    // Filter 1 (Sub) on every row: deterministic and compresses flat areas well.
    filtered[row] = 1;
    for (let i = 0; i < stride; i++) {
      const cur = data[y * stride + i]!;
      const left = i >= 4 ? data[y * stride + i - 4]! : 0;
      filtered[row + 1 + i] = (cur - left) & 0xff;
    }
  }
  return assemblePng({ width, height, depth: 8, colourType: 6 }, filtered);
}
