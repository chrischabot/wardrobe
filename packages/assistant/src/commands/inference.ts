import { ASSISTANT_COMMANDS as C } from "@garderobe/contracts/ext/assistant";
import { CommandError, all, define, first, stmt, toInstant } from "@garderobe/domain";
import { NO_UNDO } from "./common.ts";
import { TASK_SPECS, profileSpec, selectability, type ProbeRow } from "../inference/registry.ts";

/** Committed spend of a budget class and day: settled actuals plus everything still reserved or uncertain. */
const COMMITTED_SQL =
  "(SELECT COALESCE(SUM(CASE state WHEN 'settled' THEN actual_microusd WHEN 'released' THEN 0 ELSE reserved_microusd END), 0) FROM inference_reservations WHERE user_id = ? AND budget_class = ? AND budget_day = ?)";

const ALL_COMMITTED_SQL =
  "(SELECT COALESCE(SUM(CASE state WHEN 'settled' THEN actual_microusd WHEN 'released' THEN 0 ELSE reserved_microusd END), 0) FROM inference_reservations WHERE user_id = ? AND budget_day = ?)";
const DISCRETIONARY = ["research", "image_backfill"];

/**
 * Reserve spend BEFORE a model call is dispatched. The limit is enforced by a constraint-checked
 * precondition inside the same batch, so two concurrent reservations cannot both pass.
 */
export const inferenceReserve = define({
  type: "inference.reserve",
  schema: C["inference.reserve"],
  class: "system",
  requiredScope: "write",
  async plan(ctx, p) {
    if (!profileSpec(p.profileId)) throw new CommandError("invalid_command", `unknown model profile '${p.profileId}'`);
    if (await first(ctx.db, "SELECT 1 AS x FROM inference_reservations WHERE user_id = ? AND reservation_id = ?", ctx.userId, p.reservationId)) {
      return { outcome: "noop", summary: "Reservation already held", result: { reservationId: p.reservationId }, undo: NO_UNDO("nothing changed") };
    }
    return {
      summary: `Reserved ${p.reservedMicroUsd} micro-USD of the ${p.budgetClass.replace(/_/g, " ")} budget for ${p.task.replace(/_/g, " ")} (${p.profileId}, attempt ${p.attempt})`,
      preconditions: [
        {
          label: `the ${p.budgetClass.replace(/_/g, " ")} budget for ${p.budgetDay} has room for this call`,
          sql: `${COMMITTED_SQL} + ? <= ?`,
          params: [ctx.userId, p.budgetClass, p.budgetDay, p.reservedMicroUsd, p.dailyLimitMicroUsd],
          class: "state",
        },
        // Discretionary work pauses first when the day's total spend approaches its limit, so daily
        // assistance and the morning board keep their capacity.
        ...(p.discretionaryCeilingMicroUsd > 0 && DISCRETIONARY.includes(p.budgetClass)
          ? [{ label: `today's spend leaves room for optional ${p.budgetClass.replace(/_/g, " ")} work`, sql: `${ALL_COMMITTED_SQL} + ? <= ?`, params: [ctx.userId, p.budgetDay, p.reservedMicroUsd, p.discretionaryCeilingMicroUsd], class: "state" as const }]
          : []),
        // A cap on calls in flight. Reservations older than ten minutes are abandoned calls, not live ones.
        ...(p.maxOpenReservations > 0
          ? [{ label: "fewer model calls are in flight than the concurrency cap", sql: "(SELECT COUNT(*) FROM inference_reservations WHERE user_id = ? AND state = 'reserved' AND created_at > ?) < ?", params: [ctx.userId, toInstant(ctx.nowMs - 600_000), p.maxOpenReservations], class: "state" as const }]
          : []),
      ],
      statements: [
        stmt(
          `INSERT INTO inference_reservations (user_id, reservation_id, run_id, task, budget_class, profile_id, attempt, budget_day, reserved_microusd, state, parent_kind, parent_id, prompt_version, gateway_id, schema_version, effort_json, evidence_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?, ?)`,
          ctx.userId, p.reservationId, p.runId, p.task, p.budgetClass, p.profileId, p.attempt, p.budgetDay, p.reservedMicroUsd, p.parent.kind, p.parent.id, p.promptVersion, p.gatewayId, p.schemaVersion, JSON.stringify(p.effort), JSON.stringify(p.evidence), ctx.now,
        ),
      ],
      result: { reservationId: p.reservationId, runId: p.runId },
      undo: NO_UNDO("a reservation is settled or released, not undone"),
    };
  },
});

/** Settle against reported usage, release an unused reservation, or hold it as uncertain until reconciled. */
export const inferenceSettle = define({
  type: "inference.settle",
  schema: C["inference.settle"],
  class: "system",
  requiredScope: "write",
  async plan(ctx, p) {
    const row = await first<{ state: string; reserved_microusd: number; task: string }>(ctx.db, "SELECT state, reserved_microusd, task FROM inference_reservations WHERE user_id = ? AND reservation_id = ?", ctx.userId, p.reservationId);
    if (!row) throw new CommandError("not_found", `no reservation '${p.reservationId}'`);
    if (row.state === "settled" || row.state === "released") return { outcome: "noop", summary: "Reservation already closed", result: { reservationId: p.reservationId, state: row.state }, undo: NO_UNDO("nothing changed") };
    return {
      summary:
        p.outcome === "settled"
          ? `Settled ${p.actualMicroUsd} micro-USD against a reservation of ${row.reserved_microusd} (${row.task.replace(/_/g, " ")})`
          : p.outcome === "released"
            ? `Released an unused reservation of ${row.reserved_microusd} micro-USD`
            : `Outcome unknown: ${row.reserved_microusd} micro-USD stays reserved until the provider charge is reconciled`,
      statements: [
        stmt(
          "UPDATE inference_reservations SET state = ?, actual_microusd = ?, input_tokens = ?, output_tokens = ?, resolved_model = ?, error_class = ?, settled_at = ? WHERE user_id = ? AND reservation_id = ?",
          p.outcome, p.outcome === "settled" ? p.actualMicroUsd : 0, p.inputTokens, p.outputTokens, p.resolvedModel, p.errorClass, p.outcome === "uncertain" ? null : ctx.now, ctx.userId, p.reservationId,
        ),
      ],
      result: { reservationId: p.reservationId, state: p.outcome },
      undo: NO_UNDO("accounting records are not undone"),
    };
  },
});

/** A capability + billing probe result for one operation of one profile on one named Gateway. Administrative. */
export const inferenceRecordProbe = define({
  type: "inference.record_probe",
  schema: C["inference.record_probe"],
  class: "system",
  requiredScope: "admin",
  async plan(ctx, p) {
    const spec = profileSpec(p.profileId);
    if (!spec) throw new CommandError("invalid_command", `unknown model profile '${p.profileId}'`);
    if (p.gatewayId === "default") throw new CommandError("invalid_command", "the implicit 'default' gateway is never used; name the intended gateway");
    if (!spec.supportedOperations.includes(p.operation)) throw new CommandError("invalid_command", `${spec.label} does not declare the ${p.operation} operation`);
    return {
      summary: `${spec.label}: ${p.operation} probe ${p.result} on ${p.gatewayId} (billing: ${p.billing.replace(/_/g, " ")})${p.reason ? ` - ${p.reason}` : ""}`,
      statements: [
        stmt(
          `INSERT INTO model_probes (gateway_id, profile_id, operation, result, billing, reason, resolved_model, probed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (gateway_id, profile_id, operation) DO UPDATE SET result = excluded.result, billing = excluded.billing, reason = excluded.reason, resolved_model = excluded.resolved_model, probed_at = excluded.probed_at`,
          p.gatewayId, p.profileId, p.operation, p.result, p.billing, p.reason, p.resolvedModel, ctx.now,
        ),
      ],
      result: { profileId: p.profileId, operation: p.operation, result: p.result, billing: p.billing },
      undo: NO_UNDO("record a new probe to supersede this one"),
    };
  },
});

/** The owner's routing choice. Only a profile whose probes passed can be chosen; the morning profile also needs its evaluation gate. */
export const inferenceSetRouting = define({
  type: "inference.set_routing",
  schema: C["inference.set_routing"],
  class: "edit",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap", "owner_statement"],
  async plan(ctx, p) {
    const task = TASK_SPECS[p.task];
    const probes = await all<ProbeRow>(ctx.db, "SELECT profile_id, operation, result, billing, reason, resolved_model, probed_at FROM model_probes WHERE gateway_id = ?", p.gatewayId);
    for (const id of [p.profileId, ...p.fallbacks]) {
      const spec = profileSpec(id);
      if (!spec) throw new CommandError("invalid_command", `unknown model profile '${id}'`);
      const s = selectability(spec, probes, task.requiredOperations);
      if (!s.selectable) throw new CommandError("precondition_failed", `${spec.label} cannot serve ${p.task.replace(/_/g, " ")}: ${s.reason}`, { profileId: id, reason: s.reason });
    }
    if (p.task === "outfit_composition" && !p.evaluationRef) {
      throw new CommandError("precondition_failed", "the scheduled morning profile changes only after the new profile passes the same evaluation as the current one; give the evaluation reference");
    }
    const existing = await first<{ version: number }>(ctx.db, "SELECT version FROM inference_routing WHERE user_id = ? AND task = ?", ctx.userId, p.task);
    const version = (existing?.version ?? 0) + 1;
    return {
      summary: `${p.task.replace(/_/g, " ")} now uses ${profileSpec(p.profileId)!.label}${p.fallbacks.length ? `, then ${p.fallbacks.map((f) => profileSpec(f)!.label).join(", ")}` : ""}`,
      statements: [
        stmt(
          `INSERT INTO inference_routing (user_id, task, version, profile_id, fallbacks_json, evaluation_ref, command_id, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)
           ON CONFLICT (user_id, task) DO UPDATE SET version = version + 1, profile_id = excluded.profile_id, fallbacks_json = excluded.fallbacks_json, evaluation_ref = excluded.evaluation_ref, command_id = excluded.command_id, updated_at = excluded.updated_at`,
          ctx.userId, p.task, p.profileId, JSON.stringify(p.fallbacks), p.evaluationRef, ctx.commandId, ctx.now,
        ),
      ],
      affected: [{ kind: "inference_routing", id: p.task, version }],
      result: { task: p.task, profileId: p.profileId, fallbacks: p.fallbacks },
      undo: NO_UNDO("choose another profile to change it"),
    };
  },
});

export const inferenceHandlers = [inferenceReserve, inferenceSettle, inferenceRecordProbe, inferenceSetRouting];
