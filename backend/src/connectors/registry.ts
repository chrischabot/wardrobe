import { tool, type ToolSet } from 'ai';
import { jsonSchema } from 'ai';
import { canonicalJson, sha256Hex } from '../domain/hash.js';
import { DomainError } from '../domain/errors.js';
import { assertPrincipal, type Principal } from '../domain/principal.js';
import { credentialFreeUrl, redactSecrets } from './redact.js';
import { sanitizeToolDescription, wrapUntrusted, type UntrustedEnvelope } from './untrusted.js';
import { validateOutboundUrl } from './url-policy.js';

/**
 * Outbound MCP connection registry (spec section 13, "Extensible outbound MCP connections").
 *
 * A connection record holds endpoint (credential-free), expected issuer, credential reference,
 * transport and protocol, discovered tools, a stable namespace, schema digest, allowed effects, data
 * classes, limits and health. Models see namespaced wrappers only (`namespace__tool`), with
 * sanitized descriptions and untrusted-data envelopes around outputs. Built-in tools cannot be
 * overwritten, a schema change requires re-approval, and disconnect cancels queued calls and removes
 * cached credentials. Think's automatic MCP tool merge is disabled on the assistant.
 */

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
}

export interface McpClientLike {
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>, opts: { signal: AbortSignal }): Promise<{ content: unknown[]; isError?: boolean; structuredContent?: unknown }>;
  close?(): Promise<void>;
}

export type CredentialPlacement = { type: 'none' } | { type: 'bearer' } | { type: 'query'; param: string } | { type: 'header'; name: string };

export interface DispatchTarget {
  /** Resolved endpoint; may carry a secret query parameter. Never logged or stored. */
  url: URL;
  headers: Record<string, string>;
  secrets: string[];
}

export type McpClientFactory = (target: DispatchTarget) => Promise<McpClientLike>;

export interface CredentialStore {
  resolve(ref: string): Promise<string | null>;
  delete(ref: string): Promise<void>;
}

export class MemoryCredentialStore implements CredentialStore {
  readonly values = new Map<string, string>();
  async resolve(ref: string) {
    return this.values.get(ref) ?? null;
  }
  async delete(ref: string) {
    this.values.delete(ref);
  }
}

/** `env:NAME` references resolve to Worker secrets; nothing else is readable. */
export class EnvCredentialStore implements CredentialStore {
  constructor(private readonly env: Record<string, unknown>) {}
  async resolve(ref: string) {
    if (!ref.startsWith('env:')) return null;
    const v = this.env[ref.slice(4)];
    return typeof v === 'string' ? v : null;
  }
  async delete() {
    /* Worker secrets are removed with wrangler; the connection simply stops referencing them. */
  }
}

export type ConnectionKind = 'mcp' | 'exa' | 'tavily' | 'gmail' | 'calendar' | 'drive' | 'sheets';
export type Effect = 'read' | 'write';

export interface ConnectionLimits {
  maxInputBytes: number;
  maxOutputChars: number;
  timeoutMs: number;
  callsPerMinute: number;
  credentialPlacement: CredentialPlacement;
}

const DEFAULT_LIMITS: ConnectionLimits = { maxInputBytes: 16_000, maxOutputChars: 20_000, timeoutMs: 20_000, callsPerMinute: 30, credentialPlacement: { type: 'none' } };

export const RESERVED_NAMESPACES = new Set(['garderobe', 'builtin', 'profile', 'browser', 'system', 'assistant', 'workspace', 'record', 'wardrobe']);

export interface ConnectionRecord {
  connectionId: string;
  name: string;
  namespace: string;
  kind: ConnectionKind;
  endpoint: string;
  transport: string;
  protocolVersion: string;
  status: 'active' | 'reconnect_required' | 'disconnected';
  schemaDigest: string | null;
  tools: { name: string; effect: Effect; approved: boolean; suspiciousDescription: boolean }[];
  allowedEffects: Effect[];
  hasCredential: boolean;
  health: Record<string, unknown>;
}

interface Row {
  connection_id: string;
  name: string;
  namespace: string;
  kind: ConnectionKind;
  endpoint: string;
  expected_issuer: string | null;
  credential_ref: string | null;
  transport: string;
  protocol_version: string;
  tools_json: string;
  schema_digest: string | null;
  allowed_effects_json: string;
  limits_json: string;
  status: ConnectionRecord['status'];
  health_json: string;
  version: number;
}

interface StoredTool extends McpToolDescriptor {
  effect: Effect;
  approved: boolean;
  suspiciousDescription: boolean;
}

export const MCP_PROTOCOL_VERSION = '2026-07-28';

export async function schemaDigest(tools: McpToolDescriptor[]): Promise<string> {
  const canonical = [...tools].sort((a, b) => a.name.localeCompare(b.name)).map((t) => ({ name: t.name, inputSchema: t.inputSchema, annotations: t.annotations ?? {} }));
  return sha256Hex(canonicalJson(canonical));
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
}

export class ConnectionRegistry {
  private readonly now: () => string;
  constructor(
    private readonly db: D1Database,
    private readonly principal: Principal,
    private readonly deps: { clientFactory: McpClientFactory; credentials: CredentialStore; now?: () => string; builtinToolNames?: readonly string[] },
  ) {
    assertPrincipal(principal);
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  private get userId() {
    return this.principal.userId;
  }

  private toRecord(r: Row): ConnectionRecord {
    const tools = JSON.parse(r.tools_json) as StoredTool[];
    return {
      connectionId: r.connection_id,
      name: r.name,
      namespace: r.namespace,
      kind: r.kind,
      endpoint: credentialFreeUrl(r.endpoint),
      transport: r.transport,
      protocolVersion: r.protocol_version,
      status: r.status,
      schemaDigest: r.schema_digest,
      tools: tools.map((t) => ({ name: t.name, effect: t.effect, approved: t.approved, suspiciousDescription: t.suspiciousDescription })),
      allowedEffects: JSON.parse(r.allowed_effects_json) as Effect[],
      hasCredential: Boolean(r.credential_ref),
      health: JSON.parse(r.health_json) as Record<string, unknown>,
    };
  }

  private async row(idOrNamespace: string): Promise<Row> {
    const r = await this.db.prepare('SELECT * FROM connections WHERE user_id = ? AND (connection_id = ? OR namespace = ?)').bind(this.userId, idOrNamespace, idOrNamespace).first<Row>();
    if (!r) throw new DomainError('not_found', `No connection ${idOrNamespace}`);
    return r;
  }

  async list(): Promise<ConnectionRecord[]> {
    const { results } = await this.db.prepare('SELECT * FROM connections WHERE user_id = ? ORDER BY created_at').bind(this.userId).all<Row>();
    return results.map((r) => this.toRecord(r));
  }

  async get(idOrNamespace: string): Promise<ConnectionRecord> {
    return this.toRecord(await this.row(idOrNamespace));
  }

  async add(input: {
    name: string;
    endpoint: string;
    kind?: ConnectionKind;
    namespace?: string;
    credentialRef?: string;
    credentialPlacement?: CredentialPlacement;
    expectedIssuer?: string;
    allowedEffects?: Effect[];
    dataClasses?: string[];
    limits?: Partial<Omit<ConnectionLimits, 'credentialPlacement'>>;
  }): Promise<ConnectionRecord> {
    const url = validateOutboundUrl(input.endpoint);
    if ([...url.searchParams.keys()].some((k) => /key|token|secret|password|sig|auth/i.test(k))) {
      throw new DomainError('validation_failed', 'Endpoints must be credential-free; supply the secret as a credential reference');
    }
    if (input.expectedIssuer) validateOutboundUrl(input.expectedIssuer);
    const namespace = slug(input.namespace ?? input.name);
    if (!namespace || RESERVED_NAMESPACES.has(namespace) || (this.deps.builtinToolNames ?? []).includes(namespace)) {
      throw new DomainError('validation_failed', `The namespace "${namespace}" is reserved for built-in capabilities`);
    }
    const existingRef = input.credentialRef ? await this.db.prepare('SELECT connection_id FROM connections WHERE user_id = ? AND credential_ref = ? AND status <> ?').bind(this.userId, input.credentialRef, 'disconnected').first() : null;
    if (existingRef) throw new DomainError('validation_failed', 'That credential belongs to another connection; credentials are never shared between connections');
    const id = `con_${crypto.randomUUID().replace(/-/g, '')}`;
    const limits: ConnectionLimits = { ...DEFAULT_LIMITS, ...(input.limits ?? {}), credentialPlacement: input.credentialPlacement ?? (input.credentialRef ? { type: 'bearer' } : { type: 'none' }) };
    try {
      await this.db
        .prepare(
          `INSERT INTO connections (user_id, connection_id, name, namespace, kind, endpoint, expected_issuer, credential_ref, transport, protocol_version, allowed_effects_json, data_classes_json, limits_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'streamable-http', ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .bind(this.userId, id, input.name.slice(0, 80), namespace, input.kind ?? 'mcp', url.toString(), input.expectedIssuer ?? null, input.credentialRef ?? null, MCP_PROTOCOL_VERSION, JSON.stringify(input.allowedEffects ?? ['read']), JSON.stringify(input.dataClasses ?? []), JSON.stringify(limits), this.now(), this.now())
        .run();
    } catch (err) {
      if (String(err).includes('UNIQUE')) throw new DomainError('conflict', `A connection named ${namespace} already exists`);
      throw err;
    }
    return this.get(id);
  }

  private async target(r: Row): Promise<DispatchTarget> {
    const url = validateOutboundUrl(r.endpoint);
    const limits = JSON.parse(r.limits_json) as ConnectionLimits;
    const headers: Record<string, string> = {};
    const secrets: string[] = [];
    if (r.credential_ref) {
      const secret = await this.deps.credentials.resolve(r.credential_ref);
      if (!secret) throw new DomainError('invalid_state', `${r.name} needs to be reconnected`);
      secrets.push(secret);
      const p = limits.credentialPlacement;
      if (p.type === 'bearer') headers.authorization = `Bearer ${secret}`;
      else if (p.type === 'header') headers[p.name] = secret;
      else if (p.type === 'query') url.searchParams.set(p.param, secret);
    }
    return { url, headers, secrets };
  }

  /** Discover tools, compute the schema digest, and require re-approval when the schema changed. */
  async discover(idOrNamespace: string): Promise<{ record: ConnectionRecord; changed: boolean }> {
    const r = await this.row(idOrNamespace);
    if (r.status === 'disconnected') throw new DomainError('invalid_state', 'This connection is disconnected');
    const target = await this.target(r);
    let tools: McpToolDescriptor[];
    try {
      const client = await this.deps.clientFactory(target);
      tools = await client.listTools();
      await client.close?.();
    } catch (err) {
      const message = redactSecrets(err instanceof Error ? err.message : String(err), target.secrets);
      await this.db.prepare('UPDATE connections SET health_json = ?, updated_at = ? WHERE user_id = ? AND connection_id = ?').bind(JSON.stringify({ ok: false, error: message, at: this.now() }), this.now(), this.userId, r.connection_id).run();
      throw new DomainError('invalid_state', `Could not reach ${r.name}: ${message}`);
    }
    const digest = await schemaDigest(tools);
    const allowed = JSON.parse(r.allowed_effects_json) as Effect[];
    const changed = r.schema_digest !== null && r.schema_digest !== digest;
    const stored: StoredTool[] = tools.slice(0, 200).map((t) => {
      const effect: Effect = t.annotations?.readOnlyHint === true && !t.annotations?.destructiveHint ? 'read' : 'write';
      const { suspicious } = sanitizeToolDescription(r.name, t.description);
      return { ...t, effect, approved: allowed.includes(effect) && !changed, suspiciousDescription: suspicious.length > 0 };
    });
    await this.db
      .prepare('UPDATE connections SET tools_json = ?, schema_digest = ?, status = ?, health_json = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND connection_id = ?')
      .bind(JSON.stringify(stored), changed ? r.schema_digest : digest, changed ? 'reconnect_required' : 'active', JSON.stringify({ ok: true, at: this.now(), ...(changed ? { pendingDigest: digest } : {}) }), this.now(), this.userId, r.connection_id)
      .run();
    return { record: await this.get(r.connection_id), changed };
  }

  /** Owner re-approval after a schema change (accepts the new digest). */
  async approveSchema(idOrNamespace: string): Promise<ConnectionRecord> {
    const r = await this.row(idOrNamespace);
    const health = JSON.parse(r.health_json) as { pendingDigest?: string };
    if (!health.pendingDigest) return this.get(r.connection_id);
    const allowed = JSON.parse(r.allowed_effects_json) as Effect[];
    const tools = (JSON.parse(r.tools_json) as StoredTool[]).map((t) => ({ ...t, approved: allowed.includes(t.effect) }));
    await this.db
      .prepare("UPDATE connections SET schema_digest = ?, tools_json = ?, status = 'active', health_json = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND connection_id = ?")
      .bind(health.pendingDigest, JSON.stringify(tools), JSON.stringify({ ok: true, at: this.now() }), this.now(), this.userId, r.connection_id)
      .run();
    return this.get(r.connection_id);
  }

  async enqueue(idOrNamespace: string, toolName: string, input: Record<string, unknown>): Promise<string> {
    const r = await this.row(idOrNamespace);
    const callId = `ccall_${crypto.randomUUID().replace(/-/g, '')}`;
    await this.db
      .prepare("INSERT INTO connector_calls (user_id, call_id, connection_id, tool, status, input_sha256, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)")
      .bind(this.userId, callId, r.connection_id, toolName, await sha256Hex(canonicalJson(input)), this.now(), this.now())
      .run();
    return callId;
  }

  /** Dispatch a queued call under the connection's policy. Returns an untrusted-data envelope. */
  async dispatch(callId: string, input: Record<string, unknown>): Promise<UntrustedEnvelope | { error: string; message: string }> {
    const call = await this.db.prepare('SELECT * FROM connector_calls WHERE user_id = ? AND call_id = ?').bind(this.userId, callId).first<{ connection_id: string; tool: string; status: string; input_sha256: string }>();
    if (!call) throw new DomainError('not_found', 'No such call');
    if (call.status !== 'queued') return { error: 'not_dispatched', message: `Call is ${call.status}` };
    if (call.input_sha256 !== (await sha256Hex(canonicalJson(input)))) return this.failCall(callId, 'input_mismatch', 'Input differs from the queued call');
    const r = await this.row(call.connection_id);
    if (r.status !== 'active') return this.failCall(callId, 'connection_unavailable', `${r.name} is ${r.status.replace('_', ' ')}`, 'cancelled');
    const tools = JSON.parse(r.tools_json) as StoredTool[];
    const t = tools.find((x) => x.name === call.tool);
    if (!t) return this.failCall(callId, 'unknown_tool', `${r.name} has no approved tool ${call.tool}`);
    if (!t.approved) return this.failCall(callId, 'effect_not_allowed', `${call.tool} is a ${t.effect} tool; this connection allows ${(JSON.parse(r.allowed_effects_json) as Effect[]).join(', ')}`);
    const limits = JSON.parse(r.limits_json) as ConnectionLimits;
    if (JSON.stringify(input).length > limits.maxInputBytes) return this.failCall(callId, 'input_too_large', 'Input exceeds the connection limit');
    const recent = await this.db
      .prepare("SELECT COUNT(*) AS n FROM connector_calls WHERE user_id = ? AND connection_id = ? AND status IN ('running', 'succeeded', 'failed') AND created_at >= ?")
      .bind(this.userId, r.connection_id, new Date(Date.parse(this.now()) - 60_000).toISOString())
      .first<{ n: number }>();
    if ((recent?.n ?? 0) >= limits.callsPerMinute) return this.failCall(callId, 'rate_limited', 'Rate limit reached for this connection');
    const claimed = await this.db.prepare("UPDATE connector_calls SET status = 'running', updated_at = ? WHERE user_id = ? AND call_id = ? AND status = 'queued'").bind(this.now(), this.userId, callId).run();
    if (!claimed.meta.changes) return { error: 'not_dispatched', message: 'Call was cancelled' };
    const target = await this.target(r);
    try {
      const client = await this.deps.clientFactory(target);
      const res = await client.callTool(call.tool, input, { signal: AbortSignal.timeout(limits.timeoutMs) });
      await client.close?.();
      await this.db.prepare("UPDATE connector_calls SET status = ?, updated_at = ? WHERE user_id = ? AND call_id = ?").bind(res.isError ? 'failed' : 'succeeded', this.now(), this.userId, callId).run();
      return wrapUntrusted(`${r.name} (${call.tool})`, res.structuredContent ?? res.content, { maxChars: limits.maxOutputChars, knownSecrets: target.secrets });
    } catch (err) {
      const message = redactSecrets(err instanceof Error ? err.message : String(err), target.secrets);
      return this.failCall(callId, 'call_failed', message);
    }
  }

  private async failCall(callId: string, error: string, message: string, status: 'failed' | 'cancelled' = 'failed') {
    await this.db.prepare('UPDATE connector_calls SET status = ?, error = ?, updated_at = ? WHERE user_id = ? AND call_id = ?').bind(status, `${error}: ${message}`.slice(0, 500), this.now(), this.userId, callId).run();
    return { error, message };
  }

  async call(idOrNamespace: string, toolName: string, input: Record<string, unknown>) {
    const callId = await this.enqueue(idOrNamespace, toolName, input);
    return this.dispatch(callId, input);
  }

  /** Stop new calls and queued continuations, remove cached credentials, mark disconnected. */
  async disconnect(idOrNamespace: string, opts: { revoke?: () => Promise<void> } = {}): Promise<{ cancelledCalls: number; revoked: boolean }> {
    const r = await this.row(idOrNamespace);
    const cancelled = await this.db.prepare("UPDATE connector_calls SET status = 'cancelled', error = 'connection disconnected', updated_at = ? WHERE user_id = ? AND connection_id = ? AND status = 'queued'").bind(this.now(), this.userId, r.connection_id).run();
    if (r.credential_ref) await this.deps.credentials.delete(r.credential_ref);
    await this.db
      .prepare("UPDATE connections SET status = 'disconnected', credential_ref = NULL, tools_json = '[]', version = version + 1, updated_at = ? WHERE user_id = ? AND connection_id = ?")
      .bind(this.now(), this.userId, r.connection_id)
      .run();
    let revoked = false;
    if (opts.revoke) revoked = await opts.revoke().then(() => true, () => false);
    return { cancelledCalls: cancelled.meta.changes ?? 0, revoked };
  }

  /** Mark an authorization failure: one reconnect state, calls blocked until the owner reconnects. */
  async markReconnectRequired(idOrNamespace: string, reason: string): Promise<void> {
    const r = await this.row(idOrNamespace);
    await this.db.prepare("UPDATE connections SET status = 'reconnect_required', health_json = ?, updated_at = ? WHERE user_id = ? AND connection_id = ? AND status = 'active'").bind(JSON.stringify({ ok: false, reason: redactSecrets(reason), at: this.now() }), this.now(), this.userId, r.connection_id).run();
  }

  /** Namespaced, approved wrappers for the model. Built-in names are never shadowed. */
  async toolSet(): Promise<ToolSet> {
    const set: ToolSet = {};
    const builtins = new Set(this.deps.builtinToolNames ?? []);
    for (const c of await this.db.prepare("SELECT * FROM connections WHERE user_id = ? AND status = 'active'").bind(this.userId).all<Row>().then((x) => x.results)) {
      for (const t of JSON.parse(c.tools_json) as StoredTool[]) {
        if (!t.approved) continue;
        const name = `${c.namespace}__${t.name.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64);
        if (builtins.has(name) || set[name]) continue;
        const { text } = sanitizeToolDescription(c.name, t.description);
        set[name] = tool({
          description: text,
          inputSchema: jsonSchema(t.inputSchema as never),
          execute: async (input: unknown) => this.call(c.connection_id, t.name, (input ?? {}) as Record<string, unknown>),
        } as never);
      }
    }
    return set;
  }
}
