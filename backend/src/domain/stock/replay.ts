import type { StockBucket } from '@garderobe/contracts';

/**
 * Event-ordered stock replay (spec section 5, "Quantity and laundry" and "Owner observations and
 * accounting repair").
 *
 * The journal stores the *intent* of each quantity change; balances are the replay of all active
 * movements of a lot in occurrence order. Consequences:
 *  - a late report of yesterday's wear is inserted at yesterday and does not undo today's known wash
 *    (a sweep such as "socks washed" moves whatever was in the hamper at that moment);
 *  - quantities can never become negative: a movement moves at most what exists, drawing from an
 *    ordered fallback list and recording an accounting-repair note when it had to;
 *  - replay never creates units: only `receive` and a `reconcile_total` increase adds units.
 *
 * Each bucket holds the instants at which its units entered it (FIFO), which the availability
 * estimator uses to decide which dirty units fall before a weekly reset cutoff.
 */

export const BUCKETS: readonly StockBucket[] = ['clean', 'worn', 'hamper', 'laundry', 'storage', 'away', 'retired'];

export type MovementKind =
  | 'receive'
  | 'wear'
  | 'transfer'
  | 'sweep'
  | 'batch_collect'
  | 'batch_return'
  | 'reconcile_clean'
  | 'reconcile_total'
  | 'retire';

export type MovementParams =
  | { kind: 'receive'; qty: number; to?: StockBucket; basis?: 'observed' | 'import_baseline' }
  | { kind: 'wear'; to: 'hamper' | 'worn'; qty?: number; fresh?: boolean }
  | { kind: 'transfer'; from: StockBucket[]; to: StockBucket; qty: number }
  | { kind: 'sweep'; from: StockBucket[]; to: StockBucket }
  | { kind: 'batch_collect'; qty: number; batchId: string }
  | { kind: 'batch_return'; qty: number; batchId: string }
  | { kind: 'reconcile_clean'; target: number }
  | { kind: 'reconcile_total'; target: number }
  | { kind: 'retire'; qty: number; from?: StockBucket[] };

export interface ReplayMovement {
  movementId: string;
  seq: number;
  occurredAt: string;
  params: MovementParams;
}

export type UnitState = Record<StockBucket, string[]>;

export interface ReplayNote {
  movementId: string;
  kind: 'accounting_repair' | 'shortfall' | 'observation_without_stock' | 'reconcile_adjustment';
  detail: string;
}

export interface ReplayResult {
  units: UnitState;
  counts: Record<StockBucket, number>;
  notes: ReplayNote[];
  /** Instant of the latest movement that established clean units by observation (null: import baseline only). */
  lastObservedCleanAt: string | null;
}

/** Fallback order when an owner observation says a unit was worn but the ledger has no clean unit. */
export const WEAR_FALLBACK: readonly StockBucket[] = ['clean', 'hamper', 'worn', 'storage', 'away', 'laundry'];
/** Physical pickup: the hamper first; worn next; clean only as an explicit adjustment. */
export const COLLECT_FALLBACK: readonly StockBucket[] = ['hamper', 'worn', 'clean'];
/** Units removed by a downward total correction, least-available first. */
export const RETIRE_ORDER: readonly StockBucket[] = ['hamper', 'worn', 'clean', 'storage', 'away', 'laundry'];

export function emptyUnits(): UnitState {
  return { clean: [], worn: [], hamper: [], laundry: [], storage: [], away: [], retired: [] };
}

export function sortMovements(movements: ReplayMovement[]): ReplayMovement[] {
  return [...movements].sort((a, b) => {
    const t = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
    return t !== 0 ? t : a.seq - b.seq;
  });
}

function take(units: UnitState, from: readonly StockBucket[], qty: number): { taken: number; sources: StockBucket[] } {
  const sources: StockBucket[] = [];
  let taken = 0;
  for (const bucket of from) {
    while (taken < qty && units[bucket].length > 0) {
      units[bucket].shift();
      sources.push(bucket);
      taken++;
    }
    if (taken >= qty) break;
  }
  return { taken, sources };
}

function put(units: UnitState, to: StockBucket, qty: number, at: string): void {
  for (let i = 0; i < qty; i++) units[to].push(at);
}

export function replay(movements: ReplayMovement[]): ReplayResult {
  const units = emptyUnits();
  const notes: ReplayNote[] = [];
  let lastObservedCleanAt: string | null = null;

  for (const m of sortMovements(movements)) {
    const p = m.params;
    const at = m.occurredAt;
    switch (p.kind) {
      case 'receive': {
        put(units, p.to ?? 'clean', p.qty, at);
        if ((p.to ?? 'clean') === 'clean' && p.basis !== 'import_baseline') lastObservedCleanAt = at;
        break;
      }
      case 'wear': {
        const qty = p.qty ?? 1;
        const { taken, sources } = take(units, WEAR_FALLBACK, qty);
        put(units, p.to, taken, at);
        const repaired = sources.filter((s) => s !== 'clean');
        if (repaired.length) {
          notes.push({
            movementId: m.movementId,
            kind: 'accounting_repair',
            detail: `Owner-observed wear drew ${repaired.length} unit(s) from ${[...new Set(repaired)].join(', ')}: the ledger had no clean unit, so an unrecorded wash or move is assumed.`,
          });
        }
        if (taken < qty) {
          notes.push({
            movementId: m.movementId,
            kind: 'observation_without_stock',
            detail: `Owner-observed wear of ${qty} unit(s) found only ${taken} unit(s) on record; no unit was created. Reconcile the owned quantity if needed.`,
          });
        }
        break;
      }
      case 'transfer': {
        const { taken } = take(units, p.from, p.qty);
        put(units, p.to, taken, at);
        if (taken < p.qty) {
          notes.push({ movementId: m.movementId, kind: 'shortfall', detail: `Moved ${taken} of ${p.qty} unit(s) to ${p.to}; no more were on record in ${p.from.join(', ')}.` });
        }
        if (p.to === 'clean' && taken > 0) lastObservedCleanAt = at;
        break;
      }
      case 'sweep': {
        let moved = 0;
        for (const bucket of p.from) {
          moved += units[bucket].length;
          units[bucket] = [];
        }
        put(units, p.to, moved, at);
        if (p.to === 'clean' && moved > 0) lastObservedCleanAt = at;
        break;
      }
      case 'batch_collect': {
        const { taken, sources } = take(units, COLLECT_FALLBACK, p.qty);
        put(units, 'laundry', taken, at);
        const adjusted = sources.filter((s) => s !== 'hamper');
        if (adjusted.length) {
          notes.push({
            movementId: m.movementId,
            kind: 'accounting_repair',
            detail: `Pickup preserved as observed: ${adjusted.length} unit(s) in the batch were drawn from ${[...new Set(adjusted)].join(', ')} after a later correction.`,
          });
        }
        if (taken < p.qty) notes.push({ movementId: m.movementId, kind: 'shortfall', detail: `Batch expected ${p.qty} unit(s); only ${taken} on record.` });
        break;
      }
      case 'batch_return': {
        const { taken } = take(units, ['laundry'], p.qty);
        put(units, 'clean', taken, at);
        if (taken > 0) lastObservedCleanAt = at;
        if (taken < p.qty) notes.push({ movementId: m.movementId, kind: 'shortfall', detail: `Returned ${taken} of ${p.qty} unit(s); fewer were in the batch on record.` });
        break;
      }
      case 'reconcile_clean': {
        const current = units.clean.length;
        if (p.target > current) {
          const need = p.target - current;
          const { taken } = take(units, ['hamper', 'worn', 'laundry', 'storage', 'away'], need);
          put(units, 'clean', taken, at);
          if (taken < need) {
            notes.push({
              movementId: m.movementId,
              kind: 'reconcile_adjustment',
              detail: `Clean set to ${current + taken}, not ${p.target}: only ${current + taken} unit(s) are owned. Correct the owned total to add units.`,
            });
          }
        } else if (p.target < current) {
          const { taken } = take(units, ['clean'], current - p.target);
          put(units, 'hamper', taken, at);
        }
        lastObservedCleanAt = at;
        break;
      }
      case 'reconcile_total': {
        const owned = BUCKETS.filter((b) => b !== 'retired').reduce((n, b) => n + units[b].length, 0);
        if (p.target > owned) {
          put(units, 'clean', p.target - owned, at);
          lastObservedCleanAt = at;
        } else if (p.target < owned) {
          const { taken } = take(units, RETIRE_ORDER, owned - p.target);
          put(units, 'retired', taken, at);
        }
        break;
      }
      case 'retire': {
        const { taken } = take(units, p.from ?? RETIRE_ORDER, p.qty);
        put(units, 'retired', taken, at);
        break;
      }
    }
  }

  const counts = Object.fromEntries(BUCKETS.map((b) => [b, units[b].length])) as Record<StockBucket, number>;
  return { units, counts, notes, lastObservedCleanAt };
}

export function ownedUnits(counts: Record<StockBucket, number>): number {
  return BUCKETS.filter((b) => b !== 'retired').reduce((n, b) => n + counts[b], 0);
}
