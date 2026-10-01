import { beforeAll, describe, expect, it } from "vitest";
import { RunEventData } from "@garderobe/contracts/ext/api";
import { createPrincipal } from "@garderobe/domain";
import { createDailyPort } from "../src/lanes/daily.ts";
import { sweepExpired } from "../src/maintenance.ts";
import { runRecommendation } from "../src/routes/daily.ts";
import { appendRunEvent, createApiRun, RUN_EVENT_RETENTION } from "../src/runs.ts";
import { connectMcp, enableFakeModel, provisionOwner, readSse, testApp, toolResult, type FakeModel, type TestOwner } from "../src/testing/index.ts";

/*
 * Long operations as durable runs, through the real Worker with the REAL owner fixture. Stand-ins:
 * test-signed Access assertions; the labelled FAKE MODEL for conversation and research replies; a
 * labelled test double at the composition-model boundary (there is no AI binding in a local run).
 */
let owner: TestOwner;
let stranger: TestOwner;
let model: FakeModel;

const ownerPrincipal = (target: TestOwner) => createPrincipal({ userId: target.userId, actor: "owner", channel: "ios", scopes: ["read", "write"], authRef: "test:owner-session" });
const settle = async (target: TestOwner, runId: string, states: string[], tries = 100): Promise<any> => {
  let run: any;
  for (let i = 0; i < tries; i++) {
    run = await target.api.json("GET", `/v1/runs/${runId}`);
    if (states.includes(run.state)) return run;
    await new Promise((r) => setTimeout(r, 50));
  }
  return run;
};

beforeAll(async () => {
  owner = await provisionOwner({ real: true });
  stranger = await provisionOwner();
  model = await enableFakeModel(owner);
});

describe("a recommendation that takes longer than its request", () => {
  it("answers with a run, finishes in the background, and the same request ID returns that result", async () => {
    const app = await testApp();
    const background: Promise<unknown>[] = [];
    const exec = { waitUntil: (p: Promise<unknown>) => void background.push(p), passThroughOnException: () => undefined } as unknown as ExecutionContext;
    const date = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const request = { clientRequestId: `slow-${crypto.randomUUID()}`, date, count: 2, lockedGarmentIds: [], occasionOnly: false, mode: "preview" as const };

    // An inline budget of zero stands for a composition that outlasts the request.
    const accepted = await runRecommendation(app, ownerPrincipal(owner), request, exec, 0);
    expect(accepted.state).toBe("running");
    expect(accepted.runId).toBeTruthy();
    expect(accepted.options).toEqual([]); // accepted work is never shown as a result
    expect(background).toHaveLength(1);
    expect((await stranger.api.get(`/v1/runs/${accepted.runId}`)).status).toBe(404);

    await Promise.all(background);
    const run = await owner.api.json("GET", `/v1/runs/${accepted.runId}`);
    expect(run).toMatchObject({ kind: "recommendation", state: "completed" });
    expect(run.result.options.length).toBeGreaterThan(0);
    const events = await readSse(await owner.api.get(`/v1/runs/${accepted.runId}/events?follow=false`));
    expect(events.map((e) => e.event)).toEqual(["run_started", "run_finished"]);

    // The same request ID over HTTP returns the stored result, not a second composition.
    const again = await owner.api.json("POST", "/v1/recommendations", request);
    expect(again).toMatchObject({ state: "completed", runId: accepted.runId, localDate: date });
    expect(again.options.map((o: any) => o.optionId)).toEqual(run.result.options.map((o: any) => o.optionId));
    // Every garment offered is a real garment of this owner.
    const mine = new Set((await owner.api.json("GET", "/v1/wardrobe")).items.map((i: any) => i.garment.garmentId));
    for (const option of again.options) for (const garment of option.garments) expect(mine.has(garment.garmentId)).toBe(true);
  });

  it("over MCP the tool returns the run handle and garderobe_run reads the result", async () => {
    const app = await testApp();
    const env = app.env;
    const before = env.RECOMMEND_INLINE_MS;
    env.RECOMMEND_INLINE_MS = "0"; // this deployment setting is the inline budget in milliseconds
    const mcp = await connectMcp(owner, { write: false });
    try {
      const date = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
      const started = toolResult(await mcp.client.callTool({ name: "garderobe_recommend", arguments: { date, count: 2, clientRequestId: `mcp-slow-${crypto.randomUUID()}` } }));
      expect(started.ok, JSON.stringify(started.error)).toBe(true);
      expect(started.data).toMatchObject({ state: "running", options: [] });
      await settle(owner, started.data.runId, ["completed", "failed"]);
      const followed = toolResult(await mcp.client.callTool({ name: "garderobe_run", arguments: { runId: started.data.runId } }));
      expect(followed.data.run).toMatchObject({ kind: "recommendation", state: "completed" });
      expect(followed.data.run.result.options.length).toBeGreaterThan(0);
    } finally {
      if (before === undefined) delete env.RECOMMEND_INLINE_MS;
      else env.RECOMMEND_INLINE_MS = before;
      await mcp.close();
    }
  });

  it("a run whose background work was lost is reported as failed, never left running", async () => {
    const app = await testApp();
    const longAgo = Date.now() - 3_600_000;
    const run = await createApiRun(app.db, { userId: owner.userId, kind: "recommendation", clientRequestId: `lost-${crypto.randomUUID()}`, request: { lost: true }, channel: "ios", nowMs: longAgo });
    expect((await owner.api.json("GET", `/v1/runs/${run.runId}`)).state).toBe("running");
    await sweepExpired(app, Date.now());
    const after = await owner.api.json("GET", `/v1/runs/${run.runId}`);
    expect(after.state).toBe("failed");
    expect(after.error.message).toContain("Ask again");
  });
});

describe("scheduled board preparation", () => {
  it("asks each owner's own composition model, with that owner's complete profile, and still publishes when the model offers nothing", async () => {
    const app = await testApp();
    const asked: { userId: string; context: string }[] = [];
    // TEST DOUBLE at the model boundary: records what it was asked and proposes nothing, which is what
    // the real model service returns on budget exhaustion or an outage.
    const port = createDailyPort(
      { env: app.env, db: app.db, registry: app.registry, service: app.service, now: app.now },
      {
        compositionModelFor: (principal) => ({
          profile: "TEST DOUBLE (no inference)",
          propose: async (request: { contextText: string }) => {
            asked.push({ userId: principal.userId, context: request.contextText });
            return [];
          },
        }) as never,
      },
    );
    const boardsBefore = (await app.db.prepare("SELECT COUNT(*) AS n FROM boards WHERE user_id = ?").bind(owner.userId).first<{ n: number }>())!.n;
    // Three instants eight hours apart cover every owner's evening preparation window once.
    const base = Date.now() + 6 * 86_400_000;
    for (const offset of [0, 8, 16]) {
      await port.scheduled(base + offset * 3_600_000);
      if (asked.some((a) => a.userId === owner.userId)) break;
    }
    const mine = asked.filter((a) => a.userId === owner.userId);
    expect(mine.length).toBeGreaterThan(0);
    const profile = (await owner.api.json("GET", "/v1/style")).document.content as string;
    expect(mine[0]!.context).toContain(profile.trim().slice(0, 400));
    expect(mine[0]!.context).toContain(profile.trim().slice(-400));
    // Another owner's preparation was never given this owner's profile.
    for (const other of asked.filter((a) => a.userId !== owner.userId)) expect(other.context).not.toContain(profile.trim().slice(0, 400));
    const boardsAfter = (await app.db.prepare("SELECT COUNT(*) AS n FROM boards WHERE user_id = ?").bind(owner.userId).first<{ n: number }>())!.n;
    expect(boardsAfter).toBeGreaterThan(boardsBefore);
  });
});

describe("the event stream after its retention window", () => {
  it("sends a snapshot of the run for a cursor that is too old, then no gap; a recent cursor gets exactly what it missed", async () => {
    const app = await testApp();
    const run = await createApiRun(app.db, { userId: owner.userId, kind: "recommendation", clientRequestId: `long-${crypto.randomUUID()}`, request: { long: true }, channel: "ios", nowMs: Date.now() });
    const extra = RUN_EVENT_RETENTION + 20;
    for (let i = 0; i < extra; i++) await appendRunEvent(app.db, owner.userId, run.runId, "activity", { text: `Step ${i + 1}` }, { activity: `Step ${i + 1}` }, Date.now());
    const last = extra + 1;

    const stale = await readSse(await owner.api.get(`/v1/runs/${run.runId}/events?after=2&follow=false`));
    expect(stale[0]!.event).toBe("snapshot");
    expect(stale[0]!.data.data).toMatchObject({ reason: "cursor_expired", run: { runId: run.runId, state: "running", lastEventId: last, activity: `Step ${extra}` } });
    expect(Number(stale[0]!.id)).toBe(last);
    expect(stale).toHaveLength(1); // the snapshot is the current state; nothing older is replayed out of order
    for (const e of stale) expect(RunEventData[e.event as keyof typeof RunEventData].safeParse(e.data.data).success, e.event).toBe(true);

    const recent = await readSse(await owner.api.get(`/v1/runs/${run.runId}/events?after=${last - 5}&follow=false`));
    expect(recent.map((e) => Number(e.id))).toEqual([last - 4, last - 3, last - 2, last - 1, last]);
    // The retained window is bounded.
    const kept = (await app.db.prepare("SELECT COUNT(*) AS n FROM api_run_events WHERE user_id = ? AND run_id = ?").bind(owner.userId, run.runId).first<{ n: number }>())!.n;
    expect(kept).toBeLessThanOrEqual(RUN_EVENT_RETENTION);
  }, 60_000);
});

describe("cancelling a turn that is still running", () => {
  it("stops the remaining work, keeps what was already committed, and the late model answer changes nothing", async () => {
    const wardrobe = await owner.api.json("GET", "/v1/wardrobe");
    const socks = wardrobe.items.find((i: any) => i.garment.roles.includes("socks") && i.balances.some((b: any) => b.bucket === "clean" && b.quantity > 0)).garment;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    model.script(
      // First the model records a change the owner asked for; then it stalls on its next step.
      { toolCalls: [{ toolName: "mark_dirty", input: { items: [{ garmentId: socks.garmentId, quantity: 1 }], ownerQuote: `the ${socks.name} are dirty` } }] },
      async () => {
        await held;
        return { text: "LATE ANSWER that must not be delivered." };
      },
    );
    const accepted = await owner.api.json("POST", "/v1/conversation/turns", { clientTurnId: `turn-${crypto.randomUUID()}`, text: `the ${socks.name} are dirty, and what should I wear with the navy blazer?` });
    await settle(owner, accepted.runId, ["running"]);
    // Wait until the first step's change is committed, so the cancel arrives mid-turn.
    let running: any;
    for (let i = 0; i < 100; i++) {
      running = await owner.api.json("GET", `/v1/runs/${accepted.runId}`);
      if (running.receipts.length > 0 || running.state !== "running") break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const cancelled = await owner.api.json("POST", `/v1/runs/${accepted.runId}/cancel`);
    release();
    expect(cancelled.run.state).toBe("cancelled");
    expect(cancelled.stopped.join(" ")).toContain("stopped");
    // What was committed before the cancel is reported and stays committed.
    expect(cancelled.committed.map((r: any) => r.commandId)).toEqual(running.receipts.map((r: any) => r.commandId));
    await new Promise((r) => setTimeout(r, 400));
    const after = await owner.api.json("GET", `/v1/runs/${accepted.runId}`);
    expect(after.state).toBe("cancelled");
    expect(JSON.stringify(await owner.api.json("GET", "/v1/conversation/messages"))).not.toContain("LATE ANSWER");
    for (const receipt of running.receipts) expect((await owner.api.get(`/v1/commands/${receipt.commandId}`)).status).toBe(200);
    const events = await readSse(await owner.api.get(`/v1/runs/${accepted.runId}/events?follow=false`));
    expect(events.at(-1)).toMatchObject({ event: "run_finished", data: { data: { state: "cancelled" } } });
    // Cancelling again is harmless.
    expect((await owner.api.json("POST", `/v1/runs/${accepted.runId}/cancel`)).run.state).toBe("cancelled");
  });
});

describe("garderobe_run over MCP", () => {
  it("answers the assistant's question and cancels a run, with the same durable state the app sees", async () => {
    const mcp = await connectMcp(owner, { write: true });
    // The assistant asks one question; the run waits for the answer without any open stream.
    model.script({ toolCalls: [{ toolName: "ask_owner", input: { question: "Which blazer do you mean?", choices: [{ id: "navy", label: "The navy one" }, { id: "grey", label: "The grey one" }] } }] }, { text: "One moment." });
    const asked = toolResult(await mcp.client.callTool({ name: "garderobe_ask", arguments: { message: "what goes with the blazer?", clientTurnId: `turn-${crypto.randomUUID()}`, mode: "wait" } }));
    expect(asked.ok, JSON.stringify(asked.error)).toBe(true);
    const waiting = toolResult(await mcp.client.callTool({ name: "garderobe_run", arguments: { runId: asked.data.runId } }));
    expect(waiting.data.run.state).toBe("needs_input");
    expect(waiting.data.run.pendingInput.question).toBe("Which blazer do you mean?");
    const read = async (runId: string) => toolResult(await mcp.client.callTool({ name: "garderobe_run", arguments: { runId } })).data.run;
    // The app sees the same pending question on the same run.
    expect((await owner.api.json("GET", `/v1/runs/${asked.data.runId}`)).pendingInput.inputId).toBe(waiting.data.run.pendingInput.inputId);

    model.script({ text: "With the navy blazer, the grey flannels." });
    const answered = toolResult(await mcp.client.callTool({ name: "garderobe_run", arguments: { runId: asked.data.runId, action: "respond", inputId: waiting.data.run.pendingInput.inputId, choiceId: "navy" } }));
    expect(answered.ok, JSON.stringify(answered.error)).toBe(true);
    let settled = answered.data.run;
    for (let i = 0; i < 100 && !["completed", "failed"].includes(settled.state); i++) {
      await new Promise((r) => setTimeout(r, 50));
      settled = await read(answered.data.run.runId);
    }
    expect(settled.state).toBe("completed");
    expect(settled.result.reply.text ?? settled.result.reply).toContain("navy blazer");
    // The run the answer continued as can be followed from the app as well.
    expect((await owner.api.json("GET", `/v1/runs/${answered.data.run.runId}`)).state).toBe("completed");
    // An answer to a question that is no longer open is refused, not applied twice.
    const again = toolResult(await mcp.client.callTool({ name: "garderobe_run", arguments: { runId: asked.data.runId, action: "respond", inputId: waiting.data.run.pendingInput.inputId, choiceId: "grey" } }));
    expect(again.ok).toBe(false);

    // Cancel: a second question is left open, then the connected assistant stops the run.
    model.script({ toolCalls: [{ toolName: "ask_owner", input: { question: "Which trousers?", choices: [] } }] }, { text: "One moment." });
    const second = toolResult(await mcp.client.callTool({ name: "garderobe_ask", arguments: { message: "and the trousers?", clientTurnId: `turn-${crypto.randomUUID()}`, mode: "wait" } }));
    const cancelled = toolResult(await mcp.client.callTool({ name: "garderobe_run", arguments: { runId: second.data.runId, action: "cancel" } }));
    expect(cancelled.ok, JSON.stringify(cancelled.error)).toBe(true);
    expect(cancelled.data.run.state).toBe("cancelled");
    expect((await read(second.data.runId)).state).toBe("cancelled");
    // Another owner's connection cannot read, answer or cancel it.
    const other = await connectMcp(stranger, { write: true });
    for (const action of ["status", "cancel", "resume"]) expect(toolResult(await other.client.callTool({ name: "garderobe_run", arguments: { runId: second.data.runId, action } })).ok).toBe(false);
    await other.close();
    await mcp.close();
  });
});

describe("research through the MCP tool", () => {
  it("starts a durable investigation and returns its sources, verdict and comparison from the records it wrote", async () => {
    model.script(
      { toolCalls: [{ toolName: "save_shopping_candidate", input: { productId: "prd_fixture_crewneck", name: "Fixture crewneck (synthetic product)", maker: "Fixture Knitwear", url: "https://shop.example.com/fixture-crewneck" } }] },
      { toolCalls: [{ toolName: "record_product_observation", input: { productId: "prd_fixture_crewneck", observedAt: "2026-09-15T08:05:00Z", checkedUrl: "https://shop.example.com/fixture-crewneck", availability: "unknown", method: "tavily_basic", completeness: "partial", missingFields: ["size availability"] } }] },
      { text: "The page is live but I could not confirm your size. Availability is unknown." },
    );
    // Saving research records is bookkeeping a write connection may do; a read-only one gets prose only.
    const mcp = await connectMcp(owner, { write: true });
    const garmentsBefore = (await owner.api.json("GET", "/v1/wardrobe")).total;
    const request = { topic: "Is the fixture crewneck still available in my size?", kind: "product", url: "https://shop.example.com/fixture-crewneck", clientRequestId: `research-${crypto.randomUUID()}` };
    const started = toolResult(await mcp.client.callTool({ name: "garderobe_research", arguments: request }));
    expect(started.ok, JSON.stringify(started.error)).toBe(true);
    expect(started.data.runId).toBeTruthy();

    const run = await settle(owner, started.data.runId, ["completed", "failed"], 200);
    expect(run).toMatchObject({ kind: "research", state: "completed" });
    const followed = toolResult(await mcp.client.callTool({ name: "garderobe_run", arguments: { runId: started.data.runId } }));
    const research = followed.data.run.result.research;
    expect(research.summary).toContain("Availability is unknown");
    expect(research.verdict).toBeNull(); // no verdict was established, and none is invented
    expect(research.comparison[0]).toMatchObject({ productId: "prd_fixture_crewneck", availability: "unknown" });
    expect(research.sources[0]).toMatchObject({ url: "https://shop.example.com/fixture-crewneck", checkedAt: "2026-09-15T08:05:00Z" });

    // Asking again with the same request ID returns the same run with its result, not a second investigation.
    const again = toolResult(await mcp.client.callTool({ name: "garderobe_research", arguments: request }));
    expect(again.data.runId).toBe(started.data.runId);
    expect(again.data.result.summary).toBe(research.summary);
    // Researching a product did not put a garment in the wardrobe.
    expect((await owner.api.json("GET", "/v1/wardrobe")).total).toBe(garmentsBefore);
    expect((await stranger.api.get(`/v1/runs/${started.data.runId}`)).status).toBe(404);
    await mcp.close();
  });
});
