/**
 * Outbound use of the owner's tool connections (Exa, Tavily or an owner-added MCP service).
 *
 * The assistant workstream owns the MCP client, the tool catalogue and the per-call guard that re-reads
 * the connection's status and enabled tool groups before every dispatch. This module only supplies what
 * that code cannot have: the validated transport (every request URL is checked, redirects are refused)
 * and the connection's credential, decrypted at dispatch time and sent as a header of that connection
 * only. Nothing here decides what a tool may do.
 */
import { ConnectionError, createBrowserRunBackend, extractBackendFor, McpHttpClient, research, searchProviderFor, type AssistantPorts } from "@garderobe/assistant";
import { all, first, type Db } from "@garderobe/domain";
import { guardedFetch } from "./endpoints.ts";

export type DiscoveredTool = research.DiscoveredTool;
/** Resolves the authorization header of ONE connection of ONE owner, or null when it has none. */
export type Authorize = () => Promise<{ header: string; value: string } | null>;

export const OUTBOUND_PROTOCOL = "2026-07-28";
export const OUTBOUND_COMPAT_PROTOCOL = "2025-11-25";
const isCompat = (protocol: string | null): boolean => (protocol ?? "").startsWith(OUTBOUND_COMPAT_PROTOCOL);
/** How the protocol that answered is recorded on the connection (the same wording as inbound grants). */
export const protocolLabel = (protocol: string): string => (protocol === OUTBOUND_COMPAT_PROTOCOL ? `${OUTBOUND_COMPAT_PROTOCOL} (compatibility)` : protocol);

function clientFor(endpoint: string, protocol: string, authorize: Authorize, requiresCredential: boolean): McpHttpClient {
  return new McpHttpClient({
    endpoint,
    fetch: guardedFetch(),
    protocolVersion: protocol,
    sessionBased: protocol === OUTBOUND_COMPAT_PROTOCOL,
    headers: async () => {
      const authorization = await authorize();
      // A connection that has a credential is never called without it.
      if (!authorization && requiresCredential) throw new ConnectionError("not_executable", "this connection needs to be connected again");
      return authorization ? { [authorization.header.toLowerCase()]: authorization.value } : {};
    },
  });
}

/**
 * Ask the remote service for its tools. The 2026-07-28 (stateless) contract is tried first; a peer that
 * refuses it is asked again as a 2025-11-25 session. The protocol that answered is returned so it can be
 * recorded for that connection; it is evidence of what this peer accepted, not of full conformance.
 */
export async function discoverRemoteTools(endpoint: string, recorded: string | null, authorize: Authorize, requiresCredential: boolean): Promise<{ tools: DiscoveredTool[]; protocol: string }> {
  const order = isCompat(recorded) ? [OUTBOUND_COMPAT_PROTOCOL, OUTBOUND_PROTOCOL] : [OUTBOUND_PROTOCOL, OUTBOUND_COMPAT_PROTOCOL];
  let failure: unknown = null;
  for (const protocol of order) {
    try {
      return { tools: await clientFor(endpoint, protocol, authorize, requiresCredential).listTools(), protocol };
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

/**
 * Health probe of one connected tool service: list its tools with the connection's own credential (no
 * tool is called, nothing is cached). Throws the assistant client's `ConnectionError`; code `auth`
 * means the service rejected the credential.
 */
export async function probeConnection(db: Db, userId: string, connectionId: string, authorize: Authorize): Promise<void> {
  const row = await first<ConnectedRow>(db, "SELECT connection_id, endpoint, protocol, auth_type, namespace FROM connection_profiles WHERE user_id = ? AND connection_id = ? AND state = 'connected' AND kind != 'google_workspace' AND endpoint IS NOT NULL", userId, connectionId);
  if (!row) throw new ConnectionError("not_executable", "this connection is not connected");
  const requiresCredential = row.auth_type !== "none";
  if (requiresCredential && !(await authorize())) throw new ConnectionError("auth", "this connection has no usable credential");
  await clientFor(row.endpoint, isCompat(row.protocol) ? OUTBOUND_COMPAT_PROTOCOL : OUTBOUND_PROTOCOL, authorize, requiresCredential).listTools();
}

const GROUPS = ["search", "fetch", "extract", "map", "crawl"] as const;
export const GROUP_LABELS: Record<string, string> = { search: "Search the web", fetch: "Fetch pages", extract: "Read pages", map: "Map a site", crawl: "Crawl a site", other: "Other tools" };

export interface DescribedTool {
  name: string;
  description: string | null;
  enabled: boolean;
  disabledReason: string | null;
  group: string;
}

/**
 * Describe discovered tools for the registry: the assistant's catalogue decides which tool serves which
 * capability and which tools stay disabled (provider-side inference); anything else is grouped as `other`.
 */
export function describeTools(tools: DiscoveredTool[]): DescribedTool[] {
  const catalog = new research.ToolCatalog(tools);
  const groupOf = new Map<string, string>();
  for (const group of GROUPS) {
    const tool = catalog.resolveCapability(group).tool;
    if (tool && !groupOf.has(tool)) groupOf.set(tool, group);
  }
  return catalog.entries().map((entry) => ({ name: entry.name, description: entry.description === "" ? null : entry.description.slice(0, 500), enabled: entry.enabled, disabledReason: entry.reason, group: groupOf.get(entry.name) ?? "other" }));
}

interface ConnectedRow {
  connection_id: string;
  endpoint: string;
  protocol: string | null;
  auth_type: string;
  namespace: string;
}

const TOOL_CACHE_MS = 10 * 60_000;
const toolCache = new Map<string, { tools: DiscoveredTool[]; at: number }>();

/** Forget cached tool schemas of a connection (after a change to it). */
export function forgetTools(userId: string, connectionId: string): void {
  toolCache.delete(`${userId}\u0000${connectionId}`);
}

export interface OutboundDeps {
  db: Db;
  userId: string;
  now(): number;
  /** The Browser Rendering binding, when this deployment has one. */
  browser?: unknown;
  /** The credential resolver for one connection of this owner (by its secret reference). */
  authorizeFor(connectionId: string): Authorize;
}

/** The discovered tools of one connected service of this owner, with their input schemas (for the assistant's tool browser). */
export async function listConnectionTools(deps: OutboundDeps, connectionId: string): Promise<{ name: string; description: string; inputSchema: unknown }[]> {
  const row = await first<ConnectedRow>(deps.db, "SELECT connection_id, endpoint, protocol, auth_type, namespace FROM connection_profiles WHERE user_id = ? AND connection_id = ? AND state = 'connected' AND kind != 'google_workspace' AND endpoint IS NOT NULL", deps.userId, connectionId);
  if (!row) return [];
  const key = `${deps.userId}\u0000${row.connection_id}`;
  let cached = toolCache.get(key);
  if (!cached || deps.now() - cached.at > TOOL_CACHE_MS) {
    cached = { tools: await clientFor(row.endpoint, isCompat(row.protocol) ? OUTBOUND_COMPAT_PROTOCOL : OUTBOUND_PROTOCOL, deps.authorizeFor(row.connection_id), row.auth_type !== "none").listTools(), at: deps.now() };
    toolCache.set(key, cached);
  }
  return cached.tools.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema }));
}

/**
 * The assistant's search and page-retrieval ports over the owner's connected services. Connections are
 * looked up when a tool is actually called, so a connection added or removed mid-conversation takes
 * effect on the next call; the assistant's guard still re-reads status and enabled groups per dispatch.
 * Pages are rendered in a browser through the Browser Rendering binding when the deployment has one.
 */
export function outboundPorts(deps: OutboundDeps): Pick<AssistantPorts, "searchProviders" | "extraction"> {
  const runtimes = async () => {
    const rows = await all<ConnectedRow>(
      deps.db,
      "SELECT connection_id, endpoint, protocol, auth_type, namespace FROM connection_profiles WHERE user_id = ? AND state = 'connected' AND kind != 'google_workspace' AND endpoint IS NOT NULL ORDER BY created_at, connection_id",
      deps.userId,
    );
    const found: { rt: { db: Db; userId: string; connectionId: string; client: McpHttpClient }; namespace: string; tools: DiscoveredTool[] }[] = [];
    for (const row of rows) {
      const client = clientFor(row.endpoint, isCompat(row.protocol) ? OUTBOUND_COMPAT_PROTOCOL : OUTBOUND_PROTOCOL, deps.authorizeFor(row.connection_id), row.auth_type !== "none");
      const key = `${deps.userId}\u0000${row.connection_id}`;
      let cached = toolCache.get(key);
      if (!cached || deps.now() - cached.at > TOOL_CACHE_MS) {
        try {
          cached = { tools: await client.listTools(), at: deps.now() };
          toolCache.set(key, cached);
        } catch {
          continue; // unreachable right now: the other connections are still tried
        }
      }
      found.push({ rt: { db: deps.db, userId: deps.userId, connectionId: row.connection_id, client }, namespace: row.namespace, tools: cached.tools });
    }
    return found;
  };

  return {
    searchProviders: [
      {
        name: "connections",
        async search(query: string) {
          const results: { url: string; title: string; snippet: string }[] = [];
          let answered = 0;
          let failure: unknown = null;
          for (const connection of await runtimes()) {
            const provider = searchProviderFor(connection.rt, connection.namespace, connection.tools);
            if (!provider) continue;
            try {
              results.push(...(await provider.search(query)).results);
              answered++;
            } catch (error) {
              failure = error;
            }
          }
          if (answered === 0) throw failure ?? new ConnectionError("not_executable", "no search connection is connected and enabled");
          return { results };
        },
      },
    ],
    extraction: new research.ExtractionRouter({
      clock: deps.now,
      tavily: {
        async extract(request) {
          let failure: unknown = null;
          for (const connection of await runtimes()) {
            const backend = extractBackendFor(connection.rt, connection.tools);
            if (!backend) continue;
            try {
              return await backend.extract(request);
            } catch (error) {
              failure = error;
            }
          }
          throw failure ?? new ConnectionError("not_executable", "no page-retrieval connection is connected and enabled");
        },
      },
      // Rendering in a real browser, when the deployment has the binding; otherwise the method says so.
      browser: deps.browser
        ? createBrowserRunBackend(deps.browser as never, { maxCalls: 12 })
        : {
            async render() {
              throw new ConnectionError("not_executable", "browser rendering is not configured in this deployment");
            },
          },
    }),
  };
}
