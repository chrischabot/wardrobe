import { addDays, localDateOf, zonedInstant } from '../domain/time.js';

/**
 * Return and exchange deadline arithmetic (spec section 10). A delivery-based window counts from the
 * recorded arrival of the order line (order_lines.arrived_at), never from a predicted delivery.
 * Recording an arrival recalculates open delivery-based deadlines of that line inside the arrival's
 * own command, so the change has a receipt and is undone with it.
 *
 * Kept free of command-handler imports so the domain's markArrived can call it without a cycle.
 */

export interface DeadlineRestore {
  deadlineId: string;
  deadlineAt: string;
  termsSource: string;
}

export interface RecalculatedDeadline {
  deadlineId: string;
  lineId: string;
  kind: string;
  fromDate: string;
  toDate: string;
  deadlineAt: string;
}

export function computeDeadline(triggerDate: string, windowDays: number, timezone: string, now: string): { deadlineDate: string; deadlineAt: string; reminderDates: string[] } {
  const deadlineDate = addDays(triggerDate, windowDays);
  return {
    deadlineDate,
    deadlineAt: zonedInstant(deadlineDate, '23:59', timezone),
    reminderDates: [7, 2].map((d) => addDays(deadlineDate, -d)).filter((d) => d >= now.slice(0, 10)),
  };
}

/** Local date of a line's recorded arrival, or null when none is recorded with a time. */
export function arrivalDate(arrivedAt: string | null, timezone: string): string | null {
  return arrivedAt ? localDateOf(arrivedAt, timezone) : null;
}

interface DeadlineRow {
  deadline_id: string;
  line_id: string;
  kind: string;
  deadline_at: string;
  timezone: string;
  terms_source: string;
}

/**
 * Statements that move each open delivery-based deadline of `lineIds` to count from `arrivedAt`.
 * Returns the restore data for undo and what changed for the receipt.
 */
export async function planArrivalRecalculation(
  db: D1Database,
  userId: string,
  lineIds: string[],
  arrivedAt: string,
  commandId: string,
  now: string,
): Promise<{ statements: D1PreparedStatement[]; restore: DeadlineRestore[]; recalculated: RecalculatedDeadline[] }> {
  const out = { statements: [] as D1PreparedStatement[], restore: [] as DeadlineRestore[], recalculated: [] as RecalculatedDeadline[] };
  if (!lineIds.length) return out;
  const { results } = await db
    .prepare(
      `SELECT deadline_id, line_id, kind, deadline_at, timezone, terms_source FROM return_deadlines
       WHERE user_id = ? AND status = 'open' AND line_id IN (${lineIds.map(() => '?').join(',')})
         AND json_extract(terms_source, '$.trigger.event') = 'delivery'`,
    )
    .bind(userId, ...lineIds)
    .all<DeadlineRow>();
  for (const d of results) {
    const terms = JSON.parse(d.terms_source) as { windowDays: number; trigger: { event: string; date: string; evidence: string }; recalculations?: unknown[] } & Record<string, unknown>;
    const toDate = localDateOf(arrivedAt, d.timezone);
    if (terms.trigger.date === toDate) continue;
    const next = computeDeadline(toDate, terms.windowDays, d.timezone, now);
    const updated = {
      ...terms,
      trigger: { event: 'delivery', date: toDate, evidence: `recorded arrival (command ${commandId})` },
      recalculations: [...(terms.recalculations ?? []), { fromDate: terms.trigger.date, toDate, at: now, commandId }],
    };
    out.statements.push(db.prepare('UPDATE return_deadlines SET deadline_at = ?, terms_source = ? WHERE user_id = ? AND deadline_id = ?').bind(next.deadlineAt, JSON.stringify(updated), userId, d.deadline_id));
    out.restore.push({ deadlineId: d.deadline_id, deadlineAt: d.deadline_at, termsSource: d.terms_source });
    out.recalculated.push({ deadlineId: d.deadline_id, lineId: d.line_id, kind: d.kind, fromDate: terms.trigger.date, toDate, deadlineAt: next.deadlineAt });
  }
  return out;
}
