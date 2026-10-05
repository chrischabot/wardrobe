/**
 * The timeline of one simulation, generated from its seed and nothing else.
 *
 * `buildPlan({ seed, weeks, startDate })` is a pure function: the same arguments give the same plan,
 * byte for byte (see `planDigest`). The plan holds every condition and every decision of the run in
 * advance: the weather of each day and each later change of forecast, the calendar entries and when
 * they appear, move or are cancelled, the circumstances (a trip, an illness, days at home, a pause, a
 * return or an exchange), what becomes unavailable and when, the weekly laundry and its exceptions, the
 * owner's contradicting observations, and for every day the uniform draws that decide which outfit is
 * chosen, rejected, worn or reported twice. What the plan cannot hold is the server's answer (which
 * garments a board offers), so a choice is stored as a draw in [0, 1) and resolved at run time against
 * the offered list in a stable order.
 *
 * Everything here is SYNTHETIC by construction: simulated weather, simulated calendar entries and
 * simulated circumstances, labelled as such wherever their text reaches the application.
 */
import { addDays, isoWeekday } from "./dates.mjs";
import { digest, stream } from "./rng.mjs";

export const TIMEZONE = "Europe/London";
export const HOME_PLACE = { label: "Elephant and Castle (SIMULATED forecast)", latitude: 51.4946, longitude: -0.1002, timezone: TIMEZONE };

/** Mondays in 2027, one per season; two of them have a daylight-saving change inside four weeks. */
const SEASON_STARTS = [
  { startDate: "2027-01-04", season: "winter", morningC: 2, peakC: 7, driftC: 1 },
  { startDate: "2027-03-08", season: "spring (summer time begins on 28 March)", morningC: 5, peakC: 11, driftC: 5 },
  { startDate: "2027-05-31", season: "early summer", morningC: 12, peakC: 20, driftC: 5 },
  { startDate: "2027-07-19", season: "high summer", morningC: 16, peakC: 25, driftC: 2 },
  { startDate: "2027-09-06", season: "autumn", morningC: 13, peakC: 20, driftC: -6 },
  { startDate: "2027-10-11", season: "late autumn (summer time ends on 31 October)", morningC: 9, peakC: 14, driftC: -5 },
];

const TRIP_PLACES = [
  { label: "Paris (SIMULATED forecast)", latitude: 48.8566, longitude: 2.3522, timezone: "Europe/Paris", offsetC: 3 },
  { label: "Rotterdam (SIMULATED forecast)", latitude: 51.9244, longitude: 4.4777, timezone: "Europe/Amsterdam", offsetC: -1 },
  { label: "Edinburgh (SIMULATED forecast)", latitude: 55.9533, longitude: -3.1883, timezone: "Europe/London", offsetC: -4 },
  { label: "Lisbon (SIMULATED forecast)", latitude: 38.7223, longitude: -9.1393, timezone: "Europe/Lisbon", offsetC: 7 },
];

const FORMAL_TITLES = ["Wedding reception (SIMULATED)", "Formal dinner with the trustees (SIMULATED)", "Opening night at the theatre (SIMULATED)", "Client presentation at the bank (SIMULATED)", "Memorial service (SIMULATED)"];
const WORKOUT_TITLES = ["Gym: strength session (SIMULATED)", "Long walk on the Heath (SIMULATED)", "Physiotherapy for the foot (SIMULATED)", "Swim at the leisure centre (SIMULATED)"];
const ORDINARY_TITLES = ["Lunch with Pieter (SIMULATED)", "Dentist (SIMULATED)", "Team meeting (SIMULATED)", "Coffee at the bookshop (SIMULATED)"];

const round = (n) => Math.round(n);
const hhmm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** Which season a seed starts in when no start date is given: numeric seeds rotate through the list. */
export function seasonFor(seed) {
  const n = Number(seed);
  const index = Number.isInteger(n) ? ((n % SEASON_STARTS.length) + SEASON_STARTS.length) % SEASON_STARTS.length : Math.floor(stream(seed, "season").next() * SEASON_STARTS.length);
  return SEASON_STARTS[index];
}

export function buildPlan({ seed, weeks = 4, startDate } = {}) {
  if (seed === undefined || seed === null || seed === "") throw new Error("a seed is required");
  if (weeks < 4) throw new Error("a simulation spans at least four weeks");
  const season = startDate ? { ...seasonFor(seed), startDate } : seasonFor(seed);
  if (isoWeekday(season.startDate) !== 1) throw new Error("the start date must be a Monday");
  const dayCount = weeks * 7;
  const date = (index) => addDays(season.startDate, index);
  const rng = (name) => stream(seed, name);

  /* ------------------------------ circumstances: who is where, when ------------------------------ */
  const layout = rng("layout");
  const tripStart = layout.int(8, 10);
  const tripLength = 3;
  const trip = {
    name: "SIMULATED trip",
    place: layout.pick(TRIP_PLACES),
    createDay: tripStart - 4,
    proposalDay: tripStart - 2,
    packDay: tripStart - 1,
    firstDay: tripStart,
    lastDay: tripStart + tripLength - 1,
    carryOnPieces: layout.int(9, 14),
    dinnerDay: tripStart + 1,
  };
  const illness = { firstDay: layout.int(14, 16), length: 2 };
  illness.lastDay = illness.firstDay + illness.length - 1;
  const pause = { firstDay: layout.int(20, 22), length: layout.int(2, 3), withResumeDate: layout.chance(0.5) };
  pause.lastDay = pause.firstDay + pause.length - 1;
  pause.resumeDay = pause.lastDay + 1;
  const purchase = { orderDay: layout.int(1, 3), kind: layout.chance(0.5) ? "return" : "exchange" };
  purchase.arrivalDay = purchase.orderDay + 2;
  purchase.openCaseDay = purchase.orderDay + 3;
  purchase.labelDay = purchase.orderDay + 4;
  purchase.postDay = purchase.orderDay + 5;
  purchase.refundDay = Math.min(dayCount - 2, purchase.orderDay + 16);

  const busy = new Set();
  for (let d = trip.packDay; d <= trip.lastDay + 1; d++) busy.add(d);
  for (let d = illness.firstDay; d <= illness.lastDay; d++) busy.add(d);
  for (let d = pause.firstDay - 1; d <= pause.resumeDay; d++) busy.add(d);
  const freeDays = [...Array(dayCount).keys()].filter((d) => !busy.has(d) && d >= 1 && d <= dayCount - 2);
  const workFromHome = new Set(layout.sample(freeDays, 3));

  /* ------------------------------ weather ------------------------------ */
  const wx = rng("weather");
  const baseline = [];
  let wobble = 0;
  // Scripted beyond the last day so that the last evenings still have a forecast for the day after.
  for (let d = -1; d < dayCount + 9; d++) {
    wobble = Math.max(-4, Math.min(4, wobble + wx.int(-2, 2)));
    const drift = (season.driftC * Math.max(0, Math.min(d, dayCount))) / dayCount;
    const peakC = round(season.peakC + drift + wobble);
    const morningC = round(Math.min(peakC - 2, season.morningC + drift + wobble * 0.6));
    baseline.push({ day: d, script: { morningC, peakC, eveningC: round((morningC + peakC) / 2), ...(wx.chance(0.18) ? { rainFromHour: wx.int(6, 16), rainMmPerHour: wx.pick([0.6, 1.5, 3]) } : {}), gustKmh: wx.pick([12, 18, 18, 26, 44]) } });
  }
  const scriptOf = (d) => ({ ...baseline.find((b) => b.day === d).script });
  const weatherChanges = [];
  // A heat spike and a cold snap, each two days long, known from the evening before the first day.
  const heatDay = wx.pick(freeDays.filter((d) => d >= 3 && d <= dayCount - 4));
  const coldDay = wx.pick(freeDays.filter((d) => d >= 3 && d <= dayCount - 4 && Math.abs(d - heatDay) > 3));
  for (const [first, delta, kind] of [[heatDay, 9, "heat"], [coldDay, -8, "cold_snap"]]) {
    for (const d of [first, first + 1]) {
      const s = scriptOf(d);
      weatherChanges.push({ kind, onDay: first - 1, at: "18:30", forDay: d, script: { ...s, morningC: s.morningC + round(delta * 0.6), peakC: s.peakC + delta, eveningC: s.eveningC + round(delta * 0.8) } });
    }
  }
  // Sudden rain: the forecast for a day changes on that same morning, before or after the board was published.
  for (const d of wx.sample(freeDays.filter((x) => x !== heatDay && x !== heatDay + 1), 4)) {
    const afterPublication = wx.chance(0.5);
    weatherChanges.push({ kind: "sudden_rain", onDay: d, at: afterPublication ? "07:40" : "06:20", forDay: d, script: { ...scriptOf(d), rainFromHour: afterPublication ? 9 : 7, rainMmPerHour: 3 } });
  }
  // Forecast outages: the provider is down over an evening composition and the next morning, or during the day.
  const outages = [];
  const outageDays = wx.sample(freeDays.filter((d) => d >= 2), 2);
  outages.push({ kind: "forecast_outage_overnight", downOnDay: outageDays[0] - 1, downAt: "20:40", upOnDay: outageDays[0], upAt: "09:30" });
  outages.push({ kind: "forecast_outage_daytime", downOnDay: outageDays[1], downAt: "10:30", upOnDay: outageDays[1], upAt: "15:30" });
  const tripWeather = [];
  for (let d = trip.firstDay - 1; d <= trip.lastDay + 1; d++) {
    const s = scriptOf(d);
    tripWeather.push({ day: d, script: { morningC: s.morningC + trip.place.offsetC, peakC: s.peakC + trip.place.offsetC, eveningC: s.eveningC + trip.place.offsetC, ...(wx.chance(0.3) ? { rainFromHour: 14, rainMmPerHour: 1.5 } : {}) } });
  }

  /* ------------------------------ calendar ------------------------------ */
  const cal = rng("calendar");
  const calendar = [];
  const calendarDays = freeDays.filter((d) => d >= 2);
  let eventNumber = 0;
  const addEvent = (kind, title, onDay, startMinutes, lengthMinutes, extra = {}) => {
    const appearsDay = Math.max(0, onDay - cal.int(1, 5));
    const event = { id: `sim${String(seed).replace(/[^a-z0-9]/gi, "")}e${++eventNumber}`, kind, title, appearsDay, appearsAt: hhmm(cal.int(9 * 60, 17 * 60)), onDay, start: hhmm(startMinutes), end: hhmm(startMinutes + lengthMinutes), moved: null, cancelled: null, ...extra };
    calendar.push(event);
    return event;
  };
  for (const d of cal.sample(calendarDays, 3)) addEvent("formal", cal.pick(FORMAL_TITLES), d, cal.pick([12 * 60 + 30, 18 * 60 + 30, 19 * 60]), 150);
  for (const d of cal.sample(calendarDays, 4)) addEvent("workout", cal.pick(WORKOUT_TITLES), d, cal.pick([7 * 60 + 30, 12 * 60, 17 * 60 + 30]), 60);
  for (const d of cal.sample(calendarDays, 3)) addEvent("ordinary", cal.pick(ORDINARY_TITLES), d, cal.pick([10 * 60, 13 * 60, 15 * 60]), 60);
  addEvent("travel", `Train to ${trip.place.label.split(" (")[0]} (SIMULATED)`, trip.firstDay, 8 * 60 + 30, 180);
  addEvent("travel", `Train home from ${trip.place.label.split(" (")[0]} (SIMULATED)`, trip.lastDay, 16 * 60, 180);
  // Some entries move to another day, some are cancelled, each on a day after they appeared and before they happen.
  const movable = calendar.filter((e) => e.kind !== "travel" && e.onDay - e.appearsDay >= 2);
  for (const event of cal.sample(movable, Math.min(3, movable.length))) {
    const onDay = cal.int(event.appearsDay + 1, event.onDay - 1);
    const candidates = calendarDays.filter((d) => d > onDay && d !== event.onDay);
    if (candidates.length > 0) event.moved = { onDay, at: hhmm(cal.int(9 * 60, 17 * 60)), toDay: cal.pick(candidates) };
  }
  const cancellable = calendar.filter((e) => e.kind !== "travel" && !e.moved && e.onDay - e.appearsDay >= 1);
  for (const event of cal.sample(cancellable, Math.min(2, cancellable.length))) event.cancelled = { onDay: cal.int(event.appearsDay + 1, event.onDay), at: hhmm(cal.int(7 * 60 + 20, 8 * 60 + 30)) };

  /* ------------------------------ availability and observations ------------------------------ */
  const av = rng("availability");
  const availabilityDays = av.sample(freeDays.filter((d) => d <= dayCount - 6), 8);
  const kinds = ["lost", "cleaner", "lent", "damaged", "cleaner", "lent", "lost", "damaged"];
  const availability = availabilityDays.map((d, i) => ({
    kind: kinds[i],
    onDay: d,
    at: hhmm(av.int(9 * 60, 18 * 60)),
    /** Which garment: resolved at run time among the eligible ones in a stable order. */
    role: av.pick(kinds[i] === "cleaner" ? ["outer", "bottom", "outer"] : kinds[i] === "lost" ? ["socks", "top", "neckwear"] : ["top", "bottom", "outer", "footwear"]),
    draw: av.next(),
    /** When it comes back (the cleaner returns it, the friend brings it back, the repair is done); a lost piece stays lost. */
    backOnDay: kinds[i] === "lost" ? null : Math.min(dayCount - 1, d + av.int(2, 5)),
    backAt: hhmm(av.int(9 * 60, 18 * 60)),
  }));
  const ob = rng("observations");
  const observationKinds = ["all_in_the_hamper", "counted_clean", "spill", "all_in_the_hamper", "counted_clean", "spill"];
  const observations = ob.sample(freeDays, 6).map((d, i) => ({ kind: observationKinds[i], onDay: d, at: hhmm(ob.int(8 * 60, 20 * 60)), role: ob.pick(["top", "bottom", "socks"]), draw: ob.next() }));

  /* ------------------------------ laundry ------------------------------ */
  const la = rng("laundry");
  const weekKinds = la.sample(["normal", "still_away", "lost_in_service", "missed_return", "no_reports", "normal"], weeks);
  const laundry = weekKinds.map((kind, week) => ({ week, kind, collectDay: week * 7 + 4, returnDay: week * 7 + 5, lateReturnDay: week * 7 + 8, draw: la.next(), sockWashDay: week * 7 + la.int(1, 3) }));

  /* ------------------------------ repair probes, tool exercise, isolation ------------------------------ */
  const pr = rng("probes");
  const probeDays = pr.sample(freeDays.filter((d) => freeDays.includes(d + 1) && d !== outageDays[0] - 1), 4);
  const repairProbes = probeDays.map((d, i) => ({ eveningOfDay: d, method: ["worn_today_late_report", "marked_dirty", "lost", "sent_to_cleaner"][i % 4], optionDraw: pr.next(), pieceDraw: pr.next() }));
  const askDays = pr.sample(freeDays, 2);
  const researchDays = pr.sample(freeDays, 2);
  const liftAttemptDays = pr.sample(freeDays, 2);
  const undoDays = pr.sample(freeDays, 2);
  const amendDays = pr.sample(freeDays, 2);

  /* ------------------------------ the days ------------------------------ */
  const daily = rng("daily");
  const days = [];
  for (let d = 0; d < dayCount; d++) {
    const onTrip = d >= trip.firstDay && d <= trip.lastDay;
    const paused = d >= pause.firstDay && d <= pause.lastDay;
    const ill = d >= illness.firstDay && d <= illness.lastDay;
    const circumstance = onTrip ? "trip" : paused ? "paused" : ill ? "ill" : workFromHome.has(d) ? "work_from_home" : "ordinary";
    const u = daily.next();
    const w = daily.next();
    days.push({
      index: d,
      date: date(d),
      weekday: isoWeekday(date(d)),
      circumstance,
      weather: scriptOf(d),
      /** The morning decision on the published board. */
      morning: u < 0.55 ? "choose" : u < 0.7 ? "choose_then_change" : u < 0.85 ? "reject_and_ask_again" : "no_choice",
      optionDraw: daily.next(),
      secondOptionDraw: daily.next(),
      requestedCount: daily.pick([1, 3, 3, 5, 8]),
      /** What was actually worn, relative to the choice. */
      wear: ill ? "no_report" : w < 0.6 ? "as_chosen" : w < 0.8 ? "one_piece_differs" : w < 0.92 ? "something_else" : "no_report",
      pieceDraw: daily.next(),
      replacementDraw: daily.next(),
      reportedLate: daily.chance(0.15),
      reportedTwice: daily.chance(0.25),
      alsoReportedInApp: daily.chance(0.12),
      secondSockPair: daily.chance(0.06),
      comfortNote: daily.chance(0.1) ? daily.pick(["too_warm", "too_cold", "scratchy", "pain", "positive"]) : null,
      chooseTomorrowTonight: daily.chance(0.3),
      inventoryViewDraw: daily.next(),
    });
  }

  const plan = {
    formatVersion: 1,
    seed: String(seed),
    weeks,
    dayCount,
    timezone: TIMEZONE,
    startDate: season.startDate,
    endDate: date(dayCount - 1),
    season: season.season,
    home: HOME_PLACE,
    trip,
    illness,
    pause,
    purchase,
    workFromHomeDays: [...workFromHome].sort((a, b) => a - b),
    weather: { baseline, changes: weatherChanges, outages, trip: tripWeather },
    calendar,
    availability,
    observations,
    laundry,
    repairProbes,
    toolExercise: { askDays, researchDays, liftAttemptDays, undoDays, amendDays, isolationDays: [0, Math.floor(dayCount / 2), dayCount - 1] },
    days,
  };
  return { ...plan, digest: planDigest(plan) };
}

/** A digest of the whole plan: equal digests mean equal timelines. */
export const planDigest = (plan) => {
  const { digest: _ignored, ...rest } = plan;
  return digest(rest);
};

/** How often each condition occurs in a plan (the condition-coverage table of a run starts from this). */
export function plannedConditions(plan) {
  const count = (list, test) => list.filter(test).length;
  return {
    weather: {
      scripted_days: plan.dayCount,
      rainy_days: count(plan.days, (d) => d.weather.rainFromHour !== undefined),
      seasonal_drift_c: plan.days.at(-1).weather.peakC - plan.days[0].weather.peakC,
      sudden_rain: count(plan.weather.changes, (c) => c.kind === "sudden_rain"),
      heat_days: count(plan.weather.changes, (c) => c.kind === "heat"),
      cold_snap_days: count(plan.weather.changes, (c) => c.kind === "cold_snap"),
      forecast_outages: plan.weather.outages.length,
    },
    calendar: {
      entries_appearing: plan.calendar.length,
      formal: count(plan.calendar, (e) => e.kind === "formal"),
      workouts: count(plan.calendar, (e) => e.kind === "workout"),
      travel: count(plan.calendar, (e) => e.kind === "travel"),
      moved: count(plan.calendar, (e) => e.moved),
      cancelled: count(plan.calendar, (e) => e.cancelled),
    },
    availability: {
      lost: count(plan.availability, (a) => a.kind === "lost"),
      at_the_cleaner: count(plan.availability, (a) => a.kind === "cleaner"),
      lent: count(plan.availability, (a) => a.kind === "lent"),
      damaged: count(plan.availability, (a) => a.kind === "damaged"),
      owner_observations_contradicting_estimates: plan.observations.length,
      laundry_weeks: plan.laundry.length,
      laundry_exception_weeks: count(plan.laundry, (l) => l.kind !== "normal"),
      repair_probes: plan.repairProbes.length,
    },
    circumstance: {
      trip_days: plan.trip.lastDay - plan.trip.firstDay + 1,
      ill_days: plan.illness.length,
      work_from_home_days: plan.workFromHomeDays.length,
      paused_days: plan.pause.length,
      return_or_exchange: plan.purchase.kind,
      days_without_a_wear_report: count(plan.days, (d) => d.wear === "no_report"),
    },
  };
}
