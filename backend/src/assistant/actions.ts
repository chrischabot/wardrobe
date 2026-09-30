import { canonicalJson, sha256Hex } from '../domain/hash.js';

/**
 * Durable action intents (spec section 8, "Stable action identity through recovery"). Each proposed
 * mutation is registered before dispatch with its parent turn, operation, resolved targets and
 * canonical effect. The command idempotency key derives from the backend-issued action id, not from
 * a provider tool-call id, so a resampled model proposing the same effect under a new tool-call id
 * resolves to the existing intent and its existing receipt.
 */
export interface ActionIntent {
  actionId: string;
  status: 'pending' | 'committed' | 'failed' | 'cancelled';
  commandId: string | null;
  existing: boolean;
  idempotencyKey: string;
}

export async function registerActionIntent(
  db: D1Database,
  userId: string,
  input: { parentRef: string; operation: string; targetIds: string[]; effect: unknown; expectedVersions?: unknown[]; now: string },
): Promise<ActionIntent> {
  const effectHash = await sha256Hex(canonicalJson({ operation: input.operation, targets: [...input.targetIds].sort(), effect: input.effect }));
  const actionId = `act_${crypto.randomUUID().replace(/-/g, '')}`;
  await db
    .prepare(
      `INSERT INTO action_intents (user_id, action_id, parent_ref, operation, target_ids_json, effect_hash, expected_versions_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT (user_id, parent_ref, effect_hash) DO NOTHING`,
    )
    .bind(userId, actionId, input.parentRef, input.operation, JSON.stringify([...input.targetIds].sort()), effectHash, JSON.stringify(input.expectedVersions ?? []), input.now, input.now)
    .run();
  const row = await db
    .prepare('SELECT action_id, status, command_id FROM action_intents WHERE user_id = ? AND parent_ref = ? AND effect_hash = ?')
    .bind(userId, input.parentRef, effectHash)
    .first<{ action_id: string; status: ActionIntent['status']; command_id: string | null }>();
  if (!row) throw new Error('action intent was not recorded');
  return { actionId: row.action_id, status: row.status, commandId: row.command_id, existing: row.action_id !== actionId, idempotencyKey: `act:${row.action_id}` };
}

export async function settleActionIntent(db: D1Database, userId: string, actionId: string, status: 'committed' | 'failed' | 'cancelled', commandId: string | null, now: string): Promise<void> {
  await db.prepare('UPDATE action_intents SET status = ?, command_id = COALESCE(?, command_id), updated_at = ? WHERE user_id = ? AND action_id = ?').bind(status, commandId, now, userId, actionId).run();
}

/** Committed and pending effects of a turn (used by Stop to report what already happened). */
export async function actionIntentsFor(db: D1Database, userId: string, parentRef: string) {
  const { results } = await db
    .prepare('SELECT action_id, operation, target_ids_json, status, command_id FROM action_intents WHERE user_id = ? AND parent_ref = ? ORDER BY created_at')
    .bind(userId, parentRef)
    .all<{ action_id: string; operation: string; target_ids_json: string; status: string; command_id: string | null }>();
  return results.map((r) => ({ actionId: r.action_id, operation: r.operation, targetIds: JSON.parse(r.target_ids_json) as string[], status: r.status, commandId: r.command_id }));
}

/** Reconcile pending intents with D1 receipts after an eviction, before any model continues. */
export async function reconcilePendingIntents(db: D1Database, userId: string, now: string): Promise<number> {
  const { results } = await db.prepare("SELECT action_id FROM action_intents WHERE user_id = ? AND status = 'pending'").bind(userId).all<{ action_id: string }>();
  let fixed = 0;
  for (const r of results) {
    const receipt = await db.prepare('SELECT command_id FROM command_receipts WHERE user_id = ? AND idempotency_key = ?').bind(userId, `act:${r.action_id}`).first<{ command_id: string }>();
    if (receipt) {
      await settleActionIntent(db, userId, r.action_id, 'committed', receipt.command_id, now);
      fixed++;
    }
  }
  return fixed;
}
