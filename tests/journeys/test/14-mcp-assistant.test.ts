/**
 * Journey 14: a connected consumer assistant, from consent to disconnect, over the real MCP server.
 *
 * Specification: section 13 "The MCP interface to the same assistant" (the seven tools, same revision as
 * the app, explicit completeness, verified receipts, read-only clients receive proposals),
 * "Authorization for Claude and ChatGPT" (per-client grants, Disconnect takes effect at once), "MCP 0728
 * protocol contract" (the 2025-11-25 compatibility path; resources are optional); section 8 "A command is
 * a verified change" (idempotency); section 5 (a restriction stays until the owner ends it). Acceptance
 * rows (section 17): Identity recovery (MCP disconnection), Hallucinated items, Personal context. What a
 * connected assistant may do: apps/worker/README.md and packages/assistant/README.md (reports run, every
 * other change waits for the signed-in owner).
 *
 * Everything inside the Worker is real: the MCP server and its OAuth provider (the SDK client registers,
 * runs the authorization-code flow with PKCE and calls tools with its own token), the HTTP API, the
 * command service, local D1/R2/KV, the owner's real profile and the real 127-garment inventory.
 * Stand-ins, at external boundaries only:
 *  - test-signed sign-in assertions in place of Cloudflare Access on the consent page;
 *  - the MCP client is the TypeScript SDK client in-process, not Claude or ChatGPT: no real consumer
 *    client's behaviour is proved here;
 *  - FAKE MODEL (scripted, no inference) behind `garderobe_ask` and `garderobe_research`;
 *  - the scripted weather double for the fictional test place.
 * Which typed commands wait for the owner is the server's answer at run time (`mcpCommand` in
 * src/world.ts); the journey asserts the resulting state and receipt on either route.
 */
import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_ORIGIN, MCP_ORIGIN, connectMcp, enableFakeModel, publishBoard, toolResult, type FakeModel, type McpConnection, type TestOwner } from "@garderobe/worker/testing";
import { defect } from "../src/defect.ts";
import { internalCodesIn, mcpCommand, realOwnerAt, settleRun, wholeWardrobe, type JourneyOwner, type McpCommandOutcome, type WardrobeItem } from "../src/world.ts";

let j: JourneyOwner;
let owner: TestOwner;
let model: FakeModel;
let reader: McpConnection;
let writer: McpConnection;
let board: any;
let shoe: WardrobeItem["garment"];
let top: WardrobeItem["garment"];
let secondTop: WardrobeItem["garment"];
let restricted: WardrobeItem[];
let pendingProposalId: string;
/** Every confirmation the owner was shown for a typed command of the connected assistant. */
const shownToOwner: { type: string; summary: string }[] = [];

const WRITER_NAME = "Writing assistant (journey test)";
const READER_NAME = "Read-only assistant (journey test)";
const call = async (connection: McpConnection, name: string, args: Record<string, unknown>) => toolResult(await connection.client.callTool({ name, arguments: args }));
const inventory = (args: Record<string, unknown>) => call(reader, "garderobe_inventory", args);
const pending = async () => (await owner.api.json("GET", "/v1/proposals")).proposals as Record<string, any>[];
const dayRecord = async (date: string) => (await owner.api.json("GET", `/v1/days/${date}`)).garments as { garmentId: string; observationCount: number }[];
const wearCount = async (garmentId: string) => (await owner.api.json("GET", `/v1/items/${garmentId}`)).detail.recordedWearCount as number;
/** The text a connected assistant reads beside the last page of the paged item list. */
let lastItemsPageText = "";
const rawList = (token: string) => SELF.fetch(`${MCP_ORIGIN}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });

/** What every typed command must show, whichever route the server took. */
function expectVerified(outcome: McpCommandOutcome, type: string): void {
  expect(outcome.receipt.type).toBe(type);
  expect(["committed", "merged"]).toContain(outcome.receipt.outcome);
  expect(internalCodesIn(outcome.receipt.summary)).toEqual([]);
  if (outcome.route === "direct") {
    expect(outcome.receipt).toMatchObject({ channel: "mcp", actor: "assistant" });
  } else {
    // The owner saw the request in the app, attributed to this assistant, with exactly the command that then ran.
    expect(outcome.proposal).toMatchObject({ type, state: "pending", source: { channel: "mcp", assistantName: WRITER_NAME } });
    expect(outcome.proposal!.summary.length).toBeGreaterThan(10);
    expect(outcome.receipt.actor).toBe("owner");
    shownToOwner.push({ type, summary: outcome.proposal!.summary });
  }
}

beforeAll(async () => {
  j = await realOwnerAt("Connected assistant");
  owner = j.owner;
  model = await enableFakeModel(owner);
  const wardrobe = await wholeWardrobe(owner.api);
  const wearable = (i: WardrobeItem) => i.garment.acquisition === "owned" && i.availability && !i.availability.hardExcluded && i.balances.some((b) => b.bucket === "clean" && b.quantity > 0);
  shoe = wardrobe.items.find((i) => i.garment.roles.includes("footwear") && wearable(i))!.garment;
  const tops = wardrobe.items.filter((i) => i.garment.roles.includes("top") && i.garment.careChannel === "service" && wearable(i));
  top = tops[0]!.garment;
  secondTop = tops[1]!.garment;
  restricted = wardrobe.items.filter((i) => i.garment.roles.includes("footwear") && (i.availability?.restrictionIds ?? []).length > 0);
  board = (await publishBoard(owner, { date: j.today })).board;
  reader = await connectMcp(owner, { write: false, clientName: READER_NAME });
  writer = await connectMcp(owner, { write: true, clientName: WRITER_NAME, redirectUri: "https://writer.client.test/oauth/callback" });
});

describe("journey 14: a connected assistant reads, reports, asks and is disconnected", () => {
  it("a read-only connection is offered no write tool; a write connection is; no tool takes an owner", async () => {
    const read = (await reader.client.listTools()).tools;
    const write = (await writer.client.listTools()).tools;
    expect(read.map((t) => t.name).sort()).toEqual(["garderobe_ask", "garderobe_inventory", "garderobe_recommend", "garderobe_research", "garderobe_run", "garderobe_today"]);
    expect(write.map((t) => t.name).sort()).toEqual(["garderobe_ask", "garderobe_command", "garderobe_inventory", "garderobe_recommend", "garderobe_research", "garderobe_run", "garderobe_today"]);
    for (const tool of write) {
      expect(tool.outputSchema, tool.name).toBeTruthy();
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/userId|ownerId|user_id/);
      expect(tool.name).not.toMatch(/proposal|confirm|approve/i);
    }
    // Annotations describe the possible effects truthfully.
    expect(write.find((t) => t.name === "garderobe_command")!.annotations).toMatchObject({ readOnlyHint: false });
    for (const name of ["garderobe_today", "garderobe_inventory", "garderobe_recommend"]) expect(write.find((t) => t.name === name)!.annotations).toMatchObject({ readOnlyHint: true });

    // The app lists the two assistants separately, each with what it may do.
    const grants = (await owner.api.json("GET", "/v1/assistants")).grants as any[];
    expect(grants.find((g) => g.clientName === READER_NAME)).toMatchObject({ access: "read_only", scopes: ["wardrobe.read"], status: "active" });
    expect(grants.find((g) => g.clientName === WRITER_NAME)).toMatchObject({ access: "read_write", status: "active" });
    expect(JSON.stringify(grants)).not.toMatch(/access_token|refresh_token|token_hash/);
    // A read-only connection that calls the write tool anyway is refused and changes nothing.
    const before = (await owner.api.json("GET", "/v1/wardrobe")).wardrobeRevision;
    const forced = await reader.client.callTool({ name: "garderobe_command", arguments: { type: "care.mark_dirty", payload: { items: [{ garmentId: top.garmentId, quantity: 1 }] }, idempotencyKey: `forced-${crypto.randomUUID()}` } }).then((r) => toolResult(r).ok, () => false);
    expect(forced).toBe(false);
    expect((await owner.api.json("GET", "/v1/wardrobe")).wardrobeRevision).toBe(before);
  });

  it("garderobe_today is the board the app shows: same revision, same options, same garments", async () => {
    const viaMcp = await call(reader, "garderobe_today", { date: j.today });
    expect(viaMcp.ok, JSON.stringify(viaMcp.error)).toBe(true);
    const viaApp = await owner.api.json("GET", `/v1/today?date=${j.today}`);
    expect(viaMcp.data.status).toBe("ready");
    expect(viaMcp.data.board.boardId).toBe(viaApp.board.boardId);
    expect(viaMcp.data.board.revision).toBe(viaApp.board.revision);
    expect(viaMcp.data.board.options.map((o: any) => o.optionId)).toEqual(viaApp.board.options.map((o: any) => o.optionId));
    expect(viaMcp.data.board.options).toEqual(viaApp.board.options);
    expect(viaMcp.data.board.dayLine).toBe(viaApp.board.dayLine);
    expect(viaMcp.data.wardrobeRevision).toBe(viaApp.wardrobeRevision);
    expect(viaMcp.data.freshness.map((f: any) => `${f.source}:${f.state}`).sort()).toEqual(viaApp.freshness.map((f: any) => `${f.source}:${f.state}`).sort());
    // A day with no board is reported as such, not filled in.
    const empty = await call(reader, "garderobe_today", { date: j.day(5) });
    expect(empty.data.board).toBeNull();
    expect(empty.data.emptyReason).toBeTruthy();
  });

  it("garderobe_recommend returns validated options of real garments and publishes nothing", async () => {
    const before = await owner.api.json("GET", `/v1/today?date=${j.today}`);
    const wardrobe = new Map((await wholeWardrobe(owner.api)).items.map((i) => [i.garment.garmentId, i]));
    const recommended = await call(reader, "garderobe_recommend", { date: j.today, count: 3, brief: "something for the office", clientRequestId: `rec-${crypto.randomUUID()}` });
    expect(recommended.ok, JSON.stringify(recommended.error)).toBe(true);
    expect(recommended.data.state).toBe("completed");
    expect(recommended.data.board).toBeNull();
    expect(recommended.data.options.length).toBeGreaterThan(0);
    expect(recommended.data.options.length).toBeLessThanOrEqual(3);
    for (const option of recommended.data.options) {
      for (const line of [...option.garments, ...option.footwearAlternatives]) {
        const real = wardrobe.get(line.garmentId);
        expect(real?.garment.name, line.name).toBe(line.name);
        expect(real!.availability!.hardExcluded, line.name).toBe(false);
      }
      expect(option.garments.map((g: any) => g.role)).toEqual(expect.arrayContaining(["top", "bottom", "socks", "footwear"]));
      const verdict = await owner.api.json("POST", "/v1/studio/validate", { mode: "for_today", slots: option.garments.map((g: any) => ({ role: g.role, garmentId: g.garmentId })) });
      expect(verdict.valid, option.name).toBe(true);
      expect(internalCodesIn(option.reason)).toEqual([]);
    }
    const after = await owner.api.json("GET", `/v1/today?date=${j.today}`);
    expect(after.board.boardId).toBe(before.board.boardId);
    expect(after.board.revision).toBe(before.board.revision);
    expect(after.board.selection ?? null).toEqual(before.board.selection ?? null);
    expect(after.wardrobeRevision).toBe(before.wardrobeRevision);
  });

  it("garderobe_inventory agrees with the app: paged items, the complete snapshot (127), an item, availability", async () => {
    const app = await wholeWardrobe(owner.api);
    const appIds = app.items.map((i) => i.garment.garmentId).sort();

    // The snapshot is the whole wardrobe and says so.
    const snapshot = await inventory({ view: "snapshot" });
    expect(snapshot.ok, JSON.stringify(snapshot.error)).toBe(true);
    expect(snapshot.data).toMatchObject({ view: "snapshot", complete: true, total: 127, nextCursor: null, wardrobeRevision: app.wardrobeRevision });
    expect(Number.isNaN(Date.parse(snapshot.data.readAt))).toBe(false);
    expect(snapshot.data.data.items.map((i: any) => i.garment.garmentId).sort()).toEqual(appIds);

    // A page says it is not everything, and following the cursor reaches all 127 exactly once.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const raw: any = await reader.client.callTool({ name: "garderobe_inventory", arguments: { view: "items", limit: 40, ...(cursor ? { cursor } : {}) } });
      const part: any = toolResult(raw);
      lastItemsPageText = (raw.content as { type: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
      expect(part.data.total).toBe(127);
      seen.push(...part.data.data.items.map((i: any) => i.garment.garmentId));
      cursor = part.data.nextCursor;
      if (!cursor) break;
      expect(part.data.complete).toBe(false); // a page with more to come never claims to be everything
    }
    expect(seen).toHaveLength(127);
    expect([...seen].sort()).toEqual(appIds);

    // One item: the same facts the item page shows.
    const item = await inventory({ view: "item", garmentId: shoe.garmentId });
    const appItem = await owner.api.json("GET", `/v1/items/${shoe.garmentId}`);
    expect(item.data.data.detail).toEqual(appItem.detail);
    expect(item.data.data.availability).toEqual(appItem.availability);
    expect(item.data.data.media.image).toEqual(appItem.media.image);
    const missing = await inventory({ view: "item", garmentId: "gmt_ffffffffffffffffffffffff" });
    expect(missing.ok).toBe(false);
    expect(missing.error!.code).toBe("not_found");

    // Availability: every garment, the same exclusions (the restricted shoes included).
    const availability = await inventory({ view: "availability" });
    const appAvailability = await owner.api.json("GET", "/v1/availability");
    expect(availability.data.total).toBe(127);
    expect(availability.data.data.forDate).toBe(appAvailability.forDate);
    const flags = (garments: any[]) => garments.map((g) => `${g.garmentId}:${g.status}:${g.hardExcluded}`).sort();
    expect(flags(availability.data.data.garments)).toEqual(flags(appAvailability.garments));
    for (const piece of restricted) expect(availability.data.data.garments.find((g: any) => g.garmentId === piece.garment.garmentId).hardExcluded).toBe(true);
  });

  it("the other inventory views agree with the app too: laundry, style, resolve, receipts, command types, trips, returns, orders", async () => {
    const withoutReadAt = ({ readAt: _readAt, ...rest }: Record<string, unknown>) => rest;
    const laundry = await inventory({ view: "laundry" });
    expect(laundry.data.data).toEqual(withoutReadAt(await owner.api.json("GET", "/v1/laundry")));

    // The profile and rules are the same documents (compared by hash and counts; the text is not printed).
    const style = await inventory({ view: "style" });
    const appStyle = await owner.api.json("GET", "/v1/style");
    expect(style.data.data.document.contentSha256).toBe(appStyle.document.contentSha256);
    expect(style.data.data.document.content === appStyle.document.content).toBe(true);
    expect(style.data.data.rules.length).toBe(appStyle.rules.length);
    expect(style.data.data.styleRevision).toBe(appStyle.styleRevision);

    // A phrase that names three pairs is reported as ambiguous with the distinguishing facts, never guessed.
    const resolved = await inventory({ view: "resolve", phrase: "NB 990v4" });
    expect(resolved.data.data).toEqual(await owner.api.json("GET", `/v1/wardrobe/resolve?phrase=${encodeURIComponent("NB 990v4")}`));
    expect(resolved.data.data.ambiguous).toBe(true);
    expect(resolved.data.data.matches.length).toBeGreaterThan(1);

    const receipts = await inventory({ view: "receipts", garmentId: shoe.garmentId });
    const appReceipts = await owner.api.json("GET", `/v1/commands?entity=garment:${shoe.garmentId}`);
    expect(receipts.data.data.receipts.map((r: any) => r.commandId)).toEqual(appReceipts.receipts.map((r: any) => r.commandId));

    const types = await inventory({ view: "command_types" });
    const appTypes = await owner.api.json("GET", "/v1/command-types");
    expect(types.data.data.types.map((t: any) => t.type)).toEqual(appTypes.types.map((t: any) => t.type));
    expect(types.data.total).toBe(appTypes.types.length);

    for (const [view, path] of [["trips", "/v1/trips"], ["returns", "/v1/returns"], ["orders", "/v1/orders"]] as const) {
      const viaMcp = await inventory({ view });
      expect(viaMcp.ok, view).toBe(true);
      expect(viaMcp.data.complete, view).toBe(true);
      expect(viaMcp.data.data[view], view).toEqual((await owner.api.json("GET", path))[view]);
    }

    // History before anything was reported: empty, with the caveat that unlogged is not unworn.
    const history = await inventory({ view: "history" });
    expect(history.data.data.wears).toEqual([]);
    expect(history.data.data.caveat).toMatch(/unknown, not unworn/i);
    // No owner parameter is accepted anywhere.
    const foreign = await reader.client.callTool({ name: "garderobe_inventory", arguments: { view: "snapshot", userId: owner.userId } }).then((r) => toolResult(r).ok, () => false);
    expect(foreign).toBe(false);
  });

  it("an outfit choice sent by the assistant ends as the owner's intention on the board, not as a wear", async () => {
    const current = (await owner.api.json("GET", `/v1/today?date=${j.today}`)).board;
    const option = current.options[1];
    const outcome = await mcpCommand(owner, writer, "board.select", { boardId: current.boardId, optionId: option.optionId }, { expectedVersions: { [`board:${current.boardId}`]: current.revision }, expectRoute: "direct" });
    expectVerified(outcome, "board.select");
    expect(outcome.receipt.summary).toMatch(/not a recorded wear|intention/i);
    if (outcome.proposal) expect(outcome.proposal.payload).toEqual({ boardId: current.boardId, optionId: option.optionId });

    const today = await owner.api.json("GET", `/v1/today?date=${j.today}`);
    expect(today.board.selection.optionId).toBe(option.optionId);
    // The assistant sees the same choice the app shows.
    expect((await call(reader, "garderobe_today", { date: j.today })).data.board.selection.optionId).toBe(option.optionId);
    // Choosing is not wearing: nothing is on the day's record, and no wear was counted for the chosen pieces.
    expect(await dayRecord(j.today)).toEqual([]);
    expect(today.dayRecord).toEqual([]);
    expect((await owner.api.json("GET", `/v1/commands/${outcome.receipt.commandId}`)).type).toBe("board.select");
  });

  it("a write connection records a wear report at once, with a verified receipt on the mcp channel; a repeat counts nothing twice", async () => {
    const before = await wearCount(shoe.garmentId);
    const args = { type: "wear.record", payload: { wearingDate: j.today, garmentIds: [shoe.garmentId] }, idempotencyKey: `mcp-wear-${crypto.randomUUID()}` };
    const first = await call(writer, "garderobe_command", args);
    expect(first.ok, JSON.stringify(first.error)).toBe(true);
    const receipt = first.data.receipt;
    expect(receipt).toMatchObject({ type: "wear.record", outcome: "committed", channel: "mcp", actor: "assistant", replayed: false, undo: { available: true }, result: { wearingDate: j.today, counted: [shoe.garmentId] } });
    expect(receipt.summary).toContain(shoe.name);
    expect(internalCodesIn(receipt.summary)).toEqual([]);
    expect(receipt.affected).toEqual([expect.objectContaining({ kind: "garment", id: shoe.garmentId })]);
    // Verified: the app reads the very same stored receipt, and the state shows the wear.
    expect(await owner.api.json("GET", `/v1/commands/${receipt.commandId}`)).toEqual({ ...receipt, replayed: false });
    expect(await dayRecord(j.today)).toEqual([expect.objectContaining({ garmentId: shoe.garmentId, observationCount: 1 })]);
    expect(await wearCount(shoe.garmentId)).toBe(before + 1);

    // The same call again (a retry after a lost answer) returns the stored receipt.
    const retry = await call(writer, "garderobe_command", args);
    expect(retry.data.receipt).toMatchObject({ commandId: receipt.commandId, replayed: true });
    expect(await dayRecord(j.today)).toEqual([expect.objectContaining({ garmentId: shoe.garmentId, observationCount: 1 })]);
    expect(await wearCount(shoe.garmentId)).toBe(before + 1);
    // The same key with a different request is refused, not run.
    const reused = await call(writer, "garderobe_command", { ...args, payload: { wearingDate: j.today, garmentIds: [secondTop.garmentId] } });
    expect(reused.ok).toBe(false);
    expect(reused.error!.code).toBe("idempotency_key_reuse");
    // An invented garment is refused with the API's typed error and nothing is written.
    const invented = await call(writer, "garderobe_command", { type: "wear.record", payload: { wearingDate: j.today, garmentIds: ["gmt_ffffffffffffffffffffffff"] }, idempotencyKey: `mcp-${crypto.randomUUID()}` });
    expect(invented.error!.code).toBe("not_found");
    expect((await dayRecord(j.today)).map((g) => g.garmentId)).toEqual([shoe.garmentId]);

    // The history view and the receipts view now show it, as the app does.
    const history = await inventory({ view: "history", garmentId: shoe.garmentId });
    expect(JSON.stringify(history.data.data.wears)).toContain(shoe.garmentId);
    expect((await inventory({ view: "receipts", garmentId: shoe.garmentId })).data.data.receipts.map((r: any) => r.commandId)).toContain(receipt.commandId);
  });

  it("a laundry pickup sent by the assistant moves the dirty shirt into a service batch", async () => {
    // First the report that the shirt is dirty (a wash report).
    const dirty = await mcpCommand(owner, writer, "care.mark_dirty", { items: [{ garmentId: top.garmentId, quantity: 1 }] }, { expectRoute: "direct" });
    expectVerified(dirty, "care.mark_dirty");
    expect(dirty.receipt.summary).toContain(top.name);
    expect(JSON.stringify((await owner.api.json("GET", "/v1/laundry")).awaitingService)).toContain(top.garmentId);

    const collected = await mcpCommand(owner, writer, "laundry.collect", {}, { expectRoute: "direct" });
    expectVerified(collected, "laundry.collect");
    const laundry = await owner.api.json("GET", "/v1/laundry");
    expect(laundry.batches).toHaveLength(1);
    expect(JSON.stringify(laundry.batches[0])).toContain(top.garmentId);
    expect(JSON.stringify(laundry.awaitingService)).not.toContain(top.garmentId);
    // The piece is away, so it is not offered until it comes back; nothing else left the wardrobe.
    const item = await owner.api.json("GET", `/v1/items/${top.garmentId}`);
    expect(item.detail.balances.some((b: any) => b.bucket === "clean" && b.quantity > 0)).toBe(false);
    expect(item.availability.status).not.toBe("available");
    expect((await wholeWardrobe(owner.api)).total).toBe(127);
    // The assistant's laundry view is the app's.
    const { readAt: _readAt, ...appLaundry } = laundry;
    expect((await inventory({ view: "laundry" })).data.data).toEqual(appLaundry);
  });

  it("a setting change sent by the assistant takes effect in the owner's settings with a receipt", async () => {
    const before = await owner.api.json("GET", "/v1/settings");
    expect(before.settings.delivery.morningLocalTime).not.toBe("06:45");
    const outcome = await mcpCommand(owner, writer, "settings.update", { patch: { delivery: { ...before.settings.delivery, morningLocalTime: "06:45" } } }, { expectRoute: "owner_confirmed" });
    expectVerified(outcome, "settings.update");
    expect(outcome.receipt.outcome).toBe("committed");
    const after = await owner.api.json("GET", "/v1/settings");
    expect(after.settings.delivery.morningLocalTime).toBe("06:45");
    expect(after.version).toBeGreaterThan(before.version);
    // Nothing else moved: same place, same timezone, same laundry routine.
    expect(after.settings.timezone).toBe(before.settings.timezone);
    expect(after.settings.homeLocation).toEqual(before.settings.homeLocation);
    expect(after.settings.laundry).toEqual(before.settings.laundry);
    expect((await owner.api.json("GET", `/v1/commands/${outcome.receipt.commandId}`)).type).toBe("settings.update");
  });

  it("the confirmation the owner is shown for an assistant's typed command is in plain words, without internal identifiers or raw payload", () => {
    // Was defect D14-1; fixed by the API thread in 5db4fd87.
    // Specification section 13 and the profile (section 11): what the owner reads is plain wording; a
    // confirmation shows the exact change. Every summary collected above was shown in GET /v1/proposals.
    const notPlain = shownToOwner.filter((p) => internalCodesIn(p.summary).length > 0 || /[{}]|":/.test(p.summary)).map((p) => `${p.type}: ${p.summary}`);
    expect(notPlain).toEqual([]);
  });

  defect("D14-2", "the last page of the item list does not tell the assistant that more pages follow", () => {
    // Specification section 13 and research rows R14 to R16: "Pagination is explicit; complete snapshots
    // and counts cannot be silently truncated." The last page has no next cursor, yet its text still
    // says more pages follow and to pass a cursor that does not exist, so an assistant that trusts the
    // text keeps asking or reports the wardrobe as partly read.
    expect(lastItemsPageText.length).toBeGreaterThan(0);
    expect(lastItemsPageText).not.toMatch(/more pages|pass nextCursor/i);
  });

  it("garderobe_ask relays words: a named wear is recorded; anything else becomes a request for the owner", async () => {
    // A wear report naming a real garment, relayed by the write connection: recorded, on the mcp channel.
    const worn = `I wore the ${secondTop.name} today`;
    model.script({ toolCalls: [{ toolName: "record_wear", input: { garmentIds: [secondTop.garmentId] } }] }, { text: "SCRIPTED FAKE MODEL REPLY: logged." });
    const reported = await call(writer, "garderobe_ask", { message: worn, clientTurnId: `ask-${crypto.randomUUID()}`, mode: "wait" });
    expect(reported.ok, JSON.stringify(reported.error)).toBe(true);
    expect(reported.data.state).toBe("completed");
    expect(reported.data.proposals).toEqual([]);
    expect(reported.data.receipts.map((r: any) => r.type)).toEqual(["wear.record"]);
    expect(reported.data.receipts[0].summary).toContain(secondTop.name);
    const stored = await owner.api.json("GET", `/v1/commands/${reported.data.receipts[0].commandId}`);
    expect(stored).toMatchObject({ type: "wear.record", outcome: "committed", channel: "mcp", actor: "assistant" });
    expect((await dayRecord(j.today)).map((g) => g.garmentId).sort()).toEqual([shoe.garmentId, secondTop.garmentId].sort());

    // A correction relayed the same way writes nothing and waits for the owner in the app.
    const revisionBefore = (await owner.api.json("GET", "/v1/wardrobe")).wardrobeRevision;
    const correction = `The ${secondTop.name} has a loose button now`;
    model.script({ toolCalls: [{ toolName: "correct_garment", input: { garmentId: secondTop.garmentId, changes: { condition: "loose button (journey test)" } } }] }, { text: "SCRIPTED FAKE MODEL REPLY: that needs your confirmation in the app." });
    const asked = await call(writer, "garderobe_ask", { message: correction, clientTurnId: `ask-${crypto.randomUUID()}`, mode: "wait" });
    expect(asked.ok, JSON.stringify(asked.error)).toBe(true);
    expect(asked.data.receipts).toEqual([]);
    expect(asked.data.proposals.map((p: any) => p.type)).toEqual(["garment.correct"]);
    expect((await owner.api.json("GET", "/v1/wardrobe")).wardrobeRevision).toBe(revisionBefore);
    expect((await owner.api.json("GET", `/v1/items/${secondTop.garmentId}`)).detail.garment.condition).toBe(secondTop.condition);
    const proposal = (await pending()).find((p) => p.turnId === asked.data.runId)!;
    expect(proposal).toMatchObject({ type: "garment.correct", state: "pending", source: { channel: "mcp", assistantName: WRITER_NAME }, payload: { garmentId: secondTop.garmentId } });
    expect(proposal.summary).toContain(secondTop.name);
    expect(proposal.summary).toContain("\u201Cloose button (journey test)\u201D");
    expect(internalCodesIn(proposal.summary)).toEqual([]);
    pendingProposalId = proposal.proposalId;

    // A read-only connection relaying a wash report gets a proposal, never a change.
    const laundryBefore = await owner.api.json("GET", "/v1/laundry");
    model.script({ toolCalls: [{ toolName: "mark_dirty", input: { garmentIds: [secondTop.garmentId] } }] }, { text: "SCRIPTED FAKE MODEL REPLY: proposed." });
    const readOnly = await call(reader, "garderobe_ask", { message: `The ${secondTop.name} is in the wash`, clientTurnId: `ask-${crypto.randomUUID()}`, mode: "wait" });
    expect(readOnly.data.receipts).toEqual([]);
    expect(readOnly.data.proposals.length).toBeGreaterThan(0);
    expect((await owner.api.json("GET", "/v1/laundry")).awaitingService).toEqual(laundryBefore.awaitingService);

    // Both relayed messages are in the owner's one conversation, marked with the channel they came through.
    const transcript = (await owner.api.json("GET", "/v1/conversation/messages?limit=50")).messages as any[];
    const relayed = transcript.filter((m) => m.role === "user" && [worn, correction].includes(m.text));
    expect(relayed.map((m) => m.channel)).toEqual(["mcp", "mcp"]);
  });

  it("the assistant can neither list nor confirm what waits for the owner; the owner decides in the app", async () => {
    const token = writer.oauth.snapshot().accessToken;
    for (const origin of [APP_ORIGIN, MCP_ORIGIN]) {
      const listed = await SELF.fetch(`${origin}/v1/proposals`, { headers: { Authorization: `Bearer ${token}` } });
      expect(listed.status, origin).toBe(401);
      const decided = await SELF.fetch(`${origin}/v1/proposals/${pendingProposalId}/decision`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ decision: "confirm" }) });
      expect(decided.status, origin).toBe(401);
    }
    expect((await writer.client.listTools()).tools.some((t) => /proposal|confirm|approve/i.test(t.name))).toBe(false);
    // Relaying "yes, I confirm" changes nothing either.
    model.script({ toolCalls: [{ toolName: "correct_garment", input: { garmentId: secondTop.garmentId, changes: { condition: "loose button (journey test)" } } }] }, { text: "SCRIPTED FAKE MODEL REPLY: still waiting for you." });
    const again = await call(writer, "garderobe_ask", { message: "Yes, I confirm the loose button", clientTurnId: `ask-${crypto.randomUUID()}`, mode: "wait" });
    expect(again.data.receipts).toEqual([]);
    expect((await owner.api.json("GET", `/v1/items/${secondTop.garmentId}`)).detail.garment.condition).toBe(secondTop.condition);
    expect((await pending()).find((p) => p.proposalId === pendingProposalId)!.state).toBe("pending");

    // The owner declines everything that is waiting; the record stays as it was.
    for (const proposal of await pending()) expect((await owner.api.post(`/v1/proposals/${proposal.proposalId}/decision`, { decision: "reject" })).status).toBe(200);
    expect(await pending()).toEqual([]);
    expect((await owner.api.json("GET", `/v1/items/${secondTop.garmentId}`)).detail.garment.condition).toBe(secondTop.condition);
  });

  it("lifting the sneakers-only restriction is refused over MCP, and the welted shoes stay off the next board", async () => {
    expect(restricted.length).toBeGreaterThan(0);
    const restrictionId = restricted[0]!.availability!.restrictionIds[0] as string;
    const proposalsBefore = (await owner.api.json("GET", "/v1/proposals?state=all")).proposals.length;
    for (const [type, payload] of [
      ["restriction.resolve", { restrictionId, evidence: { kind: "owner_statement" }, note: "the toe has healed" }],
      ["assistant.lift_restriction", { restrictionId }],
    ] as const) {
      const attempt = await call(writer, "garderobe_command", { type, payload, idempotencyKey: `lift-${crypto.randomUUID()}` });
      expect(attempt.ok, type).toBe(false);
      expect(attempt.error!.code, type).toBe("forbidden");
      expect(attempt.error!.message).not.toBe("");
    }
    // Not even left as a request for the owner: nothing new waits in the app.
    expect((await owner.api.json("GET", "/v1/proposals?state=all")).proposals.length).toBe(proposalsBefore);

    // The restriction is still active: the same shoes are still excluded, for the assistant and for the app.
    const availability = (await inventory({ view: "availability" })).data.data.garments as any[];
    for (const piece of restricted) {
      const now = availability.find((g) => g.garmentId === piece.garment.garmentId);
      expect(now.hardExcluded, piece.garment.name).toBe(true);
      expect(now.restrictionIds).toContain(restrictionId);
    }
    const item = await owner.api.json("GET", `/v1/items/${restricted[0]!.garment.garmentId}`);
    expect(item.detail.restrictions.some((r: any) => r.restrictionId === restrictionId && r.status === "active")).toBe(true);

    // Tomorrow's board, prepared afterwards, offers no restricted shoe anywhere.
    const tomorrow = (await publishBoard(owner, { date: j.day(1) })).board;
    const offered = new Set<string>(tomorrow.options.flatMap((o: any) => [...o.garments, ...o.footwearAlternatives].map((g: any) => g.garmentId)));
    expect(tomorrow.options.length).toBeGreaterThanOrEqual(3);
    for (const piece of restricted) expect(offered.has(piece.garment.garmentId), piece.garment.name).toBe(false);
    for (const option of tomorrow.options) expect(option.garments.some((g: any) => g.role === "footwear")).toBe(true);
  });

  it("garderobe_research starts a durable run that garderobe_run and the app can both follow", async () => {
    const totalBefore = (await owner.api.json("GET", "/v1/wardrobe")).total;
    model.script({ text: "SCRIPTED FAKE MODEL REPLY: nothing could be established about this product." });
    const request = { topic: "Is the synthetic fixture crewneck still made in navy?", kind: "product", clientRequestId: `research-${crypto.randomUUID()}` };
    const started = await call(writer, "garderobe_research", request);
    expect(started.ok, JSON.stringify(started.error)).toBe(true);
    expect(started.data.runId).toBeTruthy();
    const run = await settleRun(owner.api, started.data.runId);
    expect(run).toMatchObject({ kind: "research", state: "completed" });

    const followed = await call(writer, "garderobe_run", { runId: started.data.runId });
    expect(followed.ok, JSON.stringify(followed.error)).toBe(true);
    expect(followed.data.run).toMatchObject({ runId: started.data.runId, kind: "research", state: "completed" });
    const research = followed.data.run.result.research;
    expect(research.summary).toContain("nothing could be established");
    // No verdict, comparison or source is invented when none was found.
    expect(research.verdict).toBeNull();
    expect(research.comparison).toEqual([]);
    expect(research.sources).toEqual([]);
    expect(followed.data.run.result.research).toEqual(run.result.research);

    // The same request again is the same run, not a second investigation; nothing entered the wardrobe.
    const again = await call(writer, "garderobe_research", request);
    expect(again.data.runId).toBe(started.data.runId);
    expect((await owner.api.json("GET", "/v1/wardrobe")).total).toBe(totalBefore);
    // A run that does not exist is refused, not invented.
    expect((await call(writer, "garderobe_run", { runId: "trn_00000000000000000000000000000000" })).ok).toBe(false);
  });

  it("an assistant that still speaks the 2025-11-25 protocol can read through the compatibility path", async () => {
    const legacy = await connectMcp(owner, { write: false, clientName: "Legacy assistant (journey test)", redirectUri: "https://legacy.client.test/oauth/callback", era: "legacy" });
    expect((await legacy.client.listTools()).tools.map((t) => t.name)).not.toContain("garderobe_command");
    const snapshot = toolResult(await legacy.client.callTool({ name: "garderobe_inventory", arguments: { view: "snapshot" } }));
    expect(snapshot.ok, JSON.stringify(snapshot.error)).toBe(true);
    expect(snapshot.data).toMatchObject({ complete: true, total: 127 });
    const today = toolResult(await legacy.client.callTool({ name: "garderobe_today", arguments: { date: j.today } }));
    expect(today.data.board.revision).toBe((await owner.api.json("GET", `/v1/today?date=${j.today}`)).board.revision);
    await legacy.close();
    expect(((await owner.api.json("GET", "/v1/assistants")).grants as any[]).map((g) => g.clientName)).toContain("Legacy assistant (journey test)");
  });

  it("the documents are readable as resources, and nothing in this journey needed them", async () => {
    // Every tool call above was made by connections that had read no resource.
    const resources = (await reader.client.listResources()).resources.map((r) => r.uri).sort();
    expect(resources).toEqual(expect.arrayContaining(["garderobe://commands", "garderobe://guide"]));
    const guide = (await reader.client.readResource({ uri: "garderobe://guide" })).contents[0] as { mimeType?: string; text: string };
    expect(guide.mimeType).toBe("text/markdown");
    for (const tool of ["garderobe_today", "garderobe_recommend", "garderobe_inventory", "garderobe_command", "garderobe_ask", "garderobe_run"]) expect(guide.text).toContain(tool);
    expect(guide.text).toMatch(/no owner or user parameter/i);
    const commands = (await reader.client.readResource({ uri: "garderobe://commands" })).contents[0] as { mimeType?: string; text: string };
    expect(commands.mimeType).toBe("application/json");
    const listed = JSON.parse(commands.text).types.map((t: any) => t.type);
    expect(listed).toEqual((await owner.api.json("GET", "/v1/command-types")).types.map((t: any) => t.type));
    expect(listed).toEqual(expect.arrayContaining(["wear.record", "care.mark_dirty", "board.select"]));
    // A resource that does not exist is refused.
    expect(await reader.client.readResource({ uri: "garderobe://secrets" }).then(() => true, () => false)).toBe(false);
  });

  it("Disconnect in the app takes effect on the assistant's very next request, and only for that assistant", async () => {
    const token = writer.oauth.snapshot().accessToken;
    expect((await rawList(token)).status).toBe(200);
    const grant = ((await owner.api.json("GET", "/v1/assistants")).grants as any[]).find((g) => g.clientName === WRITER_NAME && g.status === "active");
    expect(grant.lastUsedAt).toBeTruthy();
    const disconnected = await owner.api.json("POST", `/v1/assistants/${grant.grantId}/disconnect`, {});
    expect(disconnected).toMatchObject({ grantId: grant.grantId, status: "revoked" });

    // The very next request with the same token is refused; so is the SDK client's next tool call.
    expect((await rawList(token)).status).toBe(401);
    const before = await dayRecord(j.today);
    const afterwards = await writer.client.callTool({ name: "garderobe_command", arguments: { type: "wear.record", payload: { wearingDate: j.today, garmentIds: [top.garmentId] }, idempotencyKey: `late-${crypto.randomUUID()}` } }).then((r) => toolResult(r).ok, () => false);
    expect(afterwards).toBe(false);
    expect(await dayRecord(j.today)).toEqual(before);

    // The app and the other assistant are unaffected; the list shows which one was disconnected.
    expect((await owner.api.get("/v1/me")).status).toBe(200);
    expect((await call(reader, "garderobe_today", { date: j.today })).ok).toBe(true);
    const grants = (await owner.api.json("GET", "/v1/assistants")).grants as any[];
    expect(grants.find((g) => g.grantId === grant.grantId)).toMatchObject({ status: "revoked" });
    expect(grants.find((g) => g.clientName === READER_NAME).status).toBe("active");
    // What the assistant recorded before it was disconnected stays recorded.
    expect(before.map((g) => g.garmentId)).toContain(shoe.garmentId);
    await writer.close();
    await reader.close();
  });
});
