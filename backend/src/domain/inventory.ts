import type { CommandOf, StockBucket } from '@garderobe/contracts';
import { json, versionIs, type Predicate } from './db.js';
import { DomainError } from './errors.js';
import { newId } from './ids.js';
import { OWNER_CHANNELS } from './principal.js';
import { requireGarment, rowToGarment, type GarmentRow } from './records.js';
import { StockPlanner } from './stock/ledger.js';
import { CATEGORY_DEFAULTS, normalizePhrase } from './catalog.js';
import { revalidationEffect, type CommandPlan, type HandlerContext, type UndoPlan } from './commands/types.js';
import { planArrivalRecalculation } from '../lifecycle/deadlines.js';

/**
 * Inventory and lifecycle commands. Acquisition, location and stock buckets are separate facts that
 * a command updates together; nothing here creates an item except the explicit add_item command.
 */

function occurred(ctx: HandlerContext, at?: string): string {
  const iso = at ? new Date(at).toISOString() : ctx.now;
  if (Date.parse(iso) > Date.parse(ctx.now) + 5 * 60_000) throw new DomainError('validation_failed', 'occurredAt is in the future');
  return iso;
}

interface GarmentPatch {
  acquisition?: string;
  location?: string;
  locationDetail?: string | null;
  disposalReason?: string | null;
}

/** Guarded garment update plus a history snapshot of the prior state. */
export function garmentUpdate(ctx: HandlerContext, g: GarmentRow, patch: GarmentPatch): { statements: D1PreparedStatement[]; guard: Predicate } {
  const userId = ctx.principal.userId;
  const next = {
    acquisition: patch.acquisition ?? g.acquisition,
    location: patch.location ?? g.location,
    locationDetail: patch.locationDetail !== undefined ? patch.locationDetail : g.location_detail,
    disposalReason: patch.disposalReason !== undefined ? patch.disposalReason : g.disposal_reason,
  };
  return {
    guard: versionIs(userId, 'garment', g.garment_id, g.version),
    statements: [
      ctx.db
        .prepare('INSERT OR IGNORE INTO entity_history (user_id, entity_type, entity_id, version, snapshot_json, command_id, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(userId, 'garment', g.garment_id, g.version, json(rowToGarment(g)), ctx.commandId, ctx.now),
      ctx.db
        .prepare('UPDATE garments SET acquisition = ?, location = ?, location_detail = ?, disposal_reason = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND garment_id = ?')
        .bind(next.acquisition, next.location, next.locationDetail, next.disposalReason, ctx.now, userId, g.garment_id),
    ],
  };
}

function before(g: GarmentRow) {
  return { acquisition: g.acquisition, location: g.location, locationDetail: g.location_detail, disposalReason: g.disposal_reason };
}

function requireOwned(g: GarmentRow, action: string): void {
  if (g.acquisition !== 'owned') throw new DomainError('invalid_state', `${g.name} is ${g.acquisition}; it cannot be ${action}`, { garmentId: g.garment_id, acquisition: g.acquisition });
}

function assemble(
  ctx: HandlerContext,
  g: GarmentRow,
  at: string,
  planner: StockPlanner,
  update: { statements: D1PreparedStatement[]; guard: Predicate } | null,
  extra: { statements?: D1PreparedStatement[]; guards?: Predicate[]; affected?: CommandPlan['affected'] },
  summary: string,
  undo: UndoPlan | null,
  reason: string,
): CommandPlan {
  const stock = planner.finalize();
  return {
    occurredAt: at,
    guards: [...(update ? [update.guard] : []), ...stock.guards, ...(extra.guards ?? [])],
    statements: [...(update?.statements ?? []), ...(extra.statements ?? []), ...stock.statements],
    affected: [
      ...(update ? [{ entityType: 'garment' as const, entityId: g.garment_id, version: g.version + 1, change: 'updated' as const }] : []),
      ...(extra.affected ?? []),
      ...stock.affected,
    ],
    summary,
    facts: { garmentId: g.garment_id, name: g.name, buckets: planner.garmentCounts(g.garment_id), stockNotes: stock.notes },
    undo,
    effects: [revalidationEffect(ctx.commandId, [g.garment_id], reason)],
  };
}

export async function sendToTailor(ctx: HandlerContext<CommandOf<'send_to_tailor'>>): Promise<CommandPlan> {
  const c = ctx.command;
  const g = await requireGarment(ctx.db, ctx.principal.userId, c.garmentId);
  requireOwned(g, 'sent to the tailor');
  if (g.location === 'tailor') throw new DomainError('invalid_state', `${g.name} is already at the tailor`);
  const at = occurred(ctx, c.occurredAt);
  const planner = new StockPlanner(ctx.db, ctx.principal.userId, ctx.commandId, ctx.now);
  await planner.load([g.garment_id]);
  const counts = planner.garmentCounts(g.garment_id);
  const qty = counts.clean + counts.worn + counts.hamper + counts.storage;
  if (qty > 0) planner.add(g.garment_id, { kind: 'transfer', from: ['clean', 'worn', 'hamper', 'storage'], to: 'away', qty }, at);
  const projectId = newId('prj');
  const update = garmentUpdate(ctx, g, { location: 'tailor', locationDetail: c.work });
  const extra = {
    statements: [
      ctx.db
        .prepare("INSERT INTO lifecycle_projects (user_id, project_id, kind, status, details_json, expected_return, created_at, updated_at) VALUES (?, ?, 'tailoring', 'at_tailor', ?, ?, ?, ?)")
        .bind(ctx.principal.userId, projectId, json({ work: c.work, sentAt: at }), c.expectedReturn ?? null, ctx.now, ctx.now),
      ctx.db.prepare('INSERT INTO lifecycle_project_items (user_id, project_id, garment_id, quantity) VALUES (?, ?, ?, 1)').bind(ctx.principal.userId, projectId, g.garment_id),
    ],
    affected: [{ entityType: 'lifecycle_project' as const, entityId: projectId, version: 1, change: 'created' as const }],
  };
  const plan = assemble(ctx, g, at, planner, update, extra, `At the tailor: ${g.name} (${c.work})${c.expectedReturn ? `, expected back ${c.expectedReturn}` : ''}. An expected date is not a return.`, null, 'sent_to_tailor');
  plan.undo = { kind: 'restore_garment', garmentId: g.garment_id, versionAfter: g.version + 1, before: before(g), movementIds: planner.newMovementIds(), projectRestore: [{ projectId, status: 'cancelled', actualReturn: null }] };
  return plan;
}

export async function backFromTailor(ctx: HandlerContext<CommandOf<'back_from_tailor'>>): Promise<CommandPlan> {
  const c = ctx.command;
  const userId = ctx.principal.userId;
  const g = await requireGarment(ctx.db, userId, c.garmentId);
  requireOwned(g, 'returned from the tailor');
  const at = occurred(ctx, c.occurredAt);
  const planner = new StockPlanner(ctx.db, userId, ctx.commandId, ctx.now);
  await planner.load([g.garment_id]);
  if (planner.garmentCounts(g.garment_id).away > 0) planner.add(g.garment_id, { kind: 'sweep', from: ['away'], to: 'clean' }, at);
  const { results: projects } = await ctx.db
    .prepare(
      `SELECT p.project_id, p.status, p.actual_return, p.version FROM lifecycle_projects p JOIN lifecycle_project_items i ON i.user_id = p.user_id AND i.project_id = p.project_id
       WHERE p.user_id = ? AND i.garment_id = ? AND p.kind = 'tailoring' AND p.status = 'at_tailor'`,
    )
    .bind(userId, g.garment_id)
    .all<{ project_id: string; status: string; actual_return: string | null; version: number }>();
  const update = garmentUpdate(ctx, g, { location: 'home', locationDetail: null });
  const extra = {
    statements: projects.map((p) =>
      ctx.db
        .prepare("UPDATE lifecycle_projects SET status = 'returned', actual_return = ?, details_json = json_set(details_json, '$.returnNote', ?), version = version + 1, updated_at = ? WHERE user_id = ? AND project_id = ?")
        .bind(at.slice(0, 10), c.note ?? null, ctx.now, userId, p.project_id),
    ),
    guards: projects.map((p) => versionIs(userId, 'lifecycle_project', p.project_id, p.version)),
    affected: projects.map((p) => ({ entityType: 'lifecycle_project' as const, entityId: p.project_id, version: p.version + 1, change: 'updated' as const })),
  };
  const note = g.location !== 'tailor' ? ` (the ledger had it at ${g.location}; recorded as observed)` : '';
  const plan = assemble(ctx, g, at, planner, update, extra, `Back from the tailor: ${g.name}${note}.`, null, 'back_from_tailor');
  plan.undo = {
    kind: 'restore_garment',
    garmentId: g.garment_id,
    versionAfter: g.version + 1,
    before: before(g),
    movementIds: planner.newMovementIds(),
    projectRestore: projects.map((p) => ({ projectId: p.project_id, status: p.status, actualReturn: p.actual_return })),
  };
  return plan;
}

export async function markArrived(ctx: HandlerContext<CommandOf<'mark_arrived'>>): Promise<CommandPlan> {
  const c = ctx.command;
  const userId = ctx.principal.userId;
  const g = await requireGarment(ctx.db, userId, c.garmentId);
  if (g.acquisition === 'disposed') throw new DomainError('invalid_state', `${g.name} is disposed`);
  if (g.acquisition === 'owned' && !(g.tracking === 'anonymous_quantity' && c.quantity)) {
    throw new DomainError('invalid_state', `${g.name} is already owned; an arrival cannot add a second copy. Add units only for interchangeable items with an explicit quantity.`);
  }
  const at = occurred(ctx, c.occurredAt);
  const { results: lines } = await ctx.db
    .prepare("SELECT line_id, quantity, arrived_qty, status, version, arrived_at FROM order_lines WHERE user_id = ? AND garment_id = ? AND arrived_qty < quantity ORDER BY line_id")
    .bind(userId, g.garment_id)
    .all<{ line_id: string; quantity: number; arrived_qty: number; status: string; version: number; arrived_at: string | null }>();
  const outstanding = lines.reduce((n, l) => n + (l.quantity - l.arrived_qty), 0);
  const qty = c.quantity ?? (outstanding > 0 ? outstanding : 1);
  const planner = new StockPlanner(ctx.db, userId, ctx.commandId, ctx.now);
  await planner.load([g.garment_id]);
  planner.add(g.garment_id, { kind: 'receive', qty, to: 'clean', basis: 'observed' }, at);
  let remaining = qty;
  const lineStatements: D1PreparedStatement[] = [];
  const lineGuards: Predicate[] = [];
  const lineRestore: { lineId: string; arrivedQty: number; status: string; arrivedAt?: string | null }[] = [];
  for (const l of lines) {
    if (remaining <= 0) break;
    const add = Math.min(remaining, l.quantity - l.arrived_qty);
    remaining -= add;
    lineRestore.push({ lineId: l.line_id, arrivedQty: l.arrived_qty, status: l.status, arrivedAt: l.arrived_at });
    lineGuards.push(versionIs(userId, 'order_line', l.line_id, l.version));
    lineStatements.push(
      ctx.db
        .prepare('UPDATE order_lines SET arrived_qty = ?, status = ?, arrived_at = ?, version = version + 1 WHERE user_id = ? AND line_id = ?')
        .bind(l.arrived_qty + add, l.arrived_qty + add >= l.quantity ? 'arrived' : 'partially_arrived', at, userId, l.line_id),
    );
  }
  // Delivery-based return deadlines of these lines now count from this recorded arrival.
  const deadlines = await planArrivalRecalculation(ctx.db, userId, lineRestore.map((l) => l.lineId), at, ctx.commandId, ctx.now);
  lineStatements.push(...deadlines.statements);
  const update = garmentUpdate(ctx, g, { acquisition: 'owned', location: 'home', locationDetail: null });
  const moved = deadlines.recalculated.map((d) => ` Return ${d.kind.replace('_', ' ')} deadline now counts from ${d.toDate}.`).join('');
  const plan = assemble(ctx, g, at, planner, update, { statements: lineStatements, guards: lineGuards }, `Arrived: ${g.name}${qty > 1 ? ` ×${qty}` : ''}.${moved}`, null, 'arrived');
  if (deadlines.recalculated.length) plan.facts.recalculatedDeadlines = deadlines.recalculated;
  plan.undo = {
    kind: 'restore_garment',
    garmentId: g.garment_id,
    versionAfter: g.version + 1,
    before: before(g),
    movementIds: planner.newMovementIds(),
    orderLineRestore: lineRestore,
    ...(deadlines.restore.length ? { deadlineRestore: deadlines.restore } : {}),
  };
  return plan;
}

export async function putIntoStorage(ctx: HandlerContext<CommandOf<'put_into_storage'>>): Promise<CommandPlan> {
  const c = ctx.command;
  const g = await requireGarment(ctx.db, ctx.principal.userId, c.garmentId);
  requireOwned(g, 'put into storage');
  const at = occurred(ctx, c.occurredAt);
  const planner = new StockPlanner(ctx.db, ctx.principal.userId, ctx.commandId, ctx.now);
  await planner.load([g.garment_id]);
  const counts = planner.garmentCounts(g.garment_id);
  const from: StockBucket[] = g.tracking === 'anonymous_quantity' ? ['clean'] : ['clean', 'worn', 'hamper'];
  const available = from.reduce((n, b) => n + counts[b], 0);
  const qty = c.quantity ?? available;
  if (qty > available) throw new DomainError('validation_failed', `Only ${available} unit(s) of ${g.name} are at home to store`);
  if (qty > 0) planner.add(g.garment_id, { kind: 'transfer', from, to: 'storage', qty }, at);
  const after = planner.garmentCounts(g.garment_id);
  const allStored = after.clean + after.worn + after.hamper + after.laundry + after.away === 0 && after.storage > 0;
  const update = allStored ? garmentUpdate(ctx, g, { location: 'storage', locationDetail: c.locationDetail ?? null }) : null;
  const plan = assemble(ctx, g, at, planner, update, {}, `Put into storage: ${g.name}${qty > 1 ? ` ×${qty}` : ''}${c.locationDetail ? ` (${c.locationDetail})` : ''}.`, null, 'put_into_storage');
  plan.undo = update
    ? { kind: 'restore_garment', garmentId: g.garment_id, versionAfter: g.version + 1, before: before(g), movementIds: planner.newMovementIds() }
    : { kind: 'void_movements', movementIds: planner.newMovementIds(), garmentIds: [g.garment_id] };
  return plan;
}

export async function takeOutOfStorage(ctx: HandlerContext<CommandOf<'take_out_of_storage'>>): Promise<CommandPlan> {
  const c = ctx.command;
  const g = await requireGarment(ctx.db, ctx.principal.userId, c.garmentId);
  requireOwned(g, 'taken out of storage');
  const at = occurred(ctx, c.occurredAt);
  const planner = new StockPlanner(ctx.db, ctx.principal.userId, ctx.commandId, ctx.now);
  await planner.load([g.garment_id]);
  const stored = planner.garmentCounts(g.garment_id).storage;
  const qty = c.quantity ?? stored;
  if (qty > stored) throw new DomainError('validation_failed', `Only ${stored} unit(s) of ${g.name} are in storage`);
  if (qty > 0) planner.add(g.garment_id, { kind: 'transfer', from: ['storage'], to: 'clean', qty }, at);
  const update = g.location === 'storage' ? garmentUpdate(ctx, g, { location: 'home', locationDetail: null }) : null;
  const plan = assemble(ctx, g, at, planner, update, {}, `Out of storage: ${g.name}${qty > 1 ? ` ×${qty}` : ''}.`, null, 'take_out_of_storage');
  plan.undo = update
    ? { kind: 'restore_garment', garmentId: g.garment_id, versionAfter: g.version + 1, before: before(g), movementIds: planner.newMovementIds() }
    : { kind: 'void_movements', movementIds: planner.newMovementIds(), garmentIds: [g.garment_id] };
  return plan;
}

export async function reconcileQuantity(ctx: HandlerContext<CommandOf<'reconcile_quantity'>>): Promise<CommandPlan> {
  const c = ctx.command;
  const g = await requireGarment(ctx.db, ctx.principal.userId, c.garmentId);
  if (g.acquisition === 'disposed') throw new DomainError('invalid_state', `${g.name} is disposed`);
  if (g.tracking !== 'anonymous_quantity' && ((c.totalOwned ?? 0) > 1 || (c.clean ?? 0) > 1)) {
    throw new DomainError('validation_failed', `${g.name} is a single garment; quantities above 1 apply only to interchangeable units`);
  }
  const at = occurred(ctx, c.occurredAt);
  const planner = new StockPlanner(ctx.db, ctx.principal.userId, ctx.commandId, ctx.now);
  await planner.load([g.garment_id]);
  if (c.totalOwned !== undefined) planner.add(g.garment_id, { kind: 'reconcile_total', target: c.totalOwned }, at);
  if (c.clean !== undefined) planner.add(g.garment_id, { kind: 'reconcile_clean', target: c.clean }, at);
  const after = planner.garmentCounts(g.garment_id);
  const owned = after.clean + after.worn + after.hamper + after.laundry + after.storage + after.away;
  const plan = assemble(ctx, g, at, planner, null, {}, `Corrected ${g.name}: ${owned} owned, ${after.clean} clean.`, null, 'quantity_reconciled');
  plan.undo = { kind: 'void_movements', movementIds: planner.newMovementIds(), garmentIds: [g.garment_id] };
  return plan;
}

export async function disposeItem(ctx: HandlerContext<CommandOf<'dispose_item'>>): Promise<CommandPlan> {
  const c = ctx.command;
  const g = await requireGarment(ctx.db, ctx.principal.userId, c.garmentId);
  if (g.acquisition === 'disposed') throw new DomainError('invalid_state', `${g.name} is already disposed`);
  const at = occurred(ctx, c.occurredAt);
  const planner = new StockPlanner(ctx.db, ctx.principal.userId, ctx.commandId, ctx.now);
  await planner.load([g.garment_id]);
  const counts = planner.garmentCounts(g.garment_id);
  const owned = counts.clean + counts.worn + counts.hamper + counts.laundry + counts.storage + counts.away;
  if (owned > 0) planner.add(g.garment_id, { kind: 'retire', qty: owned }, at);
  const update = garmentUpdate(ctx, g, { acquisition: 'disposed', disposalReason: c.reason, location: 'unknown', locationDetail: c.note ?? null });
  const plan = assemble(ctx, g, at, planner, update, {}, `Disposed: ${g.name} (${c.reason.replace('_', ' ')}). Wear history is kept.`, null, 'disposed');
  plan.undo = { kind: 'restore_garment', garmentId: g.garment_id, versionAfter: g.version + 1, before: before(g), movementIds: planner.newMovementIds() };
  return plan;
}

export async function addItem(ctx: HandlerContext<CommandOf<'add_item'>>): Promise<CommandPlan> {
  const c = ctx.command;
  const userId = ctx.principal.userId;
  if (!OWNER_CHANNELS.includes(ctx.envelope.source)) {
    throw new DomainError('validation_failed', `Items are created only by an explicit owner request; source ${ctx.envelope.source} cannot create items`);
  }
  const d = CATEGORY_DEFAULTS[c.category];
  const laundryPolicy = c.laundryPolicy ?? d.laundryPolicy;
  const careChannel = laundryPolicy === 'never' ? 'none' : (c.careChannel ?? d.careChannel);
  const tracking = c.tracking ?? d.tracking;
  if (tracking === 'unit' && c.quantity > 1) throw new DomainError('validation_failed', 'A single garment cannot have a quantity above 1; use anonymous_quantity for interchangeable units');
  const garmentId = newId('g');
  const lotId = newId('lot');
  const settings = await ctx.db.prepare('SELECT wear_logging_since FROM owner_settings WHERE user_id = ?').bind(userId).first<{ wear_logging_since: string | null }>();
  const statements: D1PreparedStatement[] = [
    ctx.db
      .prepare(
        `INSERT INTO garments (user_id, garment_id, name, category, roles_json, maker, product_name, product_code, fabric, color, color_family, pattern, size_label,
           care_channel, laundry_policy, tracking, acquisition, planning_policy, condition, location, attributes_json, notes, wear_logging_since, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .bind(
        userId,
        garmentId,
        c.name,
        c.category,
        json(c.roles),
        c.maker ?? null,
        c.productName ?? null,
        c.productCode ?? null,
        c.fabric ?? null,
        c.color ?? null,
        c.colorFamily ?? null,
        c.pattern ?? null,
        c.sizeLabel ?? null,
        careChannel,
        laundryPolicy,
        tracking,
        c.acquisition,
        c.planningPolicy ?? 'normal',
        c.condition ?? 'unknown',
        c.acquisition === 'incoming' ? 'in_transit' : (c.location ?? 'home'),
        json(c.attributes ?? {}),
        c.notes ?? null,
        settings?.wear_logging_since ?? ctx.now.slice(0, 10),
        ctx.now,
        ctx.now,
      ),
    ctx.db.prepare('INSERT INTO stock_lots (user_id, lot_id, garment_id, updated_at) VALUES (?, ?, ?, ?)').bind(userId, lotId, garmentId, ctx.now),
  ];
  const movementIds: string[] = [];
  if (c.acquisition === 'owned') {
    const movementId = newId('mv');
    movementIds.push(movementId);
    const units = Array.from({ length: c.quantity }, () => ctx.now);
    statements.push(
      ctx.db
        .prepare("INSERT INTO stock_movements (user_id, movement_id, seq, lot_id, garment_id, kind, params_json, occurred_at, recorded_at, command_id) VALUES (?, ?, ?, ?, ?, 'receive', ?, ?, ?, ?)")
        .bind(userId, movementId, Date.now() * 1000, lotId, garmentId, json({ kind: 'receive', qty: c.quantity, to: 'clean', basis: 'observed' }), ctx.now, ctx.now, ctx.commandId),
      ctx.db
        .prepare('UPDATE stock_lots SET clean_qty = ?, units_json = ?, version = version + 1 WHERE user_id = ? AND lot_id = ?')
        .bind(c.quantity, json({ clean: units, worn: [], hamper: [], laundry: [], storage: [], away: [], retired: [] }), userId, lotId),
    );
  }
  const seen = new Set<string>();
  for (const f of c.facts ?? []) {
    statements.push(
      ctx.db
        .prepare('INSERT INTO garment_facts (user_id, fact_id, garment_id, field, value_json, source_kind, source_ref, observed_at, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(userId, newId('fct'), garmentId, f.field, json(f.value ?? null), f.sourceKind, f.sourceRef, new Date(f.observedAt).toISOString(), ctx.commandId, ctx.now),
    );
  }
  for (const a of c.aliases ?? []) {
    const norm = normalizePhrase(a.phrase);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    statements.push(
      ctx.db
        .prepare('INSERT INTO garment_aliases (user_id, alias_id, garment_id, phrase, phrase_norm, kind, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(userId, newId('ali'), garmentId, a.phrase, norm, a.kind, `command:${ctx.commandId}`, ctx.now),
    );
  }
  return {
    occurredAt: ctx.now,
    guards: [],
    statements,
    affected: [
      { entityType: 'garment', entityId: garmentId, version: 1, change: 'created' },
      { entityType: 'stock_lot', entityId: lotId, version: c.acquisition === 'owned' ? 2 : 1, change: 'created' },
    ],
    summary: `Added ${c.name}${c.acquisition === 'incoming' ? ' as incoming (not yet arrived)' : ''}${c.quantity > 1 ? ` ×${c.quantity}` : ''}.`,
    facts: { garmentId, lotId, acquisition: c.acquisition, quantity: c.acquisition === 'owned' ? c.quantity : 0 },
    undo: { kind: 'void_item', garmentId, versionAfter: 1, movementIds },
    effects: [revalidationEffect(ctx.commandId, [garmentId], 'item_added')],
  };
}
