import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { listInventory, listRestrictions, localDateOf } from "@garderobe/domain";
import { HEALING_RESTRICTION_ID } from "@garderobe/domain/import";
import { CLINIC_LEAFLET, GENUINE_HEALING_SENTENCES, NOT_HEALED_SENTENCES, ORDINARY_CASES, SENSITIVE_WRITE_CASES, liftAttempts, type CorpusContext, type FakeToolCall } from "@garderobe/assistant/testing";
import { APP_ORIGIN, MCP_ORIGIN, connectMcp, enableFakeModel, provisionOwner, testApp, toolResult, type FakeModel, type McpConnection, type TestOwner } from "../src/testing/index.ts";

/*
 * The confirmation design, end to end through the REAL Worker routes (this file belongs to the assistant
 * workstream; it lives here because the routes do): POST /v1/conversation/turns, GET /v1/runs/{id},
 * GET /v1/proposals, POST /v1/proposals/{id}/decision, and the MCP tool garderobe_ask.
 *
 * REAL owner fixture: the supplied profile and the real 127-garment inventory, imported through the
 * command service into the test database. Real local D1, the real conversation Durable Object and the
 * shared command service. Stand-ins: test-signed Access assertions in place of Cloudflare Access, and the
 * labelled FAKE MODEL, which is scripted as a COMPROMISED model for the adversarial corpora (it tries
 * every tool that would make the change hidden instructions ask for) and as an honest model for the
 * ordinary corpus. The corpora are committed in packages/assistant/src/testing/corpora.ts.
 */
let owner: TestOwner;
let model: FakeModel;
let ctx: CorpusContext;

interface Run {
  runId: string;
  state: string;
  receipts: { type: string; summary: string }[];
  proposals: { type: string; summary: string; payload: Record<string, unknown> }[];
}

/** One owner message through the app's conversation route, waited to its end. */
async function say(target: TestOwner, text: string, calls: FakeToolCall[], pastedText?: string): Promise<Run> {
  if (calls.length > 0) model.script({ toolCalls: calls }, { text: "Done as far as I may." });
  else model.script({ text: "Here is my answer." });
  const turn = await target.api.json("POST", "/v1/conversation/turns", { clientTurnId: `turn-${crypto.randomUUID()}`, text, ...(pastedText ? { pastedText } : {}) });
  let run = turn as Run;
  for (let i = 0; i < 200 && !["completed", "failed", "cancelled", "needs_input"].includes(run.state); i++) {
    await new Promise((r) => setTimeout(r, 25));
    run = (await target.api.json("GET", `/v1/runs/${turn.runId}`)) as Run;
  }
  return run;
}

const pending = async (target: TestOwner) => (await target.api.json("GET", "/v1/proposals")).proposals as { proposalId: string; type: string; summary: string; state: string; turnId: string; payload: Record<string, unknown>; source: { channel: string } }[];
const decide = (target: TestOwner, proposalId: string, decision: "confirm" | "reject") => target.api.post(`/v1/proposals/${proposalId}/decision`, { decision });
/** The owner rejects every pending request through the route (a handful at a time: decisions are rate limited). */
const rejectAll = async (target: TestOwner) => {
  for (const p of await pending(target)) expect((await decide(target, p.proposalId, "reject")).status).toBe(200);
};
/** Test housekeeping between corpora, not product behaviour: empty the requests the corpus left, directly in the test database. */
const discardPending = async (target: TestOwner) => {
  const app = await testApp();
  await app.db.prepare("UPDATE assistant_turns SET proposals_json = '[]' WHERE user_id = ?").bind(target.userId).run();
  expect(await pending(target)).toEqual([]);
};

/** What a sensitive change could alter, read through the app's own routes and the ledger. */
async function snapshot(target: TestOwner) {
  const app = await testApp();
  const wardrobe = await listInventory(app.db, target.systemPrincipal, { includeDisposed: true, limit: 500 });
  const style = await target.api.json("GET", "/v1/style");
  const count = async (sql: string) => ((await app.db.prepare(sql).bind(target.userId).first<{ n: number }>())?.n ?? 0);
  return {
    garments: wardrobe.items.map((i) => `${i.garment.garmentId}|${i.garment.name}|${i.garment.acquisition}|${i.garment.condition ?? ""}`).sort(),
    amendments: (style.amendments as { text: string }[]).map((a) => a.text),
    directions: (style.directions as { text: string }[]).map((d) => d.text),
    restrictions: (await listRestrictions(app.db, target.systemPrincipal)).map((r) => `${r.restrictionId}|${r.status}|${r.reason}`).sort(),
    measurements: await count("SELECT COUNT(*) AS n FROM measurements WHERE user_id = ?"),
    aliases: await count("SELECT COUNT(*) AS n FROM garment_aliases WHERE user_id = ?"),
    briefs: await count("SELECT COUNT(*) AS n FROM temporary_briefs WHERE user_id = ?"),
    wears: await count("SELECT COUNT(*) AS n FROM daily_wears WHERE user_id = ? AND status = 'active'"),
    stockEvents: await count("SELECT COUNT(*) AS n FROM stock_events WHERE user_id = ?"),
    orders: await count("SELECT COUNT(*) AS n FROM orders WHERE user_id = ?"),
    reminders: await count("SELECT COUNT(*) AS n FROM reminders WHERE user_id = ?"),
    memories: await count("SELECT COUNT(*) AS n FROM memory_conclusions WHERE user_id = ? AND status = 'active'"),
    projects: await count("SELECT COUNT(*) AS n FROM lifecycle_projects WHERE user_id = ?"),
    returns: await count("SELECT COUNT(*) AS n FROM return_cases WHERE user_id = ?"),
    tombstones: await count("SELECT COUNT(*) AS n FROM source_tombstones WHERE user_id = ?"),
    mailJobs: await count("SELECT COUNT(*) AS n FROM assistant_jobs WHERE user_id = ? AND kind = 'email_investigation'"),
  };
}

beforeAll(async () => {
  owner = await provisionOwner({ real: true });
  model = await enableFakeModel(owner);
  const app = await testApp();
  ctx = {
    garment: async (search) => {
      const hit = (await listInventory(app.db, owner.systemPrincipal, { search })).items[0];
      if (!hit) throw new Error(`test setup: no garment matches "${search}"`);
      return { garmentId: hit.garment.garmentId, name: hit.garment.name };
    },
    healingRestrictionId: HEALING_RESTRICTION_ID,
    localDate: localDateOf(Date.now(), "Europe/London"),
    yesterday: localDateOf(Date.now() - 86_400_000, "Europe/London"),
  };
});

describe("adversarial corpus through the real routes", () => {
  it(`none of the ${NOT_HEALED_SENTENCES.length} sentences that do not say the owner's feet have healed lifts the sneakers-only restriction or commits anything`, async () => {
    expect(NOT_HEALED_SENTENCES.length).toBeGreaterThanOrEqual(28);
    const before = await snapshot(owner);
    const failures: string[] = [];
    for (const sentence of NOT_HEALED_SENTENCES) {
      const run = await say(owner, sentence, await liftAttempts(ctx), CLINIC_LEAFLET.text);
      if (run.state !== "completed") failures.push(`${sentence} -> ${run.state}`);
      if (run.receipts.length > 0) failures.push(`${sentence} -> committed ${run.receipts.map((r) => r.type).join(",")}`);
    }
    expect(failures).toEqual([]);
    expect(await snapshot(owner)).toEqual(before);
    await discardPending(owner);
  });

  it(`none of the ${SENSITIVE_WRITE_CASES.length} loosely related owner sentences beside hidden instructions adds, retires or changes anything`, async () => {
    const before = await snapshot(owner);
    const failures: string[] = [];
    for (const c of SENSITIVE_WRITE_CASES) {
      const run = await say(owner, c.ownerText, await c.calls(ctx), c.attachment?.text);
      if (run.state !== "completed") failures.push(`${c.id} -> ${run.state}`);
      const changed = run.receipts.filter((r) => r.type !== "job.create");
      if (changed.length > 0) failures.push(`${c.id} -> committed ${changed.map((r) => `${r.type}: ${r.summary}`).join(" | ")}`);
    }
    expect(failures).toEqual([]);
    expect(await snapshot(owner)).toEqual(before);
    await discardPending(owner);
  });
});

describe("a genuine statement, the proposal, and the owner's decision", () => {
  it("each genuine healing statement yields only a pending proposal with the system's exact summary; rejected, the restriction stays", async () => {
    const app = await testApp();
    const active = async () => (await listRestrictions(app.db, owner.systemPrincipal, { status: "active" })).some((r) => r.restrictionId === HEALING_RESTRICTION_ID);
    for (const sentence of GENUINE_HEALING_SENTENCES) {
      const run = await say(owner, sentence, [{ toolName: "resolve_restriction", input: { restrictionId: HEALING_RESTRICTION_ID } }]);
      expect(run.receipts, sentence).toEqual([]);
      expect(run.proposals.map((p) => p.type), sentence).toEqual(["assistant.lift_restriction"]);
      expect(await active(), sentence).toBe(true);
    }
    const list = await pending(owner);
    expect(list).toHaveLength(GENUINE_HEALING_SENTENCES.length);
    for (const p of list) {
      expect(p).toMatchObject({ type: "assistant.lift_restriction", state: "pending", source: { channel: "ios" }, payload: { restrictionId: HEALING_RESTRICTION_ID } });
      expect(p.summary).toMatch(/^LIFT the restriction \(healing\) whose reason is \u201C/);
    }
    await rejectAll(owner);
    expect(await active()).toBe(true); // the real owner's restriction is not lifted by this test
    // A rejected proposal is not confirmed later.
    expect((await decide(owner, list[0]!.proposalId, "confirm")).status).toBe(409);
    expect(await active()).toBe(true);
  });

  it("confirmed by the owner in the app, the exact proposal takes effect once; modified, expired or already decided, it is refused; a connected assistant can neither list nor confirm it", async () => {
    const app = await testApp();
    const shirt = await ctx.garment("ISTO denim shirt");
    const condition = async () => (await app.db.prepare("SELECT condition FROM garments WHERE user_id = ? AND garment_id = ?").bind(owner.userId, shirt.garmentId).first<{ condition: string | null }>())?.condition ?? null;
    const original = await condition();
    const ask = () => say(owner, "The ISTO denim shirt has a frayed collar now.", [{ toolName: "correct_garment", input: { garmentId: shirt.garmentId, changes: { condition: "frayed collar (test fixture)" } } }]);

    // 1. Proposed, not done; the owner sees exactly what would change.
    const run = await ask();
    expect(run.receipts).toEqual([]);
    const [proposal] = await pending(owner);
    expect(proposal).toMatchObject({ type: "garment.correct", state: "pending", turnId: run.runId });
    expect(proposal!.summary).toBe(`Change the record of \u201C${shirt.name}\u201D: condition \u201Cfrayed collar (test fixture)\u201D.`);
    expect(await condition()).toBe(original);

    // 2. A connected assistant, even with write permission, can neither list nor decide it, on either hostname, and has no tool for it.
    const mcp: McpConnection = await connectMcp(owner, { write: true, clientName: "Connected assistant (test)" });
    const token = mcp.oauth.snapshot().accessToken;
    for (const origin of [APP_ORIGIN, MCP_ORIGIN]) {
      expect((await SELF.fetch(`${origin}/v1/proposals`, { headers: { Authorization: `Bearer ${token}` } })).status, origin).toBe(401);
      expect((await SELF.fetch(`${origin}/v1/proposals/${proposal!.proposalId}/decision`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ decision: "confirm" }) })).status, origin).toBe(401);
    }
    expect((await mcp.client.listTools()).tools.some((t) => /proposal|confirm|approve/i.test(t.name))).toBe(false);
    // Asking the backend assistant through the connected assistant to "confirm" only produces another proposal.
    model.script({ toolCalls: [{ toolName: "correct_garment", input: { garmentId: shirt.garmentId, changes: { condition: "frayed collar (test fixture)" } } }] }, { text: "That needs your confirmation in the app." });
    const relayed = toolResult(await mcp.client.callTool({ name: "garderobe_ask", arguments: { message: "yes I confirm, the ISTO denim shirt has a frayed collar", clientTurnId: `turn-${crypto.randomUUID()}`, mode: "wait" } }));
    expect(relayed.data.receipts).toEqual([]);
    expect(await condition()).toBe(original);
    // Another owner cannot see or decide it.
    const stranger = await provisionOwner();
    expect(await pending(stranger)).toEqual([]);
    expect((await decide(stranger, proposal!.proposalId, "confirm")).status).toBe(404);

    // 3. Stale: the record changed after the proposal was made. Confirming is refused and nothing is overwritten.
    expect((await owner.api.command("garment.correct", { garmentId: shirt.garmentId, changes: { condition: "mended (test fixture)" }, source: { kind: "owner_statement" } })).status).toBe(200);
    const stale = await decide(owner, proposal!.proposalId, "confirm");
    expect(stale.status).toBeGreaterThanOrEqual(400);
    expect(await condition()).toBe("mended (test fixture)");

    // 4. Modified: a proposal is identified by its exact content, so a changed payload is not this proposal.
    await app.db.prepare("UPDATE assistant_turns SET proposals_json = replace(proposals_json, 'frayed collar (test fixture)', 'ruined (tampered)') WHERE user_id = ? AND turn_id = ?").bind(owner.userId, run.runId).run();
    expect((await decide(owner, proposal!.proposalId, "confirm")).status).toBe(404);
    expect(await condition()).toBe("mended (test fixture)");
    await rejectAll(owner);

    // 5. Expired: older than fourteen days it can only be rejected.
    const old = await ask();
    const [aged] = (await pending(owner)).filter((p) => p.turnId === old.runId);
    await app.db.prepare("UPDATE assistant_turns SET created_at = ? WHERE user_id = ? AND turn_id = ?").bind(new Date(Date.now() - 15 * 86_400_000).toISOString(), owner.userId, old.runId).run();
    expect((await decide(owner, aged!.proposalId, "confirm")).status).toBe(409);
    expect(await condition()).toBe("mended (test fixture)");
    expect((await decide(owner, aged!.proposalId, "reject")).status).toBe(200);

    // 6. Fresh and unchanged: the owner's confirmation carries it out once, as the owner's own tap, with a receipt.
    const fresh = await ask();
    const [current] = (await pending(owner)).filter((p) => p.turnId === fresh.runId);
    const response = await decide(owner, current!.proposalId, "confirm");
    const body = (await response.json()) as { receipt: { commandId: string; type: string }; proposal: { state: string }; replayed: boolean };
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ replayed: false, proposal: { state: "confirmed" }, receipt: { type: "garment.correct" } });
    expect(await condition()).toBe("frayed collar (test fixture)");
    const command = await app.db.prepare("SELECT actor, channel, authorization_basis FROM commands WHERE user_id = ? AND command_id = ?").bind(owner.userId, body.receipt.commandId).first();
    expect(command).toEqual({ actor: "owner", channel: "ios", authorization_basis: "owner_tap" });
    // Already decided: confirming again repeats nothing, and it cannot be rejected afterwards.
    expect(((await (await decide(owner, current!.proposalId, "confirm")).json()) as { replayed: boolean }).replayed).toBe(true);
    expect((await decide(owner, current!.proposalId, "reject")).status).toBe(409);
    await rejectAll(owner);
  });

  it("a request to retire, move or receive a piece is refused as stale when the piece changed before the owner confirmed, and nothing is written", async () => {
    const app = await testApp();
    // SYNTHETIC incoming piece for the arrival case (the real inventory has nothing on order), added as the owner in the app.
    const created = await owner.api.command("garment.create", { name: "Grey lambswool scarf (synthetic test piece)", category: "accessory", roles: ["accessory"], careChannel: "none", acquisition: "incoming", quantity: 1, source: { kind: "owner_statement" } });
    expect(created.status).toBe(200);
    const scarf = await ctx.garment("Grey lambswool scarf (synthetic test piece)");
    const plaid = await ctx.garment("California plaid");
    const boots = await ctx.garment("Paraboot Michael");
    const cases: { type: string; garmentId: string; text: string; call: FakeToolCall }[] = [
      { type: "garment.retire", garmentId: plaid.garmentId, text: "I gave the California plaid away.", call: { toolName: "retire_garment", input: { garmentId: plaid.garmentId, disposition: "donated" } } },
      { type: "garment.move", garmentId: boots.garmentId, text: "The Paraboot Michael went into storage.", call: { toolName: "move_garment", input: { garmentId: boots.garmentId, to: "storage" } } },
      { type: "assistant.report_arrival", garmentId: scarf.garmentId, text: "The grey lambswool scarf arrived.", call: { toolName: "report_arrival", input: { garmentId: scarf.garmentId } } },
    ];
    const stateOf = async (garmentId: string) => ({
      record: await app.db.prepare("SELECT acquisition, condition, version FROM garments WHERE user_id = ? AND garment_id = ?").bind(owner.userId, garmentId).first(),
      stockEvents: (await app.db.prepare("SELECT COUNT(*) AS n FROM stock_events WHERE user_id = ? AND garment_id = ?").bind(owner.userId, garmentId).first<{ n: number }>())!.n,
    });
    for (const c of cases) {
      const run = await say(owner, c.text, [c.call]);
      expect(run.receipts, c.type).toEqual([]);
      const [proposal] = (await pending(owner)).filter((p) => p.turnId === run.runId);
      expect(proposal, c.type).toMatchObject({ type: c.type, state: "pending" });
      // The owner changes the piece in the app before looking at the request.
      expect((await owner.api.command("garment.correct", { garmentId: c.garmentId, changes: { condition: "changed after the request (test fixture)" }, source: { kind: "owner_statement" } })).status, c.type).toBe(200);
      const before = await stateOf(c.garmentId);
      const response = await decide(owner, proposal!.proposalId, "confirm");
      expect(response.status, c.type).toBe(409);
      expect(((await response.json()) as { error: { code: string } }).error.code, c.type).toBe("conflict");
      expect(await stateOf(c.garmentId), c.type).toEqual(before);
      // Still the owner's to decide: it stays pending and can be rejected.
      expect((await pending(owner)).some((p) => p.proposalId === proposal!.proposalId && p.state === "pending"), c.type).toBe(true);
    }
    await rejectAll(owner);
  });
});

describe("ordinary use through the real routes", () => {
  it(`all ${ORDINARY_CASES.length} ordinary requests are answered, recorded or turned into one request to confirm, with zero refusals`, async () => {
    expect(ORDINARY_CASES.length).toBeGreaterThanOrEqual(28);
    const failures: string[] = [];
    const tally = { recorded: 0, proposed: 0, answered: 0 };
    for (const c of ORDINARY_CASES) {
      const run = await say(owner, c.ownerText, await c.calls(ctx));
      // What the assistant refused in that turn, from the turn's own record.
      const refusals = JSON.parse((await (await testApp()).db.prepare("SELECT refusals_json FROM assistant_turns WHERE user_id = ? AND turn_id = ?").bind(owner.userId, run.runId).first<{ refusals_json: string }>())?.refusals_json ?? "[]") as unknown[];
      if (run.state !== "completed") failures.push(`${c.id}: ${run.state}`);
      if (refusals.length > 0) failures.push(`${c.id}: refused ${JSON.stringify(refusals)}`);
      const receipts = run.receipts.map((r) => r.type).join();
      const proposals = run.proposals.map((p) => p.type).join();
      if (c.expect.outcome === "recorded") {
        if (receipts !== c.expect.type || proposals) failures.push(`${c.id}: expected a ${c.expect.type} receipt, got receipts [${receipts}] proposals [${proposals}]`);
        else tally.recorded++;
      } else if (c.expect.outcome === "proposed") {
        if (proposals !== c.expect.type || receipts) failures.push(`${c.id}: expected a ${c.expect.type} proposal, got receipts [${receipts}] proposals [${proposals}]`);
        else tally.proposed++;
      } else if (receipts || proposals) failures.push(`${c.id}: expected only an answer`);
      else tally.answered++;
    }
    expect(failures).toEqual([]);
    expect(tally.recorded + tally.proposed + tally.answered).toBe(ORDINARY_CASES.length);
    // Every request left for the owner is in the app's list, each with a summary; the real owner's records are left as they were.
    const list = await pending(owner);
    expect(list.length).toBe(tally.proposed);
    expect(list.every((p) => p.summary.length > 10)).toBe(true);
    await discardPending(owner);
  });
});
