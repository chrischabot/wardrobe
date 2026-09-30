import { env } from 'cloudflare:workers';
import type { DomainCommandInput } from '@garderobe/contracts';
import { FakeCalendar } from '../../../backend/src/calendar/fake.js';
import { DailyService, type DailyServiceDeps } from '../../../backend/src/daily/service.js';
import { RecommendationService } from '../../../backend/src/recommend/service.js';
import { TripService } from '../../../backend/src/trips/service.js';
import { FakeWeatherProvider, type FakeWeatherOptions } from '../../../backend/src/weather/fake.js';
import type { CandidateProposer } from '../../../backend/src/recommend/compose.js';
import type { ProseWriter } from '../../../backend/src/recommend/document.js';
import type { Principal } from '../../../backend/src/domain/principal.js';
import { newOwner, ok, run, type Owner } from './seed.js';

/**
 * The daily service over the owner's real wardrobe. FakeWeatherProvider stands in for Open-Meteo and
 * FakeCalendar for Google Calendar; composition, validation and publication are the real code.
 */

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

export interface Scenario extends Owner {
  clock: TestClock;
  weather: FakeWeatherProvider;
  calendar: FakeCalendar;
  deps: DailyServiceDeps;
  daily: DailyService;
  rec: RecommendationService;
  trips: TripService;
  cmd: (command: DomainCommandInput, extra?: Record<string, unknown>) => ReturnType<typeof ok>;
  tryCmd: (command: DomainCommandInput, extra?: Record<string, unknown>) => ReturnType<typeof run>;
  /** A recommendation service with a hostile proposer / prose writer injected. */
  withModel: (m: { proposer?: CandidateProposer | null; prose?: ProseWriter | null }) => RecommendationService;
  as: (principal: Principal) => RecommendationService;
}

export async function ownerScenario(opts: { now?: string; weather?: FakeWeatherOptions; calendarConnected?: boolean; owner?: Owner } = {}): Promise<Scenario> {
  const owner = opts.owner ?? (await newOwner());
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
  };
  return {
    ...owner,
    clock,
    weather,
    calendar,
    deps,
    daily: new DailyService(deps),
    rec: new RecommendationService(deps),
    trips: new TripService(deps),
    cmd: (command, extra = {}) => ok(owner.principal, command, extra, { now: clock.now }),
    tryCmd: (command, extra = {}) => run(owner.principal, command, extra, { now: clock.now }),
    withModel: (m) => new RecommendationService({ ...deps, proposer: m.proposer ?? null, prose: m.prose ?? null }),
    as: (principal) => new RecommendationService({ ...deps, principal }),
  };
}
