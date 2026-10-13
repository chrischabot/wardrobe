/**
 * Regression tests for the automatic-review findings on boards, composition, the service functions,
 * packing and import (board selection undo, the weather basis of a swap, rebuilt swap-undo evidence,
 * locked pieces, occasion-only boards, revision-pinned repair, trip rebuilds, the paired-shoe format
 * in packing and atomic import). Real command service on real local D1. Wardrobes marked SYNTHETIC are
 * labelled test stock; the rest use the owner's real profile and imported inventory. Stand-ins, all at
 * the adapter boundary: FakeWeatherProvider (synthetic forecasts) and FakeGoogleCalendar (seeded events).
 * The healing restriction is lifted in one test, in that test's own throwaway local D1 database.
 */
import { describe, expect, it } from "vitest";
import { all, first } from "@garderobe/domain";
import { loadBoard } from "../src/document.ts";
import { exportDailyData, getBoard, importDailyData, prepareTripDayBoard, proposePacking, rebuildDay, reviseBoard, suggestOutfits, weatherForecast } from "../src/index.ts";
import { compose, createDailyHarness, garmentRows, MILD_DAY, realOwner, syntheticOwner, system } from "./helpers.ts";

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

async function syntheticBoard(count: number, garments: typeof WARDROBE = WARDROBE) {
  const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
  const owner = await syntheticOwner(h, { garments: garments as never });
  h.weather.setForecast(DAY, MILD_DAY);
  const made = (await compose(h, owner, DAY, { count })).board!;
  return { h, owner, made };
}

describe("undoing a choice (board.select)", () => {
  it("SYNTHETIC: an older choice cannot be undone over a newer one; undoing the newer one restores the older choice on the board and its exposure set", async () => {
    const { h, owner, made } = await syntheticBoard(2);
    const [one, two] = made.options;
    const chooseOne = await owner.exec("board.select", { boardId: made.boardId, optionId: one!.optionId });
    h.clock.advanceMinutes(1);
    const chooseTwo = await owner.exec("board.select", { boardId: made.boardId, optionId: two!.optionId });
    await expect(owner.exec("command.undo", { commandId: chooseOne.commandId })).rejects.toMatchObject({ code: "conflict" });
    expect((await getBoard(h.db, owner.principal(), { boardId: made.boardId }))!.selection?.optionId).toBe(two!.optionId);
    await owner.exec("command.undo", { commandId: chooseTwo.commandId });
    const board = (await getBoard(h.db, owner.principal(), { boardId: made.boardId }))!;
    expect(board.selection?.optionId).toBe(one!.optionId);
    const row = (await loadBoard(h.db, owner.userId, { boardId: made.boardId }))!;
    const exposure = await first<{ selected_option_id: string | null; chosen_alternatives_json: string; status: string }>(h.db, "SELECT selected_option_id, chosen_alternatives_json, status FROM exposure_sets WHERE user_id = ? AND exposure_id = ?", owner.userId, row.exposure_id);
    expect(exposure).toMatchObject({ selected_option_id: one!.optionId, status: "selected", chosen_alternatives_json: "[]" });
  });

  it("real owner: undoing a choice restores the shoe chosen with it while that shoe is still one of the option's footwear choices, and rebuilds the exposure set's chosen alternative (healing restriction lifted in this test's own database)", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const owner = await realOwner(h);
    await owner.exec("restriction.resolve", { restrictionId: "rst_profile_sneakers_only", evidence: { kind: "owner_statement", note: "test database only: my feet have healed" } });
    h.weather.setForecast("2026-09-16", MILD_DAY);
    const made = (await compose(h, owner, "2026-09-16")).board!;
    const option = made.options[0]!;
    const alternative = option.footwearAlternatives[0]!.garmentId;
    await owner.exec("board.select", { boardId: made.boardId, optionId: option.optionId, footwearGarmentId: alternative });
    h.clock.advanceMinutes(1);
    const clear = await owner.exec("board.select", { boardId: made.boardId, optionId: null });
    await owner.exec("command.undo", { commandId: clear.commandId });
    const row = (await loadBoard(h.db, owner.userId, { boardId: made.boardId }))!;
    expect(row.selected_option_id).toBe(option.optionId);
    expect(row.selected_footwear_id).toBe(alternative);
    const exposure = await first<{ chosen_alternatives_json: string }>(h.db, "SELECT chosen_alternatives_json FROM exposure_sets WHERE user_id = ? AND exposure_id = ?", owner.userId, row.exposure_id);
    expect(JSON.parse(exposure!.chosen_alternatives_json)).toEqual([alternative]);
  });

  it("SYNTHETIC: two clears are different choices: undoing the older clear never brings back a choice over the newer clear", async () => {
    const { h, owner, made } = await syntheticBoard(2);
    const [x, y] = made.options;
    await owner.exec("board.select", { boardId: made.boardId, optionId: x!.optionId });
    const clearA = await owner.exec("board.select", { boardId: made.boardId, optionId: null });
    await owner.exec("board.select", { boardId: made.boardId, optionId: y!.optionId });
    await owner.exec("board.select", { boardId: made.boardId, optionId: null });
    await expect(owner.exec("command.undo", { commandId: clearA.commandId })).rejects.toMatchObject({ code: "conflict" });
    expect((await getBoard(h.db, owner.principal(), { boardId: made.boardId }))!.selection).toBeNull();
  });

  it("SYNTHETIC: a revision that withdraws the chosen option is a change of choice: the earlier choice's undo cannot restore over it", async () => {
    const { h, owner, made } = await syntheticBoard(1);
    await owner.exec("board.select", { boardId: made.boardId, optionId: made.options[0]!.optionId });
    const clear = await owner.exec("board.select", { boardId: made.boardId, optionId: null });
    const before = (await loadBoard(h.db, owner.userId, { boardId: made.boardId }))!.selection_version;
    await owner.exec("board.select", { boardId: made.boardId, optionId: made.options[0]!.optionId });
    // The chosen option's shirt goes into the wash: the in-commit repair replaces or withdraws the option.
    await owner.exec("care.mark_dirty", { items: [{ garmentId: made.options[0]!.garments.find((g) => g.role === "top")!.garmentId }] });
    const row = (await loadBoard(h.db, owner.userId, { boardId: made.boardId }))!;
    expect(row.selection_version).toBeGreaterThan(before);
    await expect(owner.exec("command.undo", { commandId: clear.commandId })).rejects.toMatchObject({ code: "conflict" });
  });

  it("SYNTHETIC: a choice recorded before choices were versioned cannot be undone (it cannot be told apart from a newer one)", async () => {
    const { h, owner, made } = await syntheticBoard(2);
    const choice = await owner.exec("board.select", { boardId: made.boardId, optionId: made.options[0]!.optionId });
    // TEST-WRITTEN: the stored undo record is rewritten to the shape it had before versioning (no `wrote`).
    const stored = await first<{ undo_json: string }>(h.db, "SELECT undo_json FROM commands WHERE user_id = ? AND command_id = ?", owner.userId, choice.commandId);
    const legacy = JSON.parse(stored!.undo_json);
    if (legacy.data) delete legacy.data.wrote;
    else delete legacy.wrote;
    expect(JSON.stringify(legacy)).not.toContain("wrote");
    await h.db.prepare("UPDATE commands SET undo_json = ? WHERE user_id = ? AND command_id = ?").bind(JSON.stringify(legacy), owner.userId, choice.commandId).run();
    await expect(owner.exec("command.undo", { commandId: choice.commandId })).rejects.toMatchObject({ code: "precondition_failed", message: expect.stringMatching(/before choices were versioned/) });
    expect((await getBoard(h.db, owner.principal(), { boardId: made.boardId }))!.selection?.optionId).toBe(made.options[0]!.optionId);
  });
});

describe("the forecast a swap is checked against", () => {
  it("SYNTHETIC: a forecast newer than the board's but itself past the freshness threshold governs the swap and is stated as stale; the board is flagged for the sweep", async () => {
    const { h, owner, made } = await syntheticBoard(1);
    h.clock.advanceMinutes(90);
    h.weather.setForecast(DAY, { temperatureByHour: { 0: 9, 8: 11, 15: 18, 23: 12 } });
    await weatherForecast(h.deps, owner.principal(), { localDate: DAY }, { nowMs: h.clock.now() });
    h.clock.advanceMinutes(90); // the newer forecast is now 90 minutes old, past the 60-minute threshold
    const swap = await owner.exec("board.swap_slot", { boardId: made.boardId, optionId: made.options[0]!.optionId, role: "top" });
    expect(swap.result).toMatchObject({ weatherBasis: "stale", weatherAgeMinutes: 90 });
    const after = (await getBoard(h.db, owner.principal(), { boardId: made.boardId }))!;
    expect(after.weatherLine).toBe("11 °C leaving, 18 °C later.");
    expect(after.notice).toMatch(/The forecast behind this board is [^.]+ old\. The swap was checked against it/);
    expect((await loadBoard(h.db, owner.userId, { boardId: made.boardId }))!.needs_replenishment).toBe(1);
  });

  it("SYNTHETIC: the outfits an undo brings back carry evidence of the check made now, not the earlier revision's evidence", async () => {
    const { h, owner, made } = await syntheticBoard(1);
    const swap = await owner.exec("board.swap_slot", { boardId: made.boardId, optionId: made.options[0]!.optionId, role: "top" });
    h.clock.advanceMinutes(90);
    h.weather.setForecast(DAY, { temperatureByHour: { 0: 9, 8: 11, 15: 18, 23: 12 } });
    await weatherForecast(h.deps, owner.principal(), { localDate: DAY }, { nowMs: h.clock.now() });
    await owner.exec("command.undo", { commandId: swap.commandId });
    const row = (await loadBoard(h.db, owner.userId, { boardId: made.boardId }))!;
    const revision = await first<{ conditions_json: string }>(h.db, "SELECT conditions_json FROM board_revisions WHERE user_id = ? AND board_id = ? AND revision = ?", owner.userId, made.boardId, row.current_revision);
    const original = await first<{ conditions_json: string }>(h.db, "SELECT conditions_json FROM board_revisions WHERE user_id = ? AND board_id = ? AND revision = ?", owner.userId, made.boardId, made.revision);
    expect(JSON.parse(revision!.conditions_json).peakC).not.toBe(JSON.parse(original!.conditions_json).peakC);
    const options = await all<{ option_id: string; evidence_json: string }>(h.db, "SELECT option_id, evidence_json FROM board_options WHERE user_id = ? AND board_id = ? AND revision = ?", owner.userId, made.boardId, row.current_revision);
    expect(options.length).toBeGreaterThan(0);
    for (const o of options) expect(JSON.parse(o.evidence_json).validation.evidence.conditions.peakC, o.option_id).toBe(JSON.parse(revision!.conditions_json).peakC);
  });
});

describe("locked pieces and occasion-only boards", () => {
  it("SYNTHETIC: a locked piece the wardrobe does not hold is refused, and a known locked piece is in every suggestion", async () => {
    const { h, owner } = await syntheticBoard(1);
    await expect(suggestOutfits(h.db, owner.principal(), { forDate: DAY, locked: [{ role: "top", garmentId: "synthetic-ghost-shirt" }], nowMs: h.clock.now() } as never)).rejects.toMatchObject({ code: "invalid_command" });
    const suggestions = await suggestOutfits(h.db, owner.principal(), { forDate: DAY, locked: [{ role: "bottom", garmentId: "trouser-a" }], nowMs: h.clock.now() } as never);
    expect(suggestions.length).toBeGreaterThan(0);
    for (const s of suggestions) expect(s.slots).toContainEqual({ role: "bottom", garmentId: "trouser-a" });
  });

  it("SYNTHETIC: a board asked to suit only the day's event offers only outfits that suit it, however few, and keeps the rest as reserves", async () => {
    const garments = WARDROBE.map((g) => (g.id === "shirt-b" ? { ...g, name: "synthetic red plaid shirt" } : g.id === "shirt-c" ? { ...g, name: "synthetic denim shirt" } : g));
    const h = await createDailyHarness({ startAt: "2026-09-16T20:00:00Z", isolate: true });
    const owner = await syntheticOwner(h, { garments: garments as never });
    h.weather.setForecast(DAY, MILD_DAY);
    h.calendar.seedReadEvents(owner.userId, "primary", [{ eventId: "evt-1", calendarId: "primary", title: "Client meeting", startsAt: "2026-09-17T09:00:00Z", endsAt: "2026-09-17T10:00:00Z", allDay: false, location: null, attendance: "accepted", cancelled: false }]);
    const board = (await compose(h, owner, DAY, { count: 3, brief: { occasionOnly: true } as never })).board!;
    expect(board.options.length).toBeGreaterThan(0);
    expect(board.options.length).toBeLessThan(3);
    for (const o of board.options) {
      expect(o.suitsEventIds, o.optionId).toEqual(["evt-1"]);
      expect(o.garments.find((g) => g.role === "top")!.garmentId).toBe("shirt-a");
    }
  });
});

describe("background repair is pinned to the revision it read", () => {
  it("SYNTHETIC: a repair planned from an older read leaves a board revised meanwhile untouched", async () => {
    const { h, owner, made } = await syntheticBoard(1);
    const stale = (await loadBoard(h.db, owner.userId, { boardId: made.boardId }))!;
    await owner.exec("board.swap_slot", { boardId: made.boardId, optionId: made.options[0]!.optionId, role: "top" });
    const swapped = (await getBoard(h.db, owner.principal(), { boardId: made.boardId }))!;
    const result = await reviseBoard(h.deps, await system(h, owner), stale, { nowMs: h.clock.now(), reason: "refresh", force: true, idempotencyKey: "stale-repair" });
    expect(result.action).toBe("none");
    const now = (await getBoard(h.db, owner.principal(), { boardId: made.boardId }))!;
    expect(now.revision).toBe(swapped.revision);
    expect(now.options.map((o) => o.garments)).toEqual(swapped.options.map((o) => o.garments));
  });
});

describe("trips", () => {
  const PARIS = { label: "Paris", latitude: 48.8534, longitude: 2.3488, timezone: "Europe/Paris", from: "2026-09-24", to: "2026-09-25" };

  it("SYNTHETIC: rebuilding a trip day keeps the trip's own stated occasion and destination", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-21T18:00:00Z", isolate: true });
    const owner = await syntheticOwner(h, { garments: WARDROBE as never });
    for (const d of ["2026-09-24", "2026-09-25"]) h.weather.setForecast(d, MILD_DAY);
    await owner.exec("trip.create", { tripId: "gallery", name: "Synthetic Paris", departsOn: "2026-09-24", returnsOn: "2026-09-25", destinations: [PARIS], occasions: [{ localDate: "2026-09-24", label: "Gallery opening", register: "smart", segment: "day" }], source: { kind: "owner_statement", note: "synthetic trip for a boundary test" } });
    const proposal = await proposePacking(h.deps, owner.principal(), { tripId: "gallery", clientRequestId: "gallery", nowMs: h.clock.now() });
    await owner.exec("stock.pack", { tripId: "gallery", items: proposal.items.map((i) => ({ garmentId: i.garmentId, quantity: i.quantity })) });
    const made = await prepareTripDayBoard(h.deps, owner.principal(), { tripId: "gallery", date: "2026-09-24", clientRequestId: "gallery-board", nowMs: h.clock.now() });
    expect(made.board!.suitabilityLine).toMatch(/Gallery opening/);
    h.clock.advanceMinutes(5);
    const rebuilt = await rebuildDay(h.deps, owner.principal(), { date: "2026-09-24", scope: "trip:gallery", clientRequestId: "gallery-rebuild", nowMs: h.clock.now() });
    expect(rebuilt.board!.revision).toBeGreaterThan(made.board!.revision);
    expect(rebuilt.board!.suitabilityLine).toMatch(/Gallery opening/);
    const row = (await loadBoard(h.db, owner.userId, { boardId: rebuilt.board!.boardId }))!;
    const snapshot = await first<{ location_label: string }>(h.db, "SELECT s.location_label FROM weather_snapshots s JOIN board_revisions r ON r.user_id = s.user_id AND r.weather_snapshot_id = s.snapshot_id WHERE r.user_id = ? AND r.board_id = ? AND r.revision = ?", owner.userId, row.board_id, row.current_revision);
    expect(snapshot?.location_label).toBe("Paris");
  });

  it("real owner: with the sneaker + welted format in force, each day's second shoe is packed and counted (healing restriction lifted in this test's own database)", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-21T18:00:00Z", isolate: true });
    const owner = await realOwner(h);
    await owner.exec("restriction.resolve", { restrictionId: "rst_profile_sneakers_only", evidence: { kind: "owner_statement", note: "test database only: my feet have healed" } });
    for (const d of ["2026-09-24", "2026-09-25"]) h.weather.setForecast(d, MILD_DAY);
    await owner.exec("trip.create", { tripId: "paired", name: "Paris", departsOn: "2026-09-24", returnsOn: "2026-09-25", destinations: [PARIS], source: { kind: "owner_statement", note: "test trip" } });
    const proposal = await proposePacking(h.deps, owner.principal(), { tripId: "paired", clientRequestId: "paired", nowMs: h.clock.now() });
    const rows = await garmentRows(h, owner);
    const shoes = proposal.items.filter((i) => i.role === "footwear");
    expect(new Set(shoes.map((i) => rows.get(i.garmentId)!.attributes.footwearKind))).toEqual(new Set(["sneaker", "welted"]));
    const mainShoes = new Set(proposal.days.map((d) => d.slots.find((s) => s.role === "footwear")!.garmentId));
    expect(shoes.length).toBeGreaterThan(mainShoes.size);
  });
});

describe("portable import is all or nothing", () => {
  it("real owner: an export with one row that breaks a constraint imports nothing at all, and the corrected export then imports", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T20:00:00Z", isolate: true });
    const owner = await realOwner(h);
    h.weather.setForecast("2026-09-16", MILD_DAY);
    await compose(h, owner, "2026-09-16");
    const exported = await exportDailyData(h.db, owner.principal());
    const target = await realOwner(h);
    const admin = target.principal({ channel: "import", actor: "system", scopes: ["read", "write", "admin"] });
    // TEST-WRITTEN: the last board option is duplicated, which breaks the table's primary key.
    const broken = JSON.parse(JSON.stringify(exported));
    broken.tables.board_options.push(broken.tables.board_options[broken.tables.board_options.length - 1]);
    await expect(importDailyData(h.db, admin, broken)).rejects.toThrow();
    for (const table of ["boards", "board_revisions", "board_options"]) {
      expect((await first<{ n: number }>(h.db, `SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, target.userId))!.n, table).toBe(0);
    }
    const result = await importDailyData(h.db, admin, exported);
    expect(result.imported).toEqual(exported.counts);
  });
});
