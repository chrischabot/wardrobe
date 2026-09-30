import { installApiTestOverrides } from '../../../backend/src/api/services.js';
import { FakeWeatherProvider, type FakeWeatherOptions } from '../../../backend/src/weather/fake.js';
import { FakeCalendar } from '../../../backend/src/calendar/fake.js';

/**
 * The simulated world around the Worker: a controllable clock, weather and calendar. These are the
 * only stand-ins in the journey suite besides the model and the web/Gmail providers (see README):
 * - FakeWeatherProvider stands in for Open-Meteo (named scenarios from spec section 7);
 * - FakeCalendar stands in for Google Calendar (the owner's events; read side only via the API).
 * Everything else — routing, auth, D1, commands, composition, validation — is the real Worker code.
 */

export class Clock {
  constructor(public value: string) {}
  now = (): string => this.value;
  set(iso: string): void {
    this.value = new Date(iso).toISOString();
  }
  advanceMinutes(n: number): void {
    this.value = new Date(Date.parse(this.value) + n * 60_000).toISOString();
  }
  advanceDays(n: number): void {
    this.advanceMinutes(n * 24 * 60);
  }
}

export interface World {
  clock: Clock;
  weather: FakeWeatherProvider;
  calendar: FakeCalendar | null;
}

export interface WorldOptions {
  /** UTC instant; default Tuesday 6 October 2026, 06:30 London (BST). */
  now?: string;
  weather?: FakeWeatherOptions;
  /** Connect a fake owner calendar (default false: calendar not connected). */
  calendar?: boolean;
}

export function installWorld(opts: WorldOptions = {}): World {
  const clock = new Clock(opts.now ?? '2026-10-06T05:30:00.000Z');
  const weather = new FakeWeatherProvider({ scenario: 'mild', clock: clock.now, ...opts.weather });
  const calendar = opts.calendar ? new FakeCalendar(clock.now) : null;
  installApiTestOverrides({ weather, calendar, clock: clock.now });
  return { clock, weather, calendar };
}

/** Switches the weather scenario (a new provider identity, so the shared cache never serves old conditions). */
export function setWeather(world: World, options: Partial<FakeWeatherOptions>): void {
  world.weather.set(options);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 06:30 London on a local date in October 2026 (BST, UTC+1 until 25 October). */
export function morningOf(date: string, hhmm = '06:30'): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const bst = date < '2026-10-25';
  const utcH = h - (bst ? 1 : 0);
  return new Date(`${date}T${String(utcH).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`).toISOString();
}
