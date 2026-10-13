import { LocalDate } from "@garderobe/contracts";
import { ClientRequest, RecommendRequest, SwapSlotRequest, TemperaturePreviewQuery, TodayQuery, WeatherQuery } from "@garderobe/contracts/ext/api";
import type { TodayView } from "@garderobe/contracts/ext/daily";
import { getOwnerState, toInstant, type Principal } from "@garderobe/domain";
import { requireDaily, type App } from "../app.ts";
import { ApiException } from "../errors.ts";
import { html, json, readJson, readQuery } from "../http.ts";
import { owner, type RouteDef } from "../router.ts";
import { createApiRun, findApiRun, finishApiRun } from "../runs.ts";
import { afterCommit } from "../app.ts";
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

type RecommendInput = { clientRequestId: string; date?: string; brief?: string; count?: number; lockedGarmentIds: string[]; occasionOnly: boolean; mode: "preview" | "board" };

/** How long a recommendation may take inside its request before it continues as a durable run. */
export const RECOMMEND_INLINE_MS = 20_000;

/**
 * `POST /v1/recommendations` and MCP `garderobe_recommend` (specification section 13: "validated
 * options or a durable run ID"). Composition normally finishes inside the request. When it takes longer
 * than the inline budget (a slow model), the request answers `running` with a run ID, the work goes on
 * in the background, and the result is read from the run; nothing depends on the connection staying
 * open. Repeating the same request ID returns that run's state or result, never a second composition.
 */
export async function runRecommendation(app: App, principal: Principal, input: RecommendInput, exec: ExecutionContext, inlineMs?: number) {
  const daily = requireDaily(app, "recommendations");
  const budget = inlineMs ?? (app.env.RECOMMEND_INLINE_MS && /^\d+$/.test(app.env.RECOMMEND_INLINE_MS) ? Number(app.env.RECOMMEND_INLINE_MS) : RECOMMEND_INLINE_MS);
  const readAt = () => toInstant(app.now());
  const revision = async () => (await getOwnerState(app.db, principal)).wardrobeRevision;
  const fallbackDate = async () => input.date ?? (await daily.today(principal, {})).localDate;

  const earlier = await findApiRun(app.db, principal.userId, "recommendation", input.clientRequestId);
  if (earlier) {
    if (earlier.state === "failed" || earlier.state === "cancelled") throw new ApiException("precondition_failed", "that recommendation did not finish; ask again with a new request ID", { runId: earlier.runId, state: earlier.state });
    const stored = (earlier.result ?? {}) as Record<string, unknown>;
    const done = earlier.state === "completed";
    return {
      state: done ? ("completed" as const) : ("running" as const),
      runId: earlier.runId,
      localDate: typeof stored.localDate === "string" ? stored.localDate : await fallbackDate(),
      options: done ? earlier.result!.options : [],
      board: done ? earlier.result!.board : null,
      insufficient: stored.insufficient === true,
      note: done ? ((stored.note as string | null | undefined) ?? null) : "Still composing. Read the run for the result.",
      wardrobeRevision: await revision(),
      readAt: readAt(),
    };
  }

  const work = daily.recommend(principal, input);
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A budget of zero means "always as a run": the answer is the run handle and the work goes on in the background.
  const first = budget <= 0 ? ("slow" as const) : await Promise.race([work, new Promise<"slow">((resolve) => (timer = setTimeout(() => resolve("slow"), budget)))]).finally(() => clearTimeout(timer));
  if (first !== "slow") {
    const localDate = first.board?.localDate ?? (await fallbackDate());
    return { state: "completed" as const, runId: null, localDate, options: first.options, board: first.board, insufficient: first.insufficient, note: first.note, wardrobeRevision: await revision(), readAt: readAt() };
  }

  const localDate = await fallbackDate();
  const run = await createApiRun(app.db, { userId: principal.userId, kind: "recommendation", clientRequestId: input.clientRequestId, request: input, channel: principal.channel, nowMs: app.now() });
  exec.waitUntil(
    work.then(
      async (result) => {
        await finishApiRun(app.db, principal.userId, run.runId, { state: "completed", result: { options: result.options, board: result.board, insufficient: result.insufficient, note: result.note, localDate: result.board?.localDate ?? localDate } }, app.now());
        if (result.board) await afterCommit(app, principal);
      },
      async (error) => {
        console.error("recommendation run failed", String((error as Error)?.message ?? error));
        await finishApiRun(app.db, principal.userId, run.runId, { state: "failed", error: { code: "internal", message: "The recommendation could not be completed. Ask again.", resumable: false } }, app.now());
      },
    ),
  );
  return { state: "running" as const, runId: run.runId, localDate, options: [], board: null, insufficient: false, note: "Still composing. Read the run for the result.", wardrobeRevision: await revision(), readAt: readAt() };
}

export function dailyRoutes(): RouteDef[] {
  const board = async (app: App, principal: Principal, date: string | undefined) => {
    const body = await requireDaily(app, "the web board").boardHtml(principal, { ...(date ? { date } : {}), baseUrl: app.config.appOrigin });
    return html(body);
  };
  return [
    owner("GET", "/v1/today", "read", async ({ app, session, url }) => json(await readToday(app, session.principal, readQuery(url, TodayQuery)))),

    owner("POST", "/v1/recommendations", "write", async ({ app, session, request, exec }) => json(await runRecommendation(app, session.principal, await readJson(request, RecommendRequest), exec))),

    // A slot swap goes through the daily service so an old forecast is refreshed before the swap is validated.
    owner("POST", "/v1/boards/{id}/swap", "write", async ({ app, session, params, request, exec }) => {
      const body = await readJson(request, SwapSlotRequest);
      const result = await requireDaily(app, "board edits").swapSlot(session.principal, { boardId: params.id!, optionId: body.optionId, role: body.role, clientRequestId: body.clientRequestId, ...(body.garmentId ? { garmentId: body.garmentId } : {}), ...(body.expectedRevision !== undefined ? { expectedRevision: body.expectedRevision } : {}) });
      if (!result.receipt.replayed) exec.waitUntil(afterCommit(app, session.principal));
      return json(result);
    }),

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
