import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createPrincipal } from "@garderobe/domain";
import { APP_ORIGIN, connectMcp, provisionOwner, testApp, toolResult, uploadImage, type TestOwner } from "../src/testing/index.ts";

/*
 * The visual wardrobe as the Worker mounts it: signed image delivery, the validator Studio uses, and who
 * may restore images. REAL owner fixture (supplied profile and inventory); the photographs are generated
 * test images. Stand-ins: test-signed Access assertions; local R2 for the private media bucket.
 */
let owner: TestOwner;
let stranger: TestOwner;
let garmentId: string;
let renditionId: string;
let assetId: string;

beforeAll(async () => {
  owner = await provisionOwner({ real: true });
  stranger = await provisionOwner();
  const wardrobe = await owner.api.json("GET", "/v1/wardrobe");
  garmentId = wardrobe.items.find((i: any) => i.garment.acquisition === "owned" && i.garment.roles.includes("top")).garment.garmentId;
  assetId = (await uploadImage(owner, { garmentId })).complete.asset.assetId;
  const app = await testApp();
  renditionId = (await app.db.prepare("SELECT rendition_id FROM media_renditions WHERE user_id = ? AND asset_id = ? ORDER BY created_at LIMIT 1").bind(owner.userId, assetId).first<{ rendition_id: string }>())!.rendition_id;
  expect(renditionId).toBeTruthy();
});

describe("signed image delivery", () => {
  it("gives the owner a short-lived URL that serves that one image without the sign-in, as an image and nothing else", async () => {
    const signed = await owner.api.json("POST", `/v1/media/renditions/${renditionId}/sign`, { width: 320, ttlSeconds: 120 });
    expect(signed.url).toMatch(/^\/v1\/media\/signed\//);
    expect(signed).toMatchObject({ renditionId, width: 320 });
    expect(Date.parse(signed.expiresAt) - Date.now()).toBeLessThanOrEqual(120_000);

    // No Access assertion on this request: the token is the whole authority.
    const served = await SELF.fetch(`${APP_ORIGIN}${signed.url}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toMatch(/^image\//);
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(served.headers.get("cache-control")).toMatch(/^private/);
    expect((await served.arrayBuffer()).byteLength).toBeGreaterThan(0);

    // The authenticated image routes carry the same protections.
    const direct = await owner.api.get(`/v1/media/assets/${assetId}`);
    expect(direct.status).toBe(200);
    expect(direct.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(direct.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("answers every failure with the same 404: a changed token, another rendition, a deleted image", async () => {
    const signed = await owner.api.json("POST", `/v1/media/renditions/${renditionId}/sign`, {});
    const token = signed.url.split("/").at(-1) as string;
    const tampered = `${token.slice(0, -4)}${token.slice(-4) === "AAAA" ? "BBBB" : "AAAA"}`;
    const bodies: string[] = [];
    for (const path of [`/v1/media/signed/${tampered}`, "/v1/media/signed/not-a-token", `/v1/media/signed/${token}x`]) {
      const response = await SELF.fetch(`${APP_ORIGIN}${path}`);
      expect(response.status, path).toBe(404);
      bodies.push(await response.text());
    }
    expect(new Set(bodies).size).toBe(1);

    // Another owner cannot have this owner's rendition signed, and an invalid width is refused.
    expect((await stranger.api.post(`/v1/media/renditions/${renditionId}/sign`, {})).status).toBe(404);
    expect((await owner.api.post(`/v1/media/renditions/${renditionId}/sign`, { width: 333 })).status).toBe(400);

    // Once the image is deleted, the URL that was already issued stops working.
    const second = await uploadImage(owner, { intent: "attachment" });
    const otherAssetId = second.complete.asset.assetId as string;
    const app = await testApp();
    const rows = (await app.db.prepare("SELECT rendition_id FROM media_renditions WHERE user_id = ? AND asset_id = ?").bind(owner.userId, otherAssetId).all<{ rendition_id: string }>()).results;
    const issued = await owner.api.json("POST", `/v1/media/renditions/${rows[0]!.rendition_id}/sign`, {});
    expect((await SELF.fetch(`${APP_ORIGIN}${issued.url}`)).status).toBe(200);
    const deleted = await owner.api.command("media.delete_asset", { assetId: otherAssetId });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    const after = await SELF.fetch(`${APP_ORIGIN}${issued.url}`);
    expect(after.status).toBe(404);
    expect(await after.text()).toBe(bodies[0]);
  });
});

describe("an uploaded photograph", () => {
  // Regression: completing an upload committed the preparation job but did not put it on the queue, so the
  // photograph stayed "processing" until the next scheduled sweep or somebody else's command.
  it("is prepared straight after the upload is completed, without a sweep or any further request", async () => {
    const app = await testApp();
    const uploaded = await uploadImage(owner, { intent: "attachment" });
    const id = uploaded.complete.asset.assetId as string;
    expect(uploaded.complete.jobId).toBeTruthy();
    let job: { state: string; attempts: number } | null = null;
    // Only reads from here on: nothing in this loop dispatches or runs a job.
    for (let i = 0; i < 400; i++) {
      job = await app.db.prepare("SELECT state, attempts FROM media_jobs WHERE user_id = ? AND job_id = ?").bind(owner.userId, uploaded.complete.jobId).first<{ state: string; attempts: number }>();
      if (job && job.state !== "queued" && job.state !== "running") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(job).toEqual({ state: "succeeded", attempts: 1 });
    expect((await app.db.prepare("SELECT status FROM media_assets WHERE user_id = ? AND asset_id = ?").bind(owner.userId, id).first<{ status: string }>())!.status).not.toBe("processing");
    expect((await app.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE user_id = ? AND topic = 'media.job' AND state != 'acknowledged'").bind(owner.userId).first<{ n: number }>())!.n).toBe(0);
  });
});

describe("Studio validation", () => {
  it("is always the daily service's validator with the owner's own rules, never the visual wardrobe's baseline", async () => {
    const studio = await owner.api.json("GET", "/v1/studio?mode=for_today");
    const pick = (role: string) => studio.selectors.find((s: any) => s.role === role).items.find((i: any) => i.eligibleToday && i.garmentId);
    const complete = ["top", "bottom", "socks", "footwear"].map((role) => ({ role, garmentId: pick(role).garmentId }));
    const full = await owner.api.json("POST", "/v1/studio/validate", { mode: "for_today", slots: complete });
    expect(full.validator).toBe("daily-service");

    // The same outfit without socks: the owner's profile does not allow it, and the answer says which rule.
    const sockless = await owner.api.json("POST", "/v1/studio/validate", { mode: "for_today", slots: complete.filter((s) => s.role !== "socks") });
    expect(sockless.validator).toBe("daily-service");
    expect(sockless.valid).toBe(false);
    expect(JSON.stringify(sockless.violations).toLowerCase()).toContain("sock");
    // And it cannot be saved as a plan for a day.
    const planned = await owner.api.command("studio.plan_for_day", { localDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), slots: complete.filter((s) => s.role !== "socks") });
    expect(planned.status).toBeGreaterThanOrEqual(400);
  });
});

describe("restoring images", () => {
  it("needs the owner's admin authority before anything is read or stored", async () => {
    const app = await testApp();
    const exported = await app.media!.exportData(createPrincipal({ userId: owner.userId, actor: "system", channel: "system", scopes: ["read", "write"], authRef: "test:media-export" }));
    const target = await provisionOwner();
    const reads: string[] = [];
    const withoutAdmin = createPrincipal({ userId: target.userId, actor: "owner", channel: "ios", scopes: ["read", "write"], authRef: "test:no-admin" });
    await expect(app.media!.importData(withoutAdmin, exported.records, async (key) => (reads.push(key), null))).rejects.toMatchObject({ code: "forbidden" });
    expect(reads).toEqual([]);
    expect((await app.env.MEDIA_BUCKET!.list({ prefix: `u/${target.userId}/` })).objects).toEqual([]);
  });

  it("is not something a connected assistant can do: the restore commands are refused over MCP", async () => {
    const mcp = await connectMcp(owner, { write: true, onElicit: () => ({ action: "accept", content: { confirm: true } }) });
    for (const [type, payload] of [["media.reapply_deletions", { assetIds: ["ast_anything"], purgedOriginalAssetIds: [] }], ["media.import_records", { part: "assets", rows: {} }]] as const) {
      const result = toolResult(await mcp.client.callTool({ name: "garderobe_command", arguments: { type, payload, idempotencyKey: `restore-${crypto.randomUUID()}` } }));
      expect(result.ok, type).toBe(false);
      expect(["forbidden", "scope_denied", "invalid_command"]).toContain(result.error!.code);
    }
    await mcp.close();
  });
});
