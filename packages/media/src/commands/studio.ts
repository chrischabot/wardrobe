/**
 * Studio commands. Save combination, Plan for a day and Wear this have distinct effects:
 *   - studio.save_combination  keeps a combination; it touches no plan and no wear history;
 *   - studio.plan_for_day      records an INTENTION for a date (and registers it with the availability
 *                              estimator as a selected option); it is never a wear or a reservation;
 *   - Wear this                is the foundation's `wear.record`; nothing here records a wear.
 * Browsing, validating, suggesting and composing are reads and mutate nothing.
 */
import { FOUNDATION_COMMANDS } from "@garderobe/contracts";
import { MEDIA_COMMANDS as C } from "@garderobe/contracts/ext/media";
import type { StudioSlot, StudioValidation } from "@garderobe/contracts/ext/media";
import { all, CommandError, define, exposurePublish, first, json, localDateOf, stmt, type CommandContext, type CommandDefinition, type CommandRegistry, type Stmt } from "@garderobe/domain";
import { resolveDeps, type MediaDepsSource } from "../runtime.ts";
import { blockingMessages, composeResolved, resolveSlots, slotSignature, validateResolved } from "../studio/shared.ts";

interface CombinationRow {
  combination_id: string;
  name: string | null;
  favourite: number;
  slots_json: string;
  signature: string;
  has_candidate: number;
  status: "active" | "removed";
  validation_json: string;
  manifest_hash: string | null;
  version: number;
}

interface PlanRow {
  plan_id: string;
  local_date: string;
  combination_id: string | null;
  slots_json: string;
  status: "planned" | "removed";
  exposure_id: string | null;
  version: number;
}

const COMBINATION_COLS = "combination_id, name, favourite, slots_json, signature, has_candidate, status, validation_json, manifest_hash, version";
const PLAN_COLS = "plan_id, local_date, combination_id, slots_json, status, exposure_id, version";

function itemStatements(table: "studio_combination_items" | "studio_day_plan_items", idColumn: "combination_id" | "plan_id", ctx: CommandContext, id: string, slots: StudioSlot[]): Stmt[] {
  const out: Stmt[] = [stmt(`DELETE FROM ${table} WHERE user_id = ? AND ${idColumn} = ?`, ctx.userId, id)];
  const seen = new Set<string>();
  for (const s of slots) {
    if (!s.garmentId || seen.has(`${s.role}:${s.garmentId}`)) continue;
    seen.add(`${s.role}:${s.garmentId}`);
    out.push(stmt(`INSERT INTO ${table} (user_id, ${idColumn}, role, garment_id) VALUES (?, ?, ?, ?)`, ctx.userId, id, s.role, s.garmentId));
  }
  return out;
}

function describe(names: string[]): string {
  return names.length <= 5 ? names.join(", ") : `${names.slice(0, 5).join(", ")} and ${names.length - 5} more`;
}

function refuse(validation: StudioValidation, what: string): never {
  throw new CommandError("precondition_failed", `${what}: ${blockingMessages(validation)}; nothing was written`, { violations: validation.violations, validator: validation.validator });
}

export function studioCommands(depsSource: MediaDepsSource): CommandDefinition<any>[] {
  const save = define({
    type: "studio.save_combination",
    schema: C["studio.save_combination"],
    class: "edit",
    requiredScope: "write",
    async plan(ctx, p) {
      const deps = resolveDeps(depsSource);
      const resolved = await resolveSlots(ctx.db, ctx.userId, p.slots);
      const forDate = p.forDate ?? localDateOf(ctx.nowMs, ctx.settings.timezone);
      // A combination is saved only after validation against the current records.
      const validation = await validateResolved(deps, ctx.db, ctx.principal, resolved, p.mode, forDate, ctx.nowMs);
      if (!validation.valid) refuse(validation, "This combination cannot be saved");
      const signature = await slotSignature(resolved.slots);
      const { hash } = await composeResolved(resolved);
      const existing = p.combinationId ? await first<CombinationRow>(ctx.db, `SELECT ${COMBINATION_COLS} FROM studio_combinations WHERE user_id = ? AND combination_id = ?`, ctx.userId, p.combinationId) : null;

      if (!existing) {
        const same = await first<CombinationRow>(ctx.db, `SELECT ${COMBINATION_COLS} FROM studio_combinations WHERE user_id = ? AND signature = ? AND status = 'active'`, ctx.userId, signature);
        if (same) {
          // The same pieces are already saved: keep the one identity instead of minting a duplicate.
          return { outcome: "noop", summary: `That combination is already saved (${describe(resolved.names)})`, result: { combinationId: same.combination_id, alreadySaved: true, version: same.version }, undo: { unavailableReason: "nothing changed" } };
        }
        const combinationId = p.combinationId ?? ctx.newId("cmb");
        return {
          summary: `Saved combination: ${describe(resolved.names)}${resolved.hasCandidate ? " (includes a shopping candidate that is not owned)" : ""}`,
          statements: [
            stmt(
              `INSERT INTO studio_combinations (user_id, combination_id, name, favourite, slots_json, signature, has_candidate, status, validation_json, manifest_hash, version, command_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 1, ?, ?, ?)`,
              ctx.userId, combinationId, p.name, p.favourite, JSON.stringify(resolved.slots), signature, resolved.hasCandidate, JSON.stringify(validation), hash, ctx.commandId, ctx.now, ctx.now,
            ),
            ...itemStatements("studio_combination_items", "combination_id", ctx, combinationId, resolved.slots),
          ],
          preconditions: [{ label: `combination ${combinationId} does not exist yet`, sql: "NOT EXISTS (SELECT 1 FROM studio_combinations WHERE user_id = ? AND combination_id = ?)", params: [ctx.userId, combinationId], class: "state" }],
          affected: [{ kind: "studio_combination", id: combinationId, version: 1 }],
          outbox: [{ topic: "studio.combination", entityKind: "studio_combination", entityId: combinationId, revision: 1 }],
          result: { combinationId, version: 1, manifestHash: hash, garmentIds: resolved.garmentSlots.map((s) => s.garmentId), validation },
          undo: { data: { kind: "created", combinationId } },
        };
      }
      if (existing.status !== "active") throw new CommandError("precondition_failed", "that combination was removed; save it as a new one");
      return {
        summary: `Updated combination: ${describe(resolved.names)}`,
        statements: [
          stmt(
            "UPDATE studio_combinations SET name = ?, favourite = ?, slots_json = ?, signature = ?, has_candidate = ?, validation_json = ?, manifest_hash = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND combination_id = ?",
            p.name, p.favourite, JSON.stringify(resolved.slots), signature, resolved.hasCandidate, JSON.stringify(validation), hash, ctx.now, ctx.userId, existing.combination_id,
          ),
          ...itemStatements("studio_combination_items", "combination_id", ctx, existing.combination_id, resolved.slots),
        ],
        preconditions: [{ label: "combination unchanged since read", sql: "(SELECT version FROM studio_combinations WHERE user_id = ? AND combination_id = ?) = ?", params: [ctx.userId, existing.combination_id, existing.version], class: "internal" }],
        affected: [{ kind: "studio_combination", id: existing.combination_id, version: existing.version + 1 }],
        outbox: [{ topic: "studio.combination", entityKind: "studio_combination", entityId: existing.combination_id, revision: existing.version + 1 }],
        result: { combinationId: existing.combination_id, version: existing.version + 1, manifestHash: hash, garmentIds: resolved.garmentSlots.map((s) => s.garmentId), validation },
        undo: { data: { kind: "updated", combinationId: existing.combination_id, previous: existing } },
      };
    },
    async planUndo(ctx, _original, data) {
      const row = await first<CombinationRow>(ctx.db, `SELECT ${COMBINATION_COLS} FROM studio_combinations WHERE user_id = ? AND combination_id = ?`, ctx.userId, data.combinationId);
      if (!row || row.status !== "active") throw new CommandError("not_undoable", "that combination has since been removed");
      const done = { unavailableReason: "this is already an undo; save the combination again instead" };
      if (data.kind === "created") {
        return {
          summary: "The saved combination was removed again",
          statements: [stmt("UPDATE studio_combinations SET status = 'removed', removed_at = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND combination_id = ?", ctx.now, ctx.now, ctx.userId, row.combination_id)],
          affected: [{ kind: "studio_combination", id: row.combination_id, version: row.version + 1 }],
          undo: done,
        };
      }
      const previous = data.previous as CombinationRow;
      return {
        summary: "The combination is back to what it was",
        statements: [
          stmt(
            "UPDATE studio_combinations SET name = ?, favourite = ?, slots_json = ?, signature = ?, has_candidate = ?, validation_json = ?, manifest_hash = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND combination_id = ?",
            previous.name, previous.favourite, previous.slots_json, previous.signature, previous.has_candidate, previous.validation_json, previous.manifest_hash, ctx.now, ctx.userId, row.combination_id,
          ),
          ...itemStatements("studio_combination_items", "combination_id", ctx, row.combination_id, json<StudioSlot[]>(previous.slots_json, [])),
        ],
        affected: [{ kind: "studio_combination", id: row.combination_id, version: row.version + 1 }],
        undo: done,
      };
    },
  });

  const remove = define({
    type: "studio.remove_combination",
    schema: C["studio.remove_combination"],
    class: "edit",
    requiredScope: "write",
    async plan(ctx, p) {
      const row = await first<CombinationRow>(ctx.db, `SELECT ${COMBINATION_COLS} FROM studio_combinations WHERE user_id = ? AND combination_id = ?`, ctx.userId, p.combinationId);
      if (!row) throw new CommandError("not_found", "no such saved combination for this owner; nothing was written");
      if (row.status === "removed") return { outcome: "noop", summary: "That combination was already removed", undo: { unavailableReason: "nothing changed" } };
      const plans = await first<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM studio_day_plans WHERE user_id = ? AND combination_id = ? AND status = 'planned'", ctx.userId, row.combination_id);
      return {
        summary: `Removed the saved combination${plans && plans.n > 0 ? `; ${plans.n} day plan(s) made from it are kept` : ""}`,
        statements: [stmt("UPDATE studio_combinations SET status = 'removed', removed_at = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND combination_id = ?", ctx.now, ctx.now, ctx.userId, row.combination_id)],
        preconditions: [{ label: "combination still saved", sql: "(SELECT status FROM studio_combinations WHERE user_id = ? AND combination_id = ?) = 'active'", params: [ctx.userId, row.combination_id], class: "state" }],
        affected: [{ kind: "studio_combination", id: row.combination_id, version: row.version + 1 }],
        outbox: [{ topic: "studio.combination", entityKind: "studio_combination", entityId: row.combination_id, revision: row.version + 1 }],
        result: { combinationId: row.combination_id, keptDayPlans: plans?.n ?? 0 },
        undo: { data: { combinationId: row.combination_id } },
      };
    },
    async planUndo(ctx, _original, data) {
      const row = await first<CombinationRow>(ctx.db, `SELECT ${COMBINATION_COLS} FROM studio_combinations WHERE user_id = ? AND combination_id = ?`, ctx.userId, data.combinationId);
      if (!row) throw new CommandError("not_undoable", "that combination no longer exists");
      return {
        summary: "The combination is saved again",
        statements: [stmt("UPDATE studio_combinations SET status = 'active', removed_at = NULL, version = version + 1, updated_at = ? WHERE user_id = ? AND combination_id = ?", ctx.now, ctx.userId, row.combination_id)],
        preconditions: [
          { label: "combination still removed", sql: "(SELECT status FROM studio_combinations WHERE user_id = ? AND combination_id = ?) = 'removed'", params: [ctx.userId, row.combination_id], class: "state" },
          { label: "the same combination was not saved again meanwhile", sql: "NOT EXISTS (SELECT 1 FROM studio_combinations WHERE user_id = ? AND signature = ? AND status = 'active')", params: [ctx.userId, row.signature], class: "state" },
        ],
        affected: [{ kind: "studio_combination", id: row.combination_id, version: row.version + 1 }],
        undo: { unavailableReason: "this is already an undo; remove the combination again instead" },
      };
    },
  });

  const planForDay = define({
    type: "studio.plan_for_day",
    schema: C["studio.plan_for_day"],
    class: "edit",
    requiredScope: "write",
    async plan(ctx, p) {
      const deps = resolveDeps(depsSource);
      const today = localDateOf(ctx.nowMs, ctx.settings.timezone);
      if (p.localDate < today) throw new CommandError("invalid_command", "a day that has passed cannot be planned; record what was worn instead", { today });
      let slotsInput = p.slots;
      if (p.combinationId) {
        const combination = await first<CombinationRow>(ctx.db, `SELECT ${COMBINATION_COLS} FROM studio_combinations WHERE user_id = ? AND combination_id = ?`, ctx.userId, p.combinationId);
        if (!combination || combination.status !== "active") throw new CommandError("not_found", "no such saved combination for this owner; nothing was written");
        slotsInput = json<StudioSlot[]>(combination.slots_json, []);
      }
      if (slotsInput.length === 0) throw new CommandError("invalid_command", "a plan needs a saved combination or a set of pieces");
      const resolved = await resolveSlots(ctx.db, ctx.userId, slotsInput);
      // A plan is validated as an outfit to WEAR on that date: eligibility, availability and the owner's rules.
      const validation = await validateResolved(deps, ctx.db, ctx.principal, resolved, "for_today", p.localDate, ctx.nowMs);
      if (!validation.valid) refuse(validation, `This outfit cannot be planned for ${p.localDate}`);

      const existing = await first<PlanRow>(ctx.db, `SELECT ${PLAN_COLS} FROM studio_day_plans WHERE user_id = ? AND local_date = ? AND status = 'planned'`, ctx.userId, p.localDate);
      const planId = p.planId ?? ctx.newId("pln");
      const exposureId = ctx.newId("exp");
      // Register the intention with the availability estimator through the foundation's own exposure handler.
      const exposure = await exposurePublish.plan(
        ctx,
        FOUNDATION_COMMANDS["exposure.publish"].parse({
          exposureId,
          localDate: p.localDate,
          sourceKind: "plan",
          sourceRef: `studio:${planId}`,
          options: [{ optionId: "plan", garmentIds: [...new Set(resolved.garmentSlots.map((s) => s.garmentId))] }],
          supersedes: existing?.exposure_id ? [existing.exposure_id] : [],
        }),
      );
      const statements: Stmt[] = [];
      if (existing) statements.push(stmt("UPDATE studio_day_plans SET status = 'removed', removed_at = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND plan_id = ?", ctx.now, ctx.now, ctx.userId, existing.plan_id));
      statements.push(
        stmt(
          `INSERT INTO studio_day_plans (user_id, plan_id, local_date, combination_id, slots_json, status, needs_revalidation, validation_json, exposure_id, version, command_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'planned', 0, ?, ?, 1, ?, ?, ?)`,
          ctx.userId, planId, p.localDate, p.combinationId, JSON.stringify(resolved.slots), JSON.stringify(validation), exposureId, ctx.commandId, ctx.now, ctx.now,
        ),
        ...itemStatements("studio_day_plan_items", "plan_id", ctx, planId, resolved.slots),
        ...(exposure.statements ?? []),
        // An explicit plan is a chosen option, not merely an offered one.
        stmt("UPDATE exposure_sets SET selected_option_id = 'plan', status = 'selected', updated_at = ? WHERE user_id = ? AND exposure_id = ?", ctx.now, ctx.userId, exposureId),
      );
      return {
        summary: `Planned for ${p.localDate}: ${describe(resolved.names)} (an intention, not a recorded wear)${existing ? "; it replaces the earlier plan for that day" : ""}`,
        statements,
        preconditions: [
          { label: `plan ${planId} does not exist yet`, sql: "NOT EXISTS (SELECT 1 FROM studio_day_plans WHERE user_id = ? AND plan_id = ?)", params: [ctx.userId, planId], class: "state" },
          // The plan read above is the one being replaced: a concurrent plan for the same day makes this re-plan.
          { label: "the day's plan is unchanged since read", sql: "COALESCE((SELECT plan_id FROM studio_day_plans WHERE user_id = ? AND local_date = ? AND status = 'planned'), '') = ?", params: [ctx.userId, p.localDate, existing?.plan_id ?? ""], class: "internal" },
          ...(exposure.preconditions ?? []),
        ],
        affected: [{ kind: "studio_day_plan", id: planId, version: 1 }, ...(existing ? [{ kind: "studio_day_plan", id: existing.plan_id, version: existing.version + 1 }] : []), ...(exposure.affected ?? [])],
        outbox: [{ topic: "studio.day_plan", entityKind: "studio_day_plan", entityId: planId, revision: 1, payload: { localDate: p.localDate } }],
        result: { planId, localDate: p.localDate, exposureId, replacedPlanId: existing?.plan_id ?? null, garmentIds: resolved.garmentSlots.map((s) => s.garmentId), validation },
        // Validation read the wardrobe at this revision; a racing availability change re-plans and re-validates.
        bumpWardrobe: true,
        undo: { data: { planId } },
      };
    },
    async planUndo(ctx, _original, data) {
      return removePlan(ctx, data.planId, true);
    },
  });

  const removeDayPlan = define({
    type: "studio.remove_day_plan",
    schema: C["studio.remove_day_plan"],
    class: "edit",
    requiredScope: "write",
    async plan(ctx, p) {
      return removePlan(ctx, p.planId, false);
    },
    async planUndo(ctx, _original, data) {
      const row = await first<PlanRow>(ctx.db, `SELECT ${PLAN_COLS} FROM studio_day_plans WHERE user_id = ? AND plan_id = ?`, ctx.userId, data.planId);
      if (!row) throw new CommandError("not_undoable", "that plan no longer exists");
      const today = localDateOf(ctx.nowMs, ctx.settings.timezone);
      if (row.local_date < today) throw new CommandError("not_undoable", "that day has passed");
      return {
        summary: `The plan for ${row.local_date} is back; it will be re-checked against current availability`,
        statements: [
          stmt("UPDATE studio_day_plans SET status = 'planned', removed_at = NULL, needs_revalidation = 1, revalidation_reason = 'restored by undo', version = version + 1, updated_at = ? WHERE user_id = ? AND plan_id = ?", ctx.now, ctx.userId, row.plan_id),
          ...(row.exposure_id ? [stmt("UPDATE exposure_sets SET status = 'selected', updated_at = ? WHERE user_id = ? AND exposure_id = ? AND status = 'superseded'", ctx.now, ctx.userId, row.exposure_id)] : []),
        ],
        preconditions: [
          { label: "plan still removed", sql: "(SELECT status FROM studio_day_plans WHERE user_id = ? AND plan_id = ?) = 'removed'", params: [ctx.userId, row.plan_id], class: "state" },
          { label: "no other plan was made for that day", sql: "NOT EXISTS (SELECT 1 FROM studio_day_plans WHERE user_id = ? AND local_date = ? AND status = 'planned')", params: [ctx.userId, row.local_date], class: "state" },
        ],
        affected: [{ kind: "studio_day_plan", id: row.plan_id, version: row.version + 1 }],
        bumpWardrobe: true,
        undo: { unavailableReason: "this is already an undo; remove the plan again instead" },
      };
    },
  });

  return [save, remove, planForDay, removeDayPlan];
}

async function removePlan(ctx: CommandContext, planId: string, isUndo: boolean) {
  const row = await first<PlanRow>(ctx.db, `SELECT ${PLAN_COLS} FROM studio_day_plans WHERE user_id = ? AND plan_id = ?`, ctx.userId, planId);
  if (!row) throw new CommandError(isUndo ? "not_undoable" : "not_found", "no such day plan for this owner; nothing was written");
  if (row.status === "removed") {
    if (isUndo) throw new CommandError("not_undoable", "that plan was already removed");
    return { outcome: "noop" as const, summary: "That plan was already removed", undo: { unavailableReason: "nothing changed" } };
  }
  return {
    summary: `Removed the plan for ${row.local_date}; nothing was worn or reserved by it`,
    statements: [
      stmt("UPDATE studio_day_plans SET status = 'removed', removed_at = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND plan_id = ?", ctx.now, ctx.now, ctx.userId, row.plan_id),
      ...(row.exposure_id ? [stmt("UPDATE exposure_sets SET status = 'superseded', updated_at = ? WHERE user_id = ? AND exposure_id = ? AND status IN ('open', 'selected')", ctx.now, ctx.userId, row.exposure_id)] : []),
    ],
    preconditions: [{ label: "plan still active", sql: "(SELECT status FROM studio_day_plans WHERE user_id = ? AND plan_id = ?) = 'planned'", params: [ctx.userId, row.plan_id], class: "state" as const }],
    affected: [{ kind: "studio_day_plan", id: row.plan_id, version: row.version + 1 }],
    outbox: [{ topic: "studio.day_plan", entityKind: "studio_day_plan", entityId: row.plan_id, revision: row.version + 1, payload: { localDate: row.local_date, removed: true } }],
    result: { planId: row.plan_id, localDate: row.local_date },
    bumpWardrobe: true,
    undo: isUndo ? { unavailableReason: "this is already an undo; plan the day again instead" } : { data: { planId: row.plan_id } },
  };
}

/**
 * Commit hook: when a command changes the availability of garments (a wear, laundry, a restriction...),
 * upcoming Studio plans that use them are flagged in the SAME commit. The owner's plan is not silently
 * rewritten; the next read re-validates it and shows what changed.
 */
export function registerStudioHooks(registry: CommandRegistry): void {
  registry.addCommitHook("studio.flag_affected_day_plans", async (ctx, _plan, changes) => {
    if (ctx.envelope.type.startsWith("studio.")) return;
    const ids = [...new Set([...changes.availabilityChanged, ...changes.wears.map((w) => w.garmentId)])].slice(0, 80);
    if (ids.length === 0) return;
    const today = localDateOf(ctx.nowMs, ctx.settings.timezone);
    const marks = ids.map(() => "?").join(",");
    const wearDates = new Set(changes.wears.map((w) => w.wearingDate));
    const affected = (
      await all<{ plan_id: string; local_date: string }>(
        ctx.db,
        `SELECT DISTINCT p.plan_id, p.local_date FROM studio_day_plans p JOIN studio_day_plan_items i ON i.user_id = p.user_id AND i.plan_id = p.plan_id
          WHERE p.user_id = ? AND p.status = 'planned' AND p.local_date >= ? AND i.garment_id IN (${marks}) ORDER BY p.local_date`,
        ctx.userId, today, ...ids,
      )
      // A wear recorded for a day is that day's record; its own plan needs no re-check.
    ).filter((a) => !wearDates.has(a.local_date));
    if (affected.length === 0) return;
    const reason = `availability changed after '${ctx.envelope.type}'`;
    return {
      statements: affected.map((a) => stmt("UPDATE studio_day_plans SET needs_revalidation = 1, revalidation_reason = ?, updated_at = ? WHERE user_id = ? AND plan_id = ? AND status = 'planned'", reason, ctx.now, ctx.userId, a.plan_id)),
      repairs: affected.map((a) => `The Studio plan for ${a.local_date} uses a garment whose availability changed; it will be re-checked`),
    };
  });
  registry.registerVersionResolver("studio_combination", (userId, id) => ({ sql: "SELECT version FROM studio_combinations WHERE user_id = ? AND combination_id = ?", params: [userId, id] }));
  registry.registerVersionResolver("studio_day_plan", (userId, id) => ({ sql: "SELECT version FROM studio_day_plans WHERE user_id = ? AND plan_id = ?", params: [userId, id] }));
}
