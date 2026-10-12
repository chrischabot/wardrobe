/**
 * Helpers of test/14-connected-assistant.test.ts (a connected assistant that over-reaches).
 *
 * Everything here talks to the real Worker: the MCP endpoint through the SDK client or a raw HTTP request,
 * the owner's app routes through the signed-in test client, and the real local D1 database for reading
 * state back. Nothing here mocks the ledger, the API or the MCP server.
 */
import { SELF } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client";
import { MCP_ORIGIN, MCP_URL, TestOAuthClient, decideConsent, fingerprint, settle, sql, tableDigest, toolResult, type McpConnection, type SettleOptions, type TestOwner } from "./harness.ts";

export interface ToolOutcome<T = any> {
  ok: boolean;
  data: T;
  error: { code: string; message: string; details: Record<string, any> } | null;
}

/**
 * One tool call. Only a refusal by the MCP server itself counts as a refusal here: a JSON-RPC error answer (it carries a
 * numeric JSON-RPC `code`: strict input schema, a tool that is not offered) or the transport's authorization failure (a
 * dead or revoked token). A JSON-RPC internal error (-32603) is reported as `internal`, not as a refusal of the attack.
 * Anything else (a dropped connection, a client that was closed, a bug in the test) is rethrown, so a probe can never
 * pass without having reached the tool.
 */
export async function mcpCall(mcp: McpConnection, name: string, args: unknown): Promise<ToolOutcome> {
  try {
    return toolResult(await mcp.client.callTool({ name, arguments: args as Record<string, unknown> })) as ToolOutcome;
  } catch (error) {
    const refusal = protocolRefusal(error);
    if (refusal) return { ok: false, data: undefined, error: refusal };
    throw error;
  }
}

/** The refusal a thrown MCP client error stands for, or null when the error is not a refusal by the server. Only the server's JSON-RPC error answers count (invalid params, unknown method, internal error); the client's own result validation (structured content against an output schema) is not a refusal and is rethrown by the callers. */
export function protocolRefusal(error: unknown): ToolOutcome["error"] {
  const message = String((error as Error)?.message ?? error).slice(0, 300);
  const rpcCode = (error as { code?: unknown })?.code;
  if (error instanceof UnauthorizedError) return { code: "protocol_error", message, details: { unauthorized: true } };
  if (typeof rpcCode !== "number" || ![-32602, -32601, -32603].includes(rpcCode)) return null;
  if (/structured content|output schema/i.test(message)) return null;
  return { code: rpcCode === -32603 ? "internal" : "protocol_error", message, details: { rpcCode } };
}

export const newKey = (label = "m14"): string => `${label}-${crypto.randomUUID()}`;

/** One typed command through the real MCP tool `garderobe_command`. */
export const command = (mcp: McpConnection, type: unknown, payload: unknown, extra: Record<string, unknown> = {}): Promise<ToolOutcome> =>
  mcpCall(mcp, "garderobe_command", { type, payload, idempotencyKey: newKey(), ...extra });

/** Codes with which the application refuses a request without having changed anything. A JSON-RPC internal error
 * (`internal`) is a crash, not a refusal, and is deliberately absent. The refusal of an unbounded change is the code
 * `invalid_command` with `details.reason: "change_exceeds_bound"` (a reason today, listed here as well in case it is
 * ever answered as its own code); the tests that expect it assert that reason themselves. */
export const REFUSALS = ["confirmation_required", "forbidden", "invalid_command", "not_found", "unknown_command", "conflict", "precondition_failed", "idempotency_key_reuse", "rate_limited", "protocol_error", "change_exceeds_bound"];

/** A raw JSON-RPC request to the MCP endpoint with a bearer token (no SDK in between). */
export async function rawMcp(token: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; text: string; messages: any[] }> {
  const response = await SELF.fetch(`${MCP_ORIGIN}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}`, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  const messages: any[] = [];
  const push = (value: unknown) => (Array.isArray(value) ? messages.push(...value) : messages.push(value));
  try {
    push(JSON.parse(text));
  } catch {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        push(JSON.parse(line.slice(5)));
      } catch {
        /* not a JSON event */
      }
    }
  }
  return { status: response.status, text, messages };
}

/** Whether any JSON-RPC message of a raw answer is a successful tool result (not an error and not `isError`). */
export const anyToolSuccess = (messages: any[]): boolean => messages.some((m) => m && typeof m === "object" && m.result && !m.result.isError && (m.result.structuredContent?.receipt || m.result.content));

/* ------------------------------------------------------------------ */
/* The owner's side                                                     */
/* ------------------------------------------------------------------ */

export interface ListedProposal {
  proposalId: string;
  turnId: string;
  type: string;
  summary: string;
  payload: Record<string, any>;
  state: "pending" | "confirmed" | "rejected" | "expired";
  source: { channel: string; assistantName: string | null };
  commandId: string | null;
  [k: string]: any;
}

export const pendingProposals = async (owner: TestOwner): Promise<ListedProposal[]> => (await owner.api.json("GET", "/v1/proposals")).proposals;
export const allProposals = async (owner: TestOwner): Promise<ListedProposal[]> => (await owner.api.json("GET", "/v1/proposals?state=all")).proposals;

export async function decide(owner: TestOwner, proposalId: string, decision: "confirm" | "reject", extraBody: Record<string, unknown> = {}): Promise<{ status: number; body: any }> {
  const response = await owner.api.post(`/v1/proposals/${proposalId}/decision`, { decision, ...extraBody });
  const text = await response.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { status: response.status, body };
}

/**
 * FIXTURE: an hour passes for the owner's decision rate limit. The decision route allows 120 decisions per
 * owner and clock hour (a fixed-window counter in `auth_rate_limits`); a test file that has the owner
 * decide several hundred requests within a minute stands in for many hours of the owner's time by
 * clearing that counter. Nothing else is touched.
 */
export async function newDecisionHour(owner: TestOwner): Promise<void> {
  await sql("DELETE FROM auth_rate_limits WHERE bucket = ?", `proposal-decision:${owner.userId}`);
}

/** The owner rejects one request in the app (cleanup between tests; starts a new decision hour when the limit is reached). */
export async function ownerRejects(owner: TestOwner, proposalId: string): Promise<number> {
  let result = await decide(owner, proposalId, "reject");
  if (result.status === 429) {
    await newDecisionHour(owner);
    result = await decide(owner, proposalId, "reject");
  }
  return result.status;
}

/** The owner rejects everything that is waiting (keeps one test's requests out of the next test's list). */
export async function rejectAllPending(owner: TestOwner): Promise<number> {
  const waiting = await pendingProposals(owner);
  for (const p of waiting) {
    const status = await ownerRejects(owner, p.proposalId);
    if (status !== 200) throw new Error(`fixture: rejecting ${p.type} failed: ${status}`);
  }
  return waiting.length;
}

export interface CommandRow {
  command_id: string;
  type: string;
  actor: string;
  channel: string;
  authorization_basis: string;
  outcome: string;
}

/** The owner's ledger of commands, oldest first (read from the real database). */
export const commandRows = (owner: TestOwner): Promise<CommandRow[]> =>
  sql<CommandRow>("SELECT command_id, type, actor, channel, authorization_basis, outcome FROM commands WHERE user_id = ? ORDER BY recorded_at, command_id", owner.userId);

export const commandCount = async (owner: TestOwner): Promise<number> => (await sql<{ n: number }>("SELECT COUNT(*) AS n FROM commands WHERE user_id = ?", owner.userId))[0]!.n;

export const submittedCount = async (owner: TestOwner): Promise<number> => (await sql<{ n: number }>("SELECT COUNT(*) AS n FROM submitted_proposals WHERE user_id = ?", owner.userId))[0]!.n;

/**
 * The fingerprint once background work started by an accepted command has finished: the readings must stay
 * equal for a sustained quiet interval (by default four consecutive equal readings spanning at least
 * 500 ms). Throws, naming the fingerprint keys that were still moving, when that does not happen within
 * the timeout (default 30 s) instead of returning a reading taken mid-change.
 */
export async function settledFingerprint(owner: TestOwner, options: SettleOptions = {}): Promise<Record<string, unknown>> {
  return settle(() => fingerprint(owner), { label: "the owner's fingerprint", ...options });
}

/**
 * The part of the fingerprint that only a sensitive change can move: garments and their names, the profile
 * and its rules, restrictions, settings, measurements, memory, grants and sign-in identities. Routine
 * reports (wears, washes, laundry, packing) and the ledger's own row count are left out.
 */
export function sensitivePart(print: Record<string, unknown>): Record<string, unknown> {
  const keys = ["garments", "garment_aliases", "garment_facts", "restrictions", "restriction_rows", "style_documents", "style_document_rows", "style_amendments", "style_rules", "standing_directions", "temporary_briefs", "measurements", "size_experiences", "owner_settings_versions", "memory_conclusions", "mcp_grants", "auth_identities", "connections", "orders"];
  return Object.fromEntries(keys.map((k) => [k, print[k]]));
}

/** Tables whose every row only a sensitive change may alter (garments are compared column by column below). */
const SENSITIVE_TABLES = ["garment_aliases", "garment_facts", "restrictions", "style_documents", "style_amendments", "style_rules", "standing_directions", "temporary_briefs", "measurements", "size_experiences", "owner_settings_versions", "memory_conclusions", "mcp_grants", "auth_identities", "connections", "orders"] as const;

/**
 * Bookkeeping columns that ordinary use rewrites without any change of substance, left out of the row
 * comparison: when an assistant grant was last used and which protocol era it spoke (both written on every
 * MCP request, apps/worker/src/mcp/grants.ts and handler.ts), and a tool service's health probe and
 * discovery time with the version and timestamp those bump (packages/assistant/src/commands/connections.ts).
 * A connection's status, groups, secret reference and tools, and a grant's scopes and status, ARE compared.
 */
const BOOKKEEPING_COLUMNS: Partial<Record<(typeof SENSITIVE_TABLES)[number], readonly string[]>> = {
  mcp_grants: ["last_used_at", "protocol"],
  connections: ["health_json", "last_discovery_at", "updated_at", "version"],
};

/**
 * Everything only a sensitive change can move, row for row: `sensitivePart` of the fingerprint, the garments'
 * identity and record columns, and a full-row digest of every other sensitive table (`<table>_rows`, every
 * column except the bookkeeping ones above). Equal states mean the same rows with the same values, not only
 * the same counts.
 */
export const sensitiveState = async (owner: TestOwner): Promise<Record<string, unknown>> => {
  // Every column of every garment except the revision counters an undone change moves (`version`, `updated_at`): a
  // change of substance to any stored garment field (maker, size, model, notes, attributes...) is seen.
  const garments = await tableDigest("garments", owner, { omit: ["version", "updated_at"] });
  const rows: Record<string, string> = {};
  for (const table of SENSITIVE_TABLES) rows[`${table}_rows`] = await tableDigest(table, owner, { omit: BOOKKEEPING_COLUMNS[table] ?? [] });
  return { ...sensitivePart(await fingerprint(owner)), garment_rows: garments, ...rows };
};

/** A labelled synthetic garment made by the owner in the app (never the owner's real stock). */
export async function syntheticGarment(owner: TestOwner, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  if (!name.startsWith("SYNTHETIC")) throw new Error("fixture: a synthetic garment's name starts with SYNTHETIC");
  const response = await owner.api.command("garment.create", {
    name,
    category: "shirt",
    roles: ["top"],
    careChannel: "service",
    acquisition: "owned",
    quantity: 2,
    isSynthetic: true,
    source: { kind: "owner_statement", note: "synthetic test fixture - not the owner's wardrobe" },
    ...extra,
  });
  const receipt = (await response.json()) as any;
  const id = receipt?.affected?.find((a: any) => a.kind === "garment")?.id;
  if (!response.ok || !id) throw new Error(`fixture: creating ${name} failed: ${response.status} ${JSON.stringify(receipt).slice(0, 300)}`);
  return id as string;
}

export const garmentRow = async (owner: TestOwner, garmentId: string): Promise<Record<string, any> | null> =>
  (await sql("SELECT garment_id, name, colour, fabric, maker, size, acquisition, version FROM garments WHERE user_id = ? AND garment_id = ?", owner.userId, garmentId))[0] ?? null;

/* ------------------------------------------------------------------ */
/* A second connection of the SAME registered client                    */
/* ------------------------------------------------------------------ */

const selfFetch = ((input: RequestInfo | URL, init?: RequestInit) => SELF.fetch(input as never, init as never)) as typeof fetch;

/**
 * Connect again as the client that `base` registered (same `client_id`, same redirect address): the
 * owner approves a second consent for the same installation, as happens when an assistant is added again.
 * Mirrors `connectMcp` of the Worker's testing module, with the client registration reused instead of a
 * fresh dynamic registration.
 */
export async function connectSameClient(owner: TestOwner, base: McpConnection, options: { write?: boolean; clientName?: string; redirectUri?: string } = {}): Promise<McpConnection> {
  const oauth = new TestOAuthClient({
    clientName: options.clientName ?? base.oauth.clientMetadata.client_name ?? "Test assistant",
    // The redirect address `base` registered, so the second authorization uses the same registration.
    redirectUri: options.redirectUri ?? String(base.oauth.redirectUrl),
    scope: options.write ? "wardrobe.read wardrobe.write" : "wardrobe.read",
  });
  oauth.saveClientInformation(base.oauth.clientInformation());
  const transportOptions = { authProvider: oauth, fetch: selfFetch };
  const newClient = (): Client => {
    const client = new Client({ name: "garderobe-test-client", version: "1.0.0" }, { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: { pin: "2026-07-28" } } } as never);
    client.setRequestHandler("elicitation/create", async () => ({ action: "decline" }) as never);
    return client;
  };
  const open = async (): Promise<Client> => {
    const client = newClient();
    await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), transportOptions));
    return client;
  };
  const first = new StreamableHTTPClientTransport(new URL(MCP_URL), transportOptions);
  const probe = newClient();
  try {
    await probe.connect(first);
    await probe.listTools();
    throw new Error("the MCP endpoint answered without authorization");
  } catch (error) {
    if (!(error instanceof UnauthorizedError) && !oauth.authorizationUrl) throw error;
  }
  if (!oauth.authorizationUrl) throw new Error("the client was not sent to the authorization endpoint");
  const consent = await decideConsent(owner, oauth.authorizationUrl, { allow: true, write: options.write ?? false });
  if (consent.status !== 302 || !consent.location) throw new Error(`consent did not redirect: ${consent.status}`);
  await first.finishAuth(new URL(consent.location).searchParams);
  await probe.close().catch(() => undefined);
  let client = await open();
  return {
    get client() {
      return client;
    },
    oauth,
    reconnect: async () => {
      await client.close().catch(() => undefined);
      client = await open();
      return client;
    },
    close: async () => {
      await client.close().catch(() => undefined);
    },
  };
}

/** The application's grant rows of an owner (what the owner's "Connected assistants" list is read from). */
export const grantRows = (owner: TestOwner): Promise<{ grant_id: string; client_id: string; client_name: string; status: string; scopes_json: string }[]> =>
  sql("SELECT grant_id, client_id, client_name, status, scopes_json FROM mcp_grants WHERE user_id = ? ORDER BY granted_at, grant_id", owner.userId);

/* ------------------------------------------------------------------ */
/* Payloads for the sweep over every command type                       */
/* ------------------------------------------------------------------ */

export interface SweepContext {
  today: string;
  yesterday: string;
  tomorrow: string;
  /** An owned, clean shirt of the owner. */
  shirt: string;
  /** A sneaker no restriction excludes. */
  sneaker: string;
  /** Footwear the active restriction excludes. */
  restrictedShoe: string;
  restrictionId: string;
  /** The command that recorded the restriction (the import's). */
  restrictionCommandId: string;
  /** A correction the owner made in the app. */
  ownerCorrectionCommandId: string;
  tripId: string;
  boardId: string;
  optionId: string;
  productId: string;
}

const instant = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, "Z");

/*
 * Schema-driven payloads (`generateFromSchema`, `fromSchema`).
 *
 * LIMITS, on purpose: the generator builds the smallest payload a command's published JSON schema accepts
 * (every required field, nothing else) and understands only these constraint keywords: `$ref` (local), `type`,
 * `const`, `enum`, `anyOf`, `oneOf`, `allOf` (of object schemas only), `properties`, `required`,
 * `additionalProperties`, `propertyNames`, `minProperties`, `maxProperties`, `dependentRequired`, `items` (one
 * schema), `minItems`, `maxItems`, `uniqueItems`, `minLength`, `maxLength`, `pattern`, `format` (`date-time`,
 * `date`, `time`, `email`, `uri`, `url`, `uuid`), `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`
 * and `multipleOf`. A string with a `pattern` gets the first fixture value that matches it. Every generated
 * payload is then checked against the whole schema with the same keywords. Any other keyword (`not`, `if`,
 * `prefixItems`, `contains`, `patternProperties`, an unknown `format`, ...), a non-object `allOf`, a pattern no
 * fixture value matches, or a payload that fails the check raises `UnsupportedSchemaError`: such a type needs
 * an explicit payload in `realisticPayloads`.
 */

/** Raised by `generateFromSchema` for a constraint it does not understand or cannot satisfy. */
export class UnsupportedSchemaError extends Error {
  readonly path: string;
  readonly reason: string;
  constructor(path: string, reason: string) {
    super(`fromSchema at ${path || "(payload)"}: ${reason}`);
    this.name = "UnsupportedSchemaError";
    this.path = path;
    this.reason = reason;
  }
}

const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set(["$schema", "$id", "$comment", "$defs", "definitions", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly"]);
const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  "$ref",
  "type",
  "const",
  "enum",
  "anyOf",
  "oneOf",
  "allOf",
  "properties",
  "required",
  "additionalProperties",
  "propertyNames",
  "minProperties",
  "maxProperties",
  "dependentRequired",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);
/** Whether `value` parses as an absolute URL (without relying on `URL.canParse`, which not every lib declares). */
const parsesAsUrl = (value: string): boolean => {
  try {
    return new URL(value).href.length > 0;
  } catch {
    return false;
  }
};

const FORMAT_CHECKS: Readonly<Record<string, (value: string) => boolean>> = {
  "date-time": (v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v)),
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)),
  time: (v) => /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.test(v),
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  uri: parsesAsUrl,
  url: parsesAsUrl,
  uuid: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
};

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const numberAt = (schema: Record<string, unknown>, key: string): number | undefined => (typeof schema[key] === "number" ? (schema[key] as number) : undefined);

/** JSON with object keys sorted, for comparing values (`const`, `enum`, `uniqueItems`). */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

function compilePattern(pattern: string, path: string): RegExp {
  try {
    return new RegExp(pattern, "u");
  } catch {
    try {
      return new RegExp(pattern);
    } catch {
      throw new UnsupportedSchemaError(path, "its pattern does not compile");
    }
  }
}

function resolveRef(ref: string, root: unknown, path: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) throw new UnsupportedSchemaError(path, `the reference ${ref} is not local`);
  let node: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(node) && /^\d+$/.test(part) && Number(part) < node.length) node = node[Number(part)];
    else if (isRecord(node) && part in node) node = node[part];
    else throw new UnsupportedSchemaError(path, `the reference ${ref} does not resolve`);
  }
  return node;
}

function checkKeywords(schema: Record<string, unknown>, path: string): void {
  for (const key of Object.keys(schema)) if (!ANNOTATION_KEYWORDS.has(key) && !SUPPORTED_KEYWORDS.has(key)) throw new UnsupportedSchemaError(path, `the keyword ${key} is not supported`);
  if (typeof schema.format === "string" && !(schema.format in FORMAT_CHECKS)) throw new UnsupportedSchemaError(path, `the format ${schema.format} is not supported`);
  if (Array.isArray(schema.items)) throw new UnsupportedSchemaError(path, "tuple items are not supported");
}

const hasType = (value: unknown, type: unknown): boolean => {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    default:
      return false;
  }
};

/** Every way `value` breaks `schema` (with the supported keywords; any other keyword is itself reported). */
export function schemaViolations(value: unknown, schema: unknown, root: unknown = schema, path = "", depth = 0): string[] {
  const where = path || "(payload)";
  if (depth > 32) return [`${where}: nested deeper than 32 levels`];
  if (schema === true || schema === undefined) return [];
  if (schema === false || !isRecord(schema)) return [`${where}: nothing is allowed here`];
  const out: string[] = [];
  const at = (reason: string) => out.push(`${where}: ${reason}`);
  for (const key of Object.keys(schema)) if (!ANNOTATION_KEYWORDS.has(key) && !SUPPORTED_KEYWORDS.has(key)) at(`the keyword ${key} is not supported`);
  if (typeof schema.$ref === "string") {
    try {
      out.push(...schemaViolations(value, resolveRef(schema.$ref, root, path), root, path, depth + 1));
    } catch (error) {
      at((error as Error).message);
    }
  }
  if ("const" in schema && stableJson(value) !== stableJson(schema.const)) at("differs from the const value");
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => stableJson(option) === stableJson(value))) at("is none of the enum values");
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s) => schemaViolations(value, s, root, path, depth + 1).length === 0)) at("matches no anyOf alternative");
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter((s) => schemaViolations(value, s, root, path, depth + 1).length === 0).length !== 1) at("does not match exactly one oneOf alternative");
  if (Array.isArray(schema.allOf)) for (const part of schema.allOf) out.push(...schemaViolations(value, part, root, path, depth + 1));
  if (schema.type !== undefined) {
    const types: unknown[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => hasType(value, t))) at(`is not of type ${types.map(String).join("/")}`);
  }
  if (typeof value === "string") {
    const length = [...value].length;
    const minLength = numberAt(schema, "minLength");
    const maxLength = numberAt(schema, "maxLength");
    if (minLength !== undefined && length < minLength) at("is shorter than minLength");
    if (maxLength !== undefined && length > maxLength) at("is longer than maxLength");
    if (typeof schema.pattern === "string") {
      try {
        if (!compilePattern(schema.pattern, path).test(value)) at("does not match the pattern");
      } catch (error) {
        at((error as Error).message);
      }
    }
    if (typeof schema.format === "string") {
      const check = FORMAT_CHECKS[schema.format];
      if (!check) at(`the format ${schema.format} is not supported`);
      else if (!check(value)) at(`is not a valid ${schema.format}`);
    }
  }
  if (typeof value === "number") {
    const minimum = numberAt(schema, "minimum");
    const maximum = numberAt(schema, "maximum");
    const exclusiveMinimum = numberAt(schema, "exclusiveMinimum");
    const exclusiveMaximum = numberAt(schema, "exclusiveMaximum");
    const multipleOf = numberAt(schema, "multipleOf");
    if (minimum !== undefined && value < minimum) at("is below minimum");
    if (maximum !== undefined && value > maximum) at("is above maximum");
    if (exclusiveMinimum !== undefined && value <= exclusiveMinimum) at("is not above exclusiveMinimum");
    if (exclusiveMaximum !== undefined && value >= exclusiveMaximum) at("is not below exclusiveMaximum");
    if (multipleOf !== undefined && (multipleOf <= 0 || Math.abs(value / multipleOf - Math.round(value / multipleOf)) > 1e-9)) at("is not a multiple of multipleOf");
  }
  if (Array.isArray(value)) {
    const minItems = numberAt(schema, "minItems");
    const maxItems = numberAt(schema, "maxItems");
    if (minItems !== undefined && value.length < minItems) at("has fewer than minItems items");
    if (maxItems !== undefined && value.length > maxItems) at("has more than maxItems items");
    if (schema.uniqueItems === true && new Set(value.map(stableJson)).size !== value.length) at("has duplicate items");
    if (Array.isArray(schema.items)) at("tuple items are not supported");
    else if (schema.items !== undefined) value.forEach((item, i) => out.push(...schemaViolations(item, schema.items, root, `${path}/${i}`, depth + 1)));
  }
  if (isRecord(value)) {
    const properties: Record<string, unknown> = isRecord(schema.properties) ? schema.properties : {};
    const keys = Object.keys(value);
    if (Array.isArray(schema.required)) for (const key of schema.required) if (!(String(key) in value)) at(`lacks the required ${String(key)}`);
    for (const key of keys) {
      if (key in properties) out.push(...schemaViolations(value[key], properties[key], root, `${path}/${key}`, depth + 1));
      else if (schema.additionalProperties === false) at(`has the extra key ${key}`);
      else if (schema.additionalProperties !== undefined) out.push(...schemaViolations(value[key], schema.additionalProperties, root, `${path}/${key}`, depth + 1));
      if (schema.propertyNames !== undefined) out.push(...schemaViolations(key, schema.propertyNames, root, `${path}/${key} (name)`, depth + 1));
    }
    const minProperties = numberAt(schema, "minProperties");
    const maxProperties = numberAt(schema, "maxProperties");
    if (minProperties !== undefined && keys.length < minProperties) at("has fewer than minProperties keys");
    if (maxProperties !== undefined && keys.length > maxProperties) at("has more than maxProperties keys");
    if (isRecord(schema.dependentRequired))
      for (const [key, needed] of Object.entries(schema.dependentRequired)) if (key in value && Array.isArray(needed)) for (const other of needed) if (!(String(other) in value)) at(`has ${key} without ${String(other)}`);
  }
  return out;
}

/** The value a required string field gets when nothing constrains it: chosen from its name, so the payload reads like a real request. */
function primaryString(name: string, schema: Record<string, unknown>, ctx: SweepContext): string {
  const n = name.toLowerCase();
  const pattern = typeof schema.pattern === "string" ? schema.pattern : "";
  if (schema.format === "email") return "synthetic.fixture@example.test";
  if (schema.format === "uri" || schema.format === "url") return "https://service.example.test/synthetic";
  if (schema.format === "uuid") return crypto.randomUUID();
  if (schema.format === "time") return "08:00:00";
  if (n.endsWith("garmentid")) return ctx.shirt;
  if (n === "tripid") return ctx.tripId;
  if (n === "boardid") return ctx.boardId;
  if (n === "optionid") return ctx.optionId;
  if (n === "productid") return ctx.productId;
  if (n === "restrictionid") return ctx.restrictionId;
  if (n === "commandid") return ctx.ownerCorrectionCommandId;
  if (schema.format === "date-time" || /at$/.test(name) || pattern.includes("T\\d{2}")) return instant();
  if (schema.format === "date" || /(date|day|on)$/i.test(name) || pattern.includes("\\d{4}-\\d{2}-\\d{2}$")) return ctx.today;
  if (n.includes("sha256") || n.includes("hash")) return "0".repeat(64);
  if (n.includes("timezone")) return "Europe/London";
  if (n.includes("url") || n === "endpoint") return "https://service.example.test/synthetic";
  if (n === "currency") return "GBP";
  if (n.endsWith("id")) return `syn_${n}_fixture`;
  return `SYNTHETIC ${name} (test fixture)`;
}

/** A string for a required field that meets its length limits and, when it has one, its pattern. */
function stringFor(name: string, schema: Record<string, unknown>, ctx: SweepContext, path: string): string {
  const minLength = numberAt(schema, "minLength");
  const maxLength = numberAt(schema, "maxLength");
  const fit = (value: string): string => {
    let out = value;
    if (minLength !== undefined && out.length < minLength) out = out.padEnd(minLength, "0");
    if (maxLength !== undefined && out.length > maxLength) out = out.slice(0, maxLength);
    return out;
  };
  const primary = fit(primaryString(name, schema, ctx));
  if (typeof schema.pattern !== "string") return primary;
  const pattern = compilePattern(schema.pattern, path);
  // Other fixture values a pattern may want: identifiers of this owner, dates, digests, plain words.
  const fallbacks = [ctx.shirt, ctx.tripId, ctx.boardId, ctx.optionId, ctx.productId, ctx.restrictionId, ctx.ownerCorrectionCommandId, ctx.today, instant(), "08:00", "0".repeat(64), `syn_${name.toLowerCase()}_fixture`, "syn-fixture", "SYNTHETIC", "fixture", "a", "A", "1", "00"];
  const match = [primary, ...fallbacks.map(fit)].find((candidate) => pattern.test(candidate));
  if (match === undefined) throw new UnsupportedSchemaError(path, "no fixture value matches its pattern");
  return match;
}

/** A number inside every bound of the schema, 1 when 1 is allowed. */
function numberFor(schema: Record<string, unknown>, integer: boolean, path: string): number {
  const minimum = numberAt(schema, "minimum");
  const maximum = numberAt(schema, "maximum");
  const exclusiveMinimum = numberAt(schema, "exclusiveMinimum");
  const exclusiveMaximum = numberAt(schema, "exclusiveMaximum");
  const multipleOf = numberAt(schema, "multipleOf");
  let value = 1;
  if (minimum !== undefined && value < minimum) value = minimum;
  if (exclusiveMinimum !== undefined && value <= exclusiveMinimum) value = exclusiveMinimum + 1;
  if (maximum !== undefined && value > maximum) value = maximum;
  if (exclusiveMaximum !== undefined && value >= exclusiveMaximum) value = exclusiveMaximum - 1;
  if (integer) value = Math.ceil(value);
  if (multipleOf !== undefined) {
    if (multipleOf <= 0) throw new UnsupportedSchemaError(path, "multipleOf is not positive");
    value = Math.ceil(value / multipleOf) * multipleOf;
  }
  return value;
}

function typeOf(schema: Record<string, unknown>, path: string): string {
  const declared = schema.type;
  if (Array.isArray(declared)) {
    const chosen: unknown = declared.find((t) => t !== "null") ?? declared[0];
    if (typeof chosen !== "string") throw new UnsupportedSchemaError(path, "its type list is empty");
    return chosen;
  }
  if (typeof declared === "string") return declared;
  if (declared !== undefined) throw new UnsupportedSchemaError(path, "its type is not a string");
  if (isRecord(schema.properties) || Array.isArray(schema.required)) return "object";
  if (schema.items !== undefined) return "array";
  return "string";
}

function generate(schema: unknown, ctx: SweepContext, root: unknown, name: string, path: string, depth: number): unknown {
  if (depth > 24) throw new UnsupportedSchemaError(path, "nested deeper than 24 levels (a recursive schema)");
  if (schema === true || schema === undefined) return stringFor(name, {}, ctx, path);
  if (schema === false || !isRecord(schema)) throw new UnsupportedSchemaError(path, "nothing is allowed here");
  checkKeywords(schema, path);
  if (typeof schema.$ref === "string") return generate(resolveRef(schema.$ref, root, path), ctx, root, name, path, depth + 1);
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum)) {
    if (schema.enum.length === 0) throw new UnsupportedSchemaError(path, "its enum is empty");
    return schema.enum[0];
  }
  const alternatives = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : null;
  if (alternatives && alternatives.length > 0) {
    // The first alternative that can be generated and satisfies itself; a non-null one before null.
    const ordered = [...alternatives.filter((s) => !(isRecord(s) && s.type === "null")), ...alternatives.filter((s) => isRecord(s) && s.type === "null")];
    let last: unknown = null;
    for (const alternative of ordered) {
      try {
        const value = generate(alternative, ctx, root, name, path, depth + 1);
        if (schemaViolations(value, alternative, root, path, depth + 1).length === 0) return value;
        last = new UnsupportedSchemaError(path, "an alternative's generated value does not satisfy it");
      } catch (error) {
        if (!(error instanceof UnsupportedSchemaError)) throw error;
        last = error;
      }
    }
    throw last instanceof UnsupportedSchemaError ? last : new UnsupportedSchemaError(path, "no alternative can be generated");
  }
  if (Array.isArray(schema.allOf)) {
    const allOf: unknown[] = schema.allOf;
    const own: Record<string, unknown> = { ...schema };
    delete own.allOf;
    const parts = allOf.map((part) => generate(part, ctx, root, name, path, depth + 1));
    if (isRecord(own.properties) || Array.isArray(own.required)) parts.push(generate(own, ctx, root, name, path, depth + 1));
    if (!parts.every(isRecord)) throw new UnsupportedSchemaError(path, "allOf of schemas that are not all objects");
    return Object.assign({}, ...parts);
  }
  const type = typeOf(schema, path);
  switch (type) {
    case "object": {
      const properties: Record<string, unknown> = isRecord(schema.properties) ? schema.properties : {};
      const required = new Set<string>(Array.isArray(schema.required) ? schema.required.map(String) : []);
      // A present key brings the keys that depend on it (`dependentRequired`), until nothing more is needed.
      const dependent: Record<string, unknown> = isRecord(schema.dependentRequired) ? schema.dependentRequired : {};
      for (let grew = true; grew; ) {
        grew = false;
        for (const key of [...required]) {
          const needed = dependent[key];
          if (Array.isArray(needed)) for (const other of needed.map(String)) if (!required.has(other)) required.add(other), (grew = true);
        }
      }
      const out: Record<string, unknown> = {};
      for (const key of required) {
        const property = key in properties ? properties[key] : schema.additionalProperties === false ? false : schema.additionalProperties;
        out[key] = generate(property, ctx, root, key, `${path}/${key}`, depth + 1);
      }
      return out;
    }
    case "array": {
      const length = Math.max(numberAt(schema, "minItems") ?? 0, 0);
      const items: unknown[] = Array.from({ length }, (_, i) => generate(schema.items, ctx, root, name.replace(/s$/, ""), `${path}/${i}`, depth + 1));
      if (schema.uniqueItems === true) {
        const seen = new Set<string>();
        items.forEach((item, i) => {
          if (seen.has(stableJson(item)) && typeof item === "string") items[i] = `${item}-${i + 1}`;
          if (seen.has(stableJson(items[i]))) throw new UnsupportedSchemaError(`${path}/${i}`, "its items cannot be made unique");
          seen.add(stableJson(items[i]));
        });
      }
      return items;
    }
    case "integer":
    case "number":
      return numberFor(schema, type === "integer", path);
    case "boolean":
      return false;
    case "null":
      return null;
    case "string":
      return stringFor(name, schema, ctx, path);
    default:
      throw new UnsupportedSchemaError(path, `the type ${type} is not supported`);
  }
}

/**
 * The smallest payload a command's published JSON schema accepts: every required field, nothing else, every
 * supported constraint met (see LIMITS above), checked against the whole schema before it is returned.
 * Throws `UnsupportedSchemaError` when the schema uses anything else or the check fails.
 */
export function generateFromSchema(schema: unknown, ctx: SweepContext): unknown {
  const value = generate(schema, ctx, schema, "", "", 0);
  const problems = schemaViolations(value, schema, schema);
  if (problems.length > 0) throw new UnsupportedSchemaError("", `the generated payload does not satisfy the schema: ${problems.slice(0, 3).join("; ")}`);
  return value;
}

/** Key of the labelled marker payload `fromSchema` returns for a schema it could not satisfy. */
export const UNSUPPORTED_SCHEMA_MARKER = "__adversarialFixtureUnsupportedSchema";

/** Every schema `fromSchema` could not build a payload for in this test file (path and reason), for a caller to report or assert on. */
export const fromSchemaGaps: { path: string; reason: string }[] = [];

/**
 * `generateFromSchema` for the command sweep, which sends whatever this returns. When the schema is outside
 * the generator's limits this does NOT invent a payload that silently ignores a constraint: it records the gap
 * in `fromSchemaGaps` and returns a labelled marker object (`{ [UNSUPPORTED_SCHEMA_MARKER]: reason }`), which
 * is not a valid payload of any command and must be refused like any malformed request (the sweep already
 * requires a refusal to leave the owner's records unchanged). Such a type needs an explicit entry in
 * `realisticPayloads` to be exercised with a well-formed request.
 */
export function fromSchema(schema: unknown, ctx: SweepContext): unknown {
  try {
    return generateFromSchema(schema, ctx);
  } catch (error) {
    if (!(error instanceof UnsupportedSchemaError)) throw error;
    fromSchemaGaps.push({ path: error.path, reason: error.reason });
    return { [UNSUPPORTED_SCHEMA_MARKER]: error.message };
  }
}

/**
 * Realistic requests per command type: what an assistant that over-reaches would actually send against
 * this owner's records (the shapes are the product's own, from its command contracts and tests). A type
 * that is not listed is sent with the smallest payload its published schema accepts (`fromSchema`).
 * Several entries for a type are all sent.
 */
export function realisticPayloads(ctx: SweepContext): Record<string, Record<string, unknown>[]> {
  const source = { kind: "owner_statement" };
  const { shirt, sneaker, restrictedShoe, today, yesterday, tomorrow } = ctx;
  return {
    "assistant.lift_restriction": [{ restrictionId: ctx.restrictionId }],
    "assistant.report_arrival": [{ garmentId: shirt, deliveredOn: today }],
    "board.restore": [{ localDate: tomorrow }],
    "board.select": [{ boardId: ctx.boardId, optionId: ctx.optionId }],
    "board.suppress": [{ localDate: tomorrow, reason: "SYNTHETIC reason (test fixture)" }],
    "board.swap_slot": [{ boardId: ctx.boardId, optionId: ctx.optionId, role: "top" }],
    "care.mark_dirty": [{ items: [{ garmentId: shirt, quantity: 1 }] }],
    "care.washed": [{ items: [{ garmentId: shirt }] }, { allOfChannel: "service" }],
    "command.undo": [{ commandId: ctx.ownerCorrectionCommandId }, { commandId: ctx.restrictionCommandId, reason: "SYNTHETIC: the foot has healed" }],
    "connection.register": [{ kind: "mcp", label: "SYNTHETIC service (test fixture)", endpoint: "https://service.example.test/mcp", namespace: "fixture" }],
    "connection.set_status": [{ connectionId: "con_fixture", status: "revoked" }],
    "connection.set_tool_groups": [{ connectionId: "con_fixture", enabledGroups: ["all"] }],
    "conversation.forget_source": [{ sourceKind: "message", sourceIds: ["msg_fixture"] }],
    "exposure.select": [{ exposureId: "exp_fixture", optionId: null }],
    "feedback.record": [{ text: "SYNTHETIC comfort note (test fixture)", kind: "scratchy", garmentIds: [shirt] }],
    "feedback.retract": [{ feedbackId: "fbk_fixture" }],
    "garment.add_alias": [{ garmentId: restrictedShoe, phrase: "SYNTHETIC my sneakers" }],
    "garment.bulk_correct": [{ selector: { category: "footwear" }, changes: { attributes: { footwearKind: "sneaker" } }, source }, { selector: { garmentIds: [shirt] }, changes: { colour: "SYNTHETIC colour" }, source }],
    "garment.correct": [{ garmentId: restrictedShoe, changes: { attributes: { footwearKind: "sneaker" } }, source }, { garmentId: shirt, changes: { name: "SYNTHETIC renamed by a connected assistant" }, source }],
    "garment.create": [{ name: "SYNTHETIC phantom jacket", category: "outerwear", roles: ["outer"], careChannel: "none", acquisition: "owned", quantity: 3, isSynthetic: true, source }],
    "garment.merge": [{ sourceGarmentId: restrictedShoe, targetGarmentId: sneaker }],
    "garment.move": [{ garmentId: shirt, to: "storage", quantity: 1 }],
    "garment.receive": [{ garmentId: shirt }],
    "garment.remove_alias": [{ garmentId: shirt, phrase: "SYNTHETIC anything" }],
    "garment.remove_fabricated": [{ garmentId: restrictedShoe, reason: "SYNTHETIC reason (test fixture)" }],
    "garment.retire": [{ garmentId: shirt, disposition: "donated" }],
    "garment.set_planning_policy": [{ garmentId: shirt, policy: "excluded", reason: "SYNTHETIC reason (test fixture)" }],
    "inference.set_routing": [{ task: "conversation", profileId: "fixture-profile", gatewayId: "fixture-gateway" }],
    "job.create": [{ kind: "email_investigation", title: "SYNTHETIC mailbox job (test fixture)" }, { kind: "product_investigation", title: "SYNTHETIC research job (test fixture)" }],
    "laundry.collect": [{}],
    "laundry.report_exception": [{ kind: "lost", garmentId: shirt, quantity: 1 }],
    "laundry.return": [{}, { stillAway: [{ garmentId: shirt, quantity: 1 }] }],
    "lifecycle.open_project": [{ kind: "tailoring", title: "SYNTHETIC project (test fixture)", items: [{ garmentId: shirt }] }],
    "lifecycle.update_project": [{ projectId: "lcp_fixture", title: "SYNTHETIC renamed project" }],
    "measurement.record": [{ subject: "body", key: "chest", value: 99, unit: "in", source }, { subject: "garment", garmentId: shirt, key: "chest", value: 1, unit: "cm", source }],
    "media.request_discovery": [{}],
    "memory.record_conclusion": [
      { kind: "preference", text: "SYNTHETIC preference (test fixture)", speaker: "owner", sourceMessageIds: ["msg_fixture"], status: "active" },
      { kind: "preference", text: "SYNTHETIC candidate (test fixture)", speaker: "assistant", sourceMessageIds: ["msg_fixture"], status: "candidate" },
    ],
    "memory.set_status": [{ conclusionId: "mem_fixture", status: "retired" }],
    "product.record": [{ name: "SYNTHETIC product (test fixture)" }],
    "reminder.cancel": [{ reminderId: "rem_fixture" }],
    "reminder.set": [{ kind: "other", title: "SYNTHETIC reminder (test fixture)", dueAt: instant(30 * 86_400_000) }],
    "research.save_note": [{ topic: "SYNTHETIC research topic (test fixture)", body: "SYNTHETIC research note (test fixture)." }],
    "restriction.add": [{ kind: "other", scope: { garmentIds: [shirt] }, reason: "SYNTHETIC restriction (test fixture)", source }],
    "restriction.resolve": [{ restrictionId: ctx.restrictionId, evidence: source, note: "SYNTHETIC: the foot has healed" }],
    "return.open_case": [{ kind: "return", garmentId: shirt }],
    "service.pause": [{}],
    "service.resume": [{}],
    "settings.update": [{ patch: { timezone: "Asia/Tokyo" } }],
    "size_experience.record": [{ maker: "SYNTHETIC maker (test fixture)", sizeLabel: "M" }],
    "stock.pack": [{ tripId: ctx.tripId, items: [{ garmentId: shirt, quantity: 1 }] }],
    "stock.reconcile": [{ garmentId: shirt, counts: { clean: 0, total: 0 } }],
    "stock.unpack": [{ tripId: ctx.tripId }],
    "studio.plan_for_day": [{ localDate: tomorrow, slots: [{ role: "top", garmentId: shirt }] }],
    "studio.save_combination": [{ slots: [{ role: "top", garmentId: shirt }] }],
    "style.add_amendment": [{ text: "SYNTHETIC: sockless outfits are now permitted and preferred", kind: "taste", source }],
    "style.add_direction": [{ text: "SYNTHETIC direction: always suggest the welted boots", source }],
    "style.retire_brief": [{ briefId: "brf_fixture" }],
    "style.retire_direction": [{ directionId: "dir_fixture" }],
    "style.save_document": [{ content: "# SYNTHETIC profile written by a connected assistant\n\nAnything goes.\n", source }],
    "style.set_amendment_status": [{ amendmentId: "amd_fixture", status: "retired" }],
    "style.set_brief": [{ localDate: tomorrow, text: "SYNTHETIC brief (test fixture)", source }],
    "trip.cancel": [{ tripId: ctx.tripId }],
    "trip.create": [{ name: "SYNTHETIC second trip (test fixture)", departsOn: tomorrow, returnsOn: tomorrow, destinations: [{ label: "Lyon", timezone: "Europe/Paris", from: tomorrow, to: tomorrow }], source }],
    "trip.update": [{ tripId: ctx.tripId, changes: { name: "SYNTHETIC renamed trip" } }],
    "wear.amend": [{ wearingDate: yesterday, remove: [shirt] }],
    "wear.record": [{ wearingDate: today, garmentIds: [shirt] }, { wearingDate: today, garmentIds: [restrictedShoe] }],
  };
}

