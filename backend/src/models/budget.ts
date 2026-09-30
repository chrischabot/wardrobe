import { parseJson } from '../domain/db.js';
import type { ModelProfile, ModelTask } from './registry.js';

/**
 * Task-level spend accounting (spec section 12): reserve before dispatch, settle against reported
 * usage, keep uncertain reservations until reconciled. Budgets come from owner settings with
 * conservative defaults ($5 a month in development). The daily board keeps a reserve that
 * conversation cannot consume.
 */

export interface BudgetPolicy {
  monthlyMicroUsd: number;
  perTaskMicroUsd: Partial<Record<ModelTask, number>>;
  /** Held back for tomorrow's board (composition) from every other task. */
  boardReserveMicroUsd: number;
  /** Multiplier on the worst-case estimate covering bounded retries. */
  retryAllowance: number;
}

export const DEFAULT_BUDGET: BudgetPolicy = {
  monthlyMicroUsd: 5_000_000,
  perTaskMicroUsd: { generation: 1_000_000 },
  boardReserveMicroUsd: 200_000,
  retryAllowance: 1.5,
};

export class BudgetExhaustedError extends Error {
  readonly code = 'budget_exhausted';
  constructor(
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BudgetExhaustedError';
  }
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * A ceiling on the whole deployment's model spend over a sliding window, across every owner, task and
 * model (MODEL_SPEND_CAP_USD). It mirrors the AI Gateway's cost rule, which prices only models in the
 * gateway's catalogue: gpt-6.1-sol is not in it, so its requests are logged at $0 and never count
 * towards the gateway's $50 dev rule (checked on garderobe-dev, 2026-09-29, including with a
 * `cf-aig-custom-cost` header). The app prices every profile itself, so this cap holds Sol and Opus
 * together under the owner's limit. Unset means no deployment cap (tests, local).
 */
export interface SpendCap {
  microUsd: number;
  windowDays: number;
}

/** The gateway rule's window: 30 days (2,592,000 seconds), sliding. */
export const SPEND_CAP_WINDOW_DAYS = 30;

export function spendCapFromEnv(value: string | undefined): SpendCap | null {
  if (value === undefined || value.trim() === '') return null;
  const usd = Number(value);
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`MODEL_SPEND_CAP_USD must be a non-negative number of US dollars, got ${JSON.stringify(value)}`);
  return { microUsd: Math.round(usd * 1_000_000), windowDays: SPEND_CAP_WINDOW_DAYS };
}

const COUNTED = `CASE WHEN status IN ('reserved','uncertain') THEN reserved_micro_usd WHEN status = 'settled' THEN actual_micro_usd ELSE 0 END`;

export function costMicroUsd(profile: ModelProfile, inputTokens: number, outputTokens: number): number {
  return Math.ceil((inputTokens * profile.pricing.inputMicroUsdPerMTok + outputTokens * profile.pricing.outputMicroUsdPerMTok) / 1_000_000);
}

export async function loadBudget(db: D1Database, userId: string): Promise<BudgetPolicy> {
  const row = await db.prepare('SELECT budget_json FROM owner_settings WHERE user_id = ?').bind(userId).first<{ budget_json: string }>();
  const b = parseJson<Partial<BudgetPolicy>>(row?.budget_json, {});
  return {
    monthlyMicroUsd: typeof b.monthlyMicroUsd === 'number' ? b.monthlyMicroUsd : DEFAULT_BUDGET.monthlyMicroUsd,
    perTaskMicroUsd: { ...DEFAULT_BUDGET.perTaskMicroUsd, ...(b.perTaskMicroUsd ?? {}) },
    boardReserveMicroUsd: typeof b.boardReserveMicroUsd === 'number' ? b.boardReserveMicroUsd : DEFAULT_BUDGET.boardReserveMicroUsd,
    retryAllowance: typeof b.retryAllowance === 'number' ? b.retryAllowance : DEFAULT_BUDGET.retryAllowance,
  };
}

export interface Reservation {
  reservationId: string;
  reservedMicroUsd: number;
}

export class BudgetLedger {
  constructor(
    private readonly db: D1Database,
    private readonly userId: string,
    private readonly now: () => string,
    private readonly cap: SpendCap | null = null,
  ) {}

  private period(): string {
    return this.now().slice(0, 7);
  }

  private windowStart(): string {
    return new Date(Date.parse(this.now()) - (this.cap?.windowDays ?? SPEND_CAP_WINDOW_DAYS) * 86_400_000).toISOString();
  }

  /** Everything every owner has spent or holds reserved within the cap's window. */
  async deploymentSpent(): Promise<number> {
    const row = await this.db.prepare(`SELECT COALESCE(SUM(${COUNTED}), 0) AS n FROM model_reservations WHERE created_at >= ?`).bind(this.windowStart()).first<{ n: number }>();
    return row?.n ?? 0;
  }

  async spent(task?: ModelTask): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN status IN ('reserved', 'uncertain') THEN reserved_micro_usd WHEN status = 'settled' THEN actual_micro_usd ELSE 0 END), 0) AS n
         FROM model_reservations WHERE user_id = ? AND period = ? ${task ? 'AND task = ?' : ''}`,
      )
      .bind(...(task ? [this.userId, this.period(), task] : [this.userId, this.period()]))
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /**
   * Reserve the worst case (input + maximum output, times the retry allowance) before dispatch.
   * The check and insert run as one conditional INSERT so concurrent reservations cannot overdraw.
   */
  async reserve(input: { task: ModelTask; profile: ModelProfile; inputTokens: number; maxOutputTokens: number; runRef: string }): Promise<Reservation> {
    const policy = await loadBudget(this.db, this.userId);
    const amount = Math.ceil(costMicroUsd(input.profile, input.inputTokens, input.maxOutputTokens) * policy.retryAllowance);
    const reserveForBoard = input.task === 'composition' ? 0 : policy.boardReserveMicroUsd;
    const limit = policy.monthlyMicroUsd - reserveForBoard;
    const taskLimit = policy.perTaskMicroUsd[input.task];
    const id = `mres_${crypto.randomUUID().replace(/-/g, '')}`;
    const spentExpr = `COALESCE((SELECT SUM(${COUNTED}) FROM model_reservations WHERE user_id = ?1 AND period = ?2 %TASK%), 0)`;
    const totalExpr = spentExpr.replace('%TASK%', '');
    const taskExpr = spentExpr.replace('%TASK%', 'AND task = ?3');
    // The deployment cap (all owners, sliding window) is checked in the same conditional INSERT.
    const capExpr = `COALESCE((SELECT SUM(${COUNTED}) FROM model_reservations WHERE created_at >= ?11), 0)`;
    const result = await this.db
      .prepare(
        `INSERT INTO model_reservations (user_id, reservation_id, task, profile_id, run_ref, reserved_micro_usd, status, period, created_at)
         SELECT ?1, ?4, ?3, ?5, ?6, ?7, 'reserved', ?2, ?8
         WHERE ${totalExpr} + ?7 <= ?9 AND (?10 IS NULL OR ${taskExpr} + ?7 <= ?10) AND (?12 IS NULL OR ${capExpr} + ?7 <= ?12)`,
      )
      .bind(this.userId, this.period(), input.task, id, input.profile.profileId, input.runRef, amount, this.now(), limit, taskLimit ?? null, this.windowStart(), this.cap?.microUsd ?? null)
      .run();
    if (!result.meta.changes) {
      if (this.cap) {
        const deployment = await this.deploymentSpent();
        if (deployment + amount > this.cap.microUsd) {
          throw new BudgetExhaustedError(`The deployment's model spend limit for the last ${this.cap.windowDays} days cannot cover this ${input.task} request; it is kept and can resume when budget is available`, {
            task: input.task,
            scope: 'deployment',
            requestedMicroUsd: amount,
            spentMicroUsd: deployment,
            limitMicroUsd: this.cap.microUsd,
            windowDays: this.cap.windowDays,
          });
        }
      }
      const spent = await this.spent();
      throw new BudgetExhaustedError(`The ${input.task} budget cannot cover this request; it is kept and can resume when budget is available`, {
        task: input.task,
        requestedMicroUsd: amount,
        spentMicroUsd: spent,
        limitMicroUsd: limit,
      });
    }
    return { reservationId: id, reservedMicroUsd: amount };
  }

  async settle(reservationId: string, actualMicroUsd: number): Promise<void> {
    await this.db
      .prepare("UPDATE model_reservations SET status = 'settled', actual_micro_usd = ?, settled_at = ? WHERE user_id = ? AND reservation_id = ? AND status IN ('reserved', 'uncertain')")
      .bind(actualMicroUsd, this.now(), this.userId, reservationId)
      .run();
  }

  /** Outcome unknown (e.g. a timeout after dispatch): keep the full reservation until reconciled. */
  async markUncertain(reservationId: string): Promise<void> {
    await this.db.prepare("UPDATE model_reservations SET status = 'uncertain' WHERE user_id = ? AND reservation_id = ? AND status = 'reserved'").bind(this.userId, reservationId).run();
  }

  /** The request was never dispatched (e.g. rejected before transport). */
  async release(reservationId: string): Promise<void> {
    await this.db.prepare("UPDATE model_reservations SET status = 'released', settled_at = ? WHERE user_id = ? AND reservation_id = ? AND status = 'reserved'").bind(this.now(), this.userId, reservationId).run();
  }
}
