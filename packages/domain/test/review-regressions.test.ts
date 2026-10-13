/**
 * Regressions for the independent review of commit 7991546b5629 (findings H2, H3, H4, H5 and M2).
 * Every test runs the real command service on local D1. Synthetic owners use the labelled synthetic
 * wardrobe; the one real-owner test only reads and attempts refused commands, so the owner's imported
 * restriction is never lifted here.
 */
import { describe, expect, it } from "vitest";
import { all, first, getAvailability, getLaundryState, listRestrictions } from "../src/index.ts";
import { HEALING_RESTRICTION_ID } from "../src/import/index.ts";
import { createHarness, type Harness, type TestOwner } from "../src/testing/index.ts";
import { balances, SCHEDULED, wearOn } from "./helpers.ts";

const ASSISTANT = { actor: "assistant" as const, channel: "conversation" as const, authorization: "owner_statement" as const };
const MCP_OWNER = { actor: "owner" as const, channel: "mcp" as const, authorization: "owner_statement" as const };

// September 2026: Mon 14 ... Fri 18 (collection), Sat 19 (return), Sun 20 (baseline), Sun 27 (next baseline).
async function weekOfWear(): Promise<{ h: Harness; owner: TestOwner }> {
  const h = await createHarness({ startAt: "2026-09-14T09:00:00Z" });
  const owner = await h.createSyntheticOwner();
  await wearOn(h, owner, "2026-09-14", ["shirt-moss", "trouser-olive"]);
  await wearOn(h, owner, "2026-09-15", ["shirt-gold", "trouser-navy"]);
  await wearOn(h, owner, "2026-09-16", ["trouser-navy"]); // the second pair of navy chinos
  return { h, owner };
}

const activeExceptions = async (h: Harness, owner: TestOwner) => (await getLaundryState(h.db, owner.principal())).exceptions;

describe("H2/M2: a restriction is lifted only by the owner's own statement, never through undo or a bare label", () => {
  it("nobody can undo the imported sneakers-only restriction, and it stays active", async () => {
    const h = await createHarness();
    const { owner } = await h.createRealOwner();
    const added = await first<{ command_id: string }>(h.db, "SELECT command_id FROM commands WHERE user_id = ? AND type = 'restriction.add'", owner.userId);
    for (const who of [ASSISTANT, MCP_OWNER, {}]) {
      const attempt = await owner.exec("command.undo", { commandId: added!.command_id }, who).catch((e) => e);
      expect(attempt.code).toBe("forbidden");
    }
    expect((await listRestrictions(h.db, owner.principal(), { status: "active" })).map((r) => r.restrictionId)).toEqual([HEALING_RESTRICTION_ID]);
    const undone = await first<{ undone_by_command_id: string | null }>(h.db, "SELECT undone_by_command_id FROM commands WHERE user_id = ? AND command_id = ?", owner.userId, added!.command_id);
    expect(undone!.undone_by_command_id).toBeNull();
  });

  it("the owner can undo a restriction he recorded by mistake in the app; an assistant or a connected client cannot", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const added = await owner.exec("restriction.add", { kind: "other", scope: { garmentIds: ["shoe-welted"] }, reason: "synthetic restriction recorded by mistake", source: { kind: "owner_statement" } });
    expect((await owner.exec("command.undo", { commandId: added.commandId }, ASSISTANT).catch((e) => e)).code).toBe("forbidden");
    expect((await owner.exec("command.undo", { commandId: added.commandId }, MCP_OWNER).catch((e) => e)).code).toBe("forbidden");
    expect(await listRestrictions(h.db, owner.principal(), { status: "active" })).toHaveLength(1);

    const undo = await owner.exec("command.undo", { commandId: added.commandId });
    expect(undo.outcome).toBe("committed");
    expect(await listRestrictions(h.db, owner.principal(), { status: "active" })).toEqual([]);
  });

  it("only the app channels count as the owner himself: an owner principal on any other channel neither undoes nor lifts a restriction", async () => {
    // Second change review of pull request 2: the guard used to refuse only the MCP channel, so an owner
    // principal on conversation, scheduled, system or import could undo a restriction and so lift it.
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const added = await owner.exec("restriction.add", { kind: "healing", scope: { garmentIds: ["shoe-welted"] }, reason: "synthetic healing restriction", source: { kind: "owner_statement" } });
    const restrictionId = added.result.restrictionId as string;
    for (const channel of ["conversation", "scheduled", "system", "import", "mcp", "test"] as const) {
      const who = { actor: "owner" as const, channel, authorization: "owner_statement" as const };
      const undo = await owner.exec("command.undo", { commandId: added.commandId }, who).catch((e) => e);
      expect(undo.code, `undo on ${channel}`).toBe("forbidden");
      expect(undo.details, `undo on ${channel}`).toMatchObject({ reason: "restriction_not_lifted_by_undo" });
      const lift = await owner.exec("restriction.resolve", { restrictionId, evidence: { kind: "owner_statement" } }, who).catch((e) => e);
      expect(lift.code, `lift on ${channel}`).toBe("forbidden");
      expect(lift.details, `lift on ${channel}`).toMatchObject({ reason: "evidence_reference_required" });
    }
    expect((await listRestrictions(h.db, owner.principal(), { status: "active" })).map((r) => r.restrictionId)).toEqual([restrictionId]);
    const record = await first<{ undone_by_command_id: string | null }>(h.db, "SELECT undone_by_command_id FROM commands WHERE user_id = ? AND command_id = ?", owner.userId, added.commandId);
    expect(record!.undone_by_command_id).toBeNull();
    // An owner session in the app whose command declares another source is refused too (by the command
    // service's own channel check, before the handler's guard is reached).
    for (const sourceChannel of ["conversation", "mcp", "scheduled"] as const) {
      const envelope = (type: string, payload: unknown) => ({ type, payload, idempotencyKey: `synthetic-${type}-${sourceChannel}`, expectedVersions: {}, authorization: "owner_tap" as const, source: { channel: sourceChannel } });
      const undo = await h.service.execute(owner.principal({ channel: "ios" }), envelope("command.undo", { commandId: added.commandId }) as never).catch((e) => e);
      expect(undo.code, `undo declared from ${sourceChannel}`).toBe("forbidden");
      const lift = await h.service.execute(owner.principal({ channel: "web" }), envelope("restriction.resolve", { restrictionId, evidence: { kind: "owner_statement" } }) as never).catch((e) => e);
      expect(lift.code, `lift declared from ${sourceChannel}`).toBe("forbidden");
    }
    expect(await listRestrictions(h.db, owner.principal(), { status: "active" })).toHaveLength(1);
    // Control: the owner in the app still can, on both app channels: lift without a reference, and undo.
    const second = await owner.exec("restriction.add", { kind: "other", scope: { garmentIds: ["shoe-welted"] }, reason: "second synthetic restriction", source: { kind: "owner_statement" } });
    expect((await owner.exec("restriction.resolve", { restrictionId: second.result.restrictionId, evidence: { kind: "owner_statement" } }, { channel: "web" })).outcome).toBe("committed");
    const third = await owner.exec("restriction.add", { kind: "other", scope: { garmentIds: ["shoe-welted"] }, reason: "third synthetic restriction", source: { kind: "owner_statement" } });
    expect((await owner.exec("command.undo", { commandId: third.commandId }, { channel: "ios" })).outcome).toBe("committed");
    const web = await owner.exec("command.undo", { commandId: added.commandId }, { channel: "web" });
    expect(web.outcome).toBe("committed");
    expect(await listRestrictions(h.db, owner.principal(), { status: "active" })).toEqual([]);
  });

  it("an assistant lifting a restriction must reference the owner's statement; the owner's own tap needs no reference", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const add = () => owner.exec("restriction.add", { kind: "healing", scope: { garmentIds: ["shoe-welted"] }, reason: "synthetic healing restriction", source: { kind: "owner_statement" } });
    const first1 = (await add()).result.restrictionId as string;
    for (const evidence of [{ kind: "owner_statement" }, { kind: "owner_statement", ref: "   " }, { kind: "owner_statement", note: "he said so" }]) {
      const bare = await owner.exec("restriction.resolve", { restrictionId: first1, evidence }, ASSISTANT).catch((e) => e);
      expect(bare.code).toBe("forbidden");
    }
    expect(await listRestrictions(h.db, owner.principal(), { status: "active" })).toHaveLength(1);
    // A reference is not enough either unless the conversation's own record confirms it (PR 2 finding 8):
    // with no verifier registered, or one that does not know the reference, an invented ID lifts nothing.
    const invented = { restrictionId: first1, evidence: { kind: "owner_statement", ref: "message:synthetic-42" } };
    expect((await owner.exec("restriction.resolve", invented, ASSISTANT).catch((e) => e)).details).toMatchObject({ reason: "evidence_reference_not_verified" });
    h.registry.setOwnerStatementVerifier(async (ctx, ref) => ctx.userId === owner.userId && ref === "message:synthetic-real");
    expect((await owner.exec("restriction.resolve", invented, ASSISTANT).catch((e) => e)).code).toBe("forbidden");
    expect(await listRestrictions(h.db, owner.principal(), { status: "active" })).toHaveLength(1);
    const referenced = await owner.exec("restriction.resolve", { restrictionId: first1, evidence: { kind: "owner_statement", ref: "message:synthetic-real" } }, ASSISTANT);
    expect(referenced.outcome).toBe("committed");
    // Undoing the lift reinstates the restriction, and that undo cannot itself be undone: no chain of undos lifts it.
    const reinstated = await owner.exec("command.undo", { commandId: referenced.commandId });
    expect(await listRestrictions(h.db, owner.principal(), { status: "active" })).toHaveLength(1);
    expect((await owner.exec("command.undo", { commandId: reinstated.commandId }).catch((e) => e)).code).toBe("not_undoable");
    expect((await owner.exec("command.undo", { commandId: reinstated.commandId }, ASSISTANT).catch((e) => e)).code).toBe("not_undoable");
    expect(await listRestrictions(h.db, owner.principal(), { status: "active" })).toHaveLength(1);
    await owner.exec("restriction.resolve", { restrictionId: first1, evidence: { kind: "owner_statement" } });
    // A connected client acting as the owner is held to the same standard.
    const viaMcp = (await add()).result.restrictionId as string;
    expect((await owner.exec("restriction.resolve", { restrictionId: viaMcp, evidence: { kind: "owner_statement" } }, MCP_OWNER).catch((e) => e)).code).toBe("forbidden");
    await owner.exec("restriction.resolve", { restrictionId: viaMcp, evidence: { kind: "owner_statement" } });

    const second = (await add()).result.restrictionId as string;
    const tapped = await owner.exec("restriction.resolve", { restrictionId: second, evidence: { kind: "owner_statement" } });
    expect(tapped.outcome).toBe("committed");
    expect(await listRestrictions(h.db, owner.principal(), { status: "active" })).toEqual([]);
  });
});

describe("H3: 'the laundry is back' after a reported missed return", () => {
  it("releases what the missed cycle held, settles the cycle exception, and can be undone", async () => {
    const { h, owner } = await weekOfWear();
    h.clock.set("2026-09-20T06:30:00Z");
    await owner.exec("laundry.apply_weekly_reset", {}, SCHEDULED);
    h.clock.set("2026-09-21T08:00:00Z");
    await owner.exec("laundry.report_exception", { kind: "missed_return" });
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 0, service: 1 });
    expect(await balances(h, owner, "trouser-navy")).toMatchObject({ clean: 0, service: 2 });

    h.clock.set("2026-09-23T18:00:00Z");
    // A garment that was not held back cannot be named as still away; nothing is written.
    expect((await owner.exec("laundry.return", { stillAway: [{ garmentId: "shirt-slate" }] }).catch((e) => e)).code).toBe("precondition_failed");
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 0, service: 1 });
    const back = await owner.exec("laundry.return", { stillAway: [{ garmentId: "trouser-navy", quantity: 1 }] });
    expect(back.outcome).toBe("committed");
    expect(back.result.returned).toBe(4); // moss, gold, olive and one pair of navy chinos
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 1, service: 0 });
    expect(await balances(h, owner, "trouser-navy")).toMatchObject({ clean: 1, service: 1 });
    // The cycle exception is settled; the pair he named as still away is its own visible exception.
    expect((await activeExceptions(h, owner)).map((e) => [e.kind, e.garmentId, e.quantity])).toEqual([["still_away", "trouser-navy", 1]]);
    const moss = (await getAvailability(h.db, owner.principal(), { forDate: "2026-09-24", nowMs: h.clock.now() })).garments.find((g) => g.garmentId === "shirt-moss")!;
    expect(moss.hardExcluded).toBe(false);

    // Undo is a compensating command: the held units and the missed-return exception are as they were.
    await owner.exec("command.undo", { commandId: back.commandId });
    expect(await balances(h, owner, "trouser-navy")).toMatchObject({ clean: 0, service: 2 });
    expect((await activeExceptions(h, owner)).map((e) => e.kind)).toEqual(["missed_return"]);

    // Reported again; the next baseline does not bring back the pair that is still away.
    await owner.exec("laundry.return", { stillAway: [{ garmentId: "trouser-navy", quantity: 1 }] });
    h.clock.set("2026-09-27T06:30:00Z");
    await owner.exec("laundry.apply_weekly_reset", {}, SCHEDULED);
    expect(await balances(h, owner, "trouser-navy")).toMatchObject({ clean: 1, service: 1 });
    expect((await activeExceptions(h, owner)).map((e) => [e.kind, e.garmentId])).toEqual([["still_away", "trouser-navy"]]);
  });

  it("a missed cycle that the next baseline releases by inference no longer leaves its exception open", async () => {
    const { h, owner } = await weekOfWear();
    h.clock.set("2026-09-20T06:30:00Z");
    await owner.exec("laundry.apply_weekly_reset", {}, SCHEDULED);
    await owner.exec("laundry.report_exception", { kind: "missed_return" });
    h.clock.set("2026-09-27T06:30:00Z");
    await owner.exec("laundry.apply_weekly_reset", {}, SCHEDULED);
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 1, service: 0 });
    expect(await activeExceptions(h, owner)).toEqual([]);
  });
});

describe("H4: 'washed' settles a still-away exception only by releasing the held unit", () => {
  it("a two-unit garment with one unit held away gets that unit back, and undo reopens the exception", async () => {
    const { h, owner } = await weekOfWear();
    h.clock.set("2026-09-20T06:30:00Z");
    await owner.exec("laundry.apply_weekly_reset", {}, SCHEDULED);
    h.clock.set("2026-09-21T08:00:00Z");
    await owner.exec("laundry.report_exception", { kind: "still_away", garmentId: "trouser-navy" });
    expect(await balances(h, owner, "trouser-navy")).toMatchObject({ clean: 1, service: 1 });

    const washed = await owner.exec("care.washed", { items: [{ garmentId: "trouser-navy" }] });
    expect(await balances(h, owner, "trouser-navy")).toMatchObject({ clean: 2, service: 0 });
    expect(await activeExceptions(h, owner)).toEqual([]);

    await owner.exec("command.undo", { commandId: washed.commandId });
    expect(await balances(h, owner, "trouser-navy")).toMatchObject({ clean: 1, service: 1 });
    expect((await activeExceptions(h, owner)).map((e) => [e.kind, e.garmentId])).toEqual([["still_away", "trouser-navy"]]);
  });

  it("washing only the dirty unit leaves the held unit and its exception in place", async () => {
    const { h, owner } = await weekOfWear();
    h.clock.set("2026-09-20T06:30:00Z");
    await owner.exec("laundry.apply_weekly_reset", {}, SCHEDULED);
    h.clock.set("2026-09-21T08:00:00Z");
    await owner.exec("laundry.report_exception", { kind: "lost", garmentId: "trouser-navy" });
    await owner.exec("care.mark_dirty", { items: [{ garmentId: "trouser-navy" }] });
    await owner.exec("care.washed", { items: [{ garmentId: "trouser-navy", quantity: 1 }] });
    expect(await balances(h, owner, "trouser-navy")).toMatchObject({ clean: 1, dirty: 0, service: 1 });
    expect((await activeExceptions(h, owner)).map((e) => e.kind)).toEqual(["lost"]);
    // "Washed" without a count does not bring back a pair he reported lost.
    await owner.exec("care.washed", { items: [{ garmentId: "trouser-navy" }] });
    expect(await balances(h, owner, "trouser-navy")).toMatchObject({ clean: 1, service: 1 });
    expect((await activeExceptions(h, owner)).map((e) => e.kind)).toEqual(["lost"]);
  });

  it("a batch item named still away and later reported washed closes the batch as well", async () => {
    const h = await createHarness({ startAt: "2026-09-14T09:00:00Z" });
    const owner = await h.createSyntheticOwner();
    await wearOn(h, owner, "2026-09-14", ["shirt-moss", "shirt-gold"]);
    h.clock.set("2026-09-18T08:30:00Z");
    await owner.exec("laundry.collect", {});
    h.clock.set("2026-09-19T17:00:00Z");
    await owner.exec("laundry.return", { stillAway: [{ garmentId: "shirt-gold" }] });
    h.clock.set("2026-09-22T17:00:00Z");
    await owner.exec("care.washed", { items: [{ garmentId: "shirt-gold" }] });
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ clean: 1, service: 0 });
    const state = await getLaundryState(h.db, owner.principal());
    expect(state.exceptions).toEqual([]);
    expect(state.batches.map((b) => [b.status, b.items.map((i) => [i.garmentId, i.returnedQuantity, i.stillAway])])).toEqual([["returned", [["shirt-gold", 1, 0], ["shirt-moss", 1, 0]]]]);
  });
});

describe("H5: undoing a laundry pickup", () => {
  it("is refused once the batch has come back, and changes nothing", async () => {
    const h = await createHarness({ startAt: "2026-09-14T09:00:00Z" });
    const owner = await h.createSyntheticOwner();
    await wearOn(h, owner, "2026-09-14", ["shirt-moss"]);
    h.clock.set("2026-09-18T08:30:00Z");
    const collected = await owner.exec("laundry.collect", {});
    h.clock.set("2026-09-19T17:00:00Z");
    await owner.exec("laundry.return", {});
    const undo = await owner.exec("command.undo", { commandId: collected.commandId }).catch((e) => e);
    expect(undo.code).toBe("not_undoable");
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 1, dirty: 0, service: 0 });
    const state = await getLaundryState(h.db, owner.principal());
    expect(state.batches.map((b) => [b.status, b.items.length])).toEqual([["returned", 1]]);

    // The same holds when the weekly baseline inferred the return.
    const second = await createHarness({ startAt: "2026-09-14T09:00:00Z" });
    const o2 = await second.createSyntheticOwner();
    await wearOn(second, o2, "2026-09-14", ["shirt-moss"]);
    second.clock.set("2026-09-18T08:30:00Z");
    const c2 = await o2.exec("laundry.collect", {});
    second.clock.set("2026-09-20T06:30:00Z");
    await o2.exec("laundry.apply_weekly_reset", {}, SCHEDULED);
    expect((await o2.exec("command.undo", { commandId: c2.commandId }).catch((e) => e)).code).toBe("not_undoable");
    expect(await balances(second, o2, "shirt-moss")).toMatchObject({ clean: 1, dirty: 0 });
  });

  it("while the batch is still out, it withdraws the batch without deleting its record", async () => {
    const h = await createHarness({ startAt: "2026-09-14T09:00:00Z" });
    const owner = await h.createSyntheticOwner();
    await wearOn(h, owner, "2026-09-14", ["shirt-moss"]);
    h.clock.set("2026-09-18T08:30:00Z");
    const collected = await owner.exec("laundry.collect", {});
    const undo = await owner.exec("command.undo", { commandId: collected.commandId });
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ dirty: 1, service: 0 });
    // The record of the pickup stays, marked withdrawn by the undo; it is no longer an open batch.
    const rows = await all<{ withdrawn_at: string | null; withdrawn_by_command_id: string | null }>(h.db, "SELECT withdrawn_at, withdrawn_by_command_id FROM laundry_batches WHERE user_id = ?", owner.userId);
    expect(rows).toEqual([{ withdrawn_at: expect.any(String), withdrawn_by_command_id: undo.commandId }]);
    expect(await all(h.db, "SELECT 1 FROM laundry_batch_items WHERE user_id = ?", owner.userId)).toHaveLength(1);
    expect((await getLaundryState(h.db, owner.principal())).batches).toEqual([]);
    // "Returned" now finds no open batch and treats the hamper as what came back.
    h.clock.set("2026-09-19T17:00:00Z");
    const back = await owner.exec("laundry.return", {});
    expect(back.result).toMatchObject({ batchId: null, returned: 1 });
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 1, dirty: 0 });
  });
});
