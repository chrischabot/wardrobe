/**
 * Calendar interfaces (spec sections 7 and 9). Reading events (day context) and writing the one
 * managed outfit event per day are separate capabilities: a read-only connection can shape the board
 * without being able to project it.
 */

export type AttendanceState = 'accepted' | 'tentative' | 'declined' | 'needsAction' | null;

export interface CalendarEvent {
  eventId: string;
  calendarId: string;
  title: string;
  description: string | null;
  location: string | null;
  /** UTC instants for timed events; null for all-day events. */
  start: string | null;
  end: string | null;
  /** Local dates for all-day events (end exclusive, as in Google Calendar). */
  startDate: string | null;
  endDate: string | null;
  allDay: boolean;
  status: 'confirmed' | 'tentative' | 'cancelled';
  /** The owner's own response; null when the owner is the organiser without attendees. */
  selfResponse: AttendanceState;
  /** True for Garderobe's own managed outfit events (never treated as day context). */
  managedByGarderobe: boolean;
}

export interface CalendarSource {
  readonly name: string;
  /** Events overlapping [timeMin, timeMax) across the owner's selected calendars. */
  listEvents(req: { timeMin: string; timeMax: string; timezone: string }): Promise<CalendarEvent[]>;
}

/** The managed outfit event as stored by the provider. */
export interface ManagedEvent {
  id: string;
  etag: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  summary: string;
  description: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  transparency: 'transparent' | 'opaque';
  privateProperties: Record<string, string>;
  updated: string;
}

export interface ManagedEventInput {
  id: string;
  summary: string;
  description: string;
  start: ManagedEvent['start'];
  end: ManagedEvent['end'];
  transparency: 'transparent' | 'opaque';
  privateProperties: Record<string, string>;
}

export interface ManagedEventStore {
  readonly name: string;
  getEvent(calendarId: string, eventId: string): Promise<ManagedEvent | null>;
  /** Inserts with a caller-supplied ID; a duplicate ID raises CalendarApiError(409). */
  insertEvent(calendarId: string, event: ManagedEventInput): Promise<ManagedEvent>;
  /** Conditional patch: a changed etag raises CalendarApiError(412). */
  patchEvent(calendarId: string, eventId: string, patch: Partial<Omit<ManagedEventInput, 'id'>> & { status?: ManagedEvent['status'] }, etag: string): Promise<ManagedEvent>;
  deleteEvent(calendarId: string, eventId: string, etag?: string): Promise<void>;
}

export class CalendarApiError extends Error {
  constructor(
    message: string,
    /** HTTP status; 0 means the outcome is unknown (network loss after sending). */
    readonly status: number,
  ) {
    super(message);
    this.name = 'CalendarApiError';
  }
}
