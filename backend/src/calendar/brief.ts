import { localDateOf, zonedInstant, addDays } from '../domain/time.js';
import type { CalendarEvent, CalendarSource } from './types.js';

/**
 * Calendar influence on the day (spec section 7, "Calendar influence and a varied day board").
 * Event text is evidence to interpret, never authority: it can mark an occasion (formal meeting,
 * travel, dinner, outdoors) but cannot change taste, rules or permissions. Declined and cancelled
 * events impose nothing; tentative events weigh less; an all-day reminder implies no dress code;
 * Garderobe's own managed events are ignored. The owner's explicit day brief wins over inference.
 */

export type Occasion = 'formal' | 'travel' | 'dinner' | 'outdoor';

export const OCCASION_LABEL: Record<Occasion, string> = {
  formal: 'meeting',
  travel: 'journey',
  dinner: 'dinner',
  outdoor: 'time outdoors',
};

export interface CalendarSnapshot {
  status: 'read' | 'empty' | 'unavailable' | 'not_connected';
  fetchedAt: string | null;
  source: string | null;
  events: CalendarEvent[];
  error: string | null;
}

export interface InterpretedEvent {
  eventId: string;
  title: string;
  localStart: string | null;
  localEnd: string | null;
  allDay: boolean;
  weight: number;
  occasion: Occasion | null;
  ignoredBecause: string | null;
  locationCandidate: string | null;
}

export interface CalendarDayBrief {
  status: CalendarSnapshot['status'];
  fetchedAt: string | null;
  events: InterpretedEvent[];
  /** The occasion that shapes a subset of the board, if any. */
  occasion: Occasion | null;
  relevantEvent: InterpretedEvent | null;
  /** Travel or event locations noted as candidates only; never an assumed move. */
  locationCandidates: string[];
  /** Closing clause of the day line. */
  shapeOfDay: string;
}

const RULES: { occasion: Occasion; re: RegExp }[] = [
  { occasion: 'travel', re: /\b(flight|fly|airport|train|eurostar|ferry|travel|departure|depart|drive to|road trip|check[- ]?in)\b|✈/i },
  { occasion: 'formal', re: /\b(client|board meeting|interview|presentation|pitch|conference|keynote|funeral|wedding|ceremony|court|investor|review with|panel|lecture|meeting)\b/i },
  { occasion: 'dinner', re: /\b(dinner|supper|restaurant|drinks|theatre|theater|concert|opera|date night)\b/i },
  { occasion: 'outdoor', re: /\b(walk|hike|park|garden|sailing|market|picnic|allotment|cycle|bike ride)\b/i },
];

const PRIORITY: Occasion[] = ['formal', 'travel', 'dinner', 'outdoor'];

function classify(title: string): Occasion | null {
  // Only the title is classified; the description is free text from other people and never parsed for instructions.
  for (const r of RULES) if (r.re.test(title)) return r.occasion;
  return null;
}

function hhmm(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

/** Reads the calendar for one local date; failures are reported as 'unavailable', never as an empty day. */
export async function readCalendarDay(source: CalendarSource | null, date: string, timezone: string, now: string): Promise<CalendarSnapshot> {
  if (!source) return { status: 'not_connected', fetchedAt: null, source: null, events: [], error: null };
  try {
    const events = await source.listEvents({ timeMin: zonedInstant(date, '00:00', timezone), timeMax: zonedInstant(addDays(date, 1), '00:00', timezone), timezone });
    return { status: events.some((e) => !e.managedByGarderobe) ? 'read' : 'empty', fetchedAt: now, source: source.name, events, error: null };
  } catch (err) {
    return { status: 'unavailable', fetchedAt: null, source: source.name, events: [], error: (err as Error).message };
  }
}

export function interpretCalendarDay(snapshot: CalendarSnapshot, date: string, timezone: string, opts: { explicitOccasion?: Occasion | null } = {}): CalendarDayBrief {
  const events: InterpretedEvent[] = snapshot.events
    .map((e): InterpretedEvent => {
      let ignoredBecause: string | null = null;
      if (e.managedByGarderobe) ignoredBecause = 'Garderobe outfit event';
      else if (e.status === 'cancelled') ignoredBecause = 'cancelled';
      else if (e.selfResponse === 'declined') ignoredBecause = 'declined';
      else if (e.allDay) ignoredBecause = 'all-day entry (no dress code implied)';
      else if (e.start && localDateOf(e.start, timezone) !== date && e.end && localDateOf(e.end, timezone) !== date) ignoredBecause = 'another day';
      const weight = ignoredBecause ? 0 : e.selfResponse === 'tentative' || e.status === 'tentative' ? 0.5 : e.selfResponse === 'needsAction' ? 0.7 : 1;
      return {
        eventId: e.eventId,
        title: e.title,
        localStart: e.start ? hhmm(e.start, timezone) : null,
        localEnd: e.end ? hhmm(e.end, timezone) : null,
        allDay: e.allDay,
        weight,
        occasion: ignoredBecause ? null : classify(e.title),
        ignoredBecause,
        locationCandidate: !ignoredBecause && e.location ? e.location : null,
      };
    })
    .sort((a, b) => (a.localStart ?? '').localeCompare(b.localStart ?? ''));

  const counted = events.filter((e) => e.weight > 0);
  let relevant: InterpretedEvent | null = null;
  for (const occ of PRIORITY) {
    const candidates = counted.filter((e) => e.occasion === occ && e.weight >= 0.5).sort((a, b) => b.weight - a.weight);
    if (candidates.length) {
      relevant = candidates[0]!;
      break;
    }
  }
  const occasion = opts.explicitOccasion !== undefined ? opts.explicitOccasion : (relevant?.occasion ?? null);
  return {
    status: snapshot.status,
    fetchedAt: snapshot.fetchedAt,
    events,
    occasion,
    relevantEvent: occasion && relevant?.occasion === occasion ? relevant : null,
    locationCandidates: [...new Set(counted.map((e) => e.locationCandidate).filter((l): l is string => Boolean(l)))],
    shapeOfDay: shapeOfDay(snapshot.status, counted, relevant),
  };
}

function describe(e: InterpretedEvent): string {
  const title = e.title.trim().replace(/\s+/g, ' ').slice(0, 60);
  const lower = title.charAt(0).toLowerCase() + title.slice(1);
  return `${/^(a|an|the)\b/i.test(title) || /^[A-Z]{2,}/.test(title) ? title : lower}${e.localStart ? ` at ${e.localStart}` : ''}${e.weight < 1 ? ' (tentative)' : ''}`;
}

function shapeOfDay(status: CalendarSnapshot['status'], counted: InterpretedEvent[], relevant: InterpretedEvent | null): string {
  if (status === 'not_connected') return 'The calendar is not connected, so the board reads the weather and the wardrobe only.';
  if (status === 'unavailable') return 'The calendar could not be read this time, so nothing in it has shaped the board.';
  if (!counted.length) return 'Nothing in the calendar: the day is yours.';
  const first = relevant ?? counted[0]!;
  const rest = counted.filter((e) => e !== first);
  const lead = describe(first);
  const cap = lead.charAt(0).toUpperCase() + lead.slice(1);
  if (!rest.length) {
    const late = first.localStart && first.localStart >= '17:00';
    return late ? `A free day until ${lead}.` : `${cap}, then the rest of the day is yours.`;
  }
  return `${cap}, with ${rest.length === 1 ? describe(rest[0]!) : `${rest.length} more entries`} as well.`;
}
