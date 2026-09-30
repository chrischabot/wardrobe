import type { AffectedEntity, CommandEnvelope, CommandType, DomainCommand, EffectKind } from '@garderobe/contracts';
import type { Predicate } from '../db.js';
import type { Principal } from '../principal.js';

export interface EffectSpec {
  kind: EffectKind;
  external: boolean;
  operationKey: string;
  payload: Record<string, unknown>;
}

/**
 * Compensation plans stored with a receipt. Undo executes them as a new command with the same
 * checks; they never delete a receipt or rewrite history.
 */
export type UndoPlan =
  | { kind: 'retract_observation'; observationId: string }
  | { kind: 'revert_amendment'; newObservationId: string; previousObservationId: string }
  | { kind: 'void_movements'; movementIds: string[]; garmentIds: string[] }
  | {
      kind: 'restore_garment';
      garmentId: string;
      versionAfter: number;
      before: { acquisition: string; location: string; locationDetail: string | null; disposalReason: string | null };
      movementIds: string[];
      projectIds?: string[];
      projectRestore?: { projectId: string; status: string; actualReturn: string | null }[];
      orderLineRestore?: { lineId: string; arrivedQty: number; status: string; arrivedAt?: string | null }[];
      /** Return deadlines an arrival recalculated (lifecycle), restored on undo. */
      deadlineRestore?: { deadlineId: string; deadlineAt: string; termsSource: string }[];
    }
  | { kind: 'void_item'; garmentId: string; versionAfter: number; movementIds: string[] }
  | { kind: 'uncollect_batch'; batchId: string; versionAfter: number; movementIds: string[] }
  | {
      kind: 'unreturn_batch';
      batchId: string;
      versionAfter: number;
      movementIds: string[];
      previousStatus: string;
      previousReturnedAt: string | null;
      items: { lotId: string; returnedQty: number; status: string }[];
      exceptionIds: string[];
      clearedExceptionIds: string[];
    }
  | { kind: 'lift_restriction'; restrictionId: string; versionAfter: number }
  | { kind: 'reinstate_restriction'; restrictionId: string; versionAfter: number }
  | { kind: 'restore_selection'; selectionId: string; previousSelectionId: string | null; boardId: string }
  | { kind: 'revert_style_document'; documentId: string; versionAfter: number; previousVersion: number }
  | { kind: 'retire_rule'; ruleId: string }
  | { kind: 'end_pause'; pauseId: string }
  | { kind: 'reinstate_pauses'; pauseIds: string[] }
  /** Studio: return saved combinations / plans to the status they had before the original command. */
  | { kind: 'restore_combinations'; changes: { combinationId: string; toStatus: 'removed' | 'active'; versionAfter: number }[] };

export interface CommandPlan {
  occurredAt: string;
  guards: Predicate[];
  statements: D1PreparedStatement[];
  affected: AffectedEntity[];
  summary: string;
  facts: Record<string, unknown>;
  outcome?: 'committed' | 'merged';
  undo: UndoPlan | null;
  undoUnavailableReason?: string;
  effects: EffectSpec[];
}

export interface HandlerContext<C extends DomainCommand = DomainCommand> {
  db: D1Database;
  principal: Principal;
  command: C;
  envelope: CommandEnvelope;
  commandId: string;
  now: string;
  attempt: number;
}

export type Handler<T extends CommandType> = (ctx: HandlerContext<Extract<DomainCommand, { type: T }>>) => Promise<CommandPlan>;

export function revalidationEffect(commandId: string, garmentIds: string[], reason: string): EffectSpec {
  return {
    kind: 'board_revalidation',
    external: false,
    operationKey: `revalidate:${commandId}`,
    payload: { garmentIds: [...new Set(garmentIds)], reason },
  };
}
