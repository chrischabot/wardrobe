/** Small runtime-neutral utilities (Workers runtime and Node). */

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** Deterministic JSON: object keys sorted, undefined dropped. Used for request hashes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

export async function sha256Hex(input: string | Uint8Array | ArrayBuffer): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input instanceof Uint8Array ? input : new Uint8Array(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Deterministic short ID from stable inputs (importer, synthetic fixtures). */
export async function stableId(prefix: string, ...parts: string[]): Promise<string> {
  return `${prefix}_${(await sha256Hex(parts.join("\u001f"))).slice(0, 24)}`;
}

export function toInstant(ms: number): string {
  return new Date(ms).toISOString().replace(/\.000Z$/, "Z");
}

export function parseInstant(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`invalid instant: ${iso}`);
  return ms;
}

/* ---------------------------- civil time ---------------------------- */

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timezone, f);
  }
  return f;
}

function zonedParts(ms: number, timezone: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const parts: Record<string, number> = {};
  for (const p of formatter(timezone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return { y: parts.year!, mo: parts.month!, d: parts.day!, h: parts.hour!, mi: parts.minute!, s: parts.second! };
}

/** Civil date (YYYY-MM-DD) of an instant in a timezone. */
export function localDateOf(ms: number, timezone: string): string {
  const p = zonedParts(ms, timezone);
  return `${p.y.toString().padStart(4, "0")}-${p.mo.toString().padStart(2, "0")}-${p.d.toString().padStart(2, "0")}`;
}

/** Offset (ms) such that local wall time = UTC + offset, at the given instant. */
function offsetAt(ms: number, timezone: string): number {
  const p = zonedParts(ms, timezone);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * UTC instant of a civil local date and wall time in a timezone. Daylight-saving transitions are
 * handled by re-evaluating the offset; a wall time skipped by a spring-forward gap maps to the
 * instant just after the gap.
 */
export function zonedToUtcMs(localDate: string, localTime: string, timezone: string): number {
  const [y, mo, d] = localDate.split("-").map(Number) as [number, number, number];
  const [h, mi] = localTime.split(":").map(Number) as [number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi, 0);
  let guess = wall - offsetAt(wall, timezone);
  guess = wall - offsetAt(guess, timezone);
  return guess;
}

export function addDays(localDate: string, days: number): string {
  const [y, mo, d] = localDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d + days)).toISOString().slice(0, 10);
}

/** ISO weekday of a civil date: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(localDate: string): number {
  const [y, mo, d] = localDate.split("-").map(Number) as [number, number, number];
  const day = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Instant at which a wearing date ends (start of the next civil day) in the timezone. */
export function endOfLocalDateMs(localDate: string, timezone: string): number {
  return zonedToUtcMs(addDays(localDate, 1), "00:00", timezone);
}

export function normalizePhrase(phrase: string): string {
  return phrase
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\u2014\u2013]/g, "-")
    .replace(/[^a-z0-9+]+/g, " ")
    .trim();
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch as T;
  if (base === null || typeof base !== "object" || Array.isArray(base)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = deepMerge((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}
