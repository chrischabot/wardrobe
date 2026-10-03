import { beforeAll, describe, expect, it } from "vitest";
import { TYPED_DIRECT_BY_OWNER_DECISION } from "../src/mcp/policy.ts";
import { connectMcp, ownerDay, provisionOwner, publishBoard, testApp, toolResult, type McpConnection, type TestOwner } from "../src/testing/index.ts";

/*
 * The routine, undoable actions a connected assistant may perform directly (owner decision of 2026-10-03):
 * choosing from the published outfit board, laundry pickup, and packing checks. One test per command type
 * through the real Worker's MCP route with the SDK client: the action is recorded at once with a receipt
 * naming the connected assistant, it changes what the app's own routes read, and the connection can undo
 * it. A laundry return is named by the same decision but cannot be undone once recorded for a batch, so
 * it still waits for the owner; that is tested here too.
 *
 * The board test uses the REAL owner fixture (supplied profile and 127-garment inventory, in the test
 * database), because a board needs a real wardrobe; the choice is undone in the test. Laundry and packing
 * use SYNTHETIC owners with labelled fixture garments. Stand-ins: test-signed Access assertions in place
 * of Cloudflare Access; no weather or calendar (the board says so).
 */

const call = async (mcp: McpConnection, type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  toolResult(await mcp.client.callTool({ name: "garderobe_command", arguments: { type, payload, idempotencyKey: `routine-${crypto.randomUUID()}`, ...extra } }));
const undo = (mcp: McpConnection, commandId: string) => call(mcp, "command.undo", { commandId });
const pending = async (o: TestOwner) => (await o.api.json("GET", "/v1/proposals")).proposals as any[];
const stored = async (o: TestOwner, commandId: string) =>
  (await testApp()).db.prepare("SELECT actor, channel, authorization_basis FROM commands WHERE user_id = ? AND command_id = ?").bind(o.userId, commandId).first<{ actor: string; channel: string; authorization_basis: string }>();

/** The receipt of a directly recorded action: committed, by the connected assistant, undoable, and the same receipt the app reads. */
async function expectDirectReceipt(o: TestOwner, result: ReturnType<typeof toolResult>, type: string) {
  expect(result.ok, `${type}: ${JSON.stringify(result.error)}`).toBe(true);
  const receipt = (result.data as any).receipt;
  expect(receipt).toMatchObject({ type, outcome: "committed", actor: "assistant", channel: "mcp", undo: { available: true } });
  expect(await stored(o, receipt.commandId)).toEqual({ actor: "assistant", channel: "mcp", authorization_basis: "owner_statement" });
  expect((await o.api.json("GET", `/v1/commands/${receipt.commandId}`)).summary).toBe(receipt.summary);
  return receipt as { commandId: string; summary: string; result: Record<string, any> };
}

async function fixtureGarment(o: TestOwner, name: string): Promise<string> {
  const receipt = (await (await o.api.command("garment.create", { name, category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 2, isSynthetic: true, source: { kind: "system", note: "synthetic test garment" } })).json()) as any;
  if (!receipt.affected) throw new Error(`garment.create failed: ${JSON.stringify(receipt)}`);
  return receipt.affected.find((a: any) => a.kind === "garment").id;
}

it("names exactly the four routine actions that have an undo", () => {
  expect([...TYPED_DIRECT_BY_OWNER_DECISION].sort()).toEqual(["board.select", "laundry.collect", "stock.pack", "stock.unpack"]);
});

describe("board.select: choosing from the published board", () => {
  let owner: TestOwner;
  let mcp: McpConnection;
  let date: string;
  let board: any;
  beforeAll(async () => {
    owner = await provisionOwner({ real: true });
    mcp = await connectMcp(owner, { write: true, clientName: "Choosing assistant (test)" });
    date = await ownerDay(owner, 1);
    board = (await publishBoard(owner, { date })).board;
  });

  it("is recorded at once with a receipt, shows in the app as an intention and not a wear, and can be undone by the connection", async () => {
    expect(board.options.length).toBeGreaterThan(0);
    const option = board.options[0];
    const receipt = await expectDirectReceipt(owner, await call(mcp, "board.select", { boardId: board.boardId, optionId: option.optionId }, { expectedVersions: { [`board:${board.boardId}`]: board.revision } }), "board.select");
    const today = await owner.api.json("GET", `/v1/today?date=${date}`);
    expect(today.board.selection.optionId).toBe(option.optionId);
    expect((await owner.api.json("GET", `/v1/days/${date}`)).garments).toEqual([]); // choosing is not wearing
    expect(await pending(owner)).toEqual([]);

    const undone = await undo(mcp, receipt.commandId);
    expect(undone.ok, JSON.stringify(undone.error)).toBe(true);
    expect(undone.data.receipt).toMatchObject({ actor: "assistant", channel: "mcp" });
    expect((await owner.api.json("GET", `/v1/today?date=${date}`)).board.selection?.optionId ?? null).toBeNull();
  });

  it("only chooses what is on the published board: an invented option and a stale revision are refused, and swapping a piece still waits for the owner", async () => {
    const invented = await call(mcp, "board.select", { boardId: board.boardId, optionId: "opt_invented_by_the_connection" });
    expect(invented.error!.code).toBe("not_found");
    const stale = await call(mcp, "board.select", { boardId: board.boardId, optionId: board.options[0].optionId }, { expectedVersions: { [`board:${board.boardId}`]: 999 } });
    expect(stale.error!.code).toBe("conflict");
    const option = board.options[0];
    const swap = await call(mcp, "board.swap_slot", { boardId: board.boardId, optionId: option.optionId, role: "top" });
    expect(swap.error!.code).toBe("confirmation_required");
    const after = await owner.api.json("GET", `/v1/today?date=${date}`);
    expect(after.board.revision).toBe(board.revision);
    expect(after.board.selection?.optionId ?? null).toBeNull();
    for (const p of await pending(owner)) expect((await owner.api.post(`/v1/proposals/${p.proposalId}/decision`, { decision: "reject" })).status).toBe(200);
  });
});

describe("laundry pickup and return", () => {
  let owner: TestOwner;
  let mcp: McpConnection;
  let shirtA: string;
  let shirtB: string;
  const laundry = (o: TestOwner) => o.api.json("GET", "/v1/laundry");
  const awaiting = async (o: TestOwner) => ((await laundry(o)).awaitingService as { garmentId: string; quantity: number }[]).map((l) => `${l.garmentId}:${l.quantity}`).sort();
  const openBatches = async (o: TestOwner) => ((await laundry(o)).batches as any[]).filter((b) => !b.returnedAt);

  beforeAll(async () => {
    owner = await provisionOwner();
    shirtA = await fixtureGarment(owner, "Synthetic shirt A (laundry test fixture, not real stock)");
    shirtB = await fixtureGarment(owner, "Synthetic shirt B (laundry test fixture, not real stock)");
    // The owner's own reports in the app: one unit of each needs a wash.
    expect((await owner.api.command("care.mark_dirty", { items: [{ garmentId: shirtA, quantity: 1 }, { garmentId: shirtB, quantity: 1 }] })).status).toBe(200);
    mcp = await connectMcp(owner, { write: true, clientName: "Laundry assistant (test)" });
  });

  it("laundry.collect is recorded at once with a receipt, moves the hamper into a batch, and can be undone by the connection", async () => {
    const before = await awaiting(owner);
    expect(before).toEqual([`${shirtA}:1`, `${shirtB}:1`].sort());
    const receipt = await expectDirectReceipt(owner, await call(mcp, "laundry.collect", {}), "laundry.collect");
    expect(await awaiting(owner)).toEqual([]);
    expect((await openBatches(owner)).flatMap((b) => b.items.map((i: any) => i.garmentId)).sort()).toEqual([shirtA, shirtB].sort());

    const undone = await undo(mcp, receipt.commandId);
    expect(undone.ok, JSON.stringify(undone.error)).toBe(true);
    expect(await awaiting(owner)).toEqual(before);
    expect(await openBatches(owner)).toEqual([]);
    expect(await pending(owner)).toEqual([]);
  });

  it("laundry.return still waits for the owner (the policy has not been changed yet): confirmed in the app it runs as the owner's tap, and its receipt offers the undo a recorded return now has", async () => {
    await expectDirectReceipt(owner, await call(mcp, "laundry.collect", {}), "laundry.collect");
    const [batch] = await openBatches(owner);
    const commands = async () => ((await (await testApp()).db.prepare("SELECT COUNT(*) AS n FROM commands WHERE user_id = ?").bind(owner.userId).first<{ n: number }>())!.n);
    const before = await commands();
    const asked = await call(mcp, "laundry.return", { batchId: batch.batchId });
    expect(asked.error).toMatchObject({ code: "confirmation_required", details: { reason: "owner_confirmation_required" } });
    // So do a reported exception and a pickup said to have happened weeks ago.
    expect((await call(mcp, "laundry.report_exception", { kind: "delayed" })).error!.code).toBe("confirmation_required");
    const longAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    expect((await call(mcp, "laundry.collect", {}, { occurredAt: longAgo })).error!.code).toBe("confirmation_required");
    expect(await commands()).toBe(before);
    expect((await openBatches(owner)).map((b) => b.batchId)).toEqual([batch.batchId]);

    const proposal = (await pending(owner)).find((p) => p.type === "laundry.return");
    const decided = (await (await owner.api.post(`/v1/proposals/${proposal.proposalId}/decision`, { decision: "confirm" })).json()) as any;
    expect(decided.receipt).toMatchObject({ type: "laundry.return", outcome: "committed", undo: { available: true } });
    expect(await stored(owner, decided.receipt.commandId)).toMatchObject({ actor: "owner", authorization_basis: "owner_tap" });
    expect(await openBatches(owner)).toEqual([]);
  });
});

describe("packing checks for a trip", () => {
  let owner: TestOwner;
  let mcp: McpConnection;
  let shirt: string;
  let tripId: string;
  const packed = async () => ((await owner.api.json("GET", `/v1/trips/${tripId}`)).packed as { garmentId: string; clean: number; worn: number }[]).map((p) => `${p.garmentId}:${p.clean + p.worn}`);

  beforeAll(async () => {
    owner = await provisionOwner();
    shirt = await fixtureGarment(owner, "Synthetic shirt (packing test fixture, not real stock)");
    const departs = await ownerDay(owner, 10);
    const returns = await ownerDay(owner, 12);
    // The trip is the owner's own, made in the app; a connection cannot create one without the owner.
    const created = (await (await owner.api.command("trip.create", { name: "Synthetic trip (test fixture)", departsOn: departs, returnsOn: returns, destinations: [{ label: "Paris", timezone: "Europe/Paris", from: departs, to: returns }], source: { kind: "owner_statement" } })).json()) as any;
    if (created.outcome !== "committed") throw new Error(`trip.create failed: ${JSON.stringify(created)}`);
    tripId = String(created.result.tripId ?? created.affected.find((a: any) => a.kind === "trip")?.id);
    mcp = await connectMcp(owner, { write: true, clientName: "Packing assistant (test)" });
  });

  it("stock.pack is recorded at once with a receipt, shows as packed in the app, and can be undone by the connection", async () => {
    const receipt = await expectDirectReceipt(owner, await call(mcp, "stock.pack", { tripId, items: [{ garmentId: shirt, quantity: 1 }] }), "stock.pack");
    expect(await packed()).toEqual([`${shirt}:1`]);
    const undone = await undo(mcp, receipt.commandId);
    expect(undone.ok, JSON.stringify(undone.error)).toBe(true);
    expect(await packed()).toEqual([]);
    expect(await pending(owner)).toEqual([]);
  });

  it("stock.unpack is recorded at once with a receipt, empties the bag without calling anything clean, and can be undone by the connection", async () => {
    await expectDirectReceipt(owner, await call(mcp, "stock.pack", { tripId, items: [{ garmentId: shirt, quantity: 1 }] }), "stock.pack");
    const receipt = await expectDirectReceipt(owner, await call(mcp, "stock.unpack", { tripId }), "stock.unpack");
    expect(receipt.summary).toContain("not marked clean");
    expect(await packed()).toEqual([]);
    const undone = await undo(mcp, receipt.commandId);
    expect(undone.ok, JSON.stringify(undone.error)).toBe(true);
    expect(await packed()).toEqual([`${shirt}:1`]);
  });

  it("packing for something that is not one of the owner's planned trips waits for the owner, as do creating, changing and cancelling a trip", async () => {
    const before = await packed();
    expect((await call(mcp, "stock.pack", { tripId: "trp_invented_by_the_connection", items: [{ garmentId: shirt, quantity: 1 }] })).error!.code).toBe("confirmation_required");
    expect((await call(mcp, "stock.unpack", { tripId: "trp_invented_by_the_connection" })).error!.code).toBe("confirmation_required");
    expect((await call(mcp, "trip.cancel", { tripId })).error!.code).toBe("confirmation_required");
    const departs = await ownerDay(owner, 20);
    expect((await call(mcp, "trip.create", { name: "Synthetic second trip (test fixture)", departsOn: departs, returnsOn: departs, destinations: [{ label: "Lyon", timezone: "Europe/Paris", from: departs, to: departs }], source: { kind: "owner_statement" } })).error!.code).toBe("confirmation_required");
    expect(await packed()).toEqual(before);
    expect((await owner.api.json("GET", "/v1/trips")).trips.map((t: any) => t.tripId)).toEqual([tripId]);
    // Once the owner has cancelled the trip, packing for it is no longer a routine check.
    expect((await owner.api.command("trip.cancel", { tripId })).status).toBe(200);
    expect((await call(mcp, "stock.pack", { tripId, items: [{ garmentId: shirt, quantity: 1 }] })).error!.code).toBe("confirmation_required");
  });
});
