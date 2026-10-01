/**
 * Reminders, deterministic ledger reads, premise rechecks, the separate return-reminder control, the
 * composed registry's commit hooks, backup/restore and account erasure.
 * Real: the conversation Durable Object, D1, the command service, the daily service's commands (pause) and
 * the real owner's imported wardrobe. Stand-in: the FAKE MODEL at the model boundary.
 */
import { env, evictDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { beforeAll, describe, expect, it } from "vitest";
import { all, createFoundationRegistry, getStyleContext, listInventory } from "@garderobe/domain";
import { getPauseState, registerDaily } from "@garderobe/daily";
import { configureAssistant, displacementFor, ledgerMaterial, listForgetStates, listMemoryConclusions, listReminders, recheckPremises, registerAssistant, returnReminderDelivery, wearAnalysis } from "../src/index.ts";
import { setTestCompaction, type FakeRequest, type FakeStep } from "../src/testing/index.ts";
import { createWorld, setNow, submission, type World } from "./helpers.ts";

const isCompaction = (r: FakeRequest) => r.system.startsWith("You compress");
/** Script chat steps while any compaction call in between gets a fixed summary (compaction runs between turns). */
function chat(w: World, summary: string) {
  const queue: FakeStep[] = [];
  w.model.script();
  w.model.otherwise(async (request) => {
    if (isCompaction(request)) return { text: summary };
    const step = queue.shift() ?? { text: "(no scripted step)" };
    return typeof step === "function" ? step(request) : step;
  });
  return { say: (...steps: FakeStep[]) => void queue.push(...steps), last: () => [...w.model.requests].reverse().find((r) => !isCompaction(r))! };
}

const STATEMENT = { actor: "assistant" as const, channel: "ios" as const, authorization: "owner_statement" as const };
const SYSTEM = { actor: "system" as const, channel: "system" as const, authorization: "system_schedule" as const };

describe("reminders, ledger reads and separate controls (real owner data; FAKE MODEL)", () => {
  let w: World;
  const p = () => w.owner.principal();
  const hookCalls: string[] = [];

  beforeAll(async () => {
    w = await createWorld({ extend: (registry) => registerDaily(registry) });
    // The actor is handed the COMPOSED registry, as the Worker does: foundation + assistant + daily, plus a
    // recording hook that stands for any lane's commit hook.
    const composed = registerAssistant(createFoundationRegistry());
    registerDaily(composed);
    composed.addCommitHook("test.recorder", async (ctx) => void hookCalls.push(ctx.envelope.type));
    configureAssistant({ registry: () => composed });
  });

  it("sets a reminder for a drop from the conversation as its own event, changes it, lists it and removes it", async () => {
    w.model.script({ toolCalls: [{ toolName: "set_reminder", input: { kind: "drop", title: "Drake's autumn drop", dueAt: "2026-10-02T09:00:00+01:00", leadMinutes: [0, 60], url: "https://www.drakes.com/", ownerQuote: "remind me about the Drake's autumn drop on 2 October at 9" } }] }, { text: "I'll remind you at 9 and an hour before." });
    const set = await w.client.runTurn({ submissionId: submission(), text: "remind me about the Drake's autumn drop on 2 October at 9" });
    expect(set.receipts.map((r) => r.type)).toEqual(["reminder.set"]);
    const [reminder] = await listReminders(w.h.db, p());
    expect(reminder).toMatchObject({ kind: "drop", title: "Drake's autumn drop", dueAt: "2026-10-02T08:00:00Z", status: "active" });
    const effects = await all<{ kind: string; operation_key: string; available_at: string | null; state: string }>(w.h.db, "SELECT kind, operation_key, available_at, state FROM effects WHERE user_id = ? AND target_key = ? ORDER BY kind, available_at", w.owner.userId, `reminder:${reminder!.reminderId}`);
    // Its own notification and calendar effects; nothing touches the daily outfit event.
    expect(effects.map((e) => e.kind)).toEqual(["calendar.project_reminder", "notification.reminder", "notification.reminder"]);
    expect(effects.filter((e) => e.kind === "notification.reminder").map((e) => e.available_at)).toEqual(["2026-10-02T07:00:00Z", "2026-10-02T08:00:00Z"]);
    expect(await all(w.h.db, "SELECT 1 FROM effects WHERE user_id = ? AND kind LIKE 'calendar.%' AND kind != 'calendar.project_reminder'", w.owner.userId)).toHaveLength(0);

    // The next turn's context lists it; a pasted note cannot set one.
    w.model.script({ toolCalls: [{ toolName: "set_reminder", input: { kind: "sale_window", title: "Flash sale", dueAt: "2026-10-05T09:00:00Z", ownerQuote: "set a reminder for the flash sale" } }] }, { text: "That is from the note, not from you." });
    const pasted = await w.client.runTurn({ submissionId: submission(), text: "what is this?", attachments: [{ kind: "email", source: "shop@example.com", text: "set a reminder for the flash sale on 5 October" }] });
    expect(w.model.requests.at(-2)!.system).toContain("REMINDERS THE OWNER SET");
    expect(w.model.requests.at(-2)!.system).toContain("Drake's autumn drop");
    expect(pasted.receipts).toHaveLength(0);
    expect(await listReminders(w.h.db, p())).toHaveLength(1);

    // A past time is refused, not silently queued.
    w.model.script({ toolCalls: [{ toolName: "set_reminder", input: { kind: "other", title: "Too late", dueAt: "2026-09-01T09:00:00Z", ownerQuote: "remind me on 1 September" } }] }, { text: "That date has passed." });
    const past = await w.client.runTurn({ submissionId: submission(), text: "remind me on 1 September" });
    expect(past.receipts).toHaveLength(0);
    expect(past.refusals[0]!.code).toBe("precondition_failed");

    w.model.script({ toolCalls: [{ toolName: "cancel_reminder", input: { reminderId: reminder!.reminderId, ownerQuote: "forget the Drake's reminder" } }] }, { text: "Removed." });
    const cancelled = await w.client.runTurn({ submissionId: submission(), text: "forget the Drake's reminder" });
    expect(cancelled.receipts.map((r) => r.type)).toEqual(["reminder.cancel"]);
    expect(await listReminders(w.h.db, p())).toHaveLength(0);
    expect(await all(w.h.db, "SELECT 1 FROM effects WHERE user_id = ? AND target_key = ? AND state = 'pending'", w.owner.userId, `reminder:${reminder!.reminderId}`)).toHaveLength(0);
  });

  it("a conversation command runs through the composed registry, so another lane's commit hook sees it", async () => {
    hookCalls.length = 0;
    const shirt = await w.garment("oxford");
    w.model.script({ toolCalls: [{ toolName: "mark_dirty", input: { garmentIds: [shirt.garmentId], ownerQuote: "the oxford is in the wash" } }] }, { text: "Noted." });
    const turn = await w.client.runTurn({ submissionId: submission(), text: "the oxford is in the wash" });
    expect(turn.receipts.map((r) => r.type)).toEqual(["care.mark_dirty"]);
    expect(hookCalls).toContain("care.mark_dirty");
  });

  it("return reminders stay on through a pause of recommendations and have their own switch", async () => {
    setNow(w, "2026-09-15T08:00:00Z");
    const g = await w.garment("Clark oxford");
    const terms = { windowDays: 14, concerns: "post", triggerEvent: "delivery", sourceRef: "https://shop.example/returns", checkedOn: "2026-09-15" };
    const opened = await w.owner.exec("return.open_case", { kind: "return", garmentId: g.garmentId, terms, triggerDate: "2026-09-13" }, STATEMENT);
    const caseId = String(opened.result["caseId"]);
    const pending = () => all<{ operation_key: string }>(w.h.db, "SELECT operation_key FROM effects WHERE user_id = ? AND kind = 'notification.return_reminder' AND state = 'pending'", w.owner.userId);
    const before = await pending();
    expect(before.length).toBeGreaterThan(0);

    // Pause daily recommendations (the daily service's own command).
    await w.owner.exec("service.pause", {}, { actor: "owner", authorization: "owner_tap" });
    expect(await getPauseState(w.h.db, p())).not.toBeNull();
    expect(await pending()).toEqual(before);
    expect(await returnReminderDelivery(w.h.db, p(), { caseId })).toEqual({ deliver: true, reason: null });
    // The deadline is still in front of the model while paused.
    w.model.script({ text: "The return is due by the 27th." });
    await w.client.runTurn({ submissionId: submission(), text: "anything I need to send back?" });
    expect(w.model.requests.at(-1)!.system).toContain("OPEN RETURNS AND EXCHANGES");
    expect(w.model.requests.at(-1)!.system).toContain("2026-09-27");

    // The separate switch: only the owner's own words turn return reminders off, and that leaves the pause as it is.
    w.model.script({ toolCalls: [{ toolName: "set_return_reminders", input: { paused: true, ownerQuote: "stop reminding me about returns" } }] }, { text: "Return reminders are off." });
    const off = await w.client.runTurn({ submissionId: submission(), text: "stop reminding me about returns" });
    expect(off.receipts.map((r) => r.type)).toEqual(["settings.update"]);
    expect(await returnReminderDelivery(w.h.db, p(), { caseId })).toEqual({ deliver: false, reason: "the owner turned return reminders off" });
    expect(await getPauseState(w.h.db, p())).not.toBeNull();
    // Resuming recommendations does not switch return reminders back on.
    await w.owner.exec("service.resume", {}, { actor: "owner", authorization: "owner_tap" });
    expect(await getPauseState(w.h.db, p())).toBeNull();
    expect((await returnReminderDelivery(w.h.db, p(), { caseId })).deliver).toBe(false);
    w.model.script({ toolCalls: [{ toolName: "set_return_reminders", input: { paused: false, ownerQuote: "turn return reminders back on" } }] }, { text: "Back on." });
    await w.client.runTurn({ submissionId: submission(), text: "turn return reminders back on" });
    expect((await returnReminderDelivery(w.h.db, p(), { caseId })).deliver).toBe(true);
    // A finished return is never reminded about.
    await w.owner.exec("return.update_case", { caseId, state: "cancelled" }, STATEMENT);
    expect((await returnReminderDelivery(w.h.db, p(), { caseId })).deliver).toBe(false);
  });

  it("wear analysis and the displacement query are computed from the ledger and state their limits", async () => {
    const inventory = await listInventory(w.h.db, p());
    const shirts = inventory.items.filter((i) => i.garment.category === "shirt" && i.garment.acquisition === "owned");
    expect(shirts.length).toBeGreaterThan(2);
    const [a, b] = shirts;
    await w.owner.exec("wear.record", { wearingDate: "2026-09-10", garmentIds: [a!.garment.garmentId] }, STATEMENT);
    await w.owner.exec("wear.record", { wearingDate: "2026-09-12", garmentIds: [a!.garment.garmentId, b!.garment.garmentId] }, STATEMENT);
    // Reporting the same piece twice on one date still counts once.
    await w.owner.exec("wear.record", { wearingDate: "2026-09-12", garmentIds: [a!.garment.garmentId] }, STATEMENT);

    const analysis = await wearAnalysis(w.h.db, p(), { from: "2026-09-01", to: "2026-09-14" }, { category: "shirt" });
    expect(analysis.byGarment.find((g) => g.garmentId === a!.garment.garmentId)).toMatchObject({ wears: 2, lastWorn: "2026-09-12" });
    expect(analysis.byGarment.find((g) => g.garmentId === b!.garment.garmentId)).toMatchObject({ wears: 1 });
    expect(analysis.totalRecordedWears).toBe(3);
    expect(analysis.daysWithRecords).toBe(2);
    expect(analysis.noRecordedWear.length).toBe(shirts.length - 2);
    expect(analysis.caveat).toContain("unlogged, not unworn");

    // "What would this displace": a prospective shirt in a colour the owner already has.
    const colour = a!.garment.colour!;
    const displaced = await displacementFor(w.h.db, p(), { category: "shirt", colour, fabric: a!.garment.fabric }, { nowMs: w.h.clock.now(), localDate: "2026-09-15" });
    expect(displaced.ownedInCategory).toBe(shirts.length);
    expect(displaced.overlapping[0]!.shared).toContain("colour");
    expect(displaced.overlapping.map((o) => o.garmentId)).toContain(a!.garment.garmentId);
    expect(displaced.overlapping.find((o) => o.garmentId === a!.garment.garmentId)!.recordedWears).toBe(2);
    expect(displaced.addsUncoveredRole).toBe(false);
    const novel = await displacementFor(w.h.db, p(), { category: "shirt", colour: "fluorescent magenta" }, { nowMs: w.h.clock.now(), localDate: "2026-09-15" });
    expect(novel.addsUncoveredRole).toBe(true);
    expect(novel.repeatsUnderused).toEqual([]);
    // A read: no garment, product or command came out of asking.
    expect((await listInventory(w.h.db, p())).total).toBe(inventory.total);

    // Through the conversation tools, the same numbers reach the model as tool results.
    w.model.script({ toolCalls: [{ toolName: "wear_analysis", input: { from: "2026-09-01", to: "2026-09-14", category: "shirt" } }, { toolName: "what_would_this_displace", input: { category: "shirt", colour } }] }, { text: "You already have that covered." });
    const turn = await w.client.runTurn({ submissionId: submission(), text: "would another shirt like that earn its place?" });
    expect(turn.receipts).toHaveLength(0);
    const results = w.model.requests.at(-1)!.toolResults;
    expect((results.find((r) => r.toolName === "wear_analysis")!.output as { totalRecordedWears: number }).totalRecordedWears).toBe(3);
    expect((results.find((r) => r.toolName === "what_would_this_displace")!.output as { ownedInCategory: number }).ownedInCategory).toBe(shirts.length);
  });

  it("hands the whole ledger over as paged material: every garment row once, and the wear history by date", async () => {
    const inventory = await listInventory(w.h.db, p());
    const seen: string[] = [];
    let offset: number | null = 0;
    let pages = 0;
    while (offset !== null) {
      const page = await ledgerMaterial(w.h.db, p(), { section: "garments", offset, limit: 50 });
      expect(page.total).toBe(inventory.total);
      seen.push(...page.entries.map((e) => String(e["garmentId"])));
      offset = page.nextOffset;
      pages++;
    }
    expect(pages).toBe(Math.ceil(inventory.total / 50));
    expect(new Set(seen).size).toBe(inventory.total);
    expect(seen.length).toBe(inventory.total);
    const wear = await ledgerMaterial(w.h.db, p(), { section: "wear" });
    expect(wear.entries.map((e) => e["wearingDate"])).toEqual(["2026-09-10", "2026-09-12"]);
    expect(wear.caveat).toContain("unlogged, not unworn");
    w.model.script({ toolCalls: [{ toolName: "ledger_material", input: { section: "garments", offset: 0, limit: 5 } }] }, { text: "Draft follows." });
    await w.client.runTurn({ submissionId: submission(), text: "write a short piece about my shirts from the records" });
    const result = w.model.requests.at(-1)!.toolResults.at(-1)!.output as { entries: unknown[]; nextOffset: number; total: number };
    expect(result.entries).toHaveLength(5);
    expect(result.nextOffset).toBe(5);
  });

  it("rechecks the premises of a remembered fit judgement against current records and flags the judgement when one changed", async () => {
    const style = await getStyleContext(w.h.db, p());
    const chest = style.measurements.find((m) => m.subject === "body" && m.key === "chest" && !m.supersededBy)!;
    expect(chest).toBeTruthy();
    await w.owner.exec("memory.record_conclusion", { kind: "fit_judgement", text: "A 44 in the Harley crewneck fits with comfortable ease", speaker: "owner", sourceMessageIds: ["msg_fixture"], premises: [{ kind: "measurement", ref: "chest", value: `${chest.value} ${chest.unit}` }], status: "active" }, STATEMENT);
    const memories = await listMemoryConclusions(w.h.db, p(), { statuses: ["active"] });
    expect((await recheckPremises(w.h.db, p(), memories)).map((c) => c.status)).toEqual(["holds"]);
    w.model.script({ text: "Same size as before." });
    await w.client.runTurn({ submissionId: submission(), text: "would the 44 still fit?" });
    expect(w.model.requests.at(-1)!.system).toContain("premises rechecked against current records: measurement chest holds");

    // The owner's chest measurement changes: the next turn is told not to rely on the old judgement.
    await w.owner.exec("measurement.record", { subject: "body", key: "chest", value: chest.value + 2, unit: chest.unit, measuredOn: "2026-09-15", source: { kind: "owner_statement", ref: "message:fixture" } }, STATEMENT);
    const after = await recheckPremises(w.h.db, p(), memories);
    expect(after[0]).toMatchObject({ status: "changed" });
    expect(after[0]!.current).toContain(String(chest.value + 2));
    w.model.script({ text: "Your chest measurement changed; let me redo the arithmetic." });
    await w.client.runTurn({ submissionId: submission(), text: "and now?" });
    expect(w.model.requests.at(-1)!.system).toContain("PREMISE NO LONGER HOLDS: measurement chest");
  });

  it("records a provider's retention window for a store that cannot be emptied at once, and exposes it until removal is confirmed", async () => {
    w.model.script({ text: "ok" });
    const said = await w.client.runTurn({ submissionId: submission(), text: "a remark about my old flatmate that I will want removed" });
    const messageId = (await w.client.transcript({})).messages.find((m) => m.turnId === said.turnId && m.role === "user")!.messageId;
    await w.owner.exec("conversation.forget_source", { sourceKind: "message", sourceIds: [messageId] }, STATEMENT);
    await w.owner.exec("conversation.confirm_erasure", { sourceKind: "message", sourceIds: [messageId], store: "ai_search", outstandingRetention: "the search provider keeps job metadata for up to 30 days" }, SYSTEM);
    const held = (await listForgetStates(w.h.db, p())).find((f) => f.sourceId === messageId)!;
    expect(held.state).toBe("suppressed");
    expect(held.pendingStores).toContain("ai_search");
    expect(held.outstandingRetention).toBe("the search provider keeps job metadata for up to 30 days");
    // Hidden everywhere at once, even though one store has not confirmed removal.
    expect(JSON.stringify(await w.client.transcript({}))).not.toContain("flatmate");
    await w.owner.exec("conversation.confirm_erasure", { sourceKind: "message", sourceIds: [messageId], store: "ai_search", outstandingRetention: null }, SYSTEM);
    const done = (await listForgetStates(w.h.db, p())).find((f) => f.sourceId === messageId)!;
    expect(done.erasedStores).toContain("ai_search");
    expect(done.outstandingRetention).toBeNull();
  });
});

describe("original messages by ID, session full-text search, archived tool results (real Think session; FAKE MODEL)", () => {
  it("a large tool result is referenced from the summary and can be opened again by message ID; exact words are found by session search", async () => {
    setTestCompaction(900, 2);
    try {
      const w = await createWorld();
      const c = chat(w, "The owner asked what they own and praised a Shetland knit; the assistant listed the wardrobe.");
      c.say({ toolCalls: [{ toolName: "find_garments", input: { limit: 60 } }] }, { text: "You have a lot of shirts. The Shetland from Jamieson's is the warmest knit." });
      const first = await w.client.runTurn({ submissionId: submission(), text: "what do I own? I love the Jamieson's Shetland" });
      const big = (await w.client.transcript({})).messages.find((m) => m.turnId === first.turnId && m.role === "assistant" && JSON.stringify(m.parts).includes("find_garments"))!;
      expect(JSON.stringify(big.parts).length).toBeGreaterThan(2_000);
      // More turns push the first exchange out of the working context.
      for (let i = 0; i < 3; i++) {
        c.say({ text: `Answer ${i}: ${"flannel and tweed ".repeat(20)}` });
        await w.client.runTurn({ submissionId: submission(), text: `question ${i} about ${"trousers and jackets ".repeat(10)}` });
      }
      const checkpoints = await all<{ covered_ids_json: string; token_estimate: number }>(w.h.db, "SELECT covered_ids_json, token_estimate FROM compaction_checkpoints WHERE user_id = ?", w.owner.userId);
      expect(checkpoints.length).toBeGreaterThan(0);
      expect(checkpoints[0]!.token_estimate).toBeGreaterThan(0);
      expect(JSON.parse(checkpoints[0]!.covered_ids_json)).toContain(big.messageId);

      // The next turn works from the summary, which points at the archived result; the model opens it by message ID.
      c.say({ toolCalls: [{ toolName: "read_message", input: { messageId: big.messageId } }] }, { text: "Found it again." });
      await w.client.runTurn({ submissionId: submission(), text: "show me that list again" });
      const pointer = c.last().messages.find((m) => m.text.includes("Archived tool results"));
      expect(pointer).toBeTruthy();
      expect(pointer!.text).toContain(big.messageId);
      const opened = c.last().toolResults.at(-1)!.output as { messageId: string; toolPayloads: { tool: string; output: string }[] };
      expect(opened.messageId).toBe(big.messageId);
      expect(opened.toolPayloads[0]!.tool).toBe("find_garments");
      expect(opened.toolPayloads[0]!.output.length).toBeGreaterThan(2_000);

      // Session full-text search confirms the exact words in the source history.
      const hits = await w.client.recallSearch({ text: "Jamieson's Shetland" });
      expect(hits.hits.slice(0, 2).some((h) => h.speaker === "owner" && h.quote.includes("Jamieson's Shetland"))).toBe(true);

      // A forgotten message can no longer be opened.
      const owner = (await w.client.transcript({ limit: 200 })).messages.find((m) => m.turnId === first.turnId && m.role === "user")!;
      await w.owner.exec("conversation.forget_source", { sourceKind: "message", sourceIds: [owner.messageId] }, STATEMENT);
      c.say({ toolCalls: [{ toolName: "read_message", input: { messageId: owner.messageId } }] }, { text: "That is gone." });
      await w.client.runTurn({ submissionId: submission(), text: "open my first message" });
      expect(c.last().toolResults.at(-1)!.output).toEqual({ error: "no such message is available" });
      expect((await w.client.recallSearch({ text: "Jamieson's Shetland" })).hits.every((h) => h.messageId !== owner.messageId)).toBe(true);
    } finally {
      setTestCompaction(null, null);
    }
  });
});

describe("backup, restore and account erasure of the conversation actor (real Durable Objects; FAKE MODEL)", () => {
  it("backs up messages, overlays, unsettled turns and watermarks; restores them into an empty actor without inference or effects; then erases everything", async () => {
    setTestCompaction(300, 2);
    try {
      const w = await createWorld({ real: false });
      const c = chat(w, "Earlier the owner asked several questions about cloth and was answered each time.");
      for (let i = 0; i < 6; i++) {
        c.say({ text: `Reply ${i}: ${"cloth weight and collar ".repeat(15)}` });
        await w.client.runTurn({ submissionId: submission(), text: `Question ${i}: ${"oxford and poplin ".repeat(8)}` });
      }
      // One turn that did not settle (a provider outage, simulated).
      c.say({ error: new Error("fetch failed: connection reset") }, { error: new Error("fetch failed: connection reset") });
      const stuck = await w.client.runTurn({ submissionId: submission(), text: "and this one is interrupted" });
      expect(stuck.status).toBe("resumable");
      const N = 13;

      const backup = await w.client.backupConversation();
      expect(backup.kind).toBe("garderobe-conversation-backup");
      expect(backup.messages).toHaveLength(N);
      expect(backup.overlays.length).toBeGreaterThan(0);
      expect(backup.overlays[0]!.summary).toContain("Earlier the owner asked");
      expect(backup.pendingTurns).toEqual([expect.objectContaining({ turnId: stuck.turnId, status: "resumable" })]);
      expect(backup.watermarks).toMatchObject({ messageCount: N, lastMessageId: backup.messages.at(-1)!.messageId, compactionOverlays: backup.overlays.length });
      expect(backup.watermarks.indexedPosition).toBeGreaterThan(0);
      expect(JSON.stringify(backup)).not.toContain("reasoning");

      // Account erasure: everything the actor stored is gone, and it reports what it removed.
      const erased = await w.client.eraseEverything();
      expect(erased).toMatchObject({ messages: N, compactionOverlays: backup.overlays.length });
      await new Promise((r) => setTimeout(r, 100));
      const stub = await getAgentByName((env as unknown as { ASSISTANT: never }).ASSISTANT, w.owner.userId);
      await evictDurableObject(stub as never).catch(() => undefined);
      const empty = await w.client.transcript({});
      expect(empty.total).toBe(0);
      expect((await w.client.conversationWatermarks()).compactionOverlays).toBe(0);

      // Restore into the now-empty actor: same IDs and dates, overlays back, index rebuilt, nothing re-run.
      await w.h.db.prepare("DELETE FROM conversation_index WHERE user_id = ?").bind(w.owner.userId).run();
      await w.h.db.prepare("DELETE FROM conversation_index_state WHERE user_id = ?").bind(w.owner.userId).run();
      const calls = w.model.requests.length;
      const commands = (await all(w.h.db, "SELECT 1 FROM commands WHERE user_id = ?", w.owner.userId)).length;
      const restored = await w.client.restoreConversation(backup);
      expect(restored).toMatchObject({ imported: N, overlaysRestored: backup.overlays.length, overlaysSkipped: 0, pendingTurns: 1 });
      expect(restored.watermarks).toMatchObject({ messageCount: N, lastMessageId: backup.watermarks.lastMessageId, indexedPosition: N });
      expect(w.model.requests.length).toBe(calls);
      expect((await all(w.h.db, "SELECT 1 FROM commands WHERE user_id = ?", w.owner.userId)).length).toBe(commands);
      const again = await w.client.transcript({ limit: 200 });
      expect(again.messages.map((m) => [m.messageId, m.authoredAt, m.text])).toEqual(backup.messages.map((m) => [m.messageId, m.authoredAt, m.text]));
      // Search works over the rebuilt index.
      expect((await w.client.recallSearch({ text: "oxford poplin" })).hits.length).toBeGreaterThan(0);
      // The unsettled turn continues from the restored message; nothing earlier is repeated.
      c.say({ text: "Picking that one up now." });
      const resumed = await w.client.resumeTurn(stuck.turnId);
      expect(resumed!.status).toBe("completed");
      expect(resumed!.reply?.text).toBe("Picking that one up now.");
      // The model's working context after restore starts from the restored summary, not from nothing.
      expect(c.last().messages.some((m) => m.text.includes("Earlier the owner asked"))).toBe(true);
    } finally {
      setTestCompaction(null, null);
    }
  });
});
