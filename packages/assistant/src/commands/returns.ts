import { ASSISTANT_COMMANDS as C, type ReturnTerms } from "@garderobe/contracts/ext/assistant";
import { CommandError, addDays, define, endOfLocalDateMs, first, json, stmt, toInstant, type CommandContext, type PlannedEffect, type Stmt } from "@garderobe/domain";
import { NO_UNDO, assistantSettings, money, newEffects, requireGarments, named } from "./common.ts";

export interface DeadlineResult {
  status: "established" | "unresolved";
  at: string | null;
  localDate: string | null;
  timezone: string | null;
  concerns: ReturnTerms["concerns"] | null;
  reason: string | null;
}

/**
 * A deadline exists only when sourced purchase terms AND the real trigger date are both known.
 * Anything else is unresolved research: never a speculative countdown from a generic policy.
 */
export function computeDeadline(terms: ReturnTerms | null, triggerDate: string | null, timezone: string): DeadlineResult {
  const unresolved = (reason: string): DeadlineResult => ({ status: "unresolved", at: null, localDate: null, timezone: null, concerns: terms?.concerns ?? null, reason });
  if (!terms) return unresolved("the return terms for this purchase have not been found yet");
  if (!terms.sourceRef.trim()) return unresolved("the return terms have no source");
  if (!triggerDate) return unresolved(`the ${terms.triggerEvent} date is not known yet`);
  const localDate = addDays(triggerDate, terms.windowDays);
  return { status: "established", at: toInstant(endOfLocalDateMs(localDate, timezone)), localDate, timezone, concerns: terms.concerns, reason: null };
}

export const DEFAULT_REMINDER_DAYS = [7, 2];

function reminderEffects(ctx: CommandContext, caseId: string, deadline: DeadlineResult, label: string): PlannedEffect[] {
  if (deadline.status !== "established" || !deadline.at) return [];
  const days = assistantSettings(ctx).returnReminderDays ?? DEFAULT_REMINDER_DAYS;
  const deadlineMs = Date.parse(deadline.at);
  const out: PlannedEffect[] = [];
  for (const d of [...new Set(days)].filter((n) => Number.isInteger(n) && n > 0)) {
    const dueMs = deadlineMs - d * 86_400_000;
    if (dueMs <= ctx.nowMs) continue; // never queue a reminder that is already in the past
    out.push({
      kind: "notification.return_reminder",
      targetKey: `return:${caseId}`,
      // One reminder per case, deadline and lead time, shared by the app and the calendar projection.
      operationKey: `return:${caseId}:${deadline.at}:${d}`,
      payload: { caseId, daysBefore: d, deadlineAt: deadline.at, deadlineLocalDate: deadline.localDate, concerns: deadline.concerns, label },
      availableAt: toInstant(dueMs),
    });
  }
  return out;
}

function describeDeadline(d: DeadlineResult): string {
  if (d.status === "established") return `Deadline to ${d.concerns === "retailer_receipt" ? "reach the retailer" : d.concerns}: ${d.localDate} (${d.timezone})`;
  return `Deadline unresolved: ${d.reason}`;
}

interface CaseRow {
  case_id: string;
  version: number;
  kind: string;
  state: string;
  garment_id: string | null;
  order_id: string | null;
  line_id: string | null;
  terms_json: string | null;
  trigger_date: string | null;
  deadline_timezone: string | null;
  deadline_at: string | null;
  refund_expected_minor: number | null;
  refund_received_minor: number;
  currency: string | null;
  notes_json: string;
}

async function subjectLabel(ctx: CommandContext, garmentId: string | null, orderId: string | null, lineId: string | null): Promise<string> {
  if (garmentId) {
    const g = await first<{ name: string }>(ctx.db, "SELECT name FROM garments WHERE user_id = ? AND garment_id = ?", ctx.userId, garmentId);
    if (g) return g.name;
  }
  if (orderId && lineId) {
    const l = await first<{ product_name: string }>(ctx.db, "SELECT product_name FROM order_lines WHERE user_id = ? AND order_id = ? AND line_id = ?", ctx.userId, orderId, lineId);
    if (l) return l.product_name;
  }
  return "the item";
}

export const returnOpenCase = define({
  type: "return.open_case",
  schema: C["return.open_case"],
  class: "edit",
  requiredScope: "write",
  async plan(ctx, p) {
    if (!p.garmentId && !(p.orderId && p.lineId)) throw new CommandError("invalid_command", "a return needs the garment or the order line it concerns");
    let garmentId = p.garmentId;
    let triggerDate = p.triggerDate;
    if (p.orderId && p.lineId) {
      const line = await first<{ garment_id: string | null; delivered_on: string | null }>(ctx.db, "SELECT garment_id, delivered_on FROM order_lines WHERE user_id = ? AND order_id = ? AND line_id = ?", ctx.userId, p.orderId, p.lineId);
      if (!line) throw new CommandError("not_found", "that order line is not recorded; nothing was written");
      garmentId ??= line.garment_id;
      // Use the real delivery date where the ledger has it.
      if (!triggerDate && p.terms?.triggerEvent === "delivery") triggerDate = line.delivered_on;
    }
    if (garmentId) await requireGarments(ctx, [garmentId]);
    const caseId = p.caseId ?? ctx.newId("ret");
    const timezone = p.timezone ?? ctx.settings.timezone;
    const deadline = computeDeadline(p.terms, triggerDate, timezone);
    const label = await subjectLabel(ctx, garmentId, p.orderId, p.lineId);
    const effects = await newEffects(ctx, reminderEffects(ctx, caseId, deadline, label));
    return {
      summary: `${p.kind === "exchange" ? "Exchange" : "Return"} opened for ${named(label)}. ${describeDeadline(deadline)}. It stays in your wardrobe until it physically leaves`,
      statements: [
        stmt(
          `INSERT INTO return_cases (user_id, case_id, version, kind, state, order_id, line_id, garment_id, quantity, terms_json, trigger_date, deadline_status, deadline_at, deadline_local_date, deadline_timezone, deadline_concerns, deadline_reason,
             next_action, collection_preference, refund_expected_minor, currency, reason, created_at, updated_at)
           VALUES (?, ?, 1, ?, 'considering', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ctx.userId, caseId, p.kind, p.orderId, p.lineId, garmentId, p.quantity, p.terms ? JSON.stringify(p.terms) : null, triggerDate, deadline.status, deadline.at, deadline.localDate, deadline.timezone ?? timezone, deadline.concerns, deadline.reason,
          p.nextAction, p.collectionPreference, p.refundExpectedMinor, p.currency, p.reason, ctx.now, ctx.now,
        ),
      ],
      affected: [{ kind: "return_case", id: caseId, version: 1 }],
      effects,
      result: { caseId, deadline, reminders: effects.map((e) => ({ dueAt: e.availableAt, daysBefore: e.payload.daysBefore })) },
      undo: { data: { caseId } },
    };
  },
  async planUndo(ctx, _o, data) {
    return {
      summary: "Return cancelled; the item stays as it was",
      statements: [
        stmt("UPDATE return_cases SET state = 'cancelled', version = version + 1, updated_at = ? WHERE user_id = ? AND case_id = ?", ctx.now, ctx.userId, data.caseId),
        stmt("UPDATE effects SET state = 'cancelled', updated_at = ? WHERE user_id = ? AND kind = 'notification.return_reminder' AND target_key = ? AND state = 'pending'", ctx.now, ctx.userId, `return:${data.caseId}`),
      ],
      undo: NO_UNDO("already an undo"),
    };
  },
});

const STATE_LABEL: Record<string, string> = {
  requested: "Return requested",
  label_ready: "Label ready",
  posted: "Marked as posted",
  retailer_received: "Retailer has received it",
  refunded: "Refund complete",
  exchanged: "Exchange complete",
  closed: "Closed",
  cancelled: "Cancelled",
  considering: "Back to considering",
};

export function refundStateOf(expected: number | null, received: number): "none" | "partial" | "full" | "over" {
  if (received <= 0) return "none";
  if (expected === null) return "partial";
  if (received < expected) return "partial";
  return received === expected ? "full" : "over";
}

export const returnUpdateCase = define({
  type: "return.update_case",
  schema: C["return.update_case"],
  class: "edit",
  requiredScope: "write",
  async plan(ctx, p) {
    const row = await first<CaseRow>(ctx.db, "SELECT * FROM return_cases WHERE user_id = ? AND case_id = ?", ctx.userId, p.caseId);
    if (!row) throw new CommandError("not_found", `no return '${p.caseId}'; nothing was written`);
    const label = await subjectLabel(ctx, row.garment_id, row.order_id, row.line_id);
    const terms = p.terms ?? json<ReturnTerms | null>(row.terms_json, null);
    const triggerDate = p.triggerDate ?? row.trigger_date;
    const timezone = row.deadline_timezone ?? ctx.settings.timezone;
    const deadline = computeDeadline(terms, triggerDate, timezone);
    const received = row.refund_received_minor + (p.refundReceivedMinor ?? 0);
    if (received < 0) throw new CommandError("precondition_failed", "a refund total cannot go below zero");
    const expected = p.refundExpectedMinor ?? row.refund_expected_minor;
    const currency = p.currency ?? row.currency;
    let state = p.state ?? row.state;
    // A partial refund never closes the case by itself.
    if (p.refundReceivedMinor !== undefined && !p.state && refundStateOf(expected, received) === "full" && row.kind === "return") state = "refunded";

    const parts: string[] = [];
    if (state !== row.state) parts.push(STATE_LABEL[state] ?? state);
    if (p.terms || p.triggerDate) parts.push(describeDeadline(deadline));
    if (p.refundReceivedMinor !== undefined) parts.push(`Refund received so far ${money(received, currency)}${expected !== null ? ` of ${money(expected, currency)} expected (${refundStateOf(expected, received)})` : ""}`);
    if (p.nextAction !== undefined && p.nextAction) parts.push(`Next: ${p.nextAction}`);
    if (p.shipmentRef) parts.push("Shipment recorded");
    if (parts.length === 0) parts.push("Details updated");
    const stockNote = state === "requested" || state === "label_ready" ? " It is still in your wardrobe until it physically leaves" : "";

    const notes = json<{ at: string; note: string; sourceRef?: string }[]>(row.notes_json, []);
    if (p.note) notes.push({ at: ctx.now, note: p.note });
    if (p.refundReceivedMinor !== undefined) notes.push({ at: ctx.now, note: `refund ${p.refundReceivedMinor}`, ...(p.refundSourceRef ? { sourceRef: p.refundSourceRef } : {}) });

    const statements: Stmt[] = [
      stmt(
        `UPDATE return_cases SET version = version + 1, state = ?, terms_json = ?, trigger_date = ?, deadline_status = ?, deadline_at = ?, deadline_local_date = ?, deadline_concerns = ?, deadline_reason = ?,
           next_action = ?, label_ref = ?, collection_preference = ?, shipment_ref = ?, retailer_received_on = ?, refund_expected_minor = ?, refund_received_minor = ?, currency = ?, notes_json = ?, updated_at = ?
         WHERE user_id = ? AND case_id = ?`,
        state, terms ? JSON.stringify(terms) : null, triggerDate, deadline.status, deadline.at, deadline.localDate, deadline.concerns, deadline.reason,
        p.nextAction === undefined ? (row as any).next_action : p.nextAction,
        p.labelRef === undefined ? (row as any).label_ref : p.labelRef,
        p.collectionPreference === undefined ? (row as any).collection_preference : p.collectionPreference,
        p.shipmentRef === undefined ? (row as any).shipment_ref : p.shipmentRef,
        p.retailerReceivedOn ?? (row as any).retailer_received_on,
        expected, received, currency, JSON.stringify(notes), ctx.now, ctx.userId, p.caseId,
      ),
    ];
    // A changed deadline supersedes reminders computed for the old one; a finished case needs none.
    const finished = ["refunded", "exchanged", "closed", "cancelled", "posted", "retailer_received"].includes(state) && (deadline.concerns !== "retailer_receipt" || state !== "posted");
    if (finished || deadline.at !== row.deadline_at) {
      statements.push(stmt("UPDATE effects SET state = 'cancelled', updated_at = ? WHERE user_id = ? AND kind = 'notification.return_reminder' AND target_key = ? AND state = 'pending'", ctx.now, ctx.userId, `return:${p.caseId}`));
    }
    const effects = finished ? [] : await newEffects(ctx, reminderEffects(ctx, p.caseId, deadline, label));
    return {
      summary: `${named(label)}: ${parts.join(". ")}.${stockNote}`,
      statements,
      preconditions: [{ label: `return ${p.caseId} unchanged since read`, sql: "(SELECT version FROM return_cases WHERE user_id = ? AND case_id = ?) = ?", params: [ctx.userId, p.caseId, row.version], class: "internal" }],
      affected: [{ kind: "return_case", id: p.caseId, version: row.version + 1 }],
      effects,
      result: { caseId: p.caseId, state, deadline, refund: { expectedMinor: expected, receivedMinor: received, state: refundStateOf(expected, received) } },
      undo: NO_UNDO("update the return again to correct it"),
    };
  },
});

/** An exchange links the outgoing and incoming variants; the incoming line is not a second ownership. */
export const returnLinkExchange = define({
  type: "return.link_exchange",
  schema: C["return.link_exchange"],
  class: "edit",
  requiredScope: "write",
  async plan(ctx, p) {
    const row = await first<CaseRow>(ctx.db, "SELECT * FROM return_cases WHERE user_id = ? AND case_id = ?", ctx.userId, p.caseId);
    if (!row) throw new CommandError("not_found", `no return '${p.caseId}'; nothing was written`);
    if (row.kind !== "exchange") throw new CommandError("precondition_failed", "only an exchange has an incoming variant");
    const line = await first<{ product_name: string; size: string | null; garment_id: string | null }>(ctx.db, "SELECT product_name, size, garment_id FROM order_lines WHERE user_id = ? AND order_id = ? AND line_id = ?", ctx.userId, p.incomingOrderId, p.incomingLineId);
    if (!line) throw new CommandError("not_found", "the incoming order line is not recorded; nothing was written");
    if (line.garment_id && line.garment_id === row.garment_id) throw new CommandError("conflict", "the incoming variant must be its own incoming record, not the garment being sent back");
    const statements: Stmt[] = [
      stmt("UPDATE return_cases SET version = version + 1, exchange_order_id = ?, exchange_line_id = ?, updated_at = ? WHERE user_id = ? AND case_id = ?", p.incomingOrderId, p.incomingLineId, ctx.now, ctx.userId, p.caseId),
    ];
    if (row.order_id && row.line_id) {
      statements.push(stmt("UPDATE order_lines SET replaces_order_id = ?, replaces_line_id = ? WHERE user_id = ? AND order_id = ? AND line_id = ?", row.order_id, row.line_id, ctx.userId, p.incomingOrderId, p.incomingLineId));
    }
    return {
      summary: `Exchange linked: ${named(line.product_name)}${line.size ? ` (${line.size})` : ""} is the incoming replacement. It counts as owned only once it arrives, and the outgoing piece until it leaves`,
      statements,
      affected: [{ kind: "return_case", id: p.caseId, version: row.version + 1 }],
      result: { caseId: p.caseId, incomingOrderId: p.incomingOrderId, incomingLineId: p.incomingLineId },
      undo: NO_UNDO("link again to correct it"),
    };
  },
});

export const returnHandlers = [returnOpenCase, returnUpdateCase, returnLinkExchange];
