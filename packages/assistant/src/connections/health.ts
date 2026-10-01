/**
 * Connection health checks (specification section 15): run before the evening composition and before the
 * morning delivery. Each connected connection is probed once; the result is recorded through the shared
 * command service. A rejected credential turns into ONE clear state, `needs_reauthorization`, with the
 * owner's other functions untouched; a transient failure is recorded and nothing else changes.
 *
 * The probe itself is supplied by the composition root, because the credential store lives there:
 * `mcpProbe` and `googleProbe` below are the two ready-made ones.
 */
import { isCommandError, systemPrincipalFor, type CommandService, type Db } from "@garderobe/domain";
import type { Connection } from "@garderobe/contracts/ext/assistant";
import { ConnectionError, McpHttpClient, type McpClientOptions } from "./mcp.ts";
import { GoogleApi, type GoogleApiOptions } from "./google.ts";
import { listConnections } from "../queries.ts";

export type HealthPhase = "evening" | "morning" | "manual";
export type ConnectionProbe = (connection: Connection) => Promise<void>;

export interface HealthCheckDeps {
  db: Db;
  service: CommandService;
  /** A probe for this connection, or null when it cannot be probed here (then it is left as it is, and reported). */
  probeFor: (userId: string, connection: Connection) => ConnectionProbe | null;
  nowMs: number;
}

export interface HealthCheckResult {
  checked: { connectionId: string; label: string; ok: boolean; needsOwner: boolean; detail: string | null }[];
  notProbed: string[];
  /** One sentence per connection that needs the owner, for the board or a notification. */
  ownerActions: string[];
}

export async function checkConnectionHealth(deps: HealthCheckDeps, userId: string, phase: HealthPhase): Promise<HealthCheckResult> {
  const principal = await systemPrincipalFor(deps.db, userId, `connection-health:${phase}`, "system");
  const result: HealthCheckResult = { checked: [], notProbed: [], ownerActions: [] };
  for (const connection of await listConnections(deps.db, principal)) {
    if (connection.status === "needs_reauthorization") {
      result.ownerActions.push(`${connection.label} needs you to sign in again.`);
      continue;
    }
    if (connection.status !== "connected") continue;
    const probe = deps.probeFor(userId, connection);
    if (!probe) {
      result.notProbed.push(connection.connectionId);
      continue;
    }
    let ok = true;
    let authFailure = false;
    let detail: string | null = null;
    try {
      await probe(connection);
    } catch (e) {
      ok = false;
      authFailure = e instanceof ConnectionError && (e.code === "auth" || e.code === "scope_not_granted");
      // Only the adapter's own short message is kept: never a raw error, which could carry a key-bearing URL.
      detail = e instanceof ConnectionError ? e.message.slice(0, 280) : "the check failed";
    }
    try {
      await deps.service.execute(principal, {
        type: "connection.record_health",
        payload: { connectionId: connection.connectionId, ok, authFailure, detail, phase },
        idempotencyKey: `connection-health:${connection.connectionId}:${phase}:${new Date(deps.nowMs).toISOString().slice(0, 13)}`,
        authorization: "system_schedule",
        source: { channel: "system" },
      });
    } catch (e) {
      if (!isCommandError(e)) throw e;
    }
    result.checked.push({ connectionId: connection.connectionId, label: connection.label, ok, needsOwner: authFailure, detail });
    if (authFailure) result.ownerActions.push(`${connection.label} needs you to sign in again.`);
  }
  return result;
}

/** Probe an MCP connection by listing its tools (no tool is called). */
export function mcpProbe(options: McpClientOptions): ConnectionProbe {
  return async () => {
    await new McpHttpClient({ ...options, maxCalls: 3, timeoutMs: Math.min(options.timeoutMs ?? 10_000, 10_000) }).listTools();
  };
}

/** Probe a Google grant with the cheapest read its scopes allow. */
export function googleProbe(options: GoogleApiOptions, kind: "gmail" | "drive" | "sheets" | "calendar"): ConnectionProbe {
  return async () => {
    const api = new GoogleApi({ ...options, maxCalls: 1, timeoutMs: Math.min(options.timeoutMs ?? 10_000, 10_000) });
    if (kind === "gmail") await api.json("https://gmail.googleapis.com/", "gmail/v1/users/me/profile");
    else if (kind === "calendar") await api.json("https://www.googleapis.com/", "calendar/v3/users/me/calendarList", { maxResults: 1 });
    else await api.json("https://www.googleapis.com/", "drive/v3/about", { fields: "user(emailAddress)" });
  };
}
