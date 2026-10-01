/**
 * Stock replay: the deterministic accounting engine.
 *
 * A garment's quantities are the replay, in event order (occurred_at, then journal sequence), of
 * its own stock events plus the owner-level laundry events (weekly resets and cycle exceptions).
 * Nothing here touches the database; the command service journals events and materializes the
 * balances this function returns.
 *
 * Properties this gives the ledger (specification section 5 and the September 15 amendments):
 *   - a late report is inserted at the time it happened and everything after it is recomputed, so
 *     "I wore it yesterday" never undoes today's known wash;
 *   - an owner observation always applies: if the ledger believed the unit was elsewhere, the unit is
 *     moved to where the owner says it is and a repair note is produced - never a question;
 *   - quantities cannot go negative: every movement is clamped to what exists;
 *   - observed and inferred movements stay distinguishable (each movement carries its basis);
 *   - undo/amend voids an event and replays; pickups keep their recorded membership, so a corrected
 *     garment is never placed in a bag it did not enter.
 */
import type { Basis, Bucket, CareChannel } from "@garderobe/contracts";

export type StockEventKind =
  | "receive"
  | "arrive"
  | "wear"
  | "extra_unit"
  | "mark_dirty"
  | "wash"
  | "pickup"
  | "return"
  | "exception"
  | "weekly_reset"
  | "cycle_exception"
  | "move"
  | "pack"
  | "unpack"
  | "retire"
  | "reconcile"
  | "merged_out";

export interface StockEvent {
  eventId: string;
  /** Journal sequence; new not-yet-written events use increasing values above any stored seq. */
  seq: number;
  garmentId: string | null;
  kind: StockEventKind;
  payload: Record<string, any>;
  basis: Basis;
  occurredAtMs: number;
  voided: boolean;
}

export interface ServiceHolding {
  quantity: number;
  /** Held units are not released by an ordinary weekly reset. */
  held: boolean;
  pickedUpAtMs: number;
  /** The owner reported these units lost, not merely late: "washed" alone does not bring them back. */
  lost?: boolean;
}

export interface StockState {
  incoming: number;
  clean: number;
  /** One entry per dirty unit: the instant from which it is awaiting care. */
  dirty: number[];
  service: Map<string, ServiceHolding>;
  storage: number;
  tailor: number;
  trip: Map<string, { clean: number; dirty: number }>;
  gone: number;
}

export interface ReplayMovement {
  eventId: string;
  kind: StockEventKind;
  from: Bucket | null;
  to: Bucket | null;
  quantity: number;
  basis: Basis;
  occurredAtMs: number;
  note: string | null;
}

export interface ReplayResult {
  state: StockState;
  movements: ReplayMovement[];
  /** Accounting repairs made so an owner observation could stand. */
  repairs: { eventId: string; note: string }[];
}

export interface BalanceRow {
  bucket: Bucket;
  ref: string;
  quantity: number;
  held: boolean;
}

export function emptyState(): StockState {
  return { incoming: 0, clean: 0, dirty: [], service: new Map(), storage: 0, tailor: 0, trip: new Map(), gone: 0 };
}

export function sortEvents(events: StockEvent[]): StockEvent[] {
  return [...events].sort((a, b) => a.occurredAtMs - b.occurredAtMs || a.seq - b.seq);
}

export function ownedUnits(s: StockState): number {
  let n = s.clean + s.dirty.length + s.storage + s.tailor;
  for (const h of s.service.values()) n += h.quantity;
  for (const t of s.trip.values()) n += t.clean + t.dirty;
  return n;
}

export function toBalances(s: StockState): BalanceRow[] {
  const rows: BalanceRow[] = [];
  const push = (bucket: Bucket, ref: string, quantity: number, held = false) => {
    if (quantity > 0) rows.push({ bucket, ref, quantity, held });
  };
  push("incoming", "", s.incoming);
  push("clean", "", s.clean);
  push("dirty", "", s.dirty.length);
  for (const [ref, h] of s.service) push("service", ref, h.quantity, h.held);
  push("storage", "", s.storage);
  push("tailor", "", s.tailor);
  for (const [ref, t] of s.trip) {
    push("trip", ref, t.clean);
    push("trip", `${ref}#dirty`, t.dirty);
  }
  push("gone", "", s.gone);
  return rows;
}

/**
 * Replay one garment.
 * @param careChannel the garment's care channel (`none` garments never acquire a laundry state)
 * @param events the garment's own events together with the owner-level events (garmentId null)
 */
export function replayGarment(careChannel: CareChannel, events: StockEvent[]): ReplayResult {
  const s = emptyState();
  const movements: ReplayMovement[] = [];
  const repairs: { eventId: string; note: string }[] = [];
  const ordered = sortEvents(events.filter((e) => !e.voided));
  const laundered = careChannel !== "none";

  // Cycle-level exceptions apply to the reset of their cycle regardless of when they were reported.
  const cycleExceptions = new Set<string>();
  for (const e of ordered) {
    if (e.kind === "cycle_exception") cycleExceptions.add(`${e.payload.channel}:${e.payload.cycleKey}`);
  }

  for (const e of ordered) {
    const move = (from: Bucket | null, to: Bucket | null, quantity: number, note: string | null = null, basis: Basis = e.basis) => {
      if (quantity > 0) movements.push({ eventId: e.eventId, kind: e.kind, from, to, quantity, basis, occurredAtMs: e.occurredAtMs, note });
    };
    const repair = (note: string) => repairs.push({ eventId: e.eventId, note });

    /** Take up to n units out of service holdings; non-held first unless includeHeldFirst. */
    const takeFromService = (n: number, opts: { allowHeld: boolean }): number => {
      let taken = 0;
      const entries = [...s.service.entries()].sort((a, b) => Number(a[1].held) - Number(b[1].held) || a[1].pickedUpAtMs - b[1].pickedUpAtMs);
      for (const [ref, h] of entries) {
        if (taken >= n) break;
        if (h.held && !opts.allowHeld) continue;
        const q = Math.min(h.quantity, n - taken);
        h.quantity -= q;
        taken += q;
        if (h.quantity === 0) s.service.delete(ref);
      }
      return taken;
    };
    const takeFromTrip = (n: number): { clean: number; dirty: number } => {
      const out = { clean: 0, dirty: 0 };
      for (const [ref, t] of [...s.trip.entries()]) {
        const c = Math.min(t.clean, n - out.clean - out.dirty);
        t.clean -= c;
        out.clean += c;
        const d = Math.min(t.dirty, n - out.clean - out.dirty);
        t.dirty -= d;
        out.dirty += d;
        if (t.clean + t.dirty === 0) s.trip.delete(ref);
      }
      return out;
    };
    /**
     * An owner observation needs one unit the ledger does not show at home: take it from wherever
     * the ledger believed it was. Returns the bucket it came from, or null when no unit is on record.
     */
    const pullOneFromElsewhere = (): Bucket | null => {
      if (takeFromService(1, { allowHeld: true }) === 1) return "service";
      if (s.tailor > 0) return (s.tailor -= 1), "tailor";
      if (s.storage > 0) return (s.storage -= 1), "storage";
      const t = takeFromTrip(1);
      if (t.clean + t.dirty === 1) return "trip";
      if (s.incoming > 0) return (s.incoming -= 1), "incoming";
      return null;
    };
    const oldestDirty = (n: number): number => {
      s.dirty.sort((a, b) => a - b);
      const q = Math.min(n, s.dirty.length);
      s.dirty.splice(0, q);
      return q;
    };

    switch (e.kind) {
      case "receive": {
        const q = Number(e.payload.quantity ?? 1);
        const to = (e.payload.to ?? "clean") as "incoming" | "clean" | "storage" | "tailor";
        s[to] += q;
        move(null, to, q);
        break;
      }
      case "arrive": {
        const q = Math.min(Number(e.payload.quantity ?? s.incoming), s.incoming);
        s.incoming -= q;
        s.clean += q;
        move("incoming", "clean", q);
        break;
      }
      case "wear":
      case "extra_unit": {
        const dirtyAt = Number(e.payload.dirtyAtMs ?? e.occurredAtMs);
        const units = e.kind === "extra_unit" ? Number(e.payload.quantity ?? 1) : 1;
        for (let i = 0; i < units; i++) {
          const tripId = e.payload.tripId as string | undefined;
          const trip = tripId ? s.trip.get(tripId) : undefined;
          if (trip && trip.clean > 0) {
            if (laundered) {
              trip.clean -= 1;
              trip.dirty += 1;
              move("trip", "trip", 1, "worn from the packed subset");
            }
            continue;
          }
          if (!laundered) {
            if (s.clean > 0) continue; // never-laundered roles: a wear moves nothing
            const from = pullOneFromElsewhere();
            if (from) {
              s.clean += 1;
              move(from, "clean", 1, "owner observation: worn, so it is with the owner");
              repair(`ledger had this item in '${from}'; the recorded wear establishes it is with the owner`);
            } else if (ownedUnits(s) === 0) {
              repair("wear recorded for an item with no owned units on record; no quantity was created");
            }
            continue;
          }
          if (s.clean > 0) {
            s.clean -= 1;
            s.dirty.push(dirtyAt);
            move("clean", "dirty", 1);
          } else if (s.dirty.length > 0) {
            // Worn again while already awaiting care: it cannot have been collected before this wear.
            s.dirty.sort((a, b) => a - b);
            s.dirty[0] = Math.max(s.dirty[0]!, dirtyAt);
            repair("ledger had no clean unit; the wear is recorded and the unit stays awaiting care");
          } else {
            const from = pullOneFromElsewhere();
            if (from) {
              s.dirty.push(dirtyAt);
              move(from, "dirty", 1, "owner observation: worn, so it is with the owner");
              repair(`ledger had this item in '${from}'; the recorded wear establishes it is with the owner`);
            } else {
              repair("wear recorded for an item with no owned units on record; no quantity was created");
            }
          }
        }
        break;
      }
      case "mark_dirty": {
        if (!laundered) {
          repair("this item is never laundered; no laundry state was recorded");
          break;
        }
        const want = Number(e.payload.quantity ?? 1);
        const q = Math.min(want, s.clean);
        s.clean -= q;
        for (let i = 0; i < q; i++) s.dirty.push(e.occurredAtMs);
        move("clean", "dirty", q);
        for (let i = q; i < want; i++) {
          const from = pullOneFromElsewhere();
          if (!from) break;
          s.dirty.push(e.occurredAtMs);
          move(from, "dirty", 1, "owner observation: marked dirty, so it is with the owner");
          repair(`ledger had this item in '${from}'; the dirty observation establishes it is with the owner`);
        }
        break;
      }
      case "wash": {
        const tripId = e.payload.tripId as string | undefined;
        if (tripId && s.trip.has(tripId)) {
          const t = s.trip.get(tripId)!;
          const q = Math.min(Number(e.payload.quantity ?? t.dirty), t.dirty);
          t.dirty -= q;
          t.clean += q;
          move("trip", "trip", q, "washed on the trip");
          break;
        }
        const explicit = e.payload.quantity as number | undefined;
        const want = explicit ?? Math.max(s.dirty.length, 1);
        const q = oldestDirty(want);
        s.clean += q;
        move("dirty", "clean", q);
        let remaining = want - q;
        // The owner says it is washed: a unit the ledger believed was away is evidently back and clean.
        while (remaining > 0 && (explicit !== undefined || s.clean === 0)) {
          if (takeFromService(1, { allowHeld: true }) !== 1) break;
          s.clean += 1;
          remaining -= 1;
          move("service", "clean", 1, "owner observation: washed, so it is back and clean");
          repair("ledger had this item away at the laundry; the wash observation establishes it is back and clean");
        }
        if (e.payload.releaseHeld) {
          // "It is washed", with no count, about a garment with units reported still away or held by a missed
          // return: those units are evidently back. Units reported lost stay lost while another unit is clean.
          for (const [ref, h] of [...s.service.entries()]) {
            if (!h.held || h.lost) continue;
            s.clean += h.quantity;
            move("service", "clean", h.quantity, "owner observation: washed, so the unit reported away is back and clean");
            s.service.delete(ref);
          }
        }
        break;
      }
      case "pickup": {
        const batchId = String(e.payload.batchId);
        const q = oldestDirty(Number(e.payload.quantity ?? 1));
        if (q > 0) {
          const h = s.service.get(batchId) ?? { quantity: 0, held: false, pickedUpAtMs: e.occurredAtMs };
          h.quantity += q;
          s.service.set(batchId, h);
          move("dirty", "service", q);
        }
        break;
      }
      case "return": {
        const batchId = String(e.payload.batchId);
        const h = s.service.get(batchId);
        if (h) {
          const q = Math.min(Number(e.payload.quantity ?? h.quantity), h.quantity);
          h.quantity -= q;
          s.clean += q;
          move("service", "clean", q);
          const away = Number(e.payload.stillAway ?? 0);
          if (h.quantity === 0) s.service.delete(batchId);
          else if (away > 0) h.held = true; // named exception: stays away until the owner reports it back
        }
        break;
      }
      case "exception": {
        // Item-level exception (still away / lost): the unit is not at home, whatever was inferred.
        const want = Number(e.payload.quantity ?? 1);
        const ref = `exception:${e.payload.exceptionId}`;
        let got = takeFromService(want, { allowHeld: false });
        if (got > 0) move("service", "service", got, "held: reported still away");
        const fromClean = Math.min(want - got, s.clean);
        if (fromClean > 0) {
          s.clean -= fromClean;
          got += fromClean;
          move("clean", "service", fromClean, "owner exception overrides the inferred return");
        }
        const fromDirty = oldestDirty(want - got);
        if (fromDirty > 0) {
          got += fromDirty;
          move("dirty", "service", fromDirty, "owner exception: the unit is away, not in the hamper");
        }
        if (got > 0) {
          const h = s.service.get(ref) ?? { quantity: 0, held: true, pickedUpAtMs: e.occurredAtMs, lost: e.payload.kind === "lost" };
          h.quantity += got;
          s.service.set(ref, h);
        }
        break;
      }
      case "weekly_reset": {
        if (!laundered || e.payload.channel !== careChannel) break;
        const cutoff = Number(e.payload.cutoffAtMs);
        const key = String(e.payload.cycleKey);
        const excepted = cycleExceptions.has(`${e.payload.channel}:${key}`);
        s.dirty.sort((a, b) => a - b);
        const eligible = s.dirty.filter((t) => t < cutoff).length;
        if (excepted) {
          // Owner reported this cycle's return missed or delayed: collected units are away, not clean.
          if (eligible > 0) {
            s.dirty.splice(0, eligible);
            const ref = `cycle:${key}`;
            const h = s.service.get(ref) ?? { quantity: 0, held: true, pickedUpAtMs: cutoff };
            h.quantity += eligible;
            s.service.set(ref, h);
            move("dirty", "service", eligible, `cycle ${key}: return reported missed or delayed`, "observed");
          }
          break;
        }
        if (eligible > 0) {
          s.dirty.splice(0, eligible);
          s.clean += eligible;
          move("dirty", "clean", eligible, `weekly reset ${key}: inferred clean (no pickup or return was observed)`, "inferred");
        }
        for (const [ref, h] of [...s.service.entries()]) {
          const earlierDelayedCycle = ref.startsWith("cycle:") && ref.slice(6) < key;
          const ordinaryBatch = !h.held && h.pickedUpAtMs < e.occurredAtMs;
          if (earlierDelayedCycle || ordinaryBatch) {
            s.clean += h.quantity;
            move("service", "clean", h.quantity, `weekly reset ${key}: return inferred, not observed`, "inferred");
            s.service.delete(ref);
          }
        }
        break;
      }
      case "cycle_exception":
        break; // applied by the matching weekly_reset above
      case "move": {
        const to = e.payload.to as "clean" | "storage" | "tailor";
        let from = e.payload.from as "clean" | "dirty" | "storage" | "tailor" | undefined;
        if (!from) {
          if (to === "clean") from = s.tailor > 0 ? "tailor" : "storage";
          else from = s.clean > 0 || s.dirty.length === 0 ? "clean" : "dirty";
        }
        const have = from === "dirty" ? s.dirty.length : s[from];
        const want = Number(e.payload.quantity ?? Math.max(have, 1));
        const q = Math.min(want, have);
        if (from === "dirty") oldestDirty(q);
        else s[from] -= q;
        s[to] += q;
        move(from, to, q);
        for (let i = q; i < want && e.payload.quantity !== undefined; i++) {
          const other = pullOneFromElsewhere() ?? (s.clean > 0 && to !== "clean" ? ((s.clean -= 1), "clean" as Bucket) : oldestDirty(1) === 1 ? ("dirty" as Bucket) : null);
          if (!other) break;
          s[to] += 1;
          move(other, to, 1, "owner statement establishes the location");
          repair(`ledger had a unit in '${other}'; the owner's statement establishes it is now in '${to}'`);
        }
        if (q === 0 && e.payload.quantity === undefined) {
          const other = pullOneFromElsewhere() ?? (oldestDirty(1) === 1 ? ("dirty" as Bucket) : null);
          if (other) {
            s[to] += 1;
            move(other, to, 1, "owner statement establishes the location");
            repair(`ledger had this item in '${other}'; the owner's statement establishes it is now in '${to}'`);
          }
        }
        break;
      }
      case "pack": {
        const tripId = String(e.payload.tripId);
        const want = Number(e.payload.quantity ?? 1);
        const t = s.trip.get(tripId) ?? { clean: 0, dirty: 0 };
        const c = Math.min(want, s.clean);
        s.clean -= c;
        t.clean += c;
        move("clean", "trip", c);
        const d = oldestDirty(want - c);
        if (d > 0) {
          t.dirty += d;
          move("dirty", "trip", d, "packed while awaiting care");
          repair("packed a unit the ledger shows as awaiting care; it travels as not clean");
        }
        for (let i = c + d; i < want; i++) {
          const from = pullOneFromElsewhere();
          if (!from) break;
          t.clean += 1;
          move(from, "trip", 1, "owner statement: packed");
          repair(`ledger had this item in '${from}'; packing establishes it is in the suitcase`);
        }
        if (t.clean + t.dirty > 0) s.trip.set(tripId, t);
        break;
      }
      case "unpack": {
        const tripId = String(e.payload.tripId);
        const t = s.trip.get(tripId);
        if (!t) break;
        const want = Number(e.payload.quantity ?? t.clean + t.dirty);
        const d = Math.min(want, t.dirty);
        const c = Math.min(want - d, t.clean);
        t.dirty -= d;
        t.clean -= c;
        if (laundered) {
          // Unpacking returns units home without declaring them clean.
          for (let i = 0; i < c + d; i++) s.dirty.push(e.occurredAtMs);
          move("trip", "dirty", c + d, "unpacked; cleanliness not asserted");
        } else {
          s.clean += c + d;
          move("trip", "clean", c + d);
        }
        if (t.clean + t.dirty === 0) s.trip.delete(tripId);
        break;
      }
      case "retire": {
        let want = Number(e.payload.quantity ?? ownedUnits(s) + s.incoming);
        const take = (bucket: Bucket, available: number, apply: (q: number) => void) => {
          const q = Math.min(want, available);
          if (q > 0) {
            apply(q);
            want -= q;
            s.gone += q;
            move(bucket, "gone", q);
          }
        };
        take("clean", s.clean, (q) => (s.clean -= q));
        take("dirty", s.dirty.length, (q) => void oldestDirty(q));
        take("storage", s.storage, (q) => (s.storage -= q));
        take("tailor", s.tailor, (q) => (s.tailor -= q));
        const svc = [...s.service.values()].reduce((n, h) => n + h.quantity, 0);
        take("service", svc, (q) => void takeFromService(q, { allowHeld: true }));
        const trp = [...s.trip.values()].reduce((n, t) => n + t.clean + t.dirty, 0);
        take("trip", trp, (q) => void takeFromTrip(q));
        take("incoming", s.incoming, (q) => (s.incoming -= q));
        break;
      }
      case "reconcile": {
        const counts = (e.payload.counts ?? {}) as { clean?: number; dirty?: number; storage?: number; total?: number };
        const cur = (b: "clean" | "dirty" | "storage") => (b === "dirty" ? s.dirty.length : s[b]);
        const add = (b: "clean" | "dirty" | "storage", q: number) => {
          if (b === "dirty") for (let i = 0; i < q; i++) s.dirty.push(e.occurredAtMs);
          else s[b] += q;
        };
        const sub = (b: "clean" | "dirty" | "storage", q: number) => {
          if (b === "dirty") oldestDirty(q);
          else s[b] -= q;
        };
        const specified = new Set(Object.keys(counts).filter((k) => k !== "total"));
        if (counts.total !== undefined) {
          let diff = counts.total - ownedUnits(s);
          if (diff > 0) {
            s.clean += diff;
            move(null, "clean", diff, "count correction: more units than recorded");
          }
          for (const b of ["dirty", "clean", "storage"] as const) {
            if (diff >= 0) break;
            const q = Math.min(-diff, cur(b));
            sub(b, q);
            diff += q;
            move(b, null, q, "count correction: fewer units than recorded");
          }
        }
        for (const b of ["clean", "dirty", "storage"] as const) {
          const target = counts[b];
          if (target === undefined) continue;
          let delta = target - cur(b);
          if (delta > 0) {
            for (const donor of ["dirty", "clean", "storage"] as const) {
              if (delta === 0) break;
              if (donor === b || specified.has(donor)) continue;
              const q = Math.min(delta, cur(donor));
              sub(donor, q);
              add(b, q);
              delta -= q;
              move(donor, b, q, "owner count correction");
            }
            if (delta > 0 && b === "clean") {
              const q = takeFromService(delta, { allowHeld: false });
              s.clean += q;
              delta -= q;
              move("service", "clean", q, "owner count correction");
            }
            if (delta > 0 && counts.total === undefined) {
              add(b, delta);
              move(null, b, delta, "owner count correction: more units than recorded");
            }
          } else if (delta < 0) {
            const candidate = b === "clean" ? ("dirty" as const) : ("clean" as const);
            const receiver = specified.has(candidate) ? undefined : candidate;
            sub(b, -delta);
            if (receiver && (laundered || receiver !== "dirty")) {
              add(receiver, -delta);
              move(b, receiver, -delta, "owner count correction");
            } else {
              move(b, null, -delta, "owner count correction: fewer units than recorded");
            }
          }
        }
        break;
      }
      case "merged_out": {
        const total = ownedUnits(s) + s.incoming;
        s.incoming = 0;
        s.clean = 0;
        s.dirty = [];
        s.service.clear();
        s.storage = 0;
        s.tailor = 0;
        s.trip.clear();
        move(null, null, total, "record merged into another garment; units are accounted for there");
        break;
      }
    }
  }
  return { state: s, movements, repairs };
}
