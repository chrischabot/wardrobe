import type { z } from "zod";
import type { AuthorizationBasis, EntityVersion, OwnerSettings, ParsedCommandEnvelope, Scope } from "@garderobe/contracts";
import type { Db, Stmt } from "../db.ts";
import type { Principal } from "../principal.ts";
import type { StockPlanner } from "../stock/planner.ts";

/** A predicate that must hold for the batch to commit. Evaluated by SQLite inside the batch. */
export interface Precondition {
  label: string;
  /** SQL boolean expression (may contain subqueries) with `?` parameters. */
  sql: string;
  params: unknown[];
  /**
   * `client`: an expected version supplied by the caller - failure is a clean conflict (plan edits) or is
   *   rebased internally (owner observations);
   * `internal`: a version this plan read - failure means a concurrent commit; the service re-plans and retries;
   * `state`: a quantity/state predicate - failure is `precondition_failed`.
   */
  class: "client" | "internal" | "state";
}

export interface PlannedEffect {
  kind: string;
  /** What the effect projects onto (e.g. the managed calendar event key). */
  targetKey: string;
  /** Stable external operation key; a repeated key is never enqueued twice. */
  operationKey: string;
  desiredRevision?: number;
  payload: Record<string, unknown>;
  availableAt?: string;
}

export interface PlannedOutbox {
  topic: string;
  entityKind: string;
  entityId: string;
  revision: number;
  payload?: Record<string, unknown>;
}

/** What changed, for commit hooks (board repair, projections) owned by other workstreams. */
export interface DomainChanges {
  /** Garments whose quantities, location, acquisition, planning policy or restrictions changed. */
  availabilityChanged: string[];
  /** Counted wears created or retracted by this command. */
  wears: { garmentId: string; wearingDate: string; change: "counted" | "merged" | "retracted" }[];
  restrictionsChanged: boolean;
  styleChanged: boolean;
  settingsChanged: boolean;
  laundryBaselineApplied: boolean;
}

export function noChanges(): DomainChanges {
  return { availabilityChanged: [], wears: [], restrictionsChanged: false, styleChanged: false, settingsChanged: false, laundryBaselineApplied: false };
}

export interface CommandPlan {
  outcome?: "committed" | "merged" | "noop";
  /** Concise factual summary built from ledger records. */
  summary: string;
  preconditions?: Precondition[];
  statements?: Stmt[];
  affected?: EntityVersion[];
  effects?: PlannedEffect[];
  outbox?: PlannedOutbox[];
  repairs?: string[];
  result?: Record<string, unknown>;
  /** Data the handler's planUndo needs; omit (with a reason) when the command cannot be undone. */
  undo?: { data: Record<string, unknown> } | { unavailableReason: string };
  changes?: Partial<DomainChanges>;
  bumpWardrobe?: boolean;
  bumpStyle?: boolean;
}

/** Extra writes a commit hook adds to the same batch (e.g. board repair by the daily service). */
export interface PlanFragment {
  preconditions?: Precondition[];
  statements?: Stmt[];
  affected?: EntityVersion[];
  effects?: PlannedEffect[];
  outbox?: PlannedOutbox[];
  repairs?: string[];
  result?: Record<string, unknown>;
}

export interface StoredCommand {
  commandId: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  recordedAt: string;
  undo: { data: Record<string, unknown> } | { unavailableReason: string } | null;
  undoneByCommandId: string | null;
  undoesCommandId: string | null;
}

export interface CommandContext {
  readonly db: Db;
  readonly principal: Principal;
  readonly userId: string;
  readonly commandId: string;
  /** When the report arrived (ISO instant). */
  readonly now: string;
  readonly nowMs: number;
  /** When the event happened; equals `now` unless the envelope said otherwise. */
  readonly occurredAt: string;
  readonly occurredAtMs: number;
  /** True when the caller supplied occurredAt explicitly. */
  readonly occurredAtExplicit: boolean;
  readonly envelope: ParsedCommandEnvelope;
  readonly settings: OwnerSettings;
  readonly settingsVersion: number;
  readonly wardrobeRevision: number;
  readonly styleRevision: number;
  newId(prefix: string): string;
  /** A stock planner bound to this command (journal + replay + balance materialization). */
  stock(): StockPlanner;
}

export interface CommandDefinition<S extends z.ZodType = z.ZodType> {
  type: string;
  schema: S;
  /**
   * `observation`: an authoritative owner observation. Client expected versions are rebased, never
   *   surfaced as a conflict. `edit`: a plan/configuration edit; a stale expected version is a conflict.
   * `system`: scheduled/administrative work.
   */
  class: "observation" | "edit" | "system";
  requiredScope: Scope;
  /** Authorization bases accepted for this command. Defaults by class (see registry). */
  allowedAuthorizations?: AuthorizationBasis[];
  plan(ctx: CommandContext, payload: z.output<S>): Promise<CommandPlan>;
  /** Builds the compensating plan. Must recheck intervening changes. */
  planUndo?(ctx: CommandContext, original: StoredCommand, data: Record<string, any>): Promise<CommandPlan>;
}

export type CommitHook = (ctx: CommandContext, plan: CommandPlan, changes: DomainChanges) => Promise<PlanFragment | void>;

/** Resolves `kind:id` expected-version keys to a SQL scalar subquery returning the current version. */
export type VersionResolver = (userId: string, id: string) => { sql: string; params: unknown[] };
