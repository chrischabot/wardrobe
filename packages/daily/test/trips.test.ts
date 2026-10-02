/**
 * Trip and packing mode, end to end at the domain level, with the real owner's wardrobe on real local
 * D1. A proposal is only a proposal; what is packed is what the owner's `stock.pack` observations say;
 * destination boards use the packed subset; home laundry never washes a suitcase; unpacking is not
 * washing. The weather provider is the labelled fake behind the weather port.
 */
import { describe, expect, it } from "vitest";
import { all, first } from "@garderobe/domain";
import type { TestOwner } from "@garderobe/domain/testing";
import { getTrip, listTrips, prepareTripDayBoard, proposePacking, validateOutfit, weatherCompareLocations } from "../src/index.ts";
import { compose, createDailyHarness, garmentsByName, realOwner, SCHEDULED, type DailyHarness } from "./helpers.ts";

const PARIS = { label: "Paris", latitude: 48.8534, longitude: 2.3488, timezone: "Europe/Paris", from: "2026-09-24", to: "2026-09-26" };
const PARIS_DAY = { temperatureByHour: { 0: 11, 8: 13, 14: 20, 19: 17, 23: 13 } };

async function setup(): Promise<{ h: DailyHarness; owner: TestOwner; tripId: string }> {
  const h = await createDailyHarness({ startAt: "2026-09-21T18:00:00Z", isolate: true });
  const owner = await realOwner(h);
  for (const d of ["2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28"]) h.weather.setForecast(d, PARIS_DAY);
  // "Three days in Paris, one dinner, carry-on only."
  const receipt = await owner.exec("trip.create", {
    tripId: "paris-sept",
    name: "Three days in Paris",
    departsOn: "2026-09-24",
    returnsOn: "2026-09-26",
    destinations: [PARIS],
    occasions: [{ localDate: "2026-09-25", label: "Dinner", register: "smart", segment: "evening" }],
    luggage: { label: "carry-on", maxPieces: 14 },
    source: { kind: "owner_statement", note: "Three days in Paris, one dinner, carry-on only" },
  });
  return { h, owner, tripId: (receipt.result as any).tripId };
}

async function pack(owner: TestOwner, tripId: string, items: { garmentId: string; quantity: number }[]) {
  return owner.exec("stock.pack", { tripId, items });
}

describe("packing proposal", () => {
  it("proposes a compact set with deliberate reuse from destination weather, covers the dinner, and packs nothing", async () => {
    const { h, owner, tripId } = await setup();
    const proposal = await proposePacking(h.deps, owner.principal(), { tripId, clientRequestId: "pp-1", nowMs: h.clock.now() });

    // Destination weather, in the destination's timezone, fetched by the service (not the model).
    expect(h.weather.calls.every((c) => c.timezone === "Europe/Paris" && Math.abs(c.latitude - 48.9) < 0.11)).toBe(true);
    expect(proposal.weather.map((w) => [w.localDate, w.label, w.freshness])).toEqual([["2026-09-24", "Paris", "fresh"], ["2026-09-25", "Paris", "fresh"], ["2026-09-26", "Paris", "fresh"]]);

    // One outfit per day plus the dinner.
    expect(proposal.days.map((d) => `${d.localDate}:${d.segment}`)).toEqual(["2026-09-24:day", "2026-09-25:day", "2026-09-25:evening", "2026-09-26:day"]);
    expect(proposal.days.find((d) => d.segment === "evening")!.occasion).toBe("Dinner");
    const role = (r: string) => proposal.items.filter((i) => i.role === r);
    const dayTops = proposal.days.filter((d) => d.segment === "day").map((d) => d.slots.find((s) => s.role === "top")!.garmentId);
    expect(new Set(dayTops).size).toBe(3); // a shirt a day
    // Deliberate reuse: fewer trousers than outfits, one pair of shoes, at most one jacket.
    expect(role("bottom").length).toBeLessThan(proposal.days.length);
    expect(role("footwear")).toHaveLength(1);
    expect(role("outer").length).toBeLessThanOrEqual(1);
    // A pair of socks per wearing day (the dinner reuses the day's pair), and no pair is planned for two days.
    expect(role("socks").reduce((n, i) => n + i.quantity, 0)).toBe(3);
    const sockByDay = new Map(proposal.days.filter((d) => d.segment === "day").map((d) => [d.localDate, d.slots.find((s) => s.role === "socks")!.garmentId]));
    for (const item of role("socks")) expect([...sockByDay.values()].filter((id) => id === item.garmentId).length, `${item.name}: days planned against pairs packed`).toBe(item.quantity);
    const dinner = proposal.days.find((d) => d.segment === "evening")!;
    expect(dinner.slots.find((s) => s.role === "socks")!.garmentId).toBe(sockByDay.get(dinner.localDate));
    expect(proposal.repeatExceptionForTrip).toBe(true);
    expect(proposal.notes.join(" ")).toMatch(/applies to this trip only/);
    // Every day is a valid outfit under the trip's repeat exception (the hard rules still hold).
    const names = await garmentsByName(h, owner);
    const shoes = [...names.values()].filter((g) => g.category === "footwear");
    for (const d of proposal.days) {
      expect(d.slots.some((s) => s.role === "socks")).toBe(true);
      const shoe = shoes.find((s) => s.garment_id === d.slots.find((x) => x.role === "footwear")!.garmentId)!;
      expect(JSON.parse(shoe.attributes_json).footwearKind).toBe("sneaker");
    }

    // Proposed is not packed: the ledger has nothing in the trip location, and home stock is unchanged.
    const trip = (await getTrip(h.db, owner.principal(), tripId))!;
    expect(trip.proposal!.revision).toBe(1);
    expect(trip.packed).toEqual([]);
    expect((await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM stock_balances WHERE user_id = ? AND bucket = 'trip' AND quantity > 0", owner.userId))!.n).toBe(0);
    const home = await validateOutfit(h.db, owner.principal(), { forDate: "2026-09-22", slots: proposal.days[0]!.slots.filter((s) => s.role !== "neckwear"), nowMs: h.clock.now() });
    expect(home.violations.filter((v) => v.code === "unavailable")).toEqual([]);
    // The ordinary rotation rule is untouched by the trip's exception.
    const repeat = await first<{ status: string; params_json: string }>(h.db, "SELECT status, params_json FROM style_rules WHERE user_id = ? AND key = 'variety.repeat_horizon' AND is_current = 1", owner.userId);
    expect(repeat!.status).toBe("active");
    expect(JSON.parse(repeat!.params_json).days).toBe(7);
  });

  it("SYNTHETIC: one clean pair of socks is never planned for two days; when the pairs run out the proposal says so instead of reusing one", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-21T18:00:00Z", isolate: true });
    const owner = await h.createSyntheticOwner({
      settings: { homeLocation: { label: "London", latitude: 51.5085, longitude: -0.1257 } } as never,
      garments: [
        { id: "shirt-a", name: "synthetic blue oxford", colour: "Blue", category: "shirt", roles: ["top"], careChannel: "service" },
        { id: "shirt-b", name: "synthetic white oxford", colour: "White", category: "shirt", roles: ["top"], careChannel: "service" },
        { id: "shirt-c", name: "synthetic moss oxford", colour: "Moss", category: "shirt", roles: ["top"], careChannel: "service" },
        { id: "trouser-a", name: "synthetic beige chinos", colour: "Beige", category: "trousers", roles: ["bottom"], careChannel: "service" },
        { id: "trouser-b", name: "synthetic olive fatigues", colour: "Olive", category: "trousers", roles: ["bottom"], careChannel: "service" },
        { id: "sock-a", name: "synthetic navy socks", colour: "Navy", category: "socks", roles: ["socks"], careChannel: "handwash", quantity: 1 },
        { id: "sock-b", name: "synthetic grey socks", colour: "Grey", category: "socks", roles: ["socks"], careChannel: "handwash", quantity: 1 },
        { id: "shoe", name: "synthetic sneakers", colour: "Grey", category: "footwear", roles: ["footwear"], careChannel: "none", attributes: { footwearKind: "sneaker" } },
      ],
    });
    for (const d of ["2026-09-24", "2026-09-25", "2026-09-26"]) h.weather.setForecast(d, PARIS_DAY);
    await owner.exec("trip.create", { tripId: "synthetic-three-days", name: "Synthetic three days", departsOn: "2026-09-24", returnsOn: "2026-09-26", destinations: [PARIS], source: { kind: "owner_statement", note: "synthetic trip for a boundary test" } });
    const proposal = await proposePacking(h.deps, owner.principal(), { tripId: "synthetic-three-days", clientRequestId: "pp-synthetic", nowMs: h.clock.now() });

    // Two single pairs cover two days. The third day is not dressed in a pair already planned.
    expect(proposal.days.map((d) => d.localDate)).toEqual(["2026-09-24", "2026-09-25"]);
    const socks = proposal.days.map((d) => d.slots.find((s) => s.role === "socks")!.garmentId);
    expect([...socks].sort()).toEqual(["sock-a", "sock-b"]);
    expect(proposal.items.filter((i) => i.role === "socks").map((i) => [i.garmentId, i.quantity]).sort()).toEqual([["sock-a", 1], ["sock-b", 1]]);
    expect(proposal.notes.join(" ")).toMatch(/No complete valid outfit could be proposed for 2026-09-26/);
  });
});

describe("packed stock and destination boards", () => {
  it("a destination board uses only what was physically packed; home stock cannot leak in and restricted shoes stay restricted in a suitcase", async () => {
    const { h, owner, tripId } = await setup();
    const names = await garmentsByName(h, owner);
    const g = (n: string) => names.get(n)!.garment_id;
    const packed = ["Lightweight oxford — gold", "Lightweight oxford — moss", "Lightweight oxford — red stripe", "Di Sondrio beige chino", "Olive reverse sateen fatigue", "Drake's Olive Jungle Jacket", "NB 990v4 — navy", "Anderson's belt — brown", "Paraboot Michael Cerf"];
    await pack(owner, tripId, [...packed.map((n) => ({ garmentId: g(n), quantity: 1 })), { garmentId: g("Merino — inky blue"), quantity: 3 }]);

    const trip = (await getTrip(h.db, owner.principal(), tripId))!;
    expect(trip.packed.map((p) => p.name).sort()).toEqual([...packed, "Merino — inky blue"].sort());
    expect(trip.packed.find((p) => p.name === "Merino — inky blue")).toMatchObject({ clean: 3, worn: 0 });

    h.clock.set("2026-09-24T05:00:00Z");
    const result = await prepareTripDayBoard(h.deps, owner.principal(), { tripId, date: "2026-09-24", clientRequestId: "tb-1", nowMs: h.clock.now() });
    const doc = result.board!;
    expect(doc.scope).toBe(`trip:${tripId}`);
    expect(doc.timezone).toBe("Europe/Paris");
    const packedIds = new Set([...packed.map(g), g("Merino — inky blue")]);
    const used = doc.options.flatMap((o) => [...o.garments.map((x) => x.garmentId), ...o.footwearAlternatives.map((x) => x.garmentId), ...(o.flourish ? [o.flourish.garmentId] : [])]);
    expect(used.length).toBeGreaterThan(0);
    for (const id of used) expect(packedIds.has(id), `${[...names.values()].find((x) => x.garment_id === id)?.name} was not packed`).toBe(true);
    expect(used).not.toContain(g("Paraboot Michael Cerf")); // packing does not lift the healing restriction
    // Three packed shirts: three honest outfits, with one brief explanation; never five padded ones.
    expect(doc.options).toHaveLength(3);
    expect(doc.requestedCount).toBe(5);
    expect(doc.notice).toMatch(/Three valid outfits today instead of 5: only 3 eligible shirts\./);

    // Meanwhile at home the packed pieces are gone from the pool.
    h.weather.setForecast("2026-09-24", PARIS_DAY);
    const homeBoard = (await compose(h, owner, "2026-09-24")).board!;
    const homeUsed = homeBoard.options.flatMap((o) => o.garments.map((x) => x.garmentId));
    for (const id of packedIds) {
      if (id === g("Merino — inky blue")) continue; // one pair of four stays at home
      expect(homeUsed, "a packed piece is not offered at home").not.toContain(id);
    }
    const atHome = await validateOutfit(h.db, owner.principal(), { forDate: "2026-09-24", nowMs: h.clock.now(), slots: [{ role: "top", garmentId: g("Lightweight oxford — gold") }, { role: "bottom", garmentId: g("Di Sondrio grey chino") }, { role: "socks", garmentId: g("Merino — inky blue") }, { role: "footwear", garmentId: g("NB 990v4 — grey") }] });
    expect(atHome.violations.filter((v) => v.severity === "blocking").map((v) => v.code)).toEqual(["unavailable"]);
    const onTrip = await validateOutfit(h.db, owner.principal(), { forDate: "2026-09-24", tripId, nowMs: h.clock.now(), slots: [{ role: "top", garmentId: g("Lightweight oxford — gold") }, { role: "bottom", garmentId: g("Di Sondrio grey chino") }, { role: "socks", garmentId: g("Merino — inky blue") }, { role: "footwear", garmentId: g("NB 990v4 — navy") }] });
    expect(onTrip.violations.filter((v) => v.severity === "blocking").map((v) => v.code)).toEqual(["not_packed"]); // the grey chinos stayed at home
  });

  it("a wear on the trip uses the packed subset; a home laundry reset does not wash the suitcase; unpacking returns pieces without declaring them clean", async () => {
    const { h, owner, tripId } = await setup();
    const names = await garmentsByName(h, owner);
    const g = (n: string) => names.get(n)!.garment_id;
    const gold = g("Lightweight oxford — gold");
    const moss = g("Lightweight oxford — moss");
    await pack(owner, tripId, [gold, moss, g("Di Sondrio beige chino"), g("Olive reverse sateen fatigue"), g("NB 990v4 — navy")].map((garmentId) => ({ garmentId, quantity: 1 })));
    await pack(owner, tripId, [{ garmentId: g("Merino — inky blue"), quantity: 3 }]);

    h.clock.set("2026-09-24T08:00:00Z");
    await owner.exec("wear.record", { wearingDate: "2026-09-24", tripId, garmentIds: [gold, g("Di Sondrio beige chino"), g("Merino — inky blue"), g("NB 990v4 — navy")] });
    let trip = (await getTrip(h.db, owner.principal(), tripId))!;
    expect(trip.packed.find((p) => p.garmentId === gold)).toMatchObject({ clean: 0, worn: 1 });
    expect(trip.packed.find((p) => p.garmentId === g("Merino — inky blue"))).toMatchObject({ clean: 2, worn: 1 });

    // Friday-to-Sunday home laundry cycle passes while he is away.
    h.clock.set("2026-09-27T09:00:00Z");
    await owner.exec("laundry.apply_weekly_reset", {}, { ...SCHEDULED, authorization: "standing_policy" });
    trip = (await getTrip(h.db, owner.principal(), tripId))!;
    expect(trip.packed.find((p) => p.garmentId === gold)).toMatchObject({ clean: 0, worn: 1 });
    await owner.exec("trip.update", { tripId, changes: { returnsOn: "2026-09-28", destinations: [{ ...PARIS, to: "2026-09-28" }] } });
    const board = (await prepareTripDayBoard(h.deps, owner.principal(), { tripId, date: "2026-09-28", clientRequestId: "tb-2", nowMs: h.clock.now() })).board!;
    expect(board.options).toHaveLength(1); // only the moss shirt is still clean in the suitcase
    expect(board.options[0]!.garments.find((x) => x.role === "top")!.garmentId).toBe(moss);
    expect(board.options.flatMap((o) => o.garments.map((x) => x.garmentId))).not.toContain(gold);

    // Home again: unpacking is not washing.
    h.clock.set("2026-09-29T09:00:00Z");
    const receipt = await owner.exec("stock.unpack", { tripId });
    expect(receipt.summary).toMatch(/not marked clean/);
    const balances = async (id: string) => Object.fromEntries((await all<{ bucket: string; quantity: number }>(h.db, "SELECT bucket, quantity FROM stock_balances WHERE user_id = ? AND garment_id = ? AND quantity > 0", owner.userId, id)).map((b) => [b.bucket, b.quantity]));
    expect(await balances(gold)).toEqual({ dirty: 1 });
    // Even the shirt that was never worn comes home awaiting care: unpacking asserts nothing about cleanliness.
    expect(await balances(moss)).toEqual({ dirty: 1 });
    expect((await getTrip(h.db, owner.principal(), tripId))!.packed).toEqual([]);
    const worn = await validateOutfit(h.db, owner.principal(), { forDate: "2026-09-30", nowMs: h.clock.now(), allowRepeat: true, slots: [{ role: "top", garmentId: gold }, { role: "bottom", garmentId: g("Di Sondrio grey chino") }, { role: "socks", garmentId: g("Merino — blue jean") }, { role: "footwear", garmentId: g("NB 990v4 — grey") }] });
    expect(worn.violations.filter((v) => v.severity === "blocking").map((v) => v.code)).toEqual(["unavailable"]);
    await owner.exec("care.washed", { items: [{ garmentId: gold }] }); // the owner's wash report establishes cleanliness
    expect(await balances(gold)).toEqual({ clean: 1 });
  });

  it("validates trip facts and keeps cancelled trips out of the way", async () => {
    const { h, owner, tripId } = await setup();
    await expect(owner.exec("trip.create", { name: "Backwards", departsOn: "2026-10-05", returnsOn: "2026-10-01", destinations: [{ ...PARIS, from: "2026-10-01", to: "2026-10-05" }], source: { kind: "owner_statement" } })).rejects.toMatchObject({ code: "invalid_command" });
    await expect(owner.exec("trip.create", { name: "Nowhere", departsOn: "2026-10-01", returnsOn: "2026-10-03", destinations: [{ ...PARIS, timezone: "Mars/Olympus", from: "2026-10-01", to: "2026-10-03" }], source: { kind: "owner_statement" } })).rejects.toMatchObject({ code: "invalid_command" });
    await expect(prepareTripDayBoard(h.deps, owner.principal(), { tripId, date: "2026-10-15", clientRequestId: "x", nowMs: h.clock.now() })).rejects.toMatchObject({ code: "invalid_command" });
    await owner.exec("trip.cancel", { tripId });
    expect((await listTrips(h.db, owner.principal())).map((t) => [t.tripId, t.status])).toEqual([[tripId, "cancelled"]]);
    await expect(proposePacking(h.deps, owner.principal(), { tripId, clientRequestId: "pp-2", nowMs: h.clock.now() })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("travel across timezones", () => {
  it("compares home with a destination nine hours of clock away, and a Tokyo trip-day board runs on Tokyo's calendar day", async () => {
    const { h, owner } = await setup();
    h.weather.setForecast("2026-10-10", { temperatureByHour: { 0: 18, 8: 19, 14: 24, 23: 19 } });
    const comparison = await weatherCompareLocations(h.deps, owner.principal(), { localDate: "2026-10-10", locations: [{ label: "London" }, { label: "Tokyo" }] }, { nowMs: h.clock.now() });
    expect(comparison.snapshots.map((s) => s.location.timezone)).toEqual(["Europe/London", "Asia/Tokyo"]);
    expect(comparison.differences[0]).toMatchObject({ label: "Tokyo", utcOffsetDeltaMinutes: 480 });
    // The Tokyo snapshot's hours are Tokyo's 10 October: its 08:00 is 23:00 UTC the day before.
    const tokyo = comparison.snapshots[1]!;
    expect(tokyo.hours.find((x) => x.localTime === "2026-10-10T08:00")!.at).toBe("2026-10-09T23:00:00Z");
    expect(tokyo.conditions.departureInterval).toMatch(/Asia\/Tokyo/);

    const names = await garmentsByName(h, owner);
    const g = (n: string) => names.get(n)!.garment_id;
    await owner.exec("trip.create", { tripId: "tokyo", name: "Tokyo", departsOn: "2026-10-10", returnsOn: "2026-10-12", destinations: [{ label: "Tokyo", latitude: 35.6895, longitude: 139.6917, timezone: "Asia/Tokyo", from: "2026-10-10", to: "2026-10-12" }], source: { kind: "owner_statement" } });
    await pack(owner, "tokyo", [g("Lightweight oxford — gold"), g("Di Sondrio beige chino"), g("NB 990v4 — navy"), g("Merino — inky blue")].map((garmentId) => ({ garmentId, quantity: 1 })));
    // 9 October, 16:30 in London is already 00:30 on the 10th in Tokyo: the 10th is "today" for the trip board.
    h.clock.set("2026-10-09T15:30:00Z");
    const board = (await prepareTripDayBoard(h.deps, owner.principal(), { tripId: "tokyo", date: "2026-10-10", clientRequestId: "tk-1", nowMs: h.clock.now() })).board!;
    expect(board.timezone).toBe("Asia/Tokyo");
    expect(board.options).toHaveLength(1);
    expect(board.weatherLine).toMatch(/19 °C leaving, 24 °C later/);
    // The same instant is still the 9th at home, so a home board for the 9th is today's, not the past.
    h.weather.setForecast("2026-10-09", PARIS_DAY);
    expect((await compose(h, owner, "2026-10-09")).board!.localDate).toBe("2026-10-09");
  });
});
