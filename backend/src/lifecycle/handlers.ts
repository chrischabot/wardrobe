import { LIFECYCLE_DEPARTURE_STATUS, LIFECYCLE_STATUSES, type AffectedEntity, type CommandOf, type LifecycleProjectKind } from '@garderobe/contracts';
import { revalidationEffect, type CommandPlan, type HandlerContext } from '../domain/commands/types.js';
import { json, parseJson, rawPredicate } from '../domain/db.js';
import { DomainError, notFound } from '../domain/errors.js';
import { newId } from '../domain/ids.js';
import { disposeItem } from '../domain/inventory.js';
import { OWNER_CHANNELS } from '../domain/principal.js';
import { requireGarment, requireGarments } from '../domain/records.js';
import { localId, mergeChildPlans } from './plan-utils.js';
import { arrivalDate, computeDeadline } from './deadlines.js';

const NUMBER_WORDS: Record<number, string[]> = {
  7: ['seven'],
  10: ['ten'],
  14: ['fourteen', 'two weeks', 'two-week'],
  21: ['twenty-one', 'twenty one', 'three weeks'],
  28: ['twenty-eight', 'twenty eight', 'four weeks'],
  30: ['thirty'],
  60: ['sixty'],
  90: ['ninety'],
};

/** True when the quoted terms actually state the claimed window. */
export function quoteStatesWindow(quote: string, days: number): boolean {
  const q = quote.toLowerCase();
  if (new RegExp(`(^|[^0-9])${days}\\s*(-\\s*)?(calendar\\s+|working\\s+|business\\s+)?days?`).test(q)) return true;
  return (NUMBER_WORDS[days] ?? []).some((w) => q.includes(w));
}

/**
 * record_return_terms: a deadline exists only when sourced terms state the window and the trigger
 * date is real. Delivery-triggered windows require a recorded arrival; otherwise the deadline stays
 * unresolved research rather than a speculative countdown.
 */
export async function recordReturnTerms(ctx: HandlerContext<CommandOf<'record_return_terms'>>): Promise<CommandPlan> {
  const c = ctx.command;
  const userId = ctx.principal.userId;
  const line = await ctx.db
    .prepare('SELECT line_id, description, arrived_qty, arrived_at, garment_id, status, version FROM order_lines WHERE user_id = ? AND line_id = ?')
    .bind(userId, c.lineId)
    .first<{ line_id: string; description: string; arrived_qty: number; arrived_at: string | null; garment_id: string | null; status: string; version: number }>();
  if (!line) throw notFound('order_line', c.lineId);
  if (!quoteStatesWindow(c.terms.quote, c.terms.windowDays)) {
    throw new DomainError('evidence_required', `The quoted terms do not state a ${c.terms.windowDays}-day window; the deadline stays unresolved`, { windowDays: c.terms.windowDays });
  }
  if (c.trigger.event === 'delivery' && line.arrived_qty === 0) {
    throw new DomainError('evidence_required', `${line.description} has no recorded arrival, so a delivery-based deadline cannot be computed yet`, { lineId: line.line_id });
  }
  // A delivery window counts from the recorded arrival, whatever date the caller supplied.
  let trigger = c.trigger;
  let note = '';
  if (c.trigger.event === 'delivery') {
    const recorded = arrivalDate(line.arrived_at ?? (await receivedAt(ctx.db, userId, line.garment_id)), c.timezone);
    if (recorded && recorded !== c.trigger.date) {
      trigger = { event: 'delivery', date: recorded, evidence: `recorded arrival on ${recorded}` };
      note = ` Counted from the recorded arrival on ${recorded}, not ${c.trigger.date}.`;
    }
  }
  const { deadlineDate, deadlineAt, reminderDates: reminders } = computeDeadline(trigger.date, c.terms.windowDays, c.timezone, ctx.now);
  const deadlineId = newId('ddl');
  const termsSource = { sourceRef: c.terms.sourceRef, quote: c.terms.quote, windowDays: c.terms.windowDays, trigger, ...(trigger !== c.trigger ? { statedTrigger: c.trigger } : {}) };
  return {
    occurredAt: ctx.now,
    guards: [],
    statements: [
      ctx.db
        .prepare('INSERT INTO return_deadlines (user_id, deadline_id, line_id, kind, deadline_at, timezone, terms_source, checked_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(userId, deadlineId, line.line_id, c.kind, deadlineAt, c.timezone, json(termsSource), new Date(c.terms.checkedAt).toISOString(), 'open'),
    ],
    affected: [{ entityType: 'order_line', entityId: line.line_id, version: line.version, change: 'updated' }],
    summary: `Return ${c.kind.replace('_', ' ')} deadline for ${line.description}: ${deadlineDate} (${c.terms.windowDays} days from ${trigger.event} on ${trigger.date}, per ${c.terms.sourceRef}).${note}`,
    facts: { deadlineId, lineId: line.line_id, kind: c.kind, deadlineDate, deadlineAt, timezone: c.timezone, reminderDates: reminders, termsSource },
    undo: null,
    undoUnavailableReason: 'Record corrected terms instead.',
    effects: [],
  };
}

/** Arrival instant for lines that arrived before arrived_at was recorded: the garment's latest active mark_arrived receipt movement. */
async function receivedAt(db: D1Database, userId: string, garmentId: string | null): Promise<string | null> {
  if (!garmentId) return null;
  const row = await db
    .prepare(
      `SELECT MAX(m.occurred_at) AS at FROM stock_movements m JOIN command_receipts r ON r.user_id = m.user_id AND r.command_id = m.command_id
       WHERE m.user_id = ? AND m.garment_id = ? AND m.kind = 'receive' AND m.voided_at IS NULL AND r.command_type = 'mark_arrived'`,
    )
    .bind(userId, garmentId)
    .first<{ at: string | null }>();
  return row?.at ?? null;
}

/**
 * record_comfort_feedback: one observation scoped to what is known. Only an explicit, quoted owner
 * instruction becomes a standing direction, scoped to that garment (and activity, when named). No
 * universal ban, no medical claim.
 */
export async function recordComfortFeedback(ctx: HandlerContext<CommandOf<'record_comfort_feedback'>>): Promise<CommandPlan> {
  const c = ctx.command;
  const userId = ctx.principal.userId;
  const garment = c.garmentId ? await requireGarment(ctx.db, userId, c.garmentId) : null;
  const feedbackId = localId('cfb');
  const scope = [garment ? garment.name : c.combinationRef, c.activity, c.layer].filter(Boolean).join(' · ');
  const statements: D1PreparedStatement[] = [
    ctx.db
      .prepare(
        `INSERT INTO comfort_feedback (user_id, feedback_id, garment_id, combination_ref, wearing_date, activity, layer, conditions_json, text, scope, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(userId, feedbackId, c.garmentId ?? null, c.combinationRef ?? null, c.wearingDate ?? null, c.activity ?? null, c.layer ?? null, json(c.conditions ?? {}), c.text, c.standingInstruction ? 'standing_rule' : 'observation', ctx.now),
  ];
  let ruleId: string | null = null;
  if (c.standingInstruction && garment) {
    if (!OWNER_CHANNELS.includes(ctx.envelope.source) || ctx.principal.authenticatedBy === 'scheduler') {
      throw new DomainError('evidence_required', 'Only the owner can turn feedback into a standing direction');
    }
    ruleId = newId('rule');
    const appliesTo = c.standingInstruction.appliesTo ?? (c.activity ? { activity: c.activity } : {});
    const where = [appliesTo.activity, appliesTo.setting].filter(Boolean).join(', ');
    statements.push(
      ctx.db
        .prepare(
          `INSERT INTO style_rules (user_id, rule_id, rule_key, kind, strength, category, statement, interpretation, machine_json, exception_policy, passage_status, status, source, created_at, created_by_command)
           VALUES (?, ?, ?, 'standing_direction', 'hard', 'comfort', ?, ?, ?, 'owner_scoped', 'not_applicable', 'active', 'owner_comfort', ?, ?)`,
        )
        .bind(
          userId,
          ruleId,
          `comfort.${feedbackId}`,
          c.standingInstruction.ownerQuote,
          `Owner instruction about ${garment.name}${where ? ` for ${where}` : ''} only; it is not a ban on the garment elsewhere or on its category.`,
          json({ excludeGarmentIds: [garment.garment_id], when: appliesTo, feedbackId }),
          ctx.now,
          ctx.commandId,
        ),
    );
  }
  return {
    occurredAt: ctx.now,
    guards: [],
    statements,
    affected: garment ? [{ entityType: 'garment', entityId: garment.garment_id, version: garment.version, change: 'updated' }] : [],
    summary: ruleId
      ? `Noted, and ${garment!.name} will not be suggested ${c.standingInstruction?.appliesTo?.activity ?? c.activity ? `for ${c.standingInstruction?.appliesTo?.activity ?? c.activity}` : 'again until you say otherwise'}.`
      : `Noted for ${scope || 'this outfit'}: “${c.text}”.`,
    facts: { feedbackId, scope: scope || null, standingRuleId: ruleId, universal: false, knownConditions: c.conditions ?? {} },
    undo: ruleId ? { kind: 'retire_rule', ruleId } : null,
    undoUnavailableReason: ruleId ? undefined : 'Feedback is kept as an observation; it changes nothing permanent.',
    effects: garment ? [revalidationEffect(ctx.commandId, [garment.garment_id], 'comfort_feedback')] : [],
  };
}

interface ProjectRow {
  project_id: string;
  kind: LifecycleProjectKind;
  status: string;
  details_json: string;
  expected_return: string | null;
  actual_return: string | null;
  version: number;
}

const RESTRICTING_KINDS: Partial<Record<LifecycleProjectKind, 'for_sale' | 'return_pending'>> = { sale: 'for_sale', consignment: 'for_sale', return: 'return_pending' };
const TERMINAL = new Set(['collected', 'refunded', 'returned', 'retrieved', 'withdrawn']);

/** open_lifecycle_project: a durable project. For-sale and return stock stays owned but leaves ordinary planning. */
export async function openLifecycleProject(ctx: HandlerContext<CommandOf<'open_lifecycle_project'>>): Promise<CommandPlan> {
  const c = ctx.command;
  const userId = ctx.principal.userId;
  const garments = await requireGarments(ctx.db, userId, c.garmentIds);
  for (const g of garments.values()) {
    if (g.acquisition === 'disposed') throw new DomainError('invalid_state', `${g.name} has already left the wardrobe`);
  }
  const placeholders = c.garmentIds.map(() => '?').join(',');
  const { results: open } = await ctx.db
    .prepare(
      `SELECT i.garment_id, p.project_id, p.kind, p.status FROM lifecycle_project_items i JOIN lifecycle_projects p ON p.user_id = i.user_id AND p.project_id = i.project_id
       WHERE i.user_id = ? AND i.garment_id IN (${placeholders})`,
    )
    .bind(userId, ...c.garmentIds)
    .all<{ garment_id: string; project_id: string; kind: string; status: string }>();
  const clash = open.find((o) => !TERMINAL.has(o.status) && o.kind === c.kind);
  if (clash) throw new DomainError('conflict', `${garments.get(clash.garment_id)?.name} is already in an open ${c.kind} project`, { projectId: clash.project_id });

  const projectId = newId('prj');
  const restrictionKind = RESTRICTING_KINDS[c.kind];
  const restrictionId = restrictionKind ? newId('rst') : null;
  const details = { ...c.details, ...(restrictionId ? { restrictionId } : {}) };
  const statements: D1PreparedStatement[] = [
    ctx.db
      .prepare('INSERT INTO lifecycle_projects (user_id, project_id, kind, status, details_json, expected_return, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)')
      .bind(userId, projectId, c.kind, 'preparing', json(details), c.expectedReturn ?? null, ctx.now, ctx.now),
    ...c.garmentIds.map((gid) => ctx.db.prepare('INSERT INTO lifecycle_project_items (user_id, project_id, garment_id, quantity) VALUES (?, ?, ?, 1)').bind(userId, projectId, gid)),
  ];
  const affected: AffectedEntity[] = [{ entityType: 'lifecycle_project', entityId: projectId, version: 1, change: 'created' }];
  if (restrictionId && restrictionKind) {
    statements.push(
      ctx.db
        .prepare(
          `INSERT INTO restrictions (user_id, restriction_id, kind, scope_json, reason, starts_at, required_evidence, created_by_command, version)
           VALUES (?, ?, ?, ?, ?, ?, 'any_owner_command', ?, 1)`,
        )
        .bind(userId, restrictionId, restrictionKind, json({ garmentIds: c.garmentIds }), `${c.kind} project ${projectId}`, ctx.now, ctx.commandId),
    );
    affected.push({ entityType: 'restriction', entityId: restrictionId, version: 1, change: 'created' });
  }
  const names = c.garmentIds.map((id) => garments.get(id)!.name);
  return {
    occurredAt: ctx.now,
    guards: [],
    statements,
    affected,
    summary: `Opened a ${c.kind} project for ${names.join(', ')}.${restrictionKind === 'for_sale' ? ' They stay owned, and out of daily outfits, until they physically leave.' : ''}`,
    facts: { projectId, kind: c.kind, status: 'preparing', garmentIds: c.garmentIds, restrictionId, stillOwned: true, categoryVerdict: null },
    undo: null,
    undoUnavailableReason: 'Withdraw the project to reverse it.',
    effects: restrictionId ? [revalidationEffect(ctx.commandId, c.garmentIds, 'lifecycle_project_opened')] : [],
  };
}

/**
 * advance_lifecycle_project: forward-only status changes. "Sold" keeps stock owned; the departure
 * status (collected / posted) retires it through the ordinary disposal plan in the same batch.
 */
export async function advanceLifecycleProject(ctx: HandlerContext<CommandOf<'advance_lifecycle_project'>>): Promise<CommandPlan> {
  const c = ctx.command;
  const userId = ctx.principal.userId;
  const p = await ctx.db.prepare('SELECT * FROM lifecycle_projects WHERE user_id = ? AND project_id = ?').bind(userId, c.projectId).first<ProjectRow>();
  if (!p) throw notFound('lifecycle_project', c.projectId);
  const statuses = LIFECYCLE_STATUSES[p.kind];
  if (!statuses.includes(c.status)) throw new DomainError('validation_failed', `A ${p.kind} project has no status “${c.status}” (use ${statuses.join(', ')})`);
  if (TERMINAL.has(p.status)) throw new DomainError('invalid_state', `This ${p.kind} project is already ${p.status}`);
  if (c.status !== 'withdrawn' && statuses.indexOf(c.status) <= statuses.indexOf(p.status)) {
    throw new DomainError('invalid_state', `The project is ${p.status}; it cannot move back to ${c.status}`);
  }
  const { results: items } = await ctx.db.prepare('SELECT garment_id FROM lifecycle_project_items WHERE user_id = ? AND project_id = ?').bind(userId, p.project_id).all<{ garment_id: string }>();
  const details: Record<string, unknown> = { ...parseJson<Record<string, unknown>>(p.details_json, {}), ...(c.details ?? {}) };
  if (c.proceedsMinor !== undefined) details.proceedsMinor = c.proceedsMinor;
  if (c.refundMinor !== undefined) details.refundMinor = c.refundMinor;
  if (c.currency) details.currency = c.currency;
  if (c.note) details.lastNote = c.note;
  const history = [...((details.history as unknown[]) ?? []), { from: p.status, to: c.status, at: ctx.now, commandId: ctx.commandId }];
  details.history = history;

  const at = c.occurredAt ? new Date(c.occurredAt).toISOString() : ctx.now;
  const departure = LIFECYCLE_DEPARTURE_STATUS[p.kind];
  const children: CommandPlan[] = [];
  if (departure && departure.status === c.status) {
    for (const item of items) {
      children.push(
        await disposeItem({
          ...ctx,
          command: { type: 'dispose_item', garmentId: item.garment_id, reason: departure.reason, note: `${p.kind} project ${p.project_id}`, occurredAt: c.occurredAt },
        } as HandlerContext<CommandOf<'dispose_item'>>),
      );
    }
  }
  const merged = mergeChildPlans(children);
  const statements: D1PreparedStatement[] = [
    ...merged.statements,
    ctx.db
      .prepare('UPDATE lifecycle_projects SET status = ?, details_json = ?, actual_return = ?, updated_at = ?, version = version + 1 WHERE user_id = ? AND project_id = ?')
      .bind(c.status, json(details), ['returned', 'retrieved'].includes(c.status) ? at.slice(0, 10) : p.actual_return, ctx.now, userId, p.project_id),
  ];
  const restrictionId = typeof details.restrictionId === 'string' ? details.restrictionId : null;
  const liftRestriction = restrictionId && (c.status === 'withdrawn' || (departure && departure.status === c.status));
  if (liftRestriction) {
    statements.push(
      ctx.db
        .prepare('UPDATE restrictions SET lifted_at = ?, lift_evidence = ?, lifted_by_command = ?, version = version + 1 WHERE user_id = ? AND restriction_id = ? AND lifted_at IS NULL')
        .bind(at, `${p.kind} project ${c.status}`, ctx.commandId, userId, restrictionId),
    );
  }
  if (p.kind === 'return' && c.status === 'refunded' && typeof details.orderLineId === 'string' && c.refundMinor !== undefined) {
    statements.push(
      ctx.db
        .prepare("UPDATE order_lines SET refunded_minor = refunded_minor + ?, status = CASE WHEN refunded_minor + ? >= quantity * unit_price_minor THEN 'refunded' ELSE 'partially_refunded' END, version = version + 1 WHERE user_id = ? AND line_id = ?")
        .bind(c.refundMinor, c.refundMinor, userId, details.orderLineId),
    );
  }
  const gone = departure?.status === c.status;
  const stillOwned = !gone;
  const label: Record<string, string> = { listed: 'for sale', sold: 'sold (still here until collected)', collected: 'collected and gone', posted: 'posted and gone' };
  return {
    occurredAt: at,
    guards: [...merged.guards, rawPredicate('(SELECT version FROM lifecycle_projects WHERE user_id = ? AND project_id = ?) = ?', [userId, p.project_id, p.version], 'project version')],
    statements,
    affected: [...merged.affected, { entityType: 'lifecycle_project', entityId: p.project_id, version: p.version + 1, change: 'updated' }],
    summary: `${p.kind[0]!.toUpperCase()}${p.kind.slice(1)} project: ${label[c.status] ?? c.status}.${gone ? ' Stock retired; wear history kept.' : ''}`,
    facts: { projectId: p.project_id, from: p.status, to: c.status, stillOwned, gone, disposedGarmentIds: gone ? items.map((i) => i.garment_id) : [], restrictionLifted: Boolean(liftRestriction) },
    undo: null,
    undoUnavailableReason: gone ? 'Physical departure is final; a mistaken entry is corrected with a new command.' : 'Advance or withdraw the project instead.',
    effects: merged.effects.length ? merged.effects : liftRestriction ? [revalidationEffect(ctx.commandId, items.map((i) => i.garment_id), 'lifecycle_project_changed')] : [],
  };
}
