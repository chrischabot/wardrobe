import { beforeAll, describe, expect, it } from "vitest";
import { Rng, SYNTHETIC_WARDROBE, addDays, createWorld, defect, fingerprint, inventory, ownerDay, quantityIn, sleep, sql, submit, syntheticOwner, type ApiErrorBody, type TestOwner, type World } from "../src/harness.ts";

/*
 * THREAT CLASS 13: property-based ledger invariants.
 *
 * Long seeded random sequences of real commands (valid and invalid, interleaved between the real owner's
 * imported wardrobe and two LABELLED SYNTHETIC owners whose garment IDs are identical on purpose, with random
 * replays of earlier idempotency keys, random undos and random occurrence times in the last days) are sent to
 * the real Worker over its HTTP API. After every step the real D1 tables are read and checked:
 *
 *   1. no balance is negative, and every garment's balances are what its stock journal implies (the journal
 *      is replayed HERE, by `replayJournal` below, written for this suite and sharing no code with the product);
 *   2. no row of any table that has a `user_id` and a `garment_id` names a garment of another owner, and an
 *      owner's set of garment IDs changes only by that owner's own committed `garment.create`;
 *   3. at most one counted wear per garment and local day, backed by exactly one unit of stock movement;
 *   4. every committed command has exactly one receipt, and every refused command wrote nothing;
 *   5. undo then redo returns to an identical balance fingerprint.
 *
 * Seeds: a fixed list plus one derived from the clock. EVERY assertion message names its seed and step,
 * the ordered list of seeds already run in this file's world and when that world was made (`beginSeed`).
 * A seed alone does NOT reproduce a failure: all seeded parts share one world and build on what earlier
 * parts left (garments created, packed pieces, the history that undo and replay draw from), and occurrence
 * times and wearing dates are drawn relative to the clock. Reproducing a failure means running exactly the
 * listed seeds, in that order, from a fresh world, with the clock near the recorded time (a clock-derived
 * seed is pinned by putting it in `FIXED_SEEDS` at the same position in that order).
 *
 * Specification: section 5 ("Quantity and laundry", "One counted wear per garment and wearing date"),
 * section 8 ("A command is a verified change", "Concurrent actions and external effects"), section 15
 * ("Ownership across every service"), section 17 rows "Quantities", "Wear correction", "Concurrency".
 */

const FIXED_SEEDS = [1, 20261003, 0xc0ffee, 987654321] as const;
const CLOCK_SEED = Date.now() >>> 0;
const STEPS_PER_SEED = 64;

/** When this file's world was made, and every seed run in it so far, in the order they ran. */
let worldStartedAt = "";
const seedsRun: number[] = [];

/**
 * Start a seeded part of this file and return the label its failures carry: the seed, every seed run in
 * this world before it and itself (in order), and when the world was made. Seeds share the world and its
 * accumulated state, so a failure is reproduced by running that whole ordered list from a fresh world,
 * never by its own seed alone.
 */
function beginSeed(seed: number): string {
  seedsRun.push(seed);
  return `seed=${seed} [seeds run in this world, in order: ${seedsRun.join(", ")}; world made ${worldStartedAt}; reproduce by running them in this order from a fresh world]`;
}

const NOTE = "synthetic test fixture - not the owner's wardrobe";
const MINUTE = 60_000;
const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/* ------------------------------------------------------------------ */
/* The suite's own replay of the stock journal                          */
/* ------------------------------------------------------------------ */

interface JournalEvent {
  seq: number;
  kind: string;
  payload: Record<string, any>;
  at: number;
  voided: boolean;
}
interface Holding {
  quantity: number;
  held: boolean;
  lost: boolean;
  since: number;
}
type Totals = Record<"incoming" | "clean" | "dirty" | "service" | "storage" | "tailor" | "trip" | "gone", number>;

/** Event kinds this replay understands. Anything else makes the garment "unsupported" (reported, not guessed). */
const KNOWN_KINDS = new Set(["receive", "arrive", "wear", "extra_unit", "mark_dirty", "wash", "pickup", "return", "exception", "pack", "unpack", "retire", "reconcile"]);

/**
 * What a garment's quantities must be, from its journal alone: events in order of occurrence (the opening
 * stock of a garment recorded as already owned first, then by time of occurrence, then by journal order),
 * voided events skipped, every movement limited to the units that exist. Returns units per bucket.
 */
function replayJournal(careChannel: string, events: JournalEvent[]): Totals {
  const laundered = careChannel !== "none";
  let incoming = 0;
  let clean = 0;
  let dirty = 0;
  let storage = 0;
  let tailor = 0;
  let gone = 0;
  const service = new Map<string, Holding>();
  const trips = new Map<string, { clean: number; worn: number }>();
  const opening = (e: JournalEvent) => e.kind === "receive" && e.payload.opening === true;
  const ordered = events.filter((e) => !e.voided).sort((a, b) => Number(opening(b)) - Number(opening(a)) || a.at - b.at || a.seq - b.seq);

  const atService = () => [...service.values()].reduce((n, h) => n + h.quantity, 0);
  const packed = () => [...trips.values()].reduce((n, t) => n + t.clean + t.worn, 0);
  const owned = () => clean + dirty + storage + tailor + atService() + packed();
  /** Take up to n units from the laundry holdings: batches still out first (oldest first), then held ones if allowed. */
  const fromService = (n: number, allowHeld: boolean, allowLost = true): number => {
    let taken = 0;
    for (const [ref, h] of [...service.entries()].sort((a, b) => Number(a[1].held) - Number(b[1].held) || a[1].since - b[1].since)) {
      if (taken >= n) break;
      if (h.held && !allowHeld) continue;
      if (h.lost && !allowLost) continue;
      const q = Math.min(h.quantity, n - taken);
      h.quantity -= q;
      taken += q;
      if (h.quantity === 0) service.delete(ref);
    }
    return taken;
  };
  const fromTrips = (n: number, except?: string): number => {
    let taken = 0;
    for (const [ref, t] of [...trips.entries()]) {
      if (ref === except) continue;
      const c = Math.min(t.clean, n - taken);
      t.clean -= c;
      taken += c;
      const w = Math.min(t.worn, n - taken);
      t.worn -= w;
      taken += w;
      if (t.clean + t.worn === 0) trips.delete(ref);
    }
    return taken;
  };
  /** The owner says a unit is somewhere the ledger does not show one: it comes from wherever the ledger had it. */
  const fromElsewhere = (exceptTrip?: string): boolean => {
    if (fromService(1, true) === 1) return true;
    if (tailor > 0) return (tailor -= 1), true;
    if (storage > 0) return (storage -= 1), true;
    if (fromTrips(1, exceptTrip) === 1) return true;
    if (incoming > 0) return (incoming -= 1), true;
    return false;
  };

  for (const e of ordered) {
    const p = e.payload;
    switch (e.kind) {
      case "receive": {
        const q = Number(p.quantity ?? 1);
        const to = String(p.to ?? "clean");
        if (to === "incoming") incoming += q;
        else if (to === "storage") storage += q;
        else if (to === "tailor") tailor += q;
        else clean += q;
        break;
      }
      case "arrive": {
        const q = Math.min(Number(p.quantity ?? incoming), incoming);
        incoming -= q;
        clean += q;
        break;
      }
      case "wear":
      case "extra_unit": {
        if (p.statisticOnly) break;
        const count = e.kind === "extra_unit" ? Number(p.quantity ?? 1) : 1;
        for (let i = 0; i < count; i++) {
          const trip = typeof p.tripId === "string" ? trips.get(p.tripId) : undefined;
          if (trip && trip.clean > 0) {
            if (laundered) {
              trip.clean -= 1;
              trip.worn += 1;
            }
            continue;
          }
          if (trip && trip.worn > 0) continue;
          if (!laundered) {
            // Never-laundered pieces: a wear moves nothing, except that it shows a unit is with the owner.
            if (clean === 0 && fromElsewhere()) clean += 1;
            continue;
          }
          if (clean > 0) {
            clean -= 1;
            dirty += 1;
          } else if (dirty === 0 && fromElsewhere()) {
            dirty += 1;
          }
        }
        break;
      }
      case "mark_dirty": {
        if (!laundered) break;
        const want = Number(p.quantity ?? 1);
        const q = Math.min(want, clean);
        clean -= q;
        dirty += q;
        for (let i = q; i < want; i++) {
          if (!fromElsewhere()) break;
          dirty += 1;
        }
        break;
      }
      case "wash": {
        const trip = typeof p.tripId === "string" ? trips.get(p.tripId) : undefined;
        if (trip) {
          const q = Math.min(Number(p.quantity ?? trip.worn), trip.worn);
          trip.worn -= q;
          trip.clean += q;
          break;
        }
        const stated = p.quantity === undefined ? undefined : Number(p.quantity);
        const want = stated ?? Math.max(dirty, 1);
        const q = Math.min(want, dirty);
        dirty -= q;
        clean += q;
        let remaining = want - q;
        // A stated count, or "it is washed" about a garment with nothing clean at home, speaks for units at the laundry.
        while (remaining > 0 && (stated !== undefined || clean === 0)) {
          if (fromService(1, true, stated !== undefined) !== 1) break;
          clean += 1;
          remaining -= 1;
        }
        if (p.releaseAway && q === 0) {
          for (const [ref, h] of [...service.entries()]) {
            if (!h.held || h.lost || ref.startsWith("cycle:")) continue;
            clean += h.quantity;
            service.delete(ref);
          }
        }
        break;
      }
      case "pickup": {
        const q = Math.min(Number(p.quantity ?? 1), dirty);
        dirty -= q;
        if (q > 0) {
          const ref = String(p.batchId);
          const h = service.get(ref) ?? { quantity: 0, held: false, lost: false, since: e.at };
          h.quantity += q;
          service.set(ref, h);
        }
        break;
      }
      case "return": {
        const ref = String(p.batchId);
        const h = service.get(ref);
        if (!h) break;
        const q = Math.min(Number(p.quantity ?? h.quantity), h.quantity);
        h.quantity -= q;
        clean += q;
        if (h.quantity === 0) service.delete(ref);
        else if (Number(p.stillAway ?? 0) > 0) h.held = true;
        break;
      }
      case "exception": {
        // A unit reported still away or lost is not at home, whatever the ledger assumed.
        const want = Number(p.quantity ?? 1);
        const ref = `exception:${p.exceptionId}`;
        const isLost = p.kind === "lost";
        let got = fromService(want, false);
        if (isLost && got < want) {
          for (const [heldRef, h] of [...service.entries()].sort((a, b) => a[1].since - b[1].since)) {
            if (got >= want) break;
            if (!h.held || h.lost || heldRef === ref) continue;
            const q = Math.min(h.quantity, want - got);
            h.quantity -= q;
            got += q;
            if (h.quantity === 0) service.delete(heldRef);
          }
        }
        const fromClean = Math.min(want - got, clean);
        clean -= fromClean;
        got += fromClean;
        const fromDirty = Math.min(want - got, dirty);
        dirty -= fromDirty;
        got += fromDirty;
        if (got > 0) {
          const h = service.get(ref) ?? { quantity: 0, held: true, lost: false, since: e.at };
          h.quantity += got;
          h.held = true;
          if (isLost) h.lost = true;
          service.set(ref, h);
        }
        break;
      }
      case "pack": {
        const ref = String(p.tripId);
        const want = Number(p.quantity ?? 1);
        const t = trips.get(ref) ?? { clean: 0, worn: 0 };
        const c = Math.min(want, clean);
        clean -= c;
        t.clean += c;
        const d = Math.min(want - c, dirty);
        dirty -= d;
        t.worn += d;
        // Further units the owner says are packed come from wherever else the ledger had them; what is
        // already in this suitcase stays as it is.
        for (let i = c + d; i < want; i++) {
          if (!fromElsewhere(ref)) break;
          t.clean += 1;
        }
        if (t.clean + t.worn > 0) trips.set(ref, t);
        break;
      }
      case "unpack": {
        const ref = String(p.tripId);
        const t = trips.get(ref);
        if (!t) break;
        const want = Number(p.quantity ?? t.clean + t.worn);
        const w = Math.min(want, t.worn);
        const c = Math.min(want - w, t.clean);
        t.worn -= w;
        t.clean -= c;
        // Unpacking brings units home without declaring them clean.
        if (laundered) dirty += c + w;
        else clean += c + w;
        if (t.clean + t.worn === 0) trips.delete(ref);
        break;
      }
      case "retire": {
        let want = Number(p.quantity ?? owned() + incoming);
        const take = (available: number, apply: (q: number) => void) => {
          const q = Math.min(want, available);
          if (q > 0) {
            apply(q);
            want -= q;
            gone += q;
          }
        };
        take(clean, (q) => (clean -= q));
        take(dirty, (q) => (dirty -= q));
        take(storage, (q) => (storage -= q));
        take(tailor, (q) => (tailor -= q));
        take(atService(), (q) => void fromService(q, true));
        take(packed(), (q) => void fromTrips(q));
        take(incoming, (q) => (incoming -= q));
        break;
      }
      case "reconcile": {
        const counts = (p.counts ?? {}) as { clean?: number; dirty?: number; storage?: number; total?: number };
        const current = (b: "clean" | "dirty" | "storage") => (b === "clean" ? clean : b === "dirty" ? dirty : storage);
        const change = (b: "clean" | "dirty" | "storage", q: number) => {
          if (b === "clean") clean += q;
          else if (b === "dirty") dirty += q;
          else storage += q;
        };
        const stated = new Set(Object.keys(counts).filter((k) => k !== "total"));
        if (counts.total !== undefined) {
          let diff = counts.total - owned();
          if (diff > 0) clean += diff;
          for (const b of ["dirty", "clean", "storage"] as const) {
            if (diff >= 0) break;
            const q = Math.min(-diff, current(b));
            change(b, -q);
            diff += q;
          }
        }
        for (const b of ["clean", "dirty", "storage"] as const) {
          const target = counts[b];
          if (target === undefined) continue;
          let delta = target - current(b);
          if (delta > 0) {
            // The counted units come from the buckets the owner did not count, then are simply more units.
            for (const donor of ["dirty", "clean", "storage"] as const) {
              if (delta === 0) break;
              if (donor === b || stated.has(donor)) continue;
              const q = Math.min(delta, current(donor));
              change(donor, -q);
              change(b, q);
              delta -= q;
            }
            if (delta > 0 && b === "clean") {
              const q = fromService(delta, false);
              clean += q;
              delta -= q;
            }
            if (delta > 0 && counts.total === undefined) change(b, delta);
          } else if (delta < 0) {
            const candidate = b === "clean" ? "dirty" : "clean";
            change(b, delta);
            if (!stated.has(candidate) && (laundered || candidate !== "dirty")) change(candidate, -delta);
          }
        }
        break;
      }
      default:
        throw new Error(`replayJournal: unsupported event kind ${e.kind}`);
    }
  }
  return { incoming, clean, dirty, service: atService(), storage, tailor, trip: packed(), gone };
}

/* ------------------------------------------------------------------ */
/* Owners, baselines and invariant checks                               */
/* ------------------------------------------------------------------ */

interface Actor {
  owner: TestOwner;
  label: string;
  synthetic: boolean;
  /** Garment IDs this owner may name in a valid command. */
  pool: string[];
  /** Garment IDs that exist only for another owner. */
  foreign: string[];
  tripId: string;
  today: string;
  /** Expected garment ID set (changes only by this owner's committed garment.create). */
  garmentIds: Set<string>;
  /**
   * Garments a pack command was already generated for. A random sequence packs a garment at most once:
   * re-stating that an already packed piece is packed is covered by its own test (defect L13-2).
   */
  packed: Set<string>;
}

interface Sent {
  actor: Actor;
  type: string;
  payload: Record<string, unknown>;
  opts: { idempotencyKey: string; expectedVersions?: Record<string, number>; occurredAt?: string };
  commandId: string;
  outcome: string;
}

interface Planned {
  type: string;
  payload: Record<string, unknown>;
  opts: { idempotencyKey: string; expectedVersions?: Record<string, number>; occurredAt?: string };
  /** `refuse`: the command must not be accepted. `replay`: it must answer with this stored command. */
  expect: "any" | "refuse" | "accept";
  replayOf?: Sent;
  /** Another owner's command whose key and body are reused: its receipt must never be returned to this owner. */
  foreignOf?: Sent;
}

let world: World;
let actors: Actor[] = [];
const history: Sent[] = [];
const baseline = new Map<string, Record<string, unknown>>();
const createdIds = Array.from({ length: 10 }, (_, i) => `syn13-shared-${i}`);
let keyCounter = 0;
const nextKey = (seed: number): string => `adv13-${seed}-${++keyCounter}-${crypto.randomUUID().slice(0, 8)}`;
const stats = { sent: 0, committed: 0, refused: 0, replayed: 0, undone: 0 };

async function stableFingerprint(actor: Actor): Promise<Record<string, unknown>> {
  let previous = await fingerprint(actor.owner);
  if (actor.synthetic) return previous;
  // The real owner's follow-up work after a commit (if any) is allowed to finish before the baseline is taken.
  for (let i = 0; i < 20; i++) {
    await sleep(10);
    const next = await fingerprint(actor.owner);
    if (JSON.stringify(next) === JSON.stringify(previous)) return next;
    previous = next;
  }
  return previous;
}

/** Invariants 1, 3 and 4 (and the garment-set half of 2) for one owner, read from D1. */
async function checkLedger(actor: Actor, label: string): Promise<void> {
  const userId = actor.owner.userId;

  // 1. Balances: none negative, and each garment's buckets are what its journal implies.
  const [balances, garments, journal] = await Promise.all([
    sql<{ garment_id: string; bucket: string; quantity: number }>("SELECT garment_id, bucket, quantity FROM stock_balances WHERE user_id = ?", userId),
    sql<{ garment_id: string; care_channel: string }>("SELECT garment_id, care_channel FROM garments WHERE user_id = ?", userId),
    sql<{ seq: number; garment_id: string | null; kind: string; payload_json: string; occurred_at: string; voided_by_command_id: string | null }>("SELECT seq, garment_id, kind, payload_json, occurred_at, voided_by_command_id FROM stock_events WHERE user_id = ? ORDER BY seq", userId),
  ]);
  const stored = new Map<string, Totals>();
  const empty = (): Totals => ({ incoming: 0, clean: 0, dirty: 0, service: 0, storage: 0, tailor: 0, trip: 0, gone: 0 });
  for (const b of balances) {
    expect(b.quantity, `${label}: ${b.garment_id} ${b.bucket} is negative`).toBeGreaterThanOrEqual(0);
    const t = stored.get(b.garment_id) ?? empty();
    t[b.bucket as keyof Totals] += b.quantity;
    stored.set(b.garment_id, t);
  }
  // Owner-level events (weekly baselines, cycle exceptions) are never produced by this suite's commands.
  expect(journal.filter((e) => e.garment_id === null && e.voided_by_command_id === null).map((e) => e.kind), `${label}: unexpected owner-level stock events`).toEqual([]);
  const byGarment = new Map<string, JournalEvent[]>();
  for (const row of journal) {
    if (row.garment_id === null) continue;
    const list = byGarment.get(row.garment_id) ?? [];
    list.push({ seq: row.seq, kind: row.kind, payload: JSON.parse(row.payload_json), at: Date.parse(row.occurred_at), voided: row.voided_by_command_id !== null });
    byGarment.set(row.garment_id, list);
  }
  for (const g of garments) {
    const events = byGarment.get(g.garment_id) ?? [];
    const unsupported = events.filter((e) => !e.voided && !KNOWN_KINDS.has(e.kind)).map((e) => e.kind);
    expect(unsupported, `${label}: ${g.garment_id} has journal events this suite does not replay`).toEqual([]);
    expect(stored.get(g.garment_id) ?? empty(), `${label}: balances of ${g.garment_id} differ from the replay of its ${events.length} journal events`).toEqual(replayJournal(g.care_channel, events));
  }
  for (const id of stored.keys()) expect(actor.garmentIds.has(id), `${label}: a balance exists for ${id}, which is not this owner's garment`).toBe(true);

  // 2 (first half). The owner's garment IDs are exactly the ones its own committed creations made.
  expect(garments.map((g) => g.garment_id).sort(), `${label}: the owner's garment set changed`).toEqual([...actor.garmentIds].sort());

  // 3. One counted wear per garment and local day, each backed by exactly one unit of stock movement.
  const daily = await sql<{ garment_id: string; wearing_date: string; observation_count: number; status: string; stock_event_id: string | null }>("SELECT garment_id, wearing_date, observation_count, status, stock_event_id FROM daily_wears WHERE user_id = ?", userId);
  const live = new Map((await sql<{ garment_id: string; wearing_date: string; n: number }>("SELECT garment_id, wearing_date, COUNT(*) AS n FROM wear_observations WHERE user_id = ? AND status = 'active' GROUP BY garment_id, wearing_date", userId)).map((r) => [`${r.garment_id}|${r.wearing_date}`, r.n]));
  const wearEvents = new Map<string, string[]>();
  for (const [garmentId, events] of byGarment) {
    for (const e of events) {
      if (e.kind !== "wear" || e.voided) continue;
      const key = `${garmentId}|${e.payload.wearingDate}`;
      wearEvents.set(key, [...(wearEvents.get(key) ?? []), String(e.seq)]);
    }
  }
  const seenKeys = new Set<string>();
  for (const d of daily) {
    const key = `${d.garment_id}|${d.wearing_date}`;
    expect(seenKeys.has(key), `${label}: two counted wears for ${key}`).toBe(false);
    seenKeys.add(key);
    const observations = live.get(key) ?? 0;
    expect({ status: d.status, count: d.observation_count }, `${label}: counted wear ${key} disagrees with its ${observations} live report(s)`).toEqual({ status: observations > 0 ? "active" : "retracted", count: observations });
    expect((wearEvents.get(key) ?? []).length, `${label}: counted wear ${key} (${d.status}) is backed by the wrong number of stock movements`).toBe(d.status === "active" ? 1 : 0);
  }
  for (const key of live.keys()) expect(seenKeys.has(key), `${label}: live wear reports for ${key} without a counted wear`).toBe(true);
  for (const key of wearEvents.keys()) expect(seenKeys.has(key), `${label}: a wear stock movement for ${key} without a counted wear`).toBe(true);

  // 4. One command, one receipt; nothing half-written.
  const broken = await sql<{ command_id: string }>(
    `SELECT command_id FROM commands WHERE user_id = ? AND (receipt_json IS NULL OR json_extract(receipt_json, '$.commandId') IS NOT command_id
       OR json_extract(receipt_json, '$.type') IS NOT type OR json_extract(receipt_json, '$.outcome') IS NOT outcome)`,
    userId,
  );
  expect(broken, `${label}: commands whose stored receipt is missing or is not their own`).toEqual([]);
  const orphans = await sql<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM stock_events e WHERE e.user_id = ?1 AND NOT EXISTS (SELECT 1 FROM commands c WHERE c.user_id = e.user_id AND c.command_id = e.command_id))
          + (SELECT COUNT(*) FROM stock_events e WHERE e.user_id = ?1 AND e.voided_by_command_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM commands c WHERE c.user_id = e.user_id AND c.command_id = e.voided_by_command_id))
          + (SELECT COUNT(*) FROM wear_observations o WHERE o.user_id = ?1 AND NOT EXISTS (SELECT 1 FROM commands c WHERE c.user_id = o.user_id AND c.command_id = o.command_id))
          + (SELECT COUNT(*) FROM command_entities x WHERE x.user_id = ?1 AND NOT EXISTS (SELECT 1 FROM commands c WHERE c.user_id = x.user_id AND c.command_id = x.command_id))
          + (SELECT COUNT(*) FROM stock_events e JOIN commands c ON c.user_id = e.user_id AND c.command_id = e.command_id WHERE e.user_id = ?1 AND c.outcome = 'noop')
          + (SELECT COUNT(*) FROM commands c WHERE c.user_id = ?1 AND c.undone_by_command_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM commands u WHERE u.user_id = c.user_id AND u.command_id = c.undone_by_command_id AND u.type = 'command.undo' AND u.undoes_command_id = c.command_id))
          + (SELECT COUNT(*) FROM command_preconditions) AS n`,
    userId,
  );
  expect(orphans[0]!.n, `${label}: rows without their command, events under a no-op command, a dangling undo link, or leftover precondition rows`).toBe(0);
}

let ownedTables: string[] | null = null;

/** Invariant 2 (second half): no row of any table with `user_id` and `garment_id` names a garment that is not its owner's. */
async function checkNoCrossOwnerReferences(label: string): Promise<void> {
  if (!ownedTables) {
    const tables = await sql<{ name: string; sql: string | null }>("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'");
    ownedTables = tables.filter((t) => t.name !== "garments" && /\buser_id\b/.test(t.sql ?? "") && /\bgarment_id\b/.test(t.sql ?? "")).map((t) => t.name);
    // The foundation's own garment-keyed tables must be among them, or this check would be looking at nothing.
    for (const required of ["stock_events", "stock_balances", "wear_observations", "daily_wears", "garment_aliases", "laundry_batch_items"]) expect(ownedTables, label).toContain(required);
  }
  const ids = actors.map((a) => a.owner.userId);
  for (const table of ownedTables) {
    const stray = await sql<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} t WHERE t.user_id IN (${ids.map(() => "?").join(",")}) AND t.garment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM garments g WHERE g.user_id = t.user_id AND g.garment_id = t.garment_id)`,
      ...ids,
    );
    expect(stray[0]!.n, `${label}: ${table} has rows naming a garment that does not belong to the row's owner`).toBe(0);
  }
}

/* ------------------------------------------------------------------ */
/* Random commands                                                      */
/* ------------------------------------------------------------------ */

function randomInstant(rng: Rng): string {
  return iso(Date.now() - rng.int(2 * MINUTE, 5 * DAY));
}

/** A command the owner could legitimately send (it may still be refused for the state the ledger is in). */
function freshCommand(rng: Rng, actor: Actor, seed: number): Planned {
  const g = () => rng.pick(actor.pool);
  const some = (max: number) => [...new Set(Array.from({ length: rng.int(1, max) }, g))];
  const opts: Planned["opts"] = { idempotencyKey: nextKey(seed) };
  const timed = () => {
    if (rng.chance(0.35)) opts.occurredAt = randomInstant(rng);
  };
  const roll = rng.int(1, 100);
  if (roll <= 20) {
    const wearingDate = addDays(actor.today, -rng.int(0, 5));
    if (rng.chance(0.25)) opts.occurredAt = iso(Math.min(Date.now() - 2 * MINUTE, Date.parse(`${wearingDate}T12:00:00Z`) + rng.int(-6 * 60, 6 * 60) * MINUTE));
    const garmentIds = some(3);
    const onTrip = rng.chance(0.12);
    return { type: "wear.record", payload: { wearingDate, garmentIds, ...(onTrip ? { tripId: actor.tripId } : {}), ...(rng.chance(0.2) ? { segment: rng.pick(["day", "dinner"]) } : {}) }, opts, expect: "any" };
  }
  if (roll <= 27) {
    const wearingDate = addDays(actor.today, -rng.int(0, 5));
    return { type: "wear.amend", payload: rng.chance(0.5) ? { wearingDate, remove: some(2) } : { wearingDate, add: some(2), ...(rng.chance(0.3) ? { remove: [g()] } : {}) }, opts, expect: "any" };
  }
  if (roll <= 40) {
    timed();
    return { type: "care.mark_dirty", payload: { items: some(2).map((garmentId) => ({ garmentId, quantity: rng.int(1, 2) })) }, opts, expect: "any" };
  }
  if (roll <= 52) {
    timed();
    const variant = rng.int(1, 10);
    const payload = variant <= 6 ? { items: some(2).map((garmentId) => (rng.chance(0.5) ? { garmentId } : { garmentId, quantity: rng.int(1, 2) })) } : { allOfChannel: rng.pick(["service", "handwash"]) };
    return { type: "care.washed", payload, opts, expect: "any" };
  }
  if (roll <= 59) {
    timed();
    return { type: "laundry.collect", payload: rng.chance(0.3) ? { exclude: [g()] } : {}, opts, expect: "any" };
  }
  if (roll <= 66) {
    timed();
    return { type: "laundry.return", payload: rng.chance(0.2) ? { stillAway: [{ garmentId: g(), quantity: 1 }] } : {}, opts, expect: "any" };
  }
  if (roll <= 70) {
    timed();
    return { type: "laundry.report_exception", payload: { kind: rng.pick(["still_away", "lost"]), garmentId: g(), quantity: 1 }, opts, expect: "any" };
  }
  if (roll <= 79) {
    timed();
    const shape = rng.int(1, 5);
    const counts = shape === 1 ? { clean: rng.int(0, 4) } : shape === 2 ? { dirty: rng.int(0, 3) } : shape === 3 ? { total: rng.int(0, 5) } : shape === 4 ? { clean: rng.int(0, 3), dirty: rng.int(0, 3) } : { total: rng.int(1, 5), clean: rng.int(0, 2) };
    return { type: "stock.reconcile", payload: { garmentId: g(), counts }, opts, expect: "any" };
  }
  if (roll <= 85) {
    const unpacked = [...new Set(some(2))].filter((id) => !actor.packed.has(id));
    if (unpacked.length > 0) {
      for (const id of unpacked) actor.packed.add(id);
      return { type: "stock.pack", payload: { tripId: actor.tripId, items: unpacked.map((garmentId) => ({ garmentId, quantity: rng.int(1, 2) })) }, opts, expect: "any" };
    }
    timed();
    return { type: "care.mark_dirty", payload: { items: [{ garmentId: g(), quantity: 1 }] }, opts, expect: "any" };
  }
  if (roll <= 90) {
    timed();
    return { type: "stock.unpack", payload: rng.chance(0.5) ? { tripId: actor.tripId } : { tripId: actor.tripId, items: [{ garmentId: g() }] }, opts, expect: "any" };
  }
  if (roll <= 95 && actor.synthetic) {
    const garmentId = rng.pick(createdIds);
    const care = rng.pick(["service", "handwash", "none"] as const);
    return {
      type: "garment.create",
      payload: { garmentId, name: `SYNTHETIC ${garmentId} (invariant fixture)`, category: care === "handwash" ? "socks" : care === "none" ? "belt" : "shirt", roles: [care === "handwash" ? "socks" : care === "none" ? "belt" : "top"], careChannel: care, acquisition: "owned", quantity: rng.int(1, 3), isSynthetic: true, source: { kind: "owner_statement", note: NOTE } },
      opts,
      // Creating an ID this owner already has must be refused; a new one may be created.
      expect: actor.garmentIds.has(garmentId) ? "refuse" : "any",
    };
  }
  timed();
  return { type: "garment.retire", payload: { garmentId: g(), ...(rng.chance(0.7) ? { quantity: 1 } : {}), disposition: rng.pick(["sold", "donated", "discarded", "lost"]) }, opts, expect: "any" };
}

/** A command that must be refused whatever the state of the ledger. */
function invalidCommand(rng: Rng, actor: Actor, seed: number): Planned {
  const opts: Planned["opts"] = { idempotencyKey: nextKey(seed) };
  const g = () => rng.pick(actor.pool);
  const stranger = () => rng.pick(actor.foreign);
  const choices: (() => Omit<Planned, "opts" | "expect">)[] = [
    () => ({ type: "wear.record", payload: { wearingDate: actor.today, garmentIds: [g(), "syn13-no-such-garment"] } }),
    () => ({ type: "wear.record", payload: { wearingDate: actor.today, garmentIds: [stranger()] } }),
    () => ({ type: "wear.record", payload: { wearingDate: addDays(actor.today, rng.int(1, 30)), garmentIds: [g()] } }),
    () => ({ type: "wear.record", payload: { wearingDate: "2026-02-30", garmentIds: [g()] } }),
    () => ({ type: "wear.record", payload: { wearingDate: actor.today, garmentIds: [] } }),
    () => ({ type: "wear.amend", payload: { wearingDate: actor.today } }),
    () => ({ type: "wear.amend", payload: { wearingDate: actor.today, add: [stranger()] } }),
    () => ({ type: "care.mark_dirty", payload: { items: [{ garmentId: g(), quantity: rng.pick([0, -1, 1.5]) }] } }),
    () => ({ type: "care.mark_dirty", payload: { items: [{ garmentId: stranger(), quantity: 1 }] } }),
    () => ({ type: "care.washed", payload: {} }),
    () => ({ type: "care.washed", payload: { items: [{ garmentId: stranger() }] } }),
    () => ({ type: "laundry.collect", payload: { include: [{ garmentId: stranger(), quantity: 1 }] } }),
    () => ({ type: "laundry.return", payload: { batchId: "lb_syn13_no_such_batch" } }),
    () => ({ type: "laundry.report_exception", payload: { kind: "lost", garmentId: stranger() } }),
    () => ({ type: "laundry.report_exception", payload: { kind: "still_away" } }),
    () => ({ type: "stock.reconcile", payload: { garmentId: g(), counts: { clean: -1 } } }),
    () => ({ type: "stock.reconcile", payload: { garmentId: g(), counts: {} } }),
    () => ({ type: "stock.reconcile", payload: { garmentId: stranger(), counts: { clean: 2 } } }),
    () => ({ type: "stock.pack", payload: { tripId: actor.tripId, items: [] } }),
    () => ({ type: "stock.pack", payload: { tripId: actor.tripId, items: [{ garmentId: stranger(), quantity: 1 }] } }),
    () => ({ type: "garment.retire", payload: { garmentId: g(), disposition: "evaporated" } }),
    () => ({ type: "garment.retire", payload: { garmentId: stranger(), disposition: "lost" } }),
    () => ({ type: "command.undo", payload: { commandId: "cmd_syn13_no_such_command" } }),
    () => ({ type: "ledger.write_anything", payload: { garmentId: g() } }),
    () => ({ type: "garment.create", payload: { garmentId: g(), name: "SYNTHETIC duplicate (invariant fixture)", category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, isSynthetic: true, source: { kind: "owner_statement", note: NOTE } } }),
  ];
  const chosen = rng.pick(choices)();
  if (rng.chance(0.15)) opts.occurredAt = iso(Date.now() + rng.int(1, 30) * DAY); // and, for good measure, in the future
  return { ...chosen, opts, expect: "refuse" };
}

function plan(rng: Rng, actor: Actor, seed: number): Planned {
  const mine = history.filter((h) => h.actor === actor);
  const roll = rng.int(1, 100);
  if (roll <= 9 && mine.length > 0) {
    // Undo something this owner did earlier (it may no longer be undoable; then it must be refused cleanly).
    return { type: "command.undo", payload: { commandId: rng.pick(mine).commandId }, opts: { idempotencyKey: nextKey(seed) }, expect: "any" };
  }
  if (roll <= 17 && mine.length > 0) {
    const earlier = rng.pick(mine);
    return { type: earlier.type, payload: earlier.payload, opts: earlier.opts, expect: "any", replayOf: earlier };
  }
  if (roll <= 21 && mine.length > 0) {
    // An earlier key with another body.
    const earlier = rng.pick(mine);
    return { type: earlier.type, payload: { ...earlier.payload, note: `SYNTHETIC changed body ${rng.int(1, 1e6)}` }, opts: earlier.opts, expect: "refuse" };
  }
  if (roll <= 25 && history.length > mine.length) {
    // Another owner's command: undoing it, or reading its receipt by replaying its key, must not work.
    const theirs = rng.pick(history.filter((h) => h.actor !== actor));
    if (rng.chance(0.5)) return { type: "command.undo", payload: { commandId: theirs.commandId }, opts: { idempotencyKey: nextKey(seed) }, expect: "refuse" };
    return { type: theirs.type, payload: theirs.payload, opts: theirs.opts, expect: "any", foreignOf: theirs };
  }
  if (roll <= 37) return invalidCommand(rng, actor, seed);
  return freshCommand(rng, actor, seed);
}

const describeOutcome = (result: { status: number; receipt: any; error: ApiErrorBody | null }): string => `${result.status} ${result.receipt ? `${result.receipt.outcome}${result.receipt.replayed ? " (replayed)" : ""}` : (result.error as ApiErrorBody).code}`;
const describePlanned = (planned: Planned): string => `${planned.type} ${JSON.stringify(planned.payload).slice(0, 260)}${planned.opts.occurredAt ? ` at ${planned.opts.occurredAt}` : ""}`;

/** What must hold after one answered command of `actor` (its own ledger; the other owners are checked by the caller). */
async function account(actor: Actor, planned: Planned, result: { status: number; receipt: any; error: ApiErrorBody | null }, label: string): Promise<void> {
  stats.sent++;
  // No sequence of owner commands may break the service.
  expect(result.status, `${label}: ${JSON.stringify(result.error)}`).toBeLessThan(500);
  if (planned.expect === "refuse") expect(result.status, `${label}: a command that must be refused was accepted`).not.toBe(200);
  if (planned.expect === "accept") expect(result.status, `${label}: a command that must be carried out was refused: ${JSON.stringify(result.error)}`).toBe(200);
  if (result.status !== 200) {
    stats.refused++;
    return;
  }
  // Whatever was sent, the answer is never another owner's command, and every receipt is a command of this owner's own ledger.
  if (planned.foreignOf) expect(result.receipt.commandId, `${label}: another owner's stored receipt was returned`).not.toBe(planned.foreignOf.commandId);
  const owned = await sql<{ user_id: string }>("SELECT user_id FROM commands WHERE command_id = ?", result.receipt.commandId);
  expect(owned, `${label}: the receipt's command is not this owner's`).toEqual([{ user_id: actor.owner.userId }]);
  if (result.receipt.replayed) {
    stats.replayed++;
    if (planned.replayOf) expect(result.receipt.commandId, `${label}: the replay answered with another command`).toBe(planned.replayOf.commandId);
    else expect(history.some((h) => h.actor === actor && h.commandId === result.receipt.commandId), `${label}: a replay of a command this owner never sent`).toBe(true);
    return;
  }
  stats.committed++;
  expect(planned.replayOf, `${label}: a replayed key ran as a new command`).toBeUndefined();
  // 4. Exactly one command row with exactly this receipt.
  const rows = await sql<{ receipt_json: string; idempotency_key: string }>("SELECT receipt_json, idempotency_key FROM commands WHERE user_id = ? AND command_id = ?", actor.owner.userId, result.receipt.commandId);
  expect(rows.length, `${label}: the committed command is not in the ledger exactly once`).toBe(1);
  expect(rows[0]!.idempotency_key, label).toBe(planned.opts.idempotencyKey);
  expect({ ...JSON.parse(rows[0]!.receipt_json), replayed: false }, `${label}: the stored receipt is not the one returned`).toEqual({ ...result.receipt, replayed: false });
  if (planned.type === "garment.create") {
    actor.garmentIds.add(String(result.receipt.result.garmentId));
    actor.pool.push(String(result.receipt.result.garmentId));
  }
  if (planned.type === "command.undo") stats.undone++;
  history.push({ actor, type: planned.type, payload: planned.payload, opts: planned.opts, commandId: result.receipt.commandId, outcome: result.receipt.outcome });
}

async function othersUntouched(actor: Actor, label: string): Promise<void> {
  const others = actors.filter((other) => other !== actor);
  const prints = await Promise.all(others.map((other) => fingerprint(other.owner)));
  for (const [i, other] of others.entries()) expect(prints[i], `${label}: changed the ledger of ${other.label}`).toEqual(baseline.get(other.owner.userId));
}

/** Send one planned command and check everything that must hold afterwards. Returns the answer. */
async function execute(actor: Actor, planned: Planned, where: string): Promise<{ status: number; receipt: any; error: ApiErrorBody | null; label: string }> {
  const result = await submit(actor.owner, planned.type, planned.payload, planned.opts);
  const label = `${where} [${actor.label}] ${describePlanned(planned)} -> ${describeOutcome(result)}`;
  await account(actor, planned, result, label);
  const before = baseline.get(actor.owner.userId)!;
  // Whatever happened, the other owners' ledgers are exactly as they were.
  const [, own] = await Promise.all([othersUntouched(actor, label), result.status !== 200 || result.receipt.replayed ? fingerprint(actor.owner) : stableFingerprint(actor)]);
  if (result.status !== 200 || result.receipt.replayed) {
    // 4. A refused command, and a replay, wrote nothing.
    expect(own, `${label}: a ${result.status === 200 ? "replay" : "refused command"} wrote something`).toEqual(before);
  } else {
    expect(own.commands, `${label}: the ledger did not gain exactly one command`).toBe((before.commands as number) + 1);
    baseline.set(actor.owner.userId, own);
  }
  await checkLedger(actor, label);
  return { ...result, label };
}

async function step(rng: Rng, seed: number, index: number, tag: string): Promise<void> {
  const actor = rng.pick(actors);
  const { label } = await execute(actor, plan(rng, actor, seed), `${tag} step=${index}`);
  if (index % 16 === 15) {
    for (const other of actors) if (other !== actor) await checkLedger(other, `${label} (periodic check of ${other.label})`);
    await checkNoCrossOwnerReferences(label);
  }
}

async function checkEverything(where: string): Promise<void> {
  for (const actor of actors) await checkLedger(actor, `${where} [${actor.label}]`);
  await checkNoCrossOwnerReferences(where);
}

async function runSequence(seed: number, steps: number): Promise<void> {
  const tag = beginSeed(seed);
  const rng = new Rng(seed);
  for (const actor of actors) actor.today = await ownerDay(actor.owner, 0);
  for (let i = 0; i < steps; i++) await step(rng, seed, i, tag);
  await checkEverything(`${tag} end of sequence`);
}

/** Units per garment and bucket (summed over batches and trips) and the active counted wears: what undo and redo must restore. */
async function stockPrint(owner: TestOwner): Promise<{ balances: string[]; wears: string[] }> {
  const balances = await sql<{ garment_id: string; bucket: string; quantity: number }>("SELECT garment_id, bucket, SUM(quantity) AS quantity FROM stock_balances WHERE user_id = ? GROUP BY garment_id, bucket ORDER BY garment_id, bucket", owner.userId);
  const wears = await sql<{ garment_id: string; wearing_date: string; observation_count: number }>("SELECT garment_id, wearing_date, observation_count FROM daily_wears WHERE user_id = ? AND status = 'active' ORDER BY garment_id, wearing_date", owner.userId);
  return { balances: balances.map((b) => `${b.garment_id}:${b.bucket}:${b.quantity}`), wears: wears.map((w) => `${w.garment_id}|${w.wearing_date}|${w.observation_count}`) };
}

const envelopeOf = (planned: Pick<Planned, "type" | "payload" | "opts">) => ({
  type: planned.type,
  payload: planned.payload,
  idempotencyKey: planned.opts.idempotencyKey,
  expectedVersions: planned.opts.expectedVersions ?? {},
  ...(planned.opts.occurredAt ? { occurredAt: planned.opts.occurredAt } : {}),
  authorization: "owner_tap",
  source: { channel: "ios" },
});

/* ------------------------------------------------------------------ */

async function tripFor(owner: TestOwner): Promise<string> {
  const from = await ownerDay(owner, 0);
  const to = await ownerDay(owner, 3);
  const trip = await submit(owner, "trip.create", { name: "SYNTHETIC invariant trip (adversarial fixture)", departsOn: from, returnsOn: to, destinations: [{ label: "SYNTHETIC destination", timezone: "Europe/Paris", from, to }], source: { kind: "owner_statement", note: NOTE } });
  if (trip.status !== 200) throw new Error(`fixture: trip.create failed: ${trip.status} ${JSON.stringify(trip.error)}`);
  return trip.receipt.result.tripId as string;
}

beforeAll(async () => {
  worldStartedAt = new Date().toISOString();
  world = await createWorld();
  const collider = await syntheticOwner("Synthetic colliding owner (adversarial test fixture)");

  // The real owner's pool: a spread of the imported wardrobe across care channels.
  const real = await inventory(world.real);
  const owned = real.items.filter((i) => i.garment.acquisition === "owned" && quantityIn(i, "clean") >= 1);
  const pick = (role: string, n: number) => owned.filter((i) => i.garment.roles.includes(role)).slice(0, n).map((i) => i.garment.garmentId);
  const realPool = [...new Set([...pick("top", 4), ...pick("bottom", 2), ...pick("socks", 3), ...pick("belt", 1), ...pick("footwear", 2)])];
  if (realPool.length < 8) throw new Error("fixture: the real inventory did not yield a pool of garments");
  const syntheticPool = SYNTHETIC_WARDROBE.map((g) => g.id);

  const build = async (owner: TestOwner, label: string, synthetic: boolean, pool: string[], foreign: string[]): Promise<Actor> => ({
    owner,
    label,
    synthetic,
    pool: [...pool],
    foreign,
    tripId: await tripFor(owner),
    today: await ownerDay(owner, 0),
    garmentIds: new Set((await sql<{ garment_id: string }>("SELECT garment_id FROM garments WHERE user_id = ?", owner.userId)).map((r) => r.garment_id)),
    packed: new Set<string>(),
  });
  actors = [
    await build(world.real, "real owner fixture", false, realPool, syntheticPool.slice(0, 6)),
    await build(world.synthetic, "synthetic owner A", true, syntheticPool, realPool.slice(0, 6)),
    await build(collider, "synthetic owner B (same garment IDs as A)", true, syntheticPool, realPool.slice(0, 6)),
  ];
  // The two synthetic owners really do collide on every ID, and neither shares an ID with the real owner.
  expect([...actors[1]!.garmentIds].sort()).toEqual([...actors[2]!.garmentIds].sort());
  for (const id of actors[1]!.garmentIds) expect(actors[0]!.garmentIds.has(id)).toBe(false);
  for (const actor of actors) baseline.set(actor.owner.userId, await stableFingerprint(actor));
  for (const actor of actors) await checkLedger(actor, `before any command [${actor.label}]`);
  await checkNoCrossOwnerReferences("before any command");
});

describe("random interleaved command sequences keep every ledger invariant", () => {
  for (const seed of FIXED_SEEDS) {
    it(`seed ${seed}: ${STEPS_PER_SEED} random commands across three owners (valid, invalid, replayed, undone, back-dated)`, async () => {
      await runSequence(seed, STEPS_PER_SEED);
    });
  }

  it(`a seed derived from the clock (${CLOCK_SEED}): ${STEPS_PER_SEED} more random commands`, async () => {
    await runSequence(CLOCK_SEED, STEPS_PER_SEED);
  });

  it("the sequences really exercised the ledger: most commands committed, and refusals, replays and undos all occurred", () => {
    expect(stats.sent).toBe((FIXED_SEEDS.length + 1) * STEPS_PER_SEED);
    expect(stats.committed, JSON.stringify(stats)).toBeGreaterThan(stats.sent * 0.4);
    expect(stats.refused, JSON.stringify(stats)).toBeGreaterThan(20);
    expect(stats.replayed, JSON.stringify(stats)).toBeGreaterThan(5);
    expect(stats.undone, JSON.stringify(stats)).toBeGreaterThan(3);
    for (const actor of actors) expect(history.filter((h) => h.actor === actor).length, actor.label).toBeGreaterThan(20);
  });
});

describe("properties of undo, replay, batches, bursts, versions and colliding owners", () => {
  it("undo, redo, undo: a random undoable command returns the stock and the counted wears to identical fingerprints each time", async () => {
    const seed = 0xd0d0;
    const tag = beginSeed(seed);
    const rng = new Rng(seed);
    let cycles = 0;
    const kinds = new Set<string>();
    for (let round = 0; round < 40; round++) {
      const actor = rng.pick(actors);
      let planned = freshCommand(rng, actor, seed);
      // Creating a garment cannot be redone under the same ID, and an amendment has no undo: not part of this property.
      for (let tries = 0; tries < 10 && (planned.type === "garment.create" || planned.type === "wear.amend"); tries++) planned = freshCommand(rng, actor, seed);
      if (planned.type === "garment.create" || planned.type === "wear.amend") continue;
      const where = `${tag} undo-redo round=${round}`;
      const s0 = await stockPrint(actor.owner);
      const first = await execute(actor, planned, where);
      if (first.status !== 200 || first.receipt.outcome !== "committed" || !first.receipt.undo.available) continue;
      const s1 = await stockPrint(actor.owner);

      const undo = await execute(actor, { type: "command.undo", payload: { commandId: first.receipt.commandId }, opts: { idempotencyKey: nextKey(seed) }, expect: "any" }, `${where} undo`);
      // Nothing happened in between: the undo the receipt offered must be honoured.
      expect(undo.status, `${undo.label}: ${JSON.stringify(undo.error)}`).toBe(200);
      expect(await stockPrint(actor.owner), `${undo.label}: the undo did not restore the state before the command`).toEqual(s0);

      const redo = await execute(actor, { ...planned, opts: { ...planned.opts, idempotencyKey: nextKey(seed) } }, `${where} redo`);
      expect(redo.status, `${redo.label}: ${JSON.stringify(redo.error)}`).toBe(200);
      expect(await stockPrint(actor.owner), `${redo.label}: the redo did not reach the state the command first produced`).toEqual(s1);

      const again = await execute(actor, { type: "command.undo", payload: { commandId: redo.receipt.commandId }, opts: { idempotencyKey: nextKey(seed) }, expect: "any" }, `${where} second undo`);
      expect(again.status, `${again.label}: ${JSON.stringify(again.error)}`).toBe(200);
      expect(await stockPrint(actor.owner), `${again.label}: the second undo did not restore the state before the command`).toEqual(s0);
      cycles++;
      kinds.add(planned.type);
    }
    expect(cycles, `${tag}: too few complete undo/redo cycles (${[...kinds].join(", ")})`).toBeGreaterThanOrEqual(15);
    expect(kinds.size, `${tag}: ${[...kinds].join(", ")}`).toBeGreaterThanOrEqual(5);
    await checkEverything(`${tag} after the undo/redo cycles`);
  });

  it("random offline batches: one result per command in order, every receipt is one ledger row, every refused item wrote nothing", async () => {
    const seed = 0xba7c4;
    const tag = beginSeed(seed);
    const rng = new Rng(seed);
    for (let round = 0; round < 8; round++) {
      const actor = rng.pick(actors);
      const mine = history.filter((h) => h.actor === actor);
      const items: Planned[] = [];
      const size = rng.int(5, 12);
      for (let i = 0; i < size; i++) {
        const roll = rng.int(1, 10);
        if (roll <= 2) items.push(invalidCommand(rng, actor, seed));
        else if (roll === 3 && items.length > 0) items.push({ ...rng.pick(items) }); // the same key and body again inside the batch
        else if (roll === 4 && mine.length > 0) {
          const earlier = rng.pick(mine);
          items.push({ type: earlier.type, payload: earlier.payload, opts: earlier.opts, expect: "any", replayOf: earlier });
        } else items.push(freshCommand(rng, actor, seed));
      }
      const where = `${tag} batch round=${round} [${actor.label}]`;
      const response = await actor.owner.api.post("/v1/commands/batch", { commands: items.map(envelopeOf) });
      expect(response.status, where).toBe(200);
      const body = (await response.json()) as { results: any[]; wardrobeRevision: number };
      expect(body.results.length, `${where}: one result per command`).toBe(items.length);
      let fresh = 0;
      for (const [i, item] of items.entries()) {
        const answer = body.results[i];
        const result = answer.status === "receipt" ? { status: 200, receipt: answer.receipt, error: null } : { status: 409, receipt: null, error: answer.error as ApiErrorBody };
        const label = `${where} item=${i} ${describePlanned(item)} -> ${answer.status === "receipt" ? describeOutcome(result) : answer.error.code}`;
        expect(answer.idempotencyKey, label).toBe(item.opts.idempotencyKey);
        if (answer.status === "error") expect(answer.error.code, label).not.toBe("internal");
        await account(actor, item, result, label);
        if (answer.status === "receipt" && !answer.receipt.replayed) fresh++;
      }
      await othersUntouched(actor, where);
      const before = baseline.get(actor.owner.userId)!;
      const after = await stableFingerprint(actor);
      // 4. The ledger gained exactly the commands that have a fresh receipt; the refused and replayed items none.
      expect(after.commands, `${where}: ${fresh} fresh receipts`).toBe((before.commands as number) + fresh);
      baseline.set(actor.owner.userId, after);
      const state = await sql<{ wardrobe_revision: number }>("SELECT wardrobe_revision FROM owner_state WHERE user_id = ?", actor.owner.userId);
      expect(body.wardrobeRevision, where).toBe(state[0]!.wardrobe_revision);
      await checkLedger(actor, where);
    }
    await checkEverything(`${tag} after the batches`);
  });

  it("random parallel bursts of commands for one owner keep every invariant and never touch another owner", async () => {
    const seed = 0xb0057;
    const tag = beginSeed(seed);
    const rng = new Rng(seed);
    for (let round = 0; round < 12; round++) {
      const actor = rng.pick(actors);
      const burst = Array.from({ length: rng.int(3, 6) }, () => (rng.chance(0.2) ? invalidCommand(rng, actor, seed) : freshCommand(rng, actor, seed)));
      const where = `${tag} burst round=${round} [${actor.label}]`;
      // A creation of an ID this owner already has must be refused and must not overwrite the existing garment: every
      // column a creation sets is compared, with its aliases. Left out are only the columns that other commands in the
      // same burst legitimately change (a retirement: version, acquisition, removed_reason, updated_at; wear and
      // laundry reports: clean_inferred, wear_logging_since).
      const VOLATILE = new Set(["version", "acquisition", "removed_reason", "updated_at", "clean_inferred", "wear_logging_since"]);
      const identity = async (garmentId: string) => ({
        rows: (await sql<Record<string, unknown>>("SELECT * FROM garments WHERE user_id = ? AND garment_id = ?", actor.owner.userId, garmentId)).map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => !VOLATILE.has(column)))),
        aliases: await sql("SELECT * FROM garment_aliases WHERE user_id = ? AND garment_id = ? ORDER BY alias_id", actor.owner.userId, garmentId),
      });
      const existingIds = [...new Set(burst.filter((p) => p.type === "garment.create" && p.expect === "refuse").map((p) => String((p.payload as Record<string, unknown>).garmentId)))];
      const existingBefore = new Map(await Promise.all(existingIds.map(async (id) => [id, await identity(id)] as const)));
      const results = await Promise.all(burst.map((planned) => submit(actor.owner, planned.type, planned.payload, planned.opts)));
      let fresh = 0;
      // Two parallel creations of one ID: at most one may win; account for them in the order they committed.
      const order = results.map((_, i) => i).sort((a, b) => (results[a]!.receipt?.wardrobeRevision ?? 0) - (results[b]!.receipt?.wardrobeRevision ?? 0));
      const createdId = (p: Planned): string | null => (p.type === "garment.create" ? String((p.payload as Record<string, unknown>).garmentId ?? "") : null);
      const twins = new Map<string, number[]>();
      for (const [i, p] of burst.entries()) {
        const id = createdId(p);
        if (id) twins.set(id, [...(twins.get(id) ?? []), i]);
      }
      for (const i of order) {
        const planned = burst[i]!;
        const result = results[i]!;
        // A creation of an ID this owner already has keeps its "refuse". A creation of a free ID must be carried out
        // unless its twin (same garment ID, same burst) won the race, so only a twinned free-ID creation may lose.
        const id = createdId(planned);
        const twinned = id !== null && (twins.get(id) ?? []).length > 1;
        const freeCreate = id !== null && planned.expect !== "refuse";
        const expectation: Planned = freeCreate ? { ...planned, expect: twinned ? "any" : "accept" } : planned;
        await account(actor, expectation, result, `${where} ${describePlanned(planned)} -> ${describeOutcome(result)}`);
        if (result.status === 200 && !result.receipt.replayed) fresh++;
      }
      // Of each group of twins exactly one fresh creation commits when the ID was free, and the others are refused without a server error.
      for (const [id, members] of twins) {
        if (members.length < 2) continue;
        const won = members.filter((i) => results[i]!.status === 200 && !results[i]!.receipt.replayed);
        // A free ID is created by exactly one of its twins; an ID the owner already had by none.
        const free = members.every((i) => burst[i]!.expect !== "refuse");
        expect(won.length, `${where}: parallel creations of ${id}`).toBe(free ? 1 : 0);
        for (const i of members.filter((m) => results[m]!.status !== 200)) expect(results[i]!.status, `${where}: a losing creation of ${id}`).toBeLessThan(500);
      }
      for (const [id, row] of existingBefore) {
        expect(row.rows, `${where}: ${id} existed before the burst`).toHaveLength(1);
        expect(await identity(id), `${where}: a refused creation of ${id} overwrote the existing garment`).toEqual(row);
      }
      await othersUntouched(actor, where);
      const before = baseline.get(actor.owner.userId)!;
      const after = await stableFingerprint(actor);
      expect(after.commands, `${where}: ${fresh} commands were accepted`).toBe((before.commands as number) + fresh);
      baseline.set(actor.owner.userId, after);
      await checkLedger(actor, where);
    }
    await checkEverything(`${tag} after the bursts`);
  });

  it("an offline batch and a parallel burst made only of commands that must be refused write nothing at all, for any owner", async () => {
    const seed = 0x4ef05;
    const tag = beginSeed(seed);
    const rng = new Rng(seed);
    for (let round = 0; round < 6; round++) {
      const actor = rng.pick(actors);
      const where = `${tag} all-refused round=${round} [${actor.label}]`;
      const before = await stableFingerprint(actor);
      const items = Array.from({ length: rng.int(4, 9) }, () => invalidCommand(rng, actor, seed));
      if (round % 2 === 0) {
        const response = await actor.owner.api.post("/v1/commands/batch", { commands: items.map(envelopeOf) });
        expect(response.status, where).toBe(200);
        const body = (await response.json()) as { results: any[] };
        expect(body.results.length, where).toBe(items.length);
        for (const [i, answer] of body.results.entries()) {
          const label = `${where} item=${i} ${describePlanned(items[i]!)} -> ${answer.status === "receipt" ? describeOutcome({ status: 200, receipt: answer.receipt, error: null }) : answer.error?.code}`;
          // As in the mixed batches: the answer is this item's, it is a refusal, and the refusal is a controlled one.
          expect(answer.idempotencyKey, label).toBe(items[i]!.opts.idempotencyKey);
          expect(answer.status, `${label}: a command that must be refused was not answered with an error`).toBe("error");
          expect(typeof answer.error?.code, `${label}: the refusal carries an error code`).toBe("string");
          expect(answer.error.code, `${label}: refused by a server error, not a controlled refusal`).not.toBe("internal");
        }
      } else {
        const results = await Promise.all(items.map((planned) => submit(actor.owner, planned.type, planned.payload, planned.opts)));
        for (const [i, result] of results.entries()) {
          expect(result.status, `${where} item=${i} ${describePlanned(items[i]!)}`).not.toBe(200);
          expect(result.status, `${where} item=${i}: a server error`).toBeLessThan(500);
        }
      }
      // The whole fingerprint (garments, balances, journal, wears, commands, revisions) is exactly as before, for everyone.
      expect(await stableFingerprint(actor), `${where}: a refused command wrote something`).toEqual(before);
      await othersUntouched(actor, where);
    }
  });

  it("random stale versions: counts, retirements and packing are refused whole; wear, wash and laundry reports are never refused for a version", async () => {
    const seed = 0x57a1e;
    const tag = beginSeed(seed);
    const rng = new Rng(seed);
    let refusedForVersion = 0;
    let rebased = 0;
    for (let round = 0; round < 36; round++) {
      const actor = rng.pick(actors);
      const garmentId = rng.pick(actor.pool);
      const row = (await sql<{ version: number; removed_reason: string | null }>("SELECT version, removed_reason FROM garments WHERE user_id = ? AND garment_id = ?", actor.owner.userId, garmentId))[0]!;
      if (row.removed_reason !== null) continue; // a creation an earlier sequence undid: there is no record left to edit
      const current = row.version;
      const staleVersion = Math.max(0, current + rng.pick([-3, -2, -1, 1, 2, 5]));
      const expectedVersions = { [`garment:${garmentId}`]: staleVersion === current ? current + 1 : staleVersion };
      const where = `${tag} versions round=${round} (garment version ${current}, stated ${expectedVersions[`garment:${garmentId}`]})`;
      const opts = { idempotencyKey: nextKey(seed), expectedVersions };
      if (rng.chance(0.5)) {
        const checked = rng.pick<Omit<Planned, "opts" | "expect">>([
          { type: "stock.reconcile", payload: { garmentId, counts: { clean: rng.int(0, 4) } } },
          { type: "garment.retire", payload: { garmentId, quantity: 1, disposition: "donated" } },
          { type: "stock.pack", payload: { tripId: actor.tripId, items: [{ garmentId, quantity: 1 }] } },
          { type: "stock.unpack", payload: { tripId: actor.tripId, items: [{ garmentId }] } },
          { type: "garment.move", payload: { garmentId, to: "storage", quantity: 1 } },
          { type: "garment.correct", payload: { garmentId, changes: { condition: "SYNTHETIC stale edit" }, source: { kind: "owner_statement", note: NOTE } } },
        ]);
        const result = await execute(actor, { ...checked, opts, expect: "refuse" }, where);
        expect({ status: result.status, code: result.error?.code }, result.label).toEqual({ status: 409, code: "conflict" });
        refusedForVersion++;
      } else {
        const report = rng.pick<Omit<Planned, "opts" | "expect">>([
          { type: "wear.record", payload: { wearingDate: addDays(actor.today, -rng.int(0, 5)), garmentIds: [garmentId] } },
          { type: "wear.amend", payload: { wearingDate: addDays(actor.today, -rng.int(0, 5)), add: [garmentId] } },
          { type: "care.mark_dirty", payload: { items: [{ garmentId, quantity: 1 }] } },
          { type: "care.washed", payload: { items: [{ garmentId, quantity: 1 }] } },
          { type: "laundry.collect", payload: {} },
          { type: "laundry.return", payload: {} },
          { type: "laundry.report_exception", payload: { kind: "still_away", garmentId, quantity: 1 } },
        ]);
        const result = await execute(actor, { ...report, opts, expect: "any" }, where);
        // It may be refused for what it says (a belt cannot be washed), never because a version moved on.
        expect(result.error?.code, result.label).not.toBe("conflict");
        if (result.status === 200) rebased++;
      }
    }
    expect(refusedForVersion, tag).toBeGreaterThan(8);
    expect(rebased, tag).toBeGreaterThan(8);
    await checkEverything(`${tag} after the version rounds`);
  });

  it("replaying every committed request of this run, shuffled, through the single route and the batch route changes nothing", async () => {
    const seed = 0x5e9a1;
    const tag = beginSeed(seed);
    const rng = new Rng(seed);
    expect(history.length).toBeGreaterThan(150);
    const before = new Map<string, Record<string, unknown>>();
    for (const actor of actors) before.set(actor.owner.userId, await stableFingerprint(actor));
    const prints = new Map<string, unknown>();
    for (const actor of actors) prints.set(actor.owner.userId, await stockPrint(actor.owner));

    const shuffled = rng.shuffle(history);
    const single = shuffled.filter((_, i) => i % 3 === 0);
    for (const sent of single) {
      const again = await submit(sent.actor.owner, sent.type, sent.payload, sent.opts);
      const label = `${tag} replay [${sent.actor.label}] ${sent.type} key=${sent.opts.idempotencyKey} -> ${describeOutcome(again)}`;
      expect(again.status, `${label}: ${JSON.stringify(again.error)}`).toBe(200);
      expect({ commandId: again.receipt.commandId, replayed: again.receipt.replayed }, label).toEqual({ commandId: sent.commandId, replayed: true });
    }
    for (const actor of actors) {
      const rest = shuffled.filter((sent, i) => i % 3 !== 0 && sent.actor === actor);
      for (let offset = 0; offset < rest.length; offset += 50) {
        const chunk = rest.slice(offset, offset + 50);
        const response = await actor.owner.api.post("/v1/commands/batch", { commands: chunk.map(envelopeOf) });
        expect(response.status).toBe(200);
        const results = ((await response.json()) as { results: any[] }).results;
        expect(results.length).toBe(chunk.length);
        for (const [i, sent] of chunk.entries()) {
          const label = `${tag} batch replay [${actor.label}] ${sent.type} key=${sent.opts.idempotencyKey}`;
          expect(results[i].status, `${label}: ${JSON.stringify(results[i].error)}`).toBe("receipt");
          expect({ commandId: results[i].receipt.commandId, replayed: results[i].receipt.replayed }, label).toEqual({ commandId: sent.commandId, replayed: true });
        }
      }
    }
    for (const actor of actors) {
      expect(await fingerprint(actor.owner), `${tag}: replaying the whole run changed the ledger of ${actor.label}`).toEqual(before.get(actor.owner.userId));
      expect(await stockPrint(actor.owner), `${tag}: replaying the whole run moved stock of ${actor.label}`).toEqual(prints.get(actor.owner.userId));
      baseline.set(actor.owner.userId, before.get(actor.owner.userId)!);
    }
    await checkEverything(`${tag} after replaying the whole run`);
  });

  it("two fresh synthetic owners with identical garment IDs, given the identical random history, end with identical ledgers whatever happens in between", async () => {
    const seed = 0x7717;
    const tag = beginSeed(seed);
    const rng = new Rng(seed);
    const twins: Actor[] = [];
    for (const name of ["first", "second"]) {
      const owner = await syntheticOwner(`Synthetic twin owner, ${name} (adversarial test fixture)`);
      twins.push({ owner, label: `synthetic twin (${name})`, synthetic: true, pool: SYNTHETIC_WARDROBE.map((g) => g.id), foreign: actors[0]!.pool.slice(0, 6), tripId: await tripFor(owner), today: await ownerDay(owner, 0), garmentIds: new Set(SYNTHETIC_WARDROBE.map((g) => g.id)), packed: new Set<string>() });
    }
    const [first, second] = twins as [Actor, Actor];
    for (let i = 0; i < 44; i++) {
      const planned = rng.chance(0.15) ? invalidCommand(rng, first, seed) : freshCommand(rng, first, seed);
      const forSecond = JSON.parse(JSON.stringify(planned.payload).split(first.tripId).join(second.tripId)) as Record<string, unknown>;
      const a = await submit(first.owner, planned.type, planned.payload, planned.opts);
      // In between, a third owner with the same garment IDs does something else entirely.
      if (i % 6 === 0) await execute(actors[1]!, freshCommand(rng, actors[1]!, seed), `${tag} twins step=${i} interleaved`);
      const b = await submit(second.owner, planned.type, forSecond, { ...planned.opts, idempotencyKey: planned.opts.idempotencyKey });
      const label = `${tag} twins step=${i} ${describePlanned(planned)}`;
      expect(a.status, `${label}: ${JSON.stringify(a.error)}`).toBeLessThan(500);
      expect({ status: b.status, outcome: b.receipt?.outcome ?? b.error?.code }, `${label}: the same command had another outcome for the second twin`).toEqual({ status: a.status, outcome: a.receipt?.outcome ?? a.error?.code });
      // The same key on both sides is two commands, never one shared receipt.
      if (a.receipt && b.receipt) {
        expect(b.receipt.commandId, label).not.toBe(a.receipt.commandId);
        expect(b.receipt.replayed, label).toBe(false);
      }
      if (a.status === 200 && planned.type === "garment.create") for (const twin of twins) {
        twin.garmentIds.add(String(a.receipt.result.garmentId));
        twin.pool.push(String(a.receipt.result.garmentId));
      }
      const [printOfFirst, printOfSecond] = await Promise.all([stockPrint(first.owner), stockPrint(second.owner)]);
      expect(printOfSecond, `${label}: the twins' ledgers diverged`).toEqual(printOfFirst);
    }
    for (const twin of twins) await checkLedger(twin, `${tag} twins end [${twin.label}]`);
    const firstRows = await sql<{ n: number }>("SELECT COUNT(*) AS n FROM commands WHERE user_id = ?", first.owner.userId);
    const secondRows = await sql<{ n: number }>("SELECT COUNT(*) AS n FROM commands WHERE user_id = ?", second.owner.userId);
    expect(secondRows[0]!.n, tag).toBe(firstRows[0]!.n);
  });

  it("[fixed L13-1] stock.pack refuses a trip that does not exist, was cancelled, or belongs to another owner: no unit leaves home for a place no screen lists", async () => {
    const owner = await syntheticOwner("Synthetic packing owner (adversarial test fixture)");
    const today = await ownerDay(owner, 0);
    const cancelled = await tripFor(owner);
    expect((await submit(owner, "trip.cancel", { tripId: cancelled })).status).toBe(200);
    const foreignTrip = actors[0]!.tripId; // the real owner fixture's trip
    const attempts = [
      await submit(owner, "stock.pack", { tripId: "trp_syn13_no_such_trip", items: [{ garmentId: "shirt-moss", quantity: 1 }] }),
      await submit(owner, "stock.pack", { tripId: cancelled, items: [{ garmentId: "shirt-gold", quantity: 1 }] }),
      await submit(owner, "stock.pack", { tripId: foreignTrip, items: [{ garmentId: "shirt-slate", quantity: 1 }] }),
    ];
    // Invariant: every unit recorded as packed is packed for one of this owner's planned trips.
    const stranded = await sql<{ garment_id: string; ref: string }>(
      `SELECT b.garment_id, b.ref FROM stock_balances b WHERE b.user_id = ?1 AND b.bucket = 'trip' AND b.quantity > 0
         AND NOT EXISTS (SELECT 1 FROM trips t WHERE t.user_id = b.user_id AND t.status = 'planned' AND (b.ref = t.trip_id OR b.ref = t.trip_id || '#dirty')) ORDER BY b.garment_id`,
      owner.userId,
    );
    expect({ accepted: attempts.filter((a) => a.status === 200).length, stranded: stranded.map((s) => s.garment_id) }, `on ${today}`).toEqual({ accepted: 0, stranded: [] });
  });

  it("[fixed L13-2] saying 'packed' again about a piece already worn in the suitcase leaves the worn unit worn", async () => {
    const owner = await syntheticOwner("Synthetic re-packing owner (adversarial test fixture)");
    const today = await ownerDay(owner, 0);
    const tripId = await tripFor(owner);
    const g = "trouser-olive"; // one unit
    expect((await submit(owner, "stock.pack", { tripId, items: [{ garmentId: g, quantity: 1 }] })).status).toBe(200);
    expect((await submit(owner, "wear.record", { wearingDate: today, garmentIds: [g], tripId })).status).toBe(200);
    const packedOf = async () => ((await owner.api.json("GET", `/v1/trips/${tripId}`)).packed as { garmentId: string; clean: number; worn: number }[]).filter((p) => p.garmentId === g).map((p) => ({ clean: p.clean, worn: p.worn }));
    expect(await packedOf()).toEqual([{ clean: 0, worn: 1 }]);
    // The packing check is repeated (a second device, or the assistant confirming the list).
    const again = await submit(owner, "stock.pack", { tripId, items: [{ garmentId: g, quantity: 1 }] });
    expect([200, 409]).toContain(again.status);
    // Section 10: unpacking is distinct from washing, and only a wash report makes a worn piece clean.
    expect(await packedOf()).toEqual([{ clean: 0, worn: 1 }]);
    // The suite's own replay of the journal says the same.
    const journal = await sql<{ seq: number; kind: string; payload_json: string; occurred_at: string; voided_by_command_id: string | null }>("SELECT seq, kind, payload_json, occurred_at, voided_by_command_id FROM stock_events WHERE user_id = ? AND garment_id = ? ORDER BY seq", owner.userId, g);
    expect(replayJournal("service", journal.map((e) => ({ seq: e.seq, kind: e.kind, payload: JSON.parse(e.payload_json), at: Date.parse(e.occurred_at), voided: e.voided_by_command_id !== null }))).trip).toBe(1);
  });
});
