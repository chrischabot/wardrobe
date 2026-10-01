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
