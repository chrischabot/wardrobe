import { env } from 'cloudflare:workers';
import type { DomainCommandInput } from '@garderobe/contracts';
import { FakeCalendar } from '../../src/calendar/fake.js';
import { DailyService, type DailyServiceDeps } from '../../src/daily/service.js';
import { RecommendationService } from '../../src/recommend/service.js';
import { TripService } from '../../src/trips/service.js';
import { FakeWeatherProvider, type FakeWeatherOptions } from '../../src/weather/fake.js';
import { newOwner, ok } from './fixtures.js';
import type { Principal } from '../../src/domain/principal.js';

/** Controllable clock shared by a scenario's services. */
export class TestClock {
  constructor(public value: string) {}
  now = (): string => this.value;
  set(iso: string): void {
    this.value = new Date(iso).toISOString();
  }
  advanceMinutes(n: number): void {
    this.value = new Date(Date.parse(this.value) + n * 60_000).toISOString();
  }
}

export interface Scenario {
  principal: Principal;
  userId: string;
  byName: (name: string) => Promise<string>;
  clock: TestClock;
  weather: FakeWeatherProvider;
  calendar: FakeCalendar;
  daily: DailyService;
  rec: RecommendationService;
  trips: TripService;
  cmd: (command: DomainCommandInput, extra?: Record<string, unknown>) => ReturnType<typeof ok>;
}

/** The owner with the real profile, rules and May 2026 inventory (plus the 17 owner-asserted additions when `withAdditions`), and fake weather and calendar. */
export async function ownerScenario(opts: { now?: string; weather?: FakeWeatherOptions; calendarConnected?: boolean; deps?: Partial<DailyServiceDeps>; withAdditions?: boolean } = {}): Promise<Scenario> {
  const owner = await newOwner(opts.withAdditions ? { withAdditions: true } : {});
  const clock = new TestClock(opts.now ?? '2026-10-05T20:00:00.000Z');
  const weather = new FakeWeatherProvider({ scenario: 'mild', clock: clock.now, ...opts.weather });
  const calendar = new FakeCalendar(clock.now);
  const connected = opts.calendarConnected ?? true;
  const deps: DailyServiceDeps = {
    db: env.DB,
    principal: owner.principal,
    weather,
    calendar: connected ? calendar : null,
    calendarStore: connected ? calendar : null,
    calendarId: 'garderobe-outfits',
    clock: clock.now,
    ...opts.deps,
  };
  return {
    principal: owner.principal,
    userId: owner.userId,
    byName: owner.byName,
    clock,
    weather,
    calendar,
    daily: new DailyService(deps),
    rec: new RecommendationService(deps),
    trips: new TripService(deps),
    cmd: (command, extra = {}) => ok(owner.principal, command, extra, { now: clock.now }),
  };
}

export function names(ctxById: Map<string, { name: string }>, ids: string[]): string[] {
  return ids.map((id) => ctxById.get(id)?.name ?? id);
}
