/**
 * What a connected assistant's typed command (`garderobe_command`) does with each command type.
 *
 * The owner's contract of 2026-10-05, "Changes apply at once with undo on every surface": a change is
 * applied at once with a receipt and, where the ledger has one, an undo, on every surface, except the
 * contract's section 3 list, which waits for the signed-in owner's confirmation in the app. The class of a
 * change is the assistant workstream's one classification (`classifyChange` in
 * packages/assistant/src/policy/classes.ts), so the typed path, the conversation path and the published
 * `consequential` flag cannot drift apart.
 *
 *   - `direct`    applied at once: observations (wear and wash reports, whatever their date and whichever
 *                 pieces they name: an observation is a fact), bookkeeping, and every direction, with the
 *                 undo of any of these.
 *   - `owner`     kept as a proposal; only the owner's confirmation in the app runs it. Section 3 (irreversible
 *                 erasure, authorization towards another party, what a model or outside connection may reach,
 *                 rewriting the profile document). A background job that reads the owner's mailbox or files is
 *                 the section 3 case "what a model or an outside connection may reach".
 *   - `bounded`   refused: a change to an unbounded set. This is a hard bound of the surface, not an owner-wait
 *                 category (coordinator's ruling of 2026-10-13); the owner makes such a change in the app.
 *   - `internal`  not available to a connection at all: bookkeeping the system does for itself (class
 *                 `system`), account-level commands, and commands that do not accept an owner's statement.
 *   - `lift`      lifting a restriction or undoing the record of one: refused outright
 *                 (`forbiddenForConnectedAssistant`); the owner lifts it in the app.
 *
 * Both rest on the assistant workstream's own definitions (packages/assistant/src/policy/classes.ts):
 *   1. `OUTSIDE_REACH_JOB_KINDS` (`email_investigation`, `sheet_import`): `confirm` on `mcp`, so `owner`.
 *   2. `isUnboundedChange`: a bulk correction whose size the request does not state or that exceeds
 *      `MAX_APPLIED_CHANGES_PER_TURN`, a wash report for a whole care channel, and a payload naming more pieces
 *      than that bound: `bounded`, checked before the classification.
 */
import { classifyChange, forbiddenForConnectedAssistant, isUnboundedChange, MAX_APPLIED_CHANGES_PER_TURN } from "@garderobe/assistant";
import { first, type CommandRegistry, type Db } from "@garderobe/domain";

export type ConnectedDisposition = "direct" | "owner" | "bounded" | "internal" | "lift";

/** The most pieces one typed command from a connected assistant changes: the assistant's per-turn cap. */
export const CONNECTED_BULK_LIMIT = MAX_APPLIED_CHANGES_PER_TURN;

/** What the owner and the connection are told when a change exceeds the bound. */
export const BOUND_MESSAGE = `a connected assistant can change at most ${MAX_APPLIED_CHANGES_PER_TURN} named pieces in one request, and a bulk correction must state its expectedCount; nothing was changed. Split the change into requests that name at most ${MAX_APPLIED_CHANGES_PER_TURN} pieces each, or make it in the Garderobe app`;

/** Whether a payload applies to more than a bounded, named set (the assistant's `isUnboundedChange`). */
export const unboundedBulk = (type: string, payload: Record<string, unknown>): boolean => isUnboundedChange(type, payload);

/** The part that depends only on the type and payload (no ledger read). Unknown types are `direct`: the command service names the error. */
export function connectedDispositionOfType(registry: CommandRegistry, type: string, payload: Record<string, unknown>): ConnectedDisposition {
  if (!registry.has(type)) return "direct";
  if (forbiddenForConnectedAssistant(type, payload)) return "lift";
  const definition = registry.get(type);
  if (definition.class === "system" || definition.requiredScope === "admin" || !registry.allowedAuthorizations(definition).includes("owner_statement")) return "internal";
  if (isUnboundedChange(type, payload)) return "bounded";
  return classifyChange(type, payload, "mcp") === "confirm" ? "owner" : "direct";
}

/** The full decision for one request, including the command an undo names. */
export async function connectedDisposition(registry: CommandRegistry, db: Db, userId: string, type: string, payload: Record<string, unknown>): Promise<ConnectedDisposition> {
  if (type === "command.undo" && registry.has(type)) {
    // Undoing is the same change in the other direction, so it is treated as the change it undoes.
    if (typeof payload.commandId !== "string") return "direct"; // refused by the command's own schema
    const target = await first<{ type: string; payload_json: string }>(db, "SELECT type, payload_json FROM commands WHERE user_id = ? AND command_id = ?", userId, payload.commandId);
    if (!target) return "direct"; // the command service answers not_found
    let targetPayload: Record<string, unknown> = {};
    try {
      targetPayload = (JSON.parse(target.payload_json) ?? {}) as Record<string, unknown>;
    } catch {
      targetPayload = {};
    }
    if (forbiddenForConnectedAssistant(type, payload, { type: target.type })) return "lift";
    const undone = connectedDispositionOfType(registry, target.type, targetPayload);
    // An undo is never more permissive than the change it undoes: internal stays internal, a lift stays a lift.
    return undone;
  }
  return connectedDispositionOfType(registry, type, payload);
}
