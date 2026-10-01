/**
 * Repair after reality changes: a published future outfit is repaired automatically, inside the commit
 * of the command that changed the facts, for availability, wear, restrictions and other owner
 * observations; forecast and calendar changes are repaired by the next scheduled phase. Real command
 * service, real local D1, real owner data; labelled fakes only behind the weather and Calendar ports.
 */
import { describe, expect, it } from "vitest";
import type { BoardDocument } from "@garderobe/contracts/ext/daily";
import { all, first } from "@garderobe/domain";
import type { TestOwner } from "@garderobe/domain/testing";
import { getBoard, getToday, projectCalendarEffects, replenishBoards, runOwnerPhase, validateOutfit } from "../src/index.ts";
import { compose, createDailyHarness, garmentsByName, MILD_DAY, OUTFIT_CALENDAR, realOwner, syntheticOwner, system, WARM_DAY, type DailyHarness } from "./helpers.ts";

const piece = (o: BoardDocument["options"][number], role: string) => o.garments.find((g) => g.role === role);
const idsOf = (o: BoardDocument["options"][number]) => [...o.garments.map((g) => g.garmentId), ...o.footwearAlternatives.map((g) => g.garmentId), ...(o.flourish ? [o.flourish.garmentId] : [])];

async function expectEveryOptionValid(h: DailyHarness, owner: TestOwner, doc: BoardDocument): Promise<void> {
  for (const o of doc.options) {
    const v = await validateOutfit(h.db, owner.principal(), { forDate: doc.localDate, nowMs: h.clock.now(), slots: [...o.garments.map((g) => ({ role: g.role, garmentId: g.garmentId })), ...(o.flourish ? [{ role: "neckwear" as const, garmentId: o.flourish.garmentId }] : [])], footwearAlternatives: o.footwearAlternatives.map((g) => g.garmentId) });
    expect(v.violations.filter((x) => x.severity === "blocking"), `option ${o.number} (${o.name})`).toEqual([]);
  }
}

async function setup(dates: string[]): Promise<{ h: DailyHarness; owner: TestOwner }> {
  const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
  const owner = await realOwner(h);
  for (const d of dates) h.weather.setForecast(d, MILD_DAY);
  return { h, owner };
}

describe("availability changes repair open boards in the same commit", () => {
  it("a spill replaces just that piece, keeps the rest of the option and every other option, and records a changed-item receipt", async () => {
    const { h, owner } = await setup(["2026-09-16"]);
    const before = (await compose(h, owner, "2026-09-16")).board!;
    const target = before.options[1]!;
    const shirt = piece(target, "top")!;

    const receipt = await owner.exec("care.mark_dirty", { items: [{ garmentId: shirt.garmentId }] });

    // The repair is part of the observation's own receipt: same command, same batch.
    expect(receipt.type).toBe("care.mark_dirty");
    expect(receipt.repairs.join(" ")).toMatch(new RegExp(`Board for 2026-09-16 updated \\(revision 2\\): Option 2: ${shirt.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} replaced by .+ \\(no longer available\\)`));
    expect((receipt.result as any).boardRepairs).toEqual([expect.objectContaining({ boardId: before.boardId, revision: 2, offered: 5, withdrawn: 0 })]);
    expect(receipt.affected).toContainEqual({ kind: "board", id: before.boardId, version: 2 });
    expect(receipt.effects.map((e) => e.kind)).toContain("calendar.project_board");
    const revisionRow = await first<{ command_id: string; reason: string }>(h.db, "SELECT command_id, reason FROM board_revisions WHERE user_id = ? AND board_id = ? AND revision = 2", owner.userId, before.boardId);
    expect(revisionRow).toEqual({ command_id: receipt.commandId, reason: "repair" });

    const after = (await getBoard(h.db, owner.principal(), { boardId: before.boardId }))!;
    expect(after.options).toHaveLength(5);
    const repaired = after.options.find((o) => o.optionId === target.optionId)!;
    expect(repaired.changedInRevision).toBe(true);
    expect(piece(repaired, "top")!.garmentId).not.toBe(shirt.garmentId);
    for (const role of ["bottom", "socks", "footwear", "belt"]) expect(piece(repaired, role)?.garmentId, role).toBe(piece(target, role)?.garmentId);
    for (const o of after.options.filter((x) => x.optionId !== target.optionId)) expect(idsOf(o)).toEqual(idsOf(before.options.find((x) => x.optionId === o.optionId)!));
    expect(after.options.flatMap(idsOf)).not.toContain(shirt.garmentId);
    // What the hook predicted is what the ledger now holds: every option validates against committed state.
    await expectEveryOptionValid(h, owner, after);
    // The prior revision stays in history; its exposure set is superseded, not double-counted.
    expect((await getBoard(h.db, owner.principal(), { boardId: before.boardId }, { revision: 1 }))!.options.flatMap(idsOf)).toContain(shirt.garmentId);
    const exposures = await all<{ status: string }>(h.db, "SELECT status FROM exposure_sets WHERE user_id = ? AND local_date = '2026-09-16' ORDER BY created_at", owner.userId);
    expect(exposures.map((e) => e.status).sort()).toEqual(["open", "superseded"]);
  });

  it("a piece the owner put in himself - an occasional one the service would never offer - survives the repair of its option and a later republication", async () => {
    const { h, owner } = await setup(["2026-09-16"]);
    const names = await garmentsByName(h, owner);
    const square = names.get("Anglo-Italian pocket square")!.garment_id;
    const before = (await compose(h, owner, "2026-09-16")).board!;
    const target = before.options[1]!;
    // Unasked, the occasional piece is refused; as the owner's own pick it is accepted.
    await owner.exec("board.swap_slot", { boardId: before.boardId, optionId: target.optionId, role: "accessory", garmentId: square });
    const hasSquare = async () => (await getBoard(h.db, owner.principal(), { boardId: before.boardId }))!.options.find((o) => o.optionId === target.optionId)!.garments.some((g) => g.garmentId === square);
    expect(await hasSquare()).toBe(true);

    // The same option's shirt is spilled on: the shirt is replaced, the owner's square stays.
    const repaired = await owner.exec("care.mark_dirty", { items: [{ garmentId: piece(target, "top")!.garmentId }] });
    expect((repaired.result as any).boardRepairs[0]).toMatchObject({ offered: 5, withdrawn: 0 });
    expect(await hasSquare()).toBe(true);
    // A background republication keeps it too.
    await h.db.prepare("UPDATE boards SET needs_replenishment = 1 WHERE user_id = ? AND board_id = ?").bind(owner.userId, before.boardId).run();
    h.clock.advanceMinutes(90);
    await replenishBoards(h.deps, await system(h, owner), { nowMs: h.clock.now() });
    const after = (await getBoard(h.db, owner.principal(), { boardId: before.boardId }))!;
    expect(after.revision).toBeGreaterThan(3);
    expect(await hasSquare()).toBe(true);
    expect(after.options).toHaveLength(5);
  });

  it("a command that touches nothing on a board leaves the board alone", async () => {
    const { h, owner } = await setup(["2026-09-16"]);
    const doc = (await compose(h, owner, "2026-09-16")).board!;
    const names = await garmentsByName(h, owner);
    const used = new Set(doc.options.flatMap(idsOf));
    const stored = new Set((await all<{ garment_id: string }>(h.db, "SELECT garment_id FROM board_option_garments WHERE user_id = ? AND board_id = ?", owner.userId, doc.boardId)).map((r) => r.garment_id));
    const unused = [...names.values()].find((g) => g.category === "shirt" && !used.has(g.garment_id) && !stored.has(g.garment_id))!;
    const receipt = await owner.exec("care.mark_dirty", { items: [{ garmentId: unused.garment_id }] });
    expect(receipt.repairs.filter((r) => r.startsWith("Board"))).toEqual([]);
    expect((await getBoard(h.db, owner.principal(), { boardId: doc.boardId }))!.revision).toBe(1);
  });

  it("an owner observation that a jacket went to the tailor, and a new restriction on a pair of sneakers, are both repaired at once", async () => {
    const { h, owner } = await setup(["2026-09-16"]);
    const before = (await compose(h, owner, "2026-09-16")).board!;
    const withJacket = before.options.find((o) => piece(o, "outer"))!;
    const jacket = piece(withJacket, "outer")!;
    const moved = await owner.exec("garment.move", { garmentId: jacket.garmentId, to: "tailor" });
    expect(moved.repairs.join(" ")).toMatch(/Board for 2026-09-16 updated/);
    let after = (await getBoard(h.db, owner.principal(), { boardId: before.boardId }))!;
    expect(after.options.flatMap(idsOf)).not.toContain(jacket.garmentId);
    expect(after.options).toHaveLength(5);

    const shoe = piece(after.options[0]!, "footwear")!;
    const restricted = await owner.exec("restriction.add", { kind: "other", scope: { garmentIds: [shoe.garmentId] }, reason: "sole coming away; not to be worn until repaired", source: { kind: "owner_statement" } });
    expect(restricted.repairs.join(" ")).toMatch(/now restricted/);
    after = (await getBoard(h.db, owner.principal(), { boardId: before.boardId }))!;
    expect(after.options.flatMap(idsOf)).not.toContain(shoe.garmentId);
    expect(after.options).toHaveLength(5);
    for (const o of after.options) expect(piece(o, "footwear")).toBeTruthy();
    await expectEveryOptionValid(h, owner, after);
  });

  it("SYNTHETIC: when nothing eligible can replace a piece the option is withdrawn - fewer valid outfits, never a placeholder - and the gap is refilled once stock returns", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z" });
    const owner = await syntheticOwner(h);
    h.weather.setForecast("2026-09-16", MILD_DAY);
    // Leave exactly three eligible shirts, so the board has three options and no spare shirt.
    await owner.exec("care.mark_dirty", { items: ["shirt-slate", "shirt-blue-stripe-a", "shirt-blue-stripe-b"].map((garmentId) => ({ garmentId })) });
    const before = (await compose(h, owner, "2026-09-16", { count: 3 })).board!;
    expect(before.options).toHaveLength(3);
    const victim = before.options[0]!;
    const shirt = piece(victim, "top")!;

    const receipt = await owner.exec("care.mark_dirty", { items: [{ garmentId: shirt.garmentId }] });
    expect((receipt.result as any).boardRepairs[0]).toMatchObject({ offered: 2, requestedCount: 3, withdrawn: 1 });
    const shrunk = (await getBoard(h.db, owner.principal(), { boardId: before.boardId }))!;
    expect(shrunk.options).toHaveLength(2);
    expect(shrunk.validity).toBe("degraded");
    expect(shrunk.notice).toMatch(/2 valid outfits instead of 3/);
    expect(shrunk.changes.join(" ")).toMatch(/Option 1 .* was withdrawn/);
    expect(shrunk.options.map((o) => o.optionId)).toEqual([before.options[1]!.optionId, before.options[2]!.optionId]);
    for (const o of shrunk.options) expect(o.garments.every((g) => g.name && g.garmentId)).toBe(true);
    await expectEveryOptionValid(h, owner, shrunk);

    // Stock returns: the background composer fills the gap; the surviving options keep their identity.
    await owner.exec("care.washed", { items: [{ garmentId: "shirt-slate" }] });
    const sweep = await replenishBoards(h.deps, await system(h, owner), { nowMs: h.clock.now() });
    expect(sweep).toEqual([expect.objectContaining({ action: "replenished", offered: 3 })]);
    const refilled = (await getBoard(h.db, owner.principal(), { boardId: before.boardId }))!;
    expect(refilled.options).toHaveLength(3);
    expect(refilled.options.slice(0, 2).map((o) => o.optionId)).toEqual(shrunk.options.map((o) => o.optionId));
    expect(refilled.validity).toBe("current");
  });

  it("undoing a wash is revalidated by the sweep: the board is flagged in the undo's commit and repaired from committed state", async () => {
    const { h, owner } = await setup(["2026-09-16"]);
    const names = await garmentsByName(h, owner);
    const shirt = names.get("Lightweight oxford — gold")!.garment_id;
    await owner.exec("care.mark_dirty", { items: [{ garmentId: shirt }] });
    const washed = await owner.exec("care.washed", { items: [{ garmentId: shirt }] });
    const r = await (await import("../src/index.ts")).recommend(h.deps, owner.principal(), { clientRequestId: "gold", date: "2026-09-16", count: 3, lockedGarmentIds: [shirt], mode: "board", nowMs: h.clock.now() });
    expect(r.board!.options.length).toBeGreaterThan(0);
    await owner.exec("command.undo", { commandId: washed.commandId }); // the shirt is dirty again
    await replenishBoards(h.deps, await system(h, owner), { nowMs: h.clock.now() });
    const after = (await getBoard(h.db, owner.principal(), { boardId: r.board!.boardId }))!;
    expect(after.options.flatMap(idsOf)).not.toContain(shirt);
  });
});

describe("an actual wear repairs dependent future suggestions, including a selected one, and the existing Calendar event", () => {
  it("wearing a planned shirt today replaces it in the selected option for Thursday, keeps the selection and the other pieces, keeps the wear, and replaces the same Calendar event", async () => {
    const { h, owner } = await setup(["2026-09-15", "2026-09-17"]);
    const today = (await compose(h, owner, "2026-09-15")).board!;
    const thursday = (await compose(h, owner, "2026-09-17")).board!;
    const planned = thursday.options[2]!;
    await owner.exec("board.select", { boardId: thursday.boardId, optionId: planned.optionId });
    await projectCalendarEffects(h.deps, { nowMs: h.clock.now() });
    const eventsBefore = h.calendar.allEvents(owner.userId, OUTFIT_CALENDAR);
    expect(eventsBefore).toHaveLength(2);
    const thursdayEvent = eventsBefore.find((e) => e.description!.includes(piece(planned, "top")!.name))!;

    // He wears Thursday's planned shirt today, with today's other pieces.
    const todays = today.options[0]!;
    const worn = [piece(planned, "top")!.garmentId, piece(todays, "bottom")!.garmentId, piece(todays, "socks")!.garmentId, piece(todays, "footwear")!.garmentId];
    const receipt = await owner.exec("wear.record", { wearingDate: "2026-09-15", garmentIds: worn });

    expect(receipt.outcome).toBe("committed");
    expect((receipt.result as any).boardRepairs).toEqual([expect.objectContaining({ boardId: thursday.boardId, localDate: "2026-09-17", revision: 2, selectionKept: true })]);
    // The wear itself is intact.
    const wears = await all<{ garment_id: string }>(h.db, "SELECT garment_id FROM daily_wears WHERE user_id = ? AND wearing_date = '2026-09-15' AND status = 'active'", owner.userId);
    expect(wears.map((w) => w.garment_id).sort()).toEqual([...worn].sort());

    const after = (await getBoard(h.db, owner.principal(), { boardId: thursday.boardId }))!;
    expect(after.revision).toBe(2);
    expect(after.selection?.optionId).toBe(planned.optionId);
    const repaired = after.options.find((o) => o.optionId === planned.optionId)!;
    expect(piece(repaired, "top")!.garmentId).not.toBe(piece(planned, "top")!.garmentId);
    for (const role of ["bottom", "socks", "footwear", "belt"]) {
      if (worn.includes(piece(planned, role)?.garmentId ?? "")) continue;
      expect(piece(repaired, role)?.garmentId, role).toBe(piece(planned, role)?.garmentId);
    }
    expect(after.changes.join(" ")).toMatch(/replaced by .+ \((worn on 2026-09-15|no longer available)\)/);
    expect(after.options.flatMap((o) => [piece(o, "top")!.garmentId, piece(o, "bottom")!.garmentId])).not.toContain(piece(planned, "top")!.garmentId);
    expect(after.brief).toEqual(thursday.brief);
    await expectEveryOptionValid(h, owner, after);

    // Today's board became the day's record: it is not restyled.
    const todayAfter = await getToday(h.db, owner.principal(), { date: "2026-09-15", nowMs: h.clock.now() });
    expect(todayAfter.board!.validity).toBe("worn");
    expect(todayAfter.board!.revision).toBe(1);
    expect(todayAfter.dayRecord.map((g) => g.garmentId).sort()).toEqual([...worn].sort());
    await expect(owner.exec("board.swap_slot", { boardId: today.boardId, optionId: todays.optionId, role: "top" })).rejects.toMatchObject({ code: "precondition_failed" });

    // The existing Thursday event is replaced by the newest revision: same event, no duplicate, no old shirt.
    await projectCalendarEffects(h.deps, { nowMs: h.clock.now() });
    const eventsAfter = h.calendar.allEvents(owner.userId, OUTFIT_CALENDAR);
    expect(eventsAfter).toHaveLength(2);
    const same = eventsAfter.find((e) => e.eventId === thursdayEvent.eventId)!;
    expect(same.privateProperties.garderobeRevision).toBe("2");
    expect(same.description).not.toContain(piece(planned, "top")!.name);
    expect(same.description).toContain(piece(repaired, "top")!.name);
    expect((await getBoard(h.db, owner.principal(), { boardId: thursday.boardId }))!.calendarProjection).toMatchObject({ state: "projected", projectedRevision: 2 });
  });

  it("a late report of yesterday's wear is accepted without questions and repairs the board of a day inside the repeat horizon", async () => {
    const { h, owner } = await setup(["2026-09-18"]);
    h.clock.set("2026-09-16T09:00:00Z");
    const friday = (await compose(h, owner, "2026-09-18")).board!;
    const trousers = piece(friday.options[0]!, "bottom")!;
    const receipt = await owner.exec("wear.record", { wearingDate: "2026-09-15", garmentIds: [trousers.garmentId] }, { channel: "mcp", actor: "assistant", authorization: "owner_statement" });
    expect(receipt.outcome).toBe("committed");
    const after = (await getBoard(h.db, owner.principal(), { boardId: friday.boardId }))!;
    expect(after.revision).toBe(2);
    expect(after.options.map((o) => piece(o, "bottom")!.garmentId)).not.toContain(trousers.garmentId);
    expect(after.options).toHaveLength(5);
  });
});

describe("forecast and calendar changes are repaired by the next phase", () => {
  it("a forecast that turns hot overnight removes the shirts kept to 22 C before the morning, and the weather basis is recorded", async () => {
    const { h, owner } = await setup(["2026-09-16"]);
    h.clock.set("2026-09-15T20:05:00Z");
    const evening = await runOwnerPhase(h.deps, { userId: owner.userId, localDate: "2026-09-16", phase: "evening_compose", nowMs: h.clock.now() });
    expect(evening.status).toBe("succeeded");
    const before = (await getBoard(h.db, owner.principal(), { date: "2026-09-16" }))!;
    expect(before.options).toHaveLength(5);

    h.clock.set("2026-09-16T05:41:00Z"); // 06:41 London
    h.weather.setForecast("2026-09-16", WARM_DAY); // 20 C leaving, 26 C peak
    const refresh = await runOwnerPhase(h.deps, { userId: owner.userId, localDate: "2026-09-16", phase: "morning_refresh", nowMs: h.clock.now() });
    expect(refresh).toMatchObject({ status: "succeeded", detail: { action: "recomposed", weather: "fresh" } });
    const after = (await getBoard(h.db, owner.principal(), { date: "2026-09-16" }))!;
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.weatherLine).toMatch(/20 °C leaving, 26 °C later/);
    expect(after.options).toHaveLength(5);
    for (const o of after.options) {
      expect(piece(o, "top")!.name, "no 22 C shirt at a 26 C peak").not.toMatch(/^Pima oxford/);
      expect(piece(o, "bottom")!.name).not.toMatch(/^Cord|flannel/i);
    }
    await expectEveryOptionValid(h, owner, after);
    const stored = await first<{ conditions_json: string }>(h.db, "SELECT conditions_json FROM board_revisions WHERE user_id = ? AND board_id = ? AND revision = ?", owner.userId, after.boardId, after.revision);
    expect(JSON.parse(stored!.conditions_json)).toMatchObject({ peakC: 26, departureC: 20 });
  });

  it("after a selection the day is not rebuilt for the forecast: the chosen outfit keeps its pieces and only the layer is adjusted", async () => {
    const { h, owner } = await setup(["2026-09-16"]);
    h.clock.set("2026-09-15T20:05:00Z");
    await runOwnerPhase(h.deps, { userId: owner.userId, localDate: "2026-09-16", phase: "evening_compose", nowMs: h.clock.now() });
    const before = (await getBoard(h.db, owner.principal(), { date: "2026-09-16" }))!;
    const chosen = before.options.find((o) => piece(o, "outer") && /^Lightweight oxford/.test(piece(o, "top")!.name)) ?? before.options.find((o) => piece(o, "outer"))!;
    await owner.exec("board.select", { boardId: before.boardId, optionId: chosen.optionId });

    h.clock.set("2026-09-16T05:41:00Z");
    // Warmer start (23 C): above every jacket's stated range, while the 21 C peak leaves the shirts alone.
    h.weather.setForecast("2026-09-16", { temperatureByHour: { 0: 22, 8: 23, 14: 21, 23: 19 } });
    const refresh = await runOwnerPhase(h.deps, { userId: owner.userId, localDate: "2026-09-16", phase: "morning_refresh", nowMs: h.clock.now() });
    expect(refresh.status).toBe("succeeded");
    expect((refresh.detail as any).action).not.toBe("recomposed");
    const after = (await getBoard(h.db, owner.principal(), { date: "2026-09-16" }))!;
    expect(after.selection?.optionId).toBe(chosen.optionId);
    const kept = after.options.find((o) => o.optionId === chosen.optionId)!;
    for (const role of ["top", "bottom", "socks", "footwear"]) expect(piece(kept, role)!.garmentId, role).toBe(piece(chosen, role)!.garmentId);
    await expectEveryOptionValid(h, owner, after);
  });

  it("a meeting that appears in the calendar overnight shapes a majority of the morning board", async () => {
    const { h, owner } = await setup(["2026-09-16"]);
    h.clock.set("2026-09-15T20:05:00Z");
    await runOwnerPhase(h.deps, { userId: owner.userId, localDate: "2026-09-16", phase: "evening_compose", nowMs: h.clock.now() });
    expect((await getBoard(h.db, owner.principal(), { date: "2026-09-16" }))!.suitabilityLine).toBeNull();

    h.calendar.seedReadEvents(owner.userId, "primary", [{ eventId: "evt-1", calendarId: "primary", title: "Client meeting", startsAt: "2026-09-16T09:00:00Z", endsAt: "2026-09-16T10:00:00Z", allDay: false, location: "Holborn", attendance: "accepted", cancelled: false }]);
    h.clock.set("2026-09-16T05:41:00Z");
    const refresh = await runOwnerPhase(h.deps, { userId: owner.userId, localDate: "2026-09-16", phase: "morning_refresh", nowMs: h.clock.now() });
    expect(refresh).toMatchObject({ status: "succeeded", detail: { action: "recomposed", reasons: expect.arrayContaining(["calendar changed"]) } });
    const after = (await getBoard(h.db, owner.principal(), { date: "2026-09-16" }))!;
    expect(after.suitabilityLine).toBe("Three options work for “Client meeting”.");
    expect(after.options.filter((o) => o.suitsEventIds.includes("evt-1"))).toHaveLength(3);
    expect(after.dayLine).toMatch(/One commitment, at 10:00\.$/);
  });
});
