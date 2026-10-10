/**
 * The invariants checked after EVERY step of a simulation, on application state read back through the
 * MCP tools (and, for the Calendar event, on what the Worker wrote to the Calendar stand-in).
 *
 * Each check has an identifier; a run reports how often each passed, failed or could not apply.
 *
 *   recommended.*      no offered garment is unknown, not owned, hard-excluded, restricted, made
 *                      unavailable by the simulated owner, or against a hard constraint of the profile
 *   wear.*             every report is counted, nothing is invented, one counted wear per garment and day
 *   availability.*     probabilities are probabilities; only a hard reason excludes; what the owner
 *                      observed or did stays as observed
 *   restriction.*      a restriction recorded from the profile is never lifted by the simulation
 *   calendar.*         one managed event per day, replaced in place under a revision that never goes back
 *   pause.*            nothing is published for a paused day
 */
import { createHash } from "node:crypto";
import { addDays } from "./dates.mjs";
import { hardConstraintViolations, neutralAdvisories } from "./profile-check.mjs";
import { internalCodesIn, isHardReason } from "./sim.mjs";

const linesOf = (option) => [...(option.garments ?? []), ...(option.footwearAlternatives ?? []), ...(option.flourish ? [option.flourish] : [])];

/** What the simulator knows about the forecast an offer for `date` was validated against; null when it cannot know. */
export function thermalFacts(sim, date, freshness) {
  const script = sim.scriptedWeather.get(date);
  if (!script) return null;
  const changedAt = sim.weatherChangedAt.get(date) ?? 0;
  if (freshness) {
    if (freshness.weather !== "fresh" || !freshness.weatherFetchedAt) return null;
    if (Date.parse(freshness.weatherFetchedAt) < changedAt) return null; // validated against the forecast before the change
  } else {
    // An ad hoc recommendation may reuse a forecast read within the last hour.
    if (sim.weatherDown) return null;
    if (sim.now() - changedAt < 61 * 60_000) return null;
    if (sim.weatherUpSince && sim.now() - sim.weatherUpSince < 61 * 60_000) return null;
  }
  return { departureC: script.morningC, peakC: Math.max(script.morningC, script.peakC, script.eveningC) };
}

/**
 * Check a list of offered outfits (a board's options or a recommendation's).
 * `context`: { date, source, freshness, tripPacked: Map | null }.
 */
export function checkOptions(sim, snapshot, options, context) {
  const { date, source } = context;
  // A trip day is validated against the destination's forecast; the thermal check here knows only the home forecast.
  const thermal = context.tripPacked ? null : thermalFacts(sim, date, context.freshness ?? null);
  if (!thermal) sim.count("offers checked without a thermal check (forecast unavailable, stale or just changed)");
  const worn = sim.wornInSevenDaysBefore(date);
  const named = sim.namedByRequest.get(date) ?? new Set();
  const problems = { unknown: [], notOwned: [], excluded: [], restricted: [], ownerUnavailable: [], notPacked: [], incomplete: [], profile: [], codes: [] };
  for (const option of options) {
    const roles = (option.garments ?? []).map((g) => g.role);
    if (!((roles.includes("top") || roles.includes("one_piece")) && (roles.includes("bottom") || roles.includes("one_piece")) && roles.includes("socks") && roles.includes("footwear"))) problems.incomplete.push(`${option.name}: roles ${roles.join(", ")}`);
    for (const line of linesOf(option)) {
      const item = snapshot.byId.get(line.garmentId);
      if (!item || item.garment.name !== line.name) {
        problems.unknown.push(`${line.name} (${option.name})`);
        continue;
      }
      if (context.tripPacked) {
        if (!context.tripPacked.has(line.garmentId)) problems.notPacked.push(`${line.name} (${option.name})`);
        continue;
      }
      const a = item.availability;
      if (item.garment.acquisition !== "owned") problems.notOwned.push(`${line.name}: ${item.garment.acquisition}`);
      if (!a || a.hardExcluded) problems.excluded.push(`${line.name}: ${(a?.reasons ?? ["no availability"]).join(", ")}`);
      if ((a?.restrictionIds ?? []).length > 0) problems.restricted.push(line.name);
      if (sim.unavailable.has(line.garmentId)) problems.ownerUnavailable.push(`${line.name}: ${sim.unavailable.get(line.garmentId).reason}`);
    }
    const violations = hardConstraintViolations(option, { thermal, wornLastSevenDays: worn, namedByRequest: named, onTrip: Boolean(context.tripPacked) });
    if (violations.length > 0) problems.profile.push(...violations);
    const advisories = neutralAdvisories(option);
    if (advisories.length > 0) sim.count("advisory: one neutral three times in an offered outfit (profile section 5, a preference)", advisories.length);
    for (const text of [option.name, option.reason, option.qualification].filter((t) => typeof t === "string")) for (const code of internalCodesIn(text)) problems.codes.push(`${code} in "${text.slice(0, 80)}"`);
  }
  const evidence = { source, date, options: options.map((o) => o.name) };
  const say = (list) => `${source} for ${date}: ${list.slice(0, 6).join("; ")}${list.length > 6 ? ` (and ${list.length - 6} more)` : ""}`;
  sim.check("recommended.garments_exist_under_their_names", problems.unknown.length === 0, say(problems.unknown), evidence);
  sim.check("recommended.complete_outfit", problems.incomplete.length === 0, say(problems.incomplete), evidence);
  if (context.tripPacked) sim.check("recommended.trip_day_uses_packed_pieces_only", problems.notPacked.length === 0, say(problems.notPacked), evidence);
  else {
    sim.check("recommended.owned", problems.notOwned.length === 0, say(problems.notOwned), evidence);
    sim.check("recommended.not_hard_excluded", problems.excluded.length === 0, say(problems.excluded), evidence);
    sim.check("recommended.not_restricted", problems.restricted.length === 0, say(problems.restricted), evidence);
    sim.check("recommended.not_made_unavailable_by_owner", problems.ownerUnavailable.length === 0, say(problems.ownerUnavailable), evidence);
  }
  sim.check("recommended.profile_hard_constraints", problems.profile.length === 0, say(problems.profile), { ...evidence, thermal });
  sim.check("owner_text.no_internal_codes", problems.codes.length === 0, say(problems.codes), evidence);
  return problems;
}

/** A published board: its options (unless it is history or suppressed) and its own consistency. */
export function checkBoard(sim, snapshot, board) {
  sim.check("board.selection_is_one_of_its_options", !board.selection || board.options.some((o) => o.optionId === board.selection.optionId) || board.validity === "worn", `board for ${board.localDate} revision ${board.revision}: the selected option is not on the board`, { boardId: board.boardId, revision: board.revision });
  sim.check("board.options_are_distinct", new Set(board.options.map((o) => o.optionId)).size === board.options.length, `board for ${board.localDate} repeats an option identifier`, { boardId: board.boardId });
  if (board.validity === "worn" || board.validity === "suppressed") return null;
  return checkOptions(sim, snapshot, board.options, { date: board.localDate, source: `board revision ${board.revision}`, freshness: board.freshness, tripPacked: board.scope?.startsWith("trip:") ? sim.trip.packed : null });
}

function checkWears(sim, history, snapshot) {
  const ledger = new Map(); // "date|garment" -> count of rows
  for (const wear of history.data.wears ?? []) {
    const key = `${wear.wearingDate}|${wear.garmentId}`;
    ledger.set(key, (ledger.get(key) ?? 0) + 1);
  }
  const name = (id) => snapshot.byId.get(id)?.garment.name ?? id;
  const model = new Set();
  for (const [date, garments] of sim.wears) for (const id of garments.keys()) model.add(`${date}|${id}`);
  const readable = (key) => `${name(key.split("|")[1])} on ${key.split("|")[0]}`;
  const doubled = [...ledger].filter(([, n]) => n > 1).map(([key]) => readable(key));
  const missing = [...model].filter((key) => !ledger.has(key)).map(readable);
  const invented = [...ledger.keys()].filter((key) => !model.has(key)).map(readable);
  sim.check("wear.one_counted_wear_per_garment_and_day", doubled.length === 0, `counted more than once: ${doubled.slice(0, 5).join("; ")}`, { doubled });
  sim.check("wear.every_report_is_counted", missing.length === 0, `reported but not in the history: ${missing.slice(0, 5).join("; ")}`, { missing });
  sim.check("wear.nothing_invented", invented.length === 0, `in the history but never reported by the simulation: ${invented.slice(0, 5).join("; ")}`, { invented });
  const wrongCounts = snapshot.items.filter((i) => i.recordedWearCount !== sim.wearCountOf(i.garment.garmentId)).map((i) => `${i.garment.name}: ledger ${i.recordedWearCount}, reported days ${sim.wearCountOf(i.garment.garmentId)}`);
  sim.check("wear.count_per_garment_matches_reported_days", wrongCounts.length === 0, wrongCounts.slice(0, 5).join("; "), { wrongCounts: wrongCounts.slice(0, 20) });
}

function checkAvailability(sim, snapshot) {
  const out = { range: [], noReason: [], softExcluded: [], ownerUnavailable: [], lifted: [] };
  let estimated = 0;
  for (const item of snapshot.items) {
    const a = item.availability;
    if (!a) continue;
    const name = item.garment.name;
    if (!(a.pAvailable >= 0 && a.pAvailable <= 1) || (a.inferredWear ?? []).some((w) => !(w.probability >= 0 && w.probability <= 1))) out.range.push(name);
    const hard = (a.reasons ?? []).filter(isHardReason);
    if (a.hardExcluded && (hard.length === 0 || a.status !== "unavailable")) out.noReason.push(`${name}: ${a.status}, ${a.reasons.join(", ") || "no reason"}`);
    if (!a.hardExcluded && a.status === "unavailable") out.softExcluded.push(`${name}: unavailable without a hard exclusion (${a.reasons.join(", ")})`);
    if (a.hardExcluded && hard.length === 0 && a.reasons.length > 0) out.softExcluded.push(`${name}: excluded on ${a.reasons.join(", ")} alone`);
    if (a.status === "estimated") estimated++;
    const mine = sim.unavailable.get(item.garment.garmentId);
    if (mine && !a.hardExcluded) out.ownerUnavailable.push(`${name}: ${mine.reason}, but ${a.status} (${a.reasons.join(", ")})`);
    const kept = sim.restrictedAtStart.get(item.garment.garmentId);
    if (kept && !kept.every((id) => a.restrictionIds.includes(id))) out.lifted.push(name);
  }
  sim.conditions.set("most garments at once whose availability was an estimate", Math.max(sim.conditions.get("most garments at once whose availability was an estimate") ?? 0, estimated));
  sim.check("availability.probabilities_in_range", out.range.length === 0, out.range.slice(0, 5).join("; "));
  sim.check("availability.hard_exclusion_states_a_hard_reason", out.noReason.length === 0, out.noReason.slice(0, 5).join("; "));
  sim.check("availability.uncertainty_alone_never_excludes", out.softExcluded.length === 0, out.softExcluded.slice(0, 5).join("; "));
  sim.check("availability.what_the_owner_made_unavailable_stays_unavailable", out.ownerUnavailable.length === 0, out.ownerUnavailable.slice(0, 5).join("; "));
  sim.check("restriction.from_the_profile_is_never_lifted", out.lifted.length === 0, `no longer restricted: ${out.lifted.slice(0, 5).join("; ")}`);
}

/** The deterministic identifier the product gives the one managed event of a day (packages/daily: calendar/event-id). */
export const managedEventId = (userId, scope, localDate) => `gdb${createHash("sha256").update(`garderobe-outfit-event|${userId}|${scope}|${localDate}`).digest("hex").slice(0, 40)}`;

async function checkCalendar(sim, boards) {
  if (!sim.calendar.outfitCalendarId || !sim.target.doors.calendar) return;
  const state = await sim.target.readCalendar(sim.calendar.outfitCalendarId);
  const managed = (state.events ?? []).filter((e) => e.extendedProperties?.private?.garderobeBoard !== undefined || e.extendedProperties?.private?.garderobeRevision !== undefined);
  const dateOfEvent = (e) => String(e.start?.dateTime ?? e.start?.date ?? "").slice(0, 10);
  const live = managed.filter((e) => e.status !== "cancelled");
  const perDay = new Map();
  for (const event of live) perDay.set(dateOfEvent(event), [...(perDay.get(dateOfEvent(event)) ?? []), event]);
  const doubled = [...perDay].filter(([, events]) => events.length > 1).map(([date, events]) => `${date}: ${events.length} events`);
  sim.check("calendar.one_managed_event_per_day", doubled.length === 0, doubled.join("; "), { doubled });
  // The record of writes: an event's revision never goes back, and a replacement names the version it replaces.
  const byEvent = new Map();
  const unconditional = [];
  const backwards = [];
  for (const entry of state.log ?? []) {
    if (entry.status >= 300 || !entry.eventId) continue;
    if (entry.op === "patch" && !entry.ifMatch) unconditional.push(`${entry.eventId} at ${entry.at}`);
    if (entry.revision === null || entry.revision === undefined) continue;
    const last = byEvent.get(entry.eventId) ?? 0;
    if (Number(entry.revision) < last) backwards.push(`${entry.eventId}: revision ${last} then ${entry.revision}`);
    byEvent.set(entry.eventId, Math.max(last, Number(entry.revision)));
  }
  sim.check("calendar.revision_never_goes_back", backwards.length === 0, backwards.slice(0, 5).join("; "), { backwards });
  sim.check("calendar.replacement_names_the_version_it_replaces", unconditional.length === 0, `replaced without a version precondition: ${unconditional.slice(0, 5).join("; ")}`, { unconditional: unconditional.slice(0, 20) });
  sim.conditions.set("managed Calendar event writes (insert, replace, remove)", (state.log ?? []).filter((e) => e.op !== "list" && e.op !== "get" && e.status < 300).length);
  sim.conditions.set("managed Calendar events replaced in place under a newer revision", [...byEvent.values()].filter((r) => r > 1).length);
  for (const board of boards) {
    const events = perDay.get(board.localDate) ?? [];
    const projection = board.calendarProjection ?? {};
    if (events.length === 1) {
      const event = events[0];
      const revision = Number(event.extendedProperties?.private?.garderobeRevision);
      if (sim.userId && board.scope === "home") sim.check("calendar.event_identity_is_stable", event.id === managedEventId(sim.userId, board.scope, board.localDate), `the event of ${board.localDate} has identifier ${event.id}`, { boardId: board.boardId });
      sim.check("calendar.event_revision_not_ahead_of_board", revision <= board.revision, `the Calendar event of ${board.localDate} says revision ${revision}, the board is at ${board.revision}`, { boardId: board.boardId });
      if (projection.state === "projected") sim.check("calendar.projected_revision_is_the_event_s", projection.projectedRevision === revision, `the board says revision ${projection.projectedRevision} is in Calendar; the event carries ${revision}`, { boardId: board.boardId });
    } else if (projection.state === "projected" && board.validity !== "suppressed") {
      sim.check("calendar.projected_revision_is_the_event_s", false, `the board of ${board.localDate} says revision ${projection.projectedRevision} is in Calendar, but the calendar holds ${events.length} live managed events for that day`, { boardId: board.boardId });
    }
  }
}

/** Everything that must hold after any step. Reads: today's and tomorrow's board, the wardrobe, the history, the Calendar stand-in. */
export async function standingChecks(sim) {
  const today = sim.today();
  const snapshot = await sim.snapshot(today);
  sim.check("inventory.snapshot_is_complete", snapshot.complete === true && snapshot.total === snapshot.items.length, `snapshot says complete ${snapshot.complete}, total ${snapshot.total}, items ${snapshot.items.length}`);
  const boards = [];
  for (const date of [today, addDays(today, 1)]) {
    const view = await sim.todayBoard(date);
    if (view.board) {
      boards.push(view.board);
      checkBoard(sim, snapshot, view.board);
    }
    if (sim.pause.active && date >= sim.pause.from && (!sim.pause.until || date <= sim.pause.until)) {
      sim.check("pause.nothing_published_for_a_paused_day", !view.board || view.board.validity === "suppressed", `a board (revision ${view.board?.revision}, ${view.board?.validity}) is published for the paused day ${date}`, { date });
      if (date === today) sim.check("pause.today_says_paused", view.status === "paused" && Boolean(view.paused), `today reads as '${view.status}' while the service is paused`, { date });
    }
  }
  const history = await sim.inventory({ view: "history", from: addDays(sim.plan.startDate, -2), to: today });
  checkWears(sim, history, snapshot);
  checkAvailability(sim, snapshot);
  await checkCalendar(sim, boards);
  return { snapshot, boards };
}
