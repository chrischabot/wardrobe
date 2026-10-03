/**
 * Trip and packing mode (specification section 10).
 *
 * A trip records dates, destinations with their timezones, occasions, luggage limits and laundry
 * opportunities. A packing PROPOSAL is only a proposal: what is physically packed is whatever the
 * owner's `stock.pack` observations say, read back from the stock ledger. Trip-day boards draw on the
 * packed subset only, so home stock and home laundry resets cannot leak into them, and unpacking
 * (`stock.unpack`) returns pieces home without declaring them clean.
 */
import type { Role } from "@garderobe/contracts";
import { DAILY_COMMANDS, DayBrief } from "@garderobe/contracts/ext/daily";
import type { OutfitSlot, PackingProposal, Trip, TripDestination } from "@garderobe/contracts/ext/daily";
import { addDays, all, assertPrincipal, CommandError, define, first, json, requireScope, stmt, type CommandPlan, type CommandRegistry, type Db, type Principal } from "@garderobe/domain";
import { assembleContext } from "./context.ts";
import { composeBoard } from "./compose.ts";
import { execAs, nowOf, type DailyDeps } from "./deps.ts";
import { fetchWeatherSnapshot } from "./snapshots.ts";
import { prepareBoard, type PrepareBoardResult } from "./service.ts";
import { destinationFor, occasionSnapshot } from "./trip-day.ts";

function checkDestinations(departsOn: string, returnsOn: string, destinations: TripDestination[]): void {
  if (returnsOn < departsOn) throw new CommandError("invalid_command", "the return date is before the departure date");
  for (const d of destinations) {
    if (d.to < d.from) throw new CommandError("invalid_command", `the stay in ${d.label} ends before it starts`);
    if (d.from < departsOn || d.to > returnsOn) throw new CommandError("invalid_command", `the stay in ${d.label} is outside the trip dates`);
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: d.timezone });
    } catch {
      throw new CommandError("invalid_command", `unknown timezone '${d.timezone}' for ${d.label}`);
    }
  }
}

export const tripCreate = define({
  type: "trip.create",
  schema: DAILY_COMMANDS["trip.create"],
  class: "edit",
  requiredScope: "write",
  async plan(ctx, p): Promise<CommandPlan> {
    checkDestinations(p.departsOn, p.returnsOn, p.destinations);
    const tripId = p.tripId ?? ctx.newId("trp");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tripId)) throw new CommandError("invalid_command", "a trip ID may contain only letters, digits, '-' and '_'");
    return {
      summary: `Trip “${p.name}” recorded: ${p.departsOn} to ${p.returnsOn}, ${p.destinations.map((d) => d.label).join(", ")}. Nothing is packed until you say so`,
      statements: [
        stmt(
          "INSERT INTO trips (user_id, trip_id, version, name, departs_on, returns_on, destinations_json, occasions_json, luggage_json, laundry_json, status, source_json, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?)",
          ctx.userId, tripId, p.name, p.departsOn, p.returnsOn, JSON.stringify(p.destinations), JSON.stringify(p.occasions), p.luggage ? JSON.stringify(p.luggage) : null, JSON.stringify(p.laundry), JSON.stringify(p.source), ctx.now, ctx.now,
        ),
      ],
      preconditions: [{ label: "the trip ID is new", sql: "NOT EXISTS (SELECT 1 FROM trips WHERE user_id = ? AND trip_id = ?)", params: [ctx.userId, tripId], class: "state" }],
      affected: [{ kind: "trip", id: tripId, version: 1 }],
      result: { tripId },
      undo: { data: { tripId } },
    };
  },
  async planUndo(ctx, _o, data): Promise<CommandPlan> {
    const packed = await first<{ n: number }>(ctx.db, "SELECT COALESCE(SUM(quantity), 0) AS n FROM stock_balances WHERE user_id = ? AND bucket = 'trip' AND (ref = ? OR ref = ?)", ctx.userId, data.tripId, `${data.tripId}#dirty`);
    if ((packed?.n ?? 0) > 0) throw new CommandError("not_undoable", "pieces are packed for this trip; unpack them first");
    return {
      summary: "Trip removed",
      statements: [stmt("UPDATE trips SET status = 'cancelled', version = version + 1, updated_at = ? WHERE user_id = ? AND trip_id = ?", ctx.now, ctx.userId, data.tripId)],
      undo: { unavailableReason: "this is already an undo" },
    };
  },
});

export const tripUpdate = define({
  type: "trip.update",
  schema: DAILY_COMMANDS["trip.update"],
  class: "edit",
  requiredScope: "write",
  async plan(ctx, p): Promise<CommandPlan> {
    const row = await first<any>(ctx.db, "SELECT * FROM trips WHERE user_id = ? AND trip_id = ?", ctx.userId, p.tripId);
    if (!row || row.status !== "planned") throw new CommandError("not_found", `no active trip '${p.tripId}'`);
    const c = p.changes;
    const next = {
      name: c.name ?? row.name,
      departsOn: c.departsOn ?? row.departs_on,
      returnsOn: c.returnsOn ?? row.returns_on,
      destinations: c.destinations ?? json<TripDestination[]>(row.destinations_json, []),
      occasions: c.occasions ?? json(row.occasions_json, []),
      luggage: c.luggage !== undefined ? c.luggage : json(row.luggage_json, null),
      laundry: c.laundry ?? json(row.laundry_json, []),
    };
    checkDestinations(next.departsOn, next.returnsOn, next.destinations);
    return {
      summary: `Trip “${next.name}” updated: ${Object.keys(c).join(", ")}`,
      statements: [
        stmt(
          "UPDATE trips SET version = version + 1, name = ?, departs_on = ?, returns_on = ?, destinations_json = ?, occasions_json = ?, luggage_json = ?, laundry_json = ?, updated_at = ? WHERE user_id = ? AND trip_id = ?",
          next.name, next.departsOn, next.returnsOn, JSON.stringify(next.destinations), JSON.stringify(next.occasions), next.luggage ? JSON.stringify(next.luggage) : null, JSON.stringify(next.laundry), ctx.now, ctx.userId, p.tripId,
        ),
      ],
      preconditions: [{ label: `trip ${p.tripId} unchanged since read`, sql: "(SELECT version FROM trips WHERE user_id = ? AND trip_id = ?) = ?", params: [ctx.userId, p.tripId, row.version], class: "internal" }],
      affected: [{ kind: "trip", id: p.tripId, version: row.version + 1 }],
      result: { tripId: p.tripId, version: row.version + 1 },
      undo: { unavailableReason: "edit the trip again instead" },
    };
  },
});

export const tripCancel = define({
  type: "trip.cancel",
  schema: DAILY_COMMANDS["trip.cancel"],
  class: "edit",
  requiredScope: "write",
  async plan(ctx, p): Promise<CommandPlan> {
    const row = await first<any>(ctx.db, "SELECT version, status, name FROM trips WHERE user_id = ? AND trip_id = ?", ctx.userId, p.tripId);
    if (!row) throw new CommandError("not_found", `no trip '${p.tripId}'`);
    if (row.status === "cancelled") return { outcome: "noop", summary: "That trip was already cancelled", undo: { unavailableReason: "nothing changed" } };
    const packed = await first<{ n: number }>(ctx.db, "SELECT COALESCE(SUM(quantity), 0) AS n FROM stock_balances WHERE user_id = ? AND bucket = 'trip' AND (ref = ? OR ref = ?)", ctx.userId, p.tripId, `${p.tripId}#dirty`);
    return {
      summary: `Trip “${row.name}” cancelled${(packed?.n ?? 0) > 0 ? "; its packed pieces stay recorded as packed until you unpack them" : ""}`,
      statements: [stmt("UPDATE trips SET status = 'cancelled', version = version + 1, updated_at = ? WHERE user_id = ? AND trip_id = ?", ctx.now, ctx.userId, p.tripId)],
      affected: [{ kind: "trip", id: p.tripId, version: row.version + 1 }],
      result: { tripId: p.tripId, stillPacked: packed?.n ?? 0 },
      undo: { unavailableReason: "create the trip again instead" },
    };
  },
});

export const tripRecordPackingProposal = define({
  type: "trip.record_packing_proposal",
  schema: DAILY_COMMANDS["trip.record_packing_proposal"],
  class: "system",
  requiredScope: "write",
  allowedAuthorizations: ["standing_policy", "system_schedule", "owner_tap", "owner_statement"],
  async plan(ctx, p): Promise<CommandPlan> {
    const trip = await first<{ status: string; name: string }>(ctx.db, "SELECT status, name FROM trips WHERE user_id = ? AND trip_id = ?", ctx.userId, p.tripId);
    if (!trip || trip.status !== "planned") throw new CommandError("not_found", `no active trip '${p.tripId}'`);
    const last = await first<{ revision: number | null }>(ctx.db, "SELECT MAX(revision) AS revision FROM trip_packing_proposals WHERE user_id = ? AND trip_id = ?", ctx.userId, p.tripId);
    const revision = (last?.revision ?? 0) + 1;
    const proposal: PackingProposal = { tripId: p.tripId, revision, createdAt: ctx.now, items: p.items, days: p.days, repeatExceptionForTrip: true, weather: p.weather, notes: p.notes };
    return {
      summary: `Packing proposed for “${trip.name}”: ${p.items.reduce((n, i) => n + i.quantity, 0)} pieces for ${p.days.length} outfits. This is a proposal; nothing is packed until you say so`,
      statements: [stmt("INSERT INTO trip_packing_proposals (user_id, trip_id, revision, proposal_json, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?)", ctx.userId, p.tripId, revision, JSON.stringify(proposal), ctx.commandId, ctx.now)],
      preconditions: [{ label: "proposal revision is next", sql: "(SELECT COALESCE(MAX(revision), 0) FROM trip_packing_proposals WHERE user_id = ? AND trip_id = ?) = ?", params: [ctx.userId, p.tripId, revision - 1], class: "internal" }],
      affected: [{ kind: "trip_packing_proposal", id: p.tripId, version: revision }],
      result: { tripId: p.tripId, revision },
      undo: { unavailableReason: "ask for a new proposal instead" },
    };
  },
});

export function registerTripCommands(registry: CommandRegistry): void {
  for (const def of [tripCreate, tripUpdate, tripCancel, tripRecordPackingProposal]) registry.register(def);
  registry.registerVersionResolver("trip", (userId, id) => ({ sql: "SELECT version FROM trips WHERE user_id = ? AND trip_id = ?", params: [userId, id] }));
  // Receipts of other workstreams' commands (packing, unpacking) name a trip in the owner's words.
  registry.registerEntityNamer("trip", async (db, userId, id) => (await first<{ name: string }>(db, "SELECT name FROM trips WHERE user_id = ? AND trip_id = ?", userId, id))?.name ?? null);
}

/* ------------------------------------------------------------------ */
/* Reads                                                                */
/* ------------------------------------------------------------------ */

async function rowToTrip(db: Db, userId: string, r: any): Promise<Trip> {
  const balances = await all<{ garment_id: string; name: string; ref: string; quantity: number }>(
    db,
    "SELECT b.garment_id, g.name, b.ref, b.quantity FROM stock_balances b JOIN garments g ON g.user_id = b.user_id AND g.garment_id = b.garment_id WHERE b.user_id = ? AND b.bucket = 'trip' AND (b.ref = ? OR b.ref = ?) AND b.quantity > 0 ORDER BY g.name",
    userId, r.trip_id, `${r.trip_id}#dirty`,
  );
  const packed = new Map<string, { garmentId: string; name: string; clean: number; worn: number }>();
  for (const b of balances) {
    const entry = packed.get(b.garment_id) ?? { garmentId: b.garment_id, name: b.name, clean: 0, worn: 0 };
    if (b.ref === r.trip_id) entry.clean += b.quantity;
    else entry.worn += b.quantity;
    packed.set(b.garment_id, entry);
  }
  const proposal = await first<{ proposal_json: string }>(db, "SELECT proposal_json FROM trip_packing_proposals WHERE user_id = ? AND trip_id = ? ORDER BY revision DESC LIMIT 1", userId, r.trip_id);
  return {
    tripId: r.trip_id,
    version: r.version,
    name: r.name,
    departsOn: r.departs_on,
    returnsOn: r.returns_on,
    destinations: json(r.destinations_json, []),
    occasions: json(r.occasions_json, []),
    luggage: json(r.luggage_json, null),
    laundry: json(r.laundry_json, []),
    status: r.status,
    packed: [...packed.values()],
    proposal: proposal ? (JSON.parse(proposal.proposal_json) as PackingProposal) : null,
  };
}

export async function listTrips(db: Db, principal: Principal): Promise<Trip[]> {
  assertPrincipal(principal);
  requireScope(principal, "read");
  const rows = await all<any>(db, "SELECT * FROM trips WHERE user_id = ? ORDER BY departs_on, trip_id", principal.userId);
  const out: Trip[] = [];
  for (const r of rows) out.push(await rowToTrip(db, principal.userId, r));
  return out;
}

export async function getTrip(db: Db, principal: Principal, tripId: string): Promise<Trip | null> {
  assertPrincipal(principal);
  requireScope(principal, "read");
  const r = await first<any>(db, "SELECT * FROM trips WHERE user_id = ? AND trip_id = ?", principal.userId, tripId);
  return r ? rowToTrip(db, principal.userId, r) : null;
}

/* ------------------------------------------------------------------ */
/* Packing proposal                                                     */
/* ------------------------------------------------------------------ */

/**
 * Propose a compact set with deliberate reuse, from HOME stock, using the full taste context, the
 * destination forecast for each day and the trip's wearing intervals. Trousers, the jacket, the
 * shoes and the belt are reused across days; the repeat-policy exception this takes applies to the
 * trip only and rewrites no standing rule. The result is recorded as a proposal, never as packed.
 */
export async function proposePacking(deps: DailyDeps, principal: Principal, input: { tripId: string; clientRequestId: string; nowMs?: number }): Promise<PackingProposal> {
  assertPrincipal(principal);
  requireScope(principal, "write");
  const nowMs = nowOf(deps, input.nowMs);
  const trip = await getTrip(deps.db, principal, input.tripId);
  if (!trip || trip.status !== "planned") throw new CommandError("not_found", `no active trip '${input.tripId}'`);

  const items = new Map<string, { garmentId: string; name: string; role: Role; quantity: number }>();
  const days: PackingProposal["days"] = [];
  const weather: PackingProposal["weather"] = [];
  const notes: string[] = [];
  const reuse = new Map<Role, { garmentId: string; uses: number }>();
  const usedTops: string[] = [];
  /** Clean pairs at home of each sock already in the proposal. */
  const sockUnits = new Map<string, number>();
  const REUSE_LIMIT: Partial<Record<Role, number>> = { bottom: 2, outer: 99, footwear: 99, belt: 99 };

  for (let date = trip.departsOn; date <= trip.returnsOn; date = addDays(date, 1)) {
    const destination = destinationFor(trip, date);
    const snapshot = await fetchWeatherSnapshot(deps, principal, { localDate: date, location: destination, purpose: "trip", nowMs });
    weather.push({ localDate: date, label: destination.label, freshness: snapshot.freshness, line: snapshot.line });
    const segments: ("day" | "evening")[] = ["day", ...(trip.occasions.some((o) => o.localDate === date && o.segment === "evening") ? ["evening" as const] : [])];
    for (const segment of segments) {
      const occasion = trip.occasions.find((o) => o.localDate === date && o.segment === segment) ?? null;
      const eveningSnapshot = segment === "evening" ? await fetchWeatherSnapshot(deps, principal, { localDate: date, location: destination, purpose: "trip", segment: "evening", nowMs }) : snapshot;
      // A pair of socks is worn for one day. Pairs already planned for earlier days are not planned
      // again: once every clean pair of a sock is allocated, that sock is excluded for the remaining
      // days (the same day's dinner still reuses the pair worn that day).
      const wornToday = days.find((d) => d.localDate === date)?.slots.find((s) => s.role === "socks")?.garmentId ?? null;
      const allocatedSocks = [...items.values()].filter((i) => i.role === "socks" && i.garmentId !== wornToday && i.quantity >= (sockUnits.get(i.garmentId) ?? 1)).map((i) => i.garmentId);
      const rc = await assembleContext(deps.db, principal, {
        localDate: date,
        nowMs,
        scope: segment === "evening" ? "home:evening" : "home",
        brief: DayBrief.parse({ allowRepeat: true, requestedCount: 1, segment, exclude: allocatedSocks }),
        weather: eveningSnapshot,
        calendar: occasionSnapshot(trip, date, segment, nowMs),
      });
      // Deliberate reuse: lock pieces already in the bag while they still validate for this day.
      const attempt = async (lockedRoles: Role[]) => {
        const locked: OutfitSlot[] = lockedRoles.flatMap((role) => {
          const r = reuse.get(role);
          return r && r.uses < (REUSE_LIMIT[role] ?? 1) ? [{ role, garmentId: r.garmentId }] : [];
        });
        const evening = segment === "evening" ? days.find((d) => d.localDate === date && d.segment === "day") : undefined;
        if (evening) for (const role of ["bottom", "socks"] as Role[]) {
          const id = evening.slots.find((s) => s.role === role)?.garmentId;
          if (id && !locked.some((l) => l.role === role)) locked.push({ role, garmentId: id });
        }
        const composed = await composeBoard(rc, { count: 1, reserveCount: 0, locked, avoidTops: usedTops, everydayFlourish: false, validate: { allowRepeat: true, ignoreBriefInclusions: true } });
        return composed.options[0] ?? null;
      };
      const option = (await attempt(["bottom", "outer", "footwear", "belt"])) ?? (await attempt(["outer", "footwear", "belt"])) ?? (await attempt(["footwear"])) ?? (await attempt([]));
      if (!option) {
        notes.push(`No complete valid outfit could be proposed for ${date}${segment === "evening" ? " (evening)" : ""} from what is available at home.`);
        continue;
      }
      days.push({ localDate: date, segment, occasion: occasion?.label ?? null, slots: option.slots, reason: option.reason });
      for (const s of option.slots) {
        const g = rc.garments.get(s.garmentId)!;
        const entry = items.get(s.garmentId) ?? { garmentId: s.garmentId, name: g.name, role: s.role, quantity: 0 };
        // Interchangeable units (socks) are counted per wearing day; other pieces are packed once.
        const sameDayReuse = days.some((d) => d !== days[days.length - 1] && d.localDate === date && d.slots.some((x) => x.garmentId === s.garmentId));
        if (s.role === "socks") {
          const units = Math.max(1, g.availability.cleanObserved);
          sockUnits.set(s.garmentId, units);
          entry.quantity = sameDayReuse ? entry.quantity : Math.min(entry.quantity + 1, units);
        } else entry.quantity = 1;
        items.set(s.garmentId, entry);
        if (s.role === "top") usedTops.push(s.garmentId);
        if (REUSE_LIMIT[s.role] !== undefined) {
          const r = reuse.get(s.role);
          if (r && r.garmentId === s.garmentId) r.uses += sameDayReuse ? 0 : 1;
          else reuse.set(s.role, { garmentId: s.garmentId, uses: 1 });
        }
      }
    }
  }
  const pieces = [...items.values()].reduce((n, i) => n + i.quantity, 0);
  if (trip.luggage?.maxPieces && pieces > trip.luggage.maxPieces) notes.push(`This is ${pieces} pieces against a limit of ${trip.luggage.maxPieces} for ${trip.luggage.label}; wearing the travel-day outfit rather than packing it, or reusing a shirt, closes the gap.`);
  if (weather.some((w) => w.freshness !== "fresh")) notes.push("Some destination forecasts are stale or unavailable; those days were proposed without a verified forecast.");
  if (trip.laundry.length > 0) notes.push("Laundry opportunities on the trip are estimates until a wash is reported; the proposal does not count on them.");
  notes.push("Pieces are reused deliberately across days. That exception to the repeat rule applies to this trip only.");

  const payload = { tripId: trip.tripId, items: [...items.values()], days, weather, notes };
  const receipt = await execAs(deps, principal, "trip.record_packing_proposal", payload, `packing:${input.clientRequestId}`);
  return { tripId: trip.tripId, revision: Number((receipt.result as any).revision), createdAt: receipt.recordedAt, items: payload.items, days, repeatExceptionForTrip: true, weather, notes };
}

/** A trip-day board: destination weather, the trip's occasions, and ONLY the physically packed subset. */
export async function prepareTripDayBoard(deps: DailyDeps, principal: Principal, input: { tripId: string; date: string; clientRequestId: string; segment?: "day" | "evening"; count?: number; nowMs?: number }): Promise<PrepareBoardResult> {
  assertPrincipal(principal);
  requireScope(principal, "write");
  const nowMs = nowOf(deps, input.nowMs);
  const trip = await getTrip(deps.db, principal, input.tripId);
  if (!trip || trip.status !== "planned") throw new CommandError("not_found", `no active trip '${input.tripId}'`);
  if (input.date < trip.departsOn || input.date > trip.returnsOn) throw new CommandError("invalid_command", "that date is outside the trip");
  const segment = input.segment ?? "day";
  const destination = destinationFor(trip, input.date);
  const calendar = occasionSnapshot(trip, input.date, segment, nowMs);
  await execAs(deps, principal, "calendar.record_snapshot", { snapshot: calendar }, `calendar-snapshot:${calendar.snapshotId}`);
  return prepareBoard(deps, principal, {
    localDate: input.date,
    scope: segment === "evening" ? `trip:${trip.tripId}:evening` : `trip:${trip.tripId}`,
    purpose: "trip",
    location: destination,
    calendar,
    count: input.count,
    idempotencyKey: `trip-board:${input.clientRequestId}`,
    nowMs,
  });
}
