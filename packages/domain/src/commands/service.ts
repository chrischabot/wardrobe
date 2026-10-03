import { CommandEnvelope, CONTRACT_VERSION, DEFAULT_OWNER_SETTINGS, EffectState, OwnerSettings } from "@garderobe/contracts";
import type { CommandReceipt, EntityVersion, ParsedCommandEnvelope } from "@garderobe/contracts";
import { all, allIn, first, json, prepare, stmt, type Db, type Stmt } from "../db.ts";
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

interface ReceiptRow {
  command_id: string;
  receipt_json: string;
  undone_by_command_id: string | null;
}

const PRECONDITION_MARKERS = ["garderobe_precondition_failed", "CHECK constraint failed: ok = 1"];
const EFFECT_KEY_MARKERS = ["effects.user_id, effects.operation_key"];

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
 *   5. on a concurrent commit re-plans from fresh state. For wear, wash and laundry reports stale client
 *      versions are rebased silently; for every other command a stale client version is a clean `conflict`
 *      (see `CommandDefinition.staleVersions`);
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
    this.maxAttempts = options.maxAttempts ?? 12;
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
    if (existing) return await this.replay(existing, requestHash, principal.userId);

    let lastConflict: string | null = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      // Commands for one owner serialise on a revision. After a lost race, wait a little (more each time,
      // with jitter) so a burst of simultaneous commands drains instead of colliding again in step.
      if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, Math.min(250, 5 * attempt + Math.random() * 15 * attempt)));
      // A retry of this same request may have committed while this one was planning or waiting.
      if (attempt > 1) {
        const landed = await this.findByIdempotencyKey(principal.userId, envelope.idempotencyKey);
        if (landed) return await this.replay(landed, requestHash, principal.userId);
      }
      const ctx = await this.buildContext(principal, envelope);
      const plan = await def.plan(ctx, parsedPayload.data);
      const changes: DomainChanges = { ...noChanges(), ...(plan.changes ?? {}) };
      const fragments: PlanFragment[] = [];
      for (const { hook } of this.registry.commitHooks()) {
        const fragment = await hook(ctx, plan, changes);
        if (fragment) fragments.push(fragment);
      }
      const result = await this.commit(ctx, this.registry.staleVersionPolicy(def), plan, fragments, requestHash);
      if (result.kind !== "retry") return result.receipt;
      lastConflict = result.label;
      // result.kind === "retry": a concurrent commit changed something this plan read; re-plan from fresh state.
    }
    throw new CommandError("internal", "the command could not be committed after repeated concurrent changes; nothing was written. It is safe to send it again with the same idempotency key", { lastConflict, retryable: true });
  }

  /**
   * The receipt of a command. What was recorded is stored once and never recomputed; the two things that
   * change after the commit are read from their own records: the state of its external effects and
   * whether it has since been undone (see `current`).
   */
  async getReceipt(principal: Principal, commandId: string): Promise<CommandReceipt | null> {
    assertPrincipal(principal);
    requireScope(principal, "read");
    const row = await first<ReceiptRow>(this.db, "SELECT command_id, receipt_json, undone_by_command_id FROM commands WHERE user_id = ? AND command_id = ?", principal.userId, commandId);
    return row ? (await this.current(principal.userId, [row]))[0]! : null;
  }

  /** Receipts touching an entity (item history) or the most recent receipts, newest first. */
  async listReceipts(principal: Principal, filter: { kind?: string; entityId?: string; limit?: number } = {}): Promise<CommandReceipt[]> {
    assertPrincipal(principal);
    requireScope(principal, "read");
    const limit = Math.min(filter.limit ?? 50, 200);
    const rows =
      filter.kind && filter.entityId
        ? await all<ReceiptRow>(
            this.db,
            "SELECT c.command_id, c.receipt_json, c.undone_by_command_id FROM commands c JOIN command_entities e ON e.user_id = c.user_id AND e.command_id = c.command_id WHERE c.user_id = ? AND e.kind = ? AND e.entity_id = ? ORDER BY julianday(c.recorded_at) DESC, c.rowid DESC LIMIT ?",
            principal.userId,
            filter.kind,
            filter.entityId,
            limit,
          )
        // Instants are stored with or without milliseconds, so they are ordered as instants, not as text;
        // commands recorded in the same instant keep their commit order.
        : await all<ReceiptRow>(this.db, "SELECT command_id, receipt_json, undone_by_command_id FROM commands WHERE user_id = ? ORDER BY julianday(recorded_at) DESC, rowid DESC LIMIT ?", principal.userId, limit);
    return this.current(principal.userId, rows);
  }

  /**
   * Stored receipts as they read now. A receipt is written in the same batch as the command, when every
   * external effect it enqueued is still pending and its undo has not been used; both move on afterwards.
   * Reading them back from the commit-time text would tell the owner for ever that a Calendar update is
   * pending after it was delivered and verified, and offer an undo that was already used (specification
   * section 8: the receipt "distinguishes any pending synchronization or projection"). Everything else in
   * the receipt is exactly what was stored.
   */
  private async current(userId: string, rows: ReceiptRow[]): Promise<CommandReceipt[]> {
    const receipts = rows.map((r) => JSON.parse(r.receipt_json) as CommandReceipt);
    const withEffects = receipts.filter((r) => (r.effects?.length ?? 0) > 0).map((r) => r.commandId);
    const states = new Map<string, string>();
    for (const e of await allIn<{ effect_id: string; state: string }>(this.db, "SELECT effect_id, state FROM effects WHERE user_id = ? AND command_id IN (:ids)", [userId], withEffects)) {
      states.set(e.effect_id, e.state);
    }
    return receipts.map((receipt, i) => {
      const out: CommandReceipt = { ...receipt };
      if ((receipt.effects?.length ?? 0) > 0) {
        // An effect row holding a state this build does not know keeps the state the receipt was stored with,
        // and says so in the log: a receipt must not read as waiting for ever without a trace of why.
        out.effects = receipt.effects.map((e) => {
          const stored = states.get(e.effectId);
          const now = EffectState.safeParse(stored);
          if (stored !== undefined && !now.success) console.warn(`effect ${e.effectId} of command ${receipt.commandId} holds an unknown state; the receipt shows the state it was stored with`);
          return { ...e, state: now.success ? now.data : e.state };
        });
        // A failed effect has not been delivered: it still counts as outstanding, and its own state says "failed".
        const outstanding = out.effects.some((e) => e.state === "pending" || e.state === "in_progress" || e.state === "failed");
        // A superseded effect was overtaken by a newer revision of the same target, which carries the content.
        const delivered = out.effects.some((e) => e.state === "projected" || e.state === "superseded");
        out.externalEffectState = outstanding ? "projection_pending" : delivered ? "projected" : "none";
      }
      if (rows[i]!.undone_by_command_id && receipt.undo?.available) out.undo = { available: false, reason: "this action was already undone" };
      return out;
    });
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

  private async replay(row: CommandRow, requestHash: string, userId: string): Promise<CommandReceipt> {
    if (row.request_hash !== requestHash) {
      throw new CommandError("idempotency_key_reuse", "this idempotency key was already used with a different request body", { commandId: row.command_id });
    }
    // The repeat is answered with the receipt as it reads now, like any other read of it.
    return { ...(await this.current(userId, [row]))[0]!, replayed: true };
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
      verifyOwnerStatement: async (ref: string) => {
        const verifier = this.registry.ownerStatementVerifier();
        return verifier ? (await verifier(ctx, ref)) === true : false;
      },
      entityName: async (kind: string, id: string) => {
        // A name is cosmetic: a lane's lookup that fails must not fail the command, only leave the generic wording.
        try {
          const namer = this.registry.entityNamer(kind);
          const name = namer ? await namer(db, userId, id) : null;
          return typeof name === "string" && name.trim() !== "" ? name : null;
        } catch (error) {
          console.warn(`entity namer for '${kind}' failed for ${id} in command ${commandId}; the receipt uses the generic wording: ${error instanceof Error ? error.message : "unknown error"}`);
          return null;
        }
      },
      checkEntity: async (kind: string, id: string) => {
        const check = this.registry.entityCheck(kind);
        if (!check) return { ok: true as const };
        // Unlike a name, this decides whether the command may write: a check that cannot answer refuses.
        try {
          const answer = await check(db, userId, id);
          return answer.ok === true ? { ok: true as const } : { ok: false as const, reason: typeof answer.reason === "string" && answer.reason.trim() !== "" ? answer.reason : "it could not be confirmed" };
        } catch (error) {
          console.warn(`entity check for '${kind}' failed for ${id} in command ${commandId}; the command is refused: ${error instanceof Error ? error.message : "unknown error"}`);
          return { ok: false as const, reason: "it could not be checked just now" };
        }
      },
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
    staleVersions: "rebase" | "conflict",
    plan: CommandPlan,
    fragments: PlanFragment[],
    requestHash: string,
  ): Promise<{ kind: "committed" | "replayed"; receipt: CommandReceipt } | { kind: "retry"; label: string }> {
    const { userId, commandId, envelope } = ctx;
    const outcome = plan.outcome ?? "committed";
    const bumpWardrobe = plan.bumpWardrobe ?? false;
    const bumpStyle = plan.bumpStyle ?? false;

    // A wear or wash report is never rejected over a stale client version: it is rebased (section 5).
    // Every other command checks the versions the client stated, inside the same batch as its writes.
    const clientPre = staleVersions === "rebase" ? [] : this.clientPreconditions(ctx);
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
    // An external operation is enqueued once: a repeated operation key (a re-run of the same projection)
    // adds no second effect, and the receipt lists only the effects this command really created.
    const plannedEffects = [...(plan.effects ?? []), ...fragments.flatMap((f) => f.effects ?? [])];
    const knownKeys = new Set(
      (await allIn<{ operation_key: string }>(this.db, "SELECT operation_key FROM effects WHERE user_id = ? AND operation_key IN (:ids)", [userId], [...new Set(plannedEffects.map((e) => e.operationKey))])).map((r) => r.operation_key),
    );
    const effects: (PlannedEffect & { effectId: string })[] = [];
    for (const e of plannedEffects) {
      if (knownKeys.has(e.operationKey)) continue;
      knownKeys.add(e.operationKey);
      effects.push({ ...e, effectId: newId("eff") });
    }
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
      // Whatever made the batch fail, a retry of this same request that committed first is the answer:
      // the caller gets the stored receipt, never an error about a change its own request made.
      const landed = await this.findByIdempotencyKey(userId, envelope.idempotencyKey);
      if (landed) return { kind: "replayed", receipt: await this.replay(landed, requestHash, userId) };
      if (EFFECT_KEY_MARKERS.some((m) => text.includes(m))) return { kind: "retry", label: "an effect with the same operation key was enqueued concurrently" };
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
