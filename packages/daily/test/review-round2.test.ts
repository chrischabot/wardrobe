/**
 * Regression tests for the second independent review (garderobe-rebuild cadc3aeb / 5db4fd87) and the
 * change reviews of pull requests 15 and 24. Real command service and real local D1; the owner's real
 * imported profile and inventory unless a test name says SYNTHETIC (labelled test owners and pieces,
 * never the owner's stock).
 *
 * Stand-ins, all at the adapter boundary and labelled: FakeWeatherProvider (synthetic forecasts), a
 * canned HTTP transport for the Open-Meteo adapter, and TEST-FAKE fetches that stall. No model.
 *
 * The healing restriction is lifted in one test, in that test's own throwaway local D1 database.
 */
import { describe, expect, it } from "vitest";
import type { BoardDocument } from "@garderobe/contracts/ext/daily";
import { all } from "@garderobe/domain";
import type { TestOwner } from "@garderobe/domain/testing";
import { createGoogleCalendar } from "../src/calendar/google.ts";
import { loadBoard, loadOptions, loadRevision } from "../src/document.ts";
import { plannedReuse } from "../src/trip-day.ts";
import { CalendarApiError, WeatherProviderError, withDeadline, withRequestTimeout } from "../src/ports.ts";
import type { FetchLike } from "../src/ports.ts";
import { createOpenMeteoProvider } from "../src/weather/open-meteo.ts";
import { createWeatherKitProvider } from "../src/weather/weatherkit.ts";
import { htmlToText, isWebAddress, webAddressBase } from "../src/calendar/projector.ts";
import { dailySettings, loadOwner } from "../src/context.ts";
import { assembleContext, fetchWeatherSnapshot, getBoard, getTrip, mergeDescription, overlayFromPlan, prepareTripDayBoard, projectCalendarEffects, proposePacking, rebuildDay, recommend, repairOptions, suggestOutfits, validateOutfit, type Overlay } from "../src/index.ts";
import { compose, createDailyHarness, garmentRows, garmentsByName, MILD_DAY, OUTFIT_CALENDAR, realOwner, syntheticOwner, type DailyHarness } from "./helpers.ts";
import { OPEN_METEO_LONDON_FORECAST } from "./fixtures/open-meteo-london.ts";

const piece = (o: BoardDocument["options"][number], role: string) => o.garments.find((g) => g.role === role);
const blocking = (v: { violations: { code: string; severity: string }[] }) => v.violations.filter((x) => x.severity === "blocking").map((x) => x.code);

const PARIS = { label: "Paris", latitude: 48.8534, longitude: 2.3488, timezone: "Europe/Paris", from: "2026-09-24", to: "2026-09-26" };
const PARIS_DAY = { temperatureByHour: { 0: 11, 8: 13, 14: 20, 19: 17, 23: 13 } };

describe("trip reuse is counted in units and never applies to socks or shirts", () => {
  const WARDROBE = [
    { id: "shirt-a", name: "synthetic blue oxford", colour: "Blue", category: "shirt", roles: ["top"], careChannel: "service" },
    { id: "shirt-b", name: "synthetic white oxford", colour: "White", category: "shirt", roles: ["top"], careChannel: "service" },
    { id: "shirt-c", name: "synthetic moss oxford", colour: "Moss", category: "shirt", roles: ["top"], careChannel: "service" },
    { id: "trouser-a", name: "synthetic beige chinos", colour: "Beige", category: "trousers", roles: ["bottom"], careChannel: "service" },
    { id: "sock-a", name: "synthetic navy socks", colour: "Navy", category: "socks", roles: ["socks"], careChannel: "handwash", quantity: 3 },
    { id: "shoe", name: "synthetic sneakers", colour: "Grey", category: "footwear", roles: ["footwear"], careChannel: "none", attributes: { footwearKind: "sneaker" } },
  ];

  async function threeDays(): Promise<{ h: DailyHarness; owner: TestOwner; tripId: string }> {
    const h = await createDailyHarness({ startAt: "2026-09-21T18:00:00Z", isolate: true });
    const owner = await h.createSyntheticOwner({ settings: { homeLocation: { label: "London", latitude: 51.5085, longitude: -0.1257 } } as never, garments: WARDROBE as never });
    for (const d of ["2026-09-24", "2026-09-25", "2026-09-26"]) h.weather.setForecast(d, PARIS_DAY);
    await owner.exec("trip.create", { tripId: "synthetic-socks", name: "Synthetic three days", departsOn: "2026-09-24", returnsOn: "2026-09-26", destinations: [PARIS], source: { kind: "owner_statement", note: "synthetic trip for a boundary test" } });
    return { h, owner, tripId: "synthetic-socks" };
  }

  it("SYNTHETIC: a proposal recorded half a second after a whole-second packing report is not the one he packed to (instants, not text)", async () => {
    const { h, owner, tripId } = await threeDays();
    await proposePacking(h.deps, owner.principal(), { tripId, clientRequestId: "instant-1", nowMs: h.clock.now() });
    h.clock.set("2026-09-21T18:00:01Z"); // the packing report is recorded at a whole second: "...:01Z"
    const first = await all<{ proposal_json: string }>(h.db, "SELECT proposal_json FROM trip_packing_proposals WHERE user_id = ? AND trip_id = ? ORDER BY revision DESC LIMIT 1", owner.userId, tripId);
    const planned = JSON.parse(first[0]!.proposal_json) as { items: { garmentId: string; quantity: number }[] };
    await owner.exec("stock.pack", { tripId, items: planned.items.map((i) => ({ garmentId: i.garmentId, quantity: i.quantity })) });
    const recorded = await all<{ recorded_at: string }>(h.db, "SELECT recorded_at FROM stock_events WHERE user_id = ? AND kind = 'pack' ORDER BY seq DESC LIMIT 1", owner.userId);
    expect(recorded[0]!.recorded_at).toBe("2026-09-21T18:00:01Z");
    expect((await plannedReuse(h.db, owner.userId, tripId)).pieces.get("trouser-a")?.dates.size).toBe(3);
    // TEST-WRITTEN row standing for a proposal regenerated 0.5 s later that plans no reuse at all. As text
    // "...:01.500Z" sorts before "...:01Z", so a text comparison took it as made before the packing.
    await h.db.prepare("INSERT INTO trip_packing_proposals (user_id, trip_id, revision, proposal_json, command_id, created_at) VALUES (?, ?, 99, ?, 'TEST-regenerated', '2026-09-21T18:00:01.500Z')").bind(owner.userId, tripId, JSON.stringify({ items: [], days: [] })).run();
    expect((await plannedReuse(h.db, owner.userId, tripId)).pieces.get("trouser-a")?.dates.size).toBe(3);
  });

  it("SYNTHETIC: three pairs planned, one packed and worn: the worn pair is not offered again, the planned-again trousers are, and their second wear is recorded", async () => {
    const { h, owner, tripId } = await threeDays();
    const proposal = await proposePacking(h.deps, owner.principal(), { tripId, clientRequestId: "socks-1", nowMs: h.clock.now() });
    // One sock garment planned on three days is three pairs; the single pair of trousers is planned on all three.
    expect(proposal.items.find((i) => i.garmentId === "sock-a")!.quantity).toBe(3);
    expect(proposal.days.map((d) => d.slots.find((s) => s.role === "bottom")!.garmentId)).toEqual(["trouser-a", "trouser-a", "trouser-a"]);

    // He packs everything proposed, but only ONE pair of the socks.
    await owner.exec("stock.pack", { tripId, items: proposal.items.map((i) => ({ garmentId: i.garmentId, quantity: i.garmentId === "sock-a" ? 1 : i.quantity })) });
    // A proposal regenerated after packing (from what is left at home) changes nothing about the suitcase.
    h.clock.set("2026-09-22T09:00:00Z");
    await proposePacking(h.deps, owner.principal(), { tripId, clientRequestId: "socks-2", nowMs: h.clock.now() });
    h.clock.set("2026-09-24T08:00:00Z");
    const dayOne = proposal.days[0]!;
    await owner.exec("wear.record", { wearingDate: "2026-09-24", tripId, garmentIds: dayOne.slots.map((s) => s.garmentId) });

    for (const day of proposal.days.slice(1)) {
      const v = await validateOutfit(h.db, owner.principal(), { forDate: day.localDate, tripId, nowMs: h.clock.now(), slots: day.slots as never });
      const of = (id: string) => v.violations.filter((x) => x.severity === "blocking" && x.garmentIds.includes(id)).map((x) => x.code);
      expect(of("sock-a"), `${day.localDate}: the worn pair of socks`).toEqual(["not_packed"]);
      expect(of("trouser-a"), `${day.localDate}: the trousers the proposal plans again`).toEqual([]);
      expect(of("shoe")).toEqual([]);
      const sock = ((v.evidence as any).availability.garments as { garmentId: string; cleanObserved: number }[]).find((g) => g.garmentId === "sock-a")!;
      expect(sock.cleanObserved).toBe(0);
    }
    // A shirt is worn once: day one's shirt is not wearable on day two although it is in the suitcase.
    const shirtAgain = await validateOutfit(h.db, owner.principal(), { forDate: "2026-09-25", tripId, nowMs: h.clock.now(), slots: dayOne.slots as never });
    expect(shirtAgain.violations.filter((x) => x.garmentIds.includes(dayOne.slots.find((s) => s.role === "top")!.garmentId)).map((x) => x.code)).toEqual(["not_packed"]);
    // No clean pair is left, so the day-two trip board offers nothing rather than the worn pair.
    const board = await prepareTripDayBoard(h.deps, owner.principal(), { tripId, date: "2026-09-25", clientRequestId: "socks-board", nowMs: h.clock.now() });
    expect(board.board?.options ?? []).toEqual([]);
    expect(board.note).toMatch(/0 eligible pairs of socks/);

    // The reuse that IS planned can be recorded: the second wear of the trousers on the trip succeeds
    // and the suitcase still holds exactly one pair of them, worn.
    h.clock.set("2026-09-25T08:00:00Z");
    await owner.exec("wear.record", { wearingDate: "2026-09-25", tripId, garmentIds: ["trouser-a"] });
    expect((await getTrip(h.db, owner.principal(), tripId))!.packed.find((p) => p.garmentId === "trouser-a")).toMatchObject({ clean: 0, worn: 1 });
    // A piece he reports dirty on the trip is no longer re-worn, planned or not - including inside the
    // commit of that report itself, where board repair sees it only through the committing overlay.
    const reuseIn = async (overlay?: Overlay) => (await assembleContext(h.db, owner.principal(), { localDate: "2026-09-26", scope: `trip:${tripId}`, nowMs: h.clock.now(), ...(overlay ? { overlay } : {}) })).garments.get("trouser-a")!.packedClean;
    expect(await reuseIn()).toBe(1);
    const committing = overlayFromPlan({ envelope: { type: "care.mark_dirty", payload: { items: [{ garmentId: "trouser-a" }] } } } as never, { statements: [] } as never, { wears: [] } as never);
    expect(await reuseIn(committing)).toBe(0);
    await owner.exec("care.mark_dirty", { items: [{ garmentId: "trouser-a" }] });
    expect(await reuseIn()).toBe(0);
    const soiled = await validateOutfit(h.db, owner.principal(), { forDate: "2026-09-26", tripId, nowMs: h.clock.now(), slots: proposal.days[2]!.slots as never });
    expect(soiled.violations.filter((x) => x.severity === "blocking" && x.garmentIds.includes("trouser-a")).map((x) => x.code)).toEqual(["not_packed"]);
  });

  it("SYNTHETIC: when the clean pairs run out the proposal names socks as the reason and still plans the rest of the day; the dinner reuses the day's pair", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-21T18:00:00Z", isolate: true });
    const owner = await h.createSyntheticOwner({ settings: { homeLocation: { label: "London", latitude: 51.5085, longitude: -0.1257 } } as never, garments: WARDROBE.map((g) => (g.id === "sock-a" ? { ...g, quantity: 1 } : g)) as never });
    for (const d of ["2026-09-24", "2026-09-25"]) h.weather.setForecast(d, PARIS_DAY);
    await owner.exec("trip.create", { tripId: "one-pair", name: "Synthetic two days", departsOn: "2026-09-24", returnsOn: "2026-09-25", destinations: [{ ...PARIS, to: "2026-09-25" }], occasions: [{ localDate: "2026-09-24", label: "Dinner", register: "smart", segment: "evening" }], source: { kind: "owner_statement", note: "synthetic trip for a boundary test" } });
    const proposal = await proposePacking(h.deps, owner.principal(), { tripId: "one-pair", clientRequestId: "one-pair", nowMs: h.clock.now() });
    const socksOf = (date: string, segment: string) => proposal.days.find((d) => d.localDate === date && d.segment === segment)!.slots.find((s) => s.role === "socks")?.garmentId ?? null;
    // Day one and its dinner share the single pair: one pair packed, not two.
    expect(socksOf("2026-09-24", "day")).toBe("sock-a");
    expect(socksOf("2026-09-24", "evening")).toBe("sock-a");
    expect(proposal.items.find((i) => i.garmentId === "sock-a")!.quantity).toBe(1);
    // Day two is still planned (shirt and trousers are packed) but without socks, and the note says why.
    const dayTwo = proposal.days.find((d) => d.localDate === "2026-09-25")!;
    expect(dayTwo.slots.map((s) => s.role)).toEqual(expect.arrayContaining(["top", "bottom", "footwear"]));
    expect(socksOf("2026-09-25", "day")).toBeNull();
    expect(proposal.items.some((i) => i.garmentId === dayTwo.slots.find((s) => s.role === "top")!.garmentId)).toBe(true);
    expect(proposal.notes.join(" ")).toMatch(/No clean pair of socks is left for 2026-09-25/);
    expect(proposal.notes.join(" ")).not.toMatch(/No complete valid outfit/);
  });

  it("SYNTHETIC control: with enough pairs no sock note is written; with no socks at home at all the note names socks", async () => {
    const { h, owner, tripId } = await threeDays();
    const proposal = await proposePacking(h.deps, owner.principal(), { tripId, clientRequestId: "enough", nowMs: h.clock.now() });
    expect(proposal.days).toHaveLength(3);
    expect(proposal.notes.join(" ")).not.toMatch(/socks/);

    const barefoot = await h.createSyntheticOwner({ settings: { homeLocation: { label: "London", latitude: 51.5085, longitude: -0.1257 } } as never, garments: WARDROBE.filter((g) => g.id !== "sock-a") as never });
    await barefoot.exec("trip.create", { tripId: "no-socks", name: "Synthetic day", departsOn: "2026-09-24", returnsOn: "2026-09-24", destinations: [{ ...PARIS, to: "2026-09-24" }], source: { kind: "owner_statement", note: "synthetic trip for a boundary test" } });
    const none = await proposePacking(h.deps, barefoot.principal(), { tripId: "no-socks", clientRequestId: "no-socks", nowMs: h.clock.now() });
    expect(none.days).toEqual([]);
    expect(none.notes.join(" ")).toMatch(/No outfit could be proposed for 2026-09-24: no clean pair of socks is available at home/);

    // A sock whose only pair is in the wash (no clean pair on the ledger) is never proposed on an
    // estimate: the day is not planned and the note names socks.
    const washday = await h.createSyntheticOwner({ settings: { homeLocation: { label: "London", latitude: 51.5085, longitude: -0.1257 } } as never, garments: WARDROBE.map((g) => (g.id === "sock-a" ? { ...g, quantity: 1 } : g)) as never });
    await washday.exec("care.mark_dirty", { items: [{ garmentId: "sock-a" }] });
    await washday.exec("trip.create", { tripId: "dirty-socks", name: "Synthetic day", departsOn: "2026-09-24", returnsOn: "2026-09-24", destinations: [{ ...PARIS, to: "2026-09-24" }], source: { kind: "owner_statement", note: "synthetic trip for a boundary test" } });
    const dirty = await proposePacking(h.deps, washday.principal(), { tripId: "dirty-socks", clientRequestId: "dirty-socks", nowMs: h.clock.now() });
    expect(dirty.items.map((i) => i.garmentId)).not.toContain("sock-a");
    expect(dirty.days).toEqual([]);
    expect(dirty.notes.join(" ")).toMatch(/no clean pair of socks is available at home/);
  });
});

describe("the repeat override belongs to the owner and is stated on the board", () => {
  async function wornShirt() {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const owner = await realOwner(h);
    const shirt = (await garmentsByName(h, owner)).get("Lightweight oxford — pink")!.garment_id;
    await owner.exec("wear.record", { wearingDate: "2026-09-15", garmentIds: [shirt] });
    await owner.exec("care.washed", { items: [{ garmentId: shirt }] }); // clean again: only the week keeps it out
    h.weather.setForecast("2026-09-17", MILD_DAY);
    return { h, owner, shirt };
  }
  const STATED = /Lightweight oxford — pink was worn on 2026-09-15; it is repeated because it was asked for by name/;

  it("the owner's request repeats the named shirt and says so: in the preview note, on each option and in the published board's notice", async () => {
    const { h, owner, shirt } = await wornShirt();
    const preview = await recommend(h.deps, owner.principal(), { clientRequestId: "own-preview", date: "2026-09-17", mode: "preview", count: 2, lockedGarmentIds: [shirt], nowMs: h.clock.now() });
    expect(preview.options).toHaveLength(2);
    expect(preview.note).toMatch(STATED);
    for (const o of preview.options) expect(o.qualification).toMatch(STATED);

    const published = await recommend(h.deps, owner.principal(), { clientRequestId: "own-board", date: "2026-09-17", mode: "board", count: 2, lockedGarmentIds: [shirt], nowMs: h.clock.now() });
    expect(published.board!.options).toHaveLength(2);
    expect(published.board!.notice).toMatch(STATED);
    for (const o of published.board!.options) {
      expect(piece(o, "top")!.garmentId).toBe(shirt);
      expect(o.qualification).toMatch(STATED);
    }
    // The statement survives a later revision of the board (here: a swap of another slot).
    await owner.exec("board.swap_slot", { boardId: published.board!.boardId, optionId: published.board!.options[0]!.optionId, role: "bottom" });
    const after = (await getBoard(h.db, owner.principal(), { boardId: published.board!.boardId }))!;
    expect(after.options[0]!.qualification).toMatch(STATED);
    // A board with no repeated piece says nothing of the kind.
    h.weather.setForecast("2026-09-18", MILD_DAY);
    const plain = (await compose(h, owner, "2026-09-18")).board!;
    expect(plain.notice ?? "").not.toMatch(/repeated/);
  });

  it("an assistant's request gets no override: not by naming the shirt, not with allowRepeat, in preview or as a published board", async () => {
    const { h, owner, shirt } = await wornShirt();
    const assistant = owner.principal({ actor: "assistant", channel: "mcp" });
    for (const brief of [undefined, { allowRepeat: true }]) {
      const preview = await recommend(h.deps, assistant, { clientRequestId: `as-preview-${brief ? 1 : 0}`, date: "2026-09-17", mode: "preview", count: 2, lockedGarmentIds: [shirt], ...(brief ? { brief } : {}), nowMs: h.clock.now() });
      expect(preview.options).toEqual([]);
      expect(preview.note).toMatch(/Lightweight oxford — pink was worn on 2026-09-15, inside the 7-day repeat horizon/);
      const published = await recommend(h.deps, assistant, { clientRequestId: `as-board-${brief ? 1 : 0}`, date: "2026-09-17", mode: "board", count: 2, lockedGarmentIds: [shirt], ...(brief ? { brief } : {}), nowMs: h.clock.now() });
      expect(published.board).toBeNull();
    }
    // allowRepeat alone (no named piece) does not let an assistant's board repeat the shirt either,
    // and the board it publishes does not store the exception.
    const open = await recommend(h.deps, assistant, { clientRequestId: "as-open", date: "2026-09-17", mode: "board", count: 5, brief: { allowRepeat: true }, nowMs: h.clock.now() });
    expect(open.board!.options.length).toBeGreaterThan(0);
    expect(open.board!.options.map((o) => piece(o, "top")!.garmentId)).not.toContain(shirt);
    expect(open.board!.brief.allowRepeat).toBe(false);
    // A direct publication by an assistant with the shirt named is refused as well.
    const candidate = (await recommend(h.deps, owner.principal(), { clientRequestId: "own-candidate", date: "2026-09-17", mode: "preview", count: 1, lockedGarmentIds: [shirt], nowMs: h.clock.now() })).options[0]!;
    const weather = await fetchWeatherSnapshot(h.deps, owner.principal(), { localDate: "2026-09-17", purpose: "adhoc", nowMs: h.clock.now() });
    const slots = [...candidate.garments.map((g) => ({ role: g.role, garmentId: g.garmentId })), ...(candidate.flourish ? [{ role: "neckwear", garmentId: candidate.flourish.garmentId }] : [])];
    const publish = (actor: "owner" | "assistant") => owner.exec("board.publish", { localDate: "2026-09-17", scope: "home", reason: "rebuild", requestedCount: 1, weatherSnapshotId: weather.snapshotId, brief: { include: [shirt] }, options: [{ slots, footwearAlternatives: candidate.footwearAlternatives.map((g) => g.garmentId), reason: candidate.reason, explanationSource: "factual", removedClaims: [], source: "deterministic", suitsEventIds: [] }], reserves: [] }, actor === "assistant" ? { actor: "assistant", channel: "mcp", authorization: "owner_statement" } : {});
    await expect(publish("assistant")).rejects.toMatchObject({ code: "precondition_failed" });
    await expect(publish("owner")).resolves.toMatchObject({ outcome: "committed" });
  });

  it("SYNTHETIC: when the owner wears a named piece before the day, his own board keeps it and says so; a board whose brief came from an assistant gives it up", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const garments = [
      { id: "shirt-a", name: "synthetic blue oxford", colour: "Blue", category: "shirt", roles: ["top"], careChannel: "service", quantity: 2 },
      { id: "shirt-b", name: "synthetic white oxford", colour: "White", category: "shirt", roles: ["top"], careChannel: "service" },
      { id: "trouser-a", name: "synthetic beige chinos", colour: "Beige", category: "trousers", roles: ["bottom"], careChannel: "service" },
      { id: "trouser-b", name: "synthetic olive fatigues", colour: "Olive", category: "trousers", roles: ["bottom"], careChannel: "service" },
      { id: "sock-a", name: "synthetic navy socks", colour: "Navy", category: "socks", roles: ["socks"], careChannel: "handwash", quantity: 3 },
      { id: "shoe", name: "synthetic sneakers", colour: "Grey", category: "footwear", roles: ["footwear"], careChannel: "none", attributes: { footwearKind: "sneaker" } },
    ];
    h.weather.setForecast("2026-09-18", MILD_DAY);
    const run = async (actor: "owner" | "assistant") => {
      const owner = await syntheticOwner(h, { garments: garments as never });
      const principal = actor === "owner" ? owner.principal() : owner.principal({ actor: "assistant", channel: "mcp" });
      const made = await recommend(h.deps, principal, { clientRequestId: `named-${actor}`, date: "2026-09-18", mode: "board", count: 1, lockedGarmentIds: ["shirt-a"], nowMs: h.clock.now() });
      expect(made.board!.options.map((o) => piece(o, "top")!.garmentId)).toEqual(["shirt-a"]);
      expect(made.board!.notice ?? "").not.toMatch(/repeated/);
      // Before the day, he wears one of the two shirts of that kind: a clean one is left, the week rule applies.
      const wear = await owner.exec("wear.record", { wearingDate: "2026-09-15", garmentIds: ["shirt-a"] });
      return { wear, after: (await getBoard(h.db, owner.principal(), { boardId: made.board!.boardId }))! };
    };
    const own = await run("owner");
    expect(own.after.options.map((o) => piece(o, "top")!.garmentId)).toEqual(["shirt-a"]);
    expect(own.after.notice).toMatch(/synthetic blue oxford was worn on 2026-09-15; it is repeated because it was asked for by name/);
    expect(own.after.options[0]!.qualification).toMatch(/repeated because it was asked for by name/);
    expect(own.wear.repairs.join(" ")).toMatch(/repeated because it was asked for by name/);

    const relayed = await run("assistant");
    expect(relayed.after.options.flatMap((o) => o.garments.map((g) => g.garmentId))).not.toContain("shirt-a");
    expect(`${relayed.after.notice ?? ""} ${relayed.after.options.map((o) => o.qualification ?? "").join(" ")}`).not.toMatch(/asked for by name/);
  });

  it("SYNTHETIC: when he undoes the wear behind a stated repeat, the board stops saying the piece is repeated", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const owner = await syntheticOwner(h, {
      garments: [
        { id: "shirt-a", name: "synthetic blue oxford", colour: "Blue", category: "shirt", roles: ["top"], careChannel: "service", quantity: 2 },
        { id: "shirt-b", name: "synthetic white oxford", colour: "White", category: "shirt", roles: ["top"], careChannel: "service" },
        { id: "trouser-a", name: "synthetic beige chinos", colour: "Beige", category: "trousers", roles: ["bottom"], careChannel: "service" },
        { id: "sock-a", name: "synthetic navy socks", colour: "Navy", category: "socks", roles: ["socks"], careChannel: "handwash", quantity: 3 },
        { id: "shoe", name: "synthetic sneakers", colour: "Grey", category: "footwear", roles: ["footwear"], careChannel: "none", attributes: { footwearKind: "sneaker" } },
      ] as never,
    });
    h.weather.setForecast("2026-09-18", MILD_DAY);
    const made = await recommend(h.deps, owner.principal(), { clientRequestId: "named-undo", date: "2026-09-18", mode: "board", count: 1, lockedGarmentIds: ["shirt-a"], nowMs: h.clock.now() });
    const boardId = made.board!.boardId;
    const wear = await owner.exec("wear.record", { wearingDate: "2026-09-15", garmentIds: ["shirt-a"] });
    const worn = (await getBoard(h.db, owner.principal(), { boardId }))!;
    expect(worn.notice).toMatch(/repeated because it was asked for by name/);
    await owner.exec("command.undo", { commandId: wear.commandId });
    const undone = (await getBoard(h.db, owner.principal(), { boardId }))!;
    expect(undone.revision).toBeGreaterThan(worn.revision);
    expect(undone.options.map((o) => piece(o, "top")!.garmentId)).toEqual(["shirt-a"]);
    expect(`${undone.notice ?? ""} ${undone.options.map((o) => o.qualification ?? "").join(" ")}`).not.toMatch(/repeated|worn on 2026-09-15/);
  });

  it("SYNTHETIC: the owner rebuilding an assistant-briefed day with the stored brief keeps it the assistant's; a brief he changes is his own", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const garments = [
      { id: "shirt-a", name: "synthetic blue oxford", colour: "Blue", category: "shirt", roles: ["top"], careChannel: "service", quantity: 2 },
      { id: "shirt-b", name: "synthetic white oxford", colour: "White", category: "shirt", roles: ["top"], careChannel: "service" },
      { id: "trouser-a", name: "synthetic beige chinos", colour: "Beige", category: "trousers", roles: ["bottom"], careChannel: "service" },
      { id: "trouser-b", name: "synthetic olive fatigues", colour: "Olive", category: "trousers", roles: ["bottom"], careChannel: "service" },
      { id: "sock-a", name: "synthetic navy socks", colour: "Navy", category: "socks", roles: ["socks"], careChannel: "handwash", quantity: 3 },
      { id: "shoe", name: "synthetic sneakers", colour: "Grey", category: "footwear", roles: ["footwear"], careChannel: "none", attributes: { footwearKind: "sneaker" } },
    ];
    h.weather.setForecast("2026-09-18", MILD_DAY);
    const marker = async (h2: DailyHarness, owner: TestOwner) => {
      const row = (await loadBoard(h2.db, owner.userId, { date: "2026-09-18", scope: "home" }))!;
      return (await loadRevision(h2.db, owner.userId, row.board_id, row.current_revision))!.context.repeatExceptions;
    };
    const run = async (ownBrief: boolean) => {
      const owner = await syntheticOwner(h, { garments: garments as never });
      const assistant = owner.principal({ actor: "assistant", channel: "mcp" });
      const made = await recommend(h.deps, assistant, { clientRequestId: `relayed-${ownBrief}`, date: "2026-09-18", mode: "board", count: 1, lockedGarmentIds: ["shirt-a"], nowMs: h.clock.now() });
      expect(made.board!.options.map((o) => piece(o, "top")!.garmentId)).toEqual(["shirt-a"]);
      expect(await marker(h, owner)).toBe(false);
      // The owner rebuilds the day: with no brief (the stored one carries over) or with one he changed.
      const brief = ownBrief ? ({ ...made.board!.brief, allowRepeat: true } as never) : undefined;
      await rebuildDay(h.deps, owner.principal(), { date: "2026-09-18", clientRequestId: `rebuild-${ownBrief}`, nowMs: h.clock.now(), ...(brief ? { brief } : {}) });
      const flag = await marker(h, owner);
      await owner.exec("wear.record", { wearingDate: "2026-09-15", garmentIds: ["shirt-a"] });
      const after = (await getBoard(h.db, owner.principal(), { boardId: made.board!.boardId }))!;
      return { flag, tops: after.options.map((o) => piece(o, "top")!.garmentId) };
    };
    const carried = await run(false);
    expect(carried.flag).toBe(false);
    expect(carried.tops).not.toContain("shirt-a");
    const changed = await run(true);
    expect(changed.flag).toBe(true);
    expect(changed.tops).toContain("shirt-a");
  });
});

describe("an accessory with no recorded kind is never placed on a board", () => {
  it("SYNTHETIC accessory: an explicit pick is refused for the owner and for an assistant, by validation and by a swap; once it has a kind that is not a watch or jewellery it is accepted", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const owner = await realOwner(h);
    const create = async (name: string, accessoryKind?: string) =>
      (await owner.exec("garment.create", { name, category: "accessory", roles: ["accessory"], careChannel: "none", acquisition: "owned", quantity: 1, isSynthetic: true, ...(accessoryKind ? { attributes: { accessoryKind } } : {}), source: { kind: "system", note: "synthetic accessory for a rule test; not the owner's" } })).affected.find((a) => a.kind === "garment")!.id;
    const diver = await create("Seiko SKX007 diver (synthetic boundary piece)");
    const cap = await create("Wool cap (synthetic boundary piece)", "hat");
    h.weather.setForecast("2026-09-16", MILD_DAY);
    const board = (await compose(h, owner, "2026-09-16")).board!;
    const option = board.options[0]!;
    const slots = [...option.garments.map((g) => ({ role: g.role, garmentId: g.garmentId })), { role: "accessory", garmentId: diver }];
    for (const principal of [owner.principal(), owner.principal({ actor: "assistant", channel: "mcp" })]) {
      const v = await validateOutfit(h.db, principal, { forDate: "2026-09-16", nowMs: h.clock.now(), slots: slots as never, explicitGarmentIds: [diver] });
      expect(blocking(v)).toEqual(["accessory_unclassified"]);
    }
    const swap = (garmentId: string, actor: "owner" | "assistant") => owner.exec("board.swap_slot", { boardId: board.boardId, optionId: option.optionId, role: "accessory", garmentId }, actor === "assistant" ? { actor: "assistant", channel: "mcp", authorization: "owner_statement" } : {});
    await expect(swap(diver, "assistant")).rejects.toMatchObject({ code: "precondition_failed", message: expect.stringMatching(/no accessory kind recorded/) });
    await expect(swap(diver, "owner")).rejects.toMatchObject({ code: "precondition_failed" });
    expect((await getBoard(h.db, owner.principal(), { boardId: board.boardId }))!.revision).toBe(board.revision);
    // Control: a classified accessory that is neither a watch nor jewellery is the owner's to add.
    await swap(cap, "owner");
    expect((await getBoard(h.db, owner.principal(), { boardId: board.boardId }))!.options[0]!.garments.map((g) => g.garmentId)).toContain(cap);
    // An accessory on an option is optional: when it stops being wearable the option goes without it
    // and keeps its identity and every other piece (it is not withdrawn or replaced by a reserve).
    await owner.exec("garment.set_planning_policy", { garmentId: cap, policy: "excluded" });
    const without = (await getBoard(h.db, owner.principal(), { boardId: board.boardId }))!;
    expect(without.options.map((o) => o.optionId)).toEqual(board.options.map((o) => o.optionId));
    expect(without.options[0]!.garments.map((g) => g.garmentId)).toEqual(option.garments.map((g) => g.garmentId));
  });
});

describe("Open-Meteo: the last forecastable day", () => {
  const REQUEST = { latitude: 51.5074, longitude: -0.1278, timezone: "Europe/London", startDate: "2026-09-30", endDate: "2026-09-30" };
  const OUT_OF_RANGE = { error: true, reason: "Parameter 'end_date' is out of allowed range from 2026-07-03 to 2026-10-18" };
  /** Transport stand-in: answers by the request's end_date and records the URLs asked for. */
  function transport(answer: (endDate: string) => { status: number; body: unknown }): { fetch: FetchLike; ends: string[] } {
    const ends: string[] = [];
    return {
      ends,
      fetch: async (input) => {
        const end = new URL(input).searchParams.get("end_date")!;
        ends.push(end);
        const a = answer(end);
        return new Response(JSON.stringify(a.body), { status: a.status });
      },
    };
  }

  it("when the padding day is out of the provider's range the request is repeated without it and the day is still forecast", async () => {
    const t = transport((end) => (end === "2026-10-01" ? { status: 400, body: OUT_OF_RANGE } : { status: 200, body: structuredClone(OPEN_METEO_LONDON_FORECAST) }));
    const forecast = await createOpenMeteoProvider({ fetch: t.fetch, now: () => Date.UTC(2026, 8, 30, 6) }).forecast(REQUEST);
    expect(t.ends).toEqual(["2026-10-01", "2026-09-30"]);
    expect(forecast.hours.filter((h) => h.localTime.startsWith("2026-09-30")).length).toBeGreaterThanOrEqual(23);
  });

  it("a day that is itself out of range, and any other refusal, still fail without a second attempt hiding them", async () => {
    const always = transport(() => ({ status: 400, body: OUT_OF_RANGE }));
    await expect(createOpenMeteoProvider({ fetch: always.fetch }).forecast(REQUEST)).rejects.toBeInstanceOf(WeatherProviderError);
    expect(always.ends).toEqual(["2026-10-01", "2026-09-30"]);
    const other = transport(() => ({ status: 400, body: { error: true, reason: "Latitude must be in range of -90 to 90°. Given: 999.0." } }));
    await expect(createOpenMeteoProvider({ fetch: other.fetch }).forecast(REQUEST)).rejects.toMatchObject({ detail: { status: 400, retryable: false } });
    expect(other.ends).toEqual(["2026-10-01"]);
  });
});

describe("one neutral at most twice: the jacket is chosen with the shoe in mind", () => {
  const NEUTRAL_RULE = { key: "colour.no_neutral_three_times", kind: "soft", status: "active", params: { maxSameNeutralPerOutfit: 2 }, interpretation: "synthetic: a single neutral appears at most twice in one outfit", origin: "owner_direction" };
  const BASE = [
    { id: "shirt-navy", name: "navy oxford", colour: "Navy", fabric: "Cotton oxford", category: "shirt", roles: ["top"], careChannel: "service", attributes: { fabricClass: "lightweight_oxford" } },
    { id: "trouser-beige", name: "beige chinos", colour: "Beige", fabric: "Cotton twill", category: "trousers", roles: ["bottom"], careChannel: "service" },
    { id: "jacket-navy", name: "navy work jacket", colour: "Navy", category: "outerwear", roles: ["outer"], careChannel: "none", attributes: { jacketLike: true } },
    { id: "jacket-olive", name: "olive field jacket", colour: "Olive", category: "outerwear", roles: ["outer"], careChannel: "none", attributes: { jacketLike: true } },
    { id: "sock-green", name: "green merino socks", colour: "Pine Green", quantity: 3, category: "socks", roles: ["socks"], careChannel: "handwash", fabric: "Merino wool", attributes: { fabricClass: "merino" } },
    { id: "belt-brown", name: "brown woven belt", colour: "Brown", category: "belt", roles: ["belt"], careChannel: "none" },
    { id: "shoe-navy", name: "navy sneakers", colour: "Navy", category: "footwear", roles: ["footwear"], careChannel: "none", attributes: { footwearKind: "sneaker", model: "990v4" } },
  ];

  it("SYNTHETIC: over a navy shirt with only navy shoes eligible, the olive jacket is taken although the navy one ranks higher, so the shoe is not a third navy piece", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const owner = await syntheticOwner(h, { garments: BASE as never });
    await owner.exec("style.upsert_rule", NEUTRAL_RULE);
    // The olive jacket was worn nine days ago, which ranks it below the navy one whatever the seed.
    await owner.exec("wear.record", { wearingDate: "2026-09-07", garmentIds: ["jacket-olive"] });
    h.weather.setForecast("2026-09-16", MILD_DAY); // 12 C at departure: a jacket is worn
    const o = (await compose(h, owner, "2026-09-16", { count: 1 })).board!.options[0]!;
    expect(piece(o, "outer")!.garmentId).toBe("jacket-olive");
    expect(piece(o, "footwear")!.garmentId).toBe("shoe-navy");
    const v = await validateOutfit(h.db, owner.principal(), { forDate: "2026-09-16", nowMs: h.clock.now(), slots: o.garments.map((g) => ({ role: g.role, garmentId: g.garmentId })) as never });
    expect(v.violations.map((x) => x.code)).not.toContain("neutral_three_times");
  });

  it("SYNTHETIC control: with a grey shoe to choose, the higher-ranked navy jacket is kept", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const owner = await syntheticOwner(h, { garments: [...BASE, { ...BASE[6]!, id: "shoe-grey", name: "grey sneakers", colour: "Grey" }] as never });
    await owner.exec("style.upsert_rule", NEUTRAL_RULE);
    await owner.exec("wear.record", { wearingDate: "2026-09-07", garmentIds: ["jacket-olive"] });
    h.weather.setForecast("2026-09-16", MILD_DAY);
    const o = (await compose(h, owner, "2026-09-16", { count: 1 })).board!.options[0]!;
    expect(piece(o, "outer")!.garmentId).toBe("jacket-navy");
    expect(piece(o, "footwear")!.garmentId).toBe("shoe-grey");
  });

  it("SYNTHETIC control: in the sneaker + welted format the second shoe is not a third piece in one neutral either, although the navy pair ranks higher", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const shoe = BASE[6]!;
    const garments = [
      BASE[0]!, // navy shirt
      { ...BASE[1]!, id: "trouser-navy", name: "navy chinos", colour: "Navy" },
      BASE[3]!, // olive jacket
      BASE[4]!,
      BASE[5]!,
      { ...shoe, id: "shoe-grey", name: "grey sneakers", colour: "Grey" },
      { ...shoe, id: "welted-navy", name: "navy derbies", colour: "Navy", attributes: { footwearKind: "welted" } },
      { ...shoe, id: "welted-brown", name: "brown derbies", colour: "Brown", attributes: { footwearKind: "welted" } },
    ];
    const owner = await syntheticOwner(h, { garments: garments as never });
    await owner.exec("style.upsert_rule", NEUTRAL_RULE);
    await owner.exec("style.upsert_rule", { key: "footwear.name_sneaker_and_welted_alternative", kind: "soft", status: "active", params: {}, interpretation: "synthetic: every option names a sneaker and a welted pair", origin: "owner_direction" });
    // The brown pair was worn nine days ago, which ranks it below the navy pair whatever the seed.
    await owner.exec("wear.record", { wearingDate: "2026-09-07", garmentIds: ["welted-brown"] });
    h.weather.setForecast("2026-09-16", MILD_DAY);
    const o = (await compose(h, owner, "2026-09-16", { count: 1 })).board!.options[0]!;
    expect(piece(o, "top")!.garmentId).toBe("shirt-navy");
    expect(piece(o, "bottom")!.garmentId).toBe("trouser-navy");
    expect(piece(o, "footwear")!.garmentId).toBe("shoe-grey");
    expect(o.footwearAlternatives.map((g) => g.garmentId)).toEqual(["welted-brown"]);
    // Worn with the alternative instead of the sneaker, the outfit still has no neutral three times.
    const slots = o.garments.map((g) => ({ role: g.role, garmentId: g.role === "footwear" ? "welted-brown" : g.garmentId }));
    const v = await validateOutfit(h.db, owner.principal(), { forDate: "2026-09-16", nowMs: h.clock.now(), slots: slots as never, footwearAlternatives: ["shoe-grey"] } as never);
    expect(v.violations.map((x) => x.code)).not.toContain("neutral_three_times");
  });

  it("SYNTHETIC: the everyday flourish is a tie, never a bandana or other neckwear", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const bandana = { id: "bandana", name: "red bandana", colour: "Red", category: "accessory", roles: ["neckwear"], careChannel: "none", attributes: { accessoryKind: "bandana" } };
    const owner = await syntheticOwner(h, { garments: [...BASE, bandana] as never });
    h.weather.setForecast("2026-09-16", MILD_DAY);
    expect((await compose(h, owner, "2026-09-16", { count: 1 })).board!.options[0]!.flourish).toBeNull();
    await owner.exec("garment.create", { garmentId: "tie", name: "rust knit tie", colour: "Rust", category: "tie", roles: ["neckwear"], careChannel: "none", acquisition: "owned", quantity: 1, isSynthetic: true, source: { kind: "system", note: "synthetic test fixture - not the owner's wardrobe" } });
    h.weather.setForecast("2026-09-17", MILD_DAY);
    expect((await compose(h, owner, "2026-09-17", { count: 1 })).board!.options[0]!.flourish?.garmentId).toBe("tie");
  });
});

describe("pain on an option's second shoe", () => {
  it("the painful alternative pair gives way to another pair of the same kind, and the option keeps its identity (healing restriction lifted in this test's own database)", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const owner = await realOwner(h);
    await owner.exec("restriction.resolve", { restrictionId: "rst_profile_sneakers_only", evidence: { kind: "owner_statement", note: "test database only: my feet have healed" } });
    h.weather.setForecast("2026-09-16", MILD_DAY);
    const board = (await compose(h, owner, "2026-09-16")).board!;
    const rows = await garmentRows(h, owner);
    const first = board.options[0]!;
    expect(first.footwearAlternatives).toHaveLength(1); // the sneaker + welted format is in force
    const painful = first.footwearAlternatives[0]!.garmentId;
    const kind = rows.get(painful)!.attributes.footwearKind;

    const row = (await loadBoard(h.db, owner.userId, { boardId: board.boardId }))!;
    const revision = (await loadRevision(h.db, owner.userId, board.boardId, row.current_revision))!;
    const comfort = [{ feedbackId: "committing", text: "", kind: "pain", pain: true, garmentIds: [painful], wearingDate: null, scope: null, createdAt: "2026-09-15T08:00:00.000Z" }];
    const rc = await assembleContext(h.db, owner.principal(), { localDate: row.local_date, nowMs: h.clock.now(), brief: revision.brief, conditions: revision.conditions, comfort, withoutProfileText: true });
    const stored = await loadOptions(h.db, owner.userId, board.boardId, row.current_revision);
    const outcome = repairOptions(rc, stored, revision.requested_count, { painGarmentIds: [painful] });

    expect(outcome.changed).toBe(true);
    expect(outcome.withdrawn).toBe(0);
    expect(outcome.offered.map((o) => o.optionId)).toEqual(stored.filter((o) => o.state === "offered").map((o) => o.optionId));
    for (const o of [...outcome.offered, ...outcome.reserves]) {
      const shoes = [o.slots.find((s) => s.role === "footwear")!.garmentId, ...o.footwearAlternatives];
      expect(shoes).not.toContain(painful);
      // The format still holds: a sneaker and a welted pair are named.
      expect(new Set(shoes.map((id) => rows.get(id)!.attributes.footwearKind))).toEqual(new Set(["sneaker", "welted"]));
    }
    const eased = outcome.offered.find((o) => o.optionId === first.optionId)!;
    expect(eased.slots).toEqual(stored.find((o) => o.optionId === first.optionId)!.slots); // only the second shoe changed
    expect(rows.get(eased.footwearAlternatives[0]!)!.attributes.footwearKind).toBe(kind);

    // The same holds when the painful pair would otherwise rank FIRST as the pair that completes the
    // format, and the caller names the pain only through `painGarmentIds` (no comfort ranking to lean
    // on): every other eligible pair of that kind was worn last week, which ranks it below the painful one.
    const others = [...rc.garments.values()].filter((g) => g.roles.includes("footwear") && g.attributes.footwearKind === kind && g.garmentId !== painful && !g.availability.hardExcluded).map((g) => g.garmentId);
    expect(others.length).toBeGreaterThan(0);
    await owner.exec("wear.record", { wearingDate: "2026-09-08", garmentIds: others });
    const bare = await assembleContext(h.db, owner.principal(), { localDate: row.local_date, nowMs: h.clock.now(), brief: revision.brief, conditions: revision.conditions, withoutProfileText: true });
    const again = repairOptions(bare, stored, revision.requested_count, { painGarmentIds: [painful] });
    expect(again.changed).toBe(true);
    expect(again.withdrawn).toBe(0);
    expect(again.offered.map((o) => o.optionId)).toEqual(stored.filter((o) => o.state === "offered").map((o) => o.optionId));
    for (const o of again.offered) {
      const shoes = [o.slots.find((s) => s.role === "footwear")!.garmentId, ...o.footwearAlternatives];
      expect(shoes).not.toContain(painful);
      expect(new Set(shoes.map((id) => rows.get(id)!.attributes.footwearKind))).toEqual(new Set(["sneaker", "welted"]));
    }
  });
  // Control (it also passes on the sources before the pain fix): the fix must not cost an option.
  it("when the painful pair is the only one that can complete the sneaker + welted format, every option stays exactly as it was: pain makes no option invalid", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const owner = await realOwner(h);
    await owner.exec("restriction.resolve", { restrictionId: "rst_profile_sneakers_only", evidence: { kind: "owner_statement", note: "test database only: my feet have healed" } });
    h.weather.setForecast("2026-09-16", MILD_DAY);
    const rows = await garmentRows(h, owner);
    // Test database only: every welted pair but one is set aside, so that pair is on every option.
    const welted = [...rows.values()].filter((g) => g.category === "footwear" && g.attributes.footwearKind === "welted");
    const board = (await compose(h, owner, "2026-09-16")).board!;
    const painful = board.options[0]!.footwearAlternatives[0]!.garmentId;
    for (const g of welted) if (g.garment_id !== painful) await owner.exec("garment.set_planning_policy", { garmentId: g.garment_id, policy: "excluded" });
    const row = (await loadBoard(h.db, owner.userId, { boardId: board.boardId }))!;
    const revision = (await loadRevision(h.db, owner.userId, board.boardId, row.current_revision))!;
    const stored = await loadOptions(h.db, owner.userId, board.boardId, row.current_revision);
    const withPainful = stored.filter((o) => o.state === "offered" && o.footwearAlternatives.includes(painful));
    expect(withPainful.length).toBeGreaterThan(0);

    const rc = await assembleContext(h.db, owner.principal(), { localDate: row.local_date, nowMs: h.clock.now(), brief: revision.brief, conditions: revision.conditions, withoutProfileText: true });
    const outcome = repairOptions(rc, stored, revision.requested_count, { painGarmentIds: [painful] });
    expect(outcome.withdrawn).toBe(0);
    for (const before of withPainful) {
      const after = outcome.offered.find((o) => o.optionId === before.optionId)!;
      expect(after, `option ${before.optionId} is still offered`).toBeDefined();
      expect(after.slots).toEqual(before.slots);
      expect(after.footwearAlternatives).toEqual(before.footwearAlternatives);
    }
  });
});

describe("Studio suggestions with a forecast the caller fetched", () => {
  it("use the supplied snapshot without recording it, say so when there is none, and count options that differ only in an unasked role once", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const owner = await realOwner(h);
    const names = await garmentsByName(h, owner);
    const shirt = names.get("Pima oxford — navy")!.garment_id; // not a lightweight oxford: no jacket at 14-16 C or unknown
    const input = { forDate: "2026-09-20", nowMs: h.clock.now(), locked: [{ role: "top", garmentId: shirt }], limit: 4 } as never;
    h.weather.setForecast("2026-09-20", MILD_DAY);
    const weather = await fetchWeatherSnapshot(h.deps, owner.principal(), { localDate: "2026-09-20", purpose: "adhoc", nowMs: h.clock.now(), record: false });

    const withForecast = await suggestOutfits(h.db, owner.principal(), { ...(input as object), weather } as never);
    expect(withForecast.length).toBe(4);
    for (const s of withForecast) {
      expect(s.validation.valid).toBe(true);
      expect((s.validation.evidence as any).conditions.departureC).toBe(12);
    }
    // 12 C at departure with a known forecast: at least one suggestion carries a jacket over this shirt.
    expect(withForecast.some((s) => s.slots.some((x) => x.role === "outer"))).toBe(true);

    for (const none of [{ ...(input as object), weather: null }, input]) {
      const without = await suggestOutfits(h.db, owner.principal(), none as never);
      expect(without.length).toBeGreaterThan(0);
      for (const s of without) {
        expect((s.validation.evidence as any).conditions.departureC).toBeNull();
        expect(s.slots.some((x) => x.role === "outer"), "no jacket over a heavier shirt when the forecast is unknown").toBe(false);
      }
    }
    expect(await all(h.db, "SELECT snapshot_id FROM weather_snapshots WHERE user_id = ? AND local_date = ?", owner.userId, "2026-09-20")).toEqual([]);

    // Asked for trousers only: every suggestion is the locked shirt with a different pair, none twice -
    // the requested role alone decides whether two suggestions are the same.
    const bottoms = await suggestOutfits(h.db, owner.principal(), { ...(input as object), weather, openRoles: ["bottom"], limit: 6 } as never);
    expect(bottoms.length).toBeGreaterThan(1);
    const trousers = bottoms.map((s) => s.slots.find((x) => x.role === "bottom")!.garmentId);
    expect(new Set(trousers).size).toBe(trousers.length);
    for (const s of bottoms) expect(s.slots.find((x) => x.role === "top")!.garmentId).toBe(shirt);
    for (const s of bottoms) expect(s.slots.every((x) => ["top", "bottom", "footwear", "socks"].includes(x.role))).toBe(true);
  });
});

describe("Calendar description returned as HTML", () => {
  const previous = ["Tuesday: 12 °C at 08:00, 19 °C peak.", "", "1. Pink oxford with grey chino", "Warm against cool.", "Shirt: Pink oxford & tie"].join("\n");
  const next = previous.replace("grey chino", "walnut chino");

  it("the owner's note is kept when Google hands the edited description back with <br> line breaks and entities", () => {
    const html = `${previous.replace("1. Pink oxford with grey chino", "1. MY OWN RENAMING").replace(/&/g, "&amp;").replace(/\n/g, "<br>")}<br><br>My own note: collect the dry cleaning &amp; post`;
    expect(mergeDescription(html, previous, next)).toBe(`${next}\n\nMy own note: collect the dry cleaning & post`);
    const before = `Remember the umbrella<br /><br />${previous.replace(/&/g, "&amp;").replace(/\n/g, "<BR>")}`;
    expect(mergeDescription(before, previous, next)).toBe(`Remember the umbrella\n\n${next}`);
    // Paragraphs, a link, a numeric entity, and a description that mixes real newlines with <br>.
    const mixed = `<p>Remember the <a href="https://example.test/u">umbrella</a> &#38; keys</p>${previous.replace(/&/g, "&amp;").split("\n").map((line, i) => (i % 2 === 0 ? `${line}<br>\n` : `${line}\n`)).join("")}<div>After the outfits</div>`;
    expect(mergeDescription(mixed, previous, next)).toBe(`Remember the umbrella (https://example.test/u) & keys\n${next}\nAfter the outfits`);
  });

  it("links keep their address, an opening block starts a new line, and entities are decoded once and only into real characters", () => {
    expect(htmlToText(`Before<p>para</p>tail<div>block</div><ul><li>one</li><li>two</li></ul>`)).toBe("Before\npara\ntail\nblock\none\ntwo");
    expect(htmlToText(`See <a href='https://example.test/a?b=1&amp;c=2'>the list</a> and <a href="https://example.test">https://example.test</a>`)).toBe("See the list (https://example.test/a?b=1&c=2) and https://example.test");
    expect(htmlToText("&#38;amp; &amp;lt; &#x26;")).toBe("&amp; &lt; &");
    // Every named reference in the HTML table, not just a handful.
    expect(htmlToText("9&ndash;5 &mdash; Chris&rsquo;s note &copy; &eacute;t&eacute; &hellip;")).toBe("9–5 — Chris’s note © été …");
    // References to no valid code point become U+FFFD instead of throwing.
    expect(htmlToText("a &#1114112; b &#xD800; c &#0; d")).toBe("a \uFFFD b \uFFFD c \uFFFD d");
    expect(htmlToText("an unknown &bogus; stays as written")).toBe("an unknown &bogus; stays as written");
  });
});

describe("adversarial-suite items: a hostile board address, packing for a trip that is not his, and a malformed locked garment", () => {
  it("only a plain web address is ever taken as the board's base address, and what is written is rebuilt from the parsed address", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "//example.test", "example.test/board", "https://user:pw@example.test", "", null, undefined, "https://example.test/?q=1", "https://example.test/#x", "https://example.test/a b", " https://example.test", "https://example.test/\n<script>", "https://example.test/\u0007"]) {
      expect(isWebAddress(bad), String(bad)).toBe(false);
      expect(webAddressBase(bad), String(bad)).toBeNull();
    }
    for (const good of ["https://garderobe.example", "https://garderobe.example/app/", "http://localhost:8787"]) expect(isWebAddress(good), good).toBe(true);
    expect(webAddressBase("https://Garderobe.Example/app//")).toBe("https://garderobe.example/app");
    expect(webAddressBase("https://garderobe.example/a/../b")).toBe("https://garderobe.example/b");
  });

  it("a Calendar event never carries a javascript: address from the owner's settings; the deployment's own address is used instead", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const owner = await realOwner(h);
    h.deps.boardBaseUrl = "https://garderobe.example";
    // Written straight into the stored settings, so the projector itself is what refuses it.
    const hostile = "javascript:alert(document.cookie)";
    const stored = await all<{ settings_json: string | null }>(h.db, "SELECT settings_json FROM owner_settings WHERE user_id = ?", owner.userId);
    const settings = JSON.parse(stored[0]?.settings_json ?? "{}") as { extensions?: { daily?: { calendar?: Record<string, unknown> } } };
    settings.extensions = { ...settings.extensions, daily: { ...settings.extensions?.daily, calendar: { ...settings.extensions?.daily?.calendar, boardBaseUrl: hostile } } };
    if (stored.length > 0) await h.db.prepare("UPDATE owner_settings SET settings_json = ? WHERE user_id = ?").bind(JSON.stringify(settings), owner.userId).run();
    else await h.db.prepare("INSERT INTO owner_settings (user_id, settings_json) VALUES (?, ?)").bind(owner.userId, JSON.stringify(settings)).run();
    expect(dailySettings((await loadOwner(h.db, owner.userId)).settings).calendar.boardBaseUrl).toBe(hostile);
    h.weather.setForecast("2026-09-16", MILD_DAY);
    await compose(h, owner, "2026-09-16");
    await projectCalendarEffects(h.deps, { nowMs: h.clock.now() });
    const events = h.calendar.allEvents(owner.userId, OUTFIT_CALENDAR).filter((e) => e.status !== "cancelled");
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.description ?? "").not.toMatch(/javascript:/i);
      expect(e.description ?? "").toContain("https://garderobe.example/board/2026-09-16");
    }
  });

  it("SYNTHETIC: packing is refused for a trip that does not exist, belongs to another owner or was cancelled, and nothing is packed", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-21T18:00:00Z", isolate: true });
    const garments = (id: string) => [{ id, name: "synthetic blue oxford", colour: "Blue", category: "shirt", roles: ["top"], careChannel: "service" }];
    const owner = await syntheticOwner(h, { garments: garments("shirt-a") as never });
    const other = await syntheticOwner(h, { garments: garments("shirt-z") as never });
    const trip = (tripId: string) => ({ tripId, name: `Synthetic ${tripId}`, departsOn: "2026-09-24", returnsOn: "2026-09-25", destinations: [{ ...PARIS, to: "2026-09-25" }], source: { kind: "owner_statement", note: "synthetic trip for a boundary test" } });
    await owner.exec("trip.create", trip("mine"));
    await owner.exec("trip.create", trip("called-off"));
    await owner.exec("trip.cancel", { tripId: "called-off" });
    await other.exec("trip.create", trip("theirs"));
    const pack = (tripId: string) => owner.exec("stock.pack", { tripId, items: [{ garmentId: "shirt-a", quantity: 1 }] });
    // A trip that is not his (unknown, or another owner's) is not found, never confirmed to exist; his own
    // cancelled trip is refused as a precondition.
    for (const tripId of ["no-such-trip", "theirs"]) {
      await expect(pack(tripId), tripId).rejects.toMatchObject({ code: "not_found" });
    }
    await expect(pack("called-off")).rejects.toMatchObject({ code: "precondition_failed", message: expect.stringMatching(/cancelled/) });
    // Both the trip and the piece are another owner's: still not found, from the trip, before anything else.
    await expect(other.exec("stock.pack", { tripId: "mine", items: [{ garmentId: "shirt-a", quantity: 1 }] })).rejects.toMatchObject({ code: "not_found", message: expect.stringMatching(/no such trip/) });
    // His own piece into another owner's trip: not found as well.
    await expect(other.exec("stock.pack", { tripId: "mine", items: [{ garmentId: "shirt-z", quantity: 1 }] })).rejects.toMatchObject({ code: "not_found" });
    expect(await all(h.db, "SELECT 1 FROM stock_balances WHERE user_id = ? AND bucket = 'trip' AND quantity > 0", owner.userId)).toEqual([]);
    await expect(pack("mine")).resolves.toMatchObject({ outcome: "committed" });
  });

  it("an empty or over-long locked garment identifier is refused as an invalid request, not an internal error", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const owner = await realOwner(h);
    for (const bad of ["", "g".repeat(65)]) {
      await expect(recommend(h.deps, owner.principal(), { clientRequestId: `bad-${bad.length}`, date: "2026-09-16", mode: "preview", lockedGarmentIds: [bad], nowMs: h.clock.now() })).rejects.toMatchObject({ code: "invalid_command" });
    }
  });
});

describe("request deadline: the remaining edges", () => {
  /** TEST FAKE: never answers; rejects when its signal aborts. */
  const silent = (seen: { aborted: boolean }): FetchLike => (_input, init) =>
    new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => { seen.aborted = true; reject(new Error("TEST-FAKE: aborted")); }));
  /** TEST FAKE: sends status and headers, then stalls in the body. */
  const stalledBody: FetchLike = async () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200, headers: { "content-type": "application/json" } });

  it("the caller's own abort signal still aborts the request, before or during it", async () => {
    const seen = { aborted: false };
    const controller = new AbortController();
    const pending = withRequestTimeout(silent(seen), 5_000)("https://example.test/", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/TEST-FAKE: aborted/);
    expect(seen.aborted).toBe(true);
    const already = new AbortController();
    already.abort();
    let signalWasAborted = false;
    const observe: FetchLike = async (_input, init) => { signalWasAborted = init?.signal?.aborted === true; return new Response("{}"); };
    await withRequestTimeout(observe, 5_000)("https://example.test/", { signal: already.signal });
    expect(signalWasAborted).toBe(true);
  });

  it("an infinite deadline is no deadline, and one longer than a timer can hold does not fire at once", async () => {
    const fetch: FetchLike = async () => new Response("{}");
    expect(withRequestTimeout(fetch, Number.POSITIVE_INFINITY)).toBe(fetch);
    const slow: FetchLike = () => new Promise((resolve) => setTimeout(() => resolve(new Response('{"ok":true}')), 30));
    expect(await (await withRequestTimeout(slow, 2 ** 40)("https://example.test/")).text()).toBe('{"ok":true}');
    await expect(withDeadline(new Promise((resolve) => setTimeout(() => resolve("late"), 30)), Number.MAX_SAFE_INTEGER)).resolves.toBe("late");
  });

  it("Google Calendar: an access-token lookup that never answers is abandoned as a retryable network failure; one that fails keeps its own error", async () => {
    let requests = 0;
    const fetch: FetchLike = async () => { requests++; return new Response("{}"); };
    const hung = createGoogleCalendar({ fetch, getAccessToken: () => new Promise<string>(() => undefined), timeoutMs: 40 });
    const error = await hung.getEvent("u1", "primary", "abcde").catch((e) => e);
    expect(error).toBeInstanceOf(CalendarApiError);
    expect((error as CalendarApiError).detail).toEqual({ status: null, retryable: true, reason: "network" });
    expect(requests).toBe(0);
    const failing = createGoogleCalendar({ fetch, getAccessToken: async () => { throw new Error("TEST-FAKE: token store unavailable"); }, timeoutMs: 40 });
    await expect(failing.getEvent("u1", "primary", "abcde")).rejects.toThrow(/token store unavailable/);
  });

  it("WeatherKit: headers followed by a stalled body are abandoned as a retryable provider error", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
    let binary = "";
    for (const b of der) binary += String.fromCharCode(b);
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----\n`;
    const provider = createWeatherKitProvider({ fetch: stalledBody, timeoutMs: 40, credentials: { teamId: "TESTTEAM00", serviceId: "test.service", keyId: "TESTKEY000", privateKeyPkcs8Pem: pem } });
    const error = await provider.forecast({ latitude: 51.5, longitude: -0.1, timezone: "Europe/London", startDate: "2026-09-16", endDate: "2026-09-16" }).catch((e) => e);
    expect(error).toBeInstanceOf(WeatherProviderError);
    expect((error as WeatherProviderError).detail).toEqual({ provider: "weatherkit", retryable: true });
  });
});
