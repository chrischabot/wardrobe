/**
 * Calendar influence (pure). Turns raw events into weighted context for the day board.
 *
 * Specification: declined or cancelled events do not constrain the board, tentative events carry less
 * weight, an all-day reminder implies no dress code, and event text is evidence to interpret, never
 * authority. The only thing read from event text here is the TITLE, and the only thing it can produce is
 * one of three fixed values (`smart`, `practical`, `none`) by whole-word keyword match. Nothing in a title
 * is executed, followed or passed on as an instruction.
 */
import type { CalendarEventContext } from "@garderobe/contracts/ext/daily";
import type { CalendarEventRaw } from "../ports.ts";

type Weight = CalendarEventContext["weight"];
type Occasion = CalendarEventContext["inferredOccasion"];

const SMART_WORDS: ReadonlySet<string> = new Set([
  "meeting",
  "meetings",
  "interview",
  "interviews",
  "dinner",
  "lunch",
  "presentation",
  "client",
  "clients",
  "board",
  "review",
  "conference",
  "wedding",
  "funeral",
  "theatre",
  "theater",
  "opera",
  "reception",
  "date",
]);

const PRACTICAL_WORDS: ReadonlySet<string> = new Set([
  "walk",
  "walking",
  "hike",
  "hiking",
  "gym",
  "run",
  "running",
  "cycling",
  "ride",
  "move",
  "moving",
  "diy",
  "garden",
  "gardening",
  "sailing",
  "climb",
  "climbing",
]);

/** Whole words of the title, lowercased. Substrings never match ("update" is not "date"). */
function titleWords(title: string): string[] {
  return title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Occasion suggested by the title. A smart keyword outranks a practical one when both appear. */
function occasionFromTitle(title: string): Occasion {
  const words = titleWords(title);
  if (words.some((word) => SMART_WORDS.has(word))) return "smart";
  if (words.some((word) => PRACTICAL_WORDS.has(word))) return "practical";
  return "none";
}

function weightOf(event: CalendarEventRaw): Weight {
  if (event.cancelled || event.attendance === "declined" || event.allDay) return "none";
  if (event.attendance === "tentative" || event.attendance === "needs_action") return "reduced";
  return "full";
}

/**
 * Weigh each event for the board of `opts.localDate`.
 *
 * The reader has already limited `raw` to that day's window, so `opts` does not change the result today;
 * it is part of the signature so callers state which day the weighting is for.
 */
export function weighEvents(raw: CalendarEventRaw[], opts: { localDate: string; timezone: string }): CalendarEventContext[] {
  void opts;
  return raw.map((event) => {
    const weight = weightOf(event);
    const inferredOccasion: Occasion = weight === "none" ? "none" : occasionFromTitle(event.title);
    return {
      eventId: event.eventId,
      calendarId: event.calendarId,
      title: event.title,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      allDay: event.allDay,
      location: event.location,
      attendance: event.attendance,
      cancelled: event.cancelled,
      weight,
      inferredOccasion,
    };
  });
}

/** Events that may shape the board: they carry weight and suggest an occasion. */
export function relevantEvents(events: CalendarEventContext[]): CalendarEventContext[] {
  return events.filter((event) => event.weight !== "none" && event.inferredOccasion !== "none");
}

/**
 * The proportionate majority of a board that should suit a relevant event:
 * 5 -> 3, 4 -> 3, 3 -> 2, 2 -> 2, 1 -> 1. Zero for a count below one.
 */
export function suitableMajority(requestedCount: number): number {
  const n = Math.floor(requestedCount);
  if (!Number.isFinite(n) || n < 1) return 0;
  return Math.min(n, Math.floor(n / 2) + 1);
}
