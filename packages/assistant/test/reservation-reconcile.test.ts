/**
 * Reconciling model-call reservations whose outcome is not known (specification sections 8 and 12).
 *
 * Real model service, real D1 ledger and command service, the real conversation Durable Object. Stand-ins,
 * each labelled: the FAKE MODEL at the model boundary (scripted to fail in transit, so the charge is
 * unknown), a FAKE PROVIDER RECORD for the reconciliation rules, and a FAKE `fetch` answering in the shape
 * of Cloudflare's "List Gateway Logs" API for the adapter. No AI Gateway is contacted.
 */
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { all } from "@garderobe/domain";
import { ABANDONED_AFTER_MS, LOOKUP_NOT_BEFORE_MS, createGatewayLogsLookup, getInferenceOverview, profileSpec, reconcileInferenceReservations, refusedUpstream, runAssistantMaintenance, type DispatchedCall, type ProviderUsageFinding } from "../src/index.ts";
import { TEST_GATEWAY_ID } from "../src/testing/index.ts";
import { START, createWorld, setNow, submission, type World } from "./helpers.ts";

interface Row {
  reservation_id: string;
  run_id: string;
  attempt: number;
  state: string;
  reserved_microusd: number;
  actual_microusd: number;
  input_tokens: number | null;
  output_tokens: number | null;
  error_class: string | null;
  settled_at: string | null;
}
const rows = (w: World) => all<Row>(w.h.db, "SELECT reservation_id, run_id, attempt, state, reserved_microusd, actual_microusd, input_tokens, output_tokens, error_class, settled_at FROM inference_reservations WHERE user_id = ? ORDER BY rowid", w.owner.userId);
const at = (minutes: number) => new Date(Date.parse(START) + minutes * 60_000).toISOString();
const SYSTEM = { actor: "system" as const, channel: "system" as const, scopes: ["read", "write"] as ("read" | "write")[], authorization: "system_schedule" as const };

/** A turn whose only model call fails in transit on every attempt: each attempt's charge is unknown. */
async function failedTurn(w: World): Promise<void> {
  const transit = () => ({ error: Object.assign(new Error("fetch failed: connection reset"), { statusCode: 503 }) });
  w.model.script(transit(), transit());
  await w.client.runTurn({ submissionId: submission("uncertain"), text: "good morning" });
}

/** FAKE PROVIDER RECORD: answers per attempt number, and remembers what it was asked. */
function fakeRecord(byAttempt: Record<number, ProviderUsageFinding | Error>) {
  const asked: DispatchedCall[] = [];
  return {
    asked,
    find: async (call: DispatchedCall): Promise<ProviderUsageFinding> => {
      asked.push(call);
      const answer = byAttempt[call.attempt] ?? { status: "not_found" as const };
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

describe("uncertain model-call reservations are closed only on the provider's record", () => {
  let w: World;
  const sweep = (usageLookup: ReturnType<typeof fakeRecord> | null, nowMs = w.h.clock.now()) => reconcileInferenceReservations({ db: w.h.db, service: w.h.service, nowMs, usageLookup });
  const interactive = async () => (await getInferenceOverview(w.h.db, w.owner.principal(), { gatewayId: TEST_GATEWAY_ID, nowMs: w.h.clock.now() })).budgets.find((b) => b.budgetClass === "interactive")!;

  beforeAll(async () => {
    w = await createWorld({ real: false });
    await failedTurn(w);
  });

  it("with no record to consult, or none found, or a record that cannot be read, a reservation stays uncertain and keeps counting against the budget", async () => {
    const before = await rows(w);
    expect(before.map((r) => [r.state, r.attempt])).toEqual([["uncertain", 1], ["uncertain", 2]]);
    const held = before.reduce((n, r) => n + r.reserved_microusd, 0);
    expect((await interactive()).uncertainMicroUsd).toBe(held);

    // Too soon after the call: the provider's record may not exist yet, so it is not consulted.
    const early = fakeRecord({});
    expect(await sweep(early)).toEqual({ markedUncertain: 0, settled: 0, released: 0, stillUncertain: 0, lookupFailures: 0, notLookedUp: 0 });
    expect(early.asked).toEqual([]);

    setNow(w, at(LOOKUP_NOT_BEFORE_MS / 60_000 + 1));
    expect(await sweep(null)).toMatchObject({ settled: 0, released: 0, stillUncertain: 2 });
    const unreadable = fakeRecord({ 1: new Error("the Gateway logs request answered 503") });
    expect(await sweep(unreadable)).toMatchObject({ settled: 0, released: 0, stillUncertain: 1, lookupFailures: 1 });
    // The record is asked for exactly the call that was dispatched.
    expect(unreadable.asked.map((c) => [c.gatewayId, c.runId, c.attempt]).sort()).toEqual(before.map((r) => [TEST_GATEWAY_ID, r.run_id, r.attempt]).sort());
    expect(await rows(w)).toEqual(before);
    expect((await interactive()).uncertainMicroUsd).toBe(held);
  });

  it("a record of usage settles the reservation at the cost of that usage; a record of no charge releases it; both are ledger commands naming the record", async () => {
    const [first, second] = await rows(w);
    const record = fakeRecord({
      1: { status: "charged", inputTokens: 1200, outputTokens: 80, resolvedModel: "deepseek-chat (FAKE RECORD)", ref: "gateway-log:log-attempt-1" },
      2: { status: "not_charged", ref: "gateway-log:log-attempt-2" },
    });
    expect(await sweep(record)).toEqual({ markedUncertain: 0, settled: 1, released: 1, stillUncertain: 0, lookupFailures: 0, notLookedUp: 0 });
    const after = await rows(w);
    const price = profileSpec("deepseek-v41-flash")!.price;
    const cost = Math.ceil((1200 * price.inputMicroUsdPerMTok + 80 * price.outputMicroUsdPerMTok) / 1_000_000);
    expect(cost).toBeGreaterThan(0);
    expect(after[0]).toMatchObject({ reservation_id: first!.reservation_id, state: "settled", actual_microusd: cost, input_tokens: 1200, output_tokens: 80, error_class: "transport" });
    expect(after[1]).toMatchObject({ reservation_id: second!.reservation_id, state: "released", actual_microusd: 0 });
    expect(after.every((r) => r.settled_at !== null)).toBe(true);
    // The budget now counts what was used, not what was held.
    expect(await interactive()).toMatchObject({ uncertainMicroUsd: 0, settledMicroUsd: cost });
    const commands = await all<{ parent_id: string; summary: string }>(w.h.db, "SELECT json_extract(source_json, '$.parentId') AS parent_id, json_extract(receipt_json, '$.summary') AS summary FROM commands WHERE user_id = ? AND type = 'inference.settle' AND idempotency_key LIKE 'inference-reconcile:%' ORDER BY rowid", w.owner.userId);
    expect(commands.map((c) => c.parent_id).sort()).toEqual(["provider-record:gateway-log:log-attempt-1", "provider-record:gateway-log:log-attempt-2"]);
    expect(commands.every((c) => c.summary.startsWith("Reconciled from the provider's record: "))).toBe(true);

    // A second sweep finds nothing open and changes nothing.
    const again = fakeRecord({});
    expect(await sweep(again)).toEqual({ markedUncertain: 0, settled: 0, released: 0, stillUncertain: 0, lookupFailures: 0, notLookedUp: 0 });
    expect(again.asked).toEqual([]);
    expect(await rows(w)).toEqual(after);
  });

  it("a reservation left open by a call that can no longer be running is recorded as uncertain by the scheduled sweep, not released", async () => {
    const abandoned = async (id: string) => {
      await w.owner.exec("inference.reserve", { reservationId: id, runId: `run_${id}`, task: "conversation", budgetClass: "interactive", profileId: "deepseek-v41-flash", attempt: 1, reservedMicroUsd: 700, budgetDay: "2026-09-15", dailyLimitMicroUsd: 10_000_000, parent: { kind: "turn", id: "turn_evicted" }, gatewayId: TEST_GATEWAY_ID }, SYSTEM);
    };
    await abandoned("rsv_evicted_actor");
    setNow(w, at(60));
    await abandoned("rsv_still_running");
    setNow(w, at(60 + ABANDONED_AFTER_MS / 60_000 - 1));
    // Through the Worker's scheduled entry point, with no provider record configured.
    const swept = await runAssistantMaintenance({ db: w.h.db, service: w.h.service, env: env as never, gatewayId: TEST_GATEWAY_ID, nowMs: w.h.clock.now() });
    expect(swept.reservations).toEqual({ markedUncertain: 1, settled: 0, released: 0, stillUncertain: 1, lookupFailures: 0, notLookedUp: 0 });
    const open = (await rows(w)).filter((r) => r.reservation_id === "rsv_evicted_actor" || r.reservation_id === "rsv_still_running");
    expect(open.map((r) => [r.reservation_id, r.state, r.error_class, r.settled_at])).toEqual([
      ["rsv_evicted_actor", "uncertain", "abandoned", null],
      ["rsv_still_running", "reserved", null, null],
    ]);
    // Its 700 is still held against the day's budget.
    expect((await interactive()).uncertainMicroUsd).toBe(700);
  });
});

describe("third review, pull request 25: the sweep reaches every reservation and counts only what it closed (FAKE PROVIDER RECORD)", () => {
  let w: World;
  const reserve = (id: string, attempt = 1) =>
    w.owner.exec("inference.reserve", { reservationId: id, runId: `run_${id}`, task: "conversation", budgetClass: "interactive", profileId: "deepseek-v41-flash", attempt, reservedMicroUsd: 10, budgetDay: "2026-09-15", dailyLimitMicroUsd: 10_000_000, parent: { kind: "turn", id: `turn_${id}` }, gatewayId: TEST_GATEWAY_ID }, SYSTEM);
  const states = async () => Object.fromEntries((await rows(w)).map((r) => [r.reservation_id, r.state]));

  beforeAll(async () => {
    w = await createWorld({ real: false });
  });

  it("reservations older than the newest 25 are looked up too: every uncertain reservation is taken up within a bounded number of sweeps, whatever period the sweeps run on", async () => {
    // 60 abandoned calls, one a minute. The oldest three were not charged; the rest have no record.
    for (let n = 0; n < 60; n++) {
      setNow(w, at(n));
      await reserve(`rsv_${String(n).padStart(2, "0")}`);
    }
    setNow(w, at(60 + ABANDONED_AFTER_MS / 60_000 + 5));
    const asked = new Set<string>();
    const record = {
      find: async (call: DispatchedCall): Promise<ProviderUsageFinding> => {
        if (/^run_rsv_\d\d$/.test(call.runId)) asked.add(call.runId);
        return ["run_rsv_00", "run_rsv_01", "run_rsv_02"].includes(call.runId) ? { status: "not_charged", ref: `gateway-log:${call.runId}` } : { status: "not_found" };
      },
    };
    const first = await reconcileInferenceReservations({ db: w.h.db, service: w.h.service, nowMs: w.h.clock.now(), usageLookup: record });
    // Every abandoned call is marked, not just 25 of them.
    // (One local database serves this whole file, so another describe's open reservation may be swept too.)
    expect(first.markedUncertain).toBeGreaterThanOrEqual(60);
    expect((await rows(w)).filter((r) => r.state === "reserved")).toEqual([]);
    expect(first.notLookedUp).toBeGreaterThanOrEqual(35);
    expect(asked.size).toBeLessThanOrEqual(25);
    // Later sweeps take up the ones never looked up first, then those looked up longest ago. 57 are left
    // (25 a sweep): exactly two more sweeps reach every one, with no chance involved. They run every
    // THREE minutes, a period on which a start derived from the clock picked the same slice every time.
    let released = first.released;
    for (let sweep = 1; sweep <= 2; sweep++) {
      const r = await reconcileInferenceReservations({ db: w.h.db, service: w.h.service, nowMs: w.h.clock.now() + sweep * 3 * 60_000, usageLookup: record });
      released += r.released;
    }
    expect(asked.size).toBe(60);
    expect(released).toBe(3);
    const after = await states();
    expect([after["rsv_00"], after["rsv_01"], after["rsv_02"], after["rsv_03"], after["rsv_59"]]).toEqual(["released", "released", "released", "uncertain", "uncertain"]);
  });

  it("'released' and 'settled' count only reservations the sweep itself closed", async () => {
    const fresh = await createWorld({ real: false });
    w = fresh;
    await reserve("rsv_a");
    await reserve("rsv_b");
    setNow(w, at(ABANDONED_AFTER_MS / 60_000 + 5));
    // While the lookup for the first is in flight, both close some other way (the call's own late settlement).
    const record = {
      find: async (call: DispatchedCall): Promise<ProviderUsageFinding> => {
        for (const id of ["rsv_a", "rsv_b"]) await w.owner.exec("inference.settle", { reservationId: id, outcome: "settled", actualMicroUsd: 5, inputTokens: 10, outputTokens: 1, resolvedModel: "deepseek-chat (TEST)", errorClass: null }, { ...SYSTEM });
        if (call.runId === "run_rsv_a") return { status: "not_charged", ref: "gateway-log:a" };
        return call.runId === "run_rsv_b" ? { status: "charged", inputTokens: 999, outputTokens: 9, resolvedModel: null, ref: "gateway-log:b" } : { status: "not_found" };
      },
    };
    const r = await reconcileInferenceReservations({ db: w.h.db, service: w.h.service, nowMs: w.h.clock.now(), usageLookup: record }, { limit: 500 });
    expect(r).toMatchObject({ markedUncertain: 2, released: 0, settled: 0 });
    expect((await rows(w)).map((x) => [x.reservation_id, x.state, x.actual_microusd])).toEqual([["rsv_a", "settled", 5], ["rsv_b", "settled", 5]]);
  });

  it("usage known only as a lower bound closes the reservation at no less than what was held for the call, instead of leaving it uncertain for good", async () => {
    w = await createWorld({ real: false });
    await reserve("rsv_bound");
    await reserve("rsv_exact");
    setNow(w, at(ABANDONED_AFTER_MS / 60_000 + 5));
    const record = {
      find: async (call: DispatchedCall): Promise<ProviderUsageFinding> =>
        call.runId === "run_rsv_bound" ? { status: "charged", inputTokens: 1, outputTokens: 1, resolvedModel: null, ref: "gateway-log:bound", atLeast: true } : call.runId === "run_rsv_exact" ? { status: "charged", inputTokens: 1, outputTokens: 1, resolvedModel: null, ref: "gateway-log:exact" } : { status: "not_found" },
    };
    await reconcileInferenceReservations({ db: w.h.db, service: w.h.service, nowMs: w.h.clock.now(), usageLookup: record }, { limit: 500 });
    const after = Object.fromEntries((await rows(w)).map((x) => [x.reservation_id, x]));
    // Each was reserved at 10. The exact one costs what two tokens cost; the lower bound is not settled below 10.
    expect(after["rsv_exact"]).toMatchObject({ state: "settled" });
    expect(after["rsv_exact"]!.actual_microusd).toBeLessThan(10);
    expect(after["rsv_bound"]).toMatchObject({ state: "settled", actual_microusd: 10 });
  });
});

describe("the AI Gateway logs adapter (FAKE fetch in the documented shape of 'List Gateway Logs'; no Gateway contacted)", () => {
  const call: DispatchedCall = { gatewayId: TEST_GATEWAY_ID, runId: "run_abc123", attempt: 2, task: "conversation", reservedAt: START };
  const entry = (over: Record<string, unknown>) => ({ id: "log-1", cached: false, created_at: START, duration: 900, model: "deepseek-chat", path: "chat/completions", provider: "deepseek", success: true, tokens_in: 1500, tokens_out: 60, status_code: 200, metadata: JSON.stringify({ garderobe_run: "run_abc123", garderobe_task: "conversation", garderobe_attempt: 2, garderobe_env: "dev" }), ...over });
  const lookupWith = (respond: (url: URL, init: RequestInit) => Response) => {
    const requests: { url: URL; init: RequestInit }[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ url, init: init ?? {} });
      return respond(url, init ?? {});
    }) as typeof fetch;
    return { requests, lookup: createGatewayLogsLookup({ accountId: "acct-test", apiToken: "TEST-TOKEN-not-a-real-credential", fetch: fakeFetch, allowedGatewayIds: [TEST_GATEWAY_ID] }) };
  };
  const list = (result: unknown[]) => Response.json({ success: true, result, result_info: { count: result.length } });

  it("asks the named gateway's logs for the run, and counts only entries whose metadata names this run and this attempt", async () => {
    const { requests, lookup } = lookupWith(() =>
      list([
        entry({ id: "log-retry-a", tokens_in: 1500, tokens_out: 60 }),
        entry({ id: "log-retry-b", tokens_in: 1500, tokens_out: 40 }),
        entry({ id: "log-other-attempt", metadata: JSON.stringify({ garderobe_run: "run_abc123", garderobe_attempt: 1 }), tokens_in: 9999, tokens_out: 9999 }),
        entry({ id: "log-other-run", metadata: JSON.stringify({ garderobe_run: "run_abc1234", garderobe_attempt: 2 }), tokens_in: 9999, tokens_out: 9999 }),
        entry({ id: "log-unreadable-metadata", metadata: "run_abc123 attempt 2", tokens_in: 9999, tokens_out: 9999 }),
      ]),
    );
    expect(await lookup.find(call)).toEqual({ status: "charged", inputTokens: 3000, outputTokens: 100, resolvedModel: "deepseek-chat", ref: "gateway-log:log-retry-a,log-retry-b" });
    expect(requests).toHaveLength(1);
    const { url, init } = requests[0]!;
    expect(`${url.origin}${url.pathname}`).toBe(`https://api.cloudflare.com/client/v4/accounts/acct-test/ai-gateway/gateways/${TEST_GATEWAY_ID}/logs`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ search: "run_abc123", page: "1", per_page: "50", order_by: "created_at", order_by_direction: "asc" });
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer TEST-TOKEN-not-a-real-credential");
  });

  it("a call is 'not charged' only on explicit evidence: an answer served from cache, or a failed call with both token counts exactly 0 that the provider REFUSED; no matching entry is 'not found'", async () => {
    const failed = (status_code: unknown) => lookupWith(() => list([entry({ id: "log-failed", success: false, status_code, tokens_in: 0, tokens_out: 0 })])).lookup.find(call);
    for (const refusal of [400, 401, 403, 404, 413, 422, 429]) expect(await failed(refusal), String(refusal)).toEqual({ status: "not_charged", ref: "gateway-log:log-failed" });
    // Change review, 2026-10-03: a timeout, a dropped stream, a stop by the owner or a server-side failure is
    // logged as a failure with no tokens too, and the provider may have billed what it had processed. None of
    // these releases the reservation; neither does a status that is missing or not a number.
    for (const unknown of [408, 499, 500, 502, 503, 504, 524, 529, 200, 302, undefined, null, "429", 429.5]) expect(await failed(unknown), String(unknown)).toEqual({ status: "not_found" });
    expect([429, 499, 502, "429"].map(refusedUpstream)).toEqual([true, false, false, false]);
    // One such entry among the call's entries leaves the whole call uncertain, whatever the others say.
    expect(await lookupWith(() => list([entry({ id: "log-refused", success: false, status_code: 429, tokens_in: 0, tokens_out: 0 }), entry({ id: "log-dropped", success: false, status_code: 499, tokens_in: 0, tokens_out: 0 })])).lookup.find(call)).toEqual({ status: "not_found" });
    // A dropped stream beside a charged retry: the usage is known as a lower bound, and the call can be closed.
    expect(await lookupWith(() => list([entry({ id: "log-dropped", success: false, status_code: 502, tokens_in: 0, tokens_out: 0 }), entry({ id: "log-paid" })])).lookup.find(call)).toEqual({ status: "charged", inputTokens: 1500, outputTokens: 60, resolvedModel: "deepseek-chat", ref: "gateway-log:log-dropped,log-paid", atLeast: true });
    expect(await lookupWith(() => list([entry({ id: "log-cached", cached: true })])).lookup.find(call)).toEqual({ status: "not_charged", ref: "gateway-log:log-cached" });
    expect(await lookupWith(() => list([])).lookup.find(call)).toEqual({ status: "not_found" });
    expect(await lookupWith(() => list([entry({ metadata: undefined })])).lookup.find(call)).toEqual({ status: "not_found" });
  });

  it("third review: token fields that are absent, null, text, fractional or negative are never read as 'no charge', and neither is a successful call with no tokens", async () => {
    const failed = { success: false, status_code: 429 };
    const unreadable: Record<string, unknown>[] = [
      { ...failed, tokens_in: undefined, tokens_out: undefined },
      { ...failed, tokens_in: null, tokens_out: null },
      { ...failed, tokens_in: "1500", tokens_out: "60" },
      { ...failed, tokens_in: 0, tokens_out: null },
      { ...failed, tokens_in: 0.5, tokens_out: 0 },
      { ...failed, tokens_in: -1, tokens_out: 0 },
      { success: true, tokens_in: 0, tokens_out: 0 },
      { success: "false", tokens_in: 0, tokens_out: 0 },
      { success: false, cached: "false", tokens_in: 0, tokens_out: 0 },
    ];
    for (const over of unreadable) expect(await lookupWith(() => list([entry({ id: "log-x", ...over })])).lookup.find(call), JSON.stringify(over)).toEqual({ status: "not_found" });
    // One unreadable entry among the call's entries spoils the finding, whatever the others say.
    expect(await lookupWith(() => list([entry({ id: "log-ok", ...failed, tokens_in: 0, tokens_out: 0 }), entry({ id: "log-bad", ...failed, tokens_in: null, tokens_out: 0 })])).lookup.find(call)).toEqual({ status: "not_found" });
    // A charged entry beside a failed one is charged.
    expect(await lookupWith(() => list([entry({ id: "log-failed", ...failed, tokens_in: 0, tokens_out: 0 }), entry({ id: "log-paid" })])).lookup.find(call)).toMatchObject({ status: "charged", inputTokens: 1500, outputTokens: 60 });
  });

  it("third review: the attempt must be exactly this attempt; a loose match (empty, null, true, a list, a padded string) is not this call", async () => {
    const first: DispatchedCall = { ...call, attempt: 1 };
    const zero: DispatchedCall = { ...call, attempt: 0 };
    const meta = (attempt: unknown) => entry({ metadata: JSON.stringify({ garderobe_run: "run_abc123", garderobe_attempt: attempt }) });
    for (const loose of [true, [1], "1.0", " 1", "01", null, "", 1.5]) expect(await lookupWith(() => list([meta(loose)])).lookup.find(first), JSON.stringify(loose)).toEqual({ status: "not_found" });
    for (const loose of [null, "", false, [], " "]) expect(await lookupWith(() => list([meta(loose)])).lookup.find(zero), JSON.stringify(loose)).toEqual({ status: "not_found" });
    expect(await lookupWith(() => list([entry({ metadata: JSON.stringify({ garderobe_run: "run_abc123" }) })])).lookup.find(zero)).toEqual({ status: "not_found" });
    expect(await lookupWith(() => list([meta(1)])).lookup.find(first)).toMatchObject({ status: "charged" });
    expect(await lookupWith(() => list([meta("1")])).lookup.find(first)).toMatchObject({ status: "charged" });
  });

  it("third review: every page is read; a charged entry beyond the first fifty is found, and a search that does not end gives no finding", async () => {
    // 120 entries match the search text: this call's failed entry is on page 1, its charged retry on page 3.
    const other = (n: number) => entry({ id: `log-other-${n}`, metadata: JSON.stringify({ garderobe_run: "run_abc123", garderobe_attempt: 1 }) });
    const all120 = [entry({ id: "log-failed", success: false, status_code: 429, tokens_in: 0, tokens_out: 0 }), ...Array.from({ length: 118 }, (_, n) => other(n)), entry({ id: "log-paid-late", tokens_in: 700, tokens_out: 30 })];
    const paged = lookupWith((url) => {
      const page = Number(url.searchParams.get("page"));
      const slice = all120.slice((page - 1) * 50, page * 50);
      return Response.json({ success: true, result: slice, result_info: { count: slice.length, page, per_page: 50, total_count: all120.length } });
    });
    expect(await paged.lookup.find(call)).toEqual({ status: "charged", inputTokens: 700, outputTokens: 30, resolvedModel: "deepseek-chat", ref: "gateway-log:log-failed,log-paid-late" });
    expect(paged.requests.map((r) => r.url.searchParams.get("page"))).toEqual(["1", "2", "3"]);
    // Without a total, a full page means there may be more.
    const noTotal = lookupWith((url) => Response.json({ success: true, result: all120.slice((Number(url.searchParams.get("page")) - 1) * 50, Number(url.searchParams.get("page")) * 50) }));
    expect(await noTotal.lookup.find(call)).toMatchObject({ status: "charged", inputTokens: 700 });
    // A listing that never ends is not evidence of anything.
    const endless = lookupWith((url) => Response.json({ success: true, result: Array.from({ length: 50 }, (_, n) => entry({ id: `log-${url.searchParams.get("page")}-${n}`, success: false, tokens_in: 0, tokens_out: 0 })), result_info: { total_count: 1_000_000 } }));
    expect(await endless.lookup.find(call)).toEqual({ status: "not_found" });
    expect(endless.requests.length).toBe(20);
  });

  it("an answer that is not a plain success fails the lookup instead of reading as 'nothing was charged', and a foreign gateway is never queried", async () => {
    await expect(lookupWith(() => new Response("denied", { status: 403 })).lookup.find(call)).rejects.toThrow(/403/);
    await expect(lookupWith(() => new Response(null, { status: 302, headers: { Location: "https://collector.example/logs" } })).lookup.find(call)).rejects.toThrow(/302/);
    await expect(lookupWith(() => Response.json({ success: false, errors: [{ message: "bad token" }] })).lookup.find(call)).rejects.toThrow(/successful result list/);
    const foreign = lookupWith(() => list([entry({})]));
    await expect(foreign.lookup.find({ ...call, gatewayId: "someone-elses-gateway" })).rejects.toThrow(/not one of this application's gateways/);
    expect(foreign.requests).toEqual([]);
  });
});
