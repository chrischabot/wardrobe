import { describe, expect, it } from "vitest";
import { all, getDailyRecord, getGarmentDetail, listInventory } from "../src/index.ts";
import { createHarness } from "../src/testing/index.ts";
import { balances, countedWears, MCP_ASSISTANT, wearOn } from "./helpers.ts";

const DAY = "2026-09-15";
const OUTFIT = ["shirt-moss", "trouser-olive", "sock-navy", "shoe-navy"];

describe("one counted wear per garment and wearing date", () => {
  it("changing only the shirt increments only the replacement shirt (no second sock pair is consumed)", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    await owner.exec("wear.record", { wearingDate: DAY, garmentIds: OUTFIT, segment: "morning" });
    h.clock.advanceMinutes(8 * 60);
    const evening = await owner.exec("wear.record", { wearingDate: DAY, garmentIds: ["shirt-red-stripe", "trouser-olive", "sock-navy", "shoe-navy"], segment: "evening" });

    expect(evening.result.counted).toEqual(["shirt-red-stripe"]);
    expect(evening.result.merged).toEqual(["trouser-olive", "sock-navy", "shoe-navy"]);
    const wears = await countedWears(h, owner);
    expect(wears.map((w) => w.garment_id).sort()).toEqual(["shirt-moss", "shirt-red-stripe", "shoe-navy", "sock-navy", "trouser-olive"]);
    // The earlier shirt's genuine wear is kept; trousers, socks and shoes count once with both reports retained.
    expect(wears.find((w) => w.garment_id === "shirt-moss")!.observation_count).toBe(1);
    expect(wears.find((w) => w.garment_id === "trouser-olive")!.observation_count).toBe(2);
    expect((await balances(h, owner, "sock-navy")).clean).toBe(1); // 2 pairs owned, exactly one consumed
    expect((await balances(h, owner, "trouser-olive")).dirty).toBe(1);
    const record = await getDailyRecord(h.db, owner.principal(), DAY);
    expect(record.garments.find((g) => g.garmentId === "trouser-olive")!.segments).toEqual(["morning", "evening"]);
    expect(record.observations).toHaveLength(8);
  });

  it("the same garment on a later date is a separate counted wear", async () => {
    const h = await createHarness({ startAt: "2026-09-14T09:00:00Z" });
    const owner = await h.createSyntheticOwner();
    await wearOn(h, owner, "2026-09-14", ["shoe-navy"]);
    await wearOn(h, owner, "2026-09-15", ["shoe-navy"]);
    expect((await countedWears(h, owner, "shoe-navy")).map((w) => w.wearing_date)).toEqual(["2026-09-14", "2026-09-15"]);
    expect((await getGarmentDetail(h.db, owner.principal(), "shoe-navy")).recordedWearCount).toBe(2);
  });

  it("phone and MCP reports of the same wear merge: one count, both sources kept, no question asked", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const phone = await owner.exec("wear.record", { wearingDate: DAY, garmentIds: ["shirt-moss"] }, { channel: "ios", clientSubmissionId: "a" });
    const mcp = await owner.exec("wear.record", { wearingDate: DAY, garmentIds: ["shirt-moss"] }, { ...MCP_ASSISTANT, clientSubmissionId: "b" });
    expect(phone.outcome).toBe("committed");
    expect(mcp.outcome).toBe("merged");
    expect(mcp.summary).toContain("nothing was counted twice");
    expect(await countedWears(h, owner, "shirt-moss")).toHaveLength(1);
    const obs = await all<{ channel: string }>(h.db, "SELECT channel FROM wear_observations WHERE user_id = ? AND garment_id = 'shirt-moss' AND status = 'active' ORDER BY reported_at", owner.userId);
    expect(obs.map((o) => o.channel)).toEqual(["ios", "mcp"]);
    expect((await balances(h, owner, "shirt-moss")).dirty).toBe(1);
  });

  it("two clients racing to report the same first wear still produce one counted wear and one stock movement", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const results = await Promise.all([
      owner.exec("wear.record", { wearingDate: DAY, garmentIds: ["trouser-navy"] }, { channel: "ios" }),
      owner.exec("wear.record", { wearingDate: DAY, garmentIds: ["trouser-navy"] }, MCP_ASSISTANT),
      owner.exec("wear.record", { wearingDate: DAY, garmentIds: ["trouser-navy"] }, { channel: "web" }),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["committed", "merged", "merged"]);
    const wears = await countedWears(h, owner, "trouser-navy");
    expect(wears).toHaveLength(1);
    expect(wears[0]!.observation_count).toBe(3);
    const b = await balances(h, owner, "trouser-navy");
    expect([b.clean, b.dirty]).toEqual([1, 1]); // two pairs owned; one wear consumed one
  });

  it("an explicit extra pair moves stock without adding a second daily wear", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    await owner.exec("wear.record", { wearingDate: DAY, garmentIds: ["sock-grey"] });
    await owner.exec("wear.record", { wearingDate: DAY, garmentIds: ["sock-grey"], additionalUnits: [{ garmentId: "sock-grey", quantity: 1 }] });
    expect(await countedWears(h, owner, "sock-grey")).toHaveLength(1);
    const b = await balances(h, owner, "sock-grey");
    expect([b.clean, b.dirty]).toEqual([1, 2]);
  });

  it("a wear cannot be recorded for a future date, and a never-laundered item gets no laundry state", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const err = await owner.exec("wear.record", { wearingDate: "2026-09-16", garmentIds: ["shirt-moss"] }).catch((e) => e);
    expect(err.code).toBe("invalid_command");
    await owner.exec("wear.record", { wearingDate: DAY, garmentIds: ["shoe-navy", "belt-brown"] });
    expect(await balances(h, owner, "shoe-navy")).toMatchObject({ clean: 1, dirty: 0 });
    expect((await owner.exec("care.mark_dirty", { items: [{ garmentId: "belt-brown" }] }).catch((e) => e)).code).toBe("precondition_failed");
  });
});

describe("owner observations are authoritative; accounting is repaired in event order", () => {
  it("a late report of yesterday's wear does not undo today's known wash", async () => {
    const h = await createHarness({ startAt: "2026-09-15T09:00:00Z" });
    const owner = await h.createSyntheticOwner();
    await owner.exec("care.washed", { items: [{ garmentId: "shirt-moss" }] }); // washed at 10 AM local on the 15th
    h.clock.advanceMinutes(120);
    const late = await owner.exec("wear.record", { wearingDate: "2026-09-14", garmentIds: ["shirt-moss"] });
    expect(late.outcome).toBe("committed");
    expect((await countedWears(h, owner, "shirt-moss")).map((w) => w.wearing_date)).toEqual(["2026-09-14"]);
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 1, dirty: 0 });
    // Event time and report time are stored separately.
    const obs = await all<{ occurred_at: string; reported_at: string }>(h.db, "SELECT occurred_at, reported_at FROM wear_observations WHERE user_id = ?", owner.userId);
    expect(obs[0]!.occurred_at < obs[0]!.reported_at).toBe(true);
  });

  it("an unexpected wash is accepted and the earlier wear history is preserved", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    await owner.exec("wear.record", { wearingDate: DAY, garmentIds: ["trouser-olive"] });
    h.clock.advanceMinutes(60);
    const wash = await owner.exec("care.washed", { items: [{ garmentId: "trouser-olive" }] });
    expect(wash.outcome).toBe("committed");
    expect(await balances(h, owner, "trouser-olive")).toMatchObject({ clean: 1, dirty: 0 });
    expect(await countedWears(h, owner, "trouser-olive")).toHaveLength(1);
  });

  it("wearing an item the ledger had at the tailor records the wear and brings it back to the owner, without a duplicate garment", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    await owner.exec("garment.move", { garmentId: "jacket-blue-work", to: "tailor" });
    expect((await balances(h, owner, "jacket-blue-work")).tailor).toBe(1);
    const before = (await listInventory(h.db, owner.principal())).total;
    h.clock.advanceMinutes(30);
    const receipt = await owner.exec("wear.record", { wearingDate: DAY, garmentIds: ["jacket-blue-work"] });
    expect(receipt.outcome).toBe("committed");
    expect(receipt.repairs.join(" ")).toContain("tailor");
    expect(await balances(h, owner, "jacket-blue-work")).toMatchObject({ clean: 1, tailor: 0 });
    expect(await countedWears(h, owner, "jacket-blue-work")).toHaveLength(1);
    expect((await listInventory(h.db, owner.principal())).total).toBe(before);
  });

  it("a wear of a restricted item is recorded as fact and does not lift the restriction", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const added = await owner.exec("restriction.add", { kind: "healing", scope: { anyOf: [{ category: "footwear", footwearKinds: ["welted"] }] }, reason: "sneakers only", source: { kind: "owner_statement" } });
    const receipt = await owner.exec("wear.record", { wearingDate: DAY, garmentIds: ["shoe-welted"] });
    expect(receipt.outcome).toBe("committed");
    expect(receipt.repairs.join(" ")).toContain("restriction is unchanged");
    const r = await all<{ status: string }>(h.db, "SELECT status FROM restrictions WHERE user_id = ? AND restriction_id = ?", owner.userId, added.result.restrictionId);
    expect(r[0]!.status).toBe("active");
  });

  it("merging two records of one garment reconciles the wear keys: one garment, one counted wear, both reports kept", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner({
      garments: [
        { id: "old-work", name: "old blue work jacket", category: "outerwear", roles: ["outer"], careChannel: "none" },
        { id: "old-chore", name: "old blue chore coat", category: "outerwear", roles: ["outer"], careChannel: "none" },
      ],
    });
    await owner.exec("wear.record", { wearingDate: DAY, garmentIds: ["old-work"] }, { channel: "ios" });
    await owner.exec("wear.record", { wearingDate: DAY, garmentIds: ["old-chore"] }, MCP_ASSISTANT);
    const merge = await owner.exec("garment.merge", { sourceGarmentId: "old-chore", targetGarmentId: "old-work" });
    expect(merge.undo.available).toBe(false);

    const inventory = await listInventory(h.db, owner.principal());
    expect(inventory.items.map((i) => i.garment.garmentId)).toEqual(["old-work"]);
    expect(inventory.items[0]!.aliases).toContain("old blue chore coat");
    expect(inventory.items[0]!.totalOwnedUnits).toBe(1);
    const wears = await countedWears(h, owner);
    expect(wears).toEqual([{ garment_id: "old-work", wearing_date: DAY, observation_count: 2 }]);
    const obs = await all<{ garment_id: string; original_garment_id: string | null }>(h.db, "SELECT garment_id, original_garment_id FROM wear_observations WHERE user_id = ? AND status = 'active' ORDER BY reported_at", owner.userId);
    expect(obs).toEqual([
      { garment_id: "old-work", original_garment_id: null },
      { garment_id: "old-work", original_garment_id: "old-chore" },
    ]);
    // A later report against the merged name lands on the canonical garment and merges.
    const again = await owner.exec("wear.record", { wearingDate: DAY, garmentIds: ["old-chore"] });
    expect(again.outcome).toBe("merged");
    expect((await countedWears(h, owner))[0]!.observation_count).toBe(3);
  });
});

describe("undo and amendment are compensations, never deletions", () => {
  it("undoing a wear restores stock through a new command and keeps both receipts", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const wear = await owner.exec("wear.record", { wearingDate: DAY, garmentIds: ["shirt-gold", "sock-navy"] });
    const undo = await owner.exec("command.undo", { commandId: wear.commandId });
    expect(undo.commandId).not.toBe(wear.commandId);
    expect(undo.summary).toContain("Undone");
    expect(undo.undo.available).toBe(false);
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ clean: 1, dirty: 0 });
    expect((await balances(h, owner, "sock-navy")).clean).toBe(2);
    expect(await countedWears(h, owner)).toHaveLength(0);
    // The original receipt and the journal rows remain; the observation is retracted, not deleted.
    expect(await h.service.getReceipt(owner.principal(), wear.commandId)).toMatchObject({ commandId: wear.commandId, outcome: "committed" });
    const events = await all<{ voided_by_command_id: string | null }>(h.db, "SELECT voided_by_command_id FROM stock_events WHERE user_id = ? AND kind = 'wear'", owner.userId);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.voided_by_command_id === undo.commandId)).toBe(true);
    const obs = await all<{ status: string }>(h.db, "SELECT status FROM wear_observations WHERE user_id = ?", owner.userId);
    expect(obs.map((o) => o.status)).toEqual(["retracted", "retracted"]);
    const twice = await owner.exec("command.undo", { commandId: wear.commandId }).catch((e) => e);
    expect(twice.code).toBe("not_undoable");
  });

  it("undoing one of two merged reports withdraws only that report; the counted wear stands", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    await owner.exec("wear.record", { wearingDate: DAY, garmentIds: ["shirt-gold"] });
    const second = await owner.exec("wear.record", { wearingDate: DAY, garmentIds: ["shirt-gold"] }, MCP_ASSISTANT);
    await owner.exec("command.undo", { commandId: second.commandId });
    const wears = await countedWears(h, owner, "shirt-gold");
    expect(wears).toHaveLength(1);
    expect(wears[0]!.observation_count).toBe(1);
    expect((await balances(h, owner, "shirt-gold")).dirty).toBe(1);
  });

  it("undo rechecks intervening changes: the unit undone out of 'dirty' is not pulled back from a bag it entered", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const dirty = await owner.exec("care.mark_dirty", { items: [{ garmentId: "shirt-slate" }] });
    h.clock.advanceMinutes(60);
    await owner.exec("laundry.collect", {});
    expect((await balances(h, owner, "shirt-slate")).service).toBe(1);
    h.clock.advanceMinutes(60);
    await owner.exec("command.undo", { commandId: dirty.commandId });
    // Without the dirty mark the shirt was never awaiting care, so it cannot have been collected.
    expect(await balances(h, owner, "shirt-slate")).toMatchObject({ clean: 1, dirty: 0, service: 0 });
    const totals = await all<{ q: number }>(h.db, "SELECT SUM(quantity) AS q FROM stock_balances WHERE user_id = ? AND garment_id = 'shirt-slate'", owner.userId);
    expect(totals[0]!.q).toBe(1);
  });

  it("amending yesterday's record replaces only the corrected fact and explains the laundry adjustment", async () => {
    const h = await createHarness({ startAt: "2026-09-14T09:00:00Z" });
    const owner = await h.createSyntheticOwner();
    await wearOn(h, owner, "2026-09-14", ["shirt-moss", "trouser-olive"]);
    h.clock.set("2026-09-15T09:00:00Z");
    const pickup = await owner.exec("laundry.collect", {});
    expect(pickup.result.units).toBe(2);
    h.clock.advanceMinutes(30);
    const amend = await owner.exec("wear.amend", { wearingDate: "2026-09-14", remove: ["shirt-moss"], add: ["shirt-gold"], reason: "it was the gold one" });
    expect(amend.summary).toContain("removed moss lightweight oxford");
    expect(amend.repairs.join(" ")).toContain("not in the bag");
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 1, dirty: 0, service: 0 });
    // The gold shirt was worn but the pickup membership is history: it is awaiting care, not in the bag.
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ clean: 0, dirty: 1, service: 0 });
    expect(await balances(h, owner, "trouser-olive")).toMatchObject({ service: 1 });
    expect((await countedWears(h, owner)).map((w) => w.garment_id)).toEqual(["shirt-gold", "trouser-olive"]);
    const batches = await all(h.db, "SELECT batch_id FROM laundry_batches WHERE user_id = ?", owner.userId);
    expect(batches).toHaveLength(1);
    const retracted = await all(h.db, "SELECT 1 FROM wear_observations WHERE user_id = ? AND garment_id = 'shirt-moss' AND status = 'retracted'", owner.userId);
    expect(retracted).toHaveLength(1);
  });
});
