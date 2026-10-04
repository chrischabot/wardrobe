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
import { ALL_CATEGORY_WORDS, NAMING_STOP, loadWardrobeWords, namedInText, sameToken, tokensOf, type GarmentWords } from "./naming.ts";
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
  /** True when that pointing word is singular ("this", "it"): it then covers an attachment only when exactly one piece is attached. */
  pointsAtOne?: boolean;
}

/** Words that open a clause without changing what it says. */
const LEAD_IN = /^(?:(?:also|and|then|so|ok|okay|oh|well|fyi|btw|update|note|today|yesterday|this morning|this afternoon|this evening|last night|tonight|earlier|just now|please)[,:]?\s+)+/;

/**
 * One way a report is worded, and the REST of the clause once that wording is taken away: the part that
 * must say nothing but which pieces and when (see `onlyPiecesAndTime`).
 */
interface Form {
  re: RegExp;
  rest(m: RegExpExecArray, clause: string): string;
}
const after = (m: RegExpExecArray, clause: string): string => clause.slice(m.index + m[0].length);
const before = (m: RegExpExecArray, clause: string): string => clause.slice(0, m.index);
const around = (m: RegExpExecArray, clause: string): string => `${before(m, clause)} ${after(m, clause)}`;
const inside = (m: RegExpExecArray, clause: string): string => `${m[1] ?? ""} ${m[2] ?? ""} ${after(m, clause)}`;

const WEAR_FORMS: Form[] = [
  { re: /^(?:i|we)\s+(?:just\s+|also\s+)?(?:wore|put on|threw on|went with|have on|have worn|am wearing|was wearing|ended up wearing|have been wearing)\b/, rest: after },
  { re: /^i'm\s+wearing\b/, rest: after },
  { re: /^i've\s+(?:got on|worn|been wearing)\b/, rest: after },
  { re: /^(?:wore|threw on|put on|went with)\b/, rest: after },
  // "Wearing the Stratton cords and the olive belt." - but not "Wearing the boot is a pain", where the
  // wearing is the subject of something else.
  { re: /^wearing\b(?!.*\b(?:is|are|was|were|be|feels?|felt|seems?|seemed|makes?|made|gives?|gave|hurts?|means?|meant)\b)/, rest: after },
  // "(I) had the Chasseur on (yesterday)": the "on" closes the clause, apart from a time.
  { re: /^(?:(?:i|we)\s+)?had\s+(.+)\s+on((?:\s+(?:today|yesterday|this morning|this afternoon|this evening|last night|tonight|all day|earlier|on\s+\w+day|last\s+\w+day))?)[.!]?$/, rest: inside },
  { re: /^(?:today's|yesterday's|tonight's|this morning's)\s+outfit\s*(?:is|was|:)/, rest: after },
  { re: /^(?:log|record)\s+(?:today|yesterday|tonight|this morning|last night)\s+as\b/, rest: after },
  { re: /^(?:log|record)\s+(?:that\s+)?i\s+(?:wore|am wearing|was wearing)\b/, rest: after },
];

/**
 * What was spilled, in a spill report: an optional "some" / "a bit of" and one or two plain words, none of
 * which says that nothing was ("spilled nothing on ..."), and no "and" / "or" / "but" that would let a
 * whole other statement stand there ("got lucky and kept the curry from going down ..."). It is part of
 * the report's wording, so it is bounded here rather than left as free text (change review, 2026-10-03).
 */
const NOT_NOTHING = "(?!(?:nothing|none|anything|zero|no|hardly|barely|and|or|but)\\b)";
const SPILT = `(?:(?:some|a|an|the|my|a\\s+bit\\s+of|a\\s+little|a\\s+lot\\s+of|loads\\s+of|half\\s+(?:a|my))\\s+)?${NOT_NOTHING}[a-z'-]+(?:\\s+${NOT_NOTHING}[a-z'-]+)?`;

const DIRTY_FORMS: Form[] = [
  // A spill: "got curry down the white oxford", "spilled coffee on the navy chinos".
  { re: new RegExp(`^(?:(?:i|we)\\s+)?(?:just\\s+)?got\\s+${SPILT}\\s+(?:down|all\\s+over|all\\s+down)\\s+`), rest: after },
  { re: new RegExp(`^(?:(?:i|we)\\s+)?(?:just\\s+)?(?:spilled|spilt|splashed|slopped)\\s+${SPILT}\\s+(?:down|on|over|onto|all\\s+over|all\\s+down)\\s+`), rest: after },
  { re: /^(?:(?:i|we)\s+)?(?:just\s+)?(?:put|threw|chucked|tossed|dropped)\s+(.+)\s+in(?:to)?\s+the\s+(?:wash|hamper|laundry)\b/, rest: inside },
  // "The navy oxford is in the wash": what stands before the verb must be the piece and nothing else, so
  // "I wonder whether the oxford is dirty" is no report (adversarial finding I05-3).
  { re: /\b(?:is|are|'s)\s+(?:now\s+|all\s+|both\s+)?(?:dirty|filthy|in\s+the\s+(?:wash|hamper|laundry(?:\s+(?:bag|basket))?))[.!]?$/, rest: before },
  { re: /\bneeds?\s+(?:a\s+wash|washing|a\s+clean|cleaning|laundering|to\s+go\s+in(?:to)?\s+the\s+(?:wash|hamper|laundry))\b/, rest: around },
];

const WASHED_FORMS: Form[] = [
  { re: /^(?:(?:i|we)\s+)?(?:just\s+|have\s+)?(?:hand[- ]?)?(?:washed|laundered)\b/, rest: after },
  { re: /^(?:i've|we've)\s+(?:just\s+)?(?:hand[- ]?)?(?:washed|laundered)\b/, rest: after },
  { re: /\b(?:is|are|has\s+been|have\s+been|'s)\s+(?:now\s+|all\s+|both\s+)?(?:washed|laundered|clean\s+again|back\s+from\s+the\s+wash)[.!]?$/, rest: before },
];

const FORMS: [ReportKind, Form[]][] = [["wear", WEAR_FORMS], ["dirty", DIRTY_FORMS], ["washed", WASHED_FORMS]];

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * A word pointing at something shown rather than named: "this", "these", "those", "it", "them", "both".
 * "This morning" or "this Friday" points at nothing. A clause points at what the owner attached only when
 * it names no piece itself: in "I wore this navy oxford today" the "this" is the oxford, and an unrelated
 * attached piece is not covered by it (change reviews, 2026-10-03). A piece attached alongside a named
 * one waits for the owner.
 */
const POINTER = new RegExp(`\\b(?:(?:this|these|those)(?!\\s+(?:morning|afternoon|evening|week|weekend|time|once|${WEEKDAYS.join("|")})\\b)|it|them|both)\\b`);

/** Wording for WHEN (and the everyday where that goes with it) that may stand in a report beside the pieces. */
const WHEN = new RegExp(
  `\\b(?:today|tonight|yesterday|right\\s+now|just\\s+now|now|earlier|already|this\\s+(?:morning|afternoon|evening)|last\\s+night|all\\s+day|(?:(?:on|last|this)\\s+)?(?:${WEEKDAYS.join("|")})|(?:\\d+|one|two|three|four|five|six|seven|a)\\s+days?\\s+ago|\\d{4}-\\d{2}-\\d{2}|(?:at|over|after|before)\\s+(?:lunch|breakfast|dinner|supper)|(?:at|to|for)\\s+(?:work|the\\s+office)|at\\s+home)\\b`,
  "g",
);

/**
 * Whether the rest of a report clause says nothing but WHICH pieces and WHEN. A report is recorded
 * without the owner's tap only when it does: every word left after the report's own wording must be a
 * word of a piece the clause names, a kind of piece, a recognised time, or a small connecting word.
 * Anything else changes or qualifies what is said in a way this code cannot judge ("for years", "at
 * Easter", "in my dream", "when the weather turns", "I doubt ...", "the care label says ..."), so the
 * clause is not read as a report and the model's record becomes a request for the owner to confirm
 * (adversarial findings I05-1, I05-2 and I05-3). This is an allow-list on purpose: lists of what a
 * sentence must NOT contain were shown, three times, never to be complete.
 */
/**
 * Small words of the naming list that are NOT harmless beside the pieces of a report: a negation, an
 * alternative ("the coat or the oxford"), a condition, a contrast, a modal, a question's auxiliary,
 * another person, or a second report verb ("I wore the coat and washed the oxford" is not one wear report
 * of two pieces). `isDirectReport` already turns most of these sentences away; a clause holding one is no
 * report here either, whatever that filter does (change reviews, 2026-10-03).
 */
const NOT_SMALL = new Set("or not no yes do does did will would can could should may might if than but about you your he she his her they their wore wear wearing worn washed wash clean dirty got get put had".split(" "));
/** The small words that may stand in a report beside the pieces, as written and as `tokensOf` reduces them ("this" becomes "thi"). */
const SMALL_WORDS: ReadonlySet<string> = new Set([...NAMING_STOP].filter((w) => !NOT_SMALL.has(w)).flatMap((w) => [w, ...tokensOf(w)]));

function onlyPiecesAndTime(rest: string, wardrobe: GarmentWords[], garments: Map<string, string[]>): boolean {
  const pieceWords = new Set<string>();
  for (const g of wardrobe) {
    if (!garments.has(g.garmentId)) continue;
    for (const w of g.words) pieceWords.add(w);
    for (const alias of g.aliases) for (const t of tokensOf(alias)) if (!NAMING_STOP.has(t)) pieceWords.add(t);
  }
  for (const token of tokensOf(rest.replace(WHEN, " "))) {
    if (SMALL_WORDS.has(token) || ALL_CATEGORY_WORDS.has(token)) continue;
    if ([...pieceWords].some((w) => sameToken(token, w))) continue;
    return false;
  }
  return true;
}

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

/** The kinds of report a clause is worded as, each with the rest of the clause beside that wording. */
function readingsOf(clause: string): { kind: ReportKind; rest: string }[] {
  const c = normalizeText(clause).replace(LEAD_IN, "");
  const out: { kind: ReportKind; rest: string }[] = [];
  for (const [kind, forms] of FORMS) {
    for (const form of forms) {
      const m = form.re.exec(c);
      if (!m) continue;
      out.push({ kind, rest: form.rest(m, c) });
      break;
    }
  }
  return out;
}

const kindsOf = (clause: string): ReportKind[] => readingsOf(clause).map((r) => r.kind);

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
        const readings = readingsOf(clause);
        // A clause that reads as two kinds at once ("washed and wore") is not tied to either.
        if (readings.length !== 1) continue;
        const { kind, rest } = readings[0]!;
        if (kind === "wear" && date === null) continue;
        const garments = namedInText(wardrobe, clause);
        // Beside its own wording the clause may say only which pieces and when.
        if (!onlyPiecesAndTime(rest, wardrobe, garments)) continue;
        const said = normalizeText(clause);
        const points = garments.size === 0 && POINTER.test(said);
        out.push({ kind, clause, date: kind === "wear" ? date : null, garments, pointsAtAttachment: points, pointsAtOne: points && !/\b(?:these|those|them|both)\b/.test(said) });
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
 * be named in such a clause, or attached to the message while such a clause points at the attachment. A
 * singular pointing word ("wore this", "wore it") covers an attached piece only when it is the one piece
 * attached: with several attached it does not say which (pull request 25 review, finding 9).
 * Returns the provenance of each garment, or null when any is not covered.
 */
export function coverOf(reports: OwnerReport[], kind: ReportKind, date: string | null, garmentIds: string[], attached: string[]): ReportCover[] | null {
  const fitting = reports.filter((r) => r.kind === kind && (kind !== "wear" || r.date === date));
  if (fitting.length === 0 || garmentIds.length === 0) return null;
  const attachedCount = new Set(attached).size;
  const cover: ReportCover[] = [];
  for (const garmentId of new Set(garmentIds)) {
    const naming = fitting.find((r) => r.garments.has(garmentId));
    const pointing = fitting.find((r) => r.pointsAtAttachment && attached.includes(garmentId) && (!r.pointsAtOne || attachedCount === 1));
    if (naming) cover.push({ garmentId, basis: "named_by_owner", matched: naming.garments.get(garmentId)!, clause: naming.clause });
    else if (pointing) cover.push({ garmentId, basis: "attached_by_owner", matched: [], clause: pointing.clause });
    else return null;
  }
  return cover;
}
