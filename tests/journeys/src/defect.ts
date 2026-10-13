/**
 * Product defects the journeys found, kept as tests.
 *
 * A defect test asserts what the specification or the owner's profile requires. It is never weakened:
 * the product currently fails it. Each has an identifier listed in DEFECTS.md with its reproduction
 * and the workstream that owns the fix.
 *
 * Every defect states its SIGNATURE: a pattern the failure message must match. It names the one
 * assertion that shows the defect, so a defect test is never kept green by an unrelated throw (a
 * timeout, a TypeError from state an earlier step never set, a broken fixture or a renamed garment).
 *
 *  - Default run (`npm test`): the body runs inside an ordinary test, which PASSES only when the body
 *    fails with a message matching the signature. It FAILS when the body passes ("the product appears
 *    fixed": make it an ordinary test and move its entry in DEFECTS.md to the "Fixed" table) and when
 *    the body fails in any other way (the failure is reported as it happened). The run stays usable as
 *    a regression gate for everything else.
 *  - Strict run (`npm run test:strict`, `JOURNEYS_STRICT=1`): every defect test is an ordinary test and
 *    fails. This is the acceptance view: its failures are exactly the open defects.
 *
 * Preconditions that are not the defect belong outside the body (in an earlier ordinary step or a
 * `beforeAll`), so that a broken precondition fails as itself in both runs.
 *
 * `intermittent` marks a defect that does not show on every run (the composer's tie-breaking is seeded
 * by random identifiers). It is skipped in the default run, where an expected failure must be certain,
 * and runs in the strict run.
 */
import { it } from "vitest";

declare const __JOURNEYS_STRICT__: boolean;
export const STRICT: boolean = typeof __JOURNEYS_STRICT__ !== "undefined" && __JOURNEYS_STRICT__;

type Body = () => void | Promise<void>;

export interface DefectOptions {
  /** The failure message of the defect's own assertion must match this. */
  signature: RegExp;
  intermittent?: boolean;
}

const messageOf = (failure: unknown): string => (failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure));

/**
 * Run a defect body and decide the default-run outcome: resolves only when the body failed with the
 * recorded signature. Exported for the suite's own self-test.
 */
export async function expectDefectSignature(id: string, signature: RegExp, body: Body): Promise<void> {
  let failure: unknown = undefined;
  let failed = false;
  try {
    await body();
  } catch (error) {
    failed = true;
    failure = error;
  }
  if (!failed) throw new Error(`KNOWN DEFECT ${id} passed: the product appears fixed. Re-run the journey on the branch that holds the fix, make it an ordinary it(...) and move its DEFECTS.md row to "Fixed".`);
  const message = messageOf(failure);
  if (!signature.test(message)) {
    const unexpected = new Error(`KNOWN DEFECT ${id} failed, but not with its recorded signature ${signature}. The actual failure was:\n${message}`);
    (unexpected as Error & { cause?: unknown }).cause = failure;
    throw unexpected;
  }
}

export function defect(id: string, title: string, options: DefectOptions, body: Body): void {
  if (STRICT) it(`DEFECT ${id}: ${title}`, body);
  else if (options.intermittent) it.skip(`KNOWN DEFECT ${id} (intermittent; runs in the strict run): ${title}`, body);
  else it(`KNOWN DEFECT ${id} (fails as recorded until the product is fixed): ${title}`, () => expectDefectSignature(id, options.signature, body));
}
