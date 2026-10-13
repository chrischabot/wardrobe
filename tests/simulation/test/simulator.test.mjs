/**
 * The parts of the simulator that need no Worker: the timeline is a pure function of the seed, every
 * plan contains every kind of condition, and the independent checkers catch what they are meant to
 * catch (negative controls). The simulation itself is run with `npm run sim:local`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isoWeekday, localDateOf, zonedToUtcMs } from "../lib/dates.mjs";
import { HANDLERS } from "../lib/runner.mjs";
import { hardConstraintViolations, neutralAdvisories, SHEET_ROWS, sheetLimits, sheetRowsFor } from "../lib/profile-check.mjs";
import { buildSteps } from "../lib/schedule.mjs";
import { checkAvailability, checkOptions, isPausedDay } from "../lib/invariants.mjs";
import { balanceDifferences, composition, contractRoute, garmentChanges, garmentFingerprint, internalCodesIn, moveBalance, Sim, stableJson, wardrobeStateChanges } from "../lib/sim.mjs";
import { checkRunHonesty, checkUndoAgainstSupport, expectStockUnchanged } from "../lib/handlers-circumstances.mjs";
import { canonicalPath, isWithin, prepareStateDir, REPO_ROOT, STATE_MARKER } from "../lib/local-target.mjs";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPlan, plannedConditions } from "../lib/timeline.mjs";
import { swapRevisionVerdict } from "../lib/handlers-swap.mjs";

const SEEDS = ["1", "2", "3", "4", "5", "17", "owner-requested"];

test("the same seed gives the same plan, byte for byte; another seed gives another", () => {
  for (const seed of SEEDS) assert.equal(JSON.stringify(buildPlan({ seed })), JSON.stringify(buildPlan({ seed })));
  const digests = new Set(SEEDS.map((seed) => buildPlan({ seed }).digest));
  assert.equal(digests.size, SEEDS.length);
});

test("a plan spans at least four weeks from a Monday and refuses less", () => {
  for (const seed of SEEDS) {
    const plan = buildPlan({ seed });
    assert.equal(plan.dayCount, 28);
    assert.equal(isoWeekday(plan.startDate), 1);
    assert.equal(plan.days.length, 28);
  }
  assert.throws(() => buildPlan({ seed: 1, weeks: 3 }));
  assert.equal(buildPlan({ seed: 1, weeks: 6 }).dayCount, 42);
  // Every week has its laundry, however long the run.
  for (const weeks of [4, 6, 7, 13]) assert.deepEqual(buildPlan({ seed: 1, weeks }).laundry.map((l) => l.week), Array.from({ length: weeks }, (_unused, i) => i));
});

test("every plan holds every kind of changing condition", () => {
  for (const seed of SEEDS) {
    const c = plannedConditions(buildPlan({ seed }));
    assert.ok(c.weather.sudden_rain >= 1 && c.weather.heat_days >= 1 && c.weather.cold_snap_days >= 1 && c.weather.forecast_outages >= 2, `weather, seed ${seed}`);
    assert.ok(c.calendar.formal >= 1 && c.calendar.workouts >= 1 && c.calendar.travel >= 1, `calendar kinds, seed ${seed}`);
    assert.ok(c.availability.lost >= 1 && c.availability.at_the_cleaner >= 1 && c.availability.lent >= 1 && c.availability.damaged >= 1, `availability, seed ${seed}`);
    assert.ok(c.availability.owner_observations_contradicting_estimates >= 3 && c.availability.laundry_exception_weeks >= 1 && c.availability.repair_probes >= 1, `observations and laundry, seed ${seed}`);
    assert.ok(c.circumstance.trip_days === 3 && c.circumstance.ill_days === 2 && c.circumstance.paused_days >= 2 && c.circumstance.work_from_home_days >= 1, `circumstance, seed ${seed}`);
  }
  // Across the default seeds, entries both move and are cancelled, and both a return and an exchange occur.
  const defaults = ["1", "2", "3", "4", "5"].map((seed) => plannedConditions(buildPlan({ seed })));
  assert.ok(defaults.some((c) => c.calendar.moved > 0) && defaults.some((c) => c.calendar.cancelled > 0));
  assert.deepEqual([...new Set(defaults.map((c) => c.circumstance.return_or_exchange))].sort(), ["exchange", "return"]);
});

test("circumstances do not overlap, and everything planned lies inside the timeline", () => {
  for (const seed of SEEDS) {
    const plan = buildPlan({ seed });
    // Each circumstance's own interval, built from the plan's fields rather than from the day labels.
    const range = (from, to) => Array.from({ length: to - from + 1 }, (_unused, i) => from + i);
    const intervals = { trip: range(plan.trip.firstDay, plan.trip.lastDay), paused: range(plan.pause.firstDay, plan.pause.lastDay), ill: range(plan.illness.firstDay, plan.illness.lastDay), work_from_home: plan.workFromHomeDays };
    const owner = new Map();
    for (const [label, days] of Object.entries(intervals)) {
      for (const d of days) {
        assert.ok(!owner.has(d), `seed ${seed}: day ${d} is both ${owner.get(d)} and ${label}`);
        owner.set(d, label);
      }
    }
    for (const day of plan.days) assert.equal(day.circumstance, owner.get(day.index) ?? "ordinary", `seed ${seed}: day ${day.index} is labelled ${day.circumstance}`);
    assert.ok(plan.trip.lastDay < plan.illness.firstDay && plan.illness.lastDay < plan.pause.firstDay && plan.pause.resumeDay < plan.dayCount, `order of circumstances, seed ${seed}`);
    for (const event of plan.calendar) {
      assert.ok(event.appearsDay >= 0 && event.appearsDay <= event.onDay && event.onDay < plan.dayCount);
      if (event.moved) assert.ok(event.moved.onDay > event.appearsDay && event.moved.toDay < plan.dayCount);
      if (event.cancelled) assert.ok(event.cancelled.onDay > event.appearsDay && event.cancelled.onDay <= event.onDay);
    }
    for (const event of plan.availability) assert.ok(event.onDay >= 0 && (event.backOnDay === null || (event.backOnDay > event.onDay && event.backOnDay < plan.dayCount)));
    for (const day of plan.days) assert.ok(day.weather.peakC >= day.weather.morningC, `peak below the morning on day ${day.index}, seed ${seed}`);
  }
});

test("the steps are in time order, every step has a handler, and every day has its fixed steps", () => {
  for (const seed of SEEDS) {
    const plan = buildPlan({ seed });
    const steps = buildSteps(plan);
    for (let i = 1; i < steps.length; i++) assert.ok(steps[i - 1].day < steps[i].day || (steps[i - 1].day === steps[i].day && steps[i - 1].at <= steps[i].at), `order at step ${i}`);
    for (const step of steps) assert.equal(typeof HANDLERS[step.kind], "function", `no handler for ${step.kind}`);
    for (let d = 0; d < plan.dayCount; d++) {
      const kinds = steps.filter((s) => s.day === d).map((s) => s.kind);
      for (const kind of ["sweep", "morning", "evening_report", "plan_tomorrow", "night"]) assert.ok(kinds.includes(kind), `day ${d} has no ${kind}`);
    }
    const kinds = new Set(steps.map((s) => s.kind));
    for (const kind of ["weather_change", "weather_outage", "calendar_change", "becomes_unavailable", "comes_back", "owner_observation", "socks_washed", "trip_create", "trip_proposal", "trip_pack", "trip_unpack", "pause", "purchase_order", "return_open", "return_post", "ask", "research", "lift_attempt", "undo_a_report", "amend_a_report", "swap_and_undo"]) assert.ok(kinds.has(kind), `seed ${seed} has no ${kind} step`);
    assert.ok(steps.length > 300, `only ${steps.length} steps`);
  }
});

test("civil time: London mornings across both daylight-saving changes", () => {
  assert.equal(new Date(zonedToUtcMs("2027-01-04", "07:00", "Europe/London")).toISOString(), "2027-01-04T07:00:00.000Z");
  assert.equal(new Date(zonedToUtcMs("2027-03-29", "07:00", "Europe/London")).toISOString(), "2027-03-29T06:00:00.000Z");
  assert.equal(new Date(zonedToUtcMs("2027-11-01", "07:00", "Europe/London")).toISOString(), "2027-11-01T07:00:00.000Z");
  assert.equal(localDateOf(Date.parse("2027-06-07T23:30:00Z"), "Europe/London"), "2027-06-08");
});

/* ------------------------------ the independent checker, with negative controls ------------------------------ */

const line = (role, name, garmentId = name) => ({ role, name, garmentId });
const outfit = (overrides = {}) => ({
  number: 1,
  name: "control outfit",
  garments: [line("top", "Lightweight oxford — pink"), line("bottom", "Di Sondrio grey chino"), line("socks", SHEET_ROWS.find((r) => r.category === "Sock" && !/bed sock/i.test(`${r.item} ${r.notes}`)).item), line("footwear", "NB 990v4 — Grey")],
  footwearAlternatives: [],
  flourish: null,
  ...overrides,
});
const day = (overrides = {}) => ({ thermal: { departureC: 11, peakC: 19 }, wornLastSevenDays: new Set(), namedByRequest: new Set(), onTrip: false, ...overrides });
const swap = (role, name) => outfit({ garments: outfit().garments.map((g) => (g.role === role ? line(role, name) : g)) });

test("the sheet is read from the owner's document: 127 garments' worth of rows, names resolve", () => {
  assert.ok(SHEET_ROWS.length > 100);
  assert.equal(sheetRowsFor("NB 990v4 — Grey").length, 1);
  assert.equal(sheetRowsFor("Di Sondrio walnut chino").length, 2);
  assert.deepEqual(sheetLimits(sheetRowsFor("Pima oxford — navy")[0]), { minC: null, maxC: 22 });
  assert.deepEqual(sheetLimits(sheetRowsFor("Drake's Olive Jungle Jacket")[0]), { minC: 10, maxC: 22 });
  assert.deepEqual(sheetLimits(sheetRowsFor("Palermo linen drawstring — tobacco")[0]), { minC: 30, maxC: null });
});

test("a sound outfit passes", () => {
  assert.deepEqual(hardConstraintViolations(outfit(), day()), []);
});

test("negative controls: each hard constraint is caught", () => {
  const caught = (option, facts, pattern) => assert.ok(hardConstraintViolations(option, facts).some((v) => pattern.test(v)), `not caught: ${pattern} in ${JSON.stringify(hardConstraintViolations(option, facts))}`);
  caught(outfit({ garments: outfit().garments.filter((g) => g.role !== "socks") }), day(), /0 sock lines/);
  caught(swap("footwear", "Paraboot Reims — noir (black)"), day(), /not a sneaker/);
  caught(outfit({ footwearAlternatives: [line("footwear", "Paraboot Michael Cerf")] }), day(), /welted fleet is out of play/);
  caught(swap("top", "Pima oxford — navy"), day({ thermal: { departureC: 16, peakC: 26 } }), /peaks at 26/);
  caught(swap("bottom", "Palermo linen drawstring — tobacco"), day(), /peaks at only 19/);
  caught(outfit({ garments: [...outfit().garments, line("outer", "Drake's Olive Jungle Jacket")] }), day({ thermal: { departureC: 24, peakC: 28 } }), /when he leaves/);
  caught(outfit({ garments: [...swap("top", "Pima oxford — navy").garments, line("outer", "Drake's Olive Jungle Jacket")] }), day({ thermal: { departureC: 15, peakC: 19 } }), /lightweight oxford only/);
  caught(outfit(), day({ wornLastSevenDays: new Set(["Lightweight oxford — pink"]) }), /within the last seven days/);
  caught(swap("top", "An invented cashmere polo"), day(), /not a name from his inventory/);
  caught(swap("top", "Lightweight oxford PCF4905"), day(), /fabric code/);
  caught(outfit({ garments: [...outfit().garments, line("outer", "DBF Traveler — wool")] }), day(), /benched/);
});

test("what the checker deliberately leaves alone", () => {
  // A piece the simulation asked for by name is the owner's own exception to the repeat rule for that request.
  assert.deepEqual(hardConstraintViolations(outfit(), day({ wornLastSevenDays: new Set(["Lightweight oxford — pink"]), namedByRequest: new Set(["Lightweight oxford — pink"]) })), []);
  // No thermal claim when the simulator cannot know which forecast the offer was validated against.
  assert.deepEqual(hardConstraintViolations(swap("top", "Pima oxford — navy"), day({ thermal: null })), []);
  // A labelled synthetic garment is not expected in his sheet.
  assert.deepEqual(hardConstraintViolations(swap("top", "SYNTHETIC ordered shirt, moss (simulated order)"), day()), []);
  // The colour verdict is counted as an advisory, never as a violation.
  const navy = outfit({ garments: [line("top", "Pima oxford — navy"), line("bottom", "Cord — navy"), ...outfit().garments.filter((g) => g.role === "socks"), line("footwear", "NB 990v4 — Navy")] });
  assert.equal(neutralAdvisories(navy).length, 1);
});

test("owner-facing text: identifiers and serialisation debris are found, ordinary prose is not", () => {
  assert.deepEqual(internalCodesIn("Recorded: you wore the pink oxford and the grey chinos on Tuesday."), []);
  assert.ok(internalCodesIn("Recorded wear of gmt_0123456789abcdef").length > 0);
  assert.ok(internalCodesIn("board undefined was published").length > 0);
});

/** A Sim with only what the contract check needs: no target is ever called. */
const bareSim = () => new Sim({ target: { now: () => 0 }, plan: { seed: "unit", timezone: "Europe/London", startDate: "2026-01-05" } });
const failedIds = (sim) => sim.failures.map((f) => f.check);

test("the 2026-10-05 contract: routes by type, and every command's route is checked once", () => {
  assert.equal(contractRoute("wear.record"), "direct");
  assert.equal(contractRoute("settings.update"), "direct");
  assert.equal(contractRoute("garment.retire"), "direct");
  assert.equal(contractRoute("garment.merge"), "owner_confirmed");
  assert.equal(contractRoute("restriction.resolve"), "refused");

  let sim = bareSim();
  // A direct type that waited for the owner fails, even though the owner then confirmed it.
  assert.equal(sim.expectContractRoute("settings.update", { route: "owner_confirmed", receipt: { commandId: "c1" }, error: null }), false);
  assert.deepEqual(failedIds(sim), ["contract.a_change_the_owner_asks_for_applies_at_once"]);

  sim = bareSim();
  // A domain refusal is not a routing decision; an authorization refusal of a direct type is.
  assert.equal(sim.expectContractRoute("wear.record", { route: "refused", receipt: null, error: { code: "invalid_command" } }), true);
  assert.equal(sim.expectContractRoute("wear.record", { route: "refused", receipt: null, error: { code: "forbidden" } }), false);
  // A section 3 type that ran at once fails; one that waited passes; a lift must be refused as forbidden.
  assert.equal(sim.expectContractRoute("garment.merge", { route: "direct", receipt: { commandId: "c2", undo: { available: true } }, error: null }), false);
  assert.equal(sim.expectContractRoute("garment.merge", { route: "owner_rejected", receipt: null, error: null }), true);
  assert.equal(sim.expectContractRoute("restriction.resolve", { route: "owner_confirmed", receipt: { commandId: "c3" }, error: null }), false);
  assert.equal(sim.expectContractRoute("restriction.resolve", { route: "refused", receipt: null, error: { code: "forbidden" } }), true);
  // An explicit expected route overrides the type's.
  assert.equal(sim.expectContractRoute("wear.record", { route: "owner_rejected", receipt: null, error: null }, "owner_confirmed"), true);

  // Checked once per outcome: a handler's second call returns the recorded result without counting again.
  sim = bareSim();
  const outcome = { route: "owner_confirmed", receipt: { commandId: "c4" }, error: null };
  sim.expectContractRoute("settings.update", outcome);
  sim.expectContractRoute("settings.update", outcome);
  assert.equal(sim.entry("contract.a_change_the_owner_asks_for_applies_at_once").failed, 1);

  // A direct receipt must say whether it can be undone.
  sim = bareSim();
  sim.expectContractRoute("wear.record", { route: "direct", receipt: { commandId: "c5" }, error: null });
  assert.deepEqual(failedIds(sim), ["contract.receipt_states_whether_undo_is_available"]);
});

test("a trip day's offers face the daily hard exclusions; only the suitcase reasons are waived, for pieces in the suitcase now", () => {
  const roles = ["top", "bottom", "socks", "footwear"];
  const item = (role, reasons, { inSuitcase = 1, wornInSuitcase = 0, dirtyAtHome = 0, planningPolicy = "normal" } = {}) => {
    const balances = [];
    if (inSuitcase > 0) balances.push({ bucket: "trip", ref: "trip-1", quantity: inSuitcase });
    if (wornInSuitcase > 0) balances.push({ bucket: "trip", ref: "trip-1#dirty", quantity: wornInSuitcase });
    if (dirtyAtHome > 0) balances.push({ bucket: "dirty", ref: "", quantity: dirtyAtHome });
    if (balances.length === 0) balances.push({ bucket: "clean", ref: "", quantity: 1 });
    return { garment: { garmentId: `g-${role}`, name: `SYNTHETIC ${role} (trip check)`, roles: [role], acquisition: "owned", planningPolicy }, balances, totalOwnedUnits: balances.reduce((n, b) => n + b.quantity, 0), availability: { hardExcluded: reasons.length > 0, status: reasons.length > 0 ? "unavailable" : "available", reasons, restrictionIds: [] } };
  };
  const run = (reasonsOf, { packed = roles, itemOptions = () => ({}), proposal = null, reuseFacts = {} } = {}) => {
    const sim = bareSim();
    const items = roles.map((role) => item(role, reasonsOf(role), itemOptions(role)));
    const snapshot = { byId: new Map(items.map((i) => [i.garment.garmentId, i])), items };
    const option = { name: "trip option", garments: roles.map((role) => ({ role, name: `SYNTHETIC ${role} (trip check)`, garmentId: `g-${role}` })), footwearAlternatives: [], flourish: null };
    checkOptions(sim, snapshot, [option], { date: "2026-01-07", source: "trip board", freshness: null, tripId: "trip-1", tripProposal: proposal, tripPacked: new Map(packed.map((role) => [`g-${role}`, 1])), ...reuseFacts });
    return failedIds(sim);
  };
  assert.deepEqual(run(() => ["on_trip", "no_units_at_home"]), []);
  // A clean unit in the suitcase and the other unit dirty at home: the estimator's "no clean unit at home"
  // details (observed_dirty here) describe the unit left behind, not the packed one, so they are waived.
  assert.deepEqual(run((role) => (role === "top" ? ["no_units_at_home", "observed_dirty", "on_trip"] : ["on_trip"]), { itemOptions: (role) => (role === "top" ? { dirtyAtHome: 1 } : {}) }), []);
  // The only suitcase unit was worn on the trip: not a clean packed piece, and nothing is waived for it.
  const wornAway = run((role) => (role === "top" ? ["no_units_at_home", "on_trip", "observed_dirty"] : ["on_trip"]), { itemOptions: (role) => (role === "top" ? { inSuitcase: 0, wornInSuitcase: 1 } : {}) });
  assert.ok(wornAway.includes("recommended.not_hard_excluded") && wornAway.includes("recommended.trip_day_uses_packed_pieces_only"));
  // Trousers worn earlier on the trip: the days the packed-to proposal plans them are a wear budget, not fixed
  // dates (packages/daily/src/context.ts). Wearable again while the distinct trip days worn before this day
  // are fewer than the planned days, and not after the owner reported them dirty since packing.
  const reuse = (dates, role = "bottom") => ({ items: [{ garmentId: `g-${role}`, quantity: 1 }], days: dates.map((localDate) => ({ localDate, slots: [{ role, garmentId: `g-${role}` }] })) });
  const wornTrousers = { itemOptions: (role) => (role === "bottom" ? { inSuitcase: 0, wornInSuitcase: 1 } : {}) };
  const trouserReasons = (role) => (role === "bottom" ? ["no_units_at_home", "on_trip"] : ["on_trip"]);
  const worn = (...dates) => ({ tripDepartsOn: "2026-01-05", tripWornDates: new Map([["g-bottom", new Set(dates)]]) });
  // Planned twice, worn once before: budget left, even though the planned dates differ from today.
  assert.deepEqual(run(trouserReasons, { ...wornTrousers, proposal: reuse(["2026-01-05", "2026-01-06"]), reuseFacts: worn("2026-01-05") }), []);
  // Planned twice, already worn on two trip days: no budget left.
  assert.ok(run(trouserReasons, { ...wornTrousers, proposal: reuse(["2026-01-05", "2026-01-06"]), reuseFacts: worn("2026-01-05", "2026-01-06") }).includes("recommended.trip_day_uses_packed_pieces_only"));
  // Planned once, worn once: no budget left.
  assert.ok(run(trouserReasons, { ...wornTrousers, proposal: reuse(["2026-01-07"]), reuseFacts: worn("2026-01-05") }).includes("recommended.trip_day_uses_packed_pieces_only"));
  // Worn only before the departure: not worn on this trip, so not reusable.
  assert.ok(run(trouserReasons, { ...wornTrousers, proposal: reuse(["2026-01-05", "2026-01-06"]), reuseFacts: { tripDepartsOn: "2026-01-05", tripWornDates: new Map([["g-bottom", new Set(["2026-01-04"])]]) } }).includes("recommended.trip_day_uses_packed_pieces_only"));
  // Reported dirty after packing: the reuse is spent.
  assert.ok(run(trouserReasons, { ...wornTrousers, proposal: reuse(["2026-01-05", "2026-01-06"]), reuseFacts: { ...worn("2026-01-05"), tripDirtyAfterPack: new Set(["g-bottom"]) } }).includes("recommended.trip_day_uses_packed_pieces_only"));
  // A shirt (role top) follows the same budget.
  assert.deepEqual(run((role) => (role === "top" ? ["no_units_at_home", "on_trip"] : ["on_trip"]), { itemOptions: (role) => (role === "top" ? { inSuitcase: 0, wornInSuitcase: 1 } : {}), proposal: reuse(["2026-01-05", "2026-01-06"], "top"), reuseFacts: { tripDepartsOn: "2026-01-05", tripWornDates: new Map([["g-top", new Set(["2026-01-05"])]]) } }), []);
  // Socks are not a reuse role.
  assert.ok(run((role) => (role === "socks" ? ["no_units_at_home", "on_trip"] : ["on_trip"]), { itemOptions: (role) => (role === "socks" ? { inSuitcase: 0, wornInSuitcase: 1 } : {}), proposal: reuse(["2026-01-05", "2026-01-06"], "socks"), reuseFacts: { tripDepartsOn: "2026-01-05", tripWornDates: new Map([["g-socks", new Set(["2026-01-05"])]]) } }).includes("recommended.trip_day_uses_packed_pieces_only"));
  assert.ok(run((role) => (role === "bottom" ? ["disposed"] : [])).includes("recommended.not_hard_excluded"));
  const unpacked = run((role) => (role === "socks" ? ["on_trip"] : []), { packed: ["top", "bottom", "footwear"] });
  assert.ok(unpacked.includes("recommended.not_hard_excluded") && unpacked.includes("recommended.trip_day_uses_packed_pieces_only"));
  // Listed for packing but moved out of the suitcase since: not packed, and its home exclusion is not waived.
  const movedOut = run((role) => (role === "top" ? ["no_units_at_home"] : ["on_trip"]), { itemOptions: (role) => (role === "top" ? { inSuitcase: 0 } : {}) });
  assert.ok(movedOut.includes("recommended.trip_day_uses_packed_pieces_only") && movedOut.includes("recommended.not_hard_excluded"));
  // In the suitcase but excluded from planning: excluded, by its reason or by its policy alone.
  assert.ok(run((role) => (role === "bottom" ? ["on_trip", "planning_excluded"] : ["on_trip"])).includes("recommended.not_hard_excluded"));
  assert.ok(run(() => ["on_trip"], { itemOptions: (role) => (role === "socks" ? { planningPolicy: "excluded" } : {}) }).includes("recommended.not_hard_excluded"));
});

test("the profile restriction is checked for every garment restricted at the import, present or not", () => {
  const restricted = (id, availability) => ({ garment: { garmentId: id, name: `SYNTHETIC restricted ${id}` }, balances: [], totalOwnedUnits: 1, availability });
  const run = (items) => {
    const sim = bareSim();
    sim.restrictedAtStart = new Map([["g-a", ["r-1"]], ["g-b", ["r-2"]]]);
    checkAvailability(sim, { items, byId: new Map(items.map((i) => [i.garment.garmentId, i])) });
    return sim.failures.filter((f) => f.check === "restriction.from_the_profile_is_never_lifted").map((f) => f.message);
  };
  const kept = (ids) => ({ pAvailable: 0, hardExcluded: true, status: "unavailable", reasons: ["restricted"], restrictionIds: ids, inferredWear: [] });
  assert.deepEqual(run([restricted("g-a", kept(["r-1"])), restricted("g-b", kept(["r-2"]))]), []);
  assert.match(run([restricted("g-a", kept(["r-1"]))])[0], /g-b: missing from the snapshot/);
  assert.match(run([restricted("g-a", kept(["r-1"])), restricted("g-b", null)])[0], /no availability record/);
  assert.match(run([restricted("g-a", kept([])), restricted("g-b", kept(["r-2"]))])[0], /r-1 gone/);
});

test("undoing one report keeps a garment another report still supports; a correction removes it", () => {
  const sim = bareSim();
  sim.recordWear("2026-01-07", ["g-shirt", "g-chino"]);
  sim.recordWear("2026-01-07", ["g-shirt"]);
  sim.forgetWear("2026-01-07", ["g-shirt", "g-chino"]);
  assert.deepEqual([...sim.wears.get("2026-01-07")], [["g-shirt", 1]]);
  sim.forgetWear("2026-01-07", ["g-shirt"]);
  assert.equal(sim.wears.has("2026-01-07"), false);
  sim.recordWear("2026-01-08", ["g-shirt"]);
  sim.recordWear("2026-01-08", ["g-shirt"]);
  sim.forgetWear("2026-01-08", ["g-shirt"], { all: true });
  assert.equal(sim.wears.has("2026-01-08"), false);
});

test("the undo check: a garment another report supports must stay; with no such garment it does not apply", () => {
  const named = (ids) => ids.map((garmentId) => ({ garmentId, name: `SYNTHETIC ${garmentId}` }));
  // Two reports of the shirt, one of the chinos; the second report (shirt + chinos) is undone.
  const setUp = () => {
    const sim = bareSim();
    sim.recordWear("2026-01-07", ["g-shirt"]);
    sim.recordWear("2026-01-07", ["g-shirt", "g-chino"]);
    sim.forgetWear("2026-01-07", ["g-shirt", "g-chino"]);
    return sim;
  };
  const report = { date: "2026-01-07", ids: ["g-shirt", "g-chino"] };
  const honest = setUp();
  assert.deepEqual(checkUndoAgainstSupport(honest, report, named(["g-shirt"]), "c-1"), []);
  assert.deepEqual(failedIds(honest), []);
  // The product dropped the shirt although the first report still supports it.
  const dropped = setUp();
  checkUndoAgainstSupport(dropped, report, named([]), "c-1");
  assert.deepEqual(failedIds(dropped), ["undo.keeps_what_another_report_still_supports"]);
  // The product kept the chinos, which only the undone report supported: returned as wrongly kept.
  assert.deepEqual(checkUndoAgainstSupport(setUp(), report, named(["g-shirt", "g-chino"]), "c-1"), ["SYNTHETIC g-chino"]);
  // No other support at all: not applicable, never a pass.
  const alone = bareSim();
  alone.recordWear("2026-01-09", ["g-coat"]);
  alone.forgetWear("2026-01-09", ["g-coat"]);
  checkUndoAgainstSupport(alone, { date: "2026-01-09", ids: ["g-coat"] }, [], "c-2");
  assert.deepEqual(failedIds(alone), []);
  assert.equal(alone.checks.get("undo.keeps_what_another_report_still_supports").notApplicable, 1);
  assert.equal(alone.checks.get("undo.keeps_what_another_report_still_supports").passed, 0);
});

test("a garment's fingerprint covers acquisition and restrictions, and the change lists honour what is allowed", () => {
  const base = { garment: { garmentId: "g-1", acquisition: "owned" }, balances: [{ bucket: "clean", ref: "", quantity: 1 }], recordedWearCount: 3, totalOwnedUnits: 1, availability: { restrictionIds: ["r-1"] } };
  const same = garmentFingerprint(base);
  assert.notEqual(garmentFingerprint({ ...base, garment: { ...base.garment, acquisition: "returned" } }), same);
  assert.notEqual(garmentFingerprint({ ...base, availability: { restrictionIds: [] } }), same);
  assert.notEqual(garmentFingerprint({ ...base, restrictions: [{ restrictionId: "r-2" }] }), same);
  // Any garment property counts: name, roles, planning policy.
  assert.notEqual(garmentFingerprint({ ...base, garment: { ...base.garment, name: "renamed" } }), same);
  assert.notEqual(garmentFingerprint({ ...base, garment: { ...base.garment, roles: ["top"] } }), same);
  assert.notEqual(garmentFingerprint({ ...base, garment: { ...base.garment, planningPolicy: "excluded" } }), same);
  assert.equal(garmentFingerprint({ ...base, garment: { acquisition: "owned", garmentId: "g-1" } }), same, "key order does not count");
  assert.equal(garmentFingerprint({ ...base, balances: [...base.balances] }), same);
  const before = new Map([["g-1", same], ["g-2", "x"]]);
  const after = new Map([["g-1", garmentFingerprint({ ...base, recordedWearCount: 4 })], ["g-3", "y"]]);
  assert.equal(garmentChanges(before, after).length, 3);
  assert.equal(garmentChanges(before, after, new Set(["g-1", "g-3"])).length, 1);
  assert.deepEqual(wardrobeStateChanges({ revision: 4, receipts: "a", garments: before }, { revision: 4, receipts: "a", garments: new Map(before) }), []);
  assert.equal(wardrobeStateChanges({ revision: 4, receipts: "a", garments: before }, { revision: 5, receipts: "b", garments: before }).length, 2);
  // Background work recorded by the system actor while a request was in flight is not the request's write;
  // an owner's or assistant's receipt, an unexplained revision jump, or a garment change still is.
  const listOf = (...rs) => ({ receipts: rs.map((r) => r.commandId).join(","), receiptList: rs });
  const old = { commandId: "c-old", type: "wear.record", actor: "assistant", channel: "mcp" };
  const media = { commandId: "c-media", type: "media.record_discovery", actor: "system", channel: "system" };
  const move = { commandId: "c-move", type: "garment.move", actor: "assistant", channel: "mcp" };
  const at = (revision, garments, ...rs) => ({ revision, garments, ...listOf(...rs) });
  assert.deepEqual(wardrobeStateChanges(at(4, before, old), at(5, new Map(before), media, old)), []);
  assert.equal(wardrobeStateChanges(at(4, before, old), at(6, new Map(before), media, old)).length, 1, "two revisions for one background receipt");
  assert.equal(wardrobeStateChanges(at(4, before, old), at(6, new Map(before), move, media, old)).length, 2);
  assert.equal(wardrobeStateChanges(at(4, before, old), at(5, after, media, old)).length, 3, "a garment change is never background");
  // A background receipt does not hide the removal or reordering of receipts already listed (newest first).
  const older = { commandId: "c-older", type: "wear.record", actor: "assistant", channel: "mcp" };
  const oldest = { commandId: "c-oldest", type: "wear.record", actor: "assistant", channel: "mcp" };
  const three = { window: 3 };
  assert.deepEqual(wardrobeStateChanges(at(4, before, old, older, oldest), at(5, new Map(before), media, old, older), three), [], "the oldest pushed out of a full window");
  assert.equal(wardrobeStateChanges(at(4, before, old, older, oldest), at(5, new Map(before), media, old, older)).length, 2, "evicted although the window was not full");
  assert.equal(wardrobeStateChanges(at(4, before, old, older, oldest), at(5, new Map(before), media, older, oldest), three).length, 2, "the newest dropped instead of the oldest");
  assert.equal(wardrobeStateChanges(at(4, before, old, older, oldest), at(5, new Map(before), media, older, old), three).length, 2, "reordered");
  assert.equal(wardrobeStateChanges(at(4, before, old, older, oldest), at(5, new Map(before), old, media, older), three).length, 2, "the new receipt not at the front");
  assert.equal(wardrobeStateChanges(at(4, before, old, older, oldest), at(5, new Map(before), media, old), three).length, 2, "more removed than the window forces");
});

test("a failed run must change nothing, and a change needs a receipt", () => {
  const run = (state, extra = {}) => ({ runId: "run-1", state, error: state === "failed" ? { code: "model_error", message: "SYNTHETIC failure" } : null, result: state === "completed" ? { reply: { text: "ok" } } : null, receipts: [], ...extra });
  const clean = bareSim();
  checkRunHonesty(clean, "ask", run("failed"), []);
  assert.deepEqual(failedIds(clean), []);
  const moved = bareSim();
  checkRunHonesty(moved, "ask", run("failed"), ["garment g-1: a -> b"]);
  assert.deepEqual(failedIds(moved).sort(), ["run.a_failed_run_changes_nothing", "run.nothing_changes_without_a_receipt"]);
  // A failed run that lists receipts for what it changed is still a failed run that changed something.
  const listed = bareSim();
  checkRunHonesty(listed, "ask", run("failed", { receipts: [{ commandId: "c-1" }] }), ["ledger revision 4 -> 5"]);
  assert.deepEqual(failedIds(listed), ["run.a_failed_run_changes_nothing"]);
  const done = bareSim();
  checkRunHonesty(done, "ask", run("completed", { receipts: [{ commandId: "c-1" }] }), ["ledger revision 4 -> 5"]);
  assert.deepEqual(failedIds(done), []);
});

test("return paperwork that moves stock is caught, except for the garments the step may change", async () => {
  const withState = (garments) => Object.assign(bareSim(), { wardrobeState: async () => ({ revision: 1, receipts: "", garments }) });
  const before = new Map([["g-1", "a"], ["g-2", "b"]]);
  const still = withState(new Map(before));
  await expectStockUnchanged(still, "return.bookkeeping_moves_no_stock", before, "opening the case");
  assert.deepEqual(failedIds(still), []);
  const moved = withState(new Map([["g-1", "a"], ["g-2", "c"]]));
  await expectStockUnchanged(moved, "return.bookkeeping_moves_no_stock", before, "opening the case");
  assert.deepEqual(failedIds(moved), ["return.bookkeeping_moves_no_stock"]);
  const allowed = withState(new Map([["g-1", "a"], ["g-2", "c"], ["g-new", "d"]]));
  await expectStockUnchanged(allowed, "return.departure_changes_only_the_departed_piece", before, "the departure", new Set(["g-2", "g-new"]));
  assert.deepEqual(failedIds(allowed), []);
});

/**
 * An in-memory TEST DOUBLE of the MCP command tool, inventory views and the owner's proposal API, honest
 * by default. `reuseRuns` makes a reused key execute its new payload before refusing; `rejectRuns` makes the
 * owner's rejection execute the proposal. It stands in for the Worker only to prove the checks catch these.
 */
function fakeWardrobe({ reuseRuns = false, rejectRuns = false, waits = new Set(["garment.merge"]) } = {}) {
  const state = { revision: 1, receipts: [], clean: 3, keys: new Map(), proposals: new Map() };
  const execute = (type) => {
    state.revision++;
    state.clean--;
    const receipt = { commandId: `cmd-${state.revision}`, type, outcome: "committed", summary: "Recorded.", affected: [], undo: { available: true }, actor: "assistant", channel: "mcp", occurredAt: "t", recordedAt: "t", wardrobeRevision: state.revision };
    state.receipts.unshift(receipt);
    return receipt;
  };
  const envelope = (data) => ({ ok: true, data: { wardrobeRevision: state.revision, data } });
  const session = {
    async callTool(name, args) {
      if (name === "garderobe_inventory") {
        if (args.view === "receipts") return envelope({ receipts: state.receipts.slice(0, args.limit ?? 20) });
        return envelope({ items: [{ garment: { garmentId: "g-1", name: "SYNTHETIC shirt" }, balances: [{ bucket: "clean", ref: "", quantity: state.clean }], recordedWearCount: 0, totalOwnedUnits: 3 }] });
      }
      const body = JSON.stringify(args.payload);
      const seen = state.keys.get(args.idempotencyKey);
      if (seen && seen.body !== body) {
        if (reuseRuns) execute(args.type);
        return { ok: false, error: { code: "idempotency_key_reuse", message: "same key, different request", details: {} } };
      }
      if (seen?.proposalId) {
        const p = state.proposals.get(seen.proposalId);
        if (p.state === "rejected") return { ok: false, error: { code: "forbidden", message: "rejected", details: {} } };
        return { ok: false, error: { code: "confirmation_required", message: "waits", details: { proposalId: p.proposalId, summary: "Merge two shirts." } } };
      }
      if (seen) return { ok: true, data: { receipt: { ...seen.receipt, replayed: true } } };
      if (waits.has(args.type)) {
        const proposalId = `p-${state.proposals.size + 1}`;
        state.proposals.set(proposalId, { proposalId, type: args.type, state: "pending", source: { channel: "mcp" }, summary: "Merge two shirts." });
        state.keys.set(args.idempotencyKey, { body, proposalId });
        return { ok: false, error: { code: "confirmation_required", message: "waits", details: { proposalId, summary: "Merge two shirts." } } };
      }
      const receipt = execute(args.type);
      state.keys.set(args.idempotencyKey, { body, receipt });
      return { ok: true, data: { receipt } };
    },
  };
  const target = {
    now: () => 0,
    calls: [],
    async apiOk() {
      return { proposals: [...state.proposals.values()] };
    },
    async api(_owner, _method, url, { decision }) {
      const p = state.proposals.get(url.split("/")[3]);
      p.state = decision === "reject" ? "rejected" : "confirmed";
      if (rejectRuns && decision === "reject") execute(p.type);
      return { ok: true, json: {} };
    },
  };
  const sim = new Sim({ target, plan: { seed: "unit", timezone: "Europe/London", startDate: "2026-01-05" } });
  sim.sessions = { writer: session, reader: session, second: null };
  return sim;
}

test("key reuse: refusing is not enough; the reused key must run nothing (test double)", async () => {
  const honest = fakeWardrobe();
  await honest.probeKeyReuse("care.mark_dirty", { items: [{ garmentId: "g-1", quantity: 1 }] }, { items: [{ garmentId: "g-1", quantity: 2 }] });
  assert.deepEqual(failedIds(honest).filter((id) => id.startsWith("receipt.key_reuse")), []);
  const lying = fakeWardrobe({ reuseRuns: true });
  await lying.probeKeyReuse("care.mark_dirty", { items: [{ garmentId: "g-1", quantity: 1 }] }, { items: [{ garmentId: "g-1", quantity: 2 }] });
  assert.ok(failedIds(lying).includes("receipt.key_reuse_runs_nothing"));
  assert.ok(!failedIds(lying).includes("receipt.key_reuse_refused"));
});

test("owner rejection: the ledger after the rejection must equal the ledger before the request (test double)", async () => {
  const honest = fakeWardrobe();
  const outcome = await honest.command("garment.merge", { from: "g-1", into: "g-2" }, { decision: "reject", verify: false });
  assert.equal(outcome.route, "owner_rejected");
  assert.deepEqual(failedIds(honest), []);
  const lying = fakeWardrobe({ rejectRuns: true });
  await lying.command("garment.merge", { from: "g-1", into: "g-2" }, { decision: "reject", verify: false });
  assert.ok(failedIds(lying).includes("proposal.rejected_stays_unexecuted"));
});

test("a refusal that decides no route (internal, unavailable, unknown) fails the contract check", () => {
  const sim = bareSim();
  assert.equal(sim.expectContractRoute("wear.record", { route: "refused", receipt: null, error: { code: "internal", message: "boom" } }), false);
  assert.equal(sim.expectContractRoute("wear.record", { route: "refused", receipt: null, error: { code: "unparsed_tool_error", message: "?" } }), false);
  assert.equal(sim.expectContractRoute("wear.record", { route: "refused", receipt: null, error: { code: "precondition_failed", message: "no clean unit" } }), true);
  assert.deepEqual(failedIds(sim), ["contract.route_is_decided", "contract.route_is_decided"]);
});

test("a paused day is one inside the recorded pause until it is resumed", () => {
  const sim = bareSim();
  sim.pause = { active: true, from: "2026-01-10", until: "2026-01-12" };
  assert.deepEqual(["2026-01-09", "2026-01-10", "2026-01-12", "2026-01-13"].map((d) => isPausedDay(sim, d)), [false, true, true, false]);
  sim.pause.active = false;
  assert.equal(isPausedDay(sim, "2026-01-11"), false);
});

test("an option's composition uses stable names and roles, in a stable order", () => {
  const a = { garments: [{ role: "top", name: "Pima oxford — navy", garmentId: "gmt_1" }, { role: "bottom", name: "Cord — navy", garmentId: "gmt_2" }] };
  const b = { garments: [{ role: "bottom", name: "Cord — navy", garmentId: "other" }, { role: "top", name: "Pima oxford — navy", garmentId: "ids" }] };
  assert.equal(composition(a), composition(b));
  assert.equal(composition(a), "bottom:Cord — navy + top:Pima oxford — navy");
});

test("the state directory: only a marked directory outside the repository is ever emptied", () => {
  assert.throws(() => prepareStateDir(REPO_ROOT), /inside the repository/);
  assert.throws(() => prepareStateDir(path.join(REPO_ROOT, "tests", "simulation", "state")), /inside the repository/);
  assert.throws(() => prepareStateDir(path.dirname(REPO_ROOT)), /inside the repository or contains it/);
  assert.throws(() => prepareStateDir(path.parse(REPO_ROOT).root), /root|repository/);
  const base = mkdtempSync(path.join(os.tmpdir(), "sim-statedir-test-"));
  try {
    const foreign = path.join(base, "foreign");
    mkdirSync(foreign);
    writeFileSync(path.join(foreign, "keep.txt"), "not the simulation's");
    assert.throws(() => prepareStateDir(foreign), /marker/);
    assert.ok(existsSync(path.join(foreign, "keep.txt")));
    const ours = path.join(base, "ours");
    prepareStateDir(ours);
    writeFileSync(path.join(ours, "old-run.log"), "x");
    prepareStateDir(ours);
    assert.ok(existsSync(path.join(ours, STATE_MARKER)));
    assert.ok(!existsSync(path.join(ours, "old-run.log")));
    // A path through a symlink into the repository is the repository: refused, and nothing is written there.
    const intoRepo = path.join(base, "into-repo");
    symlinkSync(path.join(REPO_ROOT, "tests", "simulation"), intoRepo, "dir");
    assert.throws(() => prepareStateDir(path.join(intoRepo, "state-under-a-link")), /inside the repository/);
    assert.ok(!existsSync(path.join(REPO_ROOT, "tests", "simulation", "state-under-a-link")));
    // A symlink as the state directory itself is refused, wherever it points.
    const linkedState = path.join(base, "linked-state");
    symlinkSync(ours, linkedState, "dir");
    assert.throws(() => prepareStateDir(linkedState), /symlink/);
    assert.equal(canonicalPath(path.join(intoRepo, "a", "b")), path.join(REPO_ROOT, "tests", "simulation", "a", "b"));
    // A marker that is a symlink to our marker, a directory of that name, or a file with other text is not ours.
    const linkedMarker = path.join(base, "linked-marker");
    mkdirSync(linkedMarker);
    writeFileSync(path.join(linkedMarker, "keep.txt"), "x");
    symlinkSync(path.join(ours, STATE_MARKER), path.join(linkedMarker, STATE_MARKER));
    assert.throws(() => prepareStateDir(linkedMarker), /marker/);
    const dirMarker = path.join(base, "dir-marker");
    mkdirSync(path.join(dirMarker, STATE_MARKER), { recursive: true });
    assert.throws(() => prepareStateDir(dirMarker), /marker/);
    const otherText = path.join(base, "other-text");
    mkdirSync(otherText);
    writeFileSync(path.join(otherText, STATE_MARKER), "something else\n");
    assert.throws(() => prepareStateDir(otherText), /marker/);
    assert.ok(existsSync(path.join(linkedMarker, "keep.txt")) && existsSync(path.join(otherText, STATE_MARKER)));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  // Containment is separator-aware: a child whose name begins with two dots is inside; a sibling is not.
  assert.equal(isWithin("/srv/state/..data", "/srv/state"), true);
  assert.equal(isWithin("/srv/other", "/srv/state"), false);
  assert.equal(isWithin("/srv/state", "/srv/state"), true);
});

test("balance differences: only the expected moves are allowed, for every garment", () => {
  const item = (garmentId, balances, owned = 2) => ({ garment: { garmentId, name: `SYNTHETIC ${garmentId}` }, balances, totalOwnedUnits: owned });
  const snap = (...items) => ({ byId: new Map(items.map((i) => [i.garment.garmentId, i])) });
  const before = snap(item("g-1", [{ bucket: "dirty", ref: "d1", quantity: 2 }]), item("g-2", [{ bucket: "clean", ref: "", quantity: 2 }]));
  const pickup = (garmentId, map) => {
    if (garmentId !== "g-1") return;
    moveBalance(map, "dirty|*", -2);
    moveBalance(map, "service|b1", 2);
  };
  const honest = snap(item("g-1", [{ bucket: "service", ref: "b1", quantity: 2 }]), item("g-2", [{ bucket: "clean", ref: "", quantity: 2 }]));
  assert.deepEqual(balanceDifferences(before, honest, pickup, ["dirty"]), []);
  // The pickup also took a clean shirt that was not waiting.
  const greedy = snap(item("g-1", [{ bucket: "service", ref: "b1", quantity: 2 }]), item("g-2", [{ bucket: "clean", ref: "", quantity: 1 }, { bucket: "service", ref: "b1", quantity: 1 }]));
  assert.equal(balanceDifferences(before, greedy, pickup, ["dirty"]).length, 1);
  // Totals preserved but redistributed to another bucket.
  const shuffled = snap(item("g-1", [{ bucket: "service", ref: "b1", quantity: 1 }, { bucket: "tailor", ref: "", quantity: 1 }]), item("g-2", [{ bucket: "clean", ref: "", quantity: 2 }]));
  assert.equal(balanceDifferences(before, shuffled, pickup, ["dirty"]).length, 1);
  assert.match(balanceDifferences(before, snap(item("g-1", [{ bucket: "service", ref: "b1", quantity: 2 }])), pickup, ["dirty"])[0], /disappeared/);
});

test("stable JSON ignores key order and nothing else", () => {
  assert.equal(stableJson({ a: 1, b: { c: [1, { d: 2, e: 3 }] } }), stableJson({ b: { c: [1, { e: 3, d: 2 }] }, a: 1 }));
  assert.notEqual(stableJson({ a: [1, 2] }), stableJson({ a: [2, 1] }));
  assert.notEqual(stableJson({ reason: "x" }), stableJson({ reason: "y" }));
});

test("the owner's sign-in goes only to the target's app origin; a development target is checked before it runs", async () => {
  const { assertSameOrigin } = await import("../lib/target.mjs");
  const { devSimulationWranglerConfig, resolveTargetDescription } = await import("../lib/dev-target.mjs");
  assert.doesNotThrow(() => assertSameOrigin("http://localhost:8850/oauth/authorize?x=1", "http://localhost:8850", "url"));
  assert.throws(() => assertSameOrigin("https://evil.example/oauth/authorize", "http://localhost:8850", "url"), /not on the target's app origin/);
  assert.throws(() => assertSameOrigin("http://localhost:8851/oauth/authorize", "http://localhost:8850", "url"), /not on the target's app origin/);
  assert.throws(() => assertSameOrigin("not a url", "http://localhost:8850", "url"), /not a URL/);
  const dev = { kind: "development-simulation-worker", label: "dev", appOrigin: "https://sim-app.example", mcpOrigin: "https://sim-mcp.example", signIn: { kind: "headers-from-environment" }, owners: {}, doors: { kind: "simulation-worker", controlOrigin: "https://sim-mcp.example", controlTokenFromEnvironment: "SIM_TOKEN", clock: true } };
  assert.equal(resolveTargetDescription(dev, { SIM_TOKEN: "x".repeat(32) }).doors.expectMode, "development-simulation");
  assert.throws(() => resolveTargetDescription(dev, {}), /not set/);
  assert.throws(() => resolveTargetDescription(dev, { SIM_TOKEN: "short" }), /shorter than 32/);
  assert.throws(() => resolveTargetDescription({ ...dev, appOrigin: "http://sim-app.example" }, { SIM_TOKEN: "x".repeat(32) }), /https/);
  assert.throws(() => resolveTargetDescription({ ...dev, doors: { ...dev.doors, controlToken: "inline" } }, { SIM_TOKEN: "x".repeat(32) }), /must not carry/);
  assert.throws(() => resolveTargetDescription({ ...dev, signIn: { kind: "local-assertion" } }, { SIM_TOKEN: "x".repeat(32) }), /headers-from-environment/);
  const resources = { d1: { name: "garderobe-sim-dev-db", id: "d" }, kv: { id: "k" }, media: "garderobe-sim-dev-media", exports: "garderobe-sim-dev-exports", queue: "garderobe-sim-dev-media" };
  const options = { name: "garderobe-sim-dev", main: "entry.ts", migrationsDir: "m", appOrigin: "https://a.example", mcpOrigin: "https://b.example", accessTeamDomain: "https://team.cloudflareaccess.com", accessAud: "aud", resources };
  const config = devSimulationWranglerConfig(options);
  assert.equal(config.vars.ENVIRONMENT, "development");
  assert.equal(config.vars.SIM_DEPLOYMENT, "development-simulation");
  assert.ok(!("SIM_CONTROL_TOKEN" in config.vars));
  assert.throws(() => devSimulationWranglerConfig({ ...options, name: "garderobe-dev" }), /must start with/);
  assert.throws(() => devSimulationWranglerConfig({ ...options, resources: { ...resources, media: "garderobe-dev-media" } }), /simulation-only/);
  // The default gateway is one the product accepts (packages/assistant/src/inference/gateway.ts).
  const gatewaySource = (await import("node:fs")).readFileSync(new URL("../../../packages/assistant/src/inference/gateway.ts", import.meta.url), "utf8");
  const ALLOWED_GATEWAY_IDS = JSON.parse(gatewaySource.match(/ALLOWED_GATEWAY_IDS = (\[[^\]]*\])/)[1]);
  assert.ok(ALLOWED_GATEWAY_IDS.includes(config.vars.AI_GATEWAY_ID), `AI_GATEWAY_ID ${config.vars.AI_GATEWAY_ID}`);
  assert.equal(config.vars.AI_GATEWAY_ID, "garderobe-dev");
  // Result file names: a plain seed as it is; anything else encoded, never a path.
  const { seedFileName } = await import("../bin/run.mjs");
  assert.equal(seedFileName("3"), "3");
  for (const seed of ["../../etc", "a/b", "a.b"]) assert.match(seedFileName(seed), /^=[A-Za-z0-9_-]+$/);
  assert.notEqual(seedFileName("a.b"), seedFileName("a_b"));
  // An encoded seed never takes the name of a plain one ('/' encodes to 'Lw').
  assert.notEqual(seedFileName("/"), seedFileName("xLw"));
  assert.notEqual(seedFileName("/"), seedFileName("Lw"));
});

test("a colour-qualified name resolves only on its complete colour", () => {
  const row = SHEET_ROWS.find((r) => SHEET_ROWS.filter((o) => o.item === r.item).length > 1 && r.colour);
  assert.ok(row, "the sheet repeats at least one item across colours");
  const shown = `${row.item} — ${row.colour.toLowerCase()}`;
  assert.deepEqual(sheetRowsFor(shown).map((r) => r.line), SHEET_ROWS.filter((r) => r.item === row.item && r.colour.toLowerCase() === row.colour.toLowerCase()).map((r) => r.line));
  assert.deepEqual(sheetRowsFor(`${shown} nonexistent`), []);
  assert.deepEqual(sheetRowsFor(`${row.item} — ${row.colour.toLowerCase().split(" ")[0]} nonexistent`), []);
});

test("the swap's revision: the receipt's own version, or a later background replenish or refresh; a stray revision fails", () => {
  const receipt = { affected: [{ kind: "board", id: "brd_1", version: 2 }, { kind: "garment", id: "g_1", version: 5 }] };
  // The read-back at exactly the receipt's version.
  assert.equal(swapRevisionVerdict(receipt, "brd_1", 1, { revision: 2, reason: "swap" }).ok, true);
  // The background replenish (exec.waitUntil → replenishBoards) published before the read-back.
  assert.equal(swapRevisionVerdict(receipt, "brd_1", 1, { revision: 3, reason: "replenish" }).ok, true);
  assert.equal(swapRevisionVerdict(receipt, "brd_1", 1, { revision: 4, reason: "refresh" }).ok, true);
  // A later revision that is not the product's background work still fails.
  for (const reason of ["swap", "repair", "rebuild", "compose", "resume", undefined]) assert.equal(swapRevisionVerdict(receipt, "brd_1", 1, { revision: 3, reason }).ok, false, `a later ${reason} revision`);
  // An earlier read-back, a receipt that names no new version, another board or no board at all fails.
  assert.equal(swapRevisionVerdict(receipt, "brd_1", 1, { revision: 1, reason: "replenish" }).ok, false);
  assert.equal(swapRevisionVerdict(receipt, "brd_1", 2, { revision: 3, reason: "replenish" }).ok, false);
  assert.equal(swapRevisionVerdict(receipt, "brd_2", 1, { revision: 2, reason: "swap" }).ok, false);
  assert.equal(swapRevisionVerdict({ affected: [] }, "brd_1", 1, { revision: 2, reason: "swap" }).ok, false);
  assert.equal(swapRevisionVerdict({ affected: [...receipt.affected, { kind: "board", id: "brd_1", version: 3 }] }, "brd_1", 1, { revision: 3, reason: "swap" }).ok, false);
  assert.equal(swapRevisionVerdict(receipt, "brd_1", 1, null).ok, false);
});
