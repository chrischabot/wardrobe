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
import { composeBoard, eligibleFor } from "./compose.ts";
import { execAs, nowOf, type DailyDeps } from "./deps.ts";
import { fetchWeatherSnapshot } from "./snapshots.ts";
import { prepareBoard, type PrepareBoardResult } from "./service.ts";
import { destinationFor, occasionSnapshot } from "./trip-day.ts";

/**
 * Clean units at home, observed or counted clean by the weekly laundry baseline alike: what packing plans
 * with. `cleanObserved` counts only the units an observation showed clean; it is evidence, not stock.
 */
function cleanAtHome(a: { balances: { bucket: string; quantity: number }[] }): number {
  return a.balances.filter((b) => b.bucket === "clean").reduce((n, b) => n + b.quantity, 0);
}

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
    const trip = await first<{ status: string; name: string; departs_on: string }>(ctx.db, "SELECT status, name, departs_on FROM trips WHERE user_id = ? AND trip_id = ?", ctx.userId, p.tripId);
    if (!trip || trip.status !== "planned") throw new CommandError("not_found", `no active trip '${p.tripId}'`);
    const last = await first<{ revision: number | null }>(ctx.db, "SELECT MAX(revision) AS revision FROM trip_packing_proposals WHERE user_id = ? AND trip_id = ?", ctx.userId, p.tripId);
    const revision = (last?.revision ?? 0) + 1;
    const proposal: PackingProposal = { tripId: p.tripId, revision, createdAt: ctx.now, items: p.items, days: p.days, repeatExceptionForTrip: true, weather: p.weather, notes: p.notes };
    return {
      summary: `Packing proposed for “${trip.name}”: ${packedPieces(p.items, p.days, trip.departs_on)} pieces to pack for ${p.days.length} outfits${wornOnTravelDay(p.days, trip.departs_on).size > 0 ? ", with the travel-day outfit worn" : ""}. This is a proposal; nothing is packed until you say so`,
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
  // Packing (a foundation command) is accepted only for this owner's own trip that is still planned:
  // an unknown trip, another owner's trip and a cancelled trip are refused in the owner's words.
  registry.registerEntityCheck("trip", async (db, userId, id) => {
    const trip = await first<{ name: string; status: string }>(db, "SELECT name, status FROM trips WHERE user_id = ? AND trip_id = ?", userId, id);
    if (!trip) return { ok: false, reason: "there is no such trip", notFound: true };
    if (trip.status !== "planned") return { ok: false, reason: `${trip.name} is ${trip.status === "cancelled" ? "cancelled" : "no longer a planned trip"}` };
    return { ok: true };
  });
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
 *
 * A trip with a luggage limit is planned to fit it: when the set does not fit, the plan is made again with
 * more deliberate reuse (trousers on more days, then a shirt worn twice, then three times), and the first
 * plan that fits is proposed. Only when no level of reuse fits is the shortfall stated, with the smallest set.
 */
export async function proposePacking(deps: DailyDeps, principal: Principal, input: { tripId: string; clientRequestId: string; nowMs?: number }): Promise<PackingProposal> {
  assertPrincipal(principal);
  requireScope(principal, "write");
  const nowMs = nowOf(deps, input.nowMs);
  const trip = await getTrip(deps.db, principal, input.tripId);
  if (!trip || trip.status !== "planned") throw new CommandError("not_found", `no active trip '${input.tripId}'`);

  // Each destination forecast is read once, whatever the number of plans tried.
  const forecasts = new Map<string, Awaited<ReturnType<typeof fetchWeatherSnapshot>>>();
  const forecast = async (date: string, segment: "day" | "evening") => {
    const key = `${date}|${segment}`;
    let s = forecasts.get(key);
    if (!s) {
      s = await fetchWeatherSnapshot(deps, principal, { localDate: date, location: destinationFor(trip, date), purpose: "trip", ...(segment === "evening" ? { segment: "evening" as const } : {}), nowMs });
      forecasts.set(key, s);
    }
    return s;
  };
  const weather: PackingProposal["weather"] = [];
  for (let date = trip.departsOn; date <= trip.returnsOn; date = addDays(date, 1)) {
    const s = await forecast(date, "day");
    weather.push({ localDate: date, label: destinationFor(trip, date).label, freshness: s.freshness, line: s.line });
  }

  const LEVELS: Partial<Record<Role, number>>[] = [
    { bottom: 2, outer: 99, footwear: 99, belt: 99 },
    { bottom: 99, outer: 99, footwear: 99, belt: 99 },
    { top: 2, bottom: 99, outer: 99, footwear: 99, belt: 99 },
    { top: 3, bottom: 99, outer: 99, footwear: 99, belt: 99 },
  ];
  const limit = trip.luggage?.maxPieces ?? null;
  const chosen = await choosePackingPlan(LEVELS.length, limit, async (i) => withoutOptionalFlourishes({ ...(await planPacking(deps, principal, trip, nowMs, forecast, LEVELS[i]!)), travelDate: trip.departsOn }, limit));
  const plan = chosen.plan;
  const level = chosen.level;
  const { items, days } = plan;
  const notes = [...plan.notes];
  if (plan.leftOut.length > 0) notes.push(`To save space in ${trip.luggage!.label}, the optional ${plan.leftOut.join(" and ")} ${plan.leftOut.length === 1 ? "is" : "are"} left out.`);
  const worn = wornOnTravelDay(days, trip.departsOn);
  if (limit !== null && worn.size > 0) notes.push(`The outfit worn on ${trip.departsOn} for the journey is not packed, so it does not count against ${trip.luggage!.label}: ${plan.pieces} ${plan.pieces === 1 ? "piece is" : "pieces are"} packed.`);
  if (limit !== null && plan.pieces > limit) notes.push(`This is ${plan.pieces} pieces against a limit of ${limit} for ${trip.luggage!.label}, even with trousers and shirts reused across days and the travel-day outfit worn rather than packed.`);
  else if (level >= 1) notes.push(`To fit ${trip.luggage!.label} (${limit} pieces), ${level === 1 ? "trousers are worn on more days" : `a shirt is worn on up to ${LEVELS[level]!.top} days`} than usual.`);
  if (weather.some((w) => w.freshness !== "fresh")) notes.push("Some destination forecasts are stale or unavailable; those days were proposed without a verified forecast.");
  if (trip.laundry.length > 0) notes.push("Laundry opportunities on the trip are estimates until a wash is reported; the proposal does not count on them.");
  notes.push("Pieces are reused deliberately across days. That exception to the repeat rule applies to this trip only.");

  const payload = { tripId: trip.tripId, items: [...items.values()], days, weather, notes };
  const receipt = await execAs(deps, principal, "trip.record_packing_proposal", payload, `packing:${input.clientRequestId}`);
  return { tripId: trip.tripId, revision: Number((receipt.result as any).revision), createdAt: receipt.recordedAt, items: payload.items, days, repeatExceptionForTrip: true, weather, notes };
}

/** Garments of the departure day's daytime outfit: worn for the journey, so one unit of each is not packed. */
export function wornOnTravelDay(days: PackingProposal["days"], travelDate: string | null | undefined): Set<string> {
  if (!travelDate) return new Set();
  return new Set(days.find((d) => d.localDate === travelDate && d.segment === "day")?.slots.map((s) => s.garmentId) ?? []);
}

/**
 * Pieces that go in the bag, the measure a luggage limit is judged by (coordinator decision on journey D07-5):
 * every unit the trip needs, less the one unit of each garment worn on the travel day. An alternative shoe of
 * the paired format is carried, not worn, so it is packed.
 */
export function packedPieces(items: Iterable<{ garmentId: string; quantity: number }>, days: PackingProposal["days"], travelDate: string | null | undefined): number {
  const worn = wornOnTravelDay(days, travelDate);
  let n = 0;
  for (const i of items) n += Math.max(0, i.quantity - (worn.has(i.garmentId) ? 1 : 0));
  return n;
}

/** Roles that only carry the belt line's optional flourish (profile section 5: "often ignored, always welcome"). */
const OPTIONAL_FLOURISH_ROLES: ReadonlySet<Role> = new Set<Role>(["neckwear", "accessory"]);

/**
 * A plan over the luggage limit leaves out its optional flourishes (tie, scarf, pocket square), one at a
 * time, before it is judged against the limit: a piece the owner often ignores never costs the bag a
 * place it does not have. Nothing a hard rule needs is removed, and a plan within the limit keeps them.
 */
export function withoutOptionalFlourishes<P extends { items: Map<string, { garmentId: string; name: string; role: Role; quantity: number }>; days: PackingProposal["days"]; pieces: number; travelDate?: string | null }>(plan: P, limit: number | null): P & { leftOut: string[] } {
  if (limit === null || plan.pieces <= limit) return { ...plan, leftOut: [] };
  const items = new Map(plan.items);
  let days = plan.days;
  let pieces = plan.pieces;
  const leftOut: string[] = [];
  for (const item of [...items.values()].filter((i) => OPTIONAL_FLOURISH_ROLES.has(i.role))) {
    if (pieces <= limit) break;
    items.delete(item.garmentId);
    days = days.map((d) => ({ ...d, slots: d.slots.filter((s) => s.garmentId !== item.garmentId) }));
    pieces = packedPieces(items.values(), days, plan.travelDate);
    leftOut.push(item.name);
  }
  return { ...plan, items, days, pieces, leftOut };
}

/**
 * Which packing plan is proposed against a luggage limit. Plans are made level by level (more reuse at each)
 * until one fits. A day or evening left without an outfit is never a saving: a retry fits only when it still
 * covers as many days and evenings as any plan tried so far. When none fits, the smallest of the plans with
 * the best coverage is proposed (level -1).
 */
export async function choosePackingPlan<T extends { pieces: number; covered: number }>(levels: number, limit: number | null, planAt: (level: number) => Promise<T>): Promise<{ plan: T; level: number }> {
  const first = await planAt(0);
  if (limit === null || first.pieces <= limit) return { plan: first, level: 0 };
  const tried = [first];
  let bestCoverage = first.covered;
  for (let i = 1; i < levels; i++) {
    const next = await planAt(i);
    tried.push(next);
    bestCoverage = Math.max(bestCoverage, next.covered);
    if (next.pieces <= limit && next.covered >= bestCoverage) return { plan: next, level: i };
  }
  const best = tried.filter((p) => p.covered === bestCoverage).reduce((a, b) => (b.pieces < a.pieces ? b : a));
  return { plan: best, level: -1 };
}

/** One packing plan for the whole trip, reusing each role up to `REUSE_LIMIT` days (a role without a limit is not reused). */
async function planPacking(
  deps: DailyDeps,
  principal: Principal,
  trip: Trip,
  nowMs: number,
  forecast: (date: string, segment: "day" | "evening") => ReturnType<typeof fetchWeatherSnapshot>,
  REUSE_LIMIT: Partial<Record<Role, number>>,
): Promise<{ items: Map<string, { garmentId: string; name: string; role: Role; quantity: number }>; days: PackingProposal["days"]; notes: string[]; pieces: number; covered: number }> {
  const items = new Map<string, { garmentId: string; name: string; role: Role; quantity: number }>();
  const days: PackingProposal["days"] = [];
  const notes: string[] = [];
  const reuse = new Map<Role, { garmentId: string; uses: number }>();
  const usedTops: string[] = [];
  /** Days each shirt in the proposal is worn on (a shirt is reused while under its limit, not only the last one). */
  const topUses = new Map<string, number>();
  /** Clean pairs at home of each sock already in the proposal. */
  const sockUnits = new Map<string, number>();

  for (let date = trip.departsOn; date <= trip.returnsOn; date = addDays(date, 1)) {
    const segments: ("day" | "evening")[] = ["day", ...(trip.occasions.some((o) => o.localDate === date && o.segment === "evening") ? ["evening" as const] : [])];
    for (const segment of segments) {
      const occasion = trip.occasions.find((o) => o.localDate === date && o.segment === segment) ?? null;
      const eveningSnapshot = await forecast(date, segment);
      // A pair of socks is worn for one day. Pairs already planned for earlier days are not planned
      // again: once every clean pair of a sock is allocated, that sock is excluded for the remaining
      // days (the same day's dinner still reuses the pair worn that day).
      const wornToday = days.find((d) => d.localDate === date)?.slots.find((s) => s.role === "socks")?.garmentId ?? null;
      const allocatedSocks = [...items.values()].filter((i) => i.role === "socks" && i.garmentId !== wornToday && i.quantity >= (sockUnits.get(i.garmentId) ?? 1)).map((i) => i.garmentId);
      const contextFor = (exclude: string[]) => assembleContext(deps.db, principal, {
        localDate: date,
        nowMs,
        scope: segment === "evening" ? "home:evening" : "home",
        brief: DayBrief.parse({ allowRepeat: true, requestedCount: 1, segment, exclude }),
        weather: eveningSnapshot,
        calendar: occasionSnapshot(trip, date, segment, nowMs),
      });
      let rc = await contextFor(allocatedSocks);
      // Deliberate reuse: lock pieces already in the bag while they still validate for this day.
      const attempt = async (lockedRoles: Role[]) => {
        const locked: OutfitSlot[] = lockedRoles.filter((role) => role !== "top").flatMap((role) => {
          const r = reuse.get(role);
          return r && r.uses < (REUSE_LIMIT[role] ?? 1) ? [{ role, garmentId: r.garmentId }] : [];
        });
        const evening = segment === "evening" ? days.find((d) => d.localDate === date && d.segment === "day") : undefined;
        if (evening) for (const role of ["bottom", "socks"] as Role[]) {
          const id = evening.slots.find((s) => s.role === role)?.garmentId;
          if (id && !locked.some((l) => l.role === role)) locked.push({ role, garmentId: id });
        }
        const composeWith = async (slots: OutfitSlot[]) => (await composeBoard(rc, { count: 1, reserveCount: 0, locked: slots, avoidTops: usedTops.filter((id) => !slots.some((l) => l.garmentId === id)), everydayFlourish: false, validate: { allowRepeat: true, ignoreBriefInclusions: true } })).options[0] ?? null;
        if (!lockedRoles.includes("top")) return composeWith(locked);
        // Shirt reuse: every shirt already in the bag and still under its limit is tried, the most recent
        // first, before a new shirt is considered (by the next, shirt-free attempt of the cascade).
        for (const top of [...usedTops].reverse()) {
          if ((topUses.get(top) ?? 0) >= (REUSE_LIMIT.top ?? 1)) continue;
          const option = await composeWith([...locked, { role: "top", garmentId: top }]);
          if (option) return option;
        }
        return null;
      };
      // Locks are relaxed step by step. When shirts may be reused, every relaxation is first tried with a
      // shirt already in the bag; only when no relaxation admits one is a new shirt considered.
      const relaxations: Role[][] = [["bottom", "outer", "footwear", "belt"], ["outer", "footwear", "belt"], ["footwear"], []];
      const cascade = async () => {
        if (REUSE_LIMIT.top !== undefined) for (const roles of relaxations) {
          const option = await attempt(["top", ...roles]);
          if (option) return option;
        }
        for (const roles of relaxations) {
          const option = await attempt(roles);
          if (option) return option;
        }
        return null;
      };
      let option = await cascade();
      let socksRanOut = false;
      // Clean pairs at home that are not yet planned for an earlier day (they may still not suit this day).
      const unplannedCleanSocks = [...rc.garments.values()].some((g) => g.roles.includes("socks") && cleanAtHome(g.availability) > 0 && !allocatedSocks.includes(g.garmentId));
      if (!option && allocatedSocks.length > 0) {
        // Every clean pair of socks at home is already planned for an earlier day. That is said in so
        // many words, and the rest of the day is still planned (and packed): the day is composed as if
        // one more pair were clean, then listed without socks. No pair is planned twice.
        rc = await contextFor([]);
        option = await cascade();
        socksRanOut = option !== null;
      }
      if (!option) {
        // With no eligible pair of socks at all the day cannot be composed; the note still names socks, and
        // says whether no pair is clean at home or clean pairs exist that do not suit the day.
        const noEligibleSocks = eligibleFor(rc, "socks", { allowRepeat: true }).length === 0;
        const cleanSocksAtHome = [...rc.garments.values()].some((g) => g.roles.includes("socks") && cleanAtHome(g.availability) > 0);
        const where = `${date}${segment === "evening" ? " (evening)" : ""}`;
        notes.push(!noEligibleSocks
          ? `No complete valid outfit could be proposed for ${where} from what is available at home.`
          : cleanSocksAtHome
            ? `No outfit could be proposed for ${where}: the clean socks at home do not suit that day (its temperature, a restriction or another rule).`
            : `No outfit could be proposed for ${where}: no clean pair of socks is available at home.`);
        continue;
      }
      if (socksRanOut) {
        option = { ...option, slots: option.slots.filter((s) => s.role !== "socks") };
        notes.push(unplannedCleanSocks
          ? `No clean pair of socks that suits ${date}${segment === "evening" ? " (evening)" : ""} is left: the pairs that suit it are already planned for earlier days of the trip, and the other clean pairs at home do not suit that day (its temperature, a restriction or another rule). The rest of that day is planned without socks; one more suitable pair is needed before then.`
          : `No clean pair of socks is left for ${date}${segment === "evening" ? " (evening)" : ""}: every clean pair at home is already planned for an earlier day of the trip. The rest of that day is planned without socks; one more clean pair is needed before then.`);
      }
      days.push({ localDate: date, segment, occasion: occasion?.label ?? null, slots: option.slots, reason: option.reason });
      for (const s of option.slots) {
        const g = rc.garments.get(s.garmentId)!;
        const entry = items.get(s.garmentId) ?? { garmentId: s.garmentId, name: g.name, role: s.role, quantity: 0 };
        // Interchangeable units (socks) are counted per wearing day; other pieces are packed once.
        const sameDayReuse = days.some((d) => d !== days[days.length - 1] && d.localDate === date && d.slots.some((x) => x.garmentId === s.garmentId));
        if (s.role === "socks") {
          // Only a sock with a clean pair on the ledger can be chosen at all (a garment with no clean
          // unit at home is hard-excluded by the availability estimator), so the pairs that can be
          // packed are exactly the clean pairs counted there, observed or counted by the weekly baseline.
          const units = Math.max(1, cleanAtHome(g.availability));
          sockUnits.set(s.garmentId, units);
          entry.quantity = sameDayReuse ? entry.quantity : Math.min(entry.quantity + 1, units);
        } else entry.quantity = 1;
        items.set(s.garmentId, entry);
        if (s.role === "top" && !usedTops.includes(s.garmentId)) usedTops.push(s.garmentId);
        if (s.role === "top" && !sameDayReuse) topUses.set(s.garmentId, (topUses.get(s.garmentId) ?? 0) + 1);
        if (REUSE_LIMIT[s.role] !== undefined && s.role !== "top") {
          const r = reuse.get(s.role);
          if (r && r.garmentId === s.garmentId) r.uses += sameDayReuse ? 0 : 1;
          else reuse.set(s.role, { garmentId: s.garmentId, uses: 1 });
        }
      }
      // The alternative shoe of the paired format is part of the day's outfit, so it is packed (once) and
      // counted against the luggage limit like any other piece.
      for (const id of option.footwearAlternatives ?? []) {
        if (option.slots.some((s) => s.garmentId === id)) continue;
        const g = rc.garments.get(id);
        if (!g) continue;
        items.set(id, { ...(items.get(id) ?? { garmentId: id, name: g.name, role: "footwear" as Role }), quantity: 1 });
      }
    }
  }
  return { items, days, notes, pieces: packedPieces(items.values(), days, trip.departsOn), covered: days.length };
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
