import { evictDurableObject, env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { beforeAll, describe, expect, it } from "vitest";
import { all, listCountedWears, listRestrictions } from "@garderobe/domain";
import { ownerDocuments } from "@garderobe/domain/testing";
import { createWorld, submission, type World } from "./helpers.ts";

describe("conversation in the Durable Object (real Think session, real D1, real owner data, FAKE MODEL at the model boundary)", () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
  });

  it("gives the model the complete owner profile, the wardrobe and the restrictions on every turn, even when it calls no tools", async () => {
    w.model.script({ text: "Morning. Sneakers only for now." });
    const turn = await w.client.runTurn({ submissionId: submission(), text: "what socks go with grey trainers?" });
    expect(turn.status).toBe("completed");
    expect(turn.reply?.text).toBe("Morning. Sneakers only for now.");
    const seen = w.model.requests.at(-1)!;
    // The complete profile, verbatim - not a summary - on a short sock question.
    expect(seen.system).toContain(ownerDocuments().profileText.trim());
    expect(seen.system).toContain("Sneakers only");
    expect(seen.system).toContain("ACTIVE RESTRICTIONS");
    expect(seen.system).toContain("NB 990v4");
    expect(seen.system).toContain("Precedence");
    // The mandatory context names every garment record, so a model that reads nothing still has the wardrobe.
    const garments = await all<{ garment_id: string }>(w.h.db, "SELECT garment_id FROM garments WHERE user_id = ?", w.owner.userId);
    expect(garments.length).toBeGreaterThan(50);
    for (const g of garments) expect(seen.system).toContain(g.garment_id);
    expect(seen.toolNames).toContain("record_wear");
    expect(seen.toolNames).not.toContain("bash");
  });

  it("turns an owner statement into one domain command with a receipt written by the ledger, not by the model", async () => {
    const shoe = await w.garment("990v4");
    w.model.script(
      { toolCalls: [{ toolName: "record_wear", input: { garmentIds: [shoe.garmentId], ownerQuote: "I wore the grey 990s today" } }] },
      { text: "MODEL PROSE: I have totally reorganised your wardrobe." },
    );
    const turn = await w.client.runTurn({ submissionId: submission(), text: "I wore the grey 990s today" });
    expect(turn.status).toBe("completed");
    expect(turn.receipts).toHaveLength(1);
    const receipt = turn.receipts[0]!;
    expect(receipt.type).toBe("wear.record");
    // The receipt summary is the command handler's text; the model's prose is only the reply.
    const stored = await w.h.service.getReceipt(w.owner.principal(), receipt.commandId);
    expect(receipt.summary).toBe(stored!.summary);
    expect(receipt.summary).not.toContain("MODEL PROSE");
    expect(stored!.actor).toBe("assistant");
    expect(stored!.channel).toBe("ios");
    const wears = await listCountedWears(w.h.db, w.owner.principal(), { from: "2026-09-15", to: "2026-09-15" });
    expect(wears.filter((x) => x.garmentId === shoe.garmentId)).toHaveLength(1);
    // The tool result the model saw carried the ledger's summary.
    const toolResult = w.model.requests.at(-1)!.toolResults.at(-1)!;
    expect(JSON.stringify(toolResult.output)).toContain(stored!.summary);
  });

  it("returns the same turn for a retransmitted submission and rejects the same ID with a different body", async () => {
    const id = submission("retry");
    w.model.script({ text: "first answer" });
    const first = await w.client.runTurn({ submissionId: id, text: "is the tweed blazer clean?" });
    const before = w.model.requests.length;
    const again = await w.client.runTurn({ submissionId: id, text: "is the tweed blazer clean?" });
    expect(again.turnId).toBe(first.turnId);
    expect(again.accepted).toBe(false);
    expect(again.reply?.text).toBe("first answer");
    expect(w.model.requests.length).toBe(before); // no second inference
    await expect(w.client.runTurn({ submissionId: id, text: "something else entirely" })).rejects.toThrow(/already used/);
  });

  it("keeps the original transcript, the turn record and its receipts across eviction of the actor", async () => {
    const before = await w.client.transcript({ limit: 100 });
    expect(before.messages.length).toBeGreaterThanOrEqual(6);
    const stub: any = await getAgentByName((env as any).ASSISTANT, w.owner.userId);
    await evictDurableObject(stub as never);
    const after = await w.client.transcript({ limit: 100 });
    expect(after.messages.map((m) => m.messageId)).toEqual(before.messages.map((m) => m.messageId));
    expect(after.messages.map((m) => m.text)).toEqual(before.messages.map((m) => m.text));
    expect(after.messages[0]!.role).toBe("user");
    expect(after.messages[0]!.text).toBe("what socks go with grey trainers?");
    expect(after.messages[0]!.channel).toBe("ios");
    // A turn started after the restart still sees the earlier conversation.
    w.model.script({ text: "still here" });
    await w.client.runTurn({ submissionId: submission(), text: "and tomorrow?" });
    const seen = w.model.requests.at(-1)!;
    expect(seen.messages.some((m) => m.text.includes("what socks go with grey trainers?"))).toBe(true);
  });

  it("does not mint a second command when a resampled model proposes the same effect under a new tool-call ID", async () => {
    const shirt = await w.garment("California plaid");
    const call = { toolName: "mark_dirty", input: { garmentIds: [shirt.garmentId], ownerQuote: "the California plaid is filthy" } };
    w.model.script({ toolCalls: [{ ...call, toolCallId: "call_A" }] }, { toolCalls: [{ ...call, toolCallId: "call_B_resampled" }] }, { text: "Noted." });
    const turn = await w.client.runTurn({ submissionId: submission(), text: "the California plaid is filthy" });
    expect(turn.receipts).toHaveLength(1);
    const commands = await all(w.h.db, "SELECT command_id FROM commands WHERE user_id = ? AND type = 'care.mark_dirty'", w.owner.userId);
    expect(commands).toHaveLength(1);
  });

  it("serves a read-only connection with proposals instead of writes", async () => {
    const shoe = await w.garment("990v4");
    const reader = w.clientFor(w.owner.principal({ channel: "mcp", scopes: ["read"] }));
    const count = async () => (await all(w.h.db, "SELECT command_id FROM commands WHERE user_id = ? AND type = 'wear.record'", w.owner.userId)).length;
    const before = await count();
    w.model.script({ toolCalls: [{ toolName: "record_wear", input: { garmentIds: [shoe.garmentId], wearingDate: "2026-09-14", ownerQuote: "log that I wore the grey 990s yesterday" } }] }, { text: "I cannot change anything on this connection; I have proposed it." });
    const turn = await reader.runTurn({ submissionId: submission(), text: "log that I wore the grey 990s yesterday" });
    expect(turn.receipts).toHaveLength(0);
    expect(turn.proposals).toHaveLength(1);
    expect(turn.proposals[0]!.type).toBe("wear.record");
    expect(await count()).toBe(before);
    expect(turn.channel).toBe("mcp");
  });

  it("keeps the healing restriction in force and visible", async () => {
    const restrictions = await listRestrictions(w.h.db, w.owner.principal(), { status: "active" });
    expect(restrictions.some((r) => r.kind === "healing")).toBe(true);
  });
});
