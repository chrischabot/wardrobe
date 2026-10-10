/**
 * Runs one seed against one target: setup, then every step of the plan in order, with every invariant
 * checked after every step. Returns the result that is written to `results/`.
 */
import { addDays, toInstant, zonedToUtcMs } from "./dates.mjs";
import * as circumstances from "./handlers-circumstances.mjs";
import * as conditions from "./handlers-conditions.mjs";
import * as daily from "./handlers-daily.mjs";
import { standingChecks } from "./invariants.mjs";
import { buildSteps, stepCounts } from "./schedule.mjs";
import { Sim } from "./sim.mjs";
import { Target } from "./target.mjs";
import { buildPlan, plannedConditions } from "./timeline.mjs";

export const HANDLERS = {
  sweep: daily.sweep,
  morning: daily.morning,
  evening_report: daily.eveningReport,
  late_wear_report: daily.lateWearReport,
  plan_tomorrow: daily.planTomorrow,
  night: daily.night,
  day_brief: daily.dayBrief,
  weather_change: conditions.weatherChange,
  weather_outage: conditions.weatherOutage,
  calendar_change: conditions.calendarChange,
  becomes_unavailable: conditions.becomesUnavailable,
  comes_back: conditions.comesBack,
  owner_observation: conditions.ownerObservation,
  laundry_collect: conditions.laundryCollect,
  laundry_return: conditions.laundryReturn,
  laundry_late_return: conditions.laundryLateReturn,
  socks_washed: conditions.socksWashed,
  after_baseline: conditions.afterBaseline,
  trip_create: circumstances.tripCreate,
  trip_proposal: circumstances.tripProposal,
  trip_pack: circumstances.tripPack,
  trip_unpack: circumstances.tripUnpack,
  pause: circumstances.pause,
  resume: circumstances.resume,
  purchase_order: circumstances.purchaseOrder,
  purchase_arrival: circumstances.purchaseArrival,
  return_open: circumstances.returnOpen,
  return_label: circumstances.returnLabel,
  return_post: circumstances.returnPost,
  return_settle: circumstances.returnSettle,
  ask: circumstances.ask,
  research: circumstances.research,
  lift_attempt: circumstances.liftAttempt,
  undo_a_report: circumstances.undoReport,
  amend_a_report: circumstances.amendReport,
};

/** The simulated instant a local target's ledger begins at: the evening before the first day. */
export const startInstantOf = (plan) => zonedToUtcMs(addDays(plan.startDate, -1), "19:00", plan.timezone);

function toolCoverage(target, sim) {
  const byTool = {};
  const inventoryViews = {};
  const runActions = {};
  const commandTypes = {};
  for (const call of target.calls) {
    const entry = (byTool[call.tool] ??= { calls: 0, answered: 0, refused: 0, refusalCodes: {} });
    entry.calls++;
    if (call.ok) entry.answered++;
    else {
      entry.refused++;
      entry.refusalCodes[call.code] = (entry.refusalCodes[call.code] ?? 0) + 1;
    }
    if (call.tool === "garderobe_inventory") inventoryViews[call.args.view ?? "items"] = (inventoryViews[call.args.view ?? "items"] ?? 0) + 1;
    if (call.tool === "garderobe_run") runActions[call.args.action ?? "status"] = (runActions[call.args.action ?? "status"] ?? 0) + 1;
  }
  for (const command of sim.commandLog) {
    const entry = (commandTypes[command.type] ??= {});
    entry[command.route] = (entry[command.route] ?? 0) + 1;
  }
  const sessions = Object.values(sim.sessions).filter(Boolean);
  return {
    byTool,
    inventoryViews,
    runActions,
    commandTypes,
    resourcesRead: Object.fromEntries(target.resourceReads),
    oauth: { connections: sessions.length, authorizations: sessions.reduce((n, s) => n + s.authorizations, 0), tokenRefreshes: sessions.reduce((n, s) => n + s.tokenRefreshes, 0) },
    ownerRequestsInTheApp: target.ownerRequests,
    testDoorRequests: target.doorRequests,
  };
}

export async function runSimulation({ targetDescription, seed, weeks = 4, startDate, log = () => undefined, untilDay = null }) {
  const plan = buildPlan({ seed, weeks, startDate });
  const steps = buildSteps(plan);
  const target = new Target(targetDescription);
  if (!target.hasClock) {
    throw new Error(
      `the target '${targetDescription.label}' has no clock door. A timeline of ${weeks} weeks can only elapse on a target whose clock the simulator sets (the local simulation Worker). ` +
        "Running the same seeds in real time against a deployment without that door is a separate mode that is not built yet.",
    );
  }
  const sim = new Sim({ target, plan, log });
  const startedAt = Date.now();
  let stepsRun = 0;
  let fatal = null;
  const setTime = (day, at) => target.setClock(zonedToUtcMs(addDays(plan.startDate, day), at, plan.timezone));
  try {
    await setTime(-1, "19:30");
    log(`seed ${plan.seed}: ${plan.startDate} to ${plan.endDate} (${plan.season}), ${steps.length} steps, plan ${plan.digest}`);
    await daily.setup(sim);
    await standingChecks(sim);
    for (const step of steps) {
      if (untilDay !== null && step.day > untilDay) break;
      sim.step = step;
      sim.stepIndex = step.index + 1;
      await setTime(step.day, step.at);
      // A pause with a resume date ends by itself on that date.
      if (sim.pause.active && sim.pause.resumeOn && sim.today() >= sim.pause.resumeOn) sim.pause.active = false;
      try {
        await HANDLERS[step.kind](sim, step);
        sim.check("step.ran_to_its_end", true);
      } catch (error) {
        if (/this run is void/.test(String(error?.message))) throw error;
        sim.stepErrors.push({ step: sim.stepIndex, kind: step.kind, day: step.day, at: step.at, message: String(error?.message ?? error).slice(0, 600) });
        sim.check("step.ran_to_its_end", false, `${step.kind}: ${String(error?.message ?? error).slice(0, 400)}`);
      }
      try {
        await standingChecks(sim);
        sim.check("invariants.state_could_be_read_after_the_step", true);
      } catch (error) {
        if (/this run is void/.test(String(error?.message))) throw error;
        sim.check("invariants.state_could_be_read_after_the_step", false, String(error?.message ?? error).slice(0, 400));
      }
      stepsRun++;
      if (step.kind === "night") log(`  seed ${plan.seed} day ${step.day + 1}/${plan.dayCount} (${plan.days[step.day].date}, ${plan.days[step.day].circumstance}): ${[...sim.checks.values()].reduce((n, c) => n + c.failed, 0)} failed checks so far`);
    }
  } catch (error) {
    fatal = String(error?.stack ?? error).slice(0, 2000);
    log(`seed ${plan.seed}: the run stopped: ${String(error?.message ?? error)}`);
  } finally {
    for (const session of Object.values(sim.sessions)) if (session) await session.close();
  }

  const byCheck = Object.fromEntries([...sim.checks].sort(([a], [b]) => a.localeCompare(b)).map(([id, c]) => [id, c]));
  const totals = [...sim.checks.values()].reduce((t, c) => ({ passed: t.passed + c.passed, failed: t.failed + c.failed, notApplicable: t.notApplicable + c.notApplicable }), { passed: 0, failed: 0, notApplicable: 0 });
  const completed = fatal === null && (untilDay !== null || stepsRun === steps.length);
  return {
    formatVersion: 1,
    seed: plan.seed,
    completed,
    fatal,
    target: { label: targetDescription.label, kind: targetDescription.kind, doors: { clock: Boolean(target.doors.clock), weather: Boolean(target.doors.weather), calendar: Boolean(target.doors.calendar), scheduled: Boolean(target.doors.scheduled) } },
    timeline: { planDigest: plan.digest, startDate: plan.startDate, endDate: plan.endDate, weeks: plan.weeks, days: plan.dayCount, season: plan.season, trip: `${plan.trip.place.label}, days ${plan.trip.firstDay + 1} to ${plan.trip.lastDay + 1}`, illness: `days ${plan.illness.firstDay + 1} to ${plan.illness.lastDay + 1}`, pause: `days ${plan.pause.firstDay + 1} to ${plan.pause.lastDay + 1}`, purchase: plan.purchase.kind, laundryWeeks: plan.laundry.map((l) => l.kind) },
    steps: { planned: steps.length, run: stepsRun, byKind: stepCounts(steps), errors: sim.stepErrors },
    invariantChecks: { ...totals, byCheck },
    failures: sim.failures,
    notApplicable: sim.notes,
    toolCoverage: toolCoverage(target, sim),
    conditions: { planned: plannedConditions(plan), observed: Object.fromEntries([...sim.conditions].sort(([a], [b]) => a.localeCompare(b))) },
    commands: { total: sim.commandLog.length, refused: sim.commandLog.filter((c) => c.route === "refused").map((c) => ({ step: c.step, type: c.type, label: c.label, code: c.code, reason: c.reason, message: c.summary })) },
    outcomeDigest: sim.outcomeDigest(),
    simulated: { from: toInstant(zonedToUtcMs(addDays(plan.startDate, -1), "19:30", plan.timezone)), to: toInstant(target.now()) },
    realSeconds: Math.round((Date.now() - startedAt) / 1000),
    commandLog: sim.commandLog,
  };
}
