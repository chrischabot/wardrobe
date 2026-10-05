/**
 * Shared support for the media abuse cases. Everything here talks to the REAL Worker over HTTP or reads
 * the local D1 and R2 the Worker uses; nothing replaces a part of the visual wardrobe.
 *
 * EVERY IMAGE BUILT HERE IS A SYNTHETIC TEST IMAGE on a synthetic fixture garment of a synthetic owner.
 * None is a photograph of anyone's clothes.
 */
import { SELF } from "cloudflare:test";
import { APP_ORIGIN, provisionOwner, testApp, type TestOwner } from "@garderobe/worker/testing";
import { encodeJpeg, encodePng, type Raster } from "@garderobe/media/image";

export const ROLES = ["top", "bottom", "footwear", "socks"] as const;
export type FixtureRole = (typeof ROLES)[number];

const FIXTURE: Record<FixtureRole, { category: string; careChannel: string }> = {
  top: { category: "shirt", careChannel: "service" },
  bottom: { category: "trousers", careChannel: "service" },
  footwear: { category: "footwear", careChannel: "none" },
  socks: { category: "socks", careChannel: "service" },
};

export interface AbuseOwner {
  owner: TestOwner;
  label: string;
  /** One synthetic fixture garment per role. */
  garments: Record<FixtureRole, { garmentId: string; name: string }>;
  slots(): { role: FixtureRole; garmentId: string }[];
}

/** A synthetic owner with one labelled synthetic garment per role, created through the ordinary command route. */
export async function syntheticOwner(label: string): Promise<AbuseOwner> {
  const owner = await provisionOwner({ displayName: `Synthetic owner ${label} (media abuse fixture)` });
  const garments = {} as AbuseOwner["garments"];
  for (const role of ROLES) {
    const name = `Synthetic ${role} of ${label} ${crypto.randomUUID().slice(0, 8)} (test fixture, not real stock)`;
    const response = await owner.api.command("garment.create", { name, category: FIXTURE[role].category, roles: [role], careChannel: FIXTURE[role].careChannel, acquisition: "owned", quantity: 3, isSynthetic: true, source: { kind: "system", note: "synthetic test garment" } });
    const receipt = (await response.json()) as { affected?: { kind: string; id: string }[] };
    const created = receipt.affected?.find((a) => a.kind === "garment");
    if (!created) throw new Error(`garment.create failed (${response.status}): ${JSON.stringify(receipt)}`);
    garments[role] = { garmentId: created.id, name };
  }
  return { owner, label, garments, slots: () => ROLES.map((role) => ({ role, garmentId: garments[role].garmentId })) };
}

/* ------------------------------ waiting for background work ------------------------------ */

/** Dispatch committed media jobs to the local queue and wait until the Worker's queue consumer has finished them. */
export async function settleJobs(userId?: string, timeoutMs = 60_000): Promise<void> {
  const app = await testApp();
  const started = Date.now();
  for (;;) {
    await app.media!.afterCommit();
    const open = await app.db.prepare(`SELECT COUNT(*) AS n FROM media_jobs WHERE state IN ('queued', 'running') ${userId ? "AND user_id = ?" : ""}`).bind(...(userId ? [userId] : [])).first<{ n: number }>();
    const outbox = await app.db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE topic = 'media.job' AND state != 'acknowledged' ${userId ? "AND user_id = ?" : ""}`).bind(...(userId ? [userId] : [])).first<{ n: number }>();
    if ((open?.n ?? 0) === 0 && (outbox?.n ?? 0) === 0) return;
    if (Date.now() - started > timeoutMs) throw new Error(`media jobs did not settle within ${timeoutMs} ms (${open?.n} open, ${outbox?.n} undelivered)`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/* ------------------------------ state read straight from D1 and R2 ------------------------------ */

export async function rows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
  const app = await testApp();
  return (await app.db.prepare(sql).bind(...params).all<T>()).results;
}

/** Every object key the owner has in the private media bucket. */
export async function objectKeys(userId: string): Promise<string[]> {
  const app = await testApp();
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await app.env.MEDIA_BUCKET!.list({ prefix: `u/${userId}/`, ...(cursor ? { cursor } : {}) });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys.sort();
}

/** A fingerprint of everything an owner has in the visual wardrobe: used to prove an attack changed nothing. */
export async function mediaFingerprint(userId: string): Promise<string> {
  const tables = ["media_uploads", "media_assets", "media_renditions", "garment_media", "outfit_composites", "studio_combinations", "studio_day_plans"];
  const out: Record<string, unknown> = { objects: await objectKeys(userId) };
  for (const table of tables) out[table] = await rows(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY 1, 2, 3`, userId);
  out.jobs = await rows("SELECT job_id, kind, state, attempts FROM media_jobs WHERE user_id = ? ORDER BY job_id", userId);
  out.commands = (await rows<{ n: number }>("SELECT COUNT(*) AS n FROM commands WHERE user_id = ?", userId))[0]!.n;
  return JSON.stringify(out);
}

/* ------------------------------ the upload route, step by step ------------------------------ */

export interface UploadAttempt {
  authorize: { status: number; body: any };
  put: { status: number; body: any } | null;
  complete: { status: number; body: any } | null;
  uploadId: string | null;
}

async function parsed(response: Response): Promise<{ status: number; body: any }> {
  const text = await response.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON: keep the text */
  }
  return { status: response.status, body };
}

/**
 * Drive the three upload steps and report what each one answered, never throwing on a refusal.
 * `declare` is what the client CLAIMS (content type, size); `send` is what it actually puts on the wire.
 */
export async function attemptUpload(
  o: AbuseOwner,
  bytes: Uint8Array,
  opts: { intent?: "garment_photo" | "selfie" | "attachment"; role?: FixtureRole; declareType?: string; declareBytes?: number; sendType?: string; wearingDate?: string } = {},
): Promise<UploadAttempt> {
  const intent = opts.intent ?? "garment_photo";
  const authorize = await parsed(
    await o.owner.api.post("/v1/uploads", {
      clientUploadId: `abuse-${crypto.randomUUID()}`,
      intent,
      contentType: opts.declareType ?? "image/png",
      byteLength: opts.declareBytes ?? bytes.length,
      ...(intent === "garment_photo" ? { garmentId: o.garments[opts.role ?? "top"].garmentId } : {}),
      ...(opts.wearingDate ? { wearingDate: opts.wearingDate } : {}),
    }),
  );
  if (authorize.status !== 200) return { authorize, put: null, complete: null, uploadId: null };
  const uploadId = authorize.body.uploadId as string;
  const put = await parsed(await SELF.fetch(`${APP_ORIGIN}${authorize.body.url}`, { method: "PUT", headers: { "Content-Type": opts.sendType ?? authorize.body.requiredHeaders["content-type"], "Content-Length": String(bytes.length) }, body: bytes }));
  const complete = await parsed(await o.owner.api.post(`/v1/uploads/${uploadId}/complete`, {}));
  return { authorize, put, complete, uploadId };
}

/** Upload that must succeed (a clean synthetic picture), settled: returns the asset and its renditions. */
export async function uploadClean(o: AbuseOwner, bytes: Uint8Array, opts: Parameters<typeof attemptUpload>[2] = {}): Promise<{ uploadId: string; assetId: string; renditions: { rendition_id: string; kind: string; status: string }[] }> {
  const attempt = await attemptUpload(o, bytes, opts);
  if (attempt.complete?.status !== 200 || !attempt.complete.body.asset) throw new Error(`a clean upload was refused: ${JSON.stringify(attempt)}`);
  await settleJobs(o.owner.userId);
  const assetId = attempt.complete.body.asset.assetId as string;
  return { uploadId: attempt.uploadId!, assetId, renditions: await rows("SELECT rendition_id, kind, status FROM media_renditions WHERE user_id = ? AND asset_id = ? ORDER BY kind, version", o.owner.userId, assetId) };
}

/**
 * Every copy of an asset the Worker will hand out over HTTP: the asset route in each variant, every
 * rendition by its ID, and a signed URL for each. Refusals are included with their status.
 */
export async function everyServedCopy(o: AbuseOwner, assetId: string): Promise<{ via: string; status: number; contentType: string | null; bytes: Uint8Array }[]> {
  const out: { via: string; status: number; contentType: string | null; bytes: Uint8Array }[] = [];
  const take = async (via: string, response: Response) => out.push({ via, status: response.status, contentType: response.headers.get("content-type"), bytes: new Uint8Array(await response.arrayBuffer()) });
  for (const variant of ["", "?variant=display", "?variant=original", "?variant=cutout", "?variant=catalogue", "?width=320", "?variant=original&width=160"]) await take(`asset${variant}`, await o.owner.api.get(`/v1/media/assets/${assetId}${variant}`));
  for (const r of await rows<{ rendition_id: string; kind: string }>("SELECT rendition_id, kind FROM media_renditions WHERE user_id = ? AND asset_id = ?", o.owner.userId, assetId)) {
    await take(`rendition ${r.kind}`, await o.owner.api.get(`/v1/media/renditions/${r.rendition_id}`));
    const signed = await o.owner.api.post(`/v1/media/renditions/${r.rendition_id}/sign`, {});
    if (signed.status === 200) await take(`signed ${r.kind}`, await SELF.fetch(`${APP_ORIGIN}${((await signed.json()) as { url: string }).url}`));
    else out.push({ via: `signed ${r.kind} (not issued)`, status: signed.status, contentType: null, bytes: new Uint8Array(0) });
  }
  return out;
}

/* ------------------------------ building hostile files ------------------------------ */

export const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
export const latin1 = (b: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
};
export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** One PNG chunk with a correct CRC (or a deliberately wrong one). */
export function pngChunk(type: string, body: Uint8Array, opts: { badCrc?: boolean } = {}): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(ascii(type), 4);
  out.set(body, 8);
  view.setUint32(8 + body.length, (crc32(out.subarray(4, 8 + body.length)) ^ (opts.badCrc ? 0x5a5a5a5a : 0)) >>> 0);
  return out;
}

export function pngHeader(width: number, height: number, colourType = 6, depth = 8): Uint8Array {
  const body = new Uint8Array(13);
  const view = new DataView(body.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  body[8] = depth;
  body[9] = colourType;
  return pngChunk("IHDR", body);
}

/** The chunks of a PNG file, in order. */
export function pngChunks(png: Uint8Array): { type: string; bytes: Uint8Array }[] {
  const out: { type: string; bytes: Uint8Array }[] = [];
  let o = 8;
  while (o + 12 <= png.length) {
    const len = new DataView(png.buffer, png.byteOffset + o, 4).getUint32(0);
    out.push({ type: latin1(png.subarray(o + 4, o + 8)), bytes: png.subarray(o, o + 12 + len) });
    o += 12 + len;
  }
  return out;
}

export async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export const jpegSegment = (marker: number, body: Uint8Array): Uint8Array => concat(new Uint8Array([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body);

/** TEST DATA: an Exif TIFF block with an Orientation field and a pointer to a GPS directory, as a phone camera writes. */
export function exifWithGps(orientation = 1): Uint8Array {
  const tiff = new Uint8Array(8 + 2 + 24 + 4 + 8);
  const v = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
  v.setUint16(8, 2, true);
  v.setUint16(10, 0x0112, true);
  v.setUint16(12, 3, true);
  v.setUint32(14, 1, true);
  v.setUint16(18, orientation, true);
  v.setUint16(22, 0x8825, true);
  v.setUint16(24, 4, true);
  v.setUint32(26, 1, true);
  v.setUint32(30, 38, true);
  return concat(ascii("Exif\0\0"), tiff);
}

/* ------------------------------ clean synthetic pictures ------------------------------ */

/** A synthetic garment-like shape (a plain coloured block with a stripe) on a white background. */
export function syntheticPicture(size = 192, colour: [number, number, number] = [40, 90, 200]): Raster {
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = Math.round(size * 0.15); y < Math.round(size * 0.85); y++) {
    for (let x = Math.round(size * 0.25); x < Math.round(size * 0.75); x++) {
      const i = (y * size + x) * 4;
      const stripe = Math.floor(x / 6) % 2 === 0 && y > size * 0.2 && y < size * 0.8 && x > size * 0.3 && x < size * 0.7;
      data[i] = stripe ? Math.min(255, colour[0] + 90) : colour[0];
      data[i + 1] = stripe ? Math.min(255, colour[1] + 70) : colour[1];
      data[i + 2] = stripe ? Math.min(255, colour[2] + 30) : colour[2];
    }
  }
  return { width: size, height: size, data };
}

export const cleanPng = (size = 192, colour?: [number, number, number]): Promise<Uint8Array> => encodePng(syntheticPicture(size, colour));
export const cleanJpeg = (size = 192, colour?: [number, number, number]): Uint8Array => encodeJpeg(syntheticPicture(size, colour), 90);

export async function sha256(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
