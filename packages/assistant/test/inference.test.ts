import { beforeAll, describe, expect, it } from "vitest";
import { all, isCommandError } from "@garderobe/domain";
import { ALLOWED_GATEWAY_IDS, GatewayConfigError, assertGatewayId, classifyError, createCompositionModel, createGatewayModel, gatewayMetadata, getInferenceOverview, ModelService, parseCandidates, profileSpec, PROFILE_SPECS, BREAKER_THRESHOLD } from "../src/index.ts";
import { FakeModel, TEST_GATEWAY_ID, fakeModelFor } from "../src/testing/index.ts";
import { createWorld, passProbes, submission, type World } from "./helpers.ts";

const reservations = (w: World) => all<{ state: string; task: string; profile_id: string; budget_class: string; reserved_microusd: number; actual_microusd: number; attempt: number; parent_kind: string; gateway_id: string; error_class: string | null }>(w.h.db, "SELECT state, task, profile_id, budget_class, reserved_microusd, actual_microusd, attempt, parent_kind, gateway_id, error_class FROM inference_reservations WHERE user_id = ? ORDER BY rowid", w.owner.userId);

describe("configurable inference (real model service, real D1 ledger; FAKE MODELS at the model boundary only)", () => {
  it("no profile is selectable until its capability and Unified Billing probes passed; the turn is kept as resumable", async () => {
    const w = await createWorld({ real: false, probes: [] });
    const overview = await getInferenceOverview(w.h.db, w.owner.principal(), { gatewayId: TEST_GATEWAY_ID });
    expect(overview.profiles.every((p) => !p.selectable)).toBe(true);
    expect(overview.profiles.find((p) => p.profileId === "gpt-extra")!.unavailableReason).toContain("does not resolve to a verified API model name");
    const turn = await w.client.runTurn({ submissionId: submission(), text: "what should I wear?" });
    expect(turn.status).toBe("resumable");
    expect(turn.failure).toMatchObject({ code: "no_selectable_profile", resumable: true });
    expect(turn.failure!.message).toContain("has not been probed");
    expect(fakeModelFor("deepseek-v41-flash").requests).toHaveLength(0);
    expect(await reservations(w)).toHaveLength(0);
    // The owner's message is kept, not dropped.
    expect((await w.client.transcript({})).messages.map((m) => m.text)).toContain("what should I wear?");

    // A text-only probe is not proof of tool support: conversation needs both.
    await passProbes(w.h, w.owner, "deepseek-v41-flash", ["text"]);
    const again = await w.client.runTurn({ submissionId: submission(), text: "and now?" });
    expect(again.failure!.message).toContain("tools capability has not been probed");

    // A route that is not eligible for Unified Billing stays unavailable with its precise reason.
    await w.owner.exec("inference.record_probe", { profileId: "fable-5-1", operation: "text", result: "passed", billing: "ineligible", reason: "TEST FIXTURE", gatewayId: TEST_GATEWAY_ID }, { actor: "system", channel: "system", scopes: ["read", "write", "admin"], authorization: "system_schedule" });
    const after = await getInferenceOverview(w.h.db, w.owner.principal(), { gatewayId: TEST_GATEWAY_ID });
    expect(after.profiles.find((p) => p.profileId === "fable-5-1")!.unavailableReason).toContain("no direct-provider or BYOK fallback");

    // After the probes pass, the kept turn resumes and completes.
    await passProbes(w.h, w.owner, "deepseek-v41-flash");
    w.model.script({ text: "Grey flannels and the navy 990s." });
    const resumed = await w.client.resumeTurn(again.turnId);
    expect(resumed!.status).toBe("completed");
    expect(resumed!.reply?.text).toBe("Grey flannels and the navy 990s.");
  });

  describe("reservations, budgets and fallback", () => {
    let w: World;
    beforeAll(async () => {
      w = await createWorld({ real: false, probes: ["deepseek-v41-flash", "fable-5-1"] });
    });

    it("reserves before dispatch and settles against reported usage under the task's budget class", async () => {
      w.model.script({ text: "hello", usage: { inputTokens: 1000, outputTokens: 200 } });
      const turn = await w.client.runTurn({ submissionId: submission(), text: "good morning" });
      expect(turn.modelProfile).toBe("deepseek-v41-flash");
      const rows = await reservations(w);
      expect(rows).toHaveLength(1);
      const spec = profileSpec("deepseek-v41-flash")!;
      expect(rows[0]).toMatchObject({ state: "settled", task: "conversation", budget_class: "interactive", profile_id: "deepseek-v41-flash", parent_kind: "turn", gateway_id: TEST_GATEWAY_ID });
      expect(rows[0]!.actual_microusd).toBe(Math.ceil((1000 * spec.price.inputMicroUsdPerMTok + 200 * spec.price.outputMicroUsdPerMTok) / 1_000_000));
      expect(rows[0]!.reserved_microusd).toBeGreaterThan(rows[0]!.actual_microusd);
      // The reservation and settlement are commands in the ledger.
      const cmds = await all<{ type: string }>(w.h.db, "SELECT type FROM commands WHERE user_id = ? AND type IN ('inference.reserve', 'inference.settle') ORDER BY rowid", w.owner.userId);
      expect(cmds.map((c) => c.type)).toEqual(["inference.reserve", "inference.settle"]);
    });

    it("falls back to the next verified profile on a transport failure, and records every attempt", async () => {
      const before = (await reservations(w)).length;
      w.model.script({ error: Object.assign(new Error("fetch failed: connection reset"), { statusCode: 503 }) }, { error: Object.assign(new Error("fetch failed again"), { statusCode: 503 }) });
      fakeModelFor("fable-5-1").script({ text: "answer from the fallback" });
      const turn = await w.client.runTurn({ submissionId: submission(), text: "is the tweed too heavy for today?" });
      expect(turn.status).toBe("completed");
      expect(turn.reply?.text).toBe("answer from the fallback");
      expect(turn.modelProfile).toBe("fable-5-1");
      const rows = (await reservations(w)).slice(before);
      expect(rows.map((r) => [r.profile_id, r.state, r.attempt])).toEqual([
        ["deepseek-v41-flash", "uncertain", 1],
        ["deepseek-v41-flash", "uncertain", 2],
        ["fable-5-1", "settled", 3],
      ]);
      // The fallback model received the same complete context.
      expect(fakeModelFor("fable-5-1").requests.at(-1)!.system).toContain("===== WARDROBE");
    });

    it("does not fall back because an answer is unwelcome, and does not retry a request the provider rejected", async () => {
      w.model.script({ text: "No: the 990v6 stays out while the restriction is active." });
      fakeModelFor("fable-5-1").script({ text: "SHOULD NOT BE USED" });
      const turn = await w.client.runTurn({ submissionId: submission(), text: "let me wear the 990v6 anyway" });
      expect(turn.reply?.text).toContain("stays out");
      expect(fakeModelFor("fable-5-1").remaining).toBe(1);
      expect(classifyError(Object.assign(new Error("bad request"), { statusCode: 400 }))).toBe("provider_rejected");
      expect(classifyError(new Error("fetch failed"))).toBe("transport");
      expect(classifyError(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe("timeout");
      fakeModelFor("fable-5-1").reset();
    });

    it("opens the circuit breaker after repeated provider failures and skips that profile", async () => {
      const failing = () => ({ error: Object.assign(new Error("upstream unavailable"), { statusCode: 502 }) });
      w.model.script(failing, failing, failing, failing);
      fakeModelFor("fable-5-1").otherwise({ text: "fallback" });
      for (let i = 0; i < 2; i++) await w.client.runTurn({ submissionId: submission(), text: `question ${i}` });
      const breaker = await all<{ state: string; failures: number }>(w.h.db, "SELECT state, failures FROM model_breakers WHERE gateway_id = ? AND profile_id = 'deepseek-v41-flash'", TEST_GATEWAY_ID);
      expect(breaker[0]!.state).toBe("open");
      expect(breaker[0]!.failures).toBeGreaterThanOrEqual(BREAKER_THRESHOLD);
      const calls = w.model.requests.length;
      const turn = await w.client.runTurn({ submissionId: submission(), text: "one more" });
      expect(turn.modelProfile).toBe("fable-5-1");
      expect(w.model.requests.length).toBe(calls); // the unhealthy provider was not called again
      const overview = await getInferenceOverview(w.h.db, w.owner.principal(), { gatewayId: TEST_GATEWAY_ID });
      expect(overview.breakers.find((b) => b.profileId === "deepseek-v41-flash")!.state).toBe("open");
    });

    it("an exhausted budget stops the turn as resumable without any unbudgeted model call, and leaves the board budget untouched", async () => {
      await w.owner.exec("settings.update", { patch: { extensions: { assistant: { budgets: { interactive: 1 } } } } });
      const fable = fakeModelFor("fable-5-1");
      const calls = fable.requests.length + w.model.requests.length;
      const turn = await w.client.runTurn({ submissionId: submission(), text: "another question" });
      expect(turn.status).toBe("resumable");
      expect(turn.failure).toMatchObject({ code: "budget_exceeded", resumable: true });
      expect(fable.requests.length + w.model.requests.length).toBe(calls);
      const overview = await getInferenceOverview(w.h.db, w.owner.principal(), { gatewayId: TEST_GATEWAY_ID, nowMs: w.h.clock.now() });
      expect(overview.budgets.find((b) => b.budgetClass === "interactive")!.dailyLimitMicroUsd).toBe(1);
      expect(overview.budgets.find((b) => b.budgetClass === "daily_board")!.reservedMicroUsd).toBe(0);
      // The composition model for the daily service uses its own reserved budget and still works.
      const service = new ModelService({ db: w.h.db, service: w.h.service, gatewayId: TEST_GATEWAY_ID, clock: w.h.clock.now, createLanguageModel: (spec) => fakeModelFor(spec.profileId) });
      await w.owner.exec("inference.record_probe", { profileId: "fable-5-1", operation: "structured_output", result: "passed", billing: "unified_billing", reason: "TEST FIXTURE", gatewayId: TEST_GATEWAY_ID }, { actor: "system", channel: "system", scopes: ["read", "write", "admin"], authorization: "system_schedule" });
      fable.script({ text: '{"candidates":[{"slots":[{"role":"top","garmentId":"gmt_a"}],"principle":"quiet"},{"slots":"broken"}]}' });
      const composer = createCompositionModel(service, { userId: w.owner.userId });
      const candidates = await composer.propose({ localDate: "2026-09-16", count: 3, contextText: "FULL CONTEXT" });
      expect(candidates).toEqual([{ slots: [{ role: "top", garmentId: "gmt_a" }], footwearAlternatives: [], principle: "quiet", claims: [], suitsEventIds: [] }]);
      expect(composer.profile).toBe("fable-5-1");
      expect((await reservations(w)).at(-1)).toMatchObject({ budget_class: "daily_board", task: "outfit_composition", state: "settled" });
      // With the board budget exhausted the composer returns nothing (the deterministic composer takes over).
      await w.owner.exec("settings.update", { patch: { extensions: { assistant: { budgets: { daily_board: 0 } } } } });
      expect(await composer.propose({ localDate: "2026-09-16", count: 3, contextText: "FULL CONTEXT" })).toEqual([]);
    });

    it("only a probed profile can be chosen for a task, and the morning profile needs its evaluation gate", async () => {
      const routing = (payload: Record<string, unknown>) => w.owner.exec("inference.set_routing", { gatewayId: TEST_GATEWAY_ID, ...payload });
      const bad = await routing({ task: "conversation", profileId: "gpt-6-astra" }).catch((e) => e);
      expect(isCommandError(bad) && bad.code).toBe("precondition_failed");
      const gate = await routing({ task: "outfit_composition", profileId: "fable-5-1" }).catch((e) => e);
      expect(isCommandError(gate) && gate.message).toContain("evaluation");
      const ok = await routing({ task: "conversation", profileId: "fable-5-1", fallbacks: ["deepseek-v41-flash"] });
      expect(ok.summary).toContain("Fable 5.1");
      const overview = await getInferenceOverview(w.h.db, w.owner.principal(), { gatewayId: TEST_GATEWAY_ID });
      expect(overview.routing.find((r) => r.task === "conversation")).toMatchObject({ profileId: "fable-5-1", fallbacks: ["deepseek-v41-flash"] });
    });
  });
});

describe("AI Gateway adapter (configuration checks; the AI binding below is a FAKE that records the call, no Gateway is contacted)", () => {
  it("always names an allowed gateway and never the implicit default", () => {
    expect(assertGatewayId("garderobe-dev")).toBe("garderobe-dev");
    expect(ALLOWED_GATEWAY_IDS).toEqual(["garderobe-dev", "garderobe-prod"]);
    expect(() => assertGatewayId(undefined)).toThrow(GatewayConfigError);
    expect(() => assertGatewayId("default")).toThrow(/never used/);
    expect(() => assertGatewayId("someone-elses-gateway")).toThrow(/not one of this application's gateways/);
  });

  it("refuses profiles without a verified route and requests without a binding", () => {
    const meta = { runId: "run_1", task: "conversation", attempt: 1, environment: "dev" };
    expect(() => createGatewayModel({}, "garderobe-dev", profileSpec("deepseek-v41-flash")!, meta)).toThrow(/binding/);
    expect(() => createGatewayModel({ AI: {} as Ai }, "garderobe-dev", profileSpec("kimi")!, meta)).toThrow(/no verified Gateway route/);
    expect(() => createGatewayModel({ AI: {} as Ai }, "default", profileSpec("deepseek-v41-flash")!, meta)).toThrow(/never used/);
  });

  it("attaches only non-sensitive run metadata and no profile is enabled by declaration alone", () => {
    expect(gatewayMetadata({ runId: "run_1", task: "conversation", attempt: 2, environment: "dev" })).toEqual({ garderobe_run: "run_1", garderobe_task: "conversation", garderobe_attempt: 2, garderobe_env: "dev" });
    for (const p of PROFILE_SPECS) expect(p.price.observedOn).toBeNull();
    expect(PROFILE_SPECS.filter((p) => p.pendingReason).map((p) => p.profileId).sort()).toEqual(["glm", "gpt-extra", "image-edit", "kimi", "search-embedding"]);
  });

  it("dispatches a catalog model on the Unified Billing run path with the named gateway and no provider credential", async () => {
    const runCalls: unknown[][] = [];
    let gatewayPathCalls = 0;
    // FAKE AI binding (test double): records what the adapter sends and fails, so nothing is inferred.
    const fakeBinding = {
      run: async (...args: unknown[]) => {
        runCalls.push(args);
        throw new Error("FAKE AI binding: no inference in tests");
      },
      gateway: () => {
        gatewayPathCalls++;
        return { run: async () => { throw new Error("FAKE AI binding: no inference in tests"); } };
      },
    } as unknown as Ai;
    const model: any = createGatewayModel({ AI: fakeBinding }, "garderobe-dev", profileSpec("deepseek-v41-flash")!, { runId: "run_9", task: "conversation", attempt: 1, environment: "dev" });
    await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }).catch(() => undefined);
    // The BYOK/stored-key gateway path is never taken.
    expect(gatewayPathCalls).toBe(0);
    expect(runCalls).toHaveLength(1);
    const sent = JSON.stringify(runCalls[0]);
    expect(sent).toContain("deepseek/deepseek-flash");
    expect(sent).toContain("garderobe-dev");
    expect(sent).toContain("garderobe_run");
    expect(sent.toLowerCase()).not.toContain("authorization");
    expect(sent.toLowerCase()).not.toContain("api-key");
    expect(sent.toLowerCase()).not.toContain("byok");
  });

  it("parses composition output defensively", () => {
    expect(parseCandidates("not json")).toEqual([]);
    expect(parseCandidates('{"candidates":[{"slots":[]}]}')).toEqual([]);
    expect(parseCandidates('prefix {"candidates":[{"slots":[{"role":"top","garmentId":"g1"}]}]} suffix')).toHaveLength(1);
    expect(new FakeModel().provider).toBe("garderobe-fake");
  });
});
