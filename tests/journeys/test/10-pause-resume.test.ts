/**
 * Journey 10: pause and resume. One owner goes away and pauses recommendations until a date; a second
 * owner, with the same schedule, stays home as the control and later pauses with no end date.
 *
 * Specification covered (requirements/garderobe-replacement-design.md):
 *  - section 9 "Pause and resume": pausing stops composition, automatic board publication and wardrobe
 *    reminders for the interval; it does not disable conversation, observations or access to existing
 *    data; the resume date is optional and no reason is required; pause state is durable and checked
 *    before queued jobs publish; managed future outfit events inside the interval are removed or
 *    suppressed; return deadlines stay active; on resume the next useful board is prepared, with no
 *    replayed notifications, no questions about missing wears and no backlog of old boards; an
 *    indefinite pause stays paused until the owner resumes.
 *  - section 9 "Schedule and deadlines" / section 16 phase 3: the morning works with no phone request
 *    and no connected assistant (the control owner's boards are composed by the scheduled run alone).
 *  - section 17 acceptance row "Pause"; data-model row "Pause, recovery, and exports".
 *
 * Everything inside the Worker is real: the HTTP API, the real `scheduled` handler (`runCron()`), the
 * daily service's phases, the Calendar projector, D1, and both owners' real profile and 127-garment
 * inventory. Test doubles relied on, all at the network boundary:
 *  - TEST DOUBLE weather (Open-Meteo wire shape) scripted mild for two fictional home places;
 *  - TEST DOUBLE Google Calendar events store, and the Worker package's labelled Google OAuth fixture
 *    used by `connectGoogle` (this proves the Worker's side of Calendar only);
 *  - test-signed sign-in. No fake model is used; the scheduled run composes deterministically.
 *
 * Time: no API makes time pass, so the phases are made due NOW through the owner's own settings
 * (`settings.update`): the morning time is set to the current minute in Europe/London and the evening
 * composition time to 00:00. Automatic resume when a resume date arrives needs days to pass and is not
 * covered. The file assumes it does not run across midnight, Europe/London.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { calendarState, connectGoogle, exec, internalCodesIn, LONDON, quantityIn, realOwnerAt, runCron, wholeWardrobe, type JourneyOwner } from "../src/world.ts";

type Receipt = { commandId: string; type: string; actor: string; outcome: string; summary: string; effects: { kind: string; state: string }[] };

const londonMinute = () => new Intl.DateTimeFormat("en-GB", { timeZone: LONDON, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
const londonDay = (instant: string) => new Intl.DateTimeFormat("en-CA", { timeZone: LONDON, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));

describe("Journey 10: pause and resume", () => {
  /** The control: same schedule, Calendar connected, not paused at first. */
  let home: JourneyOwner;
  /** The owner who goes away and pauses until a date. */
  let away: JourneyOwner;
  let calendarId = "";
  let homeBoards: { today: string; tomorrow: string };
  let awayPause: Receipt & { result: Record<string, any>; undo: { available: boolean } };
  let wornShirt = { garmentId: "", name: "" };
  let returnCaseId = "";
  let presentedBeforeHomePause = 0;

  const today = (o: JourneyOwner, date?: string) => o.owner.api.json("GET", `/v1/today${date ? `?date=${date}` : ""}`);
  const service = (o: JourneyOwner) => o.owner.api.json("GET", "/v1/service");
  const receipts = async (o: JourneyOwner, query = "limit=200"): Promise<Receipt[]> => (await o.owner.api.json("GET", `/v1/commands?${query}`)).receipts;
  const boardReceipts = (o: JourneyOwner, boardId: string) => receipts(o, `entity=board:${boardId}&limit=200`);
  /** Everything the daily service did for an owner on its own: boards published or presented, reminders queued. */
  const scheduledWork = async (o: JourneyOwner) => (await receipts(o)).filter((r) => r.type.startsWith("board.") || r.effects.some((e) => e.kind === "notification.morning_board" || e.kind === "calendar.project_board"));
  /** The managed events still standing in the TEST DOUBLE calendar, by the owner's local day. */
  const standingEvents = async (): Promise<Map<string, any[]>> => {
    const byDay = new Map<string, any[]>();
    for (const event of (await calendarState(calendarId)).events) {
      if (event.status === "cancelled") continue;
      const day = event.start?.date ?? londonDay(event.start.dateTime);
      byDay.set(day, [...(byDay.get(day) ?? []), event]);
    }
    return byDay;
  };

  beforeAll(async () => {
    home = await realOwnerAt("Pause journey, staying home");
    away = await realOwnerAt("Pause journey, going away");
  });

  it("both owners keep the same schedule, set through their own settings; the one staying home connects Calendar", async () => {
    // The morning time is now and the evening composition time is midnight, so today's morning phases and
    // tomorrow's evening composition are due for both owners at this moment (see the header: no API passes time).
    const morning = londonMinute();
    for (const o of [home, away]) {
      const receipt = await exec(o.owner.api, "settings.update", { patch: { delivery: { morningLocalTime: morning }, extensions: { daily: { eveningComposeLocalTime: "00:00" } } } });
      expect(receipt.outcome).toBe("committed");
      const read = (await o.owner.api.json("GET", "/v1/settings")).settings;
      expect(read.delivery.morningLocalTime).toBe(morning);
      expect(read.extensions.daily.eveningComposeLocalTime).toBe("00:00");
    }
    const google = await connectGoogle(home.owner);
    const created = await home.owner.api.json("POST", `/v1/connections/${google.connectionId}/outfit-calendar`, { clientRequestId: `outfit-calendar-${crypto.randomUUID()}`, name: `Outfits pause journey ${crypto.randomUUID().slice(0, 8)}` });
    expect(created.created).toBe(true);
    calendarId = created.calendar.calendarId;
    expect((await home.owner.api.json("GET", "/v1/settings")).settings.extensions.daily.calendar.outfitCalendarId).toBe(calendarId);
    expect((await calendarState(calendarId)).events).toEqual([]);
  });

  it("pausing is one command: the resume date is optional and no reason is asked for", async () => {
    // The command takes a start and an optional resume date and nothing else: there is no reason to give.
    const types = (await away.owner.api.json("GET", "/v1/command-types")).types as { type: string; payloadSchema: { properties?: Record<string, unknown>; required?: string[] } }[];
    const pause = types.find((t) => t.type === "service.pause")!;
    expect(Object.keys(pause.payloadSchema.properties ?? {}).sort()).toEqual(["from", "resumeOn"]);
    expect(pause.payloadSchema.required ?? []).toEqual([]);

    awayPause = (await exec(away.owner.api, "service.pause", { resumeOn: away.day(3) })) as never;
    expect(awayPause.outcome).toBe("committed");
    expect(awayPause.summary).toBe(`Recommendations paused from ${away.day(0)} until ${away.day(3)}. Conversation, observations and return deadlines are unaffected`);
    expect(awayPause.summary).not.toContain("?");
    expect(internalCodesIn(awayPause.summary)).toEqual([]);
    expect(awayPause.undo.available).toBe(true);
    expect(awayPause.result).toMatchObject({ from: away.day(0), resumeOn: away.day(3) });
  });

  it("the service state, Today and Settings all say it plainly; the other owner is not affected", async () => {
    const state = await service(away);
    expect(state.paused).toBe(true);
    expect(state.pause).toMatchObject({ from: away.day(0), resumeOn: away.day(3), status: "active", endedAt: null });
    expect(state.returnDeadlinesActive).toBe(true);

    const view = await today(away);
    expect(view.status).toBe("paused");
    expect(view.board).toBeNull();
    expect(view.paused).toMatchObject({ from: away.day(0), resumeOn: away.day(3) });
    expect(view.emptyReason).toBe(`Recommendations are paused until ${away.day(3)}.`);
    expect(internalCodesIn(view.emptyReason)).toEqual([]);
    // A day inside the interval says the same; the first day after it does not.
    expect((await today(away, away.day(2))).status).toBe("paused");
    expect((await today(away, away.day(3))).paused).toBeNull();

    const settings = await away.owner.api.json("GET", "/v1/settings");
    expect(settings.service).toMatchObject({ paused: true, pause: { from: away.day(0), resumeOn: away.day(3) }, returnDeadlinesActive: true });

    expect(await service(home)).toMatchObject({ paused: false, pause: null });
    expect((await today(home)).paused).toBeNull();
  });

  it("without a pause the scheduled service composes on its own: today's and tomorrow's boards and the morning reminder (control)", async () => {
    // No phone request and no assistant connection: only the Worker's scheduled handler runs.
    await runCron();

    const todayView = await today(home);
    const tomorrowView = await today(home, home.day(1));
    expect(todayView.status).toBe("ready");
    expect(todayView.board.options.length).toBeGreaterThan(0);
    expect(tomorrowView.status).toBe("ready");
    expect(tomorrowView.board.localDate).toBe(home.day(1));
    expect(tomorrowView.board.options.length).toBeGreaterThan(0);
    homeBoards = { today: todayView.board.boardId, tomorrow: tomorrowView.board.boardId };

    const forToday = await boardReceipts(home, homeBoards.today);
    const forTomorrow = await boardReceipts(home, homeBoards.tomorrow);
    // Published by the service itself, not by the owner or an assistant.
    expect(forToday.filter((r) => r.type === "board.publish").map((r) => r.actor)).toEqual(["system"]);
    expect(forTomorrow.filter((r) => r.type === "board.publish").map((r) => r.actor)).toEqual(["system"]);
    // The morning surface marked today's board as presented and queued the morning reminder once.
    const presented = forToday.filter((r) => r.type === "board.present");
    expect(presented).toHaveLength(1);
    expect(presented[0]!.effects.map((e) => e.kind)).toEqual(["notification.morning_board"]);
    expect(forTomorrow.filter((r) => r.type === "board.present")).toEqual([]);
  });

  it("while paused, the same scheduled runs publish no board and queue no morning reminder", async () => {
    // The run above was due for this owner on exactly the same schedule; a second run changes nothing either.
    await runCron();

    for (const date of [away.day(0), away.day(1)]) {
      const view = await today(away, date);
      expect(view.board).toBeNull();
      expect(view.status).toBe("paused");
      expect(view.emptyReason).toBe(`Recommendations are paused until ${away.day(3)}.`);
    }
    expect(await scheduledWork(away)).toEqual([]);
    expect(await service(away)).toMatchObject({ paused: true });
    // The private web board says the same thing in words.
    const page = await away.owner.api.get("/board");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`Recommendations are paused until ${away.day(3)}.`);
  });

  it("observations still work while paused: a wear report and a wash report both commit", async () => {
    const shirt = (await wholeWardrobe(away.owner.api)).items.find((i) => i.garment.category === "shirt" && i.garment.careChannel === "service" && i.totalOwnedUnits === 1 && quantityIn(i, "clean") === 1)!;
    wornShirt = { garmentId: shirt.garment.garmentId, name: shirt.garment.name };

    const worn = await exec(away.owner.api, "wear.record", { wearingDate: away.day(0), garmentIds: [wornShirt.garmentId] });
    expect(worn.outcome).toBe("committed");
    expect(worn.summary).toBe(`Recorded for today: ${wornShirt.name}`);
    let read = await away.owner.api.json("GET", `/v1/items/${wornShirt.garmentId}`);
    expect(read.detail.recordedWearCount).toBe(1);
    expect(quantityIn(read.detail, "clean")).toBe(0);
    expect(quantityIn(read.detail, "dirty")).toBe(1);
    const view = await today(away);
    expect(view.dayRecord.map((g: any) => g.garmentId)).toEqual([wornShirt.garmentId]);
    expect(view.status).toBe("paused");

    const washed = await exec(away.owner.api, "care.washed", { items: [{ garmentId: wornShirt.garmentId }] });
    expect(washed.outcome).toBe("committed");
    expect(washed.summary).toBe(`Washed and clean: ${wornShirt.name}`);
    read = await away.owner.api.json("GET", `/v1/items/${wornShirt.garmentId}`);
    expect(quantityIn(read.detail, "clean")).toBe(1);
    expect(quantityIn(read.detail, "dirty")).toBe(0);
    // Existing data stays readable too.
    expect((await wholeWardrobe(away.owner.api)).total).toBeGreaterThanOrEqual(127);
  });

  it("return deadlines stay active during the pause: a return opened now gets its deadline and its reminders", async () => {
    // A return needs an item the owner would send back; he owns none, so this is a labelled SYNTHETIC garment.
    const garment = await exec(away.owner.api, "garment.create", { name: "SYNTHETIC overshirt to send back (journey 10)", category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, isSynthetic: true, source: { kind: "system", note: "synthetic item for journey 10" } });
    const opened = await exec(away.owner.api, "return.open_case", {
      kind: "return",
      garmentId: garment.result.garmentId,
      terms: { windowDays: 30, concerns: "post", triggerEvent: "delivery", sourceRef: "https://synthetic-shop.example.test/returns (SYNTHETIC terms page)", checkedOn: away.day(0) },
      triggerDate: away.day(0),
    });
    returnCaseId = opened.result.caseId;
    expect(opened.outcome).toBe("committed");
    expect(opened.result.deadline.status).toBe("established");
    expect(opened.result.reminders.map((r: any) => r.daysBefore)).toEqual([7, 2]);
    expect(opened.effects.map((e) => `${e.kind}:${e.state}`)).toEqual(["notification.return_reminder:pending", "notification.return_reminder:pending"]);

    // Scheduled runs during the pause leave the case and its deadline as they are.
    await runCron();
    const read = (await away.owner.api.json("GET", "/v1/returns")).returns.find((c: any) => c.caseId === returnCaseId);
    expect(read.state).toBe("considering");
    expect(read.deadline).toEqual(opened.result.deadline);
    expect((await service(away)).returnDeadlinesActive).toBe(true);
    expect(await service(away)).toMatchObject({ paused: true });
  });

  it("pausing from tomorrow with no resume date removes tomorrow's managed Calendar event and leaves today's alone", async () => {
    // By now the scheduled runs have delivered both of the control owner's boards to the outfit calendar.
    const before = await standingEvents();
    expect(before.get(home.day(0))).toHaveLength(1);
    expect(before.get(home.day(1))).toHaveLength(1);
    presentedBeforeHomePause = (await boardReceipts(home, homeBoards.today)).filter((r) => r.type === "board.present").length;

    const paused = await exec(home.owner.api, "service.pause", { from: home.day(1) });
    expect(paused.outcome).toBe("committed");
    expect(paused.summary).toBe(`Recommendations paused from ${home.day(1)} until you resume. Conversation, observations and return deadlines are unaffected`);
    expect(internalCodesIn(paused.summary)).toEqual([]);
    expect(await service(home)).toMatchObject({ paused: true, pause: { from: home.day(1), resumeOn: null, status: "active" } });
    // Today is before the interval: today's board is still there and today is not reported as paused.
    const todayView = await today(home);
    expect(todayView.status).toBe("ready");
    expect(todayView.paused).toBeNull();

    await runCron();

    const after = await standingEvents();
    expect(after.get(home.day(1)) ?? []).toEqual([]);
    expect(after.get(home.day(0))).toHaveLength(1);
    expect(after.get(home.day(0))![0].id).toBe(before.get(home.day(0))![0].id);
    const tomorrowView = await today(home, home.day(1));
    expect(tomorrowView.paused).toMatchObject({ from: home.day(1), resumeOn: null });
    expect(tomorrowView.board.calendarProjection.state).toBe("suppressed");
    expect((await today(home)).board.calendarProjection.state).toBe("projected");
  });

  it("an indefinite pause stays paused across scheduled runs, and the dated pause has not ended early either", async () => {
    const tomorrowBefore = (await today(home, home.day(1))).board;
    await runCron();
    await runCron();

    expect(await service(home)).toMatchObject({ paused: true, pause: { from: home.day(1), resumeOn: null, status: "active", endedAt: null } });
    const tomorrowAfter = (await today(home, home.day(1))).board;
    expect(tomorrowAfter.revision).toBe(tomorrowBefore.revision);
    expect((await boardReceipts(home, homeBoards.tomorrow)).filter((r) => r.type === "board.present")).toEqual([]);
    expect((await standingEvents()).get(home.day(1)) ?? []).toEqual([]);
    // A paused day far ahead reads as paused too: there is no end date.
    expect((await today(home, home.day(9))).paused).toMatchObject({ resumeOn: null });

    expect(await service(away)).toMatchObject({ paused: true, pause: { resumeOn: away.day(3) } });
    expect(await scheduledWork(away)).toEqual([]);
  });

  it("resuming early is one command, answered plainly", async () => {
    const resumed = await exec(away.owner.api, "service.resume", {});
    expect(resumed.outcome).toBe("committed");
    expect(resumed.summary).toMatch(/^Recommendations resumed\./);
    expect(resumed.summary).toMatch(/nothing from the pause is replayed/);
    expect(resumed.summary).not.toContain("?");
    expect(internalCodesIn(resumed.summary)).toEqual([]);
    expect(await service(away)).toMatchObject({ paused: false, pause: null, returnDeadlinesActive: true });
    const view = await today(away);
    expect(view.paused).toBeNull();
    expect(view.status).not.toBe("paused");
    expect((await away.owner.api.json("GET", "/v1/settings")).service.paused).toBe(false);
    // Resuming when nothing is paused changes nothing.
    expect((await exec(away.owner.api, "service.resume", {})).outcome).toBe("noop");
  });

  it("after the owner resumes, the next useful board is prepared", async () => {
    // Was defect D10-1 (no board was prepared); fixed by the API thread in 5db4fd87.
    // The receipt said "The next board is being prepared". Give the scheduled service a run to do it.
    await runCron();
    const todayView = await today(away);
    const tomorrowView = await today(away, away.day(1));
    const prepared = [todayView, tomorrowView].filter((v) => v.board !== null).map((v) => v.localDate);
    expect(prepared.length).toBeGreaterThan(0);
  });

  it("resume replays nothing: no backlog of boards, no missed morning reminder, no questions about what was worn", async () => {
    const work = await scheduledWork(away);
    // No board for a day that passed while paused, and no reminder or presentation for the morning that was missed.
    expect(work.filter((r) => r.type === "board.present")).toEqual([]);
    expect(work.flatMap((r) => r.effects).filter((e) => e.kind === "notification.morning_board")).toEqual([]);
    expect((await today(away, away.day(-1))).board).toBeNull();
    // Nothing waits for an answer.
    expect(await away.owner.api.json("GET", "/v1/proposals")).toMatchObject({ proposals: [], pending: 0 });
    expect(await away.owner.api.json("GET", "/v1/conversation/messages")).toMatchObject({ messages: [], total: 0 });
    const view = await today(away);
    expect(view.runId).toBeNull();
    expect(view.emptyReason ?? "").not.toContain("?");
    // What he reported while paused is still on record.
    expect(view.dayRecord.map((g: any) => g.garmentId)).toEqual([wornShirt.garmentId]);
    expect((await away.owner.api.json("GET", `/v1/items/${wornShirt.garmentId}`)).detail.recordedWearCount).toBe(1);
    expect((await away.owner.api.json("GET", "/v1/returns")).returns.find((c: any) => c.caseId === returnCaseId).deadline.status).toBe("established");
  });

  it("a pause given no dates at all starts today and has no end; Undo removes it", async () => {
    const paused = await exec(away.owner.api, "service.pause", {});
    expect(paused.outcome).toBe("committed");
    expect(paused.summary).toBe(`Recommendations paused from ${away.day(0)} until you resume. Conversation, observations and return deadlines are unaffected`);
    expect(paused.undo.available).toBe(true);
    const view = await today(away);
    expect(view.status === "paused" || view.paused !== null).toBe(true);
    expect(view.paused).toMatchObject({ from: away.day(0), resumeOn: null });
    expect(await service(away)).toMatchObject({ paused: true, pause: { resumeOn: null } });

    const undone = await exec(away.owner.api, "command.undo", { commandId: paused.commandId });
    expect(undone.outcome).toBe("committed");
    expect(undone.summary).toMatch(/Pause removed/);
    expect(await service(away)).toMatchObject({ paused: false, pause: null });
    expect((await today(away)).paused).toBeNull();
  });

  it("when the owner at home resumes, tomorrow's event returns for the board already prepared, and nothing is replayed", async () => {
    const boardBefore = (await today(home, home.day(1))).board;
    const resumed = await exec(home.owner.api, "service.resume", {});
    expect(resumed.outcome).toBe("committed");
    expect(await service(home)).toMatchObject({ paused: false, pause: null });

    await runCron();

    const events = await standingEvents();
    expect(events.get(home.day(1))).toHaveLength(1);
    expect(events.get(home.day(0))).toHaveLength(1);
    // The same board, not a second one, is what tomorrow shows.
    const tomorrowView = await today(home, home.day(1));
    expect(tomorrowView.paused).toBeNull();
    expect(tomorrowView.board.boardId).toBe(boardBefore.boardId);
    expect(tomorrowView.board.options.length).toBeGreaterThan(0);
    expect(tomorrowView.board.calendarProjection.state).toBe("projected");
    // Today's morning reminder was queued once, before the pause, and is not queued again by the resume.
    expect((await boardReceipts(home, homeBoards.today)).filter((r) => r.type === "board.present")).toHaveLength(presentedBeforeHomePause);
    expect(presentedBeforeHomePause).toBe(1);
    expect((await boardReceipts(home, homeBoards.tomorrow)).filter((r) => r.type === "board.present")).toEqual([]);
  });
});
