/**
 * Regression test for the seeded MCP simulation's trip-day failure (seeds 1, 2 and 5: "No complete outfit is
 * available for this day: 0 eligible trousers" on the last day of a three-day trip). Real command service and
 * real local D1, with a SYNTHETIC labelled owner and pieces, never the owner's stock.
 *
 * Stand-ins, at the adapter boundary and labelled: FakeWeatherProvider (synthetic destination forecasts).
 */
import { describe, expect, it } from "vitest";
import type { BoardDocument } from "@garderobe/contracts/ext/daily";
import { prepareTripDayBoard, proposePacking } from "../src/index.ts";
import { createDailyHarness } from "./helpers.ts";

const PARIS = { label: "Paris", latitude: 48.8534, longitude: 2.3488, timezone: "Europe/Paris", from: "2026-09-24", to: "2026-09-26" };
const PARIS_DAY = { temperatureByHour: { 0: 11, 8: 13, 14: 20, 19: 17, 23: 13 } };
const DAYS = ["2026-09-24", "2026-09-25", "2026-09-26"] as const;
const WARDROBE = [
  { id: "shirt-a", name: "synthetic blue oxford", colour: "Blue", category: "shirt", roles: ["top"], careChannel: "service" },
  { id: "shirt-b", name: "synthetic white oxford", colour: "White", category: "shirt", roles: ["top"], careChannel: "service" },
  { id: "shirt-c", name: "synthetic moss oxford", colour: "Moss", category: "shirt", roles: ["top"], careChannel: "service" },
  { id: "trouser-a", name: "synthetic beige chinos", colour: "Beige", category: "trousers", roles: ["bottom"], careChannel: "service" },
  { id: "trouser-b", name: "synthetic grey flannels", colour: "Grey", category: "trousers", roles: ["bottom"], careChannel: "service" },
  { id: "sock-a", name: "synthetic navy socks", colour: "Navy", category: "socks", roles: ["socks"], careChannel: "handwash", quantity: 3 },
  { id: "shoe", name: "synthetic sneakers", colour: "Grey", category: "footwear", roles: ["footwear"], careChannel: "none", attributes: { footwearKind: "sneaker" } },
];
const piece = (o: BoardDocument["options"][number], role: string) => o.garments.find((g) => g.role === role)?.garmentId;

describe("the days a proposal plans a reusable piece are a budget for the trip, not fixed dates", () => {
  it("SYNTHETIC: trousers worn in a different order from the proposal still dress the last day of the trip", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-21T18:00:00Z", isolate: true });
    const owner = await h.createSyntheticOwner({ settings: { homeLocation: { label: "London", latitude: 51.5085, longitude: -0.1257 } } as never, garments: WARDROBE as never });
    for (const d of DAYS) h.weather.setForecast(d, PARIS_DAY);
    const tripId = "synthetic-order";
    await owner.exec("trip.create", { tripId, name: "Synthetic three days", departsOn: DAYS[0], returnsOn: DAYS[2], destinations: [PARIS], source: { kind: "owner_statement", note: "synthetic trip for a boundary test" } });
    const proposal = await proposePacking(h.deps, owner.principal(), { tripId, clientRequestId: "order-1", nowMs: h.clock.now() });
    const bottoms = proposal.days.map((d) => d.slots.find((s) => s.role === "bottom")!.garmentId);
    // The proposal reuses one pair for two days and plans the other pair once.
    const twice = bottoms.find((id) => bottoms.filter((b) => b === id).length === 2)!;
    const once = bottoms.find((id) => id !== twice)!;
    expect(twice, `the proposal plans one pair twice: ${bottoms.join(", ")}`).toBeTruthy();
    expect(once).toBeTruthy();
    await owner.exec("stock.pack", { tripId, items: proposal.items.map((i) => ({ garmentId: i.garmentId, quantity: i.quantity })) });

    // He wears the pair planned once on day one, and the pair planned twice on day two (the order the
    // simulation's owner chose from the trip-day boards).
    const wear = async (index: number, bottom: string) => {
      h.clock.set(`${DAYS[index]}T08:00:00Z`);
      const slots = proposal.days[index]!.slots.map((s) => (s.role === "bottom" ? { ...s, garmentId: bottom } : s));
      await owner.exec("wear.record", { wearingDate: DAYS[index], tripId, garmentIds: slots.map((s) => s.garmentId) });
    };
    await wear(0, once);
    await wear(1, twice);

    h.clock.set(`${DAYS[2]}T06:00:00Z`);
    const day3 = await prepareTripDayBoard(h.deps, owner.principal(), { tripId, date: DAYS[2], clientRequestId: "order-board", nowMs: h.clock.now() });
    expect(day3.note ?? "").not.toMatch(/0 eligible trousers/);
    const options = day3.board?.options ?? [];
    expect(options.length).toBeGreaterThan(0);
    // The pair planned twice and worn once has a day of its budget left; the pair planned once and worn has none.
    expect(new Set(options.map((o) => piece(o, "bottom")))).toEqual(new Set([twice]));
  });
});
