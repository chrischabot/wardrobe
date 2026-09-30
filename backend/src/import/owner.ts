import { NEUTRAL_EXPORT_FORMAT, NEUTRAL_EXPORT_VERSION, StyleRuleCatalogue, type ImportDatasetInput } from '@garderobe/contracts';
import { sha256Hex, utf8ByteLength } from '../domain/hash.js';
import type { Principal } from '../domain/principal.js';
import { importDataset, type ImportResult } from './importer.js';
import { INVENTORY_SOURCE_SYSTEM, mapInventory, type InventoryMapping } from './owner-inventory.js';
import { buildInventoryReconciliation, type ReconciliationReport } from './reconciliation.js';

/**
 * The owner's real data: the September 2026 style profile (verbatim), its derived rule catalogue and
 * the May 2026 inventory CSV. This is the owner baseline used by tests, the simulation and deployment.
 */

/** SHA-256 given in the design spec (section 6) for the September 14 profile. */
export const SPEC_PROFILE_SHA256 = 'e15639d891f9a5264c7eff13d05a478bcb188745aea11323b2131db37f5cb198';
export const PROFILE_SOURCE_ID = 'owner-profile-2026-09-14';
export const PROFILE_FILE = 'owner-profile.md';

export interface OwnerSources {
  profileText: string;
  rulesCatalogue: unknown;
  csvText: string;
}

export interface OwnerDataset {
  dataset: ImportDatasetInput;
  mapping: InventoryMapping;
  profile: { sha256: string; byteLength: number; expectedSha256: string; matchesSpec: boolean; title: string };
  rulesCount: number;
}

export async function buildOwnerDataset(sources: OwnerSources, opts: { importedAt: string }): Promise<OwnerDataset> {
  const catalogue = StyleRuleCatalogue.parse(sources.rulesCatalogue);
  const sha = await sha256Hex(sources.profileText);
  const title = sources.profileText.split(/\r?\n/)[0]!.replace(/^#\s*/, '').trim();
  const mapping = await mapInventory(sources.csvText);
  const sneakers = catalogue.rules.find((r) => r.restrictionSourceId === 'profile-sneakers-only');
  const excluded = (sneakers?.machine.excludedSelectors ?? {}) as { categories?: string[]; attributes?: Record<string, string> };
  const dataset: ImportDatasetInput = {
    format: NEUTRAL_EXPORT_FORMAT,
    version: NEUTRAL_EXPORT_VERSION,
    source: { system: INVENTORY_SOURCE_SYSTEM, exportedAt: '2026-05-31T00:00:00.000Z', label: mapping.title },
    owner: {
      displayName: 'Chris',
      homeLocationLabel: 'London (Elephant and Castle)',
      timezone: 'Europe/London',
      deliveryTime: '07:00',
      dailyOptionCount: 5,
      // No wear history exists in the sources: reliable logging begins at import.
      wearLoggingSince: opts.importedAt.slice(0, 10),
    },
    styleDocuments: [
      {
        sourceId: PROFILE_SOURCE_ID,
        title,
        body: sources.profileText,
        isDemo: false,
        source: 'owner_supplied',
        authoredOn: '2026-09-14',
        expectedSha256: SPEC_PROFILE_SHA256,
        rules: catalogue.rules,
      },
    ],
    garments: mapping.garments,
    restrictions: sneakers
      ? [
          {
            sourceId: 'profile-sneakers-only',
            kind: 'healing',
            scope: { categories: (excluded.categories ?? ['shoes', 'boots']) as never, attributes: excluded.attributes ?? { construction: 'welted', model: '990v6' } },
            reason: 'Sneakers only until he says his feet have healed: nerve damage from previously too-small shoes puts the welted fleet and the 990v6 out of play (profile §8.2)',
            startsAt: '2026-09-13T23:00:00.000Z',
            requiredEvidence: 'owner_statement',
          },
        ]
      : [],
    lifecycleProjects: mapping.lifecycle,
    heldRows: mapping.heldRows,
    issues: mapping.issues,
  };
  return {
    dataset,
    mapping,
    profile: { sha256: sha, byteLength: utf8ByteLength(sources.profileText), expectedSha256: SPEC_PROFILE_SHA256, matchesSpec: sha === SPEC_PROFILE_SHA256, title },
    rulesCount: catalogue.rules.length,
  };
}

export async function importOwnerData(
  db: D1Database,
  principal: Principal,
  sources: OwnerSources,
  opts: { importedAt?: string } = {},
): Promise<{ result: ImportResult; report: ReconciliationReport; owner: OwnerDataset }> {
  const importedAt = opts.importedAt ?? new Date().toISOString();
  const owner = await buildOwnerDataset(sources, { importedAt });
  const result = await importDataset(db, principal, owner.dataset, {
    sourceSystem: INVENTORY_SOURCE_SYSTEM,
    sourceLabel: owner.mapping.title,
    sourceSha256: owner.mapping.sourceSha256,
    importedAt,
  });
  return { result, report: buildInventoryReconciliation(owner), owner };
}
