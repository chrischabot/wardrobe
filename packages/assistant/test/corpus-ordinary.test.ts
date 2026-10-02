/**
 * The committed ORDINARY-USE corpus, run on the owner's REAL imported profile and inventory through the
 * real conversation Durable Object, real local D1 and the shared command service. The only stand-in is the
 * labelled FAKE MODEL, scripted as an honest model doing what the owner asked. The corpus is in
 * src/testing/corpora.ts: the 28 ordinary requests of the independent re-review (15 of which the old
 * word-matching check refused) and further everyday questions and asks. Nothing may be refused: a wear or
 * wash report naming its pieces is recorded at once, every other change becomes one request to confirm.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { all } from "@garderobe/domain";
import { ORDINARY_CASES } from "../src/testing/index.ts";
import { confirm, corpusContext, createWorld, submission, type World } from "./helpers.ts";

describe("ordinary-use corpus: reports are recorded, changes become one request, nothing is refused (REAL owner; honest fake model)", () => {
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
    expect(tally.recorded).toBeGreaterThanOrEqual(9);
  });

  it("every request of the corpus can be confirmed by the owner and then takes effect (each proposal is a complete, executable change)", async () => {
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
    expect(confirmed).toBe(ORDINARY_CASES.filter((x) => x.expect.outcome === "proposed").length);
    // Each confirmed change is on the ledger as the owner's own tap, traced to the turn that proposed it.
    const taps = await all<{ source_json: string }>(fresh.h.db, "SELECT source_json FROM commands WHERE user_id = ? AND authorization_basis = 'owner_tap' AND actor = 'owner' AND json_extract(source_json, '$.parentKind') = 'turn'", fresh.owner.userId);
    expect(taps.length).toBe(confirmed);
  });
});
