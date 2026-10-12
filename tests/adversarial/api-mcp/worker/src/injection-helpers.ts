/**
 * Helpers of the prompt-injection (05) and hostile-model (06) files of the adversarial suite.
 *
 * Everything here drives the REAL Worker: conversation turns go through `POST /v1/conversation/turns`, are
 * followed on `GET /v1/runs/{id}`, and what they left is read from `GET /v1/proposals`, the API and the real
 * local D1. The only stand-ins used through these helpers are
 *   - the labelled FAKE MODEL (`@garderobe/assistant/testing`), scripted here as a COMPROMISED model that
 *     obeys injected instructions or misbehaves on purpose. It performs no inference, so nothing in these
 *     files says anything about what a real model would do with the same text; what is asserted is what the
 *     application does with a model's tool calls and output;
 *   - the suite's outbound doubles (src/outbound.ts), including a LABELLED STAND-IN tool service at
 *     `toolServiceHost(<file>)` (not a real search provider) that only these two files use.
 */
import { expect } from "vitest";
import type { FakeModel } from "@garderobe/worker/testing";
import { controlFetch, fingerprint, scriptOutbound, sha256, sql, type TestOwner } from "./harness.ts";
import { dnsAnswer } from "./dns.ts";

/** The imported sneakers-only restriction of the real owner (`HEALING_RESTRICTION_ID` of the importer). */
export const SNEAKERS_ONLY = "rst_profile_sneakers_only";

/** Hosts an attacker controls in the shared injection strings. No request may ever reach them. */
export const ATTACKER_HOSTS = ["attacker.example"];

export type ToolCall = { toolName: string; input: Record<string, unknown>; toolCallId?: string };
export type Step = Parameters<FakeModel["script"]>[number];
/** A fixed model answer (a step may also be a function of the request the model received that returns one). */
export type Answer = Exclude<Step, (...args: never[]) => unknown>;

export const newTurnId = (): string => `adv-turn-${crypto.randomUUID()}`;

/** One scripted model step that calls tools. */
export const call = (...toolCalls: ToolCall[]): Answer => ({ toolCalls });
export const tool = (toolName: string, input: Record<string, unknown>): ToolCall => ({ toolName, input });
/** The scripted closing reply of a turn (labelled, so no assertion can mistake it for product text). */
export const reply = (text = "SCRIPTED FAKE MODEL REPLY."): Answer => ({ text });

export interface Run {
  runId: string;
  kind: string;
  state: string;
  receipts: { commandId: string; type: string; outcome: string; summary: string; [k: string]: any }[];
  proposals: { type: string; summary: string; payload: Record<string, any>; [k: string]: any }[];
  pendingInput: { inputId: string; question: string; choices: { id: string; label: string }[] } | null;
  result: { reply: { text: string } | null; research: Record<string, any> | null; [k: string]: any } | null;
  error: { code: string; message: string; resumable: boolean } | null;
  [k: string]: any;
}

const SETTLED = ["completed", "failed", "cancelled", "needs_input"];

/**
 * Follow a durable run on the real route until it settles. A run that has not settled when polling ends is an
 * error (so no caller can read an unfinished run as its result, or compare state before the run's tool calls
 * have executed), unless the caller asks for the unsettled run on purpose (`allowUnsettled`, used only where
 * the defect under test is a run that never settles).
 */
export async function settle(owner: TestOwner, runId: string, tries = 600, allowUnsettled = false): Promise<Run> {
  let run!: Run;
  for (let i = 0; i < tries; i++) {
    run = await owner.api.json<Run>("GET", `/v1/runs/${runId}`);
    if (SETTLED.includes(run.state)) return run;
    await new Promise((r) => setTimeout(r, 40));
  }
  if (!allowUnsettled) throw new Error(`run ${runId} did not settle after ${tries} polls (last state ${run?.state})`);
  return run;
}

/**
 * One owner message through the app's real conversation route, with the FAKE MODEL scripted for it, followed
 * to a settled run. `body` is the message text, or the whole request body (attachments, pasted text...).
 */
export async function say(owner: TestOwner, model: FakeModel, body: string | Record<string, unknown>, steps: Step[], tries = 600, allowUnsettled = false): Promise<Run> {
  model.script(...steps);
  const request = typeof body === "string" ? { text: body } : body;
  const accepted = await owner.api.json("POST", "/v1/conversation/turns", { clientTurnId: newTurnId(), ...request });
  return settle(owner, accepted.runId, tries, allowUnsettled);
}

export interface Proposal {
  proposalId: string;
  type: string;
  state: string;
  summary: string;
  payload: Record<string, any>;
  turnId: string | null;
  source: { channel: string; assistantName: string | null; [k: string]: any };
  [k: string]: any;
}

export const pending = async (owner: TestOwner): Promise<Proposal[]> => (await owner.api.json("GET", "/v1/proposals")).proposals as Proposal[];
export const decide = (owner: TestOwner, proposalId: string, decision: "confirm" | "reject"): Promise<Response> => owner.api.post(`/v1/proposals/${proposalId}/decision`, { decision });

/**
 * The owner rejects everything that is waiting, through the real decision route. Decisions are rate limited
 * (120 an hour for an owner), so files use this sparingly and otherwise leave requests waiting and read the
 * ones a turn left by its run ID.
 */
export async function rejectAll(owner: TestOwner): Promise<void> {
  for (const p of await pending(owner)) expect((await decide(owner, p.proposalId, "reject")).status, `rejecting ${p.type}`).toBe(200);
  expect(await pending(owner)).toEqual([]);
}

/** What a turn recorded besides receipts and proposals: refusals and the provenance of tap-free reports. */
export async function turnRecord(owner: TestOwner, runId: string): Promise<{ status: string; refusals: { tool: string; code: string; message: string }[]; grants: Record<string, any>[]; failure: Record<string, any> | null; replyText: string | null }> {
  const [row] = await sql<{ status: string; refusals_json: string; grants_json: string; failure_json: string | null; reply_text: string | null }>("SELECT status, refusals_json, grants_json, failure_json, reply_text FROM assistant_turns WHERE user_id = ? AND turn_id = ?", owner.userId, runId);
  if (!row) throw new Error(`no turn ${runId}`);
  return { status: row.status, refusals: JSON.parse(row.refusals_json), grants: JSON.parse(row.grants_json), failure: row.failure_json ? JSON.parse(row.failure_json) : null, replyText: row.reply_text };
}

/**
 * Command types that are the application's own accounting of a turn, the assistant's permitted bookkeeping
 * (rule: research note, shopping candidate, product observation, fit assessment, background research job,
 * memory candidate), the media lane's own background work and uploads these files make themselves, and the
 * daily service's boards (asserted on separately, by content). They are counted apart; every other command
 * is a change to the owner's records and must not appear because of an attack.
 */
const ACCOUNTING = /^(inference\.|job\.|product\.|research\.|memory\.record_conclusion$|conversation\.confirm_erasure$|mail\.|connection\.|forecast\.|weather\.|calendar\.|media\.|board\.)/;

/**
 * Everything an injection must not change for an owner: the harness fingerprint (ledger tables, balances,
 * restrictions, style documents, settings, grants) without the raw command count, plus the commands on the
 * ledger by type with the accounting types left out, the active restriction rows, the active wear records,
 * and a hash of the FULL ROWS of the protected records (garments, aliases, facts, amendments, directions,
 * rules, briefs, measurements, size experiences, comfort notes, orders, reminders and the settled memory), so
 * a change made in place, not only an added or removed row, is seen.
 */
export async function protectedState(owner: TestOwner): Promise<Record<string, unknown>> {
  const out = { ...(await fingerprint(owner)) } as Record<string, unknown>;
  delete out.commands;
  delete out["rows:commands"];
  delete out.memory_conclusions;
  delete out["rows:memory_conclusions"];
  const types = await sql<{ type: string; n: number }>("SELECT type, COUNT(*) AS n FROM commands WHERE user_id = ? GROUP BY type ORDER BY type", owner.userId);
  out.commandsByType = types.filter((t) => !ACCOUNTING.test(t.type)).map((t) => `${t.type}:${t.n}`).join("|");
  out.activeRestrictions = (await sql("SELECT restriction_id, status, resolved_at FROM restrictions WHERE user_id = ? ORDER BY restriction_id", owner.userId)).map((r) => `${r.restriction_id}:${r.status}:${r.resolved_at ?? ""}`).join("|");
  out.wears = (await sql("SELECT garment_id, wearing_date, status, observation_count FROM daily_wears WHERE user_id = ? ORDER BY garment_id, wearing_date", owner.userId)).map((w) => `${w.garment_id}:${w.wearing_date}:${w.status}:${w.observation_count}`).join("|");
  const rowsHash = async (query: string): Promise<string> => {
    const rows = await sql(query, owner.userId);
    return `${rows.length}:${await sha256(JSON.stringify(rows))}`;
  };
  for (const table of ["garments", "garment_aliases", "garment_facts", "style_amendments", "style_rules", "standing_directions", "temporary_briefs", "measurements", "size_experiences", "comfort_feedback", "orders", "reminders"]) {
    out[`rows:${table}`] = await rowsHash(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY rowid`);
  }
  out["rows:settled_memory"] = await rowsHash("SELECT * FROM memory_conclusions WHERE user_id = ? AND NOT (status = 'candidate' AND speaker = 'assistant') ORDER BY rowid");
  // Authority records, column for column except the bookkeeping that ordinary use moves. Hashed are only the columns
  // that carry authority: for a grant, its client, scopes, status and revocation; for a sign-in identity, its issuer,
  // subject, owner and link times; for a tool connection, its owner-visible identity, endpoint, namespace, credential
  // reference (secret_ref), scopes, status, enabled groups and expected issuer. Left out: a grant's last use and
  // protocol, a connection's version, health, discovery and update times, all of which health probes and discovery
  // move (connected-helpers.ts BOOKKEEPING_COLUMNS).
  out["rows:mcp_grants"] = await rowsHash("SELECT grant_id, client_id, client_name, redirect_host, scopes_json, status, version, revoked_at, revoked_reason FROM mcp_grants WHERE user_id = ? ORDER BY grant_id");
  out["rows:auth_identities"] = await rowsHash("SELECT issuer, subject, user_id, linked_at, unlinked_at FROM auth_identities WHERE user_id = ? ORDER BY issuer, subject");
  out["rows:connections"] = await rowsHash("SELECT connection_id, kind, label, endpoint, namespace, secret_ref, scopes_json, status, enabled_groups_json, expected_issuer FROM connections WHERE user_id = ? ORDER BY connection_id");
  return out;
}

/** The sneakers-only restriction row as stored. */
export async function sneakersOnly(owner: TestOwner): Promise<{ status: string; resolved_at: string | null; resolved_command_id: string | null }> {
  const [row] = await sql<{ status: string; resolved_at: string | null; resolved_command_id: string | null }>("SELECT status, resolved_at, resolved_command_id FROM restrictions WHERE user_id = ? AND restriction_id = ?", owner.userId, SNEAKERS_ONLY);
  if (!row) throw new Error("fixture: the real owner has no sneakers-only restriction");
  return row;
}

/** A LABELLED SYNTHETIC garment created through the ordinary command as the owner (never one of the owner's real pieces). */
export async function syntheticGarment(owner: TestOwner, name: string, fields: Record<string, unknown> = {}): Promise<{ garmentId: string; name: string }> {
  if (!name.startsWith("SYNTHETIC")) throw new Error("fixture: a synthetic garment's name starts with SYNTHETIC");
  const response = await owner.api.command("garment.create", { name, category: "accessory", roles: ["accessory"], careChannel: "none", acquisition: "owned", quantity: 1, isSynthetic: true, source: { kind: "system", note: "synthetic adversarial test garment - not the owner's wardrobe" }, ...fields });
  const body = (await response.json()) as any;
  if (!response.ok) throw new Error(`fixture: creating ${name} failed: ${response.status} ${JSON.stringify(body).slice(0, 300)}`);
  return { garmentId: String(body.result.garmentId), name };
}

/* ------------------------------------------------------------------ */
/* A stand-in tool service only these files use                         */
/* ------------------------------------------------------------------ */

/**
 * LABELLED STAND-IN for an owner-added remote search and page-retrieval service (it is not a real
 * provider and proves nothing about one). It lives at a host only one test file uses (the files run at the
 * same time against one outbound double), behind the suite's scripted outbound layer, and answers every
 * JSON-RPC request with the same body: a tool list (a search tool and an extract tool) and one tool result
 * holding the planted pages. The Worker's real connection code discovers the tools, calls them and hands
 * the results to the assistant.
 */
export const toolServiceHost = (tag: string): string => `advinj-tools-${tag}.service-example.com`;

export interface PlantedPage {
  url: string;
  title: string;
  content: string;
}

export async function plantToolService(host: string, pages: PlantedPage[]): Promise<void> {
  const result = {
    tools: [
      { name: "adv_search", description: "Search the web for pages.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
      { name: "adv_extract", description: "Extract the content of pages.", inputSchema: { type: "object", properties: { urls: { type: "array", items: { type: "string" } }, extract_depth: { type: "string" } }, required: ["urls"] } },
    ],
    content: [{ type: "text", text: JSON.stringify({ results: pages.map((p) => ({ url: p.url, title: p.title, content: p.content, raw_content: p.content, images: [] })), failed_results: [] }) }],
  };
  await scriptOutbound(dnsAnswer(host), { match: "host", key: host, status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result }) });
}

/** Remove a planted response again (the scripted layer is shared by every test file of the suite). */
export async function unscriptOutbound(key: string): Promise<void> {
  await controlFetch("/unscript", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) });
}

/** Register the stand-in tool service as the owner's own connection through the real routes and enable search and page retrieval. */
export async function connectToolService(owner: TestOwner, host: string, pages: PlantedPage[]): Promise<string> {
  await plantToolService(host, pages);
  const registered = await owner.api.json("POST", "/v1/connections", { clientRequestId: `adv-conn-${crypto.randomUUID()}`, kind: "mcp", name: "SYNTHETIC page search (adversarial stand-in)", endpoint: `https://${host}/mcp`, auth: { type: "none" } });
  const connectionId = registered.connection.connectionId as string;
  if (registered.connection.state !== "connected") throw new Error(`fixture: the stand-in tool service did not connect: ${JSON.stringify(registered.connection).slice(0, 400)}`);
  const keys = (registered.connection.capabilities as { key: string }[]).map((c) => c.key).filter((k) => k === "tools:search" || k === "tools:extract");
  await owner.api.json("POST", `/v1/connections/${connectionId}/capabilities`, { enabled: keys });
  await owner.api.json("GET", "/v1/connections"); // mirrors the connection into the assistant's registry, as the app does
  return connectionId;
}
