import { beforeAll, describe, expect, it } from "vitest";
import { all, isCommandError } from "@garderobe/domain";
import { authorizeUpload, finalizeUpload, getGarmentMedia, getUploadStatus, mintUploadAuthorization, openAssetImage, openRendition, receiveUploadContent, serveSignedMedia, signRenditionUrl } from "../src/index.ts";
import { encodePng } from "../src/image/index.ts";
import { createMediaHarness, syntheticShirt, type MediaHarness } from "../src/testing/index.ts";
import type { TestOwner } from "@garderobe/domain/testing";

// All images are SYNTHETIC TEST IMAGES attached to synthetic fixture garments.

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return isCommandError(e) ? e.code : `threw:${String(e)}`;
  }
}

function tokenOf(url: string): string {
  return new URLSearchParams(url.split("?")[1]).get("token")!;
}

describe("uploads and private delivery (real local R2)", () => {
  let h: MediaHarness;
  let alice: TestOwner;
  let bob: TestOwner;
  let png: Uint8Array;

  beforeAll(async () => {
    h = await createMediaHarness();
    alice = await h.createSyntheticOwner({ displayName: "Synthetic owner A" });
    bob = await h.createSyntheticOwner({ displayName: "Synthetic owner B" });
    png = await encodePng(syntheticShirt({ size: 200 }));
  });

  it("authorizes, receives into staging, and creates no asset until finalization", async () => {
    const { receipt, authorization } = await authorizeUpload(h.rt, alice.principal(), { intent: "garment_photo", garmentId: "shirt-moss", contentType: "image/png", byteLength: png.length, demo: true, idempotencyKey: "idem-key-up-1" });
    expect(receipt.type).toBe("media.authorize_upload");
    expect(authorization.maxBytes).toBe(png.length);
    expect(JSON.stringify(receipt)).not.toContain(tokenOf(authorization.url)); // the token is never in the ledger
    await receiveUploadContent(h.rt, { uploadId: authorization.uploadId, token: tokenOf(authorization.url), body: png, contentLength: png.length, contentType: "image/png" });

    // Unfinalized bytes are not evidence: no asset, no rendition, nothing on the garment.
    expect(await all(h.db, "SELECT 1 FROM media_assets WHERE user_id = ?", alice.userId)).toHaveLength(0);
    expect((await getGarmentMedia(h.rt, alice.principal(), "shirt-moss")).image).toMatchObject({ hasRealImage: false, renditionId: null, missingImageNote: "No photo yet" });
    expect((await h.bindings.MEDIA_BUCKET.list({ prefix: `u/${alice.userId}/` })).objects.map((o) => o.key)).toEqual([`u/${alice.userId}/staging/${authorization.uploadId}`]);

    const done = await finalizeUpload(h.rt, alice.principal(), authorization.uploadId);
    expect(done.rejected).toBeNull();
    expect(done.receipt.outcome).toBe("committed");
    expect(done.asset).toMatchObject({ kind: "owner_photo", isDemo: true, displayLabel: "Demo placeholder", usableAsEvidence: false });
    expect(done.asset!.renditions.map((r) => r.kind)).toEqual(["original"]);
    expect(done.asset!.renditions[0]!.sourceRenditionId).toBeNull();
    // D1 holds metadata only; the bytes are in R2 under the owner's prefix.
    const object = await h.bindings.MEDIA_BUCKET.get(`u/${alice.userId}/assets/${done.asset!.assetId}/original-${done.asset!.renditions[0]!.sha256.slice(0, 16)}.png`);
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(png);
    expect(await getUploadStatus(h.rt, alice.principal(), authorization.uploadId)).toMatchObject({ state: "finalized", assetId: done.asset!.assetId });
    // Finalizing again changes nothing.
    expect((await finalizeUpload(h.rt, alice.principal(), authorization.uploadId, { idempotencyKey: "idem-key-again" })).receipt.outcome).toBe("noop");
    await h.settle(alice);
  });

  it("refuses another owner's upload at every step", async () => {
    const { authorization } = await authorizeUpload(h.rt, alice.principal(), { intent: "garment_photo", garmentId: "shirt-gold", contentType: "image/png", byteLength: png.length, demo: true, idempotencyKey: "idem-key-up-2" });
    const token = tokenOf(authorization.url);
    // Bob cannot mint a token for, send bytes to, read the status of, or finalize Alice's upload.
    expect(await code(mintUploadAuthorization(h.rt, bob.principal(), authorization.uploadId))).toBe("not_found");
    expect(await code(receiveUploadContent(h.rt, { uploadId: authorization.uploadId, token, body: png, contentLength: png.length, contentType: "image/png", principal: bob.principal() }))).toBe("forbidden");
    expect(await code(getUploadStatus(h.rt, bob.principal(), authorization.uploadId))).toBe("not_found");
    await receiveUploadContent(h.rt, { uploadId: authorization.uploadId, token, body: png, contentLength: png.length, contentType: "image/png" });
    expect(await code(finalizeUpload(h.rt, bob.principal(), authorization.uploadId))).toBe("not_found");
    expect(await all(h.db, "SELECT 1 FROM media_assets WHERE user_id = ?", bob.userId)).toHaveLength(0);
    // A request body cannot choose the owner: Bob authorizing for Alice's colliding garment ID gets his own garment.
    const mine = await authorizeUpload(h.rt, bob.principal(), { intent: "garment_photo", garmentId: "shirt-gold", contentType: "image/png", byteLength: png.length, demo: true, idempotencyKey: "idem-key-up-bob" });
    expect((await all<{ user_id: string }>(h.db, "SELECT user_id FROM media_uploads WHERE upload_id = ?", mine.authorization.uploadId))[0]!.user_id).toBe(bob.userId);
    await finalizeUpload(h.rt, alice.principal(), authorization.uploadId);
    await h.settle(alice);
  });

  it("rejects tampered, expired, oversized and mistyped uploads", async () => {
    const start = async (key: string, bytes = png.length) => (await authorizeUpload(h.rt, alice.principal(), { intent: "garment_photo", garmentId: "shirt-slate", contentType: "image/png", byteLength: bytes, demo: true, idempotencyKey: key })).authorization;
    const a = await start("idem-key-bad-1");
    const token = tokenOf(a.url);
    const send = (t: string, body: Uint8Array, type = "image/png", id = a.uploadId) => code(receiveUploadContent(h.rt, { uploadId: id, token: t, body, contentLength: body.length, contentType: type }));
    expect(await send(`${token.slice(0, -2)}xx`, png)).toBe("forbidden"); // signature
    const [body, mac] = token.split(".");
    const forged = `${btoa(atob(body!.replace(/-/g, "+").replace(/_/g, "/")).replace(alice.userId, bob.userId)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.${mac}`;
    expect(await send(forged, png)).toBe("forbidden"); // claims edited to another owner
    expect(await send(token, png, "image/jpeg")).toBe("invalid_command"); // declared type
    expect(await send(token, new Uint8Array([...png, 1, 2, 3]))).toBe("invalid_command"); // larger than authorized
    expect(await send(token, new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>"))).toBe("invalid_command"); // not an image
    const other = await start("idem-key-bad-2");
    expect(await send(token, png, "image/png", other.uploadId)).toBe("forbidden"); // token for a different upload
    // A stream that lies about its length is cut off at the authorized size.
    const big = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(png); c.enqueue(png); c.close(); } });
    expect(await code(receiveUploadContent(h.rt, { uploadId: a.uploadId, token, body: big, contentLength: null, contentType: "image/png" }))).toBe("invalid_command");
    expect(await code(finalizeUpload(h.rt, alice.principal(), a.uploadId))).toBe("precondition_failed"); // nothing was received

    h.clock.advanceMinutes(11);
    expect(await send(token, png)).toBe("forbidden"); // expired
    expect((await getUploadStatus(h.rt, alice.principal(), a.uploadId)).state).toBe("expired");
    expect(await code(authorizeUpload(h.rt, alice.principal(), { intent: "garment_photo", garmentId: "shirt-slate", contentType: "image/png", byteLength: 500 * 1024 * 1024, idempotencyKey: "idem-key-huge" }))).toBe("invalid_command");
  });

  it("records a rejection when finalized content is not what was declared", async () => {
    const { authorization } = await authorizeUpload(h.rt, alice.principal(), { intent: "garment_photo", garmentId: "shirt-slate", contentType: "image/png", byteLength: 64, demo: true, idempotencyKey: "idem-key-swap-1" });
    // Bytes placed in staging by another route (a storage event, a bug) are still validated at finalization.
    await h.bindings.MEDIA_BUCKET.put(`u/${alice.userId}/staging/${authorization.uploadId}`, new TextEncoder().encode("GIF89a-this-is-not-a-png-at-all-padding-padding-padding"));
    const done = await finalizeUpload(h.rt, alice.principal(), authorization.uploadId);
    expect(done.asset).toBeNull();
    expect(done.rejected).toMatch(/not a recognised image|declared/);
    expect(done.receipt.summary).toMatch(/^Upload rejected/);
    expect(await getUploadStatus(h.rt, alice.principal(), authorization.uploadId)).toMatchObject({ state: "rejected", assetId: null });
    expect(await h.bindings.MEDIA_BUCKET.head(`u/${alice.userId}/staging/${authorization.uploadId}`)).toBeNull();
  });

  it("never lets a demo placeholder onto a real garment", async () => {
    const real = await h.createOwner({ synthetic: false, displayName: "Non-synthetic owner (test)" });
    await real.exec("garment.create", { garmentId: "real-shirt", name: "a real shirt (test record)", category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, source: { kind: "system", note: "test record" } });
    expect(await code(authorizeUpload(h.rt, real.principal(), { intent: "garment_photo", garmentId: "real-shirt", contentType: "image/png", byteLength: png.length, demo: true, idempotencyKey: "idem-key-demo-on-real" }))).toBe("forbidden");
    expect((await getGarmentMedia(h.rt, real.principal(), "real-shirt")).image).toMatchObject({ hasRealImage: false, missingImageNote: "No photo yet", assetId: null });
  });

  it("serves images only to their owner: authenticated reads and expiring, single-rendition signed URLs", async () => {
    const media = await getGarmentMedia(h.rt, alice.principal(), "shirt-moss");
    const renditionId = media.image.renditionId!;
    const assetId = media.image.assetId!;
    const read = await openRendition(h.rt, alice.principal(), renditionId);
    expect((await new Response(read.body).arrayBuffer()).byteLength).toBeGreaterThan(100);
    expect(await code(openRendition(h.rt, bob.principal(), renditionId))).toBe("not_found");
    expect(await code(openAssetImage(h.rt, bob.principal(), assetId))).toBe("not_found");
    expect(await code(signRenditionUrl(h.rt, bob.principal(), renditionId))).toBe("not_found");
    expect(await code(openRendition(h.rt, alice.principal(), renditionId, { width: 123 }))).toBe("invalid_command"); // fixed widths only

    const signed = await signRenditionUrl(h.rt, alice.principal(), renditionId, { ttlSeconds: 99999 });
    expect(Date.parse(signed.expiresAt) - h.clock.now()).toBeLessThanOrEqual(900_000); // clamped to 15 minutes
    expect(signed.url).not.toContain(alice.userId === "" ? "x" : `u/${alice.userId}`); // no bucket key in the URL
    const token = signed.url.split("/").pop()!;
    const ok = await serveSignedMedia(h.rt, token);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toMatch(/^private, max-age=\d+/);
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    await ok.arrayBuffer();
    expect((await serveSignedMedia(h.rt, token, new Request("https://x.test/", { headers: { "if-none-match": ok.headers.get("etag")! } }))).status).toBe(304);

    // Tampering, a token of another purpose and expiry all give the same detail-free 404.
    const [claims, mac] = token.split(".");
    const swapped = btoa(atob(claims!.replace(/-/g, "+").replace(/_/g, "/")).replace(alice.userId, bob.userId)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    for (const bad of [`${swapped}.${mac}`, `${claims}.${mac!.slice(0, -3)}AAA`, "garbage", ""]) {
      const res = await serveSignedMedia(h.rt, bad);
      expect([res.status, await res.text()]).toEqual([404, "Not found"]);
    }
    h.clock.advanceMinutes(16);
    expect((await serveSignedMedia(h.rt, token)).status).toBe(404);
  });

  it("stops serving a signed URL once the image is deleted or the account is disabled", async () => {
    const media = await getGarmentMedia(h.rt, alice.principal(), "shirt-gold");
    const token = (await signRenditionUrl(h.rt, alice.principal(), media.image.renditionId!)).url.split("/").pop()!;
    expect((await serveSignedMedia(h.rt, token)).status).toBe(200);
    const receipt = await alice.exec("media.delete_asset", { assetId: media.image.assetId });
    expect(receipt.undo.available).toBe(false);
    expect((await serveSignedMedia(h.rt, token)).status).toBe(404);
    await h.settle(alice);
    // Deletion reached the bytes: nothing of that asset is left in the bucket.
    expect((await h.bindings.MEDIA_BUCKET.list({ prefix: `u/${alice.userId}/assets/${media.image.assetId}/` })).objects).toHaveLength(0);
    expect((await getGarmentMedia(h.rt, alice.principal(), "shirt-gold")).image.hasRealImage).toBe(false);
  });
});
