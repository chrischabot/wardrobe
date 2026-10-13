/**
 * Observed clean units and planned stock are different numbers (specification section 5).
 *
 * Real command service and real local D1; FakeWeatherProvider at the weather port. The wardrobe is labelled
 * synthetic (a boundary condition the owner's stock does not isolate): three pairs of one sock, worn, then
 * counted clean only by the weekly laundry baseline.
 */
import { describe, expect, it } from "vitest";
import { assembleContext } from "../src/context.ts";
import { proposePacking } from "../src/index.ts";
import { createDailyHarness, MILD_DAY, SCHEDULED } from "./helpers.ts";

const WARDROBE = [
  { id: "shirt-a", name: "synthetic blue oxford", colour: "Blue", category: "shirt", roles: ["top"], careChannel: "service" },
  { id: "shirt-b", name: "synthetic white oxford", colour: "White", category: "shirt", roles: ["top"], careChannel: "service" },
  { id: "shirt-c", name: "synthetic moss oxford", colour: "Moss", category: "shirt", roles: ["top"], careChannel: "service" },
  { id: "trouser-a", name: "synthetic beige chinos", colour: "Beige", category: "trousers", roles: ["bottom"], careChannel: "service" },
  { id: "trouser-b", name: "synthetic olive fatigues", colour: "Olive", category: "trousers", roles: ["bottom"], careChannel: "service" },
  { id: "trouser-c", name: "synthetic navy chinos", colour: "Navy", category: "trousers", roles: ["bottom"], careChannel: "service" },
  { id: "sock-a", name: "synthetic navy socks", colour: "Navy", category: "socks", roles: ["socks"], careChannel: "service", quantity: 3 },
  { id: "shoe", name: "synthetic sneakers", colour: "Grey", category: "footwear", roles: ["footwear"], careChannel: "none", attributes: { footwearKind: "sneaker" } },
];

describe("units counted clean only by the weekly laundry baseline", () => {
  it("SYNTHETIC: are not reported as observed, and are still packed: three such pairs cover a three-day trip", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-16T20:00:00Z", isolate: true });
    const owner = await h.createSyntheticOwner({ settings: { homeLocation: { label: "London", latitude: 51.5085, longitude: -0.1257 } } as never, garments: WARDROBE as never });
    for (const d of ["2026-09-14", "2026-09-15", "2026-09-16"]) await owner.exec("wear.record", { wearingDate: d, garmentIds: ["sock-a"] });
    h.clock.set("2026-09-20T06:30:00Z");
    await owner.exec("laundry.apply_weekly_reset", {}, SCHEDULED);
    h.clock.set("2026-09-21T18:00:00Z");
    const sock = (await assembleContext(h.db, owner.principal(), { localDate: "2026-09-24", nowMs: h.clock.now() })).garments.get("sock-a")!;
    expect(sock.availability.cleanObserved, "inferred units are not observed").toBe(0);
    expect(sock.availability.balances.find((b) => b.bucket === "clean")?.quantity, "they are still clean stock").toBe(3);

    const PARIS = { label: "Paris", latitude: 48.8534, longitude: 2.3488, timezone: "Europe/Paris", from: "2026-09-24", to: "2026-09-26" };
    for (const d of ["2026-09-24", "2026-09-25", "2026-09-26"]) h.weather.setForecast(d, MILD_DAY);
    await owner.exec("trip.create", { tripId: "inferred-socks", name: "Synthetic three days", departsOn: "2026-09-24", returnsOn: "2026-09-26", destinations: [PARIS], source: { kind: "owner_statement", note: "synthetic trip for a boundary test" } });
    const proposal = await proposePacking(h.deps, owner.principal(), { tripId: "inferred-socks", clientRequestId: "inferred-socks", nowMs: h.clock.now() });
    expect(proposal.days.map((d) => d.slots.find((s) => s.role === "socks")?.garmentId ?? null)).toEqual(["sock-a", "sock-a", "sock-a"]);
    expect(proposal.items.find((i) => i.garmentId === "sock-a")!.quantity).toBe(3);
    expect(proposal.notes.join(" ")).not.toMatch(/socks/);
  });
});
