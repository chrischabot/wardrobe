/**
 * SIMULATION WORKER (local runs only; never deployed).
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
 * The doors are served under `/__sim/*`, need the `x-sim-control` token of the run, and the whole entry
 * refuses to serve when ENVIRONMENT is not `local`. Background work a request starts (`waitUntil`) is
 * awaited before its response is returned, so a step's effects are complete when the simulator reads
 * state; a deployment answers first and finishes in the background.
 *
 * There is no model binding here: `garderobe_ask` and `garderobe_research` return durable runs that end
 * in a reported failure, which is the product's real behaviour with no model reachable.
 */
import { realNowMs, setSimulatedNow, simulatedOffsetMs } from "./clock.ts"; // first: installs the settable clock
import { controlCalendar, controlWeather, listCalendars, readCalendar, refusedOutbound, simulatedOutbound, type CalendarControl, type WeatherControl } from "./conditions.ts";
import production, { GarderobeAssistant as ProductionAssistant } from "../../../apps/worker/src/index.ts";
import type { Env } from "../../../apps/worker/src/env.ts";

type SimEnv = Env & { SIM_CONTROL_TOKEN?: string };

(globalThis as unknown as { fetch: typeof fetch }).fetch = simulatedOutbound as typeof fetch;

let bootId: string | null = null;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * Durable Object alarms are kept by the runtime on the real clock, while the actor computes alarm times
 * from the simulated `Date`; they are translated here, or an alarm would be due weeks late.
 */
function alignAlarms(ctx: DurableObjectState): void {
  const storage = ctx.storage;
  const setAlarm = storage.setAlarm.bind(storage);
  const getAlarm = storage.getAlarm.bind(storage);
  storage.setAlarm = ((time: number | Date, options?: DurableObjectSetAlarmOptions) => setAlarm(Math.max(realNowMs(), (time instanceof Date ? time.getTime() : time) - simulatedOffsetMs()), options)) as typeof storage.setAlarm;
  storage.getAlarm = (async (options?: DurableObjectGetAlarmOptions) => {
    const at = await getAlarm(options);
    return at === null ? null : at + simulatedOffsetMs();
  }) as typeof storage.getAlarm;
}

export class GarderobeAssistant extends ProductionAssistant {
  constructor(ctx: DurableObjectState, env: Env) {
    alignAlarms(ctx);
    super(ctx, env);
  }
}

/** An execution context that remembers what was handed to `waitUntil`, so it can be awaited. */
function tracking(ctx: ExecutionContext): { ctx: ExecutionContext; settle(): Promise<number> } {
  const pending: Promise<unknown>[] = [];
  const proxy = new Proxy(ctx, {
    get(target, property) {
      if (property === "waitUntil") {
        return (promise: Promise<unknown>) => {
          pending.push(Promise.resolve(promise).catch(() => undefined));
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
      let settled = 0;
      // Background work may itself hand over more work; wait until nothing is left (bounded).
      const deadline = realNowMs() + 60_000;
      while (settled < pending.length && realNowMs() < deadline) {
        const batch = pending.slice(settled);
        settled = pending.length;
        await Promise.race([Promise.allSettled(batch), new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - realNowMs())))]);
      }
      return pending.length;
    },
  };
}

async function control(request: Request, env: SimEnv, ctx: ExecutionContext, url: URL): Promise<Response> {
  if (!env.SIM_CONTROL_TOKEN || request.headers.get("x-sim-control") !== env.SIM_CONTROL_TOKEN) return json({ error: "simulation control token required" }, 403);
  const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};
  const state = () => ({ simulation: true, bootId, nowMs: Date.now(), now: new Date().toISOString(), offsetMs: simulatedOffsetMs(), refusedOutbound: refusedOutbound(), calendars: listCalendars() });
  try {
    switch (url.pathname) {
      case "/__sim/state":
        return json(state());
      case "/__sim/clock": {
        const nowMs = Number(body.nowMs);
        if (!Number.isFinite(nowMs) || nowMs < realNowMs()) return json({ error: "nowMs must be a time that is not before the real time" }, 400);
        setSimulatedNow(nowMs);
        return json(state());
      }
      case "/__sim/scheduled": {
        const tracked = tracking(ctx);
        await production.scheduled({ scheduledTime: Date.now(), cron: "*/5 * * * *", noRetry() {} } as ScheduledController, env, tracked.ctx);
        const background = await tracked.settle();
        return json({ ...state(), background });
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
    return json({ error: String((error as Error)?.message ?? error) }, 400);
  }
}

export default {
  async fetch(request: Request, env: SimEnv, ctx: ExecutionContext): Promise<Response> {
    if (env.ENVIRONMENT !== "local") return json({ error: "the simulation Worker only runs locally" }, 500);
    bootId ??= crypto.randomUUID();
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__sim/")) return control(request, env, ctx, url);
    const tracked = tracking(ctx);
    const response = await production.fetch(request, env, tracked.ctx);
    await tracked.settle();
    return response;
  },
  async queue(batch: MessageBatch<unknown>, env: SimEnv): Promise<void> {
    return production.queue(batch, env);
  },
} satisfies ExportedHandler<SimEnv>;
