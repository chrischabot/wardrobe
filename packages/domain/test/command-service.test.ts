import { describe, expect, it } from "vitest";
import { all, first, getDailyRecord, getGarmentDetail, isCommandError, listInventory } from "../src/index.ts";
import { createHarness } from "../src/testing/index.ts";

async function balance(h: Awaited<ReturnType<typeof createHarness>>, userId: string, garmentId: string, bucket: string): Promise<number> {
  const rows = await all<{ quantity: number }>(h.db, "SELECT quantity FROM stock_balances WHERE user_id = ? AND garment_id = ? AND bucket = ?", userId, garmentId, bucket);
  return rows.reduce((n, r) => n + r.quantity, 0);
}

describe("command service: receipts and idempotency", () => {
  it("returns a verified receipt that matches the stored ledger state", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const receipt = await owner.exec("care.mark_dirty", { items: [{ garmentId: "shirt-moss" }] });

    expect(receipt.outcome).toBe("committed");
    expect(receipt.replayed).toBe(false);
    expect(receipt.summary).toContain("moss lightweight oxford");
    expect(receipt.externalEffectState).toBe("none");
    expect(receipt.undo.available).toBe(true);
    const affected = receipt.affected.find((a) => a.kind === "garment" && a.id === "shirt-moss")!;
    const row = await first<{ version: number }>(h.db, "SELECT version FROM garments WHERE user_id = ? AND garment_id = 'shirt-moss'", owner.userId);
    expect(affected.version).toBe(row!.version);
    expect(await balance(h, owner.userId, "shirt-moss", "dirty")).toBe(1);
    expect(await balance(h, owner.userId, "shirt-moss", "clean")).toBe(0);
    // The stored receipt is what getReceipt returns; precondition rows do not linger.
    expect(await h.service.getReceipt(owner.principal(), receipt.commandId)).toEqual(receipt);
    expect((await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM command_preconditions"))!.n).toBe(0);
  });

  it("same idempotency key and body returns the previous receipt without a second effect", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const payload = { wearingDate: "2026-09-15", garmentIds: ["sock-navy"] };
    const first1 = await owner.exec("wear.record", payload, { idempotencyKey: "phone-submission-0001" });
    const again = await owner.exec("wear.record", payload, { idempotencyKey: "phone-submission-0001" });
    expect(again.commandId).toBe(first1.commandId);
    expect(again.replayed).toBe(true);
    expect(await balance(h, owner.userId, "sock-navy", "clean")).toBe(1);
    const commands = await all(h.db, "SELECT command_id FROM commands WHERE user_id = ? AND type = 'wear.record'", owner.userId);
    expect(commands).toHaveLength(1);
    const observations = await all(h.db, "SELECT observation_id FROM wear_observations WHERE user_id = ?", owner.userId);
    expect(observations).toHaveLength(1);
  });

  it("reusing an idempotency key with a different body is an error and writes nothing", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    await owner.exec("care.mark_dirty", { items: [{ garmentId: "shirt-moss" }] }, { idempotencyKey: "same-key-000001" });
    const err = await owner.exec("care.mark_dirty", { items: [{ garmentId: "shirt-gold" }] }, { idempotencyKey: "same-key-000001" }).catch((e) => e);
    expect(isCommandError(err)).toBe(true);
    expect(err.code).toBe("idempotency_key_reuse");
    expect(await balance(h, owner.userId, "shirt-gold", "dirty")).toBe(0);
  });

  it("concurrent retransmissions of one submission produce exactly one command", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const payload = { wearingDate: "2026-09-15", garmentIds: ["shirt-moss", "trouser-olive"] };
    const results = await Promise.all([1, 2, 3, 4].map(() => owner.exec("wear.record", payload, { idempotencyKey: "racing-submission-01" })));
    expect(new Set(results.map((r) => r.commandId)).size).toBe(1);
    const rows = await all(h.db, "SELECT command_id FROM commands WHERE user_id = ? AND type = 'wear.record'", owner.userId);
    expect(rows).toHaveLength(1);
    const record = await getDailyRecord(h.db, owner.principal(), "2026-09-15");
    expect(record.garments.map((g) => g.observationCount)).toEqual([1, 1]);
  });

  it("rejects unknown command types, invalid payloads and unknown garments without writing", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const before = (await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM commands WHERE user_id = ?", owner.userId))!.n;
    expect((await owner.exec("database.write", { sql: "DROP TABLE garments" }).catch((e) => e)).code).toBe("unknown_command");
    expect((await owner.exec("wear.record", { wearingDate: "15/09/2026", garmentIds: ["shirt-moss"] }).catch((e) => e)).code).toBe("invalid_command");
    // Bulk is all-or-nothing: one unknown target fails the whole command and names what was resolved.
    const err = await owner.exec("wear.record", { wearingDate: "2026-09-15", garmentIds: ["shirt-moss", "shirt-imaginary"] }).catch((e) => e);
    expect(err.code).toBe("not_found");
    expect(err.details.missing).toEqual(["shirt-imaginary"]);
    expect(err.details.resolved).toEqual(["shirt-moss"]);
    const after = (await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM commands WHERE user_id = ?", owner.userId))!.n;
    expect(after).toBe(before);
    expect(await balance(h, owner.userId, "shirt-moss", "clean")).toBe(1);
  });

  it("a status change can never create an item", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const before = (await listInventory(h.db, owner.principal())).total;
    const err = await owner.exec("garment.receive", { garmentId: "shirt-that-does-not-exist" }).catch((e) => e);
    expect(err.code).toBe("not_found");
    expect((await listInventory(h.db, owner.principal())).total).toBe(before);
  });
});

describe("command service: versions, conflicts and atomic batches", () => {
  it("a plan edit with a stale expected version is a clean conflict and writes nothing", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const detail = await getGarmentDetail(h.db, owner.principal(), "shirt-moss");
    await owner.exec("garment.set_planning_policy", { garmentId: "shirt-moss", policy: "occasional" });
    const err = await owner
      .exec("garment.set_planning_policy", { garmentId: "shirt-moss", policy: "excluded" }, { expectedVersions: { "garment:shirt-moss": detail.garment.version } })
      .catch((e) => e);
    expect(err.code).toBe("conflict");
    const row = await first<{ planning_policy: string }>(h.db, "SELECT planning_policy FROM garments WHERE user_id = ? AND garment_id = 'shirt-moss'", owner.userId);
    expect(row!.planning_policy).toBe("occasional");
    // No orphan command, receipt or precondition row from the rejected batch.
    const cmds = await all(h.db, "SELECT command_id FROM commands WHERE user_id = ? AND type = 'garment.set_planning_policy'", owner.userId);
    expect(cmds).toHaveLength(1);
    expect((await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM command_preconditions"))!.n).toBe(0);
  });

  it("an owner observation is never rejected over a stale version: it is rebased and recorded", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const receipt = await owner.exec("wear.record", { wearingDate: "2026-09-15", garmentIds: ["shirt-moss"] }, { expectedVersions: { "garment:shirt-moss": 999, wardrobe: 12345 } });
    expect(receipt.outcome).toBe("committed");
    expect(await balance(h, owner.userId, "shirt-moss", "dirty")).toBe(1);
  });

  it("simultaneous conflicting commands both land through internal rebase; quantities stay exact", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    // Two clients mark the two navy chinos dirty at the same moment, a third records a sock wear.
    const results = await Promise.all([
      owner.exec("care.mark_dirty", { items: [{ garmentId: "trouser-navy" }] }, { channel: "ios" }),
      owner.exec("care.mark_dirty", { items: [{ garmentId: "trouser-navy" }] }, { channel: "mcp", actor: "assistant" }),
      owner.exec("wear.record", { wearingDate: "2026-09-15", garmentIds: ["sock-grey"] }, { channel: "web" }),
    ]);
    expect(results.every((r) => r.outcome === "committed")).toBe(true);
    expect(await balance(h, owner.userId, "trouser-navy", "dirty")).toBe(2);
    expect(await balance(h, owner.userId, "trouser-navy", "clean")).toBe(0);
    expect(await balance(h, owner.userId, "sock-grey", "clean")).toBe(2);
    const state = await first<{ wardrobe_revision: number }>(h.db, "SELECT wardrobe_revision FROM owner_state WHERE user_id = ?", owner.userId);
    const count = await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM commands WHERE user_id = ?", owner.userId);
    // Every committed command bumped the revision exactly once (seeding included).
    expect(state!.wardrobe_revision).toBe(count!.n);
  });

  it("a forced late-statement failure rolls back the whole batch: no receipt, no mutation, no effect", async () => {
    const h = await createHarness();
    h.registry.register({
      type: "test.late_failure",
      schema: (await import("zod")).z.object({ garmentId: (await import("zod")).z.string() }),
      class: "edit",
      requiredScope: "write",
      async plan(ctx, p: { garmentId: string }) {
        const planner = ctx.stock();
        planner.add(p.garmentId, "mark_dirty", { quantity: 1 }, "observed", ctx.occurredAt);
        const build = await planner.build();
        return {
          summary: "should never commit",
          statements: [...build.statements, { sql: "INSERT INTO stock_balances (user_id, garment_id, bucket, ref, quantity) VALUES (?, ?, 'clean', 'late-failure', -1)", params: [ctx.userId, p.garmentId] }],
          preconditions: build.preconditions,
          effects: [{ kind: "calendar.project_board", targetKey: "test", operationKey: "test-late-failure", payload: {} }],
          bumpWardrobe: true,
        };
      },
    });
    const owner = await h.createSyntheticOwner();
    const revBefore = (await first<{ wardrobe_revision: number }>(h.db, "SELECT wardrobe_revision FROM owner_state WHERE user_id = ?", owner.userId))!.wardrobe_revision;
    const err = await owner.exec("test.late_failure", { garmentId: "shirt-moss" }).catch((e) => e);
    expect(err.code).toBe("internal"); // a real SQL failure is an error, not an invented conflict
    expect(await balance(h, owner.userId, "shirt-moss", "clean")).toBe(1);
    expect(await balance(h, owner.userId, "shirt-moss", "dirty")).toBe(0);
    expect(await all(h.db, "SELECT 1 FROM commands WHERE user_id = ? AND type = 'test.late_failure'", owner.userId)).toHaveLength(0);
    expect(await all(h.db, "SELECT 1 FROM effects WHERE user_id = ?", owner.userId)).toHaveLength(0);
    expect(await all(h.db, "SELECT 1 FROM stock_events WHERE user_id = ? AND kind = 'mark_dirty'", owner.userId)).toHaveLength(0);
    expect((await first<{ wardrobe_revision: number }>(h.db, "SELECT wardrobe_revision FROM owner_state WHERE user_id = ?", owner.userId))!.wardrobe_revision).toBe(revBefore);
    expect((await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM command_preconditions"))!.n).toBe(0);
  });

  it("the schema itself refuses a negative quantity", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const err = await h.db.prepare("UPDATE stock_balances SET quantity = -1 WHERE user_id = ? AND garment_id = 'shirt-moss'").bind(owner.userId).run().catch((e: unknown) => e);
    expect(String((err as Error).message)).toContain("CHECK");
  });
});

describe("authorization policy", () => {
  it("a read-only connection cannot execute a mutation", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const err = await owner.exec("care.mark_dirty", { items: [{ garmentId: "shirt-moss" }] }, { channel: "mcp", actor: "assistant", scopes: ["read"] }).catch((e) => e);
    expect(err.code).toBe("forbidden");
    expect(await balance(h, owner.userId, "shirt-moss", "dirty")).toBe(0);
  });

  it("a plain object posing as a principal is rejected", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const forged = { userId: owner.userId, actor: "owner", channel: "ios", scopes: ["read", "write", "admin"], authRef: "forged" };
    const err = await h.service
      .execute(forged as never, { type: "care.mark_dirty", payload: { items: [{ garmentId: "shirt-moss" }] }, idempotencyKey: "forged-key-0001", authorization: "owner_tap", source: { channel: "ios" } })
      .catch((e) => e);
    expect(err.code).toBe("forbidden");
  });

  it("the assistant cannot claim an owner tap, and a scheduled job cannot record a wear", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const tap = await owner.exec("care.mark_dirty", { items: [{ garmentId: "shirt-moss" }] }, { actor: "assistant", channel: "conversation", authorization: "owner_tap" }).catch((e) => e);
    expect(tap.code).toBe("forbidden");
    const job = await owner.exec("wear.record", { wearingDate: "2026-09-15", garmentIds: ["shirt-moss"] }, { actor: "system", channel: "scheduled", authorization: "system_schedule" }).catch((e) => e);
    expect(job.code).toBe("forbidden");
    expect(await all(h.db, "SELECT 1 FROM wear_observations WHERE user_id = ?", owner.userId)).toHaveLength(0);
  });

  it("a disabled account accepts no commands", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    await h.db.prepare("UPDATE users SET status = 'disabled' WHERE user_id = ?").bind(owner.userId).run();
    const err = await owner.exec("care.mark_dirty", { items: [{ garmentId: "shirt-moss" }] }).catch((e) => e);
    expect(err.code).toBe("forbidden");
  });
});
