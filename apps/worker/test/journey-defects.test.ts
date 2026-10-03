import { beforeAll, describe, expect, it } from "vitest";
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
    await app.daily!.scheduled(Date.now());
    expect(await boardsOf()).toBe(1);
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
});
