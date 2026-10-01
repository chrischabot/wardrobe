/** Temporal phrase resolution for recall, in the owner's timezone, relative to the conversation date. */
import { addDays, localDateOf } from "@garderobe/domain";

export interface ResolvedRange {
  from: string;
  to: string;
  basis: string;
  /** Set when the phrase could reasonably mean another range; surfaced rather than silently fixed. */
  ambiguity: string | null;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const SEASONS: Record<string, [number, number]> = { spring: [3, 5], summer: [6, 8], autumn: [9, 11], fall: [9, 11] };

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}
function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
function monthRange(year: number, month: number): { from: string; to: string } {
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(lastDay(year, month))}` };
}

export function resolveDateRange(text: string, nowMs: number, timezone: string): ResolvedRange | null {
  const today = localDateOf(nowMs, timezone);
  const [y, m] = today.split("-").map(Number) as [number, number, number];
  const t = text.toLowerCase();

  if (/\byesterday\b/.test(t)) return { from: addDays(today, -1), to: addDays(today, -1), basis: "yesterday", ambiguity: null };
  if (/\blast week\b/.test(t)) return { from: addDays(today, -13), to: addDays(today, -1), basis: "the last two calendar weeks up to yesterday (\"last week\")", ambiguity: null };
  if (/\blast month\b/.test(t)) {
    const pm = m === 1 ? 12 : m - 1;
    const py = m === 1 ? y - 1 : y;
    return { ...monthRange(py, pm), basis: `last month (${MONTHS[pm - 1]} ${py})`, ambiguity: null };
  }
  if (/\blast year\b/.test(t)) return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31`, basis: `last year (${y - 1})`, ambiguity: null };
  if (/\bthis year\b/.test(t)) return { from: `${y}-01-01`, to: today, basis: `this year (${y})`, ambiguity: null };
  const ago = t.match(/\b(\d{1,2}|a|one|two|three|four|five|six) (day|week|month|year)s? ago\b/);
  if (ago) {
    const words: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
    const n = words[ago[1]!] ?? Number(ago[1]);
    const days = { day: 1, week: 7, month: 30, year: 365 }[ago[2] as "day" | "week" | "month" | "year"] * n;
    const span = ago[2] === "day" ? 0 : ago[2] === "week" ? 4 : ago[2] === "month" ? 16 : 45;
    return { from: addDays(today, -days - span), to: addDays(today, -days + span), basis: `about ${ago[0]}`, ambiguity: null };
  }

  for (let i = 0; i < 12; i++) {
    const name = MONTHS[i]!;
    const re = new RegExp(`\\b(?:(last|this|in|during|back in)\\s+)?${name}(?:\\s+(\\d{4}))?\\b`);
    const hit = t.match(re);
    if (!hit) continue;
    if (name === "may" && !hit[1] && !hit[2]) continue; // the verb "may"
    const month = i + 1;
    if (hit[2]) return { ...monthRange(Number(hit[2]), month), basis: `${name} ${hit[2]}`, ambiguity: null };
    if (month < m) return { ...monthRange(y, month), basis: `${name} ${y}, the most recent ${name} before this conversation (${today})`, ambiguity: null };
    if (month === m) {
      return { ...monthRange(y - 1, month), basis: `${name} ${y - 1}`, ambiguity: `"${hit[0]}" could mean ${name} ${y - 1} or the current month (${name} ${y}); ${name} ${y - 1} was searched` };
    }
    return { ...monthRange(y - 1, month), basis: `${name} ${y - 1}, the most recent ${name} before this conversation (${today})`, ambiguity: null };
  }

  for (const [season, [a, b]] of Object.entries(SEASONS)) {
    if (!new RegExp(`\\b(last|this)\\s+${season}\\b`).test(t)) continue;
    const year = b < m ? y : y - 1;
    const within = m >= a && m <= b;
    return {
      from: `${year}-${pad(a)}-01`,
      to: `${year}-${pad(b)}-${pad(lastDay(year, b))}`,
      basis: `${season} ${year}`,
      ambiguity: within ? `it is currently ${season}; "last ${season}" was read as ${season} ${year}` : null,
    };
  }
  if (/\b(last|this) winter\b/.test(t)) {
    const year = m <= 2 ? y - 1 : y;
    return { from: `${year - 1}-12-01`, to: `${year}-02-${pad(lastDay(year, 2))}`, basis: `winter ${year - 1}/${year}`, ambiguity: null };
  }
  const yearOnly = t.match(/\bin (20\d{2})\b/);
  if (yearOnly) return { from: `${yearOnly[1]}-01-01`, to: `${yearOnly[1]}-12-31`, basis: `the year ${yearOnly[1]}`, ambiguity: null };
  return null;
}
