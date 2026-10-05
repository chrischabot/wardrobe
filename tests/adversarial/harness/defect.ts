/**
 * Product defects the adversarial suite found and that are still OPEN, kept as tests.
 *
 * A defect test asserts what the specification requires and is never weakened. Each has an identifier
 * listed in its area's DEFECTS.md (for example domain/DEFECTS.md) with a reproduction and the
 * workstream that owns the fix. A defect that was FIXED is an ordinary `it(...)` regression test.
 *
 *  - Default run (`npm test`): a known open defect is an EXPECTED failure, so the run stays a
 *    regression gate. When the product is fixed the test turns red with "expected to fail": make it an
 *    ordinary test and move its entry to the "Fixed" table.
 *  - Strict run (`npm run test:strict`, `ADVERSARIAL_STRICT=1`): every open defect fails as an ordinary
 *    test. This is the acceptance view: its failures are exactly the open defects.
 *
 * `intermittent` marks a defect that does not show on every run (a race, for example). It is skipped in
 * the default run, where an expected failure must be certain, and runs in the strict run.
 */
import { it } from "vitest";

declare const __ADVERSARIAL_STRICT__: boolean;
export const STRICT: boolean = typeof __ADVERSARIAL_STRICT__ !== "undefined" && __ADVERSARIAL_STRICT__;

type Body = () => void | Promise<void>;

export function defect(id: string, title: string, body: Body, options: { intermittent?: boolean } = {}): void {
  if (STRICT) it(`DEFECT ${id}: ${title}`, body);
  else if (options.intermittent) it.skip(`KNOWN DEFECT ${id} (intermittent; runs in the strict run): ${title}`, body);
  else it.fails(`KNOWN DEFECT ${id} (expected to fail until the product is fixed): ${title}`, body);
}
