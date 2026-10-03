/**
 * Regressions for the daily-service defects the journey suite found (tests/journeys/DEFECTS.md: D05-1,
 * D05-3, D06-2 to D06-6, D07-2, D07-3, D09-1). The journeys prove each fix through the real Worker; the
 * cases here pin each fix inside the package, with its edges, and make the outcomes that depend on
 * seeded tie-breaking deterministic with labelled SYNTHETIC wardrobes.
 *
 * Real command service and real local D1. Stand-ins: the labelled FakeWeatherProvider (synthetic
 * forecasts) and FakeGoogleCalendar at the adapter boundary, and one labelled STAND-IN for the
 * assistant package's `feedback.record` command (same schema and result shape, no storage), because
 * this package cannot depend on the assistant. No model.
 */
import { describe, expect, it } from "vitest";
import { ASSISTANT_COMMANDS } from "@garderobe/contracts/ext/assistant";
import type { BoardDocument } from "@garderobe/contracts/ext/daily";
import { all, define } from "@garderobe/domain";
import type { TestOwner } from "@garderobe/domain/testing";
import { assembleContext, fetchWeatherSnapshot, getBoard, mergeDescription, prepareTripDayBoard, projectCalendarEffects, proposePacking, recommend, repairOptions, validateOutfit } from "../src/index.ts";
import { loadBoard, loadOptions, loadRevision } from "../src/document.ts";
import { colourFamily } from "../src/model.ts";
import { compose, createDailyHarness, garmentsByName, MILD_DAY, OUTFIT_CALENDAR, realOwner, syntheticOwner, type DailyHarness } from "./helpers.ts";

const piece = (o: BoardDocument["options"][number], role: string) => o.garments.find((g) => g.role === role);

describe("D05-3: the owner's own words in the Calendar event survive a new projection", () => {
  const previous = ["Tuesday: 12 °C at 08:00, 19 °C peak.", "", "1. Pink oxford with grey chino", "Warm against cool.", "Shirt: Pink oxford", "", "2. Gold oxford with navy cord", "One saturated voice.", "Shirt: Gold oxford"].join("\n");
  const next = previous.replace("grey chino", "walnut chino");

  it.each([
    ["a note after the outfits, with an outfit heading renamed", `${previous.replace("1. Pink oxford with grey chino", "1. MY OWN RENAMING")}\n\nMy own note: collect the dry cleaning`, `${next}\n\nMy own note: collect the dry cleaning`],
    ["a note before the outfits, with the day line rewritten", `Remember the umbrella\n\n${previous.replace("Tuesday: 12 °C at 08:00, 19 °C peak.", "Tuesday, mild")}`, `Remember the umbrella\n\n${next}`],
    ["notes on both sides, with the last managed line rewritten", `Before\n${previous.replace(/Shirt: Gold oxford$/, "Shirt: the gold one")}\nAfter`, `Before\n${next}\nAfter`],
    ["a managed line deleted and a note added", `${previous.replace("\nWarm against cool.", "")}\n\nNote to self`, `${next}\n\nNote to self`],
    ["Windows line endings from the remote editor", `${previous.replace("1. Pink oxford with grey chino", "1. MY OWN RENAMING").replace(/\n/g, "\r\n")}\r\n\r\nMy own note`, `${next}\n\nMy own note`],
  ])("%s", (_name, remote, expected) => {
    expect(mergeDescription(remote, previous, next)).toBe(expected);
  });

  it("replaces the description when nothing of the last projection is left, and leaves an untouched projection's surroundings alone", () => {
    expect(mergeDescription("Something else entirely", previous, next)).toBe(next);
    expect(mergeDescription(`Top\n${previous}\nBottom`, previous, next)).toBe(`Top\n${next}\nBottom`);
  });
});

describe("D05-1: the Calendar event links to the day's board", () => {
  it("uses the deployment's origin when the owner set no address of his own, and his own address once he sets one", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T20:00:00Z", isolate: true });
    const owner = await realOwner(h);
    h.deps.boardBaseUrl = "https://garderobe.test/";
    h.weather.setForecast("2026-09-16", MILD_DAY);
    const board = (await compose(h, owner, "2026-09-16")).board!;
    await projectCalendarEffects(h.deps, { nowMs: h.clock.now() });
    const event = () => h.calendar.allEvents(owner.userId, OUTFIT_CALENDAR).filter((e) => e.status !== "cancelled")[0]!;
    expect(event().description).toContain("Open the board: https://garderobe.test/board/2026-09-16");

    await owner.exec("settings.update", { patch: { extensions: { daily: { calendar: { boardBaseUrl: "https://wardrobe.example" } } } } });
    await owner.exec("board.swap_slot", { boardId: board.boardId, optionId: board.options[0]!.optionId, role: "bottom" });
    await projectCalendarEffects(h.deps, { nowMs: h.clock.now() });
    expect(event().description).toContain("Open the board: https://wardrobe.example/board/2026-09-16");
    expect(event().description).not.toContain("garderobe.test");
  });
});

describe("D06-2: the belt and the socks count towards one neutral three times", () => {
  it("SYNTHETIC: under a black jacket and a black shirt the belt and the socks are not black, although black echoes the colour higher up", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const sock = (id: string, name: string, colour: string) => ({ id, name, colour, quantity: 3, category: "socks", roles: ["socks"], careChannel: "handwash", fabric: "Merino wool", attributes: { fabricClass: "merino" } });
    const owner = await syntheticOwner(h, {
      garments: [
        { id: "shirt-black", name: "black oxford", colour: "Black", fabric: "Cotton oxford", category: "shirt", roles: ["top"], careChannel: "service", attributes: { fabricClass: "lightweight_oxford" } },
        { id: "trouser-beige", name: "beige chinos", colour: "Beige", fabric: "Cotton twill", category: "trousers", roles: ["bottom"], careChannel: "service" },
        { id: "jacket-black", name: "black chore coat", colour: "Black", category: "outerwear", roles: ["outer"], careChannel: "none", attributes: { jacketLike: true } },
        sock("sock-black", "black merino socks", "True Black"),
        sock("sock-green", "green merino socks", "Pine Green"),
        { id: "belt-black", name: "black woven belt", colour: "Black", category: "belt", roles: ["belt"], careChannel: "none" },
        { id: "belt-olive", name: "olive woven belt", colour: "Olive", category: "belt", roles: ["belt"], careChannel: "none" },
        { id: "shoe-grey", name: "grey sneakers", colour: "Grey", category: "footwear", roles: ["footwear"], careChannel: "none", attributes: { footwearKind: "sneaker", model: "990v4" } },
      ] as never,
    });
    await owner.exec("style.upsert_rule", { key: "colour.no_neutral_three_times", kind: "soft", status: "active", params: { maxSameNeutralPerOutfit: 2 }, interpretation: "synthetic: a single neutral appears at most twice in one outfit", origin: "owner_direction" });
    h.weather.setForecast("2026-09-16", MILD_DAY); // 12 C at departure: the jacket is worn
    const o = (await compose(h, owner, "2026-09-16", { count: 1 })).board!.options[0]!;
    expect(piece(o, "outer")!.garmentId).toBe("jacket-black");
    expect(piece(o, "belt")!.garmentId).toBe("belt-olive");
    expect(piece(o, "socks")!.garmentId).toBe("sock-green");
    // The validator counts the same pieces: jacket, shirt and black socks together are reported.
    const slots = o.garments.map((g) => ({ role: g.role, garmentId: g.role === "socks" ? "sock-black" : g.garmentId }));
    const v = await validateOutfit(h.db, owner.principal(), { forDate: "2026-09-16", nowMs: h.clock.now(), slots: slots as never });
    expect(v.violations.find((x) => x.code === "neutral_three_times")).toMatchObject({ severity: "advisory", garmentIds: expect.arrayContaining(["jacket-black", "shirt-black", "sock-black"]) });
  });
});

describe("D06-3: naming a piece is the repeat override for that piece only", () => {
  it("a named shirt worn this week stays on every outfit, the trousers worn with it are still left out, and nothing standing changes", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const owner = await realOwner(h);
    const names = await garmentsByName(h, owner);
    const shirt = names.get("Lightweight oxford — pink")!.garment_id;
    const trousers = names.get("Di Sondrio grey chino")!.garment_id;
    await owner.exec("wear.record", { wearingDate: "2026-09-15", garmentIds: [shirt, trousers] });
    await owner.exec("care.washed", { items: [{ garmentId: shirt }, { garmentId: trousers }] }); // clean again: only the week keeps them out
    h.weather.setForecast("2026-09-17", MILD_DAY);

    const ordinary = await recommend(h.deps, owner.principal(), { clientRequestId: "d063-ordinary", date: "2026-09-17", mode: "preview", count: 5, nowMs: h.clock.now() });
    const worn = (o: BoardDocument["options"][number]) => o.garments.map((g) => g.garmentId).filter((id) => id === shirt || id === trousers);
    expect(ordinary.options.flatMap(worn)).toEqual([]);

    const again = await recommend(h.deps, owner.principal(), { clientRequestId: "d063-again", date: "2026-09-17", mode: "preview", count: 2, lockedGarmentIds: [shirt], nowMs: h.clock.now() });
    expect(again.options).toHaveLength(2);
    for (const o of again.options) expect(worn(o)).toEqual([shirt]);

    // Outside such a request the rule stands as it was.
    const check = await validateOutfit(h.db, owner.principal(), { forDate: "2026-09-17", nowMs: h.clock.now(), slots: again.options[0]!.garments.map((g) => ({ role: g.role, garmentId: g.garmentId })) as never });
    expect(check.violations.filter((x) => x.severity === "blocking").map((x) => x.code)).toEqual(["repeat_within_horizon"]);

    // Naming a piece never makes absent stock present: in the wash, it yields no outfit and the reason.
    await owner.exec("care.mark_dirty", { items: [{ garmentId: shirt, quantity: 1 }] });
    const inTheWash = await recommend(h.deps, owner.principal(), { clientRequestId: "d063-wash", date: "2026-09-17", mode: "preview", count: 2, lockedGarmentIds: [shirt], nowMs: h.clock.now() });
    expect(inTheWash.options).toEqual([]);
    expect(inTheWash.note).toMatch(/^No outfit can be built around what was asked for: Lightweight oxford — pink is not available: .*awaiting care\.$/);
  });
});

describe("D06-4, D06-5, D06-6: named pieces and swaps on the real owner's wardrobe", () => {
  it("three outfits around one named shirt all carry it; an occasional piece is admitted only when named; swapping out a navy jacket does not hand back navy", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const owner = await realOwner(h);
    const names = await garmentsByName(h, owner);
    const id = (n: string) => names.get(n)!.garment_id;
    h.weather.setForecast("2026-09-16", MILD_DAY); // 12 C at departure: a jacket day outside the 14-16 C band
    const ask = (clientRequestId: string, extra: Record<string, unknown>) => recommend(h.deps, owner.principal(), { clientRequestId, date: "2026-09-16", mode: "preview", nowMs: h.clock.now(), ...extra } as never);

    const around = await ask("d064", { count: 3, lockedGarmentIds: [id("Lightweight oxford — pink")] });
    expect(around.options.map((o) => piece(o, "top")!.name)).toEqual(Array(3).fill("Lightweight oxford — pink"));
    expect(new Set(around.options.map((o) => piece(o, "bottom")!.garmentId)).size).toBe(3);

    const square = id("Anglo-Italian pocket square"); // "Occasional" in the owner's sheet
    const ordinary = await ask("d065-ordinary", { count: 5 });
    expect(ordinary.options.flatMap((o) => o.garments.map((g) => g.garmentId))).not.toContain(square);
    const named = await ask("d065-named", { count: 1, lockedGarmentIds: [square] });
    expect(named.options).toHaveLength(1);
    expect(named.options[0]!.garments.map((g) => g.garmentId)).toContain(square);

    let board = (await compose(h, owner, "2026-09-16")).board!;
    const option = board.options.find((o) => piece(o, "outer"))!;
    const swap = async (garmentId?: string) => {
      await owner.exec("board.swap_slot", { boardId: board.boardId, optionId: option.optionId, role: "outer", ...(garmentId ? { garmentId } : {}) });
      board = (await getBoard(h.db, owner.principal(), { boardId: board.boardId }))!;
      return piece(board.options.find((o) => o.optionId === option.optionId)!, "outer")!;
    };
    expect((await swap(id("Drake's Navy Cotton-Linen Raglan Work Coat"))).name).toBe("Drake's Navy Cotton-Linen Raglan Work Coat");
    const replacement = await swap();
    expect(colourFamily(replacement.colour ?? replacement.name), `${replacement.name} replaced the navy raglan work coat`).not.toBe("navy");
  });

  it("Studio's validation takes a forecast the caller fetched without recording it; without one it still says the forecast is unavailable", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const owner = await realOwner(h);
    const names = await garmentsByName(h, owner);
    const g = (n: string) => names.get(n)!.garment_id;
    const input = { forDate: "2026-09-20", nowMs: h.clock.now(), slots: [{ role: "outer", garmentId: g("Drake's Olive Jungle Jacket") }, { role: "top", garmentId: g("Pima oxford — navy") }, { role: "bottom", garmentId: g("Di Sondrio grey chino") }, { role: "socks", garmentId: g("Merino — inky blue") }, { role: "footwear", garmentId: g("NB 990v4 — grey") }] as never };
    const blocking = (v: Awaited<ReturnType<typeof validateOutfit>>) => v.violations.filter((x) => x.severity === "blocking").map((x) => x.code);
    expect(blocking(await validateOutfit(h.db, owner.principal(), input))).toEqual(["jacket_band_unverified"]);

    h.weather.setForecast("2026-09-20", MILD_DAY);
    const weather = await fetchWeatherSnapshot(h.deps, owner.principal(), { localDate: "2026-09-20", purpose: "adhoc", nowMs: h.clock.now(), record: false });
    expect(blocking(await validateOutfit(h.db, owner.principal(), { ...input, weather }))).toEqual([]);
    expect(blocking(await validateOutfit(h.db, owner.principal(), { ...input, weather: undefined }))).toEqual(["jacket_band_unverified"]);
    expect(await all(h.db, "SELECT snapshot_id FROM weather_snapshots WHERE user_id = ? AND local_date = ?", owner.userId, "2026-09-20")).toEqual([]);
  });
});

const PARIS = { label: "Paris", latitude: 48.8534, longitude: 2.3488, timezone: "Europe/Paris", from: "2026-09-24", to: "2026-09-26" };

async function paris(): Promise<{ h: DailyHarness; owner: TestOwner; tripId: string }> {
  const h = await createDailyHarness({ startAt: "2026-09-21T18:00:00Z", isolate: true });
  const owner = await realOwner(h);
  for (const d of ["2026-09-24", "2026-09-25", "2026-09-26"]) h.weather.setForecast(d, { temperatureByHour: { 0: 11, 8: 13, 14: 20, 19: 17, 23: 13 } });
  const receipt = await owner.exec("trip.create", { tripId: "paris-journey-defects", name: "Three days in Paris", departsOn: "2026-09-24", returnsOn: "2026-09-26", destinations: [PARIS], occasions: [], luggage: { label: "carry-on", maxPieces: 14 }, source: { kind: "owner_statement", note: "Three days in Paris, carry-on only" } });
  return { h, owner, tripId: (receipt.result as any).tripId };
}

describe("D07-2 and D07-3: a day away is answered from the suitcase, and planned reuse stays wearable", () => {
  it("before anything is packed a trip day is answered from home; once packed, only from the suitcase; a piece planned again is offered after it was worn, a shirt worn once is not", async () => {
    const { h, owner, tripId } = await paris();
    const ask = (id: string) => recommend(h.deps, owner.principal(), { clientRequestId: id, date: "2026-09-25", mode: "preview", count: 3, nowMs: h.clock.now() });
    const proposal = await proposePacking(h.deps, owner.principal(), { tripId, clientRequestId: "d07-pack", nowMs: h.clock.now() });
    // The everyday tie suggestion is not proposed for a carry-on: these mild days have no occasion.
    expect(proposal.items.filter((i) => i.role === "neckwear")).toEqual([]);
    const packed = new Set(proposal.items.map((i) => i.garmentId));
    const lines = (options: BoardDocument["options"]) => options.flatMap((o) => [...o.garments, ...o.footwearAlternatives, ...(o.flourish ? [o.flourish] : [])].map((g) => g.garmentId));

    // A proposal packs nothing: the trip is still only a plan, and the day is answered from home stock.
    const planned = await ask("d07-before");
    expect(planned.options).toHaveLength(3);
    expect(lines(planned.options).some((id) => !packed.has(id))).toBe(true);

    const packReceipt = await owner.exec("stock.pack", { tripId, items: proposal.items.map((i) => ({ garmentId: i.garmentId, quantity: i.quantity })) });
    expect(packReceipt.summary).toContain("Three days in Paris"); // the receipt names the trip in the owner's words
    expect(packReceipt.summary).not.toContain(tripId);
    const away = await ask("d07-after");
    expect(away.options.length).toBeGreaterThan(0);
    expect(lines(away.options).filter((id) => !packed.has(id))).toEqual([]);

    // Day one is worn as planned. The trousers the proposal plans again on a later day are still
    // offered on that day; the shirt, planned once, awaits care like anything else worn on the trip.
    const dayOne = proposal.days.find((d) => d.localDate === "2026-09-24")!;
    const slot = (day: typeof dayOne, role: string) => day.slots.find((s) => s.role === role)!.garmentId;
    const again = proposal.days.find((d) => d.localDate > "2026-09-24" && d.segment === "day" && slot(d, "bottom") === slot(dayOne, "bottom"));
    expect(again, "the proposal reuses day one's trousers on a later day").toBeTruthy();
    h.clock.set("2026-09-24T08:00:00Z");
    await owner.exec("wear.record", { wearingDate: "2026-09-24", tripId, garmentIds: dayOne.slots.map((s) => s.garmentId) });
    const board = (await prepareTripDayBoard(h.deps, owner.principal(), { tripId, date: again!.localDate, clientRequestId: "d07-board", nowMs: h.clock.now() })).board!;
    expect(board.options.length).toBeGreaterThan(0);
    expect(board.options.map((o) => piece(o, "bottom")!.garmentId)).toContain(slot(dayOne, "bottom"));
    expect(board.options.map((o) => piece(o, "top")!.garmentId)).not.toContain(slot(dayOne, "top"));
    expect(lines(board.options).filter((id) => !packed.has(id))).toEqual([]);
  });
});

describe("D09-1: a report of pain is applied to the boards already published", () => {
  /**
   * STAND-IN for the assistant package's `feedback.record` (packages/assistant/src/commands/feedback.ts):
   * the real schema from the shared contracts and the same result shape, with no storage. What is under
   * test is this package's commit hook, which reads `result.pain` and `result.garmentIds`.
   */
  const feedbackRecordStandIn = define({
    type: "feedback.record",
    schema: ASSISTANT_COMMANDS["feedback.record"],
    class: "observation",
    requiredScope: "write",
    async plan(ctx, p) {
      return { summary: "STAND-IN comfort note", result: { feedbackId: p.feedbackId ?? ctx.newId("cfb"), garmentIds: p.garmentIds, pain: p.kind === "pain", scope: p.scope }, undo: { unavailableReason: "stand-in" } };
    },
  });

  it("in the note's own commit: a new revision without the painful shoes, the same options, and a receipt that says so; a note that is not about pain changes nothing", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    h.registry.register(feedbackRecordStandIn);
    const owner = await realOwner(h);
    h.weather.setForecast("2026-09-16", MILD_DAY);
    const before = (await compose(h, owner, "2026-09-16")).board!;
    const painful = piece(before.options[0]!, "footwear")!;

    const warm = await owner.exec("feedback.record", { text: "too warm on the train", kind: "too_warm", garmentIds: [painful.garmentId] });
    expect(warm.repairs).toEqual([]);
    expect((await getBoard(h.db, owner.principal(), { boardId: before.boardId }))!.revision).toBe(before.revision);

    const receipt = await owner.exec("feedback.record", { text: "these shoes hurt after an hour", kind: "pain", garmentIds: [painful.garmentId] });
    expect(receipt.repairs).toHaveLength(1);
    expect(receipt.repairs[0]).toMatch(new RegExp(`^Board for 2026-09-16 updated \\(revision ${before.revision + 1}\\): .*${painful.name} replaced by .+ \\(you said it hurt\\)`));
    const after = (await getBoard(h.db, owner.principal(), { boardId: before.boardId }))!;
    expect(after.revision).toBe(before.revision + 1);
    expect(after.options.map((o) => o.optionId)).toEqual(before.options.map((o) => o.optionId));
    for (const o of after.options) expect([piece(o, "footwear")!.garmentId, ...o.footwearAlternatives.map((g) => g.garmentId)]).not.toContain(painful.garmentId);
  });

  async function published(h: DailyHarness, owner: TestOwner, boardId: string, painful: string) {
    const row = (await loadBoard(h.db, owner.userId, { boardId }))!;
    const revision = (await loadRevision(h.db, owner.userId, boardId, row.current_revision))!;
    const comfort = [{ feedbackId: "committing", text: "", kind: "pain", pain: true, garmentIds: [painful], wearingDate: null, scope: null, createdAt: "2026-09-15T08:00:00.000Z" }];
    const rc = await assembleContext(h.db, owner.principal(), { localDate: row.local_date, nowMs: h.clock.now(), brief: revision.brief, conditions: revision.conditions, comfort, withoutProfileText: true });
    const stored = await loadOptions(h.db, owner.userId, boardId, row.current_revision);
    return { stored, outcome: repairOptions(rc, stored, revision.requested_count, { painGarmentIds: [painful] }) };
  }

  it("every option gives up the painful shoes for another pair and keeps its identity; an option he put them on himself keeps them", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const owner = await realOwner(h);
    h.weather.setForecast("2026-09-16", MILD_DAY);
    let board = (await compose(h, owner, "2026-09-16")).board!;
    const painful = piece(board.options[0]!, "footwear")!.garmentId;
    const own = board.options.find((o) => piece(o, "footwear")!.garmentId !== painful)!; // more than one pair is on the board
    await owner.exec("board.swap_slot", { boardId: board.boardId, optionId: own.optionId, role: "footwear", garmentId: painful });

    const { stored, outcome } = await published(h, owner, board.boardId, painful);
    const offered = stored.filter((o) => o.state === "offered");
    expect(outcome.changed).toBe(true);
    expect(outcome.offered.map((o) => o.optionId)).toEqual(offered.map((o) => o.optionId));
    for (const o of outcome.offered) {
      const shoes = [o.slots.find((s) => s.role === "footwear")!.garmentId, ...o.footwearAlternatives];
      if (o.optionId === own.optionId) expect(shoes).toContain(painful);
      else expect(shoes).not.toContain(painful);
    }
    expect(outcome.reserves.flatMap((o) => o.slots.map((s) => s.garmentId))).not.toContain(painful);
    expect(outcome.changes.join(" ")).toMatch(/replaced by .+ \(you said it hurt\)/);
    expect(outcome.withdrawn).toBe(0);
  });

  it("SYNTHETIC: with a single pair of shoes the board is left as it is; pain is not a ban", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const owner = await syntheticOwner(h, {
      garments: [
        { id: "shirt-blue", name: "blue oxford", colour: "Blue", fabric: "Cotton oxford", category: "shirt", roles: ["top"], careChannel: "service", attributes: { fabricClass: "lightweight_oxford" } },
        { id: "trouser-beige", name: "beige chinos", colour: "Beige", fabric: "Cotton twill", category: "trousers", roles: ["bottom"], careChannel: "service" },
        { id: "sock-green", name: "green merino socks", colour: "Pine Green", quantity: 3, category: "socks", roles: ["socks"], careChannel: "handwash", fabric: "Merino wool", attributes: { fabricClass: "merino" } },
        { id: "shoe-only", name: "grey sneakers", colour: "Grey", category: "footwear", roles: ["footwear"], careChannel: "none", attributes: { footwearKind: "sneaker", model: "990v4" } },
      ] as never,
    });
    h.weather.setForecast("2026-09-16", MILD_DAY);
    const board = (await compose(h, owner, "2026-09-16", { count: 1 })).board!;
    expect(board.options).toHaveLength(1);
    const { outcome } = await published(h, owner, board.boardId, "shoe-only");
    expect(outcome.changed).toBe(false);
    expect(outcome.offered.map((o) => o.slots.find((s) => s.role === "footwear")!.garmentId)).toEqual(["shoe-only"]);
  });
});
