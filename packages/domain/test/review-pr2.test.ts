/**
 * Regressions for the change review of pull request 2 (findings 1-6 and 10) and the two limits that
 * pull request reported. Real command service, local D1, labelled synthetic owners only.
 * September 2026: Mon 14 ... Fri 18 (collection), Sat 19 (return), Sun 20 (baseline), Sun 27 (next baseline).
 */
import { describe, expect, it } from "vitest";
import { all, first, getLaundryState } from "../src/index.ts";
import { createHarness, type Harness, type TestOwner } from "../src/testing/index.ts";
import { balances, SCHEDULED, wearOn } from "./helpers.ts";

async function start(): Promise<{ h: Harness; owner: TestOwner }> {
  const h = await createHarness({ startAt: "2026-09-14T09:00:00Z" });
  return { h, owner: await h.createSyntheticOwner() };
}

async function baseline(h: Harness, owner: TestOwner, at = "2026-09-20T06:30:00Z") {
  h.clock.set(at);
  return owner.exec("laundry.apply_weekly_reset", {}, SCHEDULED);
}

const exceptionRows = (h: Harness, owner: TestOwner) =>
  all<{ kind: string; status: string; resolution: string | null; quantity: number; garment_id: string | null; cycle_key: string | null }>(
    h.db,
    "SELECT kind, status, resolution, quantity, garment_id, cycle_key FROM laundry_exceptions WHERE user_id = ? ORDER BY rowid",
    owner.userId,
  );
const open = async (h: Harness, owner: TestOwner) => (await getLaundryState(h.db, owner.principal())).exceptions.map((e) => e.kind);
const batchRows = (h: Harness, owner: TestOwner) =>
  all<{ batch_id: string; status: string; returned_at: string | null; return_basis: string | null; withdrawn_at: string | null }>(
    h.db,
    "SELECT batch_id, status, returned_at, return_basis, withdrawn_at FROM laundry_batches WHERE user_id = ? ORDER BY rowid",
    owner.userId,
  );

describe("finding 1: an exception is settled only by a unit that actually moved", () => {
  it("an exception with nothing held under it is not resolved by a wash report about the garment", async () => {
    const { h, owner } = await start();
    await wearOn(h, owner, "2026-09-14", ["shirt-gold"]);
    await baseline(h, owner);
    h.clock.set("2026-09-21T08:00:00Z");
    await owner.exec("laundry.report_exception", { kind: "still_away", garmentId: "shirt-gold" });
    // The owner hands it straight to the tailor: the unit leaves the exception's holding without any wash.
    await owner.exec("garment.move", { garmentId: "shirt-gold", to: "tailor" });
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ service: 0, tailor: 1 });

    const counted = await owner.exec("care.washed", { items: [{ garmentId: "shirt-gold", quantity: 1 }] });
    const uncounted = await owner.exec("care.washed", { items: [{ garmentId: "shirt-gold" }] });
    expect(counted.result.exceptionsSettled).toEqual([]);
    expect(uncounted.result.exceptionsSettled).toEqual([]);
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ clean: 0, tailor: 1 });
    expect((await exceptionRows(h, owner)).map((x) => [x.kind, x.status])).toEqual([["still_away", "active"]]);
  });

  it("a wear of the unit that was held away settles its exception as 'with the owner', and undoing the wear reopens it", async () => {
    const { h, owner } = await start();
    await wearOn(h, owner, "2026-09-14", ["shirt-gold"]);
    await baseline(h, owner);
    h.clock.set("2026-09-21T08:00:00Z");
    await owner.exec("laundry.report_exception", { kind: "still_away", garmentId: "shirt-gold" });
    const worn = await wearOn(h, owner, "2026-09-22", ["shirt-gold"]);
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ dirty: 1, service: 0 });
    expect((await exceptionRows(h, owner)).map((x) => [x.status, x.resolution])).toEqual([["resolved", "with_owner"]]);
    await owner.exec("command.undo", { commandId: worn.commandId });
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ dirty: 0, service: 1 });
    expect((await exceptionRows(h, owner)).map((x) => [x.status, x.resolution])).toEqual([["active", null]]);
  });
});

describe("finding 2: a unit held as still away that is then reported lost", () => {
  async function stillAwayPair() {
    const { h, owner } = await start();
    await wearOn(h, owner, "2026-09-14", ["trouser-navy"]);
    await wearOn(h, owner, "2026-09-15", ["trouser-navy"]);
    h.clock.set("2026-09-18T08:30:00Z");
    await owner.exec("laundry.collect", {});
    h.clock.set("2026-09-19T17:00:00Z");
    await owner.exec("laundry.return", { stillAway: [{ garmentId: "trouser-navy", quantity: 1 }] });
    expect(await balances(h, owner, "trouser-navy")).toMatchObject({ clean: 1, service: 1 });
    h.clock.set("2026-09-21T08:00:00Z");
    return { h, owner };
  }

  it("is the unit that is lost, and 'washed' does not bring it back", async () => {
    const { h, owner } = await stillAwayPair();
    await owner.exec("laundry.report_exception", { kind: "lost", garmentId: "trouser-navy" });
    // The pair that was still away is the one that is lost: no clean pair at home is taken instead.
    expect(await balances(h, owner, "trouser-navy")).toMatchObject({ clean: 1, service: 1 });
    expect((await exceptionRows(h, owner)).map((x) => [x.kind, x.status, x.resolution])).toEqual([["still_away", "resolved", "reported_lost"], ["lost", "active", null]]);
    await owner.exec("care.washed", { items: [{ garmentId: "trouser-navy" }] });
    expect(await balances(h, owner, "trouser-navy")).toMatchObject({ clean: 1, service: 1 });
    expect(await open(h, owner)).toEqual(["lost"]);
    // The batch still says one pair has not come back.
    expect((await getLaundryState(h.db, owner.principal())).batches.map((b) => [b.status, b.items.map((i) => i.stillAway)])).toEqual([["partially_returned", [1]]]);
  });

  it("withdrawing the lost report restores the still-away exception, which 'washed' then settles together with its batch", async () => {
    const { h, owner } = await stillAwayPair();
    const lost = await owner.exec("laundry.report_exception", { kind: "lost", garmentId: "trouser-navy" });
    await owner.exec("command.undo", { commandId: lost.commandId });
    expect((await exceptionRows(h, owner)).map((x) => [x.kind, x.status, x.resolution])).toEqual([["still_away", "active", null], ["lost", "resolved", "withdrawn"]]);
    // Merely still away again, so "washed" (nothing is dirty at home) brings it back and closes the batch.
    h.clock.set("2026-09-22T17:00:00Z");
    await owner.exec("care.washed", { items: [{ garmentId: "trouser-navy" }] });
    expect(await balances(h, owner, "trouser-navy")).toMatchObject({ clean: 2, service: 0 });
    expect((await batchRows(h, owner)).map((b) => b.status)).toEqual(["returned"]);
  });
});

describe("finding 3: a withdrawn pickup is not an open batch for any reader", () => {
  it("a new pickup after an undone one is its own batch; the withdrawn record stays out of returns, the sheet and ID reuse", async () => {
    const { h, owner } = await start();
    await wearOn(h, owner, "2026-09-14", ["shirt-moss"]);
    h.clock.set("2026-09-18T08:30:00Z");
    const first1 = await owner.exec("laundry.collect", { batchId: "lb-synthetic-first" });
    await owner.exec("command.undo", { commandId: first1.commandId });
    // The ID stays taken by the withdrawn record: reusing it is a clean refusal, not an internal failure.
    const reuse = await owner.exec("laundry.collect", { batchId: "lb-synthetic-first" }).catch((e) => e);
    expect(reuse.code).toBe("precondition_failed");
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ dirty: 1, service: 0 });

    const second = await owner.exec("laundry.collect", {});
    expect(second.result.units).toBe(1);
    const sheet = await getLaundryState(h.db, owner.principal());
    expect(sheet.batches.map((b) => b.batchId)).toEqual([second.result.batchId]);
    h.clock.set("2026-09-19T17:00:00Z");
    const back = await owner.exec("laundry.return", {});
    expect(back.result).toMatchObject({ batchId: second.result.batchId, returned: 1 });
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 1, service: 0 });
    // The weekly baseline does not infer a return for the withdrawn pickup either.
    await baseline(h, owner);
    expect((await batchRows(h, owner)).map((b) => [b.batch_id === "lb-synthetic-first", b.status, b.returned_at === null, b.withdrawn_at !== null])).toEqual([
      [true, "collected", true, true],
      [false, "returned", false, false],
    ]);
    expect((await owner.exec("laundry.return", { batchId: "lb-synthetic-first" }).catch((e) => e)).code).toBe("not_found");
  });
});

describe("finding 4: undoing a wash report", () => {
  it("puts a batch it completed back exactly as it was, including when it was last partly returned", async () => {
    const { h, owner } = await start();
    await wearOn(h, owner, "2026-09-14", ["shirt-moss", "shirt-gold"]);
    h.clock.set("2026-09-18T08:30:00Z");
    await owner.exec("laundry.collect", {});
    h.clock.set("2026-09-19T17:00:00Z");
    await owner.exec("laundry.return", { stillAway: [{ garmentId: "shirt-gold" }] });
    h.clock.set("2026-09-22T17:00:00Z");
    const washed = await owner.exec("care.washed", { items: [{ garmentId: "shirt-gold" }] });
    expect((await batchRows(h, owner)).map((b) => [b.status, b.returned_at, b.return_basis])).toEqual([["returned", "2026-09-22T17:00:00Z", "observed"]]);

    await owner.exec("command.undo", { commandId: washed.commandId });
    expect((await batchRows(h, owner)).map((b) => [b.status, b.returned_at, b.return_basis])).toEqual([["partially_returned", "2026-09-19T17:00:00Z", "observed"]]);
    const sheet = await getLaundryState(h.db, owner.principal());
    expect(sheet.batches[0]!.items.map((i) => [i.garmentId, i.returnedQuantity, i.stillAway])).toEqual([["shirt-gold", 0, 1], ["shirt-moss", 1, 0]]);
    expect(sheet.exceptions.map((e) => [e.kind, e.garmentId])).toEqual([["still_away", "shirt-gold"]]);
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ clean: 0, service: 1 });
  });

  it("restores a partly reduced exception, and is refused once that exception has changed again", async () => {
    const { h, owner } = await start();
    await wearOn(h, owner, "2026-09-14", ["trouser-navy"]);
    await wearOn(h, owner, "2026-09-15", ["trouser-navy"]);
    await baseline(h, owner);
    h.clock.set("2026-09-21T08:00:00Z");
    await owner.exec("laundry.report_exception", { kind: "still_away", garmentId: "trouser-navy", quantity: 2 });
    expect(await balances(h, owner, "trouser-navy")).toMatchObject({ clean: 0, service: 2 });

    const one = await owner.exec("care.washed", { items: [{ garmentId: "trouser-navy", quantity: 1 }] });
    expect((await exceptionRows(h, owner)).map((x) => [x.status, x.quantity])).toEqual([["active", 1]]);
    await owner.exec("command.undo", { commandId: one.commandId });
    expect((await exceptionRows(h, owner)).map((x) => [x.status, x.quantity])).toEqual([["active", 2]]);
    expect(await balances(h, owner, "trouser-navy")).toMatchObject({ clean: 0, service: 2 });

    const again = await owner.exec("care.washed", { items: [{ garmentId: "trouser-navy", quantity: 1 }] });
    await owner.exec("care.washed", { items: [{ garmentId: "trouser-navy", quantity: 1 }] });
    expect((await exceptionRows(h, owner)).map((x) => [x.status, x.resolution])).toEqual([["resolved", "returned"]]);
    // The first report's undo would now overwrite what the second one settled: refused, nothing changes.
    expect((await owner.exec("command.undo", { commandId: again.commandId }).catch((e) => e)).code).toBe("precondition_failed");
    expect(await balances(h, owner, "trouser-navy")).toMatchObject({ clean: 2, service: 0 });
    expect((await exceptionRows(h, owner)).map((x) => x.status)).toEqual(["resolved"]);
  });
});

describe("finding 5: undoing 'the laundry is back' after a missed return", () => {
  async function missedWeek() {
    const { h, owner } = await start();
    await wearOn(h, owner, "2026-09-14", ["shirt-moss"]);
    await wearOn(h, owner, "2026-09-15", ["trouser-navy"]);
    await wearOn(h, owner, "2026-09-16", ["trouser-navy"]);
    await baseline(h, owner);
    h.clock.set("2026-09-21T08:00:00Z");
    await owner.exec("laundry.report_exception", { kind: "missed_return" });
    h.clock.set("2026-09-23T18:00:00Z");
    return { h, owner };
  }

  it("marks the still-away exception it created as withdrawn, and reopens the missed return while its units are held again", async () => {
    const { h, owner } = await missedWeek();
    const back = await owner.exec("laundry.return", { stillAway: [{ garmentId: "trouser-navy", quantity: 1 }] });
    const undo = await owner.exec("command.undo", { commandId: back.commandId });
    expect((await exceptionRows(h, owner)).map((x) => [x.kind, x.status, x.resolution])).toEqual([["missed_return", "active", null], ["still_away", "resolved", "withdrawn"]]);
    const withdrawnBy = await first<{ resolved_by_command_id: string }>(h.db, "SELECT resolved_by_command_id FROM laundry_exceptions WHERE user_id = ? AND kind = 'still_away'", owner.userId);
    expect(withdrawnBy!.resolved_by_command_id).toBe(undo.commandId);
    expect(await balances(h, owner, "trouser-navy")).toMatchObject({ clean: 0, service: 2 });
  });

  it("is refused once the still-away item it created has been reported back", async () => {
    const { h, owner } = await missedWeek();
    const back = await owner.exec("laundry.return", { stillAway: [{ garmentId: "trouser-navy", quantity: 1 }] });
    await owner.exec("care.washed", { items: [{ garmentId: "trouser-navy" }] });
    expect(await balances(h, owner, "trouser-navy")).toMatchObject({ clean: 2, service: 0 });
    expect((await owner.exec("command.undo", { commandId: back.commandId }).catch((e) => e)).code).toBe("precondition_failed");
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 1, service: 0 });
    expect((await exceptionRows(h, owner)).map((x) => [x.kind, x.status, x.resolution])).toEqual([["missed_return", "resolved", "returned"], ["still_away", "resolved", "returned"]]);
  });

  it("does not reopen a missed return that a later baseline has released, but does when that later cycle was missed too", async () => {
    const released = await missedWeek();
    const back = await released.owner.exec("laundry.return", {});
    await baseline(released.h, released.owner, "2026-09-27T06:30:00Z");
    await released.owner.exec("command.undo", { commandId: back.commandId });
    expect(await open(released.h, released.owner)).toEqual([]);
    expect(await balances(released.h, released.owner, "shirt-moss")).toMatchObject({ clean: 1, service: 0 }); // released by the later baseline, by inference

    const still = await missedWeek();
    const back2 = await still.owner.exec("laundry.return", {});
    still.h.clock.set("2026-09-26T09:00:00Z");
    await still.owner.exec("laundry.report_exception", { kind: "missed_return", cycleKey: "2026-09-27" });
    await baseline(still.h, still.owner, "2026-09-27T06:30:00Z");
    await still.owner.exec("command.undo", { commandId: back2.commandId });
    expect(await balances(still.h, still.owner, "shirt-moss")).toMatchObject({ clean: 0, service: 1 });
    expect((await exceptionRows(still.h, still.owner)).map((x) => [x.kind, x.cycle_key, x.status])).toEqual([["missed_return", "2026-09-20", "active"], ["missed_return", "2026-09-27", "active"]]);
  });
});

describe("finding 6: what 'washed' without a count says about units that are away", () => {
  it("with a unit awaiting a wash at home it is about that unit: the one reported still away stays away", async () => {
    const { h, owner } = await start();
    await wearOn(h, owner, "2026-09-14", ["trouser-navy"]);
    await baseline(h, owner);
    h.clock.set("2026-09-21T08:00:00Z");
    await owner.exec("laundry.report_exception", { kind: "still_away", garmentId: "trouser-navy" });
    await owner.exec("care.mark_dirty", { items: [{ garmentId: "trouser-navy" }] });
    expect(await balances(h, owner, "trouser-navy")).toMatchObject({ clean: 0, dirty: 1, service: 1 });
    await owner.exec("care.washed", { items: [{ garmentId: "trouser-navy" }] });
    expect(await balances(h, owner, "trouser-navy")).toMatchObject({ clean: 1, dirty: 0, service: 1 });
    expect(await open(h, owner)).toEqual(["still_away"]);
  });

  it("a missed cycle's units wait for 'the laundry is back'; the cycle's exception is settled when its last held unit is released", async () => {
    const { h, owner } = await start();
    await wearOn(h, owner, "2026-09-14", ["shirt-moss", "trouser-navy"]);
    await wearOn(h, owner, "2026-09-15", ["shirt-gold"]);
    await baseline(h, owner);
    h.clock.set("2026-09-21T08:00:00Z");
    await owner.exec("laundry.report_exception", { kind: "missed_return" });
    // Navy chinos: one pair held by the missed cycle, one clean at home. "Washed" does not release the held pair.
    await owner.exec("care.washed", { items: [{ garmentId: "trouser-navy" }] });
    expect(await balances(h, owner, "trouser-navy")).toMatchObject({ clean: 1, service: 1 });
    // A garment with nothing at home at all: the statement can only be about the held unit, which is back.
    await owner.exec("care.washed", { items: [{ garmentId: "shirt-moss" }] });
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 1, service: 0 });
    expect(await open(h, owner)).toEqual(["missed_return"]); // gold and the navy pair are still held
    await owner.exec("care.washed", { items: [{ garmentId: "trouser-navy", quantity: 1 }] });
    const last = await owner.exec("care.washed", { items: [{ garmentId: "shirt-gold" }] });
    expect(await open(h, owner)).toEqual([]);
    expect((await exceptionRows(h, owner)).map((x) => [x.kind, x.resolution])).toEqual([["missed_return", "returned"]]);
    await owner.exec("command.undo", { commandId: last.commandId });
    expect(await open(h, owner)).toEqual(["missed_return"]);
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ clean: 0, service: 1 });
  });
});

describe("finding 10 and the reported limits", () => {
  it("a batch's version in receipts counts the commands that touched it", async () => {
    const { h, owner } = await start();
    await wearOn(h, owner, "2026-09-14", ["shirt-moss", "shirt-gold"]);
    h.clock.set("2026-09-18T08:30:00Z");
    const collected = await owner.exec("laundry.collect", {});
    h.clock.set("2026-09-19T17:00:00Z");
    const partial = await owner.exec("laundry.return", { stillAway: [{ garmentId: "shirt-gold" }] });
    h.clock.set("2026-09-22T17:00:00Z");
    const rest = await owner.exec("laundry.return", {});
    const version = (r: typeof collected) => r.affected.find((a) => a.kind === "laundry_batch")!.version;
    expect([version(collected), version(partial), version(rest)]).toEqual([1, 2, 3]);
    expect((await h.service.listReceipts(owner.principal(), { kind: "laundry_batch", entityId: collected.result.batchId as string })).map((r) => r.type)).toEqual(["laundry.return", "laundry.return", "laundry.collect"]);
  });

  it("a return the owner dates before the weekly baseline still returns the held laundry, from the baseline on", async () => {
    const { h, owner } = await start();
    await wearOn(h, owner, "2026-09-14", ["shirt-moss"]);
    await baseline(h, owner);
    h.clock.set("2026-09-21T09:00:00Z");
    await owner.exec("laundry.report_exception", { kind: "missed_return" });
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 0, service: 1 });
    // "It actually came back on Saturday evening": before the Sunday baseline that counted it as away.
    const back = await owner.exec("laundry.return", {}, { occurredAt: "2026-09-19T17:00:00Z" });
    expect(back.outcome).toBe("committed");
    expect(back.result).toMatchObject({ returned: 1, effectiveAt: "2026-09-19T23:00:01Z" }); // one second after the baseline (Sunday 00:00 in London)
    expect(back.repairs.join(" ")).toContain("dated before the weekly baseline");
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 1, service: 0 });
    expect(await open(h, owner)).toEqual([]);
  });
});
