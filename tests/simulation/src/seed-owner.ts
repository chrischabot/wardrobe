/**
 * Seeds one fresh simulation owner with the owner's real data through the foundation importer,
 * exactly as deploy/scripts/seed.ts and demo/scripts/seed-local.ts seed the owner: the verbatim
 * profile (data/owner-profile.md), its 41 derived rules, the May 2026 CSV and the owner-asserted
 * additions of 2026-09-29. Unknown colours, makers, sizes and counts stay as the importer leaves them.
 *
 * A fresh owner per run keeps runs independent (receipts are immutable, so a used owner cannot be
 * reset) and keeps simulated wears out of the owner's own dev ledger.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createUser, listWardrobe, ownerPrincipal } from '@garderobe/backend/domain';
import { applyOwnerAssertedAdditions, importOwnerData, parseOwnerAdditions } from '@garderobe/backend/import';

export const SIM_ISSUER = 'garderobe-simulation';

export interface SeededOwner {
  userId: string;
  garments: number;
  units: number | null;
  rules: number;
  profileMatchesSpec: boolean;
  migrationIssues: number;
  additionsCreated: number;
}

export async function seedSimulationOwner(db: D1Database, dataDir: string, opts: { displayName: string; runLabel: string; identity?: { issuer: string; subject: string }; importedAt?: string }): Promise<SeededOwner> {
  const { userId } = await createUser(db, { displayName: opts.displayName, identity: opts.identity ?? { issuer: SIM_ISSUER, subject: `simulation-${opts.runLabel}` } });
  const principal = ownerPrincipal(userId, 'simulation-seed');
  const profileText = readFileSync(join(dataDir, 'owner-profile.md'), 'utf8');
  const { result, report } = await importOwnerData(
    db,
    principal,
    { profileText, rulesCatalogue: JSON.parse(readFileSync(join(dataDir, 'owner-profile-rules.json'), 'utf8')), csvText: readFileSync(join(dataDir, 'wardrobe-inventory-2026-05.csv'), 'utf8') },
    { importedAt: opts.importedAt ?? new Date().toISOString() },
  );
  const additions = parseOwnerAdditions(JSON.parse(readFileSync(join(dataDir, 'owner-asserted-additions-2026-09-29.json'), 'utf8')), profileText);
  const added = await applyOwnerAssertedAdditions(db, principal, additions);
  const page = await listWardrobe(db, principal);
  const units = await db
    .prepare('SELECT COALESCE(SUM(clean_qty + worn_qty + hamper_qty + laundry_qty + storage_qty + away_qty + retired_qty), 0) AS n FROM stock_lots WHERE user_id = ?')
    .bind(userId)
    .first<{ n: number }>()
    .catch(() => null);
  return { userId, garments: page.total, units: units?.n ?? null, rules: result.rulesCreated, profileMatchesSpec: report.profile.matchesSpec, migrationIssues: report.issues.length, additionsCreated: added.created };
}

/** The owner's app model budget (owner_settings.budget_json.monthlyMicroUsd), the app's own spend cap. */
export async function setMonthlyBudget(db: D1Database, userId: string, usd: number): Promise<void> {
  await db
    .prepare("UPDATE owner_settings SET budget_json = json_set(COALESCE(NULLIF(budget_json,''),'{}'), '$.monthlyMicroUsd', ?) WHERE user_id = ?")
    .bind(Math.round(usd * 1e6), userId)
    .run();
}
