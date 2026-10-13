import { SELF } from "cloudflare:test";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { originalsFor } from "../src/export/job.ts";
import { APP_ORIGIN, provisionOwner, testApp, testPng, uploadImage, type TestOwner } from "../src/testing/index.ts";

/*
 * Visual wardrobe point 2a: how supplied photographs leave the service. A portable export leaves the
 * service, so its originals are written without location data (`location_removed`); a backup never
 * leaves it and must restore the photographs exactly as stored (`as_supplied`). Through the real Worker
 * with local R2 and D1; the uploaded image is the labelled synthetic test PNG.
 */
const decoder = new TextDecoder();

async function fetchTicket(owner: TestOwner, path: string): Promise<Uint8Array> {
  const ticket = await owner.api.json("POST", path, {});
  return new Uint8Array(await (await SELF.fetch(`${APP_ORIGIN}${ticket.url}`)).arrayBuffer());
}

async function settle(userId: string): Promise<void> {
  const app = await testApp();
  for (let i = 0; i < 600; i++) {
    await app.media!.afterCommit();
    const open = await app.db.prepare("SELECT COUNT(*) AS n FROM media_jobs WHERE user_id = ? AND state IN ('queued', 'running')").bind(userId).first<{ n: number }>();
    if ((open?.n ?? 0) === 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("media jobs did not settle");
}

const mediaRecords = (zip: Uint8Array) => JSON.parse(decoder.decode(unzipSync(zip)["records/media.json"]!));

/** TEST CONTAINER: the header of a HEIC file (brand, image size and a marker standing for location data), not a decodable picture. */
function heicShell(width: number, height: number): Uint8Array {
  const ascii = (s: string) => new TextEncoder().encode(s);
  const out = new Uint8Array(96);
  out.set([0, 0, 0, 24]);
  out.set(ascii("ftypheic"), 4);
  out.set(ascii("mif1heic"), 16);
  out.set(ascii("ispe"), 28);
  const v = new DataView(out.buffer);
  v.setUint32(36, width);
  v.setUint32(40, height);
  out.set(ascii("TEST-HEIC-POSITION"), 60);
  return out;
}

async function waitForExport(owner: TestOwner, exportId: string): Promise<any> {
  let job = await owner.api.json("GET", `/v1/exports/${exportId}`);
  for (let i = 0; i < 100 && ["queued", "running"].includes(job.state); i++) {
    await new Promise((r) => setTimeout(r, 100));
    job = await owner.api.json("GET", `/v1/exports/${exportId}`);
  }
  return job;
}

/** TEST DATA: a PNG carrying an Exif chunk (with a GPS directory pointer), a text comment chunk, and trailing bytes. */
function pngWithLocation(): Uint8Array {
  const ascii = (s: string) => new TextEncoder().encode(s);
  const crc32 = (bytes: Uint8Array): number => {
    let c = 0xffffffff;
    for (const b of bytes) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const pngChunk = (type: string, body: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + body.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, body.length);
    out.set(ascii(type), 4);
    out.set(body, 8);
    v.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
  };
  const exif = new Uint8Array(8 + 2 + 24 + 4 + 8);
  const ev = new DataView(exif.buffer);
  exif.set([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
  ev.setUint16(8, 2, true);
  ev.setUint16(10, 0x0112, true);
  ev.setUint16(12, 3, true);
  ev.setUint32(14, 1, true);
  ev.setUint16(18, 1, true);
  ev.setUint16(22, 0x8825, true); // GPS directory pointer
  ev.setUint16(24, 4, true);
  ev.setUint32(26, 1, true);
  ev.setUint32(30, 38, true);
  const base = testPng();
  const parts = [
    base.subarray(0, 33),
    pngChunk("eXIf", exif),
    pngChunk("tEXt", ascii("Comment\0TEST-PNG-POSITION")),
    base.subarray(33),
    ascii("TEST-TRAILING-POSITION"),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe("originals in a package (visual wardrobe 2a)", () => {
  it("chooses by purpose: an export removes location data unless the owner asked for it, a backup keeps the photograph as supplied", () => {
    expect(originalsFor("export")).toBe("location_removed");
    expect(originalsFor("export", true)).toBe("as_supplied");
    expect(originalsFor("backup")).toBe("as_supplied");
  });

  it("writes a portable export's originals without location data and a backup's exactly as stored", async () => {
    const owner = await provisionOwner();
    const taggedPng = pngWithLocation();
    const uploaded = await uploadImage(owner, { intent: "attachment", bytes: taggedPng, contentType: "image/png" });
    const assetId = uploaded.complete.asset.assetId as string;
    await settle(owner.userId);

    let job = await owner.api.json("POST", "/v1/exports", { clientRequestId: `export-${crypto.randomUUID()}` });
    for (let i = 0; i < 100 && ["queued", "running"].includes(job.state); i++) {
      await new Promise((r) => setTimeout(r, 100));
      job = await owner.api.json("GET", `/v1/exports/${job.exportId}`);
    }
    expect(job.state).toBe("completed");
    const exportZip = await fetchTicket(owner, `/v1/exports/${job.exportId}/ticket`);
    const exported = mediaRecords(exportZip);
    expect(exported.records.originals).toBe("location_removed");
    const exportedOriginal = exported.assets.find((f: any) => f.assetId === assetId && f.kind === "original");
    expect(exportedOriginal?.location).toBe("removed");
    const exportedBytes = new Uint8Array(unzipSync(exportZip)[exported.files[exportedOriginal.file]]!);
    expect(exportedBytes.length).toBeLessThan(taggedPng.length);
    expect(decoder.decode(exportedBytes)).not.toContain("TEST-PNG-POSITION");
    expect(decoder.decode(exportedBytes)).not.toContain("TEST-TRAILING-POSITION");
    expect(decoder.decode(exportedBytes)).not.toContain("eXIf");

    const backup = await owner.api.json("POST", "/v1/backups", { clientRequestId: `manual-${crypto.randomUUID()}` });
    expect(backup.state).toBe("completed");
    const backupZip = await fetchTicket(owner, `/v1/backups/${backup.backupId}/ticket`);
    const backedUp = mediaRecords(backupZip);
    expect(backedUp.records.originals).toBe("as_supplied");
    const backedUpOriginal = backedUp.assets.find((f: any) => f.assetId === assetId && f.kind === "original");
    expect(backedUpOriginal?.location).toBe("as_supplied");
    // The backup holds the stored bytes themselves, metadata included.
    const path = backedUp.files[backedUpOriginal.file];
    const app = await testApp();
    const stored = await app.db.prepare("SELECT object_key FROM media_renditions WHERE user_id = ? AND asset_id = ? AND kind = 'original'").bind(owner.userId, assetId).first<{ object_key: string }>();
    const object = await app.env.MEDIA_BUCKET!.get(stored!.object_key);
    const backedUpBytes = new Uint8Array(unzipSync(backupZip)[path]!);
    expect(backedUpBytes).toEqual(new Uint8Array(await object!.arrayBuffer()));
    expect(backedUpBytes).toEqual(taggedPng);
    expect(decoder.decode(backedUpBytes)).toContain("TEST-PNG-POSITION");
  });

  it("backs up a HEIC original (whose location cannot be removed) as supplied, and a portable export leaves it out and says so", async () => {
    const owner = await provisionOwner();
    const heic = heicShell(256, 256);
    const uploaded = await uploadImage(owner, { intent: "attachment", bytes: heic, contentType: "image/heic" });
    const assetId = uploaded.complete.asset.assetId as string;
    await settle(owner.userId);

    // The backup completes and holds the photograph exactly as stored, location data included.
    const backup = await owner.api.json("POST", "/v1/backups", { clientRequestId: `manual-${crypto.randomUUID()}` });
    expect(backup.state, JSON.stringify(backup)).toBe("completed");
    const backupZip = await fetchTicket(owner, `/v1/backups/${backup.backupId}/ticket`);
    const backedUp = mediaRecords(backupZip);
    expect(backedUp.records.originals).toBe("as_supplied");
    expect(backedUp.records.withheldOriginals).toEqual([]);
    const original = backedUp.assets.find((f: any) => f.assetId === assetId && f.kind === "original");
    expect(original, JSON.stringify(backedUp.assets)).toBeDefined();
    expect(new Uint8Array(unzipSync(backupZip)[backedUp.files[original.file]]!)).toEqual(heic);

    // A portable export completes too: the HEIC original is withheld and the package says why.
    const job = await waitForExport(owner, (await owner.api.json("POST", "/v1/exports", { clientRequestId: `export-${crypto.randomUUID()}` })).exportId);
    expect(job.state, JSON.stringify(job)).toBe("completed");
    const exportZip = await fetchTicket(owner, `/v1/exports/${job.exportId}/ticket`);
    const exported = mediaRecords(exportZip);
    expect(exported.records.originals).toBe("location_removed");
    expect(exported.records.withheldOriginals.map((w: any) => w.assetId)).toEqual([assetId]);
    expect(exported.assets.some((f: any) => f.assetId === assetId && f.kind === "original")).toBe(false);
    for (const bytes of Object.values(unzipSync(exportZip))) expect(decoder.decode(bytes)).not.toContain("TEST-HEIC-POSITION");
    expect(JSON.stringify(job)).toContain("location data could not be removed");
  });

  it("includes the photographs with their location data only when the owner asks for that export, and reads an original as supplied only on request", async () => {
    const owner = await provisionOwner();
    const heic = heicShell(256, 256);
    const uploaded = await uploadImage(owner, { intent: "attachment", bytes: heic, contentType: "image/heic" });
    const assetId = uploaded.complete.asset.assetId as string;
    await settle(owner.userId);

    // The owner asks for this export with location data: the original is in it exactly as supplied.
    const requestId = `export-loc-${crypto.randomUUID()}`;
    const started = await owner.api.json("POST", "/v1/exports", { clientRequestId: requestId, includeLocation: true });
    expect(started.includesLocation).toBe(true);
    const job = await waitForExport(owner, started.exportId);
    expect(job.state, JSON.stringify(job)).toBe("completed");
    const zip = await fetchTicket(owner, `/v1/exports/${job.exportId}/ticket`);
    const exported = mediaRecords(zip);
    expect(exported.records.originals).toBe("as_supplied");
    expect(exported.records.withheldOriginals).toEqual([]);
    const original = exported.assets.find((f: any) => f.assetId === assetId && f.kind === "original");
    expect(original, JSON.stringify(exported.assets)).toBeDefined();
    expect(new Uint8Array(unzipSync(zip)[exported.files[original.file]]!)).toEqual(heic);

    // The same request ID with a different choice is a different request; the choice is never assumed.
    const reused = await owner.api.post("/v1/exports", { clientRequestId: requestId });
    expect(reused.status).toBe(409);
    expect(((await reused.json()) as any).error.code).toBe("idempotency_key_reuse");
    const plain = await owner.api.json("POST", "/v1/exports", { clientRequestId: `export-plain-${crypto.randomUUID()}` });
    expect(plain.includesLocation).toBe(false);
    expect((await owner.api.post("/v1/exports", { clientRequestId: `export-bad-${crypto.randomUUID()}`, includeLocation: "yes" })).status).toBe(400);

    // Reading the original: as supplied only when asked, and never as a thumbnail.
    const asSupplied = await owner.api.get(`/v1/media/assets/${assetId}?variant=original&withLocation=true`);
    expect(asSupplied.status).toBe(200);
    expect(new Uint8Array(await asSupplied.arrayBuffer())).toEqual(heic);
    expect((await owner.api.get(`/v1/media/assets/${assetId}?variant=original&withLocation=true&width=320`)).status).toBe(400);
    expect((await owner.api.get(`/v1/media/assets/${assetId}?variant=original&withLocation=yes`)).status).toBe(400);

    // A signed link never carries location data, whatever is asked (coordinator ruling): asking is refused,
    // and a link to the original serves no position.
    const rendition = await (await testApp()).db.prepare("SELECT rendition_id FROM media_renditions WHERE user_id = ? AND asset_id = ? AND kind = 'original'").bind(owner.userId, assetId).first<{ rendition_id: string }>();
    for (const asked of [{ withLocation: true }, { withLocation: false }, { withLocation: "yes" }]) {
      const refused = await owner.api.post(`/v1/media/renditions/${rendition!.rendition_id}/sign`, asked);
      expect(refused.status, JSON.stringify(asked)).toBe(400);
    }
    const without = await owner.api.json("POST", `/v1/media/renditions/${rendition!.rendition_id}/sign`, {});
    const claims = JSON.parse(atob(new URL(without.url, APP_ORIGIN).pathname.split("/").pop()!.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(claims.l).toBeUndefined();
    const plainLink = await SELF.fetch(`${APP_ORIGIN}${without.url}`);
    if (plainLink.status === 200) expect(decoder.decode(new Uint8Array(await plainLink.arrayBuffer()))).not.toContain("TEST-HEIC-POSITION");
    else expect(plainLink.status).toBe(404);
  });
});
