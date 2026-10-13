/**
 * The committed ORDINARY-USE corpus, run on the owner's REAL imported profile and inventory through the
 * real conversation Durable Object, real local D1 and the shared command service. The only stand-in is the
 * labelled FAKE MODEL, scripted as an honest model doing what the owner asked. The corpus is in
 * src/testing/corpora.ts: the 28 ordinary requests of the independent re-review and further everyday
 * questions and asks. Nothing may be refused: a report naming its pieces and the 8 allow-listed owner-worded
 * sentence forms apply at once with a receipt and can be undone; a report naming no piece and any unlisted
 * phrasing stay one-tap requests for the owner to confirm in the app.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { all } from "@garderobe/domain";
import { ORDINARY_CASES } from "../src/testing/index.ts";
import { confirm, corpusContext, createWorld, submission, undoTurn, type World } from "./helpers.ts";

/** Commands with no automatic undo: applied at once, and their receipt says so (contract section 4). */
const NO_AUTOMATIC_UNDO = new Set(["measurement.record"]);

describe("ordinary-use corpus: reports and owner-worded changes apply at once, nothing is refused (REAL owner; honest fake model)", () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
  });

  it(`handles all ${ORDINARY_CASES.length} ordinary requests with zero refusals`, async () => {
    expect(ORDINARY_CASES.length).toBeGreaterThanOrEqual(28);
    const ctx = corpusContext(w);
    const failures: string[] = [];
    const tally = { recorded: 0, proposed: 0, answered: 0 };
    for (const c of ORDINARY_CASES) {
      const calls = await c.calls(ctx);
      if (calls.length > 0) w.model.script({ toolCalls: calls }, { text: "Done as far as I may; see the request to confirm if there is one." });
      else w.model.script({ text: "Here is my answer." });
      const turn = await w.client.runTurn({ submissionId: submission(c.id), text: c.ownerText });
      if (turn.status !== "completed") failures.push(`${c.id}: status ${turn.status}`);
      if (turn.refusals.length > 0) failures.push(`${c.id}: refused ${turn.refusals.map((r) => `${r.code} (${r.message})`).join("; ")}`);
      if (c.expect.outcome === "recorded") {
        if (turn.receipts.map((r) => r.type).join() !== c.expect.type || turn.proposals.length > 0) failures.push(`${c.id}: expected a ${c.expect.type} receipt, got receipts [${turn.receipts.map((r) => r.type)}] proposals [${turn.proposals.map((x) => x.type)}]`);
        else tally.recorded++;
      } else if (c.expect.outcome === "proposed") {
        if (turn.proposals.map((x) => x.type).join() !== c.expect.type || turn.receipts.length > 0) failures.push(`${c.id}: expected a ${c.expect.type} proposal, got receipts [${turn.receipts.map((r) => r.type)}] proposals [${turn.proposals.map((x) => x.type)}]`);
        else tally.proposed++;
      } else if (turn.receipts.length > 0 || turn.proposals.length > 0 || !turn.reply?.text) failures.push(`${c.id}: expected only an answer`);
      else tally.answered++;
    }
    expect(failures).toEqual([]);
    expect(tally.recorded + tally.proposed + tally.answered).toBe(ORDINARY_CASES.length);
    expect(tally.recorded).toBe(17);
    expect(tally.proposed).toBe(24);
  });

  it("every change the corpus applied at once can be undone by the owner, except those whose receipt says there is no automatic undo", async () => {
    const fresh = await createWorld();
    const ctx = corpusContext(fresh);
    const snapshot = async () => ({
      garments: await all(fresh.h.db, "SELECT garment_id, name, acquisition, condition, planning_policy FROM garments WHERE user_id = ? AND acquisition <> 'disposed' ORDER BY garment_id", fresh.owner.userId),
      balances: await all(fresh.h.db, "SELECT garment_id, bucket, quantity FROM stock_balances WHERE user_id = ? AND quantity > 0 ORDER BY garment_id, bucket", fresh.owner.userId),
      wears: await all(fresh.h.db, "SELECT wearing_date, garment_id FROM daily_wears WHERE user_id = ? AND status = 'active' ORDER BY wearing_date, garment_id", fresh.owner.userId),
      aliases: await all(fresh.h.db, "SELECT garment_id, phrase FROM garment_aliases WHERE user_id = ? AND removed_at IS NULL ORDER BY garment_id, phrase", fresh.owner.userId),
      directions: await all(fresh.h.db, "SELECT direction_id, text FROM standing_directions WHERE user_id = ? AND status = 'active' ORDER BY direction_id", fresh.owner.userId),
      amendments: await all(fresh.h.db, "SELECT amendment_id, text FROM style_amendments WHERE user_id = ? AND status = 'active' ORDER BY amendment_id", fresh.owner.userId),
      restrictions: await all(fresh.h.db, "SELECT restriction_id, status FROM restrictions WHERE user_id = ? ORDER BY restriction_id", fresh.owner.userId),
      orderLines: await all(fresh.h.db, "SELECT order_id, line_id, state, delivered_on FROM order_lines WHERE user_id = ? ORDER BY order_id, line_id", fresh.owner.userId),
    });
    const failures: string[] = [];
    let undone = 0;
    for (const c of ORDINARY_CASES.filter((x) => x.expect.outcome === "recorded")) {
      const before = await snapshot();
      fresh.model.script({ toolCalls: await c.calls(ctx) }, { text: "Done." });
      const turn = await fresh.client.runTurn({ submissionId: submission(c.id), text: c.ownerText });
      if (turn.status !== "completed") failures.push(`${c.id}: status ${turn.status}`);
      if (turn.receipts.map((r) => r.type).join() !== (c.expect as { type: string }).type) {
        failures.push(`${c.id}: expected ${(c.expect as { type: string }).type} receipt, got [${turn.receipts.map((r) => r.type)}]`);
      }
      for (const r of turn.receipts) {
        if (NO_AUTOMATIC_UNDO.has(r.type)) {
          if (r.undoAvailable) failures.push(`${c.id}: ${r.type} claims an undo`);
        } else if (!r.undoAvailable) failures.push(`${c.id}: ${r.type} offers no undo`);
      }
      const undoableReceipts = turn.receipts.filter((r) => !NO_AUTOMATIC_UNDO.has(r.type));
      const result = await undoTurn(fresh, { receipts: undoableReceipts } as never, `undo-${c.id}`);
      failures.push(...result.notUndone.map((x) => `${c.id}: ${x}`));
      undone += result.undone.length;
      if (undoableReceipts.length === turn.receipts.length && JSON.stringify(await snapshot()) !== JSON.stringify(before)) {
        failures.push(`${c.id}: undo did not restore pre-change state`);
      }
    }
    expect(failures).toEqual([]);
    expect(undone).toBeGreaterThanOrEqual(15);
  });

  it("each request the corpus still leaves (a report naming no piece or an unlisted phrasing) can be confirmed by the owner and then takes effect", async () => {
    const fresh = await createWorld();
    const ctx = corpusContext(fresh);
    const failures: string[] = [];
    let confirmed = 0;
    for (const c of ORDINARY_CASES.filter((x) => x.expect.outcome === "proposed")) {
      fresh.model.script({ toolCalls: await c.calls(ctx) }, { text: "Recorded as a request." });
      const turn = await fresh.client.runTurn({ submissionId: submission(c.id), text: c.ownerText });
      try {
        const receipt = await confirm(fresh, turn);
        if (receipt.type !== turn.proposals[0]!.type) failures.push(`${c.id}: receipt type ${receipt.type}`);
        confirmed++;
      } catch (e) {
        failures.push(`${c.id}: confirmation failed: ${(e as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
    const proposedCases = ORDINARY_CASES.filter((x) => x.expect.outcome === "proposed");
    expect(proposedCases.length).toBe(24);
    expect(confirmed).toBe(proposedCases.length);
    // Each confirmed change is on the ledger as the owner's own tap, traced to the turn that proposed it.
    const taps = await all<{ source_json: string }>(fresh.h.db, "SELECT source_json FROM commands WHERE user_id = ? AND authorization_basis = 'owner_tap' AND actor = 'owner' AND json_extract(source_json, '$.parentKind') = 'turn'", fresh.owner.userId);
    expect(taps.length).toBe(confirmed);
  });
});
