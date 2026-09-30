import type { CommandOf } from '@garderobe/contracts';
import { parseJson, rawPredicate, versionIs, type Predicate } from '../db.js';
import { DomainError } from '../errors.js';
import { requireGarment } from '../records.js';
import { StockPlanner } from '../stock/ledger.js';
import { garmentUpdate } from '../inventory.js';
import { planRetraction, planRevertAmendment } from '../wear.js';
import { loadCurrentDocument, planDocumentVersion } from '../style.js';
import { revalidationEffect, type CommandPlan, type HandlerContext, type UndoPlan } from './types.js';
import { compensateCombinations } from '../../studio/commands.js';
import { compensatePause } from '../service-pause.js';

interface ReceiptRow {
  command_id: string;
  command_type: string;
  command_class: string;
  undo_json: string | null;
  undone_by_command_id: string | null;
  receipt_json: string;
}

function changedSince(what: string): DomainError {
  return new DomainError('conflict', `${what} has changed since; undo the later change first or correct it directly`);
}

/**
 * Undo is a compensating command (spec section 3 and 8): it rechecks intervening changes, writes a
 * new receipt and marks the original as undone. Receipts are never deleted.
 */
export async function planUndo(ctx: HandlerContext<CommandOf<'undo'>>): Promise<CommandPlan> {
  const userId = ctx.principal.userId;
  const target = await ctx.db
    .prepare('SELECT command_id, command_type, command_class, undo_json, undone_by_command_id, receipt_json FROM command_receipts WHERE user_id = ? AND command_id = ?')
    .bind(userId, ctx.command.targetCommandId)
    .first<ReceiptRow>();
  if (!target) throw new DomainError('not_found', `No command ${ctx.command.targetCommandId}`, { entityType: 'command', entityId: ctx.command.targetCommandId });
  if (target.command_class === 'compensation') throw new DomainError('not_reversible', 'An undo cannot itself be undone; repeat the original action instead');
  if (target.undone_by_command_id) throw new DomainError('already_undone', 'That change has already been undone', { undoneBy: target.undone_by_command_id });
  const undo = parseJson<UndoPlan | null>(target.undo_json, null);
  if (!undo) throw new DomainError('not_reversible', 'That change cannot be undone automatically');

  const plan = await compensate(ctx, undo);
  plan.guards.push(
    rawPredicate('SELECT undone_by_command_id IS NULL FROM command_receipts WHERE user_id = ? AND command_id = ?', [userId, target.command_id], 'target not yet undone'),
  );
  plan.statements.push(
    ctx.db.prepare('UPDATE command_receipts SET undone_by_command_id = ? WHERE user_id = ? AND command_id = ? AND undone_by_command_id IS NULL').bind(ctx.commandId, userId, target.command_id),
  );
  const original = parseJson<{ summary?: string }>(target.receipt_json, {});
  plan.summary = `Undone: ${original.summary ?? target.command_type}. ${plan.summary}`.trim();
  plan.facts = { ...plan.facts, compensatesCommandId: target.command_id, compensatedType: target.command_type };
  plan.undo = null;
  plan.undoUnavailableReason = 'An undo cannot itself be undone; repeat the original action instead.';
  return plan;
}

async function compensate(ctx: HandlerContext, undo: UndoPlan): Promise<CommandPlan> {
  const userId = ctx.principal.userId;
  const db = ctx.db;
  const base = (garmentIds: string[], reason: string): CommandPlan => ({
    occurredAt: ctx.now,
    guards: [],
    statements: [],
    affected: [],
    summary: '',
    facts: {},
    undo: null,
    effects: [revalidationEffect(ctx.commandId, garmentIds, reason)],
  });
  const voidAll = async (garmentIds: string[], movementIds: string[]) => {
    const planner = new StockPlanner(db, userId, ctx.commandId, ctx.now);
    await planner.load(garmentIds);
    for (const id of movementIds) planner.void(id);
    return planner.finalize();
  };

  switch (undo.kind) {
    case 'retract_observation':
      return planRetraction(ctx, undo.observationId);
    case 'revert_amendment':
      return planRevertAmendment(ctx, undo.newObservationId, undo.previousObservationId);
    case 'void_movements': {
      const plan = base(undo.garmentIds, 'undo');
      const stock = await voidAll(undo.garmentIds, undo.movementIds);
      plan.guards.push(...stock.guards);
      plan.statements.push(...stock.statements);
      plan.affected.push(...stock.affected);
      plan.facts = { stockNotes: stock.notes };
      return plan;
    }
    case 'restore_garment':
    case 'void_item': {
      const g = await requireGarment(db, userId, undo.garmentId);
      if (g.version !== undo.versionAfter) throw changedSince(g.name);
      const plan = base([g.garment_id], 'undo');
      if (undo.kind === 'void_item') {
        const used = await db
          .prepare("SELECT COUNT(*) AS n FROM observation_items i JOIN wear_observations o ON o.user_id = i.user_id AND o.observation_id = i.observation_id WHERE i.user_id = ? AND i.garment_id = ? AND o.status = 'active'")
          .bind(userId, g.garment_id)
          .first<{ n: number }>();
        if ((used?.n ?? 0) > 0) throw new DomainError('not_reversible', `${g.name} already has recorded wears; it cannot be removed as a mistaken entry`);
      }
      const update = garmentUpdate(
        ctx,
        g,
        undo.kind === 'void_item'
          ? { acquisition: 'disposed', disposalReason: 'fabricated_entry', location: 'unknown', locationDetail: 'Removed: mistaken entry (undo of creation)' }
          : { acquisition: undo.before.acquisition, location: undo.before.location, locationDetail: undo.before.locationDetail, disposalReason: undo.before.disposalReason },
      );
      const stock = await voidAll([g.garment_id], undo.movementIds);
      plan.guards.push(update.guard, ...stock.guards);
      plan.statements.push(...update.statements, ...stock.statements);
      plan.affected.push({ entityType: 'garment', entityId: g.garment_id, version: g.version + 1, change: 'updated' }, ...stock.affected);
      if (undo.kind === 'restore_garment') {
        for (const p of undo.projectRestore ?? []) {
          plan.statements.push(
            db.prepare('UPDATE lifecycle_projects SET status = ?, actual_return = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND project_id = ?').bind(p.status, p.actualReturn, ctx.now, userId, p.projectId),
          );
        }
        for (const l of undo.orderLineRestore ?? []) {
          plan.statements.push(
            l.arrivedAt === undefined
              ? db.prepare('UPDATE order_lines SET arrived_qty = ?, status = ?, version = version + 1 WHERE user_id = ? AND line_id = ?').bind(l.arrivedQty, l.status, userId, l.lineId)
              : db.prepare('UPDATE order_lines SET arrived_qty = ?, status = ?, arrived_at = ?, version = version + 1 WHERE user_id = ? AND line_id = ?').bind(l.arrivedQty, l.status, l.arrivedAt, userId, l.lineId),
          );
        }
        for (const d of undo.deadlineRestore ?? []) {
          plan.statements.push(db.prepare('UPDATE return_deadlines SET deadline_at = ?, terms_source = ? WHERE user_id = ? AND deadline_id = ?').bind(d.deadlineAt, d.termsSource, userId, d.deadlineId));
        }
      }
      plan.summary = undo.kind === 'void_item' ? `${g.name} removed as a mistaken entry.` : `${g.name} restored.`;
      plan.facts = { garmentId: g.garment_id, stockNotes: stock.notes };
      return plan;
    }
    case 'uncollect_batch':
    case 'unreturn_batch': {
      const batch = await db.prepare('SELECT batch_id, status, version FROM laundry_batches WHERE user_id = ? AND batch_id = ?').bind(userId, undo.batchId).first<{ batch_id: string; status: string; version: number }>();
      if (!batch) throw new DomainError('not_found', `No laundry batch ${undo.batchId}`);
      if (batch.version !== undo.versionAfter) throw changedSince('The laundry batch');
      const { results: items } = await db.prepare('SELECT garment_id FROM laundry_batch_items WHERE user_id = ? AND batch_id = ?').bind(userId, undo.batchId).all<{ garment_id: string }>();
      const garmentIds = [...new Set(items.map((i) => i.garment_id))];
      const plan = base(garmentIds, 'undo');
      const stock = await voidAll(garmentIds, undo.movementIds);
      plan.guards.push(versionIs(userId, 'laundry_batch', undo.batchId, batch.version) as Predicate, ...stock.guards);
      plan.statements.push(...stock.statements);
      if (undo.kind === 'uncollect_batch') {
        plan.statements.push(db.prepare("UPDATE laundry_batches SET status = 'voided', version = version + 1 WHERE user_id = ? AND batch_id = ?").bind(userId, undo.batchId));
        plan.summary = 'The pickup record was withdrawn; its items are back in the hamper.';
      } else {
        plan.statements.push(
          db.prepare('UPDATE laundry_batches SET status = ?, returned_at = ?, version = version + 1 WHERE user_id = ? AND batch_id = ?').bind(undo.previousStatus, undo.previousReturnedAt, userId, undo.batchId),
          ...undo.items.map((i) => db.prepare('UPDATE laundry_batch_items SET returned_qty = ?, status = ? WHERE user_id = ? AND batch_id = ? AND lot_id = ?').bind(i.returnedQty, i.status, userId, undo.batchId, i.lotId)),
          ...undo.exceptionIds.map((id) => db.prepare('UPDATE laundry_exceptions SET cleared_at = ? WHERE user_id = ? AND exception_id = ?').bind(ctx.now, userId, id)),
          ...undo.clearedExceptionIds.map((id) => db.prepare('UPDATE laundry_exceptions SET cleared_at = NULL WHERE user_id = ? AND exception_id = ?').bind(userId, id)),
        );
        plan.summary = 'The return record was withdrawn; those items are away again.';
      }
      plan.affected.push({ entityType: 'laundry_batch', entityId: undo.batchId, version: batch.version + 1, change: 'updated' }, ...stock.affected);
      return plan;
    }
    case 'lift_restriction':
    case 'reinstate_restriction': {
      const r = await db.prepare('SELECT restriction_id, reason, version, lifted_at FROM restrictions WHERE user_id = ? AND restriction_id = ?').bind(userId, undo.restrictionId).first<{ restriction_id: string; reason: string; version: number; lifted_at: string | null }>();
      if (!r) throw new DomainError('not_found', `No restriction ${undo.restrictionId}`);
      if (r.version !== undo.versionAfter) throw changedSince('The restriction');
      const plan = base([], 'undo');
      plan.guards.push(versionIs(userId, 'restriction', r.restriction_id, r.version));
      plan.statements.push(
        undo.kind === 'lift_restriction'
          ? db.prepare('UPDATE restrictions SET lifted_at = ?, lift_evidence = ?, lifted_by_command = ?, version = version + 1 WHERE user_id = ? AND restriction_id = ?').bind(ctx.now, 'Withdrawn: restriction set by mistake (undo)', ctx.commandId, userId, r.restriction_id)
          : db.prepare('UPDATE restrictions SET lifted_at = NULL, lift_evidence = NULL, lifted_by_command = NULL, version = version + 1 WHERE user_id = ? AND restriction_id = ?').bind(userId, r.restriction_id),
      );
      plan.affected.push({ entityType: 'restriction', entityId: r.restriction_id, version: r.version + 1, change: 'updated' });
      plan.summary = undo.kind === 'lift_restriction' ? `Restriction withdrawn: ${r.reason}.` : `Restriction back in force: ${r.reason}.`;
      return plan;
    }
    case 'restore_selection': {
      const active = await db.prepare("SELECT selection_id, version FROM selections WHERE user_id = ? AND board_id = ? AND status = 'active'").bind(userId, undo.boardId).first<{ selection_id: string; version: number }>();
      if (!active || active.selection_id !== undo.selectionId) throw changedSince("That day's choice");
      const plan = base([], 'undo');
      plan.guards.push(versionIs(userId, 'selection', active.selection_id, active.version));
      plan.statements.push(db.prepare("UPDATE selections SET status = 'cleared', version = version + 1 WHERE user_id = ? AND selection_id = ?").bind(userId, active.selection_id));
      if (undo.previousSelectionId) {
        plan.statements.push(db.prepare("UPDATE selections SET status = 'active', version = version + 1 WHERE user_id = ? AND selection_id = ?").bind(userId, undo.previousSelectionId));
      }
      plan.affected.push({ entityType: 'selection', entityId: active.selection_id, version: active.version + 1, change: 'updated' });
      plan.effects.push({ kind: 'calendar_projection', external: true, operationKey: `calendar:${undo.boardId}:undo:${ctx.commandId}`, payload: { boardId: undo.boardId } });
      plan.summary = undo.previousSelectionId ? 'The previous choice is back.' : 'The choice was cleared.';
      return plan;
    }
    case 'revert_style_document': {
      const current = await loadCurrentDocument(db, userId, undo.documentId);
      if (!current || current.version !== undo.versionAfter) throw changedSince('My style');
      const previous = await db.prepare('SELECT body, title FROM style_documents WHERE user_id = ? AND document_id = ? AND version = ?').bind(userId, undo.documentId, undo.previousVersion).first<{ body: string; title: string }>();
      if (!previous) throw new DomainError('not_found', 'The previous version is missing');
      const v = await planDocumentVersion(ctx, current, previous.body, previous.title, 'owner_edit');
      const plan = base([], 'undo');
      plan.effects = [];
      plan.guards.push(rawPredicate('(SELECT version FROM style_documents WHERE user_id = ? AND document_id = ? AND is_current = 1) = ?', [userId, undo.documentId, current.version], 'style document version'));
      plan.statements.push(...v.statements);
      plan.affected.push({ entityType: 'style_document', entityId: undo.documentId, version: v.newVersion, change: 'created' });
      plan.summary = `My style restored to the text of version ${undo.previousVersion} (saved as version ${v.newVersion}).`;
      return plan;
    }
    case 'retire_rule': {
      const plan = base([], 'undo');
      plan.effects = [];
      plan.guards.push(rawPredicate("SELECT status = 'active' FROM style_rules WHERE user_id = ? AND rule_id = ?", [userId, undo.ruleId], 'rule active'));
      plan.statements.push(db.prepare("UPDATE style_rules SET status = 'retired', retired_at = ?, version = version + 1 WHERE user_id = ? AND rule_id = ?").bind(ctx.now, userId, undo.ruleId));
      plan.summary = 'The temporary brief was withdrawn.';
      return plan;
    }
    case 'restore_combinations':
      return compensateCombinations(ctx, undo);
    case 'end_pause':
    case 'reinstate_pauses':
      return compensatePause(ctx, undo);
  }
}
