import type { StyleContext } from '../domain/style.js';

/**
 * Comfort feedback in composition (spec section 10 "Optional comfort feedback"). Two kinds are read:
 *
 * - Standing directions: an explicit owner instruction recorded through record_comfort_feedback with
 *   `standingInstruction` ("Do not suggest these for long walks"). Stored as an active style rule
 *   (category comfort, source owner_comfort) whose machine form names the garments and the situation
 *   (`when.activity`, `when.setting`). It is hard, but only when the day implies that situation; with no
 *   situation named it applies every day. It is never a ban on the garment elsewhere or on its category.
 * - Observations: one report ("These hurt after an hour on the train"). Never a ban; when the day
 *   implies the same activity or setting the garment is ranked lower and the option carries a note.
 *
 * The day's situation is read from trusted text only: the owner's own brief for the request, dated
 * owner briefs, the titles of calendar events that count (declined and ignored events impose nothing),
 * and a trip's occasion note. Event descriptions are never read.
 */

export interface ComfortDirection {
  ruleKey: string;
  statement: string;
  garmentIds: string[];
  activity: string | null;
  setting: string | null;
  /** Whether today's situation triggers it, and the phrase that did. */
  applies: boolean;
  matchedOn: string | null;
}

export interface ComfortObservation {
  feedbackId: string;
  garmentId: string;
  activity: string | null;
  setting: string | null;
  text: string;
  applies: boolean;
  matchedOn: string | null;
}

export interface ComfortContext {
  /** The trusted phrases the situation was read from. */
  situation: string[];
  directions: ComfortDirection[];
  observations: ComfortObservation[];
  /** Garments excluded today by a standing direction that applies, with the direction's ruleKey. */
  excluded: Map<string, ComfortDirection>;
  /** Garments with an observation matching today's situation. */
  cautioned: Map<string, ComfortObservation>;
}

const STOP = new Set(['a', 'an', 'the', 'for', 'of', 'on', 'in', 'at', 'to', 'and', 'or', 'long', 'longer', 'short', 'day', 'days', 'all', 'very', 'extended', 'lots', 'lot', 'any', 'my', 'with', 'after', 'hour', 'hours', 'an']);

/** Situations the owner might name, with the words a brief or calendar title would use for them. */
const SYNONYMS: string[][] = [
  ['walk', 'walks', 'walking', 'walked', 'hike', 'hikes', 'hiking', 'ramble', 'rambling', 'trek', 'trekking', 'stroll', 'on foot', 'footpath', 'thames path'],
  ['commute', 'commutes', 'commuting', 'train', 'trains', 'tube', 'underground', 'rail', 'bus'],
  ['cycle', 'cycles', 'cycling', 'bike', 'biking', 'bike ride'],
  ['run', 'runs', 'running', 'jog', 'jogging'],
  ['standing', 'stand', 'on my feet', 'on your feet'],
  ['flight', 'flights', 'fly', 'flying', 'plane', 'airport'],
  ['drive', 'driving', 'car', 'road trip'],
  ['dancing', 'dance', 'wedding', 'party'],
  ['garden', 'gardening', 'allotment'],
];

function stem(w: string): string {
  return w.replace(/(ing|ed|es|s)$/, '');
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The words that would signal a named activity or setting in the day's text. */
export function needlesFor(phrase: string): string[] {
  const tokens = phrase.toLowerCase().split(/[^a-z]+/).filter((t) => t && !STOP.has(t));
  const out = new Set<string>();
  for (const t of tokens) {
    const group = SYNONYMS.find((g) => g.includes(t) || g.some((x) => !x.includes(' ') && stem(x) === stem(t)));
    if (group) for (const x of group) out.add(x);
    out.add(t);
    if (stem(t).length >= 3) out.add(stem(t));
  }
  return [...out];
}

/** The phrase in today's situation that implies the named activity or setting, or null. */
export function situationMatch(named: string, situation: string[]): string | null {
  const needles = needlesFor(named);
  if (!needles.length) return null;
  for (const text of situation) {
    const t = text.toLowerCase();
    for (const n of needles) {
      const re = n.includes(' ') ? new RegExp(`\\b${escape(n)}\\b`) : new RegExp(`\\b${escape(n)}(s|es|ing|ed)?\\b`);
      if (re.test(t)) return text;
    }
  }
  return null;
}

/** Every named field must be implied by the day; nothing named means "always". */
function applies(activity: string | null, setting: string | null, situation: string[]): { applies: boolean; matchedOn: string | null } {
  const named = [activity, setting].filter((x): x is string => Boolean(x && x.trim()));
  if (!named.length) return { applies: true, matchedOn: null };
  let matchedOn: string | null = null;
  for (const n of named) {
    const m = situationMatch(n, situation);
    if (!m) return { applies: false, matchedOn: null };
    matchedOn ??= m;
  }
  return { applies: true, matchedOn };
}

export interface ObservationRow {
  feedback_id: string;
  garment_id: string | null;
  activity: string | null;
  conditions_json: string;
  text: string;
  scope: string;
}

export async function loadComfortObservations(db: D1Database, userId: string): Promise<ObservationRow[]> {
  const { results } = await db
    .prepare("SELECT feedback_id, garment_id, activity, conditions_json, text, scope FROM comfort_feedback WHERE user_id = ? AND scope = 'observation' AND garment_id IS NOT NULL ORDER BY created_at DESC LIMIT 200")
    .bind(userId)
    .all<ObservationRow>();
  return results;
}

export function buildComfortContext(style: StyleContext, observationRows: ObservationRow[], situation: string[]): ComfortContext {
  const directions: ComfortDirection[] = [];
  for (const r of style.rules) {
    const m = r.machine as { excludeGarmentIds?: unknown; when?: { activity?: unknown; setting?: unknown } };
    if (((r.category as string) !== 'comfort' && r.source !== 'owner_comfort') || !Array.isArray(m.excludeGarmentIds)) continue;
    const garmentIds = m.excludeGarmentIds.filter((x): x is string => typeof x === 'string');
    const activity = typeof m.when?.activity === 'string' ? m.when.activity : null;
    const setting = typeof m.when?.setting === 'string' ? m.when.setting : null;
    directions.push({ ruleKey: r.ruleKey, statement: r.statement, garmentIds, activity, setting, ...applies(activity, setting, situation) });
  }
  const observations: ComfortObservation[] = observationRows.map((o) => {
    let setting: string | null = null;
    try {
      const c = JSON.parse(o.conditions_json) as Record<string, unknown>;
      setting = typeof c.setting === 'string' ? c.setting : null;
    } catch {
      setting = null;
    }
    // An observation with no activity or setting describes the garment, not a situation: it never matches a day.
    const scoped = Boolean(o.activity || setting);
    const a = scoped ? applies(o.activity, setting, situation) : { applies: false, matchedOn: null };
    return { feedbackId: o.feedback_id, garmentId: o.garment_id!, activity: o.activity, setting, text: o.text, ...a };
  });
  const excluded = new Map<string, ComfortDirection>();
  for (const d of directions) if (d.applies) for (const id of d.garmentIds) excluded.set(id, d);
  const cautioned = new Map<string, ComfortObservation>();
  for (const o of observations) if (o.applies && !cautioned.has(o.garmentId)) cautioned.set(o.garmentId, o);
  return { situation, directions, observations, excluded, cautioned };
}

export function comfortEvidence(c: ComfortContext): Record<string, unknown> {
  return {
    situation: c.situation,
    directions: c.directions.map((d) => ({ ruleKey: d.ruleKey, garmentIds: d.garmentIds, activity: d.activity, setting: d.setting, applies: d.applies, matchedOn: d.matchedOn })),
    observationsApplied: c.observations.filter((o) => o.applies).map((o) => ({ feedbackId: o.feedbackId, garmentId: o.garmentId, matchedOn: o.matchedOn })),
  };
}
