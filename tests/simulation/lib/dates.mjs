/** Civil dates and times in the owner's timezone (no product code is used here). */

export const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** ISO weekday (1 = Monday ... 7 = Sunday) of a local date. */
export const isoWeekday = (date) => ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;

export const WEEKDAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function offsetMs(timezone, atMs) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(atMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(atMs / 1000) * 1000;
}

/** The UTC instant (ms) of a local date and `HH:MM` in a timezone. */
export function zonedToUtcMs(date, time, timezone) {
  const naive = Date.parse(`${date}T${time}:00Z`);
  // Two passes settle the offset on either side of a daylight-saving change.
  let utc = naive - offsetMs(timezone, naive);
  utc = naive - offsetMs(timezone, utc);
  return utc;
}

/** The local calendar date of an instant in a timezone. */
export const localDateOf = (atMs, timezone) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(atMs));

export const toInstant = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
