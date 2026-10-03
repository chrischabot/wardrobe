/**
 * Journey helpers that talk to the labelled external doubles (src/outbound.ts) and small readers used
 * by several journeys. Nothing here reaches into the Worker's internals: journeys act through the HTTP
 * API and the MCP server, and read state back through the same public surfaces.
 */
import { SELF, createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import type { CommandReceipt } from "@garderobe/contracts";
import { APP_ORIGIN, ownerDay, provisionOwner, toolResult, type ApiClient, type McpConnection, type TestOwner } from "@garderobe/worker/testing";
import worker from "@garderobe/worker/testing/worker-entry";
import type { DayScript } from "./outbound.ts";

const FIXTURE = "https://journey.fixture.test";

async function fixture<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${FIXTURE}${path}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`journey fixture ${path} -> ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

/* ------------------------------ dates ------------------------------ */

export const LONDON = "Europe/London";

/** The local calendar date in a timezone, `offsetDays` from now. */
export function localDate(offsetDays = 0, timezone = LONDON): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offsetDays * 86_400_000));
  return parts;
}

export const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** ISO weekday (1 = Monday ... 7 = Sunday) of a local date. */
export const isoWeekday = (date: string): number => ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;

/* ------------------------------ weather ---------------------------- */

export interface TestPlace {
  label: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

/** A fictional place only this test file uses (TEST DOUBLE weather is scripted per place and date). */
export const newPlace = (label: string, timezone = LONDON): Promise<TestPlace> => fixture("/place", { label: `${label} ${crypto.randomUUID().slice(0, 6)} (test place)`, timezone });

export const scriptWeather = (place: TestPlace, days: Record<string, DayScript>, options: { clear?: boolean; down?: boolean } = {}): Promise<{ requests: number }> => fixture("/weather", { place: place.label, days, ...options });

export const weatherDown = (place: TestPlace, down: boolean): Promise<{ requests: number }> => fixture("/weather", { place: place.label, down });

/** Make the fictional place the owner's home location through the ordinary settings command. */
export async function liveAt(owner: TestOwner, place: TestPlace): Promise<CommandReceipt> {
  return committed(await owner.api.command("settings.update", { patch: { timezone: place.timezone, homeLocation: { label: place.label, latitude: place.latitude, longitude: place.longitude } } }));
}

/* ------------------------------ calendar --------------------------- */

export interface CalendarDoubleState {
  events: Record<string, any>[];
  log: { seq: number; op: string; eventId: string | null; status: number; ifMatch: string | null; revision: string | null; hasAttendees: boolean; sendUpdates: string | null }[];
}

export const seedCalendar = (calendarId: string, events: Record<string, unknown>[], options: { clear?: boolean; failWrites?: number; loseResponses?: number; forbidWrites?: number } = {}): Promise<unknown> => fixture("/calendar/seed", { calendarId, events, ...options });
/** Script faults of the calendar double without touching its events. */
export const calendarFaults = (calendarId: string, faults: { failWrites?: number; loseResponses?: number; forbidWrites?: number }): Promise<unknown> => fixture("/calendar/seed", { calendarId, events: [], ...faults });

/**
 * Connect Google and create the dedicated outfit calendar through the real routes; returns its ID. Each
 * owner gets a calendar of its own name, so journeys never see each other's events or scripted faults.
 */
export async function connectOutfitCalendar(owner: TestOwner): Promise<{ connectionId: string; calendarId: string }> {
  const { connectionId } = await connectGoogle(owner);
  const created = await owner.api.json("POST", `/v1/connections/${connectionId}/outfit-calendar`, { clientRequestId: `cal-${crypto.randomUUID()}`, name: `Outfits ${crypto.randomUUID().slice(0, 8)}` });
  return { connectionId, calendarId: created.calendar.calendarId };
}

/** Read the day's context from a calendar only this owner uses (the default is the shared `primary`). */
export async function readCalendarFrom(owner: TestOwner, calendarId: string): Promise<CommandReceipt> {
  return committed(await owner.api.command("settings.update", { patch: { extensions: { daily: { calendar: { readCalendarIds: [calendarId] } } } } }));
}

/** The managed events of one local day in the calendar double (cancelled ones included). */
export async function eventsOn(calendarId: string, localDate: string): Promise<Record<string, any>[]> {
  const state = await calendarState(calendarId);
  return state.events.filter((e) => String(e.start?.dateTime ?? e.start?.date ?? "").startsWith(localDate));
}
export const calendarState = (calendarId: string): Promise<CalendarDoubleState> => fixture(`/calendar/state?calendarId=${encodeURIComponent(calendarId)}`);
export const editCalendarEvent = (calendarId: string, eventId: string, fields: Record<string, unknown>): Promise<unknown> => fixture("/calendar/edit", { calendarId, eventId, fields });

/**
 * Connect the owner's Google account through the real connection routes. Google's OAuth endpoints are
 * the Worker package's labelled fixture (`google.fixture.test`): this proves the Worker's side only.
 */
export async function connectGoogle(owner: TestOwner, capabilities: string[] = ["calendar.read", "calendar.write_outfit_calendar"]): Promise<{ connectionId: string }> {
  const started = await owner.api.json("POST", "/v1/connections", { clientRequestId: `conn-${crypto.randomUUID()}`, kind: "google_workspace", name: "Google", auth: { type: "oauth" }, capabilities });
  const state = new URL(started.authorizationUrl).searchParams.get("state")!;
  const callback = await SELF.fetch(`${APP_ORIGIN}/connections/callback?state=${encodeURIComponent(state)}&code=fixture-code`, { redirect: "manual" });
  if (callback.status >= 400) throw new Error(`connection callback failed: ${callback.status} ${await callback.text()}`);
  return { connectionId: started.connection.connectionId };
}

/* ------------------------------ receipts --------------------------- */

export interface ApiError {
  code: string;
  message: string;
  details: Record<string, any>;
}

/** The receipt of a command that must have been accepted; throws with the server's own error otherwise. */
export async function committed(response: Response): Promise<CommandReceipt & { result: Record<string, any> }> {
  const text = await response.text();
  if (response.status !== 200) throw new Error(`command was refused: ${response.status} ${text.slice(0, 800)}`);
  return JSON.parse(text);
}

export async function refused(response: Response): Promise<{ status: number; error: ApiError }> {
  const body = (await response.json()) as { error: ApiError };
  return { status: response.status, error: body.error };
}

export const exec = async (api: ApiClient, type: string, payload: Record<string, unknown>, opts: Parameters<ApiClient["command"]>[2] = {}) => committed(await api.command(type, payload, opts));

/* ------------------------------ wardrobe --------------------------- */

export interface WardrobeItem {
  garment: Record<string, any> & { garmentId: string; name: string; roles: string[]; category: string };
  balances: { bucket: string; quantity: number }[];
  availability: Record<string, any> | null;
  [key: string]: any;
}

/** Every page of the wardrobe list, read the way a client must: follow the cursor until `complete`. */
export async function wholeWardrobe(api: ApiClient, query = ""): Promise<{ items: WardrobeItem[]; total: number; wardrobeRevision: number; pages: number }> {
  const items: WardrobeItem[] = [];
  let cursor: string | null = null;
  let first: any = null;
  let pages = 0;
  do {
    const params = [query, cursor ? `cursor=${encodeURIComponent(cursor)}` : ""].filter(Boolean).join("&");
    const page: any = await api.json("GET", `/v1/wardrobe${params ? `?${params}` : ""}`);
    first ??= page;
    items.push(...page.items);
    cursor = page.nextCursor ?? null;
    pages++;
    if (pages > 50) throw new Error("wardrobe paging did not terminate");
  } while (cursor);
  return { items, total: first.total, wardrobeRevision: first.wardrobeRevision, pages };
}

export const quantityIn = (item: { balances: { bucket: string; quantity: number }[] }, bucket: string): number => item.balances.filter((b) => b.bucket === bucket).reduce((n, b) => n + b.quantity, 0);

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll a durable run to a settled state, as a client that lost its stream would. A run that never settles is a failure, not a result. */
export async function settleRun(api: ApiClient, runId: string): Promise<any> {
  let run: any;
  for (let i = 0; i < 300; i++) {
    run = await api.json("GET", `/v1/runs/${runId}`);
    if (["completed", "failed", "cancelled", "needs_input", "resumable"].includes(run.state)) return run;
    await sleep(100);
  }
  throw new Error(`run ${runId} did not settle within 30 seconds; its last state was ${run?.state}`);
}

/* ------------------------------ scheduled work --------------------- */

/**
 * One run of the Worker's real `scheduled` handler (the five-minute cron), waited to its end: the daily
 * service's due phases and calendar projections, maintenance, notifications. No phone and no assistant
 * connection takes part.
 */
export async function runCron(): Promise<void> {
  const ctx = createExecutionContext();
  await (worker as unknown as { scheduled(c: unknown, e: unknown, x: unknown): Promise<void> }).scheduled(createScheduledController({ scheduledTime: new Date(), cron: "*/5 * * * *" }), env, ctx);
  await waitOnExecutionContext(ctx);
}

/* ------------------------------ owners ----------------------------- */

export interface JourneyOwner {
  owner: TestOwner;
  place: TestPlace;
  /** The owner's own calendar days (Europe/London): `day(0)` is today, `day(1)` tomorrow. */
  day(offset: number): string;
  today: string;
}

/**
 * The real owner (supplied profile and the real 127-garment inventory, imported by the real importer),
 * living at a fictional test place whose forecast the journey scripts. Days -1..+9 get a mild default
 * forecast (11 C leaving, 19 C peak) unless `weather` overrides it.
 */
export async function realOwnerAt(label: string, weather: (day: (offset: number) => string) => Record<string, DayScript> = () => ({})): Promise<JourneyOwner> {
  const owner = await provisionOwner({ real: true });
  const today = await ownerDay(owner, 0);
  const day = (offset: number) => addDays(today, offset);
  const place = await newPlace(label);
  const days: Record<string, DayScript> = {};
  for (let i = -1; i <= 9; i++) days[day(i)] = { morningC: 11, peakC: 19, eveningC: 14 };
  await scriptWeather(place, { ...days, ...weather(day) });
  await liveAt(owner, place);
  return { owner, place, day, today };
}

/* ------------------------------ MCP -------------------------------- */

export interface McpCommandOutcome {
  /** `direct`: the connected assistant's command ran at once. `owner_confirmed`: it waited and the owner confirmed it in the app. */
  route: "direct" | "owner_confirmed";
  receipt: CommandReceipt & { result: Record<string, any> };
  /** The proposal as the owner saw it in `GET /v1/proposals`, when one was needed. */
  proposal: Record<string, any> | null;
}

/**
 * One typed command from a connected assistant, driven by the server's answer rather than by a list of
 * types: when the server says the owner must confirm, the owner reads the request in the app's proposal
 * list and confirms it there. Either way the result is the committed receipt.
 *
 * Where the owner has decided the route (decision of 2026-10-03: wear and wash reports, choosing from the
 * published board, laundry pickup and return and packing run directly; settings, corrections, moves,
 * retirements, restrictions, style and measurements wait for the owner), the caller states it as
 * `expectRoute` and a command taking the other route fails the journey.
 */
export async function mcpCommand(owner: TestOwner, mcp: McpConnection, type: string, payload: Record<string, unknown>, opts: { idempotencyKey?: string; expectedVersions?: Record<string, number>; occurredAt?: string; expectRoute?: McpCommandOutcome["route"] } = {}): Promise<McpCommandOutcome> {
  const outcome = await sendMcpCommand(owner, mcp, type, payload, opts);
  if (opts.expectRoute && outcome.route !== opts.expectRoute) throw new Error(`the connected assistant's ${type} took the route "${outcome.route}", but the owner decided it must be "${opts.expectRoute}"`);
  return outcome;
}

async function sendMcpCommand(owner: TestOwner, mcp: McpConnection, type: string, payload: Record<string, unknown>, opts: { idempotencyKey?: string; expectedVersions?: Record<string, number>; occurredAt?: string }): Promise<McpCommandOutcome> {
  const args = { type, payload, idempotencyKey: opts.idempotencyKey ?? `mcp-${crypto.randomUUID()}`, ...(opts.expectedVersions ? { expectedVersions: opts.expectedVersions } : {}), ...(opts.occurredAt ? { occurredAt: opts.occurredAt } : {}) };
  const first = toolResult(await mcp.client.callTool({ name: "garderobe_command", arguments: args }));
  if (first.ok) return { route: "direct", receipt: first.data.receipt, proposal: null };
  if (first.error!.code !== "confirmation_required") throw new Error(`MCP command ${type} was refused: ${first.error!.code} ${first.error!.message}`);
  const proposalId = String(first.error!.details.proposalId);
  const listed = (await owner.api.json("GET", "/v1/proposals")).proposals.find((p: any) => p.proposalId === proposalId);
  if (!listed) throw new Error(`proposal ${proposalId} is not in the owner's list`);
  const decided = await owner.api.json("POST", `/v1/proposals/${proposalId}/decision`, { decision: "confirm" });
  return { route: "owner_confirmed", receipt: decided.receipt, proposal: listed };
}

/* ------------------------------ owner-facing text ------------------ */

/**
 * What must never appear in text the owner reads (board copy, Calendar text, receipt summaries, notices,
 * proposal summaries): internal identifiers, maker fabric codes, machine reason codes or serialisation
 * debris. Returns the offending fragments (empty when clean).
 */
export function internalCodesIn(text: string): string[] {
  const patterns: RegExp[] = [
    /\b[a-z]{2,4}_[0-9a-f]{12,}\b/g, // record identifiers (gmt_..., opt_..., brd_..., cmd_...)
    /\b[a-z]{2,10}(?:_[a-z]{2,10})*_[0-9A-Za-z]*\d[0-9A-Za-z]{5,}\b/g, // longer prefixes and non-hex bodies (msg_trn_01HZ...)
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // UUIDs
    /\bPCF\d{3,}\b/g, // maker fabric codes (the profile: names must match what he can see at the wardrobe)
    /\b[a-z]+(?:_[a-z]+)+\b/g, // snake_case machine codes
    /\[object Object\]|\bundefined\b|\bNaN\b/g,
    /\b(?:boardId|optionId|garmentId|tripId|batchId|caseId|orderId)\b/g, // field names
  ];
  const found = new Set<string>();
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) found.add(match[0]);
  return [...found];
}

/** Every owner-facing string of a board document. */
export function boardTexts(board: Record<string, any>): string[] {
  const texts: unknown[] = [board.dayLine, board.weatherLine, board.suitabilityLine, board.notice, ...(board.changes ?? [])];
  for (const option of board.options ?? []) {
    texts.push(option.name, option.reason, option.qualification);
    for (const line of [...option.garments, ...option.footwearAlternatives, ...(option.flourish ? [option.flourish] : [])]) texts.push(line.name);
  }
  return texts.filter((t): t is string => typeof t === "string" && t.length > 0);
}
