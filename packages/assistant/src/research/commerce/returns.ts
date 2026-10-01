// Return and exchange deadlines. A deadline is established only from sourced
// purchase terms plus the real date of the event those terms count from;
// everything else is unresolved research, never a speculative countdown.

export type ReturnTriggerEvent = "delivery" | "purchase" | "dispatch";
export type ReturnConcern = "request" | "post" | "retailer_receipt";

export interface ReturnTerms {
  windowDays: number;
  /** What must happen by the deadline: requesting, posting, or the retailer receiving the parcel. */
  concerns: ReturnConcern;
  triggerEvent: ReturnTriggerEvent;
  /** Where these terms were read (order email, order page). Empty means unsourced. */
  sourceRef: string;
  checkedOn: string;
}
export interface ReturnTrigger { event: ReturnTriggerEvent; /** YYYY-MM-DD in the deadline's timezone. */ date: string }

export type ReturnDeadline =
  | { status: "established"; deadlineLocalDate: string; deadlineAt: string; timezone: string; concerns: ReturnConcern }
  | { status: "unresolved"; reason: string };

export const UNRESOLVED_REASONS = {
  noTerms: "No return terms are recorded for this order line.",
  unsourcedTerms: "The return terms have no source; a generic shop policy does not establish a deadline.",
  invalidTerms: "The recorded return window is not a whole number of days.",
  missingTrigger: "The date of the event the return window counts from is not known.",
  triggerMismatch: "The known date is for a different event than the one the return window counts from.",
  invalidDate: "The trigger date is not a valid calendar date (YYYY-MM-DD).",
  invalidTimezone: "The timezone is not a valid IANA timezone.",
} as const;

const DAY_MS = 86_400_000;

function parseLocalDate(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const check = new Date(ms);
  // Rejects dates such as 2025-02-30 that Date.UTC would roll over.
  return check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d ? ms : null;
}

/** Offset (local wall time minus UTC, in ms) of `timezone` at the instant `utcMs`. */
function zoneOffsetMs(utcMs: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return wall - Math.floor(utcMs / 1000) * 1000;
}

/**
 * UTC instant at which the civil day `localMidnightAsUtcMs` (a date expressed
 * as UTC midnight) starts in `timezone`. Correct across DST changes because
 * the offset is re-read at the candidate instant.
 */
export function startOfLocalDayUtcMs(localMidnightAsUtcMs: number, timezone: string): number {
  const first = localMidnightAsUtcMs - zoneOffsetMs(localMidnightAsUtcMs, timezone);
  return localMidnightAsUtcMs - zoneOffsetMs(first, timezone);
}

export function computeReturnDeadline(input: {
  terms: ReturnTerms | null;
  trigger: ReturnTrigger | null;
  timezone: string;
}): ReturnDeadline {
  const { terms, trigger, timezone } = input;
  const unresolved = (reason: string): ReturnDeadline => ({ status: "unresolved", reason });
  if (!terms) return unresolved(UNRESOLVED_REASONS.noTerms);
  if (terms.sourceRef.trim() === "") return unresolved(UNRESOLVED_REASONS.unsourcedTerms);
  if (!Number.isInteger(terms.windowDays) || terms.windowDays < 0) return unresolved(UNRESOLVED_REASONS.invalidTerms);
  if (!trigger || trigger.date.trim() === "") return unresolved(UNRESOLVED_REASONS.missingTrigger);
  if (trigger.event !== terms.triggerEvent) return unresolved(UNRESOLVED_REASONS.triggerMismatch);
  const triggerMs = parseLocalDate(trigger.date);
  if (triggerMs === null) return unresolved(UNRESOLVED_REASONS.invalidDate);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    return unresolved(UNRESOLVED_REASONS.invalidTimezone);
  }
  const deadlineDayMs = triggerMs + terms.windowDays * DAY_MS;
  // The deadline day is included in full: it ends where the next civil day starts.
  const deadlineAtMs = startOfLocalDayUtcMs(deadlineDayMs + DAY_MS, timezone);
  return {
    status: "established",
    deadlineLocalDate: new Date(deadlineDayMs).toISOString().slice(0, 10),
    deadlineAt: new Date(deadlineAtMs).toISOString(),
    timezone,
    concerns: terms.concerns,
  };
}

export interface ReturnReminder { dueAt: string; daysBefore: number; dedupeKey: string }

/** DEFAULT reminder offsets (days before an established deadline); overridable per call. */
export const DEFAULT_REMINDER_DAYS_BEFORE: readonly number[] = [7, 2];

/**
 * Reminders for an ESTABLISHED deadline only (pass `deadlineAt` from
 * `computeReturnDeadline`). Reminders whose time has already passed are
 * skipped. The dedupe key is the same for app and calendar, so a reminder is
 * delivered once however many times the schedule is recomputed.
 */
export function reminderSchedule(input: {
  caseId: string;
  deadlineAt: string;
  daysBefore?: readonly number[];
  nowMs: number;
}): ReturnReminder[] {
  const deadlineMs = Date.parse(input.deadlineAt);
  if (Number.isNaN(deadlineMs)) return [];
  const days = [...new Set(input.daysBefore ?? DEFAULT_REMINDER_DAYS_BEFORE)].filter((d) => Number.isFinite(d) && d >= 0);
  return days
    .sort((a, b) => b - a)
    .map((d) => ({ dueMs: deadlineMs - d * DAY_MS, d }))
    .filter(({ dueMs }) => dueMs >= input.nowMs)
    .map(({ dueMs, d }) => ({
      dueAt: new Date(dueMs).toISOString(),
      daysBefore: d,
      dedupeKey: `return:${input.caseId}:${input.deadlineAt}:${d}`,
    }));
}

export type RefundState = "none" | "partial" | "full" | "over";

/**
 * Compares money received with the refund expected, in minor units. When the
 * expected amount is unknown (`null`), money received can only be `partial`:
 * a refund is never called full without knowing what was owed.
 */
export function refundState(expectedMinor: number | null, receivedMinor: number): RefundState {
  if (receivedMinor <= 0) return "none";
  if (expectedMinor === null) return "partial";
  if (receivedMinor < expectedMinor) return "partial";
  return receivedMinor === expectedMinor ? "full" : "over";
}
