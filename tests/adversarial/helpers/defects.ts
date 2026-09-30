import { it } from 'vitest';
import { env } from 'cloudflare:workers';

/**
 * Known defects stay in the suite as expected failures (vitest `it.fails`), each linked to its entry
 * in DEFECTS.md by id. A defect test passes while the product still fails the assertion and turns red
 * once the product is fixed (then change `knownDefect` to `it`).
 *
 * Run with ADV_SHOW_DEFECTS=1 to execute them as ordinary tests and see each failure's reason.
 */
export function knownDefect(id: string, title: string, fn: () => Promise<void>, timeout?: number): void {
  const show = (env as unknown as { ADV_SHOW_DEFECTS?: string }).ADV_SHOW_DEFECTS === '1';
  const name = `[${id}] ${title}`;
  if (show) it(name, fn, timeout);
  else it.fails(name, fn, timeout);
}
