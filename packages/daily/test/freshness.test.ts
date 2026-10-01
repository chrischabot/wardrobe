/**
 * Source freshness and weather-aware edits: the final pre-morning check honours the weather and
 * calendar freshness thresholds, an ad hoc request reuses a calendar read inside its threshold, a
 * weather-affected swap is validated against a current forecast (or says how old its basis is), ad
 * hoc outfit questions get decision-scoped context, and inference is bounded by a wall-clock budget.
 * Real command service, real local D1, real owner data; labelled fakes behind the weather, Calendar
 * and model ports only.
 */
import { describe, expect, it } from "vitest";
import type { BoardDocument, OutfitCandidate } from "@garderobe/contracts/ext/daily";
import { first } from "@garderobe/domain";
import type { TestOwner } from "@garderobe/domain/testing";
import { decisionContext, getBoard, rebuildDay, recommend, replenishBoards, runOwnerPhase, swapSlot, validateOutfit, weatherForecast, type CompositionModel } from "../src/index.ts";
import { compose, createDailyHarness, garmentsByName, MILD_DAY, realOwner, system, WARM_DAY, type DailyHarness } from "./helpers.ts";

const DAY = "2026-09-16";
const piece = (o: BoardDocument["options"][number], role: string) => o.garments.find((g) => g.role === role);
const reads = (h: DailyHarness) => h.calendar.log.filter((l) => l.op === "listEvents").length;

async function setup(startAt = "2026-09-15T20:00:00Z"): Promise<{ h: DailyHarness; owner: TestOwner }> {
  const h = await createDailyHarness({ startAt, isolate: true });
  const owner = await realOwner(h);
  h.weather.setForecast(DAY, MILD_DAY);
  return { h, owner };
}

async function expectEveryOptionValid(h: DailyHarness, owner: TestOwner, doc: BoardDocument): Promise<void> {
  for (const o of doc.options) {
    const v = await validateOutfit(h.db, owner.principal(), { forDate: doc.localDate, nowMs: h.clock.now(), slots: [...o.garments.map((g) => ({ role: g.role, garmentId: g.garmentId })), ...(o.flourish ? [{ role: "neckwear" as const, garmentId: o.flourish.garmentId }] : [])] });
    expect(v.violations.filter((x) => x.severity === "blocking"), `option ${o.number} (${o.name})`).toEqual([]);
  }
}

describe("freshness thresholds at the final check", () => {
  it("a calendar read older than thirty minutes and a forecast older than an hour are read again at 6:50, and what they show reaches the board", async () => {
    const { h, owner } = await setup();
    await runOwnerPhase(h.deps, { userId: owner.userId, localDate: DAY, phase: "evening_compose", nowMs: h.clock.now() });
    const evening = (await getBoard(h.db, owner.principal(), { date: DAY }))!;
    expect(evening.suitabilityLine).toBeNull();
    const readsBefore = reads(h);
    const fetchesBefore = h.weather.calls.length;

    // The 6:40 refresh never ran. A meeting was added overnight.
    h.calendar.seedReadEvents(owner.userId, "primary", [{ eventId: "evt-late", calendarId: "primary", title: "Client meeting", startsAt: "2026-09-16T09:00:00Z", endsAt: "2026-09-16T10:00:00Z", allDay: false, location: null, attendance: "accepted", cancelled: false }]);
    h.clock.set("2026-09-16T05:50:00Z");
    const publish = await runOwnerPhase(h.deps, { userId: owner.userId, localDate: DAY, phase: "morning_publish", nowMs: h.clock.now() });
    expect(publish.status).toBe("succeeded");
    expect((publish.detail as any).finalCheck).toMatchObject({ calendarAgeMinutes: 590, weatherAgeMinutes: 590, calendarMaxAgeMinutes: 30, weatherMaxAgeMinutes: 60, reread: ["weather", "calendar"], calendarAgeAfterMinutes: 0 });
    expect(reads(h)).toBe(readsBefore + 1);
    expect(h.weather.calls.length).toBe(fetchesBefore + 1);
    const final = (await getBoard(h.db, owner.principal(), { date: DAY }))!;
    expect(final.freshness.calendarReadAt).toBe("2026-09-16T05:50:00Z");
    expect(final.freshness.weatherFetchedAt).toBe("2026-09-16T05:50:00Z");
    expect(final.suitabilityLine).toBe("Three options work for “Client meeting”.");
    expect((publish.detail as any).calendarVerified).toBe(true);
  });

  it("sources read at 6:40 are inside both thresholds at 6:50 and are not read again; a tighter owner setting is honoured", async () => {
    const { h, owner } = await setup();
    await runOwnerPhase(h.deps, { userId: owner.userId, localDate: DAY, phase: "evening_compose", nowMs: h.clock.now() });
    h.clock.set("2026-09-16T05:40:00Z");
    await runOwnerPhase(h.deps, { userId: owner.userId, localDate: DAY, phase: "morning_refresh", nowMs: h.clock.now() });
    const readsBefore = reads(h);
    const fetchesBefore = h.weather.calls.length;
    h.clock.set("2026-09-16T05:50:00Z");
    const publish = await runOwnerPhase(h.deps, { userId: owner.userId, localDate: DAY, phase: "morning_publish", nowMs: h.clock.now() });
    expect((publish.detail as any).finalCheck).toMatchObject({ calendarAgeMinutes: 10, weatherAgeMinutes: 10, reread: [] });
    expect(reads(h)).toBe(readsBefore);
    expect(h.weather.calls.length).toBe(fetchesBefore);

    // The same morning for an owner who set the calendar threshold to five minutes: the 6:40 read is too old.
    const strict = await setup();
    await strict.owner.exec("settings.update", { patch: { extensions: { daily: { calendarMaxAgeMinutes: 5 } } } });
    await runOwnerPhase(strict.h.deps, { userId: strict.owner.userId, localDate: DAY, phase: "evening_compose", nowMs: strict.h.clock.now() });
    strict.h.clock.set("2026-09-16T05:40:00Z");
    await runOwnerPhase(strict.h.deps, { userId: strict.owner.userId, localDate: DAY, phase: "morning_refresh", nowMs: strict.h.clock.now() });
    const strictReads = reads(strict.h);
    strict.h.clock.set("2026-09-16T05:50:00Z");
    const strictPublish = await runOwnerPhase(strict.h.deps, { userId: strict.owner.userId, localDate: DAY, phase: "morning_publish", nowMs: strict.h.clock.now() });
    expect((strictPublish.detail as any).finalCheck).toMatchObject({ calendarMaxAgeMinutes: 5, reread: ["calendar"] });
    expect(reads(strict.h)).toBe(strictReads + 1);
  });

  it("an ad hoc request reuses a calendar read inside the threshold and reads again once it is older", async () => {
    const { h, owner } = await setup();
    await recommend(h.deps, owner.principal(), { clientRequestId: "a", date: DAY, mode: "board", nowMs: h.clock.now() });
    const afterFirst = reads(h);
    h.clock.advanceMinutes(20);
    await rebuildDay(h.deps, owner.principal(), { date: DAY, clientRequestId: "b", nowMs: h.clock.now() });
    expect(reads(h)).toBe(afterFirst);
    h.clock.advanceMinutes(15); // 35 minutes after the read
    await rebuildDay(h.deps, owner.principal(), { date: DAY, clientRequestId: "c", nowMs: h.clock.now() });
    expect(reads(h)).toBe(afterFirst + 1);
  });
});

describe("a swap affected by weather", () => {
  it("consults the weather service when the board's forecast is past its threshold: the pick and every other option are judged on the new forecast", async () => {
    const { h, owner } = await setup();
    const names = await garmentsByName(h, owner);
    const board = (await compose(h, owner, DAY)).board!; // 12 C leaving, 19 C peak
    const fetches = h.weather.calls.length;

    h.clock.advanceMinutes(180);
    h.weather.setForecast(DAY, WARM_DAY); // now 20 C leaving, 26 C peak
    const target = board.options[0]!;
    const used = new Set(board.options.map((o) => piece(o, "top")!.name));
    const pima = ["Pima oxford — navy", "Pima oxford — white", "Pima oxford — charcoal"].find((n) => !used.has(n))!;
    // Kept to 22 C: fine for the stored 19 C forecast, wrong for the day as it now stands.
    await expect(swapSlot(h.deps, owner.principal(), { boardId: board.boardId, optionId: target.optionId, role: "top", garmentId: names.get(pima)!.garment_id, clientRequestId: "s1", nowMs: h.clock.now() })).rejects.toMatchObject({ code: "precondition_failed", message: expect.stringMatching(/22 °C and below \(peak 26 °C\)/) });
    expect(h.weather.calls.length).toBe(fetches + 1);
    expect((await getBoard(h.db, owner.principal(), { boardId: board.boardId }))!.revision).toBe(1);

    const swapped = await swapSlot(h.deps, owner.principal(), { boardId: board.boardId, optionId: target.optionId, role: "top", clientRequestId: "s2", nowMs: h.clock.now() });
    expect(swapped.receipt.result).toMatchObject({ weatherBasis: "refreshed" });
    expect(h.weather.calls.length).toBe(fetches + 1); // the forecast just fetched is inside the hour: no second call
    const doc = swapped.board;
    expect(doc.revision).toBe(2);
    expect(doc.weatherLine).toBe("20 °C leaving, 26 °C later.");
    expect(doc.freshness.weather).toBe("fresh");
    const stored = await first<{ conditions_json: string }>(h.db, "SELECT conditions_json FROM board_revisions WHERE user_id = ? AND board_id = ? AND revision = 2", owner.userId, board.boardId);
    expect(JSON.parse(stored!.conditions_json)).toMatchObject({ peakC: 26, departureC: 20 });
    // Not only the swapped option: the whole revision stands on the new forecast.
    for (const o of doc.options) expect(piece(o, "top")!.name).not.toMatch(/^Pima oxford/);
    await expectEveryOptionValid(h, owner, doc);
  });

  it("with the provider unreachable the swap still works against the last forecast, says how old it is, and is rechecked when a forecast can be read", async () => {
    const { h, owner } = await setup();
    const board = (await compose(h, owner, DAY)).board!;
    h.clock.advanceMinutes(180);
    h.weather.failNext(1);
    const swapped = await swapSlot(h.deps, owner.principal(), { boardId: board.boardId, optionId: board.options[0]!.optionId, role: "top", clientRequestId: "s1", nowMs: h.clock.now() });
    expect(swapped.receipt.result).toMatchObject({ weatherBasis: "stale", weatherAgeMinutes: 180 });
    expect(swapped.board.notice).toBe("The forecast behind this board is 3 h old. The swap was checked against it and is rechecked when a fresh forecast is read.");
    expect(swapped.board.weatherLine).toBe("12 °C leaving, 19 °C later."); // nothing was invented about today's weather
    expect((await first<{ needs_replenishment: number }>(h.db, "SELECT needs_replenishment FROM boards WHERE user_id = ? AND board_id = ?", owner.userId, board.boardId))!.needs_replenishment).toBe(1);

    // The provider is back and the day has turned warm: the sweep rechecks the whole board.
    h.weather.setForecast(DAY, WARM_DAY);
    h.clock.advanceMinutes(5);
    const sweep = await replenishBoards(h.deps, await system(h, owner), { nowMs: h.clock.now() });
    expect(sweep).toEqual([expect.objectContaining({ action: "refreshed" })]);
    const rechecked = (await getBoard(h.db, owner.principal(), { boardId: board.boardId }))!;
    expect(rechecked.notice).toBeNull();
    expect(rechecked.weatherLine).toBe("20 °C leaving, 26 °C later.");
    expect(rechecked.freshness.weather).toBe("fresh");
    for (const o of rechecked.options) expect(piece(o, "top")!.name).not.toMatch(/^Pima oxford/);
    await expectEveryOptionValid(h, owner, rechecked);
  });

  it("inside the freshness threshold, or for a slot the weather cannot affect, nothing is fetched", async () => {
    const { h, owner } = await setup();
    const board = (await compose(h, owner, DAY)).board!;
    const fetches = h.weather.calls.length;
    h.clock.advanceMinutes(10);
    const fresh = await swapSlot(h.deps, owner.principal(), { boardId: board.boardId, optionId: board.options[0]!.optionId, role: "top", clientRequestId: "s1", nowMs: h.clock.now() });
    expect(fresh.receipt.result).toMatchObject({ weatherBasis: "current", weatherAgeMinutes: 10 });
    h.clock.advanceMinutes(300);
    const belt = await swapSlot(h.deps, owner.principal(), { boardId: board.boardId, optionId: board.options[1]!.optionId, role: "belt", clientRequestId: "s2", nowMs: h.clock.now() });
    expect(belt.receipt.result).toMatchObject({ weatherBasis: "not_weather_dependent" });
    expect(belt.board.notice).toBeNull();
    expect(h.weather.calls.length).toBe(fetches);
  });

  it("the bare command uses the newest forecast recorded for the day, so a client that sends it directly is still judged on current conditions", async () => {
    const { h, owner } = await setup();
    const names = await garmentsByName(h, owner);
    const board = (await compose(h, owner, DAY)).board!;
    h.clock.advanceMinutes(180);
    h.weather.setForecast(DAY, WARM_DAY);
    await weatherForecast(h.deps, owner.principal(), { localDate: DAY }, { nowMs: h.clock.now() }); // e.g. the assistant looked at the weather
    const used = new Set(board.options.map((o) => piece(o, "top")!.name));
    const pima = ["Pima oxford — navy", "Pima oxford — white", "Pima oxford — charcoal"].find((n) => !used.has(n))!;
    await expect(owner.exec("board.swap_slot", { boardId: board.boardId, optionId: board.options[0]!.optionId, role: "top", garmentId: names.get(pima)!.garment_id })).rejects.toMatchObject({ code: "precondition_failed" });
    const receipt = await owner.exec("board.swap_slot", { boardId: board.boardId, optionId: board.options[0]!.optionId, role: "top" });
    expect(receipt.result).toMatchObject({ weatherBasis: "refreshed" });
    expect((await getBoard(h.db, owner.principal(), { boardId: board.boardId }))!.weatherLine).toBe("20 °C leaving, 26 °C later.");
  });
});

describe("decision-scoped context for an ad hoc outfit question", () => {
  it("\"what socks with this?\" gets the actual outfit, today's eligible socks, palette facts and the day's forecast before any model reasons", async () => {
    const { h, owner } = await setup();
    const names = await garmentsByName(h, owner);
    const g = (n: string) => names.get(n)!.garment_id;
    h.clock.set("2026-09-16T06:30:00Z");
    await owner.exec("care.mark_dirty", { items: [{ garmentId: g("Merino — fire red") }] }); // the only red pair is in the wash
    const fetches = h.weather.calls.length;
    const outfit = [{ role: "top" as const, garmentId: g("Lightweight oxford — red stripe") }, { role: "bottom" as const, garmentId: g("Di Sondrio walnut chino") }, { role: "footwear" as const, garmentId: g("NB 990v4 — navy") }];
    const ctx = await decisionContext(h.deps, owner.principal({ scopes: ["read"] }), { outfit, role: "socks", nowMs: h.clock.now() });

    expect(h.weather.calls.length).toBe(fetches + 1); // fetched by the backend, not by a model's tool call
    expect(ctx.localDate).toBe(DAY);
    expect(ctx.weather).toMatchObject({ line: "12 °C leaving, 19 °C later.", freshness: "fresh" });
    expect(ctx.outfit.map((o) => [o.role, o.name, o.colourFamily])).toEqual([["top", "Lightweight oxford — red stripe", "red"], ["bottom", "Di Sondrio walnut chino", "brown"], ["footwear", "NB 990v4 — navy", "navy"]]);
    const offered = ctx.candidates.map((c) => c.name);
    expect(offered.length).toBeGreaterThan(8);
    expect(offered.every((n) => /^(Merino|Alpaca) —/.test(n))).toBe(true);
    expect(offered).not.toContain("Merino — fire red"); // in the wash
    expect(offered).not.toContain("Alpaca bed sock — clotted cream"); // indoor only
    expect(ctx.rules.map((r) => r.key)).toContain("socks.required");
    expect(ctx.text).toContain("Decision: which socks for 2026-09-16.");
    for (const c of ctx.candidates) expect(ctx.text).toContain(c.garmentId);
    // Scoped to the decision: no profile prose, no shirts or trousers inventory, and a read-only caller wrote nothing.
    expect(ctx.text).not.toMatch(/Rotterdam|Pima oxford|Cord —/);
    expect((await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM weather_snapshots WHERE user_id = ?", owner.userId))!.n).toBe(0);
  });
});

describe("the inference budget of a board", () => {
  /** TEST FAKE: stands in for the AI Gateway composition model only. */
  const slowModel = (delayMs: number, calls: { userId: string | null }[], userId: string | null = null): CompositionModel => ({
    profile: "TEST-FAKE-slow-model",
    async propose(): Promise<OutfitCandidate[]> {
      calls.push({ userId });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return [];
    },
  });

  it("a model that does not answer inside the budget is abandoned and the board is still complete", async () => {
    const { h, owner } = await setup();
    const calls: { userId: string | null }[] = [];
    h.deps.model = slowModel(5_000, calls);
    h.deps.modelBudgetMs = 60;
    const started = Date.now();
    const result = await compose(h, owner, DAY);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(calls).toHaveLength(1); // no second attempt once the budget is spent
    expect(result.diagnostics!.modelError).toMatch(/inference budget/);
    expect(result.board!.options).toHaveLength(5);
  });

  it("the scheduled sweep asks for each owner's own model, so inference is attributed to the owner whose board it is", async () => {
    const { h, owner } = await setup();
    const calls: { userId: string | null }[] = [];
    h.deps.modelFor = (principal) => slowModel(0, calls, principal.userId);
    await runOwnerPhase(h.deps, { userId: owner.userId, localDate: DAY, phase: "evening_compose", nowMs: h.clock.now() });
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls.map((c) => c.userId))).toEqual(new Set([owner.userId]));
    expect((await getBoard(h.db, owner.principal(), { date: DAY }))!.options).toHaveLength(5);
  });
});
