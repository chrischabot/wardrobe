import type { Env } from '../env.js';
import type { Principal } from '../domain/principal.js';
import { OpenMeteoProvider } from '../weather/open-meteo.js';
import { FakeWeatherProvider, WEATHER_SCENARIOS, type WeatherScenarioName } from '../weather/fake.js';
import type { WeatherProvider } from '../weather/types.js';
import type { CalendarSource, ManagedEventStore } from '../calendar/types.js';
import { RecommendationService } from '../recommend/service.js';
import { createDailyService } from '../daily/runtime.js';
import type { DailyService } from '../daily/service.js';
import { localDateOf } from '../domain/time.js';

/**
 * Service wiring for the HTTP API and MCP server. Both surfaces build their services here, so the
 * app, the web board and Claude/ChatGPT read the same board revision and execute through the same
 * command service.
 */

export interface ApiOverrides {
  weather?: WeatherProvider | null;
  calendar?: CalendarSource | null;
  /** The managed outfit-event store; defaults to `calendar` when that object is also a store (FakeCalendar is both). */
  calendarStore?: ManagedEventStore | null;
  clock?: () => string;
}

let overrides: ApiOverrides = {};

/** Tests and the end-to-end simulation inject weather, calendar and a clock here (never used in production). */
export function installApiTestOverrides(o: ApiOverrides | null): void {
  overrides = o ?? {};
}

export function now(): string {
  return overrides.clock ? overrides.clock() : new Date().toISOString();
}

const fakeProviders = new Map<string, FakeWeatherProvider>();

/** Weather provider for API-triggered composition. `fake:<scenario>` is honoured only when ENVIRONMENT=local. */
export function weatherProvider(env: Pick<Env, 'WEATHER_PROVIDER' | 'ENVIRONMENT'>): WeatherProvider | null {
  if (overrides.weather !== undefined) return overrides.weather;
  const setting = env.WEATHER_PROVIDER ?? 'open-meteo';
  if (setting.startsWith('fake:') && env.ENVIRONMENT === 'local') {
    const scenario = setting.slice(5) as WeatherScenarioName;
    if (scenario in WEATHER_SCENARIOS) {
      let p = fakeProviders.get(scenario);
      if (!p) fakeProviders.set(scenario, (p = new FakeWeatherProvider({ scenario, clock: now })));
      return p;
    }
  }
  return new OpenMeteoProvider();
}

export function recommendationService(env: Env, principal: Principal): RecommendationService {
  return new RecommendationService({ db: env.DB, principal, weather: weatherProvider(env), calendar: overrides.calendar ?? null, clock: now });
}

export function calendarSource(): CalendarSource | null {
  return overrides.calendar ?? null;
}

function calendarStore(): ManagedEventStore | null {
  if (overrides.calendarStore !== undefined) return overrides.calendarStore;
  const c = overrides.calendar as unknown as Partial<ManagedEventStore> | null | undefined;
  return c && typeof c.insertEvent === 'function' && typeof c.getEvent === 'function' && typeof c.patchEvent === 'function' ? (c as ManagedEventStore) : null;
}

/**
 * The daily service for API-triggered work: the same weather, calendar source and managed outfit
 * calendar the scheduled workflow uses, and the owner's chosen outfit calendar, so a repair after an
 * app or MCP command reaches the Calendar immediately rather than at the next sweep.
 */
export async function dailyService(env: Env, userId: string): Promise<DailyService> {
  const row = await env.DB.prepare('SELECT calendar_id FROM owner_settings WHERE user_id = ?').bind(userId).first<{ calendar_id: string | null }>().catch(() => null);
  return createDailyService(env, userId, { weather: weatherProvider(env), calendar: overrides.calendar ?? null, calendarStore: calendarStore(), calendarId: row?.calendar_id ?? undefined, clock: overrides.clock });
}

export async function ownerTimezone(env: Pick<Env, 'DB' | 'DEFAULT_TIMEZONE'>, principal: Principal): Promise<string> {
  const row = await env.DB.prepare('SELECT timezone FROM owner_settings WHERE user_id = ?').bind(principal.userId).first<{ timezone: string }>();
  return row?.timezone ?? env.DEFAULT_TIMEZONE ?? 'Europe/London';
}

export async function ownerToday(env: Pick<Env, 'DB' | 'DEFAULT_TIMEZONE'>, principal: Principal): Promise<{ date: string; timezone: string }> {
  const timezone = await ownerTimezone(env, principal);
  return { date: localDateOf(now(), timezone), timezone };
}

/**
 * After a committed command, apply its board revalidation and Calendar projection effects (the daily
 * service's repair path, exactly as the scheduled workflow would) before the response is sent, so
 * Today and the outfit calendar reflect the change immediately. Bounded: after REPAIR_WAIT_MS the
 * response goes out and the repair finishes in the background (waitUntil); the scheduled sweep
 * remains the backstop for anything that fails.
 */
export const REPAIR_WAIT_MS = 5_000;

export async function afterCommit(env: Env, ctx: ExecutionContext | undefined, userId: string): Promise<void> {
  const work = dailyService(env, userId)
    .then((d) => d.processEffects())
    .then(() => undefined)
    .catch((err: unknown) => console.warn('effect processing deferred', err instanceof Error ? err.message : String(err)));
  if (ctx) ctx.waitUntil(work);
  await Promise.race([work, new Promise<void>((r) => setTimeout(r, REPAIR_WAIT_MS))]);
}
