/**
 * Forgetting: scrubbing the command ledger's own copies of a forgotten source (the function the
 * assistant's forget command composes into its own commit). Synthetic owners and synthetic text only.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { all, claimDueEffects, define, first, getStyleContext, planLedgerScrub, registerActionIntent, SCRUBBED_TEXT, settleEffect, type LedgerScrubPlan } from "../src/index.ts";
import { createHarness, type Harness, type TestOwner } from "../src/testing/index.ts";
import { balances, countedWears } from "./helpers.ts";

const SECRET_NOTE = "synthetic private remark about the dinner";
const SECRET_AMENDMENT = "Synthetic amendment: chest now forty-three.";
const SECRET_SOURCE_NOTE = "synthetic aside said at dinner";
const SECRET_EFFECT = "synthetic reminder text";

async function setup(): Promise<{ h: Harness; owner: TestOwner }> {
  const h = await createHarness({ startAt: "2026-09-15T08:00:00Z" });
  // Stand-ins for the assistant lane's commands: one that queues an effect and an outbox entry carrying
  // text, and the forget command that composes the foundation's scrub into its own commit.
  h.registry.register(
    define({
      type: "test.remind",
      schema: z.object({ text: z.string(), key: z.string() }),
      class: "edit",
      requiredScope: "write",
      async plan(_ctx, p) {
        return {
          summary: `Reminder set: ${p.text}`,
          effects: [{ kind: "notification.reminder", targetKey: `reminder:${p.key}`, operationKey: `reminder:${p.key}:1`, payload: { text: p.text } }],
          outbox: [{ topic: "search.index", entityKind: "reminder", entityId: p.key, revision: 1, payload: { text: p.text } }],
          result: { text: p.text },
          undo: { data: { text: p.text } },
        };
      },
    }),
  );
  h.registry.register(
    define({
      type: "test.forget",
      schema: z.object({ commandIds: z.array(z.string()) }),
      class: "edit",
      requiredScope: "write",
      async plan(ctx, p) {
        const scrub = await planLedgerScrub(ctx, p.commandIds);
        const { statements, ...account } = scrub;
        return { summary: `Forgotten: ${scrub.scrubbedCommandIds.length} command record(s) scrubbed`, statements, result: account as unknown as Record<string, unknown>, undo: { unavailableReason: "forgetting cannot be undone" } };
      },
    }),
  );
  return { h, owner: await h.createSyntheticOwner() };
}

/** Commands issued in one synthetic conversation turn, as the assistant issues them. */
async function turn(h: Harness, owner: TestOwner) {
  const p = owner.principal({ channel: "conversation", actor: "assistant" });
  const source = { channel: "conversation" as const, parentKind: "turn", parentId: "turn-synthetic-1" };
  const wearPayload = { wearingDate: "2026-09-15", garmentIds: ["shirt-moss"], note: SECRET_NOTE };
  const intent = await registerActionIntent(h.db, p, { parentKind: "turn", parentId: "turn-synthetic-1", operation: "wear.record", targets: ["shirt-moss"], effect: wearPayload, nowMs: h.clock.now() });
  const wearEnvelope = { type: "wear.record", payload: wearPayload, idempotencyKey: intent.idempotencyKey, authorization: "owner_statement" as const, source: { ...source, actionId: intent.actionId } };
  const wear = await h.service.execute(p, wearEnvelope);
  const importOpts = { actor: "system" as const, channel: "import" as const, scopes: ["read" as const, "write" as const, "admin" as const], authorization: "data_import" as const };
  const profile = "# Synthetic profile (test fixture)\n";
  const { sha256Hex } = await import("../src/index.ts");
  await owner.exec("style.import_document", { title: "Synthetic profile", content: profile, expectedSha256: await sha256Hex(new TextEncoder().encode(profile)), source: { kind: "import" } }, importOpts);
  const amendment = await h.service.execute(p, {
    type: "style.add_amendment",
    payload: { text: SECRET_AMENDMENT, kind: "measurement", source: { kind: "owner_statement", ref: "message:synthetic-1", note: SECRET_SOURCE_NOTE } },
    idempotencyKey: "synthetic-amendment-0001", authorization: "owner_statement", source,
  });
  const remind = await h.service.execute(p, { type: "test.remind", payload: { text: SECRET_EFFECT, key: "r1" }, idempotencyKey: "synthetic-reminder-0001", authorization: "owner_statement", source });
  return { p, wear, wearEnvelope, amendment, remind };
}

/** Every text column the ledger itself keeps for these commands, concatenated. */
async function ledgerText(h: Harness, owner: TestOwner): Promise<string> {
  const parts = await Promise.all([
    all<{ t: string }>(h.db, "SELECT payload_json || receipt_json || COALESCE(undo_json, '') || source_json AS t FROM commands WHERE user_id = ?", owner.userId),
    all<{ t: string }>(h.db, "SELECT payload_json || COALESCE(last_error, '') AS t FROM effects WHERE user_id = ?", owner.userId),
    all<{ t: string }>(h.db, "SELECT payload_json AS t FROM outbox WHERE user_id = ?", owner.userId),
    all<{ t: string }>(h.db, "SELECT effect_json AS t FROM action_intents WHERE user_id = ?", owner.userId),
    all<{ t: string }>(h.db, "SELECT COALESCE(note, '') AS t FROM wear_observations WHERE user_id = ?", owner.userId),
    all<{ t: string }>(h.db, "SELECT source_json AS t FROM style_amendments WHERE user_id = ?", owner.userId),
  ]);
  return parts.flat().map((r) => r.t).join("\n");
}

describe("scrubbing the ledger's copies of a forgotten message", () => {
  it("removes the text from commands, receipts, undo data, action intents and notes, keeps the facts, and says what is pending and what is retained", async () => {
    const { h, owner } = await setup();
    const { p, wear, wearEnvelope, amendment, remind } = await turn(h, owner);
    const before = await ledgerText(h, owner);
    for (const secret of [SECRET_NOTE, SECRET_AMENDMENT, SECRET_SOURCE_NOTE, SECRET_EFFECT]) expect(before).toContain(secret);

    const forget = await owner.exec("test.forget", { commandIds: [wear.commandId, amendment.commandId, remind.commandId, "cmd_does_not_exist"] });
    const account = forget.result as unknown as Omit<LedgerScrubPlan, "statements">;
    expect(account.scrubbedCommandIds.sort()).toEqual([wear.commandId, amendment.commandId, remind.commandId].sort());
    expect(account.unknownCommandIds).toEqual(["cmd_does_not_exist"]);
    expect(account.counts).toMatchObject({ commands: 3, actionIntents: 1, notes: 1 });
    // The reminder has not been delivered: its payload is still needed, and the account says so instead of claiming erasure.
    expect(account.pendingEffects.map((e) => [e.commandId, e.kind, e.state])).toEqual([[remind.commandId, "notification.reminder", "pending"]]);
    expect(account.pendingOutbox).toBe(1);
    expect(account.ledgerCopiesErased).toBe(false);
    // The amendment is a standing owner record: it is kept, and named as kept.
    expect(account.retained).toEqual([{ kind: "style_amendment", id: amendment.result.amendmentId, commandId: amendment.commandId }]);

    const after = await ledgerText(h, owner);
    expect(after).not.toContain(SECRET_NOTE);
    expect(after).not.toContain(SECRET_SOURCE_NOTE);
    expect(after.split(SECRET_EFFECT).length - 1).toBe(2); // only the pending effect and the pending outbox entry
    expect(after).not.toContain(SECRET_AMENDMENT); // gone from the command, receipt and intent ...
    expect((await getStyleContext(h.db, owner.principal())).amendments.map((a) => a.text)).toEqual([SECRET_AMENDMENT]); // ... but the amendment itself stands

    // The receipt keeps what happened as identifiers; its prose is gone and it says it was scrubbed.
    const receipt = (await h.service.getReceipt(owner.principal(), wear.commandId))!;
    expect(receipt).toMatchObject({ commandId: wear.commandId, type: "wear.record", outcome: "committed", summary: SCRUBBED_TEXT, result: { forgotten: true }, repairs: [], undo: { available: false } });
    expect(receipt.affected).toEqual(wear.affected);
    const row = await first<{ payload_json: string; scrubbed_by_command_id: string; scrubbed_at: string }>(h.db, "SELECT payload_json, scrubbed_by_command_id, scrubbed_at FROM commands WHERE user_id = ? AND command_id = ?", owner.userId, wear.commandId);
    expect(row).toMatchObject({ payload_json: JSON.stringify({ forgotten: true }), scrubbed_by_command_id: forget.commandId, scrubbed_at: expect.any(String) });

    // Forgetting the message does not undo what was done with it: the wear is still counted, the shirt still worn.
    expect(await countedWears(h, owner, "shirt-moss")).toHaveLength(1);
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 0, dirty: 1 });
    // A retry of the original request still gets its (scrubbed) receipt, not a second wear.
    expect(await h.service.execute(p, wearEnvelope)).toMatchObject({ commandId: wear.commandId, replayed: true, summary: SCRUBBED_TEXT });
    // Undo data is gone with the text: the change is corrected by a new action, not undone.
    expect((await owner.exec("command.undo", { commandId: remind.commandId }).catch((e) => e)).code).toBe("not_undoable");

    // Once the queued work has run, a second pass finishes the erasure.
    for (const effect of (await claimDueEffects(h.db, { nowMs: h.clock.now(), limit: 500 })).filter((e) => e.userId === owner.userId)) await settleEffect(h.db, effect, { state: "projected" }, h.clock.now());
    await h.db.prepare("UPDATE outbox SET state = 'acknowledged' WHERE user_id = ?").bind(owner.userId).run(); // stand-in for the outbox consumer acknowledging delivery
    const second = await owner.exec("test.forget", { commandIds: [wear.commandId, amendment.commandId, remind.commandId] });
    expect(second.result).toMatchObject({ scrubbedCommandIds: [], pendingEffects: [], pendingOutbox: 0, ledgerCopiesErased: true });
    expect((second.result.alreadyScrubbed as string[]).sort()).toEqual([wear.commandId, amendment.commandId, remind.commandId].sort());
    expect(await ledgerText(h, owner)).not.toContain(SECRET_EFFECT);
  });

  it("touches only the caller's own commands", async () => {
    const { h, owner } = await setup();
    const other = await h.createSyntheticOwner({ displayName: "Synthetic owner B" });
    const theirs = await other.exec("wear.record", { wearingDate: "2026-09-15", garmentIds: ["shirt-moss"], note: SECRET_NOTE });
    const forget = await owner.exec("test.forget", { commandIds: [theirs.commandId] });
    expect(forget.result).toMatchObject({ scrubbedCommandIds: [], unknownCommandIds: [theirs.commandId] });
    expect((await h.service.getReceipt(other.principal(), theirs.commandId))!.summary).not.toBe(SCRUBBED_TEXT);
    expect((await first<{ note: string }>(h.db, "SELECT note FROM wear_observations WHERE user_id = ?", other.userId))!.note).toBe(SECRET_NOTE);
  });
});
