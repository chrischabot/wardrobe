import type { Basis, CareChannel } from "@garderobe/contracts";
import { all, allIn, json, stmt, type Db, type Stmt } from "../db.ts";
import { CommandError } from "../errors.ts";
import { parseInstant } from "../util.ts";
import { ownedUnits, replayGarment, toBalances, type BalanceRow, type ReplayResult, type StockEvent, type StockEventKind } from "./replay.ts";
import type { Precondition } from "../commands/types.ts";

export interface GarmentRow {
  garment_id: string;
  version: number;
  name: string;
  category: string;
  care_channel: CareChannel;
  acquisition: "incoming" | "owned" | "disposed";
  planning_policy: string;
  merged_into: string | null;
  removed_reason: string | null;
  attributes_json: string;
}

interface EventRow {
  seq: number;
  event_id: string;
  garment_id: string | null;
  kind: string;
  payload_json: string;
  basis: Basis;
  occurred_at: string;
  voided_by_command_id: string | null;
}

export function rowToEvent(r: EventRow): StockEvent {
  return {
    eventId: r.event_id,
    seq: r.seq,
    garmentId: r.garment_id,
    kind: r.kind as StockEventKind,
    payload: json<Record<string, any>>(r.payload_json, {}),
    basis: r.basis,
    occurredAtMs: parseInstant(r.occurred_at),
    voided: r.voided_by_command_id !== null,
  };
}

export interface PlannedGarmentStock {
  garment: GarmentRow;
  before: ReplayResult;
  after: ReplayResult;
  changed: boolean;
  versionAfter: number;
  acquisitionAfter: GarmentRow["acquisition"];
  balancesAfter: BalanceRow[];
  /** Repairs attributable to events added by this command. */
  repairs: string[];
}

export interface StockBuild {
  statements: Stmt[];
  preconditions: Precondition[];
  garments: Map<string, PlannedGarmentStock>;
  repairs: string[];
  eventIds: string[];
}

/**
 * Journals stock events for one command and recomputes the affected balances by replay.
 *
 * Public primitive: a workstream's own command handler (e.g. trip packing, returns) adds events here
 * and merges `build()` into its plan, so every channel shares one accounting path.
 */
export class StockPlanner {
  private readonly added: { garmentId: string | null; event: StockEvent; recordedAt: string; occurredAt: string }[] = [];
  private readonly voids = new Set<string>();
  private readonly touched = new Set<string>();
  private ownerLevelChannel = new Set<CareChannel>();
  private allGarments = false;
  private counter = 0;
  private readonly declared = new Map<string, GarmentRow>();
  private readonly channelOverride = new Map<string, CareChannel>();

  constructor(
    private readonly db: Db,
    private readonly userId: string,
    private readonly commandId: string,
    private readonly now: string,
    private readonly newId: (prefix: string) => string,
  ) {}

  /** Journal an event. garmentId null = owner-level (weekly_reset, cycle_exception). */
  add(garmentId: string | null, kind: StockEventKind, payload: Record<string, unknown>, basis: Basis, occurredAt: string): string {
    const eventId = this.newId("sev");
    this.added.push({
      garmentId,
      occurredAt,
      recordedAt: this.now,
      event: { eventId, seq: 1e15 + this.counter++, garmentId, kind, payload, basis, occurredAtMs: parseInstant(occurredAt), voided: false },
    });
    if (garmentId) this.touched.add(garmentId);
    else if (payload.channel) this.ownerLevelChannel.add(payload.channel as CareChannel);
    else this.allGarments = true;
    return eventId;
  }

  /** Declare a garment this same command creates (its row does not exist yet). */
  declare(row: GarmentRow): void {
    this.declared.set(row.garment_id, row);
    this.touched.add(row.garment_id);
  }

  /** The command changes this garment's care channel; recompute its balances under the new channel. */
  setCareChannel(garmentId: string, channel: CareChannel): void {
    this.channelOverride.set(garmentId, channel);
    this.touched.add(garmentId);
  }

  /** Void a journaled event (compensation). The row is kept; replay skips it. */
  void(eventId: string, garmentId: string | null): void {
    this.voids.add(eventId);
    if (garmentId) this.touched.add(garmentId);
    else this.allGarments = true;
  }

  /** Include a garment in the recomputation without adding an event (e.g. after a merge). */
  touch(garmentId: string): void {
    this.touched.add(garmentId);
  }

  get isEmpty(): boolean {
    return this.added.length === 0 && this.voids.size === 0 && this.touched.size === 0;
  }

  async build(): Promise<StockBuild> {
    const statements: Stmt[] = [];
    const preconditions: Precondition[] = [];
    const garments = new Map<string, PlannedGarmentStock>();
    const repairsOut: string[] = [];
    if (this.isEmpty) return { statements, preconditions, garments, repairs: repairsOut, eventIds: [] };

    let rows: GarmentRow[];
    const cols = "garment_id, version, name, category, care_channel, acquisition, planning_policy, merged_into, removed_reason, attributes_json";
    if (this.allGarments || this.ownerLevelChannel.size > 0) {
      rows = await all<GarmentRow>(this.db, `SELECT ${cols} FROM garments WHERE user_id = ?`, this.userId);
      if (!this.allGarments) rows = rows.filter((g) => this.ownerLevelChannel.has(g.care_channel) || this.touched.has(g.garment_id));
    } else {
      rows = await allIn<GarmentRow>(this.db, `SELECT ${cols} FROM garments WHERE user_id = ? AND garment_id IN (:ids)`, [this.userId], [...this.touched].filter((id) => !this.declared.has(id)));
    }
    rows.push(...this.declared.values());
    const known = new Set(rows.map((r) => r.garment_id));
    for (const id of this.touched) {
      if (!known.has(id)) throw new CommandError("not_found", `no garment '${id}' in this wardrobe`, { garmentId: id });
    }

    const eventCols = "seq, event_id, garment_id, kind, payload_json, basis, occurred_at, voided_by_command_id";
    const ownerEvents = (await all<EventRow>(this.db, `SELECT ${eventCols} FROM stock_events WHERE user_id = ? AND garment_id IS NULL`, this.userId)).map(rowToEvent);
    const bulk = rows.length > 40;
    const garmentEvents = new Map<string, StockEvent[]>();
    const eventRows = bulk
      ? await all<EventRow>(this.db, `SELECT ${eventCols} FROM stock_events WHERE user_id = ? AND garment_id IS NOT NULL`, this.userId)
      : await allIn<EventRow>(this.db, `SELECT ${eventCols} FROM stock_events WHERE user_id = ? AND garment_id IN (:ids)`, [this.userId], rows.map((r) => r.garment_id));
    for (const r of eventRows) {
      const list = garmentEvents.get(r.garment_id!) ?? [];
      list.push(rowToEvent(r));
      garmentEvents.set(r.garment_id!, list);
    }

    const newOwnerEvents = this.added.filter((a) => a.garmentId === null).map((a) => a.event);
    const newEventIds = new Set(this.added.map((a) => a.event.eventId));
    const applyVoids = (events: StockEvent[]) => events.map((e) => (this.voids.has(e.eventId) ? { ...e, voided: true } : e));

    for (const g of rows) {
      const own = garmentEvents.get(g.garment_id) ?? [];
      const before = replayGarment(g.care_channel, [...own, ...ownerEvents]);
      const newOwn = this.added.filter((a) => a.garmentId === g.garment_id).map((a) => a.event);
      const after = replayGarment(this.channelOverride.get(g.garment_id) ?? g.care_channel, [...applyVoids(own), ...newOwn, ...applyVoids(ownerEvents), ...newOwnerEvents]);
      const balancesBefore = toBalances(before.state);
      const balancesAfter = toBalances(after.state);
      const directlyTouched = this.touched.has(g.garment_id);
      const changed = JSON.stringify(balancesBefore) !== JSON.stringify(balancesAfter);
      if (!changed && !directlyTouched) continue;

      let acquisitionAfter = g.acquisition;
      const owned = ownedUnits(after.state);
      if (g.merged_into === null && g.removed_reason === null) {
        if (owned > 0) acquisitionAfter = "owned";
        else if (after.state.incoming > 0) acquisitionAfter = "incoming";
        else if (after.state.gone > 0) acquisitionAfter = "disposed";
      }
      const repairs = after.repairs.filter((r) => newEventIds.has(r.eventId)).map((r) => `${g.name}: ${r.note}`);
      repairsOut.push(...repairs);
      const isNew = this.declared.has(g.garment_id);
      garments.set(g.garment_id, { garment: g, before, after, changed, versionAfter: isNew ? g.version : g.version + 1, acquisitionAfter, balancesAfter, repairs });
      if (isNew) continue;

      preconditions.push({
        label: `garment ${g.garment_id} unchanged since read`,
        sql: "(SELECT version FROM garments WHERE user_id = ? AND garment_id = ?) = ?",
        params: [this.userId, g.garment_id, g.version],
        class: "internal",
      });
    }

    // Journal rows first (they reference the command row, which the service inserts before plan statements).
    for (const a of this.added) {
      statements.push(
        stmt(
          "INSERT INTO stock_events (user_id, event_id, garment_id, kind, payload_json, basis, occurred_at, recorded_at, command_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          this.userId,
          a.event.eventId,
          a.garmentId,
          a.event.kind,
          JSON.stringify(a.event.payload),
          a.event.basis,
          a.occurredAt,
          a.recordedAt,
          this.commandId,
        ),
      );
    }
    for (const eventId of this.voids) {
      statements.push(stmt("UPDATE stock_events SET voided_by_command_id = ? WHERE user_id = ? AND event_id = ? AND voided_by_command_id IS NULL", this.commandId, this.userId, eventId));
    }
    for (const p of garments.values()) {
      statements.push(stmt("DELETE FROM stock_balances WHERE user_id = ? AND garment_id = ?", this.userId, p.garment.garment_id));
      for (const b of p.balancesAfter) {
        statements.push(
          stmt("INSERT INTO stock_balances (user_id, garment_id, bucket, ref, quantity, held) VALUES (?, ?, ?, ?, ?, ?)", this.userId, p.garment.garment_id, b.bucket, b.ref, b.quantity, b.held),
        );
      }
      if (this.declared.has(p.garment.garment_id)) continue;
      statements.push(
        stmt("UPDATE garments SET version = version + 1, acquisition = ?, updated_at = ? WHERE user_id = ? AND garment_id = ?", p.acquisitionAfter, this.now, this.userId, p.garment.garment_id),
      );
    }
    return { statements, preconditions, garments, repairs: repairsOut, eventIds: this.added.map((a) => a.event.eventId) };
  }
}

/** Read-only replay of one garment's journal, for item history and "why" diagnostics. */
export async function explainGarmentStock(db: Db, userId: string, garmentId: string, careChannel: CareChannel): Promise<ReplayResult> {
  const eventCols = "seq, event_id, garment_id, kind, payload_json, basis, occurred_at, voided_by_command_id";
  const rows = await all<EventRow>(db, `SELECT ${eventCols} FROM stock_events WHERE user_id = ? AND (garment_id = ? OR garment_id IS NULL)`, userId, garmentId);
  return replayGarment(careChannel, rows.map(rowToEvent));
}
