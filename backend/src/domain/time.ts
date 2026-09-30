/**
 * Civil-time helpers. Wearing dates, board dates and laundry cycles are local dates in the owner's
 * IANA timezone; instants are stored in UTC. Implemented with Intl so DST days need no tables.
 */

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

interface LocalParts {
  date: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function localParts(instant: string | number | Date, timeZone: string): LocalParts {
  const d = instant instanceof Date ? instant : new Date(instant);
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(d).map((p) => [p.type, p.value]));
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return {
    year,
    month,
    day,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    date: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

/** Local calendar date (YYYY-MM-DD) of an instant in a timezone. */
export function localDateOf(instant: string | number | Date, timeZone: string): string {
  return localParts(instant, timeZone).date;
}

function offsetMs(utcMs: number, timeZone: string): number {
  const p = localParts(utcMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** UTC instant (ISO) of a local wall-clock time. Nonexistent DST times resolve forward. */
export function zonedInstant(localDate: string, time: string, timeZone: string): string {
  const [y, m, d] = localDate.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, m - 1, d, hh, mm, 0);
  let guess = wall - offsetMs(wall, timeZone);
  const corrected = wall - offsetMs(guess, timeZone);
  if (corrected !== guess) guess = corrected;
  return new Date(guess).toISOString();
}

export function addDays(localDate: string, days: number): string {
  const [y, m, d] = localDate.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** Day of week of a local date: 0 = Sunday ... 6 = Saturday. */
export function dayOfWeek(localDate: string): number {
  const [y, m, d] = localDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Most recent date on or before `localDate` falling on `dow`. */
export function previousOrSameDow(localDate: string, dow: number): string {
  const diff = (dayOfWeek(localDate) - dow + 7) % 7;
  return addDays(localDate, -diff);
}

export function toIso(instant: string | number | Date): string {
  return new Date(instant).toISOString();
}

export function compareIso(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b);
}
