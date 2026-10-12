/**
 * A packing proposal fits the trip's luggage limit (specification section 10).
 *
 * Real command service and real local D1; FakeWeatherProvider at the weather port. The wardrobe is labelled
 * synthetic so the piece counts are known exactly: four shirts, three trousers, one pair of shoes and four
 * pairs of socks for a four-day trip.
 */
import { describe, expect, it } from "vitest";
import { proposePacking } from "../src/index.ts";
import { choosePackingPlan } from "../src/trips.ts";
import { createDailyHarness, MILD_DAY, WARM_DAY } from "./helpers.ts";

const WARDROBE = [
  { id: "shirt-a", name: "synthetic blue oxford", colour: "Blue", category: "shirt", roles: ["top"], careChannel: "service" },
  { id: "shirt-b", name: "synthetic white oxford", colour: "White", category: "shirt", roles: ["top"], careChannel: "service" },
  { id: "shirt-c", name: "synthetic moss oxford", colour: "Moss", category: "shirt", roles: ["top"], careChannel: "service" },
  { id: "shirt-d", name: "synthetic pink oxford", colour: "Pink", category: "shirt", roles: ["top"], careChannel: "service" },
  { id: "trouser-a", name: "synthetic beige chinos", colour: "Beige", category: "trousers", roles: ["bottom"], careChannel: "service" },
  { id: "trouser-b", name: "synthetic olive fatigues", colour: "Olive", category: "trousers", roles: ["bottom"], careChannel: "service" },
  { id: "trouser-c", name: "synthetic stone chinos", colour: "Stone", category: "trousers", roles: ["bottom"], careChannel: "service" },
  { id: "sock-a", name: "synthetic grey socks", colour: "Grey", category: "socks", roles: ["socks"], careChannel: "service", quantity: 4 },
  { id: "shoe", name: "synthetic sneakers", colour: "White", category: "footwear", roles: ["footwear"], careChannel: "none", attributes: { footwearKind: "sneaker" } },
];
const DAYS = ["2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"];
const PARIS = { label: "Paris", latitude: 48.8534, longitude: 2.3488, timezone: "Europe/Paris", from: DAYS[0]!, to: DAYS[3]! };

async function propose(maxPieces: number | null, tripId: string) {
  const h = await createDailyHarness({ startAt: "2026-09-21T18:00:00Z", isolate: true });
  const owner = await h.createSyntheticOwner({ settings: { homeLocation: { label: "London", latitude: 51.5085, longitude: -0.1257 } } as never, garments: WARDROBE as never });
  for (const d of DAYS) h.weather.setForecast(d, MILD_DAY);
  await owner.exec("trip.create", { tripId, name: "Synthetic four days", departsOn: DAYS[0], returnsOn: DAYS[3], destinations: [PARIS], luggage: maxPieces === null ? null : { label: "the cabin bag", maxPieces }, source: { kind: "owner_statement", note: "synthetic trip for a boundary test" } });
  const proposal = await proposePacking(h.deps, owner.principal(), { tripId, clientRequestId: tripId, nowMs: h.clock.now() });
  return { proposal, pieces: proposal.items.reduce((n, i) => n + i.quantity, 0) };
}

describe("the packing proposal and the luggage limit", () => {
  it("SYNTHETIC: a set that does not fit the bag is planned again with more reuse until it fits, and says so", async () => {
    const free = await propose(null, "luggage-free");
    expect(free.pieces, "without a limit the set is larger than the bag below").toBeGreaterThan(9);
    const fitted = await propose(9, "luggage-nine");
    expect(fitted.pieces).toBeLessThanOrEqual(9);
    expect(fitted.proposal.days).toHaveLength(4);
    for (const day of fitted.proposal.days) for (const role of ["top", "bottom", "socks", "footwear"]) expect(day.slots.some((s) => s.role === role), `${day.localDate} ${role}`).toBe(true);
    const notes = fitted.proposal.notes.join(" ");
    expect(notes).toMatch(/To fit the cabin bag \(9 pieces\)/);
    expect(notes).not.toMatch(/against a limit/);
  });

  it("SYNTHETIC: a limit no reuse can meet proposes the smallest set and states the shortfall", async () => {
    const tight = await propose(4, "luggage-four");
    expect(tight.pieces).toBeGreaterThan(4);
    expect(tight.proposal.notes.join(" ")).toMatch(new RegExp(`This is ${tight.pieces} pieces against a limit of 4 for the cabin bag`));
  });

  it("SYNTHETIC: with the weather alternating, an earlier shirt still under its limit is worn again rather than packing another", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-21T18:00:00Z", isolate: true });
    const owner = await h.createSyntheticOwner({ settings: { homeLocation: { label: "London", latitude: 51.5085, longitude: -0.1257 } } as never, garments: [] });
    const source = { kind: "system", note: "synthetic test fixture - not the owner's wardrobe" };
    const cool = { maxC: 22, basis: "daytime_peak", source: "synthetic boundary" };
    const warm = { minC: 23, basis: "daytime_peak", source: "synthetic boundary" };
    const garments = [
      { garmentId: "cool-a", name: "synthetic flannel shirt A", category: "shirt", roles: ["top"], careChannel: "service", colour: "Blue", thermal: cool },
      { garmentId: "cool-b", name: "synthetic flannel shirt B", category: "shirt", roles: ["top"], careChannel: "service", colour: "Moss", thermal: cool },
      { garmentId: "cool-c", name: "synthetic flannel shirt C", category: "shirt", roles: ["top"], careChannel: "service", colour: "Pink", thermal: cool },
      { garmentId: "warm-a", name: "synthetic linen shirt", category: "shirt", roles: ["top"], careChannel: "service", colour: "White", thermal: warm },
      { garmentId: "trouser", name: "synthetic beige chinos", category: "trousers", roles: ["bottom"], careChannel: "service", colour: "Beige" },
      { garmentId: "sock", name: "synthetic grey socks", category: "socks", roles: ["socks"], careChannel: "service", colour: "Grey", quantity: 3 },
      { garmentId: "shoe", name: "synthetic sneakers", category: "footwear", roles: ["footwear"], careChannel: "none", colour: "White", attributes: { footwearKind: "sneaker" } },
    ];
    for (const g of garments) await owner.exec("garment.create", { acquisition: "owned", quantity: 1, isSynthetic: true, source, ...g } as never);
    const days = ["2026-09-24", "2026-09-25", "2026-09-26"];
    h.weather.setForecast(days[0]!, MILD_DAY);
    h.weather.setForecast(days[1]!, WARM_DAY);
    h.weather.setForecast(days[2]!, MILD_DAY);
    await owner.exec("trip.create", { tripId: "luggage-weather", name: "Synthetic three days", departsOn: days[0], returnsOn: days[2], destinations: [{ ...PARIS, from: days[0], to: days[2] }], luggage: { label: "the cabin bag", maxPieces: 7 }, source: { kind: "owner_statement", note: "synthetic trip for a boundary test" } });
    const proposal = await proposePacking(h.deps, owner.principal(), { tripId: "luggage-weather", clientRequestId: "luggage-weather", nowMs: h.clock.now() });
    const top = (i: number) => proposal.days[i]!.slots.find((s) => s.role === "top")?.garmentId;
    expect(proposal.days).toHaveLength(3);
    expect(top(1)).toBe("warm-a");
    expect(top(2), "the cool day after the warm one wears the first cool shirt again").toBe(top(0));
    expect(proposal.items.filter((i) => i.role === "top")).toHaveLength(2);
    expect(proposal.items.reduce((n, i) => n + i.quantity, 0)).toBeLessThanOrEqual(7);
    expect(proposal.notes.join(" ")).not.toMatch(/against a limit/);
  });

  it("SYNTHETIC: an earlier shirt is reused even when the trousers it was worn with must change for the weather", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-21T18:00:00Z", isolate: true });
    const owner = await h.createSyntheticOwner({ settings: { homeLocation: { label: "London", latitude: 51.5085, longitude: -0.1257 } } as never, garments: [] });
    const source = { kind: "system", note: "synthetic test fixture - not the owner's wardrobe" };
    const garments = [
      { garmentId: "shirt-a", name: "synthetic blue oxford", category: "shirt", roles: ["top"], careChannel: "service", colour: "Blue" },
      { garmentId: "shirt-b", name: "synthetic white oxford", category: "shirt", roles: ["top"], careChannel: "service", colour: "White" },
      { garmentId: "cord", name: "synthetic beige cords", category: "trousers", roles: ["bottom"], careChannel: "service", colour: "Beige", thermal: { maxC: 22, basis: "daytime_peak", source: "synthetic boundary" } },
      { garmentId: "linen", name: "synthetic stone linen trousers", category: "trousers", roles: ["bottom"], careChannel: "service", colour: "Stone", thermal: { minC: 23, basis: "daytime_peak", source: "synthetic boundary" } },
      { garmentId: "sock", name: "synthetic grey socks", category: "socks", roles: ["socks"], careChannel: "service", colour: "Grey", quantity: 2 },
      { garmentId: "shoe", name: "synthetic sneakers", category: "footwear", roles: ["footwear"], careChannel: "none", colour: "White", attributes: { footwearKind: "sneaker" } },
    ];
    for (const g of garments) await owner.exec("garment.create", { acquisition: "owned", quantity: 1, isSynthetic: true, source, ...g } as never);
    const days = ["2026-09-24", "2026-09-25"];
    h.weather.setForecast(days[0]!, MILD_DAY);
    h.weather.setForecast(days[1]!, WARM_DAY);
    await owner.exec("trip.create", { tripId: "luggage-relax", name: "Synthetic two days", departsOn: days[0], returnsOn: days[1], destinations: [{ ...PARIS, from: days[0], to: days[1] }], luggage: { label: "the cabin bag", maxPieces: 6 }, source: { kind: "owner_statement", note: "synthetic trip for a boundary test" } });
    const proposal = await proposePacking(h.deps, owner.principal(), { tripId: "luggage-relax", clientRequestId: "luggage-relax", nowMs: h.clock.now() });
    const slot = (i: number, role: string) => proposal.days[i]!.slots.find((s) => s.role === role)?.garmentId;
    expect(proposal.days).toHaveLength(2);
    expect([slot(0, "bottom"), slot(1, "bottom")]).toEqual(["cord", "linen"]);
    expect(slot(1, "top")).toBe(slot(0, "top"));
    expect(proposal.items.reduce((n, i) => n + i.quantity, 0)).toBeLessThanOrEqual(6);
    expect(proposal.notes.join(" ")).not.toMatch(/against a limit/);
  });
});

describe("choosing the packing plan (labelled synthetic plans)", () => {
  const plans = (list: { pieces: number; covered: number }[]) => async (i: number) => list[i]!;
  it("a retry that fits only because it left a day without an outfit is not accepted", async () => {
    const chosen = await choosePackingPlan(3, 8, plans([{ pieces: 10, covered: 4 }, { pieces: 7, covered: 3 }, { pieces: 8, covered: 4 }]));
    expect(chosen).toEqual({ plan: { pieces: 8, covered: 4 }, level: 2 });
  });
  it("when nothing fits, the smallest plan of those with the best coverage is proposed, not the smallest overall", async () => {
    const chosen = await choosePackingPlan(3, 5, plans([{ pieces: 10, covered: 4 }, { pieces: 6, covered: 2 }, { pieces: 9, covered: 4 }]));
    expect(chosen).toEqual({ plan: { pieces: 9, covered: 4 }, level: -1 });
  });
  it("a first plan that fits is proposed without retrying", async () => {
    let calls = 0;
    const chosen = await choosePackingPlan(4, 9, async () => (calls++, { pieces: 9, covered: 4 }));
    expect(chosen.level).toBe(0);
    expect(calls).toBe(1);
  });
});
