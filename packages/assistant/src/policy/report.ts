/**
 * The owner's own wear and wash REPORTS, read by trusted code.
 *
 * A wear or wash report is the one kind of change recorded without the owner's tap, so what is recorded
 * must be what the owner reported, not what a model made of the message. The third review showed that
 * "the garment's words appear in a sentence that is not a question" is not that: a compromised model
 * recorded wear on "The Clifford boot is the best thing I own." This module therefore ties the three
 * things a report consists of to one clause of the owner's own voice:
 *
 *   - the KIND: the clause itself has the form of a first-person report of that kind ("I wore ...",
 *     "Wearing ...", "Had ... on", "... is in the wash", "Washed ..."). A clause that merely mentions a
 *     piece is no report;
 *   - the DATE of a wear report: derived here from the sentence ("today" when it gives none, "yesterday",
 *     a weekday of the past week, "three days ago", a written date). A sentence whose date this code
 *     cannot fix to one day in the report window gives no date, and nothing is recorded without a tap;
 *   - the GARMENTS: the pieces named in that clause (policy/naming.ts), plus the pieces the owner attached
 *     to the message when the clause points at them ("wore this today").
 *
 * The model's tool call is then only a selection: a command is recorded without a tap when its kind, its
 * date and every one of its garments are covered by such a report, and becomes a request for the owner
 * to confirm otherwise. Failing here never refuses anything. Groups ("all my socks"), wear corrections
 * and comfort notes are never recorded without a tap.
 */
import type { Db } from "@garderobe/domain";
import { loadWardrobeWords, namedInText, type GarmentWords } from "./naming.ts";
import { isDirectReport, normalizeText, ownerAuthoredText, sentencesOf } from "./voice.ts";

/** A wear report is taken without a tap for today and this many days back; anything older waits for the owner. */
export const REPORT_WINDOW_DAYS = 7;

function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Whether `wearingDate` is the owner's `ownerLocalDate` or one of the seven days before it. */
export function withinReportWindow(wearingDate: string, ownerLocalDate: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(wearingDate) || !/^\d{4}-\d{2}-\d{2}$/.test(ownerLocalDate)) return false;
  if (Number.isNaN(Date.parse(`${wearingDate}T00:00:00Z`)) || new Date(`${wearingDate}T00:00:00Z`).toISOString().slice(0, 10) !== wearingDate) return false;
  const age = dayNumber(ownerLocalDate) - dayNumber(wearingDate);
  return age >= 0 && age <= REPORT_WINDOW_DAYS;
}

export type ReportKind = "wear" | "dirty" | "washed";

export interface OwnerReport {
  kind: ReportKind;
  /** The owner's clause this report was read from. */
  clause: string;
  /** The wearing date of a wear report, fixed by trusted code. Null for dirty and washed reports. */
  date: string | null;
  /** Garments the owner named in the clause, with the words that named them. */
  garments: Map<string, string[]>;
  /** True when the clause points at what the owner attached ("this", "these", "it", "them"). */
  pointsAtAttachment: boolean;
}

/** Words that open a clause without changing what it says. */
const LEAD_IN = /^(?:(?:also|and|then|so|ok|okay|oh|well|fyi|btw|update|note|today|yesterday|this morning|this afternoon|this evening|last night|tonight|earlier|just now|please)[,:]?\s+)+/;

const WEAR_FORMS: RegExp[] = [
  /^(?:i|we)\s+(?:just\s+|also\s+)?(?:wore|put on|threw on|went with|have on|have worn|am wearing|was wearing|ended up wearing|have been wearing)\b/,
  /^i'm\s+wearing\b/,
  /^i've\s+(?:got on|worn|been wearing)\b/,
  /^(?:wore|threw on|put on|went with)\b/,
  // "Wearing the Stratton cords and the olive belt." - but not "Wearing the boot is a pain", where the
  // wearing is the subject of something else.
  /^wearing\b(?!.*\b(?:is|are|was|were|be|feels?|felt|seems?|seemed|makes?|made|gives?|gave|hurts?|means?|meant)\b)/,
  // "(I) had the Chasseur on (yesterday)": the "on" closes the clause, apart from a time.
  /^(?:(?:i|we)\s+)?had\s+.+\s+on(?:\s+(?:today|yesterday|this morning|this afternoon|this evening|last night|tonight|all day|earlier|on\s+\w+day|last\s+\w+day))?[.!]?$/,
  /^(?:today's|yesterday's|tonight's|this morning's)\s+outfit\s*(?:is|was|:)/,
  /^(?:log|record)\s+(?:today|yesterday|tonight|this morning|last night)\s+as\b/,
  /^(?:log|record)\s+(?:that\s+)?i\s+(?:wore|am wearing|was wearing)\b/,
];

const DIRTY_FORMS: RegExp[] = [
  // A spill: "got curry down the white oxford", "spilled coffee on the navy chinos".
  /^(?:(?:i|we)\s+)?(?:just\s+)?got\s+.+\s+(?:down|all\s+over|all\s+down)\s+/,
  /^(?:(?:i|we)\s+)?(?:just\s+)?(?:spilled|spilt|splashed|slopped)\s+.+\s+(?:down|on|over|onto)\s+/,
  /^(?:(?:i|we)\s+)?(?:just\s+)?(?:put|threw|chucked|tossed|dropped)\s+.+\s+in(?:to)?\s+the\s+(?:wash|hamper|laundry)\b/,
  /\b(?:is|are|'s)\s+(?:now\s+|all\s+|both\s+)?(?:dirty|filthy|in\s+the\s+(?:wash|hamper|laundry(?:\s+(?:bag|basket))?))[.!]?$/,
  /\bneeds?\s+(?:a\s+wash|washing|a\s+clean|cleaning|laundering|to\s+go\s+in(?:to)?\s+the\s+(?:wash|hamper|laundry))\b/,
];

const WASHED_FORMS: RegExp[] = [
  /^(?:(?:i|we)\s+)?(?:just\s+|have\s+)?(?:hand[- ]?)?(?:washed|laundered)\b/,
  /^(?:i've|we've)\s+(?:just\s+)?(?:hand[- ]?)?(?:washed|laundered)\b/,
  /\b(?:is|are|has\s+been|have\s+been|'s)\s+(?:now\s+|all\s+|both\s+)?(?:washed|laundered|clean\s+again|back\s+from\s+the\s+wash)[.!]?$/,
];

const FORMS: [ReportKind, RegExp[]][] = [["wear", WEAR_FORMS], ["dirty", DIRTY_FORMS], ["washed", WASHED_FORMS]];

/** A word pointing at something shown rather than named. "This morning" points at nothing. */
const POINTER = /\b(?:(?:this|these|those)(?!\s+(?:morning|afternoon|evening|week|weekend|time|once)\b)|it|them|both)\b/;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, a: 1 };
/** Date-like wording this code does not resolve: its presence means the date is not fixed here. */
const UNRESOLVED_DATE = /\b(?:last\s+(?:week|month|year|weekend|time)|the\s+other\s+(?:day|night)|at\s+the\s+weekend|over\s+the\s+weekend|this\s+week|all\s+week|every\s+day|each\s+day|daily|always|usually|often|sometimes|recently|lately|once|ages\s+ago|weeks?\s+ago|months?\s+ago|years?\s+ago|the\s+day\s+before|january|february|march|april|june|july|august|september|october|november|december|\d{1,2}(?:st|nd|rd|th)|\d{1,2}[/.]\d{1,2}|(?:19|20)\d{2}(?!-\d{2}-\d{2})|used\s+to|back\s+(?:in|when)|when\s+(?:i|we)|at\s+(?:my|our)\s+\w+|to\s+(?:my|the|our)\s+(?:wedding|funeral|party|interview|graduation|christening))\b/;

/**
 * The one wearing date a sentence gives, as trusted code reads it; today when it gives none; null when it
 * gives more than one, one this code does not resolve, or one outside the report window.
 */
export function reportDateOf(sentence: string, localDate: string): string | null {
  const s = normalizeText(sentence);
  const found = new Set<string>();
  if (/\b(?:today|today's|this\s+(?:morning|afternoon|evening)|tonight|tonight's|right\s+now|all\s+day|now)\b/.test(s)) found.add(localDate);
  if (/\b(?:yesterday|yesterday's|last\s+night)\b/.test(s)) found.add(shiftDate(localDate, -1));
  for (const m of s.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) found.add(m[1]!);
  for (const m of s.matchAll(/\b(\S+)\s+days?\s+ago\b/g)) {
    const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : NUMBER_WORDS[m[1]!];
    // "Eight days ago", "a few days ago": not a day this code can fix.
    if (n === undefined) return null;
    found.add(shiftDate(localDate, -n));
  }
  const today = new Date(`${localDate}T00:00:00Z`).getUTCDay();
  for (const m of s.matchAll(/\b(?:(on|last)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g)) {
    const back = (today - WEEKDAYS.indexOf(m[2]!) + 7) % 7;
    // The same weekday as today could mean today or a week ago: not fixed here.
    if (back === 0) return null;
    found.add(shiftDate(localDate, -back));
  }
  if (UNRESOLVED_DATE.test(s)) return null;
  if (found.size === 0) return localDate;
  if (found.size > 1) return null;
  const [date] = [...found];
  return withinReportWindow(date!, localDate) ? date! : null;
}

/** Where a sentence may be cut into clauses: before a conjunction that opens a new subject or report. */
const CLAUSE_BREAK = /\s*[,;]?\s+(?:and|but|then|while)\s+(?=(?:i|we|i'm|i've|the|my|both|these|those)\b)|\s*[;]\s+|\s+-\s+/g;

function kindsOf(clause: string): ReportKind[] {
  const c = normalizeText(clause).replace(LEAD_IN, "");
  return FORMS.filter(([, forms]) => forms.some((f) => f.test(c))).map(([kind]) => kind);
}

/**
 * The clauses of a sentence. A sentence is cut at a conjunction only when the part before it is itself a
 * report ("I wore the oxford and the 990s are dirty"); otherwise it stays whole ("The oxford and the
 * chinos are dirty", "I wore the oxford and the navy chinos").
 */
function clausesOf(sentence: string): string[] {
  for (const m of sentence.matchAll(CLAUSE_BREAK)) {
    const left = sentence.slice(0, m.index);
    const right = sentence.slice(m.index + m[0].length);
    if (kindsOf(left).length > 0 && kindsOf(right).length > 0) return [left, ...clausesOf(right)];
  }
  return [sentence];
}

/** The reports in the owner's own text of this turn (never an attachment's text, never relayed passages). */
export function reportsIn(wardrobe: GarmentWords[], ownerTexts: string[], localDate: string): OwnerReport[] {
  const out: OwnerReport[] = [];
  for (const text of ownerTexts) {
    for (const sentence of sentencesOf(ownerAuthoredText(text))) {
      // A question, a negation, a plan, a hypothetical or a sentence about somebody else reports nothing.
      if (!isDirectReport(sentence)) continue;
      const date = reportDateOf(sentence, localDate);
      for (const clause of clausesOf(sentence)) {
        const kinds = kindsOf(clause);
        // A clause that reads as two kinds at once ("washed and wore") is not tied to either.
        if (kinds.length !== 1) continue;
        const kind = kinds[0]!;
        if (kind === "wear" && date === null) continue;
        out.push({ kind, clause, date: kind === "wear" ? date : null, garments: namedInText(wardrobe, clause), pointsAtAttachment: POINTER.test(normalizeText(clause)) });
      }
    }
  }
  return out;
}

export async function resolveOwnerReports(db: Db, userId: string, ownerTexts: string[], localDate: string): Promise<OwnerReport[]> {
  if (ownerTexts.every((t) => !t.trim())) return [];
  return reportsIn(await loadWardrobeWords(db, userId), ownerTexts, localDate);
}

/** The garment IDs among a message's attached references (`garment:<id>` as the Worker sends them, or a bare ID). */
export function attachedGarmentIds(attachedRefs: string[]): string[] {
  return attachedRefs.map((ref) => (ref.startsWith("garment:") ? ref.slice("garment:".length) : ref.includes(":") ? "" : ref)).filter(Boolean);
}

export interface ReportCover {
  garmentId: string;
  basis: "named_by_owner" | "attached_by_owner";
  matched: string[];
  clause: string;
}

/**
 * Whether reports of `kind` (and, for wear, of exactly `date`) cover every one of `garmentIds`: each must
 * be named in such a clause, or attached to the message while such a clause points at the attachment.
 * Returns the provenance of each garment, or null when any is not covered.
 */
export function coverOf(reports: OwnerReport[], kind: ReportKind, date: string | null, garmentIds: string[], attached: string[]): ReportCover[] | null {
  const fitting = reports.filter((r) => r.kind === kind && (kind !== "wear" || r.date === date));
  if (fitting.length === 0 || garmentIds.length === 0) return null;
  const cover: ReportCover[] = [];
  for (const garmentId of new Set(garmentIds)) {
    const naming = fitting.find((r) => r.garments.has(garmentId));
    const pointing = fitting.find((r) => r.pointsAtAttachment && attached.includes(garmentId));
    if (naming) cover.push({ garmentId, basis: "named_by_owner", matched: naming.garments.get(garmentId)!, clause: naming.clause });
    else if (pointing) cover.push({ garmentId, basis: "attached_by_owner", matched: [], clause: pointing.clause });
    else return null;
  }
  return cover;
}
