import { describe, expect, it } from "vitest";
import { all, getAvailability, getGarmentDetail, getLaundryState } from "../src/index.ts";
import { createHarness } from "../src/testing/index.ts";
import { balances, countedWears, SCHEDULED, wearOn } from "./helpers.ts";

// September 2026: Mon 14, Tue 15, Wed 16, Thu 17, Fri 18 (collection), Sat 19 (return), Sun 20 (baseline).

describe("service laundry: pickup membership, returns and exceptions", () => {
  it("pickup snapshots what is awaiting care; a shirt worn after pickup stays behind; return completes only the batch", async () => {
    const h = await createHarness({ startAt: "2026-09-14T09:00:00Z" });
    const owner = await h.createSyntheticOwner();
    await wearOn(h, owner, "2026-09-14", ["shirt-moss", "trouser-olive", "sock-navy"]);
    await wearOn(h, owner, "2026-09-15", ["shirt-gold", "trouser-beige", "sock-grey"]);
    h.clock.set("2026-09-15T12:00:00Z");
    const pickup = await owner.exec("laundry.collect", {});
    // Monday's shirt and trousers go; today's are still being worn; socks are hand-wash and never enter the batch.
    expect((pickup.result.members as { garmentId: string }[]).map((m) => m.garmentId).sort()).toEqual(["shirt-moss", "trouser-olive"]);
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ dirty: 1, service: 0 });
    expect(await balances(h, owner, "sock-navy")).toMatchObject({ dirty: 1, service: 0 });

    await wearOn(h, owner, "2026-09-16", ["shirt-slate"]);
    h.clock.set("2026-09-17T10:00:00Z");
    const back = await owner.exec("laundry.return", { stillAway: [{ garmentId: "trouser-olive" }] });
    expect(back.result).toMatchObject({ returned: 1, stillAway: 1 });
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 1, service: 0 });
    expect(await balances(h, owner, "trouser-olive")).toMatchObject({ clean: 0, service: 1 });
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ dirty: 1 }); // not part of the returning batch
    expect(await balances(h, owner, "shirt-slate")).toMatchObject({ dirty: 1 });

    const sheet = await getLaundryState(h.db, owner.principal());
    expect(sheet.batches[0]).toMatchObject({ status: "partially_returned", returnBasis: "observed" });
    expect(sheet.exceptions.map((e) => [e.kind, e.garmentId])).toEqual([["still_away", "trouser-olive"]]);
    expect(sheet.awaitingService.map((g) => g.garmentId).sort()).toEqual(["shirt-gold", "shirt-slate", "trouser-beige"]);
    expect(sheet.awaitingHandwash.map((g) => g.garmentId).sort()).toEqual(["sock-grey", "sock-navy"]);

    // The still-away trousers stay out through the weekly baseline until the owner says they are back.
    h.clock.set("2026-09-20T06:00:00Z");
    await owner.exec("laundry.apply_weekly_reset", {}, SCHEDULED);
    expect(await balances(h, owner, "trouser-olive")).toMatchObject({ clean: 0, service: 1 });
    await owner.exec("care.washed", { items: [{ garmentId: "trouser-olive" }] });
    expect(await balances(h, owner, "trouser-olive")).toMatchObject({ clean: 1, service: 0 });
    expect((await getLaundryState(h.db, owner.principal())).exceptions).toHaveLength(0);
  });

  it("naming a still-away item that was not in the batch fails the whole return", async () => {
    const h = await createHarness({ startAt: "2026-09-14T09:00:00Z" });
    const owner = await h.createSyntheticOwner();
    await wearOn(h, owner, "2026-09-14", ["shirt-moss"]);
    h.clock.set("2026-09-15T12:00:00Z");
    await owner.exec("laundry.collect", {});
    const err = await owner.exec("laundry.return", { stillAway: [{ garmentId: "shirt-gold" }] }).catch((e) => e);
    expect(err.code).toBe("precondition_failed");
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ service: 1, clean: 0 });
  });

  it("'Socks washed' clears the hand-wash pool only; 'Returned' with no recorded pickup is accepted as fact", async () => {
    const h = await createHarness({ startAt: "2026-09-14T09:00:00Z" });
    const owner = await h.createSyntheticOwner();
    await wearOn(h, owner, "2026-09-14", ["shirt-moss", "sock-navy", "sock-grey"]);
    h.clock.set("2026-09-15T09:00:00Z");
    const socks = await owner.exec("care.washed", { allOfChannel: "handwash" });
    expect((socks.result.washed as string[]).sort()).toEqual(["sock-grey", "sock-navy"]);
    expect((await balances(h, owner, "sock-navy")).clean).toBe(2);
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ dirty: 1 }); // the service pool is untouched
    const returned = await owner.exec("laundry.return", {});
    expect(returned.summary).toContain("no pickup had been recorded");
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 1, dirty: 0 });
    expect(await all(h.db, "SELECT 1 FROM laundry_batches WHERE user_id = ?", owner.userId)).toHaveLength(0);
  });

  it("an aggregate count correction is recorded without per-pair identity and never goes negative", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    await owner.exec("care.mark_dirty", { items: [{ garmentId: "sock-grey", quantity: 3 }] });
    const fix = await owner.exec("stock.reconcile", { garmentId: "sock-grey", counts: { clean: 2 } });
    expect(fix.result).toMatchObject({ clean: 2, dirty: 1, owned: 3 });
    const more = await owner.exec("stock.reconcile", { garmentId: "sock-grey", counts: { clean: 5 } });
    expect(more.result).toMatchObject({ clean: 5, dirty: 0, owned: 5 }); // "five pairs are clean": the owner's count stands
    await owner.exec("care.mark_dirty", { items: [{ garmentId: "sock-grey", quantity: 40 }] });
    const b = await balances(h, owner, "sock-grey");
    expect(b).toMatchObject({ clean: 0, dirty: 5 });
    const undo = await owner.exec("command.undo", { commandId: more.commandId });
    expect(undo.outcome).toBe("committed");
    expect((await getGarmentDetail(h.db, owner.principal(), "sock-grey")).totalOwnedUnits).toBe(3);
  });
});

describe("weekly laundry baseline (inferred reset) and its exceptions", () => {
  async function weekOfWear() {
    const h = await createHarness({ startAt: "2026-09-14T09:00:00Z" });
    const owner = await h.createSyntheticOwner();
    await owner.exec("garment.move", { garmentId: "shirt-blue-stripe-a", to: "tailor" });
    await wearOn(h, owner, "2026-09-14", ["shirt-moss", "trouser-olive", "sock-navy"]);
    await wearOn(h, owner, "2026-09-15", ["shirt-gold", "trouser-beige", "sock-grey"]);
    await wearOn(h, owner, "2026-09-17", ["shirt-slate", "trouser-navy"]);
    await wearOn(h, owner, "2026-09-18", ["shirt-red-stripe"]); // Friday: worn on collection day, not collected
    return { h, owner };
  }

  it("resets routine cleanliness once per cycle without fabricating an observed pickup or return", async () => {
    const { h, owner } = await weekOfWear();
    h.clock.set("2026-09-20T06:30:00Z");
    const reset = await owner.exec("laundry.apply_weekly_reset", {}, SCHEDULED);
    expect(reset.result.cyclesApplied).toEqual([{ channel: "service", cycleKey: "2026-09-20" }]);
    expect(reset.result.observedReturnsRecorded).toBe(0);

    for (const id of ["shirt-moss", "shirt-gold", "shirt-slate", "trouser-olive", "trouser-beige"]) {
      expect(await balances(h, owner, id), id).toMatchObject({ clean: 1, dirty: 0 });
    }
    expect(await balances(h, owner, "trouser-navy")).toMatchObject({ clean: 2, dirty: 0 });
    // Worn after the collection cutoff: still awaiting care.
    expect(await balances(h, owner, "shirt-red-stripe")).toMatchObject({ clean: 0, dirty: 1 });
    // Hand-wash socks have their own cycle and are untouched by the service reset.
    expect(await balances(h, owner, "sock-navy")).toMatchObject({ clean: 1, dirty: 1 });
    expect(await balances(h, owner, "sock-grey")).toMatchObject({ clean: 2, dirty: 1 });
    // A scheduled assumption cannot release a garment from the tailor.
    expect(await balances(h, owner, "shirt-blue-stripe-a")).toMatchObject({ clean: 0, tailor: 1 });

    // Inferred and observed stay distinct: the movement is journaled as inferred, no batch or return exists.
    const detail = await getGarmentDetail(h.db, owner.principal(), "shirt-moss");
    const last = detail.movements.at(-1)!;
    expect(last).toMatchObject({ kind: "weekly_reset", from: "dirty", to: "clean", basis: "inferred" });
    expect(await all(h.db, "SELECT 1 FROM laundry_batches WHERE user_id = ?", owner.userId)).toHaveLength(0);
    // Actual wear history and the seven-day repeat record survive the reset.
    expect((await countedWears(h, owner, "shirt-moss")).map((w) => w.wearing_date)).toEqual(["2026-09-14"]);

    // Applied once per owner and cycle, however often the sweep runs.
    h.clock.advanceMinutes(5);
    const again = await owner.exec("laundry.apply_weekly_reset", {}, SCHEDULED);
    expect(again.outcome).toBe("noop");
    const [a, b] = await Promise.all([owner.exec("laundry.apply_weekly_reset", {}, SCHEDULED), owner.exec("laundry.apply_weekly_reset", {}, SCHEDULED)]);
    expect([a.outcome, b.outcome]).toEqual(["noop", "noop"]);
    expect(await all(h.db, "SELECT 1 FROM laundry_cycles WHERE user_id = ?", owner.userId)).toHaveLength(1);
  });

  it("after missed runs, each elapsed cycle is applied exactly once and later wear is still respected", async () => {
    const { h, owner } = await weekOfWear();
    h.clock.set("2026-09-20T06:30:00Z");
    await owner.exec("laundry.apply_weekly_reset", {}, SCHEDULED);
    await wearOn(h, owner, "2026-09-22", ["shirt-moss"]);
    await wearOn(h, owner, "2026-10-02", ["shirt-gold"]); // Friday of the third week
    h.clock.set("2026-10-05T07:00:00Z"); // the sweep was down for two Sundays
    const reset = await owner.exec("laundry.apply_weekly_reset", {}, SCHEDULED);
    expect((reset.result.cyclesApplied as { cycleKey: string }[]).map((c) => c.cycleKey)).toEqual(["2026-09-27", "2026-10-04"]);
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 1, dirty: 0 });
    expect(await balances(h, owner, "shirt-red-stripe")).toMatchObject({ clean: 1, dirty: 0 }); // cleared by the following cycle
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ clean: 0, dirty: 1 }); // worn on the last collection day
    expect(await all(h.db, "SELECT 1 FROM laundry_cycles WHERE user_id = ?", owner.userId)).toHaveLength(3);
  });

  it("a reported missed return overrides that cycle's baseline; the next cycle clears it", async () => {
    const { h, owner } = await weekOfWear();
    h.clock.set("2026-09-20T06:30:00Z");
    await owner.exec("laundry.apply_weekly_reset", {}, SCHEDULED);
    expect((await balances(h, owner, "shirt-moss")).clean).toBe(1);
    h.clock.set("2026-09-21T08:00:00Z");
    const exception = await owner.exec("laundry.report_exception", { kind: "missed_return" });
    expect(exception.result.cycleKey).toBe("2026-09-20");
    // What the baseline had assumed returned is away again; nothing is claimed clean.
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 0, service: 1 });
    expect(await balances(h, owner, "trouser-navy")).toMatchObject({ clean: 1, service: 1 });
    const snapshot = await getAvailability(h.db, owner.principal(), { forDate: "2026-09-22", nowMs: h.clock.now() });
    const moss = snapshot.garments.find((g) => g.garmentId === "shirt-moss")!;
    expect(moss.hardExcluded).toBe(true);
    expect(moss.reasons).toContain("laundry_exception");

    h.clock.set("2026-09-27T06:30:00Z");
    await owner.exec("laundry.apply_weekly_reset", {}, SCHEDULED);
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 1, service: 0 });

    // Undoing the mistaken exception report restores the ordinary baseline for that week.
    const { h: h2, owner: o2 } = await weekOfWear();
    h2.clock.set("2026-09-20T06:30:00Z");
    await o2.exec("laundry.apply_weekly_reset", {}, SCHEDULED);
    const ex2 = await o2.exec("laundry.report_exception", { kind: "delayed" });
    await o2.exec("command.undo", { commandId: ex2.commandId });
    expect(await balances(h2, o2, "shirt-moss")).toMatchObject({ clean: 1, service: 0 });
  });

  it("an item reported still away after the cycle stays out until the owner reports it back", async () => {
    const { h, owner } = await weekOfWear();
    h.clock.set("2026-09-20T06:30:00Z");
    await owner.exec("laundry.apply_weekly_reset", {}, SCHEDULED);
    h.clock.set("2026-09-21T08:00:00Z");
    await owner.exec("laundry.report_exception", { kind: "still_away", garmentId: "shirt-gold" });
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ clean: 0, service: 1 });
    h.clock.set("2026-09-27T06:30:00Z");
    await owner.exec("laundry.apply_weekly_reset", {}, SCHEDULED);
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ clean: 0, service: 1 }); // the exception is retained
    await owner.exec("care.washed", { items: [{ garmentId: "shirt-gold" }] });
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ clean: 1, service: 0 });
  });

  it("a dirty observation after the cycle overrides the baseline", async () => {
    const { h, owner } = await weekOfWear();
    h.clock.set("2026-09-20T06:30:00Z");
    await owner.exec("laundry.apply_weekly_reset", {}, SCHEDULED);
    h.clock.set("2026-09-20T12:00:00Z");
    await owner.exec("care.mark_dirty", { items: [{ garmentId: "shirt-moss" }] });
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 0, dirty: 1 });
  });

  it("an observed pickup with no reported return is inferred returned by the baseline, labelled as inferred", async () => {
    const h = await createHarness({ startAt: "2026-09-14T09:00:00Z" });
    const owner = await h.createSyntheticOwner();
    await wearOn(h, owner, "2026-09-14", ["shirt-moss"]);
    h.clock.set("2026-09-18T08:30:00Z");
    await owner.exec("laundry.collect", {});
    h.clock.set("2026-09-20T06:30:00Z");
    await owner.exec("laundry.apply_weekly_reset", {}, SCHEDULED);
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 1, service: 0 });
    const batch = (await getLaundryState(h.db, owner.principal())).batches[0]!;
    expect(batch).toMatchObject({ status: "inferred_returned", returnBasis: "inferred" });
  });

  it("the weekly reset is a standing policy: the assistant cannot trigger it by statement, and it has no undo", async () => {
    const { h, owner } = await weekOfWear();
    h.clock.set("2026-09-20T06:30:00Z");
    const err = await owner.exec("laundry.apply_weekly_reset", {}, { actor: "assistant", channel: "conversation", authorization: "owner_statement" }).catch((e) => e);
    expect(err.code).toBe("forbidden");
    const reset = await owner.exec("laundry.apply_weekly_reset", {}, SCHEDULED);
    expect(reset.undo.available).toBe(false);
  });
});

describe("trip packing primitives", () => {
  it("packed units leave home stock; a home laundry reset does not wash the suitcase; unpacking does not assert clean", async () => {
    const h = await createHarness({ startAt: "2026-09-16T09:00:00Z" });
    const owner = await h.createSyntheticOwner();
    await owner.exec("stock.pack", { tripId: "trip-paris", items: [{ garmentId: "shirt-moss" }, { garmentId: "trouser-navy", quantity: 1 }, { garmentId: "shoe-navy" }] });
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 0, trip: 1 });
    expect(await balances(h, owner, "trouser-navy")).toMatchObject({ clean: 1, trip: 1 });
    h.clock.set("2026-09-17T09:00:00Z");
    await owner.exec("wear.record", { wearingDate: "2026-09-17", garmentIds: ["shirt-moss"], tripId: "trip-paris" });
    h.clock.set("2026-09-20T06:30:00Z");
    await owner.exec("laundry.apply_weekly_reset", {}, SCHEDULED);
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 0, trip: 1 }); // still in the suitcase, still worn
    h.clock.set("2026-09-21T18:00:00Z");
    await owner.exec("stock.unpack", { tripId: "trip-paris" });
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 0, dirty: 1, trip: 0 });
    expect(await balances(h, owner, "trouser-navy")).toMatchObject({ clean: 1, dirty: 1, trip: 0 }); // unpacked, not declared clean
    expect(await balances(h, owner, "shoe-navy")).toMatchObject({ clean: 1, trip: 0 });
  });
});
