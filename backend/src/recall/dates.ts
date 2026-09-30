import { addDays, localDateOf } from '../domain/time.js';

/**
 * Resolve a temporal expression in a recall question to a stated local date range, using the owner's
 * timezone and the conversation date (spec section 6: "What shoes did I like so much last July?").
 * A September 2026 question about "last July" means July 2026. A materially ambiguous expression is
 * returned with `ambiguous` so the answer surfaces it instead of silently fixing it.
 */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export interface DateRange {
  from: string;
  to: string;
  expression: string;
  ambiguous: string | null;
}

function lastDayOfMonth(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month + 1, 0));
  return d.toISOString().slice(0, 10);
}

function monthRange(year: number, month: number): { from: string; to: string } {
  return { from: `${year}-${String(month + 1).padStart(2, '0')}-01`, to: lastDayOfMonth(year, month) };
}

export function resolveDateRange(text: string, nowIso: string, timezone: string): DateRange | null {
  const q = text.toLowerCase();
  const today = localDateOf(nowIso, timezone);
  const [y, m] = today.split('-').map(Number) as [number, number];
  const month0 = m - 1;

  if (/\byesterday\b/.test(q)) return { from: addDays(today, -1), to: addDays(today, -1), expression: 'yesterday', ambiguous: null };
  if (/\blast week\b/.test(q)) return { from: addDays(today, -13), to: addDays(today, -7), expression: 'last week', ambiguous: null };
  if (/\bthis week\b/.test(q)) return { from: addDays(today, -6), to: today, expression: 'this week', ambiguous: null };
  if (/\blast month\b/.test(q)) {
    const lm = month0 === 0 ? { y: y - 1, m: 11 } : { y, m: month0 - 1 };
    return { ...monthRange(lm.y, lm.m), expression: 'last month', ambiguous: null };
  }
  if (/\blast year\b/.test(q)) return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31`, expression: 'last year', ambiguous: null };
  const explicitYear = q.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(20\d\d)\b/);
  if (explicitYear) {
    const mi = MONTHS.indexOf(explicitYear[1]!);
    return { ...monthRange(Number(explicitYear[2]), mi), expression: explicitYear[0], ambiguous: null };
  }
  const monthMatch = q.match(/\b(last|this|in|during|back in)?\s*(january|february|march|april|may|june|july|august|september|october|november|december)\b/);
  if (monthMatch) {
    const mi = MONTHS.indexOf(monthMatch[2]!);
    const qualifier = monthMatch[1] ?? '';
    if (mi < month0) return { ...monthRange(y, mi), expression: monthMatch[0].trim(), ambiguous: null };
    if (mi > month0) return { ...monthRange(y - 1, mi), expression: monthMatch[0].trim(), ambiguous: null };
    // Same month as today: "this July" is now; "last July" is a year ago; bare "July" is ambiguous.
    if (qualifier === 'this') return { from: monthRange(y, mi).from, to: today, expression: monthMatch[0].trim(), ambiguous: null };
    if (qualifier === 'last') return { ...monthRange(y - 1, mi), expression: monthMatch[0].trim(), ambiguous: null };
    return { ...monthRange(y - 1, mi), expression: monthMatch[0].trim(), ambiguous: `"${monthMatch[2]}" could mean this month or ${monthMatch[2]} ${y - 1}; searched ${y - 1}` };
  }
  return null;
}

/** UTC instants bounding a local date range (inclusive). */
export function rangeInstants(range: { from: string; to: string }): { fromIso: string; toIso: string } {
  // Generous by one day on each side; exact local filtering happens on authored local dates.
  return { fromIso: `${addDays(range.from, -1)}T00:00:00.000Z`, toIso: `${addDays(range.to, 1)}T23:59:59.999Z` };
}
