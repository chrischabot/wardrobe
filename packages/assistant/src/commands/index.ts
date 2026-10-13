import { CommandError, first, json, type CommandRegistry } from "@garderobe/domain";
import { GARMENT_RECORD_VERSION_SQL, OBSERVATION_TYPES, SECTION3_CONFIRM_TYPES, classifyChange, forbiddenForConnectedAssistant, grantCoversTargets, indirectReach } from "../policy/classes.ts";
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
 * The second argument is accepted for callers built against the earlier rule (`typedDirect`, a list of
 * types a connected assistant could run directly); since the owner's decision of 2026-10-05 every type
 * outside the contract's section 3 runs directly on every surface, so it no longer changes anything.
 */
export function registerAssistant(registry: CommandRegistry, _options: { typedDirect?: ReadonlySet<string> } = {}): CommandRegistry {
  for (const def of ASSISTANT_HANDLERS) registry.register(def);
  for (const [kind, table, idColumn] of RESOLVERS) {
    registry.registerVersionResolver(kind, (userId, id) => ({ sql: `SELECT version FROM ${table} WHERE user_id = ? AND ${idColumn} = ?`, params: [userId, id] }));
  }
  // How many times a piece's RECORD was changed: the version a waiting request about that piece is held to.
  // The piece's own `version` also moves with every wear, wash and laundry cycle, which would make a
  // request stale although nothing the owner was shown has changed (third review, point G).
  registry.registerVersionResolver("garment_record", (userId, id) => ({ sql: GARMENT_RECORD_VERSION_SQL, params: [userId, id] }));
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
  // The ledger-side backstop of the owner's decision of 2026-10-05. Whatever tool or client sends it, a
  // command made on the strength of the owner's word (`owner_statement`) commits only when:
  //   - it is not a restriction lift by a connected assistant, nor any assistant's undo of the command that
  //     recorded a restriction (refused outright);
  //   - it is not a section 3 change (those come only as the signed-in owner's confirmation, `owner_tap`);
  //   - from a conversation turn: a direction carries the turn's `owner_direction` grant (the owner wrote
  //     words of their own in it), and a wear or wash report the turn's `owner_report` grant covering its
  //     date and every garment. A turn command without its grant is refused and nothing is written.
  registry.addCommitHook("assistant.conversation_authority", async (ctx, plan) => {
    const { source, authorization, type, payload } = ctx.envelope;
    if (source.parentKind === "turn" && authorization === "owner_tap" && type === "garment.bulk_correct") {
      const expectedIds = Object.keys(ctx.envelope.expectedVersions)
        .filter((k) => k.startsWith("garment_record:"))
        .map((k) => k.slice("garment_record:".length))
        .sort();
      const res = (plan.result ?? {}) as { changedGarmentIds?: string[]; unchangedGarmentIds?: string[] };
      const currentIds = [...(res.changedGarmentIds ?? []), ...(res.unchangedGarmentIds ?? [])].sort();
      if (currentIds.length !== expectedIds.length || currentIds.some((id, i) => id !== expectedIds[i])) {
        throw new CommandError("conflict", "the garments matching this bulk change have changed since the request was made; ask for the change again", { expectedIds, currentIds });
      }
    }
    // The owner's confirmation of a proposal carries the versions the proposal was built against. For a
    // plan edit the command service already refuses a stale version; an owner observation is normally
    // rebased instead, which must not happen to a confirmed proposal: it would apply a change described
    // against a record that has since moved on. So the same versions are enforced here.
    if (source.parentKind === "turn" && authorization === "owner_tap" && registry.has(type) && registry.get(type).class === "observation") {
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
    if (authorization !== "owner_statement") return;
    const p = payload as Record<string, unknown>;
    const assistant = ctx.principal.actor === "assistant";
    const connected = ctx.principal.channel === "mcp";
    const target = type === "command.undo" ? await first<{ type: string }>(ctx.db, "SELECT type FROM commands WHERE user_id = ? AND command_id = ?", ctx.userId, String(p["commandId"] ?? "")) : null;
    if (type === "command.undo" && !target) return; // the undo itself answers not_found
    // Hard constraints: no assistant undoes the record of a restriction (that would lift it), and a
    // connected assistant lifts none at all. Refused outright, not kept.
    if (assistant && target?.type === "restriction.add") {
      throw new CommandError("forbidden", "undoing the record of a restriction would lift it; only the owner does that, in the Garderobe app. Nothing was written", { reason: "restriction_not_lifted_by_undo" });
    }
    if (assistant && connected) {
      const forbidden = forbiddenForConnectedAssistant(type, p, target);
      if (forbidden) throw new CommandError("forbidden", "a restriction is lifted only by the owner in the Garderobe app, never through a connected assistant. Nothing was written", { reason: forbidden });
    }
    const waits = (reason: string) => new CommandError("forbidden", "this change waits for the owner's confirmation in the Garderobe app; it is not made on an assistant's word. Nothing was written", { reason });
    // Section 3: irreversible erasure, authorization towards another party, reach of a model or a
    // connection, rewriting the profile document. An undo of such a change is the same for a connected assistant.
    const reach = assistant ? await indirectReach(ctx.db, ctx.userId, type, p) : 0;
    if (assistant && classifyChange(type, p, ctx.principal.channel, reach) === "confirm") throw waits("owner_confirmation_required");
    if (assistant && connected && target && SECTION3_CONFIRM_TYPES.has(target.type)) throw waits("owner_confirmation_required");
    const cls = classifyChange(type, p, ctx.principal.channel, reach);
    if (cls === "bookkeeping" || (registry.has(type) && registry.get(type).class === "system")) return;
    if (source.parentKind !== "turn") {
      if (assistant && !connected) throw waits("owner_words_not_recorded");
      return;
    }
    const turn = await first<{ grants_json: string }>(ctx.db, "SELECT grants_json FROM assistant_turns WHERE user_id = ? AND turn_id = ?", ctx.userId, source.parentId ?? "");
    const allGrants = json<{ type?: string; basis?: string; wearingDate?: string; targets?: string[]; garments?: { garmentId: string }[] }[]>(turn?.grants_json, []);
    if (cls === "direction") {
      // The grant must be for this type AND for these very records: a grant given for one piece, return or
      // restriction never authorizes a change to another.
      if (!allGrants.some((g) => g.type === type && g.basis === "owner_direction" && grantCoversTargets(g, p, type))) throw waits("owner_words_not_recorded");
      return;
    }
    if (!OBSERVATION_TYPES.has(type)) return;
    // An observation needs the record of why it was accepted: which garments the owner named or attached.
    const grants = allGrants.filter((g) => g.type === type && g.basis === "owner_report");
    if (grants.length === 0) throw waits("owner_report_not_recorded");
    const r = payload as { wearingDate?: string; allOfChannel?: string | null; garmentIds?: string[]; items?: { garmentId: string }[] };
    // A whole care channel names no piece: it is never an owner's report of named pieces.
    if (r.allOfChannel) throw waits("group_not_named_by_owner");
    const garments = [...(r.garmentIds ?? []), ...(r.items ?? []).map((i) => i.garmentId)];
    // One recorded report must cover this command whole: its date (for a wear report) and every garment.
    const covering = grants.some((g) => {
      if (type === "wear.record" && g.wearingDate !== r.wearingDate) return false;
      const covered = new Set((g.garments ?? []).map((x) => x.garmentId));
      return garments.length > 0 && garments.every((id) => covered.has(id));
    });
    if (!covering) throw waits("garment_not_named_by_owner");
  });
  return registry;
}
