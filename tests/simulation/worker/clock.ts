/**
 * SIMULATION ONLY: a settable clock for the simulation Worker and its seed script.
 *
 * A multi-week timeline cannot be driven against a Worker that reads the wall clock, so the simulation
 * Worker (worker/entry.ts) replaces the global `Date` with one whose "now" is the instant the simulator
 * last set, moving forward at the normal rate from there. Every reader in the product uses `Date`
 * (there is no SQL-side clock in the schema), so the command service, the daily schedule, the OAuth
 * provider and the conversation actor all see the same simulated time.
 *
 * This module must be the first import of whatever uses it. It is never part of the product Worker and
 * no deployment contains it. The simulated time must not be earlier than the real time: local KV
 * refuses an absolute expiry that lies in the real past.
 */
const INSTALLED = Symbol.for("garderobe.simulation.clock");

interface ClockState {
  offsetMs: number;
  realNow(): number;
}

function install(): ClockState {
  const scope = globalThis as unknown as Record<symbol, unknown> & { Date: DateConstructor };
  const existing = scope[INSTALLED] as ClockState | undefined;
  if (existing) return existing;
  const RealDate = scope.Date;
  const state: ClockState = { offsetMs: 0, realNow: () => RealDate.now() };
  class SimulatedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + state.offsetMs);
      else super(...(args as [number]));
    }
    static override now(): number {
      return RealDate.now() + state.offsetMs;
    }
  }
  scope.Date = SimulatedDate as unknown as DateConstructor;
  scope[INSTALLED] = state;
  return state;
}

const state = install();

/** Make "now" the given instant (it then moves forward at the normal rate). */
export function setSimulatedNow(nowMs: number): void {
  state.offsetMs = nowMs - state.realNow();
}

/** How far the simulated clock is ahead of the real one. */
export const simulatedOffsetMs = (): number => state.offsetMs;
export const realNowMs = (): number => state.realNow();

// The seed script runs in Node and takes its starting instant from the environment.
const fromEnv = typeof process !== "undefined" ? Number(process.env?.SIM_NOW_MS ?? 0) : 0;
if (fromEnv > 0) setSimulatedNow(fromEnv);
