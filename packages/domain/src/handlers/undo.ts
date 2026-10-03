import { FOUNDATION_COMMANDS as C } from "@garderobe/contracts";
import { first, stmt } from "../db.ts";
import { CommandError } from "../errors.ts";
import type { CommandRegistry } from "../commands/registry.ts";
import type { CommandPlan, StoredCommand } from "../commands/types.ts";
import { json } from "../db.ts";
import { define } from "./garments.ts";

/**
 * Undo is a compensating command: it runs the original handler's `planUndo`, which rechecks
 * intervening changes, and commits through the same batch path with its own receipt. The original
 * command and receipt are never deleted; they are linked (undone_by / undoes).
 */
export function commandUndo(registry: CommandRegistry) {
  return define({
    type: "command.undo",
    schema: C["command.undo"],
    class: "edit",
    requiredScope: "write",
    async plan(ctx, p): Promise<CommandPlan> {
      const row = await first<{ type: string; payload_json: string; undo_json: string | null; occurred_at: string; recorded_at: string; undone_by_command_id: string | null; undoes_command_id: string | null; receipt_json: string }>(
        ctx.db,
        "SELECT type, payload_json, undo_json, occurred_at, recorded_at, undone_by_command_id, undoes_command_id, receipt_json FROM commands WHERE user_id = ? AND command_id = ?",
        ctx.userId,
        p.commandId,
      );
      if (!row) throw new CommandError("not_found", "there is no such action to undo", { commandId: p.commandId });
      if (row.undone_by_command_id) throw new CommandError("not_undoable", "that action was already undone", { undoneBy: row.undone_by_command_id });
      const undo = json<{ data?: Record<string, unknown>; unavailableReason?: string } | null>(row.undo_json, null);
      const def = registry.get(row.type);
      if (!undo || !undo.data || !def.planUndo) {
        throw new CommandError("not_undoable", undo?.unavailableReason ?? "this action has no automatic undo", { commandId: p.commandId });
      }
      const original: StoredCommand = {
        commandId: p.commandId,
        type: row.type,
        payload: json(row.payload_json, {}),
        occurredAt: row.occurred_at,
        recordedAt: row.recorded_at,
        undo: { data: undo.data },
        undoneByCommandId: null,
        undoesCommandId: row.undoes_command_id,
      };
      const plan = await def.planUndo(ctx, original, undo.data);
      // The receipt is read by the owner: an action whose receipt is unreadable is described in words, never by its type code.
      const originalSummary = (json<{ summary?: string }>(row.receipt_json, {}).summary || "an earlier action").replace(/\.$/, "");
      return {
        ...plan,
        summary: `Undone: ${originalSummary}. ${plan.summary}`,
        statements: [
          ...(plan.statements ?? []),
          stmt("UPDATE commands SET undone_by_command_id = ? WHERE user_id = ? AND command_id = ? AND undone_by_command_id IS NULL", ctx.commandId, ctx.userId, p.commandId),
          stmt("UPDATE commands SET undoes_command_id = ? WHERE user_id = ? AND command_id = ?", p.commandId, ctx.userId, ctx.commandId),
        ],
        preconditions: [
          ...(plan.preconditions ?? []),
          { label: "the action has not been undone already", sql: "(SELECT undone_by_command_id FROM commands WHERE user_id = ? AND command_id = ?) IS NULL", params: [ctx.userId, p.commandId], class: "state" },
        ],
        result: { ...(plan.result ?? {}), undoneCommandId: p.commandId },
        undo: { unavailableReason: "this is already an undo; repeat the original action instead" },
      };
    },
  });
}
