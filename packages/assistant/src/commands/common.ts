import { CommandError, first, stmt, type CommandContext, type CommandPlan, type PlannedEffect, type Stmt } from "@garderobe/domain";

export const NO_UNDO = (reason: string): CommandPlan["undo"] => ({ unavailableReason: reason });

/** Garment existence check for this owner. Commands never create a garment to make a reference resolve. */
export async function requireGarments(ctx: CommandContext, garmentIds: string[]): Promise<Map<string, { garment_id: string; name: string; acquisition: string }>> {
  const out = new Map<string, { garment_id: string; name: string; acquisition: string }>();
  for (const id of [...new Set(garmentIds)]) {
    const row = await first<{ garment_id: string; name: string; acquisition: string; removed_reason: string | null }>(
      ctx.db,
      "SELECT garment_id, name, acquisition, removed_reason FROM garments WHERE user_id = ? AND garment_id = ?",
      ctx.userId,
      id,
    );
    if (!row || row.removed_reason) throw new CommandError("not_found", `no garment '${id}' in this wardrobe; nothing was written`, { garmentId: id });
    out.set(id, row);
  }
  return out;
}

export async function effectExists(ctx: CommandContext, operationKey: string): Promise<boolean> {
  return (await first(ctx.db, "SELECT 1 AS x FROM effects WHERE user_id = ? AND operation_key = ?", ctx.userId, operationKey)) !== null;
}

/** Keep only effects whose stable operation key has never been enqueued (deduplicated reminders). */
export async function newEffects(ctx: CommandContext, effects: PlannedEffect[]): Promise<PlannedEffect[]> {
  const out: PlannedEffect[] = [];
  const seen = new Set<string>();
  for (const e of effects) {
    if (seen.has(e.operationKey)) continue;
    seen.add(e.operationKey);
    if (!(await effectExists(ctx, e.operationKey))) out.push(e);
  }
  return out;
}

export function money(minor: number | null | undefined, currency: string | null | undefined): string {
  if (minor === null || minor === undefined) return "an unknown amount";
  const value = (minor / 100).toFixed(2);
  return currency ? `${currency} ${value}` : value;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Version-checked update: the precondition makes a concurrent change re-plan instead of overwriting. */
export function versioned(table: string, idColumn: string, ctx: CommandContext, id: string, version: number): { bump: Stmt; precondition: NonNullable<CommandPlan["preconditions"]>[number] } {
  return {
    bump: stmt(`UPDATE ${table} SET version = version + 1, updated_at = ? WHERE user_id = ? AND ${idColumn} = ?`, ctx.now, ctx.userId, id),
    precondition: { label: `${table} ${id} unchanged since read`, sql: `(SELECT version FROM ${table} WHERE user_id = ? AND ${idColumn} = ?) = ?`, params: [ctx.userId, id, version], class: "internal" },
  };
}

/** Settings namespace owned by the assistant workstream (OwnerSettings.extensions.assistant). */
export interface AssistantSettings {
  returnReminderDays?: number[];
  routing?: Record<string, { profileId: string; fallbacks: string[]; evaluationRef?: string | null }>;
  budgets?: Record<string, number>;
}

export function assistantSettings(ctx: { settings: { extensions: Record<string, unknown> } }): AssistantSettings {
  const raw = ctx.settings.extensions["assistant"];
  return raw && typeof raw === "object" ? (raw as AssistantSettings) : {};
}

/**
 * A free-text value (a title, a name, a topic, a next action) as it may appear inside a receipt summary.
 * Such values can come from a model or from a page, so they are never allowed to read as the system's own
 * statement: the value is put on one line, stripped of control characters, cut short and wrapped in
 * quotation marks. The sentence around it is written by trusted code.
 */
export function named(value: string | null | undefined, max = 60): string {
  const clean = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/[\u201C\u201D"]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return `\u201C${clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}\u2026` : clean}\u201D`;
}
