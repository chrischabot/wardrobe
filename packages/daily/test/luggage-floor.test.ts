/**
 * Journey defect D07-5 ("a trip that states a luggage limit of six pieces gets a packing proposal of seven"),
 * reproduced on the real owner's imported profile and inventory with the real command service and local D1.
 * Stand-in: FakeWeatherProvider at the weather port (a synthetic mild Paris forecast with a 12 C start).
 *
 * What it pins: for two days in Paris with a dinner, the proposal already reuses one jacket, shirt, trousers,
 * belt and pair of shoes across all three outfits; only socks are not reused (profile rule 1, socks always,
 * one pair a wear). Seven pieces is the smallest set the owner's hard rules allow here, so the proposal does
 * not drop the jacket the 12 C start needs, the belt line every plan carries, or a pair of socks to reach six:
 * it proposes the smallest set and states the shortfall and what closes it.
 */
import { describe, expect, it } from "vitest";
import { proposePacking } from "../src/index.ts";
import { withoutOptionalFlourishes } from "../src/trips.ts";
import { createDailyHarness, MILD_DAY, realOwner } from "./helpers.ts";

const DAYS = ["2026-09-25", "2026-09-26"] as const;
const PARIS = { label: "Paris", latitude: 48.8534, longitude: 2.3488, timezone: "Europe/Paris", from: DAYS[0], to: DAYS[1] };

describe("journey D07-5: a luggage limit below what the owner's rules allow", () => {
  it("two days in Paris with a dinner and a six-piece bag: everything but socks is reused, the seven-piece floor is proposed and the shortfall is stated", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-21T18:00:00Z", isolate: true });
    const owner = await realOwner(h);
    for (const d of DAYS) h.weather.setForecast(d, MILD_DAY);
    await owner.exec("trip.create", { tripId: "d07-5", name: "Two days in Paris, hand luggage of six pieces", departsOn: DAYS[0], returnsOn: DAYS[1], destinations: [PARIS], occasions: [{ localDate: DAYS[1], label: "Dinner", register: "smart", segment: "evening" }], luggage: { label: "small bag", maxPieces: 6 }, source: { kind: "owner_statement", note: "Two days in Paris, one dinner, a small bag of six pieces." } });
    const p = await proposePacking(h.deps, owner.principal(), { tripId: "d07-5", clientRequestId: "d07-5", nowMs: h.clock.now() });

    expect(p.days.map((d) => `${d.localDate}:${d.segment}`)).toEqual([`${DAYS[0]}:day`, `${DAYS[1]}:day`, `${DAYS[1]}:evening`]);
    // Every role except socks is one piece, worn in all three outfits.
    for (const item of p.items.filter((i) => i.role !== "socks")) {
      expect(item.quantity, item.name).toBe(1);
      expect(p.days.every((d) => d.slots.some((s) => s.garmentId === item.garmentId)), item.name).toBe(true);
    }
    // One pair of socks a day (one garment twice or two different pairs); the dinner reuses that day's pair.
    expect(p.items.filter((i) => i.role === "socks").reduce((n, i) => n + i.quantity, 0)).toBe(2);
    // The hard rules keep the jacket for the cool start and the belt line; an optional tie, scarf or pocket
    // square is never packed into a bag that is already over its limit.
    expect([...new Set(p.items.map((i) => i.role))].sort()).toEqual(["belt", "bottom", "footwear", "outer", "socks", "top"]);
    expect(p.items.filter((i) => i.role !== "socks").map((i) => i.role).sort()).toEqual(["belt", "bottom", "footwear", "outer", "top"]);
    expect(p.days.every((d) => d.slots.every((s) => s.role !== "neckwear" && s.role !== "accessory"))).toBe(true);
    const pieces = p.items.reduce((n, i) => n + i.quantity, 0);
    expect(pieces).toBe(7);
    expect(p.notes.join(" ")).toMatch(/This is 7 pieces against a limit of 6 for small bag/);
    expect(p.notes.join(" ")).toMatch(/wearing the travel-day outfit rather than packing it closes part of the gap/);
  });

  it("SYNTHETIC plan: over the limit the optional flourishes are left out one at a time and named; within the limit they stay", () => {
    const item = (garmentId: string, role: "top" | "bottom" | "neckwear" | "accessory" | "socks", quantity = 1) => [garmentId, { garmentId, name: `synthetic ${garmentId}`, role, quantity }] as const;
    const plan = {
      items: new Map([item("shirt", "top"), item("trousers", "bottom"), item("tie", "neckwear"), item("square", "accessory"), item("socks", "socks", 2)]),
      days: [{ localDate: "2026-09-25", segment: "day" as const, occasion: null, slots: [{ role: "top" as const, garmentId: "shirt" }, { role: "neckwear" as const, garmentId: "tie" }, { role: "accessory" as const, garmentId: "square" }], reason: "synthetic" }],
      pieces: 6,
    };
    expect(withoutOptionalFlourishes(plan, null).leftOut).toEqual([]);
    expect(withoutOptionalFlourishes(plan, 6).pieces).toBe(6);
    const one = withoutOptionalFlourishes(plan, 5);
    expect(one.pieces).toBe(5);
    expect(one.leftOut).toEqual(["synthetic tie"]);
    expect(one.days[0]!.slots.map((s) => s.garmentId)).toEqual(["shirt", "square"]);
    const both = withoutOptionalFlourishes(plan, 3);
    // Nothing a hard rule needs is removed to reach an unreachable limit.
    expect(both.pieces).toBe(4);
    expect([...both.items.keys()]).toEqual(["shirt", "trousers", "socks"]);
    expect(both.leftOut).toEqual(["synthetic tie", "synthetic square"]);
    expect(plan.items.size).toBe(5); // the plan given is not changed
  });
});
