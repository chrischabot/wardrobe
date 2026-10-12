/**
 * Undoing a swap (board.swap_slot): the board as it was before the swap comes back as a new revision,
 * judged on the wardrobe and forecast as they now stand, with its lines recomputed from that context.
 * Wardrobes marked SYNTHETIC are labelled test stock; the forecast-change case uses the owner's real
 * profile and imported inventory. Weather comes from the FakeWeatherProvider at the adapter boundary.
 */
import { describe, expect, it } from "vitest";
import type { BoardDocument } from "@garderobe/contracts/ext/daily";
import { all } from "@garderobe/domain";
import { getBoard, weatherForecast } from "../src/index.ts";
import { compose, createDailyHarness, garmentsByName, MILD_DAY, realOwner, syntheticOwner, WARM_DAY } from "./helpers.ts";

const DAY = "2026-09-17";

const WARDROBE = [
  { id: "shirt-a", name: "synthetic blue oxford", colour: "Blue", category: "shirt", roles: ["top"], careChannel: "service" },
  { id: "shirt-b", name: "synthetic white oxford", colour: "White", category: "shirt", roles: ["top"], careChannel: "service" },
  { id: "shirt-c", name: "synthetic moss oxford", colour: "Moss", category: "shirt", roles: ["top"], careChannel: "service" },
  { id: "trouser-a", name: "synthetic beige chinos", colour: "Beige", category: "trousers", roles: ["bottom"], careChannel: "service" },
  { id: "trouser-b", name: "synthetic olive fatigues", colour: "Olive", category: "trousers", roles: ["bottom"], careChannel: "service" },
  { id: "trouser-c", name: "synthetic navy chinos", colour: "Navy", category: "trousers", roles: ["bottom"], careChannel: "service" },
  { id: "sock-a", name: "synthetic navy socks", colour: "Navy", category: "socks", roles: ["socks"], careChannel: "handwash", quantity: 3 },
  { id: "shoe", name: "synthetic sneakers", colour: "Grey", category: "footwear", roles: ["footwear"], careChannel: "none", attributes: { footwearKind: "sneaker" } },
];

const slot = (o: BoardDocument["options"][number], role: string) => o.garments.find((g) => g.role === role)?.garmentId;
const shape = (b: BoardDocument) => b.options.map((o) => ({ optionId: o.optionId, garments: o.garments.map((g) => `${g.role}:${g.garmentId}`).sort(), alternatives: (o.footwearAlternatives ?? []).map((g: { garmentId: string }) => g.garmentId).sort() }));

async function syntheticBoard(count: number) {
  const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
  const owner = await syntheticOwner(h, { garments: WARDROBE as never });
  h.weather.setForecast(DAY, MILD_DAY);
  const made = (await compose(h, owner, DAY, { count })).board!;
  return { h, owner, made };
}

describe("undoing a swap", () => {
  it("SYNTHETIC: the swap's receipt offers an undo, and the undo restores every option and reserve exactly, as a new revision", async () => {
    const { h, owner, made } = await syntheticBoard(2);
    const before = made.options[0]!;
    const swap = await owner.exec("board.swap_slot", { boardId: made.boardId, optionId: before.optionId, role: "top" });
    expect(swap.undo.available).toBe(true);
    const swapped = (await getBoard(h.db, owner.principal(), { boardId: made.boardId }))!;
    expect(slot(swapped.options[0]!, "top")).not.toBe(slot(before, "top"));
    const undo = await owner.exec("command.undo", { commandId: swap.commandId });
    const after = (await getBoard(h.db, owner.principal(), { boardId: made.boardId }))!;
    expect(after.revision).toBe(swapped.revision + 1);
    expect(shape(after)).toEqual(shape(made));
    const reserves = async (revision: number) => (await all<{ option_id: string; slots_json: string }>(h.db, "SELECT option_id, slots_json FROM board_options WHERE user_id = ? AND board_id = ? AND revision = ? AND state = 'reserve' ORDER BY position", owner.userId, made.boardId, revision)).map((r) => [r.option_id, r.slots_json]);
    expect(await reserves(after.revision)).toEqual(await reserves(made.revision));
    expect(undo.summary).toMatch(new RegExp(`outfits of revision ${made.revision} are back`));
  });

  it("SYNTHETIC: two swaps are undone in reverse order, back to the board as first published", async () => {
    const { h, owner, made } = await syntheticBoard(1);
    const optionId = made.options[0]!.optionId;
    const first = await owner.exec("board.swap_slot", { boardId: made.boardId, optionId, role: "top" });
    const afterFirst = (await getBoard(h.db, owner.principal(), { boardId: made.boardId }))!;
    const second = await owner.exec("board.swap_slot", { boardId: made.boardId, optionId, role: "bottom" });
    await owner.exec("command.undo", { commandId: second.commandId });
    expect(shape((await getBoard(h.db, owner.principal(), { boardId: made.boardId }))!)).toEqual(shape(afterFirst));
    await owner.exec("command.undo", { commandId: first.commandId });
    const after = (await getBoard(h.db, owner.principal(), { boardId: made.boardId }))!;
    expect(shape(after)).toEqual(shape(made));
    expect(after.revision).toBe(afterFirst.revision + 3);
  });

  it("SYNTHETIC: after a newer change to the board, undoing the older swap conflicts and changes nothing", async () => {
    const { h, owner, made } = await syntheticBoard(1);
    const optionId = made.options[0]!.optionId;
    const first = await owner.exec("board.swap_slot", { boardId: made.boardId, optionId, role: "top" });
    await owner.exec("board.swap_slot", { boardId: made.boardId, optionId, role: "bottom" });
    const latest = (await getBoard(h.db, owner.principal(), { boardId: made.boardId }))!;
    await expect(owner.exec("command.undo", { commandId: first.commandId })).rejects.toMatchObject({ code: "conflict" });
    expect((await getBoard(h.db, owner.principal(), { boardId: made.boardId }))!.revision).toBe(latest.revision);
  });

  it("SYNTHETIC: when the earlier shirt went into the wash since, the undo is refused and nothing changes", async () => {
    const { h, owner, made } = await syntheticBoard(1);
    const before = made.options[0]!;
    const swap = await owner.exec("board.swap_slot", { boardId: made.boardId, optionId: before.optionId, role: "top" });
    // The wash of a piece not on the board does not revise it, so the swap's revision stays current.
    await owner.exec("care.mark_dirty", { items: [{ garmentId: slot(before, "top")! }] });
    const now = (await getBoard(h.db, owner.principal(), { boardId: made.boardId }))!;
    await expect(owner.exec("command.undo", { commandId: swap.commandId })).rejects.toMatchObject({ code: expect.stringMatching(/precondition_failed|conflict/) });
    expect((await getBoard(h.db, owner.principal(), { boardId: made.boardId }))!.revision).toBe(now.revision);
  });

  it("SYNTHETIC: a reserve of the earlier revision that is no longer valid refuses the undo too (the whole revision comes back or nothing does)", async () => {
    const { h, owner, made } = await syntheticBoard(1);
    const before = made.options[0]!;
    const reserves = await all<{ option_id: string; slots_json: string }>(h.db, "SELECT option_id, slots_json FROM board_options WHERE user_id = ? AND board_id = ? AND revision = ? AND state = 'reserve'", owner.userId, made.boardId, made.revision);
    expect(reserves.length, "the board was published with a reserve").toBeGreaterThan(0);
    const swap = await owner.exec("board.swap_slot", { boardId: made.boardId, optionId: before.optionId, role: "top" });
    // TEST-WRITTEN: one reserve of the earlier revision now names a shirt that is not in this wardrobe.
    const ghost = (JSON.parse(reserves[0]!.slots_json) as { role: string; garmentId: string }[]).map((s) => (s.role === "top" ? { ...s, garmentId: "synthetic-ghost-shirt" } : s));
    await h.db.prepare("UPDATE board_options SET slots_json = ? WHERE user_id = ? AND board_id = ? AND revision = ? AND option_id = ?").bind(JSON.stringify(ghost), owner.userId, made.boardId, made.revision, reserves[0]!.option_id).run();
    const now = (await getBoard(h.db, owner.principal(), { boardId: made.boardId }))!;
    await expect(owner.exec("command.undo", { commandId: swap.commandId })).rejects.toMatchObject({ code: "precondition_failed", message: expect.stringMatching(/reserve/) });
    expect((await getBoard(h.db, owner.principal(), { boardId: made.boardId }))!.revision).toBe(now.revision);
  });
});

describe("undoing a swap uses the weather basis as it now stands, like the forward swap", () => {
  it("SYNTHETIC: a forecast recorded after the swap is carried into the restored revision, and its weather line and notice are the current ones", async () => {
    const { h, owner, made } = await syntheticBoard(1);
    const swap = await owner.exec("board.swap_slot", { boardId: made.boardId, optionId: made.options[0]!.optionId, role: "top" });
    h.clock.advanceMinutes(90); // past the weather cache, so the read records a newer forecast
    h.weather.setForecast(DAY, { temperatureByHour: { 0: 9, 8: 11, 15: 18, 23: 12 } });
    await weatherForecast(h.deps, owner.principal(), { localDate: DAY }, { nowMs: h.clock.now() });
    await owner.exec("command.undo", { commandId: swap.commandId });
    const after = (await getBoard(h.db, owner.principal(), { boardId: made.boardId }))!;
    expect(shape(after)).toEqual(shape(made));
    expect(after.weatherLine).toBe("11 °C leaving, 18 °C later.");
    expect(after.weatherLine).not.toBe(made.weatherLine);
    expect(after.notice ?? "").not.toMatch(/swap was checked/);
  });

  it("SYNTHETIC: with only a forecast past its freshness threshold, the undo states its age and the board is flagged for the next sweep", async () => {
    const { h, owner, made } = await syntheticBoard(1);
    h.clock.advanceMinutes(90); // past the 60-minute weather threshold; no newer forecast is recorded
    const swap = await owner.exec("board.swap_slot", { boardId: made.boardId, optionId: made.options[0]!.optionId, role: "top" });
    expect((await getBoard(h.db, owner.principal(), { boardId: made.boardId }))!.notice).toMatch(/The swap was checked against it/);
    const undo = await owner.exec("command.undo", { commandId: swap.commandId });
    expect((undo.result as { weatherBasis: string }).weatherBasis).toBe("stale");
    const after = (await getBoard(h.db, owner.principal(), { boardId: made.boardId }))!;
    expect(after.notice).toMatch(/The forecast behind this board is [^.]+ old\. The undo was checked against it/);
    expect(after.notice).not.toMatch(/The swap was checked/);
    const flag = await all<{ needs_replenishment: number }>(h.db, "SELECT needs_replenishment FROM boards WHERE user_id = ? AND board_id = ?", owner.userId, made.boardId);
    expect(flag[0]!.needs_replenishment).toBe(1);
  });

  it("real owner: which restored outfits suit the day's event is judged again, not copied from the earlier revision", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T20:00:00Z", isolate: true });
    const owner = await realOwner(h);
    const CAL_DAY = "2026-09-16";
    h.weather.setForecast(CAL_DAY, MILD_DAY);
    h.calendar.seedReadEvents(owner.userId, "primary", [{ eventId: "evt-1", calendarId: "primary", title: "Client meeting", startsAt: "2026-09-16T09:00:00Z", endsAt: "2026-09-16T10:00:00Z", allDay: false, location: null, attendance: "accepted", cancelled: false }]);
    const doc = (await compose(h, owner, CAL_DAY)).board!;
    expect(doc.suitabilityLine).toBe("Three options work for “Client meeting”.");
    const suitable = doc.options.filter((o) => o.suitsEventIds.includes("evt-1")).map((o) => o.optionId).sort();
    const swap = await owner.exec("board.swap_slot", { boardId: doc.boardId, optionId: doc.options[0]!.optionId, role: "top" });
    // TEST-WRITTEN: the earlier revision's history claims every option suits the meeting.
    await h.db.prepare("UPDATE board_options SET suits_event_ids_json = ? WHERE user_id = ? AND board_id = ? AND revision = ?").bind(JSON.stringify(["evt-1"]), owner.userId, doc.boardId, doc.revision).run();
    await owner.exec("command.undo", { commandId: swap.commandId });
    const after = (await getBoard(h.db, owner.principal(), { boardId: doc.boardId }))!;
    expect(shape(after)).toEqual(shape(doc));
    expect(after.suitabilityLine).toBe("Three options work for “Client meeting”.");
    expect(after.options.filter((o) => o.suitsEventIds.includes("evt-1")).map((o) => o.optionId).sort()).toEqual(suitable);
  });

  it("real owner: a forecast recorded after the swap that rules out the earlier shirt refuses the undo with the reason", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T20:00:00Z", isolate: true });
    const owner = await realOwner(h);
    const CAL_DAY = "2026-09-16";
    h.weather.setForecast(CAL_DAY, MILD_DAY); // 12 °C leaving, 19 °C peak
    const doc = (await compose(h, owner, CAL_DAY)).board!;
    const names = await garmentsByName(h, owner);
    const option = doc.options[0]!;
    const used = new Set(doc.options.flatMap((o) => o.garments.map((g) => g.name)));
    // A Pima oxford is kept to 22 °C by the owner's profile: fine on the stored forecast.
    let pinned = false;
    for (const name of ["Pima oxford — white", "Pima oxford — charcoal", "Pima oxford — navy"].filter((n) => !used.has(n))) {
      try {
        await owner.exec("board.swap_slot", { boardId: doc.boardId, optionId: option.optionId, role: "top", garmentId: names.get(name)!.garment_id });
        pinned = true;
        break;
      } catch {
        // that one does not suit this option; try the next
      }
    }
    expect(pinned, "a Pima oxford went onto the option").toBe(true);
    const swap = await owner.exec("board.swap_slot", { boardId: doc.boardId, optionId: option.optionId, role: "top" });
    // The day turns warm and the forecast is recorded (the assistant looked at the weather); the board is untouched.
    h.clock.advanceMinutes(180);
    h.weather.setForecast(CAL_DAY, WARM_DAY);
    await weatherForecast(h.deps, owner.principal(), { localDate: CAL_DAY }, { nowMs: h.clock.now() });
    const before = (await getBoard(h.db, owner.principal(), { boardId: doc.boardId }))!.revision;
    await expect(owner.exec("command.undo", { commandId: swap.commandId })).rejects.toMatchObject({ code: "precondition_failed", message: expect.stringMatching(/22 °C/) });
    expect((await getBoard(h.db, owner.principal(), { boardId: doc.boardId }))!.revision).toBe(before);
  });
});
