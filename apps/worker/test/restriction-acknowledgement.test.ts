import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_ORIGIN, MCP_ORIGIN, connectMcp, enableFakeModel, provisionOwner, testApp, toolResult, uploadImage, type FakeModel, type McpConnection, type TestOwner } from "../src/testing/index.ts";

/*
 * A correction that takes a piece out of an active restriction (checklist S07 restriction rules; README
 * "A covered garment stays covered"): refused for every caller unless the owner himself, in the app,
 * acknowledges the restriction by name (`acknowledgedRestrictionIds`), directly or when he confirms a
 * proposal. A connected assistant can never supply that acknowledgement, and one planted inside a proposal
 * is not used.
 *
 * A LABELLED SYNTHETIC owner with SYNTHETIC shoes and a SYNTHETIC restriction (the real owner's healing
 * restriction is not touched). Stand-ins: test-signed Access assertions; the labelled FAKE MODEL for the one
 * relayed turn; the turn's stored proposal is SET UP DIRECTLY and says so.
 */
let owner: TestOwner;
let model: FakeModel;
let writer: McpConnection;
let restrictionId: string;
const REASON = "SYNTHETIC healing restriction (acknowledgement tests)";

const errorOf = async (response: Response) => ((await response.json()) as { error: { code: string; message: string; details: Record<string, any> } }).error;
const db = async () => (await testApp()).db;
const restrictionStatus = async () => (await (await db()).prepare("SELECT status FROM restrictions WHERE user_id = ? AND restriction_id = ?").bind(owner.userId, restrictionId).first<{ status: string }>())!.status;
const footwearKindOf = async (garmentId: string) => ((await owner.api.json("GET", `/v1/items/${garmentId}`)).detail.garment.attributes?.footwearKind ?? null) as string | null;
const toSneaker = (garmentId: string, extra: Record<string, unknown> = {}) => ({ garmentId, changes: { attributes: { footwearKind: "sneaker" } }, source: { kind: "owner_statement" }, ...extra });

async function shoe(name: string): Promise<string> {
  const created = (await (await owner.api.command("garment.create", { name, category: "footwear", roles: ["footwear"], careChannel: "none", acquisition: "owned", quantity: 1, isSynthetic: true, attributes: { footwearKind: "welted" }, source: { kind: "system", note: "synthetic test garment" } })).json()) as any;
  expect(created.outcome, JSON.stringify(created)).toBe("committed");
  return created.affected.find((a: any) => a.kind === "garment").id as string;
}

beforeAll(async () => {
  owner = await provisionOwner();
  model = await enableFakeModel(owner);
  writer = await connectMcp(owner, { write: true, clientName: "Connected assistant (acknowledgement tests)" });
});

describe("a correction that takes a piece out of an active restriction", () => {
  let shoeA: string;
  let shoeB: string;

  beforeAll(async () => {
    shoeA = await shoe("SYNTHETIC welted shoe A (acknowledgement tests)");
    shoeB = await shoe("SYNTHETIC welted shoe B (acknowledgement tests)");
    const added = (await (await owner.api.command("restriction.add", { kind: "healing", scope: { anyOf: [{ category: "footwear", footwearKinds: ["welted"] }] }, reason: REASON, source: { kind: "owner_statement" } })).json()) as any;
    expect(added.outcome, JSON.stringify(added)).toBe("committed");
    restrictionId = added.result.restrictionId as string;
  });

  it("is refused in the app without an acknowledgement, naming the restriction; with the owner's acknowledgement it applies, says so in words, and the restriction stays active for the rest", async () => {
    const refused = await owner.api.command("garment.correct", toSneaker(shoeA));
    expect(refused.status).toBe(403);
    expect((await errorOf(refused)).details).toMatchObject({ reason: "correction_would_release_restriction", restrictionId, garmentId: shoeA });
    expect(await footwearKindOf(shoeA)).toBe("welted");

    // An acknowledgement of a different (unknown) restriction does not stand in for this one.
    const wrong = await owner.api.command("garment.correct", toSneaker(shoeA, { acknowledgedRestrictionIds: ["rst_synthetic_not_this_one"] }));
    expect(wrong.status).toBe(403);
    expect((await errorOf(wrong)).details).toMatchObject({ reason: "correction_would_release_restriction", restrictionId });

    const applied = await owner.api.command("garment.correct", toSneaker(shoeA, { acknowledgedRestrictionIds: [restrictionId] }));
    expect(applied.status, await applied.clone().text()).toBe(200);
    const receipt = (await applied.json()) as any;
    expect(receipt.outcome).toBe("committed");
    expect(receipt.result.releasedFromRestrictions).toEqual([{ restrictionId, garmentIds: [shoeA] }]);
    expect(receipt.summary).toContain(`no longer covered by the restriction`);
    expect(receipt.summary).toContain(REASON);
    expect(receipt.summary).not.toContain(restrictionId);
    expect(await footwearKindOf(shoeA)).toBe("sneaker");
    expect(await restrictionStatus()).toBe("active");
    // The other covered shoe is still covered: its own correction is refused without an acknowledgement.
    expect((await errorOf(await owner.api.command("garment.correct", toSneaker(shoeB)))).details).toMatchObject({ reason: "correction_would_release_restriction", restrictionId, garmentId: shoeB });

    // Undo puts the piece back under the restriction; that needs no acknowledgement.
    const undone = await owner.api.command("command.undo", { commandId: receipt.commandId });
    expect(undone.status, await undone.clone().text()).toBe(200);
    expect(await footwearKindOf(shoeA)).toBe("welted");
  });

  it("from a connected assistant, an acknowledgement is refused whatever it names, and nothing changes", async () => {
    const answer = toolResult(await writer.client.callTool({ name: "garderobe_command", arguments: { type: "garment.correct", payload: toSneaker(shoeB, { acknowledgedRestrictionIds: [restrictionId] }), idempotencyKey: `ack-${crypto.randomUUID()}` } }));
    expect(answer.ok).toBe(false);
    expect(answer.error).toMatchObject({ code: "forbidden", details: { reason: "restriction_acknowledgement_owner_only" } });
    expect(await footwearKindOf(shoeB)).toBe("welted");
    // Also for a correction that would not release anything: the field itself is the owner's.
    const harmless = toolResult(await writer.client.callTool({ name: "garderobe_command", arguments: { type: "garment.correct", payload: { garmentId: shoeB, changes: { colour: "SYNTHETIC dark brown" }, source: { kind: "owner_statement" }, acknowledgedRestrictionIds: [restrictionId] }, idempotencyKey: `ack-${crypto.randomUUID()}` } }));
    expect(harmless.error).toMatchObject({ code: "forbidden", details: { reason: "restriction_acknowledgement_owner_only" } });
    expect(await restrictionStatus()).toBe("active");
  });

  it("on confirming a proposal, an acknowledgement planted in the proposal is not used; the owner's own in the decision is", async () => {
    // A relayed turn from a read-only connection, whose stored proposal is then SET UP DIRECTLY as a
    // correction of shoe B that carries an acknowledgement (the assistant's tools cannot change a footwear kind).
    const reader = await connectMcp(owner, { write: false, clientName: "Read-only assistant (acknowledgement tests)" });
    const message = "I bought a SYNTHETIC grey scarf, add it to my wardrobe";
    model.script({ toolCalls: [{ toolName: "add_garment", input: { name: "SYNTHETIC grey scarf (acknowledgement tests)", category: "scarf", quantity: 1, state: "owned", ownerQuote: message } }] }, { text: "That needs your confirmation in the Garderobe app." });
    const asked = toolResult(await reader.client.callTool({ name: "garderobe_ask", arguments: { message, clientTurnId: `turn-${crypto.randomUUID()}`, mode: "wait" } }));
    expect(asked.ok, JSON.stringify(asked.error)).toBe(true);
    const turnId = asked.data.runId as string;
    const planted = { type: "garment.correct", summary: "SYNTHETIC: change shoe B to a sneaker", payload: toSneaker(shoeB, { acknowledgedRestrictionIds: [restrictionId] }), expectedVersions: {} };
    await (await db()).prepare("UPDATE assistant_turns SET proposals_json = ? WHERE user_id = ? AND turn_id = ?").bind(JSON.stringify([planted]), owner.userId, turnId).run();
    const proposal = ((await owner.api.json("GET", "/v1/proposals")).proposals as any[]).find((p) => p.turnId === turnId);
    expect(proposal).toMatchObject({ type: "garment.correct" });
    const decide = (body: Record<string, unknown>) => owner.api.post(`/v1/proposals/${proposal.proposalId}/decision`, body);

    // The planted acknowledgement is dropped: the confirmation is refused and names the restriction.
    const refused = await decide({ decision: "confirm" });
    expect(refused.status).toBe(403);
    expect((await errorOf(refused)).details).toMatchObject({ reason: "correction_would_release_restriction", restrictionId, garmentId: shoeB });
    expect(await footwearKindOf(shoeB)).toBe("welted");

    // Malformed or misplaced acknowledgements are refused before anything runs.
    expect((await decide({ decision: "reject", acknowledgedRestrictionIds: [restrictionId] })).status).toBe(400);
    expect((await decide({ decision: "confirm", acknowledgedRestrictionIds: [] })).status).toBe(400);
    expect((await decide({ decision: "confirm", acknowledgedRestrictionIds: "all" })).status).toBe(400);

    // The owner's own acknowledgement in his decision: confirmed once, the restriction stays active.
    const confirmed = await decide({ decision: "confirm", acknowledgedRestrictionIds: [restrictionId] });
    expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    const body = (await confirmed.json()) as any;
    expect(body).toMatchObject({ proposal: { state: "confirmed" }, receipt: { type: "garment.correct", outcome: "committed" } });
    expect(body.receipt.result.releasedFromRestrictions).toEqual([{ restrictionId, garmentIds: [shoeB] }]);
    expect(await footwearKindOf(shoeB)).toBe("sneaker");
    expect(await restrictionStatus()).toBe("active");
    await reader.close();
  });

  it("an acknowledgement is refused on the decision of a proposal that is not a garment correction", async () => {
    const answer = toolResult(await writer.client.callTool({ name: "garderobe_command", arguments: { type: "connection.register", payload: { kind: "mcp", label: "SYNTHETIC service (acknowledgement tests)", endpoint: "https://ack-tests.example.test/mcp", namespace: "ack_fixture" }, idempotencyKey: `ack-${crypto.randomUUID()}` } }));
    expect(answer.error?.code, JSON.stringify(answer)).toBe("confirmation_required");
    const proposal = ((await owner.api.json("GET", "/v1/proposals")).proposals as any[]).find((p) => p.type === "connection.register");
    const response = await owner.api.post(`/v1/proposals/${proposal.proposalId}/decision`, { decision: "confirm", acknowledgedRestrictionIds: [restrictionId] });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).details).toMatchObject({ reason: "acknowledgement_not_applicable" });
    expect((await owner.api.post(`/v1/proposals/${proposal.proposalId}/decision`, { decision: "reject" })).status).toBe(200);
  });

  it("refuses withLocation on signed rendition links while serving an authenticated original with location only on request", async () => {
    const ascii = (s: string) => new TextEncoder().encode(s);
    const heic = new Uint8Array(96);
    heic.set([0, 0, 0, 24]);
    heic.set(ascii("ftypheic"), 4);
    heic.set(ascii("mif1heic"), 16);
    heic.set(ascii("ispe"), 28);
    const v = new DataView(heic.buffer);
    v.setUint32(36, 256);
    v.setUint32(40, 256);
    heic.set(ascii("TEST-HEIC-POSITION"), 60);
    const uploaded = await uploadImage(owner, { intent: "attachment", bytes: heic, contentType: "image/heic" });
    const assetId = uploaded.complete.asset.assetId as string;
    const app = await testApp();
    for (let i = 0; i < 600; i++) {
      await app.media!.afterCommit();
      const open = await app.db.prepare("SELECT COUNT(*) AS n FROM media_jobs WHERE user_id = ? AND state IN ('queued', 'running')").bind(owner.userId).first<{ n: number }>();
      if ((open?.n ?? 0) === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const asSupplied = await owner.api.get(`/v1/media/assets/${assetId}?variant=original&withLocation=true`);
    expect(asSupplied.status).toBe(200);
    expect(new Uint8Array(await asSupplied.arrayBuffer())).toEqual(heic);
    expect((await owner.api.get(`/v1/media/assets/${assetId}?variant=original&withLocation=true&width=320`)).status).toBe(400);
    expect((await owner.api.get(`/v1/media/assets/${assetId}?variant=original&withLocation=yes`)).status).toBe(400);

    const rendition = await app.db.prepare("SELECT rendition_id FROM media_renditions WHERE user_id = ? AND asset_id = ? AND kind = 'original'").bind(owner.userId, assetId).first<{ rendition_id: string }>();
    for (const asked of [{ withLocation: true }, { withLocation: false }, { withLocation: "yes" }]) {
      const refused = await owner.api.post(`/v1/media/renditions/${rendition!.rendition_id}/sign`, asked);
      expect(refused.status, JSON.stringify(asked)).toBe(400);
      expect((await errorOf(refused)).details).toMatchObject({ reason: "signed_link_without_location" });
    }
    const without = await owner.api.json("POST", `/v1/media/renditions/${rendition!.rendition_id}/sign`, {});
    const claims = JSON.parse(atob(new URL(without.url, APP_ORIGIN).pathname.split("/").pop()!.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(claims.l).toBeUndefined();
  });

  it("refuses self-authenticated app routes on the MCP hostname (D10-2) and binds OAuth consent to the opening owner with strict CSP (A02-1)", async () => {
    const wrongHost = await SELF.fetch(`${MCP_ORIGIN}/v1/media/signed/tok_invalid`);
    expect(wrongHost.status).toBe(404);
    expect((await errorOf(wrongHost)).details).toMatchObject({ reason: "wrong_host" });

    const other = await provisionOwner({});
    const registration = (await (
      await SELF.fetch(`${MCP_ORIGIN}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Consent check assistant", redirect_uris: ["https://consent-check.client.test/cb"], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" }) })
    ).json()) as any;
    const url = new URL(`${APP_ORIGIN}/oauth/authorize`);
    url.search = new URLSearchParams({ response_type: "code", client_id: registration.client_id, redirect_uri: "https://consent-check.client.test/cb", scope: "wardrobe.read", state: "st-c", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256", resource: `${MCP_ORIGIN}/mcp` }).toString();
    const page = await SELF.fetch(url.toString(), { headers: await owner.api.with({ client: "web" }).headers(), redirect: "manual" });
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Security-Policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    const cookies = page.headers.getSetCookie().map((c) => c.split(";")[0]!).join("; ");
    const handle = /name="handle" value="([^"]+)"/.exec(await page.text())![1]!.replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)));
    const body = new URLSearchParams({ handle, decision: "approve", scope: "wardrobe.read" }).toString();
    const mismatch = await SELF.fetch(`${APP_ORIGIN}/oauth/authorize`, { method: "POST", headers: await other.api.with({ client: "web" }).headers({ "Content-Type": "application/x-www-form-urlencoded", Cookie: cookies }), body, redirect: "manual" });
    expect(mismatch.status).toBe(403);
  });

  it("announces more pages on garderobe_inventory only while nextCursor is present (D14-2)", async () => {
    const textOf = (result: { content?: unknown }): string => (result.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text ?? "";
    let cursor: string | null = null;
    let pages = 0;
    for (; pages < 20; pages++) {
      const raw = await writer.client.callTool({ name: "garderobe_inventory", arguments: { view: "items", limit: 1, ...(cursor ? { cursor } : {}) } });
      const page = toolResult(raw);
      expect(page.ok).toBe(true);
      cursor = page.data.nextCursor;
      if (cursor) expect(textOf(raw)).toContain("more pages: pass nextCursor");
      else {
        expect(textOf(raw)).not.toMatch(/more pages|pass nextCursor/i);
        expect(textOf(raw)).toContain("last page");
        break;
      }
    }
    expect(pages).toBeGreaterThan(0);
    expect(cursor).toBeNull();
  });
});
