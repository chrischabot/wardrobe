import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MCP_ORIGIN, connectMcp, provisionOwner } from "../src/testing/index.ts";

/*
 * Specification section 13 (line 862): "Use the Tasks extension where both peers support it; otherwise return
 * a normal result containing the Garderobe run handle." The installed server SDK (@modelcontextprotocol/server
 * 2.0.0) marks the task methods as "2025-11-25 wire vocabulary with no SDK runtime", so this server is not a
 * peer that supports Tasks. This test pins the specification's other branch: no `tasks` capability is
 * advertised, so a client never negotiates Tasks with it, and a task method is refused as unknown rather than
 * half-handled. That long work answers with a run handle that `garderobe_run` reads is covered in
 * runs.test.ts ("over MCP the tool returns the run handle and garderobe_run reads the result").
 * A real MCP client over HTTP against the real Worker; a LABELLED SYNTHETIC owner; a test-signed Access assertion on consent.
 */
describe("MCP Tasks extension (specification section 13, line 862)", () => {
  it("advertises no tasks capability and refuses a task method as unknown, so peers use the run handle instead", async () => {
    const owner = await provisionOwner();
    // The wire is observed (not changed) so a request the SDK client really sent can be replayed with another method.
    let sent: { headers: Headers; body: Record<string, any> } | null = null;
    const mcp = await connectMcp(owner, {
      write: false,
      clientName: "Tasks probe (test)",
      wrapFetch: (inner) => async (input, init) => {
        if (typeof init?.body === "string" && init.body.includes('"tools/list"')) sent = { headers: new Headers(init.headers), body: JSON.parse(init.body) };
        return inner(input, init);
      },
    });
    const capabilities = mcp.client.getServerCapabilities() ?? {};
    expect(Object.keys(capabilities)).not.toContain("tasks");
    expect(capabilities.tools).toBeTruthy();
    await mcp.client.listTools();
    expect(sent).not.toBeNull();

    // The same request, with the same headers and envelope, asking for a task instead of the tool list.
    const { headers, body } = sent!;
    headers.set("Authorization", `Bearer ${mcp.oauth.snapshot().accessToken}`);
    if (headers.has("Mcp-Method")) headers.set("Mcp-Method", "tasks/get");
    const raw = await SELF.fetch(`${MCP_ORIGIN}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, id: 7, method: "tasks/get", params: { ...(body.params ?? {}), taskId: "SYNTHETIC-task-1" } }),
    });
    const text = await raw.text();
    const payload = text.trim().startsWith("{") ? text : (text.split("\n").find((line) => line.startsWith("data:"))?.slice(5) ?? "{}");
    const message = JSON.parse(payload) as { result?: unknown; error?: { code: number } };
    expect(message.result, text).toBeUndefined();
    expect(message.error?.code, text).toBe(-32601);
    await mcp.close();
  });
});
