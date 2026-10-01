/**
 * Private delivery. Image bytes leave the bucket only (a) through an authenticated owner read, or
 * (b) through a short-lived signed URL that names ONE rendition of ONE owner. The bucket has no public
 * access; nothing here ever returns an R2 key, a bucket URL or a long-lived link.
 */
import { all, assertPrincipal, CommandError, first, requireScope, toInstant, type Principal } from "@garderobe/domain";
import { MEDIA_THUMBNAIL_WIDTHS } from "@garderobe/contracts/ext/media";
import type { MediaRenditionKind, SignedMediaUrl } from "@garderobe/contracts/ext/media";
import { assertOwnedKey } from "./keys.ts";
import { limitsOf, type MediaRuntime } from "./runtime.ts";
import { signClaims, verifyToken } from "./signing.ts";
import { loadAsset, loadRenditions, pickDisplayRendition, type RenditionRow } from "./store.ts";

export interface OpenedImage {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  etag: string;
  byteLength: number | null;
  /** `resized`: an on-demand thumbnail from the image service. `stored`: the stored rendition as it is. */
  delivery: "resized" | "stored";
}

export type ThumbnailWidth = (typeof MEDIA_THUMBNAIL_WIDTHS)[number];

/** Synthetic cache key: only this Worker reads the cache, and only after authorization succeeded. */
export function thumbnailCacheUrl(userId: string, sha256: string, width: number): string {
  return `https://thumbnails.garderobe.internal/${encodeURIComponent(userId)}/${sha256}/${width}`;
}

/**
 * Remove every cached thumbnail of one owner from this data centre's cache (account erasure). Call it
 * BEFORE the owner's rows are deleted: the cache keys are derived from the rendition checksums. The
 * Cache API is per data centre, so copies elsewhere lapse with their own 24-hour lifetime; they are
 * unreachable meanwhile because every read checks the owner's records first.
 */
export async function purgeOwnerMediaCache(rt: MediaRuntime, userId: string): Promise<{ purged: number }> {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  if (!cache) return { purged: 0 };
  const rows = await all<{ sha256: string }>(rt.db, "SELECT DISTINCT sha256 FROM media_renditions WHERE user_id = ?", userId);
  let purged = 0;
  for (const r of rows) {
    for (const width of MEDIA_THUMBNAIL_WIDTHS) if (await cache.delete(thumbnailCacheUrl(userId, r.sha256, width))) purged++;
  }
  return { purged };
}

function checkWidth(width: number | undefined | null): ThumbnailWidth | null {
  if (width === undefined || width === null || width === 0) return null;
  if (!(MEDIA_THUMBNAIL_WIDTHS as readonly number[]).includes(width)) throw new CommandError("invalid_command", `thumbnails come in fixed widths only: ${MEDIA_THUMBNAIL_WIDTHS.join(", ")}`);
  return width as ThumbnailWidth;
}

async function loadActiveRendition(rt: MediaRuntime, userId: string, renditionId: string): Promise<RenditionRow & { asset_status: string; asset_kind: string }> {
  const row = await first<RenditionRow & { asset_status: string; asset_kind: string }>(
    rt.db,
    `SELECT r.*, a.status AS asset_status, a.kind AS asset_kind FROM media_renditions r JOIN media_assets a ON a.user_id = r.user_id AND a.asset_id = r.asset_id
      WHERE r.user_id = ? AND r.rendition_id = ?`,
    userId, renditionId,
  );
  // Another owner's rendition, a deleted one and one that never existed are indistinguishable.
  if (!row || row.status === "deleted" || row.status === "rejected" || row.asset_status === "deleted" || row.asset_status === "rejected") throw new CommandError("not_found", "no such image");
  return row;
}

async function readRendition(rt: MediaRuntime, userId: string, row: RenditionRow, width: ThumbnailWidth | null): Promise<OpenedImage> {
  assertOwnedKey(userId, row.object_key);
  const images = rt.deps.images;
  if (width !== null && images && (row.width === null || row.width > width)) {
    // On-demand thumbnail through Cloudflare Images, cached at delivery. Nothing is precomputed in R2.
    const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
    const cacheKey = thumbnailCacheUrl(userId, row.sha256, width);
    const hit = cache ? await cache.match(cacheKey) : undefined;
    if (hit?.body) return { body: hit.body, contentType: hit.headers.get("content-type") ?? "image/webp", etag: `"${row.sha256.slice(0, 32)}-w${width}"`, byteLength: null, delivery: "resized" };
    const object = await rt.deps.bucket.get(row.object_key);
    if (!object) throw new CommandError("not_found", "no such image");
    const result = await images.input(object.body).transform({ width, fit: "scale-down" }).output({ format: "image/webp", quality: 82 });
    const response = result.response({ headers: { "cache-control": "private, max-age=86400" } });
    if (cache) {
      const [forCache, forCaller] = response.body!.tee();
      // The cache copy is keyed by content hash and width, and purged when the image is deleted.
      await cache.put(cacheKey, new Response(forCache, { headers: { "content-type": result.contentType(), "cache-control": "max-age=86400" } }));
      return { body: forCaller, contentType: result.contentType(), etag: `"${row.sha256.slice(0, 32)}-w${width}"`, byteLength: null, delivery: "resized" };
    }
    return { body: response.body!, contentType: result.contentType(), etag: `"${row.sha256.slice(0, 32)}-w${width}"`, byteLength: null, delivery: "resized" };
  }
  const object = await rt.deps.bucket.get(row.object_key);
  if (!object) throw new CommandError("not_found", "no such image");
  return { body: object.body, contentType: row.content_type, etag: `"${row.sha256.slice(0, 32)}"`, byteLength: object.size, delivery: "stored" };
}

/** Authenticated read of one of the caller's own renditions. */
export async function openRendition(rt: MediaRuntime, principal: Principal, renditionId: string, opts: { width?: number | null } = {}): Promise<OpenedImage> {
  assertPrincipal(principal);
  requireScope(principal, "read");
  const width = checkWidth(opts.width);
  const row = await loadActiveRendition(rt, principal.userId, renditionId);
  return readRendition(rt, principal.userId, row, width);
}

/** Authenticated read of an asset's image: its display rendition by default, or a named variant. */
export async function openAssetImage(rt: MediaRuntime, principal: Principal, assetId: string, opts: { variant?: "display" | MediaRenditionKind; width?: number | null } = {}): Promise<OpenedImage> {
  assertPrincipal(principal);
  requireScope(principal, "read");
  const width = checkWidth(opts.width);
  const asset = await loadAsset(rt.db, principal.userId, assetId);
  if (!asset || asset.status === "deleted" || asset.status === "rejected") throw new CommandError("not_found", "no such image");
  const renditions = await loadRenditions(rt.db, principal.userId, assetId);
  const variant = opts.variant ?? "display";
  const chosen = variant === "display" ? pickDisplayRendition(renditions) : pickDisplayRendition(renditions, [variant as MediaRenditionKind]);
  if (!chosen) throw new CommandError("not_found", variant === "original" ? "the full-resolution original is no longer kept" : "no such image");
  return readRendition(rt, principal.userId, chosen, width);
}

/**
 * Mint a short-lived URL for one of the caller's own renditions. `audience` narrows what is allowed:
 * a provider job gets the default lifetime at most, and a selfie is never signed for anything that is
 * embedded in shared or public text (Calendar, web board).
 */
export async function signRenditionUrl(rt: MediaRuntime, principal: Principal, renditionId: string, opts: { width?: number | null; ttlSeconds?: number; audience?: "app" | "provider" | "calendar" } = {}): Promise<SignedMediaUrl> {
  assertPrincipal(principal);
  requireScope(principal, "read");
  const width = checkWidth(opts.width);
  const limits = limitsOf(rt.deps);
  const row = await loadActiveRendition(rt, principal.userId, renditionId);
  const audience = opts.audience ?? "app";
  if (audience === "calendar" && (row.asset_kind === "selfie" || row.asset_kind === "attachment")) {
    throw new CommandError("forbidden", "a selfie or attachment is never linked from Calendar or any shared text");
  }
  const requested = opts.ttlSeconds ?? limits.defaultUrlTtlSeconds;
  const ttl = Math.max(30, Math.min(requested, audience === "app" ? limits.maxUrlTtlSeconds : limits.defaultUrlTtlSeconds));
  const exp = Math.floor(rt.clock() / 1000) + ttl;
  const token = await signClaims(rt.deps.signingKey, { p: "rendition", u: principal.userId, r: row.rendition_id, w: width ?? 0, exp });
  return { url: `/v1/media/signed/${token}`, renditionId: row.rendition_id, width, expiresAt: toInstant(exp * 1000) };
}

const DENIED_HEADERS = { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" };

/**
 * Serve a signed media URL. Every failure - bad signature, expiry, wrong owner, deleted image, disabled
 * account - is the same 404 with no detail, so a URL reveals nothing about what exists.
 */
export async function serveSignedMedia(rt: MediaRuntime, token: string, request?: Request): Promise<Response> {
  const denied = () => new Response("Not found", { status: 404, headers: DENIED_HEADERS });
  const nowMs = rt.clock();
  const verified = await verifyToken(rt.deps.signingKey, token, "rendition", nowMs);
  if (!verified.ok) return denied();
  const { u: userId, r: renditionId, w, exp } = verified.claims;
  const owner = await first<{ status: string }>(rt.db, "SELECT status FROM users WHERE user_id = ?", userId);
  if (!owner || owner.status !== "active") return denied();
  let image: OpenedImage;
  let etag: string;
  try {
    const row = await loadActiveRendition(rt, userId, renditionId);
    const width = checkWidth(w);
    etag = `"${row.sha256.slice(0, 32)}${width ? `-w${width}` : ""}"`;
    if (request?.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag, "cache-control": "private, no-transform" } });
    image = await readRendition(rt, userId, row, width);
  } catch {
    return denied();
  }
  const remaining = Math.max(0, Math.floor(exp - nowMs / 1000));
  return new Response(image.body, {
    status: 200,
    headers: {
      "content-type": image.contentType,
      // Private to the one device; never stored by shared caches, and not beyond the URL's own lifetime.
      "cache-control": `private, max-age=${remaining}, no-transform`,
      etag,
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
      "referrer-policy": "no-referrer",
      "cross-origin-resource-policy": "same-site",
      ...(image.byteLength !== null ? { "content-length": String(image.byteLength) } : {}),
    },
  });
}
