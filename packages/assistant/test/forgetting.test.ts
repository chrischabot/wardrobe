/**
 * Forgetting is complete, and its receipt is true. Real conversation Durable Object (Think session), real
 * local D1, the shared command service with the foundation's ledger scrub, and the owner's REAL imported
 * profile and inventory. Stand-ins: the labelled FAKE MODEL; no AI Search index is bound (so that store is
 * reported as still pending, never as erased).
 *
 * The check does not rely on a list of tables written here: `tablesHolding` asks the database for every
 * table with a text column and scans all of them, so a table added by any workstream's later migration is
 * covered.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { all } from "@garderobe/domain";
import { exportAssistantData, listForgetStates, runAssistantMaintenance } from "../src/index.ts";
import { TEST_GATEWAY_ID, fakeModelFor } from "../src/testing/index.ts";
import { confirm, createWorld, submission, tablesHolding, type World } from "./helpers.ts";

const MARK = /zanzibar|chemotherap/i;
const SAID = "The navy Pima oxford collar gives me a rash since my Zanzibar chemotherapy.";

describe("forgetting a message removes its text from every store, and says truthfully what it kept", () => {
  let w: World;
  const p = () => w.owner.principal();

  /** Every place outside D1's tables where the text could still be read: the actor's own stores and what is served or sent. */
  async function servedCopies(world: World, turnIds: string[]): Promise<string[]> {
    world.model.script({ text: "Good morning." });
    const next = await world.client.runTurn({ submissionId: submission("after"), text: "Good morning." });
    const stores: Record<string, unknown> = {
      transcript: await world.client.transcript({ limit: 200 }),
      conversationExport: await world.client.exportConversation(),
      conversationBackup: await world.client.backupConversation(),
      assistantExport: await exportAssistantData(world.h.db, world.owner.principal()),
      recall: await world.client.recallSearch({ text: "Zanzibar chemotherapy rash collar" }),
      turns: await Promise.all(turnIds.map((id) => world.client.getTurn(id))),
      turnEvents: await Promise.all(turnIds.map((id) => world.client.turnEvents(id))),
      // The complete request of the next model call: system prompt with the mandatory context, and the history.
      nextModelCall: world.model.requests.at(-1)!.raw.prompt,
      nextTurn: next,
    };
    return Object.entries(stores).filter(([, v]) => MARK.test(JSON.stringify(v))).map(([k]) => k);
  }

  beforeAll(async () => {
    w = await createWorld();
  });

  it("everything the assistant recorded or proposed from the message, the reply, a later repetition and the ledger's own copies are gone from every table and from everything served", async () => {
    const oxford = await w.garment("Pima oxford — navy");
    const cords = await w.garment("Stratton stretch corduroy");
    w.model.script(
      {
        toolCalls: [
          // Recorded at once: a comfort note in the owner's own words, and the assistant's bookkeeping.
          { toolName: "record_comfort_feedback", input: { kind: "scratchy", garmentIds: [oxford.garmentId] } },
          { toolName: "save_research_note", input: { topic: "Collar rash after Zanzibar chemotherapy", body: "The owner said the collar gives a rash since the Zanzibar chemotherapy.", claims: [] } },
          { toolName: "save_shopping_candidate", input: { name: "Soft-collar shirt for the Zanzibar chemotherapy rash", note: "because of the chemotherapy" } },
          { toolName: "remember", input: { kind: "fact", text: "Collars give a rash since the Zanzibar chemotherapy", saidByOwner: false } },
          { toolName: "start_background_work", input: { kind: "other", title: "Soft collars after Zanzibar chemotherapy", params: { note: "chemotherapy rash" } } },
          // Proposed, never confirmed.
          { toolName: "amend_profile", input: { text: "The oxford collar gives me a rash since my Zanzibar chemotherapy", kind: "physical_state" } },
          { toolName: "add_standing_direction", input: { text: "No stiff collars since the Zanzibar chemotherapy" } },
          { toolName: "set_day_brief", input: { localDate: "2026-09-16", text: "Soft collar: Zanzibar chemotherapy rash" } },
          { toolName: "set_reminder", input: { kind: "other", title: "Tailor about the Zanzibar chemotherapy collar", dueAt: "2026-09-18T09:00:00Z" } },
          { toolName: "add_garment", input: { name: "Zanzibar chemotherapy soft shirt", category: "shirt", state: "owned" } },
          { toolName: "add_alias", input: { garmentId: oxford.garmentId, phrase: "the Zanzibar chemotherapy shirt" } },
          { toolName: "open_return", input: { kind: "return", garmentId: cords.garmentId, reason: "rash since the Zanzibar chemotherapy" } },
          { toolName: "correct_garment", input: { garmentId: oxford.garmentId, changes: { condition: "collar causes rash (Zanzibar chemotherapy)" } } },
        ],
      },
      { text: "I am sorry to hear the collar gives you a rash since your Zanzibar chemotherapy. I noted it." },
    );
    const told = await w.client.runTurn({ submissionId: submission("told"), text: `${SAID} Remind me to see the tailor.` });
    expect(told.receipts.map((r) => r.type).sort()).toEqual(["feedback.record", "job.create", "memory.record_conclusion", "product.record", "research.save_note"]);
    expect(told.proposals).toHaveLength(8);

    // A later turn in which the assistant repeats it (and a recall tool result carries it).
    w.model.script({ toolCalls: [{ toolName: "recall_conversation", input: { text: "collar rash" } }] }, { text: "You told me the oxford collar gives you a rash since your Zanzibar chemotherapy." });
    const repeated = await w.client.runTurn({ submissionId: submission("repeated"), text: "What did I tell you about my collar?" });
    await runAssistantMaintenance({ db: w.h.db, service: w.h.service, env: env as never, gatewayId: TEST_GATEWAY_ID, nowMs: w.h.clock.now() }, { limit: 500 });

    // Before: the text is in many tables and in everything served.
    const before = await tablesHolding(w.h.db, w.owner.userId, MARK);
    expect(Object.keys(before.holding)).toEqual(expect.arrayContaining(["action_intents", "assistant_jobs", "assistant_turn_events", "assistant_turns", "comfort_feedback", "commands", "conversation_index", "memory_conclusions", "products", "research_notes"]));
    expect((await servedCopies(w, [told.turnId, repeated.turnId])).length).toBeGreaterThan(5);

    // The owner asks to forget it. That is itself a request the owner confirms; nothing is forgotten before.
    const userMessage = (await w.client.transcript({ limit: 200 })).messages.find((m) => m.turnId === told.turnId && m.role === "user")!;
    w.model.script({ toolCalls: [{ toolName: "forget", input: { sourceKind: "message", sourceIds: [userMessage.messageId] } }] }, { text: "I have recorded that as a request for you to confirm." });
    const asked = await w.client.runTurn({ submissionId: submission("forget"), text: "Please forget what I told you about my health earlier." });
    expect(asked.receipts).toEqual([]);
    expect(asked.proposals.map((x) => x.type)).toEqual(["conversation.forget_source"]);
    expect(asked.proposals[0]!.summary).not.toMatch(MARK);
    expect(Object.keys((await tablesHolding(w.h.db, w.owner.userId, MARK)).holding).length).toBeGreaterThan(8);

    const receipt = await confirm(w, asked);
    await w.client.reconcileErasures();
    await w.client.rebuildSanitizedSession();
    await runAssistantMaintenance({ db: w.h.db, service: w.h.service, env: env as never, gatewayId: TEST_GATEWAY_ID, nowMs: w.h.clock.now() }, { limit: 500 });

    // After: no table of the database holds it, whichever workstream owns the table.
    const after = await tablesHolding(w.h.db, w.owner.userId, MARK);
    expect(after.holding).toEqual({});
    expect(after.scanned).toEqual(expect.arrayContaining(["commands", "action_intents", "effects", "outbox", "style_amendments", "standing_directions", "temporary_briefs", "garments", "garment_aliases", "orders", "order_lines", "products", "return_cases", "assistant_jobs", "assistant_turns", "assistant_turn_events", "conversation_index", "conversation_judgements", "memory_conclusions", "research_notes", "comfort_feedback", "reminders", "compaction_checkpoints", "source_tombstones"]));
    expect(after.scanned.length).toBeGreaterThanOrEqual(before.scanned.length);
    // And nothing served, exported, backed up, recalled or sent to the model holds it.
    expect(await servedCopies(w, [told.turnId, repeated.turnId, asked.turnId])).toEqual([]);

    // The receipt is true. It names what was removed, what is still being removed and that nothing was kept.
    expect(receipt.summary).not.toMatch(/hidden everywhere/i);
    expect(receipt.summary).toMatch(/^Forgotten: 1 message and \d+ later repl/);
    expect(receipt.summary).toContain("Still being removed from transcript, summaries, ai search");
    expect(receipt.summary).not.toContain("Kept");
    expect(receipt.result["kept"]).toEqual([]);
    expect(receipt.result["erasedStores"]).toEqual(["retrieval_index", "ledger"]);
    expect(Number(receipt.result["scrubbedCommands"])).toBeGreaterThanOrEqual(5);
    // The later repetition was found and forgotten with it.
    expect((receipt.result["alsoForgotten"] as string[]).length).toBeGreaterThanOrEqual(2);
    // Per store: the transcript is erased once the actor confirmed it; AI Search stays pending (no index is bound here), and says so.
    const state = (await listForgetStates(w.h.db, p())).find((x) => x.sourceId === userMessage.messageId)!;
    expect(state.erasedStores).toEqual(expect.arrayContaining(["retrieval_index", "ledger", "transcript"]));
    expect(state.pendingStores).toContain("ai_search");
    expect(state.state).toBe("suppressed");
    // What the turn did is still known as facts without text: the comfort note's command exists, scrubbed.
    const scrubbed = await all<{ type: string; payload_json: string }>(w.h.db, "SELECT type, payload_json FROM commands WHERE user_id = ? AND scrubbed_at IS NOT NULL", w.owner.userId);
    expect(scrubbed.map((c) => c.type)).toEqual(expect.arrayContaining(["feedback.record", "research.save_note", "product.record", "memory.record_conclusion", "job.create"]));
    expect(scrubbed.every((c) => c.payload_json === '{"forgotten":true}')).toBe(true);
    // The unconfirmed requests are gone: there is nothing left to confirm from that turn.
    expect((await w.client.getTurn(told.turnId))!.proposals).toEqual([]);
  });

  it("records the owner confirmed from the message are kept, named on the receipt, and are the only tables still holding the text", async () => {
    const k = await createWorld();
    k.model.script(
      { toolCalls: [{ toolName: "amend_profile", input: { text: "The oxford collar gives me a rash since my Zanzibar chemotherapy", kind: "physical_state" } }, { toolName: "add_garment", input: { name: "Zanzibar chemotherapy soft shirt", category: "shirt", state: "owned" } }, { toolName: "set_reminder", input: { kind: "other", title: "Tailor about the Zanzibar chemotherapy collar", dueAt: "2026-09-18T09:00:00Z" } }] },
      { text: "Recorded as requests." },
    );
    const told = await k.client.runTurn({ submissionId: submission("kept"), text: SAID });
    expect(told.proposals).toHaveLength(3);
    for (const n of [0, 1, 2]) await confirm(k, told, n);
    const userMessage = (await k.client.transcript({ limit: 50 })).messages.find((m) => m.turnId === told.turnId && m.role === "user")!;

    const receipt = await k.owner.exec("conversation.forget_source", { sourceKind: "message", sourceIds: [userMessage.messageId] });
    await k.client.reconcileErasures();
    await k.client.rebuildSanitizedSession();

    const kept = receipt.result["kept"] as { kind: string; id: string }[];
    expect(kept.map((x) => x.kind).sort()).toEqual(["garment", "style_amendment"]);
    expect(receipt.summary).toContain("Kept, because you confirmed them as records of your own: 1 profile amendment, 1 wardrobe record. Remove them in the app if they should go too");
    // The reminder was the message's own request: it is cancelled and its text removed, and the receipt counts it.
    expect(Number(receipt.result["assistantRecords"])).toBe(1);
    expect(await all(k.h.db, "SELECT 1 FROM reminders WHERE user_id = ? AND status != 'cancelled'", k.owner.userId)).toEqual([]);
    // Exactly the kept records still hold the text; the ledger's copies of the commands that wrote them do not.
    expect((await tablesHolding(k.h.db, k.owner.userId, MARK)).holding).toEqual({ garment_aliases: ["normalized", "phrase"], garments: ["name"], style_amendments: ["text"] });
    // The owner removes the kept amendment in the app; then only the wardrobe record he chose to keep has it.
    await k.owner.exec("style.set_amendment_status", { amendmentId: kept.find((x) => x.kind === "style_amendment")!.id, status: "retired" });
  });

  it("forgetting a research request removes the topic from the task actor, the job, the result card in the main conversation and everything served", async () => {
    const r = await createWorld({ real: false, probes: ["deepseek-v41-flash", "fable-5-1"] });
    fakeModelFor("fable-5-1").script({ text: "Nothing conclusive about the Zanzibar chemotherapy clinic." });
    const started = await r.client.startResearch({ submissionId: submission("research"), topic: "History of the Zanzibar chemotherapy clinic I attend", kind: "history" });
    for (let i = 0; i < 400 && (await r.client.getTurn(started.turnId))!.status !== "completed"; i++) await new Promise((x) => setTimeout(x, 25));
    await runAssistantMaintenance({ db: r.h.db, service: r.h.service, env: env as never, gatewayId: TEST_GATEWAY_ID, nowMs: r.h.clock.now() }, { limit: 500 });
    // The result card is in the main conversation, titled with the topic.
    expect((await r.client.transcript({ limit: 50 })).messages.some((m) => MARK.test(m.text))).toBe(true);
    expect(Object.keys((await tablesHolding(r.h.db, r.owner.userId, MARK)).holding)).toEqual(expect.arrayContaining(["assistant_jobs", "commands"]));
    const task = async () => (await getAgentByName((env as unknown as { ASSISTANT: never }).ASSISTANT, `${r.owner.userId}::research::${started.turnId}`)) as unknown as { transcript(o: object): Promise<{ total: number }> };
    expect((await (await task()).transcript({})).total).toBeGreaterThan(0);

    const turnRow = (await all<{ user_message_id: string }>(r.h.db, "SELECT user_message_id FROM assistant_turns WHERE user_id = ? AND turn_id = ?", r.owner.userId, started.turnId))[0]!;
    const receipt = await r.owner.exec("conversation.forget_source", { sourceKind: "message", sourceIds: [turnRow.user_message_id] });
    await r.client.reconcileErasures();
    await r.client.rebuildSanitizedSession();
    await new Promise((x) => setTimeout(x, 100));

    expect((await (await task()).transcript({})).total).toBe(0);
    expect((await tablesHolding(r.h.db, r.owner.userId, MARK)).holding).toEqual({});
    expect((receipt.result["alsoForgotten"] as string[]).length).toBeGreaterThanOrEqual(1);
    expect(await servedCopies(r, [started.turnId])).toEqual([]);
  });

  it("a message the owner forgets directly needs no model: a plain exchange is erased from the ledger at once and a second request is a no-op", async () => {
    w.model.script({ text: "The heath is lovely in October." });
    const chat = await w.client.runTurn({ submissionId: submission("plain"), text: "I walked across the heath to see my solicitor about the lease" });
    const message = (await w.client.transcript({ limit: 200 })).messages.find((m) => m.turnId === chat.turnId && m.role === "user")!;
    const first = await w.owner.exec("conversation.forget_source", { sourceKind: "message", sourceIds: [message.messageId] });
    expect(first.result["erasedStores"]).toEqual(["retrieval_index", "ledger"]);
    expect((await tablesHolding(w.h.db, w.owner.userId, /solicitor/i)).holding).toEqual({});
    const again = await w.owner.exec("conversation.forget_source", { sourceKind: "message", sourceIds: [message.messageId] });
    expect(again.outcome).toBe("noop");
  });
});
