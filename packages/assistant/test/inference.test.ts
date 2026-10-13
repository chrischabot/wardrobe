import { beforeAll, describe, expect, it } from "vitest";
import { all, isCommandError } from "@garderobe/domain";
import { ALLOWED_GATEWAY_IDS, GatewayConfigError, assertGatewayId, classifyError, createCompositionModel, createGatewayModel, gatewayMetadata, getInferenceOverview, ModelService, parseCandidates, profileSpec, PROFILE_SPECS, TASK_SPECS, ENFORCED_MODEL_ROUTE, PRIMARY_PROFILE_ID, FALLBACK_PROFILE_ID, BREAKER_THRESHOLD } from "../src/index.ts";
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
    expect(fakeModelFor("odango-eap").requests).toHaveLength(0);
    expect(await reservations(w)).toHaveLength(0);
    // The owner's message is kept, not dropped.
    expect((await w.client.transcript({})).messages.map((m) => m.text)).toContain("what should I wear?");

    // A text-only probe is not proof of tool support: conversation needs both.
    await passProbes(w.h, w.owner, "odango-eap", ["text"]);
    const again = await w.client.runTurn({ submissionId: submission(), text: "and now?" });
    expect(again.failure!.message).toContain("tools capability has not been probed");

    // A route that is not eligible for Unified Billing stays unavailable with its precise reason.
    await w.owner.exec("inference.record_probe", { profileId: "odango-eap-fallback", operation: "text", result: "passed", billing: "ineligible", reason: "TEST FIXTURE", gatewayId: TEST_GATEWAY_ID }, { actor: "system", channel: "system", scopes: ["read", "write", "admin"], authorization: "system_schedule" });
    const after = await getInferenceOverview(w.h.db, w.owner.principal(), { gatewayId: TEST_GATEWAY_ID });
    expect(after.profiles.find((p) => p.profileId === "odango-eap-fallback")!.unavailableReason).toContain("no direct-provider or BYOK fallback");

    // After the probes pass, the kept turn resumes and completes.
    await passProbes(w.h, w.owner, "odango-eap");
    w.model.script({ text: "Grey flannels and the navy 990s." });
    const resumed = await w.client.resumeTurn(again.turnId);
    expect(resumed!.status).toBe("completed");
    expect(resumed!.reply?.text).toBe("Grey flannels and the navy 990s.");
  });

  describe("reservations, budgets and fallback", () => {
    let w: World;
    beforeAll(async () => {
      w = await createWorld({ real: false, probes: ["odango-eap", "odango-eap-fallback"] });
    });

    it("reserves before dispatch and settles against reported usage under the task's budget class", async () => {
      w.model.script({ text: "hello", usage: { inputTokens: 1000, outputTokens: 200 } });
      const turn = await w.client.runTurn({ submissionId: submission(), text: "good morning" });
      expect(turn.modelProfile).toBe("odango-eap");
      const rows = await reservations(w);
      expect(rows).toHaveLength(1);
      const spec = profileSpec("odango-eap")!;
      expect(rows[0]).toMatchObject({ state: "settled", task: "conversation", budget_class: "interactive", profile_id: "odango-eap", parent_kind: "turn", gateway_id: TEST_GATEWAY_ID });
      expect(rows[0]!.actual_microusd).toBe(Math.ceil((1000 * spec.price.inputMicroUsdPerMTok + 200 * spec.price.outputMicroUsdPerMTok) / 1_000_000));
      expect(rows[0]!.reserved_microusd).toBeGreaterThan(rows[0]!.actual_microusd);
      // The reservation and settlement are commands in the ledger.
      const cmds = await all<{ type: string }>(w.h.db, "SELECT type FROM commands WHERE user_id = ? AND type IN ('inference.reserve', 'inference.settle') ORDER BY rowid", w.owner.userId);
      expect(cmds.map((c) => c.type)).toEqual(["inference.reserve", "inference.settle"]);
    });

    it("falls back to the next verified profile on a transport failure, and records every attempt", async () => {
      const before = (await reservations(w)).length;
      w.model.script({ error: Object.assign(new Error("fetch failed: connection reset"), { statusCode: 503 }) }, { error: Object.assign(new Error("fetch failed again"), { statusCode: 503 }) });
      fakeModelFor("odango-eap-fallback").script({ text: "answer from the fallback" });
      const turn = await w.client.runTurn({ submissionId: submission(), text: "is the tweed too heavy for today?" });
      expect(turn.status).toBe("completed");
      expect(turn.reply?.text).toBe("answer from the fallback");
      expect(turn.modelProfile).toBe("odango-eap-fallback");
      const rows = (await reservations(w)).slice(before);
      expect(rows.map((r) => [r.profile_id, r.state, r.attempt])).toEqual([
        ["odango-eap", "uncertain", 1],
        ["odango-eap", "uncertain", 2],
        ["odango-eap-fallback", "settled", 3],
      ]);
      // The fallback model received the same complete context.
      expect(fakeModelFor("odango-eap-fallback").requests.at(-1)!.system).toContain("===== WARDROBE");
    });

    it("does not fall back because an answer is unwelcome, and does not retry a request the provider rejected", async () => {
      w.model.script({ text: "No: the 990v6 stays out while the restriction is active." });
      fakeModelFor("odango-eap-fallback").script({ text: "SHOULD NOT BE USED" });
      const turn = await w.client.runTurn({ submissionId: submission(), text: "let me wear the 990v6 anyway" });
      expect(turn.reply?.text).toContain("stays out");
      expect(fakeModelFor("odango-eap-fallback").remaining).toBe(1);
      expect(classifyError(Object.assign(new Error("bad request"), { statusCode: 400 }))).toBe("provider_rejected");
      expect(classifyError(new Error("fetch failed"))).toBe("transport");
      expect(classifyError(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe("timeout");
      fakeModelFor("odango-eap-fallback").reset();
    });

    it("opens the circuit breaker after repeated provider failures and skips that profile", async () => {
      const failing = () => ({ error: Object.assign(new Error("upstream unavailable"), { statusCode: 502 }) });
      w.model.script(failing, failing, failing, failing);
      fakeModelFor("odango-eap-fallback").otherwise({ text: "fallback" });
      for (let i = 0; i < 2; i++) await w.client.runTurn({ submissionId: submission(), text: `question ${i}` });
      const breaker = await all<{ state: string; failures: number }>(w.h.db, "SELECT state, failures FROM model_breakers WHERE gateway_id = ? AND profile_id = 'odango-eap'", TEST_GATEWAY_ID);
      expect(breaker[0]!.state).toBe("open");
      expect(breaker[0]!.failures).toBeGreaterThanOrEqual(BREAKER_THRESHOLD);
      const calls = w.model.requests.length;
      const turn = await w.client.runTurn({ submissionId: submission(), text: "one more" });
      expect(turn.modelProfile).toBe("odango-eap-fallback");
      expect(w.model.requests.length).toBe(calls); // the unhealthy provider was not called again
      const overview = await getInferenceOverview(w.h.db, w.owner.principal(), { gatewayId: TEST_GATEWAY_ID });
      expect(overview.breakers.find((b) => b.profileId === "odango-eap")!.state).toBe("open");
    });

    it("an exhausted budget stops the turn as resumable without any unbudgeted model call, and leaves the board budget untouched", async () => {
      await w.owner.exec("settings.update", { patch: { extensions: { assistant: { budgets: { interactive: 1 } } } } });
      const fallback = fakeModelFor("odango-eap-fallback");
      const calls = fallback.requests.length + w.model.requests.length;
      const turn = await w.client.runTurn({ submissionId: submission(), text: "another question" });
      expect(turn.status).toBe("resumable");
      expect(turn.failure).toMatchObject({ code: "budget_exceeded", resumable: true });
      expect(fallback.requests.length + w.model.requests.length).toBe(calls);
      const overview = await getInferenceOverview(w.h.db, w.owner.principal(), { gatewayId: TEST_GATEWAY_ID, nowMs: w.h.clock.now() });
      expect(overview.budgets.find((b) => b.budgetClass === "interactive")!.dailyLimitMicroUsd).toBe(1);
      expect(overview.budgets.find((b) => b.budgetClass === "daily_board")!.reservedMicroUsd).toBe(0);
      // The composition model for the daily service uses its own reserved budget and still works.
      const service = new ModelService({ db: w.h.db, service: w.h.service, gatewayId: TEST_GATEWAY_ID, clock: w.h.clock.now, createLanguageModel: (spec) => fakeModelFor(spec.profileId) });
      await w.owner.exec("inference.record_probe", { profileId: "odango-eap-fallback", operation: "structured_output", result: "passed", billing: "unified_billing", reason: "TEST FIXTURE", gatewayId: TEST_GATEWAY_ID }, { actor: "system", channel: "system", scopes: ["read", "write", "admin"], authorization: "system_schedule" });
      fallback.script({ text: '{"candidates":[{"slots":[{"role":"top","garmentId":"gmt_a"}],"principle":"quiet"},{"slots":"broken"}]}' });
      const composer = createCompositionModel(service, { userId: w.owner.userId });
      const candidates = await composer.propose({ localDate: "2026-09-16", count: 3, contextText: "FULL CONTEXT" });
      expect(candidates).toEqual([{ slots: [{ role: "top", garmentId: "gmt_a" }], footwearAlternatives: [], principle: "quiet", claims: [], suitsEventIds: [] }]);
      expect(composer.profile).toBe("odango-eap-fallback");
      expect((await reservations(w)).at(-1)).toMatchObject({ budget_class: "daily_board", task: "outfit_composition", state: "settled" });
      // With the board budget exhausted the composer returns nothing (the deterministic composer takes over).
      await w.owner.exec("settings.update", { patch: { extensions: { assistant: { budgets: { daily_board: 0 } } } } });
      expect(await composer.propose({ localDate: "2026-09-16", count: 3, contextText: "FULL CONTEXT" })).toEqual([]);
    });

    it("a stored routing row that names only retired profiles is stale: the task's own candidates serve it", async () => {
      // A row persisted before the registry dropped these profiles (written directly: the command now refuses them).
      await w.h.db.prepare("INSERT OR REPLACE INTO inference_routing (user_id, task, version, profile_id, fallbacks_json, evaluation_ref, command_id, updated_at) VALUES (?, 'historical_research', 1, 'fable-5-1', '[\"deepseek-v41-flash\",\"gpt-6-astra\"]', NULL, 'cmd_stale_fixture', '2026-09-01T00:00:00.000Z')").bind(w.owner.userId).run();
      const service = new ModelService({ db: w.h.db, service: w.h.service, gatewayId: TEST_GATEWAY_ID, clock: w.h.clock.now, createLanguageModel: (spec) => fakeModelFor(spec.profileId) });
      const { chain } = await service.profileChain(w.owner.userId, "historical_research");
      expect(chain.length).toBeGreaterThan(0);
      expect(chain.every((p) => p.profileId.startsWith("odango-eap"))).toBe(true);
      await w.h.db.prepare("DELETE FROM inference_routing WHERE user_id = ? AND task = 'historical_research' AND command_id = 'cmd_stale_fixture'").bind(w.owner.userId).run();
    });

    it("only a probed profile can be chosen for a task, and the morning profile needs its evaluation gate", async () => {
      const routing = (payload: Record<string, unknown>) => w.owner.exec("inference.set_routing", { gatewayId: TEST_GATEWAY_ID, ...payload });
      const bad = await routing({ task: "conversation", profileId: "kimi" }).catch((e) => e);
      expect(isCommandError(bad) && bad.code).toBe("precondition_failed");
      // Profiles that were removed from the registry (including every Fable model) cannot be chosen at all.
      for (const removed of ["fable-5-1", "deepseek-v41-flash", "gpt-6-astra"]) {
        const gone = await routing({ task: "conversation", profileId: removed }).catch((e) => e);
        expect(isCommandError(gone) && gone.code).toBe("invalid_command");
      }
      const gate = await routing({ task: "outfit_composition", profileId: "odango-eap-fallback" }).catch((e) => e);
      expect(isCommandError(gate) && gate.message).toContain("evaluation");
      const ok = await routing({ task: "conversation", profileId: "odango-eap-fallback", fallbacks: ["odango-eap"] });
      expect(ok.summary).toContain("Claude Odango EAP (fallback");
      const overview = await getInferenceOverview(w.h.db, w.owner.principal(), { gatewayId: TEST_GATEWAY_ID });
      expect(overview.routing.find((r) => r.task === "conversation")).toMatchObject({ profileId: "odango-eap-fallback", fallbacks: ["odango-eap"] });
    });
  });
});

describe("model service failure handling (real D1 ledger; SCRIPTED TEST-DOUBLE MODELS at the model boundary only)", () => {
  type Script = { generate?: (o: any) => Promise<any>; stream?: (o: any) => Promise<any> };
  const stub = (id: string, s: Script) => ({
    specificationVersion: "v4",
    provider: "test-double",
    modelId: `test-double-${id}`,
    supportedUrls: {},
    doGenerate: (o: any) => (s.generate ? s.generate(o) : Promise.reject(new Error(`no generate script for ${id}`))),
    doStream: (o: any) => (s.stream ? s.stream(o) : Promise.reject(new Error(`no stream script for ${id}`))),
  }) as any;
  const textResult = (text: string, usage: any = { inputTokens: { total: 10 }, outputTokens: { total: 2 } }) => ({ content: [{ type: "text", text }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] });
  const streamOf = (parts: any[]) => ({ stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) });
  const usage = { inputTokens: { total: 10 }, outputTokens: { total: 2 } };
  // Probes and breakers are kept per gateway and this file shares one D1, so each test uses a gateway of its own.
  const worldWith = async (profiles: string[]) => {
    const w = await createWorld({ real: false, probes: [] });
    const gatewayId = `test-gateway-${crypto.randomUUID().slice(0, 8)}`;
    for (const profileId of profiles) {
      for (const operation of ["text", "tools", "structured_output", "vision"]) {
        await w.owner.exec("inference.record_probe", { profileId, operation, result: "passed", billing: "unified_billing", reason: "TEST FIXTURE", gatewayId }, { actor: "system", channel: "system", scopes: ["read", "write", "admin"], authorization: "system_schedule" });
      }
    }
    return { w, gatewayId };
  };
  const serviceFor = (w: World, gatewayId: string, models: Record<string, Script>) => new ModelService({ db: w.h.db, service: w.h.service, gatewayId, clock: w.h.clock.now, createLanguageModel: (spec) => stub(spec.profileId, models[spec.profileId] ?? {}) });
  const scope = (w: World, task: "conversation" | "extraction" = "conversation") => ({ userId: w.owner.userId, task, parent: { kind: "job" as const, id: `job_${crypto.randomUUID().slice(0, 8)}` } });

  it("a stream that fails before any answer part (after framing parts only) falls back to the next profile; the failed attempt stays uncertain", async () => {
    const { w, gatewayId } = await worldWith([PRIMARY_PROFILE_ID, FALLBACK_PROFILE_ID]);
    const before = (await reservations(w)).length;
    const failures: unknown[] = [];
    const service = serviceFor(w, gatewayId, {
      // Framing parts a provider sends before any content, then the failure: no answer had begun.
      [PRIMARY_PROFILE_ID]: { stream: async () => streamOf([{ type: "stream-start", warnings: [] }, { type: "response-metadata", modelId: "x" }, { type: "reasoning-start", id: "r" }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "" }, { type: "error", error: Object.assign(new Error("upstream unavailable"), { statusCode: 503 }) }]) },
      [FALLBACK_PROFILE_ID]: { stream: async () => streamOf([{ type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "from the fallback" }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }]) },
    });
    const model: any = service.modelFor({ ...scope(w), onFailure: (e) => failures.push(e) });
    const { stream } = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
    const parts: any[] = [];
    const reader = stream.getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) parts.push(r.value);
    expect(parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("")).toBe("from the fallback");
    expect(failures).toEqual([]);
    expect((await reservations(w)).slice(before).map((r) => [r.profile_id, r.state])).toEqual([[PRIMARY_PROFILE_ID, "uncertain"], [PRIMARY_PROFILE_ID, "uncertain"], [FALLBACK_PROFILE_ID, "settled"]]);
  });

  it("a stream the reader cancels, or that fails after the answer began, is settled once as unknown and reported", async () => {
    const { w, gatewayId } = await worldWith([PRIMARY_PROFILE_ID]);
    const before = (await reservations(w)).length;
    const failures: unknown[] = [];
    const service = serviceFor(w, gatewayId, {
      [PRIMARY_PROFILE_ID]: {
        stream: async () => ({
          stream: new ReadableStream({
            start(c) { c.enqueue({ type: "text-start", id: "t" }); c.enqueue({ type: "text-delta", id: "t", delta: "partial" }); },
            pull(c) { c.error(new Error("fetch failed: connection reset")); },
          }),
        }),
      },
    });
    const broken: any = service.modelFor({ ...scope(w), onFailure: (e) => failures.push(e) });
    const reader = (await broken.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })).stream.getReader();
    await expect((async () => { for (let r = await reader.read(); !r.done; r = await reader.read()); })()).rejects.toThrow(/connection reset/);
    expect(failures).toHaveLength(1);
    // The answer had begun: no second profile, no retry.
    expect((await reservations(w)).slice(before).map((r) => r.state)).toEqual(["uncertain"]);

    const cancelled: any = serviceFor(w, gatewayId, { [PRIMARY_PROFILE_ID]: { stream: async () => ({ stream: new ReadableStream({ start(c) { c.enqueue({ type: "text-start", id: "t" }); c.enqueue({ type: "text-delta", id: "t", delta: "partial" }); } }) }) } }).modelFor(scope(w));
    await (await cancelled.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })).stream.cancel("reader went away");
    expect((await reservations(w)).slice(before).map((r) => r.state)).toEqual(["uncertain", "uncertain"]);
  });

  it("a stream that ends before any answer is an upstream failure and falls back, never an empty success", async () => {
    const { w, gatewayId } = await worldWith([PRIMARY_PROFILE_ID, FALLBACK_PROFILE_ID]);
    const before = (await reservations(w)).length;
    const service = serviceFor(w, gatewayId, {
      [PRIMARY_PROFILE_ID]: { stream: async () => streamOf([{ type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }]) },
      [FALLBACK_PROFILE_ID]: { stream: async () => streamOf([{ type: "text-delta", id: "t", delta: "answer" }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }]) },
    });
    const { stream } = await (service.modelFor(scope(w)) as any).doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
    const parts: any[] = [];
    const reader = stream.getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) parts.push(r.value);
    expect(parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("")).toBe("answer");
    expect((await reservations(w)).slice(before).map((r) => [r.profile_id, r.state, r.error_class])).toEqual([[PRIMARY_PROFILE_ID, "uncertain", "transport"], [PRIMARY_PROFILE_ID, "uncertain", "transport"], [FALLBACK_PROFILE_ID, "settled", null]]);
  });

  it("a read rejected after the caller aborted mid-stream is recorded as the caller's abort", async () => {
    const { w, gatewayId } = await worldWith([PRIMARY_PROFILE_ID]);
    const before = (await reservations(w)).length;
    const caller = new AbortController();
    const service = serviceFor(w, gatewayId, {
      [PRIMARY_PROFILE_ID]: { stream: async () => ({ stream: new ReadableStream({ start(c) { c.enqueue({ type: "text-delta", id: "t", delta: "partial" }); }, pull(c) { caller.abort(); c.error(new DOMException("aborted", "AbortError")); } }) }) },
    });
    const reader = (await (service.modelFor(scope(w)) as any).doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }], abortSignal: caller.signal })).stream.getReader();
    await expect((async () => { for (let r = await reader.read(); !r.done; r = await reader.read()); })()).rejects.toThrow();
    expect((await reservations(w)).slice(before).map((r) => [r.state, r.error_class])).toEqual([["uncertain", "aborted"]]);
  });

  it("an answer without usage figures keeps its charge uncertain instead of settling it as zero", async () => {
    const { w, gatewayId } = await worldWith([PRIMARY_PROFILE_ID]);
    const before = (await reservations(w)).length;
    const service = serviceFor(w, gatewayId, { [PRIMARY_PROFILE_ID]: { generate: async () => textResult("ok", { inputTokens: { total: 50 }, outputTokens: {} }) } });
    const out = await service.generateText(scope(w), { system: "s", prompt: "p" });
    expect(out.text).toBe("ok");
    expect((await reservations(w)).slice(before)).toMatchObject([{ state: "uncertain", error_class: "usage_missing", actual_microusd: 0 }]);
  });

  it("a structured-output repair goes back to the profile that gave the invalid answer, never to another one", async () => {
    const { w, gatewayId } = await worldWith([PRIMARY_PROFILE_ID, FALLBACK_PROFILE_ID]);
    let primaryCalls = 0;
    const fallbackAnswers = ["not json", '{"ok":true}'];
    const service = serviceFor(w, gatewayId, {
      [PRIMARY_PROFILE_ID]: { generate: async () => { primaryCalls++; throw Object.assign(new Error("upstream unavailable"), { statusCode: 503 }); } },
      [FALLBACK_PROFILE_ID]: { generate: async () => textResult(fallbackAnswers.shift()!) },
    });
    const schema = { safeParse: (v: any) => (v && v.ok === true ? { success: true as const, data: v } : { success: false as const, error: { message: "ok must be true" } }) };
    const out = await service.generateStructured(scope(w, "extraction"), { system: "s", prompt: "p", schema, schemaVersion: "test/1" });
    expect(out).toMatchObject({ value: { ok: true }, repaired: true, run: { profileId: FALLBACK_PROFILE_ID } });
    // Two primary attempts for the first answer (one retry); the repair did not return to the failing primary.
    expect(primaryCalls).toBe(2);
  });

  it("a transport failure or opened breaker during the repair sets that profile aside and the next verified profile answers", async () => {
    const { w, gatewayId } = await worldWith([PRIMARY_PROFILE_ID, FALLBACK_PROFILE_ID]);
    let primaryCalls = 0;
    const service = serviceFor(w, gatewayId, {
      [PRIMARY_PROFILE_ID]: { generate: async () => { primaryCalls++; if (primaryCalls === 1) return textResult("not json"); throw Object.assign(new Error("upstream unavailable"), { statusCode: 503 }); } },
      [FALLBACK_PROFILE_ID]: { generate: async () => textResult('{"ok":true}') },
    });
    const schema = { safeParse: (v: any) => (v && v.ok === true ? { success: true as const, data: v } : { success: false as const, error: { message: "ok must be true" } }) };
    const out = await service.generateStructured(scope(w, "extraction"), { system: "s", prompt: "p", schema, schemaVersion: "test/1" });
    expect(out).toMatchObject({ value: { ok: true }, repaired: false, run: { profileId: FALLBACK_PROFILE_ID } });
    expect(primaryCalls).toBeGreaterThanOrEqual(2);

    // If another run opens the primary's breaker before the repair dispatches (NoSelectableProfileError on onlyProfile), the fallback still answers.
    const secondWorld = await worldWith([PRIMARY_PROFILE_ID, FALLBACK_PROFILE_ID]);
    let breakerOpenedCalls = 0;
    const breakerService = serviceFor(secondWorld.w, secondWorld.gatewayId, {
      [PRIMARY_PROFILE_ID]: {
        generate: async () => {
          breakerOpenedCalls++;
          await secondWorld.w.h.db
            .prepare("INSERT OR REPLACE INTO model_breakers (gateway_id, profile_id, failures, state, opened_at, updated_at) VALUES (?, ?, 3, 'open', ?, ?)")
            .bind(secondWorld.gatewayId, PRIMARY_PROFILE_ID, new Date(secondWorld.w.h.clock.now()).toISOString(), new Date(secondWorld.w.h.clock.now()).toISOString())
            .run();
          return textResult("not json");
        },
      },
      [FALLBACK_PROFILE_ID]: { generate: async () => textResult('{"ok":true}') },
    });
    const out2 = await breakerService.generateStructured(scope(secondWorld.w, "extraction"), { system: "s", prompt: "p", schema, schemaVersion: "test/1" });
    expect(out2).toMatchObject({ value: { ok: true }, repaired: false, run: { profileId: FALLBACK_PROFILE_ID } });
    expect(breakerOpenedCalls).toBe(1);
  });

  it("a caller hook that throws before dispatch releases the reservation and calls no model", async () => {
    const { w, gatewayId } = await worldWith([PRIMARY_PROFILE_ID, FALLBACK_PROFILE_ID]);
    let calls = 0;
    const service = serviceFor(w, gatewayId, {
      [PRIMARY_PROFILE_ID]: { generate: async () => { calls++; return textResult('{"ok":true}'); } },
      [FALLBACK_PROFILE_ID]: { generate: async () => { calls++; return textResult('{"ok":true}'); } },
    });
    const schema = { safeParse: (v: any) => ({ success: true as const, data: v }) };
    const before = (await reservations(w)).length;
    await expect(service.generateStructured({ ...scope(w, "extraction"), onAttempt: () => { throw new Error("hook failed"); } }, { system: "s", prompt: "p", schema, schemaVersion: "test/1" })).rejects.toThrow("hook failed");
    expect(calls).toBe(0);
    const rows = (await reservations(w)).slice(before);
    expect(rows.map((r) => r.state)).toEqual(["released"]);
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
    expect(() => createGatewayModel({}, "garderobe-dev", profileSpec("odango-eap")!, meta)).toThrow(/binding/);
    expect(() => createGatewayModel({ AI: {} as Ai }, "garderobe-dev", profileSpec("kimi")!, meta)).toThrow(/no verified Gateway route/);
    expect(() => createGatewayModel({ AI: {} as Ai }, "default", profileSpec("odango-eap")!, meta)).toThrow(/never used/);
  });

  it("routes every role and every fallback to the single enforced model, and lists no Fable model", () => {
    expect(ENFORCED_MODEL_ROUTE).toBe("anthropic/claude-odango-eap");
    const routed = PROFILE_SPECS.filter((p) => p.gatewayRoute !== null);
    expect(routed.map((p) => p.profileId).sort()).toEqual([FALLBACK_PROFILE_ID, PRIMARY_PROFILE_ID].sort());
    for (const p of routed) expect([p.gatewayRoute, p.apiModelId]).toEqual([ENFORCED_MODEL_ROUTE, "claude-odango-eap"]);
    expect(JSON.stringify(PROFILE_SPECS).toLowerCase()).not.toMatch(/fable|deepseek|astra/);
    for (const task of Object.values(TASK_SPECS)) {
      expect(task.candidates.length).toBeGreaterThan(0);
      for (const id of task.candidates) {
        const spec = profileSpec(id)!;
        expect(spec).toBeDefined();
        expect(spec.gatewayRoute).toBe(ENFORCED_MODEL_ROUTE);
      }
    }
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
    const model: any = createGatewayModel({ AI: fakeBinding }, "garderobe-dev", profileSpec("odango-eap")!, { runId: "run_9", task: "conversation", attempt: 1, environment: "dev" });
    await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }).catch(() => undefined);
    // The BYOK/stored-key gateway path is never taken.
    expect(gatewayPathCalls).toBe(0);
    expect(runCalls).toHaveLength(1);
    const sent = JSON.stringify(runCalls[0]);
    expect(sent).toContain("anthropic/claude-odango-eap");
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
