/**
 * Behavioural drivers for the feature cases B011, B012 and B015 to B020.
 *
 * Each driver turns one case's scenario into application state through the owner's ordinary HTTP API and
 * commands (the call patterns are the journey suite's: tests/journeys/test/05, 07, 08, 09, 10 and 13), lets
 * the owner's request happen, and reads the outcome back from what the application returns: board
 * documents, day records, receipts, the returns list, the export package, the calendar double's state.
 *
 * Stand-ins, all at external boundaries and all labelled where they are used: the scripted weather double,
 * the in-memory Google Calendar double and the Worker package's Google OAuth fixture (the harness routes
 * the journey suite's doubles), and test-signed sign-in. Garments this file creates itself are named
 * SYNTHETIC. Nothing here writes to D1 directly.
 *
 * A value in `observed` is always computed from a read. Where the application offers nothing to read, the
 * driver throws and says what is unreadable.
 */
import { SELF, createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { unzipSync } from "fflate";
import { APP_ORIGIN, ApiClient, connectMcp, newIdentity, provisionOwner, uploadImage, type McpConnection } from "@garderobe/worker/testing";
import { addDays, calendarFaults, calendarState, connectOutfitCalendar, eventsOn, exec, newPlace, scriptWeather, sleep } from "../../../tests/journeys/src/world.ts";
import { rebase, receiptsSince, snapshot, unrebase, UnsupportedScenario, type BehaviourDriver, type DriverContext, type World } from "../kit.ts";
import evalWorker from "../worker-entry.ts";

type Json = Record<string, any>;
type Api = World["owner"]["api"];

const uid = (label: string): string => `eval-${label}-${crypto.randomUUID()}`;

/* ------------------------------------------------------------------ */
/* Shared readers and helpers                                           */
/* ------------------------------------------------------------------ */

/**
 * One run of the evaluation Worker's real `scheduled` handler, waited to its end (the same call the
 * journey suite's `runCron` makes on the test entry; here on the evaluation entry).
 */
async function runScheduled(): Promise<void> {
  const ctx = createExecutionContext();
  await (evalWorker as unknown as { scheduled(c: unknown, e: unknown, x: unknown): Promise<void> }).scheduled(createScheduledController({ scheduledTime: new Date(), cron: "*/5 * * * *" }), env, ctx);
  await waitOnExecutionContext(ctx);
}

function fixtureGarment(world: World, fixtureId: string): { garmentId: string; name: string } {
  const found = world.fixture.get(fixtureId);
  if (!found) throw new Error(`the fixture garment "${fixtureId}" was not created in this world`);
  return found;
}

function memoOf<T>(ctx: DriverContext, key: string): T {
  const value = ctx.memo[key];
  if (value === undefined || value === null) throw new Error(`${ctx.c.id}: nothing was stored under "${key}" before this step, so the case cannot continue`);
  return value as T;
}

/** Every garment line an option puts in front of the owner. */
const linesOf = (option: Json): Json[] => [...((option.garments ?? []) as Json[]), ...((option.footwearAlternatives ?? []) as Json[]), ...(option.flourish ? [option.flourish as Json] : [])];

async function boardOn(api: Api, date: string, scope?: string): Promise<Json | null> {
  const view: Json = await api.json("GET", `/v1/today?date=${date}${scope ? `&scope=${encodeURIComponent(scope)}` : ""}`);
  return (view.board as Json | null) ?? null;
}

/** `POST /v1/recommendations`, followed to its result when the application answers with a run. */
async function recommend(api: Api, body: Json): Promise<Json> {
  const first: Json = await api.json("POST", "/v1/recommendations", { clientRequestId: uid("recommend"), ...body });
  if (first.state === "completed") return first;
  const started = Date.now();
  for (;;) {
    const run: Json = await api.json("GET", `/v1/runs/${first.runId}`);
    if (run.state === "completed") return { ...first, state: "completed", options: run.result?.options ?? [], board: run.result?.board ?? null, note: run.result?.note ?? null, insufficient: run.result?.insufficient === true };
    if (run.state === "failed" || run.state === "cancelled") throw new Error(`the recommendation run ${first.runId} ended ${run.state}: ${JSON.stringify(run.error ?? null)}`);
    if (Date.now() - started > 5 * 60_000) throw new Error(`the recommendation run ${first.runId} did not finish within five minutes (last state ${run.state})`);
    await sleep(500);
  }
}

async function proposalIds(api: Api): Promise<string[]> {
  const body: Json = await api.json("GET", "/v1/proposals?state=all");
  return ((body.proposals ?? []) as Json[]).map((p) => String(p.proposalId));
}

/** Requests waiting for the owner's decision that did not exist when the seed ended. */
async function proposalsAfterSeed(ctx: DriverContext): Promise<Json[]> {
  const before = new Set(memoOf<string[]>(ctx, "proposalIdsAtSeed"));
  const body: Json = await ctx.world.owner.api.json("GET", "/v1/proposals?state=all");
  return ((body.proposals ?? []) as Json[]).filter((p) => !before.has(String(p.proposalId))).map((p) => ({ proposalId: p.proposalId, type: p.type, summary: p.summary, state: p.state, proposedAt: p.proposedAt }));
}

async function allReceipts(api: Api): Promise<Json[]> {
  const body: Json = await api.json("GET", "/v1/commands?limit=200");
  return (body.receipts ?? []) as Json[];
}

/** Call at the end of a seed: what already exists, so later reads can tell what the request added. */
async function markSeedEnd(ctx: DriverContext): Promise<void> {
  const api = ctx.world.owner.api;
  ctx.memo.receiptIdsAtSeed = (await allReceipts(api)).map((r) => String(r.commandId));
  ctx.memo.proposalIdsAtSeed = await proposalIds(api);
}

/** Receipts recorded after the seed ended (the owner's request, the assistant's commands, scheduled work). */
async function receiptsAfterSeed(ctx: DriverContext): Promise<Json[]> {
  const before = new Set(memoOf<string[]>(ctx, "receiptIdsAtSeed"));
  const byId = new Map<string, Json>();
  for (const r of [...(await receiptsSince(ctx.world, ctx.actStartedAt)), ...(await allReceipts(ctx.world.owner.api))]) {
    if (!before.has(String(r.commandId))) byId.set(String(r.commandId), r);
  }
  return [...byId.values()];
}

const receiptLine = (r: Json): Json => ({ commandId: r.commandId, type: r.type, actor: r.actor, outcome: r.outcome, summary: r.summary, repairs: r.repairs ?? [], effects: ((r.effects ?? []) as Json[]).map((e) => `${e.kind}:${e.state}`), recordedAt: r.recordedAt });

/** The question a settled conversation run left open for the owner, if any. */
const pendingQuestion = (ctx: DriverContext): Json | null => (ctx.turn?.run?.pendingInput as Json | null | undefined) ?? null;

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ------------------------------------------------------------------ */
/* B011: a wear today repairs the outfit chosen for tomorrow            */
/* ------------------------------------------------------------------ */

const B011: BehaviourDriver = {
  /**
   * Tomorrow's board is published by the owner (`board.publish`, as journey 07 publishes an owner's own
   * outfits) with the scenario's outfit as one option beside outfits the application's own composer
   * proposed for that day, and the owner chooses the scenario's outfit (`board.select`).
   */
  async seed(ctx) {
    const { world, memo } = ctx;
    const api = world.owner.api;
    const tomorrow = world.day(1);
    const outfit = (ctx.c.scenario.future_selected?.tomorrow ?? []) as string[];
    if (outfit.length === 0) throw new Error("B011: the scenario names no outfit chosen for tomorrow");
    const wardrobe = await snapshot(world);
    const slots = outfit.map((fixtureId) => {
      const g = fixtureGarment(world, fixtureId);
      const role = wardrobe.find((w) => w.garmentId === g.garmentId)?.roles[0];
      if (!role) throw new Error(`B011: the wardrobe the application reports has no role for ${g.name}`);
      return { role, garmentId: g.garmentId, name: g.name, fixtureId };
    });
    const shirt = slots.find((s) => s.role === "top");
    if (!shirt) throw new Error("B011: the scenario's outfit for tomorrow has no shirt");
    const inOutfit = new Set(slots.map((s) => s.garmentId));

    const preview = await recommend(api, { date: tomorrow, mode: "preview", count: 4 });
    const others = ((preview.options ?? []) as Json[]).filter((o) => !linesOf(o).some((l) => l.garmentId === shirt.garmentId)).slice(0, 3);
    const asInput = (o: Json): Json => ({ slots: (o.garments as Json[]).map((g) => ({ role: g.role, garmentId: g.garmentId })), footwearAlternatives: ((o.footwearAlternatives ?? []) as Json[]).map((l) => l.garmentId), reason: String(o.reason ?? "") });
    // When the application's own outfits name a second pair of shoes, its board format asks for one; the
    // chosen outfit then gets the same alternative, but only if it is refused without it.
    const alternative = ((preview.options ?? []) as Json[]).flatMap((o) => (o.footwearAlternatives ?? []) as Json[]).map((l) => String(l.garmentId)).find((id) => !inOutfit.has(id)) ?? null;

    const attempts: Json[] = [];
    let board: Json | null = null;
    let chosen: Json | null = null;
    for (const footwearAlternatives of [[], ...(alternative ? [[alternative]] : [])] as string[][]) {
      const published = await exec(api, "board.publish", {
        localDate: tomorrow,
        requestedCount: 1 + others.length,
        options: [{ slots: slots.map((s) => ({ role: s.role, garmentId: s.garmentId })), footwearAlternatives, reason: "The outfit chosen for tomorrow.", explicitGarmentIds: slots.map((s) => s.garmentId) }, ...others.map(asInput)],
      });
      attempts.push({ summary: published.summary, offered: published.result.offered ?? null, dropped: published.result.dropped ?? [] });
      board = await boardOn(api, tomorrow);
      chosen = ((board?.options ?? []) as Json[]).find((o) => slots.every((s) => (o.garments as Json[]).some((g) => g.garmentId === s.garmentId))) ?? null;
      if (chosen) break;
    }
    if (!board || !chosen) throw new Error(`B011: the application did not accept the scenario's outfit onto tomorrow's board, so it cannot be chosen: ${JSON.stringify(attempts).slice(0, 1500)}`);
    const selected = await exec(api, "board.select", { boardId: board.boardId, optionId: chosen.optionId });
    board = await boardOn(api, tomorrow);
    if (!board || board.selection?.optionId !== chosen.optionId) throw new Error("B011: the board does not show the scenario's outfit as chosen after board.select");
    Object.assign(memo, {
      tomorrow,
      boardId: board.boardId,
      optionId: chosen.optionId,
      shirt,
      slots,
      revisionAtSeed: board.revision,
      optionsAtSeed: (board.options as Json[]).map((o) => ({ optionId: o.optionId, garments: (o.garments as Json[]).map((g) => `${g.role}:${g.name}`) })),
      publishAttempts: attempts,
      selectReceipt: selected.summary,
    });
    await markSeedEnd(ctx);
  },

  /** The request alone: tomorrow's choice is already in the application and is not reported again. */
  message: (ctx) => ctx.c.request,

  /** "I wore the gold shirt today": the wear report for that shirt, today. */
  async scripted(ctx) {
    const shirt = memoOf<Json>(ctx, "shirt");
    const receipt = await exec(ctx.world.owner.api, "wear.record", { wearingDate: ctx.world.today, garmentIds: [shirt.garmentId] });
    ctx.memo.wearReceipt = receiptLine(receipt);
  },

  async observe(ctx) {
    const { world, memo } = ctx;
    const api = world.owner.api;
    const shirt = memoOf<Json>(ctx, "shirt");
    const slots = memoOf<Json[]>(ctx, "slots");
    const tomorrow = memoOf<string>(ctx, "tomorrow");

    const day: Json = await api.json("GET", `/v1/days/${world.today}`);
    const wornToday = ((day.garments ?? []) as Json[]).map((g) => String(g.garmentId));
    const item: Json = await api.json("GET", `/v1/items/${shirt.garmentId}`);

    const board = await boardOn(api, tomorrow);
    const options = (board?.options ?? []) as Json[];
    const offering = options.filter((o) => linesOf(o).some((l) => l.garmentId === shirt.garmentId));
    const selected = board?.selection ? (options.find((o) => o.optionId === board.selection.optionId) ?? null) : null;
    const kept = slots.filter((s) => s.role !== "top").map((s) => ({ role: s.role, name: s.name, still_in_selected_outfit: !!selected && (selected.garments as Json[]).some((g) => g.garmentId === s.garmentId && g.role === s.role) }));

    const proposals = await proposalsAfterSeed(ctx);
    const receipts = await receiptsAfterSeed(ctx);
    const repairLines = receipts.flatMap((r) => (r.repairs ?? []) as string[]);
    const question = pendingQuestion(ctx);

    return {
      observed: {
        today_wear_recorded: wornToday.includes(shirt.garmentId),
        gold_in_tomorrow_offerable_options: offering.length > 0,
        unaffected_selected_slots_preserved: !!selected && kept.every((k) => k.still_in_selected_outfit),
        repair_approval_questions: proposals.length + (question ? 1 : 0) + repairLines.filter((line) => line.includes("?")).length,
      },
      evidence: {
        today: world.today,
        tomorrow,
        shirt: { garmentId: shirt.garmentId, name: shirt.name },
        day_record_today: ((day.garments ?? []) as Json[]).map((g) => g.name ?? g.garmentId),
        recorded_wear_count_of_shirt: item.detail?.recordedWearCount ?? null,
        shirt_balances: item.detail?.balances ?? null,
        board_tomorrow: board ? { boardId: board.boardId, same_board_as_seeded: board.boardId === memo.boardId, revision: board.revision, revision_at_seed: memo.revisionAtSeed, validity: board.validity, changes: board.changes, selection: board.selection } : null,
        options_offering_the_shirt: offering.map((o) => o.number),
        selected_option_at_seed: memo.optionId,
        selected_option_now: selected ? { optionId: selected.optionId, same_option_as_seeded: selected.optionId === memo.optionId, garments: (selected.garments as Json[]).map((g) => `${g.role}:${g.name}`) } : null,
        unaffected_pieces: kept,
        options_at_seed: memo.optionsAtSeed,
        requests_to_confirm_created: proposals,
        question_left_open: question,
        repair_lines: repairLines,
        receipts_after_seed: receipts.map(receiptLine),
        seed: { publish_attempts: memo.publishAttempts },
      },
    };
  },
};

/* ------------------------------------------------------------------ */
/* B012: an older Calendar projection arrives after a newer one         */
/* ------------------------------------------------------------------ */

const SWAP_ROLES = ["bottom", "top", "socks", "belt", "footwear", "outer"];
const revisionOfEvent = (event: Json): number => Number(event.extendedProperties?.private?.garderobeRevision);
const standing = (events: Json[]): Json[] => events.filter((e) => e.status !== "cancelled");

/** One slot swap through `POST /v1/boards/{id}/swap` (journey 05), trying slots until the board gets a new revision. */
async function swapOnce(api: Api, date: string, turn: number): Promise<{ board: Json; receipt: Json }> {
  const board = await boardOn(api, date);
  if (!board) throw new Error(`there is no board for ${date} to change`);
  const pairs = SWAP_ROLES.flatMap((role) => (board.options as Json[]).map((option) => ({ option, role }))).filter((p) => (p.option.garments as Json[]).some((g) => g.role === p.role));
  const refused: string[] = [];
  for (let k = 0; k < pairs.length; k++) {
    const { option, role } = pairs[(turn + k) % pairs.length]!;
    const response = await api.post(`/v1/boards/${board.boardId}/swap`, { clientRequestId: uid("swap"), optionId: option.optionId, role });
    const text = await response.text();
    if (response.status === 200) {
      const body = JSON.parse(text) as Json;
      if (Number(body.board?.revision) > Number(board.revision)) return { board: body.board as Json, receipt: body.receipt as Json };
      refused.push(`outfit ${option.number} ${role}: accepted without a new revision`);
    } else refused.push(`outfit ${option.number} ${role}: ${response.status} ${text.slice(0, 140)}`);
  }
  throw new Error(`no slot of the board for ${date} could be swapped at revision ${board.revision}: ${refused.join(" | ").slice(0, 1800)}`);
}

/**
 * Outfit text of older board revisions that is still in the event description. Counted per outfit block of
 * the description: a block whose heading is not an outfit of the revision the event carries, a heading that
 * appears twice, and a piece that an earlier revision of the same outfit had and the current one replaced.
 */
function olderChoicesIn(description: string, current: Json, history: Json[]): string[] {
  const findings: string[] = [];
  const options = (current.options ?? []) as Json[];
  const headings = options.map((o) => `${o.number}. ${o.name}`);
  const seen = new Map<string, number>();
  for (const block of description.split(/\r?\n\s*\r?\n/).map((b) => b.trim()).filter((b) => /^\d+\. /.test(b))) {
    const heading = block.split(/\r?\n/)[0]!.trim();
    const index = headings.indexOf(heading);
    if (index < 0) {
      findings.push(`an outfit block that is not on revision ${current.revision}: "${heading}"`);
      continue;
    }
    const count = (seen.get(heading) ?? 0) + 1;
    seen.set(heading, count);
    if (count > 1) {
      findings.push(`the outfit "${heading}" appears ${count} times`);
      continue;
    }
    const option = options[index]!;
    const now = linesOf(option);
    // The garment lines of the block only (after the heading and the sentence on why the outfit works).
    let rest = block.split(/\r?\n/).slice(2).join("\n");
    for (const line of now) rest = rest.split(String(line.name)).join("");
    const replaced = new Set<string>();
    for (const old of history) {
      if (Number(old.revision) >= Number(current.revision)) continue;
      const earlier = ((old.options ?? []) as Json[]).find((o) => o.optionId === option.optionId);
      for (const line of earlier ? linesOf(earlier) : []) if (!now.some((c) => c.garmentId === line.garmentId)) replaced.add(String(line.name));
    }
    for (const name of replaced) if (rest.includes(name)) findings.push(`"${heading}" still lists ${name}, which a later revision replaced`);
  }
  return findings;
}

const B012: BehaviourDriver = {
  /**
   * A connected outfit calendar (calendar double) and one managed event for the board of the day after
   * tomorrow (no scheduled phase touches that day). The board is taken to the scenario's revisions by real
   * slot swaps, one revision each. The older of the two queued revisions is made late by a real failure:
   * the calendar double refuses writes while its projection is attempted, so the application reschedules
   * it; the newer revision is then published with the calendar working again. When the seed ends both
   * projection effects are queued and the older one is due after the newer one.
   */
  async seed(ctx) {
    const { world, memo } = ctx;
    const api = world.owner.api;
    const date = world.day(2);
    const queued = ((ctx.c.scenario.queued_effects ?? []) as unknown[]).map(Number).filter((n) => Number.isInteger(n)).sort((a, b) => a - b);
    const newer = Number(ctx.c.scenario.remote_revision ?? queued[queued.length - 1]);
    if (!Number.isInteger(newer) || newer < 3) throw new Error("B012: the scenario names no usable revision for the event");
    const older = queued.find((n) => n < newer) ?? newer - 1;

    const { calendarId, connectionId } = await connectOutfitCalendar(world.owner);
    const first = await recommend(api, { date, mode: "board" });
    if (!first.board) throw new Error(`B012: no board was published for ${date}: ${String(first.note ?? "")}`);
    let board = first.board as Json;
    const history: Json[] = [board];
    await runScheduled();
    const created = standing(await eventsOn(calendarId, date));
    if (created.length !== 1) throw new Error(`B012: the scheduled run left ${created.length} managed events for ${date}; one was expected before the case starts`);

    let turn = 0;
    const swapTo = async (target: number): Promise<Json | null> => {
      let last: Json | null = null;
      while (Number(board.revision) < target) {
        const done = await swapOnce(api, date, turn++);
        board = done.board;
        history.push(done.board);
        last = done.receipt;
      }
      return last;
    };
    await swapTo(older - 1);
    await runScheduled();
    const beforeOutage = standing(await eventsOn(calendarId, date));

    await calendarFaults(calendarId, { failWrites: 50 }); // TEST DOUBLE outage: every write to the calendar answers 503
    const olderReceipt = await swapTo(older);
    const olderRevision = Number(board.revision);
    await runScheduled(); // the older revision's projection is attempted, fails, and is rescheduled by the application
    const olderAttemptedAtMs = Date.now();
    const duringOutage = standing(await eventsOn(calendarId, date));
    await calendarFaults(calendarId, { failWrites: 0 });
    const newerReceipt = await swapTo(newer);

    Object.assign(memo, {
      date,
      calendarId,
      connectionId,
      boardId: board.boardId,
      eventId: created[0]!.id,
      history,
      olderRevision,
      newerRevision: Number(board.revision),
      requestedRevisions: { older, newer },
      olderCommandId: olderReceipt?.commandId ?? null,
      newerCommandId: newerReceipt?.commandId ?? null,
      olderAttemptedAtMs,
      remoteRevisionBeforeOutage: beforeOutage[0] ? revisionOfEvent(beforeOutage[0]) : null,
      remoteRevisionDuringOutage: duringOutage[0] ? revisionOfEvent(duringOutage[0]) : null,
      syncRuns: 0,
    });
    await markSeedEnd(ctx);
  },

  /** The request alone: the event, its revision and the queued work are application state, not something the owner recites. */
  message: (ctx) => ctx.c.request,

  /** No owner command synchronizes an event: the application does it in its scheduled run, which is run once here. */
  async scripted(ctx) {
    await runScheduled();
    ctx.memo.syncRuns = Number(ctx.memo.syncRuns ?? 0) + 1;
  },

  /**
   * Deliver what is queued, the newer revision first: one scheduled run for what is due now, then, once the
   * time the application gave the failed older projection has certainly passed (it reschedules by about a
   * minute; 75 seconds are waited from the failed attempt), two more scheduled runs.
   */
  async act(ctx) {
    await runScheduled();
    const wait = memoOf<number>(ctx, "olderAttemptedAtMs") + 75_000 - Date.now();
    if (wait > 0) await sleep(wait);
    await runScheduled();
    await runScheduled();
    ctx.memo.syncRuns = Number(ctx.memo.syncRuns ?? 0) + 3;
  },

  async observe(ctx) {
    const { world, memo } = ctx;
    const api = world.owner.api;
    const date = memoOf<string>(ctx, "date");
    const calendarId = memoOf<string>(ctx, "calendarId");
    const history = memoOf<Json[]>(ctx, "history");

    const state = await calendarState(calendarId);
    const events = standing(await eventsOn(calendarId, date));
    if (events.length === 0) throw new Error(`B012: the calendar double holds no standing managed event for ${date}, so the revision the event carries cannot be read`);
    const event = events.find((e) => e.id === memo.eventId) ?? events[0]!;
    const remoteRevision = revisionOfEvent(event);
    if (!Number.isInteger(remoteRevision)) throw new Error(`B012: the managed event ${String(event.id)} carries no readable revision property`);

    const board = await boardOn(api, date);
    const carried = history.find((h) => Number(h.revision) === remoteRevision) ?? (board && Number(board.revision) === remoteRevision ? board : null);
    if (!carried) throw new Error(`B012: the event carries revision ${remoteRevision}, of which no board document was read, so its text cannot be compared with older revisions`);
    const appended = events.flatMap((e) => olderChoicesIn(String(e.description ?? ""), carried, history));

    const effectsOf = async (commandId: unknown): Promise<Json[] | null> => (typeof commandId === "string" ? ((await api.json("GET", `/v1/commands/${commandId}`)).effects as Json[]) : null);
    const log = state.log.filter((l) => l.eventId === event.id);
    const written = log.filter((l) => l.status === 200 && l.revision !== null && l.op !== "get").map((l) => Number(l.revision));
    const literal = memo.olderRevision === memo.requestedRevisions.older && memo.newerRevision === memo.requestedRevisions.newer;

    return {
      observed: {
        managed_event_count: events.length,
        remote_revision: remoteRevision,
        superseded_choices_appended: appended.length,
      },
      evidence: {
        board_day: date,
        calendar: "TEST DOUBLE Google Calendar (in-memory, the journey suite's)",
        event: { id: event.id, same_event_as_first_created: event.id === memo.eventId, status: event.status, revision: remoteRevision, writes: event.writes, option_headings: String(event.description ?? "").split(/\r?\n/).filter((l) => /^\d+\. /.test(l)) },
        events_for_the_day_including_cancelled: (await eventsOn(calendarId, date)).map((e) => ({ id: e.id, status: e.status })),
        board_now: board ? { boardId: board.boardId, revision: board.revision, options: (board.options as Json[]).length, calendarProjection: board.calendarProjection } : null,
        revisions: { asked_for: memo.requestedRevisions, older_reached: memo.olderRevision, newer_reached: memo.newerRevision, reached_one_swap_at_a_time: history.map((h) => h.revision) },
        remote_revision_before_the_outage: memo.remoteRevisionBeforeOutage,
        remote_revision_while_the_older_projection_failed: memo.remoteRevisionDuringOutage,
        effects_of_older_revision: await effectsOf(memo.olderCommandId),
        effects_of_newer_revision: await effectsOf(memo.newerCommandId),
        revisions_written_to_the_event_in_order: written,
        inserts_of_the_event: log.filter((l) => l.op.startsWith("insert")).length,
        calendar_log_tail: log.slice(-14).map((l) => `${l.op} ${l.status}${l.revision !== null ? ` rev ${l.revision}` : ""}`),
        older_choices_found_in_event_text: appended,
        scheduled_runs_after_seed: memo.syncRuns,
        note:
          (literal ? `The board was taken to revisions ${memo.olderRevision} and ${memo.newerRevision} by real slot swaps. ` : `The board could not be taken to exactly the scenario's revisions (reached ${memo.olderRevision} and ${memo.newerRevision}); the numbers reported are the real ones. `) +
          "The application orders projection effects by the time of the command that queued them and always writes the board's current revision, so an older effect cannot be handed to it after a newer one by any public means other than time: the older projection was delayed by a scripted calendar outage (test double), and the scheduled handler was run before and after its retry time.",
      },
    };
  },
};

/* ------------------------------------------------------------------ */
/* B015: outfits at the destination come from the suitcase              */
/* ------------------------------------------------------------------ */

const quantityIn = (balances: Json[], bucket: string): number => balances.filter((b) => b.bucket === bucket).reduce((n, b) => n + Number(b.quantity), 0);
const suitcaseKey = (packed: Json[]): string => JSON.stringify(packed.map((p) => `${String(p.garmentId)}:${Number(p.clean)}:${Number(p.worn)}`).sort());

interface Suitcases {
  trip: Json[];
  earlierTrip: Json[] | null;
  homeShirtBalances: Json[] | null;
}

/** What is physically packed, as `GET /v1/trips/{id}` reports it, and the stock of the control shirt left at home. */
async function suitcases(ctx: DriverContext): Promise<Suitcases> {
  const api = ctx.world.owner.api;
  const trip: Json = await api.json("GET", `/v1/trips/${memoOf<string>(ctx, "tripId")}`);
  const control = (ctx.memo.control ?? null) as Json | null;
  const earlier: Json | null = control ? await api.json("GET", `/v1/trips/${control.tripId}`) : null;
  const home: Json | null = control ? await api.json("GET", `/v1/items/${control.homeShirt}`) : null;
  return { trip: (trip.packed ?? []) as Json[], earlierTrip: earlier ? ((earlier.packed ?? []) as Json[]) : null, homeShirtBalances: home ? ((home.detail?.balances ?? []) as Json[]) : null };
}

/** Outfits for each day of the trip, asked the way journey 07 asks: the recommendation route, as a preview. */
async function destinationOptions(ctx: DriverContext): Promise<Json[]> {
  const out: Json[] = [];
  for (const date of memoOf<string[]>(ctx, "tripDays")) {
    const answer = await recommend(ctx.world.owner.api, { date, mode: "preview", count: 3 });
    out.push({ date, source: "POST /v1/recommendations (preview)", options: (answer.options ?? []) as Json[], note: answer.note ?? null, insufficient: answer.insufficient === true });
  }
  return out;
}

const B015: BehaviourDriver = {
  /**
   * A three-day trip starting today with one dinner and carry-on luggage (`trip.create`), to a fictional
   * destination whose forecast is the scripted weather double, and the scenario's packed pieces actually
   * packed (`stock.pack`, one unit each). Nothing is washed at the destination, so the trip records no
   * laundry opportunity.
   *
   * So that the home weekly reset has something it could wrongly wash, the boundary case of journey 07 is
   * added, built from labelled SYNTHETIC shirts and a SYNTHETIC earlier trip reported late through
   * occurrence dates: one shirt worn eleven days ago from a suitcase that is still packed, one worn the
   * same day at home. The home shirt is the control: a reset that really runs makes it clean again.
   */
  async seed(ctx) {
    const { world, memo } = ctx;
    const api = world.owner.api;
    const packed = ((ctx.c.scenario.packed ?? []) as string[]).map((fixtureId) => ({ fixtureId, ...fixtureGarment(world, fixtureId) }));
    if (packed.length === 0) throw new Error("B015: the scenario names nothing packed");
    const tripDays = [world.day(0), world.day(1), world.day(2)];

    const destination = await newPlace("Evaluation B015 destination");
    const forecast: Record<string, { morningC: number; peakC: number; eveningC: number }> = {};
    for (let i = -1; i <= 5; i++) forecast[world.day(i)] = { morningC: 12, peakC: 18, eveningC: 14 };
    await scriptWeather(destination, forecast);
    const where = { label: destination.label, latitude: destination.latitude, longitude: destination.longitude, timezone: destination.timezone };

    const created = await exec(api, "trip.create", {
      name: "Three days away",
      departsOn: tripDays[0],
      returnsOn: tripDays[2],
      destinations: [{ ...where, from: tripDays[0], to: tripDays[2] }],
      occasions: [{ localDate: tripDays[1], label: "Dinner", segment: "evening" }],
      luggage: { label: "carry-on" },
      source: { kind: "owner_statement", note: ctx.c.request },
    });
    const tripId = String(created.result.tripId);
    // The scenario's trip carries a repeat exception. The owner cannot set one; the application grants it
    // with its own packing proposal for the trip. The proposal packs nothing: what is packed is the scenario's.
    const proposal: Json = await api.json("POST", `/v1/trips/${tripId}/packing-proposal`, { clientRequestId: uid("pack") });
    if (ctx.c.scenario.trip_repeat_exception === true && proposal.repeatExceptionForTrip !== true) throw new UnsupportedScenario(`the scenario's trip has a repeat exception, and the application's packing proposal for this trip did not grant one (repeatExceptionForTrip: ${JSON.stringify(proposal.repeatExceptionForTrip ?? null)})`);
    const pack = await exec(api, "stock.pack", { tripId, items: packed.map((g) => ({ garmentId: g.garmentId })) });
    Object.assign(memo, { tripId, tripDays, packedFixture: packed, destination: destination.label, packReceipt: pack.summary, control: null, controlError: null });

    try {
      const at = (offset: number) => ({ occurredAt: `${world.day(offset)}T10:00:00.000Z` });
      const synthetic = async (name: string): Promise<string> =>
        String((await exec(api, "garment.create", { name, category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, isSynthetic: true, source: { kind: "system", note: "SYNTHETIC boundary-case garment for evaluation case B015" } }, at(-13))).result.garmentId);
      const suitcaseShirt = await synthetic("SYNTHETIC shirt worn from a suitcase (evaluation B015)");
      const homeShirt = await synthetic("SYNTHETIC shirt worn at home (evaluation B015)");
      const earlier = await exec(api, "trip.create", {
        name: "SYNTHETIC earlier trip (evaluation B015)",
        departsOn: world.day(-12),
        returnsOn: world.day(-9),
        destinations: [{ ...where, from: world.day(-12), to: world.day(-9) }],
        source: { kind: "system", note: "SYNTHETIC boundary-case trip for evaluation case B015" },
      });
      const earlierTripId = String(earlier.result.tripId);
      await exec(api, "stock.pack", { tripId: earlierTripId, items: [{ garmentId: suitcaseShirt }] }, at(-12));
      await exec(api, "wear.record", { wearingDate: world.day(-11), garmentIds: [suitcaseShirt], tripId: earlierTripId }, at(-11));
      await exec(api, "wear.record", { wearingDate: world.day(-11), garmentIds: [homeShirt] }, at(-11));
      memo.control = { tripId: earlierTripId, suitcaseShirt, homeShirt };
    } catch (error) {
      memo.controlError = String((error as Error)?.message ?? error).slice(0, 600);
    }
    memo.suitcasesAtSeed = await suitcases(ctx);
    await markSeedEnd(ctx);
  },

  /** The request alone: the trip and the packing are already recorded and are not reported a second time. */
  message: (ctx) => ctx.c.request,

  /** "Suggest outfits from what I packed": the recommendation route for each day away. */
  async scripted(ctx) {
    ctx.memo.asked = await destinationOptions(ctx);
  },

  /** Not said to the assistant: the home weekly laundry reset runs (`laundry.apply_weekly_reset`, as in journey 07). */
  async act(ctx) {
    ctx.memo.suitcasesBeforeReset = await suitcases(ctx);
    const reset = await exec(ctx.world.owner.api, "laundry.apply_weekly_reset", {});
    ctx.memo.reset = { outcome: reset.outcome, summary: reset.summary, cyclesApplied: reset.result.cyclesApplied ?? [], garmentsReset: reset.result.garmentsReset ?? null };
  },

  async observe(ctx) {
    const { world, memo } = ctx;
    const api = world.owner.api;
    const tripId = memoOf<string>(ctx, "tripId");

    // Destination outfits: what the request produced, and what the application offers for the days away now.
    const sources: Json[] = [...(((memo.asked as Json[] | undefined) ?? (await destinationOptions(ctx))) as Json[])];
    const reply = [...((ctx.turn?.run?.result?.options ?? []) as Json[]), ...((ctx.turn?.run?.result?.board?.options ?? []) as Json[])];
    if (reply.length > 0) sources.push({ date: null, source: "options carried by the assistant's reply", options: reply });
    for (const date of memoOf<string[]>(ctx, "tripDays")) {
      const board = await boardOn(api, date, `trip:${tripId}`);
      if (board) sources.push({ date, source: "the trip's board for that day", options: (board.options ?? []) as Json[] });
    }
    const trip: Json = await api.json("GET", `/v1/trips/${tripId}`);
    const inSuitcase = new Set(((trip.packed ?? []) as Json[]).map((p) => String(p.garmentId)));
    const outside = new Map<string, Json>();
    for (const s of sources) {
      for (const option of s.options as Json[]) {
        for (const line of linesOf(option)) {
          const id = String(line.garmentId);
          if (!inSuitcase.has(id)) outside.set(id, { garmentId: id, name: line.name, fixtureId: world.fixtureIdOf.get(id) ?? null, seen_in: s.source, date: s.date });
        }
      }
    }

    // The home reset and the suitcases.
    const reset = memoOf<Json>(ctx, "reset");
    const after = await suitcases(ctx);
    const ranNow = ((reset.cyclesApplied ?? []) as unknown[]).length > 0;
    let before = memoOf<Suitcases>(ctx, "suitcasesBeforeReset");
    if (!ranNow) {
      const laundry: Json = await api.json("GET", "/v1/laundry");
      if (((laundry.cycles ?? []) as unknown[]).length === 0) throw new Error("B015: the home weekly reset applied no cycle and none is on record, so what a reset does to the suitcase cannot be observed");
      before = memoOf<Suitcases>(ctx, "suitcasesAtSeed"); // a cycle was applied earlier than the driver's own reset: compare from the seed
    }
    const changed = suitcaseKey(before.trip) !== suitcaseKey(after.trip) || (before.earlierTrip !== null && after.earlierTrip !== null && suitcaseKey(before.earlierTrip) !== suitcaseKey(after.earlierTrip));
    const control = (memo.control ?? null) as Json | null;

    return {
      observed: {
        home_only_items_in_destination_options: outside.size,
        home_laundry_applied_to_suitcase: changed,
      },
      evidence: {
        trip: { tripId, days: memo.tripDays, destination: `${String(memo.destination)} (fictional place; forecast from the TEST DOUBLE weather)`, status: trip.status, repeat_exception_on_proposal: trip.proposal?.repeatExceptionForTrip ?? null },
        packed_now: ((trip.packed ?? []) as Json[]).map((p) => ({ name: p.name, clean: p.clean, worn: p.worn, fixtureId: world.fixtureIdOf.get(String(p.garmentId)) ?? null })),
        destination_option_sources: sources.map((s) => ({ source: s.source, date: s.date, options: (s.options as Json[]).length, note: s.note ?? null, pieces: (s.options as Json[]).map((o) => linesOf(o).map((l) => l.name)) })),
        destination_options_read: sources.reduce((n, s) => n + (s.options as Json[]).length, 0),
        pieces_offered_that_are_not_in_the_suitcase: [...outside.values()],
        weekly_reset: reset,
        reset_compared_from: ranNow ? "immediately before the reset the driver ran" : "the end of the seed (a cycle had already been applied before the driver's reset)",
        suitcase_before_reset: before.trip.map((p) => `${p.name}: ${p.clean} clean, ${p.worn} worn`),
        suitcase_after_reset: after.trip.map((p) => `${p.name}: ${p.clean} clean, ${p.worn} worn`),
        control: control
          ? {
              what: "SYNTHETIC shirts worn eleven days ago: one from the suitcase of a SYNTHETIC earlier trip that is still packed, one at home",
              earlier_suitcase_before: before.earlierTrip,
              earlier_suitcase_after: after.earlierTrip,
              home_shirt_clean_before: before.homeShirtBalances ? quantityIn(before.homeShirtBalances, "clean") : null,
              home_shirt_clean_after: after.homeShirtBalances ? quantityIn(after.homeShirtBalances, "clean") : null,
              home_shirt_dirty_after: after.homeShirtBalances ? quantityIn(after.homeShirtBalances, "dirty") : null,
            }
          : { unavailable: memo.controlError ?? "the control was not built", consequence: "only the scenario's own suitcase, in which nothing had been worn, was compared" },
        note: "The repeat exception of the scenario's trip is the one the application granted with its packing proposal for this trip (see trip.repeat_exception_on_proposal); the proposal packed nothing. One unit of each piece the scenario names was packed.",
      },
    };
  },
};

/* ------------------------------------------------------------------ */
/* B016: a return whose deadline comes from the supplied terms          */
/* ------------------------------------------------------------------ */

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fourteen: 14, fifteen: 15, twenty: 20, "twenty-eight": 28, thirty: 30, sixty: 60, ninety: 90 };

/** The number of days the supplied terms give for REQUESTING a return, read from their own words. */
function requestWindowDays(terms: string): number {
  const match = /request\s+within\s+(\d+|[a-z-]+)\s+(?:calendar\s+)?days?/i.exec(terms);
  const word = match?.[1]?.toLowerCase() ?? "";
  const days = /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word];
  if (!days) throw new Error(`B016: the supplied terms do not state a number of days for requesting a return: "${terms}"`);
  return days;
}

const B016: BehaviourDriver = {
  /**
   * A labelled SYNTHETIC shirt bought from a SYNTHETIC shop (journey 08's sequence: `garment.create` as
   * incoming, `purchase.import_order`, `purchase.link_line`), reported as arrived on the scenario's
   * receipt date carried over to the run's calendar (`assistant.report_arrival`). No return exists yet.
   */
  async seed(ctx) {
    const { world, memo } = ctx;
    const api = world.owner.api;
    const receivedOn = rebase(world, String(ctx.c.scenario.received_on));
    const name = "SYNTHETIC ordered shirt to send back (evaluation B016)";
    const garmentId = String((await exec(api, "garment.create", { name, category: "shirt", roles: ["top"], careChannel: "service", acquisition: "incoming", quantity: 1, isSynthetic: true, source: { kind: "system", note: "SYNTHETIC ordered item for evaluation case B016" } })).result.garmentId);
    const logged = await exec(api, "purchase.import_order", {
      merchant: "SYNTHETIC Shop (evaluation)",
      merchantKey: "synthetic-shop-evaluation",
      orderNumber: `EVAL-B016-${crypto.randomUUID().slice(0, 8)}`,
      orderedOn: addDays(receivedOn, -4),
      currency: "GBP",
      totalMinor: 9_000,
      channel: "owner_statement",
      lines: [{ lineKey: "shirt-M", productName: "SYNTHETIC ordered shirt", size: "M", priceMinor: 9_000, currency: "GBP" }],
      sourceRefs: ["owner statement (SYNTHETIC order for evaluation case B016)"],
    });
    const orderId = String(logged.result.orderId);
    const order = (((await api.json("GET", "/v1/orders")).orders ?? []) as Json[]).find((o) => o.orderId === orderId);
    const lineId = String(((order?.lines ?? []) as Json[]).find((l) => l.lineKey === "shirt-M")?.lineId ?? "");
    if (!lineId) throw new Error("B016: the logged order does not list its line");
    await exec(api, "purchase.link_line", { orderId, lineId, garmentId });
    await exec(api, "assistant.report_arrival", { garmentId, deliveredOn: receivedOn });
    const item: Json = await api.json("GET", `/v1/items/${garmentId}`);
    const line = ((((await api.json("GET", "/v1/orders")).orders ?? []) as Json[]).find((o) => o.orderId === orderId)?.lines as Json[]).find((l) => l.lineId === lineId);
    Object.assign(memo, {
      garmentId,
      garmentName: name,
      orderId,
      lineId,
      receivedOn,
      deliveredOnRecorded: line?.deliveredOn ?? null,
      ownedUnitsAtSeed: Number(item.detail?.totalOwnedUnits),
      caseIdsAtSeed: (((await api.json("GET", "/v1/returns")).returns ?? []) as Json[]).map((c) => String(c.caseId)),
    });
    await markSeedEnd(ctx);
  },

  /**
   * What the owner says: the request, which shirt "this shirt" is, the shop's terms as supplied, and that
   * no authorization has been asked for. The receipt date is not repeated: the application recorded it.
   */
  message: (ctx) => `${ctx.c.request}\n\nThe shirt is the ${memoOf<string>(ctx, "garmentName")}.\nThe shop's return terms: ${String(ctx.c.scenario.fixture_terms)}\nI have not asked the shop for a return authorization.`,

  /**
   * The return is opened for the delivered order line with the supplied terms (`return.open_case`, journey
   * 08). No trigger date is sent: the application takes the delivery date it recorded. Reminders are what
   * that command queues.
   */
  async scripted(ctx) {
    const { world, memo } = ctx;
    const terms = String(ctx.c.scenario.fixture_terms);
    const opened = await exec(world.owner.api, "return.open_case", {
      kind: "return",
      orderId: memoOf<string>(ctx, "orderId"),
      lineId: memoOf<string>(ctx, "lineId"),
      terms: { windowDays: requestWindowDays(terms), concerns: "request", triggerEvent: "delivery", sourceRef: "return terms the owner supplied with the request (SYNTHETIC evaluation terms)", checkedOn: world.today, text: terms },
    });
    memo.openReceipt = { ...receiptLine(opened), reminders: opened.result.reminders ?? null };
  },

  async observe(ctx) {
    const { world, memo } = ctx;
    const api = world.owner.api;
    const garmentId = memoOf<string>(ctx, "garmentId");
    const returns = ((await api.json("GET", "/v1/returns")).returns ?? []) as Json[];
    const mine = returns.filter((c) => c.garmentId === garmentId || (c.orderId === memo.orderId && c.lineId === memo.lineId));
    const withDeadline = (concerns: string): Json | null => mine.find((c) => c.deadline?.status === "established" && c.deadline?.concerns === concerns && typeof c.deadline?.localDate === "string") ?? null;
    const request = withDeadline("request");
    const posting = withDeadline("post");
    const known = new Set(memoOf<string[]>(ctx, "caseIdsAtSeed"));
    const item: Json = await api.json("GET", `/v1/items/${garmentId}`);
    const ownedNow = Number(item.detail?.totalOwnedUnits);
    const ownedAtSeed = memoOf<number>(ctx, "ownedUnitsAtSeed");
    if (!Number.isInteger(ownedNow) || !Number.isInteger(ownedAtSeed)) throw new Error("B016: the item view does not report how many units of the shirt are owned");
    const receipts = await receiptsAfterSeed(ctx);

    return {
      observed: {
        request_deadline: request ? unrebase(world, String(request.deadline.localDate)) : null,
        posting_deadline: posting ? unrebase(world, String(posting.deadline.localDate)) : null,
        owned_stock_removed_by_draft: ownedAtSeed - ownedNow,
      },
      evidence: {
        today_of_the_run: world.today,
        received_on_in_the_run: memo.receivedOn,
        delivered_on_recorded_on_the_order_line: memo.deliveredOnRecorded,
        shirt: { garmentId, name: memo.garmentName, synthetic: true },
        return_cases_for_the_shirt: mine.map((c) => ({ caseId: c.caseId, kind: c.kind, state: c.state, triggerDate: c.triggerDate, terms: c.terms, deadline: c.deadline, nextAction: c.nextAction, stockDeparted: c.stockDeparted })),
        request_deadline_in_the_run: request?.deadline?.localDate ?? null,
        posting_deadline_in_the_run: posting?.deadline?.localDate ?? null,
        other_cases_opened_after_seed: returns.filter((c) => !known.has(String(c.caseId)) && !mine.includes(c)).map((c) => ({ caseId: c.caseId, garmentId: c.garmentId, deadline: c.deadline })),
        owned_units: { at_seed: ownedAtSeed, now: ownedNow, balances_now: item.detail?.balances ?? null, acquisition: item.detail?.garment?.acquisition ?? null },
        open_receipt: memo.openReceipt ?? null,
        receipts_after_seed: receipts.map((r) => ({ ...receiptLine(r), reminders: r.result?.reminders ?? null })),
        requests_to_confirm_created: await proposalsAfterSeed(ctx),
        note: "Dates in `observed` are carried back to the corpus calendar; the run's own dates are listed beside them.",
      },
    };
  },
};

/* ------------------------------------------------------------------ */
/* B017: one unsolicited comfort remark                                 */
/* ------------------------------------------------------------------ */

const B017: BehaviourDriver = {
  /** Nothing is added to the scenario: only what exists before the remark is noted, so the remark's effect can be told apart. */
  async seed(ctx) {
    const { world, memo } = ctx;
    const api = world.owner.api;
    const garment = fixtureGarment(world, String(ctx.c.scenario.garment));
    const item: Json = await api.json("GET", `/v1/items/${garment.garmentId}`);
    const style: Json = await api.json("GET", "/v1/style");
    Object.assign(memo, {
      garment,
      restrictionsAtSeed: ((item.detail?.restrictions ?? []) as Json[]).map((r) => String(r.restrictionId ?? JSON.stringify(r))),
      hardExcludedAtSeed: Boolean(item.availability?.hardExcluded),
      statusAtSeed: item.availability?.status ?? null,
      planningPolicyAtSeed: item.detail?.garment?.planningPolicy ?? null,
      rulesAtSeed: JSON.stringify(style.rules ?? null),
      directionsAtSeed: JSON.stringify(style.directions ?? null),
      feedbackIdsAtSeed: (((await api.json("GET", "/v1/feedback")).feedback ?? []) as Json[]).map((f) => String(f.feedbackId)),
      conversationTotalAtSeed: Number((await api.json("GET", "/v1/conversation/messages")).total ?? 0),
    });
    await markSeedEnd(ctx);
  },

  /**
   * The remark as the sentence states it (`feedback.record`, journey 09): the owner's words, too warm, about
   * that shirt, on the train. No date, activity or temperature is added, because the sentence gives none.
   */
  async scripted(ctx) {
    const said = ctx.c.request;
    if (!/too warm/i.test(said) || !/on the train/i.test(said)) throw new Error(`B017: the request no longer reads as a too-warm remark about the train: "${said}"`);
    const garment = memoOf<Json>(ctx, "garment");
    const receipt = await exec(ctx.world.owner.api, "feedback.record", { text: said, kind: "too_warm", garmentIds: [garment.garmentId], conditions: { where: "on the train" }, scope: "on the train" });
    ctx.memo.feedbackReceipt = receiptLine(receipt);
  },

  async observe(ctx) {
    const { world, memo } = ctx;
    const api = world.owner.api;
    const garment = memoOf<Json>(ctx, "garment");
    const known = new Set(memoOf<string[]>(ctx, "feedbackIdsAtSeed"));
    const fresh = (((await api.json("GET", "/v1/feedback")).feedback ?? []) as Json[]).filter((f) => !known.has(String(f.feedbackId)) && f.status === "active");

    const item: Json = await api.json("GET", `/v1/items/${garment.garmentId}`);
    const restrictionsBefore = new Set(memoOf<string[]>(ctx, "restrictionsAtSeed"));
    const newRestrictions = ((item.detail?.restrictions ?? []) as Json[]).filter((r) => !restrictionsBefore.has(String(r.restrictionId ?? JSON.stringify(r))));
    const hardExcluded = Boolean(item.availability?.hardExcluded);
    const policy = item.detail?.garment?.planningPolicy ?? null;
    const status = item.availability?.status ?? null;
    const ban = {
      new_restriction_on_the_garment: newRestrictions.length > 0,
      became_hard_excluded: hardExcluded && !memo.hardExcludedAtSeed,
      planning_policy_changed_away_from_normal: policy !== memo.planningPolicyAtSeed && policy !== "normal",
      became_unavailable: status === "unavailable" && memo.statusAtSeed !== "unavailable",
    };
    const style: Json = await api.json("GET", "/v1/style");

    const proposals = await proposalsAfterSeed(ctx);
    const question = pendingQuestion(ctx);
    const conversationTotal = Number((await api.json("GET", "/v1/conversation/messages")).total ?? 0);
    // With no owner turn (scripted run) any new message is one the application started by itself.
    const unprompted = ctx.mode === "scripted_commands" ? conversationTotal - Number(memo.conversationTotalAtSeed ?? 0) : 0;

    return {
      observed: {
        comfort_observation_saved: fresh.length > 0,
        questionnaire_created: proposals.length > 0 || question !== null || unprompted > 0,
        universal_garment_ban_created: Object.values(ban).some(Boolean),
      },
      evidence: {
        garment: { garmentId: garment.garmentId, name: garment.name },
        comfort_notes_saved_after_seed: fresh.map((f) => ({ feedbackId: f.feedbackId, text: f.text, kind: f.kind, pain: f.pain, linked_to_the_garment: ((f.garmentIds ?? []) as string[]).includes(garment.garmentId), garmentIds: f.garmentIds, wearingDate: f.wearingDate, activity: f.activity, layer: f.layer, conditions: f.conditions, scope: f.scope })),
        requests_to_confirm_created: proposals,
        question_left_open: question,
        messages_started_by_the_application: unprompted,
        ban_checks: ban,
        garment_now: { status, hardExcluded, planningPolicy: policy, restrictions: item.detail?.restrictions ?? [], owned_units: item.detail?.totalOwnedUnits ?? null },
        garment_at_seed: { status: memo.statusAtSeed, hardExcluded: memo.hardExcludedAtSeed, planningPolicy: memo.planningPolicyAtSeed },
        style_rules_changed: JSON.stringify(style.rules ?? null) !== memo.rulesAtSeed,
        standing_directions_changed: JSON.stringify(style.directions ?? null) !== memo.directionsAtSeed,
        feedback_receipt: memo.feedbackReceipt ?? null,
        receipts_after_seed: (await receiptsAfterSeed(ctx)).map(receiptLine),
      },
    };
  },
};

/* ------------------------------------------------------------------ */
/* B018: resuming after a pause replays nothing                         */
/* ------------------------------------------------------------------ */

const WEEKDAYS: Record<string, number> = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 };
const localMinute = (timezone: string): string => new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
const dateIn = (text: unknown): string | null => /\d{4}-\d{2}-\d{2}/.exec(String(text ?? ""))?.[0] ?? null;

/** `GET /v1/today` for each day of a range of offsets from today. */
async function dayViews(ctx: DriverContext, from: number, to: number): Promise<Json[]> {
  const out: Json[] = [];
  for (let offset = from; offset <= to; offset++) {
    const date = ctx.world.day(offset);
    const view: Json = await ctx.world.owner.api.json("GET", `/v1/today?date=${date}`);
    out.push({ date, offset, status: view.status, paused: view.paused !== null && view.paused !== undefined, boardId: view.board?.boardId ?? null, revision: view.board?.revision ?? null, reason: view.board?.reason ?? null, validity: view.board?.validity ?? null });
  }
  return out;
}

/** Morning presentations and morning reminders among receipts, each with the board day it concerns. */
function morningNotices(receipts: Json[], boardDays: Map<string, string>): Json[] {
  return receipts
    .filter((r) => r.type === "board.present" || ((r.effects ?? []) as Json[]).some((e) => e.kind === "notification.morning_board"))
    .map((r) => {
      const boardId = ((r.affected ?? []) as Json[]).find((a) => a.kind === "board")?.id ?? null;
      return {
        commandId: r.commandId,
        type: r.type,
        actor: r.actor,
        summary: r.summary,
        boardDay: dateIn(r.summary) ?? (boardId ? (boardDays.get(String(boardId)) ?? null) : null),
        reminders: ((r.effects ?? []) as Json[]).filter((e) => e.kind === "notification.morning_board").map((e) => e.state),
        recordedAt: r.recordedAt,
      };
    });
}

const B018: BehaviourDriver = {
  /**
   * As journey 10 does, the owner's own schedule is set so the daily phases are due now (no API makes time
   * pass): the scheduled run prepares today's and tomorrow's boards and queues today's morning reminder.
   * A return whose deadline is tomorrow is opened for a labelled SYNTHETIC overshirt (`return.open_case`).
   * The weekly reset is kept on the scenario's weekday through the owner's settings. Then the owner pauses.
   *
   * The scenario's pause began fourteen days ago, and the driver asks for exactly that. When the application
   * refuses a pause that starts in the past, the case is reported as not run: a pause starting today has no
   * missed days and would be a different scenario.
   */
  async seed(ctx) {
    const { world, memo } = ctx;
    const api = world.owner.api;
    const missed = Number(ctx.c.scenario.missed_days ?? 0);
    if (!Number.isInteger(missed) || missed < 1) throw new Error("B018: the scenario does not say how many days were missed");
    const weekday = WEEKDAYS[String(ctx.c.scenario.weekly_reset ?? "").toLowerCase()];
    if (!weekday) throw new Error(`B018: the scenario's weekly reset day is not a weekday: "${String(ctx.c.scenario.weekly_reset)}"`);
    if (String(ctx.c.scenario.return_deadline ?? "").toLowerCase() !== "tomorrow") throw new Error(`B018: this driver seeds a return deadline of tomorrow; the scenario now says "${String(ctx.c.scenario.return_deadline)}"`);

    const settings: Json = (await api.json("GET", "/v1/settings")).settings;
    const laundry = (settings.laundry?.service ?? {}) as Json;
    const laundryChanged = laundry.baselineWeekday !== weekday || laundry.weeklyResetEnabled !== true;
    if (laundryChanged) await exec(api, "settings.update", { patch: { laundry: { service: { weeklyResetEnabled: true, baselineWeekday: weekday } } } });
    await exec(api, "settings.update", { patch: { delivery: { morningLocalTime: localMinute(String(settings.timezone)) }, extensions: { daily: { eveningComposeLocalTime: "00:00" } } } });
    await runScheduled();

    const deadlineDate = world.day(1);
    const garment = await exec(api, "garment.create", { name: "SYNTHETIC overshirt to send back (evaluation B018)", category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, isSynthetic: true, source: { kind: "system", note: "SYNTHETIC item for the return of evaluation case B018" } });
    const opened = await exec(api, "return.open_case", {
      kind: "return",
      garmentId: garment.result.garmentId,
      terms: { windowDays: 30, concerns: "post", triggerEvent: "delivery", sourceRef: "https://synthetic-shop.example.test/returns (SYNTHETIC terms page)", checkedOn: world.today },
      triggerDate: addDays(deadlineDate, -30),
    });
    const returnCaseId = String(opened.result.caseId);
    const caseAtSeed = (((await api.json("GET", "/v1/returns")).returns ?? []) as Json[]).find((c) => c.caseId === returnCaseId);
    if (!caseAtSeed || caseAtSeed.deadline?.status !== "established" || caseAtSeed.deadline.localDate !== deadlineDate) throw new Error(`B018: the seeded return does not have its deadline tomorrow (${deadlineDate}): ${JSON.stringify(caseAtSeed?.deadline ?? null)}`);

    const wantedFrom = world.day(-missed);
    const asked = await api.command("service.pause", { from: wantedFrom });
    const askedText = await asked.text();
    let pause: Json;
    let pauseRefusal: string | null = null;
    if (asked.status === 200) pause = JSON.parse(askedText) as Json;
    else {
      // No route and no clock control lets a run stand fourteen days after a pause began. A pause that starts
      // today has no missed days, which is a different scenario; it is not scored in this one's place.
      throw new UnsupportedScenario(`the scenario needs a pause that began ${missed} days ago; the application refused it (${asked.status} ${askedText.slice(0, 300)}) and no route makes time pass`);
    }
    await runScheduled(); // a scheduled run while paused

    const viewsAtSeed = await dayViews(ctx, -missed, 1);
    const boardDays = new Map<string, string>(viewsAtSeed.filter((v) => v.boardId).map((v) => [String(v.boardId), String(v.date)]));
    const noticesAtSeed = morningNotices(await allReceipts(api), boardDays);
    Object.assign(memo, {
      missed,
      wantedPauseFrom: wantedFrom,
      pauseFrom: pause.result?.from ?? null,
      pauseSummary: pause.summary,
      pauseRefusal,
      laundryAtSeed: { ...laundry, ...(laundryChanged ? { changedTo: { weeklyResetEnabled: true, baselineWeekday: weekday } } : {}) },
      returnCaseId,
      returnDeadlineAtSeed: caseAtSeed.deadline,
      viewsAtSeed,
      noticesAtSeed,
      daysNotifiedAtSeed: [...new Set(noticesAtSeed.map((n) => n.boardDay).filter((d): d is string => typeof d === "string"))],
      runsNeedingInputAtSeed: Number((await api.json("GET", "/v1/recovery")).pending?.runsNeedingInput ?? 0),
      conversationTotalAtSeed: Number((await api.json("GET", "/v1/conversation/messages")).total ?? 0),
      serviceAtSeed: await api.json("GET", "/v1/service"),
    });
    await markSeedEnd(ctx);
  },

  /** The request alone: the pause, the return and the laundry routine are application state. */
  message: (ctx) => ctx.c.request,

  /** "Resume my outfits": the resume command (`service.resume`, journey 10). */
  async scripted(ctx) {
    ctx.memo.resumeReceipt = receiptLine(await exec(ctx.world.owner.api, "service.resume", {}));
  },

  /** Not said to the assistant: the scheduled service runs after the resume, twice. */
  async act() {
    await runScheduled();
    await runScheduled();
  },

  async observe(ctx) {
    const { world, memo } = ctx;
    const api = world.owner.api;
    const missed = memoOf<number>(ctx, "missed");
    const viewsAtSeed = memoOf<Json[]>(ctx, "viewsAtSeed");
    const views = await dayViews(ctx, -missed, 1);
    const boardDays = new Map<string, string>([...viewsAtSeed, ...views].filter((v) => v.boardId).map((v) => [String(v.boardId), String(v.date)]));

    const receipts = await receiptsAfterSeed(ctx);
    const notices = morningNotices(receipts, boardDays);
    const unreadable = notices.filter((n) => n.boardDay === null);
    if (unreadable.length > 0) throw new Error(`B018: ${unreadable.length} morning notification(s) after the resume do not say which day's board they concern, so they cannot be classed as old or new: ${JSON.stringify(unreadable).slice(0, 600)}`);
    const notifiedBefore = new Set(memoOf<string[]>(ctx, "daysNotifiedAtSeed"));
    const replayed = notices.filter((n) => String(n.boardDay) < world.today || notifiedBefore.has(String(n.boardDay)));

    const proposals = await proposalsAfterSeed(ctx);
    const runsNeedingInput = Number((await api.json("GET", "/v1/recovery")).pending?.runsNeedingInput ?? 0);
    const conversationTotal = Number((await api.json("GET", "/v1/conversation/messages")).total ?? 0);
    // With no owner turn (scripted run) any new message is one the application started by itself.
    const unprompted = ctx.mode === "scripted_commands" ? conversationTotal - Number(memo.conversationTotalAtSeed ?? 0) : 0;
    const newRunsNeedingInput = Math.max(0, runsNeedingInput - Number(memo.runsNeedingInputAtSeed ?? 0));

    const returnCase = (((await api.json("GET", "/v1/returns")).returns ?? []) as Json[]).find((c) => c.caseId === memo.returnCaseId) ?? null;
    const was = memoOf<Json>(ctx, "returnDeadlineAtSeed");
    const preserved = !!returnCase && !["cancelled", "closed"].includes(String(returnCase.state)) && returnCase.deadline?.status === "established" && returnCase.deadline.localDate === was.localDate && returnCase.deadline.at === was.at && returnCase.deadline.concerns === was.concerns;

    const hadBoard = new Set(viewsAtSeed.filter((v) => v.boardId).map((v) => String(v.date)));
    const laundryNow: Json = await api.json("GET", "/v1/laundry");

    return {
      observed: {
        old_board_notifications_replayed: replayed.length,
        wear_confirmation_tasks_created: proposals.length + newRunsNeedingInput + Math.max(0, unprompted),
        return_deadline_preserved: preserved,
      },
      evidence: {
        today: world.today,
        pause: {
          asked_to_start_on: memo.wantedPauseFrom,
          started_on: memo.pauseFrom,
          refusal_of_the_backdated_pause: memo.pauseRefusal,
          summary: memo.pauseSummary,
          note: memo.pauseRefusal
            ? `The application refused a pause starting ${missed} days ago and no API makes time pass, so the pause of this run started today. Replay is measured against the board that was presented before the pause.`
            : `The pause covers the ${missed} days before today.`,
        },
        service_at_seed: memo.serviceAtSeed,
        service_now: await api.json("GET", "/v1/service"),
        resume_receipt: memo.resumeReceipt ?? receipts.filter((r) => r.type === "service.resume").map(receiptLine),
        morning_notices_before_the_pause: memo.noticesAtSeed,
        morning_notices_after_the_resume: notices,
        counted_as_replayed: replayed,
        boards_at_seed: viewsAtSeed.filter((v) => v.boardId || v.offset >= 0),
        boards_now: views.filter((v) => v.boardId || v.offset >= 0),
        boards_now_for_days_before_today: views.filter((v) => v.offset < 0 && v.boardId).map((v) => v.date),
        boards_created_after_the_resume: views.filter((v) => v.boardId && !hadBoard.has(String(v.date))).map((v) => v.date),
        requests_to_confirm_created: proposals,
        runs_waiting_for_the_owner: { at_seed: memo.runsNeedingInputAtSeed, now: runsNeedingInput },
        question_left_open: pendingQuestion(ctx),
        messages_started_by_the_application: unprompted,
        return_case: returnCase ? { caseId: returnCase.caseId, state: returnCase.state, deadline_at_seed: was, deadline_now: returnCase.deadline } : null,
        weekly_reset: { settings_at_seed: memo.laundryAtSeed, cycles_on_record: laundryNow.cycles ?? null },
        receipts_after_seed: receipts.map(receiptLine),
      },
    };
  },
};

/* ------------------------------------------------------------------ */
/* B019: recovery with the kit reaches the same account                 */
/* ------------------------------------------------------------------ */

const compactCode = (code: string): string => code.split("-").slice(2).join("");

/**
 * The recovery flow of journey 13, through the real routes and never through the conversation: a new
 * sign-in (a test-signed identity standing for a different Google account) starts a recovery transaction
 * and completes it with the kit's code, unlinking the lost sign-in. Afterwards the owner uses the new
 * sign-in, so the world's client is replaced by it.
 */
async function recoverWithKit(ctx: DriverContext): Promise<void> {
  const { world, memo } = ctx;
  if (memo.recovery) return;
  const kit = memoOf<Json>(ctx, "kit");
  const replacement = new ApiClient(newIdentity("replacement"));
  const locked = await replacement.get("/v1/me");
  await locked.text();
  const tx: Json = await replacement.json("POST", "/auth/recovery/start", {});
  const done: Json = await replacement.json("POST", "/auth/recovery/complete", { transactionId: tx.transactionId, recoveryCode: kit.recoveryCode, unlinkPreviousIdentities: true });
  memo.recovery = { replacement, transactionId: tx.transactionId, statusOfNewSignInBefore: locked.status, done };
  memo.lostApi = world.owner.api;
  world.owner.api = replacement;
  world.owner.identity = replacement.identity;
}

const B019: BehaviourDriver = {
  /** The owner already holds the kit issued when the account was claimed; the account and its wardrobe are noted as they are before the loss. */
  async seed(ctx) {
    const { world, memo } = ctx;
    const me: Json = await world.owner.api.json("GET", "/v1/me");
    if (!me.recoveryKit?.present || !world.owner.recoveryKit?.recoveryCode) throw new Error("B019: the owner has no recovery kit");
    Object.assign(memo, {
      kit: world.owner.recoveryKit,
      userIdBefore: String(me.userId),
      identitiesBefore: ((me.identities ?? []) as unknown[]).length,
      garmentIdsBefore: (await snapshot(world)).map((g) => g.garmentId).sort(),
      seededAtMs: Date.now(),
    });
  },

  /** The owner's sentence and nothing else: no code, no kit text. The credential never enters the conversation. */
  message: (ctx) => ctx.c.request,

  async scripted(ctx) {
    await recoverWithKit(ctx);
  },

  /** The recovery itself happens outside the conversation in both modes. */
  async act(ctx) {
    await recoverWithKit(ctx);
  },

  async observe(ctx) {
    const { world, memo } = ctx;
    const recovery = memoOf<Json>(ctx, "recovery");
    const replacement = recovery.replacement as ApiClient;
    const lost = memoOf<ApiClient>(ctx, "lostApi");
    const kit = memoOf<Json>(ctx, "kit");
    const done = recovery.done as Json;
    const statusOf = async (response: Response): Promise<{ status: number; code: string | null }> => {
      const text = await response.text();
      let code: string | null = null;
      try {
        code = (JSON.parse(text) as Json).error?.code ?? null;
      } catch {
        code = null;
      }
      return { status: response.status, code };
    };

    const me: Json = await replacement.json("GET", "/v1/me");
    const before = memoOf<string>(ctx, "userIdBefore");
    const same = String(me.userId) === before;

    // The spent code, tried again by yet another sign-in in a new transaction.
    const again = new ApiClient(newIdentity("reuse"));
    const tx: Json = await again.json("POST", "/auth/recovery/start", {});
    const reuse = await statusOf(await again.post("/auth/recovery/complete", { transactionId: tx.transactionId, recoveryCode: kit.recoveryCode }));
    const replay = await statusOf(await replacement.post("/auth/recovery/complete", { transactionId: recovery.transactionId, recoveryCode: kit.recoveryCode }));

    // Sessions that began before the recovery: of the lost sign-in (the native app's assertion header) and of the new one.
    const ago = Math.ceil((Date.now() - memoOf<number>(ctx, "seededAtMs")) / 1000) + 30;
    const lostEarlier = await statusOf(await lost.with({ issuedAgoSeconds: ago }).get("/v1/me"));
    const lostEarlierWardrobe = await statusOf(await lost.with({ issuedAgoSeconds: ago }).get("/v1/wardrobe"));
    const lostFresh = await statusOf(await lost.get("/v1/me"));
    const replacementEarlier = await statusOf(await replacement.with({ issuedAgoSeconds: ago }).get("/v1/me"));

    // The conversation as stored, and the settled run of the owner's turn.
    const transcript = JSON.stringify(await replacement.json("GET", "/v1/conversation/messages?limit=100"));
    const haystack = `${transcript}\n${ctx.turn ? JSON.stringify(ctx.turn.run) : ""}`;
    const replacementCode = String(done.replacementKit?.recoveryCode ?? "");
    const secrets = [
      { label: "the used recovery code", value: String(kit.recoveryCode) },
      { label: "the used recovery code without separators", value: compactCode(String(kit.recoveryCode)) },
      { label: "the replacement recovery code", value: replacementCode },
      { label: "the replacement recovery code without separators", value: replacementCode ? compactCode(replacementCode) : "" },
    ];
    const found = secrets.filter((s) => s.value.length > 0 && haystack.includes(s.value)).map((s) => s.label);
    if (/\bGRD1-RK[A-Z0-9]+(?:-[A-Z0-9]{4}){3,}/i.test(haystack)) found.push("text shaped like a recovery code");
    if (/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(haystack)) found.push("text shaped like a signed session token");

    const garmentIdsNow = (await snapshot(world)).map((g) => g.garmentId).sort();

    return {
      observed: {
        retained_user_id: same ? String(ctx.c.scenario.old_user_id) : String(me.userId),
        used_recovery_credential_reusable: reuse.status === 200 || replay.status === 200,
        old_native_sessions_valid: lostEarlier.status === 200 || lostEarlierWardrobe.status === 200 || replacementEarlier.status === 200,
        credentials_in_conversation: found.length > 0,
      },
      evidence: {
        internal_user_id_before_the_loss: before,
        internal_user_id_reached_after_recovery: me.userId,
        internal_user_id_in_the_recovery_answer: done.userId,
        same_internal_user: same,
        reported_as: same ? `"${String(ctx.c.scenario.old_user_id)}" is the corpus's name for the owner before the loss; it is reported because the two real identifiers above are equal` : "the differing identifier itself",
        sign_in: "test-signed identities stand for Google accounts behind Cloudflare Access (journey suite stand-in)",
        new_sign_in_before_recovery: recovery.statusOfNewSignInBefore,
        recovery_answer: { identityLinked: done.identityLinked, previousIdentitiesUnlinked: done.previousIdentitiesUnlinked, assistantGrantsRevoked: done.assistantGrantsRevoked, sessionsRevokedBefore: done.sessionsRevokedBefore, connectionsUnchanged: done.connectionsUnchanged, receiptId: done.receiptId, replacement_kit_issued: replacementCode.length > 0, replacement_kit_differs: replacementCode !== String(kit.recoveryCode) },
        identities_linked: { before: memo.identitiesBefore, now: ((me.identities ?? []) as unknown[]).length },
        recovery_kit_present_now: me.recoveryKit?.present ?? null,
        same_garments_reachable: JSON.stringify(garmentIdsNow) === JSON.stringify(memo.garmentIdsBefore),
        garments: { before: (memo.garmentIdsBefore as string[]).length, now: garmentIdsNow.length },
        spent_code_in_a_new_transaction: reuse,
        finished_transaction_replayed: replay,
        lost_sign_in_session_from_before_recovery: { me: lostEarlier, wardrobe: lostEarlierWardrobe, began_seconds_ago: ago },
        lost_sign_in_fresh_session: lostFresh,
        new_sign_in_session_from_before_recovery: replacementEarlier,
        conversation_messages_stored: (JSON.parse(transcript) as Json).total ?? null,
        credential_material_found_in_conversation: found,
        recovery_done_by: ctx.mode === "conversation" ? "the driver, through the recovery routes, after the owner's message settled (never through the assistant)" : "the driver, through the recovery routes (scripted run, no assistant)",
        note: "No code or token is written into this evidence: only whether each was found.",
      },
    };
  },
};

/* ------------------------------------------------------------------ */
/* B020: the export package and an import into an empty account         */
/* ------------------------------------------------------------------ */

const CREDENTIAL_FIELD = /"(access_token|refresh_token|token_hash|verifier|ciphertext|client_secret|recovery_code|password)"/;
const CREDENTIAL_TABLES = ["recovery_credentials", "auth_identities", "connection_credentials", "connection_oauth_states", "owner_invitations", "identity_link_tickets", "auth_session_floors", "export_tickets"];

const calendarWrites = async (calendarId: string): Promise<number> => (await calendarState(calendarId)).log.filter((entry) => !["get", "list"].includes(entry.op)).length;

async function followExport(api: Api, exportId: string): Promise<Json> {
  const started = Date.now();
  for (;;) {
    const job: Json = await api.json("GET", `/v1/exports/${exportId}`);
    if (!["queued", "running"].includes(String(job.state))) return job;
    if (Date.now() - started > 3 * 60_000) throw new Error(`the export ${exportId} was still ${String(job.state)} after three minutes`);
    await sleep(200);
  }
}

const B020: BehaviourDriver = {
  /**
   * An owner with history of his own (a wear today, a dirty mark and its undo), one LABELLED TEST IMAGE
   * uploaded for a garment through the upload routes, and credentials in the backend: the recovery kit,
   * a Google connection with its outfit calendar (OAuth fixture and calendar double), a connection holding
   * a SYNTHETIC secret key, and a connected assistant with its tokens. Today's board is delivered to the
   * outfit calendar by the scheduled handler, so one external effect really happened before the export.
   */
  async seed(ctx) {
    const { world, memo } = ctx;
    const owner = world.owner;
    const api = owner.api;
    const wardrobe = await snapshot(world);
    const clean = (role: string) => {
      const g = wardrobe.find((w) => w.acquisition === "owned" && w.roles.includes(role) && !w.hardExcluded && w.balances.some((b) => b.bucket === "clean" && b.quantity > 0));
      if (!g) throw new Error(`B020: the wardrobe has no clean ${role} to build history from`);
      return g;
    };
    const top = clean("top");
    const bottom = clean("bottom");
    const socks = clean("socks");
    const wear = await exec(api, "wear.record", { wearingDate: world.today, garmentIds: [top.garmentId, bottom.garmentId] });
    const dirty = await exec(api, "care.mark_dirty", { items: [{ garmentId: socks.garmentId, quantity: 1 }] });
    const undo = await exec(api, "command.undo", { commandId: dirty.commandId, reason: null });
    const upload = await uploadImage(owner, { garmentId: top.garmentId }); // LABELLED TEST IMAGE, not a photograph of clothes

    const { calendarId, connectionId } = await connectOutfitCalendar(owner);
    const published = await recommend(api, { date: world.today, mode: "board" });
    let writes = -1;
    for (let i = 0; i < 6; i++) {
      await runScheduled();
      const now = await calendarWrites(calendarId);
      const projected = (await boardOn(api, world.today))?.calendarProjection?.state === "projected";
      if (projected && now === writes) break;
      writes = now;
    }
    if ((await calendarWrites(calendarId)) === 0) throw new Error(`B020: nothing was written to the outfit calendar before the export (board: ${published.board ? "published" : String(published.note ?? "none")}), so a replay on import could not be told apart from nothing`);

    const secrets: { label: string; value: string }[] = [
      { label: "the recovery code", value: owner.recoveryKit.recoveryCode },
      { label: "the recovery code without separators", value: compactCode(owner.recoveryKit.recoveryCode) },
    ];
    const seedNotes: string[] = [];
    const connectionSecret = `tvly-EVAL-B020-SYNTHETIC-${crypto.randomUUID().replace(/-/g, "")}`;
    try {
      await api.json("POST", "/v1/connections", { clientRequestId: uid("conn"), kind: "tavily", name: "Tavily search (SYNTHETIC key, evaluation B020)", auth: { type: "secret", secret: connectionSecret } });
      secrets.push({ label: "the secret key of a connection", value: connectionSecret });
    } catch (error) {
      seedNotes.push(`a connection holding a secret key could not be added: ${String((error as Error)?.message ?? error).split(connectionSecret).join("[secret]").slice(0, 300)}`);
    }
    let assistant: McpConnection | null = null;
    try {
      assistant = await connectMcp(owner, { write: true, clientName: "Assistant in export (evaluation B020)" });
      const tokens = assistant.oauth.snapshot();
      if (tokens.accessToken) secrets.push({ label: "the connected assistant's access token", value: tokens.accessToken });
      if (tokens.refreshToken) secrets.push({ label: "the connected assistant's refresh token", value: tokens.refreshToken });
    } catch (error) {
      seedNotes.push(`a connected assistant could not be added: ${String((error as Error)?.message ?? error).slice(0, 300)}`);
    }

    Object.assign(memo, {
      worn: [top.garmentId, bottom.garmentId],
      seedCommandIds: [wear.commandId, dirty.commandId, undo.commandId],
      assetId: upload.complete?.asset?.assetId ?? null,
      uploadState: upload.complete?.state ?? null,
      calendarId,
      connectionId,
      secrets,
      seedNotes,
      assistant,
      exportId: null,
    });
  },

  /** The request alone: what the backend holds is not something the owner lists. */
  message: (ctx) => ctx.c.request,

  /** "Export everything": start the export job and follow it; an incomplete package is asked for again, up to three times (journey 13). */
  async scripted(ctx) {
    const api = ctx.world.owner.api;
    const attempts: Json[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const requested: Json = await api.json("POST", "/v1/exports", { clientRequestId: uid("export") });
      const job = await followExport(api, String(requested.exportId));
      attempts.push({ exportId: job.exportId, state: job.state, complete: job.complete });
      ctx.memo.exportId = job.exportId;
      if (job.complete) break;
    }
    ctx.memo.exportAttempts = attempts;
  },

  async observe(ctx) {
    const { world, memo } = ctx;
    const api = world.owner.api;
    const calendarId = memoOf<string>(ctx, "calendarId");
    const secrets = memoOf<{ label: string; value: string }[]>(ctx, "secrets");
    const assistant = (memo.assistant ?? null) as McpConnection | null;
    const decoder = new TextDecoder();

    // The export the request produced: the one the scripted step followed, or the newest one on the owner's list.
    const listed = (((await api.json("GET", "/v1/exports")).exports ?? []) as Json[]).sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)));
    const chosen = typeof memo.exportId === "string" ? memo.exportId : ((listed.find((e) => e.complete) ?? listed[0])?.exportId ?? null);
    const job = chosen ? await followExport(api, String(chosen)) : null;
    if (!job || !job.sha256 || !["completed", "completed_incomplete"].includes(String(job.state))) {
      await assistant?.close();
      return {
        // Only what the absence of a package itself establishes is reported. Whether a package would have
        // carried a credential, and whether an import would have replayed an effect, was not observed: those
        // two outcomes are left out, so the state check reports them as missing rather than as met.
        observed: { original_history_included: false, media_manifest_included: false, checksums_valid: false },
        evidence: {
          package: null,
          exports_on_the_owners_list: listed.map((e) => ({ exportId: e.exportId, state: e.state, complete: e.complete, requestedAt: e.requestedAt })),
          job: job ? { exportId: job.exportId, state: job.state, complete: job.complete, components: job.components } : null,
          note: "No finished export package exists after the request, so there is no package to hold history, media or checksums. Nothing was downloaded or imported, so the two remaining outcomes were not observed and are not reported.",
          seed_notes: memo.seedNotes,
        },
      };
    }
    if (job.encrypted) throw new Error("B020: the export package is encrypted with a passphrase the driver does not hold, so its contents are unreadable");

    const ticket: Json = await api.json("POST", `/v1/exports/${job.exportId}/ticket`, {});
    const download = await SELF.fetch(`${APP_ORIGIN}${String(ticket.url)}`);
    if (download.status !== 200) throw new Error(`B020: the export package could not be downloaded with its ticket (${download.status}), so its contents are unreadable`);
    const zip = new Uint8Array(await download.arrayBuffer());
    let unzipped: Record<string, Uint8Array>;
    try {
      unzipped = unzipSync(zip);
    } catch (error) {
      throw new Error(`B020: the downloaded package is not a readable archive: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
    }
    const files: Record<string, Uint8Array> = Object.fromEntries(Object.entries(unzipped).filter(([path]) => !path.endsWith("/")));
    const text = (path: string): string | null => {
      const bytes = files[path];
      return bytes ? decoder.decode(bytes) : null;
    };
    const jsonFile = (path: string): Json | null => {
      const content = text(path);
      if (content === null) return null;
      try {
        return JSON.parse(content) as Json;
      } catch {
        return null;
      }
    };
    const manifest = jsonFile("manifest.json");
    const manifestFiles = ((manifest?.files ?? []) as Json[]).map((f) => ({ path: String(f.path), bytes: Number(f.bytes), sha256: String(f.sha256) }));

    // History the owner made before the export: today's wears and the commands behind them.
    const worn = memoOf<string[]>(ctx, "worn");
    const wearRows = ((jsonFile("records/wear.json")?.tables?.daily_wears?.rows ?? []) as Json[]).filter((w) => w.wearing_date === world.today).map((w) => String(w.garment_id));
    const exportedCommands = new Set(((jsonFile("records/receipts.json")?.tables?.commands?.rows ?? []) as Json[]).map((c) => String(c.command_id)));
    const seedCommands = memoOf<string[]>(ctx, "seedCommandIds");
    const wearsIncluded = worn.every((id) => wearRows.includes(id));
    const commandsIncluded = seedCommands.every((id) => exportedCommands.has(id));

    // Media: the records file, its assets and the image files they name.
    const media = jsonFile("records/media.json");
    const assets = (media?.assets ?? []) as Json[];
    const assetChecks = assets.map((a) => {
      const path = media?.files?.[String(a.file)] as string | undefined;
      const bytes = path ? files[path] : undefined;
      return { assetId: a.assetId, kind: a.kind, path: path ?? null, in_package: !!bytes, length_matches: !!bytes && bytes.length === Number(a.byteLength), in_manifest: !!path && manifestFiles.some((f) => f.path === path) };
    });
    const mediaChecks = {
      records_file_present: media !== null,
      records_file_in_manifest: manifestFiles.some((f) => f.path === "records/media.json"),
      assets_listed: assets.length,
      uploaded_image_listed: assets.some((a) => a.assetId === memo.assetId),
      every_asset_file_present_and_listed: assets.length > 0 && assetChecks.every((c) => c.in_package && c.length_matches && c.in_manifest),
      none_reported_missing: ((media?.missing ?? []) as unknown[]).length === 0,
    };

    // Checksums, recomputed from the bytes.
    const checksumFailures: string[] = [];
    if (!manifest) checksumFailures.push("manifest.json is missing or unreadable");
    for (const entry of manifestFiles) {
      const bytes = files[entry.path];
      if (!bytes) checksumFailures.push(`${entry.path}: listed in the manifest but not in the package`);
      else if (bytes.length !== entry.bytes) checksumFailures.push(`${entry.path}: length differs from the manifest`);
      else if ((await sha256Hex(bytes)) !== entry.sha256) checksumFailures.push(`${entry.path}: checksum differs from the manifest`);
    }
    for (const path of Object.keys(files)) if (path !== "manifest.json" && path !== "checksums.sha256" && !manifestFiles.some((f) => f.path === path)) checksumFailures.push(`${path}: in the package but not in the manifest`);
    const sums = text("checksums.sha256");
    const sumLines = sums === null ? [] : sums.trim().split("\n");
    if (sums === null) checksumFailures.push("checksums.sha256 is missing");
    for (const line of sumLines) {
      const [sum, path] = line.split("  ");
      const bytes = path ? files[path] : undefined;
      if (!bytes) checksumFailures.push(`checksums.sha256 names a file that is not in the package: ${String(path ?? line).slice(0, 80)}`);
      else if ((await sha256Hex(bytes)) !== sum) checksumFailures.push(`${path}: checksum differs from checksums.sha256`);
    }
    const packageSha = await sha256Hex(zip);
    if (packageSha !== job.sha256) checksumFailures.push("the downloaded package's checksum differs from the one the job reports");
    if (zip.length !== Number(job.byteLength)) checksumFailures.push("the downloaded package's length differs from the one the job reports");

    // Credentials: known secrets of this owner, credential field names, credential tables.
    const leaks: string[] = [];
    for (const [path, bytes] of Object.entries(files)) {
      for (const table of CREDENTIAL_TABLES) if (path.includes(table)) leaks.push(`${path}: named after the credential table ${table}`);
      if (path.startsWith("media/")) continue; // image bytes
      const content = decoder.decode(bytes);
      for (const secret of secrets) if (secret.value.length > 0 && content.includes(secret.value)) leaks.push(`${secret.label} in ${path}`);
      const field = CREDENTIAL_FIELD.exec(content);
      if (field) leaks.push(`a credential field (${field[1]}) in ${path}`);
      if (path.startsWith("records/")) {
        const tables = Object.keys((jsonFile(path)?.tables ?? {}) as Json);
        for (const table of CREDENTIAL_TABLES) if (tables.includes(table)) leaks.push(`the credential table ${table} in ${path}`);
      }
    }
    const everything = Object.entries(files).filter(([path]) => !path.startsWith("media/")).map(([, bytes]) => decoder.decode(bytes)).join("\n");

    // Import into a fresh, empty account (journey 13) and count what reaches the outside afterwards.
    let settled = await calendarWrites(calendarId);
    for (let i = 0; i < 4; i++) {
      await runScheduled();
      const now = await calendarWrites(calendarId);
      if (now === settled) break;
      settled = now;
    }
    const target = await provisionOwner({ displayName: "Evaluation import target (SYNTHETIC, empty)" });
    const targetGarmentsBefore = Number((await target.api.json("GET", "/v1/wardrobe")).total);
    const writesBefore = await calendarWrites(calendarId);
    const logBefore = (await calendarState(calendarId)).log.length;
    const imported = await target.api.request("POST", "/v1/imports", { raw: zip, headers: { "Content-Type": "application/zip" } });
    const importText = await imported.text();
    if (imported.status !== 200) {
      await assistant?.close();
      throw new Error(`B020: importing the package into a fresh empty account was refused (${imported.status} ${importText.slice(0, 300)}), so what an import sends to the outside cannot be observed`);
    }
    const report = JSON.parse(importText) as Json;
    await runScheduled();
    await runScheduled();
    const writesAfter = await calendarWrites(calendarId);
    const targetRecovery: Json = await target.api.json("GET", "/v1/recovery");
    const targetPending = Number(targetRecovery.pending?.effects ?? 0);
    const targetToday = await boardOn(target.api, world.today);
    const logAfter = (await calendarState(calendarId)).log;
    await assistant?.close();

    return {
      observed: {
        original_history_included: wearsIncluded && commandsIncluded,
        media_manifest_included: mediaChecks.records_file_present && mediaChecks.records_file_in_manifest && mediaChecks.uploaded_image_listed && mediaChecks.every_asset_file_present_and_listed && mediaChecks.none_reported_missing,
        checksums_valid: manifestFiles.length > 0 && checksumFailures.length === 0,
        credentials_in_export: leaks.length > 0,
        external_effects_replayed_on_import: writesAfter - writesBefore + targetPending + Number(report.externalEffectsReplayed ?? 0),
      },
      evidence: {
        job: { exportId: job.exportId, state: job.state, complete: job.complete, encrypted: job.encrypted, formatVersion: job.formatVersion, byteLength: job.byteLength, components: job.components },
        export_attempts: memo.exportAttempts ?? null,
        exports_on_the_owners_list: listed.length,
        package: { bytes: zip.length, sha256_recomputed: packageSha, sha256_reported: job.sha256, files: Object.keys(files).length, file_names: Object.keys(files).sort().slice(0, 80) },
        manifest: manifest ? { format: manifest.format, complete: manifest.complete, coherent: manifest.snapshot?.coherent ?? null, files_listed: manifestFiles.length, excluded: manifest.excluded ?? null, components: ((manifest.components ?? []) as Json[]).map((c) => `${c.name}:${c.state}:${c.records}`) } : null,
        history: { worn_today_at_seed: worn, wear_rows_for_today_in_package: wearRows, wears_included: wearsIncluded, seed_commands: seedCommands, seed_commands_in_package: seedCommands.filter((id) => exportedCommands.has(id)), commands_in_package: exportedCommands.size, owners_request_in_conversation_records: ctx.mode === "conversation" ? (text("records/conversation.json") ?? "").includes(ctx.c.request) : null, readable_views: Object.keys(files).filter((p) => p.startsWith("views/")).sort() },
        media: { ...mediaChecks, uploaded_asset: memo.assetId, upload_state: memo.uploadState, image: "LABELLED TEST IMAGE uploaded through the upload routes", assets: assetChecks },
        checksums: { files_recomputed: manifestFiles.length, checksum_lines: sumLines.length, failures: checksumFailures },
        credentials: { searched_for: secrets.map((s) => s.label), field_names_searched: String(CREDENTIAL_FIELD), tables_searched: CREDENTIAL_TABLES, found: leaks, sign_in_subject_in_package: everything.includes(world.owner.identity.subject) },
        import: {
          target: "a fresh SYNTHETIC account with no garments, provisioned for this import",
          target_garments_before: targetGarmentsBefore,
          target_garments_after: Number((await target.api.json("GET", "/v1/wardrobe")).total),
          report: { importId: report.importId, state: report.state, checksumsVerified: report.checksumsVerified, idsPreserved: report.idsPreserved, externalEffectsReplayed: report.externalEffectsReplayed, error: report.error, components: report.components },
          calendar_writes_before: writesBefore,
          calendar_writes_after_two_scheduled_runs: writesAfter,
          calendar_log_since_import: logAfter.slice(logBefore).map((l) => `${l.op} ${l.status}`),
          effects_pending_in_target: targetPending,
          target_connection_issues: targetRecovery.connectionIssues ?? null,
          target_board_today_projection: targetToday?.calendarProjection ?? null,
          target_connections: (((await target.api.json("GET", "/v1/connections")).connections ?? []) as unknown[]).length,
          target_devices: (((await target.api.json("GET", "/v1/devices")).devices ?? []) as unknown[]).length,
        },
        calendar: "TEST DOUBLE Google Calendar (in-memory, the journey suite's); Google sign-in for the connection is the Worker package's OAuth fixture",
        seed_notes: memo.seedNotes,
        note: "No secret is written into this evidence: only the kinds searched for and where one was found.",
      },
    };
  },
};

/* ------------------------------------------------------------------ */

export const featureDrivers: Record<string, BehaviourDriver> = { B011, B012, B015, B016, B017, B018, B019, B020 };
