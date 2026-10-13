import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { all, first, isCommandError } from "@garderobe/domain";
import type { TestOwner } from "@garderobe/domain/testing";
import { createCloudflareImagesTranscoder, getAsset, getGarmentMedia, listMediaJobs, openAssetImage, openRendition, purgeOwnerMediaCache, serveSignedMedia, signRenditionUrl } from "../src/index.ts";
import { thumbnailCacheUrl } from "../src/delivery.ts";
import { encodePng, probeImage } from "../src/image/index.ts";
import { signClaims } from "../src/signing.ts";
import { createMediaHarness, syntheticShirt, type MediaHarness } from "../src/testing/index.ts";

// SYNTHETIC TEST IMAGES on synthetic fixture garments throughout (labelled demo placeholders).
// The Images binding here is the local runtime's implementation of the Cloudflare Images binding: it
// resizes and converts for real, but it is not the production service (see the live-verification list).

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return isCommandError(e) ? e.code : `threw:${String(e)}`;
  }
}

const tokenOf = (url: string): string => url.split("/").pop()!;
const bytesOf = async (body: ReadableStream<Uint8Array> | null): Promise<Uint8Array> => new Uint8Array(await new Response(body).arrayBuffer());

describe("signed media URLs: owner-scoped, single-rendition, expiring", () => {
  let h: MediaHarness;
  let alice: TestOwner;
  let bob: TestOwner;
  let garmentRendition: string;
  let garmentAsset: string;
  let selfieRendition: string;

  beforeAll(async () => {
    h = await createMediaHarness();
    alice = await h.createSyntheticOwner({ displayName: "Synthetic owner A (delivery)" });
    bob = await h.createSyntheticOwner({ displayName: "Synthetic owner B (delivery)" });
    const up = await h.upload(alice, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 320 }), demo: true });
    const selfie = await h.upload(alice, { intent: "selfie", raster: syntheticShirt({ size: 200 }), wearingDate: "2026-09-15" });
    await h.settle(alice);
    garmentAsset = up.asset!.assetId;
    garmentRendition = (await getGarmentMedia(h.rt, alice.principal(), "shirt-moss")).image.renditionId!;
    selfieRendition = (await getAsset(h.rt, alice.principal(), selfie.asset!.assetId)).renditions.find((r) => r.kind === "display")!.renditionId;
  });

  it("a signed URL names one rendition and carries no storage key, bucket address or long life", async () => {
    const signed = await signRenditionUrl(h.rt, alice.principal(), garmentRendition);
    expect(signed.url).toMatch(/^\/v1\/media\/signed\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(signed.renditionId).toBe(garmentRendition);
    expect(Date.parse(signed.expiresAt) - h.clock.now()).toBe(300_000); // five minutes by default
    expect(signed.url).not.toMatch(/r2\.dev|r2\.cloudflarestorage|assets\/|u\//);
    const claims = JSON.parse(atob(tokenOf(signed.url).split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(Object.keys(claims).sort()).toEqual(["exp", "p", "r", "u", "w"]); // owner, one rendition, width, purpose, expiry: nothing else
    expect(claims).toMatchObject({ p: "rendition", u: alice.userId, r: garmentRendition, w: 0 });
    // The requested lifetime is clamped at both ends.
    expect(Date.parse((await signRenditionUrl(h.rt, alice.principal(), garmentRendition, { ttlSeconds: 1 })).expiresAt) - h.clock.now()).toBe(30_000);
    expect(Date.parse((await signRenditionUrl(h.rt, alice.principal(), garmentRendition, { ttlSeconds: 86_400 })).expiresAt) - h.clock.now()).toBe(900_000);
  });

  it("never signs a selfie for Calendar or shared text, and gives providers the short lifetime only", async () => {
    expect(await code(signRenditionUrl(h.rt, alice.principal(), selfieRendition, { audience: "calendar" }))).toBe("forbidden");
    // The owner's own app can still show the selfie beside the composition.
    expect((await serveSignedMedia(h.rt, tokenOf((await signRenditionUrl(h.rt, alice.principal(), selfieRendition)).url))).status).toBe(200);
    for (const audience of ["calendar", "provider"] as const) {
      const signed = await signRenditionUrl(h.rt, alice.principal(), garmentRendition, { audience, ttlSeconds: 86_400 });
      expect(Date.parse(signed.expiresAt) - h.clock.now()).toBe(300_000); // never the long app lifetime
    }
  });

  it("refuses tokens of another purpose, another key, another owner's rendition and unknown widths with the same 404", async () => {
    const exp = Math.floor(h.clock.now() / 1000) + 300;
    const key = h.deps.signingKey;
    const forged = [
      await signClaims(key, { p: "upload", u: alice.userId, r: garmentRendition, m: 1000, c: "image/png", exp }), // an upload token is not a read token
      await signClaims(key, { p: "composite", u: alice.userId, r: garmentRendition, w: 0, exp }),
      await signClaims("another-signing-key-of-sufficient-length-000000", { p: "rendition", u: alice.userId, r: garmentRendition, w: 0, exp }),
      await signClaims(key, { p: "rendition", u: bob.userId, r: garmentRendition, w: 0, exp }), // validly signed for Bob, but the rendition is Alice's
      await signClaims(key, { p: "rendition", u: alice.userId, r: "rnd_does_not_exist", w: 0, exp }),
      await signClaims(key, { p: "rendition", u: alice.userId, r: garmentRendition, w: 123, exp }), // not one of the fixed widths
      await signClaims(key, { p: "rendition", u: alice.userId, r: garmentRendition, w: 0, exp: Math.floor(h.clock.now() / 1000) }), // expires this second
      await signClaims(key, { p: "rendition", u: "usr_nobody", r: garmentRendition, w: 0, exp }),
    ];
    for (const token of forged) {
      const res = await serveSignedMedia(h.rt, token);
      expect([res.status, await res.text(), res.headers.get("cache-control")]).toEqual([404, "Not found", "no-store"]);
    }
    // The same claims, correctly signed for the real owner, do work: the refusals above are not an outage.
    const good = await serveSignedMedia(h.rt, await signClaims(key, { p: "rendition", u: alice.userId, r: garmentRendition, w: 0, exp }));
    expect(good.status).toBe(200);
    expect(good.headers.get("referrer-policy")).toBe("no-referrer");
    expect(good.headers.get("cache-control")).toBe("private, max-age=300, no-transform");
    await good.arrayBuffer();
  });

  it("requires an authenticated owner with read scope for direct reads and for signing", async () => {
    const noScope = alice.principal({ scopes: [] });
    expect(await code(openRendition(h.rt, noScope, garmentRendition))).toBe("forbidden");
    expect(await code(openAssetImage(h.rt, noScope, garmentAsset))).toBe("forbidden");
    expect(await code(signRenditionUrl(h.rt, noScope, garmentRendition))).toBe("forbidden");
    expect(await code(openRendition(h.rt, { userId: alice.userId, scopes: ["read"] } as never, garmentRendition))).not.toBe("ok"); // a forged principal object is refused
    expect(await code(getGarmentMedia(h.rt, bob.principal(), "shirt-moss"))).toBe("ok"); // Bob's own colliding garment ID...
    expect((await getGarmentMedia(h.rt, bob.principal(), "shirt-moss")).assets).toHaveLength(0); // ...shows none of Alice's images
    expect(await code(getAsset(h.rt, bob.principal(), garmentAsset))).toBe("not_found");
  });

  it("no read model exposes an object key, and every stored object sits under its owner's prefix", async () => {
    const media = await getGarmentMedia(h.rt, alice.principal(), "shirt-moss");
    const jobs = await listMediaJobs(h.rt, alice.principal());
    const text = JSON.stringify([media, jobs, await getAsset(h.rt, alice.principal(), garmentAsset)]);
    expect(text).not.toContain(`u/${alice.userId}`);
    expect(text).not.toMatch(/objectKey|object_key/);
    const keys = await all<{ user_id: string; object_key: string }>(h.db, "SELECT user_id, object_key FROM media_renditions WHERE user_id IN (?, ?)", alice.userId, bob.userId);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k.object_key.startsWith(`u/${k.user_id}/assets/`)).toBe(true);
    expect((await h.bindings.MEDIA_BUCKET.list({ prefix: `u/${bob.userId}/` })).objects).toHaveLength(0);
    // D1 holds metadata only: no column of the rendition table contains image bytes.
    const row = await first<Record<string, unknown>>(h.db, "SELECT * FROM media_renditions WHERE user_id = ? AND rendition_id = ?", alice.userId, garmentRendition);
    expect(Object.values(row!).every((v) => v === null || typeof v === "number" || (typeof v === "string" && v.length < 4000))).toBe(true);
  });

  it("stops serving every outstanding URL of a disabled account", async () => {
    const carol = await h.createSyntheticOwner({ displayName: "Synthetic owner C (to be disabled)" });
    await h.upload(carol, { garmentId: "shirt-gold", raster: syntheticShirt({ size: 128 }), demo: true });
    await h.settle(carol);
    const rendition = (await getGarmentMedia(h.rt, carol.principal(), "shirt-gold")).image.renditionId!;
    const token = tokenOf((await signRenditionUrl(h.rt, carol.principal(), rendition)).url);
    expect((await serveSignedMedia(h.rt, token)).status).toBe(200);
    await h.db.prepare("UPDATE users SET status = 'disabled' WHERE user_id = ?").bind(carol.userId).run();
    expect((await serveSignedMedia(h.rt, token)).status).toBe(404);
  });
});

describe("on-demand thumbnails and conversion through the Images binding (local runtime implementation)", () => {
  let h: MediaHarness;
  let owner: TestOwner;
  const images = (env as unknown as { IMAGES: ImagesBinding }).IMAGES;

  beforeAll(async () => {
    h = await createMediaHarness();
    owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (thumbnails)" });
  });

  it("resizes at the fixed widths on demand, stores nothing extra in R2 and purges the cached copy on deletion", async () => {
    expect(h.deps.images).toBeDefined();
    const up = await h.upload(owner, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 400 }), demo: true });
    await h.settle(owner);
    const media = await getGarmentMedia(h.rt, owner.principal(), "shirt-moss");
    const rendition = media.image.renditionId!;
    const before = (await h.bindings.MEDIA_BUCKET.list({ prefix: `u/${owner.userId}/` })).objects.map((o) => o.key).sort();

    const thumb = await openRendition(h.rt, owner.principal(), rendition, { width: 160 });
    expect(thumb.delivery).toBe("resized");
    expect(thumb.contentType).toBe("image/webp");
    expect(probeImage(await bytesOf(thumb.body))).toMatchObject({ format: "webp", width: 160 });
    // A width at or above the stored size returns the stored rendition untouched (never upscaled).
    const full = await openRendition(h.rt, owner.principal(), rendition, { width: 640 });
    expect(full.delivery).toBe("stored");
    await bytesOf(full.body);
    // Thumbnails are not precomputed in R2: the bucket holds exactly what it held before.
    expect((await h.bindings.MEDIA_BUCKET.list({ prefix: `u/${owner.userId}/` })).objects.map((o) => o.key).sort()).toEqual(before);
    // The thumbnail is cached at delivery under a key only this Worker reads.
    const sha = media.image.renditionSha256!;
    const cached = await caches.default.match(thumbnailCacheUrl(owner.userId, sha, 160));
    expect(cached?.headers.get("content-type")).toBe("image/webp");
    await cached?.arrayBuffer();

    // A signed thumbnail URL carries its width and serves the resized image.
    const signed = await signRenditionUrl(h.rt, owner.principal(), rendition, { width: 320 });
    expect(signed.width).toBe(320);
    const res = await serveSignedMedia(h.rt, tokenOf(signed.url));
    expect([res.status, res.headers.get("content-type")]).toEqual([200, "image/webp"]);
    expect(res.headers.get("etag")).toMatch(/-w320"$/);
    expect(probeImage(await bytesOf(res.body))).toMatchObject({ width: 320 });

    // Deletion reaches the cached thumbnails as well as the stored files.
    const receipt = await owner.exec("media.delete_asset", { assetId: up.asset!.assetId });
    await h.settle(owner);
    const purge = await first<{ result_json: string; state: string }>(h.db, "SELECT result_json, state FROM media_jobs WHERE user_id = ? AND job_id = ?", owner.userId, String(receipt.result.purgeJobId));
    expect(purge!.state).toBe("succeeded");
    expect(JSON.parse(purge!.result_json).cacheEntriesPurged).toBeGreaterThanOrEqual(2);
    expect(await caches.default.match(thumbnailCacheUrl(owner.userId, sha, 160))).toBeUndefined();
    expect((await serveSignedMedia(h.rt, tokenOf(signed.url))).status).toBe(404);
    expect((await h.bindings.MEDIA_BUCKET.list({ prefix: `u/${owner.userId}/assets/${up.asset!.assetId}/` })).objects).toHaveLength(0);
  });

  it("purges every cached thumbnail of one owner for account erasure, leaving other owners' alone", async () => {
    const other = await h.createSyntheticOwner({ displayName: "Synthetic owner (thumbnails, kept)" });
    const leaving = await h.createSyntheticOwner({ displayName: "Synthetic owner (thumbnails, erased)" });
    const shas: Record<string, string> = {};
    for (const o of [other, leaving]) {
      await h.upload(o, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 400 }), demo: true });
      await h.settle(o);
      const image = (await getGarmentMedia(h.rt, o.principal(), "shirt-moss")).image;
      shas[o.userId] = image.renditionSha256!;
      for (const width of [160, 320]) await bytesOf((await openRendition(h.rt, o.principal(), image.renditionId!, { width })).body);
    }
    expect(await purgeOwnerMediaCache(h.rt, leaving.userId)).toEqual({ purged: 2 });
    expect(await caches.default.match(thumbnailCacheUrl(leaving.userId, shas[leaving.userId]!, 160))).toBeUndefined();
    expect(await caches.default.match(thumbnailCacheUrl(leaving.userId, shas[leaving.userId]!, 320))).toBeUndefined();
    const kept = await caches.default.match(thumbnailCacheUrl(other.userId, shas[other.userId]!, 160));
    expect(kept).toBeDefined();
    await kept?.arrayBuffer();
    expect(await purgeOwnerMediaCache(h.rt, leaving.userId)).toEqual({ purged: 0 });
  });

  it("keeps a WebP photo as supplied when no converter is configured, and says so", async () => {
    const png = await encodePng(syntheticShirt({ size: 300 }));
    const webp = await bytesOf((await images.input(new Response(png).body!).output({ format: "image/webp", quality: 90 })).image());
    expect(probeImage(webp)).toMatchObject({ format: "webp" });
    const up = await h.upload(owner, { garmentId: "shirt-gold", bytes: webp, contentType: "image/webp", demo: true });
    expect(up.rejected).toBeNull();
    await h.settle(owner);
    const media = await getGarmentMedia(h.rt, owner.principal(), "shirt-gold");
    expect(media.assets[0]!.renditions.map((r) => r.kind)).toEqual(["original"]);
    expect(media.lastFailure).toMatch(/image\/webp photo is stored as supplied; no converter is configured/);

    // With the Images transcoder adapter the same bytes get a cutout and catalogue view, each traceable to the transcode step.
    h.deps.transcoder = createCloudflareImagesTranscoder(images);
    const again = await h.upload(owner, { garmentId: "shirt-slate", bytes: webp, contentType: "image/webp", demo: true });
    await h.settle(owner);
    h.deps.transcoder = undefined;
    const converted = (await getGarmentMedia(h.rt, owner.principal(), "shirt-slate")).assets.find((a) => a.assetId === again.asset!.assetId)!;
    expect(converted.renditions.map((r) => r.kind).sort()).toEqual(["catalogue", "cutout", "mask", "original"]);
    const cutout = converted.renditions.find((r) => r.kind === "cutout")!;
    expect(cutout.transformations[0]).toMatchObject({ step: "transcode", tool: "cloudflare-images", generative: false, params: { from: "image/webp", to: "image/png" } });
    expect(converted.renditions.find((r) => r.kind === "original")).toMatchObject({ contentType: "image/webp", sha256: again.asset!.renditions[0]!.sha256 }); // the original is untouched
  });
});
