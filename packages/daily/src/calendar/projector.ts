/**
 * Calendar as a dependable presentation (specification section 9).
 *
 * One managed event per board day, addressed by a stable caller-supplied ID. The projector always
 * projects what D1 says NOW (the current revision, or the absence of a board when it is suppressed or
 * paused), so an older delayed effect can never restore older contents. New contents replace the
 * managed contents of the existing event: nothing is appended and no second event is created. A write
 * is reported `projected` only after a read-back showed every managed field as written (summary, time,
 * reminder, private properties and the managed text) and D1 still wanted exactly that write.
 *
 * One projector at a time holds a managed event: a lease owned by a random token, renewed before every
 * Calendar call, which writes the row only while it still carries that token and releases only its own.
 * A call starts only when the lease outlasts the call's deadline, so a call never outlives the lease.
 */
import type { BoardDocument } from "@garderobe/contracts/ext/daily";
import { decodeHTML } from "entities";
import { claimDueEffects, first, latestDesiredRevision, prepare, settleEffect, stmt, toInstant, zonedToUtcMs, type Db, type EffectRecord, type Stmt } from "@garderobe/domain";
import { CALENDAR_EFFECT_KIND } from "../boards.ts";
import { dailySettings, loadOwner } from "../context.ts";
import { nowOf, type DailyDeps } from "../deps.ts";
import { boardSummary, buildBoardDocument, loadBoard, pauseCovering, renderBoardCalendarText } from "../document.ts";
import { CalendarApiError, CalendarNotConnectedError, DeadlineError, hasBoundedCallDeadline, withDeadline, type CalendarWriter, type ManagedEvent, type ManagedEventWrite } from "../ports.ts";
import { managedEventId } from "./event-id.ts";

export const REVISION_PROPERTY = "garderobeRevision";
export const BOARD_PROPERTY = "garderobeBoard";
/**
 * Private property carrying a fresh random value on a fencing write: a write made only so that a write of
 * ours that may still land fails its precondition. The new value guarantees the event (and its etag) changes.
 */
export const FENCE_PROPERTY = "garderobeFence";
/** Private property marking an event inserted only to claim its ID, removed again at once (never the board's). */
export const TOMBSTONE_PROPERTY = "garderobeTombstone";
const MAX_ATTEMPTS = 8;
const MAX_ROUNDS = 4;
/** How long one projector holds a managed event; renewed before every Calendar call. */
export const PROJECTION_LEASE_MS = 60_000;
/** Lease time that must remain beyond a call's deadline (and grace) before the call may start. */
const LEASE_SAFETY_MS = 5_000;
/** Grace beyond a writer's promised deadline before the projector gives a call up by itself. */
const CALL_GRACE_MS = 1_000;

export type ProjectionOutcome = "projected" | "removed" | "superseded" | "not_connected" | "retry" | "failed" | "skipped_deleted_externally" | "suppressed_deleted_externally" | "busy";

interface ProjectionRow {
  target_key: string;
  board_id: string;
  calendar_id: string | null;
  event_id: string;
  state: string;
  suppression_reason: string | null;
  projected_revision: number | null;
  etag: string | null;
  managed_text: string | null;
  /** The event ID this projector set out to delete and has not yet seen gone or still there (migration 0101). */
  removing_event_id: string | null;
  /** JSON array of [calendar ID, event ID] pairs where a write of ours may still land (migration 0101). */
  uncertain_calendars: string | null;
  /** JSON array of the managed texts of writes that may have landed unverified, newest first (migration 0101). */
  attempted_text: string | null;
}

/* ------------------------------ the lease ------------------------------ */

/** The row no longer carries this projector's token: another projector holds the event now. */
export class LeaseLostError extends Error {
  constructor() {
    super("another projection of this event took over");
    this.name = "LeaseLostError";
  }
}

/**
 * An earlier call of this run was given up while it may still land: no further call is started in this run,
 * so a later write can never be overtaken by the abandoned one. The lease is kept until it runs out.
 */
export class CallAbandonedError extends Error {
  constructor() {
    super("an earlier Calendar call of this run was given up and may still land; no further call is started");
    this.name = "CallAbandonedError";
  }
}

/** A Calendar call was not started: the lease would not outlast the call's deadline. */
export class LeaseTooShortError extends Error {
  constructor(leftMs: number, neededMs: number) {
    super(`the projection lease has ${Math.max(0, Math.floor(leftMs))} ms left; a Calendar call needs ${neededMs} ms`);
    this.name = "LeaseTooShortError";
  }
}

/** @internal What a leased writer needs from a lease. */
export interface LeaseHold {
  /** Renew the lease if it is still ours and return its new expiry (epoch ms); throws LeaseLostError otherwise. */
  hold(): Promise<number>;
  /** A call was given up on while it may still land: keep the lease until it runs out instead of releasing it. */
  keepUntilExpiry(): void;
}

/** @internal Exported for tests only. */
export class ProjectionLease implements LeaseHold {
  private keep = false;
  /** When this lease runs out as last written (epoch ms). */
  private until = 0;

  private constructor(
    private readonly db: Db,
    private readonly userId: string,
    private readonly targetKey: string,
    private readonly token: string,
    private readonly now: () => number,
  ) {}

  /** Take the lease when nobody holds it or the holder's lease ran out; null when it is held. */
  static async acquire(db: Db, userId: string, targetKey: string, now: () => number): Promise<ProjectionLease | null> {
    const token = crypto.randomUUID();
    const at = now();
    const taken = await prepare(db, stmt("UPDATE calendar_projections SET lock_until = ?, lock_token = ? WHERE user_id = ? AND target_key = ? AND (lock_until IS NULL OR julianday(lock_until) < julianday(?))", toInstant(at + PROJECTION_LEASE_MS), token, userId, targetKey, toInstant(at))).run();
    if ((taken.meta?.changes ?? 0) !== 1) return null;
    const lease = new ProjectionLease(db, userId, targetKey, token, now);
    lease.until = at + PROJECTION_LEASE_MS;
    return lease;
  }

  async hold(): Promise<number> {
    const until = this.now() + PROJECTION_LEASE_MS;
    const renewed = await prepare(this.db, stmt("UPDATE calendar_projections SET lock_until = ? WHERE user_id = ? AND target_key = ? AND lock_token = ?", toInstant(until), this.userId, this.targetKey, this.token)).run();
    if ((renewed.meta?.changes ?? 0) !== 1) throw new LeaseLostError();
    this.until = until;
    return until;
  }

  /**
   * Withdraw a removal intent for `eventId` that a delete which never happened left behind. Only an intent this
   * projector recorded (its token) is withdrawn; this works also after the lease was lost, but never while
   * another projector holds a live lease, and never once another projector recorded an intent of its own.
   */
  async withdrawIntent(eventId: string): Promise<void> {
    const at = toInstant(this.now());
    await prepare(this.db, stmt("UPDATE calendar_projections SET removing_event_id = NULL, removing_token = NULL, updated_at = ? WHERE user_id = ? AND target_key = ? AND removing_event_id = ? AND removing_token = ? AND (lock_token = ? OR lock_until IS NULL OR julianday(lock_until) < julianday(?))", at, this.userId, this.targetKey, eventId, this.token, this.token, at)).run();
  }

  /** Record the intent to delete `eventId`, owned by this projector's token (see withdrawIntent). */
  async markIntent(eventId: string): Promise<void> {
    await this.write({ removing_event_id: eventId, removing_token: this.token });
  }

  keepUntilExpiry(): void {
    this.keep = true;
  }

  /** When a given-up call keeps this lease until it runs out: that time (epoch ms); otherwise null. */
  keptUntil(): number | null {
    return this.keep ? this.until : null;
  }

  /**
   * Write projection bookkeeping only while the lease is ours (renewing it). With `condition`, false
   * means the condition did not hold although the lease still does; a lost lease always throws.
   */
  async write(fields: Record<string, unknown>, condition?: string): Promise<boolean> {
    const at = this.now();
    const keys = Object.keys(fields);
    const sets = [...keys.map((k) => `${k} = ?`), "lock_until = ?", "updated_at = ?"].join(", ");
    const written = await prepare(this.db, stmt(`UPDATE calendar_projections SET ${sets} WHERE user_id = ? AND target_key = ? AND lock_token = ?${condition ? ` AND (${condition})` : ""}`, ...keys.map((k) => fields[k]), toInstant(at + PROJECTION_LEASE_MS), toInstant(at), this.userId, this.targetKey, this.token)).run();
    if ((written.meta?.changes ?? 0) === 1) {
      this.until = at + PROJECTION_LEASE_MS;
      return true;
    }
    if (condition !== undefined) {
      const held = await first<{ n: number }>(this.db, "SELECT COUNT(*) AS n FROM calendar_projections WHERE user_id = ? AND target_key = ? AND lock_token = ?", this.userId, this.targetKey, this.token);
      if ((held?.n ?? 0) > 0) return false;
    }
    throw new LeaseLostError();
  }

  /** Release the lease, only while it is still ours. */
  async release(): Promise<void> {
    if (this.keep) return; // a call that was given up on may still land: the lease runs out by itself
    await prepare(this.db, stmt("UPDATE calendar_projections SET lock_until = NULL, lock_token = NULL WHERE user_id = ? AND target_key = ? AND lock_token = ?", this.userId, this.targetKey, this.token)).run();
  }

  /**
   * Settle `effect` only while the lease is ours: the effect's update (and `fields`, written to the
   * projection row first) carry the lease token as a condition inside one batch, so a projector whose
   * lease ran out can never settle an effect after another projector took over. A lost lease throws.
   *
   * While the lease is kept after a given-up call, a retry is never made available before the lease runs
   * out (plus a second): the next attempt could not take it anyway, and the abandoned call may land until then.
   */
  async settle(effect: EffectRecord, outcome: { state: "projected" | "failed" | "cancelled" } | { state: "retry"; error: string; retryAtMs: number }, nowMs: number, fields?: Record<string, unknown>): Promise<void> {
    const at = this.now();
    const now = toInstant(nowMs);
    const writesFields = fields !== undefined && Object.keys(fields).length > 0;
    const leaseEnds = writesFields ? at + PROJECTION_LEASE_MS : this.until;
    if (outcome.state === "retry" && this.keep) outcome = { ...outcome, retryAtMs: Math.max(outcome.retryAtMs, leaseEnds + 1_000) };
    const fence = "EXISTS (SELECT 1 FROM calendar_projections WHERE user_id = ? AND target_key = ? AND lock_token = ?)";
    const fenceParams = [this.userId, this.targetKey, this.token];
    const statements: Stmt[] = [];
    if (fields && Object.keys(fields).length > 0) {
      const keys = Object.keys(fields);
      const sets = [...keys.map((k) => `${k} = ?`), "lock_until = ?", "updated_at = ?"].join(", ");
      statements.push(stmt(`UPDATE calendar_projections SET ${sets} WHERE user_id = ? AND target_key = ? AND lock_token = ?`, ...keys.map((k) => fields[k]), toInstant(at + PROJECTION_LEASE_MS), toInstant(at), this.userId, this.targetKey, this.token));
    }
    const effectIndex = statements.length;
    if (outcome.state === "retry") {
      statements.push(stmt(`UPDATE effects SET state = 'pending', last_error = ?, available_at = ?, claimed_until = NULL, updated_at = ? WHERE user_id = ? AND effect_id = ? AND ${fence}`, outcome.error.slice(0, 500), toInstant(outcome.retryAtMs), now, effect.userId, effect.effectId, ...fenceParams));
    } else {
      statements.push(stmt(`UPDATE effects SET state = ?, claimed_until = NULL, updated_at = ? WHERE user_id = ? AND effect_id = ? AND ${fence}`, outcome.state, now, effect.userId, effect.effectId, ...fenceParams));
      if (outcome.state === "projected") {
        statements.push(stmt(`UPDATE effects SET state = 'superseded', updated_at = ? WHERE user_id = ? AND kind = ? AND target_key = ? AND desired_revision < ? AND state IN ('pending', 'in_progress', 'failed') AND ${fence}`, now, effect.userId, effect.kind, effect.targetKey, effect.desiredRevision, ...fenceParams));
      }
    }
    const results = await this.db.batch(statements.map((s) => prepare(this.db, s)));
    if ((results[effectIndex]?.meta?.changes ?? 0) !== 1) throw new LeaseLostError();
  }
}

type ManagedEventCalls = Pick<CalendarWriter, "getEvent" | "insertEvent" | "patchEvent" | "deleteEvent">;

/**
 * @internal The calls of `writer`, each made only after renewing `lease`, and only when the renewed lease
 * outlasts the call's deadline with a safety margin (otherwise LeaseTooShortError, and the call is never
 * started). A call that has not settled by its deadline plus a grace is given up as a retryable network
 * failure, and the lease is then kept until it runs out because the abandoned request may still land; every
 * later call of the same writer is refused (CallAbandonedError) without being started.
 */
export function leasedWriter(writer: CalendarWriter, lease: LeaseHold, now: () => number): ManagedEventCalls {
  const budgetMs = writer.callDeadlineMs + CALL_GRACE_MS;
  let abandoned = false;
  const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
    if (abandoned) throw new CallAbandonedError();
    const expires = await lease.hold();
    const left = expires - now();
    if (!(left - LEASE_SAFETY_MS >= budgetMs)) throw new LeaseTooShortError(left, budgetMs + LEASE_SAFETY_MS);
    try {
      return await withDeadline(work(), budgetMs);
    } catch (e) {
      if (!(e instanceof DeadlineError)) throw e;
      abandoned = true;
      lease.keepUntilExpiry();
      throw new CalendarApiError("Calendar call given up: no answer within its deadline", { status: null, retryable: true, reason: "network" });
    }
  };
  return {
    getEvent: (userId, calendarId, eventId) => guarded(() => writer.getEvent(userId, calendarId, eventId)),
    insertEvent: (userId, calendarId, eventId, write) => guarded(() => writer.insertEvent(userId, calendarId, eventId, write)),
    patchEvent: (userId, calendarId, eventId, write, etag) => guarded(() => writer.patchEvent(userId, calendarId, eventId, write, etag)),
    deleteEvent: (userId, calendarId, eventId, etag) => guarded(() => writer.deleteEvent(userId, calendarId, eventId, etag ?? null)),
  };
}

/* ------------------------- the managed description ------------------------- */

/**
 * Invisible marker closing the first line (the day line) of the managed text: the managed region begins
 * at the start of that line. Placed at the end of the line so the description still opens with the day
 * line. Word joiners, invisible separators and a zero-width space: nothing a reader sees.
 */
const MANAGED_BEGIN = "\u2063\u2060\u200b\u2060\u2063";
/** Invisible marker on its own line directly after the managed text: the managed region ends there. */
const MANAGED_END = "\u2063\u200b\u2060\u200b\u2063";

/** The managed text as written into the event: `text` between the two invisible region markers. */
export function managedBlock(text: string): string {
  const newline = text.indexOf("\n");
  const firstLine = newline === -1 ? text : text.slice(0, newline);
  const rest = newline === -1 ? "" : text.slice(newline);
  return `${firstLine}${MANAGED_BEGIN}${rest}\n${MANAGED_END}`;
}

/** A description as plain text with `\n` line breaks (HTML from Google's web editor read as its text). */
function plainDescription(raw: string | null | undefined): string {
  if (!raw) return "";
  const text = /<\/?(br|p|div|a|span|b|i|u|ul|ol|li)\b[^>]*>/i.test(raw) ? htmlToText(raw) : raw;
  return text.replace(/\r\n?/g, "\n");
}

/** The complete marked region of a plain description: its bounds and the managed text inside it. */
function managedRegion(plain: string): { start: number; end: number; inner: string } | null {
  const begin = plain.indexOf(MANAGED_BEGIN);
  if (begin === -1) return null;
  const close = plain.indexOf(MANAGED_END, begin + MANAGED_BEGIN.length);
  if (close === -1) return null;
  const start = plain.lastIndexOf("\n", begin) + 1;
  const inner = plain.slice(start, close).replace(MANAGED_BEGIN, "").replace(/\n$/, "");
  return { start, end: close + MANAGED_END.length, inner };
}

/** `text` without region markers: a line that only held a marker goes, a marker inside a line is removed. */
function stripMarkers(text: string): string {
  return text
    .split("\n")
    .flatMap((line) => {
      const bare = line.split(MANAGED_BEGIN).join("").split(MANAGED_END).join("");
      return bare !== line && bare.trim() === "" ? [] : [bare];
    })
    .join("\n");
}

/** Longest common subsequence of non-blank lines: the lines of `managed` that survive in `lines`, in order. */
function survivingLines(managed: string[], lines: string[]): { i: number; j: number }[] {
  const lcs: number[][] = Array.from({ length: managed.length + 1 }, () => new Array<number>(lines.length + 1).fill(0));
  const same = (i: number, j: number) => managed[i]!.trim() !== "" && managed[i]!.trim() === lines[j]!.trim();
  for (let i = managed.length - 1; i >= 0; i--) for (let j = lines.length - 1; j >= 0; j--) lcs[i]![j] = same(i, j) ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const matches: { i: number; j: number }[] = [];
  for (let i = 0, j = 0; i < managed.length && j < lines.length; ) {
    if (same(i, j)) {
      matches.push({ i, j });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) i++;
    else j++;
  }
  return matches;
}

/**
 * Replace the managed text inside whatever the description holds now, preserving the owner's content
 * around it (specification section 9). `next` is placed verbatim (the projector passes the marked block).
 *
 * - A complete marked region is replaced; everything outside it is the owner's, and so is every line
 *   inside it that is not a line of the last projection (kept directly after the new managed text).
 * - Without one (a description written before the markers, or one whose markers were lost), the last
 *   projection's text is replaced where it still stands whole; otherwise the lines of the last
 *   projection that survive locate it, and the span from the first to the last surviving line is
 *   replaced. Owner lines above or below that span are kept, also when they could be a managed line
 *   the owner rewrote. Inside the span, every non-blank line that is not a surviving managed line is
 *   kept, directly after the managed text: a line count cannot tell a rewritten managed line from his
 *   note, and losing his note is worse than repeating a line he rewrote.
 * - When nothing identifies the managed text, nothing of the owner's is deleted: the new managed text
 *   goes first, in a fresh marked region, and his text follows it.
 *
 * Google can hand a description back as HTML once it was edited in its web editor (line breaks as
 * `<br>` or closed paragraphs, links as anchors, `&amp;` for `&`). Such a description is read as its
 * plain text before the managed region is looked for, so the owner's note is found there too; the
 * merged description is written as plain text.
 */
export function mergeDescription(remoteRaw: string | null, previousManaged: string | null, next: string, alsoManaged: readonly string[] = []): string {
  const remote = plainDescription(remoteRaw);
  const region = managedRegion(remote);
  if (region) {
    // Inside the markers, every non-blank line that is no line of the last verified projection, of a write of
    // ours that may have landed unverified (`alsoManaged`) or of the new managed text is the owner's note: it
    // is kept directly after the new managed text, outside the markers, rather than lost.
    const inner = region.inner.split("\n");
    const matched = new Set<number>();
    for (const basis of [previousManaged, ...alsoManaged, stripMarkers(next)]) {
      if (basis === null) continue;
      for (const m of survivingLines(basis.replace(/\r\n?/g, "\n").split("\n"), inner)) matched.add(m.j);
    }
    const notes = inner.filter((line, j) => !matched.has(j) && line.trim() !== "");
    return `${stripMarkers(remote.slice(0, region.start))}${next}${notes.length > 0 ? `\n${notes.join("\n")}` : ""}${stripMarkers(remote.slice(region.end))}`;
  }
  const bareRaw = stripMarkers(remote);
  if (bareRaw.trim() === "") return next;
  // The last verified projection or an unverified write of ours that stands whole is ours to replace; the
  // longest first, so an unverified write that extends the verified text is replaced with its extension.
  const whole = [previousManaged, ...alsoManaged].filter((t): t is string => t !== null && t.trim() !== "").sort((a, b) => b.length - a.length);
  for (const text of whole) if (bareRaw.includes(text)) return bareRaw.replace(text, () => next);
  const nextText = stripMarkers(next);
  if (nextText.trim() !== "" && bareRaw.includes(nextText)) return bareRaw.replace(nextText, () => next);
  // Lines of an unverified write of ours are never kept as the owner's: they leave the description wherever
  // they stand (those it shares with the verified projection or the new text still locate the managed text),
  // and what remains is located and kept as below.
  const known = new Set([previousManaged ?? "", nextText].flatMap((t) => t.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim())));
  const attemptedLines = new Set(alsoManaged.flatMap((a) => a.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim()).filter((l) => l !== "" && !known.has(l))));
  const bare = attemptedLines.size === 0 ? bareRaw : bareRaw.split("\n").filter((l) => !attemptedLines.has(l.trim())).join("\n");
  if (bare.trim() === "") return next;
  if (previousManaged) {
    const managed = previousManaged.replace(/\r\n?/g, "\n").split("\n");
    const lines = bare.split("\n");
    const matches = survivingLines(managed, lines);
    if (matches.length > 0) {
      // Between two surviving lines every other non-blank line is kept: it may be the owner's note.
      const kept: string[] = [];
      for (let k = 1; k < matches.length; k++) {
        kept.push(...lines.slice(matches[k - 1]!.j + 1, matches[k]!.j).filter((l) => l.trim() !== ""));
      }
      return [...lines.slice(0, matches[0]!.j), next, ...kept, ...lines.slice(matches[matches.length - 1]!.j + 1)].join("\n");
    }
  }
  return `${next}\n\n${bare.replace(/^\n+/, "")}`;
}

/** True when `description` carries exactly `text` as its managed text. */
function carriesManagedText(description: string | null, text: string): boolean {
  const plain = plainDescription(description);
  const region = managedRegion(plain);
  // Without markers (lost in an editor), the text must at least stand whole in the description.
  return region ? region.inner === text : stripMarkers(plain).includes(text);
}

function sameTime(read: ManagedEventWrite["time"], wanted: ManagedEventWrite["time"]): boolean {
  if (read.kind === "all_day" || wanted.kind === "all_day") return read.kind === "all_day" && wanted.kind === "all_day" && read.localDate === wanted.localDate;
  return Date.parse(read.startsAt) === Date.parse(wanted.startsAt) && Date.parse(read.endsAt) === Date.parse(wanted.endsAt) && read.timezone === wanted.timezone;
}

/**
 * True when `event` is live and shows every managed field of `write`: summary, time (presentation and
 * start), reminder, private properties (board and revision), and `text` as its managed text. A field the
 * adapter did not read back never verifies.
 */
export function carriesWrite(event: ManagedEvent | null, write: ManagedEventWrite, text: string): boolean {
  if (!event || event.status === "cancelled") return false;
  if (event.summary !== write.summary) return false;
  for (const [key, value] of Object.entries(write.privateProperties)) if (event.privateProperties[key] !== value) return false;
  if (event.time === undefined || event.time === null || !sameTime(event.time, write.time)) return false;
  if (event.reminderMinutesBefore === undefined || event.reminderMinutesBefore !== write.reminderMinutesBefore) return false;
  return carriesManagedText(event.description, text);
}

/**
 * The plain text of a description Google returned as HTML: line breaks and block boundaries become lines,
 * a link keeps its address as "text (address)", other tags go, and entities are decoded in one pass (so
 * "&#38;amp;" is the text "&amp;", never "&").
 */
export function htmlToText(html: string): string {
  let out = "";
  let swallowNewline = false;
  let anchor: { href: string; start: number } | null = null;
  const lineStart = () => {
    if (out !== "" && !out.endsWith("\n")) out += "\n";
  };
  const token = /<(\/?)([a-z][a-z0-9]*)\b([^>]*)>|[^<]+|</gi;
  for (const m of html.replace(/\r\n/g, "\n").matchAll(token)) {
    const [whole, closing, rawName, attributes] = m;
    if (rawName === undefined) {
      let text = decodeEntities(whole);
      if (swallowNewline && text.startsWith("\n")) text = text.slice(1);
      swallowNewline = false;
      out += text;
      continue;
    }
    swallowNewline = false;
    const name = rawName.toLowerCase();
    if (name === "br") {
      out += "\n";
      swallowNewline = true;
    } else if (name === "p" || name === "div" || name === "li") {
      if (closing) {
        out += "\n";
        swallowNewline = true;
      } else lineStart();
    } else if (name === "a" && !closing) {
      const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes ?? "");
      const value = href ? decodeEntities(href[1] ?? href[2] ?? href[3] ?? "").trim() : "";
      anchor = value ? { href: value, start: out.length } : null;
    } else if (name === "a" && closing && anchor) {
      const label = out.slice(anchor.start).trim();
      if (label !== anchor.href) out += ` (${anchor.href})`;
      anchor = null;
    }
  }
  return out.replace(/\n+$/, "");
}

/**
 * Decode HTML character references in one pass, as a browser shows the text, using the `entities`
 * package's full HTML named-reference table; a numeric reference naming no valid code point (beyond
 * U+10FFFF, a surrogate, zero) becomes U+FFFD instead of throwing.
 */
function decodeEntities(text: string): string {
  return decodeHTML(text);
}

/**
 * The base address to write into a Calendar event, rebuilt from the parsed URL (origin and path, no
 * trailing slash): an absolute http(s) address with no credentials, query, fragment, whitespace or
 * control characters. Anything else is null and is never written as a link.
 */
export function webAddressBase(value: string | null | undefined): string | null {
  if (!value || /[\s\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || value.includes("?") || value.includes("#")) return null;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** A base address fit to be written into a Calendar event (see `webAddressBase`). */
export function isWebAddress(value: string | null | undefined): value is string {
  return webAddressBase(value) !== null;
}

function isNotConnected(e: unknown): boolean {
  return e instanceof CalendarNotConnectedError || (e as Error)?.name === "CalendarNotConnectedError";
}
function apiError(e: unknown): CalendarApiError | null {
  return e instanceof CalendarApiError || (e as Error)?.name === "CalendarApiError" ? (e as CalendarApiError) : null;
}

function eventWrite(doc: BoardDocument, description: string, morningLocalTime: string, presentation: "timed" | "all_day", reminderMinutesBefore: number | null): ManagedEventWrite {
  const startMs = zonedToUtcMs(doc.localDate, morningLocalTime, doc.timezone);
  return {
    summary: boardSummary(doc),
    description,
    privateProperties: { [BOARD_PROPERTY]: doc.boardId, [REVISION_PROPERTY]: String(doc.revision) },
    // An all-day board has no 7 AM start; the morning reminder is then the app's, kept separate.
    time: presentation === "all_day" ? { kind: "all_day", localDate: doc.localDate } : { kind: "timed", startsAt: toInstant(startMs), endsAt: toInstant(startMs + 15 * 60_000), timezone: doc.timezone },
    reminderMinutesBefore,
  };
}

function live(event: ManagedEvent | null): boolean {
  return event !== null && event.status !== "cancelled";
}

interface ProjectionPayload {
  boardId?: string | null;
  localDate: string;
  scope: string;
  restore?: boolean;
}

interface DesiredState {
  /** Equal keys mean the same desired outcome: absence for the same reason, or the very same write. */
  key: string;
  calendarId: string | null;
  absent: "pause" | "owner_request" | null;
  present: { doc: BoardDocument; text: string; write: ManagedEventWrite } | null;
}

/**
 * What D1 wants for this event now: the owner's outfit calendar, and either no event (no board, the
 * board removed or suppressed, or a pause covering the day) or one exact write of the current revision.
 */
async function desiredState(deps: DailyDeps, userId: string, payload: ProjectionPayload): Promise<DesiredState> {
  const db = deps.db;
  const owner = await loadOwner(db, userId);
  const settings = dailySettings(owner.settings);
  const calendarId = settings.calendar.outfitCalendarId ?? null;
  const board = await loadBoard(db, userId, { date: payload.localDate, scope: payload.scope });
  const suppression = await first<{ reason: string }>(db, "SELECT reason FROM board_suppressions WHERE user_id = ? AND scope = ? AND local_date = ? AND status = 'active'", userId, payload.scope, payload.localDate);
  const paused = await pauseCovering(db, userId, payload.localDate);
  if (!board || board.status === "suppressed" || suppression || paused) {
    const absent = paused ? "pause" : "owner_request";
    return { key: JSON.stringify(["absent", absent, calendarId]), calendarId, absent, present: null };
  }
  const doc = await buildBoardDocument(db, userId, board);
  // The owner's own base address when he set one; otherwise this deployment's origin. Only a plain
  // https (or http) address is ever written into the Calendar event; anything else is not a link.
  const base = [settings.calendar.boardBaseUrl, deps.boardBaseUrl].map((b) => webAddressBase(b)).find((b) => b !== null) ?? null;
  const url = base ? `${base}/board/${doc.localDate}` : null;
  const text = renderBoardCalendarText(doc, { boardUrl: url });
  const write = eventWrite(doc, managedBlock(text), owner.settings.delivery.morningLocalTime, settings.calendar.presentation, settings.calendar.reminderMinutesBefore);
  return { key: JSON.stringify(["present", calendarId, write]), calendarId, absent: null, present: { doc, text, write } };
}

/**
 * @internal True when a failed delete definitely did not happen: the lease guard refused to start it (lease too short
 * for the call, or lost before it), no connection at all, or a client error other than a timeout. A server
 * error, a timeout or no answer may follow a committed delete.
 */
export function definitelyNotDeleted(e: unknown): boolean {
  if (e instanceof LeaseTooShortError || e instanceof LeaseLostError || e instanceof CallAbandonedError) return true;
  const status = apiError(e)?.detail.status ?? null;
  return isNotConnected(e) || (status !== null && status >= 400 && status < 500 && status !== 408);
}

/**
 * The owner chose another outfit calendar: remove the managed event from the previous one (only an
 * event this projector wrote, recognised by its board property). A previous calendar that can no longer
 * be written (deleted, unshared) has nothing left to clean up: that is returned as a note and delivery
 * to the new calendar goes on. Anything retryable, a lost lease or a lost connection is thrown.
 *
 * The removal intent is recorded (`intent.mark`) just before the delete, so an uncertain outcome followed by
 * a switch back to that calendar is never read as the owner's deletion; a delete that definitely did not
 * happen withdraws it (`intent.clear`).
 */
/**
 * The etag a patch or delete is made conditional on. Every mutation of an existing event carries one, so a
 * call that was given up and lands later (after the lease ran out and another projector wrote) fails its
 * precondition instead of overwriting or removing the newer write; an insert is fenced by its fixed ID.
 * An event read back without an etag is not mutated at all.
 */
function requireEtag(event: ManagedEvent): string {
  if (event.etag === null) throw new CalendarApiError("the event was read without an etag, so it cannot be changed conditionally", { status: null, retryable: true, reason: "no_etag" });
  return event.etag;
}

/**
 * Writes of ours that may still land in a calendar (`pending`); `fenceMissing`, which fences them when no live
 * event can be seen (true once nothing of ours can land there any more); and `mutate`, through which every
 * insert, patch or delete is made so that an uncertain outcome is recorded before the call.
 */
interface Unsettled {
  pending: boolean;
  fenceMissing: (remote: ManagedEvent | null) => Promise<boolean>;
  mutate: <T>(call: () => Promise<T>) => Promise<T>;
  settled: () => Promise<void>;
}

async function removeFromPreviousCalendar(w: ManagedEventCalls, userId: string, calendarId: string, eventId: string, intent: { mark: () => Promise<void>; clear: () => Promise<void> }, unsettled: Unsettled): Promise<string | null> {
  try {
    const old = await w.getEvent(userId, calendarId, eventId);
    if (unsettled.pending && !live(old)) {
      // A write of ours there may still land and bring the event back: fence it, then there is nothing to remove.
      if (!(await unsettled.fenceMissing(old))) throw new CalendarApiError("the event in the previous outfit calendar changed while it was being fenced", { status: null, retryable: true, reason: "previous_calendar" });
      await unsettled.settled();
      return null;
    }
    if (old && live(old) && old.privateProperties[BOARD_PROPERTY] === undefined) {
      // Not marked as ours, so it is not removed. A write of ours to it may still land (an adoption patch):
      // move its etag on with an invisible fence value, so that write fails its precondition.
      if (unsettled.pending) {
        await unsettled.mutate(() => w.patchEvent(userId, calendarId, eventId, { privateProperties: { [FENCE_PROPERTY]: crypto.randomUUID() } }, requireEtag(old)));
        await unsettled.settled();
      }
      return null;
    }
    if (!old || !live(old)) return null;
    const etag = requireEtag(old);
    await intent.mark();
    try {
      await unsettled.mutate(() => w.deleteEvent(userId, calendarId, eventId, etag));
    } catch (e) {
      if (definitelyNotDeleted(e)) await intent.clear();
      throw e;
    }
    const after = await w.getEvent(userId, calendarId, eventId);
    if (live(after)) throw new CalendarApiError("the event in the previous outfit calendar is still there", { status: null, retryable: true, reason: "previous_calendar" });
    // A delete also succeeds when the event had vanished already (404/410): an ID with no event at all could
    // still take a late insert of ours, so it is claimed and removed again before anything counts as fenced.
    if (!(await unsettled.fenceMissing(after))) throw new CalendarApiError("the event in the previous outfit calendar changed while it was being fenced", { status: null, retryable: true, reason: "previous_calendar" });
    // Our conditional delete succeeded: every write of ours still in flight there now fails.
    await unsettled.settled();
    return null;
  } catch (e) {
    const api = apiError(e);
    // The event changed since it was read (a precondition failure): it is still there, so it must be read
    // again and removed, never left behind as a note while the row moves to the new calendar.
    if (!api || api.detail.retryable || api.detail.reason === "precondition") throw api?.detail.reason === "precondition" ? new CalendarApiError("the event in the previous outfit calendar changed while it was being removed", { status: 412, retryable: true, reason: "previous_calendar" }) : e;
    return `the event in the previous outfit calendar could not be removed (${api.detail.reason ?? `HTTP ${api.detail.status ?? "error"}`})`;
  }
}

/**
 * @internal Settle an effect this run claimed, only while that claim stands (still in progress, at this claim's
 * attempt count). Once another run reclaimed the effect, or a lease holder settled it, this changes nothing:
 * a projector that could not take the lease never resets an effect another one already delivered.
 */
export async function settleClaimed(db: Db, effect: EffectRecord, outcome: { state: "failed" | "superseded" | "cancelled" } | { state: "retry"; error: string; retryAtMs: number }, nowMs: number): Promise<void> {
  const now = toInstant(nowMs);
  if (outcome.state === "retry") {
    await prepare(db, stmt("UPDATE effects SET state = 'pending', last_error = ?, available_at = ?, claimed_until = NULL, updated_at = ? WHERE user_id = ? AND effect_id = ? AND state = 'in_progress' AND attempts = ?", outcome.error.slice(0, 500), toInstant(outcome.retryAtMs), now, effect.userId, effect.effectId, effect.attempts)).run();
    return;
  }
  await prepare(db, stmt("UPDATE effects SET state = ?, claimed_until = NULL, updated_at = ? WHERE user_id = ? AND effect_id = ? AND state = 'in_progress' AND attempts = ?", outcome.state, now, effect.userId, effect.effectId, effect.attempts)).run();
}

async function projectOne(deps: DailyDeps, effect: EffectRecord, nowMs: number): Promise<ProjectionOutcome> {
  const db = deps.db;
  const { userId, targetKey } = effect;
  const payload = effect.payload as unknown as ProjectionPayload;
  // Leases and bookkeeping follow the live clock: one projection can outlast the batch's start time.
  const clock = (): number => nowOf(deps);
  // Once the lease is held, every settlement is fenced by its token (see ProjectionLease.settle).
  let held: ProjectionLease | null = null;
  const settle = (outcome: { state: "projected" | "failed" | "cancelled" } | { state: "retry"; error: string; retryAtMs: number }, fields?: Record<string, unknown>): Promise<void> =>
    held ? held.settle(effect, outcome, nowMs, fields) : outcome.state === "projected" ? settleEffect(db, effect, outcome, nowMs) : settleClaimed(db, effect, outcome as Parameters<typeof settleClaimed>[2], nowMs);
  const retryLater = async (error: string, outcome: ProjectionOutcome, delayMs: number): Promise<ProjectionOutcome> => {
    if (effect.attempts >= MAX_ATTEMPTS) {
      await settle({ state: "failed" });
      return outcome === "not_connected" ? "not_connected" : "failed";
    }
    await settle({ state: "retry", error, retryAtMs: nowMs + delayMs });
    return outcome;
  };
  const busy = async (): Promise<ProjectionOutcome> => {
    await settleClaimed(db, effect, { state: "retry", error: "another projection of this event is in progress", retryAtMs: nowMs + 15_000 }, nowMs);
    return "busy";
  };

  // A newer desired revision exists for this event: this effect is superseded and never written.
  const latest = await latestDesiredRevision(db, userId, effect.kind, targetKey);
  if (latest !== null && latest > effect.desiredRevision) {
    await settleClaimed(db, effect, { state: "superseded" }, nowMs);
    return "superseded";
  }

  const stableEventId = await managedEventId(userId, payload.scope, payload.localDate);
  await prepare(db, stmt("INSERT INTO calendar_projections (user_id, target_key, board_id, local_date, event_id, state, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?) ON CONFLICT (user_id, target_key) DO NOTHING", userId, targetKey, payload.boardId ?? "", payload.localDate, stableEventId, toInstant(clock()))).run();

  // Serialize projection per managed event: from here on every row write is fenced by the lease token.
  const lease = await ProjectionLease.acquire(db, userId, targetKey, clock);
  if (!lease) return busy();
  held = lease;

  const readRow = async (): Promise<ProjectionRow> => (await first<ProjectionRow>(db, "SELECT target_key, board_id, calendar_id, event_id, state, suppression_reason, projected_revision, etag, managed_text, removing_event_id, uncertain_calendars, attempted_text FROM calendar_projections WHERE user_id = ? AND target_key = ?", userId, targetKey))!;
  // Only the connection problem is recorded. What was delivered, a suppression (above all the owner's
  // own deletion of the event), the managed text and the event's identity stay as they are.
  // Writes of ours that may still land: each (calendar, event ID) is recorded in the row before every insert,
  // patch or delete of that event (so a later run knows), and counts as fenced in this run once a write of
  // ours to that event succeeded after every uncertain one (a newer etag fails a late patch or delete; a
  // claimed ID fails a late insert). While an event is unfenced, it is never taken as already current, already
  // gone or deleted by the owner.
  type Target = [calendarId: string, eventId: string];
  const same = (a: Target, b: Target) => a[0] === b[0] && a[1] === b[1];
  const uncertainOf = (r: ProjectionRow): Target[] => {
    try {
      const value: unknown = JSON.parse(r.uncertain_calendars ?? "[]");
      return Array.isArray(value) ? value.filter((t): t is Target => Array.isArray(t) && t.length === 2 && typeof t[0] === "string" && typeof t[1] === "string") : [];
    } catch {
      return [];
    }
  };
  const fenced = new Set<string>();
  const attemptedOf = (r: ProjectionRow): string[] => {
    try {
      const value: unknown = JSON.parse(r.attempted_text ?? "[]");
      return Array.isArray(value) ? value.filter((t): t is string => typeof t === "string") : [];
    } catch {
      return [];
    }
  };
  const fenceKey = (cal: string, id: string) => JSON.stringify([cal, id]);
  const unfenced = (r: ProjectionRow, cal: string, id: string): boolean => !fenced.has(fenceKey(cal, id)) && uncertainOf(r).some((t) => same(t, [cal, id]));
  const settledFields = async (cal: string, id: string): Promise<{ uncertain_calendars: string | null }> => {
    const rest = uncertainOf(await readRow()).filter((t) => !same(t, [cal, id]));
    return { uncertain_calendars: rest.length > 0 ? JSON.stringify(rest) : null };
  };
  const mutate = async <T>(cal: string, id: string, call: () => Promise<T>): Promise<T> => {
    const current = uncertainOf(await readRow());
    const added = !current.some((t) => same(t, [cal, id]));
    if (added) await lease.write({ uncertain_calendars: JSON.stringify([...current, [cal, id]]) });
    try {
      const result = await call();
      fenced.add(fenceKey(cal, id));
      return result;
    } catch (e) {
      if (!definitelyNotDeleted(e)) fenced.delete(fenceKey(cal, id));
      // The call definitely did not happen and nothing was uncertain there before it: withdraw the mark.
      else if (added && !(e instanceof LeaseLostError)) await lease.write(await settledFields(cal, id));
      throw e;
    }
  };
  const tombstone = (): ManagedEventWrite => ({
    summary: "Garderobe",
    description: "",
    privateProperties: { [BOARD_PROPERTY]: payload.boardId ?? "", [FENCE_PROPERTY]: crypto.randomUUID(), [TOMBSTONE_PROPERTY]: "1" },
    time: { kind: "all_day", localDate: payload.localDate },
    reminderMinutesBefore: null,
  });
  /**
   * Fence the writes of ours that may still land on a missing event without bringing it back into view. A
   * deleted event gets a fresh fence value under a new etag and stays deleted (a late patch or delete fails
   * its precondition, a late insert finds the ID taken). An ID with no event is claimed and removed again.
   * An ID that is taken although no event can be read under it is fenced already: a late insert fails the
   * same way and a late patch or delete has no event to change. False when the event changed meanwhile.
   */
  const fenceMissing = async (w: ManagedEventCalls, cal: string, id: string, remote: ManagedEvent | null, again = false): Promise<boolean> => {
    try {
      if (remote === null) {
        const claimed = await mutate(cal, id, () => w.insertEvent(userId, cal, id, tombstone()));
        await mutate(cal, id, () => w.deleteEvent(userId, cal, id, requireEtag(claimed)));
        // Read back: the tombstone must be gone. Our insert claimed the ID after every write of ours that may
        // still land, so what follows it (cancelled, or no event under a kept ID) fences them all.
        if (live(await w.getEvent(userId, cal, id))) {
          fenced.delete(fenceKey(cal, id));
          return false;
        }
      } else {
        // A cancelled event: a fresh fence value moves its etag on, so a late conditional write of ours fails.
        await mutate(cal, id, () => w.patchEvent(userId, cal, id, { privateProperties: { [FENCE_PROPERTY]: crypto.randomUUID() } }, requireEtag(remote)));
      }
      return true;
    } catch (e) {
      const reason = apiError(e)?.detail.reason;
      if (reason === "duplicate" && remote === null) {
        // Taken: an ID kept after deletion with no event to read (fenced already: a late insert fails the
        // same way and a late patch or delete has nothing to change), a cancelled event (its etag is moved on
        // first), or a write of ours that landed meanwhile (a live event, decided anew by the caller).
        const taken = await w.getEvent(userId, cal, id);
        if (live(taken)) return false;
        if (taken !== null) return again ? false : fenceMissing(w, cal, id, taken, true);
        fenced.add(fenceKey(cal, id));
        return true;
      }
      if (reason === "precondition" || reason === "not_found") return false;
      throw e;
    }
  };
  /**
   * Read an event back after a delete of ours succeeded. A delete also succeeds when the event had vanished
   * already (404/410) without its etag moving on: an ID with no event is claimed and removed again, and a
   * cancelled event gets a fresh fence value, so no late write of ours can land there. True once nothing of
   * ours can land there; false when the event is live again or changed meanwhile (the pair then stays
   * unfenced and the caller decides anew).
   */
  const fencedAfterDelete = async (w: ManagedEventCalls, cal: string, id: string): Promise<boolean> => {
    const after = await w.getEvent(userId, cal, id);
    const done = live(after) ? false : await fenceMissing(w, cal, id, after);
    if (!done) fenced.delete(fenceKey(cal, id));
    return done;
  };
  const recordConnectionFailure = async (message: string): Promise<void> => {
    if (!(await lease.write({ state: "not_connected", last_error: message }, "state != 'suppressed'"))) await lease.write({ last_error: message });
  };
  const recordFailure = async (message: string, terminal: boolean): Promise<void> => {
    if (terminal && (await lease.write({ state: "failed", last_error: message }, "state != 'suppressed'"))) return;
    await lease.write({ last_error: message });
  };

  const run = async (): Promise<ProjectionOutcome> => {
    let row = await readRow();
    // The owner deleted the event in Calendar: delivery for that day stays suppressed until an explicit
    // restore. A write of ours that may still land there (a restore) is fenced first, further below.
    const suppressedByOwner = row.state === "suppressed" && row.suppression_reason === "deleted_externally" && !payload.restore;
    if (suppressedByOwner && uncertainOf(row).length === 0) {
      await settle({ state: "cancelled" });
      return "skipped_deleted_externally";
    }
    const writer: CalendarWriter | null = deps.calendar.writer;
    const calendarId = (await desiredState(deps, userId, payload)).calendarId;
    if (!writer || !calendarId) {
      await recordConnectionFailure(!writer ? "Google Calendar is not connected" : "no outfit calendar has been chosen");
      return retryLater("calendar not connected", "not_connected", 30 * 60_000);
    }
    if (!hasBoundedCallDeadline(writer)) {
      // A call without a bounded deadline could outlive the lease it runs under: never start one.
      await recordFailure("the calendar writer has no bounded call deadline", true);
      await settle({ state: "failed" });
      return "failed";
    }
    const w = leasedWriter(writer, lease, clock);
    let note: string | null = null;
    // A missing event was fenced in this run: its absence was seen while a write of ours could still land.
    let fencedMissing = false;

    // Another outfit calendar than the one last written: the managed event moves. It is removed from the
    // previous calendar, and in the new one nothing has been delivered yet, so a missing event there is
    // "not delivered", never "deleted by the owner". The event goes back to the stable ID (a row imported
    // from another account, with no calendar, may carry that account's ID).
    if (row.calendar_id !== null && row.calendar_id !== calendarId) {
      const previousEventId = row.event_id;
      const previousCalendarId = row.calendar_id;
      note = await removeFromPreviousCalendar(w, userId, previousCalendarId, previousEventId, {
        mark: () => lease.markIntent(previousEventId),
        clear: () => lease.withdrawIntent(previousEventId),
      }, {
        pending: unfenced(row, previousCalendarId, previousEventId),
        fenceMissing: (old) => fenceMissing(w, previousCalendarId, previousEventId, old),
        mutate: (call) => mutate(previousCalendarId, previousEventId, call),
        settled: async () => { await lease.write(await settledFields(previousCalendarId, previousEventId)); },
      });
      if (note !== null) {
        // The event of ours there could not be removed: it stays outstanding, so a later run removes it once
        // access returns, and while it stands its text stays recognisable as ours (below).
        const current = uncertainOf(await readRow());
        if (!current.some((t) => same(t, [previousCalendarId, previousEventId]))) await lease.write({ uncertain_calendars: JSON.stringify([...current, [previousCalendarId, previousEventId]]) });
      }
    }
    if (row.calendar_id !== calendarId) {
      // The verified text of the event left behind is kept with the unverified ones: an event of ours that
      // still carries it (in the previous calendar, or back here after a later switch) is recognised as ours.
      const kept = row.managed_text !== null ? { attempted_text: JSON.stringify([row.managed_text, ...attemptedOf(await readRow()).filter((t) => t !== row.managed_text)]) } : {};
      await lease.write({ calendar_id: calendarId, event_id: stableEventId, projected_revision: null, etag: null, managed_text: null, removing_event_id: null, ...kept, ...(row.state === "suppressed" ? {} : { state: "pending" }) });
    }

    // Writes of ours that may still land on another event ID in this calendar (an earlier replacement ID),
    // in an earlier outfit calendar (left when the event moved away and its cleanup there was not possible),
    // or on this one when the owner deleted it: fence each one, and remove an event of ours still standing
    // under it. An earlier calendar that still cannot be written keeps its entry, so a later run cleans it
    // up once access returns; delivery to the current calendar goes on meanwhile.
    const currentId = (await readRow()).event_id;
    for (const [cal, id] of uncertainOf(await readRow()).filter((t) => suppressedByOwner || t[0] !== calendarId || t[1] !== currentId)) {
      try {
        // The event changed or vanished between the read and the call (another client): read it again and
        // decide anew, a few times, before leaving it to the next attempt.
        let done = false;
        for (let attempt = 0; attempt < 3 && !done; attempt++) {
          const stray = await w.getEvent(userId, cal, id);
          try {
            if (live(stray)) {
              if (stray!.privateProperties[BOARD_PROPERTY] !== undefined) {
                await mutate(cal, id, () => w.deleteEvent(userId, cal, id, requireEtag(stray!)));
                done = await fencedAfterDelete(w, cal, id);
              } else {
                await mutate(cal, id, () => w.patchEvent(userId, cal, id, { privateProperties: { [FENCE_PROPERTY]: crypto.randomUUID() } }, requireEtag(stray!)));
                done = true;
              }
            } else {
              done = await fenceMissing(w, cal, id, stray);
            }
          } catch (e) {
            const reason = apiError(e)?.detail.reason;
            if (reason !== "precondition" && reason !== "not_found") throw e;
          }
        }
        if (!done) throw new CalendarApiError("an earlier event of ours changed while it was being removed or fenced", { status: null, retryable: true, reason: "stray_event" });
      } catch (e) {
        const api = apiError(e);
        if (cal !== calendarId && api && !api.detail.retryable && api.detail.reason !== "precondition") {
          note = `an event of ours in an earlier outfit calendar could not be cleaned up yet (${api.detail.reason ?? `HTTP ${api.detail.status ?? "error"}`})`;
          continue;
        }
        throw e;
      }
      await lease.write(await settledFields(cal, id));
    }
    if (suppressedByOwner) {
      // Every write of ours there is fenced and nothing of ours stands: the day stays the owner's deletion.
      await settle({ state: "cancelled" });
      return "skipped_deleted_externally";
    }

    for (let round = 0; round < MAX_ROUNDS; round++) {
      row = await readRow();
      const eventId = row.event_id;
      // Recheck what D1 wants before every write, and again after every remote operation.
      const want = await desiredState(deps, userId, payload);
      if (want.calendarId !== calendarId) {
        await lease.write({ last_error: "the outfit calendar changed during delivery" });
        return retryLater("the outfit calendar changed during delivery", "retry", 5_000);
      }
      const remote = await w.getEvent(userId, calendarId, eventId);
      if (live(remote) && remote!.privateProperties[TOMBSTONE_PROPERTY] === "1") {
        // A fence of ours (claimed only to be removed again) whose removal did not finish: it is never the
        // board's event and never the owner's. It is removed, and the day is decided anew without it.
        const etag = requireEtag(remote!);
        try {
          await mutate(calendarId, eventId, () => w.deleteEvent(userId, calendarId, eventId, etag));
          await fencedAfterDelete(w, calendarId, eventId);
        } catch (e) {
          // Changed or already gone meanwhile: the next round reads it again and decides anew.
          const reason = apiError(e)?.detail.reason;
          if (reason !== "precondition" && reason !== "not_found") throw e;
        }
        continue;
      }
      // A deletion of ours for another event ID is no longer pending. One for this event stays pending while
      // the event is still there: the delete may have been given up and can still land. It ends only when a
      // write of ours changes the event (and with it the etag the late delete is conditional on) or when the
      // event is seen gone and the row is settled.
      if (row.removing_event_id !== null && row.removing_event_id !== eventId) {
        await lease.write({ removing_event_id: null });
        row = { ...row, removing_event_id: null };
      }
      const removalPending = row.removing_event_id !== null && live(remote);
      // No live event, while a write of ours there may still land: nothing can be concluded from its absence
      // until that write is fenced.
      const missingUnfenced = !live(remote) && unfenced(row, calendarId, eventId);
      // Delivered and not suppressed, yet no live event, and not a deletion of our own in flight: someone
      // else removed it, which is the owner.
      const ownerDeleted = row.projected_revision !== null && row.state !== "suppressed" && row.removing_event_id === null && !live(remote) && !payload.restore && !missingUnfenced;

      if (want.absent) {
        if (missingUnfenced) {
          // Fence it without bringing the event back into view, then decide anew. Its absence was observed
          // before the fence, so it is not taken as the owner's deletion.
          await fenceMissing(w, calendarId, eventId, remote);
          fencedMissing = true;
          continue;
        }
        if (live(remote)) {
          // The intent to delete is recorded first and the delivered basis stays: an event deleted by our
          // own hand never reads as the owner's deletion, and a delete that fails keeps what was delivered.
          const etag = requireEtag(remote!);
          await lease.markIntent(eventId);
          try {
            await mutate(calendarId, eventId, () => w.deleteEvent(userId, calendarId, eventId, etag));
          } catch (e) {
            // A definite refusal means the delete did not happen: the intent is withdrawn at once, so an
            // owner's deletion before the next read is still his. Otherwise the intent stays, to be settled
            // by the next read of the event.
            if (definitelyNotDeleted(e)) await lease.withdrawIntent(eventId);
            // The event changed since it was read (the owner edited it): read it again and decide anew.
            if (apiError(e)?.detail.reason === "precondition") continue;
            throw e;
          }
          if (!(await fencedAfterDelete(w, calendarId, eventId))) continue;
        }
        // A restore, the end of a pause or a new board may have landed during the delete: go round again.
        if ((await desiredState(deps, userId, payload)).key !== want.key) continue;
        await settle({ state: "projected" }, { state: "suppressed", suppression_reason: ownerDeleted && !fencedMissing ? "deleted_externally" : want.absent, projected_revision: null, etag: null, removing_event_id: null, ...(await settledFields(calendarId, eventId)), last_error: note, last_verified_at: toInstant(clock()) });
        return "removed";
      }

      const { doc, text, write } = want.present!;
      if (missingUnfenced && row.projected_revision !== null && row.state !== "suppressed" && row.removing_event_id === null && !payload.restore) {
        // It looks deleted by the owner, but a write of ours may still recreate it: fence that write first
        // (without bringing the event back), then decide anew.
        await fenceMissing(w, calendarId, eventId, remote);
        continue;
      }
      if (ownerDeleted) {
        if (!(await lease.write({ state: "suppressed", suppression_reason: "deleted_externally", last_error: null }, "projected_revision IS NOT NULL AND state != 'suppressed'"))) continue;
        await settle({ state: "cancelled" });
        return "suppressed_deleted_externally";
      }

      let written: ManagedEvent | null = null;
      let duplicate = false;
      // A removal or another write of ours may still land: the event is written even when it already shows
      // this write, with a fresh fence value, so the late call's etag is stale.
      const mustFence = removalPending || unfenced(row, calendarId, eventId);
      if (carriesWrite(remote, write, text) && !mustFence) {
        written = remote; // exactly this write already landed (a retried or duplicate effect): nothing to write
      } else {
        try {
          // The text this write carries is recorded first: if it lands unverified, its lines stay ours. The
          // history is bounded only while no write of ours is outstanding; until then every text is kept.
          if (attemptedOf(row)[0] !== text) {
            const history = [text, ...attemptedOf(row).filter((t) => t !== text)];
            await lease.write({ attempted_text: JSON.stringify(uncertainOf(row).length > 0 ? history : history.slice(0, 8)) });
          }
          if (remote === null) {
            written = await mutate(calendarId, eventId, () => w.insertEvent(userId, calendarId, eventId, write));
          } else {
            const description = mergeDescription(remote.description, row.managed_text, write.description, attemptedOf(row));
            // A patch keeps private properties it does not send: a fence of ours (a tombstone) brought back
            // as the board's event has its tombstone mark cleared explicitly.
            const base = remote.privateProperties[TOMBSTONE_PROPERTY] !== undefined ? { ...write.privateProperties, [TOMBSTONE_PROPERTY]: "0" } : write.privateProperties;
            const privateProperties = mustFence ? { ...base, [FENCE_PROPERTY]: crypto.randomUUID() } : base;
            written = await mutate(calendarId, eventId, () => w.patchEvent(userId, calendarId, eventId, { ...write, privateProperties, description, ...(remote.status === "cancelled" ? { status: "confirmed" as const } : {}) }, requireEtag(remote)));
          }
        } catch (e) {
          const api = apiError(e);
          if (!api) throw e;
          // Lost conditional update, an ID that already exists, an event gone meanwhile, or an uncertain
          // outcome: retrieve the event by its ID and decide from what is actually there.
          if (api.detail.reason === "duplicate") duplicate = true;
          else if (api.detail.reason !== "precondition" && api.detail.reason !== "not_found" && !api.detail.retryable) throw e;
        }
      }

      const check = await w.getEvent(userId, calendarId, eventId);
      if (duplicate && check === null) {
        // The ID is taken although no event can be read under it (a deleted event whose ID Google keeps):
        // an insert there can never succeed. The event moves to a replacement ID derived from this one,
        // the same on every attempt, so a lost response still finds the event it created. Nothing of ours can
        // land under the taken ID any more (an insert fails the same way, and there is no event to change).
        const replacement = await managedEventId(userId, `${payload.scope}|after-deletion|${eventId}`, payload.localDate);
        await lease.write({ event_id: replacement, etag: null, projected_revision: null, ...(await settledFields(calendarId, eventId)) });
        continue;
      }
      // Only a read-back showing every managed field as written counts, and only while D1 still wants
      // exactly that write; otherwise nothing of the managed basis is recorded and the round repeats.
      if (!check || !carriesWrite(check, write, text)) continue;
      // A write of this round got no definite answer: it may still land after the read-back, so fence it first.
      if (unfenced(await readRow(), calendarId, eventId)) continue;
      if ((await desiredState(deps, userId, payload)).key !== want.key) continue;
      // Texts of unverified writes stay recorded while a write of ours elsewhere (an earlier calendar not yet
      // cleaned up) may still land: its lines must stay recognisable as ours if the event moves back there.
      const remaining = await settledFields(calendarId, eventId);
      await settle({ state: "projected" }, { state: "projected", suppression_reason: null, board_id: doc.boardId, calendar_id: calendarId, projected_revision: doc.revision, etag: check.etag ?? written?.etag ?? null, managed_text: text, ...(remaining.uncertain_calendars === null ? { attempted_text: null } : {}), removing_event_id: null, ...remaining, last_verified_at: toInstant(clock()), last_error: note });
      return "projected";
    }
    await lease.write({ last_error: "the event could not be verified after writing" });
    return retryLater("read-back did not verify the projected revision", "retry", 60_000);
  };

  const fail = async (e: unknown): Promise<ProjectionOutcome> => {
    // The lease was lost: the projector holding it now decides, and this effect's claim simply runs out.
    if (e instanceof LeaseLostError) return "busy";
    if (e instanceof CallAbandonedError) {
      // The abandoned call may still land: the next attempt waits until this lease has run out.
      await lease.write({ last_error: "a Calendar call was given up; delivery resumes once it can no longer land" });
      return retryLater(e.message, "retry", PROJECTION_LEASE_MS);
    }
    if (e instanceof LeaseTooShortError) {
      await lease.write({ last_error: "a Calendar call could not start within the projection lease" });
      return retryLater(e.message, "retry", 15_000);
    }
    if (isNotConnected(e)) {
      await recordConnectionFailure("Google Calendar is not connected");
      return retryLater("calendar not connected", "not_connected", 30 * 60_000);
    }
    const api = apiError(e);
    const message = api ? `calendar error${api.detail.status ? ` ${api.detail.status}` : ""}${api.detail.reason ? ` (${api.detail.reason})` : ""}` : String((e as Error)?.message ?? e).slice(0, 200);
    if (api && !api.detail.retryable) {
      await recordFailure(message, true);
      await settle({ state: "failed" });
      return "failed";
    }
    await recordFailure(message, effect.attempts >= MAX_ATTEMPTS);
    return retryLater(message, "retry", Math.min(15 * 60_000, 30_000 * 2 ** Math.min(effect.attempts, 5)));
  };

  try {
    return await run();
  } catch (e) {
    try {
      return await fail(e);
    } catch (inner) {
      // The lease was lost while recording the failure: the projector holding it now decides.
      if (inner instanceof LeaseLostError) return "busy";
      // Anything else: the claim is released for a later retry, never before a lease kept for a given-up
      // call has run out (the next attempt could not take it, and the call may land until then).
      const kept = lease.keptUntil();
      await settleClaimed(db, effect, { state: "retry", error: String((inner as Error)?.message ?? inner).slice(0, 200), retryAtMs: Math.max(clock() + 60_000, kept === null ? 0 : kept + 1_000) }, nowMs);
      return "retry";
    }
  } finally {
    // Only our own lease is released; a lease that ran out and was taken by another projector stays theirs.
    await lease.release().catch(() => undefined);
  }
}

/** Claim and deliver due Calendar projection effects. Safe to call repeatedly and concurrently. */
export async function projectCalendarEffects(deps: DailyDeps, opts: { nowMs?: number; limit?: number } = {}): Promise<{ effectId: string; userId: string; targetKey: string; outcome: ProjectionOutcome }[]> {
  const nowMs = opts.nowMs ?? deps.clock?.() ?? Date.now();
  const effects = await claimDueEffects(deps.db, { nowMs, kinds: [CALENDAR_EFFECT_KIND], limit: opts.limit ?? 20 });
  const out: { effectId: string; userId: string; targetKey: string; outcome: ProjectionOutcome }[] = [];
  for (const effect of effects) {
    let outcome: ProjectionOutcome;
    try {
      outcome = await projectOne(deps, effect, nowMs);
    } catch (e) {
      await settleClaimed(deps.db, effect, { state: "retry", error: String((e as Error)?.message ?? e).slice(0, 200), retryAtMs: nowMs + 60_000 }, nowMs);
      outcome = "retry";
    }
    out.push({ effectId: effect.effectId, userId: effect.userId, targetKey: effect.targetKey, outcome });
  }
  return out;
}
