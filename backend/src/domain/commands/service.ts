import {
  COMMAND_CLASS,
  CONTRACTS_VERSION,
  CommandEnvelope,
  type CommandEffect,
  type CommandReceipt,
  type CommandType,
  type DomainCommand,
} from '@garderobe/contracts';
import { isPreconditionFailure, isUniqueViolation, isVersionedEntity, json, parseJson, preconditionCleanup, preconditionStatement, readVersion, versionIs, type Predicate } from '../db.js';
import { DomainError } from '../errors.js';
import { canonicalJson, sha256Hex } from '../hash.js';
import { newId } from '../ids.js';
import { assertPrincipal, findForgedOwnerFields, hasScope, SCOPE_WRITE, type Principal } from '../principal.js';
import { HANDLERS } from './handlers.js';
import type { CommandPlan, HandlerContext } from './types.js';

export interface CommandServiceOptions {
  /** Clock injection for tests and replays. */
  now?: () => string;
  /** Bounded retries after a precondition race (observations rebase and retry). */
  maxAttempts?: number;
  /** Test hook: extra statements appended after the domain writes (e.g. a forced late failure). */
  afterStatements?: (db: D1Database) => D1PreparedStatement[];
}

interface ReceiptRow {
  command_id: string;
  request_hash: string;
  receipt_json: string;
  undo_json: string | null;
  undone_by_command_id: string | null;
}

/**
 * The domain command service (spec section 8). Callable without any model: typed command in,
 * verified receipt out.
 *
 * Guarantees
 *  - The owner comes only from the authenticated principal; bodies with owner fields are rejected.
 *  - Same idempotency key + same body returns the stored receipt; same key + different body is an error.
 *  - Domain writes, receipt, affected-entity index and outbox effects commit in one D1 batch whose first
 *    statement is a CHECK-constrained precondition; any failure rolls back everything.
 *  - Edit commands with stale expected versions return a `conflict` receipt; owner observations are
 *    accepted and rebased internally (`rebased: true`).
 *  - Undo is a compensating command; receipts are never deleted (a trigger forbids it).
 */
export class CommandService {
  private readonly now: () => string;
  private readonly maxAttempts: number;

  constructor(
    private readonly db: D1Database,
    private readonly principal: Principal,
    private readonly options: CommandServiceOptions = {},
  ) {
    assertPrincipal(principal);
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxAttempts = options.maxAttempts ?? 8;
  }

  async execute(input: unknown): Promise<CommandReceipt> {
    const commandId = newId('cmd');
    const raw = (input ?? {}) as Record<string, unknown>;
    const rawKey = typeof raw.idempotencyKey === 'string' ? raw.idempotencyKey : '';
    const rawType = typeof (raw.command as Record<string, unknown> | undefined)?.type === 'string' ? ((raw.command as Record<string, unknown>).type as string) : 'unknown';
    const reject = (code: string, message: string, details?: Record<string, unknown>, outcome: 'rejected' | 'conflict' = 'rejected') =>
      this.unpersistedReceipt(commandId, rawKey, rawType, outcome, code, message, details);

    const forged = findForgedOwnerFields(input);
    if (forged.length) return reject('forbidden_owner_field', 'Owner identity comes from the authenticated connection; remove owner fields from the request', { fields: forged });
    if (!hasScope(this.principal, SCOPE_WRITE)) return reject('insufficient_scope', 'This connection is read-only; it can propose changes but not execute them', { scope: SCOPE_WRITE });

    const parsed = CommandEnvelope.safeParse(input);
    if (!parsed.success) {
      return reject('validation_failed', 'The command is not valid', { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    const envelope = parsed.data;
    const command = envelope.command as DomainCommand;
    const commandClass = COMMAND_CLASS[command.type];
    const requestHash = await sha256Hex(canonicalJson({ command: envelope.command, expectedVersions: envelope.expectedVersions ?? [] }));

    const existing = await this.loadByKey(envelope.idempotencyKey);
    if (existing) return this.replayOrReject(existing, requestHash, envelope.idempotencyKey, command.type);

    const user = await this.db.prepare('SELECT status FROM users WHERE user_id = ?').bind(this.principal.userId).first<{ status: string }>();
    if (!user) throw new DomainError('unauthenticated', 'Unknown user');
    if (user.status !== 'active') return reject('user_disabled', 'This account is disabled; no changes can be made');

    let rebased = false;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const now = this.now();
      // Expected versions: strict for edits and compensation, informational for owner observations.
      const stale = await this.staleExpectations(envelope.expectedVersions ?? []);
      if (stale.length) {
        if (commandClass === 'observation') rebased = true;
        else return reject('stale_version', 'The record changed since it was read; reload and try again', { stale }, 'conflict');
      }
      const ctx: HandlerContext = { db: this.db, principal: this.principal, command, envelope, commandId, now, attempt };
      let plan: CommandPlan;
      try {
        plan = await (HANDLERS[command.type] as (c: HandlerContext) => Promise<CommandPlan>)(ctx);
      } catch (err) {
        if (err instanceof DomainError) return reject(err.code, err.message, err.details, err.code === 'conflict' ? 'conflict' : 'rejected');
        throw err;
      }
      const expectedGuards: Predicate[] =
        commandClass === 'observation'
          ? []
          : (envelope.expectedVersions ?? []).filter((e) => isVersionedEntity(e.entityType)).map((e) => versionIs(this.principal.userId, e.entityType, e.entityId, e.version));
      const receipt = this.buildReceipt(commandId, envelope.idempotencyKey, command.type, plan, rebased, now);
      const statements = this.batchFor(ctx, plan, [...expectedGuards, ...plan.guards], receipt, requestHash, commandClass);
      try {
        await this.db.batch(statements);
        return receipt;
      } catch (err) {
        if (isUniqueViolation(err, 'command_receipts.idempotency_key')) {
          const winner = await this.loadByKey(envelope.idempotencyKey);
          if (winner) return this.replayOrReject(winner, requestHash, envelope.idempotencyKey, command.type);
        }
        if (isUniqueViolation(err, 'command_receipts.compensates_command_id')) return reject('already_undone', 'That change has already been undone');
        if (isPreconditionFailure(err) || isUniqueViolation(err, 'stock_movements') || isUniqueViolation(err, 'selections') || isUniqueViolation(err, 'style_documents')) {
          // Another command committed between our read and write. Observations rebase; edits re-check.
          if (commandClass === 'observation' || commandClass === 'intake') rebased = true;
          continue;
        }
        throw err;
      }
    }
    return reject('retry_exhausted', 'The wardrobe kept changing while this command was applied; please retry', {}, 'conflict');
  }

  private async staleExpectations(expected: { entityType: string; entityId: string; version: number }[]) {
    const stale: { entityType: string; entityId: string; expected: number; current: number | null }[] = [];
    for (const e of expected) {
      const current = await readVersion(this.db, this.principal.userId, e.entityType, e.entityId);
      if (current !== e.version) stale.push({ entityType: e.entityType, entityId: e.entityId, expected: e.version, current });
    }
    return stale;
  }

  private buildReceipt(commandId: string, key: string, type: CommandType, plan: CommandPlan, rebased: boolean, now: string): CommandReceipt {
    const effects: CommandEffect[] = plan.effects.map((e) => ({ effectId: newId('eff'), kind: e.kind, external: e.external, status: 'pending', operationKey: e.operationKey }));
    const external = effects.filter((e) => e.external);
    return {
      schemaVersion: CONTRACTS_VERSION,
      commandId,
      idempotencyKey: key,
      commandType: type,
      outcome: plan.outcome ?? 'committed',
      replayed: false,
      rebased,
      affected: plan.affected,
      summary: plan.summary,
      facts: plan.facts,
      effects: { state: external.length ? 'projection_pending' : 'none', items: effects },
      undo: plan.undo ? { available: true } : { available: false, ...(plan.undoUnavailableReason ? { reason: plan.undoUnavailableReason } : {}) },
      compensatesCommandId: type === 'undo' ? ((plan.facts.compensatesCommandId as string | undefined) ?? null) : null,
      undoneByCommandId: null,
      occurredAt: plan.occurredAt,
      recordedAt: now,
      error: null,
    };
  }

  private batchFor(ctx: HandlerContext, plan: CommandPlan, guards: Predicate[], receipt: CommandReceipt, requestHash: string, commandClass: string): D1PreparedStatement[] {
    const db = this.db;
    const userId = this.principal.userId;
    const checkId = newId('pre');
    const out: D1PreparedStatement[] = [preconditionStatement(db, checkId, guards), ...plan.statements];
    out.push(
      db
        .prepare(
          `INSERT INTO command_receipts (user_id, command_id, idempotency_key, request_hash, command_type, command_class, source, outcome, receipt_json, undo_json, compensates_command_id, occurred_at, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          userId,
          receipt.commandId,
          receipt.idempotencyKey,
          requestHash,
          receipt.commandType,
          commandClass,
          ctx.envelope.source,
          receipt.outcome,
          json(receipt),
          plan.undo ? json(plan.undo) : null,
          receipt.compensatesCommandId,
          receipt.occurredAt,
          receipt.recordedAt,
        ),
    );
    const seen = new Set<string>();
    for (const a of receipt.affected) {
      const k = `${a.entityType}|${a.entityId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(
        db.prepare('INSERT INTO command_receipt_entities (user_id, command_id, entity_type, entity_id, version) VALUES (?, ?, ?, ?, ?)').bind(userId, receipt.commandId, a.entityType, a.entityId, a.version),
      );
    }
    receipt.effects.items.forEach((e, i) => {
      out.push(
        db
          .prepare('INSERT INTO command_effects (user_id, effect_id, command_id, kind, external, status, operation_key, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(userId, e.effectId, receipt.commandId, e.kind, e.external ? 1 : 0, 'pending', e.operationKey, json(plan.effects[i]!.payload), receipt.recordedAt, receipt.recordedAt),
      );
    });
    if (this.options.afterStatements) out.push(...this.options.afterStatements(db));
    out.push(preconditionCleanup(db, checkId));
    return out;
  }

  private async loadByKey(key: string): Promise<ReceiptRow | null> {
    return this.db
      .prepare('SELECT command_id, request_hash, receipt_json, undo_json, undone_by_command_id FROM command_receipts WHERE user_id = ? AND idempotency_key = ?')
      .bind(this.principal.userId, key)
      .first<ReceiptRow>();
  }

  private async replayOrReject(row: ReceiptRow, requestHash: string, key: string, type: string): Promise<CommandReceipt> {
    if (row.request_hash !== requestHash) {
      return this.unpersistedReceipt(newId('cmd'), key, type, 'rejected', 'idempotency_key_reused', 'This idempotency key was already used for a different request');
    }
    const receipt = await hydrateReceipt(this.db, this.principal.userId, row);
    return { ...receipt, replayed: true };
  }

  private unpersistedReceipt(commandId: string, key: string, type: string, outcome: 'rejected' | 'conflict', code: string, message: string, details?: Record<string, unknown>): CommandReceipt {
    const now = this.now();
    return {
      schemaVersion: CONTRACTS_VERSION,
      commandId,
      idempotencyKey: key,
      commandType: type,
      outcome,
      replayed: false,
      rebased: false,
      affected: [],
      summary: message,
      facts: {},
      effects: { state: 'none', items: [] },
      undo: { available: false, reason: 'Nothing was changed.' },
      compensatesCommandId: null,
      undoneByCommandId: null,
      occurredAt: now,
      recordedAt: now,
      error: { code, message, ...(details ? { details } : {}) },
    };
  }
}

/** Stored receipt with its current undo and effect state overlaid. */
export async function hydrateReceipt(db: D1Database, userId: string, row: ReceiptRow): Promise<CommandReceipt> {
  const receipt = parseJson<CommandReceipt>(row.receipt_json, null as unknown as CommandReceipt);
  const { results: effects } = await db
    .prepare('SELECT effect_id, kind, external, status, operation_key FROM command_effects WHERE user_id = ? AND command_id = ?')
    .bind(userId, row.command_id)
    .all<{ effect_id: string; kind: CommandEffect['kind']; external: number; status: CommandEffect['status']; operation_key: string }>();
  const items: CommandEffect[] = effects.map((e) => ({ effectId: e.effect_id, kind: e.kind, external: e.external === 1, status: e.status, operationKey: e.operation_key }));
  const external = items.filter((e) => e.external);
  const state = !external.length ? 'none' : external.some((e) => e.status === 'failed') ? 'failed' : external.every((e) => e.status === 'projected' || e.status === 'superseded') ? 'projected' : 'projection_pending';
  return {
    ...receipt,
    effects: { state, items },
    undoneByCommandId: row.undone_by_command_id,
    undo: row.undone_by_command_id
      ? { available: false, reason: 'Already undone.' }
      : row.undo_json
        ? { available: true }
        : receipt.undo,
  };
}

export async function getReceipt(db: D1Database, principal: Principal, commandId: string): Promise<CommandReceipt | null> {
  assertPrincipal(principal);
  const row = await db
    .prepare('SELECT command_id, request_hash, receipt_json, undo_json, undone_by_command_id FROM command_receipts WHERE user_id = ? AND command_id = ?')
    .bind(principal.userId, commandId)
    .first<ReceiptRow>();
  return row ? hydrateReceipt(db, principal.userId, row) : null;
}

export async function listReceiptsForEntity(db: D1Database, principal: Principal, entityType: string, entityId: string, limit = 50): Promise<CommandReceipt[]> {
  assertPrincipal(principal);
  const { results } = await db
    .prepare(
      `SELECT r.command_id, r.request_hash, r.receipt_json, r.undo_json, r.undone_by_command_id FROM command_receipts r
       JOIN command_receipt_entities e ON e.user_id = r.user_id AND e.command_id = r.command_id
       WHERE r.user_id = ? AND e.entity_type = ? AND e.entity_id = ? ORDER BY r.recorded_at DESC LIMIT ?`,
    )
    .bind(principal.userId, entityType, entityId, limit)
    .all<ReceiptRow>();
  return Promise.all(results.map((r) => hydrateReceipt(db, principal.userId, r)));
}

/** Convenience wrapper: `executeCommand(env.DB, principal, body)`. */
export function executeCommand(db: D1Database, principal: Principal, input: unknown, options?: CommandServiceOptions): Promise<CommandReceipt> {
  return new CommandService(db, principal, options).execute(input);
}
