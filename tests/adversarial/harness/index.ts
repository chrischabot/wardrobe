/**
 * Shared harness of the adversarial suite (SHARED FILE, owned by the domain adversarial thread).
 *
 * Everything an adversarial test needs to attack the REAL application is importable from here:
 *
 *  1. The whole Worker inside workerd, through its real `fetch` handler (`SELF.fetch`): OAuth provider,
 *     router, authentication, the one command service, local D1 with every migration, KV, R2, the queue
 *     and the conversation actor. `provisionOwner()` creates an owner the way a deployment does and
 *     gives a signed-in API client; `connectMcp()` connects a real MCP client through the real OAuth
 *     flow. (Re-exported from `@garderobe/worker/testing`.)
 *  2. The command service directly on the same local D1, with a clock the test moves
 *     (`createLedgerHarness()`), for races, replay storms and date edges that need a fixed time.
 *  3. The labelled doubles of EXTERNAL services (weather, Calendar) and the helpers that script them
 *     (re-exported from the journey suite's `world.ts`). Nothing inside the Worker is replaced.
 *  4. Helpers for adversarial assertions on actual state: `ledgerFingerprint` / `ledgerDiff` ("this
 *     refused command wrote nothing, anywhere"), `refusal` (the typed error of a refused command),
 *     `defect` (an open product defect kept as an expected failure).
 *
 * Owner data: `provisionOwner({ real: true })` and `createLedgerHarness().createRealOwner()` import the
 * owner's real profile and inventory through the real importer. Every other owner is a labelled
 * SYNTHETIC fixture; boundary cases use those and say so in the test name or description.
 */
import { all, isCommandError, sha256Hex, type CommandRegistry, type Db } from "@garderobe/domain";
import { createHarness, testDatabase, type Harness } from "@garderobe/domain/testing";
import { testApp } from "@garderobe/worker/testing";

/* The real Worker: sign-in, API client, owners, MCP client, fake model, uploads, event streams. */
export * from "@garderobe/worker/testing";

/* The command service on the same D1 with a controllable clock. */
export { createHarness as createFoundationHarness, ownerDocuments, testDatabase, TestClock, SYNTHETIC_WARDROBE, SYNTHETIC_LABEL } from "@garderobe/domain/testing";
export type { ExecOptions, Harness as LedgerHarness, SyntheticGarment, TestOwner as LedgerOwner } from "@garderobe/domain/testing";

/* External doubles (weather, Calendar), scheduled runs and readers shared with the journey suite. */
export {
  LONDON,
  addDays,
  boardTexts,
  calendarFaults,
  calendarState,
  committed,
  connectGoogle,
  connectOutfitCalendar,
  editCalendarEvent,
  eventsOn,
  exec,
  internalCodesIn,
  isoWeekday,
  liveAt,
  localDate,
  mcpCommand,
  newPlace,
  quantityIn,
  readCalendarFrom,
  realOwnerAt,
  refused,
  runCron,
  scriptWeather,
  seedCalendar,
  settleRun,
  sleep,
  weatherDown,
  wholeWardrobe,
} from "../../journeys/src/world.ts";
export type { ApiError, CalendarDoubleState, JourneyOwner, McpCommandOutcome, TestPlace, WardrobeItem } from "../../journeys/src/world.ts";
export type { DayScript } from "../../journeys/src/outbound.ts";

export { defect, STRICT } from "./defect.ts";

/** Marks a constructed case in a test title: it is not the owner's wardrobe, history or profile. */
export const SYNTHETIC = "[synthetic]";
/** Marks a case that runs on the owner's real imported profile and inventory. */
export const REAL = "[real owner data]";

/* ------------------------------------------------------------------ */
/* The command service with a clock the test controls                   */
/* ------------------------------------------------------------------ */

/**
 * The real command service on the real local D1 of this run, with a manually advanced clock (default
 * start 2026-09-15T08:00:00Z).
 *  - default: the foundation registry (every foundation command; no lane commit hooks), which is what
 *    ledger tests want: nothing but the command under attack writes.
 *  - `composed: true`: the Worker's own composed registry (foundation plus the daily, assistant and
 *    media lanes with their commit hooks), still with the controllable clock. Lane code that reads the
 *    wall clock itself is not moved by it.
 */
export async function createLedgerHarness(options: { startAt?: string; composed?: boolean; registry?: CommandRegistry } = {}): Promise<Harness> {
  const registry = options.registry ?? (options.composed ? (await testApp()).registry : undefined);
  return createHarness({ ...(registry ? { registry } : {}), ...(options.startAt ? { startAt: options.startAt } : {}) });
}

/* ------------------------------------------------------------------ */
/* Refusals                                                             */
/* ------------------------------------------------------------------ */

export interface Refusal {
  code: string;
  message: string;
  details: Record<string, any>;
}

/**
 * The typed error of a command the service must refuse. Fails the test when the command was accepted,
 * or when it failed with anything other than a `CommandError` (a crash is not a refusal).
 */
export async function refusal(attempt: Promise<unknown> | (() => Promise<unknown>)): Promise<Refusal> {
  let value: unknown;
  try {
    value = await (typeof attempt === "function" ? attempt() : attempt);
  } catch (error) {
    if (isCommandError(error)) return { code: error.code, message: error.message, details: error.details as Record<string, any> };
    throw new Error(`expected a typed refusal, but the command crashed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  }
  throw new Error(`expected a refusal, but the command was accepted: ${JSON.stringify(value)?.slice(0, 600)}`);
}

/* ------------------------------------------------------------------ */
/* Ledger fingerprint: what is stored for one owner, in every table     */
/* ------------------------------------------------------------------ */

export type LedgerFingerprint = Record<string, { rows: number; digest: string }>;

const INTERNAL_TABLE = /^(sqlite_|_cf_|d1_)/;
let ownerTables: Promise<string[]> | null = null;

/** Every table of the local database that keeps rows per owner (has a `user_id` column). */
export function ownerScopedTables(): Promise<string[]> {
  ownerTables ??= (async () => {
    const db = await testDatabase();
    const names = await all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    const out: string[] = [];
    for (const { name } of names) {
      if (INTERNAL_TABLE.test(name)) continue;
      try {
        await db.prepare(`SELECT user_id FROM "${name}" LIMIT 0`).all();
        out.push(name);
      } catch {
        // no user_id column: not an owner-scoped table
      }
    }
    return out;
  })();
  return ownerTables;
}

/**
 * A fingerprint of EVERYTHING the database holds for one owner: per owner-scoped table, the number of
 * rows and a digest of their full content. Take one before an attack and compare after it with
 * `ledgerDiff`: an empty difference proves the refused command wrote nothing (no orphan receipt, no
 * partial mutation, no queued effect), which a status code alone does not.
 */
export async function ledgerFingerprint(userId: string, db?: Db): Promise<LedgerFingerprint> {
  const database = db ?? (await testDatabase());
  const out: LedgerFingerprint = {};
  for (const table of await ownerScopedTables()) {
    const rows = await all<Record<string, unknown>>(database, `SELECT * FROM "${table}" WHERE user_id = ?`, userId);
    if (rows.length === 0) continue;
    const lines = rows.map((row) => JSON.stringify(Object.keys(row).sort().map((key) => [key, row[key]]))).sort();
    out[table] = { rows: rows.length, digest: await sha256Hex(lines.join("\n")) };
  }
  return out;
}

/** The tables whose content for the owner differs between two fingerprints, as `table (rows before -> after)`. */
export function ledgerDiff(before: LedgerFingerprint, after: LedgerFingerprint, options: { ignore?: string[] } = {}): string[] {
  const ignore = new Set(options.ignore ?? []);
  const changed: string[] = [];
  for (const table of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (ignore.has(table)) continue;
    const a = before[table];
    const b = after[table];
    if (a?.digest !== b?.digest) changed.push(`${table} (${a?.rows ?? 0} -> ${b?.rows ?? 0})`);
  }
  return changed;
}
