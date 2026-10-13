/**
 * Portable export and clean import of the daily service's records, on real local D1.
 */
import { describe, expect, it } from "vitest";
import { all, first } from "@garderobe/domain";
import { DAILY_TABLES, exportDailyData, getBoard, getPauseState, getTrip, importDailyData, projectCalendarEffects } from "../src/index.ts";
import { compose, createDailyHarness, MILD_DAY, realOwner } from "./helpers.ts";

describe("portable export", () => {
  it("exports every owned table without owner IDs or cache rows, and imports into an empty owner with the same boards and no replayed effects", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T20:00:00Z", isolate: true });
    const owner = await realOwner(h);
    h.weather.setForecast("2026-09-16", MILD_DAY);
    const doc = (await compose(h, owner, "2026-09-16")).board!;
    await owner.exec("board.select", { boardId: doc.boardId, optionId: doc.options[0]!.optionId });
    await owner.exec("board.swap_slot", { boardId: doc.boardId, optionId: doc.options[1]!.optionId, role: "top" });
    await projectCalendarEffects(h.deps, { nowMs: h.clock.now() });
    await owner.exec("trip.create", { tripId: "t1", name: "Paris", departsOn: "2026-10-01", returnsOn: "2026-10-03", destinations: [{ label: "Paris", timezone: "Europe/Paris", from: "2026-10-01", to: "2026-10-03" }], source: { kind: "owner_statement" } });
    await owner.exec("service.pause", { from: "2026-10-01", resumeOn: "2026-10-04" });
    const source = (await getBoard(h.db, owner.principal(), { boardId: doc.boardId }))!;

    const exported = await exportDailyData(h.db, owner.principal());
    expect(Object.keys(exported.tables).sort()).toEqual([...DAILY_TABLES].sort());
    expect(exported.tables).not.toHaveProperty("weather_cache");
    expect(exported.counts).toMatchObject({ boards: 1, board_revisions: 2, trips: 1, service_pauses: 1, calendar_projections: 1 });
    expect(exported.counts.board_options).toBeGreaterThanOrEqual(10);
    const text = JSON.stringify(exported);
    expect(text).not.toContain(owner.userId);
    for (const table of DAILY_TABLES) {
      const actual = (await first<{ n: number }>(h.db, `SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, owner.userId))!.n;
      expect(exported.counts[table], table).toBe(actual);
    }

    // A second owner with the same wardrobe (the importer gives garments stable IDs) and no daily data.
    const target = await realOwner(h);
    const admin = target.principal({ channel: "import", actor: "system", scopes: ["read", "write", "admin"] });
    await expect(importDailyData(h.db, target.principal(), exported)).rejects.toMatchObject({ code: "forbidden" });
    const result = await importDailyData(h.db, admin, JSON.parse(text));
    expect(result.imported).toEqual(exported.counts);

    const restored = (await getBoard(h.db, target.principal(), { boardId: doc.boardId }))!;
    expect(restored.options).toEqual(source.options);
    expect(restored.selection).toEqual(source.selection);
    expect(restored.revision).toBe(2);
    expect((await getBoard(h.db, target.principal(), { boardId: doc.boardId }, { revision: 1 }))!.options.map((o) => o.optionId)).toEqual(doc.options.map((o) => o.optionId));
    expect((await getTrip(h.db, target.principal(), "t1"))!.name).toBe("Paris");
    expect(await getPauseState(h.db, target.principal())).toMatchObject({ from: "2026-10-01", resumeOn: "2026-10-04" });
    // Nothing external is replayed for the importing owner.
    expect(await all(h.db, "SELECT effect_id FROM effects WHERE user_id = ?", target.userId)).toEqual([]);
    expect(await projectCalendarEffects(h.deps, { nowMs: h.clock.now() })).toEqual([]);
    expect(h.calendar.allEvents(target.userId, "outfits@test.calendar")).toEqual([]);
    // Import is only into an empty owner.
    await expect(importDailyData(h.db, admin, exported)).rejects.toMatchObject({ code: "precondition_failed" });

    // The restored board's next real publication reaches the importing owner's calendar as a new event:
    // the absence of an event there is not mistaken for a deletion by the owner.
    await target.exec("settings.update", { patch: { extensions: { daily: { calendar: { outfitCalendarId: "outfits@test.calendar" } } } } });
    h.clock.advanceMinutes(5);
    await target.exec("board.swap_slot", { boardId: doc.boardId, optionId: doc.options[2]!.optionId, role: "belt" });
    const outcomes = (await projectCalendarEffects(h.deps, { nowMs: h.clock.now() })).filter((o) => o.userId === target.userId);
    expect(outcomes.map((o) => o.outcome)).toEqual(["projected"]);
    expect(h.calendar.allEvents(target.userId, "outfits@test.calendar")).toHaveLength(1);
  });
});
