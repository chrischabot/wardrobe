/**
 * Journey 05: reality changes. A wear repairs the outfits planned for later days, and the Calendar
 * event is replaced by the newest revision, never appended to or duplicated.
 *
 * Specification: section 8 (repair after reality changes), section 9 (Calendar as a dependable
 * presentation; schedule), section 7 (calendar influence and a varied day board); acceptance rows
 * "Repair", "Selected future repair", "Calendar", "Calendar influence", "Concurrency" (stale plan edits).
 *
 * Real: the Worker, its cron handler, the daily service's projector and Google Calendar adapter.
 * Stand-ins (external boundaries only): the in-memory Google Calendar double and the Open-Meteo double
 * (src/outbound.ts), Google's OAuth endpoints (the Worker package's labelled fixture), test-signed
 * sign-in. None of this proves anything about Google's real service.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { defect } from "../src/defect.ts";
import { connectMcp, publishBoard, type TestOwner } from "@garderobe/worker/testing";
import { boardTexts, calendarFaults, calendarState, connectOutfitCalendar, editCalendarEvent, eventsOn, exec, internalCodesIn, mcpCommand, readCalendarFrom, realOwnerAt, runCron, seedCalendar, type JourneyOwner } from "../src/world.ts";

const piece = (option: any, role: string) => option.garments.find((g: any) => g.role === role);
const ids = (option: any) => option.garments.map((g: any) => g.garmentId);
const revisionOf = (event: any) => Number(event.extendedProperties.private.garderobeRevision);
const COMPLETE = ["top", "bottom", "socks", "footwear"];

describe("wearing a planned garment repairs later days and the existing Calendar event", () => {
  let j: JourneyOwner;
  let owner: TestOwner;
  let calendarId: string;
  let planned: any; // the board for the day after tomorrow, as first published
  let chosen: any; // the option the owner chose on it
  let wornTop: any;
  let wear: any;
  let repaired: any;
  const boardOf = (date: string) => owner.api.json("GET", `/v1/today?date=${date}`).then((t: any) => t.board);

  beforeAll(async () => {
    j = await realOwnerAt("Repair");
    owner = j.owner;
    ({ calendarId } = await connectOutfitCalendar(owner));
    planned = (await publishBoard(owner, { date: j.day(2) })).board;
  });

  it("delivers the prepared board as one managed Calendar event with no phone or assistant involved", async () => {
    expect(planned.calendarProjection.state).toBe("pending"); // never "projected" before it is verified
    await runCron();
    const events = await eventsOn(calendarId, j.day(2));
    expect(events).toHaveLength(1);
    const event = events[0]!;
    // A transparent, timed 7:00 to 7:15 event in the owner's timezone (the default presentation).
    expect(event.start.timeZone).toBe("Europe/London");
    expect(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" }).format(new Date(event.start.dateTime))).toBe("07:00");
    expect(Date.parse(event.end.dateTime) - Date.parse(event.start.dateTime)).toBe(15 * 60_000);
    expect(event.transparency).toBe("transparent");
    // Nobody is invited and nobody is notified; Calendar's own default reminders are not used.
    expect(event.attendees).toBeUndefined();
    expect(event.reminders.useDefault).toBe(false);
    const log = (await calendarState(calendarId)).log.filter((l) => l.eventId === event.id);
    for (const write of log.filter((l) => l.op !== "get")) {
      expect(write.hasAttendees).toBe(false);
      expect(write.sendUpdates).toBe("none");
    }
    expect(revisionOf(event)).toBe(1);
    const board = await boardOf(j.day(2));
    expect(board.calendarProjection).toMatchObject({ state: "projected", projectedRevision: 1 });
  });

  it("writes the Calendar text from the same board: day line, then each outfit with why it works and its pieces, no codes", async () => {
    const event = (await eventsOn(calendarId, j.day(2)))[0]!;
    const text: string = event.description;
    expect(text.startsWith(planned.dayLine)).toBe(true);
    let cursor = 0;
    for (const option of planned.options) {
      const at = text.indexOf(`${option.number}. ${option.name}`, cursor);
      expect(at, `option ${option.number} in order`).toBeGreaterThan(cursor - 1);
      expect(text.indexOf(option.reason, at)).toBeGreaterThan(at);
      for (const line of option.garments) expect(text).toContain(line.name);
      cursor = at + 1;
    }
    // Blank lines between everything: built for the half-awake glance.
    expect(text.split("\n\n").length).toBeGreaterThanOrEqual(planned.options.length + 1);
    // Perceptible garment lines in the profile's order.
    const firstBlock = text.split("\n\n")[1]!.split("\n").slice(2).map((l) => l.split(":")[0]);
    expect(firstBlock).toEqual(["Jacket", "Shirt", "Trousers", "Belt", "Socks and shoes"].filter((l) => firstBlock.includes(l)));
    expect(firstBlock.at(-1)).toBe("Socks and shoes");
    // No item codes, job traces, laundry diagnostics or status headings in the outfit copy.
    expect(internalCodesIn(text.replace(/https?:\/\/\S+/g, ""))).toEqual([]);
    expect(text).not.toMatch(/revision|status:|pending|laundry|awaiting|estimate/i);
    expect(event.summary).toMatch(/^Outfits for /);
  });

  defect("D05-1", "the Calendar event links to that day's board, so a tap opens the app or the web board", async () => {
    // Specification section 9: "A normal HTTPS link opens the corresponding app view when installed and
    // the web view otherwise" and "Its link opens the current board". With the owner's settings as
    // imported (nothing configured by hand) the event carries no link at all.
    const event = (await eventsOn(calendarId, j.day(2)))[0]!;
    expect(`${event.description} ${event.source?.url ?? ""}`).toMatch(new RegExp(`https?://\\S+/board/${j.day(2)}`));
  });

  it("a connected assistant relays the owner's choice for that day; it is an intention, with a receipt", async () => {
    const mcp = await connectMcp(owner, { write: true, clientName: "Planner" });
    chosen = planned.options[2];
    const outcome = await mcpCommand(owner, mcp, "board.select", { boardId: planned.boardId, optionId: chosen.optionId });
    expect(outcome.receipt.outcome).toBe("committed");
    expect(outcome.receipt.type).toBe("board.select");
    if (outcome.proposal) {
      // When the server keeps the request for the owner, what he confirms is described, not just identified.
      expect(outcome.proposal.summary).toMatch(/outfit/i);
      expect(outcome.proposal.source.assistantName).toBe("Planner");
    }
    await mcp.close();
    const board = await boardOf(j.day(2));
    expect(board.selection.optionId).toBe(chosen.optionId);
    expect((await owner.api.json("GET", `/v1/days/${j.day(2)}`)).garments).toEqual([]);
  });

  it("today he wears the shirt planned for that day: the wear is recorded at once and says what it changed", async () => {
    wornTop = piece(chosen, "top");
    wear = await exec(owner.api, "wear.record", { wearingDate: j.day(0), garmentIds: [wornTop.garmentId] });
    expect(wear.outcome).toBe("committed");
    expect(wear.summary).toBe(`Recorded for today: ${wornTop.name}`);
    // The receipt names the repaired board and the changed piece in his words, and asks nothing.
    expect(wear.repairs).toHaveLength(1);
    expect(wear.repairs[0]).toContain(wornTop.name);
    expect(wear.repairs[0]).not.toMatch(/\?/);
    expect(internalCodesIn(wear.repairs[0].replace(/\d{4}-\d{2}-\d{2}/g, ""))).toEqual([]);
    expect(wear.affected.some((a: any) => a.kind === "board" && a.id === planned.boardId)).toBe(true);
    // The Calendar update is queued, and honestly reported as not yet delivered.
    expect(wear.externalEffectState).toBe("projection_pending");
    expect(wear.effects.map((e: any) => e.kind)).toContain("calendar.project_board");
    // The actual wear is history: recorded for today, whatever was planned.
    expect((await owner.api.json("GET", `/v1/days/${j.day(0)}`)).garments.map((g: any) => g.garmentId)).toEqual([wornTop.garmentId]);
  });

  it("the later board no longer offers the worn shirt, and is still a full board of complete outfits", async () => {
    repaired = await boardOf(j.day(2));
    expect(repaired.boardId).toBe(planned.boardId);
    expect(repaired.revision).toBeGreaterThan(planned.revision);
    for (const option of repaired.options) {
      expect(ids(option)).not.toContain(wornTop.garmentId);
      // An option is never a pending placeholder: every one is a complete outfit.
      for (const role of COMPLETE) expect(piece(option, role), `${role} in option ${option.number}`).toBeTruthy();
    }
    expect(repaired.options).toHaveLength(planned.requestedCount);
    expect(repaired.validity).toBe("current");
    for (const text of boardTexts(repaired)) expect(internalCodesIn(text), text).toEqual([]);
  });

  it("leaves the four unaffected outfits exactly as they were, under the same identities", () => {
    for (const before of planned.options.filter((o: any) => o.optionId !== chosen.optionId)) {
      const after = repaired.options.find((o: any) => o.optionId === before.optionId);
      expect(after, `option ${before.number} is still offered`).toBeTruthy();
      expect(ids(after)).toEqual(ids(before));
    }
  });

  it("repairs the chosen outfit in place: same option, only the worn shirt replaced, still chosen", () => {
    // Specification section 8: a suggestion that depends on a garment made unavailable by a wear "is
    // automatically repaired, including a previously selected future option. Preserve the brief and
    // unaffected slots, replace the unavailable piece".
    const after = repaired.options.find((o: any) => o.optionId === chosen.optionId);
    expect(after, "the chosen option keeps its identity").toBeTruthy();
    for (const role of ["outer", "bottom", "belt", "socks", "footwear"]) expect(piece(after, role)?.garmentId, role).toBe(piece(chosen, role)?.garmentId);
    expect(piece(after, "top").garmentId).not.toBe(wornTop.garmentId);
    expect(repaired.selection?.optionId).toBe(chosen.optionId);
  });

  it("shows a concise note of what changed, on the option and in the wear's receipt", () => {
    // Specification section 8: "Keep the prior revision in history and show a concise changed-item receipt."
    const after = repaired.options.find((o: any) => o.optionId === chosen.optionId);
    expect(wear.result.boardRepairs[0].changes.join(" ")).toContain(wornTop.name);
    expect(wear.result.boardRepairs[0].changes.join(" ")).toContain(piece(after, "top").name);
    expect(wear.result.boardRepairs[0].selectionKept).toBe(true);
  });

  it("replaces the contents of the existing Calendar event with the newest revision: no second event, no stale shirt", async () => {
    const before = (await eventsOn(calendarId, j.day(2)))[0]!;
    await runCron();
    const events = await eventsOn(calendarId, j.day(2));
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.id).toBe(before.id);
    const board = await boardOf(j.day(2));
    expect(revisionOf(event)).toBe(board.revision);
    expect(board.calendarProjection).toMatchObject({ state: "projected", projectedRevision: board.revision });
    expect(event.description).not.toContain(wornTop.name);
    // Replaced, not appended: each option heading appears once.
    for (const option of board.options) expect(event.description.split(`${option.number}. ${option.name}`).length - 1).toBe(1);
    expect((event.description.match(/^\d\. /gm) ?? []).length).toBe(board.options.length);
    // The update was conditional on the version last seen, and was read back before being called done.
    const log = (await calendarState(calendarId)).log.filter((l) => l.eventId === event.id);
    const patch = log.filter((l) => l.op === "patch").at(-1)!;
    expect(patch.ifMatch).toBe(before.etag);
    expect(log.filter((l) => l.op === "insert")).toHaveLength(1);
    expect(log.at(-1)!.op).toBe("get");
  });

  defect("D05-2", "the wear's receipt, read again after delivery, no longer says its Calendar update is pending", async () => {
    // Specification section 8: "The receipt acknowledges what was recorded and distinguishes any pending
    // synchronization or projection." The stored receipt keeps the state from the moment of the commit,
    // so the item's history says "projection pending" for ever, although the event was updated and verified.
    const board = await boardOf(j.day(2));
    expect(board.calendarProjection.state).toBe("projected");
    const receipt = await owner.api.json("GET", `/v1/commands/${wear.commandId}`);
    expect(receipt.externalEffectState).not.toBe("projection_pending");
    expect(receipt.effects.every((e: any) => ["projected", "superseded"].includes(e.state))).toBe(true);
  });

  it("the worn shirt stays out of every board for the next seven days", async () => {
    for (const offset of [1, 6]) {
      const board = (await publishBoard(owner, { date: j.day(offset) })).board;
      for (const option of board.options) expect(ids(option), `day +${offset}`).not.toContain(wornTop.garmentId);
    }
  });
});

describe("the Calendar event is a dependable presentation of the board", () => {
  let j: JourneyOwner;
  let owner: TestOwner;
  let calendarId: string;
  let connectionId: string;
  let board: any;
  const boardOf = (date: string) => owner.api.json("GET", `/v1/today?date=${date}`).then((t: any) => t.board);
  const swap = (role: string, optionIndex: number) => owner.api.json("POST", `/v1/boards/${board.boardId}/swap`, { clientRequestId: `swap-${crypto.randomUUID()}`, optionId: board.options[optionIndex].optionId, role }).then((r: any) => (board = r.board));
  const theEvent = async () => {
    const events = await eventsOn(calendarId, j.day(2));
    expect(events).toHaveLength(1);
    return events[0]!;
  };

  beforeAll(async () => {
    j = await realOwnerAt("Calendar");
    owner = j.owner;
    ({ calendarId, connectionId } = await connectOutfitCalendar(owner));
    board = (await publishBoard(owner, { date: j.day(2) })).board;
    await runCron();
  });

  it("keeps his own note and unrelated event fields when the board changes", async () => {
    const event = await theEvent();
    await editCalendarEvent(calendarId, event.id, { description: `${event.description}\n\nMy own note: collect the dry cleaning`, location: "Home", colorId: "7" });
    await swap("bottom", 4);
    await runCron();
    const after = await theEvent();
    expect(revisionOf(after)).toBe(board.revision);
    expect(after.description).toContain("My own note: collect the dry cleaning");
    expect(after.location).toBe("Home");
    expect(after.colorId).toBe("7");
    expect((after.description.match(/^\d\. /gm) ?? []).length).toBe(board.options.length);
  });

  it("replaces his edit of the managed outfit text with the next authoritative revision", async () => {
    const event = await theEvent();
    await editCalendarEvent(calendarId, event.id, { description: event.description.replace(board.options[0].name, "MY OWN RENAMING") });
    await swap("bottom", 3);
    await runCron();
    const after = await theEvent();
    expect(revisionOf(after)).toBe(board.revision);
    expect(after.description).not.toContain("MY OWN RENAMING");
    expect(after.description).toContain(board.options[0].name);
    expect((after.description.match(/^\d\. /gm) ?? []).length).toBe(board.options.length);
  });

  defect("D05-3", "his own note survives even when he also edited the outfit text", async () => {
    // Specification section 9: updates "preserve unmanaged content"; "A user edit to the managed outfit
    // text can be replaced by the next authoritative projection; preserve unrelated event fields and
    // content." Once the managed text has been edited, the next projection replaces the whole
    // description and the owner's note is lost with it.
    const after = await theEvent();
    expect(after.description).toContain("My own note: collect the dry cleaning");
  });

  it("when a write lands but its response is lost, it looks the event up instead of creating another", async () => {
    await calendarFaults(calendarId, { loseResponses: 1 });
    await swap("top", 3);
    await runCron();
    await calendarFaults(calendarId, { loseResponses: 0 });
    const event = await theEvent(); // still exactly one
    expect(revisionOf(event)).toBe(board.revision);
    const now = await boardOf(j.day(2));
    // Either it already verified the revision by reading it back, or it honestly still says pending.
    if (now.calendarProjection.state === "projected") expect(now.calendarProjection.projectedRevision).toBe(board.revision);
    else expect(now.calendarProjection.state).toBe("pending");
    const log = (await calendarState(calendarId)).log.filter((l) => l.eventId === event.id);
    expect(log.filter((l) => l.op.startsWith("insert"))).toHaveLength(1);
  });

  it("during a Calendar outage it never claims delivery, keeps the failure visible, and the app board still works", async () => {
    const delivered = revisionOf(await theEvent());
    await calendarFaults(calendarId, { failWrites: 50 });
    await swap("top", 1);
    await runCron();
    const during = await boardOf(j.day(2));
    expect(during.revision).toBe(board.revision);
    expect(during.calendarProjection.state).not.toBe("projected");
    expect(during.calendarProjection.projectedRevision).toBeLessThan(during.revision);
    expect(revisionOf(await theEvent())).toBe(delivered); // the old contents are still what Calendar shows
    const recovery = await owner.api.json("GET", "/v1/recovery");
    expect(recovery.pending.effects).toBeGreaterThan(0);
    expect(recovery.actions).toContain("retry");
    expect(JSON.stringify(recovery)).not.toMatch(/token|secret/i);
    // The board in the app and on the web is the current one regardless.
    expect(during.options.find((o: any) => o.optionId === board.options[1].optionId).changedInRevision).toBe(true);
    expect((await owner.api.with({ client: "web" }).get(`/board/${j.day(2)}`)).status).toBe(200);
  });

  it("after the outage the newest revision is delivered, and no older one can come back over it", async () => {
    await calendarFaults(calendarId, { failWrites: 0 });
    await swap("bottom", 2);
    await runCron();
    await runCron();
    const event = await theEvent();
    expect(revisionOf(event)).toBe(board.revision);
    expect((await boardOf(j.day(2))).calendarProjection).toMatchObject({ state: "projected", projectedRevision: board.revision });
    // Revisions written to the event only ever went up.
    const written = (await calendarState(calendarId)).log.filter((l) => l.eventId === event.id && l.status === 200 && l.revision !== null).map((l) => Number(l.revision));
    expect(written).toEqual([...written].sort((a, b) => a - b));
    expect(written.at(-1)).toBe(board.revision);
  });

  it("removing that day's board removes its event, and retries cannot bring it back until he restores it", async () => {
    const removed = await exec(owner.api, "board.suppress", { localDate: j.day(2) });
    expect(removed.summary).toMatch(/removed/i);
    await runCron();
    await runCron();
    expect((await theEvent()).status).toBe("cancelled");
    const view = await owner.api.json("GET", `/v1/today?date=${j.day(2)}`);
    expect(view.board.validity).toBe("suppressed");
    expect(view.emptyReason).toMatch(/removed/i);
    const restored = await exec(owner.api, "board.restore", { localDate: j.day(2) });
    expect(restored.outcome).toBe("committed");
    await runCron();
    await runCron(); // the restored board is rechecked in one sweep and delivered by the next
    const event = await theEvent(); // the same event, confirmed again; not a new one
    expect(event.status).toBe("confirmed");
    board = await boardOf(j.day(2));
    expect(board.validity).not.toBe("suppressed");
    expect(revisionOf(event)).toBe(board.revision);
  });

  it("an event he deletes in Calendar stays deleted, the app board keeps working, and an explicit restore returns it", async () => {
    const event = await theEvent();
    await editCalendarEvent(calendarId, event.id, { status: "cancelled" });
    await swap("top", 0);
    await runCron();
    await runCron();
    expect((await theEvent()).status).toBe("cancelled");
    const view = await boardOf(j.day(2));
    expect(view.calendarProjection.state).toBe("suppressed");
    expect(view.options.length).toBe(board.options.length);
    await exec(owner.api, "board.restore", { localDate: j.day(2) });
    await runCron();
    await runCron();
    const back = await theEvent();
    expect(back.status).toBe("confirmed");
    expect(revisionOf(back)).toBe((await boardOf(j.day(2))).revision);
  });

  it("an all-day presentation is an all-day event, not a 7 AM one", async () => {
    await exec(owner.api, "settings.update", { patch: { extensions: { daily: { calendar: { presentation: "all_day" } } } } });
    await publishBoard(owner, { date: j.day(4) });
    await runCron();
    const events = await eventsOn(calendarId, j.day(4));
    expect(events).toHaveLength(1);
    expect(events[0]!.start.date).toBe(j.day(4));
    expect(events[0]!.start.dateTime).toBeUndefined();
  });

  it("with Calendar disconnected the board keeps working and he gets one concise connection action", async () => {
    const disconnected = await owner.api.json("POST", `/v1/connections/${connectionId}/disconnect`, {});
    expect(disconnected.connection.state).toBe("disconnected");
    board = await boardOf(j.day(2));
    await swap("bottom", 0);
    await runCron();
    const view = await boardOf(j.day(2));
    expect(view.revision).toBe(board.revision);
    expect(view.calendarProjection.state).toBe("not_connected");
    expect(view.calendarProjection.projectedRevision).toBeLessThan(view.revision); // never claims the failed projection succeeded
    expect(view.calendarProjection.action).toMatch(/connect/i);
    expect(view.calendarProjection.action.length).toBeLessThan(140);
    expect(internalCodesIn(view.calendarProjection.action)).toEqual([]);
    expect((await owner.api.with({ client: "web" }).get(`/board/${j.day(2)}`)).status).toBe(200);
  });
});

describe("the calendar shapes part of the board", () => {
  let j: JourneyOwner;
  let owner: TestOwner;
  const contextCalendar = `context-${crypto.randomUUID().slice(0, 8)}@journey.test`;
  const at = (date: string, time: string) => ({ dateTime: `${date}T${time}:00+01:00`, timeZone: "Europe/London" });

  beforeAll(async () => {
    j = await realOwnerAt("Influence");
    owner = j.owner;
    await connectOutfitCalendar(owner);
    await readCalendarFrom(owner, contextCalendar);
    await seedCalendar(contextCalendar, [
      { id: "evt-dinner", summary: "Client dinner", start: at(j.day(2), "19:00"), end: at(j.day(2), "21:30"), attendees: [{ self: true, responseStatus: "accepted" }] },
      { id: "evt-declined", summary: "Opera reception", start: at(j.day(2), "18:00"), end: at(j.day(2), "19:00"), attendees: [{ self: true, responseStatus: "declined" }] },
      { id: "evt-only-declined", summary: "Board meeting", start: at(j.day(3), "10:00"), end: at(j.day(3), "11:00"), attendees: [{ self: true, responseStatus: "declined" }] },
    ]);
  });

  it("an accepted dinner shapes a subset of the options and the rest stay useful alternatives", async () => {
    const board = (await publishBoard(owner, { date: j.day(2) })).board;
    expect(board.freshness.calendar).toBe("ok");
    expect(board.options).toHaveLength(5);
    const suited = board.options.filter((o: any) => o.suitsEventIds.includes("evt-dinner"));
    expect(suited.length).toBeGreaterThan(0);
    expect(suited.length).toBeLessThan(board.options.length);
    // He is told how many work for it, in a sentence, outside the outfit copy.
    expect(board.suitabilityLine).toBeTruthy();
    expect(board.suitabilityLine).toMatch(/dinner/i);
    expect(internalCodesIn(board.suitabilityLine)).toEqual([]);
    // The day line closes on the shape of the day.
    expect(board.dayLine).toMatch(/commitment|dinner/i);
    expect(board.dayLine).toContain("19:00");
    // The declined event imposes nothing and is not mentioned.
    for (const option of board.options) expect(option.suitsEventIds).not.toContain("evt-declined");
    for (const text of boardTexts(board)) expect(text).not.toMatch(/opera/i);
  });

  it("a day whose only event he declined is planned as a free day, and an empty calendar is not a missing one", async () => {
    const board = (await publishBoard(owner, { date: j.day(3) })).board;
    expect(board.freshness.calendar).toBe("ok");
    expect(board.suitabilityLine).toBeNull();
    for (const option of board.options) expect(option.suitsEventIds).toEqual([]);
    for (const text of boardTexts(board)) expect(text).not.toMatch(/board meeting/i);
    expect(board.notice ?? "").not.toMatch(/calendar/i);
  });

  it("when the calendar cannot be read it says so, and does not treat the error as a free day", async () => {
    // An unknown calendar answers like a real outage for reads: the double has no such calendar to list,
    // so the adapter's request for the owner's revoked connection fails once the grant is gone.
    const connections = await owner.api.json("GET", "/v1/connections");
    await owner.api.json("POST", `/v1/connections/${connections.connections[0].connectionId}/disconnect`, {});
    const board = (await publishBoard(owner, { date: j.day(5) })).board;
    expect(board.freshness.calendar).toBe("not_connected");
    expect(`${board.notice}`).toMatch(/calendar/i);
    expect(board.dayLine).not.toMatch(/nothing fixed/i);
  });
});
