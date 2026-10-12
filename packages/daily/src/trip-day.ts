/**
 * Which trip a day belongs to, and what that trip says about the day. Shared by the trip functions and
 * by ad hoc recommendations, which answer a day away from the packed suitcase and never from home stock
 * (specification section 10).
 */
import type { CalendarSnapshot, PackingProposal, TripDestination } from "@garderobe/contracts/ext/daily";
import { first, json, newId, toInstant, type Db } from "@garderobe/domain";

/** The parts of a trip that a single day's recommendation needs. */
export interface TripDay {
  tripId: string;
  destinations: TripDestination[];
  occasions: { localDate: string; segment: "day" | "evening"; label: string; register: string }[];
}

export function destinationFor(trip: { destinations: TripDestination[] }, localDate: string): TripDestination {
  return trip.destinations.find((d) => d.from <= localDate && localDate <= d.to) ?? trip.destinations[0]!;
}

/** The trip's stated occasions as calendar context for one day (they are the owner's own statements). */
export function occasionSnapshot(trip: TripDay, localDate: string, segment: "day" | "evening", nowMs: number): CalendarSnapshot {
  const events = trip.occasions
    .filter((o) => o.localDate === localDate && o.segment === segment && o.register !== "none")
    .map((o, i) => ({ eventId: `trip-occasion:${trip.tripId}:${localDate}:${segment}:${i}`, calendarId: "trip", title: o.label, startsAt: null, endsAt: null, allDay: false, location: null, attendance: "accepted" as const, cancelled: false, weight: "full" as const, inferredOccasion: o.register as "smart" | "practical" | "none" }));
  return { snapshotId: newId("cal"), localDate, status: "ok", readAt: toInstant(nowMs), ageMinutes: 0, events, limitation: null };
}

/**
 * The trip the owner is away on that day: a recorded, uncancelled trip whose dates cover the day AND
 * for which something is physically packed. Until he says pieces are packed, a trip is only a plan
 * and the day is answered from home stock.
 */
export async function packedTripOn(db: Db, userId: string, localDate: string): Promise<TripDay | null> {
  const row = await first<{ trip_id: string; destinations_json: string; occasions_json: string }>(
    db,
    `SELECT t.trip_id, t.destinations_json, t.occasions_json FROM trips t
      WHERE t.user_id = ? AND t.status = 'planned' AND t.departs_on <= ? AND t.returns_on >= ?
        AND EXISTS (SELECT 1 FROM stock_balances b WHERE b.user_id = t.user_id AND b.bucket = 'trip' AND (b.ref = t.trip_id OR b.ref = t.trip_id || '#dirty') AND b.quantity > 0)
      ORDER BY t.departs_on DESC, t.trip_id LIMIT 1`,
    userId, localDate, localDate,
  );
  if (!row) return null;
  const destinations = json<TripDestination[]>(row.destinations_json, []);
  if (destinations.length === 0) return null;
  return { tripId: row.trip_id, destinations, occasions: json(row.occasions_json, []) };
}

/** Roles the packing proposal reuses deliberately across days (see `proposePacking`). Socks and shirts are worn once. */
export const PLANNED_REUSE_ROLES: ReadonlySet<string> = new Set(["bottom", "outer", "footwear", "belt"]);

/**
 * Pieces the packing proposal THE OWNER PACKED TO plans on more days than it packs units of, with the
 * days it plans them and that unit count. Packing to that proposal is the owner's explicit request for
 * the reuse, so a planned-again piece worn earlier on the trip is still wearable from the suitcase on a
 * day the proposal plans it; the exception is the trip's alone.
 *
 * Only trousers, the jacket, the shoes and the belt are reused this way. A pair of socks or a shirt is
 * worn for one day: a sock garment planned on three days is three pairs, and a pair that was worn is
 * never offered again however few were packed. The proposal read is the newest one recorded no later
 * than the owner's last packing report, compared as instants (julianday), never as text: the command
 * service writes "...:00Z" for a whole second and "...:00.500Z" otherwise, and as text the second sorts
 * before the first. A proposal regenerated after packing, however soon, changes nothing. The last
 * packing report is one row, the newest in the journal, and both its instant and its journal position
 * come from it; after that position a dirty report counts against re-wearing a piece.
 */
export async function plannedReuse(db: Db, userId: string, tripId: string): Promise<{ pieces: Map<string, { dates: Set<string>; units: number }>; packedSeq: number | null }> {
  const packed = await first<{ at: string; seq: number }>(db, "SELECT recorded_at AS at, seq FROM stock_events WHERE user_id = ? AND kind = 'pack' AND voided_by_command_id IS NULL AND json_extract(payload_json, '$.tripId') = ? ORDER BY seq DESC LIMIT 1", userId, tripId);
  if (!packed?.at) return { pieces: new Map(), packedSeq: null };
  const row = await first<{ proposal_json: string }>(db, "SELECT proposal_json FROM trip_packing_proposals WHERE user_id = ? AND trip_id = ? AND julianday(created_at) <= julianday(?) ORDER BY revision DESC LIMIT 1", userId, tripId, packed.at);
  const proposal = row ? json<PackingProposal | null>(row.proposal_json, null) : null;
  const dates = new Map<string, Set<string>>();
  for (const day of proposal?.days ?? []) for (const s of day.slots) if (PLANNED_REUSE_ROLES.has(s.role)) dates.set(s.garmentId, (dates.get(s.garmentId) ?? new Set()).add(day.localDate));
  const out = new Map<string, { dates: Set<string>; units: number }>();
  for (const [garmentId, d] of dates) {
    const units = Math.max(1, proposal?.items.find((i) => i.garmentId === garmentId)?.quantity ?? 1);
    if (d.size > units) out.set(garmentId, { dates: d, units });
  }
  return { pieces: out, packedSeq: packed.seq };
}
