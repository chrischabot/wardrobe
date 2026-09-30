import { ownWords } from '../domain/healing.js';
import { addDays, dayOfWeek } from '../domain/time.js';

/**
 * Trusted grounding for the two conversational writes that change how the profile is applied.
 *
 * ADV-05: a profile amendment must rest on a substantial quote of the owner's own words (not a
 * trigger phrase such as "From now on", and not pasted text), and the amendment the model writes
 * may not add substance the owner did not state: nearly every content word must come from his
 * quote, his message, or the names of garments he owns.
 *
 * ADV-07: a one-day exception or brief is bounded by the dates the owner's words name (today,
 * tomorrow, a weekday, this weekend or week, explicit dates, his planned trip). The model's
 * validFrom/validTo must fit inside one of those windows.
 */

const TRIGGER_PHRASES = /\b(from now on|going forward|in future|as a rule|remember that|correction|update my (style|profile)|that'?s wrong|that is wrong|actually|please|i want|i'd like|i would like)\b/gi;

const STOPWORDS = new Set(
  `a an the and or but of to in on at for with by from as is are was were be been being it its this that these those i me my mine he him his you your we our they them their there here not no nor do does did doing done don't dont so than then too very can will would should could may might must shall just only also again more most less least any some all each every other such own same into over under about after before up down out off per via now ever never always owner owner's owners he's i'm i've let lets`.split(
    /\s+/,
  ),
);
/** Words an amendment may use to state what applies, without importing new substance. */
const FRAMING = new Set(
  `include exclude offer offered suggest suggestion suggestions propose recommend avoid prefer preferred preference use wear wearing worn pair pairing combine choose pick keep stop start often rarely instead default defaults apply applies rule direction supersede supersedes replaces replace earlier older passage profile section correction standing owner's wants want like likes dislike dislikes`.split(
    /\s+/,
  ),
);

function stem(w: string): string {
  let s = w.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const suf of ['ings', 'ing', 'ied', 'ies', 'ed', 'es', 's', 'ly']) {
    if (s.length > suf.length + 3 && s.endsWith(suf)) {
      s = s.slice(0, -suf.length);
      break;
    }
  }
  return s.slice(0, 6);
}

function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'.-]*/g) ?? []).map((w) => w.replace(/[.'-]+$/, '')).filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

export interface GroundingResult {
  ok: boolean;
  reason?: string;
  unsupported?: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/[‘’“”]/g, "'").replace(/\s+/g, ' ').trim();

/** ADV-05: the quote is the owner's own substantial words and the amendment adds nothing he did not say. */
export function amendmentGrounded(input: { ownerQuote: string; amendment: string; ownerText: string; garmentNames: string[] }): GroundingResult {
  const own = ownWords(input.ownerText);
  if (!norm(own).includes(norm(input.ownerQuote))) return { ok: false, reason: 'The quote must be the owner’s own words in this message, not quoted or pasted text.' };
  const substance = contentWords(input.ownerQuote.replace(TRIGGER_PHRASES, ' ')).filter((w) => !FRAMING.has(w));
  if (substance.length < 3) {
    return { ok: false, reason: 'Quote the sentence that states the change itself (at least a few words of substance), not just a phrase such as “From now on”.' };
  }
  const supported = new Set([...contentWords(input.ownerQuote), ...contentWords(own), ...input.garmentNames.flatMap(contentWords)].map(stem));
  const words = contentWords(input.amendment).filter((w) => !FRAMING.has(w));
  const unsupported = [...new Set(words.filter((w) => !supported.has(stem(w))))];
  // A word or two of paraphrase is fine; new claims are not.
  if (unsupported.length > Math.max(2, Math.floor(words.length * 0.25))) {
    return { ok: false, reason: `The amendment goes beyond what the owner said (${unsupported.slice(0, 6).join(', ')}); record his words, or ask him.`, unsupported };
  }
  return { ok: true };
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export interface DateWindow {
  from: string;
  to: string;
  label: string;
}

/** ADV-07: the date windows the owner's own words name, relative to his local `today`. */
export function namedWindows(ownerText: string, today: string, trip?: { departsOn: string; returnsOn: string; name: string } | null): DateWindow[] {
  const t = ownWords(ownerText).toLowerCase();
  const out: DateWindow[] = [];
  if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(t)) out.push({ from: today, to: today, label: 'today' });
  if (/\btomorrow\b/.test(t)) out.push({ from: addDays(today, 1), to: addDays(today, 1), label: 'tomorrow' });
  if (/\bthis weekend\b/.test(t)) {
    const sat = addDays(today, (6 - dayOfWeek(today) + 7) % 7);
    const from = dayOfWeek(today) === 0 ? today : sat;
    out.push({ from, to: dayOfWeek(today) === 0 ? today : addDays(sat, 1), label: 'this weekend' });
  }
  if (/\bthis week\b/.test(t)) out.push({ from: today, to: addDays(today, (7 - dayOfWeek(today)) % 7), label: 'this week' });
  WEEKDAYS.forEach((name, dow) => {
    if (new RegExp(`\\b(on |this |next )?${name}\\b`).test(t)) {
      const d = addDays(today, (dow - dayOfWeek(today) + 7) % 7 || (/\bnext\b/.test(t) ? 7 : 0));
      out.push({ from: d, to: d, label: name });
    }
  });
  const iso = [...t.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)].map((m) => m[1]!).sort();
  if (iso.length) out.push({ from: iso[0]!, to: iso.at(-1)!, label: 'the dates stated' });
  if (trip && /\b(trip|travel|travelling|traveling|away|holiday|packing)\b/.test(t)) out.push({ from: trip.departsOn, to: trip.returnsOn, label: `the ${trip.name} trip` });
  return out;
}

/** ADV-07: a brief's range must fit inside one window the owner named; an unnamed occasion allows one day within two weeks. */
export function briefRangeAllowed(input: { validFrom: string; validTo: string; ownerText: string; today: string; trip?: { departsOn: string; returnsOn: string; name: string } | null }): GroundingResult & { windows: DateWindow[] } {
  const windows = namedWindows(input.ownerText, input.today, input.trip);
  if (input.validTo < input.validFrom) return { ok: false, reason: 'The brief ends before it starts.', windows };
  if (windows.some((w) => input.validFrom >= w.from && input.validTo <= w.to)) return { ok: true, windows };
  if (!windows.length && input.validFrom === input.validTo && input.validFrom >= input.today && input.validFrom <= addDays(input.today, 14)) return { ok: true, windows };
  const named = windows.length ? windows.map((w) => (w.from === w.to ? `${w.label} (${w.from})` : `${w.label} (${w.from} to ${w.to})`)).join(', ') : 'a single day';
  return { ok: false, reason: `The owner’s words cover ${named}; a brief from ${input.validFrom} to ${input.validTo} goes beyond them. Ask him for the dates.`, windows };
}
