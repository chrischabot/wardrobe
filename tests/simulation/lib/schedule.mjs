/**
 * The ordered steps of a plan. A step is `{ day, at, kind, ... }`: a day index (-1 is the evening before
 * the first day), a local time on the owner's clock and what happens then. The runner sets the target's
 * clock to that moment (when the target has a clock), runs the step and then checks every invariant.
 *
 * A day, on the owner's clock (Europe/London; the product's defaults: composition at 21:00 the evening
 * before, refresh at 06:40, publication at 06:50, the board presented at 07:00):
 *
 *   06:45 06:55 07:05  the scheduled sweep (refresh, publish, present)
 *   07:10              a wear report about yesterday, when yesterday's was late
 *   07:15              the morning: read the board, choose, change the choice, or ask for other options
 *   08:10 Friday       laundry pickup;  11:00 Saturday  the bag comes back (or does not)
 *   through the day    forecast changes and outages, calendar entries appearing, moving and being
 *                      cancelled, garments becoming unavailable or coming back, the owner's own
 *                      observations, the order and its return, the trip, the pause
 *   12:30              the scheduled sweep
 *   19:30              the wear report of the day
 *   21:05              the scheduled sweep (tomorrow's board is composed)
 *   21:20              tomorrow's board: read, sometimes chosen already, sometimes a planned piece then
 *                      becomes unavailable (the repair probe)
 *   22:30              one inventory view in depth; the isolation check on three days
 */
const ORDER = ["weather_outage", "weather_change", "pause", "resume", "sweep", "late_wear_report", "after_baseline", "morning"];

export function buildSteps(plan) {
  const steps = [];
  let sequence = 0;
  const add = (day, at, kind, extra = {}) => {
    if (day < -1 || day >= plan.dayCount) return;
    steps.push({ day, at, kind, ...extra, sequence: sequence++ });
  };
  const circumstance = (d) => plan.days[d]?.circumstance ?? "ordinary";

  add(-1, "21:05", "sweep", { why: "the first board is composed the evening before the first day" });
  add(-1, "21:20", "plan_tomorrow");

  for (const day of plan.days) {
    const d = day.index;
    for (const at of ["06:45", "06:55", "07:05"]) add(d, at, "sweep");
    if (d > 0 && plan.days[d - 1].reportedLate) add(d, "07:10", "late_wear_report", { forDay: d - 1 });
    if (day.weekday === 1 && d >= 7) add(d, "07:08", "after_baseline", { week: d / 7 - 1 });
    add(d, "07:15", "morning");
    add(d, "12:30", "sweep");
    add(d, "19:30", "evening_report");
    add(d, "21:05", "sweep");
    add(d, "21:20", "plan_tomorrow", { probe: plan.repairProbes.find((p) => p.eveningOfDay === d) ?? null });
    add(d, "22:30", "night", { isolation: plan.toolExercise.isolationDays.includes(d) });
    if (day.weekday === 7) add(d, "23:10", "sweep", { why: "the weekly baseline day ends" });
    if (plan.workFromHomeDays.includes(d + 1)) add(d, "20:40", "day_brief", { forDay: d + 1 });
  }

  for (const change of plan.weather.changes) {
    add(change.onDay, change.at, "weather_change", { change });
    if (change.at === "07:40") add(change.onDay, "07:50", "sweep", { why: "after a forecast change that followed publication" });
  }
  for (const outage of plan.weather.outages) {
    add(outage.downOnDay, outage.downAt, "weather_outage", { down: true, outage: outage.kind });
    add(outage.upOnDay, outage.upAt, "weather_outage", { down: false, outage: outage.kind });
  }

  for (const event of plan.calendar) {
    add(event.appearsDay, event.appearsAt, "calendar_change", { action: "appear", event });
    if (event.moved) add(event.moved.onDay, event.moved.at, "calendar_change", { action: "move", event });
    if (event.cancelled) add(event.cancelled.onDay, event.cancelled.at, "calendar_change", { action: "cancel", event });
  }

  plan.availability.forEach((event, index) => {
    add(event.onDay, event.at, "becomes_unavailable", { event, index });
    if (event.backOnDay !== null && event.backOnDay > event.onDay) add(event.backOnDay, event.backAt, "comes_back", { event, index });
  });
  plan.observations.forEach((observation, index) => add(observation.onDay, observation.at, "owner_observation", { observation, index }));

  for (const week of plan.laundry) {
    const away = (d) => circumstance(d) === "trip";
    if (week.kind !== "no_reports" && !away(week.collectDay)) {
      add(week.collectDay, "08:10", "laundry_collect", { week });
      if (!away(week.returnDay)) add(week.returnDay, "11:00", "laundry_return", { week });
      else add(week.lateReturnDay, "11:00", "laundry_return", { week: { ...week, kind: "normal" }, why: "the bag came back while he was away; reported on his return" });
      if (week.kind === "still_away" || week.kind === "missed_return" || week.kind === "lost_in_service") add(week.lateReturnDay, "11:30", "laundry_late_return", { week });
    }
    if (!away(week.sockWashDay)) add(week.sockWashDay, "18:00", "socks_washed", { week });
  }

  const trip = plan.trip;
  add(trip.createDay, "11:00", "trip_create");
  add(trip.proposalDay, "11:00", "trip_proposal");
  add(trip.packDay, "21:40", "trip_pack");
  add(trip.lastDay, "20:15", "trip_unpack");

  add(plan.pause.firstDay - 1, "20:30", "pause");
  if (!plan.pause.withResumeDate) add(plan.pause.resumeDay, "06:30", "resume");

  const purchase = plan.purchase;
  add(purchase.orderDay, "10:00", "purchase_order");
  add(purchase.arrivalDay, "10:00", "purchase_arrival");
  add(purchase.openCaseDay, "10:00", "return_open");
  add(purchase.labelDay, "10:00", "return_label");
  add(purchase.postDay, "10:00", "return_post");
  add(purchase.refundDay, "10:00", "return_settle");

  const tools = plan.toolExercise;
  tools.askDays.forEach((d, i) => add(d, "14:00", "ask", { variant: i }));
  tools.researchDays.forEach((d, i) => add(d, "14:20", "research", { variant: i }));
  tools.liftAttemptDays.forEach((d, i) => add(d, "15:00", "lift_attempt", { variant: i }));
  tools.undoDays.forEach((d) => add(d, "20:00", "undo_a_report"));
  tools.amendDays.forEach((d) => add(d, "20:10", "amend_a_report"));

  const rank = (kind) => {
    const index = ORDER.indexOf(kind);
    return index === -1 ? ORDER.length : index;
  };
  steps.sort((a, b) => a.day - b.day || a.at.localeCompare(b.at) || rank(a.kind) - rank(b.kind) || a.sequence - b.sequence);
  return steps.map(({ sequence: _sequence, ...step }, index) => ({ index, ...step }));
}

/** How many steps of each kind a plan has. */
export function stepCounts(steps) {
  const counts = {};
  for (const step of steps) counts[step.kind] = (counts[step.kind] ?? 0) + 1;
  return counts;
}
