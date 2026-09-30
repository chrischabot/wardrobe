/**
 * Live import-race check on the dev deployment: `npm run dev:probe -- import-race [calls]` (default 5).
 * Each call asks the dev-only probe POST /__dev/probe/import-race (deploy/src/import-race-probe.ts) for
 * one round: two staged packages confirmed at the same moment, and two direct imports, each into a
 * fresh synthetic empty owner on the real D1. A round passes when exactly one import lands. Writes
 * deploy/evidence/import-race and fails (non-zero exit) if any round or call fails.
 */
import { api } from './probe.js';
import { writeEvidence } from './lib.js';

export async function importRace(args: string[]): Promise<void> {
  // One round per request: each round stages and imports into remote D1, which takes about two minutes.
  const raw = args[0] ?? '5';
  if (!/^\d{1,2}$/.test(raw) || Number(raw) < 1 || Number(raw) > 50) throw new Error(`import-race: calls must be a whole number from 1 to 50 (got ${JSON.stringify(raw)})`);
  const calls = Number(raw);
  const all: Record<string, unknown>[] = [];
  let failures = 0;
  for (let i = 0; i < calls; i++) {
    const r = await api('/__dev/probe/import-race', { body: { rounds: 1 } });
    if (r.status !== 200) {
      failures++;
      console.log(`call ${i}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
      continue;
    }
    for (const x of r.body.results as Record<string, unknown>[]) {
      const { targetUserId: _t, ...rest } = x;
      void _t;
      all.push({ ...rest, call: i, ms: r.ms });
      console.log(`call ${i} ${x.path}: outcomes=${JSON.stringify(x.outcomes)} garments=${x.garments}${x.importedAudits !== undefined ? ` importedAudits=${x.importedAudits}` : ''} pass=${x.pass} (${r.ms} ms)`);
    }
  }
  const passed = failures === 0 && all.length === calls * 2 && all.every((x) => x.pass === true);
  console.log(JSON.stringify({ calls, results: all.length, failedCalls: failures, passed }));
  console.log('evidence:', writeEvidence('import-race', { probe: 'import-race', checkedAt: new Date().toISOString(), calls, failedCalls: failures, passed, results: all }));
  if (!passed) throw new Error('import-race: at least one round did not import exactly once');
}
