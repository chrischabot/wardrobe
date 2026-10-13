/**
 * SIMULATION ONLY: a settable clock for the simulation Worker and its seed script.
 *
 * A multi-week timeline cannot be driven against a Worker that reads the wall clock, so the simulation
 * Worker (worker/entry.ts) replaces the global `Date` with one whose "now" is the instant the simulator
 * last set, moving forward at the normal rate from there. Every reader in the product uses `Date`
 * (there is no SQL-side clock in the schema), so the command service, the daily schedule, the OAuth
 * provider and the conversation actor all see the same simulated time.
 *
 * This module must be the first import of whatever uses it. It is never part of the product Worker: only
 * the simulation Worker contains it (locally, or deployed under its own simulation name to development
 * resources, never as the product). The simulated time must not be earlier than the real time: local KV
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
  // A function, not a class: `Date()` called without `new` must still return the current (simulated) time
  // as a string, as the native one does. Construction goes through Reflect.construct so `instanceof Date`,
  // subclasses and every argument form behave natively.
  const SimulatedDate = function (this: unknown, ...args: unknown[]): unknown {
    if (!new.target) return new RealDate(RealDate.now() + state.offsetMs).toString();
    return Reflect.construct(RealDate, args.length === 0 ? [RealDate.now() + state.offsetMs] : args, new.target);
  } as unknown as DateConstructor & { prototype: Date };
  Object.defineProperty(SimulatedDate, "prototype", { value: RealDate.prototype, writable: false });
  Object.defineProperties(SimulatedDate, {
    now: { value: () => RealDate.now() + state.offsetMs, writable: true, configurable: true },
    parse: { value: RealDate.parse, writable: true, configurable: true },
    UTC: { value: RealDate.UTC, writable: true, configurable: true },
  });
  scope.Date = SimulatedDate;
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
