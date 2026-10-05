/**
 * Media abuse: one owner reaching for another owner's images, uploads, previews and saved outfits.
 *
 * Specification section 11 ("Images are served via authenticated requests or narrowly scoped short-lived
 * URLs"), section 15 ("R2 paths, signed asset authorization ... are scoped to the same owner"), section 17
 * acceptance rows "Isolation" and "Hallucinated items" (an identifier the owner does not own cannot be
 * composed).
 *
 * Real: the Worker (HTTP API and MCP server), local D1, the private local R2 bucket, the local queue and
 * its consumer, the daily service's validator. Stand-ins: test-signed sign-in assertions in place of
 * Cloudflare Access. Both owners and all their garments and pictures are SYNTHETIC test fixtures.
 *
 * Every case asserts on state: what the victim holds in D1 and R2 before and after, and what the attacker
 * ends up holding.
 */
import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_ORIGIN, connectMcp, toolResult } from "@garderobe/worker/testing";
import { cleanPng, mediaFingerprint, objectKeys, rows, settleJobs, syntheticOwner, uploadClean, type AbuseOwner } from "./support.ts";

let victim: AbuseOwner;
let attacker: AbuseOwner;
let v: { uploadId: string; assetId: string; renditionIds: string[]; manifestHash: string; combinationId: string; planId: string; pendingUploadId: string; pendingUploadUrl: string };
let before: string;

const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  victim = await syntheticOwner("V");
  attacker = await syntheticOwner("A");
  const photo = await uploadClean(victim, await cleanPng());
  const preview = await victim.owner.api.json("POST", "/v1/studio/previews", { clientRequestId: `victim-preview-${crypto.randomUUID()}`, slots: victim.slots() });
  await settleJobs(victim.owner.userId);
  const saved = (await (await victim.owner.api.command("studio.save_combination", { name: "Victim's saved outfit (synthetic)", slots: victim.slots() })).json()) as any;
  const planned = (await (await victim.owner.api.command("studio.plan_for_day", { localDate: tomorrow(), slots: victim.slots() })).json()) as any;
  // An upload the victim has authorized but not yet sent: its staging slot is a target too.
  const pending = await victim.owner.api.json("POST", "/v1/uploads", { clientUploadId: `victim-pending-${crypto.randomUUID()}`, intent: "attachment", contentType: "image/png", byteLength: (await cleanPng(96)).length });
  v = {
    uploadId: photo.uploadId,
    assetId: photo.assetId,
    renditionIds: photo.renditions.map((r) => r.rendition_id),
    manifestHash: preview.manifestHash,
    combinationId: saved.result?.combinationId,
    planId: planned.result?.planId,
    pendingUploadId: pending.uploadId,
    pendingUploadUrl: pending.url,
  };
  expect(v.renditionIds.length).toBeGreaterThan(1); // the original and its derived copies
  expect(v.combinationId, JSON.stringify(saved)).toBeTruthy();
  expect(v.planId, JSON.stringify(planned)).toBeTruthy();
  expect((await victim.owner.api.get(`/v1/studio/compositions/${v.manifestHash}/preview`)).status).toBe(200);
  before = await mediaFingerprint(victim.owner.userId);
});

describe("another owner's media cannot be read", () => {
  it("every image, upload, composition and preview route answers the attacker as if nothing existed, exactly as for an invented ID", async () => {
    const paths = (ids: { upload: string; asset: string; rendition: string; garment: string; manifest: string }) => [
      `/v1/uploads/${ids.upload}`,
      `/v1/media/assets/${ids.asset}`,
      `/v1/media/assets/${ids.asset}?variant=original`,
      `/v1/media/assets/${ids.asset}?variant=cutout&width=320`,
      `/v1/media/renditions/${ids.rendition}`,
      `/v1/media/renditions/${ids.rendition}?width=160`,
      `/v1/items/${ids.garment}/image`,
      `/v1/items/${ids.garment}`,
      `/v1/studio/compositions/${ids.manifest}`,
      `/v1/studio/compositions/${ids.manifest}/preview`,
    ];
    const real = paths({ upload: v.uploadId, asset: v.assetId, rendition: v.renditionIds[0]!, garment: victim.garments.top.garmentId, manifest: v.manifestHash });
    const invented = paths({ upload: "upl_doesnotexist0000000000", asset: "ast_doesnotexist0000000000", rendition: "rnd_doesnotexist0000000000", garment: "gar_doesnotexist0000000000", manifest: "0".repeat(64) });
    for (let i = 0; i < real.length; i++) {
      const forVictims = await attacker.owner.api.get(real[i]!);
      const forInvented = await attacker.owner.api.get(invented[i]!);
      expect(forVictims.status, real[i]).toBe(404);
      // Whether the ID exists for somebody else is not observable: same status, same error code.
      expect(forInvented.status, invented[i]).toBe(404);
      const a = (await forVictims.json()) as any;
      const b = (await forInvented.json()) as any;
      expect(a.error.code, real[i]).toBe(b.error.code);
      expect(JSON.stringify(a)).not.toContain(victim.garments.top.name);
      expect(forVictims.headers.get("content-type") ?? "").not.toMatch(/^image\//);
      // The victim, on the same path, is served.
      expect((await victim.owner.api.get(real[i]!)).status, `victim ${real[i]}`).toBe(200);
    }
    // Every other rendition of the same asset too.
    for (const id of v.renditionIds) {
      expect((await attacker.owner.api.get(`/v1/media/renditions/${id}`)).status).toBe(404);
      expect((await attacker.owner.api.post(`/v1/media/renditions/${id}/sign`, {})).status).toBe(404);
    }
  });

  it("without a sign-in, or with a sign-in the service does not trust, no image route answers at all", async () => {
    for (const path of [`/v1/media/assets/${v.assetId}`, `/v1/media/renditions/${v.renditionIds[0]}`, `/v1/items/${victim.garments.top.garmentId}/image`, `/v1/studio/compositions/${v.manifestHash}/preview`, "/v1/media/photos-needed", "/v1/studio"]) {
      const anonymous = await SELF.fetch(`${APP_ORIGIN}${path}`);
      expect(anonymous.status, path).toBe(401);
      expect(anonymous.headers.get("content-type") ?? "").not.toMatch(/^image\//);
      const forged = await victim.owner.api.with({ untrusted: true }).get(path);
      expect(forged.status, `forged ${path}`).toBe(401);
    }
    const sign = await SELF.fetch(`${APP_ORIGIN}/v1/media/renditions/${v.renditionIds[0]}/sign`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(sign.status).toBe(401);
  });

  it("the lists an owner can read hold only that owner's records", async () => {
    const studio = await attacker.owner.api.json("GET", "/v1/studio?mode=explore");
    const text = JSON.stringify([studio, await attacker.owner.api.json("GET", "/v1/media/photos-needed"), await attacker.owner.api.json("GET", "/v1/media/review"), await attacker.owner.api.json("GET", "/v1/wardrobe")]);
    for (const secret of [v.assetId, v.combinationId, v.planId, v.manifestHash, victim.owner.userId, ...v.renditionIds, ...Object.values(victim.garments).map((g) => g.garmentId), ...Object.values(victim.garments).map((g) => g.name)]) expect(text).not.toContain(secret);
    expect(studio.combinations).toEqual([]);
    expect(studio.dayPlans).toEqual([]);
  });
});

describe("another owner's media cannot be changed", () => {
  it("commands naming the victim's asset, upload, combination or plan are refused and commit nothing", async () => {
    const attempts: [string, Record<string, unknown>][] = [
      ["media.delete_asset", { assetId: v.assetId }],
      ["media.set_primary_asset", { garmentId: attacker.garments.top.garmentId, assetId: v.assetId }],
      ["media.set_primary_asset", { garmentId: victim.garments.top.garmentId, assetId: v.assetId }],
      ["media.finalize_upload", { uploadId: v.pendingUploadId }],
      ["media.request_discovery", { garmentIds: [victim.garments.top.garmentId] }],
      ["studio.remove_combination", { combinationId: v.combinationId }],
      ["studio.remove_day_plan", { planId: v.planId }],
      ["studio.plan_for_day", { localDate: tomorrow(), combinationId: v.combinationId }],
    ];
    const attackerBefore = await mediaFingerprint(attacker.owner.userId);
    for (const [type, payload] of attempts) {
      const response = await attacker.owner.api.command(type, payload);
      const body = (await response.json()) as any;
      expect(response.status, `${type} ${JSON.stringify(body)}`).toBeGreaterThanOrEqual(400);
      expect(response.status, type).toBeLessThan(500);
      expect(JSON.stringify(body)).not.toContain(victim.garments.top.name);
    }
    await settleJobs();
    expect(await mediaFingerprint(victim.owner.userId)).toBe(before);
    // Nothing of the victim's was attached to the attacker either: no upload, asset, job or plan appeared.
    const after = JSON.parse(await mediaFingerprint(attacker.owner.userId));
    const was = JSON.parse(attackerBefore);
    for (const table of ["objects", "media_uploads", "media_assets", "media_renditions", "garment_media", "outfit_composites", "studio_combinations", "studio_day_plans", "jobs"]) expect(after[table], table).toEqual(was[table]);
  });

  it("the attacker's own upload authorization does not open the victim's upload, and the victim's pending upload stays empty", async () => {
    const bytes = await cleanPng(96, [200, 30, 30]);
    const own = await attacker.owner.api.json("POST", "/v1/uploads", { clientUploadId: `attacker-${crypto.randomUUID()}`, intent: "attachment", contentType: "image/png", byteLength: bytes.length });
    const ownToken = new URL(own.url, APP_ORIGIN).searchParams.get("token")!;
    const put = (path: string) => SELF.fetch(`${APP_ORIGIN}${path}`, { method: "PUT", headers: { "Content-Type": "image/png", "Content-Length": String(bytes.length) }, body: bytes });
    // The attacker's valid token on the victim's upload ID; no token; a token cut short.
    for (const path of [`/v1/uploads/${v.pendingUploadId}/content?token=${ownToken}`, `/v1/uploads/${v.pendingUploadId}/content`, `/v1/uploads/${v.pendingUploadId}/content?token=${ownToken.slice(0, -6)}`, `/v1/uploads/${v.uploadId}/content?token=${ownToken}`]) {
      const response = await put(path);
      expect(response.status, path).toBeGreaterThanOrEqual(400);
      expect(response.status, path).toBeLessThan(500);
    }
    // The attacker cannot complete or inspect the victim's upload.
    expect((await attacker.owner.api.post(`/v1/uploads/${v.pendingUploadId}/complete`, {})).status).toBe(404);
    expect((await attacker.owner.api.get(`/v1/uploads/${v.pendingUploadId}`)).status).toBe(404);
    // Nothing reached the victim's storage, and the victim's upload is still waiting for the victim's own bytes.
    expect(await objectKeys(victim.owner.userId)).toEqual(JSON.parse(before).objects);
    expect((await victim.owner.api.json("GET", `/v1/uploads/${v.pendingUploadId}`)).state).toBe("authorized");
    expect(await mediaFingerprint(victim.owner.userId)).toBe(before);
    // And nothing was stored for the attacker under the victim's upload ID.
    expect((await objectKeys(attacker.owner.userId)).filter((k) => k.includes(v.pendingUploadId))).toEqual([]);
  });
});

describe("composites cannot be built from another owner's garments", () => {
  it("composing, previewing, validating, suggesting, saving or planning with the victim's garment is refused and stores nothing", async () => {
    const stolen = attacker.slots().map((s) => (s.role === "top" ? { role: "top", garmentId: victim.garments.top.garmentId } : s));
    const allStolen = victim.slots();
    const compositesBefore = await rows("SELECT manifest_hash FROM outfit_composites WHERE user_id = ?", attacker.owner.userId);
    for (const slots of [stolen, allStolen]) {
      const answers: [string, Response][] = [
        ["compose", await attacker.owner.api.post("/v1/studio/compose", { slots })],
        ["preview", await attacker.owner.api.post("/v1/studio/previews", { clientRequestId: `stolen-${crypto.randomUUID()}`, slots })],
        ["validate", await attacker.owner.api.post("/v1/studio/validate", { mode: "explore", slots })],
        ["suggest", await attacker.owner.api.post("/v1/studio/suggest", { mode: "explore", slots })],
        ["save", await attacker.owner.api.command("studio.save_combination", { name: "stolen", slots })],
        ["plan", await attacker.owner.api.command("studio.plan_for_day", { localDate: tomorrow(), slots })],
        ["preview command", await attacker.owner.api.command("media.request_composite_preview", { slots })],
      ];
      for (const [what, response] of answers) {
        const text = await response.text();
        // The victim's garment is never described back: no name, no image reference, no asset.
        for (const secret of [victim.garments.top.name, v.assetId, ...v.renditionIds]) expect(text, what).not.toContain(secret);
        if (what === "validate") {
          // Validation may answer, but only to say the garment is not one of this owner's.
          if (response.status === 200) expect(JSON.parse(text).valid, text).toBe(false);
          else expect(response.status).toBeLessThan(500);
        } else {
          expect(response.status, `${what}: ${text.slice(0, 300)}`).toBeGreaterThanOrEqual(400);
          expect(response.status, what).toBeLessThan(500);
        }
      }
    }
    await settleJobs();
    // No composition, saved outfit, plan or render job naming the victim's garments exists for the attacker.
    expect(await rows("SELECT manifest_hash FROM outfit_composites WHERE user_id = ?", attacker.owner.userId)).toEqual(compositesBefore);
    expect(await rows("SELECT 1 FROM studio_combinations WHERE user_id = ?", attacker.owner.userId)).toEqual([]);
    expect(await rows("SELECT 1 FROM studio_day_plans WHERE user_id = ?", attacker.owner.userId)).toEqual([]);
    const everywhere = JSON.stringify(await rows("SELECT * FROM outfit_composites WHERE user_id = ?", attacker.owner.userId)) + JSON.stringify(await rows("SELECT payload_json FROM media_jobs WHERE user_id = ?", attacker.owner.userId));
    for (const g of Object.values(victim.garments)) expect(everywhere).not.toContain(g.garmentId);
    expect((await objectKeys(attacker.owner.userId)).filter((k) => k.includes("/composites/"))).toEqual([]);
    expect(await mediaFingerprint(victim.owner.userId)).toBe(before);
  });

  it("knowing the victim's manifest hash gives the attacker neither the manifest nor the picture, and their own identical outfit is a different composite", async () => {
    expect((await attacker.owner.api.get(`/v1/studio/compositions/${v.manifestHash}`)).status).toBe(404);
    expect((await attacker.owner.api.get(`/v1/studio/compositions/${v.manifestHash}/preview`)).status).toBe(404);
    const own = await attacker.owner.api.json("POST", "/v1/studio/previews", { clientRequestId: `own-preview-${crypto.randomUUID()}`, slots: attacker.slots() });
    await settleJobs(attacker.owner.userId);
    expect(own.manifestHash).not.toBe(v.manifestHash);
    const mine = await attacker.owner.api.json("GET", `/v1/studio/compositions/${own.manifestHash}`);
    const text = JSON.stringify(mine);
    for (const g of Object.values(victim.garments)) expect(text).not.toContain(g.garmentId);
    // The attacker's rendered files live under the attacker's prefix only; the victim's are untouched.
    const keys = (await objectKeys(attacker.owner.userId)).filter((k) => k.includes("/composites/"));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.startsWith(`u/${attacker.owner.userId}/composites/${own.manifestHash}.`))).toBe(true);
    expect((await victim.owner.api.get(`/v1/studio/compositions/${own.manifestHash}/preview`)).status).toBe(404);
    expect(await mediaFingerprint(victim.owner.userId)).toBe(before);
  });

  it("a connected assistant acting for the attacker is refused the same way", async () => {
    const mcp = await connectMcp(attacker.owner, { write: true, onElicit: () => ({ action: "accept", content: { confirm: true } }) });
    const stolen = attacker.slots().map((s) => (s.role === "top" ? { role: "top", garmentId: victim.garments.top.garmentId } : s));
    for (const [type, payload] of [["studio.save_combination", { name: "stolen through the assistant", slots: stolen }], ["media.delete_asset", { assetId: v.assetId }], ["media.request_composite_preview", { slots: stolen }]] as const) {
      const result = toolResult(await mcp.client.callTool({ name: "garderobe_command", arguments: { type, payload, idempotencyKey: `mcp-stolen-${crypto.randomUUID()}` } }));
      expect(result.ok, `${type} ${JSON.stringify(result.data)}`).toBe(false);
      expect(JSON.stringify(result.error)).not.toContain(victim.garments.top.name);
    }
    await mcp.close();
    await settleJobs();
    expect(await rows("SELECT 1 FROM studio_combinations WHERE user_id = ?", attacker.owner.userId)).toEqual([]);
    expect(await mediaFingerprint(victim.owner.userId)).toBe(before);
    // The victim's image is still there and still theirs.
    expect((await victim.owner.api.get(`/v1/media/assets/${v.assetId}`)).status).toBe(200);
  });
});
