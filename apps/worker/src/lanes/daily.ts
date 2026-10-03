import {
  createGoogleCalendar,
  createOpenMeteoGeocoder,
  createOpenMeteoProvider,
  decisionContext,
  swapSlot,
  exportDailyData,
  getPauseState,
  getToday,
  getTrip,
  importDailyData,
  listTrips,
  proposePacking,
  prepareBoard,
  recommend,
  registerDaily,
  renderBoardHtml,
  replenishBoards,
  runDueJobs,
  temperaturePreview,
  weatherForecast,
  type DailyDeps,
} from "@garderobe/daily";
import { createCompositionModel, createGatewayModelService, listComfortFeedback } from "@garderobe/assistant";
import { addDays, all, createPrincipal, first, getSettings, localDateOf, prepare, stmt, toInstant, type Principal } from "@garderobe/domain";
import { googleAccessToken } from "../connections/service.ts";
import { ApiException } from "../errors.ts";
import type { DailyPort } from "../ports.ts";
import type { LaneContext } from "./index.ts";

/**
 * The daily service, mounted. Weather comes from Open-Meteo; Calendar reading and writing use the
 * owner's Google connection through this workstream's credential vault, each with its own capability
 * (a missing or revoked grant yields `null`, which the daily service reports as "not connected").
 *
 * Composition: every board is composed with the assistant workstream's composition model through AI
 * Gateway, budgeted to the owner it is for (`modelFor`), in requests and in the scheduled sweep alike.
 * It yields no candidates on budget exhaustion, outage or when no model profile has passed its probes,
 * and the daily service's deterministic composer then fills the board. The owner's comfort observations
 * are read from the assistant's store.
 */
export type CompositionModel = NonNullable<DailyDeps["model"]>;

export interface DailyPortOptions {
  /**
   * How the composition model for one owner is built. Default: the assistant workstream's model service
   * through AI Gateway when the AI binding and gateway are configured, otherwise none.
   */
  compositionModelFor?: (principal: Principal) => CompositionModel | null;
}

/** How long after a resume its board is still prepared by the scheduled sweep when the first attempt did not finish. */
const RESUME_FOLLOW_UP_MS = 3 * 3600_000;

/**
 * The day whose board a resume is to prepare, fixed by the moment of the resume: that day when the owner
 * resumed before midday in their timezone, otherwise the day after (the daily service's rule for the next
 * useful board). It never moves with the time at which the follow-up happens to run.
 */
export function resumeTargetDay(resumedAtMs: number, timezone: string): string {
  const day = localDateOf(resumedAtMs, timezone);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(new Date(resumedAtMs)));
  return hour < 12 ? day : addDays(day, 1);
}

export function createDailyPort(ctx: LaneContext, options: DailyPortOptions = {}): DailyPort {
  const { env, db } = ctx;
  const outbound = ((input: string, init?: RequestInit) => fetch(input, init)) as never;
  const calendarBase = env.GOOGLE_API_BASE_URL ? `${env.GOOGLE_API_BASE_URL.replace(/\/+$/, "")}/calendar/v3` : undefined;
  const reader = createGoogleCalendar({ fetch: outbound, getAccessToken: (userId) => googleAccessToken(env, db, userId, "calendar.read", ctx.now()), ...(calendarBase ? { baseUrl: calendarBase } : {}) });
  const writer = createGoogleCalendar({ fetch: outbound, getAccessToken: (userId) => googleAccessToken(env, db, userId, "calendar.write_outfit_calendar", ctx.now()), ...(calendarBase ? { baseUrl: calendarBase } : {}) });
  const gatewayModelFor = (principal: Principal): CompositionModel | null => {
    if (!env.AI || !env.AI_GATEWAY_ID) return null;
    try {
      return createCompositionModel(createGatewayModelService({ DB: env.DB, AI: env.AI as never, AI_GATEWAY_ID: env.AI_GATEWAY_ID, ENVIRONMENT: env.ENVIRONMENT }, ctx.service, ctx.now), { userId: principal.userId }) as never;
    } catch (error) {
      // A gateway that is not one of this deployment's is a configuration error, not a reason to fail the request.
      console.warn("composition model unavailable", String((error as Error)?.message ?? error));
      return null;
    }
  };
  const deps: DailyDeps = {
    db,
    commands: ctx.service,
    clock: ctx.now,
    weather: { provider: createOpenMeteoProvider({ fetch: outbound, now: ctx.now }), geocoder: createOpenMeteoGeocoder({ fetch: outbound }) },
    calendar: { reader, writer },
    modelFor: options.compositionModelFor ?? gatewayModelFor,
    comfort: (principal) => listComfortFeedback(db, principal) as never,
    // The Calendar event links to the day's board on this deployment unless the owner set another address.
    boardBaseUrl: env.APP_ORIGIN,
  };

  /**
   * "On resume ... prepare the next useful board" (specification section 9), for a pause that the owner
   * (in the app, by confirming a request, or in conversation) ended with the plain `service.resume`
   * command, whose receipt says the next board is being prepared. An automatic resume on the date the
   * owner set goes through the daily service's own `resumeService` and is not handled here.
   *
   * The steps are those `resumeService` takes after the command: the weekly cleanliness baselines that
   * elapsed during the pause, then the next useful board, composed by the daily service's `prepareBoard`.
   * The day is fixed by the moment of the resume (`resumeTargetDay`) and claimed once per resume in
   * `resume_followups` before anything is composed, so every run for that resume works on the same day. A board that already exists for
   * that day (prepared before the pause, or made by the owner since) is the next useful board and is left
   * as it is: the resume command restores its Calendar event, the ordinary refresh and repair keep it
   * current, and the scheduled sweep applies due weekly baselines as always. Both steps run as the system
   * for that owner and carry keys derived from the resume command, so running this again writes nothing
   * twice. Until the day has a board the scheduled sweep tries again for a few hours, so a follow-up that
   * was cut short is not lost and a resume made in conversation is covered too. Nothing from the paused
   * days is prepared.
   */
  const followUpResumes = async (nowMs: number, userId?: string): Promise<void> => {
    // Each owner's latest resume inside the window, when the owner is not paused again. Not truncated: the
    // window bounds it, and a resume whose day already has a board costs one read.
    const ended = await all<{ user_id: string; command_id: string; ended_at: string }>(
      db,
      `SELECT p.user_id, p.ended_by_command_id AS command_id, p.ended_at FROM service_pauses p
         JOIN commands c ON c.user_id = p.user_id AND c.command_id = p.ended_by_command_id AND c.actor != 'system'
        WHERE p.status = 'ended' AND unixepoch(p.ended_at) > ? AND (? IS NULL OR p.user_id = ?)
          AND NOT EXISTS (SELECT 1 FROM service_pauses a WHERE a.user_id = p.user_id AND a.status = 'active')
          AND NOT EXISTS (SELECT 1 FROM service_pauses l WHERE l.user_id = p.user_id AND l.status = 'ended' AND (unixepoch(l.ended_at) > unixepoch(p.ended_at) OR (unixepoch(l.ended_at) = unixepoch(p.ended_at) AND l.pause_id > p.pause_id)))`,
      Math.floor((nowMs - RESUME_FOLLOW_UP_MS) / 1000), userId ?? null, userId ?? null,
    );
    for (const pause of ended) {
      try {
        const system = createPrincipal({ userId: pause.user_id, actor: "system", channel: "system", scopes: ["read", "write"], authRef: `daily:resume:${pause.command_id}` });
        // The day is claimed once per resume, before anything is composed (migration 0305): the first run
        // writes it and every other run, overlapping or later, reads the same day, whatever the time of the
        // retry and whatever the owner's timezone has become since.
        const computed = resumeTargetDay(Date.parse(pause.ended_at), (await getSettings(db, system)).settings.timezone);
        await prepare(db, stmt("INSERT INTO resume_followups (user_id, resume_command_id, local_date, claimed_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, resume_command_id) DO NOTHING", pause.user_id, pause.command_id, computed, toInstant(nowMs))).run();
        const localDate = (await first<{ local_date: string }>(db, "SELECT local_date FROM resume_followups WHERE user_id = ? AND resume_command_id = ?", pause.user_id, pause.command_id))!.local_date;
        // Followed up already: the day has its board (prepared before the pause, by this follow-up, or by the owner).
        if (await first(db, "SELECT 1 AS x FROM boards WHERE user_id = ? AND local_date = ? AND scope = 'home'", pause.user_id, localDate)) continue;
        await ctx.service.execute(system, { type: "laundry.apply_weekly_reset", payload: {}, idempotencyKey: `resume-weekly-reset:${pause.command_id}`, expectedVersions: {}, authorization: "standing_policy", source: { channel: "system" } });
        // One key per resume and one day per resume: overlapping runs publish at most once.
        await prepareBoard(deps, system, { localDate, reason: "compose", purpose: "resume", idempotencyKey: `resume-board:${pause.command_id}:${localDate}`, nowMs });
      } catch (error) {
        console.warn("the board after a resume was not prepared; the scheduled sweep tries again", String((error as Error)?.message ?? error));
      }
    }
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
    swapSlot: (principal, input) => swapSlot(deps, principal, { ...input, role: input.role as never, nowMs: ctx.now() }),
    decisionContext: async (principal, input) => (await decisionContext(deps, principal, { ...input, outfit: input.outfit as never, role: input.role as never, nowMs: ctx.now() })) as unknown as Record<string, unknown>,
    proposePacking: (principal, input) => proposePacking(deps, principal, input),
    temperaturePreview: (principal, temperatureC) => temperaturePreview(db, principal, { temperatureC, nowMs: ctx.now() }),
    weather: async (principal, date) => {
      const localDate = date ?? localDateOf(ctx.now(), (await getSettings(db, principal)).settings.timezone);
      return weatherForecast(deps, principal, { localDate }, { nowMs: ctx.now() });
    },
    boardHtml: (principal, input) => renderBoardHtml(db, principal, { ...(input.date ? { date: input.date } : {}), baseUrl: input.baseUrl, nowMs: ctx.now() }),
    afterCommit: async (principal) => {
      if (principal.scopes.includes("write") || principal.scopes.includes("admin")) {
        await followUpResumes(ctx.now(), principal.userId).catch((error) => console.warn("resume follow-up failed", String((error as Error)?.message ?? error)));
        await replenishBoards(deps, principal, { nowMs: ctx.now() });
      }
    },
    scheduled: async (nowMs) => {
      await followUpResumes(nowMs).catch((error) => console.warn("resume follow-up failed", String((error as Error)?.message ?? error)));
      return runDueJobs(deps, { nowMs });
    },
    exportData: (principal) => exportDailyData(db, principal),
    importData: (principal, data) => importDailyData(db, principal, data as never),
  };
}
