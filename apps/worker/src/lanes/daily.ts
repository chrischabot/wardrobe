import {
  createGoogleCalendar,
  createOpenMeteoGeocoder,
  createOpenMeteoProvider,
  exportDailyData,
  getPauseState,
  getToday,
  getTrip,
  importDailyData,
  listTrips,
  proposePacking,
  recommend,
  registerDaily,
  renderBoardHtml,
  replenishBoards,
  runDueJobs,
  temperaturePreview,
  weatherForecast,
  type DailyDeps,
} from "@garderobe/daily";
import { getSettings, localDateOf } from "@garderobe/domain";
import { googleAccessToken } from "../connections/service.ts";
import { ApiException } from "../errors.ts";
import type { DailyPort } from "../ports.ts";
import type { LaneContext } from "./index.ts";

/**
 * The daily service, mounted. Weather comes from Open-Meteo; Calendar reading and writing use the
 * owner's Google connection through this workstream's credential vault, each with its own capability
 * (a missing or revoked grant yields `null`, which the daily service reports as "not connected").
 */
export function createDailyPort(ctx: LaneContext): DailyPort {
  const { env, db } = ctx;
  const outbound = ((input: string, init?: RequestInit) => fetch(input, init)) as never;
  const calendarBase = env.GOOGLE_API_BASE_URL ? `${env.GOOGLE_API_BASE_URL.replace(/\/+$/, "")}/calendar/v3` : undefined;
  const reader = createGoogleCalendar({ fetch: outbound, getAccessToken: (userId) => googleAccessToken(env, db, userId, "calendar.read", ctx.now()), ...(calendarBase ? { baseUrl: calendarBase } : {}) });
  const writer = createGoogleCalendar({ fetch: outbound, getAccessToken: (userId) => googleAccessToken(env, db, userId, "calendar.write_outfit_calendar", ctx.now()), ...(calendarBase ? { baseUrl: calendarBase } : {}) });
  const deps: DailyDeps = {
    db,
    commands: ctx.service,
    clock: ctx.now,
    weather: { provider: createOpenMeteoProvider({ fetch: outbound, now: ctx.now }), geocoder: createOpenMeteoGeocoder({ fetch: outbound }) },
    calendar: { reader, writer },
    model: null,
  };
  return {
    register: registerDaily,
    today: (principal, query) => getToday(db, principal, { ...(query.date ? { date: query.date } : {}), ...(query.scope ? { scope: query.scope } : {}), nowMs: ctx.now() }),
    recommend: async (principal, input) => {
      const result = await recommend(deps, principal, {
        clientRequestId: input.clientRequestId,
        ...(input.date ? { date: input.date } : {}),
        ...(input.brief ? { brief: { text: input.brief } } : {}),
        ...(input.count ? { count: input.count } : {}),
        lockedGarmentIds: input.lockedGarmentIds,
        occasionOnly: input.occasionOnly,
        mode: input.mode,
      });
      return { options: result.options, board: result.board, insufficient: result.insufficient, note: result.note };
    },
    trips: (principal) => listTrips(db, principal),
    trip: async (principal, tripId) => {
      const trip = await getTrip(db, principal, tripId);
      if (!trip) throw new ApiException("not_found", "that trip was not found");
      return trip;
    },
    pause: (principal) => getPauseState(db, principal),
    proposePacking: (principal, input) => proposePacking(deps, principal, input),
    temperaturePreview: (principal, temperatureC) => temperaturePreview(db, principal, { temperatureC, nowMs: ctx.now() }),
    weather: async (principal, date) => {
      const localDate = date ?? localDateOf(ctx.now(), (await getSettings(db, principal)).settings.timezone);
      return weatherForecast(deps, principal, { localDate }, { nowMs: ctx.now() });
    },
    boardHtml: (principal, input) => renderBoardHtml(db, principal, { ...(input.date ? { date: input.date } : {}), baseUrl: input.baseUrl, nowMs: ctx.now() }),
    afterCommit: async (principal) => {
      if (principal.scopes.includes("write") || principal.scopes.includes("admin")) await replenishBoards(deps, principal, { nowMs: ctx.now() });
    },
    scheduled: (nowMs) => runDueJobs(deps, { nowMs }),
    exportData: (principal) => exportDailyData(db, principal),
    importData: (principal, data) => importDailyData(db, principal, data as never),
  };
}
