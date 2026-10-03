/**
 * A shifted clock for whole-suite runs at a chosen time of day (test support only).
 *
 * Several owners' days end at a different instant from the UTC day (the real owner's is Europe/London),
 * so a suite can pass all day and fail for one hour around midnight. To check that deliberately, run
 *
 *   GARDEROBE_TEST_CLOCK=23:30 npx vitest run
 *
 * and every `Date` in the Workers runtime under test (the Worker, the conversation actor, the tests and
 * their helpers: one isolate) reads as the NEXT occurrence of that UTC time, moving forward at the
 * normal rate. The shift is always forwards and less than a day, so anything that was stored with a
 * real-clock expiry outside the isolate (local KV) only lives longer, never shorter. Without the
 * variable nothing is installed and the clock is the real one.
 */
import { env } from "cloudflare:workers";

export const TEST_CLOCK_BINDING = "TEST_CLOCK_OFFSET_MS";

const INSTALLED = Symbol.for("garderobe.test.clock");

/** Replace the global `Date` with one that runs `offsetMs` ahead. Idempotent; a zero offset installs nothing. */
export function installShiftedClock(offsetMs: number): void {
  const scope = globalThis as unknown as Record<symbol, unknown> & { Date: DateConstructor };
  if (!offsetMs || scope[INSTALLED]) return;
  const RealDate = scope.Date;
  class ShiftedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + offsetMs);
      else super(...(args as [number]));
    }
    static override now(): number {
      return RealDate.now() + offsetMs;
    }
  }
  scope.Date = ShiftedDate as unknown as DateConstructor;
  scope[INSTALLED] = offsetMs;
}

/** The shift in force in this isolate (0 when the clock is the real one). */
export const testClockOffsetMs = (): number => Number((globalThis as unknown as Record<symbol, unknown>)[INSTALLED] ?? 0);

installShiftedClock(Number((env as unknown as Record<string, unknown>)[TEST_CLOCK_BINDING] ?? 0));
