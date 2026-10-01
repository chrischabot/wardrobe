import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createPrincipal } from "@garderobe/domain";
import { ownerPrefix } from "@garderobe/media";
import { ownerTables, remainingOwnerRows, resumeErasures } from "../src/identity/erasure.ts";
import { APP_ORIGIN, MCP_ORIGIN, connectMcp, enableFakeModel, provisionOwner, testApp, uploadImage, type TestOwner } from "../src/testing/index.ts";

/*
 * Account deletion erases the owner's stored data everywhere, and nobody else's. Two owners with the
 * REAL fixture (supplied profile and inventory) and activity on every surface; one is deleted.
 * Stand-ins: test-signed Access assertions, the labelled FAKE MODEL for the conversation, the labelled
 * Google and tool-service fixtures for connections. There is no AI Search binding locally, so erasing
 * the search instance is not exercised here.
 */
let victim: TestOwner;
let bystander: TestOwner;
let victimToken: string;
let victimExport: { exportId: string; ticketUrl: string };
const before: Record<string, any> = {};

const sha256 = async (bytes: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const fixtureCalls = async (): Promise<{ method: string; url: string; body: string }[]> => (await fetch("https://google.fixture.test/__calls")).json();

async function activity(owner: TestOwner, marker: string) {
  const model = await enableFakeModel(owner);
  const wardrobe = await owner.api.json("GET", "/v1/wardrobe");
  const top = wardrobe.items.find((i: any) => i.garment.acquisition === "owned" && i.garment.roles.includes("top")).garment;
  await owner.api.command("style.add_direction", { text: `Direction ${marker}`, source: { kind: "owner_statement" } });
  await uploadImage(owner, { garmentId: top.garmentId });
  model.script({ text: `Reply ${marker}` });
  const turn = await owner.api.json("POST", "/v1/conversation/turns", { clientTurnId: `turn-${crypto.randomUUID()}`, text: `Question ${marker}` });
  for (let i = 0; i < 100; i++) {
    if ((await owner.api.json("GET", `/v1/runs/${turn.runId}`)).state === "completed") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await owner.api.json("POST", "/v1/connections", { clientRequestId: `conn-${crypto.randomUUID()}`, kind: "tavily", name: "Page search", auth: { type: "secret", secret: `tvly-ERASURE-${marker}-0123456789` } });
  const started = await owner.api.json("POST", "/v1/connections", { clientRequestId: `conn-${crypto.randomUUID()}`, kind: "google_workspace", name: "Google", auth: { type: "oauth" }, capabilities: ["calendar.read"] });
  const state = new URL(started.authorizationUrl).searchParams.get("state")!;
  await SELF.fetch(`${APP_ORIGIN}/connections/callback?state=${encodeURIComponent(state)}&code=fixture-code`, { redirect: "manual" });
  return { top, turnId: turn.runId as string };
}

beforeAll(async () => {
  victim = await provisionOwner({ real: true });
  bystander = await provisionOwner({ real: true });
  before.victim = await activity(victim, "VICTIM-MARKER-7f3a");
  before.bystander = await activity(bystander, "BYSTANDER-MARKER-91c2");
  const assistant = await connectMcp(victim, { write: true, clientName: "Assistant of the deleted account" });
  victimToken = assistant.oauth.snapshot().accessToken;
  before.bystanderMcp = await connectMcp(bystander, { write: false, clientName: "Assistant of the other owner" });

  const requested = await victim.api.json("POST", "/v1/exports", { clientRequestId: `export-${crypto.randomUUID()}` });
  for (let i = 0; i < 150; i++) {
    if (!["queued", "running"].includes((await victim.api.json("GET", `/v1/exports/${requested.exportId}`)).state)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  victimExport = { exportId: requested.exportId, ticketUrl: (await victim.api.json("POST", `/v1/exports/${requested.exportId}/ticket`, {})).url };

  before.bystanderWardrobe = await bystander.api.json("GET", "/v1/wardrobe");
  before.bystanderImage = await sha256(await (await bystander.api.get(`/v1/items/${before.bystander.top.garmentId}/image`)).arrayBuffer());
  before.bystanderStyle = await bystander.api.json("GET", "/v1/style");
});

describe("deleting an account", () => {
  it("had real data in every store before the deletion", async () => {
    const app = await testApp();
    const rows = await remainingOwnerRows(app.db, victim.userId);
    for (const table of ["users", "auth_identities", "garments", "commands", "style_documents", "recovery_credentials", "connection_credentials", "mcp_grants", "export_jobs", "account_audit"]) expect(rows[table], table).toBeGreaterThan(0);
    expect((await app.env.MEDIA_BUCKET!.list({ prefix: ownerPrefix(victim.userId) })).objects.length).toBeGreaterThan(0);
    expect((await app.env.EXPORT_BUCKET.list({ prefix: `exports/${victim.userId}/` })).objects.length).toBeGreaterThan(0);
    expect(JSON.stringify(await victim.api.json("GET", "/v1/conversation/messages"))).toContain("VICTIM-MARKER-7f3a");
  });

  it("erases every row, object, conversation and credential of that owner once confirmed", async () => {
    const app = await testApp();
    await fixtureCalls();
    const asked = await victim.api.json("POST", "/v1/account/delete", {});
    expect(asked.consequence).toContain("cannot be undone");
    const confirmed = await victim.api.json("POST", "/v1/account/delete", { confirmationToken: asked.confirmationToken });
    expect(confirmed.state).toBe("erased");

    // D1: no table has a row of this owner, and no table anywhere still mentions the owner or their markers.
    expect(await remainingOwnerRows(app.db, victim.userId)).toEqual({});
    const tables = (await app.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'").all<{ name: string }>()).results.map((t) => t.name);
    expect(tables.length).toBeGreaterThan((await ownerTables(app.db)).length);
    for (const table of tables) {
      const dump = JSON.stringify((await app.db.prepare(`SELECT * FROM ${table}`).all()).results);
      expect(dump.includes(victim.userId), `${table} still names the owner`).toBe(false);
      expect(dump.includes("VICTIM-MARKER-7f3a"), `${table} still holds the owner's text`).toBe(false);
      expect(dump.includes(victim.identity.subject), `${table} still holds the sign-in`).toBe(false);
    }

    // Objects: photographs, renditions, staging, export packages.
    expect((await app.env.MEDIA_BUCKET!.list({ prefix: ownerPrefix(victim.userId) })).objects).toEqual([]);
    expect((await app.env.EXPORT_BUCKET.list({ prefix: `exports/${victim.userId}/` })).objects).toEqual([]);
    expect((await app.env.EXPORT_BUCKET.list({ prefix: `backups/${victim.userId}/` })).objects).toEqual([]);

    // The conversation actor holds nothing for that owner any more.
    const ghost = createPrincipal({ userId: victim.userId, actor: "system", channel: "system", scopes: ["read"], authRef: "test:after-erasure" });
    const transcript = await app.assistant!.transcript(ghost, { limit: 50 }).catch(() => ({ messages: [] }));
    expect(JSON.stringify(transcript)).not.toContain("VICTIM-MARKER-7f3a");
    expect(transcript.messages).toEqual([]);

    // The provider was asked to revoke the Google grant.
    expect((await fixtureCalls()).some((c) => c.method === "POST" && new URL(c.url).pathname === "/revoke")).toBe(true);

    // What remains is a record without personal data.
    const record = await app.db.prepare("SELECT * FROM account_erasures ORDER BY confirmed_at DESC LIMIT 1").first<Record<string, unknown>>();
    expect(record).toMatchObject({ state: "erased", pending_owner_id: null, last_error: null });
    expect(JSON.parse(String(record!.stores_json)).database.rows).toBeGreaterThan(100);
    expect(await resumeErasures(app, Date.now())).toBe(0); // nothing is left pending
  });

  it("leaves nothing readable through the sign-in, the assistant's token or an earlier download link", async () => {
    const me = await victim.api.get("/v1/me");
    expect(me.status).toBe(403);
    expect(((await me.json()) as any).error.code).toBe("identity_not_linked");
    expect((await victim.api.get("/v1/wardrobe")).status).toBe(403);
    const mcp = await SELF.fetch(`${MCP_ORIGIN}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${victimToken}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(mcp.status).toBe(401);
    const download = await SELF.fetch(`${APP_ORIGIN}${victimExport.ticketUrl}`);
    expect(download.ok).toBe(false);
    // The other owner cannot reach anything of the deleted one by ID either.
    // (Garment IDs of the imported inventory are the same in every real-fixture owner, so runs and exports are the cross-owner probes.)
    expect((await bystander.api.get(`/v1/runs/${before.victim.turnId}`)).status).toBe(404);
    expect((await bystander.api.get(`/v1/exports/${victimExport.exportId}`)).status).toBe(404);
  });

  it("leaves the other owner exactly as they were", async () => {
    const app = await testApp();
    const wardrobe = await bystander.api.json("GET", "/v1/wardrobe");
    expect(wardrobe.total).toBe(before.bystanderWardrobe.total);
    expect(wardrobe.wardrobeRevision).toBe(before.bystanderWardrobe.wardrobeRevision);
    expect((await bystander.api.json("GET", "/v1/style")).document.contentSha256).toBe(before.bystanderStyle.document.contentSha256);
    expect(JSON.stringify(await bystander.api.json("GET", "/v1/style"))).toContain("BYSTANDER-MARKER-91c2");
    expect(JSON.stringify(await bystander.api.json("GET", "/v1/conversation/messages"))).toContain("Reply BYSTANDER-MARKER-91c2");
    expect(await sha256(await (await bystander.api.get(`/v1/items/${before.bystander.top.garmentId}/image`)).arrayBuffer())).toBe(before.bystanderImage);
    expect((await app.env.MEDIA_BUCKET!.list({ prefix: ownerPrefix(bystander.userId) })).objects.length).toBeGreaterThan(0);
    const connections = (await bystander.api.json("GET", "/v1/connections")).connections;
    expect(connections.map((c: any) => c.state)).toEqual(["connected", "connected"]);
    expect((await before.bystanderMcp.client.listTools()).tools.length).toBe(6);
    await before.bystanderMcp.close();
  });
});
