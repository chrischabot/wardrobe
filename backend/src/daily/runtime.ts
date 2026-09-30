import { systemPrincipal } from '../domain/principal.js';
import type { Env } from '../env.js';
import type { CalendarSource, ManagedEventStore } from '../calendar/types.js';
import { OpenMeteoProvider } from '../weather/open-meteo.js';
import type { WeatherProvider } from '../weather/types.js';
import type { CandidateProposer } from '../recommend/compose.js';
import type { ProseWriter } from '../recommend/document.js';
import { DailyService, type DailyServiceDeps } from './service.js';

/**
 * Runtime wiring for scheduled work (Workflow, cron sweep) and for the API/MCP layer.
 * Defaults: Open-Meteo (keyless, spec section 7) for weather; no Calendar until the connections
 * workstream supplies a Google adapter (then pass `calendar`/`calendarStore`, e.g. a
 * `GoogleCalendarAdapter` with an access-token provider). A missing Calendar is reported as
 * "not connected", never as an empty day.
 */
export interface DailyRuntimeOverrides {
  weather?: WeatherProvider | null;
  calendar?: CalendarSource | null;
  calendarStore?: ManagedEventStore | null;
  calendarId?: string;
  prose?: ProseWriter | null;
  proposer?: CandidateProposer | null;
  boardBaseUrl?: string;
  clock?: () => string;
}

export function createDailyService(env: Pick<Env, 'DB'>, userId: string, overrides: DailyRuntimeOverrides = {}): DailyService {
  const deps: DailyServiceDeps = {
    db: env.DB,
    principal: systemPrincipal(userId),
    weather: overrides.weather === undefined ? new OpenMeteoProvider() : overrides.weather,
    calendar: overrides.calendar ?? null,
    calendarStore: overrides.calendarStore ?? null,
    calendarId: overrides.calendarId,
    prose: overrides.prose ?? null,
    proposer: overrides.proposer ?? null,
    boardBaseUrl: overrides.boardBaseUrl,
    clock: overrides.clock,
  };
  return new DailyService(deps);
}
