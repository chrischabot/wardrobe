import { newId } from './ids.js';

/**
 * D1 helpers for the command commit boundary (spec section 8, "Concurrent actions").
 *
 * Every command batch starts with a precondition record whose `ok` column has CHECK (ok = 1). The
 * INSERT ... SELECT evaluates every expected version, required row and quantity predicate; a
 * mismatch raises a real SQLite constraint error before any mutation and D1 rolls back the batch.
 */

export interface Predicate {
  sql: string;
  params: unknown[];
  /** Human description used in conflict details. */
  describe: string;
}

const VERSIONED: Record<string, { table: string; keys: string[]; column?: string }> = {
  garment: { table: 'garments', keys: ['garment_id'] },
  stock_lot: { table: 'stock_lots', keys: ['lot_id'] },
  restriction: { table: 'restrictions', keys: ['restriction_id'] },
  wear_observation: { table: 'wear_observations', keys: ['observation_id'] },
  laundry_batch: { table: 'laundry_batches', keys: ['batch_id'] },
  board: { table: 'boards', keys: ['board_id'] },
  selection: { table: 'selections', keys: ['selection_id'] },
  lifecycle_project: { table: 'lifecycle_projects', keys: ['project_id'] },
  order_line: { table: 'order_lines', keys: ['line_id'] },
  saved_combination: { table: 'saved_combinations', keys: ['combination_id'] },
  owner_settings: { table: 'owner_settings', keys: [] },
  user: { table: 'users', keys: [] },
};

export function isVersionedEntity(entityType: string): boolean {
  return entityType in VERSIONED;
}

/** Predicate: the entity's version equals `version` (a missing row fails). */
export function versionIs(userId: string, entityType: string, entityId: string, version: number): Predicate {
  const spec = VERSIONED[entityType];
  if (!spec) throw new Error(`Entity type ${entityType} has no version column`);
  const where = ['user_id = ?', ...spec.keys.map((k) => `${k} = ?`)].join(' AND ');
  const keyParams = spec.keys.length ? [entityId] : [];
  return {
    sql: `(SELECT version FROM ${spec.table} WHERE ${where}) = ?`,
    params: [userId, ...keyParams, version],
    describe: `${entityType} ${entityId} at version ${version}`,
  };
}

export async function readVersion(db: D1Database, userId: string, entityType: string, entityId: string): Promise<number | null> {
  const spec = VERSIONED[entityType];
  if (!spec) return null;
  const where = ['user_id = ?', ...spec.keys.map((k) => `${k} = ?`)].join(' AND ');
  const row = await db
    .prepare(`SELECT version FROM ${spec.table} WHERE ${where}`)
    .bind(userId, ...(spec.keys.length ? [entityId] : []))
    .first<{ version: number }>();
  return row ? row.version : null;
}

export function rawPredicate(sql: string, params: unknown[], describe: string): Predicate {
  return { sql: `(${sql})`, params, describe };
}

export function preconditionStatement(db: D1Database, checkId: string, predicates: Predicate[]): D1PreparedStatement {
  const condition = predicates.length ? predicates.map((p) => `COALESCE(${p.sql}, 0)`).join(' AND ') : '1';
  const params = predicates.flatMap((p) => p.params);
  return db
    .prepare(`INSERT INTO command_preconditions (check_id, ok) SELECT ?, CASE WHEN ${condition} THEN 1 ELSE 0 END`)
    .bind(checkId, ...params);
}

export function preconditionCleanup(db: D1Database, checkId: string): D1PreparedStatement {
  return db.prepare('DELETE FROM command_preconditions WHERE check_id = ?').bind(checkId);
}

/** An assertion statement that fails the batch when a postcondition is false. */
export function assertionStatement(db: D1Database, predicates: Predicate[]): D1PreparedStatement[] {
  const id = newId('pre');
  return [preconditionStatement(db, id, predicates), preconditionCleanup(db, id)];
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message} ${cause.message}` : err.message;
  }
  return String(err);
}

export function isPreconditionFailure(err: unknown): boolean {
  return /CHECK constraint failed: ok = 1/.test(errorMessage(err));
}

export function isUniqueViolation(err: unknown, fragment: string): boolean {
  const m = errorMessage(err);
  return m.includes('UNIQUE constraint failed') && m.includes(fragment);
}

/** Execute statements in bounded D1 batches (each chunk is atomic on its own). */
export async function batchInChunks(db: D1Database, statements: D1PreparedStatement[], size = 80): Promise<void> {
  for (let i = 0; i < statements.length; i += size) {
    await db.batch(statements.slice(i, i + size));
  }
}

export function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
