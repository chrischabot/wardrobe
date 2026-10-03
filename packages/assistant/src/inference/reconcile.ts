/**
 * Reconciling model-call reservations whose outcome is not known (specification sections 8 and 12).
 *
 * A reservation is taken before a model call is dispatched and settled when the call ends. Two things
 * leave one open: the call ended without a clear answer from the provider (a timeout, a dropped stream,
 * a stop by the owner), which the model service records as `uncertain`; or the actor was evicted between
 * the reservation and its settlement, which leaves it `reserved` with nobody left to settle it.
 *
 * This sweep closes them only on evidence:
 *   - a reservation still `reserved` long after any call could be running is recorded as `uncertain`
 *     (it was an abandoned call, and whether it was charged is not known);
 *   - an `uncertain` reservation is looked up in the provider's own record of the call. A record showing
 *     usage settles it at the cost of that usage; a record showing the call was refused or produced nothing
 *     releases it; no record leaves it exactly as it is.
 * It never guesses: without a lookup, or when the lookup finds nothing or fails, the reservation stays
 * uncertain and keeps counting against its day's budget.
 */
import { all, isCommandError, systemPrincipalFor, toInstant, type CommandService, type Db } from "@garderobe/domain";
import { actualCostMicroUsd, profileSpec } from "./registry.ts";

/** One dispatched model call, as it can be identified in the provider's record. */
export interface DispatchedCall {
  gatewayId: string;
  /** The run ID sent as Gateway metadata (`garderobe_run`). */
  runId: string;
  /** The attempt number sent as Gateway metadata (`garderobe_attempt`). */
  attempt: number;
  task: string;
  /** When the reservation was taken (the call was dispatched just after). */
  reservedAt: string;
}

export type ProviderUsageFinding =
  /** The provider's record shows the call used tokens: it is settled at the cost of that usage. */
  | { status: "charged"; inputTokens: number; outputTokens: number; resolvedModel: string | null; ref: string }
  /** The provider's record shows the call failed or was served without usage: nothing was charged. */
  | { status: "not_charged"; ref: string }
  /** The provider has no record that can be tied to this call. Not proof that nothing was charged. */
  | { status: "not_found" };

/** The provider's own record of what a dispatched call used. Production: AI Gateway logs. Tests: a labelled fake. */
export interface ProviderUsageLookup {
  find(call: DispatchedCall): Promise<ProviderUsageFinding>;
}

/** A reservation still open after this long belongs to no running call: the longest model timeout is two minutes. */
export const ABANDONED_AFTER_MS = 10 * 60_000;
/** The provider's record of a call may trail the call itself; an uncertain reservation is not looked up sooner than this. */
export const LOOKUP_NOT_BEFORE_MS = 2 * 60_000;
/** Reservations older than this are no longer looked up: they stay uncertain for good and remain reported as such. */
export const LOOKUP_WINDOW_MS = 30 * 86_400_000;

export interface ReconcileDeps {
  db: Db;
  service: CommandService;
  nowMs: number;
  /** Absent: abandoned reservations are still marked uncertain, and nothing uncertain is closed. */
  usageLookup?: ProviderUsageLookup | null;
}

export interface ReconcileResult {
  /** `reserved` reservations of calls that are no longer running, now recorded as uncertain. */
  markedUncertain: number;
  /** Uncertain reservations settled at the usage the provider recorded. */
  settled: number;
  /** Uncertain reservations released because the provider recorded no charge. */
  released: number;
  /** Uncertain reservations left as they are: no provider record, no lookup configured, or an unknown profile. */
  stillUncertain: number;
  /** Lookups that failed (the provider's record could not be read); those reservations are left as they are. */
  lookupFailures: number;
}

interface OpenRow {
  user_id: string;
  reservation_id: string;
  run_id: string;
  task: string;
  profile_id: string;
  attempt: number;
  gateway_id: string;
  state: string;
  error_class: string | null;
  created_at: string;
}

const SYSTEM = { authorization: "system_schedule" as const, source: { channel: "system" as const } };

export async function reconcileInferenceReservations(deps: ReconcileDeps, opts: { limit?: number } = {}): Promise<ReconcileResult> {
  const result: ReconcileResult = { markedUncertain: 0, settled: 0, released: 0, stillUncertain: 0, lookupFailures: 0 };
  const limit = opts.limit ?? 25;
  const principals = new Map<string, Awaited<ReturnType<typeof systemPrincipalFor>> | null>();
  const principalFor = async (userId: string) => {
    if (!principals.has(userId)) {
      // A disabled account's accounting is left untouched, like its other scheduled work.
      principals.set(userId, await systemPrincipalFor(deps.db, userId, "inference-reconcile", "system").catch(() => null));
    }
    return principals.get(userId) ?? null;
  };

  // 1. Calls that can no longer be running. Compared as instants, newest first.
  const abandoned = await all<OpenRow>(
    deps.db,
    "SELECT user_id, reservation_id, run_id, task, profile_id, attempt, gateway_id, state, error_class, created_at FROM inference_reservations WHERE state = 'reserved' AND julianday(created_at) < julianday(?) ORDER BY julianday(created_at) DESC LIMIT ?",
    toInstant(deps.nowMs - ABANDONED_AFTER_MS),
    limit,
  );
  for (const row of abandoned) {
    const principal = await principalFor(row.user_id);
    if (!principal) continue;
    try {
      const receipt = await deps.service.execute(principal, { type: "inference.settle", payload: { reservationId: row.reservation_id, outcome: "uncertain", errorClass: "abandoned" }, idempotencyKey: `inference-reconcile:${row.reservation_id}:abandoned`, ...SYSTEM });
      // A call that settled itself in the meantime is left as it settled (the command is then a no-op).
      if (receipt.outcome !== "noop" && !receipt.replayed) result.markedUncertain++;
    } catch (e) {
      if (!isCommandError(e)) throw e;
    }
  }

  // 2. Uncertain reservations, against the provider's record.
  const uncertain = await all<OpenRow>(
    deps.db,
    "SELECT user_id, reservation_id, run_id, task, profile_id, attempt, gateway_id, state, error_class, created_at FROM inference_reservations WHERE state = 'uncertain' AND julianday(created_at) < julianday(?) AND julianday(created_at) > julianday(?) ORDER BY julianday(created_at) DESC LIMIT ?",
    toInstant(deps.nowMs - LOOKUP_NOT_BEFORE_MS),
    toInstant(deps.nowMs - LOOKUP_WINDOW_MS),
    limit,
  );
  for (const row of uncertain) {
    if (!deps.usageLookup) {
      result.stillUncertain++;
      continue;
    }
    const principal = await principalFor(row.user_id);
    if (!principal) continue;
    let finding: ProviderUsageFinding;
    try {
      finding = await deps.usageLookup.find({ gatewayId: row.gateway_id, runId: row.run_id, attempt: row.attempt, task: row.task, reservedAt: row.created_at });
    } catch {
      result.lookupFailures++;
      continue;
    }
    if (finding.status === "not_found") {
      result.stillUncertain++;
      continue;
    }
    // The provider's record is named on the settling command, so the ledger shows what closed the reservation.
    const source = { channel: "system" as const, parentKind: "job" as const, parentId: `provider-record:${finding.ref}`.slice(0, 128) };
    try {
      if (finding.status === "not_charged") {
        await deps.service.execute(principal, { type: "inference.settle", payload: { reservationId: row.reservation_id, outcome: "released", errorClass: row.error_class }, idempotencyKey: `inference-reconcile:${row.reservation_id}:released`, authorization: "system_schedule", source });
        result.released++;
        continue;
      }
      const spec = profileSpec(row.profile_id);
      if (!spec) {
        // The price of a profile that is no longer in the registry is not known; the reservation is not priced by guess.
        result.stillUncertain++;
        continue;
      }
      await deps.service.execute(principal, {
        type: "inference.settle",
        payload: { reservationId: row.reservation_id, outcome: "settled", actualMicroUsd: actualCostMicroUsd(spec, finding.inputTokens, finding.outputTokens), inputTokens: finding.inputTokens, outputTokens: finding.outputTokens, resolvedModel: finding.resolvedModel ?? spec.apiModelId ?? null, errorClass: row.error_class },
        idempotencyKey: `inference-reconcile:${row.reservation_id}:settled`,
        authorization: "system_schedule",
        source,
      });
      result.settled++;
    } catch (e) {
      if (!isCommandError(e)) throw e;
      result.stillUncertain++;
    }
  }
  return result;
}
