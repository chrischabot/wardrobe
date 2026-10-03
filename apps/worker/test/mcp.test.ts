import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { MCP_TOOL_NAMES } from "@garderobe/contracts/ext/api";
import { APP_ORIGIN, MCP_ORIGIN, connectMcp, decideConsent, ownerDay, provisionOwner, testApp, toolResult, type McpConnection, type TestOwner } from "../src/testing/index.ts";

/*
 * A real MCP client (the TypeScript SDK's Client over streamable HTTP) against the real Worker:
 * discovery, dynamic registration, authorization code with PKCE, consent, token, tool calls.
 * The owner is the REAL owner fixture (supplied profile and inventory). Access sign-in on the consent
 * page is a test-signed assertion; the conversation model is the labelled fake.
 */
let owner: TestOwner;
let reader: McpConnection;
let writer: McpConnection;

beforeAll(async () => {
  owner = await provisionOwner({ real: true });
  reader = await connectMcp(owner, { write: false, clientName: "Read-only assistant" });
  writer = await connectMcp(owner, { write: true, clientName: "Writing assistant", redirectUri: "https://writer.client.test/oauth/callback" });
});

describe("discovery", () => {
  it("publishes protected-resource and authorization-server metadata on the MCP hostname", async () => {
    const resource = (await (await SELF.fetch(`${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp`)).json()) as any;
    expect(resource.resource).toBe(`${MCP_ORIGIN}/mcp`);
    expect(resource.authorization_servers).toEqual([MCP_ORIGIN]);
    const server = (await (await SELF.fetch(`${MCP_ORIGIN}/.well-known/oauth-authorization-server`)).json()) as any;
    expect(server.issuer).toBe(MCP_ORIGIN);
    // Consent happens on the Access-protected app hostname; tokens on the MCP hostname.
    expect(server.authorization_endpoint).toBe(`${APP_ORIGIN}/oauth/authorize`);
    expect(server.token_endpoint).toBe(`${MCP_ORIGIN}/oauth/token`);
    expect(server.registration_endpoint).toBe(`${MCP_ORIGIN}/oauth/register`);
    expect(server.revocation_endpoint).toBeTruthy();
    expect(server.code_challenge_methods_supported).toEqual(["S256"]);
    expect(server.scopes_supported).toEqual(expect.arrayContaining(["wardrobe.read", "wardrobe.write"]));
  });
});

describe("tools", () => {
  it("offers a read-only connection every tool except the write tool, with truthful annotations", async () => {
    const read = await reader.client.listTools();
    const names = read.tools.map((t) => t.name).sort();
    expect(names).toEqual(MCP_TOOL_NAMES.filter((n) => n !== "garderobe_command").slice().sort());
    const write = await writer.client.listTools();
    expect(write.tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    const command = write.tools.find((t) => t.name === "garderobe_command")!;
    expect(command.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect(write.tools.find((t) => t.name === "garderobe_inventory")!.annotations).toMatchObject({ readOnlyHint: true });
    for (const tool of write.tools) {
      expect(tool.outputSchema).toBeTruthy();
      // No tool takes an owner.
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/userId|ownerId|user_id/);
    }
  });

  it("returns the complete real inventory with explicit completeness", async () => {
    const result = toolResult(await reader.client.callTool({ name: "garderobe_inventory", arguments: { view: "snapshot" } }));
    expect(result.ok).toBe(true);
    const api = await owner.api.json("GET", "/v1/wardrobe");
    expect(result.data.complete).toBe(true);
    expect(result.data.total).toBe(api.total);
    expect(result.data.data.items).toHaveLength(api.total);
    expect(result.data.wardrobeRevision).toBe(api.wardrobeRevision);
    const page = toolResult(await reader.client.callTool({ name: "garderobe_inventory", arguments: { view: "items", limit: 10 } }));
    expect(page.data.complete).toBe(false);
    expect(page.data.nextCursor).toBeTruthy();
    expect(page.data.total).toBe(api.total);
  });
});

describe("commands over MCP", () => {
  /** Today as the owner counts it (the owner's timezone), not the UTC date. */
  const today = () => ownerDay(owner);
  const cleanTop = async (skip: string[] = []) => {
    const inventory = await owner.api.json("GET", "/v1/wardrobe");
    return inventory.items.find((i: any) => i.garment.acquisition === "owned" && i.garment.roles.includes("top") && !skip.includes(i.garment.garmentId) && i.balances.some((b: any) => b.bucket === "clean" && b.quantity > 0));
  };

  it("executes a typed command through the same command service: the receipt is the one the API serves", async () => {
    const top = await cleanTop();
    const key = `mcp-wear-${crypto.randomUUID()}`;
    const args = { type: "wear.record", payload: { wearingDate: await today(), garmentIds: [top.garment.garmentId] }, idempotencyKey: key };
    const result = toolResult(await writer.client.callTool({ name: "garderobe_command", arguments: args }));
    expect(result.ok).toBe(true);
    const receipt = result.data.receipt;
    expect(receipt.outcome).toBe("committed");
    expect(receipt.channel).toBe("mcp");
    expect(receipt.actor).toBe("assistant");
    // The native API reads the very same stored receipt, and the day's record shows the wear.
    const viaApi = await owner.api.json("GET", `/v1/commands/${receipt.commandId}`);
    expect(viaApi).toEqual({ ...receipt, replayed: false });
    const day = await owner.api.json("GET", `/v1/days/${await today()}`);
    expect(day.garments.map((g: any) => g.garmentId)).toContain(top.garment.garmentId);
    // A retry with the same key returns the stored receipt; nothing is recorded twice.
    const retry = toolResult(await writer.client.callTool({ name: "garderobe_command", arguments: args }));
    expect(retry.data.receipt.replayed).toBe(true);
    expect(retry.data.receipt.commandId).toBe(receipt.commandId);
    // The same wear reported from the phone merges with it (one counted wear across clients).
    const fromPhone = await (await owner.api.command("wear.record", args.payload)).json();
    expect((fromPhone as any).outcome).toBe("merged");
  });

  it("returns the API's typed errors for a refused command and writes nothing", async () => {
    const missing = toolResult(await writer.client.callTool({ name: "garderobe_command", arguments: { type: "wear.record", payload: { wearingDate: await today(), garmentIds: ["gmt_invented_by_a_model"] }, idempotencyKey: `mcp-${crypto.randomUUID()}` } }));
    expect(missing.ok).toBe(false);
    expect(missing.error!.code).toBe("not_found");
    const unknown = toolResult(await writer.client.callTool({ name: "garderobe_command", arguments: { type: "garment.invent", payload: {}, idempotencyKey: `mcp-${crypto.randomUUID()}` } }));
    expect(unknown.error!.code).toBe("unknown_command");
  });

  it("cannot use system or import authority, or an account-level (admin) command", async () => {
    const reset = toolResult(await writer.client.callTool({ name: "garderobe_command", arguments: { type: "laundry.apply_weekly_reset", payload: {}, idempotencyKey: `mcp-${crypto.randomUUID()}` } }));
    expect(reset.ok).toBe(false);
    expect(reset.error!.code).toBe("forbidden");
    const importRun = toolResult(await writer.client.callTool({ name: "garderobe_command", arguments: { type: "import.record_run", payload: {}, idempotencyKey: `mcp-${crypto.randomUUID()}` } }));
    expect(importRun.ok).toBe(false);
    expect(["forbidden", "invalid_command"]).toContain(importRun.error!.code);
  });

  it("rejects a model-supplied owner: tool inputs are strict and the owner is the grant's", async () => {
    const stranger = await provisionOwner();
    const call = writer.client.callTool({ name: "garderobe_inventory", arguments: { view: "snapshot", userId: stranger.userId } });
    const outcome = await call.then((r) => toolResult(r), (error) => ({ ok: false, error: { code: "protocol", message: String(error.message), details: {} }, data: null }));
    expect(outcome.ok).toBe(false);
    // And an ordinary call still returns the connected owner's wardrobe, not the stranger's empty one.
    const mine = toolResult(await writer.client.callTool({ name: "garderobe_inventory", arguments: { view: "snapshot" } }));
    expect(mine.data.total).toBeGreaterThan(50);
  });

  it("a read-only connection is refused the write tool with a scope challenge and changes nothing", async () => {
    const top = await cleanTop();
    const before = await owner.api.json("GET", `/v1/commands?entity=garment:${top.garment.garmentId}`);
    const tokens = reader.oauth.snapshot();
    const raw = await SELF.fetch(`${MCP_ORIGIN}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${tokens.accessToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "garderobe_command", arguments: { type: "care.mark_dirty", payload: { items: [{ garmentId: top.garment.garmentId, quantity: 1 }] }, idempotencyKey: `ro-${crypto.randomUUID()}` } } }),
    });
    expect(raw.status).toBe(403);
    expect(raw.headers.get("WWW-Authenticate")).toContain("insufficient_scope");
    expect(raw.headers.get("WWW-Authenticate")).toContain("wardrobe.write");
    const after = await owner.api.json("GET", `/v1/commands?entity=garment:${top.garment.garmentId}`);
    expect(after.receipts.length).toBe(before.receipts.length);
  });
});

describe("sensitive typed commands wait for the owner", () => {
  /** A labelled synthetic garment created for this test only; it is not the owner's real stock. */
  async function syntheticGarment(name: string): Promise<string> {
    const receipt = (await (
      await owner.api.command("garment.create", { name, category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, isSynthetic: true, source: { kind: "system", note: "synthetic boundary-test garment" } })
    ).json()) as any;
    if (!receipt.affected) throw new Error(`garment.create failed: ${JSON.stringify(receipt)}`);
    return receipt.affected.find((a: any) => a.kind === "garment").id;
  }
  const retire = (garmentId: string, key: string) => ({ name: "garderobe_command", arguments: { type: "garment.retire", payload: { garmentId, disposition: "donated" }, idempotencyKey: key } });
  const retired = async (garmentId: string) => (await owner.api.json("GET", `/v1/commands?entity=garment:${garmentId}`)).receipts.filter((r: any) => r.type === "garment.retire");
  const pending = async () => (await owner.api.json("GET", "/v1/proposals")).proposals as any[];

  it("is not executed and not confirmable by the connection, even one that answers yes to every question; the owner's confirmation in the app runs it once", async () => {
    const garmentId = await syntheticGarment("Synthetic test shirt A (not real stock)");
    const asked: string[] = [];
    const eager = await connectMcp(owner, { write: true, clientName: "Eager assistant", redirectUri: "https://confirm.client.test/cb", onElicit: (p) => (asked.push(String(p.message)), { action: "accept", content: { confirm: true } }) });
    const key = `retire-${crypto.randomUUID()}`;
    const result = toolResult(await eager.client.callTool(retire(garmentId, key)));
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: "confirmation_required", details: { reason: "owner_confirmation_required", state: "pending" } });
    expect(asked).toEqual([]); // the connection is never asked: its answer would be its own
    expect(await retired(garmentId)).toEqual([]);
    // Repeating the call neither executes it nor makes a second proposal.
    expect(toolResult(await eager.client.callTool(retire(garmentId, key))).error!.code).toBe("confirmation_required");
    const waiting = (await pending()).filter((p) => p.type === "garment.retire" && p.payload.garmentId === garmentId);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ state: "pending", turnId: "", source: { channel: "mcp", assistantName: "Eager assistant" }, payload: { garmentId, disposition: "donated" } });
    // The summary is written by trusted code from the exact request, in words, with the garment's name from the ledger.
    expect(waiting[0].summary).toContain("\u201CSynthetic test shirt A (not real stock)\u201D has left your wardrobe for good (donated)");
    expect(waiting[0].summary).not.toContain(garmentId);
    // The same key with a different request is refused and does not replace what the owner will see.
    const second = await syntheticGarment("Synthetic test shirt A2 (not real stock)");
    expect(toolResult(await eager.client.callTool(retire(second, key))).error!.code).toBe("idempotency_key_reuse");
    expect((await pending()).some((p) => p.payload.garmentId === second)).toBe(false);

    // The owner confirms in the app: the change is made once, as the owner's tap.
    const decided = (await (await owner.api.post(`/v1/proposals/${waiting[0].proposalId}/decision`, { decision: "confirm" })).json()) as any;
    expect(decided).toMatchObject({ replayed: false, proposal: { state: "confirmed" }, receipt: { type: "garment.retire", outcome: "committed" } });
    const command = await (await testApp()).db.prepare("SELECT actor, channel, authorization_basis FROM commands WHERE user_id = ? AND command_id = ?").bind(owner.userId, decided.receipt.commandId).first();
    expect(command).toEqual({ actor: "owner", channel: "ios", authorization_basis: "owner_tap" });
    // The connection learns the outcome by repeating its call; nothing runs a second time.
    const again = toolResult(await eager.client.callTool(retire(garmentId, key)));
    expect(again.ok, JSON.stringify(again.error)).toBe(true);
    expect(again.data.receipt).toMatchObject({ commandId: decided.receipt.commandId, replayed: true });
    expect(await retired(garmentId)).toHaveLength(1);
    await eager.close();
  });

  it("does nothing when the owner rejects it, and tells the connection so", async () => {
    const garmentId = await syntheticGarment("Synthetic test shirt B (not real stock)");
    const key = `retire-${crypto.randomUUID()}`;
    expect(toolResult(await writer.client.callTool(retire(garmentId, key))).error!.code).toBe("confirmation_required");
    const proposal = (await pending()).find((p) => p.payload.garmentId === garmentId)!;
    expect((await owner.api.post(`/v1/proposals/${proposal.proposalId}/decision`, { decision: "reject" })).status).toBe(200);
    const result = toolResult(await writer.client.callTool(retire(garmentId, key)));
    expect(result.error).toMatchObject({ code: "forbidden", details: { reason: "rejected_by_owner" } });
    expect(await retired(garmentId)).toEqual([]);
  });

  it("covers the undo of a sensitive change, while a routine change and its undo still run directly", async () => {
    const garmentId = await syntheticGarment("Synthetic test shirt C (not real stock)");
    const created = (await owner.api.json("GET", `/v1/commands?entity=garment:${garmentId}`)).receipts.find((r: any) => r.type === "garment.create");
    const undo = (commandId: string) => ({ name: "garderobe_command", arguments: { type: "command.undo", payload: { commandId }, idempotencyKey: `undo-${crypto.randomUUID()}` } });
    // Undoing the creation would remove the garment: it waits for the owner.
    expect(toolResult(await writer.client.callTool(undo(created.commandId))).error!.code).toBe("confirmation_required");
    expect((await owner.api.json("GET", "/v1/wardrobe")).items.some((i: any) => i.garment.garmentId === garmentId)).toBe(true);
    const undoProposal = (await pending()).find((p) => p.type === "command.undo" && p.payload.commandId === created.commandId);
    expect(undoProposal.summary).toMatch(/^Undo an earlier change \(add a garment to the wardrobe\) whose receipt read \u201C.+\u201D/);
    expect(undoProposal.summary).not.toContain("garment.create");
    // A wear report on a garment the connection names is recorded at once, and so is its undo.
    const wore = toolResult(await writer.client.callTool({ name: "garderobe_command", arguments: { type: "wear.record", payload: { wearingDate: await ownerDay(owner), garmentIds: [garmentId] }, idempotencyKey: `wear-${crypto.randomUUID()}` } }));
    expect(wore.ok, JSON.stringify(wore.error)).toBe(true);
    const undone = toolResult(await writer.client.callTool(undo(wore.data.receipt.commandId)));
    expect(undone.ok, JSON.stringify(undone.error)).toBe(true);
  });

  it("says so when a request names a garment that is not in the wardrobe, and stops a connection from filling the owner's list", async () => {
    // A synthetic owner, so the real owner's list is not filled by a test.
    const other = await provisionOwner();
    const noisy = await connectMcp(other, { write: true, clientName: "Noisy assistant (test)", redirectUri: "https://noisy.client.test/cb" });
    const ask = (n: number) => noisy.client.callTool({ name: "garderobe_command", arguments: { type: "garment.retire", payload: { garmentId: `gmt_invented_${n}`, disposition: "discarded" }, idempotencyKey: `noisy-${n}-${crypto.randomUUID()}` } });
    for (let n = 0; n < 40; n++) expect(toolResult(await ask(n)).error!.code, `request ${n}`).toBe("confirmation_required");
    const over = toolResult(await ask(40));
    expect(over.error).toMatchObject({ code: "rate_limited", details: { reason: "too_many_requests_waiting" } });
    const listed = (await other.api.json("GET", "/v1/proposals")).proposals as any[];
    expect(listed).toHaveLength(40);
    expect(listed[0].summary).toMatch(/a piece that is not in the wardrobe \(\u201Cgmt_invented_\d+\u201D\)/);
    // Confirming such a request changes nothing: the command refuses it and the proposal stays open.
    expect((await other.api.post(`/v1/proposals/${listed[0].proposalId}/decision`, { decision: "confirm" })).status).toBe(404);
    expect((await other.api.json("GET", "/v1/proposals")).proposals).toHaveLength(40);
    await noisy.close();
  });

  it("refuses an invalid sensitive request before anything is shown to the owner", async () => {
    const before = (await owner.api.json("GET", "/v1/proposals?state=all")).proposals.length;
    const result = toolResult(await writer.client.callTool({ name: "garderobe_command", arguments: { type: "garment.retire", payload: { disposition: "donated" }, idempotencyKey: `bad-${crypto.randomUUID()}` } }));
    expect(result.error!.code).toBe("invalid_command");
    expect((await owner.api.json("GET", "/v1/proposals?state=all")).proposals.length).toBe(before);
  });
});

describe("protocol contract", () => {
  it("rejects a request whose routing headers do not match its body", async () => {
    const token = reader.oauth.snapshot().accessToken;
    const response = await SELF.fetch(`${MCP_ORIGIN}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}`, "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list", "Mcp-Name": "garderobe_today" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "garderobe_inventory", arguments: { view: "snapshot" }, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "raw", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } },
      }),
    });
    const body = (await response.json()) as any;
    expect(body.error).toBeTruthy();
    expect(body.result).toBeUndefined();
  });

  it("serves a 2025-11-25 client through the compatibility path and records that per connection", async () => {
    const legacy = await connectMcp(owner, { write: false, clientName: "Legacy assistant", redirectUri: "https://legacy.client.test/cb", era: "legacy" });
    const tools = await legacy.client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("garderobe_inventory");
    const result = toolResult(await legacy.client.callTool({ name: "garderobe_inventory", arguments: { view: "laundry" } }));
    expect(result.ok).toBe(true);
    await legacy.close();
    const grants = await owner.api.json("GET", "/v1/assistants");
    const byName = (name: string) => grants.grants.find((g: any) => g.clientName === name);
    expect(byName("Legacy assistant")).toBeTruthy();
    const app = await (await import("../src/testing/index.ts")).testApp();
    const rows = await app.db.prepare("SELECT client_name, protocol FROM mcp_grants WHERE user_id = ?").bind(owner.userId).all<{ client_name: string; protocol: string | null }>();
    const protocolOf = (name: string) => rows.results.find((r) => r.client_name === name)?.protocol;
    expect(protocolOf("Legacy assistant")).toBe("2025-11-25 (compatibility)");
    expect(protocolOf("Read-only assistant")).toBe("2026-07-28");
  });

  it("exposes documents as resources without depending on them", async () => {
    const list = await reader.client.listResources();
    expect(list.resources.map((r) => r.uri).sort()).toEqual(["garderobe://commands", "garderobe://guide", "garderobe://style/profile"]);
    const profile = await reader.client.readResource({ uri: "garderobe://style/profile" });
    const style = await owner.api.json("GET", "/v1/style");
    expect((profile.contents[0] as any).text).toBe(style.document.content);
  });
});

describe("grants", () => {
  it("lists each connected assistant separately with its permissions and last use", async () => {
    const grants = (await owner.api.json("GET", "/v1/assistants")).grants;
    const read = grants.find((g: any) => g.clientName === "Read-only assistant");
    const write = grants.find((g: any) => g.clientName === "Writing assistant");
    expect(read).toMatchObject({ access: "read_only", scopes: ["wardrobe.read"], status: "active" });
    expect(write).toMatchObject({ access: "read_write", status: "active" });
    expect(read.lastUsedAt).toBeTruthy();
    expect(JSON.stringify(grants)).not.toMatch(/access_token|refresh_token|token_hash/);
  });

  it("records nothing when the owner denies, and the client is told so", async () => {
    const before = (await owner.api.json("GET", "/v1/assistants")).grants.length;
    const registration = (await (
      await SELF.fetch(`${MCP_ORIGIN}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Denied assistant", redirect_uris: ["https://denied.client.test/cb"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) })
    ).json()) as any;
    const url = new URL(`${APP_ORIGIN}/oauth/authorize`);
    url.search = new URLSearchParams({ response_type: "code", client_id: registration.client_id, redirect_uri: "https://denied.client.test/cb", scope: "wardrobe.read wardrobe.write", state: "st-1", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256", resource: `${MCP_ORIGIN}/mcp` }).toString();
    const consent = await decideConsent(owner, url, { allow: false });
    expect(consent.page).toContain("Denied assistant");
    expect(consent.page).toContain("denied.client.test");
    expect(consent.status).toBe(302);
    const back = new URL(consent.location!);
    expect(back.origin).toBe("https://denied.client.test");
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("st-1");
    expect((await owner.api.json("GET", "/v1/assistants")).grants.length).toBe(before);
  });

  it("shows the consent page only to a signed-in owner and escapes what the client supplied", async () => {
    const registration = (await (
      await SELF.fetch(`${MCP_ORIGIN}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: '<script>alert(1)</script> "Helper"', redirect_uris: ["https://xss.client.test/cb"], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" }) })
    ).json()) as any;
    const url = new URL(`${APP_ORIGIN}/oauth/authorize`);
    url.search = new URLSearchParams({ response_type: "code", client_id: registration.client_id, redirect_uri: "https://xss.client.test/cb", scope: "wardrobe.read", state: "st-2", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256", resource: `${MCP_ORIGIN}/mcp` }).toString();
    const anonymous = await SELF.fetch(url.toString(), { redirect: "manual" });
    expect(anonymous.status).toBe(401);
    const page = await SELF.fetch(url.toString(), { headers: await owner.api.with({ client: "web" }).headers(), redirect: "manual" });
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&#60;script&#62;");
    expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    // An unregistered redirect URI is never redirected to.
    url.searchParams.set("redirect_uri", "https://attacker.example/cb");
    const bad = await SELF.fetch(url.toString(), { headers: await owner.api.with({ client: "web" }).headers(), redirect: "manual" });
    expect(bad.status).toBe(400);
    expect(bad.headers.get("Location")).toBeNull();
  });

  it("refreshes with rotation, and a disconnect takes effect on the very next request", async () => {
    const conn = await connectMcp(owner, { write: true, clientName: "Short-lived assistant", redirectUri: "https://short.client.test/cb" });
    const { accessToken, refreshToken, clientId } = conn.oauth.snapshot();
    expect(refreshToken).toBeTruthy();
    const refresh = async (token: string) => SELF.fetch(`${MCP_ORIGIN}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: clientId, resource: `${MCP_ORIGIN}/mcp` }).toString() });
    const refreshed = (await (await refresh(refreshToken!)).json()) as any;
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.access_token).not.toBe(accessToken);
    expect(refreshed.refresh_token).not.toBe(refreshToken);
    expect(refreshed.expires_in).toBe(900);
    const list = (token: string) => SELF.fetch(`${MCP_ORIGIN}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect((await list(refreshed.access_token)).status).toBe(200);

    const grant = (await owner.api.json("GET", "/v1/assistants")).grants.find((g: any) => g.clientName === "Short-lived assistant" && g.status === "active");
    const disconnected = await owner.api.json("POST", `/v1/assistants/${grant.grantId}/disconnect`, {});
    expect(disconnected.status).toBe("revoked");
    expect(disconnected.version).toBe(grant.version + 1);
    // Tokens issued before the disconnect are refused at once, and cannot be refreshed.
    for (const token of [accessToken, refreshed.access_token]) expect((await list(token)).status).toBe(401);
    expect((await refresh(refreshed.refresh_token)).status).toBeGreaterThanOrEqual(400);
    // Other assistants and the native app are unaffected.
    expect((await writer.client.listTools()).tools.length).toBe(7);
    expect((await owner.api.get("/v1/me")).status).toBe(200);
    // Reconnecting is an ordinary new consent.
    const again = await connectMcp(owner, { write: false, clientName: "Short-lived assistant", redirectUri: "https://short.client.test/cb" });
    expect((await again.client.listTools()).tools.length).toBe(6);
    await again.close();
    await conn.close();
  });

  it("honours the D1 decision even while the provider would still accept the token", async () => {
    const conn = await connectMcp(owner, { write: false, clientName: "Stale-cache assistant", redirectUri: "https://stale.client.test/cb" });
    const { accessToken } = conn.oauth.snapshot();
    const app = await (await import("../src/testing/index.ts")).testApp();
    // Revoke ONLY the application record, leaving the provider's KV records untouched (a stale token cache).
    await app.db.prepare("UPDATE mcp_grants SET status = 'revoked', version = version + 1, revoked_at = ? WHERE user_id = ? AND client_name = ?").bind(new Date().toISOString(), owner.userId, "Stale-cache assistant").run();
    const response = await SELF.fetch(`${MCP_ORIGIN}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${accessToken}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(response.status).toBe(401);
    await conn.close();
  });
});
