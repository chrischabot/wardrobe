/**
 * Step handlers, part 2: changing conditions. The forecast changes or fails, calendar entries appear,
 * move and are cancelled, garments become unavailable and come back, the owner observes something the
 * ledger did not expect, and the weekly laundry runs with its exceptions.
 *
 * Every event text that reaches the application says SIMULATED.
 */
import { toInstant, zonedToUtcMs } from "./dates.mjs";
import { candidates } from "./handlers-daily.mjs";
import { isSynthetic } from "./profile-check.mjs";
import { byDraw } from "./rng.mjs";
import { quantityIn } from "./sim.mjs";

const byName = (a, b) => a.garment.name.localeCompare(b.garment.name) || a.garment.garmentId.localeCompare(b.garment.garmentId);
const consequential = (sim, type, outcome) => sim.check("proposal.consequential_change_waits_for_the_owner", outcome.route === "owner_confirmed" || outcome.route === "refused", `${type} from the connected assistant took the route ${outcome.route}`, { commandId: outcome.receipt?.commandId ?? null });

/* ------------------------------ weather ------------------------------ */

export async function weatherChange(sim, step) {
  const { change } = step;
  const date = sim.dateOf(change.forDay);
  if (!sim.target.doors.weather) return sim.count(`forecast changes that could not be scripted on this target: ${change.kind}`);
  await sim.target.scriptWeather({ days: { [sim.plan.home.label]: { [date]: change.script } } });
  sim.scriptedWeather.set(date, change.script);
  sim.weatherChangedAt.set(date, sim.now());
  sim.count(`forecast changes: ${change.kind.replaceAll("_", " ")} (SIMULATED weather)`);
  sim.trace.push(["weather", change.kind, date]);
}

export async function weatherOutage(sim, step) {
  if (!sim.target.doors.weather) return sim.count("forecast outages that could not be scripted on this target");
  await sim.target.scriptWeather({ down: { [sim.plan.home.label]: step.down } });
  sim.weatherDown = step.down;
  if (step.down) sim.count(`forecast outages: ${step.outage.replace("forecast_outage_", "")} (SIMULATED weather)`);
  else sim.weatherUpSince = sim.now();
  sim.trace.push(["weather_outage", step.down]);
}

/* ------------------------------ calendar ------------------------------ */

export async function calendarChange(sim, step) {
  const { action, event } = step;
  if (!sim.target.doors.calendar) return sim.count(`calendar changes that could not be scripted on this target: ${action}`);
  const timezone = sim.plan.timezone;
  const wire = (dayIndex) => ({
    id: event.id,
    summary: event.title,
    status: "confirmed",
    start: { dateTime: toInstant(zonedToUtcMs(sim.dateOf(dayIndex), event.start, timezone)), timeZone: timezone },
    end: { dateTime: toInstant(zonedToUtcMs(sim.dateOf(dayIndex), event.end, timezone)), timeZone: timezone },
  });
  if (action === "appear") await sim.target.scriptCalendar({ calendarId: "primary", upsert: [wire(event.onDay)] });
  else if (action === "move") await sim.target.scriptCalendar({ calendarId: "primary", upsert: [wire(event.moved.toDay)] });
  else await sim.target.scriptCalendar({ calendarId: "primary", cancel: [event.id] });
  sim.count(`calendar entries: ${action === "appear" ? `${event.kind} entry appears` : action === "move" ? "entry moves to another day" : "entry cancelled"} (SIMULATED calendar)`);
  sim.trace.push(["calendar", action, event.kind]);
}

/* ------------------------------ garments becoming unavailable ------------------------------ */

export async function becomesUnavailable(sim, step) {
  const { event, index } = step;
  const snapshot = await sim.snapshot();
  let item = null;
  for (const role of [event.role, "top", "bottom", "outer"]) {
    item = byDraw(candidates(sim, snapshot, role, { singleUnit: true }), event.draw);
    if (item) break;
  }
  const id = "availability.what_the_owner_made_unavailable_is_excluded_at_once";
  if (!item) return sim.notApplicable(id, `no single-unit garment was free to become ${event.kind}`);
  const garmentId = item.garment.garmentId;
  const today = sim.today();
  let outcome;
  let type;
  if (event.kind === "lost") {
    type = "garment.retire";
    outcome = await sim.command(type, { garmentId, quantity: 1, disposition: "lost", note: "SIMULATED event: lost" }, { label: "lost" });
  } else if (event.kind === "cleaner") {
    type = "garment.move";
    outcome = await sim.command(type, { garmentId, to: "tailor", note: "SIMULATED event: at the cleaner" }, { label: "sent to the cleaner" });
  } else if (event.kind === "lent") {
    type = "restriction.add";
    outcome = await sim.command(type, { kind: "other", scope: { garmentIds: [garmentId] }, reason: "SIMULATED event: lent to a friend", source: { kind: "owner_statement" } }, { label: "lent to a friend" });
  } else {
    type = "garment.set_planning_policy";
    outcome = await sim.command(type, { garmentId, policy: "excluded", reason: "SIMULATED event: damaged, needs a repair" }, { label: "damaged" });
  }
  consequential(sim, type, outcome);
  if (!outcome.receipt) return sim.check(id, false, `${type} for ${item.garment.name} (${event.kind}) was refused: ${outcome.error?.code} ${outcome.error?.message}`, { error: outcome.error });
  const restrictionId = event.kind === "lent" ? (outcome.receipt.affected.find((a) => a.kind === "restriction")?.id ?? outcome.receipt.result?.restrictionId ?? null) : null;
  sim.unavailable.set(garmentId, { kind: event.kind, reason: `${event.kind === "cleaner" ? "at the cleaner" : event.kind} (SIMULATED event)`, since: today });
  sim.events ??= new Map();
  sim.events.set(index, { garmentId, name: item.garment.name, restrictionId, kind: event.kind });
  const after = (await sim.snapshot()).byId.get(garmentId);
  sim.check(id, !after || after.garment.acquisition === "disposed" || after.availability?.hardExcluded === true, `${item.garment.name} was reported ${event.kind} but reads as ${after?.availability?.status} (${(after?.availability?.reasons ?? []).join(", ")})`, { commandId: outcome.receipt.commandId, summary: outcome.receipt.summary });
  sim.count(`garments made unavailable: ${event.kind === "cleaner" ? "at the cleaner" : event.kind} (SIMULATED event)`);
  sim.trace.push(["unavailable", event.kind, item.garment.name]);
}

export async function comesBack(sim, step) {
  const record = sim.events?.get(step.index);
  if (!record) return;
  const { garmentId, name, kind } = record;
  let outcome;
  if (kind === "cleaner") outcome = await sim.command("garment.move", { garmentId, to: "clean", from: "tailor", note: "SIMULATED event: back from the cleaner" }, { label: "back from the cleaner" });
  else if (kind === "damaged") outcome = await sim.command("garment.set_planning_policy", { garmentId, policy: "normal", reason: "SIMULATED event: repaired" }, { label: "repaired" });
  else {
    // A restriction is lifted by the owner, never by a connected assistant: the assistant's attempt must be refused.
    const attempt = await sim.command("restriction.resolve", { restrictionId: record.restrictionId, evidence: { kind: "owner_statement", note: "SIMULATED: the connected assistant says the friend brought it back" } }, { label: "the assistant tries to lift a restriction" });
    sim.check("restriction.connected_assistant_cannot_lift", attempt.route === "refused" && attempt.error?.code === "forbidden", `restriction.resolve from the connected assistant took the route ${attempt.route} (${attempt.error?.code ?? attempt.receipt?.outcome})`, { error: attempt.error });
    outcome = await sim.ownerCommand("restriction.resolve", { restrictionId: record.restrictionId, evidence: { kind: "owner_statement", note: "SIMULATED: the friend brought it back" } });
  }
  const id = "availability.what_came_back_is_available_again";
  if (!outcome.receipt) return sim.check(id, false, `${name} could not be brought back (${kind}): ${outcome.error?.code} ${outcome.error?.message}`, { error: outcome.error });
  sim.unavailable.delete(garmentId);
  const after = (await sim.snapshot()).byId.get(garmentId);
  const gone = kind === "cleaner" ? "at_tailor" : kind === "damaged" ? "planning_excluded" : "restricted";
  sim.check(id, Boolean(after?.availability) && !after.availability.reasons.includes(gone), `${name} came back (${kind}) but still reads as ${(after?.availability?.reasons ?? []).join(", ")}`, { commandId: outcome.receipt.commandId });
  sim.count(`garments that came back: ${kind === "cleaner" ? "from the cleaner" : kind === "lent" ? "from the friend" : "repaired"} (SIMULATED event)`);
  sim.trace.push(["back", kind, name]);
}

/* ------------------------------ the owner's own observations ------------------------------ */

export async function ownerObservation(sim, step) {
  const { observation } = step;
  const snapshot = await sim.snapshot();
  if (observation.kind === "counted_clean") {
    // He counted: everything of this garment that is at home is clean, whatever the ledger assumed.
    const usable = (i) => i.garment.acquisition === "owned" && !isSynthetic(i.garment.name) && !sim.unavailable.has(i.garment.garmentId) && (i.availability?.restrictionIds ?? []).length === 0 && i.garment.careChannel !== "none" && quantityIn(i, "service") === 0 && quantityIn(i, "trip") === 0;
    const doubted = snapshot.items.filter((i) => usable(i) && (quantityIn(i, "dirty") > 0 || i.availability?.status === "estimated")).sort(byName);
    const item = byDraw(doubted, observation.draw);
    const id = "observation.the_owner_s_count_is_what_the_ledger_then_says";
    if (!item) return sim.notApplicable(id, "no garment was dirty or estimated at that moment");
    const atHome = quantityIn(item, "clean") + quantityIn(item, "dirty");
    const before = item.availability?.status;
    const outcome = await sim.command("stock.reconcile", { garmentId: item.garment.garmentId, counts: { clean: atHome, dirty: 0 }, note: "SIMULATED observation: counted, all clean" }, { label: "counted clean" });
    consequential(sim, "stock.reconcile", outcome);
    if (!outcome.receipt) return sim.check(id, false, `the count of ${item.garment.name} was refused: ${outcome.error?.code} ${outcome.error?.message}`, { error: outcome.error });
    const after = (await sim.snapshot()).byId.get(item.garment.garmentId);
    sim.check(id, quantityIn(after, "clean") === atHome && quantityIn(after, "dirty") === 0 && after.availability?.hardExcluded === false && after.availability.cleanObserved >= 1, `${item.garment.name}: counted ${atHome} clean; the ledger says clean ${quantityIn(after, "clean")}, dirty ${quantityIn(after, "dirty")}, ${after.availability?.status}, observed clean ${after.availability?.cleanObserved}`, { commandId: outcome.receipt.commandId, summary: outcome.receipt.summary });
    sim.observedClean ??= new Set();
    sim.observedClean.add(item.garment.garmentId);
    sim.count(`owner observations contradicting the ledger: counted clean (was ${before})`);
    sim.trace.push(["observation", "counted_clean", item.garment.name]);
    return;
  }
  const item = byDraw(candidates(sim, snapshot, observation.role), observation.draw);
  const id = "observation.what_the_owner_says_is_dirty_is_dirty";
  if (!item) return sim.notApplicable(id, `no ${observation.role} was clean at that moment`);
  const clean = quantityIn(item, "clean");
  const quantity = observation.kind === "all_in_the_hamper" ? clean : 1;
  const payload = { items: [{ garmentId: item.garment.garmentId, quantity }] };
  // The spill doubles as the probe of a reused key: the same key with another request must be refused.
  const outcome = observation.kind === "spill" ? await sim.probeKeyReuse("care.mark_dirty", payload, { items: [{ garmentId: item.garment.garmentId, quantity: quantity + 1 }] }) : await sim.command("care.mark_dirty", payload, { label: "all of it is in the hamper" });
  if (!outcome.receipt) return sim.check(id, false, `the report on ${item.garment.name} was refused: ${outcome.error?.code} ${outcome.error?.message}`, { error: outcome.error });
  sim.check("observation.a_wash_report_runs_without_a_tap", outcome.route === "direct", `care.mark_dirty took the route ${outcome.route}`, { commandId: outcome.receipt.commandId });
  const after = (await sim.snapshot()).byId.get(item.garment.garmentId);
  const expectedClean = clean - quantity;
  sim.check(id, quantityIn(after, "clean") === expectedClean && (expectedClean > 0 || after.availability?.hardExcluded === true), `${item.garment.name}: ${quantity} reported dirty of ${clean} clean; the ledger says clean ${quantityIn(after, "clean")}, ${after.availability?.status} (${(after.availability?.reasons ?? []).join(", ")})`, { commandId: outcome.receipt.commandId, summary: outcome.receipt.summary });
  sim.observedClean?.delete(item.garment.garmentId);
  sim.count(`owner observations contradicting the ledger: ${observation.kind === "spill" ? "a spill" : "all of it in the hamper"} (was ${item.availability.status})`);
  sim.trace.push(["observation", observation.kind, item.garment.name]);
}

/* ------------------------------ laundry ------------------------------ */

const laundryView = async (sim) => (await sim.inventory({ view: "laundry" })).data;

export async function laundryCollect(sim, step) {
  const { week } = step;
  const before = await laundryView(sim);
  const waiting = before.awaitingService ?? [];
  const id = "laundry.pickup_takes_what_was_waiting";
  if (waiting.length === 0) return sim.notApplicable(id, "nothing was waiting for the service that Friday");
  const outcome = await sim.command("laundry.collect", {}, { label: `pickup, week ${week.week + 1}` });
  if (!outcome.receipt) return sim.check(id, false, `the pickup was refused: ${outcome.error?.code} ${outcome.error?.message}`, { error: outcome.error });
  sim.check("laundry.pickup_runs_without_a_tap", outcome.route === "direct", `laundry.collect took the route ${outcome.route}`, { commandId: outcome.receipt.commandId });
  const after = await laundryView(sim);
  const known = new Set((before.batches ?? []).map((b) => b.batchId));
  const batch = (after.batches ?? []).find((b) => !known.has(b.batchId));
  const taken = new Map((batch?.items ?? []).map((i) => [i.garmentId, i.quantity]));
  sim.check(id, Boolean(batch) && waiting.every((w) => taken.get(w.garmentId) === w.quantity) && (after.awaitingService ?? []).length === 0, `the pickup took ${taken.size} lines; ${waiting.length} were waiting and ${(after.awaitingService ?? []).length} still are`, { commandId: outcome.receipt.commandId, summary: outcome.receipt.summary });
  sim.laundry ??= new Map();
  if (batch) sim.laundry.set(week.week, { batchId: batch.batchId, items: batch.items.map((i) => ({ garmentId: i.garmentId, name: i.name, quantity: i.quantity })), awayId: null, returned: false });
  const snapshot = await sim.snapshot();
  const wrong = (batch?.items ?? []).filter((i) => quantityIn(snapshot.byId.get(i.garmentId), "clean") === 0 && snapshot.byId.get(i.garmentId)?.availability?.hardExcluded !== true).map((i) => i.name);
  sim.check("laundry.what_is_at_the_service_is_not_offered", wrong.length === 0, `at the service with nothing clean at home, yet not excluded: ${wrong.join(", ")}`, { batchId: batch?.batchId });
  sim.count("laundry pickups");
  sim.trace.push(["laundry", "collect", taken.size]);
}

export async function laundryReturn(sim, step) {
  const { week } = step;
  const state = sim.laundry?.get(week.week);
  const id = "laundry.return_brings_back_the_bag_and_only_the_bag";
  if (!state) return sim.notApplicable(id, "no pickup was recorded that week");
  if (week.kind === "missed_return") {
    const outcome = await sim.command("laundry.report_exception", { kind: "missed_return", note: "SIMULATED event: the bag did not come back on Saturday" }, { label: "the bag did not come back" });
    consequential(sim, "laundry.report_exception", outcome);
    sim.check("laundry.exception_recorded", Boolean(outcome.receipt), `the missed return was refused: ${outcome.error?.code} ${outcome.error?.message}`, { error: outcome.error });
    sim.count("laundry exceptions: the bag did not come back");
    sim.trace.push(["laundry", "missed_return"]);
    return;
  }
  const payload = { batchId: state.batchId };
  if (week.kind === "still_away" || week.kind === "lost_in_service") {
    const snapshot = await sim.snapshot();
    const away = byDraw(state.items.filter((i) => snapshot.byId.get(i.garmentId)?.totalOwnedUnits === 1), week.draw) ?? byDraw(state.items, week.draw);
    state.awayId = away.garmentId;
    state.awayName = away.name;
    payload.stillAway = [{ garmentId: away.garmentId, quantity: 1 }];
  }
  const outcome = await sim.command("laundry.return", payload, { label: `the bag comes back, week ${week.week + 1}${payload.stillAway ? ", one piece missing" : ""}` });
  if (!outcome.receipt) return sim.check(id, false, `the return was refused: ${outcome.error?.code} ${outcome.error?.message}`, { error: outcome.error });
  sim.check(payload.stillAway ? "laundry.a_return_with_a_missing_piece_waits_for_the_owner" : "laundry.return_runs_without_a_tap", payload.stillAway ? outcome.route === "owner_confirmed" : outcome.route === "direct", `laundry.return took the route ${outcome.route}`, { commandId: outcome.receipt.commandId });
  state.returned = true;
  const snapshot = await sim.snapshot();
  const stillOut = state.items.filter((i) => i.garmentId !== state.awayId && (snapshot.byId.get(i.garmentId)?.balances ?? []).some((b) => b.bucket === "service" && b.ref === state.batchId && b.quantity > 0)).map((i) => i.name);
  sim.check(id, stillOut.length === 0, `still recorded at the service after the bag came back: ${stillOut.join(", ")}`, { commandId: outcome.receipt.commandId, summary: outcome.receipt.summary, repairs: outcome.receipt.repairs });
  if (state.awayId) {
    const item = snapshot.byId.get(state.awayId);
    if (item?.totalOwnedUnits === 1) {
      sim.check("laundry.a_piece_still_away_is_not_offered", item.availability?.hardExcluded === true, `${state.awayName} is still away but reads as ${item.availability?.status} (${(item.availability?.reasons ?? []).join(", ")})`, { commandId: outcome.receipt.commandId });
      sim.unavailable.set(state.awayId, { kind: "still_away", reason: "still at the laundry service (SIMULATED event)", since: sim.today() });
    }
    sim.count("laundry exceptions: one piece did not come back with the bag");
  }
  sim.count("laundry returns");
  sim.trace.push(["laundry", "return", week.kind]);
}

export async function laundryLateReturn(sim, step) {
  const { week } = step;
  const state = sim.laundry?.get(week.week);
  if (!state) return;
  if (week.kind === "missed_return") {
    const outcome = await sim.command("laundry.return", { batchId: state.batchId }, { label: "the missed bag comes back at last" });
    const id = "laundry.a_missed_bag_comes_back_when_the_owner_says_so";
    if (!outcome.receipt) return sim.check(id, false, `the late return was refused: ${outcome.error?.code} ${outcome.error?.message}`, { error: outcome.error });
    const snapshot = await sim.snapshot();
    const stillOut = state.items.filter((i) => (snapshot.byId.get(i.garmentId)?.balances ?? []).some((b) => b.bucket === "service" && b.quantity > 0)).map((i) => i.name);
    sim.check(id, stillOut.length === 0, `still at the service after the late return: ${stillOut.join(", ")}`, { commandId: outcome.receipt.commandId, summary: outcome.receipt.summary });
    state.returned = true;
    sim.count("laundry: a missed bag returned days late");
    return;
  }
  if (!state.awayId) return;
  if (week.kind === "lost_in_service") {
    const outcome = await sim.command("laundry.report_exception", { kind: "lost", garmentId: state.awayId, quantity: 1, note: "SIMULATED event: the service lost it" }, { label: "the service lost the missing piece" });
    consequential(sim, "laundry.report_exception", outcome);
    sim.check("laundry.exception_recorded", Boolean(outcome.receipt), `the loss was refused: ${outcome.error?.code} ${outcome.error?.message}`, { error: outcome.error });
    if (sim.unavailable.has(state.awayId)) sim.unavailable.set(state.awayId, { kind: "lost", reason: "lost by the laundry service (SIMULATED event)", since: sim.today() });
    sim.count("laundry exceptions: a piece lost by the service");
    return;
  }
  // It turned up: he says it is washed and back.
  const outcome = await sim.command("care.washed", { items: [{ garmentId: state.awayId, quantity: 1 }] }, { label: "the missing piece came back" });
  const id = "laundry.a_piece_that_came_back_late_is_available_again";
  if (!outcome.receipt) return sim.check(id, false, `the late piece was refused: ${outcome.error?.code} ${outcome.error?.message}`, { error: outcome.error });
  sim.unavailable.delete(state.awayId);
  const item = (await sim.snapshot()).byId.get(state.awayId);
  sim.check(id, quantityIn(item, "clean") >= 1 && !(item.availability?.reasons ?? []).includes("laundry_exception"), `${state.awayName}: clean ${quantityIn(item, "clean")}, ${(item.availability?.reasons ?? []).join(", ")}`, { commandId: outcome.receipt.commandId, summary: outcome.receipt.summary });
  sim.count("laundry: a piece that came back late");
}

export async function socksWashed(sim) {
  const before = await laundryView(sim);
  const waiting = before.awaitingHandwash ?? [];
  const id = "laundry.hand_wash_returns_only_when_the_owner_says_washed";
  if (waiting.length === 0) return sim.notApplicable(id, "nothing was waiting for a hand wash");
  const outcome = await sim.command("care.washed", { items: waiting.map((w) => ({ garmentId: w.garmentId, quantity: w.quantity })) }, { label: "socks washed" });
  if (!outcome.receipt) return sim.check(id, false, `"washed" was refused: ${outcome.error?.code} ${outcome.error?.message}`, { error: outcome.error });
  const after = await laundryView(sim);
  sim.check(id, (after.awaitingHandwash ?? []).length === 0, `${(after.awaitingHandwash ?? []).length} lines still await a hand wash after "washed"`, { commandId: outcome.receipt.commandId, summary: outcome.receipt.summary });
  for (const line of waiting) {
    sim.observedClean ??= new Set();
    sim.observedClean.add(line.garmentId);
  }
  sim.count("hand-wash reports (socks washed)");
}

/** Monday morning, after the weekly baseline day: exceptions are kept, and what was only inferred is not called observed. */
export async function afterBaseline(sim, step) {
  const week = sim.plan.laundry[step.week];
  if (!week) return;
  const snapshot = await sim.snapshot();
  const laundry = await laundryView(sim);
  sim.conditions.set("weekly laundry baselines the ledger has applied", (laundry.cycles ?? []).length);
  const state = sim.laundry?.get(week.week);
  if (week.kind === "missed_return" && state && !state.returned) {
    const washedByBaseline = state.items.filter((i) => !(snapshot.byId.get(i.garmentId)?.balances ?? []).some((b) => b.bucket === "service" && b.quantity > 0)).map((i) => i.name);
    sim.check("laundry.the_weekly_baseline_does_not_bring_back_a_missed_bag", washedByBaseline.length === 0, `no longer at the service although the bag never came back: ${washedByBaseline.join(", ")}`, { batchId: state.batchId });
  }
  if (week.kind === "no_reports") {
    // Nothing was reported about laundry that week. Whatever is clean again is clean by inference only.
    const from = sim.dateOf(week.week * 7);
    const to = sim.dateOf(week.week * 7 + 6);
    const worn = new Set();
    for (const [date, garments] of sim.wears) if (date >= from && date <= to) for (const garmentId of garments.keys()) worn.add(garmentId);
    const claimed = [];
    let inferred = 0;
    for (const garmentId of worn) {
      const item = snapshot.byId.get(garmentId);
      if (!item || item.garment.careChannel !== "service" || item.totalOwnedUnits !== 1 || sim.observedClean?.has(garmentId) || sim.unavailable.has(garmentId)) continue;
      if (quantityIn(item, "clean") > 0 && !item.availability?.hardExcluded) {
        inferred++;
        if (item.availability.cleanObserved > 0) claimed.push(item.garment.name);
      }
    }
    if (inferred === 0) sim.notApplicable("availability.clean_by_inference_is_not_called_observed", "no garment worn in the week without laundry reports was clean again on Monday");
    else sim.check("availability.clean_by_inference_is_not_called_observed", claimed.length === 0, `clean only by the weekly baseline, yet counted as observed clean: ${claimed.join(", ")}`, { week: week.week + 1 });
    sim.count("garments clean again by the weekly baseline alone (a week without laundry reports)", inferred);
  }
}
