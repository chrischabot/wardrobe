import { CommandError, first, json, type CommandRegistry } from "@garderobe/domain";
import { OBSERVATION_TYPES, mayCommitFromConversation } from "../policy/classes.ts";
import { bindRegistry, compositeHandlers } from "./composite.ts";
import { purchaseHandlers } from "./purchases.ts";
import { researchHandlers } from "./research.ts";
import { returnHandlers } from "./returns.ts";
import { lifecycleHandlers } from "./lifecycle.ts";
import { feedbackHandlers } from "./feedback.ts";
import { memoryHandlers } from "./memory.ts";
import { inferenceHandlers } from "./inference.ts";
import { connectionHandlers, jobHandlers } from "./connections.ts";
import { reminderHandlers } from "./reminders.ts";

export const ASSISTANT_HANDLERS = [
  ...compositeHandlers,
  ...purchaseHandlers,
  ...researchHandlers,
  ...returnHandlers,
  ...lifecycleHandlers,
  ...feedbackHandlers,
  ...memoryHandlers,
  ...inferenceHandlers,
  ...connectionHandlers,
  ...jobHandlers,
  ...reminderHandlers,
];

const RESOLVERS: [kind: string, table: string, idColumn: string][] = [
  ["order", "orders", "order_id"],
  ["return_case", "return_cases", "case_id"],
  ["lifecycle_project", "lifecycle_projects", "project_id"],
  ["connection", "connections", "connection_id"],
  ["job", "assistant_jobs", "job_id"],
  ["memory_conclusion", "memory_conclusions", "conclusion_id"],
  ["research_note", "research_notes", "note_id"],
  ["product", "products", "product_id"],
  ["reminder", "reminders", "reminder_id"],
];

/**
 * Registers every assistant-lane command and its expected-version resolvers on the shared registry.
 * `apps/worker` composes the lanes: `const registry = createFoundationRegistry(); registerAssistant(registry);`
 */
export function registerAssistant(registry: CommandRegistry): CommandRegistry {
  for (const def of ASSISTANT_HANDLERS) registry.register(def);
  for (const [kind, table, idColumn] of RESOLVERS) {
    registry.registerVersionResolver(kind, (userId, id) => ({ sql: `SELECT version FROM ${table} WHERE user_id = ? AND ${idColumn} = ?`, params: [userId, id] }));
  }
  // The domain refuses an assistant-issued restriction lift unless its evidence reference checks out. A
  // reference is `message:<id>` and holds only when that message is the owner's own message of the turn
  // that issued the command: an invented ID, another turn's message or another owner's message fails.
  registry.setOwnerStatementVerifier(async (ctx, ref) => {
    const source = ctx.envelope.source;
    if (!ref.startsWith("message:") || source.parentKind !== "turn" || !source.parentId) return false;
    const row = await first(ctx.db, "SELECT 1 AS x FROM assistant_turns WHERE user_id = ? AND turn_id = ? AND user_message_id = ?", ctx.userId, source.parentId, ref.slice("message:".length));
    return row !== null && row !== undefined;
  });
  bindRegistry(registry);
  // The ledger-side backstop of the confirmation design. A command that arrives from a conversation turn
  // on the strength of conversation text (`owner_statement`) commits only when it is a wear or wash report
  // whose provenance trusted code recorded with the turn, or the assistant's own bookkeeping. Everything
  // else - whatever tool, present or future, tried it - is refused here and nothing is written: it has to
  // come as the owner's own confirmation of a proposal (`owner_tap` by the signed-in owner).
  registry.addCommitHook("assistant.conversation_authority", async (ctx) => {
    const { source, authorization, type, payload } = ctx.envelope;
    // The owner's confirmation of a proposal carries the versions the proposal was built against. For a
    // plan edit the command service already refuses a stale version; an owner observation is normally
    // rebased instead, which must not happen to a confirmed proposal: it would apply a change described
    // against a record that has since moved on. So the same versions are enforced here.
    if (source.parentKind === "turn" && authorization === "owner_tap" && registry.get(type).class === "observation") {
      const preconditions = [];
      for (const [key, version] of Object.entries(ctx.envelope.expectedVersions)) {
        const sep = key.indexOf(":");
        const resolver = registry.versionResolver(sep === -1 ? key : key.slice(0, sep));
        if (!resolver) throw new CommandError("invalid_command", `unknown expected-version kind in a confirmed request: '${key}'`, { key });
        const { sql, params } = resolver(ctx.userId, sep === -1 ? "" : key.slice(sep + 1));
        preconditions.push({ label: `the record ${key} changed since this request was made; ask for the change again`, sql: `(${sql}) = ?`, params: [...params, version], class: "state" as const });
      }
      return preconditions.length > 0 ? { preconditions } : undefined;
    }
    if (source.parentKind !== "turn" || authorization !== "owner_statement") return;
    const refuse = (reason: string) => new CommandError("forbidden", "this change is not made from conversation text; it needs the owner's confirmation in the Garderobe app. Nothing was written", { reason });
    if (!mayCommitFromConversation(type, payload as Record<string, unknown>, ctx.principal.channel)) throw refuse("owner_confirmation_required");
    if (!OBSERVATION_TYPES.has(type)) return;
    // An observation needs the record of why it was accepted: which garments the owner named or attached.
    const turn = await first<{ grants_json: string }>(ctx.db, "SELECT grants_json FROM assistant_turns WHERE user_id = ? AND turn_id = ?", ctx.userId, source.parentId ?? "");
    const grants = json<{ type?: string; basis?: string; garments?: { garmentId: string }[] }[]>(turn?.grants_json, []).filter((g) => g.type === type && g.basis === "owner_report");
    if (grants.length === 0) throw refuse("owner_report_not_recorded");
    const p = payload as { garmentIds?: string[]; remove?: string[]; add?: string[]; items?: { garmentId: string }[] };
    const garments = [...(p.garmentIds ?? []), ...(p.remove ?? []), ...(p.add ?? []), ...(p.items ?? []).map((i) => i.garmentId)];
    const covered = new Set(grants.flatMap((g) => (g.garments ?? []).map((x) => x.garmentId)));
    if (garments.some((id) => !covered.has(id))) throw refuse("garment_not_named_by_owner");
  });
  return registry;
}
