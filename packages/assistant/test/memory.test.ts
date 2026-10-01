import { env, evictDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { beforeAll, describe, expect, it } from "vitest";
import { all, prepare, stmt } from "@garderobe/domain";
import { ownerDocuments } from "@garderobe/domain/testing";
import { extractJudgements, listForgetStates, resolveDateRange } from "../src/index.ts";
import { setTestCompaction, type FakeRequest } from "../src/testing/index.ts";
import { createWorld, setNow, submission, type World } from "./helpers.ts";

/**
 * SYNTHETIC CONVERSATION (test fixture): the things said below are scripted test dialogue held against the
 * owner's real imported wardrobe and profile. They are not the owner's history and are never imported.
 * The shoes discussed are a shop try-on, not an owned garment.
 */
const JULY_LIKING = "Tried a pair on at the shop on Lamb's Conduit Street today. Honestly the best thing I've had on my feet in years, the last is roomy and nothing rubs.";
const JULY_ASSISTANT = "You might like the darker pair as well; I would recommend looking at those too.";
const AUGUST_RETURN = "Update on that pair for my feet: I sent them back in the end, the heel slipped.";

const isCompaction = (r: FakeRequest) => r.system.startsWith("You compress");

describe("continuous conversation: recall, compaction and forgetting (real Think session and D1, real owner data, FAKE MODEL)", () => {
  let w: World;
  let julyMessageId = "";
  const say = async (text: string, reply: string) => {
    // The FAKE summarizer paraphrases the July message only when that message is actually in its input.
    w.model.otherwise((r) => (isCompaction(r) ? { text: r.messages.some((m) => m.text.includes("Lamb's Conduit")) ? "SUMMARY (fake): the owner tried shoes at a shop in July and was delighted with the fit; the assistant suggested a darker pair." : "SUMMARY (fake): filler questions about weather and layering." } : { text: reply }));
    return w.client.runTurn({ submissionId: submission(), text });
  };

  beforeAll(async () => {
    // A low threshold so compaction happens within a short test conversation.
    setTestCompaction(900, 2);
    w = await createWorld({ startAt: "2026-07-10T09:00:00Z" });
    setNow(w, "2026-07-14T18:30:00Z");
    const july = await say(JULY_LIKING, JULY_ASSISTANT);
    julyMessageId = (await w.client.transcript({})).messages.find((m) => m.turnId === july.turnId && m.role === "user")!.messageId;
    setNow(w, "2026-07-20T09:00:00Z");
    await say("What do you think of knitted ties with tweed?", "They work: the texture is in the same register.");
    setNow(w, "2026-08-22T09:00:00Z");
    await say(AUGUST_RETURN, "Understood, noted that they went back.");
    for (let i = 0; i < 6; i++) {
      setNow(w, `2026-09-0${i + 1}T09:00:00Z`);
      await say(`Filler question number ${i} about weather and layering, long enough to add tokens to the working context. `.repeat(6), `Filler answer ${i}. `.repeat(20));
    }
    setNow(w, "2026-09-15T08:00:00Z");
  });

  it("finds a seeded July liking through a paraphrase, with the owner's actual words, date and a later return reported separately", async () => {
    const result = await w.client.recallSearch({ text: "What shoes did I like so much last July?" });
    expect(result.resolvedRange).toMatchObject({ from: "2026-07-01", to: "2026-07-31" });
    expect(result.resolvedRange!.basis).toContain("july 2026");
    expect(result.hits).toHaveLength(1);
    const hit = result.hits[0]!;
    // The message never says "shoes" or "like": it is found by topic and judgement.
    expect(hit.quote).toBe(JULY_LIKING);
    expect(hit.speaker).toBe("owner");
    expect(hit.authoredAt).toBe("2026-07-14T18:30:00Z");
    expect(hit.messageId).toBe(julyMessageId);
    expect(hit.judgements.some((j) => j.kind === "liked" && j.speaker === "owner")).toBe(true);
    expect(hit.link).toContain(julyMessageId);
    // The assistant's own suggestion from the same day is not presented as the owner's liking.
    expect(result.hits.some((h) => h.quote.includes("darker pair"))).toBe(false);
    // The later return is reported separately, never folded into the liking.
    expect(hit.laterDevelopments.map((d) => d.kind)).toContain("returned");
    expect(hit.laterDevelopments[0]!.quote).toContain("sent them back");
    expect(result.caveat).toContain("does not mean it is owned");
    expect(result.exhaustive).toBe(true);
  });

  it("separates what the assistant suggested from what the owner said", async () => {
    const suggested = await w.client.recallSearch({ text: "what did you recommend for my feet", speaker: "assistant", from: "2026-07-01", to: "2026-07-31" });
    expect(suggested.hits.every((h) => h.speaker === "assistant")).toBe(true);
    expect(extractJudgements(JULY_ASSISTANT).map((j) => j.kind)).toContain("considering");
    expect(extractJudgements("I don't like the sheen on that one").map((j) => j.kind)).toEqual(["rejected"]);
  });

  it("resolves periods against the conversation date and surfaces a materially ambiguous one", () => {
    const now = Date.parse("2026-09-15T08:00:00Z");
    expect(resolveDateRange("last July", now, "Europe/London")).toMatchObject({ from: "2026-07-01", to: "2026-07-31", ambiguity: null });
    expect(resolveDateRange("in November", now, "Europe/London")).toMatchObject({ from: "2025-11-01", to: "2025-11-30" });
    expect(resolveDateRange("last September", now, "Europe/London")!.ambiguity).toContain("could mean");
    expect(resolveDateRange("July 2024", now, "Europe/London")).toMatchObject({ from: "2024-07-01", to: "2024-07-31" });
    expect(resolveDateRange("what socks", now, "Europe/London")).toBeNull();
  });

  it("compacts the working context through the model service while keeping every original message and the complete profile", async () => {
    const checkpoints = await all<{ covered_ids_json: string; model_profile: string; prompt_version: string; summary_sha256: string; status: string }>(w.h.db, "SELECT covered_ids_json, model_profile, prompt_version, summary_sha256, status FROM compaction_checkpoints WHERE user_id = ?", w.owner.userId);
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(checkpoints[0]).toMatchObject({ model_profile: "deepseek-v41-flash", prompt_version: "garderobe-compaction/1.0.0" });
    expect(checkpoints[0]!.summary_sha256).toHaveLength(64);
    // The compaction call reserved and settled budget like any other model call.
    const spend = await all<{ state: string }>(w.h.db, "SELECT state FROM inference_reservations WHERE user_id = ? AND task = 'compaction'", w.owner.userId);
    expect(spend.length).toBeGreaterThan(0);
    expect(spend.every((s) => s.state === "settled")).toBe(true);

    // The working context is now shorter than the history...
    await say("Anything else I should know today?", "No.");
    const seen = w.model.requests.filter((r) => !isCompaction(r)).at(-1)!;
    const transcript = await w.client.transcript({ limit: 200 });
    expect(seen.messages.filter((m) => m.role !== "system").length).toBeLessThan(transcript.messages.length);
    expect(seen.messages.some((m) => m.text.includes("SUMMARY (fake)"))).toBe(true);
    // ...the complete profile is still injected, and the original messages are all still retrievable by ID.
    expect(seen.system).toContain(ownerDocuments().profileText.trim());
    expect(transcript.total).toBe(20);
    expect(transcript.messages.find((m) => m.messageId === julyMessageId)!.text).toBe(JULY_LIKING);
    expect(transcript.messages.some((m) => m.text.includes("SUMMARY (fake)"))).toBe(false);
  });

  it("answers the July question with the original words after compaction and eviction of the actor", async () => {
    const stub: any = await getAgentByName((env as any).ASSISTANT, w.owner.userId);
    await evictDurableObject(stub as never);
    const result = await w.client.recallSearch({ text: "which shoes was I so pleased with last July" });
    expect(result.hits[0]!.quote).toBe(JULY_LIKING);
    // The assistant's recall tool returns the same evidence to the model.
    w.model.script({ toolCalls: [{ toolName: "recall_conversation", input: { text: "What shoes did I like so much last July?" } }] }, { text: "The pair you tried on in mid July; you sent them back in August." });
    const turn = await w.client.runTurn({ submissionId: submission(), text: "What shoes did I like so much last July?" });
    expect(turn.status).toBe("completed");
    const toolOutput = JSON.stringify(w.model.requests.filter((r) => !isCompaction(r)).at(-1)!.toolResults.at(-1)!.output);
    expect(toolOutput).toContain("best thing I've had on my feet");
    expect(toolOutput).toContain("sent them back");
  });

  it("catches the index up from its watermark after an interruption, without losing or duplicating messages, and discloses the gap meanwhile", async () => {
    const count = async () => (await all(w.h.db, "SELECT 1 FROM conversation_index WHERE user_id = ?", w.owner.userId)).length;
    const full = await count();
    // Simulate an interrupted projection: the index lost its last rows and its watermark moved back.
    const rows = await all<{ message_id: string; position: number }>(w.h.db, "SELECT message_id, position FROM conversation_index WHERE user_id = ? ORDER BY position", w.owner.userId);
    const cut = rows[2]!.position;
    await w.h.db.batch([
      prepare(w.h.db, stmt("DELETE FROM conversation_judgements WHERE user_id = ? AND message_id IN (SELECT message_id FROM conversation_index WHERE user_id = ? AND position > ?)", w.owner.userId, w.owner.userId, cut)),
      prepare(w.h.db, stmt("DELETE FROM conversation_index WHERE user_id = ? AND position > ?", w.owner.userId, cut)),
      prepare(w.h.db, stmt("UPDATE conversation_index_state SET indexed_position = ? WHERE user_id = ?", cut, w.owner.userId)),
    ]);
    const during = await w.client.recallSearch({ text: "did I send anything back for my feet", judgement: "returned", from: "2026-08-01", to: "2026-08-31" });
    expect(during.indexGap).toMatchObject({ searchedSourceDirectly: true });
    expect(during.indexGap!.unindexedMessages).toBe(full - 3);
    expect(during.hits[0]!.quote).toBe(AUGUST_RETURN); // found directly in the source history
    const caughtUp = await w.client.projectIndex();
    expect(caughtUp.indexed).toBe(full - 3);
    expect(await count()).toBe(full);
    expect((await w.client.projectIndex()).indexed).toBe(0);
    expect(await count()).toBe(full);
    expect((await w.client.recallSearch({ text: "feet", from: "2026-08-01", to: "2026-08-31" })).indexGap).toBeNull();
  });

  it("forgets a message: hidden from recall, transcript, model context and export at once; summaries that covered it are invalidated; erasure is reported per store", async () => {
    w.model.script({ toolCalls: [{ toolName: "forget", input: { sourceKind: "message", sourceIds: [julyMessageId], ownerQuote: "please forget what I said about that shop visit in July" } }] }, { text: "Forgotten." });
    const turn = await w.client.runTurn({ submissionId: submission(), text: "please forget what I said about that shop visit in July" });
    expect(turn.receipts.map((r) => r.type)).toEqual(["conversation.forget_source"]);
    expect(turn.receipts[0]!.summary).toContain("still in progress");

    expect((await w.client.recallSearch({ text: "What shoes did I like so much last July?" })).hits).toHaveLength(0);
    const transcript = await w.client.transcript({ limit: 200 });
    const gone = transcript.messages.find((m) => m.messageId === julyMessageId)!;
    expect(gone).toMatchObject({ forgotten: true, text: "", parts: [] });
    const exported = await w.client.exportConversation();
    expect(exported.messages.some((m) => m.messageId === julyMessageId)).toBe(false);
    // Including the verbatim copy that the earlier recall tool result had placed in a later message.
    expect(JSON.stringify(exported)).not.toContain("Lamb's Conduit");
    expect(JSON.stringify(exported)).not.toContain("best thing I've had on my feet");
    expect(JSON.stringify(transcript)).not.toContain("best thing I've had on my feet");
    expect(JSON.stringify(await all(w.h.db, "SELECT * FROM conversation_index WHERE user_id = ?", w.owner.userId))).not.toContain("Lamb's Conduit");
    const invalidated = await all(w.h.db, "SELECT 1 FROM compaction_checkpoints WHERE user_id = ? AND status = 'invalidated'", w.owner.userId);
    expect(invalidated.length).toBeGreaterThan(0);

    // The earlier summary paraphrased the forgotten message. Between turns the session was rebuilt without any
    // summary that covered it, so the fact cannot return through compaction; AI Search removal is still pending
    // (no index is bound in this test), so the source is NOT reported as fully erased.
    const state = (await listForgetStates(w.h.db, w.owner.principal())).find((s) => s.sourceId === julyMessageId)!;
    expect(state.erasedStores).toEqual(expect.arrayContaining(["retrieval_index", "ledger", "transcript", "summaries"]));
    expect(state.pendingStores).toEqual(["ai_search"]);
    expect(state.state).toBe("suppressed");
    expect(exported.compactions).toHaveLength(0);
    await say("What should I know now?", "Nothing new.");
    const context = JSON.stringify(w.model.requests.filter((r) => !isCompaction(r)).at(-1)!.messages);
    expect(context).not.toContain("tried shoes at a shop in July");
    expect(context).not.toContain("Lamb's Conduit");
    // The rest of the history survived the rebuild with its original IDs and order.
    const after = await w.client.transcript({ limit: 200 });
    expect(after.messages.slice(0, transcript.messages.length).map((m) => m.messageId)).toEqual(transcript.messages.map((m) => m.messageId));
    expect(after.messages.find((m) => m.text === AUGUST_RETURN)).toBeDefined();

    // A restore of the exported history replays the tombstone and does not resurrect the message.
    const again = await w.client.transcript({ around: julyMessageId, limit: 3 });
    expect(again.messages.find((m) => m.messageId === julyMessageId)!.forgotten).toBe(true);
  });
});
