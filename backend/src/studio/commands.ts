import type { CommandOf, GarmentRole, StudioSlot } from '@garderobe/contracts';
import { json, parseJson, rawPredicate, versionIs } from '../domain/db.js';
import { DomainError, notFound } from '../domain/errors.js';
import { loadGarments } from '../domain/records.js';
import type { CommandPlan, HandlerContext, UndoPlan } from '../domain/commands/types.js';

/**
 * Studio commands (spec section 3): Save combination, Plan for a day and removal. They run through
 * the shared CommandService (idempotency key, one D1 batch, stored receipt, undo as compensation).
 *
 * Distinct effects, by construction:
 *  - save_combination writes one saved_combinations row (kind 'saved'); no plan, no wear, no stock.
 *  - plan_outfit writes one plan row for a date (kind 'plan'), superseding that day's previous plan;
 *    it is an intention, never a wear.
 *  - Wear this is the foundation's record_wear (StudioService.wear), the only one that counts a wear.
 *
 * These handlers check ownership and structure. The day's full validation (weather, cleanliness,
 * profile rules) runs in StudioService before it issues plan_outfit; see studio/service.ts.
 */

export function combinationId(): string {
  return `cmb_${crypto.randomUUID().replace(/-/g, '')}`;
}

const SINGLE_ROLES: GarmentRole[] = ['base_top', 'mid_layer', 'outer_layer', 'bottom', 'one_piece', 'socks', 'belt', 'accessory'];

/** Ownership and structural checks shared by every Studio command. Returns the garment names in slot order. */
export async function checkSlots(db: D1Database, userId: string, slots: StudioSlot[]): Promise<string[]> {
  const ids = slots.map((s) => s.garmentId);
  if (new Set(ids).size !== ids.length) throw new DomainError('validation_failed', 'A garment appears twice in the combination', { garmentIds: ids });
  const rows = await loadGarments(db, userId, ids);
  for (const s of slots) {
    const g = rows.get(s.garmentId);
    // Another owner's garment looks exactly like a missing one.
    if (!g) throw notFound('garment', s.garmentId);
    if (g.acquisition === 'disposed') throw new DomainError('invalid_state', `${g.name} is no longer in the wardrobe`, { garmentId: s.garmentId });
    const roles = parseJson<GarmentRole[]>(g.roles_json, []);
    if (!roles.includes(s.role)) throw new DomainError('validation_failed', `${g.name} cannot be worn as ${s.role.replace('_', ' ')}`, { garmentId: s.garmentId, role: s.role });
    if (s.role === 'underwear' || s.role === 'indoor') throw new DomainError('validation_failed', 'Underwear and indoor pieces are not part of a Studio combination', { garmentId: s.garmentId });
  }
  for (const role of SINGLE_ROLES) {
    if (slots.filter((s) => s.role === role).length > 1) throw new DomainError('validation_failed', `Only one ${role.replace('_', ' ')} per combination`, { role });
  }
  const oneP = slots.some((s) => s.role === 'one_piece');
  if (oneP && slots.some((s) => s.role === 'base_top' || s.role === 'bottom')) {
    throw new DomainError('validation_failed', 'A one-piece replaces the top and the trousers', { role: 'one_piece' });
  }
  const shoes = slots.filter((s) => s.role === 'footwear');
  if (shoes.length > 1 && (!shoes.every((s) => s.alternativeGroup) || new Set(shoes.map((s) => s.alternativeGroup)).size !== 1)) {
    throw new DomainError('validation_failed', 'Several shoes must be alternatives in one group, so a wear never logs both', { role: 'footwear' });
  }
  return slots.map((s) => rows.get(s.garmentId)!.name);
}

function normalizeSlots(slots: StudioSlot[]): StudioSlot[] {
  return slots.map((s) => ({ garmentId: s.garmentId, role: s.role, ...(s.alternativeGroup ? { alternativeGroup: s.alternativeGroup } : {}) }));
}

function basePlan(ctx: HandlerContext): CommandPlan {
  return { occurredAt: ctx.now, guards: [], statements: [], affected: [], summary: '', facts: {}, undo: null, effects: [] };
}

function insertRow(ctx: HandlerContext, row: { id: string; kind: 'saved' | 'plan'; name: string | null; slots: StudioSlot[]; mode: string; favorite: boolean; date: string | null }): D1PreparedStatement {
  return ctx.db
    .prepare(
      `INSERT INTO saved_combinations (user_id, combination_id, name, slots_json, favorite, planned_for_date, created_at, version, kind, mode, status, command_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'active', ?, ?)`,
    )
    .bind(ctx.principal.userId, row.id, row.name, json(row.slots), row.favorite ? 1 : 0, row.date, ctx.now, row.kind, row.mode, ctx.commandId, ctx.now);
}

export async function saveCombination(ctx: HandlerContext<CommandOf<'save_combination'>>): Promise<CommandPlan> {
  const c = ctx.command;
  const names = await checkSlots(ctx.db, ctx.principal.userId, c.slots);
  const id = combinationId();
  const plan = basePlan(ctx);
  plan.statements.push(insertRow(ctx, { id, kind: 'saved', name: c.name ?? null, slots: normalizeSlots(c.slots), mode: c.mode ?? 'today', favorite: c.favorite ?? false, date: null }));
  plan.affected.push({ entityType: 'saved_combination', entityId: id, version: 1, change: 'created' });
  plan.summary = `Saved combination${c.name ? ` "${c.name}"` : ''}: ${names.join(', ')}.`;
  plan.facts = { combinationId: id, kind: 'saved', garmentIds: c.slots.map((s) => s.garmentId), plannedForDate: null, wearRecorded: false };
  plan.undo = { kind: 'restore_combinations', changes: [{ combinationId: id, toStatus: 'removed', versionAfter: 1 }] };
  return plan;
}

export async function planOutfit(ctx: HandlerContext<CommandOf<'plan_outfit'>>): Promise<CommandPlan> {
  const c = ctx.command;
  const userId = ctx.principal.userId;
  const names = await checkSlots(ctx.db, userId, c.slots);
  const previous = await ctx.db
    .prepare("SELECT combination_id, version FROM saved_combinations WHERE user_id = ? AND kind = 'plan' AND status = 'active' AND planned_for_date = ?")
    .bind(userId, c.date)
    .first<{ combination_id: string; version: number }>();
  const id = combinationId();
  const plan = basePlan(ctx);
  const changes: Extract<UndoPlan, { kind: 'restore_combinations' }>['changes'] = [{ combinationId: id, toStatus: 'removed', versionAfter: 1 }];
  if (previous) {
    plan.guards.push(versionIs(userId, 'saved_combination', previous.combination_id, previous.version));
    plan.statements.push(
      ctx.db.prepare("UPDATE saved_combinations SET status = 'superseded', version = version + 1, updated_at = ? WHERE user_id = ? AND combination_id = ?").bind(ctx.now, userId, previous.combination_id),
    );
    plan.affected.push({ entityType: 'saved_combination', entityId: previous.combination_id, version: previous.version + 1, change: 'updated' });
    changes.push({ combinationId: previous.combination_id, toStatus: 'active', versionAfter: previous.version + 1 });
  } else {
    // A concurrent plan for the same day makes this re-plan against it instead of failing on the unique index.
    plan.guards.push(rawPredicate("SELECT COUNT(*) = 0 FROM saved_combinations WHERE user_id = ? AND kind = 'plan' AND status = 'active' AND planned_for_date = ?", [userId, c.date], 'no plan for the day yet'));
  }
  plan.statements.push(insertRow(ctx, { id, kind: 'plan', name: c.name ?? null, slots: normalizeSlots(c.slots), mode: 'today', favorite: false, date: c.date }));
  plan.affected.push({ entityType: 'saved_combination', entityId: id, version: 1, change: 'created' });
  plan.summary = `Planned for ${c.date}: ${names.join(', ')}.${previous ? ' It replaces the earlier plan for that day.' : ''} Nothing is recorded as worn.`;
  plan.facts = { combinationId: id, kind: 'plan', plannedForDate: c.date, garmentIds: c.slots.map((s) => s.garmentId), supersededCombinationId: previous?.combination_id ?? null, wearRecorded: false };
  plan.undo = { kind: 'restore_combinations', changes };
  return plan;
}

export async function removeCombination(ctx: HandlerContext<CommandOf<'remove_combination'>>): Promise<CommandPlan> {
  const userId = ctx.principal.userId;
  const row = await ctx.db
    .prepare('SELECT combination_id, name, kind, status, version, planned_for_date FROM saved_combinations WHERE user_id = ? AND combination_id = ?')
    .bind(userId, ctx.command.combinationId)
    .first<{ combination_id: string; name: string | null; kind: string; status: string; version: number; planned_for_date: string | null }>();
  if (!row) throw notFound('saved_combination', ctx.command.combinationId);
  if (row.status !== 'active') throw new DomainError('invalid_state', 'That combination was already removed or replaced', { status: row.status });
  const plan = basePlan(ctx);
  plan.guards.push(versionIs(userId, 'saved_combination', row.combination_id, row.version));
  plan.statements.push(ctx.db.prepare("UPDATE saved_combinations SET status = 'removed', version = version + 1, updated_at = ? WHERE user_id = ? AND combination_id = ?").bind(ctx.now, userId, row.combination_id));
  plan.affected.push({ entityType: 'saved_combination', entityId: row.combination_id, version: row.version + 1, change: 'updated' });
  plan.summary = row.kind === 'plan' ? `Removed the plan for ${row.planned_for_date}.` : `Removed saved combination${row.name ? ` "${row.name}"` : ''}.`;
  plan.facts = { combinationId: row.combination_id, kind: row.kind };
  plan.undo = { kind: 'restore_combinations', changes: [{ combinationId: row.combination_id, toStatus: 'active', versionAfter: row.version + 1 }] };
  return plan;
}

/**
 * Compensation for Studio commands: each recorded change is reverted only if the row is still at the
 * version the original command left (otherwise the later change must be undone first).
 */
export async function compensateCombinations(ctx: HandlerContext, undo: Extract<UndoPlan, { kind: 'restore_combinations' }>): Promise<CommandPlan> {
  const userId = ctx.principal.userId;
  const plan = basePlan(ctx);
  const restored: string[] = [];
  for (const ch of undo.changes) {
    const row = await ctx.db
      .prepare('SELECT combination_id, kind, status, version, planned_for_date FROM saved_combinations WHERE user_id = ? AND combination_id = ?')
      .bind(userId, ch.combinationId)
      .first<{ combination_id: string; kind: string; status: string; version: number; planned_for_date: string | null }>();
    if (!row) throw notFound('saved_combination', ch.combinationId);
    if (row.version !== ch.versionAfter) throw new DomainError('conflict', 'The combination has changed since; undo the later change first or correct it directly');
    // Undo reverses the original change: removed -> active (and back), superseded -> active.
    const target = ch.toStatus === 'removed' ? 'removed' : 'active';
    plan.guards.push(versionIs(userId, 'saved_combination', row.combination_id, row.version));
    plan.statements.push(
      ctx.db.prepare('UPDATE saved_combinations SET status = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND combination_id = ?').bind(target, ctx.now, userId, row.combination_id),
    );
    plan.affected.push({ entityType: 'saved_combination', entityId: row.combination_id, version: row.version + 1, change: 'updated' });
    restored.push(`${row.kind === 'plan' ? 'plan' : 'combination'} ${target === 'removed' ? 'withdrawn' : 'restored'}`);
  }
  // Removals go first so restoring a day's earlier plan never collides with the one being withdrawn.
  const order = undo.changes.map((c, i) => ({ i, removed: (c.toStatus === 'removed' ? 0 : 1) }));
  order.sort((a, b) => a.removed - b.removed || a.i - b.i);
  plan.statements = order.map((o) => plan.statements[o.i]!);
  for (const ch of undo.changes) {
    if (ch.toStatus !== 'active') continue;
    const r = await ctx.db.prepare('SELECT kind, planned_for_date FROM saved_combinations WHERE user_id = ? AND combination_id = ?').bind(userId, ch.combinationId).first<{ kind: string; planned_for_date: string | null }>();
    if (r?.kind === 'plan' && r.planned_for_date) {
      const others = undo.changes.filter((x) => x.toStatus === 'removed').map((x) => x.combinationId);
      plan.guards.push(
        rawPredicate(
          `SELECT COUNT(*) = 0 FROM saved_combinations WHERE user_id = ? AND kind = 'plan' AND status = 'active' AND planned_for_date = ? AND combination_id NOT IN (${others.map(() => '?').join(', ') || "''"})`,
          [userId, r.planned_for_date, ...others],
          'no other plan for the day',
        ),
      );
    }
  }
  plan.summary = restored.length ? `${restored.join('; ')}.` : '';
  return plan;
}
