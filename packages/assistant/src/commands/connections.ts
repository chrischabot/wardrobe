import { ASSISTANT_COMMANDS as C } from "@garderobe/contracts/ext/assistant";
import { CommandError, define, first, json, stmt } from "@garderobe/domain";
import { NO_UNDO, plural } from "./common.ts";
import { validateOwnerEndpoint, redactSecretsInUrl } from "../research/web/index.ts";

interface ConnectionRow {
  connection_id: string;
  version: number;
  label: string;
  status: string;
  tools_json: string;
}

const unchanged = (userId: string, row: ConnectionRow) => ({
  label: `connection ${row.connection_id} unchanged since read`,
  sql: "(SELECT version FROM connections WHERE user_id = ? AND connection_id = ?) = ?",
  params: [userId, row.connection_id, row.version],
  class: "internal" as const,
});

/** Registers a managed connection. Only the NAME of a secret binding is stored; never a credential. */
export const connectionRegister = define({
  type: "connection.register",
  schema: C["connection.register"],
  class: "edit",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap", "owner_statement"],
  async plan(ctx, p) {
    let endpoint: string;
    try {
      endpoint = validateOwnerEndpoint(p.endpoint);
    } catch (e) {
      throw new CommandError("invalid_command", `that endpoint cannot be used: ${(e as Error).message}`);
    }
    if (redactSecretsInUrl(endpoint) !== endpoint) throw new CommandError("invalid_command", "the endpoint URL carries a credential; store the credential as a secret and register the plain endpoint");
    if (p.secretRef && !/^[A-Za-z][A-Za-z0-9_.:-]{1,119}$/.test(p.secretRef)) throw new CommandError("invalid_command", "secretRef must be the name of a stored secret, not the secret itself");
    if (await first(ctx.db, "SELECT 1 AS x FROM connections WHERE user_id = ? AND namespace = ? AND status != 'revoked'", ctx.userId, p.namespace)) {
      throw new CommandError("conflict", `the tool namespace '${p.namespace}' is already in use`);
    }
    const connectionId = p.connectionId ?? ctx.newId("con");
    return {
      summary: `${p.label} registered. No tools are enabled until its capabilities are discovered and you choose them`,
      statements: [
        stmt("DELETE FROM connections WHERE user_id = ? AND namespace = ? AND status = 'revoked'", ctx.userId, p.namespace),
        stmt(
          "INSERT INTO connections (user_id, connection_id, version, kind, label, endpoint, namespace, secret_ref, scopes_json, status, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 'registered', ?, ?)",
          ctx.userId, connectionId, p.kind, p.label, endpoint, p.namespace, p.secretRef, JSON.stringify(p.scopes), ctx.now, ctx.now,
        ),
      ],
      affected: [{ kind: "connection", id: connectionId, version: 1 }],
      result: { connectionId, namespace: p.namespace },
      undo: NO_UNDO("revoke the connection to remove it"),
    };
  },
});

/** Records what a live discovery actually returned: real tool schemas' digest, never assumed tool names. */
export const connectionRecordDiscovery = define({
  type: "connection.record_discovery",
  schema: C["connection.record_discovery"],
  class: "system",
  requiredScope: "write",
  allowedAuthorizations: ["standing_policy", "system_schedule", "owner_tap", "owner_statement"],
  async plan(ctx, p) {
    const row = await first<ConnectionRow>(ctx.db, "SELECT connection_id, version, label, status, tools_json FROM connections WHERE user_id = ? AND connection_id = ?", ctx.userId, p.connectionId);
    if (!row) throw new CommandError("not_found", `no connection '${p.connectionId}'`);
    if (row.status === "revoked") throw new CommandError("forbidden", "this connection was revoked");
    const enabled = p.tools.filter((t) => t.enabled).length;
    return {
      summary: `${row.label}: ${plural(p.tools.length, "tool")} discovered, ${enabled} usable, ${p.tools.length - enabled} disabled`,
      statements: [
        stmt(
          "UPDATE connections SET version = version + 1, status = 'connected', status_reason = NULL, protocol_version = ?, schema_digest = ?, tools_json = ?, last_discovery_at = ?, updated_at = ? WHERE user_id = ? AND connection_id = ?",
          p.protocolVersion, p.schemaDigest, JSON.stringify(p.tools), ctx.now, ctx.now, ctx.userId, p.connectionId,
        ),
      ],
      preconditions: [unchanged(ctx.userId, row)],
      affected: [{ kind: "connection", id: p.connectionId, version: row.version + 1 }],
      result: { connectionId: p.connectionId, schemaDigest: p.schemaDigest, enabledTools: enabled },
      undo: NO_UNDO("run discovery again to refresh"),
    };
  },
});

export const connectionSetToolGroups = define({
  type: "connection.set_tool_groups",
  schema: C["connection.set_tool_groups"],
  class: "edit",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap", "owner_statement"],
  async plan(ctx, p) {
    const row = await first<ConnectionRow>(ctx.db, "SELECT connection_id, version, label, status, tools_json FROM connections WHERE user_id = ? AND connection_id = ?", ctx.userId, p.connectionId);
    if (!row) throw new CommandError("not_found", `no connection '${p.connectionId}'`);
    if (row.status === "revoked") throw new CommandError("forbidden", "this connection was revoked");
    const known = new Set(json<{ group: string | null }[]>(row.tools_json, []).map((t) => t.group).filter((g): g is string => !!g));
    const unknown = p.enabledGroups.filter((g) => !known.has(g));
    if (unknown.length > 0) throw new CommandError("not_found", `this connection has not offered these tool groups: ${unknown.join(", ")}`);
    return {
      summary: `${row.label}: ${p.enabledGroups.length > 0 ? `enabled ${p.enabledGroups.join(", ")}` : "all tool groups disabled"}`,
      statements: [stmt("UPDATE connections SET version = version + 1, enabled_groups_json = ?, updated_at = ? WHERE user_id = ? AND connection_id = ?", JSON.stringify(p.enabledGroups), ctx.now, ctx.userId, p.connectionId)],
      preconditions: [unchanged(ctx.userId, row)],
      affected: [{ kind: "connection", id: p.connectionId, version: row.version + 1 }],
      result: { connectionId: p.connectionId, enabledGroups: p.enabledGroups },
      undo: NO_UNDO("choose the groups again to change them"),
    };
  },
});

/** Revocation takes effect at the next outbound call: the executor re-reads the status, so queued retries are refused. */
export const connectionSetStatus = define({
  type: "connection.set_status",
  schema: C["connection.set_status"],
  class: "edit",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap", "owner_statement", "standing_policy", "system_schedule"],
  async plan(ctx, p) {
    const row = await first<ConnectionRow>(ctx.db, "SELECT connection_id, version, label, status, tools_json FROM connections WHERE user_id = ? AND connection_id = ?", ctx.userId, p.connectionId);
    if (!row) throw new CommandError("not_found", `no connection '${p.connectionId}'`);
    if (row.status === p.status) return { outcome: "noop", summary: `${row.label} is already ${p.status.replace(/_/g, " ")}`, result: { connectionId: p.connectionId }, undo: NO_UNDO("nothing changed") };
    if (row.status === "revoked") throw new CommandError("forbidden", "a revoked connection is registered again rather than revived");
    const ownerAuthority = ctx.envelope.authorization === "owner_tap" || ctx.envelope.authorization === "owner_statement";
    if (p.status === "connected" && !ownerAuthority) throw new CommandError("forbidden", "only you can reconnect a service");
    return {
      summary: p.status === "revoked" ? `${row.label} disconnected. Queued work for it will not run; nothing else is affected` : p.status === "needs_reauthorization" ? `${row.label} needs you to sign in again; other functions keep working` : `${row.label} connected`,
      statements: [
        stmt(
          "UPDATE connections SET version = version + 1, status = ?, status_reason = ?, enabled_groups_json = CASE WHEN ? = 'revoked' THEN '[]' ELSE enabled_groups_json END, secret_ref = CASE WHEN ? = 'revoked' THEN NULL ELSE secret_ref END, updated_at = ? WHERE user_id = ? AND connection_id = ?",
          p.status, p.reason, p.status, p.status, ctx.now, ctx.userId, p.connectionId,
        ),
      ],
      preconditions: [unchanged(ctx.userId, row)],
      affected: [{ kind: "connection", id: p.connectionId, version: row.version + 1 }],
      result: { connectionId: p.connectionId, status: p.status },
      undo: NO_UNDO("reconnect the service to restore it"),
    };
  },
});

/* ------------------------------------------------------------------ */
/* Background jobs                                                      */
/* ------------------------------------------------------------------ */

export const jobCreate = define({
  type: "job.create",
  schema: C["job.create"],
  class: "edit",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap", "owner_statement", "standing_policy", "system_schedule"],
  async plan(ctx, p) {
    const jobId = p.jobId ?? ctx.newId("job");
    if (await first(ctx.db, "SELECT 1 AS x FROM assistant_jobs WHERE user_id = ? AND job_id = ?", ctx.userId, jobId)) {
      return { outcome: "noop", summary: `${p.title} is already under way`, result: { jobId, deliveryId: `job-result:${jobId}` }, undo: NO_UNDO("nothing changed") };
    }
    return {
      summary: `Started: ${p.title}. It runs in the background and reports here when it settles`,
      statements: [
        stmt(
          "INSERT INTO assistant_jobs (user_id, job_id, version, kind, state, title, params_json, priority, delivery_id, created_at, updated_at) VALUES (?, ?, 1, ?, 'queued', ?, ?, ?, ?, ?, ?)",
          ctx.userId, jobId, p.kind, p.title, JSON.stringify(p.params), p.priority, `job-result:${jobId}`, ctx.now, ctx.now,
        ),
      ],
      affected: [{ kind: "job", id: jobId, version: 1 }],
      effects: [{ kind: "assistant.run_job", targetKey: `job:${jobId}`, operationKey: `job:${jobId}:start`, payload: { jobId, kind: p.kind } }],
      result: { jobId, deliveryId: `job-result:${jobId}` },
      undo: NO_UNDO("cancel the job to stop it"),
    };
  },
});

const TERMINAL = ["completed", "failed", "cancelled"];

export const jobUpdate = define({
  type: "job.update",
  schema: C["job.update"],
  class: "system",
  requiredScope: "write",
  allowedAuthorizations: ["standing_policy", "system_schedule", "owner_tap", "owner_statement"],
  async plan(ctx, p) {
    const row = await first<{ version: number; state: string; title: string; progress_json: string; committed_command_ids_json: string; coverage_json: string | null; result_ref: string | null; unresolved_reason: string | null }>(
      ctx.db,
      "SELECT version, state, title, progress_json, committed_command_ids_json, coverage_json, result_ref, unresolved_reason FROM assistant_jobs WHERE user_id = ? AND job_id = ?",
      ctx.userId,
      p.jobId,
    );
    if (!row) throw new CommandError("not_found", `no job '${p.jobId}'`);
    if (TERMINAL.includes(row.state)) {
      // A late step of a cancelled or finished job changes nothing.
      return { outcome: "noop", summary: `${row.title} had already ${row.state === "completed" ? "finished" : row.state === "cancelled" ? "been stopped" : "failed"}`, result: { jobId: p.jobId, state: row.state }, undo: NO_UNDO("nothing changed") };
    }
    const state = p.state ?? row.state;
    const committed = [...new Set([...json<string[]>(row.committed_command_ids_json, []), ...(p.committedCommandIds ?? [])])];
    const progress = { ...json<Record<string, unknown>>(row.progress_json, {}), ...(p.progress ?? {}) };
    const coverage = p.coverage ?? json<{ completion: string } | null>(row.coverage_json, null);
    let summary = `${row.title}: ${state}`;
    if (state === "cancelled") summary = `${row.title} stopped. ${committed.length > 0 ? `${plural(committed.length, "change")} already made stay in place; undo is separate` : "Nothing had been changed"}`;
    else if (state === "completed") summary = `${row.title} finished${coverage ? ` (${coverage.completion === "complete" ? "searched completely" : "partial: not everything was searched"})` : ""}`;
    else if (state === "failed") summary = `${row.title} could not finish${p.unresolvedReason ? `: ${p.unresolvedReason}` : ""}`;
    return {
      summary,
      statements: [
        stmt(
          "UPDATE assistant_jobs SET version = version + 1, state = ?, progress_json = ?, coverage_json = ?, result_ref = ?, unresolved_reason = ?, committed_command_ids_json = ?, updated_at = ? WHERE user_id = ? AND job_id = ?",
          state, JSON.stringify(progress), coverage ? JSON.stringify(coverage) : null, p.resultRef === undefined ? row.result_ref : p.resultRef, p.unresolvedReason === undefined ? row.unresolved_reason : p.unresolvedReason, JSON.stringify(committed), ctx.now, ctx.userId, p.jobId,
        ),
      ],
      preconditions: [{ label: "job unchanged since read", sql: "(SELECT version FROM assistant_jobs WHERE user_id = ? AND job_id = ?) = ?", params: [ctx.userId, p.jobId, row.version], class: "internal" }],
      affected: [{ kind: "job", id: p.jobId, version: row.version + 1 }],
      // Completion queues exactly one result delivery to the conversation (stable delivery ID).
      outbox: TERMINAL.includes(state) ? [{ topic: "conversation.deliver", entityKind: "job", entityId: p.jobId, revision: row.version + 1, payload: { deliveryId: `job-result:${p.jobId}` } }] : [],
      result: { jobId: p.jobId, state, committedCommandIds: committed },
      undo: NO_UNDO("job progress is not undone"),
    };
  },
});

export const connectionHandlers = [connectionRegister, connectionRecordDiscovery, connectionSetToolGroups, connectionSetStatus];
export const jobHandlers = [jobCreate, jobUpdate];
