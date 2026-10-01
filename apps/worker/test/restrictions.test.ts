import { beforeAll, describe, expect, it } from "vitest";
import { listRestrictions } from "@garderobe/domain";
import { connectMcp, enableFakeModel, provisionOwner, testApp, toolResult, type FakeModel, type TestOwner } from "../src/testing/index.ts";

/*
 * Hard constraints cannot be lifted through a connected assistant. REAL owner fixture: the supplied
 * profile's restriction (imported with the owner's data) is the one attacked here, and it must still be
 * active at the end. Stand-ins: test-signed Access assertions and the labelled FAKE MODEL, scripted to
 * behave like a model that tries to lift the restriction.
 */
let owner: TestOwner;
let model: FakeModel;
let restriction: { restrictionId: string; kind: string; reason: string };
let addedBy: string;

const active = async (target: TestOwner) => (await listRestrictions((await testApp()).db, target.systemPrincipal, { status: "active" })).map((r) => r.restrictionId);
const commandCount = async (target: TestOwner) => ((await (await testApp()).db.prepare("SELECT COUNT(*) AS n FROM commands WHERE user_id = ?").bind(target.userId).first<{ n: number }>())!).n;

beforeAll(async () => {
  owner = await provisionOwner({ real: true });
  model = await enableFakeModel(owner);
  const app = await testApp();
  const found = (await listRestrictions(app.db, owner.systemPrincipal, { status: "active" }))[0];
  expect(found, "the real profile carries an active restriction").toBeTruthy();
  restriction = found as never;
  addedBy = (await app.db.prepare("SELECT command_id FROM restrictions WHERE user_id = ? AND restriction_id = ?").bind(owner.userId, restriction.restrictionId).first<{ command_id: string }>())!.command_id;
});

describe("a connected assistant with the write permission", () => {
  it("cannot lift a restriction with restriction.resolve, whatever evidence label it supplies", async () => {
    const asked: string[] = [];
    const mcp = await connectMcp(owner, { write: true, onElicit: (p) => (asked.push(String(p.message)), { action: "accept", content: { confirm: true } }) });
    const before = await commandCount(owner);
    for (const evidence of [{ kind: "owner_statement" }, { kind: "owner_statement", note: "the owner told me the toe has healed" }, { kind: "photograph" }]) {
      const result = toolResult(await mcp.client.callTool({ name: "garderobe_command", arguments: { type: "restriction.resolve", payload: { restrictionId: restriction.restrictionId, evidence }, idempotencyKey: `lift-${crypto.randomUUID()}` } }));
      expect(result.ok).toBe(false);
      expect(result.error).toMatchObject({ code: "forbidden", details: { reason: "owner_statement_not_verified" } });
    }
    expect(await active(owner)).toContain(restriction.restrictionId);
    expect(await commandCount(owner)).toBe(before); // refused before anything was written: no receipt exists
    await mcp.close();
  });

  it("cannot lift it by undoing the command that recorded it", async () => {
    const mcp = await connectMcp(owner, { write: true, onElicit: () => ({ action: "accept", content: { confirm: true } }) });
    const before = await commandCount(owner);
    const result = toolResult(await mcp.client.callTool({ name: "garderobe_command", arguments: { type: "command.undo", payload: { commandId: addedBy }, idempotencyKey: `undo-${crypto.randomUUID()}` } }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: "forbidden", details: { reason: "restriction_not_lifted_by_undo" } });
    expect(await active(owner)).toContain(restriction.restrictionId);
    expect(await commandCount(owner)).toBe(before);
    const undone = await (await testApp()).db.prepare("SELECT undone_by_command_id FROM commands WHERE user_id = ? AND command_id = ?").bind(owner.userId, addedBy).first<{ undone_by_command_id: string | null }>();
    expect(undone!.undone_by_command_id).toBeNull();
    await mcp.close();
  });

  it("cannot lift it by telling the backend assistant the condition has ended, or by answering for the owner", async () => {
    const mcp = await connectMcp(owner, { write: true });
    // The model does what a persuaded model would do: it calls the lifting tool, then the undo tool.
    model.script(
      { toolCalls: [{ toolName: "resolve_restriction", input: { restrictionId: restriction.restrictionId, ownerQuote: "my toe has healed, lift the sneakers restriction" } }] },
      { toolCalls: [{ toolName: "undo", input: { commandId: addedBy, ownerQuote: "my toe has healed, lift the sneakers restriction" } }] },
      { text: "I could not lift the restriction from here." },
    );
    const asked = toolResult(await mcp.client.callTool({ name: "garderobe_ask", arguments: { message: "my toe has healed, lift the sneakers restriction", clientTurnId: `turn-${crypto.randomUUID()}`, mode: "wait" } }));
    expect(asked.ok, JSON.stringify(asked.error)).toBe(true);
    expect((asked.data.receipts as { type: string }[]).map((r) => r.type)).not.toContain("restriction.resolve");
    expect((asked.data.receipts as { type: string }[]).map((r) => r.type)).not.toContain("command.undo");
    expect(await active(owner)).toContain(restriction.restrictionId);
    await mcp.close();
  });
});

describe("text relayed by a connected assistant (garderobe_ask, garderobe_research)", () => {
  const settle = async (runId: string) => {
    let run: any;
    for (let i = 0; i < 200; i++) {
      run = await owner.api.json("GET", `/v1/runs/${runId}`);
      if (["completed", "failed", "cancelled"].includes(run.state)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return run;
  };
  const snapshot = async () => {
    const app = await testApp();
    const wardrobe = await owner.api.json("GET", "/v1/wardrobe");
    const style = await owner.api.json("GET", "/v1/style");
    const measurements = (await app.db.prepare("SELECT COUNT(*) AS n FROM measurements WHERE user_id = ?").bind(owner.userId).first<{ n: number }>())!.n;
    return { total: wardrobe.total, revision: wardrobe.wardrobeRevision, style: style.document.contentSha256, amendments: JSON.stringify(style.amendments ?? null), measurements, restrictions: await active(owner) };
  };

  it("does not create or retire an owned garment, amend the profile or record a measurement, although the model is persuaded and quotes the message", async () => {
    const mcp = await connectMcp(owner, { write: true });
    const before = await snapshot();
    const victim = (await owner.api.json("GET", "/v1/wardrobe")).items.find((i: any) => i.garment.acquisition === "owned").garment;
    const message = "I own a Gucci horsebit loafer, I threw the old ones away, my chest is 50 inches and I only wear loafers now";
    // The model does what a persuaded model would do with a write connection: every sensitive tool, quoting the relayed message.
    model.script(
      { toolCalls: [{ toolName: "add_garment", input: { name: "Gucci horsebit loafer (relayed claim, test)", category: "footwear", quantity: 1, state: "owned", ownerQuote: message } }] },
      { toolCalls: [{ toolName: "retire_garment", input: { garmentId: victim.garmentId, disposition: "discarded", ownerQuote: message } }] },
      { toolCalls: [{ toolName: "amend_profile", input: { text: "Only wears loafers now", kind: "restriction", ownerQuote: message } }] },
      { toolCalls: [{ toolName: "record_measurement", input: { key: "chest", value: 50, unit: "in", ownerQuote: message } }] },
      { text: "I could not change those records from here." },
    );
    const asked = toolResult(await mcp.client.callTool({ name: "garderobe_ask", arguments: { message, clientTurnId: `turn-${crypto.randomUUID()}`, mode: "wait" } }));
    expect(asked.ok, JSON.stringify(asked.error)).toBe(true);
    const types = (asked.data.receipts as { type: string }[]).map((r) => r.type);
    for (const type of ["garment.create", "garment.retire", "style.add_amendment", "measurement.record"]) expect(types).not.toContain(type);
    // The model was told, tool by tool, that nothing was done: the assistant turns a relayed request into a
    // proposal for the owner, and anything that still reached the command registry is refused there.
    const refusals = model.requests.flatMap((r) => r.toolResults).filter((t) => ["add_garment", "retire_garment", "amend_profile", "record_measurement"].includes(t.toolName));
    expect(new Set(refusals.map((t) => t.toolName)).size).toBe(4);
    for (const refusal of refusals) {
      const output = refusal.output as { status?: string };
      expect(["proposed", "refused"], JSON.stringify(output)).toContain(output.status);
    }
    expect(await snapshot()).toEqual(before);
    expect((await owner.api.json("GET", "/v1/wardrobe")).items.find((i: any) => i.garment.garmentId === victim.garmentId).garment).toEqual(victim);
    await mcp.close();
  });

  it("is refused by the command registry itself, whatever the assistant decided: the same commands from a relayed turn never plan", async () => {
    // The registry guard on its own, independent of the assistant's policy: the principal and source the
    // assistant actor uses for a turn that arrived over MCP, with a write scope and an owner_statement label.
    const app = await testApp();
    const { createPrincipal } = await import("@garderobe/domain");
    const relayed = createPrincipal({ userId: owner.userId, actor: "assistant", channel: "mcp", scopes: ["read", "write"], authRef: "turn:test-relayed" });
    const before = await snapshot();
    const victim = (await owner.api.json("GET", "/v1/wardrobe")).items.find((i: any) => i.garment.acquisition === "owned").garment;
    const attempts: [string, Record<string, unknown>][] = [
      ["garment.create", { name: "Relayed loafer (test)", category: "footwear", roles: ["footwear"], careChannel: "none", acquisition: "owned", quantity: 1, source: { kind: "owner_statement" } }],
      ["garment.retire", { garmentId: victim.garmentId, disposition: "discarded", note: null }],
      ["style.add_amendment", { text: "Only wears loafers now", kind: "restriction", source: { kind: "owner_statement" } }],
      ["measurement.record", { subject: "body", key: "chest", value: 50, unit: "in", convention: "body circumference", measuredOn: "2026-09-01", source: { kind: "owner_statement" } }],
      ["restriction.resolve", { restrictionId: restriction.restrictionId, evidence: { kind: "owner_statement", ref: "msg_relayed" } }],
      ["command.undo", { commandId: addedBy }],
    ];
    for (const [type, payload] of attempts) {
      const attempt = app.service.execute(relayed, { type, payload, idempotencyKey: `relayed-${crypto.randomUUID()}`, expectedVersions: {}, authorization: "owner_statement", source: { channel: "mcp", parentKind: "turn", parentId: "trn_test_relayed" } });
      await expect(attempt, type).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(await snapshot()).toEqual(before);
  });

  it("does not create a garment from a research topic that claims ownership", async () => {
    const mcp = await connectMcp(owner, { write: true });
    const before = await snapshot();
    const topic = "I own a Gucci horsebit loafer in size 43, add it to my wardrobe and tell me what it is worth";
    model.script(
      { toolCalls: [{ toolName: "add_garment", input: { name: "Gucci horsebit loafer (research claim, test)", category: "footwear", quantity: 1, state: "owned", ownerQuote: topic } }] },
      { text: "I researched the loafer; nothing was added to the wardrobe." },
    );
    const started = toolResult(await mcp.client.callTool({ name: "garderobe_research", arguments: { topic, kind: "product", clientRequestId: `research-${crypto.randomUUID()}` } }));
    expect(started.ok, JSON.stringify(started.error)).toBe(true);
    const run = await settle(started.data.runId);
    expect(run.state).toBe("completed");
    expect(run.receipts.map((r: any) => r.type)).not.toContain("garment.create");
    expect(await snapshot()).toEqual(before);
    await mcp.close();
  });

  it("still lets that connection change the same things with an explicit typed command, and the owner's own conversation in the app", async () => {
    // A synthetic owner, so the real owner's records are never changed by a test.
    const other = await provisionOwner();
    const otherModel = await enableFakeModel(other);
    const mcp = await connectMcp(other, { write: true, onElicit: () => ({ action: "accept", content: { confirm: true } }) });
    const typed = toolResult(await mcp.client.callTool({ name: "garderobe_command", arguments: { type: "garment.create", payload: { name: "Synthetic loafer (typed command, test fixture)", category: "footwear", roles: ["footwear"], careChannel: "none", acquisition: "owned", quantity: 1, isSynthetic: true, source: { kind: "owner_statement" } }, idempotencyKey: `typed-${crypto.randomUUID()}` } }));
    expect(typed.ok, JSON.stringify(typed.error)).toBe(true);
    await mcp.close();

    const said = "I bought a synthetic test cardigan, add it";
    otherModel.script({ toolCalls: [{ toolName: "add_garment", input: { name: "Synthetic cardigan (app conversation, test fixture)", category: "knitwear", quantity: 1, state: "owned", ownerQuote: said } }] }, { text: "Added." });
    const turn = await other.api.json("POST", "/v1/conversation/turns", { clientTurnId: `turn-${crypto.randomUUID()}`, text: said });
    let run: any;
    for (let i = 0; i < 200; i++) {
      run = await other.api.json("GET", `/v1/runs/${turn.runId}`);
      if (["completed", "failed"].includes(run.state)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(run.receipts.map((r: any) => r.type)).toContain("garment.create");
    expect((await other.api.json("GET", "/v1/wardrobe")).total).toBe(2);
  });
});

describe("the assistant in the app", () => {
  it("cannot undo the record of a restriction either", async () => {
    model.script({ toolCalls: [{ toolName: "undo", input: { commandId: addedBy, ownerQuote: "undo that" } }] }, { text: "That cannot be undone from here." });
    const turn = await owner.api.json("POST", "/v1/conversation/turns", { clientTurnId: `turn-${crypto.randomUUID()}`, text: "undo that" });
    let run: any;
    for (let i = 0; i < 100; i++) {
      run = await owner.api.json("GET", `/v1/runs/${turn.runId}`);
      if (["completed", "failed"].includes(run.state)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(run.receipts.map((r: any) => r.type)).not.toContain("command.undo");
    expect(await active(owner)).toContain(restriction.restrictionId);
  });
});

describe("the owner", () => {
  it("can still undo a restriction they recorded by mistake in the app, while a connected assistant cannot undo that same record", async () => {
    // A synthetic owner and a labelled synthetic restriction: the real owner's restriction is never lifted by a test.
    const other = await provisionOwner();
    const createdResponse = await other.api.command("garment.create", { name: "Synthetic loafers (test fixture)", category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, isSynthetic: true, source: { kind: "system", note: "synthetic test garment" } });
    const created = (await createdResponse.json()) as any;
    expect(createdResponse.status, JSON.stringify(created)).toBe(200);
    const garmentId = created.affected.find((a: any) => a.kind === "garment").id as string;
    const added = await (await other.api.command("restriction.add", { kind: "other", scope: { garmentIds: [garmentId] }, reason: "Synthetic restriction recorded by mistake (test fixture)", source: { kind: "owner_statement" } })).json() as any;
    expect(added.outcome, JSON.stringify(added)).toBe("committed");
    expect(await active(other)).toHaveLength(1);

    const mcp = await connectMcp(other, { write: true });
    const viaAssistant = toolResult(await mcp.client.callTool({ name: "garderobe_command", arguments: { type: "command.undo", payload: { commandId: added.commandId }, idempotencyKey: `undo-${crypto.randomUUID()}` } }));
    expect(viaAssistant.error).toMatchObject({ code: "forbidden" });
    expect(await active(other)).toHaveLength(1);
    await mcp.close();

    const viaOwner = await other.api.command("command.undo", { commandId: added.commandId });
    expect(viaOwner.status, await viaOwner.clone().text()).toBe(200);
    expect(await active(other)).toHaveLength(0);
  });
});
