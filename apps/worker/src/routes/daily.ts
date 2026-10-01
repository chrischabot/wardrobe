import { LocalDate } from "@garderobe/contracts";
import { ClientRequest, RecommendRequest, TemperaturePreviewQuery, TodayQuery, WeatherQuery } from "@garderobe/contracts/ext/api";
import type { TodayView } from "@garderobe/contracts/ext/daily";
import { getOwnerState, toInstant, type Principal } from "@garderobe/domain";
import { requireDaily, type App } from "../app.ts";
import { ApiException } from "../errors.ts";
import { html, json, readJson, readQuery } from "../http.ts";
import { owner, type RouteDef } from "../router.ts";
import { readService } from "./core.ts";

type Freshness = { source: "wardrobe" | "style" | "weather" | "calendar" | "board" | "media"; state: "fresh" | "stale" | "unavailable" | "not_connected"; checkedAt: string | null; revision: number | null; detail: string | null };

const CALENDAR_STATE: Record<string, Freshness["state"]> = { ok: "fresh", stale: "stale", not_connected: "not_connected", error: "unavailable", not_read: "unavailable" };

/**
 * `GET /v1/today` and MCP `garderobe_today`: the daily service's view, unchanged, with API-level
 * status and a freshness list that says plainly when the board was built on older state.
 */
export async function readToday(app: App, principal: Principal, query: { date?: string; scope?: string }) {
  const daily = requireDaily(app, "the daily board");
  const [view, state]: [TodayView, { wardrobeRevision: number; styleRevision: number }] = await Promise.all([daily.today(principal, query), getOwnerState(app.db, principal)]);
  const freshness: Freshness[] = [];
  const board = view.board;
  if (board) {
    const f = board.freshness;
    freshness.push({ source: "board", state: "fresh", checkedAt: board.publishedAt, revision: board.revision, detail: board.notice });
    // The daily service revalidates open boards inside the commit of every wardrobe change (repair), so a
    // served board is always consistent with the ledger; the revision shown is the current one.
    freshness.push({ source: "wardrobe", state: "fresh", checkedAt: board.publishedAt, revision: state.wardrobeRevision, detail: board.changes.length > 0 ? board.changes.join(" ") : null });
    freshness.push({ source: "style", state: f.styleRevision === state.styleRevision ? "fresh" : "stale", checkedAt: board.publishedAt, revision: f.styleRevision, detail: f.styleRevision === state.styleRevision ? null : "Your style settings changed after this board was published." });
    freshness.push({ source: "weather", state: f.weather, checkedAt: f.weatherFetchedAt, revision: null, detail: f.weather === "fresh" ? null : f.weather === "stale" ? "The forecast is older than usual." : "No usable forecast." });
    freshness.push({ source: "calendar", state: CALENDAR_STATE[f.calendar] ?? "unavailable", checkedAt: f.calendarReadAt, revision: null, detail: f.calendar === "not_connected" ? "Calendar is not connected." : f.calendar === "error" ? "Calendar could not be read." : null });
  }
  const status = board ? "ready" : view.paused ? "paused" : "none";
  return { ...view, status, freshness, runId: null, wardrobeRevision: state.wardrobeRevision };
}

export async function runRecommendation(app: App, principal: Principal, input: { clientRequestId: string; date?: string; brief?: string; count?: number; lockedGarmentIds: string[]; occasionOnly: boolean; mode: "preview" | "board" }) {
  const daily = requireDaily(app, "recommendations");
  const result = await daily.recommend(principal, input);
  const state = await getOwnerState(app.db, principal);
  const localDate = result.board?.localDate ?? input.date ?? (await daily.today(principal, {})).localDate;
  return { state: "completed" as const, runId: null, localDate, options: result.options, board: result.board, insufficient: result.insufficient, note: result.note, wardrobeRevision: state.wardrobeRevision, readAt: toInstant(app.now()) };
}

export function dailyRoutes(): RouteDef[] {
  const board = async (app: App, principal: Principal, date: string | undefined) => {
    const body = await requireDaily(app, "the web board").boardHtml(principal, { ...(date ? { date } : {}), baseUrl: app.config.appOrigin });
    return html(body);
  };
  return [
    owner("GET", "/v1/today", "read", async ({ app, session, url }) => json(await readToday(app, session.principal, readQuery(url, TodayQuery)))),

    owner("POST", "/v1/recommendations", "write", async ({ app, session, request }) => json(await runRecommendation(app, session.principal, await readJson(request, RecommendRequest)))),

    owner("GET", "/v1/weather", "read", async ({ app, session, url }) => json(await requireDaily(app, "weather").weather(session.principal, readQuery(url, WeatherQuery).date))),

    owner("GET", "/v1/service", "read", async ({ app, session }) => {
      requireDaily(app, "the daily service state");
      return json(await readService(app, session.principal));
    }),

    owner("GET", "/v1/trips", "read", async ({ app, session }) => json({ trips: await requireDaily(app, "trips").trips(session.principal) })),

    owner("GET", "/v1/trips/{id}", "read", async ({ app, session, params }) => json(await requireDaily(app, "trips").trip(session.principal, params.id!))),

    owner("POST", "/v1/trips/{id}/packing-proposal", "write", async ({ app, session, params, request }) => {
      const { clientRequestId } = await readJson(request, ClientRequest);
      return json(await requireDaily(app, "trip packing").proposePacking(session.principal, { tripId: params.id!, clientRequestId }));
    }),

    owner("GET", "/v1/wardrobe/temperature-preview", "read", async ({ app, session, url }) =>
      json(await requireDaily(app, "the temperature preview").temperaturePreview(session.principal, readQuery(url, TemperaturePreviewQuery).temperatureC)),
    ),

    owner("GET", "/board", "read", async ({ app, session }) => board(app, session.principal, undefined)),

    owner("GET", "/board/{date}", "read", async ({ app, session, params }) => {
      const date = LocalDate.safeParse(params.date);
      if (!date.success) throw new ApiException("invalid_command", "the date must be written YYYY-MM-DD");
      return board(app, session.principal, date.data);
    }),
  ];
}
