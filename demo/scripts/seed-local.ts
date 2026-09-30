/**
 * Seeds local D1 (the same persisted state `wrangler dev` uses) with the owner's real data:
 * the verbatim September 2026 profile, its derived rules and the May 2026 inventory, plus the
 * synthetic second owner used for isolation checks. Scenario test events are opt-in (--with-test-events).
 *
 * Run from garderobe/: npm run seed:demo   (applies migrations first)
 * Everything is local: no Cloudflare account is contacted.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import { CommandService, createUser, listWardrobe, ownerPrincipal, resolveIdentity } from '@garderobe/backend/domain';
import { applyOwnerAssertedAdditions, importDataset, importOwnerData, parseOwnerAdditions } from '@garderobe/backend/import';
import { LOCAL_DEV_SIGNING_KEY, MediaService } from '@garderobe/backend/media';
import { applyTestEvents, applyDemoPlaceholders, syntheticOwnerB } from '../src/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const backendDir = join(root, 'backend');
const dataDir = join(root, 'data');
const withTestEvents = process.argv.includes('--with-test-events');

execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local'], { cwd: backendDir, stdio: 'inherit', env: { ...process.env, CI: '1' } });

process.chdir(backendDir);
const proxy = await getPlatformProxy<{ DB: D1Database; MEDIA: R2Bucket }>({ configPath: join(backendDir, 'wrangler.jsonc'), persist: true, remoteBindings: false });
const db = proxy.env.DB;

async function ensureUser(issuer: string, subject: string, displayName: string): Promise<{ userId: string; created: boolean }> {
  const existing = await resolveIdentity(db, issuer, subject);
  if (existing) return { userId: existing, created: false };
  const { userId } = await createUser(db, { displayName, identity: { issuer, subject } });
  return { userId, created: true };
}

try {
  const owner = await ensureUser('local-dev', 'owner', 'Chris');
  const principal = ownerPrincipal(owner.userId, 'local-seed');
  const nowMs = Date.now();
  // Test events must happen after the import baseline exists, so a fresh seed with events back-dates the import.
  const importedAt = new Date(withTestEvents && owner.created ? nowMs - 14 * 86_400_000 : nowMs).toISOString();
  const { result, report } = await importOwnerData(
    db,
    principal,
    {
      profileText: readFileSync(join(dataDir, 'owner-profile.md'), 'utf8'),
      rulesCatalogue: JSON.parse(readFileSync(join(dataDir, 'owner-profile-rules.json'), 'utf8')),
      csvText: readFileSync(join(dataDir, 'wardrobe-inventory-2026-05.csv'), 'utf8'),
    },
    { importedAt },
  );
  console.log(`Owner ${owner.userId}${owner.created ? ' (created)' : ''}: ${result.garmentsCreated} garments created, ${result.garmentsSkipped} already present; ${result.rulesCreated} rules; profile hash ${report.profile.matchesSpec ? 'matches the spec' : 'DIFFERS from the spec (supplied file kept)'}; ${report.issues.length} migration issues.`);
  const additions = parseOwnerAdditions(JSON.parse(readFileSync(join(dataDir, 'owner-asserted-additions-2026-09-29.json'), 'utf8')), readFileSync(join(dataDir, 'owner-profile.md'), 'utf8'));
  const added = await applyOwnerAssertedAdditions(db, principal, additions);
  console.log(`Owner-asserted additions (answer of ${additions.answer.answeredOn}): ${added.created} created, ${added.replayed} already present; issues resolved now: ${added.issuesResolved.length}.`);

  const b = await ensureUser('local-dev', 'synthetic-owner-b', 'Synthetic Test Owner B');
  const bResult = await importDataset(db, ownerPrincipal(b.userId, 'local-seed'), syntheticOwnerB, { sourceSystem: 'synthetic-test-owner-b' });
  console.log(`Synthetic test owner B ${b.userId}: ${bResult.garmentsCreated} garments created, ${bResult.garmentsSkipped} already present.`);

  // DEMO placeholder images (labelled "Demo placeholder", never verified) for garments without any image,
  // so composites, Studio and the simulation have pictures. Real photographs replace them as catalogue images.
  for (const [label, userId] of [['Owner', owner.userId], ['Synthetic test owner B', b.userId]] as const) {
    const media = new MediaService({ db, bucket: proxy.env.MEDIA, principal: ownerPrincipal(userId, 'local-seed'), signingKey: LOCAL_DEV_SIGNING_KEY });
    const placeholders = await applyDemoPlaceholders(db, media);
    console.log(`${label}: ${placeholders.created} DEMO placeholder images created, ${placeholders.skipped} skipped (garments that already had images are not counted).`);
  }

  if (withTestEvents) {
    const firstImport = await db.prepare('SELECT MIN(created_at) AS at FROM import_runs WHERE user_id = ?').bind(owner.userId).first<{ at: string }>();
    const start = new Date(firstImport!.at);
    start.setUTCDate(start.getUTCDate() + ((8 - start.getUTCDay()) % 7 || 7)); // first Monday after the import
    const weekStart = start.toISOString().slice(0, 10);
    if (Date.parse(weekStart) + 7 * 86_400_000 > nowMs) {
      console.log(`Skipped test events: the owner import (${firstImport!.at}) is too recent for a full event week before today. Reset local state (rm -rf backend/.wrangler) and rerun with --with-test-events.`);
    } else {
      const byName = async (name: string) => {
        const row = await db.prepare('SELECT garment_id FROM garments WHERE user_id = ? AND name = ?').bind(owner.userId, name).first<{ garment_id: string }>();
        if (!row) throw new Error(`No garment ${name}`);
        return row.garment_id;
      };
      const events = await applyTestEvents(new CommandService(db, principal), { garment: byName, weekStart });
      console.log(`Applied ${events.receipts.length} labelled test events for the week of ${weekStart} (${events.receipts.filter((r) => r.replayed).length} already applied).`);
    }
  }
  const page = await listWardrobe(db, principal);
  console.log(`Owner wardrobe: ${page.total} garments; owned ${page.counts.owned}, available ${page.counts.available}, incoming ${page.counts.incoming}, retired ${page.counts.retired}.`);
} finally {
  await proxy.dispose();
}
