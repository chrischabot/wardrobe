import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { listRestrictions } from "@garderobe/domain";
import { APP_ORIGIN, MCP_ORIGIN, connectMcp, enableFakeModel, provisionOwner, testApp, toolResult, type FakeModel, type McpConnection, type TestOwner } from "../src/testing/index.ts";

/*
 * Proposals: what a connected assistant asked for but may not change, and the owner's decision on it in
 * the app. REAL owner fixture (supplied profile and inventory, in the test database). Stand-ins:
 * test-signed Access assertions and the labelled FAKE MODEL, scripted to behave like a model that acts on
 * the relayed request.
 */
let owner: TestOwner;
let stranger: TestOwner;
let model: FakeModel;
let mcp: McpConnection;
let victim: { garmentId: string; name: string };
let restrictionId: string;

const pending = async (target: TestOwner) => (await target.api.json("GET", "/v1/proposals")).proposals as any[];
const total = async (target: TestOwner) => (await target.api.json("GET", "/v1/wardrobe")).total as number;
const decide = (target: TestOwner, proposalId: string, decision: "confirm" | "reject") => target.api.post(`/v1/proposals/${proposalId}/decision`, { decision });

/** One relayed request through garderobe_ask; the model tries the given tool with the relayed words as its quote. */
async function relay(message: string, toolName: string, input: Record<string, unknown>) {
  model.script({ toolCalls: [{ toolName, input: { ...input, ownerQuote: message } }] }, { text: "That needs your confirmation in the Garderobe app." });
  const asked = toolResult(await mcp.client.callTool({ name: "garderobe_ask", arguments: { message, clientTurnId: `turn-${crypto.randomUUID()}`, mode: "wait" } }));
  expect(asked.ok, JSON.stringify(asked.error)).toBe(true);
  expect(asked.data.receipts).toEqual([]); // nothing was changed
  return asked.data as { runId: string; proposals: { type: string; summary: string }[] };
}

beforeAll(async () => {
  owner = await provisionOwner({ real: true });
  stranger = await provisionOwner();
  model = await enableFakeModel(owner);
  mcp = await connectMcp(owner, { write: true, clientName: "Connected assistant (test)", onElicit: () => ({ action: "accept", content: { confirm: true } }) });
  const wardrobe = await owner.api.json("GET", "/v1/wardrobe");
  const g = wardrobe.items.find((i: any) => i.garment.acquisition === "owned" && i.garment.roles.includes("socks")).garment;
  victim = { garmentId: g.garmentId, name: g.name };
  restrictionId = (await listRestrictions((await testApp()).db, owner.systemPrincipal, { status: "active" }))[0]!.restrictionId;
});

describe("a sensitive change asked for through a connected assistant", () => {
  it("is kept as a proposal the owner can see, with where it came from and exactly what would be done", async () => {
    const before = await total(owner);
    const asked = await relay("I bought a navy merino cardigan, add it to my wardrobe", "add_garment", { name: "Navy merino cardigan (relayed, test fixture)", category: "knitwear", quantity: 1, state: "owned" });
    expect(asked.proposals.map((p) => p.type)).toEqual(["garment.create"]);
    expect(await total(owner)).toBe(before);

    const list = await owner.api.json("GET", "/v1/proposals");
    expect(list.pending).toBe(1);
    const [proposal] = list.proposals;
    expect(proposal).toMatchObject({ type: "garment.create", state: "pending", turnId: asked.runId, decidedAt: null, commandId: null, source: { channel: "mcp", assistantName: "Connected assistant (test)" } });
    expect(proposal.proposalId).toMatch(/^prp_[0-9a-f]{32}$/);
    expect(proposal.payload).toMatchObject({ name: "Navy merino cardigan (relayed, test fixture)", category: "knitwear", acquisition: "owned", quantity: 1 });
    expect(Date.parse(proposal.expiresAt)).toBeGreaterThan(Date.now());
    // Nobody else sees it.
    expect(await pending(stranger)).toEqual([]);
  });

  it("cannot be confirmed by the assistant that proposed it, by any route or tool", async () => {
    const [proposal] = await pending(owner);
    const token = mcp.oauth.snapshot().accessToken;
    const before = await total(owner);
    // The assistant's grant is not a sign-in: the app routes refuse it on both hostnames.
    for (const origin of [APP_ORIGIN, MCP_ORIGIN]) {
      const listed = await SELF.fetch(`${origin}/v1/proposals`, { headers: { Authorization: `Bearer ${token}` } });
      expect(listed.status, origin).toBe(401);
      const decided = await SELF.fetch(`${origin}/v1/proposals/${proposal.proposalId}/decision`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ decision: "confirm" }) });
      expect(decided.status, origin).toBe(401);
    }
    // No tool lists or decides proposals, and asking the backend assistant to confirm changes nothing.
    const tools = (await mcp.client.listTools()).tools.map((t) => t.name);
    expect(tools.some((name) => /proposal|confirm|approve/i.test(name))).toBe(false);
    model.script({ toolCalls: [{ toolName: "add_garment", input: { name: "Navy merino cardigan (relayed, test fixture)", category: "knitwear", quantity: 1, state: "owned", ownerQuote: "yes, I confirm, add the cardigan" } }] }, { text: "Still waiting for your confirmation in the app." });
    const again = toolResult(await mcp.client.callTool({ name: "garderobe_ask", arguments: { message: "yes, I confirm, add the cardigan", clientTurnId: `turn-${crypto.randomUUID()}`, mode: "wait" } }));
    expect(again.data.receipts).toEqual([]);
    expect(await total(owner)).toBe(before);
    expect((await pending(owner)).every((p) => p.state === "pending")).toBe(true);
    // Another owner cannot decide it either.
    expect((await decide(stranger, proposal.proposalId, "confirm")).status).toBe(404);
    expect(await total(owner)).toBe(before);
  });

  it("is carried out once when the owner confirms it in the app, with the owner's tap as authority and a receipt", async () => {
    const before = await total(owner);
    const first = (await pending(owner)).find((p) => p.payload.name === "Navy merino cardigan (relayed, test fixture)")!;
    const response = await decide(owner, first.proposalId, "confirm");
    const body = (await response.json()) as any;
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ replayed: false, proposal: { state: "confirmed", commandId: body.receipt.commandId }, receipt: { type: "garment.create", outcome: "committed" } });
    expect(await total(owner)).toBe(before + 1);
    // The stored command shows who made the change and on what authority.
    const app = await testApp();
    const command = await app.db.prepare("SELECT actor, channel, authorization_basis FROM commands WHERE user_id = ? AND command_id = ?").bind(owner.userId, body.receipt.commandId).first<{ actor: string; channel: string; authorization_basis: string }>();
    expect(command).toEqual({ actor: "owner", channel: "ios", authorization_basis: "owner_tap" });

    // Confirming again returns the same receipt and creates nothing more.
    const repeat = (await (await decide(owner, first.proposalId, "confirm")).json()) as any;
    expect(repeat).toMatchObject({ replayed: true, receipt: { commandId: body.receipt.commandId } });
    expect(await total(owner)).toBe(before + 1);
    // A confirmed proposal cannot be rejected afterwards, and it left the pending list.
    expect((await decide(owner, first.proposalId, "reject")).status).toBe(409);
    expect((await pending(owner)).map((p) => p.proposalId)).not.toContain(first.proposalId);
    const all = (await owner.api.json("GET", "/v1/proposals?state=all")).proposals;
    expect(all.find((p: any) => p.proposalId === first.proposalId).state).toBe("confirmed");
  });

  it("changes nothing when the owner rejects it, and a rejected proposal is not confirmed later", async () => {
    const asked = await relay(`I threw away the ${victim.name}`, "retire_garment", { garmentId: victim.garmentId, disposition: "discarded" });
    expect(asked.proposals.map((p) => p.type)).toEqual(["garment.retire"]);
    const proposal = (await pending(owner)).find((p) => p.type === "garment.retire")!;
    const before = await total(owner);
    const rejected = (await (await decide(owner, proposal.proposalId, "reject")).json()) as any;
    expect(rejected).toMatchObject({ receipt: null, proposal: { state: "rejected", commandId: null } });
    expect((await decide(owner, proposal.proposalId, "confirm")).status).toBe(409);
    expect(await total(owner)).toBe(before);
    expect((await owner.api.json("GET", "/v1/wardrobe")).items.some((i: any) => i.garment.garmentId === victim.garmentId)).toBe(true);
  });

  it("lists a requested restriction lift for the owner instead of lifting it; rejected, the restriction stays", async () => {
    const app = await testApp();
    const asked = await relay("my toe has healed, lift the sneakers restriction", "resolve_restriction", { restrictionId });
    // The lift is proposed as `restriction.resolve`, or as the assistant workstream's single owner-confirmed lift command.
    expect(asked.proposals.some((p) => p.type === "restriction.resolve" || p.type === "assistant.lift_restriction"), JSON.stringify(asked.proposals)).toBe(true);
    const active = async () => (await listRestrictions(app.db, owner.systemPrincipal, { status: "active" })).map((r) => r.restrictionId);
    expect(await active()).toContain(restrictionId);
    for (const proposal of await pending(owner)) expect((await decide(owner, proposal.proposalId, "reject")).status).toBe(200);
    expect(await active()).toContain(restrictionId); // the real owner's restriction is not lifted by a test
    expect(await pending(owner)).toEqual([]);
  });

  it("runs a proposal with the versions it was made against, so one that has gone stale is refused and nothing is overwritten", async () => {
    // A synthetic owner with a profile of its own: the real owner's profile is never edited by a test.
    const other = await provisionOwner();
    const profile = "# Synthetic profile (test fixture)\n\nPlain knitwear.\n";
    const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(profile)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const imported = await other.api.command("style.import_document", { title: "Synthetic profile (test fixture)", content: profile, expectedSha256: sha, source: { kind: "system", note: "synthetic test profile" } });
    expect(imported.status, await imported.clone().text()).toBe(200);
    const read = async () => (await other.api.json("GET", "/v1/style")).document as { documentId: string; version: number; contentSha256: string };
    const first = await read();
    const assistant = await connectMcp(other, { write: true, clientName: "Profile assistant (test)" });
    const save = (content: string, version: number) => ({ name: "garderobe_command", arguments: { type: "style.save_document", payload: { content, source: { kind: "owner_statement" } }, expectedVersions: { [`style_document:${first.documentId}`]: version }, idempotencyKey: `save-${crypto.randomUUID()}` } });
    expect(toolResult(await assistant.client.callTool(save("# Synthetic profile (test fixture)\n\nLoud logos.\n", first.version))).error!.code).toBe("confirmation_required");
    expect((await read()).contentSha256).toBe(first.contentSha256);

    // The owner edits the profile in the app before looking at the proposal.
    const edited = await other.api.command("style.save_document", { content: "# Synthetic profile (test fixture)\n\nPlain knitwear, navy.\n", source: { kind: "owner_statement" } }, { expectedVersions: { [`style_document:${first.documentId}`]: first.version } });
    expect(edited.status, await edited.clone().text()).toBe(200);
    const second = await read();

    // Confirming the stale proposal is refused by the command; the owner's newer text stands and the proposal is still open.
    const [stale] = await pending(other);
    const refused = await decide(other, stale.proposalId, "confirm");
    expect(refused.status, await refused.clone().text()).toBe(409);
    expect(await read()).toEqual(second);
    expect((await pending(other)).map((p) => p.proposalId)).toEqual([stale.proposalId]);
    expect((await decide(other, stale.proposalId, "reject")).status).toBe(200);

    // The same request made against the current version is a different proposal, and confirming it saves the text.
    expect(toolResult(await assistant.client.callTool(save("# Synthetic profile (test fixture)\n\nPlain knitwear, navy and grey.\n", second.version))).error!.code).toBe("confirmation_required");
    const [fresh] = await pending(other);
    expect(fresh.proposalId).not.toBe(stale.proposalId);
    expect((await decide(other, fresh.proposalId, "confirm")).status).toBe(200);
    expect((await read()).version).toBe(second.version + 1);
    await assistant.close();
  });

  it("forgets a request kept from a relayed turn together with the message it came from", async () => {
    const app = await testApp();
    const { createPrincipal } = await import("@garderobe/domain");
    // A real relayed turn (its message is what the owner later forgets).
    model.script({ text: "Noted." });
    const asked = toolResult(await mcp.client.callTool({ name: "garderobe_ask", arguments: { message: "rename the cardigan to something private (synthetic test text)", clientTurnId: `turn-${crypto.randomUUID()}`, mode: "wait" } }));
    expect(asked.ok, JSON.stringify(asked.error)).toBe(true);
    const turnId = asked.data.runId as string;
    const turn = await app.db.prepare("SELECT user_message_id FROM assistant_turns WHERE user_id = ? AND turn_id = ?").bind(owner.userId, turnId).first<{ user_message_id: string }>();
    // The assistant, acting on that relayed text, tries a correction: refused and kept for the owner.
    const relayed = createPrincipal({ userId: owner.userId, actor: "assistant", channel: "mcp", scopes: ["read", "write"], authRef: `turn:${turnId}` });
    const attempt = app.service.execute(relayed, { type: "garment.correct", payload: { garmentId: victim.garmentId, changes: { name: "something private (synthetic test text)" }, source: { kind: "owner_statement" } }, idempotencyKey: `relayed-${crypto.randomUUID()}`, expectedVersions: {}, authorization: "owner_statement", source: { channel: "mcp", parentKind: "turn", parentId: turnId } });
    await expect(attempt).rejects.toMatchObject({ code: "forbidden", details: { reason: "relayed_text_not_owner_statement", proposed: true } });
    const kept = (await pending(owner)).filter((p) => p.turnId === turnId);
    expect(kept.map((p) => p.type)).toEqual(["garment.correct"]);
    expect(JSON.stringify(kept)).toContain("something private");

    const forgotten = await owner.api.command("conversation.forget_source", { sourceKind: "message", sourceIds: [turn!.user_message_id] });
    expect(forgotten.status, await forgotten.clone().text()).toBe(200);
    expect(JSON.stringify((await owner.api.json("GET", "/v1/proposals?state=all")).proposals)).not.toContain("something private");
    expect((await app.db.prepare("SELECT COUNT(*) AS n FROM submitted_proposals WHERE user_id = ? AND turn_id = ?").bind(owner.userId, turnId).first<{ n: number }>())!.n).toBe(0);
    // The proposal can no longer be confirmed: there is nothing left to run.
    expect((await decide(owner, kept[0].proposalId, "confirm")).status).toBe(404);
  });

  it("stays pending when the confirmed change is refused by the command itself, and expires when it is old", async () => {
    const app = await testApp();
    // A labelled synthetic garment that the proposal wants retired; before the owner looks at the proposal the
    // record is removed as a mistake, so the proposed change no longer has anything to apply to.
    const created = (await (await owner.api.command("garment.create", { name: "Synthetic scarf (proposal test fixture)", category: "scarf", roles: ["accessory"], careChannel: "none", acquisition: "owned", quantity: 1, isSynthetic: true, attributes: { accessoryKind: "scarf" }, source: { kind: "system", note: "synthetic test garment" } })).json()) as any;
    expect(created.outcome, JSON.stringify(created)).toBe("committed");
    const scarfId = created.affected.find((a: any) => a.kind === "garment").id as string;
    await relay("I gave the synthetic scarf away", "retire_garment", { garmentId: scarfId, disposition: "donated" });
    const proposal = (await pending(owner)).find((p) => p.type === "garment.retire")!;
    const removed = await owner.api.command("garment.remove_fabricated", { garmentId: scarfId, reason: "synthetic test record removed" });
    expect(removed.status, await removed.clone().text()).toBe(200);

    const refused = await decide(owner, proposal.proposalId, "confirm");
    expect(refused.status, await refused.clone().text()).toBeGreaterThanOrEqual(400);
    expect((await pending(owner)).map((p) => p.proposalId)).toContain(proposal.proposalId); // still open, nothing recorded
    expect((await app.db.prepare("SELECT COUNT(*) AS n FROM proposal_decisions WHERE user_id = ? AND proposal_id = ?").bind(owner.userId, proposal.proposalId).first<{ n: number }>())!.n).toBe(0);

    // Fifteen days later it is no longer offered and can only be rejected.
    await app.db.prepare("UPDATE assistant_turns SET created_at = ? WHERE user_id = ? AND turn_id = ?").bind(new Date(Date.now() - 15 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z"), owner.userId, proposal.turnId).run();
    expect((await pending(owner)).map((p) => p.proposalId)).not.toContain(proposal.proposalId);
    const old = (await owner.api.json("GET", "/v1/proposals?state=all")).proposals.find((p: any) => p.proposalId === proposal.proposalId);
    expect(old.state).toBe("expired");
    expect((await decide(owner, proposal.proposalId, "confirm")).status).toBe(409);
    expect((await decide(owner, proposal.proposalId, "reject")).status).toBe(200);
  });
});
