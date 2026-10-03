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
 *                 needs-a-wash report naming its garments, the records of a piece of research, and the
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
import { classifyChange } from "@garderobe/assistant";
import { addDays, first, getOwnerState, localDateOf, type CommandRegistry, type Db, type Principal } from "@garderobe/domain";
import { wearsRestrictedGarment } from "../restrictions.ts";

export type ConnectedDisposition = "direct" | "owner" | "internal" | "lift";

const LIFTS = new Set(["restriction.resolve", "assistant.lift_restriction"]);

/** The owner's reports that are recorded without a tap. */
const REPORTS = new Set(["wear.record", "care.mark_dirty", "care.washed"]);

/**
 * How far back a connected assistant's report is recorded without the owner: today and this many days
 * before it. The assistant workstream applies the same window to reports made in conversation
 * (`packages/assistant/src/tools/runtime.ts`).
 */
export const REPORT_WINDOW_DAYS = 7;

/** Whether a wearing date lies in the window, given the owner's own calendar day. Dates are YYYY-MM-DD, so text order is date order. */
export const withinReportWindow = (wearingDate: string, ownerLocalDate: string): boolean => wearingDate <= ownerLocalDate && wearingDate >= addDays(ownerLocalDate, -REPORT_WINDOW_DAYS);

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
 * conversation text may not. Empty: the owner has decided no such difference. This is the one place to
 * add a type for the typed path only (for example `board.select` or `laundry.collect`, if the owner
 * decides everyday actions need no confirmation); a type that should also run from relayed conversation
 * text belongs in the assistant workstream's classification instead.
 */
export const TYPED_DIRECT_BY_OWNER_DECISION: ReadonlySet<string> = new Set<string>();

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
  // A wear report naming a garment that an active restriction excludes contradicts the restriction on words nobody verified.
  if (disposition === "direct" && type === "wear.record" && (await wearsRestrictedGarment(db, userId, payload))) return "owner";
  // The tap-free exception is for garments the report names: "everything in the hamper is washed" names none.
  if (disposition === "direct" && type === "care.washed" && !(Array.isArray(payload.items) && payload.items.length > 0)) return "owner";
  // The tap-free exception covers today and the last week; a report about any other day waits for the owner.
  if (disposition === "direct" && timing && (await reportOutsideWindow(db, type, payload, timing))) return "owner";
  return disposition;
}
