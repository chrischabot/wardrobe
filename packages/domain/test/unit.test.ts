import { describe, expect, it } from "vitest";
import { addDays, canonicalJson, cycleCutoffMs, dueCycleKeys, endOfLocalDateMs, isoWeekday, localDateOf, ownedUnits, replayGarment, toBalances, toInstant, zonedToUtcMs, type StockEvent, type StockEventKind } from "../src/index.ts";

describe("civil time", () => {
  it("derives the local wearing date from the timezone, including across midnight and DST changes", () => {
    expect(localDateOf(Date.parse("2026-09-14T23:30:00Z"), "Europe/London")).toBe("2026-09-15"); // BST
    expect(localDateOf(Date.parse("2026-12-14T23:30:00Z"), "Europe/London")).toBe("2026-12-14"); // GMT
    expect(localDateOf(Date.parse("2026-09-15T03:00:00Z"), "America/New_York")).toBe("2026-09-14");
    expect(toInstant(zonedToUtcMs("2026-09-15", "07:00", "Europe/London"))).toBe("2026-09-15T06:00:00Z");
    expect(toInstant(zonedToUtcMs("2026-12-15", "07:00", "Europe/London"))).toBe("2026-12-15T07:00:00Z");
    // Civil days around the clock changes are 23 and 25 hours long; neither invents nor loses a wearing date.
    const springForward = endOfLocalDateMs("2026-03-29", "Europe/London") - zonedToUtcMs("2026-03-29", "00:00", "Europe/London");
    const fallBack = endOfLocalDateMs("2026-10-25", "Europe/London") - zonedToUtcMs("2026-10-25", "00:00", "Europe/London");
    expect([springForward / 3_600_000, fallBack / 3_600_000]).toEqual([23, 25]);
    expect(addDays("2026-10-25", 1)).toBe("2026-10-26");
    expect([isoWeekday("2026-09-18"), isoWeekday("2026-09-20")]).toEqual([5, 7]);
  });

  it("computes due laundry cycles once each and the Friday cutoff for a Sunday baseline", () => {
    expect(dueCycleKeys("2026-09-22", 7, null)).toEqual(["2026-09-20"]); // first ever run: only the latest baseline
    expect(dueCycleKeys("2026-09-20", 7, "2026-09-20")).toEqual([]);
    expect(dueCycleKeys("2026-10-06", 7, "2026-09-20")).toEqual(["2026-09-27", "2026-10-04"]);
    expect(dueCycleKeys("2027-03-01", 7, "2026-09-20")).toHaveLength(8); // catch-up is bounded
    expect(toInstant(cycleCutoffMs("2026-09-20", 5, "08:00", "Europe/London"))).toBe("2026-09-18T07:00:00Z");
  });

  it("canonical JSON is independent of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe(canonicalJson({ a: { d: [2, { y: 2, z: 1 }] }, b: 1 }));
  });
});

describe("stock replay (pure)", () => {
  let seq = 0;
  const ev = (kind: StockEventKind, at: string, payload: Record<string, unknown> = {}, extra: Partial<StockEvent> = {}): StockEvent => ({
    eventId: `e${++seq}`, seq, garmentId: "g", kind, payload, basis: "observed", occurredAtMs: Date.parse(at), voided: false, ...extra,
  });

  it("orders by when things happened, not by when they were reported", () => {
    const wash = ev("wash", "2026-09-15T09:00:00Z");
    const lateWear = ev("wear", "2026-09-14T11:00:00Z", { wearingDate: "2026-09-14", dirtyAtMs: Date.parse("2026-09-14T23:00:00Z") });
    const result = replayGarment("service", [ev("receive", "2026-09-01T00:00:00Z", { quantity: 1, to: "clean" }), wash, lateWear]);
    expect(toBalances(result.state)).toEqual([{ bucket: "clean", ref: "", quantity: 1, held: false }]);
  });

  it("a voided event is skipped and everything after it is recomputed", () => {
    const receive = ev("receive", "2026-09-01T00:00:00Z", { quantity: 2, to: "clean" });
    const dirty = ev("mark_dirty", "2026-09-02T00:00:00Z", { quantity: 2 });
    const pickup = ev("pickup", "2026-09-03T00:00:00Z", { batchId: "b1", quantity: 2 });
    expect(toBalances(replayGarment("service", [receive, dirty, pickup]).state)).toEqual([{ bucket: "service", ref: "b1", quantity: 2, held: false }]);
    expect(toBalances(replayGarment("service", [receive, { ...dirty, voided: true }, pickup]).state)).toEqual([{ bucket: "clean", ref: "", quantity: 2, held: false }]);
  });

  it("never produces a negative or fictional quantity under arbitrary event sequences", () => {
    // Deterministic pseudo-random sequences (LCG) over every event kind that moves stock.
    let state = 20260915;
    const rand = (n: number) => ((state = (state * 1103515245 + 12345) & 0x7fffffff) % n);
    const kinds: StockEventKind[] = ["wear", "extra_unit", "mark_dirty", "wash", "pickup", "return", "exception", "weekly_reset", "move", "pack", "unpack", "retire", "reconcile", "arrive"];
    for (let run = 0; run < 300; run++) {
      const start = 1 + rand(4);
      const events: StockEvent[] = [ev("receive", "2026-09-01T00:00:00Z", { quantity: start, to: rand(4) === 0 ? "incoming" : "clean" })];
      let created = start;
      for (let i = 0; i < 25; i++) {
        const kind = kinds[rand(kinds.length)]!;
        const at = toInstant(Date.parse("2026-09-01T00:00:00Z") + rand(30 * 24) * 3_600_000);
        const q = 1 + rand(3);
        const payload: Record<string, unknown> =
          kind === "pickup" || kind === "return" ? { batchId: `b${rand(2)}`, quantity: q, stillAway: rand(2) }
          : kind === "exception" ? { exceptionId: `x${rand(2)}`, quantity: q }
          : kind === "weekly_reset" ? { channel: "service", cycleKey: `2026-09-${String(6 + 7 * rand(4)).padStart(2, "0")}`, cutoffAtMs: Date.parse(at) - 86_400_000 }
          : kind === "move" ? { to: ["clean", "storage", "tailor"][rand(3)], quantity: q }
          : kind === "pack" || kind === "unpack" ? { tripId: "t", quantity: q }
          : kind === "reconcile" ? { counts: { clean: rand(4) } }
          : kind === "retire" ? { quantity: 1 }
          : kind === "wear" ? { wearingDate: at.slice(0, 10), dirtyAtMs: Date.parse(at) + 3_600_000 }
          : { quantity: q };
        events.push(ev(kind, at, payload, kind === "weekly_reset" ? { garmentId: null, basis: "inferred" } : {}));
      }
      const result = replayGarment(rand(3) === 0 ? "none" : "service", events);
      const rows = toBalances(result.state);
      expect(rows.every((r) => Number.isInteger(r.quantity) && r.quantity > 0)).toBe(true);
      // Units are only ever created by a receive or an explicit owner count correction.
      for (const m of result.movements) if (m.from === null && m.to !== null && m.kind === "reconcile") created += m.quantity;
      const total = ownedUnits(result.state) + result.state.incoming + result.state.gone;
      expect(total).toBeLessThanOrEqual(created);
      expect(result.state.dirty.length).toBeGreaterThanOrEqual(0);
    }
  });
});
