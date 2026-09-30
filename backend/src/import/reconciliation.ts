import type { OwnerDataset } from './owner.js';
import { INVENTORY_FILE } from './owner-inventory.js';
import { additionRestricted, type OwnerAdditionsFile } from './owner-additions.js';

/**
 * Reconciliation report for the owner inventory import (spec section 16): counts by category and
 * lifecycle state, quantities, status mapping, duplicates, missing assets, missing wear/laundry state,
 * held rows and migration issues. Deterministic (no timestamps) so the committed copy can be checked.
 */
export interface ReconciliationReport {
  source: { file: string; title: string; sha256: string; dataRows: number };
  profile: { file: string; sha256: string; expectedSha256: string; matchesSpec: boolean; byteLength: number; rules: number };
  accounting: { imported: number; merged: number; held: number; garments: number; allRowsAccounted: boolean };
  byCategory: { category: string; garments: number; units: number }[];
  byPlanningPolicy: { policy: string; garments: number }[];
  statusMapping: { csvStatus: string; rows: number; acquisition: string; planningPolicy: string; location: string; restriction: string; lifecycle: string; explanation: string }[];
  restrictedBySneakersOnly: string[];
  tailoringProjects: { name: string; status: string }[];
  socks: { name: string; pairs: number; quantitySource: string }[];
  merges: { name: string; rows: number[] }[];
  renames: { item: string; names: string[] }[];
  missing: { images: number; productLinks: number; wearHistory: string; laundryState: string };
  heldRows: { row: number; reason: string }[];
  issues: { key: string; kind: string; severity: string; detail: string; status: 'open' | 'resolved'; resolution: string | null }[];
  ownerAsserted: null | {
    answer: { question: string; answer: string; answeredOn: string; pieces: string };
    garments: { name: string; category: string; restricted: boolean; knownFrom: string[]; unknownFields: string[]; detailsNeeded: string | null }[];
    detailsNeeded: { key: string; detail: string }[];
    totals: { garments: number; units: number };
  };
}

export function buildInventoryReconciliation(owner: OwnerDataset, additions?: OwnerAdditionsFile): ReconciliationReport {
  const m = owner.mapping;
  const garments = m.garments;
  const catCount = new Map<string, { garments: number; units: number }>();
  for (const g of garments) {
    const c = catCount.get(g.category) ?? { garments: 0, units: 0 };
    c.garments++;
    c.units += Object.values(g.stock ?? {}).reduce((a, b) => a + (b ?? 0), 0);
    catCount.set(g.category, c);
  }
  const policy = new Map<string, number>();
  for (const g of garments) policy.set(g.planningPolicy ?? 'normal', (policy.get(g.planningPolicy ?? 'normal') ?? 0) + 1);
  const statusRows = new Map<string, number>();
  for (const r of m.rows) statusRows.set(r.status, (statusRows.get(r.status) ?? 0) + 1);
  const imported = garments.reduce((n, g) => n + (g.sourceRows?.filter((s) => s.disposition === 'imported').length ?? 1), 0);
  const merged = garments.reduce((n, g) => n + (g.sourceRows?.filter((s) => s.disposition === 'merged').length ?? 0), 0);
  const restricted = garments.filter((g) => g.category === 'shoes' || g.category === 'boots' || g.attributes?.construction === 'welted' || g.attributes?.model === '990v6');
  return {
    source: { file: INVENTORY_FILE, title: m.title, sha256: m.sourceSha256, dataRows: m.rows.length },
    profile: { file: 'owner-profile.md', sha256: owner.profile.sha256, expectedSha256: owner.profile.expectedSha256, matchesSpec: owner.profile.matchesSpec, byteLength: owner.profile.byteLength, rules: owner.rulesCount },
    accounting: { imported, merged, held: m.heldRows.length, garments: garments.length, allRowsAccounted: imported + merged + m.heldRows.length === m.rows.length },
    byCategory: [...catCount.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([category, c]) => ({ category, ...c })),
    byPlanningPolicy: [...policy.entries()].sort().map(([p, n]) => ({ policy: p, garments: n })),
    statusMapping: [...m.statusMappings.values()]
      .sort((a, b) => a.csvStatus.localeCompare(b.csvStatus))
      .map((s) => ({
        csvStatus: s.csvStatus,
        rows: statusRows.get(s.csvStatus) ?? 0,
        acquisition: s.acquisition,
        planningPolicy: s.planningPolicy,
        location: s.location,
        restriction: s.restrictedBy ? 'sneakers-only (for welted shoes and boots)' : '—',
        lifecycle: s.tailoring ? `tailoring ${s.tailoring}` : '—',
        explanation: s.explanation,
      })),
    restrictedBySneakersOnly: restricted.map((g) => g.name).sort(),
    tailoringProjects: m.lifecycle.map((p) => ({ name: garments.find((g) => g.sourceId === p.garmentSourceIds[0])?.name ?? p.garmentSourceIds[0]!, status: p.status })).sort((a, b) => a.name.localeCompare(b.name)),
    socks: garments
      .filter((g) => g.category === 'socks')
      .map((g) => ({ name: g.name, pairs: g.stock?.clean ?? 0, quantitySource: m.issues.some((i) => i.garmentSourceId === g.sourceId && i.kind === 'quantity_unstated') ? 'not stated; minimum 1 from row presence' : "from the 'Nx' note" }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    merges: m.merges,
    renames: m.renames,
    missing: {
      images: garments.length,
      productLinks: m.rows.filter((r) => r.link === 'link').length,
      wearHistory: 'The CSV contains no wear history. No wears were created; wear logging begins at import (zero recorded wears means unlogged, never unworn).',
      laundryState: 'The CSV contains no laundry state. Every unit starts clean as an import baseline (basis import_baseline, not an observation); the estimator treats cleanliness under the weekly reset and no batch, hamper or pickup was invented.',
    },
    heldRows: m.heldRows.map((h) => ({ row: h.row, reason: h.reason })),
    issues: m.issues
      .map((i) => {
        const names = additions?.additions.filter((a) => a.resolvesIssue === i.issueKey).map((a) => a.item.name) ?? [];
        return {
          key: i.issueKey,
          kind: i.kind,
          severity: i.severity ?? 'review',
          detail: i.detail,
          status: names.length ? ('resolved' as const) : ('open' as const),
          resolution: names.length ? `Resolved by the owner's answer of ${additions!.answer.answeredOn} ("${additions!.answer.answer}"): added ${names.join(', ')}.` : null,
        };
      })
      .sort((a, b) => (a.status !== b.status ? (a.status === 'open' ? -1 : 1) : a.severity === b.severity ? a.key.localeCompare(b.key) : sevRank(a.severity) - sevRank(b.severity))),
    ownerAsserted: additions
      ? {
          answer: { question: additions.answer.question, answer: additions.answer.answer, answeredOn: additions.answer.answeredOn, pieces: additions.answer.pieces },
          garments: additions.additions.map((a) => ({
            name: a.item.name,
            category: a.item.category,
            restricted: additionRestricted(a),
            knownFrom: a.passages.map((p) => `§${p.section.split('.')[0]}: "${p.quote}"`),
            unknownFields: a.unknownFields,
            detailsNeeded: a.detailsNeeded,
          })),
          detailsNeeded: [
            ...additions.additions.filter((a) => a.detailsNeeded).map((a) => ({ key: `details_needed:${a.key}`, detail: `${a.item.name}: ${a.detailsNeeded}` })),
            ...additions.openQuestions.map((q) => ({ key: `open_question:${q.key}`, detail: q.detail })),
          ],
          totals: { garments: garments.length + additions.additions.length, units: [...catCount.values()].reduce((n, c) => n + c.units, 0) + additions.additions.length },
        }
      : null,
  };
}

function sevRank(s: string): number {
  return s === 'conflict' ? 0 : s === 'review' ? 1 : 2;
}

const esc = (s: string) => s.replace(/\|/g, '\\|');

export function renderReconciliationMarkdown(r: ReconciliationReport): string {
  const L: string[] = [];
  L.push('# Owner inventory import — reconciliation report', '');
  L.push('Generated by `npm run reconcile` from the byte-exact files in `garderobe/data/`. Deterministic: regenerate after any mapping change; a test fails if this file is stale.', '');
  L.push('## Sources', '');
  L.push(`- Inventory: \`${r.source.file}\` — "${r.source.title}" — ${r.source.dataRows} data rows — SHA-256 \`${r.source.sha256}\``);
  L.push(`- Profile: \`${r.profile.file}\` — ${r.profile.byteLength} bytes — SHA-256 \`${r.profile.sha256}\``);
  L.push(`- Spec's expected profile hash: \`${r.profile.expectedSha256}\` — **${r.profile.matchesSpec ? 'match' : 'MISMATCH (supplied file is authoritative)'}**`);
  L.push(`- Derived machine rules: ${r.profile.rules}`, '');
  L.push('## Row accounting', '');
  L.push(`| Disposition | Rows |`, `| --- | ---: |`, `| Imported | ${r.accounting.imported} |`, `| Merged (explicit mapping) | ${r.accounting.merged} |`, `| Held for resolution | ${r.accounting.held} |`, `| **Total** | **${r.accounting.imported + r.accounting.merged + r.accounting.held}** |`, '');
  L.push(`${r.accounting.garments} garments created. Every source row accounted for: **${r.accounting.allRowsAccounted ? 'yes' : 'NO'}**.`, '');
  L.push('## Counts by category', '', '| Category | Garments | Units |', '| --- | ---: | ---: |');
  for (const c of r.byCategory) L.push(`| ${c.category} | ${c.garments} | ${c.units} |`);
  L.push(`| **Total** | **${r.byCategory.reduce((n, c) => n + c.garments, 0)}** | **${r.byCategory.reduce((n, c) => n + c.units, 0)}** |`, '');
  L.push('All garments are acquisition `owned` and location `home`: the CSV lists no incoming, disposed, stored or at-tailor items.', '');
  L.push('## Lifecycle state (planning policy)', '', '| Planning policy | Garments |', '| --- | ---: |');
  for (const p of r.byPlanningPolicy) L.push(`| ${p.policy} | ${p.garments} |`);
  L.push('', '## Status mapping', '', 'Old status values are decomposed into separate facts; the original value is kept as the `csv_status` fact and attribute.', '');
  L.push('| CSV status | Rows | Acquisition | Planning | Location | Restriction | Lifecycle | Meaning |', '| --- | ---: | --- | --- | --- | --- | --- | --- |');
  for (const s of r.statusMapping) L.push(`| ${esc(s.csvStatus)} | ${s.rows} | ${s.acquisition} | ${s.planningPolicy} | ${s.location} | ${s.restriction} | ${s.lifecycle} | ${esc(s.explanation)} |`);
  L.push('', `Sneakers-only healing restriction (profile §8.2; lifted only by an explicit owner statement) covers: ${r.restrictedBySneakersOnly.join(', ')}; plus any future 990v6 by model.`, '');
  L.push('Tailoring projects (none is at the tailor):', '');
  for (const t of r.tailoringProjects) L.push(`- ${t.name} — ${t.status}`);
  L.push('', '## Quantities: socks', '', '| Socks | Pairs | Quantity source |', '| --- | ---: | --- |');
  for (const s of r.socks) L.push(`| ${s.name} | ${s.pairs} | ${s.quantitySource} |`);
  L.push(`| **Total** | **${r.socks.reduce((n, s) => n + s.pairs, 0)}** | |`, '');
  L.push('## Duplicates', '');
  L.push('Numbered identical rows ("pair 1" / "pair 2") are interchangeable units of one garment: they merge into a single garment with an anonymous quantity of 2, so wearing either counts one wear of that garment per day and the seven-day repeat rule treats them as the same visible piece. The second row is recorded as `merged` with an explicit note; both row labels remain aliases.', '');
  for (const d of r.merges) L.push(`- ${d.name} — rows ${d.rows.join(' + ')}`);
  L.push('', 'Items listed on several rows in different colours keep one garment each; the colour is appended to the perceptible name and the bare item name stays an alias:', '');
  for (const n of r.renames) L.push(`- ${n.item} → ${n.names.join('; ')}`);
  L.push('', '## Missing data', '');
  L.push(`- Images: none of the ${r.missing.images} garments has a catalogue image (the CSV carries none); all start in "Photos needed".`);
  L.push(`- Product links: ${r.missing.productLinks} rows say "link" without a URL.`);
  L.push(`- Wear history: ${r.missing.wearHistory}`);
  L.push(`- Laundry state: ${r.missing.laundryState}`);
  L.push('- Scenario state the CSV lacks (wears, laundry batches, tailor, storage, incoming, disposed) exists only in test fixtures, created through commands and labelled as test events.', '');
  L.push('## Held rows', '');
  L.push(r.heldRows.length ? r.heldRows.map((h) => `- Row ${h.row}: ${h.reason}`).join('\n') : 'None.', '');
  if (r.ownerAsserted) {
    const o = r.ownerAsserted;
    L.push('## Owner-asserted additions', '');
    L.push(`On ${o.answer.answeredOn} the owner answered "${o.answer.question}" with "${o.answer.answer}" (${o.answer.pieces}). These garments were added through the explicit add-item command as owner-asserted records, separate from the CSV rows (which stay untouched), each with the owner's answer and the verbatim profile passages as sourced facts. Anything the profile does not state is unknown.`, '');
    L.push('| Garment | Category | Sneakers-only restriction | Known from the profile | Unknown |', '| --- | --- | --- | --- | --- |');
    for (const g of o.garments) L.push(`| ${esc(g.name)} | ${g.category} | ${g.restricted ? 'restricted' : '—'} | ${esc(g.knownFrom.join('; '))} | ${esc(g.unknownFields.join('; '))} |`);
    L.push('', `Totals after the additions: **${o.totals.garments} garments, ${o.totals.units} units** (CSV baseline ${r.accounting.garments} garments; each addition records one unit until the owner gives a count).`, '');
    L.push('### Details still needed from the owner', '');
    for (const d of o.detailsNeeded) L.push(`- ${d.detail}`);
    L.push('');
  }
  L.push('## Migration issues', '', 'Conflicts between the May 2026 CSV and the September 2026 profile, and gaps in the CSV, recorded instead of guessed.', '');
  L.push('| Status | Severity | Kind | Detail |', '| --- | --- | --- | --- |');
  for (const i of r.issues) L.push(`| ${i.status}${i.resolution ? ` — ${esc(i.resolution)}` : ''} | ${i.severity} | ${i.kind} | ${esc(i.detail)} |`);
  L.push('', `Open: ${r.issues.filter((i) => i.status === 'open').length}. Resolved: ${r.issues.filter((i) => i.status === 'resolved').length}.`);
  L.push('');
  return L.join('\n');
}
