import { beforeAll, describe, expect, it } from "vitest";
import { summaryForOwner } from "../src/proposals/store.ts";
import { connectMcp, ownerDay, provisionOwner, publishBoard, testApp, toolResult, type McpConnection, type TestOwner } from "../src/testing/index.ts";

/*
 * Routine, undoable actions a connected assistant performs directly: choosing from the published outfit
 * board, laundry pickup and return, and packing checks (owner decision of 2026-10-03, and the contract of
 * 2026-10-05 under which every change outside section 3 applies at once with undo). One test per command
 * type through the real Worker's MCP route with the SDK client: the action is recorded at once with a
 * receipt naming the connected assistant, it changes what the app's own routes read, and the connection
 * can undo it.
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

  it("only chooses what is on the published board: an invented option and a stale revision are refused", async () => {
    const invented = await call(mcp, "board.select", { boardId: board.boardId, optionId: "opt_invented_by_the_connection" });
    expect(invented.error!.code).toBe("not_found");
    const stale = await call(mcp, "board.select", { boardId: board.boardId, optionId: board.options[0].optionId }, { expectedVersions: { [`board:${board.boardId}`]: 999 } });
    expect(stale.error!.code).toBe("conflict");
    const after = await owner.api.json("GET", `/v1/today?date=${date}`);
    expect(after.board.revision).toBe(board.revision);
    expect(after.board.selection?.optionId ?? null).toBeNull();
    expect(await pending(owner)).toEqual([]);
  });

  it("board.swap_slot is applied at once with a receipt naming the connection, and the connection can undo it", async () => {
    const option = board.options[0];
    const receipt = await expectDirectReceipt(owner, await call(mcp, "board.swap_slot", { boardId: board.boardId, optionId: option.optionId, role: "top" }), "board.swap_slot");
    expect(await pending(owner)).toEqual([]);
    const swapped = await owner.api.json("GET", `/v1/today?date=${date}`);
    expect(swapped.board.revision).toBeGreaterThan(board.revision);
    const undone = await undo(mcp, receipt.commandId);
    const revisions = await (await testApp()).db.prepare("SELECT revision, reason FROM board_revisions WHERE user_id = ? AND board_id = ? ORDER BY revision").bind(owner.userId, board.boardId).all();
    expect(undone.ok, `${JSON.stringify(undone.error)} revisions ${JSON.stringify(revisions.results)}`).toBe(true);
    expect(undone.data.receipt).toMatchObject({ actor: "assistant", channel: "mcp" });
    expect(await pending(owner)).toEqual([]);
  });

  it("numbers an option the same way in a waiting change's summary and in the receipt: 1-based, as on the board", async () => {
    const db = (await testApp()).db;
    const today = (await owner.api.json("GET", `/v1/today?date=${date}`)).board;
    expect(today.options.length, "the board offers at least two options").toBeGreaterThanOrEqual(2);
    // The summary a waiting request shows (the proposal list and its confirmation) is summaryForOwner, i.e.
    // describeChange, the same trusted code for every surface. Each offered option is named by its number on the board.
    for (const option of today.options) {
      const shown = await summaryForOwner(db, owner.userId, "board.swap_slot", { boardId: today.boardId, optionId: option.optionId, role: "top" });
      expect(shown.showable).toBe(true);
      expect(shown.summary, `option ${option.number}`).toContain(`outfit option ${option.number} on the board`);
    }
    // The receipt of the same swap, actually run, names the same option by the same number. The second
    // option is used so an off-by-one in either direction fails.
    const second = today.options[1];
    const waiting = await summaryForOwner(db, owner.userId, "board.swap_slot", { boardId: today.boardId, optionId: second.optionId, role: "top" });
    const result = await call(mcp, "board.swap_slot", { boardId: today.boardId, optionId: second.optionId, role: "top" });
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    const receipt = (result.data as any).receipt as { commandId: string; summary: string };
    const receiptNumber = /\bOption (\d+)\b/.exec(receipt.summary)?.[1];
    const summaryNumber = /\boutfit option (\d+)\b/.exec(waiting.summary)?.[1];
    expect(receiptNumber, receipt.summary).toBe(String(second.number));
    expect(summaryNumber, waiting.summary).toBe(receiptNumber);
    // The same for a choice: the board.select receipt numbers the first option 1.
    const first = today.options[0];
    const selected = await expectDirectReceipt(owner, await call(mcp, "board.select", { boardId: today.boardId, optionId: first.optionId }, { expectedVersions: { [`board:${today.boardId}`]: (await owner.api.json("GET", `/v1/today?date=${date}`)).board.revision } }), "board.select");
    expect(selected.summary.toLowerCase()).toMatch(/\boption 1\b/);
    expect((await undo(mcp, selected.commandId)).ok).toBe(true);
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

  it("laundry.return is recorded at once with a receipt, closes the bag, and can be undone by the connection", async () => {
    await expectDirectReceipt(owner, await call(mcp, "laundry.collect", {}), "laundry.collect");
    const [batch] = await openBatches(owner);
    const receipt = await expectDirectReceipt(owner, await call(mcp, "laundry.return", { batchId: batch.batchId }), "laundry.return");
    expect(await openBatches(owner)).toEqual([]);
    expect(await pending(owner)).toEqual([]);

    const undone = await undo(mcp, receipt.commandId);
    expect(undone.ok, JSON.stringify(undone.error)).toBe(true);
    expect(undone.data.receipt).toMatchObject({ actor: "assistant", channel: "mcp" });
    // The bag is back at the service with its contents, as before the return.
    const reopened = await openBatches(owner);
    expect(reopened.map((b) => b.batchId)).toEqual([batch.batchId]);
    expect(reopened[0].items.map((i: any) => i.garmentId).sort()).toEqual([shirtA, shirtB].sort());
  });

  it("a return that names a piece as still away is recorded at once too, with its undo; a return dated before its bag was collected is refused, not recorded", async () => {
    const [batch] = await openBatches(owner);
    // The bag was collected just now (the test above), so a return said to have happened a month ago cannot end it.
    const longAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const early = await call(mcp, "laundry.return", { batchId: batch.batchId, stillAway: [{ garmentId: shirtB, quantity: 1 }] }, { occurredAt: longAgo });
    expect(early.ok).toBe(false);
    expect(early.error).toMatchObject({ code: "invalid_command", details: { reason: "return_before_pickup" } });
    expect((await openBatches(owner)).map((b) => b.batchId)).toEqual([batch.batchId]);
    const receipt = await expectDirectReceipt(owner, await call(mcp, "laundry.return", { batchId: batch.batchId, stillAway: [{ garmentId: shirtB, quantity: 1 }] }), "laundry.return");
    expect(await openBatches(owner)).toEqual([]);
    expect(await pending(owner)).toEqual([]);
    const undone = await undo(mcp, receipt.commandId);
    expect(undone.ok, JSON.stringify(undone.error)).toBe(true);
    expect((await openBatches(owner)).map((b) => b.batchId)).toEqual([batch.batchId]);
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

  it("packing for a trip that does not exist is refused by the command itself and nothing is kept for the owner; a trip the connection creates applies at once with an undo", async () => {
    const before = await packed();
    const invented = await call(mcp, "stock.pack", { tripId: "trp_invented_by_the_connection", items: [{ garmentId: shirt, quantity: 1 }] });
    expect(invented.ok).toBe(false);
    expect(invented.error!.code).not.toBe("confirmation_required");
    expect(await packed()).toEqual(before);
    const departs = await ownerDay(owner, 20);
    const created = await expectDirectReceipt(owner, await call(mcp, "trip.create", { name: "Synthetic second trip (test fixture)", departsOn: departs, returnsOn: departs, destinations: [{ label: "Lyon", timezone: "Europe/Paris", from: departs, to: departs }], source: { kind: "owner_statement" } }), "trip.create");
    expect((await owner.api.json("GET", "/v1/trips")).trips).toHaveLength(2);
    expect((await undo(mcp, created.commandId)).ok).toBe(true);
    expect(((await owner.api.json("GET", "/v1/trips")).trips as any[]).filter((t) => t.status === "planned")).toHaveLength(1);
    expect(await pending(owner)).toEqual([]);
  });
});
