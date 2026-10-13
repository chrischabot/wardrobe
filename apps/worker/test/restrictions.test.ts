import { beforeAll, describe, expect, it } from "vitest";
import { listRestrictions } from "@garderobe/domain";
import { connectMcp, enableFakeModel, ownerDay, provisionOwner, testApp, toolResult, type FakeModel, type TestOwner } from "../src/testing/index.ts";

/*
 * Hard constraints cannot be lifted through a connected assistant, while what the owner asks for (relayed
 * words included) applies at once with a receipt and an undo (contract of 2026-10-05). REAL owner fixture:
 * the supplied profile's restriction (imported with the owner's data) is the one attacked here, and it must
 * still be active at the end; changes that are applied are made on SYNTHETIC owners. Stand-ins: test-signed
 * Access assertions and the labelled FAKE MODEL, scripted to behave like a model acting on the message.
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
      expect(result.error).toMatchObject({ code: "forbidden" });
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
    expect(result.error).toMatchObject({ code: "forbidden" });
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
    const types = (asked.data.receipts as { type: string }[]).map((r) => r.type);
    for (const type of ["restriction.resolve", "assistant.lift_restriction", "command.undo"]) expect(types).not.toContain(type);
    expect(await active(owner)).toContain(restriction.restrictionId);
    for (const p of ((await owner.api.json("GET", "/v1/proposals")).proposals as any[])) expect((await owner.api.post(`/v1/proposals/${p.proposalId}/decision`, { decision: "reject" })).status).toBe(200);
    await mcp.close();
  });
});

describe("text relayed by a connected assistant (garderobe_ask, garderobe_research)", () => {
  const settle = async (target: TestOwner, runId: string) => {
    let run: any;
    for (let i = 0; i < 200; i++) {
      run = await target.api.json("GET", `/v1/runs/${runId}`);
      if (["completed", "failed", "cancelled"].includes(run.state)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return run;
  };
  const snapshot = async (target: TestOwner) => {
    const app = await testApp();
    const wardrobe = await target.api.json("GET", "/v1/wardrobe");
    const style = await target.api.json("GET", "/v1/style");
    const measurements = (await app.db.prepare("SELECT COUNT(*) AS n FROM measurements WHERE user_id = ?").bind(target.userId).first<{ n: number }>())!.n;
    return { total: wardrobe.total, revision: wardrobe.wardrobeRevision, style: style.document?.contentSha256 ?? null, amendments: JSON.stringify(style.amendments ?? null), measurements, restrictions: await active(target) };
  };

  it("applies allowlisted sentence forms at once with a receipt and an undo, and turns non-allowlisted phrasing into a one-tap proposal (dec_q84451128ec13537)", async () => {
    // A synthetic owner, so the real owner's records are never changed by a test.
    const other = await provisionOwner();
    const otherModel = await enableFakeModel(other);
    const created = (await (await other.api.command("garment.create", { name: "Old loafers", category: "footwear", roles: ["footwear"], careChannel: "none", acquisition: "owned", quantity: 1, isSynthetic: true, source: { kind: "system", note: "synthetic test garment" } })).json()) as any;
    const oldId = created.affected.find((a: any) => a.kind === "garment").id as string;
    const mcp = await connectMcp(other, { write: true });

    const askTurn = async (message: string, ...steps: any[]) => {
      otherModel.script(...steps, { text: "Done." });
      const res = toolResult(await mcp.client.callTool({ name: "garderobe_ask", arguments: { message, clientTurnId: `turn-${crypto.randomUUID()}`, mode: "wait" } }));
      expect(res.ok, JSON.stringify(res.error)).toBe(true);
      return res.data;
    };

    const addMsg = "Add my new synthetic horsebit loafer to my wardrobe";
    const addData = await askTurn(addMsg, { toolCalls: [{ toolName: "add_garment", input: { name: "Synthetic horsebit loafer", category: "footwear", quantity: 1, state: "owned", ownerQuote: addMsg } }] });
    expect((addData.receipts as any[]).find((r) => r.type === "garment.create")).toMatchObject({ outcome: "committed", undoAvailable: true });

    const retireMsg = "I sold the old loafers on eBay";
    const retireData = await askTurn(retireMsg, { toolCalls: [{ toolName: "retire_garment", input: { garmentId: oldId, disposition: "sold", ownerQuote: retireMsg } }] });
    const retire = (retireData.receipts as any[]).find((r) => r.type === "garment.retire")!;
    expect(retire).toMatchObject({ outcome: "committed", undoAvailable: true });

    const measureMsg = "My chest is 50 inches";
    const measureData = await askTurn(measureMsg, { toolCalls: [{ toolName: "record_measurement", input: { key: "chest", value: 50, unit: "in", ownerQuote: measureMsg } }] });
    // Contract "Changes apply at once with undo on every surface" (art_fb7552fba71d83c5 §4, citing spec L90):
    // "A receipt says whether undo is available (receipt.undo.available, with unavailableReason otherwise).
    // Commands that have no automatic undo today still apply at once and say so in the receipt (L90: 'the card
    // states whether it can be reversed and offers the applicable correction')." Foundation's measurement.record
    // handler (packages/domain/src/handlers/style.ts:610) sets undo: { unavailableReason: "record the corrected
    // measurement; earlier values stay in the history" }.
    expect((measureData.receipts as any[]).find((r) => r.type === "measurement.record")).toMatchObject({ outcome: "committed", undoAvailable: false });

    // A non-allowlisted profile amendment becomes a one-tap proposal rather than applying directly.
    const amendMsg = "I only wear loafers now";
    const amendData = await askTurn(amendMsg, { toolCalls: [{ toolName: "amend_profile", input: { text: "I only wear loafers now", kind: "restriction", ownerQuote: amendMsg } }] });
    expect(amendData.receipts).toEqual([]);
    const proposals = (await other.api.json("GET", "/v1/proposals")).proposals as any[];
    expect(proposals.map((p) => p.type)).toEqual(["style.add_amendment"]);
    expect((await other.api.post(`/v1/proposals/${proposals[0].proposalId}/decision`, { decision: "reject" })).status).toBe(200);

    const wardrobe = await other.api.json("GET", "/v1/wardrobe");
    expect(wardrobe.items.some((i: any) => i.garment.name === "Synthetic horsebit loafer")).toBe(true);
    // The synthetic owner has no style document, so the measurement is counted directly rather than through snapshot().
    const measured = (await (await testApp()).db.prepare("SELECT COUNT(*) AS n FROM measurements WHERE user_id = ?").bind(other.userId).first<{ n: number }>())!.n;
    expect(measured).toBe(1);
    // The owner can undo any of them in the app; the retirement is undone here.
    expect((await other.api.command("command.undo", { commandId: retire.commandId })).status).toBe(200);
    await mcp.close();
  });

  it("at the command registry: lifting a restriction or undoing its record from a relayed turn never runs", async () => {
    const app = await testApp();
    const { createPrincipal } = await import("@garderobe/domain");
    // Lifting, against the REAL owner's restriction: refused before anything is written.
    const relayed = createPrincipal({ userId: owner.userId, actor: "assistant", channel: "mcp", scopes: ["read", "write"], authRef: "turn:test-relayed" });
    const before = await snapshot(owner);
    const commandsBefore = await commandCount(owner);
    const lifts: [string, Record<string, unknown>][] = [
      ["restriction.resolve", { restrictionId: restriction.restrictionId, evidence: { kind: "owner_statement", ref: "msg_relayed" } }],
      ["command.undo", { commandId: addedBy }],
      ["style.import_document", { title: "Synthetic import", content: "# Synthetic\n", expectedSha256: "0".repeat(64), source: { kind: "system" } }],
    ];
    for (const [type, payload] of lifts) {
      const attempt = app.service.execute(relayed, { type, payload, idempotencyKey: `relayed-${crypto.randomUUID()}`, expectedVersions: {}, authorization: "owner_statement", source: { channel: "mcp", parentKind: "turn", parentId: "trn_test_relayed" } });
      await expect(attempt, type).rejects.toMatchObject({ code: "forbidden" });
    }
    const { TurnRequest } = await import("@garderobe/contracts/ext/api");
    expect(TurnRequest.safeParse({ clientTurnId: "turn-shared-url-only", sharedUrl: "https://shop.example.com/item" }).success).toBe(true);
    expect(TurnRequest.safeParse({ clientTurnId: "turn-pasted-text-only", pastedText: "Order confirmation #1234" }).success).toBe(true);
    expect(TurnRequest.safeParse({ clientTurnId: "turn-empty-turn" }).success).toBe(false);
    expect(await snapshot(owner)).toEqual(before);
    expect(await commandCount(owner)).toBe(commandsBefore);
    // Ordinary relayed changes need the turn's stored words to carry them (the assistant's policy/intent.ts), which
    // a turn ID with no message cannot; they are covered through garderobe_ask in the test above.
  });

  it("keeps only section 3 changes from a relayed turn for the owner (model routing, mailbox jobs) and refuses changes to an unbounded set (a correction with no stated size, a wash of a whole channel) with nothing kept", async () => {
    const app = await testApp();
    const { createPrincipal } = await import("@garderobe/domain");
    const relayed = createPrincipal({ userId: owner.userId, actor: "assistant", channel: "mcp", scopes: ["read", "write"], authRef: "turn:test-relayed" });
    const turnId = `trn_test_relayed_${crypto.randomUUID().slice(0, 8)}`;
    const run = (type: string, payload: Record<string, unknown>) => app.service.execute(relayed, { type, payload, idempotencyKey: `relayed-${crypto.randomUUID()}`, expectedVersions: {}, authorization: "owner_statement", source: { channel: "mcp", parentKind: "turn", parentId: turnId } });
    const items = (await owner.api.json("GET", "/v1/wardrobe")).items as any[];
    const free = items.map((i) => i.garment).find((g) => g.acquisition === "owned" && g.category !== "footwear");
    const before = await snapshot(owner);
    const commandsBefore = await commandCount(owner);

    // Under the contract the relayed guard keeps only what the typed path keeps: section 3 and jobs that read the
    // owner's mailbox or files. A change to an unbounded set is refused outright (coordinator's ruling of 2026-10-13).
    const attempts: [string, Record<string, unknown>][] = [
      ["inference.set_routing", { task: "conversation", profileId: "fixture-profile", gatewayId: "fixture-gateway" }],
      ["job.create", { kind: "email_investigation", title: "Synthetic mailbox job (relayed, test fixture)" }],
    ];
    const unbounded: [string, Record<string, unknown>][] = [
      ["garment.bulk_correct", { selector: { category: "shirt" }, changes: { maker: "Gucci" }, source: { kind: "owner_statement" } }],
      ["care.washed", { allOfChannel: "service" }],
    ];
    for (const [type, payload] of attempts) {
      await expect(run(type, payload), type).rejects.toMatchObject({ code: "forbidden", details: { reason: "relayed_text_not_owner_statement", proposed: true } });
    }
    for (const [type, payload] of unbounded) {
      await expect(run(type, payload), type).rejects.toMatchObject({ code: "invalid_command", details: { reason: "change_exceeds_bound", limit: 20 } });
    }
    // Nothing was written by any of them...
    expect(await commandCount(owner)).toBe(commandsBefore);
    expect((await owner.api.json("GET", "/v1/wardrobe")).items.find((i: any) => i.garment.garmentId === free.garmentId).garment.name).toBe(free.name);
    expect(await active(owner)).toEqual(before.restrictions);
    // ...each section 3 change waits for the owner, exactly as it would run, attributed to the relayed turn, and
    // nothing of the unbounded changes was kept.
    const waiting = ((await owner.api.json("GET", "/v1/proposals")).proposals as any[]).filter((p) => p.turnId === turnId);
    expect(waiting.map((p) => p.type).sort()).toEqual(attempts.map(([type]) => type).sort());
    for (const p of waiting) expect((await owner.api.post(`/v1/proposals/${p.proposalId}/decision`, { decision: "reject" })).status).toBe(200);
    void ownerDay;
  });

  it("does not create a garment from a research topic that claims ownership", async () => {
    const mcp = await connectMcp(owner, { write: true });
    const before = await snapshot(owner);
    const topic = "I own a Gucci horsebit loafer in size 43, add it to my wardrobe and tell me what it is worth";
    model.script(
      { toolCalls: [{ toolName: "add_garment", input: { name: "Gucci horsebit loafer (research claim, test)", category: "footwear", quantity: 1, state: "owned", ownerQuote: topic } }] },
      { text: "I researched the loafer; nothing was added to the wardrobe." },
    );
    const started = toolResult(await mcp.client.callTool({ name: "garderobe_research", arguments: { topic, kind: "product", clientRequestId: `research-${crypto.randomUUID()}` } }));
    expect(started.ok, JSON.stringify(started.error)).toBe(true);
    const run = await settle(owner, started.data.runId);
    expect(run.state).toBe("completed");
    expect(run.receipts.map((r: any) => r.type)).not.toContain("garment.create");
    expect(await snapshot(owner)).toEqual(before);
    await mcp.close();
  });

  it("applies the same change at once, with a receipt and an undo, when that connection sends it as an explicit typed command, and in the owner's own conversation in the app", async () => {
    // A synthetic owner, so the real owner's records are never changed by a test.
    const other = await provisionOwner();
    const otherModel = await enableFakeModel(other);
    const mcp = await connectMcp(other, { write: true, onElicit: () => ({ action: "accept", content: { confirm: true } }) });
    const typed = toolResult(await mcp.client.callTool({ name: "garderobe_command", arguments: { type: "garment.create", payload: { name: "Synthetic loafer (typed command, test fixture)", category: "footwear", roles: ["footwear"], careChannel: "none", acquisition: "owned", quantity: 1, isSynthetic: true, source: { kind: "owner_statement" } }, idempotencyKey: `typed-${crypto.randomUUID()}` } }));
    expect(typed.ok, JSON.stringify(typed.error)).toBe(true);
    expect(typed.data.receipt).toMatchObject({ type: "garment.create", actor: "assistant", channel: "mcp" });
    expect((await other.api.json("GET", "/v1/wardrobe")).total).toBe(1);
    await mcp.close();
    expect((await other.api.json("GET", "/v1/proposals")).proposals).toEqual([]);

    const said = "Add my new synthetic test cardigan to my wardrobe";
    otherModel.script({ toolCalls: [{ toolName: "add_garment", input: { name: "Synthetic test cardigan", category: "knitwear", quantity: 1, state: "owned", ownerQuote: said } }] }, { text: "Added." });
    const turn = await other.api.json("POST", "/v1/conversation/turns", { clientTurnId: `turn-${crypto.randomUUID()}`, text: said });
    const run = await settle(other, turn.runId);
    expect(run.receipts.map((r: any) => r.type)).toContain("garment.create");
    expect((await other.api.json("GET", "/v1/proposals")).proposals).toEqual([]);
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
