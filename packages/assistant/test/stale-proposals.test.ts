/**
 * A request the owner confirms is the request they were shown. Every proposal that rewrites, moves,
 * receives or removes a wardrobe piece carries the piece's version as read when the proposal was made, and
 * confirming it after the piece changed is refused with `conflict` and writes nothing.
 *
 * Real conversation Durable Object, real local D1, the shared command service (which makes the refusal)
 * and the owner's REAL imported inventory. The only stand-in is the labelled FAKE MODEL. The owner's
 * confirmation is carried out as the Worker's owner-only route does it (`confirm` in helpers.ts); the same
 * cases run through the route itself in apps/worker/test/assistant-confirmation.test.ts.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { all } from "@garderobe/domain";
import { confirm, createWorld, submission, type World } from "./helpers.ts";

describe("a proposal about a wardrobe piece is refused as stale when the piece changed before the owner confirmed", () => {
  let w: World;

  /** Everything a confirmed proposal could have written about the piece. */
  const stateOf = async (garmentId: string) => ({
    record: (await all<{ acquisition: string; condition: string | null }>(w.h.db, "SELECT acquisition, condition FROM garments WHERE user_id = ? AND garment_id = ?", w.owner.userId, garmentId))[0],
    stockEvents: (await all(w.h.db, "SELECT 1 FROM stock_events WHERE user_id = ? AND garment_id = ?", w.owner.userId, garmentId)).length,
    aliases: (await all(w.h.db, "SELECT 1 FROM garment_aliases WHERE user_id = ? AND garment_id = ? AND removed_at IS NULL", w.owner.userId, garmentId)).length,
    projectEvents: (await all(w.h.db, "SELECT 1 FROM lifecycle_events WHERE user_id = ?", w.owner.userId)).length,
  });
  const storedVersions = async (turnId: string) => (JSON.parse((await all<{ proposals_json: string }>(w.h.db, "SELECT proposals_json FROM assistant_turns WHERE user_id = ? AND turn_id = ?", w.owner.userId, turnId))[0]!.proposals_json) as { expectedVersions?: Record<string, number> }[])[0]!.expectedVersions ?? {};

  beforeAll(async () => {
    w = await createWorld();
  });

  interface Case {
    label: string;
    type: string;
    ownerText: string;
    /** The piece the proposal is about, and the tool call the (fake) model makes for it. */
    setup(): Promise<{ garmentId: string; toolName: string; input: Record<string, unknown> }>;
  }

  const cases: Case[] = [
    {
      label: "retiring a piece",
      type: "garment.retire",
      ownerText: "I gave the California plaid away.",
      setup: async () => {
        const g = await w.garment("California plaid");
        return { garmentId: g.garmentId, toolName: "retire_garment", input: { garmentId: g.garmentId, disposition: "donated" } };
      },
    },
    {
      label: "moving a piece to storage",
      type: "garment.move",
      ownerText: "The Paraboot Michael went into storage.",
      setup: async () => {
        const g = await w.garment("Paraboot Michael");
        return { garmentId: g.garmentId, toolName: "move_garment", input: { garmentId: g.garmentId, to: "storage" } };
      },
    },
    {
      label: "receiving an ordered piece",
      type: "assistant.report_arrival",
      ownerText: "The grey lambswool scarf arrived.",
      setup: async () => {
        // SYNTHETIC incoming piece (the real inventory has none on order); added by the owner in the app.
        const created = await w.owner.exec("garment.create", { name: "Grey lambswool scarf (synthetic test piece)", category: "accessory", roles: ["accessory"], careChannel: "none", acquisition: "incoming", quantity: 1, source: { kind: "owner_statement" } });
        const garmentId = String(created.result["garmentId"]);
        return { garmentId, toolName: "report_arrival", input: { garmentId } };
      },
    },
    {
      label: "giving a piece another name",
      type: "garment.add_alias",
      ownerText: "Call the Drake's Clifford boot my winter boots.",
      setup: async () => {
        const g = await w.garment("Clifford boot");
        return { garmentId: g.garmentId, toolName: "add_alias", input: { garmentId: g.garmentId, phrase: "winter boots" } };
      },
    },
    {
      label: "a project event that discards its piece",
      type: "lifecycle.record_event",
      ownerText: "I threw the grey flannel plaid shirt away.",
      setup: async () => {
        const g = await w.garment("Flannel plaid");
        const project = await w.owner.exec("lifecycle.open_project", { kind: "disposal", title: "Bin the flannel plaid", items: [{ garmentId: g.garmentId }] });
        return { garmentId: g.garmentId, toolName: "record_project_event", input: { projectId: String(project.result["projectId"]), kind: "discarded" } };
      },
    },
  ];

  it.each(cases)("$label: refused with conflict and nothing written; asked again against the current record, it goes through", async (c) => {
    const { garmentId, toolName, input } = await c.setup();
    const ask = async () => {
      w.model.script({ toolCalls: [{ toolName, input }] }, { text: "Recorded as a request to confirm." });
      const turn = await w.client.runTurn({ submissionId: submission("stale"), text: c.ownerText });
      expect(turn.receipts).toEqual([]);
      expect(turn.proposals.map((x) => x.type)).toEqual([c.type]);
      return turn;
    };

    const turn = await ask();
    const version = (await all<{ version: number }>(w.h.db, "SELECT version FROM garments WHERE user_id = ? AND garment_id = ?", w.owner.userId, garmentId))[0]!.version;
    expect(await storedVersions(turn.turnId)).toMatchObject({ [`garment:${garmentId}`]: version });

    // The owner changes the piece in the app before looking at the request.
    await w.owner.exec("garment.correct", { garmentId, changes: { condition: `changed after the request (${c.type})` }, source: { kind: "owner_statement" } });
    const before = await stateOf(garmentId);
    await expect(confirm(w, turn)).rejects.toMatchObject({ code: "conflict" });
    expect(await stateOf(garmentId)).toEqual(before);

    // Not refused for some other reason: the same request made against the current record is carried out.
    const receipt = await confirm(w, await ask());
    expect(receipt).toMatchObject({ type: c.type, outcome: "committed" });
    expect(await stateOf(garmentId)).not.toEqual(before);
  });
});
