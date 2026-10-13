/*
 * TEST CLASS 14 (second file): a connected assistant that over-reaches: the limits on what it can leave
 * waiting for the owner, under load.
 *
 * The first file (test/14-connected-assistant.test.ts) holds the command-class boundary, the proposal
 * routes, the owner's decision, the summary and the cap of 40 undecided requests per connection. This
 * file holds the two cases that need many requests and would make that file slow:
 *   - a burst of concurrent requests on one connection must not get past the cap of 40;
 *   - the owner's list of waiting requests is not cut off: the oldest request stays listed and decidable
 *     after several hundred newer requests (typed commands and relayed turns) have come and been decided.
 * Under the owner's contract of 2026-10-05 only section-3 requests wait (and count against the limits), so
 * every request here is one: a typed erasure of a media asset, and a relayed turn whose model asks to forget
 * a message for good.
 *
 * Everything runs against the real Worker in-process (OAuth provider, MCP server, router, command service,
 * local D1). `real` is the owner's real imported profile and inventory and is only read here (it must come
 * out untouched); every request is made for LABELLED SYNTHETIC owners. Stand-ins at external boundaries
 * only: test-signed sign-in assertions in place of Cloudflare Access, the SDK client in place of a consumer
 * assistant, the labelled FAKE MODEL behind `garderobe_ask`, and `newDecisionHour` (src/connected-helpers.ts)
 * for the hours of the owner's time that several hundred decisions would take.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectMcp, createWorld, defect, enableFakeModel, fingerprint, provisionOwner, rowCounts, sql, type FakeModel, type McpConnection, type TestOwner, type World } from "../src/harness.ts";
import { allProposals, command, commandRows, decide, mcpCall, newDecisionHour, newKey, ownerRejects, pendingProposals } from "../src/connected-helpers.ts";

const LIMIT = 40;
let world: World;
let model: FakeModel;
let realBefore: { counts: Record<string, number>; ledger: Record<string, unknown> };
let serial = 0;

/** A typed request that waits for the owner (section 3: erasing a media asset), each one distinct. */
const request = (mcp: McpConnection) => command(mcp, "media.delete_asset", { assetId: `SYNTHETIC-asset-${++serial}`, reason: "SYNTHETIC: not needed (test fixture)" });
/** A FAKE MODEL step that asks to forget one message for good (section 3), so the relayed turn leaves a request for the owner. */
const relayed = (sourceId: string) => ({ toolCalls: [{ toolName: "forget", input: { sourceKind: "message", sourceIds: [sourceId] } }] });

beforeAll(async () => {
  world = await createWorld();
  model = await enableFakeModel(world.synthetic);
  realBefore = { counts: await rowCounts(world.real), ledger: await fingerprint(world.real) };
});

afterAll(async () => {
  // Nothing in this file is done for the real owner.
  expect({ counts: await rowCounts(world.real), ledger: await fingerprint(world.real) }).toEqual(realBefore);
});

describe("B. the cap on undecided requests, under load", () => {
  it("[fixed M14-8] a burst of concurrent requests on one connection leaves more than 40 undecided requests", async () => {
    const owner = world.synthetic;
    const connection = await connectMcp(owner, { write: true, clientName: "SYNTHETIC assistant sending a burst" });
    expect(await pendingProposals(owner)).toEqual([]);
    // Sixty requests at once, each with its own idempotency key.
    const results = await Promise.all(Array.from({ length: 60 }, () => request(connection)));
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(["confirmation_required", "rate_limited"]).toContain(result.error!.code);
    }
    const kept = results.filter((r) => r.error!.code === "confirmation_required").length;
    const waiting = await pendingProposals(owner);
    try {
      expect(waiting.length).toBeLessThanOrEqual(LIMIT);
      expect(kept).toBeLessThanOrEqual(LIMIT);
      // Once the burst is over the connection is at its limit.
      expect((await request(connection)).error!.code).toBe("rate_limited");
    } finally {
      await connection.close();
    }
  });

  it(
    "keeps the oldest waiting requests on the owner's list, and decidable, after more than 200 newer typed requests and more than 200 newer relayed turns",
    async () => {
      const owner: TestOwner = await provisionOwner({ displayName: "SYNTHETIC long-list owner (adversarial test fixture)" });
      await enableFakeModel(owner);
      const connection = await connectMcp(owner, { write: true, clientName: "SYNTHETIC prolific assistant" });
      // The oldest requests: one typed command and one left by a relayed turn (FAKE MODEL scripted to ask for the erasure).
      const oldestArgs = { type: "media.delete_asset", payload: { assetId: "SYNTHETIC-oldest-asset", reason: "SYNTHETIC: the oldest request (test fixture)" }, idempotencyKey: newKey("oldest") };
      expect((await mcpCall(connection, "garderobe_command", oldestArgs)).error).toMatchObject({ code: "confirmation_required", details: { state: "pending" } });
      model.script(relayed("SYNTHETIC-oldest-message"), { text: "That needs your confirmation." });
      const oldestTurn = await mcpCall(connection, "garderobe_ask", { message: "SYNTHETIC: forget my oldest message for good", clientTurnId: newKey("turn"), mode: "wait" });
      expect(oldestTurn.ok, JSON.stringify(oldestTurn.error)).toBe(true);
      expect(oldestTurn.data.receipts).toEqual([]);
      const oldest = await pendingProposals(owner);
      expect(oldest.map((p) => p.type).sort()).toEqual(["conversation.forget_source", "media.delete_asset"]);
      const oldestIds = oldest.map((p) => p.proposalId).sort();
      const oldestTurnId = oldest.find((p) => p.type === "conversation.forget_source")!.turnId;
      expect(oldestTurnId).toBe(String(oldestTurn.data.runId));

      // Newer requests in rounds that fit under the connection's limit (2 + 19 + 19 = 40): 19 relayed turns, then 19
      // typed commands, then the owner rejects all 38 in the app. Eleven rounds: 209 of each kind. The turns come
      // first because a new turn starts only when there is room for everything one turn can leave (8; the M14-7
      // fix, `hasRoomFor` in apps/worker/src/proposals/store.ts), so a turn is never sent with fewer than 8 free places.
      const ROUND = 19;
      let typedTotal = 0;
      let turnTotal = 0;
      for (let round = 0; round < 11; round++) {
        for (let i = 0; i < ROUND; i++) {
          model.script(relayed(`SYNTHETIC-message-${round}-${i}`), { text: "That needs your confirmation." });
          const turn = await mcpCall(connection, "garderobe_ask", { message: `SYNTHETIC: forget message ${round}-${i} for good`, clientTurnId: newKey("turn"), mode: "wait" });
          expect(turn.ok, `round ${round}, turn ${i}: ${JSON.stringify(turn.error)}`).toBe(true);
          expect(turn.data.receipts).toEqual([]);
          turnTotal++;
        }
        for (let i = 0; i < ROUND; i++) {
          const typed = await request(connection);
          expect(typed.error!.code, `round ${round}, typed ${i}`).toBe("confirmation_required");
          typedTotal++;
        }
        const listed = await pendingProposals(owner);
        // The oldest two are on the list in every round.
        for (const id of oldestIds) expect(listed.map((p) => p.proposalId), `round ${round}`).toContain(id);
        const newer = listed.filter((p) => !oldestIds.includes(p.proposalId));
        expect(newer.length, `round ${round}`).toBe(2 * ROUND);
        for (const p of newer) expect(await ownerRejects(owner, p.proposalId), `round ${round}`).toBe(200);
      }
      expect(typedTotal).toBeGreaterThan(200);
      expect(turnTotal).toBeGreaterThan(200);
      // More than 200 newer rows of each kind really exist behind the oldest ones.
      const oldestTyped = (await sql<{ created_at: string }>("SELECT created_at FROM submitted_proposals WHERE user_id = ? AND idempotency_key = ?", owner.userId, oldestArgs.idempotencyKey))[0]!;
      const oldestTurnRow = (await sql<{ created_at: string }>("SELECT created_at FROM assistant_turns WHERE user_id = ? AND turn_id = ?", owner.userId, oldestTurnId))[0]!;
      const newerRequests = (await sql<{ n: number }>("SELECT COUNT(*) AS n FROM proposal_decisions d WHERE d.user_id = ? AND d.decision = 'rejected'", owner.userId))[0]!.n;
      expect(newerRequests).toBe(typedTotal + turnTotal);
      expect((await sql<{ n: number }>("SELECT COUNT(*) AS n FROM submitted_proposals WHERE user_id = ? AND turn_id IS NULL AND unixepoch(created_at) >= unixepoch(?) AND idempotency_key != ?", owner.userId, oldestTyped.created_at, oldestArgs.idempotencyKey))[0]!.n).toBeGreaterThan(200);
      const newerTurns =
        (await sql<{ n: number }>("SELECT COUNT(*) AS n FROM assistant_turns WHERE user_id = ? AND proposals_json != '[]' AND unixepoch(created_at) >= unixepoch(?) AND turn_id != ?", owner.userId, oldestTurnRow.created_at, oldestTurnId))[0]!.n +
        (await sql<{ n: number }>("SELECT COUNT(DISTINCT turn_id) AS n FROM submitted_proposals WHERE user_id = ? AND turn_id IS NOT NULL AND turn_id != ?", owner.userId, oldestTurnId))[0]!.n;
      expect(newerTurns).toBeGreaterThan(200);

      // Both oldest requests still wait, are counted, and are in the full history as pending.
      const waiting = await owner.api.json("GET", "/v1/proposals");
      expect(waiting.pending).toBe(2);
      expect((waiting.proposals as { proposalId: string }[]).map((p) => p.proposalId).sort()).toEqual(oldestIds);
      const history = await allProposals(owner);
      for (const id of oldestIds) expect(history.find((p) => p.proposalId === id)).toMatchObject({ state: "pending" });
      // And the owner can still decide each of them by its identifier.
      await newDecisionHour(owner);
      for (const id of oldestIds) {
        const decided = await decide(owner, id, "reject");
        expect(decided.status, id).toBe(200);
        expect(decided.body.proposal).toMatchObject({ proposalId: id, state: "rejected" });
      }
      expect(await pendingProposals(owner)).toEqual([]);
      expect((await mcpCall(connection, "garderobe_command", oldestArgs)).error).toMatchObject({ code: "forbidden", details: { reason: "rejected_by_owner" } });
      // Through all of it nothing was carried out for this owner: no garment exists, nothing was erased or forgotten.
      expect((await sql<{ n: number }>("SELECT COUNT(*) AS n FROM garments WHERE user_id = ?", owner.userId))[0]!.n).toBe(0);
      expect((await commandRows(owner)).filter((r) => r.actor !== "system")).toEqual([]);
      await connection.close();
    },
    600_000,
  );
});
