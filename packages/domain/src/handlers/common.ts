import type { EntityVersion } from "@garderobe/contracts";
import { all, allIn, json, stmt, type Stmt } from "../db.ts";
import { CommandError } from "../errors.ts";
import type { GarmentRow, StockBuild, StockPlanner } from "../stock/planner.ts";
import type { CommandContext, CommandPlan, StoredCommand } from "../commands/types.ts";

export const GARMENT_COLS = "garment_id, version, name, category, care_channel, acquisition, planning_policy, merged_into, removed_reason, attributes_json";

/** Load garments by ID for this owner. All-or-nothing: any unknown ID fails the whole command. */
export async function loadGarments(ctx: CommandContext, ids: string[], opts: { followMerges?: boolean } = {}): Promise<Map<string, GarmentRow>> {
  const unique = [...new Set(ids)];
  const rows = await allIn<GarmentRow>(ctx.db, `SELECT ${GARMENT_COLS} FROM garments WHERE user_id = ? AND garment_id IN (:ids)`, [ctx.userId], unique);
  const byId = new Map(rows.map((r) => [r.garment_id, r]));
  const out = new Map<string, GarmentRow>();
  const missing: string[] = [];
  for (const id of unique) {
    let row = byId.get(id);
    // An identity merge redirects later reports to the canonical garment.
    for (let hops = 0; row && row.merged_into && opts.followMerges !== false && hops < 5; hops++) {
      const target = row.merged_into;
      row = byId.get(target) ?? (await all<GarmentRow>(ctx.db, `SELECT ${GARMENT_COLS} FROM garments WHERE user_id = ? AND garment_id = ?`, ctx.userId, target))[0];
    }
    if (!row || row.removed_reason !== null) missing.push(id);
    else out.set(id, row);
  }
  if (missing.length > 0) {
    throw new CommandError("not_found", `unknown garment${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}; nothing was written`, { missing, resolved: [...out.keys()] });
  }
  return out;
}

export async function loadGarment(ctx: CommandContext, id: string, opts: { followMerges?: boolean } = {}): Promise<GarmentRow> {
  return (await loadGarments(ctx, [id], opts)).get(id)!;
}

/**
 * Free text that came in with a command, as it appears inside a receipt summary.
 *
 * A summary is prose written by the ledger. Text supplied by the caller (a reason, a direction, a brief,
 * a new name) is shown inside typographic quotation marks, on one line, with any quotation marks of its
 * own flattened and its length bounded, so it always reads as something that was said and can never
 * pass for, or continue, the ledger's own sentence. The stored record keeps the text exactly as given.
 * Same convention as the assistant lane's `named`.
 */
export function quoted(value: string | null | undefined, max = 160): string {
  const clean = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB\uFF02"]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return `\u201C${clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}\u2026` : clean}\u201D`;
}

export function nameList(names: string[], max = 6): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

/** Fold a stock build into plan parts shared by every stock-changing handler. */
export function stockParts(build: StockBuild): {
  statements: Stmt[];
  preconditions: NonNullable<CommandPlan["preconditions"]>;
  affected: EntityVersion[];
  repairs: string[];
  availabilityChanged: string[];
} {
  const affected: EntityVersion[] = [];
  const availabilityChanged: string[] = [];
  for (const [id, g] of build.garments) {
    affected.push({ kind: "garment", id, version: g.versionAfter });
    availabilityChanged.push(id);
  }
  return { statements: build.statements, preconditions: build.preconditions, affected, repairs: build.repairs, availabilityChanged };
}

/** Generic compensation for commands whose whole effect is a set of journaled stock events. */
export async function undoStockEvents(ctx: CommandContext, planner: StockPlanner, eventIds: string[]): Promise<void> {
  if (eventIds.length === 0) return;
  const rows = await allIn<{ event_id: string; garment_id: string | null; voided_by_command_id: string | null }>(
    ctx.db,
    "SELECT event_id, garment_id, voided_by_command_id FROM stock_events WHERE user_id = ? AND event_id IN (:ids)",
    [ctx.userId],
    eventIds,
  );
  for (const r of rows) if (r.voided_by_command_id === null) planner.void(r.event_id, r.garment_id);
}

/**
 * What the receipt of an undone stock command says when its handler has nothing more specific to add.
 * Receipts are read by the owner: they never show a command's type code.
 */
export const UNDO_STOCK_SUMMARY = "The quantities are as they were before";

export async function simpleStockUndo(ctx: CommandContext, _original: StoredCommand, data: Record<string, any>, extra: Stmt[] = []): Promise<CommandPlan> {
  const planner = ctx.stock();
  await undoStockEvents(ctx, planner, (data.stockEventIds ?? []) as string[]);
  const parts = stockParts(await planner.build());
  return {
    summary: UNDO_STOCK_SUMMARY,
    statements: [...parts.statements, ...extra],
    preconditions: parts.preconditions,
    affected: parts.affected,
    repairs: parts.repairs,
    changes: { availabilityChanged: parts.availabilityChanged },
    bumpWardrobe: true,
    undo: { unavailableReason: "this is already an undo; repeat the original action instead" },
  };
}

export function attrs(row: GarmentRow): Record<string, unknown> {
  return json<Record<string, unknown>>(row.attributes_json, {});
}

export function bumpGarment(ctx: CommandContext, garmentId: string, expectedVersion: number): { statement: Stmt; precondition: NonNullable<CommandPlan["preconditions"]>[number] } {
  return {
    statement: stmt("UPDATE garments SET version = version + 1, updated_at = ? WHERE user_id = ? AND garment_id = ?", ctx.now, ctx.userId, garmentId),
    precondition: {
      label: `garment ${garmentId} unchanged since read`,
      sql: "(SELECT version FROM garments WHERE user_id = ? AND garment_id = ?) = ?",
      params: [ctx.userId, garmentId, expectedVersion],
      class: "internal",
    },
  };
}
