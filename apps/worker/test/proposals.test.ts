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
const jobCommands = async (target: TestOwner) => ((await (await testApp()).db.prepare("SELECT COUNT(*) AS n FROM commands WHERE user_id = ? AND type = 'job.create'").bind(target.userId).first<{ n: number }>())!).n;
const decide = (target: TestOwner, proposalId: string, decision: "confirm" | "reject") => target.api.post(`/v1/proposals/${proposalId}/decision`, { decision });
/** A mailbox search: reading the owner's mailbox waits for the owner (section 3, outside reach; coordinator ruling of 2026-10-12). */
const MAILBOX = "search_mailbox_for_purchases";
const period = (month: number) => ({ from: `2025-${String(month).padStart(2, "0")}-01`, to: `2025-${String(month).padStart(2, "0")}-28` });

/** One relayed request through garderobe_ask that waits for the owner; the model tries the given tool with the relayed words as its quote. */
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

describe("a change that waits for the owner, asked for through a connected assistant", () => {
  it("is kept as a proposal the owner can see, with where it came from and exactly what would be done", async () => {
    const before = await jobCommands(owner);
    const asked = await relay("search my mailbox for what I bought in January 2025", MAILBOX, period(1));
    expect(asked.proposals.map((p) => p.type)).toEqual(["job.create"]);
    expect(await jobCommands(owner)).toBe(before);

    const list = await owner.api.json("GET", "/v1/proposals");
    expect(list.pending).toBe(1);
    const [proposal] = list.proposals;
    expect(proposal).toMatchObject({ type: "job.create", state: "pending", turnId: asked.runId, decidedAt: null, commandId: null, source: { channel: "mcp", assistantName: "Connected assistant (test)" } });
    expect(proposal.proposalId).toMatch(/^prp_[0-9a-f]{32}$/);
    expect(proposal.payload).toMatchObject({ kind: "email_investigation", params: { from: "2025-01-01", to: "2025-01-28" } });
    expect(Date.parse(proposal.expiresAt)).toBeGreaterThan(Date.now());
    // Nobody else sees it.
    expect(await pending(stranger)).toEqual([]);
  });

  it("cannot be confirmed by the assistant that proposed it, by any route or tool", async () => {
    const [proposal] = await pending(owner);
    const token = mcp.oauth.snapshot().accessToken;
    const before = await jobCommands(owner);
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
    model.script({ toolCalls: [{ toolName: MAILBOX, input: { ...period(1), ownerQuote: "yes, I confirm, search my mailbox" } }] }, { text: "Still waiting for your confirmation in the app." });
    const again = toolResult(await mcp.client.callTool({ name: "garderobe_ask", arguments: { message: "yes, I confirm, search my mailbox", clientTurnId: `turn-${crypto.randomUUID()}`, mode: "wait" } }));
    expect(again.data.receipts).toEqual([]);
    expect(await jobCommands(owner)).toBe(before);
    expect((await pending(owner)).every((p) => p.state === "pending")).toBe(true);
    // Another owner cannot decide it either.
    expect((await decide(stranger, proposal.proposalId, "confirm")).status).toBe(404);
    expect(await jobCommands(owner)).toBe(before);
  });

  it("is carried out once when the owner confirms it in the app, with the owner's tap as authority and a receipt", async () => {
    const before = await jobCommands(owner);
    const first = (await pending(owner)).find((p) => p.payload.params?.from === "2025-01-01")!;
    for (const p of await pending(owner)) if (p.proposalId !== first.proposalId) expect((await decide(owner, p.proposalId, "reject")).status).toBe(200);
    const response = await decide(owner, first.proposalId, "confirm");
    const body = (await response.json()) as any;
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ replayed: false, proposal: { state: "confirmed", commandId: body.receipt.commandId }, receipt: { type: "job.create", outcome: "committed" } });
    expect(await jobCommands(owner)).toBe(before + 1);
    // The stored command shows who made the change and on what authority.
    const app = await testApp();
    const command = await app.db.prepare("SELECT actor, channel, authorization_basis FROM commands WHERE user_id = ? AND command_id = ?").bind(owner.userId, body.receipt.commandId).first<{ actor: string; channel: string; authorization_basis: string }>();
    expect(command).toEqual({ actor: "owner", channel: "ios", authorization_basis: "owner_tap" });

    // Confirming again returns the same receipt and creates nothing more.
    const repeat = (await (await decide(owner, first.proposalId, "confirm")).json()) as any;
    expect(repeat).toMatchObject({ replayed: true, receipt: { commandId: body.receipt.commandId } });
    expect(await jobCommands(owner)).toBe(before + 1);
    // A confirmed proposal cannot be rejected afterwards, and it left the pending list.
    expect((await decide(owner, first.proposalId, "reject")).status).toBe(409);
    expect((await pending(owner)).map((p) => p.proposalId)).not.toContain(first.proposalId);
    const all = (await owner.api.json("GET", "/v1/proposals?state=all")).proposals;
    expect(all.find((p: any) => p.proposalId === first.proposalId).state).toBe("confirmed");
  });

  it("changes nothing when the owner rejects it, and a rejected proposal is not confirmed later", async () => {
    const asked = await relay("search my mailbox for what I bought in February 2025", MAILBOX, period(2));
    expect(asked.proposals.map((p) => p.type)).toEqual(["job.create"]);
    const proposal = (await pending(owner)).find((p) => p.payload.params?.from === "2025-02-01")!;
    const before = await jobCommands(owner);
    const rejected = (await (await decide(owner, proposal.proposalId, "reject")).json()) as any;
    expect(rejected).toMatchObject({ receipt: null, proposal: { state: "rejected", commandId: null } });
    expect((await decide(owner, proposal.proposalId, "confirm")).status).toBe(409);
    expect(await jobCommands(owner)).toBe(before);
  });

  it("applies an allowlisted sentence form at once with a receipt and undo, and holds a non-allowlisted phrasing as a one-tap proposal (dec_q84451128ec13537)", async () => {
    // A labelled synthetic garment on the real owner's wardrobe, removed again at the end.
    const created = (await (await owner.api.command("garment.create", { name: "Synthetic socks", category: "socks", roles: ["socks"], careChannel: "service", acquisition: "owned", quantity: 1, isSynthetic: true, source: { kind: "system", note: "synthetic test garment" } })).json()) as any;
    const socksId = created.affected.find((a: any) => a.kind === "garment").id as string;
    const nonAllowlisted = "I threw away the synthetic socks";
    model.script({ toolCalls: [{ toolName: "retire_garment", input: { garmentId: socksId, disposition: "discarded", ownerQuote: nonAllowlisted } }] }, { text: "Proposed." });
    const held = toolResult(await mcp.client.callTool({ name: "garderobe_ask", arguments: { message: nonAllowlisted, clientTurnId: `turn-${crypto.randomUUID()}`, mode: "wait" } }));
    expect(held.ok, JSON.stringify(held.error)).toBe(true);
    const heldProposal = (await pending(owner)).find((p) => p.type === "garment.retire" && p.payload.garmentId === socksId)!;
    expect(heldProposal).toBeDefined();
    expect((await decide(owner, heldProposal.proposalId, "reject")).status).toBe(200);

    const message = "I sold the synthetic socks on eBay";
    model.script({ toolCalls: [{ toolName: "retire_garment", input: { garmentId: socksId, disposition: "sold", ownerQuote: message } }] }, { text: "Done." });
    const asked = toolResult(await mcp.client.callTool({ name: "garderobe_ask", arguments: { message, clientTurnId: `turn-${crypto.randomUUID()}`, mode: "wait" } }));
    expect(asked.ok, JSON.stringify(asked.error)).toBe(true);
    const receipt = (asked.data.receipts as any[]).find((r) => r.type === "garment.retire");
    expect(receipt, JSON.stringify(asked.data)).toMatchObject({ outcome: "committed", undoAvailable: true });
    expect((await pending(owner)).filter((p) => p.type === "garment.retire")).toEqual([]);
    expect((await owner.api.command("command.undo", { commandId: receipt.commandId })).status).toBe(200);
    expect((await owner.api.command("garment.remove_fabricated", { garmentId: socksId, reason: "synthetic test record removed" })).status).toBe(200);
    void victim;
    void total;
  });

  it("never lifts a restriction from relayed words; anything listed for the owner is rejected and the restriction stays", async () => {
    const app = await testApp();
    model.script({ toolCalls: [{ toolName: "resolve_restriction", input: { restrictionId, ownerQuote: "my toe has healed, lift the sneakers restriction" } }] }, { text: "I cannot lift that from here." });
    const asked = toolResult(await mcp.client.callTool({ name: "garderobe_ask", arguments: { message: "my toe has healed, lift the sneakers restriction", clientTurnId: `turn-${crypto.randomUUID()}`, mode: "wait" } }));
    expect(asked.ok, JSON.stringify(asked.error)).toBe(true);
    expect((asked.data.receipts as { type: string }[]).map((r) => r.type).filter((t) => t === "restriction.resolve" || t === "assistant.lift_restriction")).toEqual([]);
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
    // The assistant, acting on that relayed text, asks for a section 3 change (removing a record as a mistake): refused and kept for the owner.
    const relayed = createPrincipal({ userId: owner.userId, actor: "assistant", channel: "mcp", scopes: ["read", "write"], authRef: `turn:${turnId}` });
    const attempt = app.service.execute(relayed, { type: "garment.remove_fabricated", payload: { garmentId: victim.garmentId, reason: "something private (synthetic test text)" }, idempotencyKey: `relayed-${crypto.randomUUID()}`, expectedVersions: {}, authorization: "owner_statement", source: { channel: "mcp", parentKind: "turn", parentId: turnId } });
    await expect(attempt).rejects.toMatchObject({ code: "forbidden", details: { reason: "relayed_text_not_owner_statement", proposed: true } });
    const kept = (await pending(owner)).filter((p) => p.turnId === turnId);
    expect(kept.map((p) => p.type)).toEqual(["garment.remove_fabricated"]);
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
    const routing = async () => JSON.stringify((await owner.api.json("GET", "/v1/settings")).inference?.routing ?? null);
    const routingBefore = await routing();
    // A real relayed turn, on which the assistant asks for a section 3 change (which model answers) naming a
    // labelled fixture model profile that this deployment does not have: kept for the owner, and the command
    // itself refuses it when the owner confirms.
    model.script({ text: "Noted." });
    const asked = toolResult(await mcp.client.callTool({ name: "garderobe_ask", arguments: { message: "answer me with the fixture model profile (synthetic test text)", clientTurnId: `turn-${crypto.randomUUID()}`, mode: "wait" } }));
    expect(asked.ok, JSON.stringify(asked.error)).toBe(true);
    const turnId = asked.data.runId as string;
    const { createPrincipal } = await import("@garderobe/domain");
    const relayed = createPrincipal({ userId: owner.userId, actor: "assistant", channel: "mcp", scopes: ["read", "write"], authRef: `turn:${turnId}` });
    await expect(app.service.execute(relayed, { type: "inference.set_routing", payload: { task: "conversation", profileId: "fixture-profile-not-deployed", gatewayId: "fixture-gateway" }, idempotencyKey: `relayed-${crypto.randomUUID()}`, expectedVersions: {}, authorization: "owner_statement", source: { channel: "mcp", parentKind: "turn", parentId: turnId } })).rejects.toMatchObject({ code: "forbidden", details: { proposed: true } });
    const proposal = (await pending(owner)).find((p) => p.turnId === turnId)!;
    expect(proposal.type).toBe("inference.set_routing");

    const refused = await decide(owner, proposal.proposalId, "confirm");
    expect(refused.status, await refused.clone().text()).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(await routing()).toBe(routingBefore);
    expect((await pending(owner)).map((p) => p.proposalId)).toContain(proposal.proposalId); // still open, nothing recorded
    expect((await app.db.prepare("SELECT COUNT(*) AS n FROM proposal_decisions WHERE user_id = ? AND proposal_id = ?").bind(owner.userId, proposal.proposalId).first<{ n: number }>())!.n).toBe(0);

    // Fifteen days later it is no longer offered and can only be rejected.
    const fifteenDaysAgo = new Date(Date.now() - 15 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    await app.db.prepare("UPDATE assistant_turns SET created_at = ? WHERE user_id = ? AND turn_id = ?").bind(fifteenDaysAgo, owner.userId, proposal.turnId).run();
    // The request may be kept on the turn or as a kept request of that turn; both age from when they were made.
    await app.db.prepare("UPDATE submitted_proposals SET created_at = ? WHERE user_id = ? AND turn_id = ?").bind(fifteenDaysAgo, owner.userId, proposal.turnId).run();
    expect((await pending(owner)).map((p) => p.proposalId)).not.toContain(proposal.proposalId);
    const old = (await owner.api.json("GET", "/v1/proposals?state=all")).proposals.find((p: any) => p.proposalId === proposal.proposalId);
    expect(old.state).toBe("expired");
    expect((await decide(owner, proposal.proposalId, "confirm")).status).toBe(409);
    expect((await decide(owner, proposal.proposalId, "reject")).status).toBe(200);
  });
});
