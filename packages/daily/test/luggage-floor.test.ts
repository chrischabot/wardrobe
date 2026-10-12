/**
 * Journey defect D07-5 ("a trip that states a luggage limit of six pieces gets a packing proposal of seven"),
 * reproduced on the real owner's imported profile and inventory with the real command service and local D1.
 * Stand-in: FakeWeatherProvider at the weather port (a synthetic mild Paris forecast with a 12 C start).
 *
 * Coordinator decision on D07-5: the outfit worn on the travel day is not packed, so it does not count
 * against the luggage limit; only packed pieces do. Before the fix the proposal counted the worn outfit
 * too, so this trip came to seven pieces against six and stated a shortfall for a bag the set fits.
 */
import { describe, expect, it } from "vitest";
import { proposePacking } from "../src/index.ts";
import { withoutOptionalFlourishes } from "../src/trips.ts";
import { createDailyHarness, MILD_DAY, realOwner } from "./helpers.ts";

const DAYS = ["2026-09-25", "2026-09-26"] as const;
const PARIS = { label: "Paris", latitude: 48.8534, longitude: 2.3488, timezone: "Europe/Paris", from: DAYS[0], to: DAYS[1] };

describe("journey D07-5: the luggage limit counts packed pieces, not the travel-day outfit", () => {
  it("two days in Paris with a dinner and a six-piece bag: the travel-day outfit is worn, the packed set fits and no shortfall is stated", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-21T18:00:00Z", isolate: true });
    const owner = await realOwner(h);
    for (const d of DAYS) h.weather.setForecast(d, MILD_DAY);
    await owner.exec("trip.create", { tripId: "d07-5", name: "Two days in Paris, hand luggage of six pieces", departsOn: DAYS[0], returnsOn: DAYS[1], destinations: [PARIS], occasions: [{ localDate: DAYS[1], label: "Dinner", register: "smart", segment: "evening" }], luggage: { label: "small bag", maxPieces: 6 }, source: { kind: "owner_statement", note: "Two days in Paris, one dinner, a small bag of six pieces." } });
    const p = await proposePacking(h.deps, owner.principal(), { tripId: "d07-5", clientRequestId: "d07-5", nowMs: h.clock.now() });

    expect(p.days.map((d) => `${d.localDate}:${d.segment}`)).toEqual([`${DAYS[0]}:day`, `${DAYS[1]}:day`, `${DAYS[1]}:evening`]);
    for (const d of p.days) for (const role of ["top", "bottom", "socks", "footwear"]) expect(d.slots.some((s) => s.role === role), `${d.localDate} ${d.segment} ${role}`).toBe(true);
    const travel = p.days[0]!;
    const worn = new Set(travel.slots.map((s) => s.garmentId));
    const needed = p.items.reduce((n, i) => n + i.quantity, 0);
    const packed = p.items.reduce((n, i) => n + i.quantity - (worn.has(i.garmentId) ? 1 : 0), 0);
    // The whole set the trip needs is still listed (what is worn travels too); only the bag count differs.
    expect(needed - packed).toBe(worn.size);
    expect(packed).toBeLessThanOrEqual(6);
    const notes = p.notes.join(" ");
    expect(notes).not.toMatch(/against a limit of/);
    expect(notes).toContain(`The outfit worn on ${DAYS[0]} for the journey is not packed, so it does not count against small bag: ${packed} ${packed === 1 ? "piece is" : "pieces are"} packed.`);
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
    // With a travel day, the pieces worn for the journey are not in the bag: the shirt, tie and one pair of
    // socks worn on the day leave 3 packed (trousers, square, a pair of socks); leaving the worn tie out frees
    // no space, so it is removed only on the way to the square.
    const travelled = { ...plan, travelDate: "2026-09-25", days: [{ ...plan.days[0]!, slots: [{ role: "top" as const, garmentId: "shirt" }, { role: "neckwear" as const, garmentId: "tie" }, { role: "socks" as const, garmentId: "socks" }] }], pieces: 3 };
    expect(withoutOptionalFlourishes(travelled, 3).leftOut).toEqual([]);
    const squeezed = withoutOptionalFlourishes(travelled, 2);
    expect(squeezed.pieces).toBe(2);
    expect(squeezed.leftOut).toEqual(["synthetic tie", "synthetic square"]);
  });
});
