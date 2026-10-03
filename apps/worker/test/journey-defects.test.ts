import { beforeAll, describe, expect, it } from "vitest";
import { gatewayUsageLookup } from "../src/lanes/assistant.ts";
import { resumeTargetDay } from "../src/lanes/daily.ts";
import { MAX_VALUE_CHARS } from "../src/proposals/store.ts";
import { connectMcp, enableFakeModel, ownerDay, provisionOwner, testApp, toolResult, type FakeModel, type TestOwner } from "../src/testing/index.ts";

/*
 * Worker-side regressions for product defects the journey suite found (tests/journeys/DEFECTS.md), each
 * through the real routes: D11-1 (the recovery screen counted a question the owner had answered), D10-1
 * (resuming in the app prepared no board), D14-1 and D07-1 (the request the owner confirms showed
 * identifiers and raw fields).
 *
 * REAL owner fixture for the resume test (a board needs the real wardrobe; nothing of the owner's is
 * changed beyond a pause that is ended again); SYNTHETIC owners elsewhere. Stand-ins: test-signed Access
 * assertions in place of Cloudflare Access, the labelled FAKE MODEL, no reachable weather service and no
 * calendar (the board says so).
 */

const recovery = (o: TestOwner) => o.api.json("GET", "/v1/recovery");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("D11-1: the recovery screen counts only questions that still wait for the owner", () => {
  let owner: TestOwner;
  let model: FakeModel;
  beforeAll(async () => {
    owner = await provisionOwner();
    model = await enableFakeModel(owner);
  });

  it("counts a question as soon as the assistant asks it, although nobody has read the run, and stops counting it once it is answered", async () => {
    expect((await recovery(owner)).pending.runsNeedingInput).toBe(0);
    model.script({ toolCalls: [{ toolName: "ask_owner", input: { question: "Which blazer do you mean?", choices: [{ id: "navy", label: "The navy one" }, { id: "grey", label: "The grey one" }] } }] }, { text: "One moment." });
    const accepted = await owner.api.json("POST", "/v1/conversation/turns", { clientTurnId: `turn-${crypto.randomUUID()}`, text: "What goes with the blazer?" });
    // Only the recovery screen is read while the turn runs: it finds the waiting question itself.
    let pending = 0;
    for (let i = 0; i < 200 && pending === 0; i++) {
      await sleep(25);
      pending = (await recovery(owner)).pending.runsNeedingInput;
    }
    expect(pending).toBe(1);
    const waiting = await owner.api.json("GET", `/v1/runs/${accepted.runId}`);
    expect(waiting.state).toBe("needs_input");

    model.script({ text: "With the navy blazer, the grey flannels." });
    const answered = await owner.api.json("POST", `/v1/runs/${accepted.runId}/input`, { inputId: waiting.pendingInput.inputId, choiceId: "navy" });
    // Answered: nothing waits for the owner, at once and after the answer's own run has finished.
    expect((await recovery(owner)).pending.runsNeedingInput).toBe(0);
    let settled = answered;
    for (let i = 0; i < 200 && !["completed", "failed", "cancelled", "needs_input"].includes(settled.state); i++) {
      await sleep(25);
      settled = await owner.api.json("GET", `/v1/runs/${answered.runId}`);
    }
    expect(settled.state).toBe("completed");
    expect((await recovery(owner)).pending.runsNeedingInput).toBe(0);
    expect((await owner.api.json("GET", `/v1/runs/${accepted.runId}`)).state).toBe("completed");
  });

  it("stops counting a question when the owner cancels the run instead of answering", async () => {
    model.script({ toolCalls: [{ toolName: "ask_owner", input: { question: "Which trousers?", choices: [] } }] }, { text: "One moment." });
    const accepted = await owner.api.json("POST", "/v1/conversation/turns", { clientTurnId: `turn-${crypto.randomUUID()}`, text: "And the trousers?" });
    let pending = 0;
    for (let i = 0; i < 200 && pending === 0; i++) {
      await sleep(25);
      pending = (await recovery(owner)).pending.runsNeedingInput;
    }
    expect(pending).toBe(1);
    expect((await owner.api.json("POST", `/v1/runs/${accepted.runId}/cancel`)).run.state).toBe("cancelled");
    expect((await recovery(owner)).pending.runsNeedingInput).toBe(0);
  });
});

describe("D10-1: resuming in the app prepares the next useful board", () => {
  let owner: TestOwner;
  const boardOn = async (offset: number) => (await owner.api.json("GET", `/v1/today?date=${await ownerDay(owner, offset)}`)).board;
  const prepared = async () => [await boardOn(0), await boardOn(1)].filter((b) => b !== null);
  const boardCommands = async () =>
    ((await (await testApp()).db.prepare("SELECT COUNT(*) AS n FROM commands WHERE user_id = ? AND type = 'board.publish'").bind(owner.userId).first<{ n: number }>())!.n);

  beforeAll(async () => {
    owner = await provisionOwner({ real: true });
  });

  it("prepares a board of real garments for today or tomorrow after the owner's own resume command, and only one", async () => {
    expect(await prepared()).toEqual([]);
    expect((await owner.api.command("service.pause", { resumeOn: null })).status).toBe(200);
    const resumed = (await (await owner.api.command("service.resume", {})).json()) as any;
    expect(resumed.outcome).toBe("committed");
    expect(resumed.summary).toContain("The next board is being prepared");

    // The preparation follows the receipt; it is waited for here, as the app would by reading Today again.
    let boards: any[] = [];
    for (let i = 0; i < 200 && boards.length === 0; i++) {
      await sleep(50);
      boards = await prepared();
    }
    expect(boards).toHaveLength(1); // the next useful day only, no backlog
    expect(boards[0].options.length).toBeGreaterThan(0);
    const wardrobe = await owner.api.json("GET", "/v1/wardrobe?limit=200");
    const owned = new Set(wardrobe.items.map((i: any) => i.garment.garmentId));
    for (const option of boards[0].options) for (const line of option.garments) expect(owned.has(line.garmentId), line.name).toBe(true);
    expect((await owner.api.json("GET", "/v1/service")).paused).toBe(false);

    // The scheduled sweep and further commands find the board there and prepare nothing more for the resume.
    const published = await boardCommands();
    const app = await testApp();
    await app.daily!.scheduled(Date.now());
    expect((await owner.api.command("service.resume", {})).status).toBe(200); // not paused: changes nothing
    await sleep(200);
    expect(await boardCommands()).toBe(published);
    expect((await prepared()).map((b) => `${b.boardId}:${b.revision}`)).toEqual(boards.map((b) => `${b.boardId}:${b.revision}`));
  });

  it("prepares nothing while the pause lasts, and the sweep catches up on a resume whose own follow-up did not run", async () => {
    const other = await provisionOwner({ real: true });
    const app = await testApp();
    const boardsOf = async () => ((await app.db.prepare("SELECT COUNT(*) AS n FROM boards WHERE user_id = ?").bind(other.userId).first<{ n: number }>())!.n);
    expect((await other.api.command("service.pause", { resumeOn: null })).status).toBe(200);
    await app.daily!.scheduled(Date.now());
    expect(await boardsOf()).toBe(0);
    // The resume is committed through the command service directly, as a conversation turn does: no route's
    // follow-up runs. The next scheduled sweep prepares the board.
    const { createPrincipal } = await import("@garderobe/domain");
    const ownerInApp = createPrincipal({ userId: other.userId, actor: "owner", channel: "ios", scopes: ["read", "write"], authRef: "test:resume-without-follow-up" });
    const receipt = await app.service.execute(ownerInApp, { type: "service.resume", payload: {}, idempotencyKey: `resume-${crypto.randomUUID()}`, expectedVersions: {}, authorization: "owner_tap", source: { channel: "ios" } });
    expect(receipt.outcome).toBe("committed");
    expect(await boardsOf()).toBe(0);
    await app.daily!.scheduled(Date.now());
    expect(await boardsOf()).toBe(1);
    // The board is for the day the moment of the resume fixes; later sweeps prepare nothing more in the resume's name.
    const ended = (await app.db.prepare("SELECT ended_at FROM service_pauses WHERE user_id = ? AND status = 'ended'").bind(other.userId).first<{ ended_at: string }>())!.ended_at;
    const target = resumeTargetDay(Date.parse(ended), "Europe/London");
    const days = async () => (await app.db.prepare("SELECT local_date FROM boards WHERE user_id = ?").bind(other.userId).all<{ local_date: string }>()).results.map((r) => r.local_date);
    expect(await days()).toEqual([target]);
    const resumeBoards = async () => ((await app.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE user_id = ? AND type = 'board.publish' AND substr(idempotency_key, 1, 13) = 'resume-board:'").bind(other.userId).first<{ n: number }>())!.n);
    expect(await resumeBoards()).toBe(1);
    await app.daily!.scheduled(Date.now());
    await app.daily!.afterCommit(other.systemPrincipal);
    expect(await resumeBoards()).toBe(1);
    expect(await days()).toContain(target);
  });

  it("fixes the day by the moment of the resume in the owner's timezone: that day before midday, the next day from midday on", () => {
    expect(resumeTargetDay(Date.parse("2026-10-03T07:30:00Z"), "Europe/London")).toBe("2026-10-03"); // 08:30 in London
    expect(resumeTargetDay(Date.parse("2026-10-03T10:59:00Z"), "Europe/London")).toBe("2026-10-03"); // 11:59
    expect(resumeTargetDay(Date.parse("2026-10-03T11:00:00Z"), "Europe/London")).toBe("2026-10-04"); // midday
    expect(resumeTargetDay(Date.parse("2026-10-03T22:59:00Z"), "Europe/London")).toBe("2026-10-04"); // 23:59
    expect(resumeTargetDay(Date.parse("2026-10-03T23:30:00Z"), "Europe/London")).toBe("2026-10-04"); // 00:30 on the 4th
    expect(resumeTargetDay(Date.parse("2026-10-03T23:30:00Z"), "America/New_York")).toBe("2026-10-04"); // 19:30 on the 3rd
    expect(resumeTargetDay(Date.parse("2026-12-31T23:30:00Z"), "Europe/London")).toBe("2027-01-01");
  });
});

describe("D14-1, D07-1: the request the owner confirms is in words", () => {
  it("names the trip and the settings instead of showing identifiers, field names or raw payload", async () => {
    const owner = await provisionOwner();
    const departs = await ownerDay(owner, 10);
    const returns = await ownerDay(owner, 12);
    const created = (await (await owner.api.command("trip.create", { name: "Synthetic trip to Paris (test fixture)", departsOn: departs, returnsOn: returns, destinations: [{ label: "Paris", timezone: "Europe/Paris", from: departs, to: returns }], source: { kind: "owner_statement" } })).json()) as any;
    const tripId = String(created.result.tripId ?? created.affected.find((a: any) => a.kind === "trip")?.id);
    const settings = (await owner.api.json("GET", "/v1/settings")).settings;
    const mcp = await connectMcp(owner, { write: true, clientName: "Planning assistant (test)" });
    const ask = async (type: string, payload: Record<string, unknown>) => toolResult(await mcp.client.callTool({ name: "garderobe_command", arguments: { type, payload, idempotencyKey: `words-${crypto.randomUUID()}` } }));
    expect((await ask("trip.update", { tripId, changes: { name: "Synthetic trip to Lyon (test fixture)" } })).error!.code).toBe("confirmation_required");
    expect((await ask("settings.update", { patch: { delivery: { ...settings.delivery, morningLocalTime: "06:45" } } })).error!.code).toBe("confirmation_required");
    expect((await ask("trip.cancel", { tripId })).error!.code).toBe("confirmation_required");

    const shown = (await owner.api.json("GET", "/v1/proposals")).proposals as { type: string; summary: string }[];
    expect(shown.map((p) => p.type).sort()).toEqual(["settings.update", "trip.cancel", "trip.update"]);
    for (const p of shown) {
      expect(p.summary, p.type).not.toContain(tripId);
      expect(p.summary, p.type).not.toMatch(/\b[a-z]{2,4}_[0-9a-f]{12,}\b/); // no record identifier
      expect(p.summary, p.type).not.toMatch(/\b(?:tripId|boardId|optionId|garmentId)\b/); // no field names as written in code
      expect(p.summary, p.type).not.toMatch(/[{}]|":/); // no raw payload
      expect(p.summary, p.type).not.toContain(p.type); // no command name
    }
    const summaryOf = (type: string) => shown.find((p) => p.type === type)!.summary;
    expect(summaryOf("trip.update")).toMatch(/^Change a trip\. /);
    expect(summaryOf("trip.update")).toContain(`the trip \u201CSynthetic trip to Paris (test fixture)\u201D (${departs} to ${returns})`);
    expect(summaryOf("trip.update")).toContain("\u201CSynthetic trip to Lyon (test fixture)\u201D");
    expect(summaryOf("trip.cancel")).toMatch(/^Cancel a trip\. /);
    expect(summaryOf("settings.update")).toMatch(/^Change your settings\./);
    expect(summaryOf("settings.update")).toContain("\u201C06:45\u201D");
    // What is confirmed is still exactly what was asked: the payload is unchanged and runs as the owner's tap.
    const update = ((await owner.api.json("GET", "/v1/proposals")).proposals as any[]).find((p) => p.type === "trip.update");
    const decided = (await (await owner.api.post(`/v1/proposals/${update.proposalId}/decision`, { decision: "confirm" })).json()) as any;
    expect(decided.receipt).toMatchObject({ type: "trip.update", outcome: "committed" });
    expect((await owner.api.json("GET", `/v1/trips/${tripId}`)).name).toBe("Synthetic trip to Lyon (test fixture)");
    await mcp.close();
  });

  it("lists a stored request that cannot be shown in full with a plain statement, never as raw fields, and lets the owner reject but not confirm it", async () => {
    const owner = await provisionOwner();
    const app = await testApp();
    // TEST SETUP standing in for a request kept before the bounds existed: written straight into the test database.
    const text = `Synthetic amendment kept earlier (test fixture). ${"z".repeat(MAX_VALUE_CHARS + 500)}`;
    const payload = { documentId: "owner-profile", text, kind: "taste", source: { kind: "owner_statement" } };
    const proposalId = `prp_${"0".repeat(31)}1`;
    await app.db
      .prepare("INSERT INTO submitted_proposals (user_id, proposal_id, origin, source_ref, grant_id, turn_id, idempotency_key, request_hash, command_type, payload_json, expected_versions_json, occurred_at, created_at) VALUES (?, ?, 'typed_command', 'grant-fixture', NULL, NULL, 'kept-earlier-0001', 'fixture', 'style.add_amendment', ?, '{}', NULL, ?)")
      .bind(owner.userId, proposalId, JSON.stringify(payload), new Date().toISOString().replace(/\.\d{3}Z$/, "Z"))
      .run();
    const [shown] = (await owner.api.json("GET", "/v1/proposals")).proposals as any[];
    expect(shown).toMatchObject({ proposalId, type: "style.add_amendment", state: "pending" });
    expect(shown.summary).toBe("Add an amendment to My style. This request cannot be shown to you in full, so it cannot be confirmed. Reject it; if the change is still wanted, it can be asked for again in a shorter form.");
    expect(shown.summary).not.toMatch(/[{}]|":|zzzz/);
    const refused = await owner.api.post(`/v1/proposals/${proposalId}/decision`, { decision: "confirm" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as any).error).toMatchObject({ code: "precondition_failed", details: { reason: "not_shown_in_full" } });
    expect((await app.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE user_id = ? AND type = 'style.add_amendment'").bind(owner.userId).first<{ n: number }>())!.n).toBe(0);
    expect((await owner.api.post(`/v1/proposals/${proposalId}/decision`, { decision: "reject" })).status).toBe(200);
    expect((await owner.api.json("GET", "/v1/proposals")).proposals).toEqual([]);
  });
});

describe("D11-1 at scale: every waiting question is counted, and only those", () => {
  it("counts all of many waiting runs and none of many answered ones, whatever the registry's stale copy says", async () => {
    const owner = await provisionOwner();
    const model = await enableFakeModel(owner);
    const app = await testApp();
    model.script({ toolCalls: [{ toolName: "ask_owner", input: { question: "Which blazer do you mean?", choices: [] } }] }, { text: "One moment." });
    const accepted = await owner.api.json("POST", "/v1/conversation/turns", { clientTurnId: `turn-${crypto.randomUUID()}`, text: "What goes with the blazer?" });
    for (let i = 0; i < 200 && (await recovery(owner)).pending.runsNeedingInput === 0; i++) await sleep(25);
    // TEST SETUP: 120 further turns and their registry rows, copied from the real waiting one. Sixty still
    // wait; sixty were answered (the assistant's record says completed) while the registry's copy was never
    // refreshed and still says they wait.
    const turn = (await app.db.prepare("SELECT * FROM assistant_turns WHERE user_id = ? AND turn_id = ?").bind(owner.userId, accepted.runId).first<Record<string, unknown>>())!;
    const run = (await app.db.prepare("SELECT * FROM api_runs WHERE user_id = ? AND run_id = ?").bind(owner.userId, accepted.runId).first<Record<string, unknown>>())!;
    const insert = (table: string, row: Record<string, unknown>) => app.db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`).bind(...Object.values(row));
    const statements = Array.from({ length: 120 }, (_, i) => [
      insert("assistant_turns", { ...turn, turn_id: `${turn.turn_id}-copy-${i}`, submission_id: `${turn.submission_id}-copy-${i}`, user_message_id: `${turn.user_message_id}-copy-${i}`, status: i < 60 ? "needs_input" : "completed" }),
      insert("api_runs", { ...run, run_id: `${run.run_id}-copy-${i}`, client_request_id: `${run.client_request_id}-copy-${i}`, state: "needs_input" }),
    ]).flat();
    for (let i = 0; i < statements.length; i += 50) await app.db.batch(statements.slice(i, i + 50));
    expect((await recovery(owner)).pending.runsNeedingInput).toBe(61);
  });
});

describe("the Gateway-logs lookup for uncertain inference reservations", () => {
  const call = { gatewayId: "garderobe-test", runId: "trn_fixture_run", attempt: 1, task: "conversation", reservedAt: "2026-10-03T10:00:00Z" };

  it("is not built unless the account, the read-only token and the gateway are all configured", () => {
    expect(gatewayUsageLookup({})).toBeNull();
    expect(gatewayUsageLookup({ AI_GATEWAY_ID: "garderobe-test", AI_GATEWAY_ACCOUNT_ID: "acct-fixture" })).toBeNull();
    expect(gatewayUsageLookup({ AI_GATEWAY_ID: "garderobe-test", AI_GATEWAY_LOGS_TOKEN: "token-fixture" })).toBeNull();
    expect(gatewayUsageLookup({ AI_GATEWAY_ACCOUNT_ID: "acct-fixture", AI_GATEWAY_LOGS_TOKEN: "token-fixture" })).toBeNull();
  });

  it("reads this deployment's own gateway with the configured account and token, and no other gateway (FAKE logs endpoint)", async () => {
    const requests: { url: string; authorization: string | null }[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), authorization: new Headers(init?.headers).get("Authorization") });
      const entry = { id: "log-fixture-1", success: true, cached: false, model: "fixture-model", tokens_in: 120, tokens_out: 30, metadata: JSON.stringify({ garderobe_run: call.runId, garderobe_attempt: 1 }) };
      return new Response(JSON.stringify({ success: true, result: [entry], result_info: { total_count: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const lookup = gatewayUsageLookup({ AI_GATEWAY_ID: "garderobe-test", AI_GATEWAY_ACCOUNT_ID: "acct-fixture", AI_GATEWAY_LOGS_TOKEN: "token-fixture" }, fakeFetch)!;
    expect(lookup).not.toBeNull();
    expect(await lookup.find(call)).toMatchObject({ status: "charged", inputTokens: 120, outputTokens: 30 });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toContain("/accounts/acct-fixture/ai-gateway/gateways/garderobe-test/logs");
    expect(requests[0]!.authorization).toBe("Bearer token-fixture");
    // A reservation that names another gateway is never looked up with this deployment's token.
    await expect(lookup.find({ ...call, gatewayId: "someone-elses-gateway" })).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });
});
