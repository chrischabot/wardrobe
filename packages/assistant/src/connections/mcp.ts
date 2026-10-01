/**
 * Outbound MCP connections: a small JSON-RPC client over HTTPS and adapters that turn DISCOVERED tools into
 * the assistant's search and extraction ports.
 *
 * What is verified here and what is not: the request framing is the Model Context Protocol's JSON-RPC over
 * streamable HTTP (`tools/list`, `tools/call`, optional `initialize` for session-based revisions). Tool names
 * and argument names are never assumed: arguments are filled only for properties that exist in the tool's
 * discovered input schema, and results are read tolerantly. None of this was exercised against the real
 * Exa, Tavily or Google endpoints from this repository (no credentials or network policy for them here);
 * the deployment probes record each connection's working contract with `connection.record_discovery`.
 *
 * Policy enforced outside the model on every call: the endpoint passes the SSRF guard, the connection's
 * status and enabled tool groups are re-read from D1 immediately before dispatch (so a revoked connection
 * stops queued retries), provider-inference tools stay disabled, generated-answer options are stripped,
 * private material is never forwarded, responses are size-bounded and time-bounded, and credentials are
 * resolved privately at dispatch time and never appear in arguments, results, logs or model context.
 */
import { first, json, type Db } from "@garderobe/domain";
import { redactDeep } from "../policy/secrets.ts";
import { ToolCatalog, assertPublicHttpsUrl, canExecute, namespacedToolName, redactSecretsInUrl, type DiscoveredTool, type SearchProvider, type TavilyExtractBackend } from "../research/index.ts";

export class ConnectionError extends Error {
  constructor(readonly code: "not_executable" | "tool_refused" | "transport" | "protocol" | "too_large" | "tool_error", message: string) {
    super(message);
  }
}

export const MAX_MCP_RESPONSE_BYTES = 2_000_000;
export const DEFAULT_MCP_TIMEOUT_MS = 30_000;

export interface McpClientOptions {
  endpoint: string;
  fetch: typeof fetch;
  /** Resolved at dispatch time by trusted code (for example an Authorization header from the credential store). */
  headers?: () => Promise<Record<string, string>>;
  protocolVersion: string;
  /** Session-based protocol revisions need `initialize` first; stateless revisions do not. */
  sessionBased?: boolean;
  timeoutMs?: number;
}

export interface McpToolResult {
  text: string;
  structured: unknown;
  isError: boolean;
}

export class McpHttpClient {
  private readonly endpoint: string;
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(private readonly options: McpClientOptions) {
    this.endpoint = assertPublicHttpsUrl(options.endpoint);
  }

  private async rpc(method: string, params: Record<string, unknown>, notification = false): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS);
    try {
      const secret = (await this.options.headers?.()) ?? {};
      const response = await this.options.fetch(this.endpoint, {
        method: "POST",
        redirect: "error", // a redirect could leave the validated origin
        signal: controller.signal,
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": this.options.protocolVersion, ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}), ...secret },
        body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: this.nextId++ }), method, params }),
      });
      const session = response.headers.get("mcp-session-id");
      if (session) this.sessionId = session;
      if (notification) return null;
      if (!response.ok) throw new ConnectionError("transport", `the service answered ${response.status}`);
      const body = await response.text();
      if (body.length > MAX_MCP_RESPONSE_BYTES) throw new ConnectionError("too_large", "the service's answer exceeded the size limit");
      const payload = (response.headers.get("content-type") ?? "").includes("text/event-stream")
        ? body.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).at(-1) ?? ""
        : body;
      let message: any;
      try {
        message = JSON.parse(payload);
      } catch {
        throw new ConnectionError("protocol", "the service did not answer with JSON-RPC");
      }
      if (message.error) throw new ConnectionError("protocol", `the service refused ${method}: ${String(message.error.message ?? "error").slice(0, 200)}`);
      return message.result;
    } catch (e) {
      if (e instanceof ConnectionError) throw e;
      // Never surface a raw error: it could carry a key-bearing URL.
      throw new ConnectionError("transport", (e as Error)?.name === "AbortError" ? "the service timed out" : "the service could not be reached");
    } finally {
      clearTimeout(timer);
    }
  }

  private async ready(): Promise<void> {
    if (!this.options.sessionBased || this.sessionId) return;
    await this.rpc("initialize", { protocolVersion: this.options.protocolVersion, capabilities: {}, clientInfo: { name: "garderobe", version: "1.0.0" } });
    await this.rpc("notifications/initialized", {}, true);
  }

  async listTools(): Promise<DiscoveredTool[]> {
    await this.ready();
    const result = await this.rpc("tools/list", {});
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    return tools.filter((t: any) => typeof t?.name === "string").map((t: any) => ({ name: t.name, ...(typeof t.description === "string" ? { description: t.description } : {}), inputSchema: t.inputSchema ?? {} }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    await this.ready();
    const result = await this.rpc("tools/call", { name, arguments: args });
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("\n");
    // Tool output is untrusted data and is scrubbed of anything credential-shaped before it goes anywhere.
    return redactDeep({ text, structured: result?.structuredContent ?? null, isError: result?.isError === true });
  }
}

/** Fill only arguments the discovered schema declares; nothing is sent under an assumed name. */
export function argsFromSchema(inputSchema: unknown, wanted: Record<string, { names: string[]; value: unknown }>): { args: Record<string, unknown>; missing: string[] } {
  const properties = Object.keys(((inputSchema as { properties?: Record<string, unknown> })?.properties ?? {}) as Record<string, unknown>);
  const args: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const [role, { names, value }] of Object.entries(wanted)) {
    const key = properties.find((p) => names.includes(p.toLowerCase()));
    if (key) args[key] = value;
    else missing.push(role);
  }
  return { args, missing };
}

function parsed(result: McpToolResult): any {
  if (result.structured && typeof result.structured === "object") return result.structured;
  try {
    return JSON.parse(result.text);
  } catch {
    return null;
  }
}

export interface ConnectionRuntime {
  db: Db;
  userId: string;
  connectionId: string;
  client: McpHttpClient;
}

/** Re-read the connection immediately before every dispatch: revoked or re-authorization-needed stops the call. */
async function guardedCall(rt: ConnectionRuntime, catalog: ToolCatalog, tool: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const row = await first<{ status: string; enabled_groups_json: string; tools_json: string; namespace: string }>(rt.db, "SELECT status, enabled_groups_json, tools_json, namespace FROM connections WHERE user_id = ? AND connection_id = ?", rt.userId, rt.connectionId);
  if (!row) throw new ConnectionError("not_executable", "that connection does not exist");
  const recorded = json<{ name: string; group: string | null; enabled: boolean }[]>(row.tools_json, []).find((t) => t.name === tool);
  if (!recorded || !recorded.enabled || !canExecute({ status: row.status, enabledGroups: json<string[]>(row.enabled_groups_json, []) }, { group: recorded.group })) {
    throw new ConnectionError("not_executable", `${namespacedToolName(row.namespace, tool)} is not available: the connection is ${row.status.replace(/_/g, " ")} or the tool group is not enabled`);
  }
  const prepared = catalog.prepareToolCall(tool, args);
  if (!prepared.ok) throw new ConnectionError("tool_refused", prepared.reason);
  const result = await rt.client.callTool(prepared.toolName, prepared.args);
  if (result.isError) throw new ConnectionError("tool_error", "the service reported an error for this request");
  return result;
}

/** A search provider backed by a connection's discovered search tool (Exa, Tavily or an owner-added service). */
export function searchProviderFor(rt: ConnectionRuntime, name: string, tools: DiscoveredTool[]): SearchProvider | null {
  const catalog = new ToolCatalog(tools);
  const resolved = catalog.resolveCapability("search");
  const tool = tools.find((t) => t.name === resolved.tool);
  if (!tool) return null;
  return {
    name,
    async search(query: string) {
      const { args, missing } = argsFromSchema(tool.inputSchema, { query: { names: ["query", "q", "search_query"], value: query } });
      if (missing.length > 0) throw new ConnectionError("protocol", "the search tool's schema has no query argument");
      const body = parsed(await guardedCall(rt, catalog, tool.name, args));
      const list: any[] = Array.isArray(body?.results) ? body.results : Array.isArray(body) ? body : [];
      return {
        results: list
          .filter((r) => typeof r?.url === "string")
          .map((r) => ({ url: redactSecretsInUrl(r.url), title: String(r.title ?? r.url), snippet: String(r.snippet ?? r.content ?? r.text ?? r.description ?? "").slice(0, 600) })),
      };
    },
  };
}

/** The Tavily Extract backend of the extraction router, over the connection's discovered extract tool. */
export function extractBackendFor(rt: ConnectionRuntime, tools: DiscoveredTool[]): TavilyExtractBackend | null {
  const catalog = new ToolCatalog(tools);
  const resolved = catalog.resolveCapability("extract");
  const tool = tools.find((t) => t.name === resolved.tool);
  if (!tool) return null;
  return {
    async extract(req) {
      const { args, missing } = argsFromSchema(tool.inputSchema, {
        urls: { names: ["urls", "url"], value: req.urls },
        depth: { names: ["extract_depth", "depth"], value: req.depth },
        images: { names: ["include_images", "includeimages"], value: true },
      });
      if (missing.includes("urls")) throw new ConnectionError("protocol", "the extract tool's schema has no URL argument");
      const body = parsed(await guardedCall(rt, catalog, tool.name, args));
      const results: any[] = Array.isArray(body?.results) ? body.results : [];
      const failed: any[] = Array.isArray(body?.failed_results) ? body.failed_results : Array.isArray(body?.failed) ? body.failed : [];
      const seen = new Set(results.map((r) => r?.url));
      return {
        results: results.filter((r) => typeof r?.url === "string").map((r) => ({ url: r.url, content: String(r.raw_content ?? r.content ?? r.text ?? ""), images: Array.isArray(r.images) ? r.images.filter((i: unknown) => typeof i === "string") : [] })),
        // A URL the service silently dropped is a failure too, even when the call as a whole succeeded.
        failed: [...failed.filter((f) => typeof f?.url === "string").map((f) => ({ url: f.url, error: String(f.error ?? "failed") })), ...req.urls.filter((u) => !seen.has(u) && !failed.some((f) => f?.url === u)).map((url) => ({ url, error: "no result returned for this URL" }))],
      };
    },
  };
}
