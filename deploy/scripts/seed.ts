/**
 * Seeds the dev D1/R2 with the owner's real data through the foundation's own importer, exactly as
 * demo/scripts/seed-local.ts does locally, but with remote bindings (wrangler getPlatformProxy with
 * `remote: true`) so every statement runs on the deployed garderobe-dev database and bucket:
 *  - the verbatim profile (data/owner-profile.md), its 41 derived rules and the May 2026 CSV;
 *  - the owner-asserted additions of 2026-09-29;
 *  - the synthetic, labelled test owner B (isolation checks only);
 *  - labelled DEMO placeholder images in private R2;
 *  - optionally the labelled TEST EVENT scenario week (--no-test-events to skip).
 * The reconciliation report produced by the import is compared with data/owner-inventory-reconciliation.json.
 *
 * Identity links are a separate, explicit step (`link` / `unlink` below), recorded in account_audit.
 * The seed never links any sign-in identity to the owner.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import { CommandService, createUser, listWardrobe, ownerPrincipal, resolveIdentity } from '@garderobe/backend/domain';
import { applyOwnerAssertedAdditions, buildInventoryReconciliation, importDataset, importOwnerData, parseOwnerAdditions } from '@garderobe/backend/import';
import { MediaService } from '@garderobe/backend/media';
import { applyDemoPlaceholders, applyTestEvents, syntheticOwnerB } from '@garderobe/demo';
import { assertDevConfig, dataDir, deployDir, readConfig, readState, TEAM_DOMAIN, writeEvidence, type ServiceTokenState } from './lib.js';

export const SEED_ISSUER = 'garderobe-dev-seed';

async function remoteProxy() {
  const config = readConfig();
  assertDevConfig(config);
  const seedConfig = {
    name: 'garderobe-dev-seed',
    compatibility_date: '2026-08-01',
    compatibility_flags: ['nodejs_compat'],
    d1_databases: config.d1_databases.map((d) => ({ ...d, migrations_dir: join(deployDir, d.migrations_dir), remote: true })),
    r2_buckets: config.r2_buckets.map((b) => ({ ...b, remote: true })),
  };
  const dir = join(deployDir, '.generated');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'wrangler.seed.json');
  writeFileSync(path, JSON.stringify(seedConfig, null, 2));
  return getPlatformProxy<{ DB: D1Database; MEDIA: R2Bucket }>({ configPath: path, persist: false, remoteBindings: true });
}

async function ensureUser(db: D1Database, subject: string, displayName: string) {
  const existing = await resolveIdentity(db, SEED_ISSUER, subject);
  if (existing) return { userId: existing, created: false };
  const { userId } = await createUser(db, { displayName, identity: { issuer: SEED_ISSUER, subject } });
  return { userId, created: true };
}

export async function seed(opts: { withTestEvents: boolean }): Promise<void> {
  const proxy = await remoteProxy();
  const db = proxy.env.DB;
  const signingKey = 'seed-time-key-unused-for-stored-objects-000000'; // ingest stores bytes; URLs are signed at read time with the Worker secret
  try {
    const owner = await ensureUser(db, 'owner', 'Chris');
    const principal = ownerPrincipal(owner.userId, 'dev-seed');
    const nowMs = Date.now();
    const importedAt = new Date(opts.withTestEvents && owner.created ? nowMs - 14 * 86_400_000 : nowMs).toISOString();
    const profileText = readFileSync(join(dataDir, 'owner-profile.md'), 'utf8');
    const t0 = Date.now();
    const { result, report, owner: ownerDataset } = await importOwnerData(
      db,
      principal,
      { profileText, rulesCatalogue: JSON.parse(readFileSync(join(dataDir, 'owner-profile-rules.json'), 'utf8')), csvText: readFileSync(join(dataDir, 'wardrobe-inventory-2026-05.csv'), 'utf8') },
      { importedAt },
    );
    console.log(`Owner ${owner.created ? '(created)' : '(existing)'}: ${result.garmentsCreated} garments created, ${result.garmentsSkipped} already present; ${result.rulesCreated} rules; profile hash ${report.profile.matchesSpec ? 'matches the spec' : 'DIFFERS'}; ${report.issues.length} migration issues (${Date.now() - t0} ms).`);
    const additions = parseOwnerAdditions(JSON.parse(readFileSync(join(dataDir, 'owner-asserted-additions-2026-09-29.json'), 'utf8')), profileText);
    const added = await applyOwnerAssertedAdditions(db, principal, additions);
    console.log(`Owner-asserted additions: ${added.created} created, ${added.replayed} already present; issues resolved now: ${added.issuesResolved.length}.`);

    const b = await ensureUser(db, 'synthetic-owner-b', 'Synthetic Test Owner B');
    const bResult = await importDataset(db, ownerPrincipal(b.userId, 'dev-seed'), syntheticOwnerB, { sourceSystem: 'synthetic-test-owner-b' });
    console.log(`Synthetic test owner B: ${bResult.garmentsCreated} garments created, ${bResult.garmentsSkipped} already present.`);

    for (const [label, userId] of [['Owner', owner.userId], ['Synthetic test owner B', b.userId]] as const) {
      const media = new MediaService({ db, bucket: proxy.env.MEDIA, principal: ownerPrincipal(userId, 'dev-seed'), signingKey });
      const placeholders = await applyDemoPlaceholders(db, media);
      console.log(`${label}: ${placeholders.created} DEMO placeholder images created in private R2, ${placeholders.skipped} skipped.`);
    }

    let events: { applied: number; replayed: number; weekStart: string } | string = 'not requested';
    if (opts.withTestEvents) {
      const firstImport = await db.prepare('SELECT MIN(created_at) AS at FROM import_runs WHERE user_id = ?').bind(owner.userId).first<{ at: string }>();
      const start = new Date(firstImport!.at);
      start.setUTCDate(start.getUTCDate() + ((8 - start.getUTCDay()) % 7 || 7));
      const weekStart = start.toISOString().slice(0, 10);
      if (Date.parse(weekStart) + 7 * 86_400_000 > nowMs) {
        events = `skipped: the import (${firstImport!.at}) is too recent for a full event week before today`;
      } else {
        const byName = async (name: string) => {
          const row = await db.prepare('SELECT garment_id FROM garments WHERE user_id = ? AND name = ?').bind(owner.userId, name).first<{ garment_id: string }>();
          if (!row) throw new Error(`No garment ${name}`);
          return row.garment_id;
        };
        const r = await applyTestEvents(new CommandService(db, principal), { garment: byName, weekStart });
        events = { applied: r.receipts.length, replayed: r.receipts.filter((x) => x.replayed).length, weekStart };
      }
      console.log(`Labelled TEST EVENT scenario week: ${JSON.stringify(events)}`);
    }

    const page = await listWardrobe(db, principal);
    console.log(`Owner wardrobe on dev D1: ${page.total} garments; counts ${JSON.stringify(page.counts)}.`);

    // Reconciliation: (1) the importer's report for this run (with the owner-asserted additions) must equal
    // the committed local report apart from timestamps; (2) what dev D1 now holds must match that report.
    const committed = JSON.parse(readFileSync(join(dataDir, 'owner-inventory-reconciliation.json'), 'utf8')) as unknown;
    const devReport = buildInventoryReconciliation(ownerDataset, additions);
    const reportMatches = JSON.stringify(stripTimes(committed)) === JSON.stringify(stripTimes(JSON.parse(JSON.stringify(devReport))));
    const held = await db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM garments WHERE user_id = ?1) AS garments,
                (SELECT COALESCE(SUM(clean_qty + worn_qty + hamper_qty + laundry_qty + storage_qty + away_qty + retired_qty), 0) FROM stock_lots WHERE user_id = ?1) AS units,
                (SELECT COUNT(*) FROM migration_issues WHERE user_id = ?1) AS issues,
                (SELECT COUNT(*) FROM migration_issues WHERE user_id = ?1 AND resolved_at IS NULL) AS openIssues,
                (SELECT COUNT(*) FROM style_rules WHERE user_id = ?1) AS rules`,
      )
      .bind(owner.userId)
      .first<{ garments: number; units: number; issues: number; openIssues: number; rules: number }>();
    const expected = {
      garments: devReport.ownerAsserted?.totals.garments,
      units: devReport.ownerAsserted?.totals.units,
      // The CSV issues in the report plus one "details needed" issue per owner-asserted addition.
      issues: devReport.issues.length + (devReport.ownerAsserted?.garments.length ?? 0),
      openIssues: devReport.issues.filter((i) => i.status === 'open').length + (devReport.ownerAsserted?.garments.length ?? 0),
    };
    // Labelled test events may add garments (for example an incoming order line); they never change units already imported.
    const d1Matches = held!.garments >= expected.garments! && held!.units === expected.units && held!.issues === expected.issues && held!.openIssues === expected.openIssues;
    const local = await (await import('./reconcile.js')).compareLocalAndDev(db);
    const comparison = { reportMatchesCommittedLocalReport: reportMatches, d1: held, expectedFromReport: expected, d1MatchesReport: d1Matches, localImport: local, matches: reportMatches && d1Matches && local.matches !== false };
    console.log(`Reconciliation: report equals data/owner-inventory-reconciliation.json (timestamps aside): ${reportMatches}; dev D1 ${JSON.stringify(held)} vs report ${JSON.stringify(expected)}: ${d1Matches}; dev vs local import signature: ${local.matches === null ? `not compared (${local.note})` : local.matches}${local.differences?.length ? ` (${local.differences.join('; ')})` : ''}`);
    writeEvidence('seed.json', {
      seededAt: new Date().toISOString(),
      owner: { created: owner.created, garmentsCreated: result.garmentsCreated, garmentsSkipped: result.garmentsSkipped, rules: result.rulesCreated, profileHashMatchesSpec: report.profile.matchesSpec, migrationIssues: report.issues.length },
      additions: { created: added.created, replayed: added.replayed },
      syntheticOwnerB: { garmentsCreated: bResult.garmentsCreated, garmentsSkipped: bResult.garmentsSkipped },
      testEvents: events,
      wardrobe: { total: page.total, counts: page.counts },
      reconciliation: comparison,
    });
    if (!comparison.matches) process.exitCode = 1;
  } finally {
    await proxy.dispose();
  }
}

/** Drops volatile timestamp fields so two reports of the same inputs compare equal. */
function stripTimes(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripTimes);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !/(At|Time)$/.test(k)).map(([k, x]) => [k, stripTimes(x)]));
  return v;
}

/**
 * Explicit, audited link of an Access service token to a seeded owner (the only way a service-token
 * subject reaches an owner). `unlink` sets unlinked_at, after which the token is `unknown_identity`.
 *   npm run dev:seed -- link owner|b      npm run dev:seed -- unlink owner|b
 */
export async function linkServiceToken(action: 'link' | 'unlink', which: 'owner' | 'b'): Promise<void> {
  const state = readState<ServiceTokenState>(which === 'owner' ? 'access-service-token.json' : 'access-service-token-b.json');
  if (!state) throw new Error('No service token state: run provision first');
  const subject = `service-token:${state.clientId}`;
  const proxy = await remoteProxy();
  const db = proxy.env.DB;
  try {
    const target = await resolveIdentity(db, SEED_ISSUER, which === 'owner' ? 'owner' : 'synthetic-owner-b');
    if (!target) throw new Error('Seed first: the target owner does not exist on dev');
    const now = new Date().toISOString();
    const current = await db.prepare('SELECT user_id, identity_id FROM auth_identities WHERE issuer = ? AND subject = ? AND unlinked_at IS NULL').bind(TEAM_DOMAIN, subject).first<{ user_id: string; identity_id: string }>();
    if (action === 'link') {
      if (current) {
        if (current.user_id !== target) throw new Error('This service token is linked to a different owner; unlink it first');
        console.log('Already linked.');
        return;
      }
      const identityId = `idn_${crypto.randomUUID().replace(/-/g, '')}`;
      const previous = await db.prepare('SELECT user_id, identity_id FROM auth_identities WHERE issuer = ? AND subject = ? AND unlinked_at IS NOT NULL').bind(TEAM_DOMAIN, subject).first<{ user_id: string; identity_id: string }>();
      if (previous && previous.user_id !== target) throw new Error('This service token was previously linked to a different owner; refusing to move it');
      const audit = (id: string, relinked: boolean) =>
        db.prepare("INSERT INTO account_audit (user_id, audit_id, action, surface, grant_ref, idempotency_key, outcome, detail_json, created_at) VALUES (?, ?, 'identity_linked', 'deploy', NULL, NULL, 'linked', ?, ?)").bind(target, `aud_${crypto.randomUUID().replace(/-/g, '')}`, JSON.stringify({ identityId: id, relinked, issuer: TEAM_DOMAIN, kind: 'access_service_token', tokenName: which === 'owner' ? 'garderobe-dev-automation' : 'garderobe-dev-automation-owner-b', by: 'deploy/scripts/seed.ts link' }), now);
      if (previous) {
        // (issuer, subject) is unique: relinking re-activates the same identity row for the same owner.
        await db.batch([db.prepare('UPDATE auth_identities SET unlinked_at = NULL, linked_at = ? WHERE user_id = ? AND identity_id = ?').bind(now, target, previous.identity_id), audit(previous.identity_id, true)]);
        console.log(`Relinked identity ${previous.identity_id} (audited).`);
        return;
      }
      await db.batch([
        db.prepare('INSERT INTO auth_identities (user_id, identity_id, issuer, subject, email, linked_at) VALUES (?, ?, ?, ?, NULL, ?)').bind(target, identityId, TEAM_DOMAIN, subject, now),
        audit(identityId, false),
      ]);
      console.log(`Linked the ${which === 'owner' ? 'garderobe-dev-automation' : 'garderobe-dev-automation-owner-b'} service token to ${which === 'owner' ? 'the owner' : 'synthetic test owner B'} (identity ${identityId}; audited).`);
    } else {
      if (!current) {
        console.log('Not linked.');
        return;
      }
      await db.batch([
        db.prepare('UPDATE auth_identities SET unlinked_at = ? WHERE user_id = ? AND identity_id = ?').bind(now, current.user_id, current.identity_id),
        db.prepare("INSERT INTO account_audit (user_id, audit_id, action, surface, grant_ref, idempotency_key, outcome, detail_json, created_at) VALUES (?, ?, 'identity_unlinked', 'deploy', NULL, NULL, 'unlinked', ?, ?)").bind(current.user_id, `aud_${crypto.randomUUID().replace(/-/g, '')}`, JSON.stringify({ identityId: current.identity_id, kind: 'access_service_token' }), now),
      ]);
      console.log(`Unlinked identity ${current.identity_id}; the service token now gets unknown_identity.`);
    }
  } finally {
    await proxy.dispose();
  }
}
