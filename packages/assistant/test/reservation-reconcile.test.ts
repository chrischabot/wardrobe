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
import { ABANDONED_AFTER_MS, LOOKUP_NOT_BEFORE_MS, createGatewayLogsLookup, getInferenceOverview, profileSpec, reconcileInferenceReservations, runAssistantMaintenance, type DispatchedCall, type ProviderUsageFinding } from "../src/index.ts";
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
    expect(await sweep(early)).toEqual({ markedUncertain: 0, settled: 0, released: 0, stillUncertain: 0, lookupFailures: 0 });
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
    expect(await sweep(record)).toEqual({ markedUncertain: 0, settled: 1, released: 1, stillUncertain: 0, lookupFailures: 0 });
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
    expect(await sweep(again)).toEqual({ markedUncertain: 0, settled: 0, released: 0, stillUncertain: 0, lookupFailures: 0 });
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
    expect(swept.reservations).toEqual({ markedUncertain: 1, settled: 0, released: 0, stillUncertain: 1, lookupFailures: 0 });
    const open = (await rows(w)).filter((r) => r.reservation_id === "rsv_evicted_actor" || r.reservation_id === "rsv_still_running");
    expect(open.map((r) => [r.reservation_id, r.state, r.error_class, r.settled_at])).toEqual([
      ["rsv_evicted_actor", "uncertain", "abandoned", null],
      ["rsv_still_running", "reserved", null, null],
    ]);
    // Its 700 is still held against the day's budget.
    expect((await interactive()).uncertainMicroUsd).toBe(700);
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
    expect(Object.fromEntries(url.searchParams)).toEqual({ search: "run_abc123", per_page: "50", order_by: "created_at", order_by_direction: "desc" });
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer TEST-TOKEN-not-a-real-credential");
  });

  it("a logged call that used no tokens is 'not charged'; no matching entry is 'not found', never 'not charged'", async () => {
    expect(await lookupWith(() => list([entry({ id: "log-failed", success: false, status_code: 502, tokens_in: 0, tokens_out: 0 })])).lookup.find(call)).toEqual({ status: "not_charged", ref: "gateway-log:log-failed" });
    expect(await lookupWith(() => list([entry({ id: "log-cached", cached: true })])).lookup.find(call)).toEqual({ status: "not_charged", ref: "gateway-log:log-cached" });
    expect(await lookupWith(() => list([])).lookup.find(call)).toEqual({ status: "not_found" });
    expect(await lookupWith(() => list([entry({ metadata: undefined })])).lookup.find(call)).toEqual({ status: "not_found" });
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
