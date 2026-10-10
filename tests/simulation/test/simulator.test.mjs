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
import { internalCodesIn } from "../lib/sim.mjs";
import { buildPlan, plannedConditions } from "../lib/timeline.mjs";

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
    const special = plan.days.filter((d) => d.circumstance !== "ordinary").map((d) => d.index);
    assert.equal(new Set(special).size, special.length);
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
    for (const kind of ["weather_change", "weather_outage", "calendar_change", "becomes_unavailable", "comes_back", "owner_observation", "socks_washed", "trip_create", "trip_proposal", "trip_pack", "trip_unpack", "pause", "purchase_order", "return_open", "return_post", "ask", "research", "lift_attempt", "undo_a_report", "amend_a_report"]) assert.ok(kinds.has(kind), `seed ${seed} has no ${kind} step`);
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
  caught(swap("footwear", "Paraboot Reims — Noir"), day(), /not a sneaker/);
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
