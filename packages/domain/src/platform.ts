import { DEFAULT_OWNER_SETTINGS, OwnerSettings } from "@garderobe/contracts";
import type { Actor, Channel, Scope } from "@garderobe/contracts";
import { all, first, json, prepare, stmt, type Db } from "./db.ts";
import { CommandError } from "./errors.ts";
import { assertPrincipal, createPrincipal, type Principal } from "./principal.ts";
import { canonicalJson, deepMerge, newId, sha256Hex, toInstant } from "./util.ts";

/**
 * Owner provisioning and identity mapping. These are administrative operations performed by trusted
 * code (deployment provisioning, the identity workstream's claim/link flows, tests) - never by a
 * request body. Email is a display attribute; identity is (issuer, subject).
 */

export interface CreateUserInput {
  userId?: string;
  displayName: string;
  isSynthetic?: boolean;
  settings?: Partial<OwnerSettings>;
  nowMs?: number;
}

export async function createUser(db: Db, input: CreateUserInput): Promise<{ userId: string }> {
  const userId = input.userId ?? newId("usr");
  const now = toInstant(input.nowMs ?? Date.now());
  const settings = OwnerSettings.parse(deepMerge(DEFAULT_OWNER_SETTINGS, input.settings ?? {}));
  const text = JSON.stringify(settings);
  await db.batch(
    [
      stmt("INSERT INTO users (user_id, display_name, status, is_synthetic, created_at) VALUES (?, ?, 'active', ?, ?)", userId, input.displayName, input.isSynthetic ?? false, now),
      stmt("INSERT INTO owner_settings (user_id, version, settings_json, updated_at) VALUES (?, 1, ?, ?)", userId, text, now),
      stmt("INSERT INTO owner_settings_versions (user_id, version, settings_json, command_id, created_at) VALUES (?, 1, ?, NULL, ?)", userId, text, now),
      stmt("INSERT INTO owner_state (user_id, wardrobe_revision, style_revision) VALUES (?, 0, 0)", userId),
    ].map((s) => prepare(db, s)),
  );
  return { userId };
}

/** Link a verified identity to an existing user. A given (issuer, subject) maps to exactly one user. */
export async function linkIdentity(db: Db, input: { userId: string; issuer: string; subject: string; displayEmail?: string; nowMs?: number }): Promise<void> {
  const existing = await first<{ user_id: string; unlinked_at: string | null }>(db, "SELECT user_id, unlinked_at FROM auth_identities WHERE issuer = ? AND subject = ?", input.issuer, input.subject);
  if (existing && existing.user_id !== input.userId) throw new CommandError("forbidden", "this identity is already linked to another account");
  const now = toInstant(input.nowMs ?? Date.now());
  if (existing) {
    await prepare(db, stmt("UPDATE auth_identities SET unlinked_at = NULL, linked_at = ? WHERE issuer = ? AND subject = ?", now, input.issuer, input.subject)).run();
    return;
  }
  await prepare(db, stmt("INSERT INTO auth_identities (user_id, issuer, subject, display_email, linked_at) VALUES (?, ?, ?, ?, ?)", input.userId, input.issuer, input.subject, input.displayEmail ?? null, now)).run();
}

/** Unlinking an identity never deletes the wardrobe. */
export async function unlinkIdentity(db: Db, input: { userId: string; issuer: string; subject: string; nowMs?: number }): Promise<void> {
  await prepare(db, stmt("UPDATE auth_identities SET unlinked_at = ? WHERE user_id = ? AND issuer = ? AND subject = ?", toInstant(input.nowMs ?? Date.now()), input.userId, input.issuer, input.subject)).run();
}

/**
 * Map a VERIFIED (issuer, subject) to a principal. The caller must already have verified the signed
 * assertion or grant; this function never trusts an email, a header or a body field. Unknown or
 * unlinked subjects and disabled accounts are rejected.
 */
export async function resolvePrincipal(
  db: Db,
  verified: { issuer: string; subject: string },
  grant: { actor: Actor; channel: Channel; scopes: Scope[]; authRef: string },
): Promise<Principal> {
  const row = await first<{ user_id: string; status: string }>(
    db,
    "SELECT a.user_id, u.status FROM auth_identities a JOIN users u ON u.user_id = a.user_id WHERE a.issuer = ? AND a.subject = ? AND a.unlinked_at IS NULL",
    verified.issuer,
    verified.subject,
  );
  if (!row) throw new CommandError("forbidden", "unknown identity");
  if (row.status !== "active") throw new CommandError("forbidden", "this account is disabled");
  return createPrincipal({ userId: row.user_id, ...grant });
}

/** Principal for scheduled/background work under a durable job's verified owner; rechecks account status. */
export async function systemPrincipalFor(db: Db, userId: string, authRef: string, channel: Channel = "scheduled"): Promise<Principal> {
  const row = await first<{ status: string }>(db, "SELECT status FROM users WHERE user_id = ?", userId);
  if (!row) throw new CommandError("forbidden", "unknown owner");
  if (row.status !== "active") throw new CommandError("forbidden", "this account is disabled; scheduled effects are stopped");
  return createPrincipal({ userId, actor: "system", channel, scopes: ["read", "write"], authRef });
}

export async function setUserStatus(db: Db, userId: string, status: "active" | "disabled"): Promise<void> {
  await prepare(db, stmt("UPDATE users SET status = ? WHERE user_id = ?", status, userId)).run();
}

export async function getSettings(db: Db, principal: Principal): Promise<{ settings: OwnerSettings; version: number }> {
  assertPrincipal(principal);
  const row = await first<{ settings_json: string; version: number }>(db, "SELECT settings_json, version FROM owner_settings WHERE user_id = ?", principal.userId);
  if (!row) throw new CommandError("not_found", "no settings for this owner");
  return { settings: OwnerSettings.parse(deepMerge(DEFAULT_OWNER_SETTINGS, json(row.settings_json, {}))), version: row.version };
}

/* ------------------------------------------------------------------ */
/* Action intents (specification section 8, "Stable action identity")   */
/* ------------------------------------------------------------------ */

export interface ActionIntentInput {
  parentKind: "turn" | "job" | "workflow";
  parentId: string;
  operation: string;
  targets: string[];
  /** Normalized effect body (the command payload). */
  effect: Record<string, unknown>;
  expectedVersions?: Record<string, number>;
  nowMs?: number;
}

export interface ActionIntent {
  actionId: string;
  /** Derived from the action ID, never from a provider tool-call ID. Use as the command idempotency key. */
  idempotencyKey: string;
  state: "pending" | "committed" | "abandoned";
  /** Set when the effect was already committed: read this receipt instead of executing again. */
  commandId: string | null;
  /** True when the same parent + canonical effect had already been registered (a retry or resample). */
  existing: boolean;
}

/**
 * Register a proposed mutation before dispatching it. A recovered turn - or a resampled model that
 * proposes the same effect under a new tool-call ID - resolves to the same action and therefore the
 * same command: it cannot mint a second one.
 */
export async function registerActionIntent(db: Db, principal: Principal, input: ActionIntentInput): Promise<ActionIntent> {
  assertPrincipal(principal);
  const effectHash = await sha256Hex(canonicalJson({ operation: input.operation, targets: [...input.targets].sort(), effect: input.effect }));
  const find = () =>
    first<{ action_id: string; state: ActionIntent["state"]; command_id: string | null }>(
      db,
      "SELECT action_id, state, command_id FROM action_intents WHERE user_id = ? AND parent_kind = ? AND parent_id = ? AND effect_hash = ?",
      principal.userId,
      input.parentKind,
      input.parentId,
      effectHash,
    );
  const existing = await find();
  if (existing) return { actionId: existing.action_id, idempotencyKey: `action:${existing.action_id}`, state: existing.state, commandId: existing.command_id, existing: true };
  const actionId = newId("act");
  const now = toInstant(input.nowMs ?? Date.now());
  await prepare(
    db,
    stmt(
      `INSERT INTO action_intents (user_id, action_id, parent_kind, parent_id, operation, targets_json, effect_hash, effect_json, expected_versions_json, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT (user_id, parent_kind, parent_id, effect_hash) DO NOTHING`,
      principal.userId, actionId, input.parentKind, input.parentId, input.operation, JSON.stringify(input.targets), effectHash, JSON.stringify(input.effect), JSON.stringify(input.expectedVersions ?? {}), now, now,
    ),
  ).run();
  const row = (await find())!;
  return { actionId: row.action_id, idempotencyKey: `action:${row.action_id}`, state: row.state, commandId: row.command_id, existing: row.action_id !== actionId };
}

/** Pending intents of a parent turn/job, to reconcile against receipts before asking a model to continue. */
export async function pendingActionIntents(db: Db, principal: Principal, parentKind: string, parentId: string): Promise<{ actionId: string; operation: string; state: string; commandId: string | null; effect: Record<string, unknown> }[]> {
  assertPrincipal(principal);
  const rows = await all<{ action_id: string; operation: string; state: string; command_id: string | null; effect_json: string }>(
    db,
    "SELECT action_id, operation, state, command_id, effect_json FROM action_intents WHERE user_id = ? AND parent_kind = ? AND parent_id = ? ORDER BY created_at",
    principal.userId, parentKind, parentId,
  );
  return rows.map((r) => ({ actionId: r.action_id, operation: r.operation, state: r.state, commandId: r.command_id, effect: json(r.effect_json, {}) }));
}

/* ------------------------------------------------------------------ */
/* Effects and outbox                                                   */
/* ------------------------------------------------------------------ */

export interface EffectRecord {
  userId: string;
  effectId: string;
  commandId: string;
  kind: string;
  targetKey: string;
  operationKey: string;
  desiredRevision: number;
  payload: Record<string, unknown>;
  state: string;
  attempts: number;
}

/**
 * Claim due effects for delivery (scheduled sweep / Workflow step). A claim is a lease: a crashed
 * worker's claim expires and the effect is claimed again, so handlers must be idempotent on operationKey.
 * Effects of disabled accounts are never claimed.
 */
export async function claimDueEffects(db: Db, opts: { nowMs: number; kinds?: string[]; limit?: number; leaseMs?: number }): Promise<EffectRecord[]> {
  const now = toInstant(opts.nowMs);
  const lease = toInstant(opts.nowMs + (opts.leaseMs ?? 120_000));
  const kinds = opts.kinds ?? [];
  const kindFilter = kinds.length > 0 ? `AND e.kind IN (${kinds.map(() => "?").join(",")})` : "";
  const rows = await all<any>(
    db,
    `SELECT e.* FROM effects e JOIN users u ON u.user_id = e.user_id
      WHERE u.status = 'active' AND e.available_at <= ? AND (e.state = 'pending' OR (e.state = 'in_progress' AND e.claimed_until < ?)) ${kindFilter}
      ORDER BY e.available_at, e.effect_id LIMIT ?`,
    now, now, ...kinds, opts.limit ?? 20,
  );
  const claimed: EffectRecord[] = [];
  for (const r of rows) {
    const res = await prepare(
      db,
      stmt(
        "UPDATE effects SET state = 'in_progress', claimed_until = ?, attempts = attempts + 1, updated_at = ? WHERE user_id = ? AND effect_id = ? AND (state = 'pending' OR (state = 'in_progress' AND claimed_until < ?))",
        lease, now, r.user_id, r.effect_id, now,
      ),
    ).run();
    if ((res.meta?.changes ?? 0) === 1) {
      claimed.push({ userId: r.user_id, effectId: r.effect_id, commandId: r.command_id, kind: r.kind, targetKey: r.target_key, operationKey: r.operation_key, desiredRevision: r.desired_revision, payload: json(r.payload_json, {}), state: "in_progress", attempts: r.attempts + 1 });
    }
  }
  return claimed;
}

/**
 * Record an effect's outcome. `projected` must only be reported after a read-back verified the external
 * content. Marking a revision projected supersedes older pending effects for the same target, so a
 * delayed older write can never be delivered after a newer one.
 */
export async function settleEffect(
  db: Db,
  effect: Pick<EffectRecord, "userId" | "effectId">,
  outcome: { state: "projected" | "failed" | "superseded" | "cancelled" } | { state: "retry"; error: string; retryAtMs: number },
  nowMs: number,
): Promise<void> {
  const now = toInstant(nowMs);
  if (outcome.state === "retry") {
    await prepare(db, stmt("UPDATE effects SET state = 'pending', last_error = ?, available_at = ?, claimed_until = NULL, updated_at = ? WHERE user_id = ? AND effect_id = ?", outcome.error.slice(0, 500), toInstant(outcome.retryAtMs), now, effect.userId, effect.effectId)).run();
    return;
  }
  const row = await first<{ kind: string; target_key: string; desired_revision: number }>(db, "SELECT kind, target_key, desired_revision FROM effects WHERE user_id = ? AND effect_id = ?", effect.userId, effect.effectId);
  if (!row) return;
  const statements = [stmt("UPDATE effects SET state = ?, claimed_until = NULL, updated_at = ? WHERE user_id = ? AND effect_id = ?", outcome.state, now, effect.userId, effect.effectId)];
  if (outcome.state === "projected") {
    statements.push(
      stmt(
        "UPDATE effects SET state = 'superseded', updated_at = ? WHERE user_id = ? AND kind = ? AND target_key = ? AND desired_revision < ? AND state IN ('pending', 'in_progress', 'failed')",
        now, effect.userId, row.kind, row.target_key, row.desired_revision,
      ),
    );
  }
  await db.batch(statements.map((s) => prepare(db, s)));
}

/** The newest desired revision for a target: a projector skips any effect older than this. */
export async function latestDesiredRevision(db: Db, userId: string, kind: string, targetKey: string): Promise<number | null> {
  const row = await first<{ rev: number | null }>(db, "SELECT MAX(desired_revision) AS rev FROM effects WHERE user_id = ? AND kind = ? AND target_key = ? AND state != 'cancelled'", userId, kind, targetKey);
  return row?.rev ?? null;
}

export async function effectsForCommand(db: Db, principal: Principal, commandId: string): Promise<{ effectId: string; kind: string; state: string }[]> {
  assertPrincipal(principal);
  const rows = await all<{ effect_id: string; kind: string; state: string }>(db, "SELECT effect_id, kind, state FROM effects WHERE user_id = ? AND command_id = ? ORDER BY effect_id", principal.userId, commandId);
  return rows.map((r) => ({ effectId: r.effect_id, kind: r.kind, state: r.state }));
}

export interface OutboxEntry {
  seq: number;
  userId: string;
  topic: string;
  entityKind: string;
  entityId: string;
  revision: number;
  payload: Record<string, unknown>;
}

/** Read projection work after a cursor. Entries carry IDs and revisions only. */
export async function readOutbox(db: Db, opts: { afterSeq?: number; topics?: string[]; limit?: number }): Promise<OutboxEntry[]> {
  const topics = opts.topics ?? [];
  const filter = topics.length > 0 ? `AND topic IN (${topics.map(() => "?").join(",")})` : "";
  const rows = await all<any>(db, `SELECT * FROM outbox WHERE seq > ? AND state != 'acknowledged' ${filter} ORDER BY seq LIMIT ?`, opts.afterSeq ?? 0, ...topics, opts.limit ?? 100);
  return rows.map((r) => ({ seq: r.seq, userId: r.user_id, topic: r.topic, entityKind: r.entity_kind, entityId: r.entity_id, revision: r.revision, payload: json(r.payload_json, {}) }));
}

/** Acknowledge only after the receiving store has durably accepted the deduplicated reference. */
export async function acknowledgeOutbox(db: Db, seqs: number[], nowMs: number): Promise<void> {
  const now = toInstant(nowMs);
  for (let i = 0; i < seqs.length; i += 50) {
    const part = seqs.slice(i, i + 50);
    await prepare(db, stmt(`UPDATE outbox SET state = 'acknowledged', updated_at = ? WHERE seq IN (${part.map(() => "?").join(",")})`, now, ...part)).run();
  }
}
