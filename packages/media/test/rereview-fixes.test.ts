import { describe, expect, it } from "vitest";
import { all, first, isCommandError } from "@garderobe/domain";
import {
  createPurchaseLinkProvider, evaluateCandidate, getAsset, getMediaStorageStatus, isPrivateAddress, openAssetImage, openRendition, requestCompositePreview, runMediaMaintenance, safeFetch, serveSignedMedia,
  signRenditionUrl,
} from "../src/index.ts";
import { extractProductPage } from "../src/pipeline/purchase-link.ts";
import { parseIpv6 } from "../src/pipeline/safe-fetch.ts";
import { encodeJpeg, probeImage } from "../src/image/index.ts";
import { createMediaHarness, syntheticShirt, syntheticTrousers, type MediaHarness } from "../src/testing/index.ts";

// Regression tests for the second independent review of this package (findings N1 to N5, at commit d48a2c6a).
// SYNTHETIC TEST IMAGES AND FIXTURE PAGES: no real page, resolver or photograph is involved.

const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (isCommandError(e) ? e.code : `threw:${String(e)}`));
const tokenOf = (url: string) => url.split("/").pop()!;
const bytesOf = async (b: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(b).arrayBuffer());
const keysOf = async (h: MediaHarness, o: { userId: string }, sub = "") => (await h.bindings.MEDIA_BUCKET.list({ prefix: `u/${o.userId}/${sub}` })).objects.map((x) => x.key);

/** A JPEG carrying an Exif block with a GPS pointer (as a phone camera writes). */
function gpsTagged(jpg: Uint8Array): Uint8Array {
  const tiff = new Uint8Array(8 + 2 + 12 + 4 + 6);
  const v = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
  v.setUint16(8, 1, true);
  v.setUint16(10, 0x8825, true);
  v.setUint16(12, 4, true);
  v.setUint32(14, 1, true);
  v.setUint32(18, 26, true);
  const body = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]);
  return new Uint8Array([...jpg.subarray(0, 2), 0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body, ...jpg.subarray(2)]);
}

describe("re-review N1: a disabled account's queued work cannot hold up the sweep", () => {
  it("another owner's deletion is completed by the first sweep although a disabled account has more queued jobs than the sweep takes", async () => {
    const h = await createMediaHarness();
    const a = await h.createSyntheticOwner({ displayName: "Synthetic A (to be disabled)" });
    for (let i = 0; i < 21; i++) await h.upload(a, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 64 }), demo: true });
    await h.db.prepare("UPDATE users SET status = 'disabled' WHERE user_id = ?").bind(a.userId).run();
    await h.db.prepare("UPDATE outbox SET state = 'acknowledged' WHERE user_id = ? AND topic = 'media.job'").bind(a.userId).run();
    const queuedOfA = async () => (await all(h.db, "SELECT 1 FROM media_jobs WHERE user_id = ? AND state = 'queued' AND attempts = 0", a.userId)).length;
    expect(await queuedOfA()).toBe(21);

    h.clock.advanceMinutes(1);
    const b = await h.createSyntheticOwner({ displayName: "Synthetic B" });
    const up = await h.upload(b, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 128 }), demo: true });
    await h.settle(b);
    // A second, later job of B that is not a removal: it must not be held up either.
    const later = await h.upload(b, { garmentId: "trouser-olive", raster: syntheticTrousers({ size: 128 }), demo: true });
    const del = await b.exec("media.delete_asset", { assetId: up.asset!.assetId });
    // Both queue messages are lost: only the sweep can run these jobs.
    await h.db.prepare("UPDATE outbox SET state = 'acknowledged' WHERE user_id = ? AND topic = 'media.job'").bind(b.userId).run();
    expect((await keysOf(h, b, `assets/${up.asset!.assetId}/`)).length).toBeGreaterThan(0);

    h.clock.advanceMinutes(10);
    const sweep = await runMediaMaintenance(h.rt, { startDiscovery: false });
    expect(sweep.errors).toEqual([]);
    expect(sweep.staleJobsRun).toBeGreaterThanOrEqual(2);
    expect(await keysOf(h, b, `assets/${up.asset!.assetId}/`)).toEqual([]);
    expect(await first(h.db, "SELECT state FROM media_jobs WHERE user_id = ? AND job_id = ?", b.userId, String(del.result.purgeJobId))).toEqual({ state: "succeeded" });
    expect((await getMediaStorageStatus(h.rt, b.principal())).deletionsPending).toBe(0);
    expect((await getAsset(h.rt, b.principal(), later.asset!.assetId)).status).toBe("active");
    // The disabled account's jobs were not run and not discarded: they are simply never selected.
    expect(await queuedOfA()).toBe(21);

    // Enabled again, its work resumes on the following sweeps.
    await h.db.prepare("UPDATE users SET status = 'active' WHERE user_id = ?").bind(a.userId).run();
    h.clock.advanceMinutes(10);
    await runMediaMaintenance(h.rt, { startDiscovery: false });
    expect(await queuedOfA()).toBe(1);
  });
});

describe("re-review N2: the recorded purchase page is adopted only for the recorded product", () => {
  const boot = { garmentId: "g", name: "Drake's Clifford boot", category: "footwear", maker: "Drake's", product: "Clifford boot", colour: "Brown", pattern: null, fabric: null, size: null, codes: [], model: null, purchaseLink: "https://www.shop.example.org/products/clifford-boot-brown", cut: null } as any;
  const page = (product: Record<string, unknown> | null, head = "") => `<html><head>${head}${product ? `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", ...product })}</script>` : ""}</head></html>`;
  const banner = '<meta property="og:image" content="/img/site-banner.jpg">';
  const run = async (body: string, g = boot) => {
    const provider = createPurchaseLinkProvider({ fetchImpl: async () => new Response(body, { headers: { "content-type": "text/html" } }), resolver: async () => ["93.184.216.34"] });
    const found = await provider.search({ strategy: "purchase_source", garment: g, text: g.purchaseLink } as any, { maxPages: 12, maxBrowserSessions: 2 } as any);
    return found.pages[0] ? { ...evaluateCandidate(g, found.pages[0]), image: found.pages[0].imageUrl } : null;
  };

  it("a reused address now showing another product by the same maker is not adopted, even when the colour matches", async () => {
    const other = await run(page({ name: "Suede Chukka Sneaker", brand: "Drake's", color: "Brown", image: "/chukka.jpg" }));
    expect(other).toMatchObject({ decision: "needs_review", exactIdentifier: false });
    // The question is the system's own wording: nothing from the page is quoted into it.
    expect(other!.reviewQuestion).toBe("The recorded purchase link names the same maker, but the product shown there now does not match the recorded name. Is this Drake's Clifford boot?");
    expect(other!.reviewQuestion).not.toContain("Chukka");
    // The same page for a garment whose colour is not recorded: still not adopted.
    expect((await run(page({ name: "Suede Chukka Sneaker", brand: "Drake's", color: "Brown", image: "/chukka.jpg" }), { ...boot, colour: null }))!.decision).toBe("needs_review");
    // Neither maker nor product named: rejected outright.
    expect((await run(page({ name: "Suede Chukka Sneaker", image: "/chukka.jpg" })))!.decision).toBe("rejected");
  });

  it("a product block without an image of its own yields nothing: a site banner is never taken instead", async () => {
    expect(await run(page({ name: "New arrivals", brand: "Drake's" }, banner), { ...boot, colour: null })).toBeNull();
    // Even when the block names the recorded product.
    expect(await run(page({ name: "Clifford Boot", brand: "Drake's", color: "Brown" }, banner))).toBeNull();
    expect(extractProductPage(page({ name: "Clifford Boot" }, banner), boot.purchaseLink, "2026-10-02T00:00:00Z")).toBeNull();
  });

  it("the recorded page showing the recorded product is still adopted, by product name or by product code", async () => {
    expect(await run(page({ name: "Clifford Boot", brand: "Drake's", color: "Brown", image: "/clifford.jpg" }))).toMatchObject({ decision: "eligible", image: "https://www.shop.example.org/clifford.jpg" });
    // Product named, maker not stated on the page: the recorded address plus the product is enough.
    expect((await run(page({ name: "Clifford Boot", color: "Brown", image: "/clifford.jpg" })))!.decision).toBe("eligible");
    // A matching code identifies the product whatever the page calls it.
    expect(await run(page({ name: "Style 4471", sku: "CLF-4471", image: "/clifford.jpg" }), { ...boot, codes: ["CLF-4471"] })).toMatchObject({ decision: "eligible", exactIdentifier: true });
    // The recorded product in a colour that is not the recorded one is rejected as before.
    expect(await run(page({ name: "Clifford Boot", brand: "Drake's", color: "Black", image: "/clifford-black.jpg" }))).toMatchObject({ decision: "rejected", rejectionReasons: ["wrong_colourway"] });
  });
});

describe("re-review N3: an address is judged by what it is, not by how it is written", () => {
  it("NAT64, 6to4, IPv4-mapped and IPv4-compatible forms of private addresses are private in every notation", () => {
    const privateForms = [
      "64:ff9b::7f00:1", "64:ff9b::127.0.0.1", "64:ff9b::a00:5", "64:ff9b:0:0:0:0:c0a8:101", "64:ff9b:1::a00:1", "64:ff9b:1::5db8:d822",
      "2002:7f00:1::", "2002:a00:5::1", "2002:c0a8:101::", "2002:a9fe:a9fe::1",
      "::7f00:1", "::127.0.0.1", "0:0:0:0:0:ffff:7f00:1", "::ffff:127.0.0.1", "::ffff:a00:5", "::ffff:169.254.169.254",
      "::", "::1", "0000:0000:0000:0000:0000:0000:0000:0001", "fe80::1", "fe80::1%eth0", "fe90::1", "fec0::1", "fc00::1", "fd00:ec2::254", "ff02::1", "100::1",
      "2001:db8::1", "2001:0db8::1", "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "3fff::1:2:3:4:5:6:7", "not-an-address", "1::2::3", "12345::1",
      "100.64.0.1", "169.254.169.254", "192.0.0.8", "198.18.0.1", "240.0.0.1", "10.0.0.5", "127.0.0.1",
    ];
    expect(privateForms.filter((a) => !isPrivateAddress(a))).toEqual([]);
    const publicForms = ["93.184.216.34", "2606:4700::1", "2606:4700:4700::1111", "2a00:1450:4009:81f::200e", "2001:4860:4860::8888", "::ffff:93.184.216.34", "::ffff:5db8:d822", "64:ff9b::5db8:d822", "64:ff9b::93.184.216.34", "2002:5db8:d822::1"];
    expect(publicForms.filter((a) => isPrivateAddress(a))).toEqual([]);
    expect(parseIpv6("64:ff9b::a00:5")).toEqual([0x64, 0xff9b, 0, 0, 0, 0, 0xa00, 5]);
    expect(parseIpv6("::ffff:10.0.0.5")).toEqual([0, 0, 0, 0, 0, 0xffff, 0xa00, 5]);
    expect(parseIpv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIpv6("1:2:3:4:5:6:7")).toBeNull();
  });

  it("a name whose only answer is a NAT64 or 6to4 form of a private address is not fetched", async () => {
    let fetched = 0;
    const fetchImpl: typeof fetch = async () => {
      fetched++;
      return new Response("x", { headers: { "content-type": "image/png" } });
    };
    for (const answer of ["64:ff9b::a00:5", "2002:7f00:1::", "64:ff9b:1::a00:1", "::ffff:c0a8:101"]) {
      const result = await safeFetch("https://shop-one.org/a", { maxBytes: 10, accept: "*/*", fetchImpl, resolver: async () => [answer] });
      expect(result).toMatchObject({ ok: false });
      expect((result as { reason: string }).reason).toContain("private or local");
    }
    expect(fetched).toBe(0);
    expect(await safeFetch("https://shop-one.org/a", { maxBytes: 10, accept: "*/*", fetchImpl, resolver: async () => ["2606:4700::1"] })).toMatchObject({ ok: true });
  });
});

describe("re-review N4: the photograph as supplied reaches the owner only", () => {
  it("no assistant principal can open or sign the original; where it is the only picture yet, a metadata-free copy is served", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic N4" });
    const tagged = gpsTagged(encodeJpeg(syntheticShirt({ size: 256 }), 92));
    expect(probeImage(tagged)?.exif.hasGps).toBe(true);
    const up = await h.upload(owner, { garmentId: "shirt-moss", bytes: tagged, contentType: "image/jpeg", demo: true });
    const assetId = up.asset!.assetId;
    const original = (await getAsset(h.rt, owner.principal(), assetId)).renditions.find((r) => r.kind === "original")!.renditionId;
    const assistants = [
      owner.principal({ actor: "assistant", channel: "mcp", scopes: ["read"] }),
      owner.principal({ actor: "assistant", channel: "mcp", scopes: ["read", "write", "admin"] }),
      owner.principal({ actor: "assistant", channel: "conversation", scopes: ["read", "write"] }),
      owner.principal({ actor: "owner", channel: "mcp", scopes: ["read"] }),
    ];

    // Not processed yet: the original is the only picture of this asset.
    for (const who of assistants) {
      expect(await code(signRenditionUrl(h.rt, who, original))).toBe("not_found");
      expect(await code(signRenditionUrl(h.rt, who, original, { ttlSeconds: 900 }))).toBe("not_found");
      expect(await code(openRendition(h.rt, who, original))).toBe("not_found");
      expect(await code(openAssetImage(h.rt, who, assetId, { variant: "original" }))).toBe("not_found");
      const shown = await openAssetImage(h.rt, who, assetId);
      const bytes = await bytesOf(shown.body);
      expect(shown.contentType).toBe("image/jpeg");
      expect(probeImage(bytes)).toMatchObject({ format: "jpeg", width: 256, height: 256 });
      expect(probeImage(bytes)!.exif.hasGps).toBe(false);
      expect(bytes).not.toEqual(tagged);
    }

    // Processed: derived copies exist and are what everyone but the owner gets; the original stays withheld.
    await h.settle(owner);
    for (const who of assistants) {
      expect(await code(signRenditionUrl(h.rt, who, original))).toBe("not_found");
      expect(await code(openRendition(h.rt, who, original))).toBe("not_found");
      expect(await code(openAssetImage(h.rt, who, assetId, { variant: "original" }))).toBe("not_found");
      const shown = await bytesOf((await openAssetImage(h.rt, who, assetId)).body);
      expect(probeImage(shown)!.exif.hasGps).toBe(false);
      const derived = (await getAsset(h.rt, who, assetId)).renditions.find((r) => r.kind === "cutout")!.renditionId;
      const served = await serveSignedMedia(h.rt, tokenOf((await signRenditionUrl(h.rt, who, derived)).url));
      expect(served.status).toBe(200);
      expect(probeImage(new Uint8Array(await served.arrayBuffer()))!.exif.hasGps).toBe(false);
    }

    // The owner, in their own app, still has the photograph exactly as supplied.
    expect(await bytesOf((await openAssetImage(h.rt, owner.principal(), assetId, { variant: "original" })).body)).toEqual(tagged);

    // A PNG that is the only picture yet is served to the assistant as a PNG written again from its pixels.
    const png = await h.upload(owner, { garmentId: "trouser-olive", raster: syntheticTrousers({ size: 128 }), demo: true });
    const copy = await openAssetImage(h.rt, assistants[2]!, png.asset!.assetId);
    expect(copy.contentType).toBe("image/png");
    expect(probeImage(await bytesOf(copy.body))).toMatchObject({ format: "png", width: 128, height: 128 });
    const mine = await serveSignedMedia(h.rt, tokenOf((await signRenditionUrl(h.rt, owner.principal(), original)).url));
    expect(new Uint8Array(await mine.arrayBuffer())).toEqual(tagged);
    // ...but never for an audience outside the app.
    expect(await code(signRenditionUrl(h.rt, owner.principal(), original, { audience: "calendar" }))).toBe("forbidden");
  });
});

describe("re-review N5: no command record holds a storage location", () => {
  it("after uploads, processing, a rendered preview, a discarded preview and a deletion, no command's payload or receipt names a storage key", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic N5" });
    const shirt = await h.upload(owner, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 256 }), demo: true });
    await h.upload(owner, { garmentId: "trouser-olive", raster: syntheticTrousers({ size: 256 }), demo: true });
    await h.settle(owner);
    const { manifestHash } = await requestCompositePreview(h.rt, owner.principal(), { slots: [{ role: "top", garmentId: "shirt-moss" }, { role: "bottom", garmentId: "trouser-olive" }] });
    await h.settle(owner);
    // The rendered preview is where the key scheme puts it, although the command that recorded it named no location.
    expect((await keysOf(h, owner, "composites/")).sort()).toEqual([`u/${owner.userId}/composites/${manifestHash}.png`, `u/${owner.userId}/composites/${manifestHash}.svg`]);
    await owner.exec("media.delete_asset", { assetId: shirt.asset!.assetId });
    await h.settle(owner);

    const rows = await all<{ type: string; payload_json: string | null; receipt_json: string | null }>(h.db, "SELECT type, payload_json, receipt_json FROM commands WHERE user_id = ?", owner.userId);
    const types = new Set(rows.map((r) => r.type));
    for (const expected of ["media.record_normalization", "media.record_composite", "media.delete_asset", "media.complete_job"]) expect(types.has(expected)).toBe(true);
    const holding = rows.filter((r) => /"u\/|objectKey|object_key|previewKey|svgKey|r2Key/.test(`${r.payload_json ?? ""}${r.receipt_json ?? ""}`) || `${r.payload_json ?? ""}${r.receipt_json ?? ""}`.includes(`u/${owner.userId}`)).map((r) => r.type);
    expect(holding).toEqual([]);
  });
});
