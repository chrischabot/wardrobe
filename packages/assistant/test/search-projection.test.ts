import { describe, expect, it } from "vitest";
import { all, readOutbox } from "@garderobe/domain";
import { instanceNameFor, itemKeyFor, provisionSearchInstance, splitDocument, SEARCH_METADATA_FIELDS, type SearchDocument, type SearchIndexPort } from "../src/recall/ai-search.ts";
import { runSearchProjection } from "../src/index.ts";
import { TEST_GATEWAY_ID, setTestPorts } from "../src/testing/index.ts";
import { createWorld, submission } from "./helpers.ts";

/**
 * FAKE AI Search index (test double for the AI Search binding). It stores documents in memory and can be told
 * to report an upload as merely accepted or to return stale results. No AI Search instance is contacted.
 */
class FakeSearchIndex implements SearchIndexPort {
  docs = new Map<string, SearchDocument>();
  acceptOnly = new Set<string>();
  stale: { sourceId: string; text: string }[] = [];
  async upsert(doc: SearchDocument) {
    if (this.acceptOnly.has(doc.sourceId)) return { status: "accepted" as const, detail: "queued" };
    this.docs.set(doc.sourceId, doc);
    return { status: "searchable" as const };
  }
  async remove(sourceId: string) {
    this.docs.delete(sourceId);
  }
  async search(query: string) {
    const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const live = [...this.docs.values()].filter((d) => words.some((w) => d.body.toLowerCase().includes(w))).map((d) => ({ sourceId: d.sourceId, sourceVersion: d.sourceVersion, kind: d.kind, score: 0.9, text: d.body }));
    return [...live, ...this.stale.map((s) => ({ sourceId: s.sourceId, sourceVersion: 1, kind: "conversation_episode", score: 0.99, text: s.text }))];
  }
}

describe("AI Search projection (real outbox, real conversation index, real budget ledger; FAKE AI Search index)", () => {
  it("projects records and conversation episodes once, advances its watermark only over searchable items, removes forgotten sources, and a stale index cannot resurrect them", async () => {
    const w = await createWorld();
    const index = new FakeSearchIndex();
    setTestPorts({ searchIndex: index });
    const run = () => runSearchProjection(w.h.db, w.h.service, index, { userId: w.owner.userId, nowMs: w.h.clock.now(), gatewayId: TEST_GATEWAY_ID, limit: 500 });

    w.model.script({ text: "Noted." }, { text: "Fine." });
    const first = await w.client.runTurn({ submissionId: submission(), text: "I really love the texture of that Shetland cloth I handled at the mill shop" });
    await w.client.runTurn({ submissionId: submission(), text: "What goes with grey flannels?" });
    const note = await w.owner.exec("research.save_note", { topic: "Shetland wool grading", body: "Notes on Shetland wool grades and handle." }, { actor: "assistant", authorization: "owner_statement" });
    const messages = (await w.client.transcript({})).messages;
    const loved = messages.find((m) => m.turnId === first.turnId && m.role === "user")!;

    // The second message's upload is only "accepted": the watermark must stop before it.
    index.acceptOnly.add(`message:${messages[2]!.messageId}`);
    const one = await run();
    expect(one.uploaded).toBeGreaterThan(100); // every imported garment record, the note and the searchable episodes
    expect(index.docs.get(`research_note:${note.result["noteId"]}`)!.body).toContain("Shetland wool grades");
    expect(index.docs.get(`message:${loved.messageId}`)).toMatchObject({ kind: "conversation_episode", occurredAt: "2026-09-15T08:00:00Z" });
    expect(index.docs.get(`message:${loved.messageId}`)!.body).toContain("said by the owner");
    expect(one.pending).toBe(1);
    const position = (p: string) => all<{ position: number }>(w.h.db, "SELECT position FROM conversation_index WHERE user_id = ? AND message_id = ?", w.owner.userId, p).then((r) => r[0]!.position);
    expect(one.conversationPosition).toBe(await position(messages[1]!.messageId));
    // Garment documents describe; they never assert ownership or availability.
    const garmentDoc = [...index.docs.values()].find((d) => d.kind === "garment")!;
    expect(garmentDoc.body).toContain("Ownership and availability are not stated here");
    // Acknowledged outbox entries are not delivered again.
    expect((await readOutbox(w.h.db, { topics: ["search.index", "garment"], limit: 500 })).filter((e) => e.userId === w.owner.userId)).toHaveLength(0);

    // The item becomes searchable: the next run catches up without re-uploading what is already covered.
    index.acceptOnly.clear();
    const two = await run();
    expect(two.uploaded).toBe(2);
    expect(two.conversationPosition).toBe(await position(messages[3]!.messageId));
    expect((await run()).uploaded).toBe(0);
    // The job reserved and settled under the search budget.
    const spend = await all<{ state: string; budget_class: string }>(w.h.db, "SELECT state, budget_class FROM inference_reservations WHERE user_id = ? AND task = 'semantic_indexing'", w.owner.userId);
    expect(spend).toEqual([{ state: "settled", budget_class: "search" }, { state: "settled", budget_class: "search" }]);

    // Recall merges AI Search candidates with the source index.
    const found = await w.client.recallSearch({ text: "what did I say about Shetland cloth texture" });
    expect(found.hits[0]).toMatchObject({ messageId: loved.messageId, origin: "both" });

    // Forget the message: the projection removes it from the index...
    await w.owner.exec("conversation.forget_source", { sourceKind: "message", sourceIds: [loved.messageId] }, { actor: "assistant", authorization: "owner_statement" });
    await run();
    expect(index.docs.has(`message:${loved.messageId}`)).toBe(false);
    // ...and even an index that still returns the stale document cannot bring it back.
    index.stale.push({ sourceId: `message:${loved.messageId}`, text: "I really love the texture of that Shetland cloth" });
    const after = await w.client.recallSearch({ text: "what did I say about Shetland cloth texture" });
    expect(after.hits.some((h) => h.messageId === loved.messageId)).toBe(false);
    expect(JSON.stringify(after)).not.toContain("mill shop");

    // With the search budget exhausted nothing is sent to the service.
    await w.owner.exec("settings.update", { patch: { extensions: { assistant: { budgets: { search: 0 } } } } });
    await w.owner.exec("research.save_note", { topic: "Another note", body: "More notes." }, { actor: "assistant", authorization: "owner_statement" });
    const size = index.docs.size;
    const blocked = await run();
    expect(blocked.skippedForBudget).toBe(true);
    expect(index.docs.size).toBe(size);
  });

  it("derives the instance from the internal user ID only, keeps the five metadata fields and splits long documents", async () => {
    expect(instanceNameFor("dev", "usr_AB12")).toBe("garderobe-dev-usr-ab12");
    expect(() => instanceNameFor("dev/../prod", "usr_1")).toThrow();
    expect(SEARCH_METADATA_FIELDS).toEqual(["kind", "occurred_at", "entity_id", "source_id", "source_version"]);
    expect(itemKeyFor("message:abc/../x")).toBe("message:abc____x.md");
    const parts = splitDocument({ sourceId: "research_note:n1", sourceVersion: 2, kind: "research_note", occurredAt: "2026-09-15T08:00:00Z", entityId: "n1", body: "x".repeat(50_000) }, 24_000);
    expect(parts.map((p) => p.sourceId)).toEqual(["research_note:n1#1", "research_note:n1#2", "research_note:n1#3"]);
    expect(parts.every((p) => p.body.length <= 24_000)).toBe(true);

    // FAKE namespace binding (test double): records the provisioning call the adapter would make.
    const created: Record<string, unknown>[] = [];
    const namespace = { list: async () => ({ result: created.map((c) => ({ id: c["id"] })) }), create: async (config: Record<string, unknown>) => (created.push(config), {}) } as unknown as AiSearchNamespace;
    expect(await provisionSearchInstance(namespace, "dev", "usr_1", "garderobe-dev")).toEqual({ instance: "garderobe-dev-usr-1", created: true });
    expect(await provisionSearchInstance(namespace, "dev", "usr_1", "garderobe-dev")).toEqual({ instance: "garderobe-dev-usr-1", created: false });
    expect(created[0]).toMatchObject({ id: "garderobe-dev-usr-1", ai_gateway_id: "garderobe-dev", cache: false, rewrite_query: false, reranking: false });
    expect((created[0]!["custom_metadata"] as unknown[]).length).toBe(5);
  });
});
