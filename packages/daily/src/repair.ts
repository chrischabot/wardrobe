/**
 * Repair after reality changes (specification section 8).
 *
 * `boardRepairHook` runs inside the commit of ANY command that changes availability, wear or
 * restrictions. It revalidates every affected open board against the wardrobe as it will be after
 * that batch, replaces invalid pieces or options from eligible stock and reserves, withdraws what
 * cannot be repaired, and writes the new board revision, its exposure set and its Calendar effect in
 * the same D1 batch. No model is involved, and a published option is never left as a placeholder.
 *
 * The owner's observation always commits: if repair itself fails, the boards are flagged for the
 * sweep instead of failing the command.
 */
import type { Role } from "@garderobe/contracts";
import type { OutfitSlot } from "@garderobe/contracts/ext/daily";
import { addDays, all, allIn, localDateOf, stmt, type BalanceRow, type CommandContext, type CommandPlan, type CommitHook, type DomainChanges, type PlanFragment, type Stmt } from "@garderobe/domain";
import { assembleContext, calendarSnapshotById, weatherSnapshotById, type Overlay } from "./context.ts";
import { boardNotice, describeChanges, optionEvidence, planRevisionWrite, revisionContext, storedToDraft, type DraftOption } from "./boards.ts";
import { factualReason, findReplacement } from "./compose.ts";
import { loadOptions, loadRevision, pauseCovering, type BoardRow, type StoredOption } from "./document.ts";
import { parseScope, type RecommendationContext } from "./model.ts";
import { validateCandidate } from "./validate.ts";

const slotOf = (o: { slots: OutfitSlot[] }, role: Role) => o.slots.find((s) => s.role === role)?.garmentId ?? null;

export interface RepairOutcome {
  changed: boolean;
  offered: DraftOption[];
  reserves: DraftOption[];
  changes: string[];
  shortage: string | null;
  withdrawn: number;
}

function whyPhrase(rc: RecommendationContext, code: string, garmentId: string): string {
  if (code === "repeat_within_horizon") {
    const last = rc.garments.get(garmentId)?.wornDates.filter((d) => d < rc.localDate).pop();
    return last ? `worn on ${last}` : "worn this week";
  }
  if (code === "unavailable" || code === "not_packed" || code === "unknown_garment") return "no longer available";
  if (code === "restricted" || code === "footwear_restricted") return "now restricted";
  if (code.startsWith("thermal") || code === "fabric_rule" || code === "outerwear_ceiling" || code === "jacket_band_requires_lightweight_oxford" || code === "too_warm_together") return "wrong for the forecast now";
  return "no longer valid";
}

/**
 * Revalidate a board's options against `rc` and repair what is invalid: keep unaffected slots, replace
 * the affected piece, else promote a complete reserve, else withdraw the option. Pure.
 */
export function repairOptions(rc: RecommendationContext, stored: StoredOption[], requestedCount: number): RepairOutcome {
  const offered = stored.filter((o) => o.state === "offered");
  const reserves = stored.filter((o) => o.state === "reserve");
  const optsFor = (o: StoredOption) => ({ requirePairedFootwear: true, ignoreBriefInclusions: false, explicitGarmentIds: o.evidence.explicitGarmentIds ?? [] });
  const checks = offered.map((o) => ({ o, validation: validateCandidate(rc, o, optsFor(o)) }));
  const reserveChecks = reserves.map((o) => ({ o, validation: validateCandidate(rc, o, optsFor(o)) }));
  const usedTops = new Set<string>();
  const usedBottoms = new Set<string>();
  for (const c of checks) {
    if (!c.validation.valid) continue;
    const t = slotOf(c.o, "top");
    const b = slotOf(c.o, "bottom");
    if (t) usedTops.add(t);
    if (b) usedBottoms.add(b);
  }
  const why = new Map<string, string>();
  const next: DraftOption[] = [];
  const spareReserves = reserveChecks.filter((c) => c.validation.valid).map((c) => c.o);
  let changed = reserveChecks.some((c) => !c.validation.valid);
  let withdrawn = 0;

  for (const { o, validation } of checks) {
    if (validation.valid) {
      next.push(storedToDraft(o));
      continue;
    }
    changed = true;
    const blockers = validation.violations.filter((x) => x.severity === "blocking");
    const implicated = new Set<string>();
    for (const b of blockers) for (const id of b.garmentIds) {
      // A combination rule names both pieces; the layer is what gives way, the base outfit stays.
      if ((b.code === "jacket_band_requires_lightweight_oxford" || b.code === "too_warm_together") && slotOf(o, "outer") && b.garmentIds.includes(slotOf(o, "outer")!) && id !== slotOf(o, "outer")) continue;
      implicated.add(id);
      if (!why.has(id)) why.set(id, whyPhrase(rc, b.code, id));
    }
    const opts = optsFor(o);
    let current: { slots: OutfitSlot[]; footwearAlternatives: string[] } = { slots: o.slots, footwearAlternatives: o.footwearAlternatives.filter((id) => !implicated.has(id)) };
    let ok = true;
    const roles = o.slots.filter((s) => implicated.has(s.garmentId)).map((s) => s.role);
    for (const role of roles) {
      const avoid = new Set<string>([...implicated, ...(role === "top" ? usedTops : role === "bottom" ? usedBottoms : [])]);
      if (role === "outer" || role === "neckwear" || role === "belt" || role === "mid_layer") {
        // An optional layer: replace it when something eligible fits, otherwise the outfit goes without it.
        const found = findReplacement(rc, current, role, { avoidGarmentIds: avoid, validate: { explicitGarmentIds: opts.explicitGarmentIds } });
        current = found ? { slots: found.slots, footwearAlternatives: found.footwearAlternatives } : { slots: current.slots.filter((s) => s.role !== role), footwearAlternatives: current.footwearAlternatives };
        continue;
      }
      const found = findReplacement(rc, current, role, { avoidGarmentIds: avoid, validate: { explicitGarmentIds: opts.explicitGarmentIds } });
      if (!found) {
        ok = false;
        break;
      }
      current = { slots: found.slots, footwearAlternatives: found.footwearAlternatives };
    }
    const finalValidation = ok ? validateCandidate(rc, current, opts) : null;
    if (ok && finalValidation?.valid) {
      const t = slotOf(current, "top");
      const b = slotOf(current, "bottom");
      if (t) usedTops.add(t);
      if (b) usedBottoms.add(b);
      next.push({
        optionId: o.optionId,
        slots: current.slots,
        footwearAlternatives: current.footwearAlternatives,
        reason: factualReason(rc, current.slots),
        suitsEventIds: o.suitsEventIds,
        evidence: optionEvidence(finalValidation, Number((finalValidation.evidence as any).availability.jointAvailability), { source: "repair", explanationSource: "factual", removedClaims: [], explicitGarmentIds: opts.explicitGarmentIds.filter((id) => current.slots.some((s) => s.garmentId === id)) }),
        changed: true,
      });
      continue;
    }
    // The option cannot be repaired piece by piece: a complete reserve takes its place, under its own identity.
    const index = spareReserves.findIndex((r) => !usedTops.has(slotOf(r, "top") ?? ""));
    if (index >= 0) {
      const reserve = spareReserves.splice(index, 1)[0]!;
      const t = slotOf(reserve, "top");
      const b = slotOf(reserve, "bottom");
      if (t) usedTops.add(t);
      if (b) usedBottoms.add(b);
      next.push({ ...storedToDraft(reserve, true) });
    } else {
      withdrawn++;
    }
  }
  const keptReserves = spareReserves.filter((r) => !usedTops.has(slotOf(r, "top") ?? "")).map((r) => storedToDraft(r));
  if (keptReserves.length !== reserves.length) changed = true;
  const shortage = next.length < requestedCount
    ? next.length === 0
      ? "No complete outfit is available for this day at the moment."
      : `${next.length} valid ${next.length === 1 ? "outfit" : "outfits"} instead of ${requestedCount}: the others could not be replaced from eligible stock.`
    : null;
  return { changed, offered: next, reserves: keptReserves, changes: changed ? describeChanges(rc, offered, next, why) : [], shortage, withdrawn };
}

/* ------------------------------------------------------------------ */
/* Post-commit state of the committing command                          */
/* ------------------------------------------------------------------ */

const BALANCE_DELETE = "DELETE FROM stock_balances WHERE user_id = ? AND garment_id = ?";
const BALANCE_INSERT = "INSERT INTO stock_balances (user_id, garment_id, bucket, ref, quantity, held)";

/**
 * What the wardrobe will look like once this command commits. Stock balances come from the stock
 * planner's own materialization statements in the plan (every stock change goes through it); policy
 * and restriction changes come from the command's typed payload.
 */
export function overlayFromPlan(ctx: CommandContext, plan: CommandPlan, changes: DomainChanges): Overlay {
  const balances = new Map<string, BalanceRow[]>();
  for (const s of plan.statements ?? []) {
    const sql = s.sql.trim();
    if (sql.startsWith(BALANCE_DELETE)) balances.set(String(s.params[1]), []);
    else if (sql.startsWith(BALANCE_INSERT)) {
      const id = String(s.params[1]);
      const list = balances.get(id) ?? [];
      list.push({ bucket: s.params[2] as BalanceRow["bucket"], ref: String(s.params[3] ?? ""), quantity: Number(s.params[4]), held: s.params[5] === true || s.params[5] === 1 });
      balances.set(id, list);
    }
  }
  const overlay: Overlay = { balances };
  const payload = ctx.envelope.payload as Record<string, any>;
  switch (ctx.envelope.type) {
    case "garment.set_planning_policy":
      overlay.planningPolicy = new Map([[String(payload.garmentId), payload.policy]]);
      break;
    case "restriction.add":
      overlay.addRestrictions = [{ restrictionId: String(payload.restrictionId ?? "committing"), kind: String(payload.kind), scope: payload.scope ?? {} }];
      break;
    case "restriction.resolve":
      overlay.removeRestrictionIds = new Set([String(payload.restrictionId)]);
      break;
    case "garment.merge":
      overlay.unavailable = new Set([String(payload.sourceGarmentId)]);
      break;
    case "garment.remove_fabricated":
      overlay.unavailable = new Set([String(payload.garmentId)]);
      break;
  }
  overlay.addWears = changes.wears.filter((w) => w.change !== "retracted").map((w) => ({ garmentId: w.garmentId, wearingDate: w.wearingDate }));
  overlay.removeWears = changes.wears.filter((w) => w.change === "retracted").map((w) => ({ garmentId: w.garmentId, wearingDate: w.wearingDate }));
  return overlay;
}

/** Commands whose effect on eligibility the hook cannot derive exactly; their boards are flagged for the sweep. */
const FLAG_ONLY = new Set(["command.undo", "garment.correct", "style.upsert_rule", "settings.update", "style.set_brief", "style.retire_brief"]);

export const boardRepairHook: CommitHook = async (ctx, plan, changes): Promise<PlanFragment | void> => {
  const type = ctx.envelope.type;
  if (type.startsWith("board.") || type.startsWith("exposure.") || type.startsWith("weather.") || type.startsWith("calendar.") || type.startsWith("trip.") || type.startsWith("service.")) return;
  const affected = new Set<string>([...changes.availabilityChanged, ...changes.wears.map((w) => w.garmentId)]);
  const broad = changes.restrictionsChanged;
  const flagOnly = FLAG_ONLY.has(type) || changes.styleChanged || changes.settingsChanged;
  if (affected.size === 0 && !broad && !flagOnly) return;

  const today = localDateOf(ctx.nowMs, ctx.settings.timezone);
  const statements: Stmt[] = [];
  const fragment: Required<Pick<PlanFragment, "statements" | "preconditions" | "affected" | "effects" | "outbox" | "repairs">> & { result: Record<string, unknown> } = { statements, preconditions: [], affected: [], effects: [], outbox: [], repairs: [], result: {} };

  // A recorded wear makes that day's board the day's record: it is never silently restyled afterwards.
  const payload = ctx.envelope.payload as Record<string, any>;
  const wornDates = [...new Set(changes.wears.filter((w) => w.change !== "retracted").map((w) => w.wearingDate))];
  const wornScope = typeof payload.tripId === "string" && payload.tripId ? `trip:${payload.tripId}` : "home";
  for (const date of wornDates) {
    statements.push(stmt("UPDATE boards SET status = 'worn', updated_at = ? WHERE user_id = ? AND scope = ? AND local_date = ? AND status = 'active'", ctx.now, ctx.userId, wornScope, date));
  }
  for (const date of [...new Set(changes.wears.filter((w) => w.change === "retracted").map((w) => w.wearingDate))]) {
    if (wornDates.includes(date) || date < today) continue;
    const remaining = await all<{ garment_id: string }>(ctx.db, "SELECT garment_id FROM daily_wears WHERE user_id = ? AND wearing_date = ? AND status = 'active'", ctx.userId, date);
    const retracted = new Set(changes.wears.filter((w) => w.change === "retracted" && w.wearingDate === date).map((w) => w.garmentId));
    // Undoing a mistaken recording reopens the day's board; the sweep revalidates it.
    if (remaining.every((r) => retracted.has(r.garment_id))) statements.push(stmt("UPDATE boards SET status = 'active', needs_replenishment = 1, updated_at = ? WHERE user_id = ? AND local_date = ? AND status = 'worn'", ctx.now, ctx.userId, date));
  }

  let boards = await all<BoardRow>(ctx.db, "SELECT * FROM boards WHERE user_id = ? AND status = 'active' AND local_date >= ? ORDER BY local_date, scope", ctx.userId, addDays(today, -1));
  // A board is open while its own local day has not passed (a trip board lives in the destination's timezone).
  boards = boards.filter((b) => b.local_date >= localDateOf(ctx.nowMs, b.timezone));
  boards = boards.filter((b) => !(wornDates.includes(b.local_date) && b.scope === wornScope));
  if (boards.length === 0) return statements.length > 0 ? fragment : undefined;

  if (flagOnly && affected.size === 0 && !broad) {
    statements.push(stmt("UPDATE boards SET needs_replenishment = 1, updated_at = ? WHERE user_id = ? AND status = 'active' AND local_date >= ?", ctx.now, ctx.userId, today));
    return fragment;
  }
  if (!broad) {
    const hits = await allIn<{ board_id: string }>(
      ctx.db,
      "SELECT DISTINCT g.board_id FROM board_option_garments g JOIN boards b ON b.user_id = g.user_id AND b.board_id = g.board_id AND b.current_revision = g.revision WHERE g.user_id = ? AND b.status = 'active' AND g.garment_id IN (:ids)",
      [ctx.userId],
      [...affected],
    );
    const ids = new Set(hits.map((h) => h.board_id));
    boards = boards.filter((b) => ids.has(b.board_id));
    if (boards.length === 0) return statements.length > 0 ? fragment : undefined;
  }

  const overlay = overlayFromPlan(ctx, plan, changes);
  const repaired: Record<string, unknown>[] = [];
  for (const board of boards) {
    try {
      const revision = await loadRevision(ctx.db, ctx.userId, board.board_id, board.current_revision);
      if (!revision) continue;
      const weather = revision.weather_snapshot_id ? await weatherSnapshotById(ctx.db, ctx.userId, revision.weather_snapshot_id) : null;
      const calendar = revision.calendar_snapshot_id ? await calendarSnapshotById(ctx.db, ctx.userId, revision.calendar_snapshot_id) : null;
      const rc = await assembleContext(ctx.db, ctx.principal, { localDate: board.local_date, nowMs: ctx.nowMs, scope: board.scope, brief: revision.brief, conditions: revision.conditions, weather, calendar, overlay, withoutProfileText: true });
      const stored = await loadOptions(ctx.db, ctx.userId, board.board_id, board.current_revision);
      const outcome = repairOptions(rc, stored, revision.requested_count);
      if (!outcome.changed) continue;
      const evening = parseScope(board.scope).evening;
      const write = await planRevisionWrite(ctx, {
        existing: board,
        scope: board.scope,
        localDate: board.local_date,
        timezone: board.timezone,
        reason: "repair",
        requestedCount: revision.requested_count,
        brief: revision.brief,
        conditions: revision.conditions,
        context: revisionContext(rc, { repairedBy: { commandId: ctx.commandId, type } }),
        weatherLine: revision.weather_line,
        suitabilityLine: revision.suitability_line,
        notice: boardNotice(rc, outcome.shortage),
        changes: outcome.changes,
        weatherSnapshotId: revision.weather_snapshot_id,
        calendarSnapshotId: revision.calendar_snapshot_id,
        offered: outcome.offered,
        reserves: outcome.reserves,
        projectToCalendar: !evening && !(await pauseCovering(ctx.db, ctx.userId, board.local_date)),
        writeExposure: !evening,
        needsReplenishment: outcome.offered.length < revision.requested_count || outcome.reserves.length < rc.daily.reserveCount,
      });
      statements.push(...write.statements);
      fragment.preconditions.push(...write.preconditions);
      fragment.affected.push(...write.affected);
      fragment.effects.push(...write.effects);
      fragment.outbox.push(...write.outbox);
      const lines = outcome.changes.length > 0 ? outcome.changes : ["reserve options refreshed"];
      fragment.repairs.push(`Board for ${board.local_date} updated (revision ${write.revision}): ${lines.join("; ")}`);
      repaired.push({ boardId: board.board_id, localDate: board.local_date, scope: board.scope, revision: write.revision, changes: outcome.changes, offered: outcome.offered.length, requestedCount: revision.requested_count, withdrawn: outcome.withdrawn, selectionKept: write.selectionKept });
    } catch (e) {
      // The observation must commit regardless; the sweep repairs this board from committed state.
      statements.push(stmt("UPDATE boards SET needs_replenishment = 1, updated_at = ? WHERE user_id = ? AND board_id = ?", ctx.now, ctx.userId, board.board_id));
      fragment.repairs.push(`Board for ${board.local_date}: repair deferred to the background sweep (${String((e as Error)?.message ?? e).slice(0, 120)})`);
    }
  }
  if (repaired.length > 0) fragment.result = { boardRepairs: repaired };
  if (flagOnly) statements.push(stmt("UPDATE boards SET needs_replenishment = 1, updated_at = ? WHERE user_id = ? AND status = 'active' AND local_date >= ?", ctx.now, ctx.userId, today));
  return fragment;
};
