/**
 * What a connected assistant's typed command (`garderobe_command`) does with each command type.
 *
 * The owner's rule (decision of 2026-10-01): a connected assistant may propose a change, but a change
 * is carried out only after the signed-in owner confirms a summary written by the system; wear and wash
 * reports are the exception that needs no tap. So this is an allow-list, and a type that is not on it
 * waits for the owner. The list is not kept here: it is the assistant workstream's classification of
 * what relayed words may record (`classifyChange(type, payload, "mcp")`), so the typed path and the
 * conversation path (`garderobe_ask`) cannot drift apart.
 *
 *   - `direct`    recorded at once: a wear report for garments no active restriction excludes, a wash or
 *                 needs-a-wash report naming its garments, the records of a piece of research, the routine
 *                 actions the owner allowed on 2026-10-03 (see `TYPED_DIRECT_BY_OWNER_DECISION`), and the
 *                 undo of one of these.
 *   - `owner`     kept as a proposal; only the owner's confirmation in the app runs it.
 *   - `internal`  not available to a connection at all: bookkeeping the system does for itself (class
 *                 `system`), account-level commands, and commands that do not accept an owner's statement.
 *   - `lift`      lifting a restriction or undoing the record of one: refused outright by the registry
 *                 guard (`guardRestrictionLifts`), which states the reason; the owner lifts it in the app.
 *
 * A report is recorded at once only for today or the last seven days as the owner counts them, the same
 * window the conversation path applies. A wear dated earlier or later, or a report said to have happened
 * longer ago than that, is not refused: it waits for the owner like any other change.
 */
import { classifyChange, REPORT_WINDOW_DAYS, withinReportWindow } from "@garderobe/assistant";
import { first, getOwnerState, localDateOf, type CommandRegistry, type Db, type Principal } from "@garderobe/domain";
import { wearsRestrictedGarment } from "../restrictions.ts";

export type ConnectedDisposition = "direct" | "owner" | "internal" | "lift";

const LIFTS = new Set(["restriction.resolve", "assistant.lift_restriction"]);

/** What is recorded without a tap and says when something happened: the owner's reports, and the routine actions that are observations. */
const REPORTS = new Set(["wear.record", "care.mark_dirty", "care.washed", "laundry.collect", "laundry.return", "stock.pack", "stock.unpack"]);

/**
 * How far back a connected assistant's report is recorded without the owner: today and the seven days
 * before it. The window is the assistant workstream's own (`REPORT_WINDOW_DAYS`, `withinReportWindow`), the
 * one it applies to reports made in conversation, so the typed path and the conversation path agree.
 */
export { REPORT_WINDOW_DAYS, withinReportWindow };

/** When the request was made and what it says about when the reported thing happened. */
export interface ReportTiming {
  principal: Principal;
  nowMs: number;
  /** The envelope's `occurredAt`, when the connection gave one. */
  occurredAt?: string | null | undefined;
}

async function reportOutsideWindow(db: Db, type: string, payload: Record<string, unknown>, timing: ReportTiming): Promise<boolean> {
  if (!REPORTS.has(type)) return false;
  const { settings } = await getOwnerState(db, timing.principal);
  const today = localDateOf(timing.nowMs, settings.timezone);
  // A malformed date is left to the command's own schema, which names the error.
  if (type === "wear.record" && typeof payload.wearingDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(payload.wearingDate) && !withinReportWindow(payload.wearingDate, today)) return true;
  if (typeof timing.occurredAt === "string") {
    const at = Date.parse(timing.occurredAt);
    if (Number.isFinite(at) && !withinReportWindow(localDateOf(at, settings.timezone), today)) return true;
  }
  return false;
}

/**
 * Types the owner has decided a connected assistant's TYPED command may run directly although relayed
 * conversation text may not. This is the one place to add a type for the typed path only; a type that
 * should also run from relayed conversation text belongs in the assistant workstream's classification
 * instead.
 *
 * Owner decision of 2026-10-03: a connected assistant may directly perform the routine, undoable actions,
 * each with an authenticated receipt and undo: choosing from the published outfit board, laundry pickup
 * and return, and packing checks. Each of the five commands below has an undo of its own (a return of a
 * recorded laundry bag since the foundation's a5e6c8fa; until then it waited for the owner).
 *
 * Record corrections, moves, retirements,
 * settings, restrictions, style and measurements wait for the owner as before, and so do
 * `laundry.report_exception`, trips, reminders, feedback and images, which the decision does not name.
 * The same set is given to the assistant workstream's ledger guard (`registerAssistant`, `typedDirect`),
 * which otherwise refuses a connected assistant's command that names no conversation turn.
 */
export const TYPED_DIRECT_BY_OWNER_DECISION: ReadonlySet<string> = new Set<string>(["board.select", "laundry.collect", "laundry.return", "stock.pack", "stock.unpack"]);

/**
 * The part of a routine action the decision does not cover, so it waits for the owner after all:
 *   - a laundry return that names pieces as still away records an exception for each of them, which is
 *     what `laundry.report_exception` does;
 *   - packing or unpacking for something that is not one of the owner's planned trips is not a packing
 *     check of a trip; it would only move pieces out of what can be suggested.
 */
async function routineActionNeedsOwner(db: Db, userId: string, type: string, payload: Record<string, unknown>): Promise<boolean> {
  if (type === "laundry.return") return Array.isArray(payload.stillAway) && payload.stillAway.length > 0;
  if (type === "stock.pack" || type === "stock.unpack") {
    if (typeof payload.tripId !== "string") return false; // refused by the command's own schema
    return !(await first(db, "SELECT 1 AS x FROM trips WHERE user_id = ? AND trip_id = ? AND status = 'planned'", userId, payload.tripId));
  }
  return false;
}

/** The part that depends only on the type and payload (no ledger read). Unknown types are `direct`: the command service names the error. */
export function connectedDispositionOfType(registry: CommandRegistry, type: string, payload: Record<string, unknown>): ConnectedDisposition {
  if (!registry.has(type)) return "direct";
  if (LIFTS.has(type)) return "lift";
  const definition = registry.get(type);
  if (definition.class === "system" || definition.requiredScope === "admin" || !registry.allowedAuthorizations(definition).includes("owner_statement")) return "internal";
  if (TYPED_DIRECT_BY_OWNER_DECISION.has(type)) return "direct";
  return classifyChange(type, payload, "mcp") === "confirm" ? "owner" : "direct";
}

/** The full decision for one request, including what the ledger says about the garments or the command it names. */
export async function connectedDisposition(registry: CommandRegistry, db: Db, userId: string, type: string, payload: Record<string, unknown>, timing?: ReportTiming): Promise<ConnectedDisposition> {
  if (type === "command.undo" && registry.has(type)) {
    // Undoing is the same change in the other direction, so it is treated as the change it undoes.
    if (typeof payload.commandId !== "string") return "direct"; // refused by the command's own schema
    const target = await first<{ type: string; payload_json: string }>(db, "SELECT type, payload_json FROM commands WHERE user_id = ? AND command_id = ?", userId, payload.commandId);
    if (!target) return "direct"; // the command service answers not_found
    if (target.type === "restriction.add") return "lift";
    let targetPayload: Record<string, unknown> = {};
    try {
      targetPayload = (JSON.parse(target.payload_json) ?? {}) as Record<string, unknown>;
    } catch {
      targetPayload = {};
    }
    return connectedDispositionOfType(registry, target.type, targetPayload) === "direct" ? "direct" : "owner";
  }
  const disposition = connectedDispositionOfType(registry, type, payload);
  if (disposition === "direct" && TYPED_DIRECT_BY_OWNER_DECISION.has(type) && (await routineActionNeedsOwner(db, userId, type, payload))) return "owner";
  // A wear report naming a garment that an active restriction excludes contradicts the restriction on words nobody verified.
  if (disposition === "direct" && type === "wear.record" && (await wearsRestrictedGarment(db, userId, payload))) return "owner";
  // The tap-free exception is for garments the report names: "everything in the hamper is washed" names none.
  if (disposition === "direct" && type === "care.washed" && !(Array.isArray(payload.items) && payload.items.length > 0)) return "owner";
  // The tap-free exception covers today and the last week; a report about any other day waits for the owner.
  if (disposition === "direct" && timing && (await reportOutsideWindow(db, type, payload, timing))) return "owner";
  return disposition;
}
