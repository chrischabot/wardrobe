import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, readOutbox } from "@garderobe/domain";
import { ConnectionError, McpHttpClient, argsFromSchema, extractBackendFor, listForgetStates, listJobs, runAssistantMaintenance, searchProviderFor, research, type SearchDocument, type SearchIndexPort } from "../src/index.ts";
import { TEST_GATEWAY_ID } from "../src/testing/index.ts";
import { createWorld, submission } from "./helpers.ts";

const TOOLS = [
  { name: "tavily_search", description: "Search the web", inputSchema: { type: "object", properties: { query: { type: "string" }, include_answer: { type: "boolean" } } } },
  { name: "tavily_extract", description: "Extract content from URLs", inputSchema: { type: "object", properties: { urls: { type: "array" }, extract_depth: { type: "string" }, include_images: { type: "boolean" } } } },
  { name: "tavily_research", description: "Deep research agent that writes a report", inputSchema: { type: "object", properties: { input: { type: "string" } } } },
];

/** FAKE MCP server (test double for a remote MCP endpoint such as Tavily's): answers JSON-RPC over a fake fetch. */
function fakeMcp() {
  const calls: { method: string; params: any; headers: Record<string, string> }[] = [];
  const fetcher = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ method: body.method, params: body.params, headers: init.headers as Record<string, string> });
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
    if (body.method === "tools/list") return reply({ tools: TOOLS });
    if (body.method === "tools/call" && body.params.name === "tavily_search") return reply({ content: [{ type: "text", text: JSON.stringify({ results: [{ url: "https://shop.example/p?api_key=LEAKED123456", title: "Crewneck", content: "A jumper" }] }) }] });
    if (body.method === "tools/call" && body.params.name === "tavily_extract") return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { results: [{ url: body.params.arguments.urls[0], raw_content: "Shetland wool crewneck, full description of the garment and its construction.", images: ["https://shop.example/a.jpg"] }], failed_results: [] } } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "unknown" } }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

describe("outbound connections (real connection registry in D1; FAKE MCP server behind a fake fetch)", () => {
  it("uses only discovered tools and schema-declared arguments, keeps credentials out of arguments and results, and stops at revocation", async () => {
    const w = await createWorld({ real: false });
    const mcp = fakeMcp();
    expect(() => new McpHttpClient({ endpoint: "http://mcp.tavily.com/mcp/", fetch: mcp.fetcher, protocolVersion: "2026-07-28" })).toThrow();
    expect(() => new McpHttpClient({ endpoint: "https://169.254.169.254/mcp", fetch: mcp.fetcher, protocolVersion: "2026-07-28" })).toThrow();
    const client = new McpHttpClient({ endpoint: "https://mcp.tavily.com/mcp/", fetch: mcp.fetcher, protocolVersion: "2026-07-28", headers: async () => ({ authorization: "Bearer SECRET-FROM-STORE-0123456789" }) });
    const tools = await client.listTools();
    const catalog = new research.ToolCatalog(tools);
    const digest = await research.computeSchemaDigest(tools);

    const c = await w.owner.exec("connection.register", { kind: "tavily", label: "Tavily", endpoint: "https://mcp.tavily.com/mcp/", namespace: "tavily", secretRef: "TAVILY_API_KEY" });
    const connectionId = String(c.result["connectionId"]);
    const SYSTEM = { actor: "system" as const, channel: "system" as const, authorization: "system_schedule" as const };
    await w.owner.exec("connection.record_discovery", { connectionId, protocolVersion: "2026-07-28", schemaDigest: digest, tools: catalog.entries().map((e) => ({ name: e.name, description: e.description, enabled: e.enabled, disabledReason: e.reason, group: e.name.includes("research") ? "research" : "search" })) }, SYSTEM);
    const rt = { db: w.h.db, userId: w.owner.userId, connectionId, client };
    const search = searchProviderFor(rt, "tavily", tools)!;
    const extract = extractBackendFor(rt, tools)!;

    // Not enabled by the owner yet: nothing is called.
    await expect(search.search("harley crewneck")).rejects.toMatchObject({ code: "not_executable" });
    await w.owner.exec("connection.set_tool_groups", { connectionId, enabledGroups: ["search", "research"] });

    const found = await search.search("harley crewneck");
    expect(found.results[0]).toMatchObject({ title: "Crewneck", snippet: "A jumper" });
    expect(found.results[0]!.url).not.toContain("LEAKED123456"); // a key-bearing result URL is redacted
    const searchCall = mcp.calls.find((x) => x.method === "tools/call")!;
    expect(searchCall.params).toEqual({ name: "tavily_search", arguments: { query: "harley crewneck" } }); // no generated-answer option
    expect(searchCall.headers["authorization"]).toContain("SECRET-FROM-STORE"); // resolved at dispatch, in a header only
    expect(JSON.stringify(searchCall.params)).not.toContain("SECRET");
    expect(searchCall.headers["mcp-protocol-version"]).toBe("2026-07-28");

    const extracted = await extract.extract({ urls: ["https://shop.example/p", "https://shop.example/dropped"], depth: "advanced", includeImages: true, timeoutMs: 1000 });
    expect(extracted.results[0]!.content).toContain("Shetland wool");
    expect(extracted.failed).toEqual([{ url: "https://shop.example/dropped", error: "no result returned for this URL" }]);
    expect(mcp.calls.at(-1)!.params.arguments).toEqual({ urls: ["https://shop.example/p", "https://shop.example/dropped"], extract_depth: "advanced", include_images: true });

    // A provider-side research agent stays disabled even though its group was enabled.
    expect(catalog.entry("tavily_research")).toMatchObject({ discovered: true, enabled: false });
    expect(catalog.prepareToolCall("tavily_research", { input: "x" }).ok).toBe(false);
    expect(argsFromSchema({ properties: { q: {} } }, { query: { names: ["query", "q"], value: "x" } })).toEqual({ args: { q: "x" }, missing: [] });

    // Revocation: the very next call is refused before anything is sent.
    const sent = mcp.calls.length;
    await w.owner.exec("connection.set_status", { connectionId, status: "revoked" });
    await expect(search.search("again")).rejects.toBeInstanceOf(ConnectionError);
    expect(mcp.calls.length).toBe(sent);
  });
});

describe("assistant maintenance (real outbox, real Durable Object; FAKE AI Search index)", () => {
  it("delivers each job result to the conversation once, reconciles erasures per store and rechecks the owner's account", async () => {
    const w = await createWorld({ real: false });
    /** FAKE AI Search index (test double). */
    const docs = new Map<string, SearchDocument>();
    const index: SearchIndexPort = { upsert: async (d) => (docs.set(d.sourceId, d), { status: "searchable" as const }), remove: async (id) => void docs.delete(id), search: async () => [] };
    const sweep = () => runAssistantMaintenance({ db: w.h.db, service: w.h.service, env: env as never, gatewayId: TEST_GATEWAY_ID, nowMs: w.h.clock.now(), searchIndexFor: () => index }, { limit: 500 });

    w.model.script({ text: "Looking into it." });
    const said = await w.client.runTurn({ submissionId: submission(), text: "A private remark I will want forgotten about my old landlord" });
    const messageId = (await w.client.transcript({})).messages.find((m) => m.turnId === said.turnId && m.role === "user")!.messageId;
    const job = await w.owner.exec("job.create", { kind: "email_investigation", title: "Everything bought from Drake's" }, { actor: "assistant", authorization: "owner_statement" });
    const SYSTEM = { actor: "system" as const, channel: "system" as const, authorization: "system_schedule" as const };
    await w.owner.exec("job.update", { jobId: job.result["jobId"], state: "completed", coverage: { from: "2024-01-01", to: "2026-09-15", completion: "partial", resumeToken: "p3" }, committedCommandIds: ["cmd_1"] }, SYSTEM);

    const calls = w.model.requests.length;
    const first = await sweep();
    expect(first.delivered).toBe(1);
    expect(first.searchUploaded).toBeGreaterThan(0);
    const card = (await w.client.transcript({})).messages.at(-1)!;
    expect(card.text).toContain("Everything bought from Drake's");
    expect(card.text).toContain("partial, not everything was searched");
    expect(card.text).toContain("1 change(s) were recorded and remain in place");
    expect(w.model.requests.length).toBe(calls); // delivered without inference
    expect((await sweep()).delivered).toBe(0);
    expect((await w.client.transcript({})).messages.filter((m) => m.text.includes("Everything bought from Drake's"))).toHaveLength(1);
    expect((await listJobs(w.h.db, w.owner.principal()))[0]!.deliveredAt).not.toBeNull();
    expect(docs.has(`message:${messageId}`)).toBe(true);

    // Forgetting: the sweep erases the transcript copy, removes the AI Search document, and only then is the source fully erased.
    await w.owner.exec("conversation.forget_source", { sourceKind: "message", sourceIds: [messageId] }, { actor: "assistant", authorization: "owner_statement" });
    expect((await listForgetStates(w.h.db, w.owner.principal()))[0]).toMatchObject({ state: "suppressed" });
    await sweep();
    expect(docs.has(`message:${messageId}`)).toBe(false);
    const state = (await listForgetStates(w.h.db, w.owner.principal()))[0]!;
    expect(state).toMatchObject({ state: "erased", pendingStores: [] });
    expect(state.erasedStores.sort()).toEqual(["ai_search", "ledger", "retrieval_index", "summaries", "transcript"]);
    expect(JSON.stringify(await w.client.exportConversation())).not.toContain("landlord");
    expect((await readOutbox(w.h.db, { topics: ["conversation.deliver", "conversation.erase", "search.delete"], limit: 500 })).filter((e) => e.userId === w.owner.userId)).toHaveLength(0);

    // A disabled account receives nothing.
    await w.owner.exec("job.create", { jobId: "job_late", kind: "other", title: "Late job" }, { actor: "assistant", authorization: "owner_statement" });
    await w.owner.exec("job.update", { jobId: "job_late", state: "completed" }, SYSTEM);
    await w.h.db.prepare("UPDATE users SET status = 'disabled' WHERE user_id = ?").bind(w.owner.userId).run();
    const blocked = await sweep();
    expect(blocked.skippedOwners).toEqual([w.owner.userId]);
    expect(blocked.delivered).toBe(0);
    expect((await all(w.h.db, "SELECT 1 FROM assistant_deliveries WHERE user_id = ? AND delivery_id = 'job-result:job_late'", w.owner.userId))).toHaveLength(0);
  });
});
