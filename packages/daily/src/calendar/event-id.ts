/**
 * Stable identifiers for the one managed outfit event per (scope, local date).
 *
 * Google Calendar accepts caller-supplied event IDs under these rules (Event.id in the v3 discovery
 * document, revision 20260925, and the events.insert reference, both read on 2026-09-30):
 *   - characters are those of base32hex: lowercase letters a-v and digits 0-9;
 *   - length between 5 and 1024 characters;
 *   - unique per calendar.
 * Lowercase hexadecimal (0-9, a-f) is a subset of that alphabet, and the prefix "gdb" uses only a-v.
 */

const GOOGLE_EVENT_ID = /^[a-v0-9]{5,1024}$/;

/** True when `id` satisfies Google's rules for a caller-supplied event ID. */
export function isValidGoogleEventId(id: string): boolean {
  return GOOGLE_EVENT_ID.test(id);
}

/**
 * Deterministic event ID: "gdb" + the first 40 lowercase hex characters of
 * SHA-256("garderobe-outfit-event|userId|scope|localDate"). The same inputs always give the same ID, so a
 * retry after a lost response addresses the same event instead of creating another one.
 */
export async function managedEventId(userId: string, scope: string, localDate: string): Promise<string> {
  const input = new TextEncoder().encode(`garderobe-outfit-event|${userId}|${scope}|${localDate}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return `gdb${hex.slice(0, 40)}`;
}

/** Key under which projection of one managed event is serialized and tracked. */
export function projectionTargetKey(scope: string, localDate: string): string {
  return `outfit-event:${scope}:${localDate}`;
}
