import { DEFAULT_LAUNDRY_ROUTINE, type CommandOf, type LaundryPool, type LaundryReset, type LaundryRoutine } from '@garderobe/contracts';
import { parseJson, versionIs, type Predicate } from './db.js';
import { DomainError } from './errors.js';
import { newId } from './ids.js';
import { assertPrincipal, type Principal } from './principal.js';
import { requireGarment, requireGarments, type GarmentRow } from './records.js';
import { StockPlanner } from './stock/ledger.js';
import { addDays, localDateOf, previousOrSameDow, zonedInstant } from './time.js';
import { revalidationEffect, type CommandPlan, type HandlerContext } from './commands/types.js';

/**
 * Care flows (spec section 5, "Quantity and laundry"):
 * - service laundry: the hamper is snapshotted into a batch at pickup; a return completes only that
 *   batch, less named exceptions; a shirt worn after pickup stays in the hamper.
 * - hand wash: "Socks washed" clears the hand-wash hamper; it never enters a service batch.
 * - footwear, belts and other never-laundered roles cannot acquire a laundry state.
 */

function occurred(ctx: HandlerContext, at?: string): string {
  const iso = at ? new Date(at).toISOString() : ctx.now;
  if (Date.parse(iso) > Date.parse(ctx.now) + 5 * 60_000) throw new DomainError('validation_failed', 'occurredAt is in the future');
  return iso;
}

function assertLaunderable(g: GarmentRow): void {
  if (g.laundry_policy === 'never' || g.care_channel === 'none' && g.laundry_policy !== 'multi_wear') {
    throw new DomainError('never_laundered', `${g.name} is never laundered; it cannot be put in the wash`, { garmentId: g.garment_id, laundryPolicy: g.laundry_policy });
  }
}

function assertQuantity(g: GarmentRow, qty: number | undefined): void {
  if (qty !== undefined && qty > 1 && g.tracking !== 'anonymous_quantity') {
    throw new DomainError('validation_failed', `${g.name} is a single garment; a quantity above 1 applies only to interchangeable units`);
  }
}

export async function markInWash(ctx: HandlerContext<CommandOf<'mark_in_wash'>>): Promise<CommandPlan> {
  const c = ctx.command;
  const g = await requireGarment(ctx.db, ctx.principal.userId, c.garmentId);
  assertLaunderable(g);
  assertQuantity(g, c.quantity);
  const at = occurred(ctx, c.occurredAt);
  const planner = new StockPlanner(ctx.db, ctx.principal.userId, ctx.commandId, ctx.now);
  await planner.load([g.garment_id]);
  const qty = c.quantity ?? 1;
  planner.add(g.garment_id, { kind: 'transfer', from: ['worn', 'clean'], to: 'hamper', qty }, at);
  const stock = planner.finalize();
  const after = planner.garmentCounts(g.garment_id);
  return {
    occurredAt: at,
    guards: stock.guards,
    statements: stock.statements,
    affected: stock.affected,
    summary: `In the wash: ${g.name}${qty > 1 ? ` (${qty})` : ''}. ${after.clean} clean remaining.`,
    facts: { garmentId: g.garment_id, name: g.name, buckets: after, stockNotes: stock.notes },
    undo: { kind: 'void_movements', movementIds: planner.newMovementIds(), garmentIds: [g.garment_id] },
    effects: [revalidationEffect(ctx.commandId, [g.garment_id], 'in_the_wash')],
  };
}

export async function markWashed(ctx: HandlerContext<CommandOf<'mark_washed'>>): Promise<CommandPlan> {
  const c = ctx.command;
  const g = await requireGarment(ctx.db, ctx.principal.userId, c.garmentId);
  assertLaunderable(g);
  assertQuantity(g, c.quantity);
  const at = occurred(ctx, c.occurredAt);
  const planner = new StockPlanner(ctx.db, ctx.principal.userId, ctx.commandId, ctx.now);
  await planner.load([g.garment_id]);
  const before = planner.garmentCounts(g.garment_id);
  const qty = c.quantity ?? Math.max(1, before.hamper + before.worn);
  planner.add(g.garment_id, { kind: 'transfer', from: ['hamper', 'worn'], to: 'clean', qty }, at);
  const stock = planner.finalize();
  const after = planner.garmentCounts(g.garment_id);
  const cleared = await openExceptionIds(ctx.db, ctx.principal.userId, g.garment_id, ['dirty']);
  const statements = [...stock.statements, ...cleared.map((id) => clearException(ctx, id, at))];
  return {
    occurredAt: at,
    guards: stock.guards,
    statements,
    affected: stock.affected,
    summary: `Washed: ${g.name}. ${after.clean} clean.`,
    facts: { garmentId: g.garment_id, name: g.name, buckets: after, stockNotes: stock.notes },
    undo: { kind: 'void_movements', movementIds: planner.newMovementIds(), garmentIds: [g.garment_id] },
    effects: [revalidationEffect(ctx.commandId, [g.garment_id], 'washed')],
  };
}

export async function socksWashed(ctx: HandlerContext<CommandOf<'socks_washed'>>): Promise<CommandPlan> {
  const c = ctx.command;
  const userId = ctx.principal.userId;
  const at = occurred(ctx, c.occurredAt);
  let garments: Map<string, GarmentRow>;
  if (c.garmentIds?.length) {
    garments = await requireGarments(ctx.db, userId, c.garmentIds);
    for (const g of garments.values()) {
      if (g.care_channel !== 'hand_wash') throw new DomainError('validation_failed', `${g.name} is not a hand-wash item; use the laundry service commands`, { garmentId: g.garment_id });
    }
  } else {
    const { results } = await ctx.db
      .prepare(
        `SELECT DISTINCT g.* FROM garments g JOIN stock_lots l ON l.user_id = g.user_id AND l.garment_id = g.garment_id
         WHERE g.user_id = ? AND g.care_channel = 'hand_wash' AND (l.hamper_qty > 0 OR EXISTS (
           SELECT 1 FROM stock_movements m WHERE m.user_id = l.user_id AND m.lot_id = l.lot_id AND m.voided_at IS NULL AND m.occurred_at > ?))`,
      )
      .bind(userId, at)
      .all<GarmentRow>();
    garments = new Map(results.map((g) => [g.garment_id, g]));
  }
  const planner = new StockPlanner(ctx.db, userId, ctx.commandId, ctx.now);
  await planner.load([...garments.keys()]);
  const washed: { garmentId: string; name: string; quantity: number }[] = [];
  for (const g of garments.values()) {
    for (const lot of planner.lotsOf(g.garment_id)) {
      const inHamper = planner.countsAt(lot.lot_id, at).hamper;
      if (inHamper > 0 || c.garmentIds?.length) {
        planner.add(g.garment_id, { kind: 'sweep', from: ['hamper'], to: 'clean' }, at, {}, lot.lot_id);
        if (inHamper > 0) washed.push({ garmentId: g.garment_id, name: g.name, quantity: inHamper });
      }
    }
  }
  const stock = planner.finalize();
  const total = washed.reduce((n, w) => n + w.quantity, 0);
  return {
    occurredAt: at,
    guards: stock.guards,
    statements: stock.statements,
    affected: stock.affected,
    summary: total ? `Socks washed: ${washed.map((w) => `${w.name} ×${w.quantity}`).join(', ')}.` : 'Socks washed: no hand-wash items were in the hamper on record.',
    facts: { washed, totalPairs: total },
    undo: { kind: 'void_movements', movementIds: planner.newMovementIds(), garmentIds: [...garments.keys()] },
    effects: [revalidationEffect(ctx.commandId, [...garments.keys()], 'socks_washed')],
  };
}

export async function laundryCollected(ctx: HandlerContext<CommandOf<'laundry_collected'>>): Promise<CommandPlan> {
  const userId = ctx.principal.userId;
  const at = occurred(ctx, ctx.command.occurredAt);
  const { results: garmentRows } = await ctx.db
    .prepare(
      `SELECT DISTINCT g.* FROM garments g JOIN stock_lots l ON l.user_id = g.user_id AND l.garment_id = g.garment_id
       WHERE g.user_id = ? AND g.care_channel = 'service' AND (l.hamper_qty > 0 OR EXISTS (
         SELECT 1 FROM stock_movements m WHERE m.user_id = l.user_id AND m.lot_id = l.lot_id AND m.voided_at IS NULL AND m.occurred_at > ?))`,
    )
    .bind(userId, at)
    .all<GarmentRow>();
  const planner = new StockPlanner(ctx.db, userId, ctx.commandId, ctx.now);
  await planner.load(garmentRows.map((g) => g.garment_id));
  const batchId = newId('bat');
  const items: { garmentId: string; name: string; lotId: string; quantity: number }[] = [];
  for (const g of garmentRows) {
    for (const lot of planner.lotsOf(g.garment_id)) {
      const qty = planner.countsAt(lot.lot_id, at).hamper;
      if (qty > 0) {
        planner.add(g.garment_id, { kind: 'batch_collect', qty, batchId }, at, { batchId }, lot.lot_id);
        items.push({ garmentId: g.garment_id, name: g.name, lotId: lot.lot_id, quantity: qty });
      }
    }
  }
  const stock = planner.finalize();
  const statements: D1PreparedStatement[] = [
    ctx.db
      .prepare("INSERT INTO laundry_batches (user_id, batch_id, channel, status, collected_at, command_id, version) VALUES (?, ?, 'service', 'collected', ?, ?, 1)")
      .bind(userId, batchId, at, ctx.commandId),
    ...items.map((i) =>
      ctx.db
        .prepare('INSERT INTO laundry_batch_items (user_id, batch_id, lot_id, garment_id, quantity) VALUES (?, ?, ?, ?, ?)')
        .bind(userId, batchId, i.lotId, i.garmentId, i.quantity),
    ),
    ...stock.statements,
  ];
  const units = items.reduce((n, i) => n + i.quantity, 0);
  return {
    occurredAt: at,
    guards: stock.guards,
    statements,
    affected: [{ entityType: 'laundry_batch', entityId: batchId, version: 1, change: 'created' }, ...stock.affected],
    summary: units ? `Laundry collected: ${units} item(s) — ${items.map((i) => i.name + (i.quantity > 1 ? ` ×${i.quantity}` : '')).join(', ')}.` : 'Laundry collected: the hamper was empty on record, so the batch is empty.',
    facts: { batchId, items, units, stockNotes: stock.notes },
    undo: { kind: 'uncollect_batch', batchId, versionAfter: 1, movementIds: planner.newMovementIds() },
    effects: [revalidationEffect(ctx.commandId, items.map((i) => i.garmentId), 'laundry_collected')],
  };
}

interface BatchRow {
  batch_id: string;
  status: string;
  collected_at: string;
  returned_at: string | null;
  version: number;
}
interface BatchItemRow {
  lot_id: string;
  garment_id: string;
  quantity: number;
  returned_qty: number;
  status: string;
}

export async function laundryReturned(ctx: HandlerContext<CommandOf<'laundry_returned' | 'laundry_partial_return'>>): Promise<CommandPlan> {
  const c = ctx.command;
  const userId = ctx.principal.userId;
  const at = occurred(ctx, c.occurredAt);
  const batch = c.batchId
    ? await ctx.db.prepare('SELECT * FROM laundry_batches WHERE user_id = ? AND batch_id = ?').bind(userId, c.batchId).first<BatchRow>()
    : await ctx.db
        .prepare("SELECT * FROM laundry_batches WHERE user_id = ? AND status IN ('collected', 'partially_returned') ORDER BY collected_at LIMIT 1")
        .bind(userId)
        .first<BatchRow>();
  if (!batch) {
    if (c.batchId) throw new DomainError('not_found', `No laundry batch ${c.batchId}`, { entityType: 'laundry_batch', entityId: c.batchId });
    throw new DomainError('invalid_state', 'No laundry batch is away');
  }
  if (batch.status === 'returned' || batch.status === 'voided') throw new DomainError('invalid_state', `That batch is already ${batch.status}`);
  if (Date.parse(at) < Date.parse(batch.collected_at)) throw new DomainError('validation_failed', 'A batch cannot return before it was collected');
  const { results: items } = await ctx.db
    .prepare('SELECT lot_id, garment_id, quantity, returned_qty, status FROM laundry_batch_items WHERE user_id = ? AND batch_id = ?')
    .bind(userId, batch.batch_id)
    .all<BatchItemRow>();
  const garments = await requireGarments(ctx.db, userId, items.map((i) => i.garment_id));

  const exceptionQty = new Map<string, number | undefined>();
  for (const e of c.exceptions ?? []) {
    const inBatch = items.filter((i) => i.garment_id === e.garmentId && i.quantity > i.returned_qty);
    if (!inBatch.length) throw new DomainError('validation_failed', 'An exception names an item that is not away in this batch', { garmentId: e.garmentId, batchId: batch.batch_id });
    exceptionQty.set(e.garmentId, e.quantity);
  }

  const planner = new StockPlanner(ctx.db, userId, ctx.commandId, ctx.now);
  await planner.load(items.map((i) => i.garment_id));
  const statements: D1PreparedStatement[] = [];
  const returned: { garmentId: string; name: string; quantity: number }[] = [];
  const stillAway: { garmentId: string; name: string; quantity: number }[] = [];
  const newExceptionIds: string[] = [];
  let allReturned = true;
  for (const item of items) {
    const outstanding = item.quantity - item.returned_qty;
    if (outstanding <= 0) continue;
    const hasException = exceptionQty.has(item.garment_id);
    const exc = hasException ? Math.min(exceptionQty.get(item.garment_id) ?? outstanding, outstanding) : 0;
    if (hasException) exceptionQty.set(item.garment_id, Math.max(0, (exceptionQty.get(item.garment_id) ?? outstanding) - exc));
    const ret = outstanding - exc;
    const name = garments.get(item.garment_id)!.name;
    if (ret > 0) {
      planner.add(item.garment_id, { kind: 'batch_return', qty: ret, batchId: batch.batch_id }, at, { batchId: batch.batch_id }, item.lot_id);
      returned.push({ garmentId: item.garment_id, name, quantity: ret });
    }
    const newReturned = item.returned_qty + ret;
    if (newReturned < item.quantity) allReturned = false;
    statements.push(
      ctx.db
        .prepare('UPDATE laundry_batch_items SET returned_qty = ?, status = ? WHERE user_id = ? AND batch_id = ? AND lot_id = ?')
        .bind(newReturned, newReturned >= item.quantity ? 'returned' : 'away', userId, batch.batch_id, item.lot_id),
    );
    if (exc > 0) {
      const exceptionId = newId('lex');
      newExceptionIds.push(exceptionId);
      stillAway.push({ garmentId: item.garment_id, name, quantity: exc });
      statements.push(
        ctx.db
          .prepare("INSERT INTO laundry_exceptions (user_id, exception_id, garment_id, kind, quantity, batch_id, occurred_at, command_id) VALUES (?, ?, ?, 'still_away', ?, ?, ?, ?)")
          .bind(userId, exceptionId, item.garment_id, exc, batch.batch_id, at, ctx.commandId),
      );
    }
  }
  // Earlier "still away" exceptions for this batch are superseded by this return's statement of reality.
  const { results: prior } = await ctx.db
    .prepare("SELECT exception_id FROM laundry_exceptions WHERE user_id = ? AND batch_id = ? AND kind = 'still_away' AND cleared_at IS NULL")
    .bind(userId, batch.batch_id)
    .all<{ exception_id: string }>();
  for (const p of prior) statements.push(clearException(ctx, p.exception_id, at));

  const stock = planner.finalize();
  const newStatus = allReturned ? 'returned' : 'partially_returned';
  statements.push(
    ctx.db
      .prepare('UPDATE laundry_batches SET status = ?, returned_at = ?, version = version + 1 WHERE user_id = ? AND batch_id = ?')
      .bind(newStatus, at, userId, batch.batch_id),
  );
  const guards: Predicate[] = [versionIs(userId, 'laundry_batch', batch.batch_id, batch.version), ...stock.guards];
  return {
    occurredAt: at,
    guards,
    statements: [...statements, ...stock.statements],
    affected: [{ entityType: 'laundry_batch', entityId: batch.batch_id, version: batch.version + 1, change: 'updated' }, ...stock.affected],
    summary: `Laundry returned: ${returned.length ? returned.map((r) => r.name + (r.quantity > 1 ? ` ×${r.quantity}` : '')).join(', ') : 'nothing'}${stillAway.length ? `. Still away: ${stillAway.map((s) => s.name + (s.quantity > 1 ? ` ×${s.quantity}` : '')).join(', ')}` : ''}.`,
    facts: { batchId: batch.batch_id, status: newStatus, returned, stillAway, stockNotes: stock.notes },
    undo: {
      kind: 'unreturn_batch',
      batchId: batch.batch_id,
      versionAfter: batch.version + 1,
      movementIds: planner.newMovementIds(),
      previousStatus: batch.status,
      previousReturnedAt: batch.returned_at,
      items: items.map((i) => ({ lotId: i.lot_id, returnedQty: i.returned_qty, status: i.status })),
      exceptionIds: newExceptionIds,
      clearedExceptionIds: prior.map((p) => p.exception_id),
    },
    effects: [revalidationEffect(ctx.commandId, items.map((i) => i.garment_id), 'laundry_returned')],
  };
}

async function openExceptionIds(db: D1Database, userId: string, garmentId: string, kinds: string[]): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT exception_id FROM laundry_exceptions WHERE user_id = ? AND garment_id = ? AND cleared_at IS NULL AND kind IN (${kinds.map(() => '?').join(',')})`)
    .bind(userId, garmentId, ...kinds)
    .all<{ exception_id: string }>();
  return results.map((r) => r.exception_id);
}

function clearException(ctx: HandlerContext, exceptionId: string, at: string): D1PreparedStatement {
  return ctx.db.prepare('UPDATE laundry_exceptions SET cleared_at = ? WHERE user_id = ? AND exception_id = ? AND cleared_at IS NULL').bind(at, ctx.principal.userId, exceptionId);
}

// ------------------------------------------------------------------ settings and weekly resets

export interface OwnerSettingsRow {
  user_id: string;
  home_location_label: string;
  timezone: string;
  delivery_time: string;
  daily_option_count: number;
  laundry_routine_json: string;
  estimator_params_json: string | null;
  wear_logging_since: string | null;
  version: number;
  updated_at: string;
}

export async function loadSettings(db: D1Database, principal: Principal): Promise<OwnerSettingsRow | null> {
  assertPrincipal(principal);
  return db.prepare('SELECT * FROM owner_settings WHERE user_id = ?').bind(principal.userId).first<OwnerSettingsRow>();
}

export function routineOf(settings: OwnerSettingsRow | null): LaundryRoutine {
  return parseJson<LaundryRoutine>(settings?.laundry_routine_json, DEFAULT_LAUNDRY_ROUTINE);
}

/** The reset cycles (most recent first) whose baseline has passed at `at`. */
export function dueCycles(routine: LaundryRoutine, timezone: string, at: string, notBefore: string, maxCycles = 8): Omit<LaundryReset, 'appliedAt'>[] {
  const out: Omit<LaundryReset, 'appliedAt'>[] = [];
  const today = localDateOf(at, timezone);
  const pools: { pool: LaundryPool; baselineDow: number | null; baselineTime: string }[] = [
    { pool: 'service', baselineDow: routine.service.baselineDow, baselineTime: routine.service.baselineTime },
    { pool: 'hand_wash', baselineDow: routine.handWash.baselineDow, baselineTime: routine.handWash.baselineTime },
  ];
  for (const p of pools) {
    if (p.baselineDow === null) continue;
    let baselineDate = previousOrSameDow(today, p.baselineDow);
    if (Date.parse(zonedInstant(baselineDate, p.baselineTime, timezone)) > Date.parse(at)) baselineDate = addDays(baselineDate, -7);
    for (let i = 0; i < maxCycles; i++) {
      const effectiveAt = zonedInstant(baselineDate, p.baselineTime, timezone);
      if (Date.parse(effectiveAt) < Date.parse(notBefore)) break;
      const cutoffAt =
        p.pool === 'service'
          ? zonedInstant(previousOrSameDow(addDays(baselineDate, -1), routine.service.collectDow), routine.service.collectTime, timezone)
          : effectiveAt;
      out.push({ pool: p.pool, cycleKey: baselineDate, cutoffAt, effectiveAt });
      baselineDate = addDays(baselineDate, -7);
    }
  }
  return out;
}

/**
 * Applies due weekly cleanliness resets once per owner, pool and cycle (idempotent; catches up after
 * missed runs). A reset is an estimate boundary only: it never records a pickup, return or movement,
 * and never touches wear history, restrictions or exceptions. Returns the resets newly applied.
 */
export async function ensureLaundryResets(db: D1Database, principal: Principal, at: string): Promise<LaundryReset[]> {
  assertPrincipal(principal);
  const settings = await loadSettings(db, principal);
  if (!settings) return [];
  const user = await db.prepare('SELECT created_at FROM users WHERE user_id = ?').bind(principal.userId).first<{ created_at: string }>();
  const routine = routineOf(settings);
  const cycles = dueCycles(routine, settings.timezone, at, user?.created_at ?? at);
  if (!cycles.length) return [];
  const appliedAt = new Date().toISOString();
  const results = await db.batch(
    cycles.map((cy) =>
      db
        .prepare('INSERT OR IGNORE INTO laundry_resets (user_id, pool, cycle_key, cutoff_at, effective_at, applied_at, routine_version) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(principal.userId, cy.pool, cy.cycleKey, cy.cutoffAt, cy.effectiveAt, appliedAt, settings.version),
    ),
  );
  return cycles.filter((_, i) => (results[i]?.meta.changes ?? 0) > 0).map((cy) => ({ ...cy, appliedAt }));
}

export async function listLaundryResets(db: D1Database, principal: Principal): Promise<LaundryReset[]> {
  assertPrincipal(principal);
  const { results } = await db
    .prepare('SELECT pool, cycle_key, cutoff_at, effective_at, applied_at FROM laundry_resets WHERE user_id = ? ORDER BY effective_at DESC')
    .bind(principal.userId)
    .all<{ pool: LaundryPool; cycle_key: string; cutoff_at: string; effective_at: string; applied_at: string }>();
  return results.map((r) => ({ pool: r.pool, cycleKey: r.cycle_key, cutoffAt: r.cutoff_at, effectiveAt: r.effective_at, appliedAt: r.applied_at }));
}

export interface LaundryState {
  batches: { batchId: string; status: string; collectedAt: string; returnedAt: string | null; version: number; items: { garmentId: string; name: string; quantity: number; returnedQuantity: number; status: string }[] }[];
  hamper: { service: { garmentId: string; name: string; quantity: number }[]; handWash: { garmentId: string; name: string; quantity: number }[] };
  openExceptions: { exceptionId: string; garmentId: string; kind: string; quantity: number; batchId: string | null; occurredAt: string }[];
}

/** Laundry sheet read model: open batches from actual membership, hamper by channel, open exceptions. */
export async function getLaundryState(db: D1Database, principal: Principal): Promise<LaundryState> {
  assertPrincipal(principal);
  const userId = principal.userId;
  const { results: batches } = await db
    .prepare("SELECT batch_id, status, collected_at, returned_at, version FROM laundry_batches WHERE user_id = ? AND status IN ('collected', 'partially_returned') ORDER BY collected_at")
    .bind(userId)
    .all<BatchRow>();
  const { results: items } = await db
    .prepare(
      `SELECT i.batch_id, i.garment_id, g.name, i.quantity, i.returned_qty, i.status FROM laundry_batch_items i
       JOIN garments g ON g.user_id = i.user_id AND g.garment_id = i.garment_id WHERE i.user_id = ?`,
    )
    .bind(userId)
    .all<{ batch_id: string; garment_id: string; name: string; quantity: number; returned_qty: number; status: string }>();
  const { results: hamper } = await db
    .prepare(
      `SELECT g.garment_id, g.name, g.care_channel, SUM(l.hamper_qty) AS qty FROM stock_lots l JOIN garments g ON g.user_id = l.user_id AND g.garment_id = l.garment_id
       WHERE l.user_id = ? GROUP BY g.garment_id HAVING qty > 0 ORDER BY g.name`,
    )
    .bind(userId)
    .all<{ garment_id: string; name: string; care_channel: string; qty: number }>();
  const { results: exceptions } = await db
    .prepare('SELECT exception_id, garment_id, kind, quantity, batch_id, occurred_at FROM laundry_exceptions WHERE user_id = ? AND cleared_at IS NULL')
    .bind(userId)
    .all<{ exception_id: string; garment_id: string; kind: string; quantity: number; batch_id: string | null; occurred_at: string }>();
  return {
    batches: batches.map((b) => ({
      batchId: b.batch_id,
      status: b.status,
      collectedAt: b.collected_at,
      returnedAt: b.returned_at,
      version: b.version,
      items: items.filter((i) => i.batch_id === b.batch_id).map((i) => ({ garmentId: i.garment_id, name: i.name, quantity: i.quantity, returnedQuantity: i.returned_qty, status: i.status })),
    })),
    hamper: {
      service: hamper.filter((h) => h.care_channel === 'service').map((h) => ({ garmentId: h.garment_id, name: h.name, quantity: h.qty })),
      handWash: hamper.filter((h) => h.care_channel === 'hand_wash').map((h) => ({ garmentId: h.garment_id, name: h.name, quantity: h.qty })),
    },
    openExceptions: exceptions.map((e) => ({ exceptionId: e.exception_id, garmentId: e.garment_id, kind: e.kind, quantity: e.quantity, batchId: e.batch_id, occurredAt: e.occurred_at })),
  };
}
