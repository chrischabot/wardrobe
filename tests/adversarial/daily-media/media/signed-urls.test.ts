/**
 * Media abuse: signed image URLs and upload authorizations - tampering, expiry and replay.
 *
 * Specification section 11 ("narrowly scoped short-lived URLs; a public calendar link never embeds a
 * permanent bearer URL to a selfie"; "uploads use short-lived authorization, size limits, content
 * validation and an explicit finalization step"), section 15 (signed asset authorization is scoped to one
 * owner).
 *
 * Real: the Worker over HTTP, its signing key, local D1 and the private local R2 bucket. Stand-ins:
 * test-signed sign-in assertions in place of Cloudflare Access. The expiry cases move the clock of the
 * one isolate the Worker and the test share (`Date.now`), forwards only, and put it back; the URL under
 * test is one the Worker really issued. Owners, garments and pictures are SYNTHETIC test fixtures.
 */
import { SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { APP_ORIGIN, testApp } from "@garderobe/worker/testing";
import { cleanJpeg, cleanPng, objectKeys, rows, settleJobs, sha256, syntheticOwner, uploadClean, type AbuseOwner } from "./support.ts";

let owner: AbuseOwner;
let other: AbuseOwner;
let assetId: string;
let original: string;
let derived: string;
let othersRendition: string;
let notFoundBody: string;

const realNow = Date.now;
const advanceClock = (ms: number) => {
  Date.now = () => realNow() + ms;
};
afterEach(() => {
  Date.now = realNow;
});

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4)), (c) => c.charCodeAt(0));
const claimsOf = (token: string) => JSON.parse(new TextDecoder().decode(unb64url(token.split(".")[0]!))) as Record<string, unknown>;
const withClaims = (token: string, patch: Record<string, unknown>) => `${b64url(new TextEncoder().encode(JSON.stringify({ ...claimsOf(token), ...patch })))}.${token.split(".")[1]}`;
const tokenOf = (url: string) => url.split("/").at(-1)!;
const fetchSigned = (token: string) => SELF.fetch(`${APP_ORIGIN}/v1/media/signed/${token}`);

/** A token with valid structure, signed with a key the Worker does not hold. */
async function forgedWithOtherKey(claims: Record<string, unknown>): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("an-attackers-own-key-of-sufficient-length-0123456789"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${body}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))))}`;
}

async function sign(o: AbuseOwner, renditionId: string, body: Record<string, unknown> = {}): Promise<{ url: string; expiresAt: string; token: string }> {
  const signed = await o.owner.api.json("POST", `/v1/media/renditions/${renditionId}/sign`, body);
  return { ...signed, token: tokenOf(signed.url) };
}

async function expectDenied(response: Response, what: string): Promise<void> {
  expect(response.status, what).toBe(404);
  expect(response.headers.get("content-type") ?? "", what).not.toMatch(/^image\//);
  expect(response.headers.get("cache-control"), what).toBe("no-store");
  // One answer for every reason: the refusal says nothing about what exists or why it failed.
  expect(await response.text(), what).toBe(notFoundBody);
}

beforeAll(async () => {
  owner = await syntheticOwner("S");
  other = await syntheticOwner("T");
  const photo = await uploadClean(owner, await cleanPng());
  assetId = photo.assetId;
  original = photo.renditions.find((r) => r.kind === "original")!.rendition_id;
  derived = photo.renditions.find((r) => r.kind !== "original" && r.status === "active")!.rendition_id;
  othersRendition = (await uploadClean(other, await cleanPng(192, [200, 40, 40]))).renditions[0]!.rendition_id;
  notFoundBody = await (await fetchSigned("not-a-token")).text();
});

describe("signed image URLs: tampering", () => {
  it("a genuine URL serves exactly one image, privately, and never names the bucket, a key or the owner", async () => {
    const signed = await sign(owner, derived);
    const served = await fetchSigned(signed.token);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toMatch(/^image\/(png|jpeg|webp)$/);
    expect(served.headers.get("cache-control")).toMatch(/^private, max-age=\d+, no-transform$/);
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(served.headers.get("access-control-allow-origin")).toBeNull();
    await served.arrayBuffer();
    expect(signed.url).not.toMatch(/u\/|assets\/|r2|bucket|https?:/i);
    const claims = claimsOf(signed.token);
    expect(Object.keys(claims).sort()).toEqual(["exp", "p", "r", "u", "w"]);
    expect(claims).toMatchObject({ p: "rendition", r: derived, u: owner.owner.userId });
  });

  it("changing any claim, the signature, or the key invalidates the URL", async () => {
    const signed = await sign(owner, derived, { width: 320 });
    const claims = claimsOf(signed.token);
    const [body, mac] = signed.token.split(".") as [string, string];
    const victimOfOther = await sign(other, othersRendition);
    const attempts: Record<string, string> = {
      "another owner's rendition under this signature": withClaims(signed.token, { r: othersRendition, u: other.owner.userId }),
      "this owner's other rendition": withClaims(signed.token, { r: original }),
      "a different owner": withClaims(signed.token, { u: other.owner.userId }),
      "a later expiry": withClaims(signed.token, { exp: (claims.exp as number) + 86_400 * 365 }),
      "no expiry": withClaims(signed.token, { exp: undefined }),
      "a different width": withClaims(signed.token, { w: 1280 }),
      "the location release added": withClaims(signed.token, { l: 1 }),
      "another purpose": withClaims(signed.token, { p: "composite" }),
      "the signature of another valid token": `${body}.${victimOfOther.token.split(".")[1]}`,
      "the body of another owner's token with this signature": `${victimOfOther.token.split(".")[0]}.${mac}`,
      "a shortened signature": `${body}.${mac.slice(0, -2)}`,
      "an empty signature": `${body}.`,
      "no signature": body,
      "a signature of zeros": `${body}.${b64url(new Uint8Array(32))}`,
      "signed with another key": await forgedWithOtherKey(claims),
      "signed with another key, naming the other owner": await forgedWithOtherKey({ ...claims, u: other.owner.userId, r: othersRendition }),
      "extra path segment": `${signed.token}/../${victimOfOther.token}`,
      "percent-encoded dot": signed.token.replace(".", "%2E%2E"),
      "three parts": `${signed.token}.${mac}`,
      "padded": `${signed.token}==`,
      "very long": `${signed.token}${"A".repeat(5000)}`,
    };
    for (const [what, token] of Object.entries(attempts)) await expectDenied(await fetchSigned(token), what);
    // The untouched URL still works: the refusals above did not revoke or consume anything.
    const again = await fetchSigned(signed.token);
    expect(again.status).toBe(200);
    await again.arrayBuffer();
  });

  it("an upload authorization is not an image URL, and an image URL is not an upload authorization", async () => {
    const bytes = await cleanPng(96);
    const upload = await owner.owner.api.json("POST", "/v1/uploads", { clientUploadId: `purpose-${crypto.randomUUID()}`, intent: "attachment", contentType: "image/png", byteLength: bytes.length });
    const uploadToken = new URL(upload.url, APP_ORIGIN).searchParams.get("token")!;
    await expectDenied(await fetchSigned(uploadToken), "upload token as image URL");
    const imageToken = (await sign(owner, derived)).token;
    const before = await objectKeys(owner.owner.userId);
    const put = await SELF.fetch(`${APP_ORIGIN}/v1/uploads/${upload.uploadId}/content?token=${imageToken}`, { method: "PUT", headers: { "Content-Type": "image/png", "Content-Length": String(bytes.length) }, body: bytes });
    expect(put.status).toBeGreaterThanOrEqual(400);
    expect(put.status).toBeLessThan(500);
    expect(await objectKeys(owner.owner.userId)).toEqual(before);
  });

  it("a URL cannot be asked for longer than the cap, for an unlisted width, or for the photograph with its location", async () => {
    // The request schema refuses more than an hour; within it the server still caps the lifetime at fifteen minutes.
    expect((await owner.owner.api.post(`/v1/media/renditions/${derived}/sign`, { ttlSeconds: 86_400 })).status).toBe(400);
    const long = await sign(owner, derived, { ttlSeconds: 3600 });
    expect(Date.parse(long.expiresAt) - Date.now()).toBeLessThanOrEqual(900_000);
    expect((claimsOf(long.token).exp as number) * 1000 - Date.now()).toBeLessThanOrEqual(900_000);
    for (const body of [{ width: 999 }, { width: -1 }, { ttlSeconds: 5 }, { ttlSeconds: "900" }]) expect((await owner.owner.api.post(`/v1/media/renditions/${derived}/sign`, body)).status, JSON.stringify(body)).toBe(400);
    // Asking for the location release over HTTP is not a thing a request body can switch on.
    const asked = await owner.owner.api.post(`/v1/media/renditions/${original}/sign`, { withLocation: true });
    if (asked.status === 200) expect(claimsOf(tokenOf(((await asked.json()) as { url: string }).url)).l).toBeUndefined();
    else expect(asked.status).toBe(400);
  });
});

describe("signed image URLs: expiry", () => {
  it("a URL the Worker issued stops working when its lifetime ends, and the answer is the same 404", async () => {
    const signed = await sign(owner, derived, { ttlSeconds: 30 });
    const ok = await fetchSigned(signed.token);
    expect(ok.status).toBe(200);
    const maxAge = Number(/max-age=(\d+)/.exec(ok.headers.get("cache-control")!)![1]);
    expect(maxAge).toBeLessThanOrEqual(30); // a device does not keep it past the URL's own life
    await ok.arrayBuffer();

    advanceClock(29_000);
    const nearEnd = await fetchSigned(signed.token);
    expect(nearEnd.status).toBe(200);
    await nearEnd.arrayBuffer();
    advanceClock(31_000);
    await expectDenied(await fetchSigned(signed.token), "one second past expiry");
    // A conditional request does not get a 304 for an expired URL either.
    const etag = ok.headers.get("etag")!;
    await expectDenied(await SELF.fetch(`${APP_ORIGIN}/v1/media/signed/${signed.token}`, { headers: { "If-None-Match": etag } }), "conditional request past expiry");
    advanceClock(86_400_000);
    await expectDenied(await fetchSigned(signed.token), "a day later");
  });

  it("an upload authorization expires too: late bytes are refused and nothing is stored", async () => {
    const bytes = await cleanPng(96);
    const upload = await owner.owner.api.json("POST", "/v1/uploads", { clientUploadId: `late-${crypto.randomUUID()}`, intent: "attachment", contentType: "image/png", byteLength: bytes.length });
    const before = await objectKeys(owner.owner.userId);
    advanceClock(Date.parse(upload.expiresAt) - realNow() + 1000);
    const put = await SELF.fetch(`${APP_ORIGIN}${upload.url}`, { method: "PUT", headers: { "Content-Type": "image/png", "Content-Length": String(bytes.length) }, body: bytes });
    expect(put.status).toBeGreaterThanOrEqual(400);
    expect(put.status).toBeLessThan(500);
    Date.now = realNow;
    expect(await objectKeys(owner.owner.userId)).toEqual(before);
    expect(await rows("SELECT asset_id FROM media_uploads WHERE user_id = ? AND upload_id = ?", owner.owner.userId, upload.uploadId)).toEqual([{ asset_id: null }]);
  });
});

describe("signed image URLs and upload authorizations: replay", () => {
  it("replaying a URL after its image was deleted serves nothing, including a thumbnail that was already fetched", async () => {
    const doomed = await uploadClean(owner, cleanJpeg(192, [30, 120, 60]), { intent: "attachment", declareType: "image/jpeg" });
    const urls: string[] = [];
    for (const r of doomed.renditions.filter((x) => x.status === "active")) {
      for (const body of [{}, { width: 160 }, { width: 640 }]) {
        const signed = await sign(owner, r.rendition_id, { ...body, ttlSeconds: 900 });
        const served = await fetchSigned(signed.token); // fetched once: anything cacheable is now cached
        expect(served.status).toBe(200);
        await served.arrayBuffer();
        urls.push(signed.token);
      }
    }
    expect(urls.length).toBeGreaterThanOrEqual(6);
    const deleted = await owner.owner.api.command("media.delete_asset", { assetId: doomed.assetId });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    // At once, before the background removal has run:
    for (const token of urls) await expectDenied(await fetchSigned(token), "replay straight after deletion");
    await settleJobs(owner.owner.userId);
    for (const token of urls) await expectDenied(await fetchSigned(token), "replay after the files were removed");
    // The bytes are gone from the private bucket, and a new URL cannot be issued for any of its renditions.
    expect((await objectKeys(owner.owner.userId)).filter((k) => k.includes(doomed.assetId))).toEqual([]);
    for (const r of doomed.renditions) expect((await owner.owner.api.post(`/v1/media/renditions/${r.rendition_id}/sign`, {})).status).toBe(404);
  });

  it("replaying an upload authorization after finalization cannot replace the stored photograph", async () => {
    const first = await cleanPng(128, [20, 20, 160]);
    const upload = await owner.owner.api.json("POST", "/v1/uploads", { clientUploadId: `replay-${crypto.randomUUID()}`, intent: "garment_photo", garmentId: owner.garments.bottom.garmentId, contentType: "image/png", byteLength: first.length });
    const put = (bytes: Uint8Array) => SELF.fetch(`${APP_ORIGIN}${upload.url}`, { method: "PUT", headers: { "Content-Type": "image/png", "Content-Length": String(bytes.length) }, body: bytes });
    expect((await put(first)).status).toBe(200);
    const complete = await owner.owner.api.json("POST", `/v1/uploads/${upload.uploadId}/complete`, {});
    expect(complete.state).toBe("finalized");
    await settleJobs(owner.owner.userId);
    const stored = await rows<{ sha256: string; object_key: string }>("SELECT sha256, object_key FROM media_renditions WHERE user_id = ? AND asset_id = ? AND kind = 'original'", owner.owner.userId, complete.asset.assetId);
    expect(stored[0]!.sha256).toBe(await sha256(first));
    const keysBefore = await objectKeys(owner.owner.userId);

    // The same authorization again, still inside its lifetime, with different bytes of the same size class.
    const swapped = (await cleanPng(128, [160, 20, 20])).slice();
    const replay = await put(swapped.length <= first.length ? swapped : first.map((b, i) => (i > 100 && i < 110 ? b ^ 1 : b)));
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(replay.status).toBeLessThan(500);
    // Completing again changes nothing and creates no second asset.
    const again = await owner.owner.api.json("POST", `/v1/uploads/${upload.uploadId}/complete`, {});
    expect(again.asset.assetId).toBe(complete.asset.assetId);
    await settleJobs(owner.owner.userId);
    expect(await objectKeys(owner.owner.userId)).toEqual(keysBefore);
    const app = await testApp();
    const object = await app.env.MEDIA_BUCKET!.get(stored[0]!.object_key);
    expect(await sha256(new Uint8Array(await object!.arrayBuffer()))).toBe(await sha256(first));
    expect(await rows("SELECT 1 FROM media_assets WHERE user_id = ? AND upload_id = ?", owner.owner.userId, upload.uploadId)).toHaveLength(1);
  });

  it("every outstanding URL of an account dies with the account's access", async () => {
    const leaving = await syntheticOwner("L");
    const photo = await uploadClean(leaving, await cleanPng(128));
    const signed = await sign(leaving, photo.renditions.find((r) => r.kind !== "original")!.rendition_id, { ttlSeconds: 900 });
    const ok = await fetchSigned(signed.token);
    expect(ok.status).toBe(200);
    await ok.arrayBuffer();
    const app = await testApp();
    await app.db.prepare("UPDATE users SET status = 'disabled' WHERE user_id = ?").bind(leaving.owner.userId).run();
    await expectDenied(await fetchSigned(signed.token), "disabled account");
    await app.db.prepare("UPDATE users SET status = 'active' WHERE user_id = ?").bind(leaving.owner.userId).run();
  });

  it("the first owner's image is intact after all of the above", async () => {
    const served = await owner.owner.api.get(`/v1/media/assets/${assetId}`);
    expect(served.status).toBe(200);
    await served.arrayBuffer();
  });
});
