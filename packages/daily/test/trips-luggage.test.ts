/**
 * A packing proposal fits the trip's luggage limit (specification section 10).
 *
 * Real command service and real local D1; FakeWeatherProvider at the weather port. The wardrobe is labelled
 * synthetic so the piece counts are known exactly: four shirts, three trousers, one pair of shoes and four
 * pairs of socks for a four-day trip.
 */
import { describe, expect, it } from "vitest";
import { proposePacking } from "../src/index.ts";
import { createDailyHarness, MILD_DAY } from "./helpers.ts";

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
});
