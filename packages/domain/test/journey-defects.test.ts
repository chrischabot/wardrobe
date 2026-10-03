/**
 * Regressions for the defects the journey suite found in the foundation (tests/journeys/DEFECTS.md:
 * D03-1, D03-2, D03-3, D04-1, D04-2, D05-2, D07-4) and for the undo of a recorded batch return.
 * Real command service, local D1, labelled synthetic owners only.
 * September 2026: Mon 14 ... Fri 18 (collection), Sat 19 (return), Sun 20 (baseline).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { all, claimDueEffects, define, first, getAvailability, getLaundryState, settleEffect } from "../src/index.ts";
import { createHarness, type Harness, type TestOwner } from "../src/testing/index.ts";
import { balances, SCHEDULED, wearOn } from "./helpers.ts";

async function start(): Promise<{ h: Harness; owner: TestOwner }> {
  const h = await createHarness({ startAt: "2026-09-14T09:00:00Z" });
  return { h, owner: await h.createSyntheticOwner() };
}

const refusal = (p: Promise<unknown>) => p.then(() => ({ code: "committed", message: "" }), (e) => e as { code: string; message: string });
const batchOf = async (h: Harness, owner: TestOwner) => (await getLaundryState(h.db, owner.principal())).batches[0]!;
const item = (batch: Awaited<ReturnType<typeof batchOf>>, garmentId: string) => batch.items.find((i) => i.garmentId === garmentId)!;
const openExceptions = async (h: Harness, owner: TestOwner) => (await getLaundryState(h.db, owner.principal())).exceptions.map((e) => [e.kind, e.garmentId, e.quantity]);
const basisOf = async (h: Harness, owner: TestOwner, garmentId: string) =>
  (await getAvailability(h.db, owner.principal(), { nowMs: h.clock.now() })).garments.find((g) => g.garmentId === garmentId)!.basis.join(" | ");

/** Two shirts worn on Monday and collected on Friday; the clock is left at Saturday's return. */
async function collected(): Promise<{ h: Harness; owner: TestOwner }> {
  const { h, owner } = await start();
  await wearOn(h, owner, "2026-09-14", ["shirt-gold", "shirt-moss"]);
  h.clock.set("2026-09-18T08:30:00Z");
  await owner.exec("laundry.collect", {});
  h.clock.set("2026-09-19T17:00:00Z");
  return { h, owner };
}

describe("D04-1: a wear dated before the garment's record was made", () => {
  it("uses the stock the garment was recorded with: the unit is awaiting care and nothing is repaired", async () => {
    const { h, owner } = await start();
    h.clock.set("2026-09-14T10:00:00Z");
    // The wardrobe was recorded at 09:00 today; both wears are dated before that.
    const yesterday = await owner.exec("wear.record", { wearingDate: "2026-09-13", garmentIds: ["trouser-olive"] });
    const earlier = await owner.exec("wear.record", { wearingDate: "2026-09-01", garmentIds: ["shirt-gold"] });
    expect(yesterday.repairs).toEqual([]);
    expect(earlier.repairs).toEqual([]);
    expect(await balances(h, owner, "trouser-olive")).toMatchObject({ clean: 0, dirty: 1 });
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ clean: 0, dirty: 1 });
  });

  it("does not turn something that is still on order into stock: nothing arrives before it is reported", async () => {
    const { h, owner } = await start();
    h.clock.set("2026-09-14T10:00:00Z");
    const receipt = await owner.exec("wear.record", { wearingDate: "2026-09-13", garmentIds: ["shirt-ordered"] });
    expect(await balances(h, owner, "shirt-ordered")).toMatchObject({ incoming: 1, clean: 0, dirty: 0 });
    expect(receipt.repairs.join(" ")).toMatch(/no owned units on record; no quantity was created/);
  });
});

describe("D03-2 / D04-2: a return counts what actually came back", () => {
  it("a shirt reported lost before its bag returned is not counted, and stays lost", async () => {
    const { h, owner } = await start();
    await wearOn(h, owner, "2026-09-14", ["shirt-gold"]);
    h.clock.set("2026-09-18T08:30:00Z");
    await owner.exec("laundry.collect", {});
    await owner.exec("laundry.report_exception", { kind: "lost", garmentId: "shirt-gold" });
    h.clock.set("2026-09-19T17:00:00Z");
    const back = await owner.exec("laundry.return", {});
    expect(back.result).toMatchObject({ returned: 0, stillAway: 0 });
    expect(back.summary).toBe("Laundry returned: nothing came back clean; not returned, reported lost: gold lightweight oxford");
    const batch = await batchOf(h, owner);
    expect(batch.status).toBe("returned");
    expect(item(batch, "shirt-gold").returnedQuantity).toBe(0);
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ clean: 0, service: 1 });
    expect(await openExceptions(h, owner)).toEqual([["lost", "shirt-gold", 1]]);
  });

  it("a shirt a wear amendment took out of the collected bag is not counted", async () => {
    const { h, owner } = await collected();
    await owner.exec("wear.amend", { wearingDate: "2026-09-14", remove: ["shirt-moss"], add: [], reason: "it was only the gold one" });
    const back = await owner.exec("laundry.return", {});
    expect(back.result).toMatchObject({ returned: 1, stillAway: 0 });
    expect(back.summary).toBe("Laundry returned: 1 item clean");
    expect(back.repairs.join(" ")).toMatch(/moss lightweight oxford: not counted as returned/);
    const batch = await batchOf(h, owner);
    expect(item(batch, "shirt-gold").returnedQuantity).toBe(1);
    expect(item(batch, "shirt-moss").returnedQuantity).toBe(0);
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 1, service: 0 });
  });

  it("a unit named as still away is not returned in place of one that was reported lost", async () => {
    const { h, owner } = await start();
    await wearOn(h, owner, "2026-09-14", ["trouser-navy"]);
    await wearOn(h, owner, "2026-09-15", ["trouser-navy"]);
    h.clock.set("2026-09-18T08:30:00Z");
    await owner.exec("laundry.collect", {});
    await owner.exec("laundry.report_exception", { kind: "lost", garmentId: "trouser-navy", quantity: 1 });
    h.clock.set("2026-09-19T17:00:00Z");
    const back = await owner.exec("laundry.return", { stillAway: [{ garmentId: "trouser-navy", quantity: 1 }] });
    expect(back.result).toMatchObject({ returned: 0, stillAway: 1 });
    expect(await balances(h, owner, "trouser-navy")).toMatchObject({ clean: 0, service: 2 });
    expect((await openExceptions(h, owner)).map((x) => x[0]).sort()).toEqual(["lost", "still_away"]);
  });
});

describe("the return of a recorded batch can be undone", () => {
  it("puts the bag back at the service, with the batch and its items as they were, and the return can be recorded again", async () => {
    const { h, owner } = await collected();
    const before = await batchOf(h, owner);
    const back = await owner.exec("laundry.return", {});
    expect(back.undo).toEqual({ available: true, reason: null });
    const undone = await owner.exec("command.undo", { commandId: back.commandId });
    expect(undone.summary).toBe("Undone: Laundry returned: 2 items clean. The laundry return is withdrawn; that bag is recorded as out at the service again");
    expect(await batchOf(h, owner)).toEqual(before);
    for (const id of ["shirt-gold", "shirt-moss"]) expect(await balances(h, owner, id)).toMatchObject({ clean: 0, service: 1 });
    // The used undo is not offered again, and a second undo is refused.
    expect((await h.service.getReceipt(owner.principal(), back.commandId))!.undo).toEqual({ available: false, reason: "this action was already undone" });
    expect((await refusal(owner.exec("command.undo", { commandId: back.commandId }))).code).toBe("not_undoable");
    const again = await owner.exec("laundry.return", {});
    expect(again.result).toMatchObject({ batchId: before.batchId, returned: 2 });
  });

  it("withdraws the still-away exception a partial return opened, and the unit is no longer held back", async () => {
    const { h, owner } = await collected();
    const back = await owner.exec("laundry.return", { stillAway: [{ garmentId: "shirt-gold", quantity: 1 }] });
    expect(await openExceptions(h, owner)).toEqual([["still_away", "shirt-gold", 1]]);
    await owner.exec("command.undo", { commandId: back.commandId });
    expect(await openExceptions(h, owner)).toEqual([]);
    const batch = await batchOf(h, owner);
    expect(batch).toMatchObject({ status: "collected", returnedAt: null, returnBasis: null });
    expect(item(batch, "shirt-gold")).toMatchObject({ returnedQuantity: 0, stillAway: 0 });
    expect(await all(h.db, "SELECT held FROM stock_balances WHERE user_id = ? AND garment_id = 'shirt-gold' AND bucket = 'service'", owner.userId)).toEqual([{ held: 0 }]);
    const withdrawn = await all<{ status: string; resolution: string }>(h.db, "SELECT status, resolution FROM laundry_exceptions WHERE user_id = ?", owner.userId);
    expect(withdrawn).toEqual([{ status: "resolved", resolution: "withdrawn" }]);
  });

  it("undoing 'the rest is back' reopens the still-away exception and leaves the first return standing", async () => {
    const { h, owner } = await collected();
    await owner.exec("laundry.return", { stillAway: [{ garmentId: "shirt-gold", quantity: 1 }] });
    const partial = await batchOf(h, owner);
    h.clock.set("2026-09-19T19:00:00Z");
    const rest = await owner.exec("laundry.return", { batchId: partial.batchId });
    expect(rest.result).toMatchObject({ returned: 1 });
    expect(await openExceptions(h, owner)).toEqual([]);
    await owner.exec("command.undo", { commandId: rest.commandId });
    expect(await batchOf(h, owner)).toEqual(partial);
    expect(await openExceptions(h, owner)).toEqual([["still_away", "shirt-gold", 1]]);
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ clean: 0, service: 1 });
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 1, service: 0 });
  });

  it("is refused, with nothing changed, once one of the returned pieces has been worn", async () => {
    const { h, owner } = await collected();
    const back = await owner.exec("laundry.return", {});
    await wearOn(h, owner, "2026-09-20", ["shirt-gold"]);
    const returned = await batchOf(h, owner);
    const refused = await refusal(owner.exec("command.undo", { commandId: back.commandId }));
    expect(refused.code).toBe("not_undoable");
    expect(refused.message).toMatch(/something has been recorded since that laundry came back \(gold lightweight oxford\)/);
    expect(await batchOf(h, owner)).toEqual(returned);
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ dirty: 1, service: 0 });
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 1, service: 0 });
  });

  it("is refused once a weekly baseline has passed: the baseline would count the bag as back anyway", async () => {
    const { h, owner } = await collected();
    const back = await owner.exec("laundry.return", {});
    h.clock.set("2026-09-20T06:30:00Z");
    await owner.exec("laundry.apply_weekly_reset", {}, SCHEDULED);
    const refused = await refusal(owner.exec("command.undo", { commandId: back.commandId }));
    expect(refused.code).toBe("not_undoable");
    expect(refused.message).toMatch(/something has been recorded since that laundry came back/);
    expect((await batchOf(h, owner)).status).toBe("returned");
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ clean: 1, service: 0 });
  });
});

describe("D03-3: the availability basis never calls an inference an observation", () => {
  it("names the weekly baseline as an estimate until a wash is reported, and counts how many units it covers", async () => {
    const { h, owner } = await start();
    await wearOn(h, owner, "2026-09-14", ["shirt-gold", "trouser-navy"]);
    h.clock.set("2026-09-20T06:30:00Z");
    await owner.exec("laundry.apply_weekly_reset", {}, SCHEDULED);
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ clean: 1, dirty: 0 });

    const inferred = await basisOf(h, owner, "shirt-gold");
    expect(inferred).toMatch(/^1 clean unit at home; counted clean by the weekly laundry baseline, an estimate: no wash or return was reported/);
    expect(inferred).not.toMatch(/observed/i);
    // One of the two pairs was never worn: only the other is an estimate.
    expect(await basisOf(h, owner, "trouser-navy")).toMatch(/^2 clean units at home; 1 of them counted clean by the weekly laundry baseline/);
    // A shirt nobody wore was recorded clean by the owner and has not moved.
    expect(await basisOf(h, owner, "shirt-moss")).toBe("1 clean unit at home (observed ledger balance)");

    await owner.exec("care.washed", { items: [{ garmentId: "shirt-gold" }] });
    expect(await basisOf(h, owner, "shirt-gold")).toBe("1 clean unit at home (observed ledger balance)");
  });
});

describe("D05-2: a receipt read again shows its effects and its undo as they are now", () => {
  it("reports a delivered effect as projected, an overtaken one as superseded, and keeps the stored record as committed", async () => {
    const h = await createHarness({ startAt: "2026-09-16T07:00:00Z" });
    h.registry.register(
      define({
        type: "test.publish",
        schema: z.object({ revision: z.number().int() }),
        class: "system",
        requiredScope: "write",
        async plan(_ctx, p) {
          return { summary: `published revision ${p.revision}`, effects: [{ kind: "test.synthetic_projection", targetKey: "synthetic-target", operationKey: `synthetic-target:r${p.revision}`, desiredRevision: p.revision, payload: {} }] };
        },
      }),
    );
    const owner = await h.createSyntheticOwner();
    const system = { actor: "system", channel: "scheduled", authorization: "system_schedule" } as const;
    const first1 = await owner.exec("test.publish", { revision: 1 }, { ...system, idempotencyKey: "publish-revision-1" });
    const second = await owner.exec("test.publish", { revision: 2 }, system);
    expect(first1).toMatchObject({ externalEffectState: "projection_pending", effects: [{ state: "pending" }] });

    const claimed = (await claimDueEffects(h.db, { nowMs: h.clock.now(), kinds: ["test.synthetic_projection"], limit: 500 })).filter((e) => e.userId === owner.userId);
    // Still in progress: nothing is claimed to be delivered yet.
    expect((await h.service.getReceipt(owner.principal(), second.commandId))!).toMatchObject({ externalEffectState: "projection_pending", effects: [{ state: "in_progress" }] });
    await settleEffect(h.db, claimed.find((e) => e.desiredRevision === 2)!, { state: "projected" }, h.clock.now());

    expect((await h.service.getReceipt(owner.principal(), second.commandId))!).toMatchObject({ externalEffectState: "projected", effects: [{ state: "projected" }] });
    expect((await h.service.getReceipt(owner.principal(), first1.commandId))!).toMatchObject({ externalEffectState: "projected", effects: [{ state: "superseded" }] });
    const listed = (await h.service.listReceipts(owner.principal(), { limit: 10 })).filter((r) => r.type === "test.publish");
    expect(listed.map((r) => r.externalEffectState)).toEqual(["projected", "projected"]);
    // The same request sent again is answered with the receipt as it reads now.
    const repeated = await owner.exec("test.publish", { revision: 1 }, { ...system, idempotencyKey: "publish-revision-1" });
    expect(repeated).toMatchObject({ commandId: first1.commandId, replayed: true, externalEffectState: "projected" });
    // The audit record itself is what was committed; it is not rewritten.
    const stored = await first<{ receipt_json: string }>(h.db, "SELECT receipt_json FROM commands WHERE user_id = ? AND command_id = ?", owner.userId, second.commandId);
    expect(JSON.parse(stored!.receipt_json)).toMatchObject({ externalEffectState: "projection_pending", effects: [{ state: "pending" }] });
  });
});

describe("D03-1 / D07-4: receipts are in the owner's words", () => {
  const TRIP = "trp_0123456789abcdef0123";
  const codes = (text: string) => [...text.matchAll(/\b[a-z]+\.[a-z_]+\b|\b[a-z]{2,4}_[0-9a-f]{12,}\b/g)].map((m) => m[0]);

  it("the undo of a stock report says what was undone, without the command's type code", async () => {
    const { h, owner } = await start();
    const dirty = await owner.exec("care.mark_dirty", { items: [{ garmentId: "shirt-gold" }] });
    const undone = await owner.exec("command.undo", { commandId: dirty.commandId });
    expect(undone.summary).toBe("Undone: In the wash: gold lightweight oxford. The quantities are as they were before");
    const packed = await owner.exec("stock.pack", { tripId: TRIP, items: [{ garmentId: "shirt-moss" }] });
    expect(codes((await owner.exec("command.undo", { commandId: packed.commandId })).summary)).toEqual([]);
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 1, trip: 0 });
  });

  it("packing and unpacking name the trip by the name its workstream gives, and never by its identifier", async () => {
    const { h, owner } = await start();
    const packed = await owner.exec("stock.pack", { tripId: TRIP, items: [{ garmentId: "shirt-moss" }, { garmentId: "belt-brown" }] });
    expect(packed.summary).toBe("Packed for the trip: moss lightweight oxford, brown woven belt");
    // The workstream that owns trips registers how a trip is named; only this owner's trip is looked up.
    const asked: string[] = [];
    h.registry.registerEntityNamer("trip", async (_db, userId, id) => (asked.push(`${userId}:${id}`), id === TRIP ? "Paris in October" : null));
    const unpacked = await owner.exec("stock.unpack", { tripId: TRIP });
    expect(unpacked.summary).toBe("Unpacked from \u201CParis in October\u201D: brown woven belt, moss lightweight oxford; laundered pieces are awaiting care, not marked clean");
    expect(asked).toEqual([`${owner.userId}:${TRIP}`]);
    expect(codes(packed.summary + unpacked.summary)).toEqual([]);
  });
});

describe("'washed' without a count is not about a unit reported lost", () => {
  it("leaves the only unit lost; saying how many were washed brings it back", async () => {
    const { h, owner } = await start();
    h.clock.set("2026-09-15T08:00:00Z");
    await owner.exec("laundry.report_exception", { kind: "lost", garmentId: "shirt-gold" });
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ clean: 0, service: 1 });
    await owner.exec("care.washed", { items: [{ garmentId: "shirt-gold" }] });
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ clean: 0, service: 1 });
    expect(await openExceptions(h, owner)).toEqual([["lost", "shirt-gold", 1]]);
    await owner.exec("care.washed", { items: [{ garmentId: "shirt-gold", quantity: 1 }] });
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ clean: 1, service: 0 });
    expect(await openExceptions(h, owner)).toEqual([]);
  });
});
