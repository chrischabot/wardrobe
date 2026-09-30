import type { AffectedEntity, StockBucket } from '@garderobe/contracts';
import { json, parseJson, versionIs, type Predicate } from '../db.js';
import { newId } from '../ids.js';
import { loadLots, type LotRow } from '../records.js';
import { replay, type MovementKind, type MovementParams, type ReplayMovement, type ReplayResult } from './replay.js';

export interface MovementMeta {
  observationId?: string | null;
  batchId?: string | null;
  wearKey?: string | null;
}

export interface JournalMovement extends ReplayMovement, MovementMeta {
  lotId: string;
  garmentId: string;
  isNew: boolean;
}

let seqCounter = 0;
function nextSeq(): number {
  seqCounter = (seqCounter + 1) % 1000;
  return Date.now() * 1000 + seqCounter;
}

/**
 * Plans quantity changes for a set of garments inside one command: loads their lots and active
 * movements, appends or voids journal rows, replays affected lots in event order and returns the
 * statements plus version guards for the command batch.
 */
export class StockPlanner {
  private lots = new Map<string, LotRow>();
  private lotsByGarment = new Map<string, LotRow[]>();
  private movements = new Map<string, JournalMovement[]>();
  private voided = new Set<string>();
  private touched = new Set<string>();

  constructor(
    private readonly db: D1Database,
    private readonly userId: string,
    private readonly commandId: string,
    private readonly now: string,
  ) {}

  async load(garmentIds: readonly string[]): Promise<void> {
    const missing = [...new Set(garmentIds)].filter((g) => !this.lotsByGarment.has(g));
    if (!missing.length) return;
    const lots = await loadLots(this.db, this.userId, missing);
    for (const g of missing) this.lotsByGarment.set(g, []);
    for (const l of lots) {
      this.lots.set(l.lot_id, l);
      this.lotsByGarment.get(l.garment_id)!.push(l);
      this.movements.set(l.lot_id, []);
    }
    const lotIds = lots.map((l) => l.lot_id);
    for (let i = 0; i < lotIds.length; i += 50) {
      const chunk = lotIds.slice(i, i + 50);
      const { results } = await this.db
        .prepare(
          `SELECT movement_id, seq, lot_id, garment_id, params_json, occurred_at, observation_id, batch_id, wear_key
           FROM stock_movements WHERE user_id = ? AND voided_at IS NULL AND lot_id IN (${chunk.map(() => '?').join(',')})`,
        )
        .bind(this.userId, ...chunk)
        .all<{ movement_id: string; seq: number; lot_id: string; garment_id: string; params_json: string; occurred_at: string; observation_id: string | null; batch_id: string | null; wear_key: string | null }>();
      for (const r of results) {
        this.movements.get(r.lot_id)!.push({
          movementId: r.movement_id,
          seq: r.seq,
          lotId: r.lot_id,
          garmentId: r.garment_id,
          occurredAt: r.occurred_at,
          params: parseJson<MovementParams>(r.params_json, { kind: 'receive', qty: 0 }),
          observationId: r.observation_id,
          batchId: r.batch_id,
          wearKey: r.wear_key,
          isNew: false,
        });
      }
    }
  }

  lotsOf(garmentId: string): LotRow[] {
    return this.lotsByGarment.get(garmentId) ?? [];
  }

  /** The lot a new movement for this garment applies to (most currently clean units; stable). */
  primaryLot(garmentId: string): LotRow | null {
    const lots = this.lotsOf(garmentId);
    if (!lots.length) return null;
    return [...lots].sort((a, b) => this.current(b.lot_id).counts.clean - this.current(a.lot_id).counts.clean || a.lot_id.localeCompare(b.lot_id))[0]!;
  }

  activeMovements(filter: (m: JournalMovement) => boolean): JournalMovement[] {
    const out: JournalMovement[] = [];
    for (const list of this.movements.values()) for (const m of list) if (!this.voided.has(m.movementId) && filter(m)) out.push(m);
    return out;
  }

  add(garmentId: string, params: MovementParams, occurredAt: string, meta: MovementMeta = {}, lotId?: string): string | null {
    const lot = lotId ? this.lots.get(lotId) : this.primaryLot(garmentId);
    if (!lot) return null;
    const movementId = newId('mv');
    this.movements.get(lot.lot_id)!.push({ movementId, seq: nextSeq(), lotId: lot.lot_id, garmentId, occurredAt, params, isNew: true, ...meta });
    this.touched.add(lot.lot_id);
    return movementId;
  }

  void(movementId: string): boolean {
    for (const [lotId, list] of this.movements) {
      const m = list.find((x) => x.movementId === movementId);
      if (m && !this.voided.has(movementId)) {
        this.voided.add(movementId);
        this.touched.add(lotId);
        return true;
      }
    }
    return false;
  }

  private activeFor(lotId: string, until?: string): JournalMovement[] {
    const list = (this.movements.get(lotId) ?? []).filter((m) => !this.voided.has(m.movementId));
    return until === undefined ? list : list.filter((m) => Date.parse(m.occurredAt) <= Date.parse(until));
  }

  current(lotId: string): ReplayResult {
    return replay(this.activeFor(lotId));
  }

  /** Balances as they stood at an instant (for snapshots such as a laundry pickup). */
  countsAt(lotId: string, instant: string): Record<StockBucket, number> {
    return replay(this.activeFor(lotId, instant)).counts;
  }

  garmentCounts(garmentId: string): Record<StockBucket, number> {
    const total: Record<StockBucket, number> = { clean: 0, worn: 0, hamper: 0, laundry: 0, storage: 0, away: 0, retired: 0 };
    for (const lot of this.lotsOf(garmentId)) {
      const c = this.current(lot.lot_id).counts;
      for (const k of Object.keys(total) as StockBucket[]) total[k] += c[k];
    }
    return total;
  }

  hasChanges(): boolean {
    return this.touched.size > 0;
  }

  finalize(): { statements: D1PreparedStatement[]; guards: Predicate[]; affected: AffectedEntity[]; notes: { lotId: string; garmentId: string; detail: string; kind: string }[] } {
    const statements: D1PreparedStatement[] = [];
    const guards: Predicate[] = [];
    const affected: AffectedEntity[] = [];
    const notes: { lotId: string; garmentId: string; detail: string; kind: string }[] = [];
    for (const lotId of this.touched) {
      const lot = this.lots.get(lotId)!;
      guards.push(versionIs(this.userId, 'stock_lot', lotId, lot.version));
      for (const m of this.movements.get(lotId)!) {
        if (m.isNew && !this.voided.has(m.movementId)) {
          statements.push(
            this.db
              .prepare(
                `INSERT INTO stock_movements (user_id, movement_id, seq, lot_id, garment_id, kind, params_json, occurred_at, recorded_at, command_id, observation_id, batch_id, wear_key)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .bind(this.userId, m.movementId, m.seq, lotId, m.garmentId, m.params.kind satisfies MovementKind, json(m.params), m.occurredAt, this.now, this.commandId, m.observationId ?? null, m.batchId ?? null, m.wearKey ?? null),
          );
        } else if (!m.isNew && this.voided.has(m.movementId)) {
          statements.push(
            this.db
              .prepare('UPDATE stock_movements SET voided_at = ?, voided_by_command = ? WHERE user_id = ? AND movement_id = ? AND voided_at IS NULL')
              .bind(this.now, this.commandId, this.userId, m.movementId),
          );
        }
      }
      const result = this.current(lotId);
      const c = result.counts;
      statements.push(
        this.db
          .prepare(
            `UPDATE stock_lots SET clean_qty = ?, worn_qty = ?, hamper_qty = ?, laundry_qty = ?, storage_qty = ?, away_qty = ?, retired_qty = ?,
               units_json = ?, replay_notes_json = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND lot_id = ?`,
          )
          .bind(c.clean, c.worn, c.hamper, c.laundry, c.storage, c.away, c.retired, json(result.units), json(result.notes.slice(-20)), this.now, this.userId, lotId),
      );
      affected.push({ entityType: 'stock_lot', entityId: lotId, version: lot.version + 1, change: 'updated' });
      const newIds = new Set(this.movements.get(lotId)!.filter((m) => m.isNew).map((m) => m.movementId));
      for (const n of result.notes) if (newIds.has(n.movementId) || n.kind !== 'shortfall') notes.push({ lotId, garmentId: lot.garment_id, detail: n.detail, kind: n.kind });
    }
    return { statements, guards, affected, notes: dedupeNotes(notes) };
  }

  newMovementIds(): string[] {
    const out: string[] = [];
    for (const list of this.movements.values()) for (const m of list) if (m.isNew && !this.voided.has(m.movementId)) out.push(m.movementId);
    return out;
  }

  voidedMovementIds(): string[] {
    return [...this.voided];
  }
}

function dedupeNotes<T extends { detail: string; lotId: string }>(notes: T[]): T[] {
  const seen = new Set<string>();
  return notes.filter((n) => {
    const k = `${n.lotId}|${n.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
