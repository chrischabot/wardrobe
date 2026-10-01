import { FOUNDATION_COMMANDS as C } from "@garderobe/contracts";
import { all, allIn, first, stmt, type Stmt } from "../db.ts";
import { CommandError } from "../errors.ts";
import { addDays, endOfLocalDateMs, isoWeekday, localDateOf, toInstant, zonedToUtcMs } from "../util.ts";
import type { GarmentRow, StockPlanner } from "../stock/planner.ts";
import type { CommandContext, CommandPlan, DomainChanges } from "../commands/types.ts";
import { restrictionCovers } from "../availability/estimator.ts";
import { attrs, loadGarments, nameList, simpleStockUndo, stockParts, undoStockEvents } from "./common.ts";
import { define } from "./garments.ts";

/* ------------------------------------------------------------------ */
/* Wear                                                                 */
/* ------------------------------------------------------------------ */

interface WearAddition {
  statements: Stmt[];
  counted: string[];
  merged: string[];
  observationIds: string[];
  names: string[];
  wears: DomainChanges["wears"];
  repairs: string[];
}

/** When a wear on `wearingDate` happened, for event ordering: explicit time, now (today), or local noon (past date). */
function wearOccurredAt(ctx: CommandContext, wearingDate: string, timezone: string): string {
  if (ctx.occurredAtExplicit) return ctx.occurredAt;
  const today = localDateOf(ctx.nowMs, timezone);
  if (wearingDate === today) return ctx.now;
  return toInstant(zonedToUtcMs(wearingDate, "12:00", timezone));
}

async function planWearAdditions(
  ctx: CommandContext,
  planner: StockPlanner,
  garments: GarmentRow[],
  wearingDate: string,
  timezone: string,
  opts: { segment: string | null; note: string | null; tripId: string | null },
): Promise<WearAddition> {
  const out: WearAddition = { statements: [], counted: [], merged: [], observationIds: [], names: [], wears: [], repairs: [] };
  const occurredAt = wearOccurredAt(ctx, wearingDate, timezone);
  const dirtyAtMs = endOfLocalDateMs(wearingDate, timezone);
  const ids = garments.map((g) => g.garment_id);
  const existing = await allIn<{ garment_id: string; status: string }>(
    ctx.db,
    "SELECT garment_id, status FROM daily_wears WHERE user_id = ? AND wearing_date = ? AND garment_id IN (:ids)",
    [ctx.userId, wearingDate],
    ids,
  );
  const existingStatus = new Map(existing.map((r) => [r.garment_id, r.status]));
  const restrictions = await all<{ restriction_id: string; reason: string; scope_json: string }>(ctx.db, "SELECT restriction_id, reason, scope_json FROM restrictions WHERE user_id = ? AND status = 'active'", ctx.userId);

  for (const g of garments) {
    const observationId = ctx.newId("obs");
    out.observationIds.push(observationId);
    out.names.push(g.name);
    // Every report is kept with its provenance, including duplicates from another client.
    out.statements.push(
      stmt(
        `INSERT INTO wear_observations (user_id, observation_id, garment_id, wearing_date, occurred_at, reported_at, timezone, channel, client_submission_id, segment, note, command_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ctx.userId,
        observationId,
        g.garment_id,
        wearingDate,
        occurredAt,
        ctx.now,
        timezone,
        ctx.principal.channel,
        ctx.envelope.source.clientSubmissionId ?? null,
        opts.segment,
        opts.note,
        ctx.commandId,
      ),
    );
    if (existingStatus.get(g.garment_id) === "active") {
      // Same garment, same wearing date: one counted wear. The report merges; no further unit is consumed.
      out.merged.push(g.garment_id);
      out.wears.push({ garmentId: g.garment_id, wearingDate, change: "merged" });
      out.statements.push(
        stmt("UPDATE daily_wears SET observation_count = observation_count + 1, updated_at = ? WHERE user_id = ? AND garment_id = ? AND wearing_date = ?", ctx.now, ctx.userId, g.garment_id, wearingDate),
      );
      // Touch the garment so a concurrent first report of the same key re-plans instead of double counting.
      planner.touch(g.garment_id);
      continue;
    }
    const payload: Record<string, unknown> = { wearingDate, dirtyAtMs };
    if (opts.tripId) payload.tripId = opts.tripId;
    const eventId = planner.add(g.garment_id, "wear", payload, "observed", occurredAt);
    out.counted.push(g.garment_id);
    out.wears.push({ garmentId: g.garment_id, wearingDate, change: "counted" });
    out.statements.push(
      stmt(
        `INSERT INTO daily_wears (user_id, garment_id, wearing_date, observation_count, status, stock_event_id, first_reported_at, updated_at)
         VALUES (?, ?, ?, 1, 'active', ?, ?, ?)
         ON CONFLICT (user_id, garment_id, wearing_date) DO UPDATE SET observation_count = observation_count + 1, status = 'active', stock_event_id = excluded.stock_event_id, updated_at = excluded.updated_at`,
        ctx.userId,
        g.garment_id,
        wearingDate,
        eventId,
        ctx.now,
        ctx.now,
      ),
    );
    const a = attrs(g);
    for (const r of restrictions) {
      if (restrictionCovers(JSON.parse(r.scope_json), { garmentId: g.garment_id, category: g.category, attributes: a })) {
        out.repairs.push(`${g.name}: worn while restricted (${r.reason}); the wear is recorded and the restriction is unchanged`);
      }
    }
  }
  return out;
}

async function planWearRetractions(ctx: CommandContext, planner: StockPlanner, garments: GarmentRow[], wearingDate: string): Promise<{ statements: Stmt[]; wears: DomainChanges["wears"]; retracted: string[] }> {
  const statements: Stmt[] = [];
  const wears: DomainChanges["wears"] = [];
  const retracted: string[] = [];
  for (const g of garments) {
    const dw = await first<{ status: string; stock_event_id: string | null }>(ctx.db, "SELECT status, stock_event_id FROM daily_wears WHERE user_id = ? AND garment_id = ? AND wearing_date = ?", ctx.userId, g.garment_id, wearingDate);
    if (!dw || dw.status !== "active") continue;
    retracted.push(g.garment_id);
    wears.push({ garmentId: g.garment_id, wearingDate, change: "retracted" });
    statements.push(
      stmt("UPDATE wear_observations SET status = 'retracted', retracted_by_command_id = ? WHERE user_id = ? AND garment_id = ? AND wearing_date = ? AND status = 'active'", ctx.commandId, ctx.userId, g.garment_id, wearingDate),
      stmt("UPDATE daily_wears SET status = 'retracted', observation_count = 0, updated_at = ? WHERE user_id = ? AND garment_id = ? AND wearing_date = ?", ctx.now, ctx.userId, g.garment_id, wearingDate),
    );
    if (dw.stock_event_id) planner.void(dw.stock_event_id, g.garment_id);
    else planner.touch(g.garment_id);
  }
  return { statements, wears, retracted };
}

function friendlyDate(wearingDate: string, today: string): string {
  if (wearingDate === today) return "today";
  if (wearingDate === addDays(today, -1)) return "yesterday";
  return wearingDate;
}

export const wearRecord = define({
  type: "wear.record",
  schema: C["wear.record"],
  class: "observation",
  requiredScope: "write",
  async plan(ctx, p): Promise<CommandPlan> {
    const timezone = p.timezone ?? ctx.settings.timezone;
    const today = localDateOf(ctx.nowMs, timezone);
    if (p.wearingDate > today) {
      throw new CommandError("invalid_command", "a wear cannot be recorded for a future date; choose an outfit instead", { wearingDate: p.wearingDate, today });
    }
    const requested = [...new Set([...p.garmentIds, ...p.additionalUnits.map((a) => a.garmentId)])];
    const loaded = await loadGarments(ctx, requested);
    // Distinct canonical garments (two aliases merged into one garment count once).
    const canonical = new Map<string, GarmentRow>();
    for (const id of p.garmentIds) {
      const g = loaded.get(id)!;
      canonical.set(g.garment_id, g);
    }
    const planner = ctx.stock();
    const add = await planWearAdditions(ctx, planner, [...canonical.values()], p.wearingDate, timezone, { segment: p.segment, note: p.note, tripId: p.tripId });
    const extraEventIds: string[] = [];
    const dirtyAtMs = endOfLocalDateMs(p.wearingDate, timezone);
    for (const extra of p.additionalUnits) {
      // A further interchangeable unit was physically used: stock moves, the daily wear statistic does not.
      const g = loaded.get(extra.garmentId)!;
      const payload: Record<string, unknown> = { quantity: extra.quantity, dirtyAtMs, wearingDate: p.wearingDate };
      if (p.tripId) payload.tripId = p.tripId;
      extraEventIds.push(planner.add(g.garment_id, "extra_unit", payload, "observed", wearOccurredAt(ctx, p.wearingDate, timezone)));
    }
    const build = await planner.build();
    const parts = stockParts(build);
    const statements = [
      ...parts.statements,
      ...add.statements,
      // The observation replaces the corresponding selection uncertainty for that date.
      stmt("UPDATE exposure_sets SET status = 'resolved_worn', updated_at = ? WHERE user_id = ? AND local_date = ? AND status IN ('open', 'selected')", ctx.now, ctx.userId, p.wearingDate),
    ];
    const when = friendlyDate(p.wearingDate, today);
    const allMerged = add.counted.length === 0 && extraEventIds.length === 0;
    const summary = allMerged
      ? `Already recorded for ${when}: ${nameList(add.names)}. The report was merged; nothing was counted twice`
      : `Recorded for ${when}: ${nameList(add.names)}` + (add.merged.length > 0 ? ` (${add.merged.length} already recorded that day, counted once)` : "");
    return {
      outcome: allMerged ? "merged" : "committed",
      summary,
      statements,
      preconditions: parts.preconditions,
      affected: parts.affected,
      repairs: [...parts.repairs, ...add.repairs],
      result: { wearingDate: p.wearingDate, counted: add.counted, merged: add.merged, observationIds: add.observationIds, additionalUnitEvents: extraEventIds.length },
      changes: { availabilityChanged: parts.availabilityChanged, wears: add.wears },
      bumpWardrobe: true,
      undo: { data: { observationIds: add.observationIds, wearingDate: p.wearingDate, stockEventIds: extraEventIds } },
    };
  },
  async planUndo(ctx, _original, data): Promise<CommandPlan> {
    const planner = ctx.stock();
    const obs = await allIn<{ observation_id: string; garment_id: string; status: string }>(
      ctx.db,
      "SELECT observation_id, garment_id, status FROM wear_observations WHERE user_id = ? AND observation_id IN (:ids)",
      [ctx.userId],
      data.observationIds as string[],
    );
    const statements: Stmt[] = [];
    const wears: DomainChanges["wears"] = [];
    for (const o of obs) {
      if (o.status !== "active") continue;
      statements.push(stmt("UPDATE wear_observations SET status = 'retracted', retracted_by_command_id = ? WHERE user_id = ? AND observation_id = ?", ctx.commandId, ctx.userId, o.observation_id));
      const dw = await first<{ observation_count: number; stock_event_id: string | null }>(ctx.db, "SELECT observation_count, stock_event_id FROM daily_wears WHERE user_id = ? AND garment_id = ? AND wearing_date = ?", ctx.userId, o.garment_id, data.wearingDate);
      if (!dw) continue;
      if (dw.observation_count <= 1) {
        // This was the only report of that wear: the counted wear and its stock effect are compensated.
        statements.push(stmt("UPDATE daily_wears SET status = 'retracted', observation_count = 0, updated_at = ? WHERE user_id = ? AND garment_id = ? AND wearing_date = ?", ctx.now, ctx.userId, o.garment_id, data.wearingDate));
        if (dw.stock_event_id) planner.void(dw.stock_event_id, o.garment_id);
        wears.push({ garmentId: o.garment_id, wearingDate: data.wearingDate, change: "retracted" });
      } else {
        // Another report of the same wear stands; only this report is withdrawn.
        statements.push(stmt("UPDATE daily_wears SET observation_count = observation_count - 1, updated_at = ? WHERE user_id = ? AND garment_id = ? AND wearing_date = ?", ctx.now, ctx.userId, o.garment_id, data.wearingDate));
        planner.touch(o.garment_id);
      }
    }
    await undoStockEvents(ctx, planner, (data.stockEventIds ?? []) as string[]);
    const parts = stockParts(await planner.build());
    return {
      summary: `Wear record for ${data.wearingDate} undone (${wears.length} counted wear${wears.length === 1 ? "" : "s"} withdrawn)`,
      statements: [...parts.statements, ...statements],
      preconditions: parts.preconditions,
      affected: parts.affected,
      changes: { availabilityChanged: parts.availabilityChanged, wears },
      bumpWardrobe: true,
      undo: { unavailableReason: "this is already an undo; record the wear again if it happened" },
    };
  },
});

export const wearAmend = define({
  type: "wear.amend",
  schema: C["wear.amend"],
  class: "observation",
  requiredScope: "write",
  async plan(ctx, p): Promise<CommandPlan> {
    if (p.remove.length === 0 && p.add.length === 0) throw new CommandError("invalid_command", "an amendment needs something to remove or add");
    const timezone = ctx.settings.timezone;
    const loaded = await loadGarments(ctx, [...p.remove, ...p.add]);
    const planner = ctx.stock();
    const removeRows = [...new Map(p.remove.map((id) => [loaded.get(id)!.garment_id, loaded.get(id)!])).values()];
    const addRows = [...new Map(p.add.map((id) => [loaded.get(id)!.garment_id, loaded.get(id)!])).values()];
    const removed = await planWearRetractions(ctx, planner, removeRows, p.wearingDate);
    const added = await planWearAdditions(ctx, planner, addRows, p.wearingDate, timezone, { segment: null, note: p.reason, tripId: null });
    const build = await planner.build();
    const parts = stockParts(build);
    const repairs = [...parts.repairs, ...added.repairs];
    for (const g of build.garments.values()) {
      const svc = (r: typeof g.before) => [...r.state.service.values()].reduce((n, h) => n + h.quantity, 0);
      if (svc(g.before) !== svc(g.after)) {
        repairs.push(`${g.garment.name}: a later laundry pickup is preserved; the batch is adjusted because this item was not worn, so it was not in the bag`);
      }
    }
    const names = (rows: GarmentRow[]) => nameList(rows.map((r) => r.name));
    const bits: string[] = [];
    if (removed.retracted.length > 0) bits.push(`removed ${names(removeRows.filter((r) => removed.retracted.includes(r.garment_id)))}`);
    if (added.names.length > 0) bits.push(`added ${nameList(added.names)}`);
    if (bits.length === 0) return { outcome: "noop", summary: `${p.wearingDate}: the record already matches`, undo: { unavailableReason: "nothing changed" } };
    return {
      summary: `Corrected ${p.wearingDate}: ${bits.join("; ")}`,
      statements: [...parts.statements, ...removed.statements, ...added.statements],
      preconditions: parts.preconditions,
      affected: parts.affected,
      repairs,
      result: { wearingDate: p.wearingDate, removed: removed.retracted, counted: added.counted, merged: added.merged },
      changes: { availabilityChanged: parts.availabilityChanged, wears: [...removed.wears, ...added.wears] },
      bumpWardrobe: true,
      undo: { unavailableReason: "amend again to restore the earlier record; every revision is kept" },
    };
  },
});

/* ------------------------------------------------------------------ */
/* Care                                                                 */
/* ------------------------------------------------------------------ */

export const careMarkDirty = define({
  type: "care.mark_dirty",
  schema: C["care.mark_dirty"],
  class: "observation",
  requiredScope: "write",
  async plan(ctx, p) {
    const loaded = await loadGarments(ctx, p.items.map((i) => i.garmentId));
    const planner = ctx.stock();
    const eventIds: string[] = [];
    const names: string[] = [];
    for (const item of p.items) {
      const g = loaded.get(item.garmentId)!;
      if (g.care_channel === "none") throw new CommandError("precondition_failed", `${g.name} is never laundered and cannot be put in the wash`, { garmentId: g.garment_id });
      names.push(g.name);
      eventIds.push(planner.add(g.garment_id, "mark_dirty", { quantity: item.quantity }, "observed", ctx.occurredAt));
    }
    const parts = stockParts(await planner.build());
    return {
      summary: `In the wash: ${nameList(names)}`,
      ...parts,
      changes: { availabilityChanged: parts.availabilityChanged },
      bumpWardrobe: true,
      undo: { data: { stockEventIds: eventIds } },
    };
  },
  planUndo: (ctx, original, data) => simpleStockUndo(ctx, original, data),
});

export const careWashed = define({
  type: "care.washed",
  schema: C["care.washed"],
  class: "observation",
  requiredScope: "write",
  async plan(ctx, p) {
    const planner = ctx.stock();
    const eventIds: string[] = [];
    const names: string[] = [];
    const statements: Stmt[] = [];
    const washedIds: string[] = [];
    if (p.allOfChannel) {
      const rows = await all<{ garment_id: string; name: string }>(
        ctx.db,
        `SELECT g.garment_id, g.name FROM garments g JOIN stock_balances b ON b.user_id = g.user_id AND b.garment_id = g.garment_id
          WHERE g.user_id = ? AND g.care_channel = ? AND b.bucket = 'dirty' AND b.quantity > 0 ORDER BY g.name`,
        ctx.userId,
        p.allOfChannel,
      );
      for (const r of rows) {
        names.push(r.name);
        washedIds.push(r.garment_id);
        eventIds.push(planner.add(r.garment_id, "wash", {}, "observed", ctx.occurredAt));
      }
    }
    const itemIds: string[] = [];
    if (p.items) {
      const loaded = await loadGarments(ctx, p.items.map((i) => i.garmentId));
      for (const item of p.items) {
        const g = loaded.get(item.garmentId)!;
        if (washedIds.includes(g.garment_id)) continue;
        if (g.care_channel === "none") throw new CommandError("precondition_failed", `${g.name} is never laundered`, { garmentId: g.garment_id });
        names.push(g.name);
        washedIds.push(g.garment_id);
        itemIds.push(g.garment_id);
        // Without a count, "it is washed" also brings back units reported still away (never ones reported lost).
        eventIds.push(planner.add(g.garment_id, "wash", item.quantity ? { quantity: item.quantity } : { releaseHeld: true }, "observed", ctx.occurredAt));
      }
    }
    if (eventIds.length === 0) return { outcome: "noop", summary: "Nothing was awaiting a wash", undo: { unavailableReason: "nothing changed" } };
    const build = await planner.build();
    const parts = stockParts(build);

    // An exception is settled only by what actually moved: its row is resolved when the units it held are
    // no longer away, and reduced when only some of them came back. A unit that stays away keeps its exception.
    const settled: SettledException[] = [];
    const open = await allIn<{ exception_id: string; garment_id: string; batch_id: string | null; quantity: number }>(
      ctx.db,
      "SELECT exception_id, garment_id, batch_id, quantity FROM laundry_exceptions WHERE user_id = ? AND status = 'active' AND garment_id IN (:ids)",
      [ctx.userId],
      itemIds,
    );
    for (const x of open) {
      const g = build.garments.get(x.garment_id);
      if (!g) continue;
      const ref = x.batch_id ?? `exception:${x.exception_id}`;
      const before = g.before.state.service.get(ref)?.quantity ?? 0;
      const after = g.after.state.service.get(ref)?.quantity ?? 0;
      if (after > 0 && after >= before) continue;
      settled.push({ exceptionId: x.exception_id, garmentId: x.garment_id, batchId: x.batch_id, previousQuantity: x.quantity, heldBefore: before, heldAfter: after });
      if (after === 0) {
        statements.push(stmt("UPDATE laundry_exceptions SET status = 'resolved', resolved_at = ? WHERE user_id = ? AND exception_id = ? AND status = 'active'", ctx.now, ctx.userId, x.exception_id));
      } else {
        statements.push(stmt("UPDATE laundry_exceptions SET quantity = ? WHERE user_id = ? AND exception_id = ? AND status = 'active'", after, ctx.userId, x.exception_id));
      }
      if (x.batch_id) {
        // The batch's own record of what came back follows the observation.
        statements.push(
          stmt("UPDATE laundry_batch_items SET returned_quantity = MIN(quantity - ?, returned_quantity + ?), still_away = ? WHERE user_id = ? AND batch_id = ? AND garment_id = ?", after, before - after, after, ctx.userId, x.batch_id, x.garment_id),
          stmt(
            `UPDATE laundry_batches SET status = 'returned', returned_at = COALESCE(returned_at, ?), return_basis = 'observed'
              WHERE user_id = ? AND batch_id = ? AND status = 'partially_returned'
                AND NOT EXISTS (SELECT 1 FROM laundry_batch_items i WHERE i.user_id = laundry_batches.user_id AND i.batch_id = laundry_batches.batch_id AND i.returned_quantity < i.quantity)`,
            ctx.occurredAt, ctx.userId, x.batch_id,
          ),
        );
      }
    }
    return {
      summary: `Washed and clean: ${nameList(names)}`,
      statements: [...parts.statements, ...statements],
      preconditions: parts.preconditions,
      affected: parts.affected,
      repairs: parts.repairs,
      result: { washed: washedIds, exceptionsSettled: settled.filter((x) => x.heldAfter === 0).map((x) => x.exceptionId) },
      changes: { availabilityChanged: parts.availabilityChanged },
      bumpWardrobe: true,
      undo: { data: { stockEventIds: eventIds, settled } },
    };
  },
  async planUndo(ctx, original, data) {
    // The units go back to where the ledger had them, and so do the exceptions this report settled.
    const extra: Stmt[] = [];
    for (const x of (data.settled ?? []) as SettledException[]) {
      extra.push(stmt("UPDATE laundry_exceptions SET status = 'active', resolved_at = NULL, quantity = ? WHERE user_id = ? AND exception_id = ?", x.previousQuantity, ctx.userId, x.exceptionId));
      if (!x.batchId) continue;
      extra.push(
        stmt("UPDATE laundry_batch_items SET returned_quantity = MAX(0, returned_quantity - ?), still_away = ? WHERE user_id = ? AND batch_id = ? AND garment_id = ?", x.heldBefore - x.heldAfter, x.heldBefore, ctx.userId, x.batchId, x.garmentId),
        stmt(
          `UPDATE laundry_batches SET status = 'partially_returned' WHERE user_id = ? AND batch_id = ? AND status = 'returned'
             AND EXISTS (SELECT 1 FROM laundry_batch_items i WHERE i.user_id = laundry_batches.user_id AND i.batch_id = laundry_batches.batch_id AND i.still_away > 0)`,
          ctx.userId, x.batchId,
        ),
      );
    }
    return simpleStockUndo(ctx, original, data, extra);
  },
});

/** A laundry exception a wash report settled or reduced, with what undo needs to put it back. */
interface SettledException {
  exceptionId: string;
  garmentId: string;
  batchId: string | null;
  previousQuantity: number;
  heldBefore: number;
  heldAfter: number;
}

/* ------------------------------------------------------------------ */
/* Service laundry                                                      */
/* ------------------------------------------------------------------ */

/** Dirty service-channel quantities, less units being worn on or after `localDate` (still on the body). */
async function collectableQuantities(ctx: CommandContext, localDate: string): Promise<{ garment_id: string; name: string; quantity: number }[]> {
  const rows = await all<{ garment_id: string; name: string; dirty: number; worn_now: number }>(
    ctx.db,
    `SELECT g.garment_id, g.name, b.quantity AS dirty,
            (SELECT COUNT(*) FROM daily_wears w WHERE w.user_id = g.user_id AND w.garment_id = g.garment_id AND w.status = 'active' AND w.wearing_date >= ?) AS worn_now
       FROM garments g JOIN stock_balances b ON b.user_id = g.user_id AND b.garment_id = g.garment_id
      WHERE g.user_id = ? AND g.care_channel = 'service' AND b.bucket = 'dirty' AND b.quantity > 0 ORDER BY g.name`,
    localDate,
    ctx.userId,
  );
  return rows.map((r) => ({ garment_id: r.garment_id, name: r.name, quantity: Math.max(0, r.dirty - r.worn_now) })).filter((r) => r.quantity > 0);
}

export const laundryCollect = define({
  type: "laundry.collect",
  schema: C["laundry.collect"],
  class: "observation",
  requiredScope: "write",
  async plan(ctx, p) {
    const localDate = localDateOf(ctx.occurredAtMs, ctx.settings.timezone);
    const quantities = new Map<string, { name: string; quantity: number }>();
    for (const r of await collectableQuantities(ctx, localDate)) {
      if (!p.exclude.includes(r.garment_id)) quantities.set(r.garment_id, { name: r.name, quantity: r.quantity });
    }
    if (p.include.length > 0) {
      const loaded = await loadGarments(ctx, p.include.map((i) => i.garmentId));
      for (const inc of p.include) {
        const g = loaded.get(inc.garmentId)!;
        if (g.care_channel !== "service") throw new CommandError("precondition_failed", `${g.name} does not go to the laundry service`, { garmentId: g.garment_id });
        quantities.set(g.garment_id, { name: g.name, quantity: inc.quantity });
      }
    }
    if (quantities.size === 0) return { outcome: "noop", summary: "Nothing was awaiting collection", undo: { unavailableReason: "nothing changed" } };
    const batchId = p.batchId ?? ctx.newId("lb");
    const planner = ctx.stock();
    const eventIds: string[] = [];
    for (const [garmentId, q] of quantities) eventIds.push(planner.add(garmentId, "pickup", { batchId, quantity: q.quantity }, "observed", ctx.occurredAt));
    const build = await planner.build();
    const parts = stockParts(build);
    const statements: Stmt[] = [stmt("INSERT INTO laundry_batches (user_id, batch_id, channel, status, picked_up_at, command_id) VALUES (?, ?, 'service', 'collected', ?, ?)", ctx.userId, batchId, ctx.occurredAt, ctx.commandId)];
    let units = 0;
    const members: { garmentId: string; quantity: number }[] = [];
    for (const [garmentId] of quantities) {
      // Membership is what actually moved (a unit cannot be collected if it was not awaiting care).
      const g = build.garments.get(garmentId)!;
      const moved = g.after.movements.filter((m) => eventIds.includes(m.eventId) && m.to === "service").reduce((n, m) => n + m.quantity, 0);
      if (moved === 0) continue;
      units += moved;
      members.push({ garmentId, quantity: moved });
      statements.push(stmt("INSERT INTO laundry_batch_items (user_id, batch_id, garment_id, quantity) VALUES (?, ?, ?, ?)", ctx.userId, batchId, garmentId, moved));
    }
    if (units === 0) return { outcome: "noop", summary: "Nothing was awaiting collection", undo: { unavailableReason: "nothing changed" } };
    return {
      summary: `Laundry collected: ${units} item${units === 1 ? "" : "s"} in the batch`,
      statements: [...statements, ...parts.statements],
      preconditions: parts.preconditions,
      affected: [...parts.affected, { kind: "laundry_batch", id: batchId, version: 1 }],
      repairs: parts.repairs,
      result: { batchId, units, members },
      changes: { availabilityChanged: parts.availabilityChanged },
      bumpWardrobe: true,
      undo: { data: { stockEventIds: eventIds, batchId } },
    };
  },
  async planUndo(ctx, original, data) {
    // A pickup can be withdrawn only while the batch is still out. Once it has come back (observed, or
    // inferred by the weekly baseline), withdrawing it would put clothes the owner has back into the hamper.
    const batch = await first<{ status: string; withdrawn_at: string | null }>(ctx.db, "SELECT status, withdrawn_at FROM laundry_batches WHERE user_id = ? AND batch_id = ?", ctx.userId, data.batchId);
    if (!batch || batch.withdrawn_at !== null) throw new CommandError("not_undoable", "that pickup is no longer on record as an open batch", { batchId: data.batchId });
    if (batch.status !== "collected") {
      throw new CommandError("not_undoable", "that laundry has already come back; report what is wrong with the return instead (an item still away, or mark an item dirty)", { batchId: data.batchId, status: batch.status });
    }
    // Compensation, not deletion: the batch and its items stay on record, marked withdrawn by this undo.
    const plan = await simpleStockUndo(ctx, original, data, [
      stmt("UPDATE laundry_batches SET withdrawn_at = ?, withdrawn_by_command_id = ? WHERE user_id = ? AND batch_id = ? AND status = 'collected' AND withdrawn_at IS NULL", ctx.now, ctx.commandId, ctx.userId, data.batchId),
    ]);
    return {
      ...plan,
      summary: "Laundry pickup withdrawn; the items are awaiting collection again",
      preconditions: [
        ...(plan.preconditions ?? []),
        { label: "the batch is still out", sql: "(SELECT status FROM laundry_batches WHERE user_id = ? AND batch_id = ? AND withdrawn_at IS NULL) = 'collected'", params: [ctx.userId, data.batchId], class: "state" },
      ],
      affected: [...(plan.affected ?? []), { kind: "laundry_batch", id: String(data.batchId), version: 2 }],
    };
  },
});

export const laundryReturn = define({
  type: "laundry.return",
  schema: C["laundry.return"],
  class: "observation",
  requiredScope: "write",
  async plan(ctx, p): Promise<CommandPlan> {
    const batch = p.batchId
      ? await first<{ batch_id: string; status: string }>(ctx.db, "SELECT batch_id, status FROM laundry_batches WHERE user_id = ? AND batch_id = ? AND withdrawn_at IS NULL", ctx.userId, p.batchId)
      : await first<{ batch_id: string; status: string }>(ctx.db, "SELECT batch_id, status FROM laundry_batches WHERE user_id = ? AND channel = 'service' AND status IN ('collected', 'partially_returned') AND withdrawn_at IS NULL ORDER BY picked_up_at ASC LIMIT 1", ctx.userId);
    if (p.batchId && !batch) throw new CommandError("not_found", `no laundry batch '${p.batchId}'`);
    const planner = ctx.stock();
    const eventIds: string[] = [];
    const statements: Stmt[] = [];

    if (!batch) {
      const missed = await planMissedCycleReturn(ctx, p.stillAway);
      if (missed) return missed;
      // No pickup was ever observed, but the owner says the laundry is back: that is the physical fact.
      // Everything that was awaiting the service (except what is being worn today) is clean.
      const localDate = localDateOf(ctx.occurredAtMs, ctx.settings.timezone);
      const rows = await collectableQuantities(ctx, localDate);
      const away = new Map(p.stillAway.map((s) => [s.garmentId, s.quantity]));
      let units = 0;
      for (const r of rows) {
        const q = r.quantity - (away.get(r.garment_id) ?? 0);
        if (q <= 0) continue;
        units += q;
        eventIds.push(planner.add(r.garment_id, "wash", { quantity: q, via: "service_return_without_recorded_pickup" }, "observed", ctx.occurredAt));
      }
      if (units === 0) return { outcome: "noop", summary: "No laundry was recorded as away or awaiting the service", undo: { unavailableReason: "nothing changed" } };
      const parts = stockParts(await planner.build());
      return {
        summary: `Laundry returned: ${units} item${units === 1 ? "" : "s"} clean (no pickup had been recorded; your report stands)`,
        ...parts,
        result: { batchId: null, returned: units },
        changes: { availabilityChanged: parts.availabilityChanged },
        bumpWardrobe: true,
        undo: { data: { stockEventIds: eventIds } },
      };
    }
    if (batch.status === "returned") return { outcome: "noop", summary: "That batch was already returned", undo: { unavailableReason: "nothing changed" } };

    const items = await all<{ garment_id: string; quantity: number; returned_quantity: number; still_away: number; name: string }>(
      ctx.db,
      "SELECT i.garment_id, i.quantity, i.returned_quantity, i.still_away, g.name FROM laundry_batch_items i JOIN garments g ON g.user_id = i.user_id AND g.garment_id = i.garment_id WHERE i.user_id = ? AND i.batch_id = ?",
      ctx.userId,
      batch.batch_id,
    );
    const awayRequested = new Map(p.stillAway.map((s) => [s.garmentId, s.quantity]));
    for (const id of awayRequested.keys()) {
      if (!items.some((i) => i.garment_id === id)) throw new CommandError("precondition_failed", "an item named as still away was not in this batch; nothing was written", { garmentId: id, batchId: batch.batch_id });
    }
    let returned = 0;
    let stillAway = 0;
    const awayNames: string[] = [];
    for (const item of items) {
      const outstanding = item.quantity - item.returned_quantity;
      if (outstanding <= 0) continue;
      const away = Math.min(awayRequested.get(item.garment_id) ?? 0, outstanding);
      const back = outstanding - away;
      returned += back;
      stillAway += away;
      eventIds.push(planner.add(item.garment_id, "return", { batchId: batch.batch_id, quantity: back, stillAway: away }, "observed", ctx.occurredAt));
      statements.push(stmt("UPDATE laundry_batch_items SET returned_quantity = returned_quantity + ?, still_away = ? WHERE user_id = ? AND batch_id = ? AND garment_id = ?", back, away, ctx.userId, batch.batch_id, item.garment_id));
      if (away > 0) {
        awayNames.push(item.name);
        statements.push(
          stmt(
            "INSERT INTO laundry_exceptions (user_id, exception_id, kind, garment_id, batch_id, quantity, occurred_at, reported_at, command_id) VALUES (?, ?, 'still_away', ?, ?, ?, ?, ?, ?)",
            ctx.userId, ctx.newId("lex"), item.garment_id, batch.batch_id, away, ctx.occurredAt, ctx.now, ctx.commandId,
          ),
        );
      } else {
        statements.push(stmt("UPDATE laundry_exceptions SET status = 'resolved', resolved_at = ? WHERE user_id = ? AND garment_id = ? AND batch_id = ? AND status = 'active'", ctx.now, ctx.userId, item.garment_id, batch.batch_id));
      }
    }
    const newStatus = stillAway > 0 ? "partially_returned" : "returned";
    statements.push(stmt("UPDATE laundry_batches SET status = ?, returned_at = ?, return_basis = 'observed' WHERE user_id = ? AND batch_id = ?", newStatus, ctx.occurredAt, ctx.userId, batch.batch_id));
    const parts = stockParts(await planner.build());
    return {
      summary: `Laundry returned: ${returned} item${returned === 1 ? "" : "s"} clean` + (stillAway > 0 ? `; still away: ${nameList(awayNames)}` : ""),
      statements: [...parts.statements, ...statements],
      preconditions: parts.preconditions,
      affected: [...parts.affected, { kind: "laundry_batch", id: batch.batch_id, version: 2 }],
      repairs: parts.repairs,
      result: { batchId: batch.batch_id, returned, stillAway },
      changes: { availabilityChanged: parts.availabilityChanged },
      bumpWardrobe: true,
      undo: { unavailableReason: "report what is still away instead; the return stays in the record" },
    };
  },
  async planUndo(ctx, original, data) {
    const extra: Stmt[] = [];
    // A missed-return exception this report settled is open again, unless a later baseline has since released that cycle.
    for (const id of (data.reopenExceptionIds ?? []) as string[]) {
      extra.push(
        stmt(
          `UPDATE laundry_exceptions SET status = 'active', resolved_at = NULL WHERE user_id = ? AND exception_id = ?
             AND NOT EXISTS (SELECT 1 FROM laundry_cycles c WHERE c.user_id = laundry_exceptions.user_id AND c.channel = 'service' AND c.cycle_key > laundry_exceptions.cycle_key)`,
          ctx.userId, id,
        ),
      );
    }
    for (const id of (data.withdrawExceptionIds ?? []) as string[]) {
      extra.push(stmt("UPDATE laundry_exceptions SET status = 'resolved', resolved_at = ? WHERE user_id = ? AND exception_id = ?", ctx.now, ctx.userId, id));
    }
    return simpleStockUndo(ctx, original, data, extra);
  },
});

/**
 * "The laundry is back" with no open batch, after the owner reported a cycle's return missed or delayed:
 * the units that cycle has been holding away are back and clean. This is the owner's observation, so it
 * stands whatever the weekly baseline inferred; the cycle's exception is settled, and anything he names as
 * still away becomes its own item exception that only he can clear. Returns null when no missed cycle is
 * holding anything, so the caller falls back to the hamper.
 */
async function planMissedCycleReturn(ctx: CommandContext, stillAway: { garmentId: string; quantity: number }[]): Promise<CommandPlan | null> {
  const held = await all<{ garment_id: string; name: string; ref: string; quantity: number }>(
    ctx.db,
    `SELECT b.garment_id, g.name, b.ref, b.quantity FROM stock_balances b JOIN garments g ON g.user_id = b.user_id AND g.garment_id = b.garment_id
      WHERE b.user_id = ? AND b.bucket = 'service' AND b.ref LIKE 'cycle:%' AND b.quantity > 0 ORDER BY g.name, b.ref`,
    ctx.userId,
  );
  if (held.length === 0) return null;
  const byGarment = new Map<string, { name: string; holdings: { ref: string; quantity: number }[]; total: number }>();
  for (const h of held) {
    const g = byGarment.get(h.garment_id) ?? { name: h.name, holdings: [], total: 0 };
    g.holdings.push({ ref: h.ref, quantity: h.quantity });
    g.total += h.quantity;
    byGarment.set(h.garment_id, g);
  }
  const away = new Map(stillAway.map((s) => [s.garmentId, s.quantity]));
  for (const id of away.keys()) {
    if (!byGarment.has(id)) throw new CommandError("precondition_failed", "an item named as still away was not among the laundry that was held back; nothing was written", { garmentId: id });
  }
  const planner = ctx.stock();
  const returnEventIds: string[] = [];
  const eventIds: string[] = [];
  const statements: Stmt[] = [];
  const withdrawExceptionIds: string[] = [];
  const awayNames: string[] = [];
  let stillAwayUnits = 0;
  for (const [garmentId, g] of byGarment) {
    for (const h of g.holdings) {
      const id = planner.add(garmentId, "return", { batchId: h.ref, quantity: h.quantity, via: "return_after_missed_cycle" }, "observed", ctx.occurredAt);
      returnEventIds.push(id);
      eventIds.push(id);
    }
    const stays = Math.min(away.get(garmentId) ?? 0, g.total);
    if (stays === 0) continue;
    // Named as still away: held under its own exception, which no weekly baseline releases.
    const exceptionId = ctx.newId("lex");
    eventIds.push(planner.add(garmentId, "exception", { exceptionId, quantity: stays, kind: "still_away" }, "observed", ctx.occurredAt));
    statements.push(
      stmt(
        "INSERT INTO laundry_exceptions (user_id, exception_id, kind, garment_id, quantity, occurred_at, reported_at, command_id) VALUES (?, ?, 'still_away', ?, ?, ?, ?, ?)",
        ctx.userId, exceptionId, garmentId, stays, ctx.occurredAt, ctx.now, ctx.commandId,
      ),
    );
    withdrawExceptionIds.push(exceptionId);
    awayNames.push(g.name);
    stillAwayUnits += stays;
  }
  const build = await planner.build();
  // What the receipt claims is what the replay actually moved (a report dated before the baseline moves nothing).
  let released = 0;
  for (const g of build.garments.values()) {
    released += g.after.movements.filter((m) => returnEventIds.includes(m.eventId) && m.from === "service" && m.to === "clean").reduce((n, m) => n + m.quantity, 0);
  }
  if (released === 0) return null;
  const parts = stockParts(build);
  const cycleKeys = [...new Set(held.map((h) => h.ref.slice("cycle:".length)))].sort();
  const settled = await all<{ exception_id: string }>(
    ctx.db,
    "SELECT exception_id FROM laundry_exceptions WHERE user_id = ? AND status = 'active' AND garment_id IS NULL AND cycle_key IS NOT NULL AND cycle_key <= ?",
    ctx.userId,
    cycleKeys[cycleKeys.length - 1]!,
  );
  for (const x of settled) {
    statements.push(stmt("UPDATE laundry_exceptions SET status = 'resolved', resolved_at = ? WHERE user_id = ? AND exception_id = ? AND status = 'active'", ctx.now, ctx.userId, x.exception_id));
  }
  const returned = released - stillAwayUnits;
  return {
    summary:
      `Laundry returned: ${returned} item${returned === 1 ? "" : "s"} clean (held back since the missed return of ${cycleKeys.join(", ")})` +
      (stillAwayUnits > 0 ? `; still away: ${nameList(awayNames)}` : ""),
    statements: [...parts.statements, ...statements],
    preconditions: parts.preconditions,
    affected: parts.affected,
    repairs: parts.repairs,
    result: { batchId: null, returned, stillAway: stillAwayUnits, cyclesReturned: cycleKeys, exceptionsSettled: settled.map((x) => x.exception_id) },
    changes: { availabilityChanged: parts.availabilityChanged },
    bumpWardrobe: true,
    undo: { data: { stockEventIds: eventIds, reopenExceptionIds: settled.map((x) => x.exception_id), withdrawExceptionIds } },
  };
}

/** The baseline dates (cycle keys) due at `asOf`, newest last, after `lastApplied`. */
export function dueCycleKeys(todayLocal: string, baselineWeekday: number, lastApplied: string | null, maxCatchUp = 8): string[] {
  let d = todayLocal;
  while (isoWeekday(d) !== baselineWeekday) d = addDays(d, -1);
  const keys: string[] = [];
  while (keys.length < maxCatchUp && (lastApplied === null || d > lastApplied)) {
    keys.unshift(d);
    if (lastApplied === null) break; // first ever run: only the most recent baseline
    d = addDays(d, -7);
  }
  return keys;
}

/** The collection cutoff instant for the cycle whose baseline falls on `cycleKey`. */
export function cycleCutoffMs(cycleKey: string, collectionWeekday: number, collectionLocalTime: string, timezone: string): number {
  let c = addDays(cycleKey, -1);
  for (let i = 0; i < 7 && isoWeekday(c) !== collectionWeekday; i++) c = addDays(c, -1);
  return zonedToUtcMs(c, collectionLocalTime, timezone);
}

export const laundryApplyWeeklyReset = define({
  type: "laundry.apply_weekly_reset",
  schema: C["laundry.apply_weekly_reset"],
  class: "system",
  requiredScope: "write",
  allowedAuthorizations: ["standing_policy", "system_schedule", "owner_tap"],
  async plan(ctx, p): Promise<CommandPlan> {
    const tz = ctx.settings.timezone;
    const asOfMs = p.asOf ? Date.parse(p.asOf) : ctx.nowMs;
    const today = localDateOf(asOfMs, tz);
    const planner = ctx.stock();
    const statements: Stmt[] = [];
    const preconditions: NonNullable<CommandPlan["preconditions"]> = [];
    const applied: { channel: string; cycleKey: string }[] = [];
    const channels: { channel: "service" | "handwash"; baselineWeekday: number; collectionWeekday: number; collectionLocalTime: string }[] = [];
    const svc = ctx.settings.laundry.service;
    if (svc.weeklyResetEnabled) channels.push({ channel: "service", baselineWeekday: svc.baselineWeekday, collectionWeekday: svc.collectionWeekday, collectionLocalTime: svc.collectionLocalTime });
    const hw = ctx.settings.laundry.handwash;
    if (hw.mode === "inferred_weekly" && hw.baselineWeekday) {
      const prev = hw.baselineWeekday === 1 ? 7 : hw.baselineWeekday - 1;
      channels.push({ channel: "handwash", baselineWeekday: hw.baselineWeekday, collectionWeekday: prev, collectionLocalTime: "23:59" });
    }
    for (const ch of channels) {
      const last = await first<{ cycle_key: string }>(ctx.db, "SELECT cycle_key FROM laundry_cycles WHERE user_id = ? AND channel = ? ORDER BY cycle_key DESC LIMIT 1", ctx.userId, ch.channel);
      for (const cycleKey of dueCycleKeys(today, ch.baselineWeekday, last?.cycle_key ?? null)) {
        const baselineMs = zonedToUtcMs(cycleKey, "00:00", tz);
        const cutoffMs = cycleCutoffMs(cycleKey, ch.collectionWeekday, ch.collectionLocalTime, tz);
        // Inferred baseline: journaled with basis `inferred`. No pickup or return observation is fabricated.
        planner.add(null, "weekly_reset", { channel: ch.channel, cycleKey, cutoffAtMs: cutoffMs }, "inferred", toInstant(baselineMs));
        statements.push(
          stmt("INSERT INTO laundry_cycles (user_id, channel, cycle_key, cutoff_at, baseline_at, applied_at, command_id) VALUES (?, ?, ?, ?, ?, ?, ?)", ctx.userId, ch.channel, cycleKey, toInstant(cutoffMs), toInstant(baselineMs), ctx.now, ctx.commandId),
        );
        if (ch.channel === "service") {
          statements.push(
            stmt(
              `UPDATE laundry_batches SET status = 'inferred_returned', returned_at = ?, return_basis = 'inferred'
                WHERE user_id = ? AND channel = 'service' AND status = 'collected' AND withdrawn_at IS NULL AND picked_up_at < ?
                  AND NOT EXISTS (SELECT 1 FROM laundry_exceptions x WHERE x.user_id = laundry_batches.user_id AND x.status = 'active' AND (x.batch_id = laundry_batches.batch_id OR x.cycle_key = ?))`,
              toInstant(baselineMs), ctx.userId, toInstant(baselineMs), cycleKey,
            ),
            // A baseline that is not itself reported missed releases what earlier missed cycles held, so
            // their exceptions are settled with it (inferred, like the release itself).
            stmt(
              `UPDATE laundry_exceptions SET status = 'resolved', resolved_at = ?
                WHERE user_id = ? AND status = 'active' AND garment_id IS NULL AND cycle_key IS NOT NULL AND cycle_key < ?
                  AND NOT EXISTS (SELECT 1 FROM laundry_exceptions y WHERE y.user_id = laundry_exceptions.user_id AND y.status = 'active' AND y.garment_id IS NULL AND y.cycle_key = ?)`,
              ctx.now, ctx.userId, cycleKey, cycleKey,
            ),
          );
        }
        preconditions.push({
          label: `cycle ${ch.channel}/${cycleKey} not applied yet`,
          sql: "NOT EXISTS (SELECT 1 FROM laundry_cycles WHERE user_id = ? AND channel = ? AND cycle_key = ?)",
          params: [ctx.userId, ch.channel, cycleKey],
          class: "internal", // a concurrent run applied it: re-plan, which finds nothing due
        });
        applied.push({ channel: ch.channel, cycleKey });
      }
    }
    if (applied.length === 0) {
      return { outcome: "noop", summary: "No laundry baseline is due", result: { cyclesApplied: [] }, undo: { unavailableReason: "nothing changed" } };
    }
    const build = await planner.build();
    const parts = stockParts(build);
    const reset = [...build.garments.values()].filter((g) => g.changed).length;
    return {
      summary: `Weekly laundry baseline applied (${applied.map((a) => `${a.channel} ${a.cycleKey}`).join(", ")}): ${reset} garment${reset === 1 ? "" : "s"} estimated clean; owner-reported exceptions kept`,
      statements: [...statements, ...parts.statements],
      preconditions: [...preconditions, ...parts.preconditions],
      affected: parts.affected,
      result: { cyclesApplied: applied, garmentsReset: reset, observedReturnsRecorded: 0 },
      changes: { availabilityChanged: parts.availabilityChanged.filter((id) => build.garments.get(id)!.changed), laundryBaselineApplied: true },
      bumpWardrobe: true,
      undo: { unavailableReason: "the weekly baseline is a standing policy; report an exception instead (missed return, item still away)" },
    };
  },
});

export const laundryReportException = define({
  type: "laundry.report_exception",
  schema: C["laundry.report_exception"],
  class: "observation",
  requiredScope: "write",
  async plan(ctx, p): Promise<CommandPlan> {
    const planner = ctx.stock();
    const exceptionId = ctx.newId("lex");
    const tz = ctx.settings.timezone;
    let summary: string;
    let cycleKey: string | null = p.cycleKey ?? null;
    let garmentId: string | null = null;
    let eventId: string;
    if (p.garmentId) {
      const g = (await loadGarments(ctx, [p.garmentId])).get(p.garmentId)!;
      garmentId = g.garment_id;
      eventId = planner.add(g.garment_id, "exception", { exceptionId, quantity: p.quantity, kind: p.kind }, "observed", ctx.occurredAt);
      summary = `${g.name}: recorded as ${p.kind === "lost" ? "lost at the laundry" : "still away"}; it stays out of suggestions until you say it is back`;
    } else {
      if (p.kind !== "missed_return" && p.kind !== "delayed") throw new CommandError("invalid_command", `'${p.kind}' needs the garment it applies to`);
      if (!cycleKey) {
        const last = await first<{ cycle_key: string }>(ctx.db, "SELECT cycle_key FROM laundry_cycles WHERE user_id = ? AND channel = 'service' ORDER BY cycle_key DESC LIMIT 1", ctx.userId);
        const today = localDateOf(ctx.occurredAtMs, tz);
        // Reported before this week's baseline ran: it applies to the coming baseline; otherwise to the latest.
        let upcoming = today;
        while (isoWeekday(upcoming) !== ctx.settings.laundry.service.baselineWeekday) upcoming = addDays(upcoming, 1);
        let lastCollection = today;
        while (isoWeekday(lastCollection) !== ctx.settings.laundry.service.collectionWeekday) lastCollection = addDays(lastCollection, -1);
        const afterCollectionBeforeBaseline = addDays(lastCollection, 7) > upcoming && (!last || last.cycle_key < upcoming) && upcoming !== today;
        cycleKey = afterCollectionBeforeBaseline || !last ? upcoming : last.cycle_key;
      }
      eventId = planner.add(null, "cycle_exception", { channel: "service", cycleKey, kind: p.kind, exceptionId }, "observed", ctx.occurredAt);
      summary = `Laundry ${p.kind === "delayed" ? "delayed" : "not returned"} for the week of ${cycleKey}: collected items stay unavailable until they are back`;
    }
    const build = await planner.build();
    const parts = stockParts(build);
    const changedIds = parts.availabilityChanged.filter((id) => build.garments.get(id)!.changed || id === garmentId);
    return {
      summary,
      statements: [
        ...parts.statements,
        stmt(
          "INSERT INTO laundry_exceptions (user_id, exception_id, kind, garment_id, cycle_key, quantity, occurred_at, reported_at, note, command_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ctx.userId, exceptionId, p.kind, garmentId, garmentId ? null : cycleKey, p.quantity, ctx.occurredAt, ctx.now, p.note, ctx.commandId,
        ),
      ],
      preconditions: parts.preconditions,
      affected: parts.affected,
      repairs: parts.repairs,
      result: { exceptionId, cycleKey: garmentId ? null : cycleKey, garmentsAffected: changedIds.length },
      changes: { availabilityChanged: changedIds },
      bumpWardrobe: true,
      undo: { data: { stockEventIds: [eventId], exceptionId } },
    };
  },
  async planUndo(ctx, original, data) {
    return simpleStockUndo(ctx, original, data, [stmt("UPDATE laundry_exceptions SET status = 'resolved', resolved_at = ? WHERE user_id = ? AND exception_id = ?", ctx.now, ctx.userId, data.exceptionId)]);
  },
});

export const wearCareHandlers = [wearRecord, wearAmend, careMarkDirty, careWashed, laundryCollect, laundryReturn, laundryApplyWeeklyReset, laundryReportException];
