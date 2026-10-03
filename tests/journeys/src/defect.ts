/**
 * Product defects the journeys found, kept as tests.
 *
 * A defect test asserts what the specification or the owner's profile requires. It is never weakened:
 * the product currently fails it. Each has an identifier listed in DEFECTS.md with its reproduction
 * and the workstream that owns the fix.
 *
 *  - Default run (`npm test`): a known defect is an EXPECTED failure. The run stays usable as a
 *    regression gate for everything else, and the day the product is fixed the test turns red with
 *    "expected to fail", which is the signal to delete its entry from DEFECTS.md and make it an
 *    ordinary test.
 *  - Strict run (`npm run test:strict`, `JOURNEYS_STRICT=1`): every defect test is an ordinary test and
 *    fails. This is the acceptance view: its failures are exactly the open defects.
 *
 * `intermittent` marks a defect that does not show on every run (the composer's tie-breaking is seeded
 * by random identifiers). It is skipped in the default run, where an expected failure must be certain,
 * and runs in the strict run.
 */
import { it } from "vitest";

declare const __JOURNEYS_STRICT__: boolean;
export const STRICT: boolean = typeof __JOURNEYS_STRICT__ !== "undefined" && __JOURNEYS_STRICT__;

type Body = () => void | Promise<void>;

export function defect(id: string, title: string, body: Body, options: { intermittent?: boolean } = {}): void {
  if (STRICT) it(`DEFECT ${id}: ${title}`, body);
  else if (options.intermittent) it.skip(`KNOWN DEFECT ${id} (intermittent; runs in the strict run): ${title}`, body);
  else it.fails(`KNOWN DEFECT ${id} (expected to fail until the product is fixed): ${title}`, body);
}
