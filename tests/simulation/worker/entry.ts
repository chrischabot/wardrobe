/**
 * SIMULATION WORKER (local runs, or a separate development-only simulation deployment; never the product).
 *
 * This is the product Worker (`apps/worker/src/index.ts`: the same fetch, scheduled and queue handlers,
 * router, OAuth provider, MCP server, command service and conversation actor) with three LABELLED TEST
 * DOORS added around it, so a multi-week timeline can be driven against it over real HTTP:
 *
 *  - a settable clock (worker/clock.ts);
 *  - scripted stand-ins for the external weather and Google services (worker/conditions.ts), installed
 *    as the Worker's outbound `fetch`, so nothing reaches the network;
 *  - `POST /__sim/scheduled`, which runs the product's own five-minute `scheduled` handler once and
 *    waits for its background work.
 *
 * Where it may serve (`servingMode`): ENVIRONMENT `local` (bin/local.mjs), or ENVIRONMENT `development`
 * together with SIM_DEPLOYMENT `development-simulation` (a Worker deployed under its own name to
 * development resources only; see lib/dev-target.mjs). Anything else is refused. The doors are served
 * under `/__sim/*` and need the run's `x-sim-control` token, compared in constant time; a development
 * deployment additionally needs a token of at least 32 characters. Background work a request starts
 * (`waitUntil`) is awaited before its response is returned, so a step's effects are complete when the
 * simulator reads state. The clock and the scripted conditions are module state of one isolate, the run's
 * CONTROL ISOLATE (`GET /__sim/ready` is a readiness probe only: it reads no state and makes no isolate
 * authoritative): `POST /__sim/begin` (called once, at the start of a run) records it in the registry; a
 * registry serves one run, so a later begin is refused and voids it (a development simulation deployment is
 * deployed afresh for each run). Every later door call, product request, queue delivery, Durable Object
 * request (including the object's own control-token doors) and alarm verifies that it runs in that isolate. The first one that does not voids the run permanently (recorded in the registry):
 * it is refused, and every later door call answers 409 `simulation_run_void`, so the harness stops the run
 * instead of reading a world with another clock or no scripted conditions.
 *
 * There is no model binding here: `garderobe_ask` and `garderobe_research` return durable runs that end
 * in a reported failure, which is the product's real behaviour with no model reachable.
 */
import { realNowMs, setSimulatedNow, simulatedOffsetMs } from "./clock.ts"; // first: installs the settable clock
import { controlCalendar, controlWeather, listCalendars, readCalendar, refusedOutbound, simulatedOutbound, type CalendarControl, type WeatherControl } from "./conditions.ts";
import production, { GarderobeAssistant as ProductionAssistant } from "../../../apps/worker/src/index.ts";
import type { Env } from "../../../apps/worker/src/env.ts";

type SimEnv = Env & { SIM_CONTROL_TOKEN?: string; SIM_DEPLOYMENT?: string; SIM_REGISTRY?: DurableObjectNamespace };

(globalThis as unknown as { fetch: typeof fetch }).fetch = simulatedOutbound as typeof fetch;

/** This isolate's identity. Module state (the clock offset, the scripted conditions) lives and dies with it. */
// Generated on first use: Workers refuse random values in global scope.
let isolateIdValue: string | null = null;
const isolateId = (): string => (isolateIdValue ??= crypto.randomUUID());
let bootId: string | null = null;
/** Whether this isolate has been given the simulated clock (by the clock door, an alarm sync, or the registry). */
let clockReceived = false;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Where this entry may serve, or null when it must refuse. */
export function servingMode(env: { ENVIRONMENT?: string; SIM_DEPLOYMENT?: string; SIM_CONTROL_TOKEN?: string }): "local" | "development-simulation" | null {
  if (env.ENVIRONMENT === "local") return "local";
  if (env.ENVIRONMENT === "development" && env.SIM_DEPLOYMENT === "development-simulation" && (env.SIM_CONTROL_TOKEN ?? "").length >= 32) return "development-simulation";
  return null;
}

/** Constant-time comparison of the control token. */
function tokenMatches(given: string | null, expected: string | undefined): boolean {
  if (!expected || given === null) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Durable Object alarms are kept by the runtime on the real clock, while the actor computes alarm times
 * from the simulated `Date`; they are translated here, or an alarm would be due weeks late.
 *
 * Nothing about alarms is kept in the Worker's isolate, which need not be the isolate an object runs in:
 *
 *  - Every object registers its ID (with the isolate it runs in) in the `SimulationRegistry` object before it
 *    serves anything, and a fresh isolate first takes the current simulated clock from the registry (the clock
 *    door records each new offset there). Each object keeps the absolute SIMULATED deadline of its alarm in
 *    its own storage.
 *  - When the simulated clock moves, the clock door asks every registered object over its own endpoint
 *    (`/__sim/alarm-sync`): the object sets its own isolate's clock to the new instant, sets its alarm again
 *    on the real clock from the stored deadline, and reports its status, including its isolate ID.
 *  - An object whose isolate differs from the one recorded at its last sync has restarted, and with it
 *    lost the clock it had been given between syncs: the clock door fails the step (409).
 *  - The door then polls each object that has a due deadline or a running handler (`/__sim/alarm-status`)
 *    until none has, so it never returns while due alarm work is outstanding. An invocation consumes its
 *    deadline when it starts; a deadline its handler sets for an instant already reached is waited for too.
 */
const SIM_ALARM_KEY = "__garderobe_simulation_alarm_at";
const REGISTRY_NAME = "garderobe-simulation-alarm-registry";

interface AlarmEntry {
  id: string;
  setReal(time: number, options?: DurableObjectSetAlarmOptions): Promise<void>;
  getReal(options?: DurableObjectGetAlarmOptions): Promise<number | null>;
  remember(simulatedAt: number | null): Promise<void>;
  simulatedAt: number | null;
  running: number;
  completedRuns: number;
  /** Every alarm failure since the object was constructed; `reported` of them have been reported by a clock step. */
  failures: string[];
  reported: number;
  registered: boolean;
}

/** What an object reports about its alarm, from its own isolate. */
export interface AlarmStatus {
  id: string;
  isolateId: string;
  simulatedAt: number | null;
  nowMs: number;
  due: boolean;
  running: number;
  completedRuns: number;
  /** Failures not yet reported by a clock step (kept until reported, whatever later invocations do). */
  unreported: string[];
}

const realDeadline = (simulatedAt: number) => Math.max(realNowMs(), simulatedAt - simulatedOffsetMs());

function registryOf(env: SimEnv): DurableObjectStub {
  if (!env.SIM_REGISTRY) throw new Error("SIMULATION WORKER: the SIM_REGISTRY binding is missing");
  return env.SIM_REGISTRY.get(env.SIM_REGISTRY.idFromName(REGISTRY_NAME));
}

async function registryCall<T>(env: SimEnv, path: string, body?: unknown): Promise<T> {
  // Durable Object stubs follow no redirect: the registry never answers with one, and nothing here may be
  // forwarded to another origin.
  const init: RequestInit = body === undefined ? { redirect: "manual" } : { method: "POST", body: JSON.stringify(body), redirect: "manual" };
  const answer = await registryOf(env).fetch(`https://simulation.invalid${path}`, init);
  if (!answer.ok) throw new Error(`SIMULATION WORKER: the alarm registry answered ${answer.status} on ${path}`);
  return (await answer.json()) as T;
}

/**
 * Whether this isolate is the run's control isolate. Null when it is; otherwise the reason the run is void
 * (recorded in the registry by this call, or earlier by another).
 */
async function voidReason(env: SimEnv, where: string): Promise<string | null> {
  const answer = await registryCall<{ ok: boolean; reason?: string }>(env, "/verify", { isolateId: isolateId(), where });
  return answer.ok ? null : (answer.reason ?? "the run was voided");
}

const voidRun = (reason: string) => json({ error: { code: "simulation_run_void", message: `SIMULATION WORKER: ${reason}; this run is void` } }, 409);

function alignAlarms(ctx: DurableObjectState, env: SimEnv): AlarmEntry {
  const storage = ctx.storage;
  const deleteReal = storage.deleteAlarm.bind(storage);
  const entry: AlarmEntry = {
    id: ctx.id.toString(),
    setReal: storage.setAlarm.bind(storage),
    getReal: storage.getAlarm.bind(storage),
    remember: async (simulatedAt) => {
      entry.simulatedAt = simulatedAt;
      if (simulatedAt === null) await storage.delete(SIM_ALARM_KEY);
      else await storage.put(SIM_ALARM_KEY, simulatedAt);
    },
    simulatedAt: null,
    running: 0,
    completedRuns: 0,
    failures: [],
    reported: 0,
    registered: false,
  };
  // Before the object serves anything (request, RPC or alarm): restore its simulated deadline; give a fresh
  // isolate the current simulated clock from the registry, so its first product work never runs on the real
  // clock; and register the object, so every later clock step syncs it and an isolate restart is detected.
  void ctx.blockConcurrencyWhile(async () => {
    const stored = await storage.get<number>(SIM_ALARM_KEY);
    entry.simulatedAt = typeof stored === "number" ? stored : null;
    if (!env.SIM_REGISTRY) return;
    if (!clockReceived) {
      const { offsetMs } = await registryCall<{ offsetMs: number | null }>(env, "/now");
      if (typeof offsetMs === "number") {
        setSimulatedNow(realNowMs() + offsetMs);
        clockReceived = true;
      }
    }
    await registryCall(env, "/register", { id: entry.id, isolateId: isolateId() });
    entry.registered = true;
  });
  storage.setAlarm = (async (time: number | Date, options?: DurableObjectSetAlarmOptions) => {
    const simulatedAt = time instanceof Date ? time.getTime() : time;
    if (!entry.registered) {
      await registryCall(env, "/register", { id: entry.id, isolateId: isolateId() });
      entry.registered = true;
    }
    await entry.remember(simulatedAt);
    await entry.setReal(realDeadline(simulatedAt), options);
  }) as typeof storage.setAlarm;
  storage.getAlarm = (async (options?: DurableObjectGetAlarmOptions) => {
    const at = await entry.getReal(options);
    if (at === null) {
      if (entry.simulatedAt !== null && entry.running === 0) await entry.remember(null); // it ran or was deleted
      return null;
    }
    return entry.simulatedAt ?? at + simulatedOffsetMs();
  }) as typeof storage.getAlarm;
  storage.deleteAlarm = (async (options?: DurableObjectSetAlarmOptions) => {
    await entry.remember(null);
    await deleteReal(options);
  }) as typeof storage.deleteAlarm;
  return entry;
}

function statusOf(entry: AlarmEntry): AlarmStatus {
  const nowMs = Date.now();
  return { id: entry.id, isolateId: isolateId(), simulatedAt: entry.simulatedAt, nowMs, due: entry.simulatedAt !== null && entry.simulatedAt <= nowMs, running: entry.running, completedRuns: entry.completedRuns, unreported: entry.failures.slice(entry.reported) };
}

/** Inside an object: take the new simulated instant for this isolate and set the outstanding alarm again on the real clock. */
async function syncOwnAlarm(entry: AlarmEntry, nowMs: number): Promise<AlarmStatus> {
  setSimulatedNow(nowMs);
  clockReceived = true;
  // A stored deadline is always set again on the real clock (an overdue one becomes due at once), so it is
  // either run and consumed or reported as pending; it is never silently dropped.
  if (entry.simulatedAt !== null) await entry.setReal(realDeadline(entry.simulatedAt));
  return statusOf(entry);
}

/** An object door found the run void (409 simulation_run_void); the door that asked answers the same. */
class SimulationRunVoid extends Error {}

async function askObject(env: SimEnv, id: string, path: string, body?: unknown): Promise<AlarmStatus> {
  const namespace = env.ASSISTANT;
  if (!namespace) throw new Error("SIMULATION WORKER: the ASSISTANT binding is missing");
  const stub = namespace.get(namespace.idFromString(id));
  const headers = { "x-sim-control": env.SIM_CONTROL_TOKEN ?? "" };
  const answer = await stub.fetch(`https://simulation.invalid${path}`, body === undefined ? { headers, redirect: "manual" } : { method: "POST", headers, body: JSON.stringify(body), redirect: "manual" });
  if (answer.status === 409) {
    const refused = (await answer.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    if (refused?.error?.code === "simulation_run_void") throw new SimulationRunVoid(refused.error.message ?? `object ${id} found the run void on ${path}`);
  }
  if (!answer.ok) throw new Error(`SIMULATION WORKER: object ${id} answered ${answer.status} on ${path}`);
  return (await answer.json()) as AlarmStatus;
}

interface ClockOutcome {
  synced: number;
  restarted: string[];
  pending: string[];
  failed: string[];
  drained: number;
}

/** Move every registered object to the new instant, detect isolate restarts, and drain due alarms (bounded). */
async function moveObjectsTo(env: SimEnv, nowMs: number): Promise<ClockOutcome> {
  const { objects } = await registryCall<{ objects: { id: string; isolateId: string }[] }>(env, "/list");
  const before = new Map<string, AlarmStatus>();
  const restarted: string[] = [];
  for (const object of objects) {
    const status = await askObject(env, object.id, "/__sim/alarm-sync", { nowMs });
    before.set(object.id, status);
    if (status.isolateId !== object.isolateId) restarted.push(`${object.id}: isolate ${object.isolateId} -> ${status.isolateId}`);
  }
  // Record the isolates seen now, so a restart is reported once, at the step it happened before.
  if (objects.length > 0) await registryCall(env, "/seen", { objects: [...before.values()].map((s) => ({ id: s.id, isolateId: s.isolateId })) });
  const deadline = realNowMs() + 60_000;
  const latest = new Map(before);
  let busy: AlarmStatus[] = [];
  // Drain until two consecutive complete passes, each reading every registered object afresh, find every
  // object idle with nothing due, the registry unchanged and no handler run in between. A handler that
  // schedules a due alarm on an object already read in the first pass, or creates another object, shows
  // in the second pass as a due alarm, a completed run or a new object, and the drain goes on.
  const fingerprint = (statuses: Map<string, AlarmStatus>) => [...statuses.values()].map((s) => `${s.id}:${s.due}:${s.running}:${s.completedRuns}`).sort().join("|");
  let quietPass: string | null = null;
  let settled = false;
  for (;;) {
    const { objects: current } = await registryCall<{ objects: { id: string; isolateId: string }[] }>(env, "/list");
    const added = current.filter((o) => !latest.has(o.id));
    for (const object of added) {
      const status = await askObject(env, object.id, "/__sim/alarm-sync", { nowMs });
      before.set(object.id, { ...status, completedRuns: 0 });
      latest.set(object.id, status);
      if (status.isolateId !== object.isolateId) restarted.push(`${object.id}: isolate ${object.isolateId} -> ${status.isolateId}`);
    }
    if (added.length > 0) await registryCall(env, "/seen", { objects: added.map((o) => ({ id: o.id, isolateId: latest.get(o.id)!.isolateId })) });
    // A complete fresh pass over every object.
    for (const id of latest.keys()) latest.set(id, await askObject(env, id, "/__sim/alarm-status"));
    busy = [...latest.values()].filter((s) => s.due || s.running > 0);
    const pass = fingerprint(latest);
    if (busy.length === 0 && added.length === 0 && quietPass === pass) {
      settled = true;
      break;
    }
    quietPass = busy.length === 0 && added.length === 0 ? pass : null;
    if (realNowMs() >= deadline) break;
    if (busy.length > 0) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const ran = [...latest.values()].filter((s) => s.completedRuns > (before.get(s.id)?.completedRuns ?? 0));
  for (const s of latest.values()) if (s.isolateId !== before.get(s.id)?.isolateId) restarted.push(`${s.id}: isolate changed while draining`);
  // Every failure not yet reported, including one from before this step's sync or from an alarm that fired by
  // itself between steps, and one followed by a successful retry: reported once, then acknowledged.
  const failed: string[] = [];
  for (const s of latest.values()) {
    if (s.unreported.length === 0) continue;
    failed.push(...s.unreported.map((message) => `${s.id}: ${message}`));
    await askObject(env, s.id, "/__sim/alarm-ack", { count: s.unreported.length });
  }
  // A drain that reached its deadline without two identical idle passes has not settled: it is a timeout even
  // when the last pass happened to find nothing due.
  const pending = settled ? [] : busy.length > 0 ? busy.map((s) => s.id) : ["the drain did not observe two consecutive identical idle passes before its deadline"];
  return { synced: latest.size, restarted, pending, failed, drained: ran.length };
}

/** The registry of objects that have set an alarm, with the isolate each was last seen in. */
export class SimulationRegistry {
  constructor(private readonly ctx: DurableObjectState) {}
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const body = request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : {};
    if (path === "/register") {
      const { id, isolateId: seenIn } = body as { id: string; isolateId: string };
      if ((await this.ctx.storage.get(`object:${id}`)) === undefined) await this.ctx.storage.put(`object:${id}`, seenIn);
      return json({ ok: true });
    }
    if (path === "/seen") {
      for (const o of (body as { objects: { id: string; isolateId: string }[] }).objects) await this.ctx.storage.put(`object:${o.id}`, o.isolateId);
      return json({ ok: true });
    }
    if (path === "/clock") {
      await this.ctx.storage.put("clock:offset", Number((body as { offsetMs: number }).offsetMs));
      return json({ ok: true });
    }
    if (path === "/begin") {
      // A registry serves ONE run: the first begin records the control isolate; any later begin (another run,
      // or a fresh isolate trying to take over, or resurrecting a void run) is refused and voids the run.
      const claimant = String((body as { isolateId: string }).isolateId);
      const control = await this.ctx.storage.get<string>("control:isolate");
      if (control === undefined) {
        await this.ctx.storage.put("control:isolate", claimant);
        return json({ ok: true });
      }
      const reason = control === claimant ? "a second run began on a registry that already served one" : `a run tried to begin from isolate ${claimant} while isolate ${control} holds the run`;
      if ((await this.ctx.storage.get<string>("control:void")) === undefined) await this.ctx.storage.put("control:void", reason);
      return json({ ok: false, reason: (await this.ctx.storage.get<string>("control:void")) ?? reason });
    }
    if (path === "/verify") {
      const { isolateId: claimant, where } = body as { isolateId: string; where: string };
      const voided = await this.ctx.storage.get<string>("control:void");
      if (typeof voided === "string") return json({ ok: false, reason: voided });
      const control = await this.ctx.storage.get<string>("control:isolate");
      if (control === claimant) return json({ ok: true });
      // No run begun, or another isolate: never adopted, always void (a door can never make a fresh isolate authoritative).
      const reason = control === undefined ? `${where} arrived before the run began (no control isolate)` : `${where} reached isolate ${claimant}, but the simulated clock and scripted conditions live in isolate ${control}`;
      await this.ctx.storage.put("control:void", reason);
      return json({ ok: false, reason });
    }
    if (path === "/now") {
      const offsetMs = await this.ctx.storage.get<number>("clock:offset");
      return json({ offsetMs: typeof offsetMs === "number" ? offsetMs : null });
    }
    if (path === "/list") {
      const all = await this.ctx.storage.list<string>({ prefix: "object:" });
      return json({ objects: [...all].map(([key, seenIn]) => ({ id: key.slice("object:".length), isolateId: seenIn })) });
    }
    return json({ error: "unknown registry path" }, 404);
  }
}

export class GarderobeAssistant extends ProductionAssistant {
  readonly #simAlarm: AlarmEntry;
  constructor(ctx: DurableObjectState, env: Env) {
    const entry = alignAlarms(ctx, env as SimEnv);
    super(ctx, env);
    this.#simAlarm = entry;
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/__sim/")) {
      // The object's own doors answer only the simulation Worker's control token, in the run's control isolate;
      // anything else (a product route forwarded here, another isolate) is refused like a door call would be.
      if (!tokenMatches(request.headers.get("x-sim-control"), (this.env as SimEnv).SIM_CONTROL_TOKEN)) return json({ error: "simulation control token required" }, 403);
      const doorReason = await voidReason(this.env as SimEnv, `the object door ${path} of Durable Object ${this.#simAlarm.id}`);
      if (doorReason) return voidRun(doorReason);
    }
    if (path === "/__sim/alarm-sync") {
      const { nowMs } = (await request.json()) as { nowMs: number };
      return json(await syncOwnAlarm(this.#simAlarm, Number(nowMs)));
    }
    if (path === "/__sim/alarm-status") return json(statusOf(this.#simAlarm));
    if (path === "/__sim/alarm-ack") {
      const { count } = (await request.json()) as { count: number };
      this.#simAlarm.reported = Math.min(this.#simAlarm.failures.length, this.#simAlarm.reported + Math.max(0, Number(count) || 0));
      return json(statusOf(this.#simAlarm));
    }
    if (path.startsWith("/__sim/")) return json({ error: "not a simulation object door" }, 404);
    const reason = await voidReason(this.env as SimEnv, `a request to Durable Object ${this.#simAlarm.id} (${path})`);
    if (reason) return voidRun(reason);
    return super.fetch(request);
  }

  override async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    const entry = this.#simAlarm;
    entry.running++;
    try {
      // This invocation consumes the deadline that made it due; a deadline the handler sets is a new one.
      if (entry.simulatedAt !== null && entry.simulatedAt <= Date.now()) await entry.remember(null);
      const reason = await voidReason(this.env as SimEnv, `an alarm of Durable Object ${entry.id}`);
      if (reason) throw new Error(`${reason}; this run is void`);
      await (super.alarm as unknown as (info?: AlarmInvocationInfo) => Promise<void>).call(this, alarmInfo);
    } catch (error) {
      entry.failures.push(String((error as Error)?.message ?? error).slice(0, 300));
      throw error;
    } finally {
      entry.running--;
      entry.completedRuns++;
    }
  }
}

/** An execution context that remembers what was handed to `waitUntil`, so it can be awaited and its failures reported. */
function tracking(ctx: ExecutionContext): { ctx: ExecutionContext; settle(): Promise<{ handed: number; timedOut: boolean; failures: string[] }> } {
  const pending: Promise<unknown>[] = [];
  const failures: string[] = [];
  let finished = 0;
  const proxy = new Proxy(ctx, {
    get(target, property) {
      if (property === "waitUntil") {
        return (promise: Promise<unknown>) => {
          pending.push(
            Promise.resolve(promise)
              .catch((error) => {
                failures.push(String((error as Error)?.stack ?? (error as Error)?.message ?? error).slice(0, 600));
              })
              .finally(() => finished++),
          );
          target.waitUntil(promise);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    ctx: proxy,
    settle: async () => {
      // Background work may itself hand over more work; wait until every task has finished (bounded).
      const deadline = realNowMs() + 60_000;
      while (finished < pending.length && realNowMs() < deadline) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([Promise.allSettled(pending.slice()), new Promise((resolve) => (timer = setTimeout(resolve, Math.max(0, deadline - realNowMs()))))]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      return { handed: pending.length, timedOut: finished < pending.length, failures };
    },
  };
}

/** The answer when background work did not finish in time: the step must fail, never read half-done state. */
const unsettled = (handed: number) => json({ error: { code: "simulation_settlement_timeout", message: `SIMULATION WORKER: ${handed} background task(s) did not finish within 60 s; this step's effects are incomplete` } }, 504);
/** The answer when background work failed: the step must fail with the failures, never look successful. */
const backgroundFailed = (failures: string[]) => json({ error: { code: "simulation_background_failure", message: `SIMULATION WORKER: ${failures.length} background task(s) failed`, details: { failures: failures.slice(0, 10) } } }, 500);

async function control(request: Request, env: SimEnv, ctx: ExecutionContext, url: URL, mode: string): Promise<Response> {
  if (!tokenMatches(request.headers.get("x-sim-control"), env.SIM_CONTROL_TOKEN)) return json({ error: "simulation control token required" }, 403);
  const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};
  const state = () => ({ simulation: true, mode, bootId, isolateId: isolateId(), nowMs: Date.now(), now: new Date().toISOString(), offsetMs: simulatedOffsetMs(), refusedOutbound: refusedOutbound(), calendars: listCalendars() });
  // Readiness only: answers before the run begins, reads no state, reaches no registry and makes no isolate authoritative.
  if (url.pathname === "/__sim/ready") return json({ simulation: true, mode });
  if (url.pathname === "/__sim/begin") {
    const begun = await registryCall<{ ok: boolean; reason?: string }>(env, "/begin", { isolateId: isolateId() });
    if (!begun.ok) return voidRun(begun.reason ?? "the run could not begin");
    return json(state());
  }
  // Every other door, read or write, must reach the run's control isolate; it never makes another one authoritative.
  const reason = await voidReason(env, `the door ${request.method} ${url.pathname}`);
  if (reason) return voidRun(reason);
  try {
    switch (url.pathname) {
      case "/__sim/state":
        return json(state());
      case "/__sim/clock": {
        const nowMs = Number(body.nowMs);
        if (!Number.isFinite(nowMs) || nowMs < realNowMs()) return json({ error: "nowMs must be a time that is not before the real time" }, 400);
        setSimulatedNow(nowMs);
        clockReceived = true;
        // Objects constructed later read the clock here before their first product work.
        await registryCall(env, "/clock", { offsetMs: simulatedOffsetMs() });
        const outcome = await moveObjectsTo(env, nowMs);
        if (outcome.restarted.length > 0) return json({ error: { code: "simulation_object_restarted", message: `SIMULATION WORKER: ${outcome.restarted.length} Durable Object(s) restarted in a new isolate and lost the simulated clock between steps; this run is void`, details: { restarted: outcome.restarted } } }, 409);
        if (outcome.pending.length > 0) return json({ error: { code: "simulation_alarm_timeout", message: `SIMULATION WORKER: ${outcome.pending.length} alarm(s) due at the new instant did not finish within 60 s`, details: { pending: outcome.pending } } }, 504);
        if (outcome.failed.length > 0) return json({ error: { code: "simulation_alarm_failure", message: `SIMULATION WORKER: ${outcome.failed.length} alarm(s) due at the new instant failed`, details: { failed: outcome.failed } } }, 500);
        return json({ ...state(), alarms: { synced: outcome.synced, drained: outcome.drained } });
      }
      case "/__sim/scheduled": {
        const tracked = tracking(ctx);
        await production.scheduled({ scheduledTime: Date.now(), cron: "*/5 * * * *", noRetry() {} } as ScheduledController, env, tracked.ctx);
        const { handed, timedOut, failures } = await tracked.settle();
        if (timedOut) return unsettled(handed);
        if (failures.length > 0) return backgroundFailed(failures);
        return json({ ...state(), background: handed });
      }
      case "/__sim/weather":
        return json({ ...state(), ...controlWeather(body as WeatherControl) });
      case "/__sim/calendar":
        if (request.method === "GET") return json(readCalendar(String(url.searchParams.get("calendarId"))));
        return json({ ...state(), ...controlCalendar(body as unknown as CalendarControl) });
      default:
        return json({ error: "not a simulation door" }, 404);
    }
  } catch (error) {
    if (error instanceof SimulationRunVoid) return json({ error: { code: "simulation_run_void", message: error.message } }, 409);
    return json({ error: String((error as Error)?.message ?? error) }, 400);
  }
}

export default {
  async fetch(request: Request, env: SimEnv, ctx: ExecutionContext): Promise<Response> {
    const mode = servingMode(env);
    if (!mode) return json({ error: "the simulation Worker serves only locally or as a development-only simulation deployment (ENVIRONMENT development, SIM_DEPLOYMENT development-simulation, a control token of at least 32 characters)" }, 500);
    bootId ??= isolateId();
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__sim/")) return control(request, env, ctx, url, mode);
    // The clock and the scripted conditions are this isolate's module state: a request that reached another
    // isolate would run on another clock with no scripted conditions, so it is refused and the run is void.
    const reason = await voidReason(env, `the request ${request.method} ${url.pathname}`);
    if (reason) return voidRun(reason);
    const tracked = tracking(ctx);
    const response = await production.fetch(request, env, tracked.ctx);
    const { handed, timedOut, failures } = await tracked.settle();
    if (timedOut) return unsettled(handed);
    if (failures.length > 0) return backgroundFailed(failures);
    return response;
  },
  async queue(batch: MessageBatch<unknown>, env: SimEnv): Promise<void> {
    if (!servingMode(env)) throw new Error("the simulation Worker serves only locally or as a development-only simulation deployment");
    // A delivery to another isolate would run product work on another clock with no scripted conditions: it is
    // not run, the run is recorded as void (every later door call says so), and the batch is acknowledged so
    // nothing is retried into the void run.
    const reason = await voidReason(env, `a queue delivery of ${batch.messages.length} message(s)`);
    if (reason) {
      batch.ackAll();
      return;
    }
    return production.queue(batch, env);
  },
} satisfies ExportedHandler<SimEnv>;
