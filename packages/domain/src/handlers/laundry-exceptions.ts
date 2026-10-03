/**
 * Laundry exceptions are settled only by what the replay actually moved.
 *
 * An item exception ("still away", "lost") holds its units under a service reference: the batch it named,
 * or `exception:<id>`. A cycle exception ("the return was missed") holds every collected unit under
 * `cycle:<key>`. Whatever command moves those units (a wash report, a wear, "the laundry is back"), the
 * exception row follows the holding: resolved when nothing is held under it any more, reduced when only
 * part came back, untouched when nothing moved. Each closure records why and by which command, so the
 * command's undo can verify it is reversing exactly its own effect and nothing that happened since.
 */
import { all, allIn, stmt, type Stmt } from "../db.ts";
import type { CommandContext, CommandPlan, Precondition, StoredCommand } from "../commands/types.ts";
import type { StockBuild } from "../stock/planner.ts";
import { stockParts, undoStockEvents, UNDO_STOCK_SUMMARY } from "./common.ts";

export type ExceptionResolution = "returned" | "with_owner" | "inferred_baseline" | "reported_lost" | "withdrawn";

export interface SettledException {
  exceptionId: string;
  scope: "item" | "cycle";
  garmentId: string | null;
  batchId: string | null;
  cycleKey: string | null;
  previousQuantity: number;
  heldBefore: number;
  heldAfter: number;
  /** The batch item's own record before and after, when the exception named a batch and the units came back. */
  item: { returnedBefore: number; stillAwayBefore: number; returnedAfter: number; stillAwayAfter: number } | null;
}

/** A batch this settlement completed, with the values it had before. */
export interface ClosedBatch {
  batchId: string;
  status: string;
  returnedAt: string | null;
  returnBasis: string | null;
}

export interface ExceptionSettlement {
  settled: SettledException[];
  closedBatches: ClosedBatch[];
}

const serviceHeld = (build: StockBuild, garmentId: string, ref: string, when: "before" | "after"): number => build.garments.get(garmentId)?.[when].state.service.get(ref)?.quantity ?? 0;

/**
 * Settle the exceptions whose held units this command's stock build moved.
 * `adjustBatches` is false when the units did not come back (a still-away unit reported lost): the batch
 * item keeps saying it is away.
 */
export async function planExceptionSettlement(
  ctx: CommandContext,
  build: StockBuild,
  resolution: ExceptionResolution,
  opts: { adjustBatches?: boolean } = {},
): Promise<{ statements: Stmt[]; settlement: ExceptionSettlement }> {
  const statements: Stmt[] = [];
  const settlement: ExceptionSettlement = { settled: [], closedBatches: [] };
  const garmentIds = [...build.garments.keys()];
  if (garmentIds.length === 0) return { statements, settlement };
  const adjustBatches = opts.adjustBatches ?? true;

  const open = await allIn<{ exception_id: string; garment_id: string; batch_id: string | null; quantity: number }>(
    ctx.db,
    "SELECT exception_id, garment_id, batch_id, quantity FROM laundry_exceptions WHERE user_id = ? AND status = 'active' AND garment_id IN (:ids) ORDER BY julianday(occurred_at), exception_id",
    [ctx.userId],
    garmentIds,
  );
  const moved = open
    .map((x) => {
      const ref = x.batch_id ?? `exception:${x.exception_id}`;
      return { x, before: serviceHeld(build, x.garment_id, ref, "before"), after: serviceHeld(build, x.garment_id, ref, "after") };
    })
    // Only what actually moved: an exception with nothing held under it is not settled by an unrelated report.
    .filter((m) => m.before > m.after);

  const batchIds = adjustBatches ? [...new Set(moved.map((m) => m.x.batch_id).filter((b): b is string => b !== null))] : [];
  const items = await allIn<{ batch_id: string; garment_id: string; quantity: number; returned_quantity: number; still_away: number }>(
    ctx.db,
    "SELECT batch_id, garment_id, quantity, returned_quantity, still_away FROM laundry_batch_items WHERE user_id = ? AND batch_id IN (:ids)",
    [ctx.userId],
    batchIds,
  );
  const batches = await allIn<{ batch_id: string; status: string; returned_at: string | null; return_basis: string | null }>(
    ctx.db,
    "SELECT batch_id, status, returned_at, return_basis FROM laundry_batches WHERE user_id = ? AND withdrawn_at IS NULL AND batch_id IN (:ids)",
    [ctx.userId],
    batchIds,
  );

  for (const { x, before, after } of moved) {
    const record: SettledException = { exceptionId: x.exception_id, scope: "item", garmentId: x.garment_id, batchId: x.batch_id, cycleKey: null, previousQuantity: x.quantity, heldBefore: before, heldAfter: after, item: null };
    if (after === 0) {
      statements.push(
        stmt("UPDATE laundry_exceptions SET status = 'resolved', resolved_at = ?, resolution = ?, resolved_by_command_id = ? WHERE user_id = ? AND exception_id = ? AND status = 'active'", ctx.now, resolution, ctx.commandId, ctx.userId, x.exception_id),
      );
    } else {
      statements.push(stmt("UPDATE laundry_exceptions SET quantity = ? WHERE user_id = ? AND exception_id = ? AND status = 'active'", after, ctx.userId, x.exception_id));
    }
    const item = x.batch_id && adjustBatches ? items.find((i) => i.batch_id === x.batch_id && i.garment_id === x.garment_id) : undefined;
    if (item) {
      // The batch's own record of what came back follows the observation.
      const returnedAfter = Math.min(item.quantity - after, item.returned_quantity + (before - after));
      record.item = { returnedBefore: item.returned_quantity, stillAwayBefore: item.still_away, returnedAfter, stillAwayAfter: after };
      item.returned_quantity = returnedAfter;
      item.still_away = after;
      statements.push(stmt("UPDATE laundry_batch_items SET returned_quantity = ?, still_away = ? WHERE user_id = ? AND batch_id = ? AND garment_id = ?", returnedAfter, after, ctx.userId, x.batch_id, x.garment_id));
    }
    settlement.settled.push(record);
  }
  for (const b of batches) {
    if (b.status !== "partially_returned") continue;
    if (items.filter((i) => i.batch_id === b.batch_id).some((i) => i.returned_quantity < i.quantity)) continue;
    settlement.closedBatches.push({ batchId: b.batch_id, status: b.status, returnedAt: b.returned_at, returnBasis: b.return_basis });
    statements.push(stmt("UPDATE laundry_batches SET status = 'returned', returned_at = ?, return_basis = 'observed' WHERE user_id = ? AND batch_id = ?", ctx.occurredAt, ctx.userId, b.batch_id));
  }

  // A missed cycle whose last held unit this command released has nothing left to wait for.
  const emptied = new Set<string>();
  for (const g of build.garments.values()) {
    for (const [ref, h] of g.before.state.service) {
      if (ref.startsWith("cycle:") && h.quantity > 0 && !g.after.state.service.has(ref)) emptied.add(ref);
    }
  }
  for (const ref of emptied) {
    if ([...build.garments.values()].some((g) => (g.after.state.service.get(ref)?.quantity ?? 0) > 0)) continue;
    const elsewhere = await all<{ garment_id: string }>(ctx.db, "SELECT garment_id FROM stock_balances WHERE user_id = ? AND bucket = 'service' AND ref = ? AND quantity > 0", ctx.userId, ref);
    if (elsewhere.some((r) => !build.garments.has(r.garment_id))) continue;
    const cycleKey = ref.slice("cycle:".length);
    const rows = await all<{ exception_id: string; quantity: number }>(
      ctx.db,
      "SELECT exception_id, quantity FROM laundry_exceptions WHERE user_id = ? AND status = 'active' AND garment_id IS NULL AND cycle_key = ?",
      ctx.userId,
      cycleKey,
    );
    for (const r of rows) {
      settlement.settled.push({ exceptionId: r.exception_id, scope: "cycle", garmentId: null, batchId: null, cycleKey, previousQuantity: r.quantity, heldBefore: 1, heldAfter: 0, item: null });
      statements.push(
        stmt("UPDATE laundry_exceptions SET status = 'resolved', resolved_at = ?, resolution = ?, resolved_by_command_id = ? WHERE user_id = ? AND exception_id = ? AND status = 'active'", ctx.now, resolution, ctx.commandId, ctx.userId, r.exception_id),
      );
    }
  }
  return { statements, settlement };
}

/**
 * Reverse a settlement as part of undoing the command that made it. Every row is guarded on the state that
 * command left: if an exception, batch item or batch changed since, the undo is refused whole rather than
 * overwriting the later change. A missed-cycle exception is reopened only if, after the undo's replay, that
 * cycle is holding units again (a later baseline may already have released it).
 */
export function planExceptionUnsettle(ctx: CommandContext, forwardCommandId: string, settlement: ExceptionSettlement | undefined, undoBuild: StockBuild): { statements: Stmt[]; preconditions: Precondition[] } {
  const statements: Stmt[] = [];
  const preconditions: Precondition[] = [];
  if (!settlement) return { statements, preconditions };
  const state = "(SELECT status || ':' || quantity || ':' || COALESCE(resolved_by_command_id, '') FROM laundry_exceptions WHERE user_id = ? AND exception_id = ?) = ?";
  for (const x of settlement.settled) {
    // Whatever happens next, the row must still be as this command left it: a later change is never overwritten.
    const expected = x.heldAfter === 0 ? `resolved:${x.previousQuantity}:${forwardCommandId}` : `active:${x.heldAfter}:`;
    preconditions.push({ label: "the laundry exception has not changed since", sql: state, params: [ctx.userId, x.exceptionId, expected], class: "state" });
    if (x.scope === "cycle") {
      const heldAgain = [...undoBuild.garments.values()].some((g) => (g.after.state.service.get(`cycle:${x.cycleKey}`)?.quantity ?? 0) > 0);
      if (!heldAgain) continue;
    } else if (x.garmentId) {
      // Reopen an item exception only if the undo's replay really holds its units again. Another report in
      // the journal (an earlier "washed" that now applies to them) may account for them instead.
      const ref = x.batchId ?? `exception:${x.exceptionId}`;
      const heldNow = undoBuild.garments.get(x.garmentId)?.after.state.service.get(ref)?.quantity ?? 0;
      if (heldNow <= x.heldAfter) continue;
    }
    statements.push(
      stmt("UPDATE laundry_exceptions SET status = 'active', resolved_at = NULL, resolution = NULL, resolved_by_command_id = NULL, quantity = ? WHERE user_id = ? AND exception_id = ?", x.previousQuantity, ctx.userId, x.exceptionId),
    );
    if (x.item && x.batchId && x.garmentId) {
      preconditions.push({
        label: "the laundry batch item has not changed since",
        sql: "(SELECT returned_quantity || ':' || still_away FROM laundry_batch_items WHERE user_id = ? AND batch_id = ? AND garment_id = ?) = ?",
        params: [ctx.userId, x.batchId, x.garmentId, `${x.item.returnedAfter}:${x.item.stillAwayAfter}`],
        class: "state",
      });
      statements.push(stmt("UPDATE laundry_batch_items SET returned_quantity = ?, still_away = ? WHERE user_id = ? AND batch_id = ? AND garment_id = ?", x.item.returnedBefore, x.item.stillAwayBefore, ctx.userId, x.batchId, x.garmentId));
    }
  }
  for (const b of settlement.closedBatches) {
    preconditions.push({ label: "the laundry batch has not changed since", sql: "(SELECT status FROM laundry_batches WHERE user_id = ? AND batch_id = ? AND withdrawn_at IS NULL) = 'returned'", params: [ctx.userId, b.batchId], class: "state" });
    // The batch goes back exactly as it was, including when (and on what basis) it was last partly returned.
    statements.push(stmt("UPDATE laundry_batches SET status = ?, returned_at = ?, return_basis = ? WHERE user_id = ? AND batch_id = ?", b.status, b.returnedAt, b.returnBasis, ctx.userId, b.batchId));
  }
  return { statements, preconditions };
}

/** Void a command's journaled stock events and replay; the caller inspects the build before composing the plan. */
export async function undoStockBuild(ctx: CommandContext, eventIds: string[]): Promise<StockBuild> {
  const planner = ctx.stock();
  await undoStockEvents(ctx, planner, eventIds);
  return planner.build();
}

/** The compensating plan for a stock command whose undo also restores other records. */
export function undoPlan(_original: StoredCommand, build: StockBuild, extra: { statements: Stmt[]; preconditions: Precondition[] }, summary?: string): CommandPlan {
  const parts = stockParts(build);
  return {
    summary: summary ?? UNDO_STOCK_SUMMARY,
    statements: [...parts.statements, ...extra.statements],
    preconditions: [...parts.preconditions, ...extra.preconditions],
    affected: parts.affected,
    repairs: parts.repairs,
    changes: { availabilityChanged: parts.availabilityChanged },
    bumpWardrobe: true,
    undo: { unavailableReason: "this is already an undo; repeat the original action instead" },
  };
}
