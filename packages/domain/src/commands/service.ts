import { CommandEnvelope, CONTRACT_VERSION, DEFAULT_OWNER_SETTINGS, OwnerSettings } from "@garderobe/contracts";
import type { CommandReceipt, EntityVersion, ParsedCommandEnvelope } from "@garderobe/contracts";
import { all, first, json, prepare, stmt, type Db, type Stmt } from "../db.ts";
import { CommandError, isCommandError } from "../errors.ts";
import { assertPrincipal, requireScope, type Principal } from "../principal.ts";
import { StockPlanner } from "../stock/planner.ts";
import { canonicalJson, deepMerge, newId, parseInstant, sha256Hex, toInstant } from "../util.ts";
import type { CommandRegistry } from "./registry.ts";
import { noChanges, type CommandContext, type CommandPlan, type DomainChanges, type PlanFragment, type PlannedEffect, type PlannedOutbox, type Precondition, type StoredCommand } from "./types.ts";

export interface CommandServiceOptions {
  db: Db;
  registry: CommandRegistry;
  /** Injectable clock (ms since epoch) for deterministic tests. */
  clock?: () => number;
  /** Maximum internal re-plans after a concurrent commit before giving up. */
  maxAttempts?: number;
}

interface CommandRow {
  command_id: string;
  type: string;
  request_hash: string;
  payload_json: string;
  receipt_json: string;
  undo_json: string | null;
  occurred_at: string;
  recorded_at: string;
  undone_by_command_id: string | null;
  undoes_command_id: string | null;
}

const PRECONDITION_MARKERS = ["garderobe_precondition_failed", "CHECK constraint failed: ok = 1"];
const IDEMPOTENCY_MARKERS = ["garderobe_idempotency_key_unique", "commands.user_id, commands.idempotency_key"];

function errorText(e: unknown): string {
  const parts: string[] = [];
  let cur: any = e;
  for (let i = 0; i < 4 && cur; i++) {
    parts.push(String(cur.message ?? cur));
    cur = cur.cause;
  }
  return parts.join(" | ");
}

/**
 * The single command service. Every mutation from every channel (native app, web, MCP, conversation
 * tools, scheduled jobs, the importer) goes through `execute`, which:
 *
 *   1. validates the envelope and the typed payload, the principal's scope and the authorization basis;
 *   2. enforces idempotency: same key + same body returns the stored receipt, a different body is an error;
 *   3. asks the handler for a plan (reads happen here, outside the transaction);
 *   4. commits precondition rows, the command row with its receipt, the domain writes, commit-hook writes,
 *      effect and outbox rows in ONE D1 batch. The first statements insert CHECK-constrained precondition
 *      rows, so any stale version or failed quantity predicate raises a real SQLite error and the whole
 *      batch rolls back: no orphan receipt, no partial mutation, no external effect;
 *   5. on a concurrent commit re-plans from fresh state. For owner observations stale client versions are
 *      rebased silently; for plan edits a stale client version is a clean `conflict`;
 *   6. reads the stored receipt back and returns it.
 */
export class CommandService {
  private readonly db: Db;
  readonly registry: CommandRegistry;
  private readonly clock: () => number;
  private readonly maxAttempts: number;

  constructor(options: CommandServiceOptions) {
    this.db = options.db;
    this.registry = options.registry;
    this.clock = options.clock ?? (() => Date.now());
    this.maxAttempts = options.maxAttempts ?? 6;
  }

  async execute(principal: Principal, input: CommandEnvelope | Record<string, unknown>): Promise<CommandReceipt> {
    assertPrincipal(principal);
    const parsedEnvelope = CommandEnvelope.safeParse(input);
    if (!parsedEnvelope.success) {
      throw new CommandError("invalid_command", "the command envelope is invalid", { issues: parsedEnvelope.error.issues });
    }
    const envelope = parsedEnvelope.data;
    const def = this.registry.get(envelope.type);
    requireScope(principal, def.requiredScope);
    this.checkAuthorization(principal, envelope, this.registry.allowedAuthorizations(def));

    const parsedPayload = def.schema.safeParse(envelope.payload);
    if (!parsedPayload.success) {
      throw new CommandError("invalid_command", `invalid payload for '${envelope.type}'`, { issues: parsedPayload.error.issues });
    }
    const requestHash = await sha256Hex(
      canonicalJson({ type: envelope.type, payload: envelope.payload, expectedVersions: envelope.expectedVersions, occurredAt: envelope.occurredAt ?? null, authorization: envelope.authorization }),
    );

    const existing = await this.findByIdempotencyKey(principal.userId, envelope.idempotencyKey);
    if (existing) return this.replay(existing, requestHash);

    let lastConflict: string | null = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const ctx = await this.buildContext(principal, envelope);
      const plan = await def.plan(ctx, parsedPayload.data);
      const changes: DomainChanges = { ...noChanges(), ...(plan.changes ?? {}) };
      const fragments: PlanFragment[] = [];
      for (const { hook } of this.registry.commitHooks()) {
        const fragment = await hook(ctx, plan, changes);
        if (fragment) fragments.push(fragment);
      }
      const result = await this.commit(ctx, def.class, plan, fragments, requestHash);
      if (result.kind !== "retry") return result.receipt;
      lastConflict = result.label;
      // result.kind === "retry": a concurrent commit changed something this plan read; re-plan from fresh state.
    }
    throw new CommandError("internal", "the command could not be committed after repeated concurrent changes; nothing was written", { lastConflict });
  }

  /** The stored receipt of a command (never recomputed). */
  async getReceipt(principal: Principal, commandId: string): Promise<CommandReceipt | null> {
    assertPrincipal(principal);
    requireScope(principal, "read");
    const row = await first<{ receipt_json: string }>(this.db, "SELECT receipt_json FROM commands WHERE user_id = ? AND command_id = ?", principal.userId, commandId);
    return row ? (JSON.parse(row.receipt_json) as CommandReceipt) : null;
  }

  /** Receipts touching an entity (item history) or the most recent receipts, newest first. */
  async listReceipts(principal: Principal, filter: { kind?: string; entityId?: string; limit?: number } = {}): Promise<CommandReceipt[]> {
    assertPrincipal(principal);
    requireScope(principal, "read");
    const limit = Math.min(filter.limit ?? 50, 200);
    const rows =
      filter.kind && filter.entityId
        ? await all<{ receipt_json: string }>(
            this.db,
            "SELECT c.receipt_json FROM commands c JOIN command_entities e ON e.user_id = c.user_id AND e.command_id = c.command_id WHERE c.user_id = ? AND e.kind = ? AND e.entity_id = ? ORDER BY c.recorded_at DESC, c.command_id DESC LIMIT ?",
            principal.userId,
            filter.kind,
            filter.entityId,
            limit,
          )
        : await all<{ receipt_json: string }>(this.db, "SELECT receipt_json FROM commands WHERE user_id = ? ORDER BY recorded_at DESC, command_id DESC LIMIT ?", principal.userId, limit);
    return rows.map((r) => JSON.parse(r.receipt_json) as CommandReceipt);
  }

  async loadStoredCommand(userId: string, commandId: string): Promise<StoredCommand | null> {
    const row = await first<CommandRow>(
      this.db,
      "SELECT command_id, type, request_hash, payload_json, receipt_json, undo_json, occurred_at, recorded_at, undone_by_command_id, undoes_command_id FROM commands WHERE user_id = ? AND command_id = ?",
      userId,
      commandId,
    );
    if (!row) return null;
    return {
      commandId: row.command_id,
      type: row.type,
      payload: json(row.payload_json, {}),
      occurredAt: row.occurred_at,
      recordedAt: row.recorded_at,
      undo: json(row.undo_json, null),
      undoneByCommandId: row.undone_by_command_id,
      undoesCommandId: row.undoes_command_id,
    };
  }

  /* ------------------------------------------------------------------ */

  private checkAuthorization(principal: Principal, envelope: ParsedCommandEnvelope, allowed: string[]): void {
    const basis = envelope.authorization;
    if (!allowed.includes(basis)) {
      throw new CommandError("forbidden", `'${envelope.type}' cannot be authorized by '${basis}'`, { allowed });
    }
    const actorOk =
      (basis === "owner_tap" && principal.actor === "owner") ||
      (basis === "owner_statement" && (principal.actor === "owner" || principal.actor === "assistant")) ||
      ((basis === "standing_policy" || basis === "system_schedule") && (principal.actor === "system" || principal.actor === "owner")) ||
      (basis === "data_import" && principal.scopes.includes("admin"));
    if (!actorOk) {
      throw new CommandError("forbidden", `authorization '${basis}' is not available to actor '${principal.actor}'`, { actor: principal.actor });
    }
    if (envelope.source.channel !== principal.channel) {
      throw new CommandError("forbidden", "the command's channel does not match the authenticated connection", { expected: principal.channel });
    }
  }

  private async findByIdempotencyKey(userId: string, key: string): Promise<CommandRow | null> {
    return first<CommandRow>(
      this.db,
      "SELECT command_id, type, request_hash, payload_json, receipt_json, undo_json, occurred_at, recorded_at, undone_by_command_id, undoes_command_id FROM commands WHERE user_id = ? AND idempotency_key = ?",
      userId,
      key,
    );
  }

  private replay(row: CommandRow, requestHash: string): CommandReceipt {
    if (row.request_hash !== requestHash) {
      throw new CommandError("idempotency_key_reuse", "this idempotency key was already used with a different request body", { commandId: row.command_id });
    }
    return { ...(JSON.parse(row.receipt_json) as CommandReceipt), replayed: true };
  }

  private async buildContext(principal: Principal, envelope: ParsedCommandEnvelope): Promise<CommandContext> {
    const userId = principal.userId;
    const owner = await first<{ status: string; wardrobe_revision: number | null; style_revision: number | null; settings_json: string | null; settings_version: number | null }>(
      this.db,
      `SELECT u.status, s.wardrobe_revision, s.style_revision, o.settings_json, o.version AS settings_version
         FROM users u LEFT JOIN owner_state s ON s.user_id = u.user_id LEFT JOIN owner_settings o ON o.user_id = u.user_id
        WHERE u.user_id = ?`,
      userId,
    );
    if (!owner) throw new CommandError("forbidden", "unknown owner");
    if (owner.status !== "active") throw new CommandError("forbidden", "this account is disabled");
    const nowMs = this.clock();
    const now = toInstant(nowMs);
    const occurredAt = envelope.occurredAt ?? now;
    const occurredAtMs = parseInstant(occurredAt);
    if (occurredAtMs > nowMs + 5 * 60_000) {
      throw new CommandError("invalid_command", "occurredAt is in the future; an observation cannot be reported before it happens");
    }
    const commandId = newId("cmd");
    const db = this.db;
    const settings = OwnerSettings.parse(deepMerge(DEFAULT_OWNER_SETTINGS, json(owner.settings_json, {})));
    const ctx: CommandContext = {
      db,
      principal,
      userId,
      commandId,
      now,
      nowMs,
      occurredAt,
      occurredAtMs,
      occurredAtExplicit: envelope.occurredAt !== undefined,
      envelope,
      settings,
      settingsVersion: owner.settings_version ?? 0,
      wardrobeRevision: owner.wardrobe_revision ?? 0,
      styleRevision: owner.style_revision ?? 0,
      newId,
      stock: () => new StockPlanner(db, userId, commandId, now, newId),
    };
    return ctx;
  }

  private clientPreconditions(ctx: CommandContext): Precondition[] {
    const out: Precondition[] = [];
    for (const [key, version] of Object.entries(ctx.envelope.expectedVersions)) {
      const sep = key.indexOf(":");
      const kind = sep === -1 ? key : key.slice(0, sep);
      const id = sep === -1 ? "" : key.slice(sep + 1);
      const resolver = this.registry.versionResolver(kind);
      if (!resolver) throw new CommandError("invalid_command", `unknown expected-version kind '${kind}'`, { key });
      const { sql, params } = resolver(ctx.userId, id);
      out.push({ label: `expected ${key} = ${version}`, sql: `(${sql}) = ?`, params: [...params, version], class: "client" });
    }
    return out;
  }

  private async commit(
    ctx: CommandContext,
    cls: "observation" | "edit" | "system",
    plan: CommandPlan,
    fragments: PlanFragment[],
    requestHash: string,
  ): Promise<{ kind: "committed" | "replayed"; receipt: CommandReceipt } | { kind: "retry"; label: string }> {
    const { userId, commandId, envelope } = ctx;
    const outcome = plan.outcome ?? "committed";
    const bumpWardrobe = plan.bumpWardrobe ?? false;
    const bumpStyle = plan.bumpStyle ?? false;

    // Owner observations are never rejected over a stale client version: they are rebased (section 5).
    const clientPre = cls === "observation" ? [] : this.clientPreconditions(ctx);
    const preconditions: Precondition[] = [
      { label: "owner active", sql: "(SELECT status FROM users WHERE user_id = ?) = 'active'", params: [userId], class: "state" },
      ...clientPre,
      ...(plan.preconditions ?? []),
      ...fragments.flatMap((f) => f.preconditions ?? []),
    ];
    if (bumpWardrobe) {
      preconditions.push({
        label: "wardrobe revision unchanged since read",
        sql: "(SELECT wardrobe_revision FROM owner_state WHERE user_id = ?) = ?",
        params: [userId, ctx.wardrobeRevision],
        class: "internal",
      });
    }
    if (bumpStyle) {
      preconditions.push({
        label: "style revision unchanged since read",
        sql: "(SELECT style_revision FROM owner_state WHERE user_id = ?) = ?",
        params: [userId, ctx.styleRevision],
        class: "internal",
      });
    }

    const affected = dedupeAffected([...(plan.affected ?? []), ...fragments.flatMap((f) => f.affected ?? [])]);
    const effects: (PlannedEffect & { effectId: string })[] = [...(plan.effects ?? []), ...fragments.flatMap((f) => f.effects ?? [])].map((e) => ({ ...e, effectId: newId("eff") }));
    const outbox: PlannedOutbox[] = [...(plan.outbox ?? []), ...fragments.flatMap((f) => f.outbox ?? [])];
    const wardrobeRevision = ctx.wardrobeRevision + (bumpWardrobe ? 1 : 0);

    const receipt: CommandReceipt = {
      commandId,
      type: envelope.type,
      outcome,
      summary: plan.summary,
      affected,
      externalEffectState: effects.length > 0 ? "projection_pending" : "none",
      effects: effects.map((e) => ({ effectId: e.effectId, kind: e.kind, state: "pending" as const })),
      undo: plan.undo && "data" in plan.undo ? { available: true, reason: null } : { available: false, reason: plan.undo?.unavailableReason ?? "this action has no automatic undo" },
      repairs: [...(plan.repairs ?? []), ...fragments.flatMap((f) => f.repairs ?? [])],
      result: Object.assign({}, plan.result ?? {}, ...fragments.map((f) => f.result ?? {})),
      occurredAt: ctx.occurredAt,
      recordedAt: ctx.now,
      wardrobeRevision,
      replayed: false,
      actor: ctx.principal.actor,
      channel: ctx.principal.channel,
      contractVersion: CONTRACT_VERSION,
    };

    const batch: Stmt[] = [];
    for (const p of preconditions) {
      batch.push(stmt(`INSERT INTO command_preconditions (command_id, label, ok) SELECT ?, ?, CASE WHEN (${p.sql}) THEN 1 ELSE 0 END`, commandId, p.label.slice(0, 200), ...p.params));
    }
    batch.push(
      stmt(
        `INSERT INTO commands (user_id, command_id, idempotency_key, type, request_hash, payload_json, channel, actor, authorization_basis, source_json,
                               occurred_at, recorded_at, outcome, receipt_json, undo_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        userId,
        commandId,
        envelope.idempotencyKey,
        envelope.type,
        requestHash,
        JSON.stringify(envelope.payload),
        ctx.principal.channel,
        ctx.principal.actor,
        envelope.authorization,
        JSON.stringify({ ...envelope.source, authRef: ctx.principal.authRef }),
        ctx.occurredAt,
        ctx.now,
        outcome,
        JSON.stringify(receipt),
        plan.undo ? JSON.stringify(plan.undo) : null,
      ),
    );
    batch.push(...(plan.statements ?? []));
    for (const f of fragments) batch.push(...(f.statements ?? []));
    for (const a of affected) {
      batch.push(stmt("INSERT INTO command_entities (user_id, command_id, kind, entity_id, version) VALUES (?, ?, ?, ?, ?)", userId, commandId, a.kind, a.id, a.version));
    }
    for (const e of effects) {
      batch.push(
        stmt(
          `INSERT INTO effects (user_id, effect_id, command_id, kind, target_key, operation_key, desired_revision, payload_json, state, available_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
          userId,
          e.effectId,
          commandId,
          e.kind,
          e.targetKey,
          e.operationKey,
          e.desiredRevision ?? 0,
          JSON.stringify(e.payload),
          e.availableAt ?? ctx.now,
          ctx.now,
          ctx.now,
        ),
      );
    }
    for (const o of outbox) {
      batch.push(
        stmt(
          "INSERT INTO outbox (user_id, topic, entity_kind, entity_id, revision, payload_json, command_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
          userId,
          o.topic,
          o.entityKind,
          o.entityId,
          o.revision,
          JSON.stringify(o.payload ?? {}),
          commandId,
          ctx.now,
          ctx.now,
        ),
      );
    }
    if (bumpWardrobe || bumpStyle) {
      batch.push(
        stmt("UPDATE owner_state SET wardrobe_revision = wardrobe_revision + ?, style_revision = style_revision + ? WHERE user_id = ?", bumpWardrobe ? 1 : 0, bumpStyle ? 1 : 0, userId),
      );
    }
    if (envelope.source.actionId) {
      batch.push(
        stmt("UPDATE action_intents SET state = 'committed', command_id = ?, updated_at = ? WHERE user_id = ? AND action_id = ?", commandId, ctx.now, userId, envelope.source.actionId),
      );
    }
    batch.push(stmt("DELETE FROM command_preconditions WHERE command_id = ?", commandId));

    try {
      await this.db.batch(batch.map((s) => prepare(this.db, s)));
    } catch (e) {
      if (isCommandError(e)) throw e;
      const text = errorText(e);
      if (IDEMPOTENCY_MARKERS.some((m) => text.includes(m))) {
        const row = await this.findByIdempotencyKey(userId, envelope.idempotencyKey);
        if (row) return { kind: "replayed", receipt: this.replay(row, requestHash) };
      }
      if (PRECONDITION_MARKERS.some((m) => text.includes(m))) {
        const failed = await this.findFailedPrecondition(preconditions);
        if (!failed) return { kind: "retry", label: "transient precondition failure" };
        if (failed.class === "client") {
          throw new CommandError("conflict", "this was changed elsewhere since you last saw it; nothing was written", { failed: failed.label });
        }
        if (failed.class === "state") {
          throw new CommandError("precondition_failed", `the change cannot be applied: ${failed.label}; nothing was written`, { failed: failed.label });
        }
        return { kind: "retry", label: failed.label };
      }
      throw new CommandError("internal", "the command failed and nothing was written", { cause: text.slice(0, 500) });
    }

    // Read the committed receipt back: the response is what the ledger holds, not what was intended.
    const stored = await first<{ receipt_json: string }>(this.db, "SELECT receipt_json FROM commands WHERE user_id = ? AND command_id = ?", userId, commandId);
    if (!stored) throw new CommandError("internal", "the command batch reported success but its receipt is missing");
    return { kind: "committed", receipt: JSON.parse(stored.receipt_json) as CommandReceipt };
  }

  private async findFailedPrecondition(preconditions: Precondition[]): Promise<Precondition | null> {
    // Report client conflicts before internal version races, and those before state predicates.
    const order = { client: 0, state: 1, internal: 2 } as const;
    for (const p of [...preconditions].sort((a, b) => order[a.class] - order[b.class])) {
      const row = await first<{ ok: number }>(this.db, `SELECT CASE WHEN (${p.sql}) THEN 1 ELSE 0 END AS ok`, ...p.params);
      if (!row || row.ok !== 1) return p;
    }
    return null;
  }
}

function dedupeAffected(list: EntityVersion[]): EntityVersion[] {
  const map = new Map<string, EntityVersion>();
  for (const a of list) {
    const key = `${a.kind}:${a.id}`;
    const prev = map.get(key);
    if (!prev || prev.version < a.version) map.set(key, a);
  }
  return [...map.values()];
}
