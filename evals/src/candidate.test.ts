/**
 * The candidate phase. One test per case of the split this process was given; each case runs in a world of
 * its own inside the real Worker. A case never fails this file: what happened (including an adapter error
 * or a model that was unavailable) is recorded for the check and judge phases to report.
 */
import { describe, it } from "vitest";
import { drivers } from "./drivers/index.ts";
import { buildWorld, enableGatewayRoutes, HARNESS, ownerMessage, receiptsSince, record, say, snapshot, UnsupportedScenario, type CandidateCase, type CandidateInput, type DriverContext, type TurnOutcome } from "./kit.ts";

const input = (await (await fetch(`${HARNESS}/cases`)).json()) as CandidateInput;

function describeError(error: unknown): { message: string; stack: string | null } {
  const e = error as Error;
  return { message: String(e?.message ?? error).slice(0, 4000), stack: typeof e?.stack === "string" ? e.stack.split("\n").slice(0, 8).join("\n") : null };
}

/** The parts of a settled run the owner can see: the reply, receipts, requests to confirm, a question asked. */
function visible(turn: TurnOutcome | null) {
  if (!turn) return null;
  const run = turn.run;
  return {
    state: turn.state,
    reply: turn.replyText,
    options: run.result?.options ?? [],
    board: run.result?.board ?? null,
    receipts: (run.receipts ?? []).map((r: any) => ({ type: r.type, outcome: r.outcome, summary: r.summary, undoAvailable: r.undoAvailable ?? null })),
    requests_to_confirm: (run.proposals ?? []).map((p: any) => ({ type: p.type ?? null, summary: p.summary ?? null, state: p.state ?? null })),
    question_asked: run.pendingInput ?? null,
    error: run.error ?? null,
  };
}

async function runCase(c: CandidateCase): Promise<void> {
  const startedAt = new Date().toISOString();
  const driver = drivers[c.id] ?? null;
  const base = { case_id: c.id, world: c.world, driver_mode: input.driver, has_behaviour_driver: Boolean(driver), started_at: startedAt };
  let stage = "world";
  try {
    const world = await buildWorld(c, input.fixture);
    const ctx: DriverContext = { c, world, mode: input.driver, turn: null, memo: {}, actStartedAt: startedAt };
    stage = "seed";
    if (driver) await driver.seed(ctx);
    const before = await snapshot(world);
    ctx.actStartedAt = new Date().toISOString();
    let message: string | null = null;
    let notRun: string | null = null;
    stage = "act";
    if (input.driver === "conversation") {
      await enableGatewayRoutes(world);
      message = driver?.message ? driver.message(ctx) : ownerMessage(c, world);
      ctx.turn = await say(world, message);
    } else if (driver?.scripted) {
      await driver.scripted(ctx);
    } else {
      notRun = driver ? "this case has no scripted form: what it tests is the assistant's own answer or action, which needs the model route" : "a taste case: the candidate's answer needs the model route";
    }
    if (driver?.act && !notRun) await driver.act(ctx);
    stage = "observe";
    const after = await snapshot(world);
    const receipts = await receiptsSince(world, ctx.actStartedAt).catch((error) => [{ unreadable: describeError(error).message }]);
    const observation = driver && !notRun ? await driver.observe(ctx) : null;
    await record(c.id, "candidate-run.json", {
      ...base,
      status: notRun ? "not_run" : "ran",
      not_run_reason: notRun,
      finished_at: new Date().toISOString(),
      today: world.today,
      owner_message: message,
      visible: visible(ctx.turn),
      turn_elapsed_ms: ctx.turn?.elapsedMs ?? null,
      application_run_id: ctx.turn?.runId ?? null,
      run_document: ctx.turn?.run ?? null,
      receipts_after_act: receipts,
      observation,
      wardrobe_before: before,
      wardrobe_after: after,
      fixture_ids: Object.fromEntries(world.fixture),
    });
  } catch (error) {
    if (error instanceof UnsupportedScenario) {
      await record(c.id, "candidate-run.json", { ...base, status: "not_run", not_run_reason: `the application cannot be put into this scenario's starting state (stage "${stage}"): ${error.message}`, finished_at: new Date().toISOString() });
      return;
    }
    await record(c.id, "candidate-run.json", { ...base, status: "adapter_error", stage, finished_at: new Date().toISOString(), error: describeError(error) });
  }
}

describe(`candidate phase: ${input.split} (${input.driver})`, () => {
  for (const c of input.cases) it(c.id, () => runCase(c));
});
