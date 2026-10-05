/**
 * Media abuse: files that are not what they claim to be - oversized, mislabelled, polyglot, malformed,
 * decompression bombs - and photographs that carry a location.
 *
 * Specification section 11 ("the backend validates even client-prepared images"; "location metadata is
 * stripped from derivatives"; "a provider receives only the relevant image"), section 17 acceptance row
 * "Image fidelity ... failed edits are rejected".
 *
 * Real: the Worker over HTTP (authorize, PUT, complete), its queue consumer running the real normalization
 * job, local D1 and the private local R2 bucket, the portable export. Stand-ins: test-signed sign-in
 * assertions in place of Cloudflare Access. No Images binding is configured in this run, so the width
 * parameter serves the stored copy; resizing at the edge is a platform check (see README.md).
 *
 * EVERY FILE HERE IS HAND-BUILT TEST DATA on synthetic fixture garments: hostile containers, and Exif,
 * XMP, comment and trailing blocks carrying recognisable markers. No real photograph or position is used.
 *
 * The rule each case holds the Worker to: a hostile file is either refused, or - where only decoding can
 * tell - accepted for processing and then never shown; and whatever IS served decodes as a complete image,
 * is labelled as an image and nothing else, and carries none of the smuggled bytes.
 */
import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { APP_ORIGIN } from "@garderobe/worker/testing";
import { decodeImage, probeImage } from "@garderobe/media/image";
import {
  ascii, attemptUpload, cleanJpeg, cleanPng, concat, deflate, everyServedCopy, exifWithGps, jpegSegment, latin1, objectKeys, pngChunk, pngChunks, pngHeader, PNG_SIGNATURE, rows, settleJobs, syntheticOwner,
  type AbuseOwner, type UploadAttempt,
} from "./support.ts";

let owner: AbuseOwner;
let png: Uint8Array;
let jpg: Uint8Array;

beforeAll(async () => {
  owner = await syntheticOwner("H");
  png = await cleanPng(192);
  jpg = cleanJpeg(192);
});

const MARKERS = ["TEST-SMUGGLED-SCRIPT", "TEST-GPS-XMP-POSITION", "TEST-IPTC-CITY", "TEST-COMMENT-POSITION", "TEST-TRAILING-PAYLOAD", "TEST-TEXT-CHUNK", "TEST-MAKER-NOTE"];
const SCRIPT = ascii("<script>alert('TEST-SMUGGLED-SCRIPT')</script><svg onload=alert(1)>TEST-TRAILING-PAYLOAD");

/** Nothing of the upload exists as an image: no asset row that can be served, no file outside staging, no garment picture. */
async function expectNothingStored(attempt: UploadAttempt, what: string): Promise<void> {
  await settleJobs(owner.owner.userId);
  if (!attempt.uploadId) return;
  const assets = await rows<{ asset_id: string; status: string }>("SELECT asset_id, status FROM media_assets WHERE user_id = ? AND upload_id = ?", owner.owner.userId, attempt.uploadId);
  for (const asset of assets) {
    expect(["rejected", "deleted"], `${what}: asset status`).toContain(asset.status);
    for (const copy of await everyServedCopy(owner, asset.asset_id)) expect(copy.status, `${what}: ${copy.via}`).not.toBe(200);
  }
  const keys = await objectKeys(owner.owner.userId);
  expect(keys.filter((k) => k.endsWith(`/staging/${attempt.uploadId}`)), `${what}: staging`).toEqual([]);
  const status = await owner.owner.api.json("GET", `/v1/uploads/${attempt.uploadId}`);
  expect(status.state === "finalized" && assets.every((a) => a.status !== "rejected"), `${what}: upload reported as a usable image (${JSON.stringify(status)})`).toBe(false);
}

/** Every copy the Worker hands out is a complete, decodable image of a served type, with the image-only headers and none of the markers. */
async function expectOnlySafeCopies(assetId: string, what: string): Promise<number> {
  let served = 0;
  for (const copy of await everyServedCopy(owner, assetId)) {
    if (copy.status !== 200) {
      expect(copy.status, `${what}: ${copy.via}`).toBe(404);
      continue;
    }
    served++;
    expect(copy.contentType, `${what}: ${copy.via}`).toMatch(/^image\/(png|jpeg)$/);
    const probe = probeImage(copy.bytes);
    expect(probe?.contentType, `${what}: ${copy.via} is what it says`).toBe(copy.contentType);
    expect(probe!.exif.hasGps, `${what}: ${copy.via} GPS`).toBe(false);
    const decoded = await decodeImage(copy.bytes); // throws on a truncated or corrupt file
    expect(decoded.raster.width * decoded.raster.height, `${what}: ${copy.via}`).toBeGreaterThan(0);
    const text = latin1(copy.bytes);
    for (const marker of MARKERS) expect(text.includes(marker), `${what}: ${copy.via} carries ${marker}`).toBe(false);
  }
  return served;
}

describe("oversized uploads", () => {
  it("refuses to authorize more than the limit, and nothing is recorded", async () => {
    const before = (await rows("SELECT 1 FROM media_uploads WHERE user_id = ?", owner.owner.userId)).length;
    for (const declareBytes of [20 * 1024 * 1024 + 1, 5_000_000_000, Number.MAX_SAFE_INTEGER]) {
      const attempt = await attemptUpload(owner, png, { declareBytes });
      expect(attempt.authorize.status, String(declareBytes)).toBe(400);
    }
    for (const declareBytes of [0, -5, 1.5]) expect((await attemptUpload(owner, png, { declareBytes })).authorize.status, String(declareBytes)).toBe(400);
    expect((await rows("SELECT 1 FROM media_uploads WHERE user_id = ?", owner.owner.userId)).length).toBe(before);
  });

  it("refuses more bytes than were authorized, however the client declares them, and keeps none", async () => {
    const small = await cleanPng(64);
    // Authorized for the small picture; the large one is sent instead.
    const swapped = await attemptUpload(owner, png, { declareBytes: small.length });
    expect(swapped.put!.status).toBeGreaterThanOrEqual(400);
    expect(swapped.put!.status).toBeLessThan(500);
    expect(swapped.complete!.status).toBeGreaterThanOrEqual(400); // nothing was received, so there is nothing to finalize
    await expectNothingStored(swapped, "more bytes than authorized");

    // No length at all (a streamed body), and a length above the route's own ceiling.
    const auth = await owner.owner.api.json("POST", "/v1/uploads", { clientUploadId: `nolen-${crypto.randomUUID()}`, intent: "attachment", contentType: "image/png", byteLength: small.length });
    const stream = new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(png), c.close()) });
    const streamed = await SELF.fetch(`${APP_ORIGIN}${auth.url}`, { method: "PUT", headers: { "Content-Type": "image/png" }, body: stream, duplex: "half" } as RequestInit);
    expect(streamed.status).toBeGreaterThanOrEqual(400);
    expect(streamed.status).toBeLessThan(500);
    expect((await objectKeys(owner.owner.userId)).filter((k) => k.includes(auth.uploadId))).toEqual([]);
    expect((await owner.owner.api.json("GET", `/v1/uploads/${auth.uploadId}`)).state).toBe("authorized");
  });

  it("refuses a picture whose header declares more pixels than the limit, without decoding it", async () => {
    const idat = pngChunks(png).find((c) => c.type === "IDAT")!.bytes;
    for (const [w, h] of [[60_000, 60_000], [8193, 100], [100, 8193], [6000, 6000], [0xffffffff, 0xffffffff]] as const) {
      const huge = concat(PNG_SIGNATURE, pngHeader(w, h), idat, pngChunk("IEND", new Uint8Array(0)));
      const attempt = await attemptUpload(owner, huge);
      const refusedAtPut = attempt.put!.status >= 400;
      if (!refusedAtPut) {
        expect(attempt.complete!.body.state, `${w}x${h}`).toBe("rejected");
        expect(attempt.complete!.body.asset, `${w}x${h}`).toBeNull();
      }
      await expectNothingStored(attempt, `declared ${w}x${h}`);
      expect(await rows("SELECT 1 FROM media_assets WHERE user_id = ? AND upload_id = ?", owner.owner.userId, attempt.uploadId), `${w}x${h}`).toEqual([]);
    }
    // A JPEG frame header claiming the largest size the format can express.
    const sof = jpg.findIndex((b, i) => b === 0xff && (jpg[i + 1] === 0xc0 || jpg[i + 1] === 0xc2));
    const giant = jpg.slice();
    giant.set([0xff, 0xff, 0xff, 0xff], sof + 5);
    const attempt = await attemptUpload(owner, giant, { declareType: "image/jpeg" });
    await expectNothingStored(attempt, "JPEG declaring 65535x65535");
    expect(await rows("SELECT 1 FROM media_assets WHERE user_id = ? AND upload_id = ?", owner.owner.userId, attempt.uploadId)).toEqual([]);
  });
});

describe("content-type spoofing", () => {
  it("judges a file by its bytes: a mislabelled or non-image file never becomes an image", async () => {
    const html = ascii("<!doctype html><html><body><script>alert('TEST-SMUGGLED-SCRIPT')</script></body></html>");
    const svg = ascii("<svg xmlns='http://www.w3.org/2000/svg' onload=\"alert('TEST-SMUGGLED-SCRIPT')\"><script>1</script></svg>");
    const gif = concat(ascii("GIF89a"), new Uint8Array([192, 0, 192, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, 192, 0, 192, 0, 0, 2, 2, 0x44, 1, 0, 0x3b]));
    const cases: [string, Uint8Array, { declareType?: string; sendType?: string }][] = [
      ["HTML declared as PNG", html, {}],
      ["SVG with script declared as PNG", svg, {}],
      ["SVG declared as JPEG", svg, { declareType: "image/jpeg" }],
      ["JPEG bytes declared as PNG", jpg, {}],
      ["PNG bytes declared as JPEG", png, { declareType: "image/jpeg" }],
      ["GIF bytes declared as PNG", gif, {}],
      ["PNG authorized, sent as text/html", png, { sendType: "text/html" }],
      ["PNG authorized, sent as image/svg+xml", png, { sendType: "image/svg+xml" }],
      ["PNG authorized, sent as image/jpeg", png, { sendType: "image/jpeg" }],
      ["a PNG signature and nothing else", PNG_SIGNATURE, {}],
      ["a PNG signature followed by HTML", concat(PNG_SIGNATURE, html), {}],
      ["a JPEG start marker followed by HTML", concat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), html), { declareType: "image/jpeg" }],
      ["a WebP container holding no picture", concat(ascii("RIFF"), new Uint8Array([40, 0, 0, 0]), ascii("WEBPJUNK"), new Uint8Array(32)), { declareType: "image/webp" }],
      ["an executable header declared as PNG", concat(ascii("MZ"), new Uint8Array(200)), {}],
      ["a ZIP declared as PNG", concat(ascii("PK\x03\x04"), new Uint8Array(200)), {}],
    ];
    for (const [what, bytes, opts] of cases) {
      const attempt = await attemptUpload(owner, bytes, opts);
      expect(attempt.authorize.status, what).toBe(200);
      expect(attempt.put!.status, `${what}: PUT`).toBeGreaterThanOrEqual(400);
      expect(attempt.put!.status, `${what}: PUT`).toBeLessThan(500);
      await expectNothingStored(attempt, what);
      expect(await rows("SELECT 1 FROM media_assets WHERE user_id = ? AND upload_id = ?", owner.owner.userId, attempt.uploadId), what).toEqual([]);
    }
    // Types that are never accepted cannot even be authorized.
    for (const declareType of ["image/svg+xml", "image/gif", "text/html", "application/octet-stream", "image/png; charset=utf-8", "IMAGE/PNG", ""]) {
      expect((await attemptUpload(owner, png, { declareType })).authorize.status, declareType).toBe(400);
    }
  });

  it("serves a stored image under the type of its bytes with the image-only headers, whatever the request asks for", async () => {
    const attempt = await attemptUpload(owner, png, { role: "bottom" });
    expect(attempt.complete!.body.state).toBe("finalized");
    await settleJobs(owner.owner.userId);
    const assetId = attempt.complete!.body.asset.assetId as string;
    for (const accept of ["text/html", "image/svg+xml", "*/*", "application/javascript"]) {
      const served = await owner.owner.api.get(`/v1/media/assets/${assetId}`, { Accept: accept });
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toMatch(/^image\/(png|jpeg)$/);
      expect(served.headers.get("x-content-type-options")).toBe("nosniff");
      expect(served.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
      expect(served.headers.get("content-disposition")).toBe("inline");
      expect(served.headers.get("cache-control")).toMatch(/^private/);
      await served.arrayBuffer();
    }
    expect(await expectOnlySafeCopies(assetId, "clean PNG")).toBeGreaterThan(3);
  });
});

describe("polyglot files", () => {
  it("a real picture with a script, an archive or a second file attached never serves the attached part", async () => {
    const chunks = pngChunks(png);
    const withText = concat(PNG_SIGNATURE, chunks[0]!.bytes, pngChunk("tEXt", ascii("Comment\0<script>TEST-TEXT-CHUNK</script>")), pngChunk("iTXt", ascii("XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta>TEST-GPS-XMP-POSITION</x:xmpmeta>")), ...chunks.slice(1).map((c) => c.bytes));
    const cases: [string, Uint8Array, string][] = [
      ["PNG followed by a script", concat(png, SCRIPT), "image/png"],
      ["PNG followed by a ZIP archive", concat(png, ascii("PK\x03\x04"), new Uint8Array(64), ascii("TEST-TRAILING-PAYLOAD")), "image/png"],
      ["PNG with script in text chunks", withText, "image/png"],
      ["PNG followed by a whole JPEG", concat(png, jpg, ascii("TEST-TRAILING-PAYLOAD")), "image/png"],
      ["JPEG followed by a script", concat(jpg, SCRIPT), "image/jpeg"],
      ["JPEG with a script in a comment and an application segment", concat(jpg.subarray(0, 2), jpegSegment(0xfe, concat(ascii("TEST-COMMENT-POSITION"), SCRIPT)), jpegSegment(0xec, concat(ascii("TEST-MAKER-NOTE"), SCRIPT)), jpg.subarray(2)), "image/jpeg"],
      ["JPEG followed by a whole PNG", concat(jpg, png, ascii("TEST-TRAILING-PAYLOAD")), "image/jpeg"],
    ];
    for (const [what, bytes, declareType] of cases) {
      const attempt = await attemptUpload(owner, bytes, { declareType, role: "footwear" });
      if (attempt.complete?.body?.asset) {
        await settleJobs(owner.owner.userId);
        const assetId = attempt.complete.body.asset.assetId as string;
        // It is a real picture, so it is kept and shown - without what was attached to it.
        expect(await expectOnlySafeCopies(assetId, what), what).toBeGreaterThan(0);
        // Every stored DERIVED file was written from pixels: none carries the attachment either.
        const app = await (await import("@garderobe/worker/testing")).testApp();
        for (const r of await rows<{ object_key: string; kind: string }>("SELECT object_key, kind FROM media_renditions WHERE user_id = ? AND asset_id = ? AND kind != 'original' AND status = 'active'", owner.owner.userId, assetId)) {
          const text = latin1(new Uint8Array(await (await app.env.MEDIA_BUCKET!.get(r.object_key))!.arrayBuffer()));
          for (const marker of MARKERS) expect(text.includes(marker), `${what}: stored ${r.kind} carries ${marker}`).toBe(false);
        }
      } else {
        await expectNothingStored(attempt, what);
      }
    }
  });
});

describe("malformed images", () => {
  it("a file that only looks like an image from its header is never shown, and leaves the garment honestly without a picture", async () => {
    const chunks = pngChunks(png);
    const idat = chunks.find((c) => c.type === "IDAT")!.bytes;
    const idatBody = idat.subarray(8, idat.length - 4);
    const garbage = new Uint8Array(idatBody.length).map((_, i) => (i * 131 + 17) & 0xff);
    const sos = jpg.findIndex((b, i) => b === 0xff && jpg[i + 1] === 0xda);
    const cases: [string, Uint8Array, string][] = [
      ["PNG cut off in the middle of its data", png.subarray(0, Math.floor(png.length * 0.6)), "image/png"],
      ["PNG without its end chunk", png.subarray(0, png.length - 12), "image/png"],
      ["PNG whose data fails its checksum", concat(PNG_SIGNATURE, chunks[0]!.bytes, pngChunk("IDAT", idatBody, { badCrc: true }), pngChunk("IEND", new Uint8Array(0))), "image/png"],
      ["PNG whose data is noise", concat(PNG_SIGNATURE, chunks[0]!.bytes, pngChunk("IDAT", garbage), pngChunk("IEND", new Uint8Array(0))), "image/png"],
      ["PNG with no data at all", concat(PNG_SIGNATURE, chunks[0]!.bytes, pngChunk("IEND", new Uint8Array(0))), "image/png"],
      ["PNG with an empty data chunk", concat(PNG_SIGNATURE, chunks[0]!.bytes, pngChunk("IDAT", new Uint8Array(0)), pngChunk("IEND", new Uint8Array(0))), "image/png"],
      ["PNG with an impossible colour type", concat(PNG_SIGNATURE, pngHeader(192, 192, 7, 8), idat, pngChunk("IEND", new Uint8Array(0))), "image/png"],
      ["PNG holding less data than its size needs", concat(PNG_SIGNATURE, pngHeader(1024, 1024), idat, pngChunk("IEND", new Uint8Array(0))), "image/png"],
      ["JPEG headers followed by noise", concat(jpg.subarray(0, sos + 14), garbage), "image/jpeg"],
      ["JPEG headers and no picture data", concat(jpg.subarray(0, sos), new Uint8Array([0xff, 0xd9])), "image/jpeg"],
    ];
    for (const [what, bytes, declareType] of cases) {
      const attempt = await attemptUpload(owner, bytes, { declareType, role: "socks" });
      expect(attempt.authorize.status, what).toBe(200);
      await settleJobs(owner.owner.userId);
      const assets = await rows<{ asset_id: string; status: string }>("SELECT asset_id, status FROM media_assets WHERE user_id = ? AND upload_id = ?", owner.owner.userId, attempt.uploadId);
      // Either it never became an asset, or decoding found it out and it is marked unusable.
      for (const asset of assets) {
        expect(asset.status, what).toBe("rejected");
        for (const copy of await everyServedCopy(owner, asset.asset_id)) expect(copy.status, `${what}: ${copy.via}`).toBe(404);
      }
      // No job is left running or queued behind it, and none was retried without end.
      const jobs = await rows<{ state: string; attempts: number }>("SELECT state, attempts FROM media_jobs WHERE user_id = ? AND subject_id IN (SELECT asset_id FROM media_assets WHERE user_id = ? AND upload_id = ?)", owner.owner.userId, owner.owner.userId, attempt.uploadId);
      for (const job of jobs) {
        expect(["succeeded", "dead", "failed"], what).toContain(job.state);
        expect(job.attempts, what).toBeLessThanOrEqual(3);
      }
    }
    // The garment these were sent for has no picture, and says so; nothing was invented in its place.
    const item = await owner.owner.api.get(`/v1/items/${owner.garments.socks.garmentId}/image`);
    expect(item.status).toBe(404);
    expect(((await item.json()) as any).error.details.missingImageNote).toBe("No photo yet");
    const detail = await owner.owner.api.json("GET", `/v1/items/${owner.garments.socks.garmentId}`);
    expect(detail.media.image).toMatchObject({ hasRealImage: false, renditionId: null });
    // Only immutable originals of rejected uploads may remain until their removal; no derived file was written from them.
    const derived = (await objectKeys(owner.owner.userId)).filter((k) => /\/(display|cutout|mask|catalogue)-v/.test(k));
    const fromRejected = await rows<{ asset_id: string }>("SELECT asset_id FROM media_assets WHERE user_id = ? AND status = 'rejected'", owner.owner.userId);
    for (const a of fromRejected) expect(derived.filter((k) => k.includes(a.asset_id)), a.asset_id).toEqual([]);
  });

  it("refuses animated pictures and pictures too small to be a photograph", async () => {
    const chunks = pngChunks(png);
    const animated = concat(PNG_SIGNATURE, chunks[0]!.bytes, pngChunk("acTL", new Uint8Array([0, 0, 0, 2, 0, 0, 0, 0])), ...chunks.slice(1).map((c) => c.bytes));
    for (const [what, bytes] of [["animated PNG", animated], ["a one-pixel picture", await cleanPng(1)], ["a 32-pixel picture", await cleanPng(32)]] as const) {
      const attempt = await attemptUpload(owner, bytes);
      if (attempt.put!.status < 400) expect(attempt.complete!.body.state, what).toBe("rejected");
      await expectNothingStored(attempt, what);
      expect(await rows("SELECT 1 FROM media_assets WHERE user_id = ? AND upload_id = ?", owner.owner.userId, attempt.uploadId), what).toEqual([]);
    }
  });
});

describe("decompression bombs", () => {
  it("a small file that inflates far beyond what its header declares is stopped while inflating and never shown", async () => {
    // 200x200 declared (160 KB of scanlines); the data inflates to 48 MB of zeros from about 47 KB.
    const bomb = concat(PNG_SIGNATURE, pngHeader(200, 200), pngChunk("IDAT", await deflate(new Uint8Array(48 * 1024 * 1024))), pngChunk("IEND", new Uint8Array(0)));
    expect(bomb.length).toBeLessThan(200_000);
    const started = Date.now();
    const attempt = await attemptUpload(owner, bomb, { role: "top" });
    await settleJobs(owner.owner.userId);
    expect(Date.now() - started).toBeLessThan(30_000);
    const assets = await rows<{ asset_id: string; status: string; status_reason: string | null }>("SELECT asset_id, status, status_reason FROM media_assets WHERE user_id = ? AND upload_id = ?", owner.owner.userId, attempt.uploadId);
    for (const asset of assets) {
      expect(asset.status).toBe("rejected");
      for (const copy of await everyServedCopy(owner, asset.asset_id)) expect(copy.status, copy.via).toBe(404);
    }
    const jobs = await rows<{ state: string; attempts: number }>("SELECT state, attempts FROM media_jobs WHERE user_id = ? AND subject_id IN (SELECT asset_id FROM media_assets WHERE user_id = ? AND upload_id = ?)", owner.owner.userId, owner.owner.userId, attempt.uploadId);
    // Found out on the first attempt and not retried: a bomb is not a transient fault.
    for (const job of jobs) expect(job).toMatchObject({ state: "succeeded", attempts: 1 });
    expect((await owner.owner.api.get(`/v1/items/${owner.garments.top.garmentId}/image`)).status).toBe(404);
  });

  it("a tiny file declaring an enormous canvas is refused from its header alone", async () => {
    const tiny = await deflate(new Uint8Array(1024));
    for (const [w, h] of [[50_000, 50_000], [8192, 8192], [5001, 5000]] as const) {
      const bomb = concat(PNG_SIGNATURE, pngHeader(w, h, 0, 1), pngChunk("IDAT", tiny), pngChunk("IEND", new Uint8Array(0)));
      const attempt = await attemptUpload(owner, bomb);
      if (attempt.put!.status < 400) expect(attempt.complete!.body.state, `${w}x${h}`).toBe("rejected");
      await expectNothingStored(attempt, `${w}x${h}`);
      expect(await rows("SELECT 1 FROM media_assets WHERE user_id = ? AND upload_id = ?", owner.owner.userId, attempt.uploadId)).toEqual([]);
    }
  });

  it("the Worker still serves and processes ordinary pictures afterwards", async () => {
    const attempt = await attemptUpload(owner, await cleanPng(160, [90, 60, 20]), { intent: "attachment" });
    expect(attempt.complete!.body.state).toBe("finalized");
    await settleJobs(owner.owner.userId);
    expect(await expectOnlySafeCopies(attempt.complete!.body.asset.assetId, "after the bombs")).toBeGreaterThan(0);
  });
});

describe("EXIF and location leakage", () => {
  /** TEST DATA: everything a camera file can carry about where it was taken. */
  const located = (base: Uint8Array) =>
    concat(
      base.subarray(0, 2),
      jpegSegment(0xe1, exifWithGps(1)),
      jpegSegment(0xe1, ascii("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta exif:GPSLatitude='TEST-GPS-XMP-POSITION'/>")),
      jpegSegment(0xed, ascii("Photoshop 3.0\0TEST-IPTC-CITY")),
      jpegSegment(0xec, ascii("TEST-MAKER-NOTE")),
      jpegSegment(0xfe, ascii("TEST-COMMENT-POSITION")),
      base.subarray(2),
      ascii("TEST-TRAILING-PAYLOAD"),
    );

  it("a photograph taken with a position is stored, and no copy that leaves the service says where: garment photo, selfie, attachment", async () => {
    const file = located(jpg);
    expect(probeImage(file)!.exif.hasGps).toBe(true); // the test file really carries a GPS pointer
    const uploads: [string, Parameters<typeof attemptUpload>[2]][] = [
      ["garment photo", { declareType: "image/jpeg", role: "top" }],
      ["selfie", { declareType: "image/jpeg", intent: "selfie", wearingDate: new Date().toISOString().slice(0, 10) }],
      ["attachment", { declareType: "image/jpeg", intent: "attachment" }],
    ];
    const assetIds: string[] = [];
    for (const [what, opts] of uploads) {
      const attempt = await attemptUpload(owner, file, opts);
      expect(attempt.complete!.body.state, `${what}: ${JSON.stringify(attempt.complete)}`).toBe("finalized");
      await settleJobs(owner.owner.userId);
      const assetId = attempt.complete!.body.asset.assetId as string;
      assetIds.push(assetId);
      // The record is truthful about what arrived...
      expect(await rows("SELECT had_location_metadata FROM media_assets WHERE user_id = ? AND asset_id = ?", owner.owner.userId, assetId), what).toEqual([{ had_location_metadata: 1 }]);
      // ...and no served copy carries any of it, including the full-size original and every signed URL.
      expect(await expectOnlySafeCopies(assetId, what), what).toBeGreaterThan(1);
      // No request parameter turns the release on.
      for (const query of ["?variant=original&withLocation=true", "?variant=original&withLocation=1", "?variant=original&asSupplied=true", "?variant=original&l=1"]) {
        const served = await owner.owner.api.get(`/v1/media/assets/${assetId}${query}`);
        const bytes = new Uint8Array(await served.arrayBuffer());
        if (served.status === 200) {
          expect(probeImage(bytes)!.exif.hasGps, query).toBe(false);
          for (const marker of MARKERS) expect(latin1(bytes).includes(marker), `${query} ${marker}`).toBe(false);
        } else expect(served.status, query).toBe(400);
      }
    }

    // An outfit preview drawn from the garment photo carries nothing of it either.
    const preview = await owner.owner.api.json("POST", "/v1/studio/previews", { clientRequestId: `located-${crypto.randomUUID()}`, slots: owner.slots() });
    await settleJobs(owner.owner.userId);
    const picture = await owner.owner.api.get(`/v1/studio/compositions/${preview.manifestHash}/preview`);
    expect(picture.status).toBe(200);
    const pictureBytes = new Uint8Array(await picture.arrayBuffer());
    await decodeImage(pictureBytes);
    const composition = JSON.stringify(await owner.owner.api.json("GET", `/v1/studio/compositions/${preview.manifestHash}`));
    for (const marker of MARKERS) {
      expect(latin1(pictureBytes).includes(marker), marker).toBe(false);
      expect(composition.includes(marker), marker).toBe(false);
    }

    // Nothing the API says about these images repeats the metadata.
    const said = JSON.stringify([await owner.owner.api.json("GET", `/v1/items/${owner.garments.top.garmentId}`), await owner.owner.api.json("GET", "/v1/studio?mode=explore"), await owner.owner.api.json("GET", "/v1/media/review")]);
    for (const marker of MARKERS) expect(said.includes(marker), marker).toBe(false);

    // The portable export holds the pictures without their location.
    const requested = await owner.owner.api.json("POST", "/v1/exports", { clientRequestId: `located-export-${crypto.randomUUID()}` });
    let job = requested;
    for (let i = 0; i < 300 && ["queued", "running"].includes(job.state); i++) {
      await new Promise((r) => setTimeout(r, 100));
      job = await owner.owner.api.json("GET", `/v1/exports/${requested.exportId}`);
    }
    expect(job.state, JSON.stringify(job).slice(0, 400)).toBe("completed");
    const ticket = await owner.owner.api.json("POST", `/v1/exports/${requested.exportId}/ticket`, {});
    const files = unzipSync(new Uint8Array(await (await SELF.fetch(`${APP_ORIGIN}${ticket.url}`)).arrayBuffer()));
    const images = Object.entries(files).filter(([path]) => path.startsWith("media/"));
    expect(images.filter(([path]) => assetIds.some((id) => path.includes(id))).length).toBeGreaterThanOrEqual(assetIds.length);
    for (const [path, bytes] of Object.entries(files)) {
      const text = latin1(bytes);
      for (const marker of MARKERS) expect(text.includes(marker), `${path} carries ${marker}`).toBe(false);
      if (path.startsWith("media/") && /\.(jpg|png)$/.test(path)) expect(probeImage(bytes)?.exif.hasGps ?? false, path).toBe(false);
    }
  });
});
