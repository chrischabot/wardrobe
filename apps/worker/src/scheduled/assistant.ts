/**
 * Scheduled work the assistant workstream hands to the composition root, because the credential store,
 * the calendar writer and the sweep live here:
 *
 *  - background jobs (`assistant.run_job` effects; mailbox investigations and sheet-import previews)
 *    run by the assistant's own idempotent runner, with the owner's Google grant resolved per request;
 *  - connection health (specification section 15): each connected service is probed once before the
 *    evening composition and once before the morning delivery, the result is recorded through the shared
 *    command service, and a rejected credential becomes the one reconnect state;
 *  - `calendar.project_reminder` effects: a reminder set in conversation is written as one managed
 *    event on the owner's dedicated outfit calendar (the only calendar the backend may write), read
 *    back before it is recorded as projected, updated in place when the reminder changes and deleted
 *    when it is removed.
 *
 * None of this decides anything about a job, a connection or a reminder: those rules are the
 * assistant's. Google is reached through the daily service's calendar adapter and the assistant's
 * typed Google adapters; nothing here builds a Google request of its own.
 */
import {
  ASSISTANT_JOB_KINDS,
  ConnectionError,
  GOOGLE_SCOPES,
  GoogleApi,
  ModelService,
  checkConnectionHealth,
  createGatewayModelService,
  createGmailSource,
  createSheetsClient,
  googleProbe,
  listReminders,
  runAssistantJob,
  runPendingAssistantJobs,
  type AssistantJobDeps,
  type HealthCheckResult,
  type SheetsClient,
} from "@garderobe/assistant";
import { DailySettings } from "@garderobe/contracts/ext/daily";
import { CalendarApiError, CalendarNotConnectedError, createGoogleCalendar, phaseSchedule, type ManagedEventWrite } from "@garderobe/daily";
import { addDays, all, claimDueEffects, first, getSettings, latestDesiredRevision, localDateOf, prepare, settleEffect, stmt, systemPrincipalFor, toInstant, type EffectRecord } from "@garderobe/domain";
import type { App } from "../app.ts";
import { connectionAuthorization, connectionRejected, connectionState, googleAccessToken, googleGrant } from "../connections/service.ts";
import { probeConnection } from "../connections/outbound.ts";
import { LOCAL_ENVIRONMENTS, type Env } from "../env.ts";

const MAX_ATTEMPTS = 6;
const backoffMs = (attempts: number) => Math.min(60, 2 ** attempts) * 60_000;

/**
 * The assistant's Google adapters only talk to Google's own hosts. In local runs and tests the same
 * request path is served by the labelled fixture named in `GOOGLE_API_BASE_URL`; a deployment always
 * reaches Google.
 */
function googleFetch(env: Env): typeof fetch {
  const base = env.GOOGLE_API_BASE_URL && LOCAL_ENVIRONMENTS.has(env.ENVIRONMENT) ? env.GOOGLE_API_BASE_URL.replace(/\/+$/, "") : null;
  if (!base) return fetch;
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    return fetch(`${base}${url.pathname}${url.search}`, init);
  }) as typeof fetch;
}

/** `<Google connection>_<service>` is how the Google connection appears in the assistant's registry. */
const googleService = (registryId: string, profileId: string, service: string): boolean => registryId === `${profileId}_${service}`;

/* ------------------------------------------------------------------ */
/* Background jobs                                                      */
/* ------------------------------------------------------------------ */

export const JOB_EFFECT_KIND = "assistant.run_job";

function jobDeps(app: App, nowMs: number): AssistantJobDeps {
  const { env, db } = app;
  // Without the AI binding a model call fails inside the job with the assistant's own error and the job
  // settles as failed with that reason; it never runs against an unbudgeted or invented model.
  const models = env.AI
    ? createGatewayModelService({ DB: env.DB, AI: env.AI as never, ...(env.AI_GATEWAY_ID ? { AI_GATEWAY_ID: env.AI_GATEWAY_ID } : {}), ENVIRONMENT: env.ENVIRONMENT }, app.service, app.now)
    : new ModelService({
        db,
        service: app.service,
        gatewayId: env.AI_GATEWAY_ID ?? "unconfigured",
        clock: app.now,
        createLanguageModel: () => {
          throw new Error("no language model is reachable in this deployment (the AI binding is not configured)");
        },
      });
  return {
    db,
    service: app.service,
    models,
    nowMs,
    mailFor: async (userId, connectionId) => {
      const grant = await googleGrant(env, db, userId, "gmail.read_orders", app.now);
      if (!grant || !googleService(connectionId, grant.connectionId, "gmail")) return null;
      return createGmailSource(new GoogleApi({ accessToken: grant.accessToken, grantedScopes: grant.grantedScopes, fetch: googleFetch(env), maxCalls: 400 }));
    },
    sheetsFor: async (userId, connectionId) => {
      const grant = await googleGrant(env, db, userId, "sheets.read_selected", app.now);
      if (!grant || !googleService(connectionId, grant.connectionId, "sheets")) return null;
      // This connection asks Google for read-only access to spreadsheets. The adapter is told about the
      // read it may do; its write operations are refused here, before any request, because the grant
      // could not perform them.
      const readOnly = !grant.grantedScopes.includes(GOOGLE_SCOPES.sheets) && !grant.grantedScopes.includes(GOOGLE_SCOPES.driveFile);
      const sheets = createSheetsClient(new GoogleApi({ accessToken: grant.accessToken, grantedScopes: readOnly ? [...grant.grantedScopes, GOOGLE_SCOPES.sheets] : grant.grantedScopes, fetch: googleFetch(env), maxCalls: 50 }));
      if (!readOnly) return sheets;
      const refuse = async (): Promise<never> => {
        throw new ConnectionError("scope_not_granted", "the owner granted read-only access to spreadsheets");
      };
      return { read: sheets.read, readRecords: sheets.readRecords, write: refuse, create: refuse } satisfies SheetsClient;
    },
  };
}

export interface JobSweepResult {
  effects: { effectId: string; jobId: string; outcome: string }[];
  ran: { userId: string; jobId: string; state: string }[];
}

/**
 * Run queued background jobs. Each `assistant.run_job` effect names one job; the job row is the state, so
 * a job delivered twice starts once. Jobs of a kind another runner owns (research runs in its task actor)
 * are recorded as dispatched once that runner has started them. A final pass picks up any queued job
 * whose effect was lost.
 */
export async function runAssistantJobs(app: App, nowMs: number, limit = 5): Promise<JobSweepResult> {
  const deps = jobDeps(app, nowMs);
  const result: JobSweepResult = { effects: [], ran: [] };
  for (const effect of await claimDueEffects(app.db, { nowMs, kinds: [JOB_EFFECT_KIND], limit, leaseMs: 15 * 60_000 })) {
    const jobId = String(effect.payload.jobId ?? "");
    const done = async (outcome: string, settle: Parameters<typeof settleEffect>[2]) => {
      await settleEffect(app.db, effect, settle, nowMs);
      result.effects.push({ effectId: effect.effectId, jobId, outcome });
    };
    try {
      if ((ASSISTANT_JOB_KINDS as readonly string[]).includes(String(effect.payload.kind ?? ""))) {
        const outcome = await runAssistantJob(deps, effect.userId, jobId);
        if (outcome.handled) {
          result.ran.push({ userId: effect.userId, jobId, state: outcome.state });
          await done(outcome.state, { state: "projected" });
        } else await done(outcome.reason, { state: "cancelled" });
        continue;
      }
      // Not this runner's kind: dispatched once its own runner has taken it out of the queue.
      const job = await first<{ state: string }>(app.db, "SELECT state FROM assistant_jobs WHERE user_id = ? AND job_id = ?", effect.userId, jobId);
      if (!job) await done("no such job", { state: "cancelled" });
      else if (job.state !== "queued") await done(`started elsewhere (${job.state})`, { state: "projected" });
      else if (effect.attempts < MAX_ATTEMPTS) await done("waiting for its runner", { state: "retry", error: "the job has not been started by its runner yet", retryAtMs: nowMs + backoffMs(effect.attempts) });
      else await done("never started", { state: "failed" });
    } catch (error) {
      console.error("background job failed to run", String((error as Error)?.message ?? error).slice(0, 200));
      if (effect.attempts < MAX_ATTEMPTS) await done("error", { state: "retry", error: "the job runner raised an error", retryAtMs: nowMs + backoffMs(effect.attempts) });
      else await done("error", { state: "failed" });
    }
  }
  const stragglers = await runPendingAssistantJobs(deps, { limit });
  result.ran.push(...stragglers.ran);
  return result;
}

/* ------------------------------------------------------------------ */
/* Connection health                                                    */
/* ------------------------------------------------------------------ */

const GOOGLE_PROBE_CAPABILITY = { gmail: "gmail.read_orders", calendar: "calendar.read", drive: "drive.read_selected", sheets: "sheets.read_selected" } as const;
type GoogleService = keyof typeof GOOGLE_PROBE_CAPABILITY;
const GOOGLE_SERVICES = Object.keys(GOOGLE_PROBE_CAPABILITY) as GoogleService[];

/** The profile a registry entry belongs to: Google services share one grant, a tool service is its own. */
async function profileOf(app: App, userId: string, registryId: string, kind: string): Promise<string | null> {
  if (!(GOOGLE_SERVICES as string[]).includes(kind)) return (await connectionState(app.db, userId, registryId)) ? registryId : null;
  const suffix = `_${kind}`;
  const profileId = registryId.endsWith(suffix) ? registryId.slice(0, -suffix.length) : null;
  return profileId && (await connectionState(app.db, userId, profileId))?.kind === "google_workspace" ? profileId : null;
}

/** Probe every connected service of one owner now and record the result (also the manual "check now"). */
export async function checkOwnerConnections(app: App, userId: string, phase: "evening" | "morning" | "manual", nowMs: number): Promise<HealthCheckResult> {
  const { env, db } = app;
  const result = await checkConnectionHealth(
    {
      db,
      service: app.service,
      nowMs,
      probeFor: (owner, connection) => async () => {
        const kind = connection.kind as string;
        const profileId = await profileOf(app, owner, connection.connectionId, kind);
        if (!profileId) throw new ConnectionError("not_executable", "this connection has no stored credential here");
        if ((GOOGLE_SERVICES as string[]).includes(kind)) {
          const service = kind as GoogleService;
          const grant = await googleGrant(env, db, owner, GOOGLE_PROBE_CAPABILITY[service], app.now);
          if (!grant) {
            // No token: either Google refused the refresh (the profile now says so) or it could not be reached.
            const state = (await connectionState(db, owner, profileId))?.state;
            throw state === "connected" ? new ConnectionError("transport", "Google could not be reached to refresh the grant") : new ConnectionError("auth", "the Google grant was rejected; the owner needs to reconnect");
          }
          await googleProbe({ accessToken: grant.accessToken, grantedScopes: grant.grantedScopes, fetch: googleFetch(env) }, service)(connection);
          return;
        }
        await probeConnection(db, owner, profileId, () => connectionAuthorization(env, db, owner, `cred_${profileId}`, app.now()));
      },
    },
    userId,
    phase,
  );
  // The assistant's registry now says which connections need the owner; the profile the owner sees says the same.
  for (const checked of result.checked) {
    if (!checked.needsOwner) continue;
    const entry = await first<{ kind: string }>(db, "SELECT kind FROM connections WHERE user_id = ? AND connection_id = ?", userId, checked.connectionId);
    const profileId = entry ? await profileOf(app, userId, checked.connectionId, entry.kind) : null;
    if (profileId) await connectionRejected(db, userId, profileId, nowMs);
  }
  return result;
}

export interface HealthSweepResult {
  runs: { userId: string; localDate: string; phase: "evening" | "morning"; checked: number; needOwner: number }[];
}

/**
 * The scheduled health check. It runs in the sweep before the daily service's phases, once per owner,
 * board day and phase: `evening` when that day's evening composition is due, `morning` from the morning
 * refresh onwards (which precedes publication, presentation and the notification).
 */
export async function runConnectionHealth(app: App, nowMs: number): Promise<HealthSweepResult> {
  const { db } = app;
  const result: HealthSweepResult = { runs: [] };
  const owners = await all<{ user_id: string }>(db, "SELECT DISTINCT u.user_id FROM users u JOIN connection_profiles c ON c.user_id = u.user_id WHERE u.status = 'active' AND c.state = 'connected' ORDER BY u.user_id");
  for (const { user_id: userId } of owners) {
    try {
      const principal = await systemPrincipalFor(db, userId, "connection-health", "system");
      const { settings } = await getSettings(db, principal);
      const daily = DailySettings.parse((settings.extensions as { daily?: unknown }).daily ?? {});
      const today = localDateOf(nowMs, settings.timezone);
      for (const localDate of [today, addDays(today, 1)]) {
        const schedule = phaseSchedule(localDate, settings.timezone, settings.delivery.morningLocalTime, daily);
        const due: ("evening" | "morning")[] = [];
        if (nowMs >= schedule.evening_compose.dueAtMs && nowMs < schedule.evening_compose.expiresAtMs) due.push("evening");
        if (nowMs >= schedule.morning_refresh.dueAtMs && nowMs < schedule.morning_refresh.expiresAtMs) due.push("morning");
        for (const phase of due) {
          const claimed = await prepare(db, stmt("INSERT INTO connection_health_runs (user_id, local_date, phase, ran_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, local_date, phase) DO NOTHING", userId, localDate, phase, toInstant(nowMs))).run();
          if ((claimed.meta?.changes ?? 0) !== 1) continue;
          const health = await checkOwnerConnections(app, userId, phase, nowMs);
          const run = { userId, localDate, phase, checked: health.checked.length, needOwner: health.ownerActions.length };
          await prepare(db, stmt("UPDATE connection_health_runs SET result_json = ? WHERE user_id = ? AND local_date = ? AND phase = ?", JSON.stringify({ checked: run.checked, needOwner: run.needOwner, notProbed: health.notProbed.length }), userId, localDate, phase)).run();
          result.runs.push(run);
        }
      }
    } catch (error) {
      console.error("connection health check failed", String((error as Error)?.message ?? error).slice(0, 200));
    }
  }
  await prepare(db, stmt("DELETE FROM connection_health_runs WHERE ran_at < ?", toInstant(nowMs - 14 * 86_400_000))).run();
  return result;
}

/* ------------------------------------------------------------------ */
/* Reminder events on the outfit calendar                               */
/* ------------------------------------------------------------------ */

export const REMINDER_CALENDAR_EFFECT_KIND = "calendar.project_reminder";
export const REMINDER_PROPERTY = "garderobeReminder";
export const REMINDER_VERSION_PROPERTY = "garderobeReminderVersion";
const REMINDER_EVENT_MINUTES = 30;

/**
 * Deterministic event ID, valid under Google's rules for caller-supplied IDs (base32hex characters,
 * 5 to 1024 long): "gdr" + 40 hex characters. The same reminder always addresses the same event, so a
 * retry after a lost response cannot create a second one.
 */
export async function reminderEventId(userId: string, reminderId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`garderobe-reminder-event|${userId}|${reminderId}`)));
  return `gdr${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40)}`;
}

function calendarWriter(app: App) {
  const { env, db } = app;
  const base = env.GOOGLE_API_BASE_URL ? `${env.GOOGLE_API_BASE_URL.replace(/\/+$/, "")}/calendar/v3` : undefined;
  return createGoogleCalendar({ fetch: ((input: string, init?: RequestInit) => fetch(input, init)) as never, getAccessToken: (userId) => googleAccessToken(env, db, userId, "calendar.write_outfit_calendar", app.now()), ...(base ? { baseUrl: base } : {}) });
}

export interface ReminderProjectionResult {
  projected: number;
  superseded: number;
  notConnected: number;
  retried: number;
  failed: number;
  removed: number;
}

async function projectOne(app: App, writer: ReturnType<typeof calendarWriter>, effect: EffectRecord, nowMs: number): Promise<"projected" | "superseded" | "not_connected"> {
  const { db } = app;
  const newest = await latestDesiredRevision(db, effect.userId, effect.kind, effect.targetKey);
  if (newest !== null && newest > effect.desiredRevision) return "superseded";
  const principal = await systemPrincipalFor(db, effect.userId, `reminder-calendar:${effect.effectId}`, "system");
  const reminderId = String(effect.payload.reminderId ?? "");
  // The reminder as it stands now, not as it was when the effect was queued.
  const reminder = (await listReminders(db, principal)).find((r) => r.reminderId === reminderId);
  if (!reminder) return "superseded"; // removed meanwhile; the removal pass deletes its event
  const { settings } = await getSettings(db, principal);
  const calendarId = (settings.extensions as { daily?: { calendar?: { outfitCalendarId?: string | null } } }).daily?.calendar?.outfitCalendarId ?? null;
  if (!calendarId) return "not_connected";

  const eventId = await reminderEventId(effect.userId, reminderId);
  const dueMs = Date.parse(reminder.dueAt);
  const write: ManagedEventWrite = {
    summary: reminder.title,
    description: [reminder.note, reminder.url, "Reminder set in Garderobe."].filter((line): line is string => typeof line === "string" && line.trim() !== "").join("\n\n"),
    privateProperties: { [REMINDER_PROPERTY]: reminderId, [REMINDER_VERSION_PROPERTY]: String(reminder.version) },
    time: { kind: "timed", startsAt: toInstant(dueMs), endsAt: toInstant(dueMs + REMINDER_EVENT_MINUTES * 60_000), timezone: settings.timezone },
    // The app's own notification effects remind the owner; the calendar event adds no second alert.
    reminderMinutesBefore: null,
  };
  const existing = await writer.getEvent(effect.userId, calendarId, eventId);
  if (existing && existing.privateProperties[REMINDER_PROPERTY] !== reminderId) throw new CalendarApiError("the calendar event with this ID is not this reminder's", { status: null, retryable: false, reason: "not_managed" });
  if (existing) await writer.patchEvent(effect.userId, calendarId, eventId, { ...write, status: "confirmed" }, existing.status === "cancelled" ? null : existing.etag);
  else {
    try {
      await writer.insertEvent(effect.userId, calendarId, eventId, write);
    } catch (error) {
      // An earlier attempt created it and its answer was lost: the same event is updated instead.
      if (!(error instanceof CalendarApiError) || error.detail.reason !== "duplicate") throw error;
      await writer.patchEvent(effect.userId, calendarId, eventId, { ...write, status: "confirmed" }, null);
    }
  }
  // Projected only after reading the event back and finding this version in it.
  const stored = await writer.getEvent(effect.userId, calendarId, eventId);
  if (!stored || stored.status === "cancelled" || stored.privateProperties[REMINDER_VERSION_PROPERTY] !== String(reminder.version) || stored.summary !== reminder.title) {
    throw new CalendarApiError("the reminder event did not read back as written", { status: null, retryable: true, reason: "read_back_mismatch" });
  }
  await prepare(
    db,
    stmt(
      "INSERT INTO reminder_calendar_events (user_id, reminder_id, calendar_id, event_id, projected_version, projected_at, removed_at) VALUES (?, ?, ?, ?, ?, ?, NULL) ON CONFLICT (user_id, reminder_id) DO UPDATE SET calendar_id = excluded.calendar_id, event_id = excluded.event_id, projected_version = excluded.projected_version, projected_at = excluded.projected_at, removed_at = NULL",
      effect.userId, reminderId, calendarId, eventId, reminder.version, toInstant(nowMs),
    ),
  ).run();
  return "projected";
}

/**
 * Deliver due `calendar.project_reminder` effects, then delete the events of reminders that were removed.
 * An owner with no outfit calendar (or without the calendar-writing capability) gets no event: the effect
 * is recorded as cancelled, never as projected, and the app notification is unaffected.
 */
export async function projectReminderEvents(app: App, nowMs: number, limit = 20): Promise<ReminderProjectionResult> {
  const { db } = app;
  const writer = calendarWriter(app);
  const result: ReminderProjectionResult = { projected: 0, superseded: 0, notConnected: 0, retried: 0, failed: 0, removed: 0 };
  for (const effect of await claimDueEffects(db, { nowMs, kinds: [REMINDER_CALENDAR_EFFECT_KIND], limit })) {
    try {
      const outcome = await projectOne(app, writer, effect, nowMs);
      if (outcome === "projected") (await settleEffect(db, effect, { state: "projected" }, nowMs), result.projected++);
      else if (outcome === "superseded") (await settleEffect(db, effect, { state: "superseded" }, nowMs), result.superseded++);
      else (await settleEffect(db, effect, { state: "cancelled" }, nowMs), result.notConnected++);
    } catch (error) {
      if (error instanceof CalendarNotConnectedError) {
        await settleEffect(db, effect, { state: "cancelled" }, nowMs);
        result.notConnected++;
      } else if ((!(error instanceof CalendarApiError) || error.detail.retryable) && effect.attempts < MAX_ATTEMPTS) {
        // Only the adapter's own short message is kept (it never contains a token, a URL or event text).
        await settleEffect(db, effect, { state: "retry", error: error instanceof CalendarApiError ? error.message.slice(0, 200) : "the calendar projection raised an error", retryAtMs: nowMs + backoffMs(effect.attempts) }, nowMs);
        result.retried++;
      } else {
        await settleEffect(db, effect, { state: "failed" }, nowMs);
        result.failed++;
      }
    }
  }

  // Removal: a reminder that is no longer active has no event. Deleting a missing event is not an error.
  const live = await all<{ user_id: string; reminder_id: string; calendar_id: string; event_id: string }>(db, "SELECT e.user_id, e.reminder_id, e.calendar_id, e.event_id FROM reminder_calendar_events e JOIN users u ON u.user_id = e.user_id WHERE e.removed_at IS NULL AND u.status = 'active' ORDER BY e.projected_at LIMIT 200");
  const active = new Map<string, Set<string>>();
  for (const row of live) {
    try {
      if (!active.has(row.user_id)) {
        const principal = await systemPrincipalFor(db, row.user_id, "reminder-calendar:removal", "system");
        active.set(row.user_id, new Set((await listReminders(db, principal)).map((r) => r.reminderId)));
      }
      if (active.get(row.user_id)!.has(row.reminder_id)) continue;
      await writer.deleteEvent(row.user_id, row.calendar_id, row.event_id);
      await prepare(db, stmt("UPDATE reminder_calendar_events SET removed_at = ? WHERE user_id = ? AND reminder_id = ?", toInstant(nowMs), row.user_id, row.reminder_id)).run();
      result.removed++;
    } catch (error) {
      // Left as it is; the next sweep tries again.
      if (!(error instanceof CalendarNotConnectedError) && !(error instanceof CalendarApiError)) console.error("reminder event removal failed", String((error as Error)?.message ?? error).slice(0, 200));
    }
  }
  return result;
}
