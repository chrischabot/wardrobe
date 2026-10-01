/**
 * Test support for the daily service and for other workstreams' suites.
 *
 * `createDailyHarness()` is the foundation harness (REAL command service on REAL local D1 in workerd)
 * with the daily commands and the board-repair hook registered. The only stand-ins are the labelled
 * fakes at the adapter boundary: `FakeWeatherProvider` / `FakeGeocoder` for the weather HTTP service
 * and `FakeGoogleCalendar` for the Google Calendar HTTP service.
 */
import { createFoundationRegistry } from "@garderobe/domain";
import { createHarness, type Harness } from "@garderobe/domain/testing";
import type { DailyDeps } from "../deps.ts";
import { registerDaily } from "../index.ts";
import type { CompositionModel } from "../ports.ts";
import { FakeGoogleCalendar } from "./fake-calendar.ts";
import { FakeGeocoder, FakeWeatherProvider } from "./fake-weather.ts";
import { REVISION_PROPERTY } from "../calendar/projector.ts";

export * from "./fake-calendar.ts";
export * from "./fake-weather.ts";

export interface DailyHarness extends Harness {
  deps: DailyDeps;
  /** TEST FAKE weather provider (adapter boundary). */
  weather: FakeWeatherProvider;
  geocoder: FakeGeocoder;
  /** TEST FAKE Google Calendar (adapter boundary). */
  calendar: FakeGoogleCalendar;
}

export async function createDailyHarness(opts: { startAt?: string; model?: CompositionModel | null; calendarConnected?: boolean; isolate?: boolean } = {}): Promise<DailyHarness> {
  const registry = createFoundationRegistry();
  registerDaily(registry);
  const h = await createHarness({ registry, startAt: opts.startAt });
  if (opts.isolate) {
    // The local D1 database is shared by the tests of one file. Sweeps and the projector work across
    // ALL owners, so a test that drives them first retires the owners and pending effects that earlier
    // tests left behind (their data stays; their accounts are simply disabled).
    await h.db.batch([h.db.prepare("UPDATE users SET status = 'disabled' WHERE status = 'active'"), h.db.prepare("UPDATE effects SET state = 'cancelled' WHERE state IN ('pending', 'in_progress')"), h.db.prepare("DELETE FROM weather_cache")]);
  }
  const weather = new FakeWeatherProvider({ now: h.clock.now });
  const geocoder = new FakeGeocoder();
  const calendar = new FakeGoogleCalendar({ revisionProperty: REVISION_PROPERTY });
  const connected = opts.calendarConnected !== false;
  const deps: DailyDeps = { db: h.db, commands: h.service, clock: h.clock.now, weather: { provider: weather, geocoder }, calendar: { reader: connected ? calendar : null, writer: connected ? calendar : null }, model: opts.model ?? null };
  return { ...h, deps, weather, geocoder, calendar };
}

/** Settings patch every daily test owner needs: a home city (London) and a chosen outfit calendar. */
export const TEST_DAILY_SETTINGS = {
  homeLocation: { label: "London", latitude: 51.5085, longitude: -0.1257 },
  extensions: { daily: { calendar: { outfitCalendarId: "outfits@test.calendar", readCalendarIds: ["primary"] } } },
};
