/**
 * Simulation hook for the Garderobe Worker, used only by the end-to-end simulation
 * (tests/simulation). It is wired into the dev deployment's entry (deploy/src/dev-entry.ts) and the
 * local simulation entry (./local-entry.ts); the product entry (backend/src/index.ts) never loads it.
 *
 * A request carrying a valid `x-garderobe-sim` header (HMAC-SHA256 with the DEV_SIM_SECRET Worker
 * secret) runs with the simulated world it describes:
 *  - the simulated clock, weather (FakeWeatherProvider driven by the header's per-day curves) and
 *    calendar (FakeCalendar holding the header's events) are installed through the product's own test
 *    seams, `installApiTestOverrides` (HTTP API, MCP tools, daily-service repair) and
 *    `installTestDailyProviders` (the assistant's trusted day context and outfit validation);
 *  - before an MCP call that can reach the assistant (garderobe_ask, garderobe_research,
 *    garderobe_run) or a /v1/conversation request, the same state is pushed into the simulation
 *    owner's assistant actor, so a real assistant turn discusses the simulated day.
 * Routes under `/__sim/` (only with a valid header): `POST /__sim/phase` runs one scheduled daily
 * phase (evening, morning_refresh, final) for the simulation owner through the real DailyService;
 * `POST /__sim/audit` returns the owner's assistant turns (with their outfit cards) and model runs.
 *
 * A request without the header runs unchanged with the product defaults (Open-Meteo, no calendar,
 * the real clock). A header with a bad signature, or any header outside ENVIRONMENT dev/local, is
 * refused with 403 rather than silently ignored.
 */
import { getAgentByName } from 'agents';
import type { Env } from '../../../backend/src/env.js';
import { installApiTestOverrides, dailyService } from '../../../backend/src/api/services.js';
import { installTestDailyProviders } from '../../../backend/src/assistant/day-context.js';
import { assistantActorName } from '../../../backend/src/assistant/index.js';
import { FakeWeatherProvider, type WeatherScenario } from '../../../backend/src/weather/fake.js';
import { FakeCalendar } from '../../../backend/src/calendar/fake.js';
import type { DailyPhase } from '../../../backend/src/daily/service.js';
import { BudgetLedger, spendCapFromEnv } from '../../../backend/src/models/budget.js';
import { hourOf, SIM_HEADER, verifySimState, type DayWeather, type SimState } from '../src/sim-state.js';

export type SimEnv = Env & { DEV_SIM_SECRET?: string };

/** A fake weather provider whose identity is the scenario revision, so the shared D1 forecast cache never serves another scenario. */
class SimWeatherProvider extends FakeWeatherProvider {
  constructor(private readonly simName: string, options: ConstructorParameters<typeof FakeWeatherProvider>[0]) {
    super(options);
  }
  override get name(): string {
    return this.simName;
  }
}

const MILD: DayWeather = { low: 11, high: 17, rainProbability: 5, rainMm: 0, windKmh: 10, gustKmh: 18 };

function scenarioOf(days: Record<string, DayWeather>): WeatherScenario {
  return (date, hour) => hourOf(days[date] ?? MILD, hour);
}

export function simClock(state: SimState, receivedAtMs = Date.now()): () => string {
  const base = Date.parse(state.clock);
  return () => new Date(base + (Date.now() - receivedAtMs)).toISOString();
}

export interface SimProviders {
  weather: FakeWeatherProvider;
  calendar: FakeCalendar | null;
  clock: () => string;
}

export function buildProviders(state: SimState, receivedAtMs = Date.now()): SimProviders {
  const clock = simClock(state, receivedAtMs);
  const byLocation = Object.fromEntries(Object.entries(state.weather.byLocation ?? {}).map(([label, days]) => [label, scenarioOf(days)]));
  const weather = new SimWeatherProvider(`sim-weather-${state.revision}`, { scenario: scenarioOf(state.weather.home), byLocation, fail: Boolean(state.weather.fail), clock });
  let calendar: FakeCalendar | null = null;
  if (state.calendar) {
    calendar = new FakeCalendar(clock);
    calendar.failListing = Boolean(state.calendar.fail);
    for (const e of state.calendar.events) {
      calendar.addEvent({
        eventId: e.eventId,
        title: e.title,
        start: e.start ?? null,
        end: e.end ?? null,
        startDate: e.startDate ?? null,
        endDate: e.endDate ?? null,
        allDay: Boolean(e.allDay),
        location: e.location ?? null,
        status: e.status ?? 'confirmed',
        selfResponse: (e.selfResponse ?? 'accepted') as never,
      });
    }
  }
  return { weather, calendar, clock };
}

/** Installs the simulated world for this isolate (API/MCP services and the assistant's day context). */
export function installSimulation(p: SimProviders | null): void {
  if (!p) {
    installApiTestOverrides(null);
    installTestDailyProviders(null);
    return;
  }
  // calendarStore: null — the simulation does not project outfit events into a managed calendar (not covered).
  installApiTestOverrides({ weather: p.weather, calendar: p.calendar, calendarStore: null, clock: p.clock });
  installTestDailyProviders({ weather: p.weather, calendar: p.calendar, clock: p.clock });
}

const ASSISTANT_TOOLS = new Set(['garderobe_ask', 'garderobe_research', 'garderobe_run']);

function reachesAssistant(request: Request, url: URL): boolean {
  if (url.pathname.startsWith('/v1/conversation')) return true;
  if (url.pathname !== '/mcp' || request.method !== 'POST') return false;
  const name = request.headers.get('mcp-name');
  // Without the 2026-07-28 Mcp-Name header (the 2025-11-25 adapter) push anyway: it is cheap.
  return name === null || ASSISTANT_TOOLS.has(name);
}

const refuse = (status: number, code: string, message: string) => new Response(JSON.stringify({ error: { code, message } }), { status, headers: { 'content-type': 'application/json' } });

let active = false;

export async function simulationFetch(request: Request, env: SimEnv, ctx: ExecutionContext, next: (request: Request) => Promise<Response>): Promise<Response> {
  const url = new URL(request.url);
  const header = request.headers.get(SIM_HEADER);
  if (!header) {
    if (active) {
      installSimulation(null);
      active = false;
    }
    if (url.pathname.startsWith('/__sim/')) return refuse(404, 'not_found', 'Not found');
    return next(request);
  }
  if (env.ENVIRONMENT !== 'dev' && env.ENVIRONMENT !== 'local') return refuse(403, 'simulation_not_allowed', 'Simulation headers are accepted only in the dev and local environments');
  const state = await verifySimState(header, env.DEV_SIM_SECRET);
  if (!state) return refuse(403, 'simulation_signature_invalid', 'The simulation header is not signed with this environment’s DEV_SIM_SECRET');
  const providers = buildProviders(state);
  installSimulation(providers);
  active = true;

  if (url.pathname === '/__sim/phase' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { phase?: DailyPhase; boardDate?: string };
    if (!body.phase || !['evening', 'morning_refresh', 'final'].includes(body.phase) || !/^\d{4}-\d{2}-\d{2}$/.test(body.boardDate ?? '')) return refuse(422, 'validation_failed', 'phase and boardDate are required');
    const daily = await dailyService(env, state.userId);
    const r = await daily.runPhase(body.phase, body.boardDate!);
    return Response.json({ phase: r.phase, boardDate: r.boardDate, status: r.status, purpose: r.purpose, publish: r.publish, repair: r.repair, resetsApplied: r.resetsApplied, deadlineMet: r.deadlineMet, error: r.error });
  }
  if (url.pathname === '/__sim/audit' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { since?: string };
    return Response.json(await audit(env, state.userId, body.since ?? '1970-01-01T00:00:00.000Z'));
  }
  if (url.pathname.startsWith('/__sim/')) return refuse(404, 'not_found', 'Unknown simulation route');

  if (reachesAssistant(request, url)) {
    const actor = (await getAgentByName(env.ASSISTANT as never, assistantActorName(env.ENVIRONMENT, state.userId))) as unknown as { devSimulation: (s: SimState) => Promise<unknown> };
    await actor.devSimulation(state);
  }
  void ctx;
  return next(request);
}

/** The simulation owner's assistant turns (outfit cards included) and model runs since `since`. */
async function audit(env: SimEnv, userId: string, since: string) {
  const turns = await env.DB.prepare(
    'SELECT turn_id, client_turn_id, channel, status, intent_json, profile_version, context_digest, result_json, error, created_at, updated_at FROM assistant_turns WHERE user_id = ? AND created_at >= ? ORDER BY created_at',
  )
    .bind(userId, since)
    .all<Record<string, unknown>>();
  const runs = await env.DB.prepare(
    `SELECT r.run_id, r.task, r.profile_id, r.provider, r.model, r.route, r.gateway_id, r.input_tokens, r.output_tokens, r.status, r.error_class, r.error_message, r.fallback_of, r.created_at,
            m.run_ref, m.actual_micro_usd, m.reserved_micro_usd, m.status AS reservation_status
       FROM model_runs r LEFT JOIN model_reservations m ON m.user_id = r.user_id AND m.reservation_id = r.reservation_id
      WHERE r.user_id = ? AND r.created_at >= ? ORDER BY r.created_at`,
  )
    .bind(userId, since)
    .all<Record<string, unknown>>();
  const spend = await env.DB.prepare("SELECT COALESCE(SUM(COALESCE(actual_micro_usd, reserved_micro_usd)), 0) AS micro FROM model_reservations WHERE user_id = ? AND status IN ('settled', 'reserved', 'uncertain')")
    .bind(userId)
    .first<{ micro: number }>();
  // The deployment-wide spend cap exactly as the product's ModelService reads it (models/budget.ts), and what it counts now.
  const raw = (env as SimEnv & { MODEL_SPEND_CAP_USD?: string }).MODEL_SPEND_CAP_USD;
  let spendCap: Record<string, unknown>;
  try {
    const cap = spendCapFromEnv(raw);
    spendCap = { configured: raw ?? null, parsed: cap, deploymentSpentMicroUsd: cap ? await new BudgetLedger(env.DB, userId, () => new Date().toISOString(), cap).deploymentSpent() : null };
  } catch (err) {
    spendCap = { configured: raw ?? null, error: err instanceof Error ? err.message : String(err) };
  }
  return { userId, turns: turns.results, modelRuns: runs.results, ownerSpendMicroUsd: spend?.micro ?? 0, spendCap };
}

/**
 * Mixin for the assistant Durable Object class: `devSimulation(state)` installs the simulated world
 * in the actor's isolate and makes the actor's clock follow the simulated clock. Without a pushed
 * state the actor behaves exactly like the product class.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withSimulation<T extends abstract new (...args: any[]) => object>(Base: T) {
  abstract class SimulationAware extends Base {
    private simulation: { state: SimState; clock: () => string } | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(...args: any[]) {
      super(...args);
      // The product actor reads time through its private now(); an own property shadows it.
      Object.defineProperty(this, 'now', { configurable: true, writable: true, value: () => (this.simulation ? this.simulation.clock() : new Date().toISOString()) });
    }

    /** Called by the simulation hook before a request that can reach this actor. */
    async devSimulation(state: SimState): Promise<{ clock: string; revision: string }> {
      const providers = buildProviders(state);
      this.simulation = { state, clock: providers.clock };
      installTestDailyProviders({ weather: providers.weather, calendar: providers.calendar, clock: providers.clock });
      return { clock: providers.clock(), revision: state.revision };
    }
  }
  return SimulationAware;
}
