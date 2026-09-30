import type { CommandOf } from '@garderobe/contracts';
import type { AffectedEntity } from '@garderobe/contracts';
import type { CommandPlan, HandlerContext } from '../domain/commands/types.js';
import { json, parseJson, rawPredicate } from '../domain/db.js';
import { DomainError } from '../domain/errors.js';
import { newId } from '../domain/ids.js';
import { requireGarments } from '../domain/records.js';
import { normalizeLineId, normalizeMerchant, normalizeOrderNumber } from './normalize.js';

interface OrderRow {
  order_id: string;
  merchant: string;
  merchant_order_number: string;
  currency: string;
  status: string;
  version: number;
}

interface LineRow {
  line_id: string;
  order_id: string;
  external_line_id: string;
  garment_id: string | null;
  description: string;
  spec_json: string;
  quantity: number;
  unit_price_minor: number;
  arrival_estimate: string | null;
  arrived_qty: number;
  refunded_minor: number;
  remake_of_line_id: string | null;
  status: string;
  version: number;
}

async function loadOrder(db: D1Database, userId: string, merchant: string, number: string) {
  const order = await db.prepare('SELECT * FROM orders WHERE user_id = ? AND merchant = ? AND merchant_order_number = ?').bind(userId, merchant, number).first<OrderRow>();
  if (!order) return { order: null, lines: [] as LineRow[] };
  const { results } = await db.prepare('SELECT * FROM order_lines WHERE user_id = ? AND order_id = ?').bind(userId, order.order_id).all<LineRow>();
  return { order, lines: results };
}

/**
 * import_order: create or enrich an order from evidence. Never creates garments or stock, and never
 * marks anything arrived. Repeated imports of the same merchant/order/line identity merge.
 */
export async function importOrder(ctx: HandlerContext<CommandOf<'import_order'>>): Promise<CommandPlan> {
  const c = ctx.command;
  const userId = ctx.principal.userId;
  const merchant = normalizeMerchant(c.merchant);
  const number = normalizeOrderNumber(c.merchantOrderNumber);
  const linkIds = c.lines.map((l) => l.garmentId).filter((x): x is string => Boolean(x));
  if (linkIds.length) await requireGarments(ctx.db, userId, linkIds); // hallucinated garment ids fail here

  const { order, lines } = await loadOrder(ctx.db, userId, merchant, number);
  const statements: D1PreparedStatement[] = [];
  const guards = [];
  const affected: AffectedEntity[] = [];
  const orderId = order?.order_id ?? newId('ord');
  if (order && order.currency !== c.currency) {
    throw new DomainError('validation_failed', `Order ${merchant} ${number} is recorded in ${order.currency}, not ${c.currency}`);
  }
  if (!order) {
    guards.push(rawPredicate('(SELECT COUNT(*) FROM orders WHERE user_id = ? AND merchant = ? AND merchant_order_number = ?) = 0', [userId, merchant, number], 'order not yet imported'));
    statements.push(
      ctx.db
        .prepare('INSERT INTO orders (user_id, order_id, merchant, merchant_order_number, ordered_at, currency, source_ref, status, created_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)')
        .bind(userId, orderId, merchant, number, new Date(c.orderedAt).toISOString(), c.currency, c.sourceRef, 'placed', ctx.now),
    );
  }
  const existingByExt = new Map(lines.map((l) => [l.external_line_id, l]));
  const newByExt = new Map<string, string>();
  const created: string[] = [];
  const enriched: string[] = [];
  const unchanged: string[] = [];
  const remakes: { lineId: string; originalLineId: string }[] = [];

  for (const input of c.lines) {
    const ext = normalizeLineId(input.externalLineId);
    const prev = existingByExt.get(ext);
    if (prev) {
      const spec = { ...parseJson<Record<string, string>>(prev.spec_json, {}), ...(input.spec ?? {}) };
      const arrival = input.arrivalEstimate ?? prev.arrival_estimate;
      const garmentId = input.garmentId ?? prev.garment_id;
      const changed = json(spec) !== prev.spec_json || arrival !== prev.arrival_estimate || garmentId !== prev.garment_id;
      if (prev.quantity !== input.quantity || prev.unit_price_minor !== input.unitPriceMinor) {
        throw new DomainError('conflict', `Line ${ext} of ${merchant} ${number} was recorded with a different quantity or price; review it rather than doubling it`, {
          lineId: prev.line_id,
          recorded: { quantity: prev.quantity, unitPriceMinor: prev.unit_price_minor },
          incoming: { quantity: input.quantity, unitPriceMinor: input.unitPriceMinor },
        });
      }
      if (changed) {
        statements.push(
          ctx.db
            .prepare('UPDATE order_lines SET spec_json = ?, arrival_estimate = ?, garment_id = ?, version = version + 1 WHERE user_id = ? AND line_id = ? AND version = ?')
            .bind(json(spec), arrival, garmentId, userId, prev.line_id, prev.version),
        );
        guards.push(rawPredicate('(SELECT version FROM order_lines WHERE user_id = ? AND line_id = ?) = ?', [userId, prev.line_id, prev.version], `order line ${prev.line_id} version`));
        affected.push({ entityType: 'order_line', entityId: prev.line_id, version: prev.version + 1, change: 'updated' });
        enriched.push(prev.line_id);
      } else {
        unchanged.push(prev.line_id);
      }
      continue;
    }
    if (newByExt.has(ext)) throw new DomainError('validation_failed', `Line ${ext} appears twice in one import`);
    const lineId = newId('oln');
    newByExt.set(ext, lineId);
    let remakeOf: string | null = null;
    if (input.remakeOfExternalLineId) {
      const origExt = normalizeLineId(input.remakeOfExternalLineId);
      remakeOf = existingByExt.get(origExt)?.line_id ?? newByExt.get(origExt) ?? null;
      if (!remakeOf) throw new DomainError('not_found', `The original line ${origExt} of this remake is not recorded`);
      remakes.push({ lineId, originalLineId: remakeOf });
    }
    statements.push(
      ctx.db
        .prepare(
          `INSERT INTO order_lines (user_id, line_id, order_id, external_line_id, garment_id, description, spec_json, quantity, unit_price_minor, currency, arrival_estimate, remake_of_line_id, status, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .bind(userId, lineId, orderId, ext, input.garmentId ?? null, input.description, json(input.spec ?? {}), input.quantity, input.unitPriceMinor, c.currency, input.arrivalEstimate ?? null, remakeOf, remakeOf ? 'remake_ordered' : 'ordered'),
    );
    affected.push({ entityType: 'order_line', entityId: lineId, version: 1, change: 'created' });
    created.push(lineId);
  }
  // A remake replaces its original: the original stops counting as outstanding ownership.
  for (const r of remakes) {
    const orig = lines.find((l) => l.line_id === r.originalLineId);
    if (orig) {
      statements.push(ctx.db.prepare("UPDATE order_lines SET status = 'replaced_by_remake', version = version + 1 WHERE user_id = ? AND line_id = ?").bind(userId, orig.line_id));
      affected.push({ entityType: 'order_line', entityId: orig.line_id, version: orig.version + 1, change: 'updated' });
    }
  }
  const merged = created.length === 0 && enriched.length === 0;
  return {
    occurredAt: ctx.now,
    outcome: merged ? 'merged' : 'committed',
    guards,
    statements,
    affected,
    summary: merged
      ? `${merchant} order ${number} was already recorded; nothing changed.`
      : `${order ? 'Updated' : 'Recorded'} ${merchant} order ${number}: ${created.length} new line(s)${enriched.length ? `, ${enriched.length} enriched` : ''}. Nothing is marked arrived.`,
    facts: { orderId, merchant, merchantOrderNumber: number, createdLineIds: created, enrichedLineIds: enriched, unchangedLineIds: unchanged, remakes, arrivalRecorded: false },
    undo: null,
    undoUnavailableReason: 'Orders are corrected with a later order event, not undone.',
    effects: [],
  };
}

const EVENT_STATUS: Record<CommandOf<'record_order_event'>['event'], string> = {
  dispatched: 'dispatched',
  cancelled: 'cancelled',
  refunded: 'refunded',
  return_requested: 'return_requested',
  return_posted: 'return_posted',
  return_received: 'return_received',
  exchange_requested: 'exchange_requested',
};

/**
 * record_order_event: dispatch, cancellation, refund and return messages enrich the existing order.
 * A dispatch is never an arrival; a cancellation cannot cancel a line that already arrived.
 */
export async function recordOrderEvent(ctx: HandlerContext<CommandOf<'record_order_event'>>): Promise<CommandPlan> {
  const c = ctx.command;
  const userId = ctx.principal.userId;
  const merchant = normalizeMerchant(c.merchant);
  const number = normalizeOrderNumber(c.merchantOrderNumber);
  const { order, lines } = await loadOrder(ctx.db, userId, merchant, number);
  if (!order) throw new DomainError('not_found', `No recorded ${merchant} order ${number}; import the order confirmation first`, { merchant, merchantOrderNumber: number });
  const wanted = c.externalLineIds?.map(normalizeLineId);
  const target = wanted ? lines.filter((l) => wanted.includes(l.external_line_id)) : lines.filter((l) => l.status !== 'replaced_by_remake');
  if (wanted && target.length !== wanted.length) {
    const missing = wanted.filter((w) => !lines.some((l) => l.external_line_id === w));
    throw new DomainError('not_found', `Order ${number} has no line(s) ${missing.join(', ')}`, { missing });
  }
  const statements: D1PreparedStatement[] = [];
  const affected: AffectedEntity[] = [];
  const warnings: string[] = [];
  const status = EVENT_STATUS[c.event];
  let refundLeft = c.refundMinor ?? 0;
  for (const l of target) {
    let newStatus = status;
    let refunded = l.refunded_minor;
    if (c.event === 'cancelled' && l.arrived_qty > 0) {
      warnings.push(`${l.description} already arrived; a cancellation cannot remove it. Record a return instead.`);
      continue;
    }
    if (c.event === 'dispatched' && l.status !== 'ordered' && l.status !== 'remake_ordered') {
      warnings.push(`${l.description} is ${l.status}; the dispatch notice adds only its estimate.`);
      newStatus = l.status;
    }
    if (c.event === 'refunded') {
      const max = l.quantity * l.unit_price_minor - l.refunded_minor;
      const share = target.length === 1 ? refundLeft : Math.min(refundLeft, max);
      if (share > max) throw new DomainError('validation_failed', `A refund of ${share} exceeds what was paid for ${l.description}`);
      refunded = l.refunded_minor + share;
      refundLeft -= share;
      newStatus = refunded >= l.quantity * l.unit_price_minor ? 'refunded' : 'partially_refunded';
    }
    statements.push(
      ctx.db
        .prepare('UPDATE order_lines SET status = ?, arrival_estimate = COALESCE(?, arrival_estimate), refunded_minor = ?, version = version + 1 WHERE user_id = ? AND line_id = ?')
        .bind(newStatus, c.arrivalEstimate ?? null, refunded, userId, l.line_id),
    );
    affected.push({ entityType: 'order_line', entityId: l.line_id, version: l.version + 1, change: 'updated' });
  }
  if (refundLeft > 0) throw new DomainError('validation_failed', 'The refund exceeds the amount paid for the named lines');
  statements.push(ctx.db.prepare('UPDATE orders SET status = ?, version = version + 1 WHERE user_id = ? AND order_id = ?').bind(status, userId, order.order_id));
  return {
    occurredAt: c.occurredAt ? new Date(c.occurredAt).toISOString() : ctx.now,
    guards: [],
    statements,
    affected,
    summary: `${merchant} order ${number}: ${c.event.replace('_', ' ')} recorded for ${affected.length} line(s).${c.event === 'dispatched' ? ' Dispatch is not arrival.' : ''}`,
    facts: { orderId: order.order_id, event: c.event, lineIds: affected.map((a) => a.entityId), warnings, arrivalRecorded: false, sourceRef: c.sourceRef },
    undo: null,
    undoUnavailableReason: 'Order events are corrected by a later event.',
    effects: [],
  };
}
