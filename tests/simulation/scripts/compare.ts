/**
 * Compares a local and a dev report of the same seed, day by day.
 *
 *   npx tsx tests/simulation/scripts/compare.ts [--seed 20261005] [--dir tests/simulation/reports]
 *
 * The two runs use different simulation owners (different random garment ids), so boards are not
 * expected to be identical; the comparison is of outcomes: boards published, rule violations, command
 * outcomes, assistant turns and their checks. Writes <dir>/comparison-seed<seed>.md.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DayRecord, RunReport } from '../src/run.js';

const args = process.argv.slice(2);
const at = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const seed = at('--seed') ?? '20261005';
const dir = at('--dir') ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'reports');
const load = (t: string) => JSON.parse(readFileSync(join(dir, `${t}-seed${seed}.json`), 'utf8')) as RunReport;
const local = load('local');
const dev = load('dev');

const cell = (d: DayRecord | undefined) => {
  if (!d) return 'not run';
  const v = d.violations.length + d.previews.reduce((s, p) => s + p.violations.length, 0);
  const av = d.asks.reduce((s, a) => s + (a.violations?.length ?? 0), 0);
  return `${d.board?.status ?? 'none'}/${d.board?.offerable ?? 0}; pick ${d.selection?.outcome ?? '-'}; wear ${d.wear?.outcome ?? '-'}; ${d.actions.filter((a) => !a.ok).length} unexpected; ${v} board viol.; ${d.asks.length} asks (${av} viol.)`;
};
const esc = (s: string) => s.replace(/\|/g, '\\|');
const rows = local.scenario.days.map((sd) => {
  const l = local.days.find((d) => d.index === sd.index);
  const r = dev.days.find((d) => d.index === sd.index);
  const same = Boolean(l && r) && l!.board?.status === r!.board?.status && l!.violations.length === r!.violations.length && l!.actions.filter((a) => !a.ok).length === r!.actions.filter((a) => !a.ok).length;
  return `| ${sd.index} | ${sd.date} | ${sd.weatherKind} | ${esc(sd.circumstances.join(', ') || '-')} | ${esc(cell(l))} | ${esc(cell(r))} | ${same ? 'same' : 'DIFFERS'} |`;
});
const keys = [...new Set([...Object.keys(local.totals), ...Object.keys(dev.totals)])];
const out = [
  `# Local vs dev, seed ${seed}`,
  `Local run ${local.runTag} (${local.startedAt}); dev run ${dev.runTag} (${dev.startedAt}, Worker version ${dev.deployedVersion ?? 'not recorded'}). Different simulation owners, the same scenario plan.`,
  '## Totals',
  '| measure | local | dev |',
  '| --- | --- | --- |',
  ...keys.map((k) => `| ${k} | ${local.totals[k] ?? '-'} | ${dev.totals[k] ?? '-'} |`),
  '## Days',
  '| # | date | weather | circumstances | local | dev | outcome |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...rows,
].join('\n');
writeFileSync(join(dir, `comparison-seed${seed}.md`), out + '\n');
console.log(out);
