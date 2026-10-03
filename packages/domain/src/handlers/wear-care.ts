import { FOUNDATION_COMMANDS as C } from "@garderobe/contracts";
import { all, allIn, first, stmt, type Stmt } from "../db.ts";
import { CommandError } from "../errors.ts";
import { addDays, endOfLocalDateMs, isoWeekday, localDateOf, toInstant, zonedToUtcMs } from "../util.ts";
import type { GarmentRow, StockPlanner } from "../stock/planner.ts";
import type { CommandContext, CommandPlan, DomainChanges, Precondition, StoredCommand } from "../commands/types.ts";
import { restrictionCovers } from "../availability/estimator.ts";
import { attrs, loadGarments, nameList, simpleStockUndo, stockParts, undoStockEvents } from "./common.ts";
import { define } from "./garments.ts";
import { planExceptionSettlement, planExceptionUnsettle, undoPlan, undoStockBuild, type ExceptionSettlement } from "./laundry-exceptions.ts";

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
    // Extra units are a total for the garment and day, like the wear itself: the same report arriving again
    // (from another client, or a retry under a new key) consumes nothing further.
    const priorExtras = new Map<string, number>();
    if (p.additionalUnits.length > 0) {
      const rows = await all<{ garment_id: string; quantity: number | null }>(
        ctx.db,
        "SELECT garment_id, json_extract(payload_json, '$.quantity') AS quantity FROM stock_events WHERE user_id = ? AND kind = 'extra_unit' AND voided_by_command_id IS NULL AND json_extract(payload_json, '$.wearingDate') = ?",
        ctx.userId,
        p.wearingDate,
      );
      for (const r of rows) priorExtras.set(r.garment_id, (priorExtras.get(r.garment_id) ?? 0) + Number(r.quantity ?? 1));
    }
    let extrasAlreadyRecorded = 0;
    for (const extra of p.additionalUnits) {
      // A further interchangeable unit was physically used: stock moves, the daily wear statistic does not.
      const g = loaded.get(extra.garmentId)!;
      const already = priorExtras.get(g.garment_id) ?? 0;
      const further = Math.max(0, extra.quantity - already);
      extrasAlreadyRecorded += extra.quantity - further;
      priorExtras.set(g.garment_id, already + further);
      if (further === 0) continue;
      const payload: Record<string, unknown> = { quantity: further, dirtyAtMs, wearingDate: p.wearingDate };
      if (p.tripId) payload.tripId = p.tripId;
      extraEventIds.push(planner.add(g.garment_id, "extra_unit", payload, "observed", wearOccurredAt(ctx, p.wearingDate, timezone)));
    }
    const build = await planner.build();
    const parts = stockParts(build);
    // A wear shows the unit is with the owner: an exception that was holding it away is settled by that.
    const settle = await planExceptionSettlement(ctx, build, "with_owner");
    // The observation replaces the selection uncertainty of the option sets it is about: those that offered
    // one of the reported garments. A report about something else (a belt no option contained) leaves the
    // day's options, and the unreported wear they imply, as uncertain as they were.
    const resolvedSets = new Map<string, string>();
    for (const s of await allIn<{ exposure_id: string; status: string }>(
      ctx.db,
      `SELECT DISTINCT s.exposure_id, s.status FROM exposure_sets s JOIN exposure_items i ON i.user_id = s.user_id AND i.exposure_id = s.exposure_id
        WHERE s.user_id = ? AND s.local_date = ? AND s.status IN ('open', 'selected') AND i.garment_id IN (:ids)`,
      [ctx.userId, p.wearingDate],
      [...canonical.keys()],
    )) {
      resolvedSets.set(s.exposure_id, s.status);
    }
    const statements = [
      ...parts.statements,
      ...add.statements,
      ...settle.statements,
      ...[...resolvedSets.keys()].map((id) => stmt("UPDATE exposure_sets SET status = 'resolved_worn', updated_at = ? WHERE user_id = ? AND exposure_id = ? AND status IN ('open', 'selected')", ctx.now, ctx.userId, id)),
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
      result: { wearingDate: p.wearingDate, counted: add.counted, merged: add.merged, observationIds: add.observationIds, additionalUnitEvents: extraEventIds.length, additionalUnitsAlreadyRecorded: extrasAlreadyRecorded },
      changes: { availabilityChanged: parts.availabilityChanged, wears: add.wears },
      bumpWardrobe: true,
      undo: {
        data: {
          observationIds: add.observationIds,
          wearingDate: p.wearingDate,
          stockEventIds: extraEventIds,
          settlement: settle.settlement,
          exposuresResolved: [...resolvedSets].map(([exposureId, previousStatus]) => ({ exposureId, previousStatus })),
        },
      },
    };
  },
  async planUndo(ctx, original, data): Promise<CommandPlan> {
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
    const build = await planner.build();
    const parts = stockParts(build);
    const unsettle = planExceptionUnsettle(ctx, original.commandId, data.settlement as ExceptionSettlement | undefined, build);
    // An option set this report resolved is uncertain again, unless another recorded wear of that day still speaks for it.
    const reopened = ((data.exposuresResolved ?? []) as { exposureId: string; previousStatus: string }[]).map((x) =>
      stmt(
        `UPDATE exposure_sets SET status = ?, updated_at = ? WHERE user_id = ? AND exposure_id = ? AND status = 'resolved_worn'
           AND NOT EXISTS (SELECT 1 FROM exposure_items i JOIN daily_wears w ON w.user_id = i.user_id AND w.garment_id = i.garment_id
                            WHERE i.user_id = exposure_sets.user_id AND i.exposure_id = exposure_sets.exposure_id AND w.wearing_date = exposure_sets.local_date AND w.status = 'active')`,
        x.previousStatus, ctx.now, ctx.userId, x.exposureId,
      ),
    );
    return {
      summary: `Wear record for ${data.wearingDate} undone (${wears.length} counted wear${wears.length === 1 ? "" : "s"} withdrawn)`,
      statements: [...parts.statements, ...statements, ...unsettle.statements, ...reopened],
      preconditions: [...parts.preconditions, ...unsettle.preconditions],
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
    const build = await planner.build();
    const parts = stockParts(build);
    // "It is in the wash" about a unit the ledger held away shows it is with the owner.
    const settle = await planExceptionSettlement(ctx, build, "with_owner");
    return {
      summary: `In the wash: ${nameList(names)}`,
      ...parts,
      statements: [...parts.statements, ...settle.statements],
      changes: { availabilityChanged: parts.availabilityChanged },
      bumpWardrobe: true,
      undo: { data: { stockEventIds: eventIds, settlement: settle.settlement } },
    };
  },
  async planUndo(ctx, original, data) {
    const build = await undoStockBuild(ctx, (data.stockEventIds ?? []) as string[]);
    return undoPlan(original, build, planExceptionUnsettle(ctx, original.commandId, data.settlement as ExceptionSettlement | undefined, build));
  },
});

export const careWashed = define({
  type: "care.washed",
  schema: C["care.washed"],
  class: "observation",
  requiredScope: "write",
  async plan(ctx, p) {
    const statements: Stmt[] = [];
    const asked: { garmentId: string; name: string; payload: Record<string, unknown>; uncounted: boolean }[] = [];
    if (p.allOfChannel) {
      const rows = await all<{ garment_id: string; name: string }>(
        ctx.db,
        `SELECT g.garment_id, g.name FROM garments g JOIN stock_balances b ON b.user_id = g.user_id AND b.garment_id = g.garment_id
          WHERE g.user_id = ? AND g.care_channel = ? AND b.bucket = 'dirty' AND b.quantity > 0 ORDER BY g.name`,
        ctx.userId,
        p.allOfChannel,
      );
      for (const r of rows) asked.push({ garmentId: r.garment_id, name: r.name, payload: {}, uncounted: false });
    }
    if (p.items) {
      const loaded = await loadGarments(ctx, p.items.map((i) => i.garmentId));
      for (const item of p.items) {
        const g = loaded.get(item.garmentId)!;
        if (asked.some((a) => a.garmentId === g.garment_id)) continue;
        if (g.care_channel === "none") throw new CommandError("precondition_failed", `${g.name} is never laundered`, { garmentId: g.garment_id });
        // Without a count, "it is washed" is about what was awaiting a wash at home. Only when nothing of the
        // garment was does it speak about a unit reported still away (never one reported lost, and never a
        // missed cycle's units, which "the laundry is back" returns).
        asked.push({ garmentId: g.garment_id, name: g.name, payload: item.quantity ? { quantity: item.quantity } : { releaseAway: true }, uncounted: !item.quantity });
      }
    }
    if (asked.length === 0) return { outcome: "noop", summary: "Nothing was awaiting a wash", undo: { unavailableReason: "nothing changed" } };
    const planWashes = async (items: typeof asked) => {
      const planner = ctx.stock();
      const events = items.map((a) => ({ ...a, eventId: planner.add(a.garmentId, "wash", a.payload, "observed", ctx.occurredAt) }));
      return { events, build: await planner.build() };
    };
    let { events, build } = await planWashes(asked);
    // "Washed" without a count does not speak for a unit reported lost. When that is all there is of the
    // garment, nothing was marked clean: the receipt says so instead of listing it as washed, and no wash
    // is written for it, so withdrawing the lost report later cannot make this statement wash the unit.
    const leftLost = events.filter(({ garmentId, eventId, uncounted }) => {
      if (!uncounted) return false;
      const g = build.garments.get(garmentId);
      const movedAny = (g?.after.movements ?? []).some((m) => m.eventId === eventId);
      const lostHeld = [...(g?.after.state.service.values() ?? [])].some((h) => h.lost && h.quantity > 0);
      const atHome = (g?.after.state.clean ?? 0) + (g?.after.state.dirty.length ?? 0);
      return !movedAny && lostHeld && atHome === 0;
    });
    const lostIds = new Set(leftLost.map((x) => x.garmentId));
    const lostSummary = leftLost.length > 0 ? `; still recorded as lost: ${nameList(leftLost.map((x) => x.name))}` : "";
    if (leftLost.length > 0) {
      const washed = asked.filter((a) => !lostIds.has(a.garmentId));
      if (washed.length === 0) {
        return { outcome: "noop", summary: `Nothing was marked clean${lostSummary}. If it has turned up, say how many were washed`, undo: { unavailableReason: "nothing changed" } };
      }
      ({ events, build } = await planWashes(washed));
    }
    const eventIds = events.map((e) => e.eventId);
    const parts = stockParts(build);
    const lostNotes = leftLost.map((x) => `${x.name}: it is recorded as lost, so nothing was marked clean; if it has turned up, say how many were washed`);
    // An exception is settled only by what actually moved: resolved when the units it held are no longer
    // away, reduced when only some came back, untouched when nothing held under it moved.
    const settle = await planExceptionSettlement(ctx, build, "returned");
    return {
      summary: `Washed and clean: ${nameList(events.map((e) => e.name))}${lostSummary}`,
      statements: [...parts.statements, ...statements, ...settle.statements],
      preconditions: parts.preconditions,
      affected: parts.affected,
      repairs: [...parts.repairs, ...lostNotes],
      result: { washed: events.map((e) => e.garmentId), leftAsLost: [...lostIds], exceptionsSettled: settle.settlement.settled.filter((x) => x.heldAfter === 0).map((x) => x.exceptionId) },
      changes: { availabilityChanged: parts.availabilityChanged },
      bumpWardrobe: true,
      undo: { data: { stockEventIds: eventIds, settlement: settle.settlement } },
    };
  },
  async planUndo(ctx, original, data) {
    // The units go back to where the ledger had them, and so do the exceptions and batch records this report
    // settled - provided none of them has changed since.
    const build = await undoStockBuild(ctx, (data.stockEventIds ?? []) as string[]);
    return undoPlan(original, build, planExceptionUnsettle(ctx, original.commandId, data.settlement as ExceptionSettlement | undefined, build));
  },
});

/** The next version of a ledger entity that has no version column of its own: one more than the last command that touched it. */
async function nextEntityVersion(ctx: CommandContext, kind: string, id: string): Promise<number> {
  const row = await first<{ v: number | null }>(ctx.db, "SELECT MAX(version) AS v FROM command_entities WHERE user_id = ? AND kind = ? AND entity_id = ?", ctx.userId, kind, id);
  return (row?.v ?? 0) + 1;
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
      preconditions: [
        ...parts.preconditions,
        // A caller-chosen batch ID that is already on record is a clean refusal, not an internal failure.
        { label: "the laundry batch ID is not already in use", sql: "NOT EXISTS (SELECT 1 FROM laundry_batches WHERE user_id = ? AND batch_id = ?)", params: [ctx.userId, batchId], class: "state" },
      ],
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
      affected: [...(plan.affected ?? []), { kind: "laundry_batch", id: String(data.batchId), version: await nextEntityVersion(ctx, "laundry_batch", String(data.batchId)) }],
    };
  },
});

export const laundryReturn = define({
  type: "laundry.return",
  schema: C["laundry.return"],
  class: "observation",
  requiredScope: "write",
  async plan(ctx, p): Promise<CommandPlan> {
    const batchCols = "batch_id, status, returned_at, return_basis";
    type BatchRow = { batch_id: string; status: string; returned_at: string | null; return_basis: string | null };
    const batch = p.batchId
      ? await first<BatchRow>(ctx.db, `SELECT ${batchCols} FROM laundry_batches WHERE user_id = ? AND batch_id = ? AND withdrawn_at IS NULL`, ctx.userId, p.batchId)
      : await first<BatchRow>(ctx.db, `SELECT ${batchCols} FROM laundry_batches WHERE user_id = ? AND channel = 'service' AND status IN ('collected', 'partially_returned') AND withdrawn_at IS NULL ORDER BY julianday(picked_up_at) ASC, batch_id LIMIT 1`, ctx.userId);
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
    // The return is planned against the batch's record, then counted from what the replay actually moved:
    // a unit the owner reported lost, or one a later correction showed was never in the bag, is not in
    // the batch's holding any more, so it does not come back and is not claimed to have.
    const planned: { item: (typeof items)[number]; outstanding: number; away: number; eventId: string }[] = [];
    // What the batch is actually holding of each item now. A unit named as still away is taken from that
    // first, so "one is still away" is never answered by returning the only unit that is there.
    const holding = new Map(
      (await all<{ garment_id: string; quantity: number }>(ctx.db, "SELECT garment_id, quantity FROM stock_balances WHERE user_id = ? AND bucket = 'service' AND ref = ?", ctx.userId, batch.batch_id)).map((r) => [r.garment_id, r.quantity]),
    );
    for (const item of items) {
      const outstanding = item.quantity - item.returned_quantity;
      if (outstanding <= 0) continue;
      const away = Math.min(awayRequested.get(item.garment_id) ?? 0, outstanding);
      const back = Math.max(0, Math.min(outstanding, holding.get(item.garment_id) ?? 0) - away);
      planned.push({ item, outstanding, away, eventId: planner.add(item.garment_id, "return", { batchId: batch.batch_id, quantity: back, stillAway: away }, "observed", ctx.occurredAt) });
      eventIds.push(planned[planned.length - 1]!.eventId);
    }
    const build = await planner.build();
    // Only the still-away exceptions an earlier return of this batch opened are this return's to settle. A
    // unit reported lost is held under its own exception, never under the batch, and is not closed here.
    const openForBatch = await all<{ exception_id: string; garment_id: string; quantity: number }>(
      ctx.db,
      "SELECT exception_id, garment_id, quantity FROM laundry_exceptions WHERE user_id = ? AND batch_id = ? AND status = 'active' AND kind = 'still_away' AND garment_id IS NOT NULL",
      ctx.userId,
      batch.batch_id,
    );
    const lostIds = new Set(
      (await allIn<{ garment_id: string }>(ctx.db, "SELECT DISTINCT garment_id FROM laundry_exceptions WHERE user_id = ? AND status = 'active' AND kind = 'lost' AND garment_id IN (:ids)", [ctx.userId], planned.map((x) => x.item.garment_id))).map((r) => r.garment_id),
    );
    let returned = 0;
    let stillAway = 0;
    const awayNames: string[] = [];
    const lostNames: string[] = [];
    const notes: string[] = [];
    const undoItems: BatchReturnUndo["items"] = [];
    const createdExceptionIds: string[] = [];
    const resolvedExceptions: { exceptionId: string; quantity: number }[] = [];
    for (const { item, outstanding, away: awayAsked, eventId } of planned) {
      const g = build.garments.get(item.garment_id);
      const heldBefore = g?.before.state.service.get(batch.batch_id)?.quantity ?? 0;
      const heldAfter = g?.after.state.service.get(batch.batch_id)?.quantity ?? 0;
      const back = (g?.after.movements ?? []).filter((m) => m.eventId === eventId && m.from === "service" && m.to === "clean").reduce((n, m) => n + m.quantity, 0);
      const away = Math.min(awayAsked, heldAfter);
      returned += back;
      stillAway += away;
      const returnedAfter = item.returned_quantity + back;
      undoItems.push({ garmentId: item.garment_id, name: item.name, returnedBefore: item.returned_quantity, stillAwayBefore: item.still_away, returnedAfter, stillAwayAfter: away, heldBefore });
      statements.push(stmt("UPDATE laundry_batch_items SET returned_quantity = ?, still_away = ? WHERE user_id = ? AND batch_id = ? AND garment_id = ?", returnedAfter, away, ctx.userId, batch.batch_id, item.garment_id));
      const earlier = openForBatch.filter((o) => o.garment_id === item.garment_id);
      const earlierAway = earlier.reduce((n, o) => n + o.quantity, 0);
      // Nothing new is said about an item that is exactly as away as an earlier return of this batch left
      // it: its exception stands as it is, and no second one is opened for the same units.
      const unchanged = back === 0 && away > 0 && away === earlierAway;
      if (!unchanged && (away > 0 || back > 0)) {
        // What an earlier return of this batch left as still away has now come back, in whole or in part:
        // that exception is closed by this return, and whatever is still away is its own exception below.
        for (const x of earlier) {
          resolvedExceptions.push({ exceptionId: x.exception_id, quantity: x.quantity });
          statements.push(
            stmt(
              "UPDATE laundry_exceptions SET status = 'resolved', resolved_at = ?, resolution = 'returned', resolved_by_command_id = ? WHERE user_id = ? AND exception_id = ? AND status = 'active'",
              ctx.now, ctx.commandId, ctx.userId, x.exception_id,
            ),
          );
        }
      }
      if (away > 0) {
        awayNames.push(item.name);
        if (!unchanged) {
          const exceptionId = ctx.newId("lex");
          createdExceptionIds.push(exceptionId);
          statements.push(
            stmt(
              "INSERT INTO laundry_exceptions (user_id, exception_id, kind, garment_id, batch_id, quantity, occurred_at, reported_at, command_id) VALUES (?, ?, 'still_away', ?, ?, ?, ?, ?, ?)",
              ctx.userId, exceptionId, item.garment_id, batch.batch_id, away, ctx.occurredAt, ctx.now, ctx.commandId,
            ),
          );
        }
      }
      const missing = outstanding - back - away;
      if (missing > 0) {
        if (lostIds.has(item.garment_id)) {
          lostNames.push(item.name);
          notes.push(`${item.name}: reported lost, so it is not counted as returned and stays recorded as lost`);
        } else {
          notes.push(`${item.name}: not counted as returned; another report had already accounted for it, so it was no longer in this bag`);
        }
      }
    }
    const newStatus = stillAway > 0 ? "partially_returned" : "returned";
    statements.push(stmt("UPDATE laundry_batches SET status = ?, returned_at = ?, return_basis = 'observed' WHERE user_id = ? AND batch_id = ?", newStatus, ctx.occurredAt, ctx.userId, batch.batch_id));
    const parts = stockParts(build);
    const undoData: BatchReturnUndo = {
      stockEventIds: eventIds,
      batchId: batch.batch_id,
      batchBefore: { status: batch.status, returnedAt: batch.returned_at, returnBasis: batch.return_basis },
      statusAfter: newStatus,
      returnedAtAfter: ctx.occurredAt,
      items: undoItems,
      createdExceptionIds,
      resolvedExceptions,
    };
    return {
      summary:
        (returned > 0 ? `Laundry returned: ${returned} item${returned === 1 ? "" : "s"} clean` : "Laundry returned: nothing came back clean") +
        (stillAway > 0 ? `; still away: ${nameList(awayNames)}` : "") +
        (lostNames.length > 0 ? `; not returned, reported lost: ${nameList(lostNames)}` : ""),
      statements: [...parts.statements, ...statements],
      preconditions: parts.preconditions,
      affected: [...parts.affected, { kind: "laundry_batch", id: batch.batch_id, version: await nextEntityVersion(ctx, "laundry_batch", batch.batch_id) }],
      repairs: [...parts.repairs, ...notes],
      result: { batchId: batch.batch_id, returned, stillAway },
      changes: { availabilityChanged: parts.availabilityChanged },
      bumpWardrobe: true,
      undo: { data: undoData as unknown as Record<string, unknown> },
    };
  },
  async planUndo(ctx, original, data) {
    if (typeof data.batchId === "string") return undoBatchReturn(ctx, original, data as unknown as BatchReturnUndo);
    const build = await undoStockBuild(ctx, (data.stockEventIds ?? []) as string[]);
    // What this report settled is open again where the undo's replay shows the units held again; a
    // missed cycle that a later baseline has since released stays settled.
    const extra = planExceptionUnsettle(ctx, original.commandId, data.settlement as ExceptionSettlement | undefined, build);
    // The still-away exceptions this report created are withdrawn with it - marked as withdrawn by this
    // undo, not as settled - and only while they are still open.
    for (const id of (data.withdrawExceptionIds ?? []) as string[]) {
      extra.preconditions.push({ label: "the still-away item has not been reported back since", sql: "(SELECT status FROM laundry_exceptions WHERE user_id = ? AND exception_id = ?) = 'active'", params: [ctx.userId, id], class: "state" });
      extra.statements.push(
        stmt("UPDATE laundry_exceptions SET status = 'resolved', resolved_at = ?, resolution = 'withdrawn', resolved_by_command_id = ? WHERE user_id = ? AND exception_id = ? AND status = 'active'", ctx.now, ctx.commandId, ctx.userId, id),
      );
    }
    return undoPlan(original, build, extra);
  },
});

interface BatchReturnUndo {
  stockEventIds: string[];
  batchId: string;
  batchBefore: { status: string; returnedAt: string | null; returnBasis: string | null };
  statusAfter: string;
  /** The exact `returned_at` the return wrote (absent on returns recorded before this field existed). */
  returnedAtAfter?: string;
  items: { garmentId: string; name: string; returnedBefore: number; stillAwayBefore: number; returnedAfter: number; stillAwayAfter: number; heldBefore: number }[];
  createdExceptionIds: string[];
  resolvedExceptions: { exceptionId: string; quantity: number }[];
}

/**
 * Take back the return of a recorded batch ("the laundry is back" said by mistake, or of the wrong bag).
 *
 * The return is withdrawn exactly or not at all. Its stock events are voided and the journal replayed; the
 * undo goes ahead only if every item is then held by the batch again as it was before the return. If
 * anything recorded since speaks for one of those units - a wear, a wash report, a count, a weekly
 * baseline that has counted the bag as back, a later return of the same bag - the replay does not put it
 * back in the bag, and the undo is refused: that later record stands and the owner corrects the item
 * itself. Units of one garment are interchangeable in the ledger: when a garment has another unit at home
 * and a later wear or wash is fully answered by that unit, the bag's unit is untouched by it and the
 * return can still be withdrawn. The batch row, its items and
 * the exceptions the return opened or closed go back to what they were, each guarded on the state the
 * return left, so a later change is never overwritten.
 */
async function undoBatchReturn(ctx: CommandContext, original: StoredCommand, data: BatchReturnUndo): Promise<CommandPlan> {
  const batch = await first<{ status: string }>(ctx.db, "SELECT status FROM laundry_batches WHERE user_id = ? AND batch_id = ? AND withdrawn_at IS NULL", ctx.userId, data.batchId);
  if (!batch) throw new CommandError("not_undoable", "that laundry batch is no longer on record", { batchId: data.batchId });
  const build = await undoStockBuild(ctx, data.stockEventIds ?? []);
  const moved = data.items.filter((i) => (build.garments.get(i.garmentId)?.after.state.service.get(data.batchId)?.quantity ?? 0) !== i.heldBefore);
  if (moved.length > 0) {
    throw new CommandError(
      "not_undoable",
      `something has been recorded since that laundry came back (${nameList(moved.map((i) => i.name))}), such as a wear, a wash, a count, a weekly laundry baseline or a later return of the same bag. The return stays in the record; correct the item instead (mark it dirty, or report it still away)`,
      { batchId: data.batchId, garmentIds: moved.map((i) => i.garmentId) },
    );
  }
  const statements: Stmt[] = [];
  const preconditions: Precondition[] = [
    {
      label: "the laundry batch has not changed since it was returned",
      // Compared as instants: the same moment may be stored with or without milliseconds.
      sql: "(SELECT status || ':' || COALESCE(julianday(returned_at), '') FROM laundry_batches WHERE user_id = ? AND batch_id = ? AND withdrawn_at IS NULL) = (SELECT ? || ':' || julianday(?))",
      params: [ctx.userId, data.batchId, data.statusAfter, data.returnedAtAfter ?? original.occurredAt],
      class: "state",
    },
  ];
  statements.push(
    stmt("UPDATE laundry_batches SET status = ?, returned_at = ?, return_basis = ? WHERE user_id = ? AND batch_id = ?", data.batchBefore.status, data.batchBefore.returnedAt, data.batchBefore.returnBasis, ctx.userId, data.batchId),
  );
  for (const i of data.items) {
    preconditions.push({
      label: "the laundry batch item has not changed since",
      sql: "(SELECT returned_quantity || ':' || still_away FROM laundry_batch_items WHERE user_id = ? AND batch_id = ? AND garment_id = ?) = ?",
      params: [ctx.userId, data.batchId, i.garmentId, `${i.returnedAfter}:${i.stillAwayAfter}`],
      class: "state",
    });
    statements.push(stmt("UPDATE laundry_batch_items SET returned_quantity = ?, still_away = ? WHERE user_id = ? AND batch_id = ? AND garment_id = ?", i.returnedBefore, i.stillAwayBefore, ctx.userId, data.batchId, i.garmentId));
  }
  // The still-away exceptions the return opened are withdrawn with it (marked withdrawn, not settled) ...
  for (const id of data.createdExceptionIds ?? []) {
    preconditions.push({ label: "the still-away item has not been reported back since", sql: "(SELECT status FROM laundry_exceptions WHERE user_id = ? AND exception_id = ?) = 'active'", params: [ctx.userId, id], class: "state" });
    statements.push(
      stmt("UPDATE laundry_exceptions SET status = 'resolved', resolved_at = ?, resolution = 'withdrawn', resolved_by_command_id = ? WHERE user_id = ? AND exception_id = ? AND status = 'active'", ctx.now, ctx.commandId, ctx.userId, id),
    );
  }
  // ... and the ones it closed are open again, exactly as they were.
  for (const x of data.resolvedExceptions ?? []) {
    preconditions.push({
      label: "the laundry exception has not changed since",
      sql: "(SELECT status || ':' || quantity || ':' || COALESCE(resolved_by_command_id, '') FROM laundry_exceptions WHERE user_id = ? AND exception_id = ?) = ?",
      params: [ctx.userId, x.exceptionId, `resolved:${x.quantity}:${original.commandId}`],
      class: "state",
    });
    statements.push(stmt("UPDATE laundry_exceptions SET status = 'active', resolved_at = NULL, resolution = NULL, resolved_by_command_id = NULL WHERE user_id = ? AND exception_id = ?", ctx.userId, x.exceptionId));
  }
  const plan = undoPlan(original, build, { statements, preconditions }, "The laundry return is withdrawn; that bag is recorded as out at the service again");
  return { ...plan, affected: [...(plan.affected ?? []), { kind: "laundry_batch", id: data.batchId, version: await nextEntityVersion(ctx, "laundry_batch", data.batchId) }] };
}

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
  const repairs: string[] = [];
  let stillAwayUnits = 0;
  const cycleKeys = [...new Set(held.map((h) => h.ref.slice("cycle:".length)))].sort();
  // The held units exist from their cycle's baseline onwards. A return the owner dates earlier than that
  // ("it came back on Saturday") is still his observation that they are back: it takes effect at the baseline.
  const baselines = await allIn<{ baseline_at: string }>(ctx.db, "SELECT baseline_at FROM laundry_cycles WHERE user_id = ? AND channel = 'service' AND cycle_key IN (:ids)", [ctx.userId], cycleKeys);
  const earliestMs = Math.max(0, ...baselines.map((b) => Date.parse(b.baseline_at))) + 1000;
  const effectiveAt = ctx.occurredAtMs >= earliestMs ? ctx.occurredAt : toInstant(earliestMs);
  if (effectiveAt !== ctx.occurredAt) repairs.push(`the return was dated before the weekly baseline of ${cycleKeys[cycleKeys.length - 1]}; it is applied from that baseline, when the held items were counted as away`);
  for (const [garmentId, g] of byGarment) {
    for (const h of g.holdings) {
      const id = planner.add(garmentId, "return", { batchId: h.ref, quantity: h.quantity, via: "return_after_missed_cycle" }, "observed", effectiveAt);
      returnEventIds.push(id);
      eventIds.push(id);
    }
    const stays = Math.min(away.get(garmentId) ?? 0, g.total);
    if (stays === 0) continue;
    // Named as still away: held under its own exception, which no weekly baseline releases.
    const exceptionId = ctx.newId("lex");
    eventIds.push(planner.add(garmentId, "exception", { exceptionId, quantity: stays, kind: "still_away" }, "observed", effectiveAt));
    statements.push(
      stmt(
        "INSERT INTO laundry_exceptions (user_id, exception_id, kind, garment_id, quantity, occurred_at, reported_at, command_id) VALUES (?, ?, 'still_away', ?, ?, ?, ?, ?)",
        ctx.userId, exceptionId, garmentId, stays, effectiveAt, ctx.now, ctx.commandId,
      ),
    );
    withdrawExceptionIds.push(exceptionId);
    awayNames.push(g.name);
    stillAwayUnits += stays;
  }
  const build = await planner.build();
  // What the receipt claims is what the replay actually moved.
  let released = 0;
  for (const g of build.garments.values()) {
    released += g.after.movements.filter((m) => returnEventIds.includes(m.eventId) && m.from === "service" && m.to === "clean").reduce((n, m) => n + m.quantity, 0);
  }
  if (released === 0) return null;
  const parts = stockParts(build);
  // The cycles whose last held unit came back are settled; so is any older missed-cycle report, since
  // nothing of any missed cycle is held any more.
  const settle = await planExceptionSettlement(ctx, build, "returned");
  const stale = await all<{ exception_id: string; cycle_key: string; quantity: number }>(
    ctx.db,
    "SELECT exception_id, cycle_key, quantity FROM laundry_exceptions WHERE user_id = ? AND status = 'active' AND garment_id IS NULL AND cycle_key IS NOT NULL AND cycle_key <= ?",
    ctx.userId,
    cycleKeys[cycleKeys.length - 1]!,
  );
  for (const x of stale) {
    if (settle.settlement.settled.some((s) => s.exceptionId === x.exception_id)) continue;
    settle.settlement.settled.push({ exceptionId: x.exception_id, scope: "cycle", garmentId: null, batchId: null, cycleKey: x.cycle_key, previousQuantity: x.quantity, heldBefore: 0, heldAfter: 0, item: null });
    settle.statements.push(
      stmt("UPDATE laundry_exceptions SET status = 'resolved', resolved_at = ?, resolution = 'returned', resolved_by_command_id = ? WHERE user_id = ? AND exception_id = ? AND status = 'active'", ctx.now, ctx.commandId, ctx.userId, x.exception_id),
    );
  }
  const returned = released - stillAwayUnits;
  return {
    summary:
      `Laundry returned: ${returned} item${returned === 1 ? "" : "s"} clean (held back since the missed return of ${cycleKeys.join(", ")})` +
      (stillAwayUnits > 0 ? `; still away: ${nameList(awayNames)}` : ""),
    statements: [...parts.statements, ...statements, ...settle.statements],
    preconditions: parts.preconditions,
    affected: parts.affected,
    repairs: [...parts.repairs, ...repairs],
    result: { batchId: null, returned, stillAway: stillAwayUnits, cyclesReturned: cycleKeys, exceptionsSettled: settle.settlement.settled.map((x) => x.exceptionId), effectiveAt },
    changes: { availabilityChanged: parts.availabilityChanged },
    bumpWardrobe: true,
    undo: { data: { stockEventIds: eventIds, settlement: settle.settlement, withdrawExceptionIds } },
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
    // A baseline is applied for cycles that have happened. A future `asOf` would apply cycles early and block the real ones.
    if (asOfMs > ctx.nowMs + 5 * 60_000) throw new CommandError("invalid_command", "the weekly laundry baseline cannot be applied for a future date; nothing was written", { asOf: p.asOf });
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
                WHERE user_id = ? AND channel = 'service' AND status = 'collected' AND withdrawn_at IS NULL AND julianday(picked_up_at) < julianday(?)
                  AND NOT EXISTS (SELECT 1 FROM laundry_exceptions x WHERE x.user_id = laundry_batches.user_id AND x.status = 'active' AND (x.batch_id = laundry_batches.batch_id OR x.cycle_key = ?))`,
              toInstant(baselineMs), ctx.userId, toInstant(baselineMs), cycleKey,
            ),
            // A baseline that is not itself reported missed releases what earlier missed cycles held, so
            // their exceptions are settled with it (inferred, like the release itself).
            stmt(
              `UPDATE laundry_exceptions SET status = 'resolved', resolved_at = ?, resolution = 'inferred_baseline', resolved_by_command_id = ?
                WHERE user_id = ? AND status = 'active' AND garment_id IS NULL AND cycle_key IS NOT NULL AND cycle_key < ?
                  AND NOT EXISTS (SELECT 1 FROM laundry_exceptions y WHERE y.user_id = laundry_exceptions.user_id AND y.status = 'active' AND y.garment_id IS NULL AND y.cycle_key = ?)`,
              ctx.now, ctx.commandId, ctx.userId, cycleKey, cycleKey,
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
    // A unit reported lost that an earlier exception was holding as still away is now covered by this report.
    const settle = garmentId && p.kind === "lost" ? await planExceptionSettlement(ctx, build, "reported_lost", { adjustBatches: false }) : null;
    return {
      summary,
      statements: [
        ...parts.statements,
        stmt(
          "INSERT INTO laundry_exceptions (user_id, exception_id, kind, garment_id, cycle_key, quantity, occurred_at, reported_at, note, command_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ctx.userId, exceptionId, p.kind, garmentId, garmentId ? null : cycleKey, p.quantity, ctx.occurredAt, ctx.now, p.note, ctx.commandId,
        ),
        ...(settle?.statements ?? []),
      ],
      preconditions: parts.preconditions,
      affected: parts.affected,
      repairs: parts.repairs,
      result: { exceptionId, cycleKey: garmentId ? null : cycleKey, garmentsAffected: changedIds.length },
      changes: { availabilityChanged: changedIds },
      bumpWardrobe: true,
      undo: { data: { stockEventIds: [eventId], exceptionId, settlement: settle?.settlement } },
    };
  },
  async planUndo(ctx, original, data) {
    const build = await undoStockBuild(ctx, (data.stockEventIds ?? []) as string[]);
    const extra = planExceptionUnsettle(ctx, original.commandId, data.settlement as ExceptionSettlement | undefined, build);
    // The mistaken report is withdrawn, marked as such; a report that has since been settled is not undone.
    extra.preconditions.push({ label: "the exception is still open", sql: "(SELECT status FROM laundry_exceptions WHERE user_id = ? AND exception_id = ?) = 'active'", params: [ctx.userId, data.exceptionId], class: "state" });
    extra.statements.push(
      stmt("UPDATE laundry_exceptions SET status = 'resolved', resolved_at = ?, resolution = 'withdrawn', resolved_by_command_id = ? WHERE user_id = ? AND exception_id = ? AND status = 'active'", ctx.now, ctx.commandId, ctx.userId, data.exceptionId),
    );
    return undoPlan(original, build, extra);
  },
});

export const wearCareHandlers = [wearRecord, wearAmend, careMarkDirty, careWashed, laundryCollect, laundryReturn, laundryApplyWeeklyReset, laundryReportException];
