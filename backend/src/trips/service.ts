import type { Board } from '@garderobe/contracts';
import { json } from '../domain/db.js';
import { DomainError } from '../domain/errors.js';
import { assertPrincipal, requireScope, SCOPE_WRITE, type Principal } from '../domain/principal.js';
import { requireGarments } from '../domain/records.js';
import { addDays } from '../domain/time.js';
import { RecommendationService, type PublishOutcome, type RecommendationDeps } from '../recommend/service.js';
import type { ScoredOption } from '../recommend/compose.js';
import { loadTrip, loadTripItems, type TripDestination, type TripItemRecord, type TripRecord } from './store.js';

/**
 * Trip and packing mode (spec section 10; section 5 "Trips and packing").
 *  - A trip records dates, destinations with timezones, occasions, luggage and laundry opportunities.
 *  - `proposePacking` composes a compact set of day outfits from home stock against destination
 *    weather, with deliberate reuse; it writes proposed quantities only.
 *  - `markPacked` records what was physically packed (an owner statement); packed units leave the
 *    home pool until unpacked.
 *  - Trip-day boards (`purpose = trip:<id>`) use only the packed subset and destination weather; home
 *    stock cannot leak in and no home laundry reset applies inside a suitcase. An explicit packing
 *    request permits deliberate reuse (repeat-policy exception for this trip only).
 *  - `markUnpacked` returns units home without declaring them clean; a wash report or the next
 *    applicable care cycle establishes cleanliness.
 */

export interface CreateTripInput {
  name: string;
  departsOn: string;
  returnsOn: string;
  destinations: TripDestination[];
  timezone?: string;
  luggage?: string | null;
  occasions?: TripRecord['occasions'];
  laundryOpportunities?: unknown[];
  /** An explicit packing request permits deliberate reuse on the trip (default true). */
  allowRepeats?: boolean;
}

export interface PackingProposal {
  tripId: string;
  days: { date: string; garments: { garmentId: string; name: string; role: string }[]; why: string }[];
  items: { garmentId: string; name: string; quantity: number }[];
  notes: string[];
}

export class TripService {
  readonly recommendations: RecommendationService;
  private readonly db: D1Database;
  private readonly principal: Principal;
  private readonly clock: () => string;

  constructor(deps: RecommendationDeps) {
    assertPrincipal(deps.principal);
    this.db = deps.db;
    this.principal = deps.principal;
    this.clock = deps.clock ?? (() => new Date().toISOString());
    this.recommendations = new RecommendationService(deps);
  }

  async createTrip(input: CreateTripInput): Promise<TripRecord> {
    requireScope(this.principal, SCOPE_WRITE);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.departsOn) || !/^\d{4}-\d{2}-\d{2}$/.test(input.returnsOn) || input.returnsOn < input.departsOn) {
      throw new DomainError('validation_failed', 'A trip needs valid departure and return dates, returning on or after departure');
    }
    if (!input.destinations.length) throw new DomainError('validation_failed', 'A trip needs at least one destination');
    const tripId = `trip_${crypto.randomUUID().replace(/-/g, '')}`;
    await this.db
      .prepare(
        `INSERT INTO trips (user_id, trip_id, name, departs_on, returns_on, destinations_json, timezone, luggage, laundry_opportunities_json, status, allow_repeats, occasions_json, created_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, 1)`,
      )
      .bind(
        this.principal.userId,
        tripId,
        input.name,
        input.departsOn,
        input.returnsOn,
        json(input.destinations),
        input.timezone ?? input.destinations[0]!.timezone,
        input.luggage ?? null,
        json(input.laundryOpportunities ?? []),
        input.allowRepeats === false ? 0 : 1,
        json(input.occasions ?? []),
        this.clock(),
      )
      .run();
    return (await loadTrip(this.db, this.principal.userId, tripId))!;
  }

  async getTrip(tripId: string): Promise<{ trip: TripRecord; items: TripItemRecord[] }> {
    const trip = await loadTrip(this.db, this.principal.userId, tripId);
    if (!trip) throw new DomainError('not_found', 'No such trip');
    return { trip, items: await loadTripItems(this.db, this.principal.userId, tripId) };
  }

  /**
   * Compact packing with deliberate reuse (spec: "propose a compact set of combinations with deliberate
   * reuse"): one shirt and socks per day, trousers and shoes shared. Reuse is a rule, not a tie-break:
   * a trip of N days packs at most ceil(N/2) trousers. Once that many are chosen, each further day wears
   * one of them. When the day's board offers no outfit with a packed pair, the day is composed again
   * with each packed pair pinned (the pin is validated like any request). New trousers are added beyond
   * the limit only when no packed pair makes a valid outfit that day (weather or occasion), and the notes
   * say so. On an occasion day an outfit suitable for it is preferred within whichever set is allowed.
   * `seed` varies composition deterministically (tests); the default is the owner and date.
   */
  async proposePacking(tripId: string, opts: { seed?: string } = {}): Promise<PackingProposal> {
    requireScope(this.principal, SCOPE_WRITE);
    const { trip } = await this.getTrip(tripId);
    const days: PackingProposal['days'] = [];
    const chosen: ScoredOption[] = [];
    const notes: string[] = [];
    let tripDays = 0;
    for (let d = trip.departsOn; d <= trip.returnsOn; d = addDays(d, 1)) tripDays++;
    const trouserLimit = Math.max(1, Math.ceil(tripDays / 2));
    const bottomOf = (o: ScoredOption) => o.validation.parts.bottom?.garmentId;
    for (let d = trip.departsOn; d <= trip.returnsOn; d = addDays(d, 1)) {
      const dest = trip.destinations.find((x) => (!x.from || x.from <= d) && (!x.to || x.to >= d)) ?? trip.destinations[0]!;
      const occ = trip.occasions.find((o) => o.date === d);
      const usedTops = new Set(chosen.map((c) => c.validation.parts.top?.garmentId).filter((id): id is string => Boolean(id)));
      // Shirts already proposed for earlier days are excluded before composition, so the composer searches
      // every combination with the unused shirts instead of a bounded board filtered afterwards.
      const request = { date: d, destination: dest, requestedCount: 5, occasion: occ && ['formal', 'dinner', 'travel', 'outdoor'].includes(occ.occasion) ? (occ.occasion as never) : undefined, exclude: [...usedTops], ...(opts.seed ? { seed: `${opts.seed}:${d}` } : {}) };
      const { composed, context } = await this.recommendations.compose(request);
      const packedBottoms = [...new Set(chosen.map(bottomOf).filter((id): id is string => Boolean(id)))];
      const reuse = (o: ScoredOption) => {
        const p = o.validation.parts;
        let s = 0;
        if (chosen.some((c) => c.validation.parts.bottom?.garmentId === p.bottom?.garmentId)) s += 2;
        if (chosen.some((c) => c.validation.parts.footwear[0]?.garmentId === p.footwear[0]?.garmentId)) s += 1.5;
        if (p.outer && chosen.some((c) => c.validation.parts.outer?.garmentId === p.outer!.garmentId)) s += 1.5;
        if (p.belt && chosen.some((c) => c.validation.parts.belt?.garmentId === p.belt!.garmentId)) s += 0.5;
        return s;
      };
      const freshTop = (o: ScoredOption) => !usedTops.has(o.validation.parts.top?.garmentId ?? '');
      const best = (pool: ScoredOption[]) => {
        const ranked = [...pool].sort((a, b) => b.score + reuse(b) - (a.score + reuse(a)));
        return (occ ? ranked.find((o) => o.suitable) : undefined) ?? ranked[0];
      };
      const pool = [...composed.options, ...composed.reserves].filter(freshTop);
      const mustReuse = packedBottoms.length >= trouserLimit;
      let pick: ScoredOption | undefined;
      if (mustReuse) {
        const reusing = (o: ScoredOption) => packedBottoms.includes(bottomOf(o) ?? '');
        let candidates = pool.filter(reusing);
        if (!candidates.length || (occ && !candidates.some((o) => o.suitable))) {
          for (const bottom of packedBottoms) {
            const pinned = await this.recommendations.compose({ ...request, include: [bottom] });
            candidates = candidates.concat([...pinned.composed.options, ...pinned.composed.reserves].filter((o) => freshTop(o) && bottomOf(o) === bottom));
          }
        }
        pick = best(candidates);
        if (!pick) {
          pick = best(pool);
          if (pick) notes.push(`${d}: none of the packed trousers makes a valid outfit for ${dest.label} that day, so another pair is proposed.`);
        }
      } else {
        pick = best(pool);
      }
      if (!pick) {
        notes.push(`${d}: no complete outfit from home stock for ${dest.label} weather (${composed.shortfall ?? 'no candidates'})`);
        continue;
      }
      chosen.push(pick);
      days.push({ date: d, garments: pick.slots.map((s) => ({ garmentId: s.garmentId, name: context.byId.get(s.garmentId)!.name, role: s.role })), why: `${dest.label}: ${context.weather.summary.line}` });
    }
    const qty = new Map<string, number>();
    for (const c of chosen) {
      for (const s of c.slots) {
        // Shirts and socks are consumed per wear; everything else is packed once and reused.
        const consumes = s.role === 'base_top' || s.role === 'socks';
        qty.set(s.garmentId, consumes ? (qty.get(s.garmentId) ?? 0) + 1 : 1);
      }
    }
    const items = [...qty.entries()].map(([garmentId, quantity]) => ({ garmentId, name: garmentId, quantity }));
    const rows = await requireGarments(this.db, this.principal.userId, items.map((i) => i.garmentId));
    for (const i of items) i.name = rows.get(i.garmentId)!.name;
    await this.db.batch(
      items.map((i) =>
        this.db
          .prepare('INSERT INTO trip_items (user_id, trip_id, garment_id, proposed_qty, packed_qty) VALUES (?, ?, ?, ?, 0) ON CONFLICT (user_id, trip_id, garment_id) DO UPDATE SET proposed_qty = excluded.proposed_qty')
          .bind(this.principal.userId, tripId, i.garmentId, i.quantity),
      ),
    );
    if (trip.laundryOpportunities.length) notes.push('Laundry opportunities are recorded as estimates only; nothing is assumed washed on the trip until reported.');
    return { tripId, days, items, notes };
  }

  /** "Packed": the owner's statement of what went into the suitcase (distinct from the proposal). */
  async markPacked(tripId: string, items: { garmentId: string; quantity: number }[], occurredAt?: string): Promise<{ trip: TripRecord; items: TripItemRecord[]; summary: string }> {
    requireScope(this.principal, SCOPE_WRITE);
    const { trip } = await this.getTrip(tripId);
    if (trip.status === 'completed' || trip.status === 'cancelled') throw new DomainError('invalid_state', `That trip is ${trip.status}`);
    if (!items.length || items.some((i) => !Number.isInteger(i.quantity) || i.quantity < 1)) throw new DomainError('validation_failed', 'Name the packed pieces with a quantity of at least one');
    const rows = await requireGarments(this.db, this.principal.userId, items.map((i) => i.garmentId));
    const at = occurredAt ? new Date(occurredAt).toISOString() : this.clock();
    await this.db.batch([
      ...items.map((i) =>
        this.db
          .prepare(
            `INSERT INTO trip_items (user_id, trip_id, garment_id, proposed_qty, packed_qty, packed_at) VALUES (?, ?, ?, 0, ?, ?)
             ON CONFLICT (user_id, trip_id, garment_id) DO UPDATE SET packed_qty = excluded.packed_qty, packed_at = excluded.packed_at, unpacked_qty = 0, unpacked_at = NULL`,
          )
          .bind(this.principal.userId, tripId, i.garmentId, i.quantity, at),
      ),
      this.db.prepare("UPDATE trips SET status = 'packed', packed_at = COALESCE(packed_at, ?), version = version + 1 WHERE user_id = ? AND trip_id = ? AND version = ?").bind(at, this.principal.userId, tripId, trip.version),
    ]);
    const after = await this.getTrip(tripId);
    return { ...after, summary: `Packed for ${trip.name}: ${items.map((i) => `${rows.get(i.garmentId)!.name}${i.quantity > 1 ? ` ×${i.quantity}` : ''}`).join(', ')}.` };
  }

  /** "Unpacked": units return home. Nothing is declared clean; worn pieces stay dirty in the ledger. */
  async markUnpacked(tripId: string, occurredAt?: string, items?: { garmentId: string; quantity: number }[]): Promise<{ trip: TripRecord; items: TripItemRecord[]; summary: string }> {
    requireScope(this.principal, SCOPE_WRITE);
    const { trip, items: current } = await this.getTrip(tripId);
    if (trip.status !== 'packed') throw new DomainError('invalid_state', 'Only a packed trip can be unpacked');
    const at = occurredAt ? new Date(occurredAt).toISOString() : this.clock();
    const targets = items ?? current.filter((i) => i.packedQty > i.unpackedQty).map((i) => ({ garmentId: i.garmentId, quantity: i.packedQty }));
    const stmts = targets.map((i) =>
      this.db
        .prepare('UPDATE trip_items SET unpacked_qty = MIN(packed_qty, ?), unpacked_at = ? WHERE user_id = ? AND trip_id = ? AND garment_id = ?')
        .bind(i.quantity, at, this.principal.userId, tripId, i.garmentId),
    );
    await this.db.batch(stmts);
    const remaining = (await loadTripItems(this.db, this.principal.userId, tripId)).some((i) => i.packedQty > i.unpackedQty);
    if (!remaining) {
      await this.db.prepare("UPDATE trips SET status = 'completed', unpacked_at = ?, version = version + 1 WHERE user_id = ? AND trip_id = ?").bind(at, this.principal.userId, tripId).run();
    }
    const after = await this.getTrip(tripId);
    return { ...after, summary: `Unpacked ${targets.length} piece${targets.length === 1 ? '' : 's'} from ${trip.name}. Nothing is marked clean: tell me what you wash, or the next care cycle covers it.` };
  }

  /** A destination board for one trip day from the packed subset only. */
  async composeTripDay(tripId: string, date: string, extra: { requestedCount?: number } = {}): Promise<PublishOutcome & { board: Board | null }> {
    const { trip } = await this.getTrip(tripId);
    if (trip.status !== 'packed') throw new DomainError('invalid_state', 'Pack the trip before composing destination boards');
    if (date < trip.departsOn || date > trip.returnsOn) throw new DomainError('validation_failed', 'That date is outside the trip');
    return this.recommendations.composeAndPublish({ date, purpose: `trip:${tripId}`, requestedCount: extra.requestedCount ?? 3 });
  }
}
