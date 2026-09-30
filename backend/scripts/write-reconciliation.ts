/**
 * Regenerates garderobe/data/owner-inventory-reconciliation.md from the byte-exact owner files.
 * Run from garderobe/: npm run reconcile --workspace @garderobe/backend
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInventoryReconciliation, buildOwnerDataset, parseOwnerAdditions, renderReconciliationMarkdown } from '../src/import/index.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const owner = await buildOwnerDataset(
  {
    profileText: readFileSync(join(dataDir, 'owner-profile.md'), 'utf8'),
    rulesCatalogue: JSON.parse(readFileSync(join(dataDir, 'owner-profile-rules.json'), 'utf8')),
    csvText: readFileSync(join(dataDir, 'wardrobe-inventory-2026-05.csv'), 'utf8'),
  },
  { importedAt: new Date().toISOString() },
);
const report = buildInventoryReconciliation(
  owner,
  parseOwnerAdditions(JSON.parse(readFileSync(join(dataDir, 'owner-asserted-additions-2026-09-29.json'), 'utf8')), readFileSync(join(dataDir, 'owner-profile.md'), 'utf8')),
);
writeFileSync(join(dataDir, 'owner-inventory-reconciliation.md'), renderReconciliationMarkdown(report));
writeFileSync(join(dataDir, 'owner-inventory-reconciliation.json'), JSON.stringify(report, null, 2) + '\n');
console.log(
  `Rows: ${report.source.dataRows} (imported ${report.accounting.imported}, merged ${report.accounting.merged}, held ${report.accounting.held}); CSV garments ${report.accounting.garments}; after owner-asserted additions ${report.ownerAsserted?.totals.garments} garments / ${report.ownerAsserted?.totals.units} units; issues open ${report.issues.filter((i) => i.status === 'open').length}, resolved ${report.issues.filter((i) => i.status === 'resolved').length}; profile hash ${report.profile.matchesSpec ? 'matches' : 'MISMATCH'}`,
);
