/**
 * Prepares a live run on the garderobe-dev deployment (dev only; guarded by assertDevConfig):
 *  1. the Access service token `garderobe-dev-automation-sim` (created once; its secret only in
 *     deploy/.state/access-service-token-sim.json, mode 600) added to the existing reusable
 *     "Garderobe dev automation (service token)" policy, keeping the two tokens already there;
 *  2. the DEV_SIM_SECRET Worker secret (generated once, kept in deploy/.state/dev-sim-secret.json);
 *  3. a fresh simulation owner on the remote D1, seeded with the owner's real profile, rules, May 2026
 *     CSV and owner-asserted additions through the foundation importer;
 *  4. the sim service token's Access identity moved to that owner (audited in account_audit on both
 *     owners), so each run starts from a clean ledger and the owner's own dev ledger is untouched;
 *  5. the owner's app model budget capped (default $25, `--budget-usd`), below the gateway's $50 rule.
 *
 *   npx tsx tests/simulation/scripts/setup-dev.ts [--budget-usd 25]
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import { accountId, assertDevConfig, cf, configPath, dataDir, deployDir, readConfig, readState, TEAM_DOMAIN, wrangler, writeState, type ServiceTokenState } from '../../../deploy/scripts/lib.js';
import { seedSimulationOwner, setMonthlyBudget } from '../src/seed-owner.js';

export const SIM_TOKEN_NAME = 'garderobe-dev-automation-sim';
export const SIM_TOKEN_STATE = 'access-service-token-sim.json';
export const SIM_SECRET_STATE = 'dev-sim-secret.json';
export const SIM_OWNER_STATE = 'simulation-owner.json';
const POLICY_NAME = 'Garderobe dev automation (service token)';

export interface SimOwnerState {
  userId: string;
  runLabel: string;
  budgetUsd: number;
  preparedAt: string;
  garments: number;
  units: number | null;
  profileMatchesSpec: boolean;
}

const A = () => `/accounts/${accountId()}`;

async function ensureSimToken(): Promise<ServiceTokenState> {
  const tokens = await cf<{ id: string; name: string; client_id: string }[]>('GET', `${A()}/access/service_tokens?per_page=100`);
  const existing = tokens.find((t) => t.name === SIM_TOKEN_NAME);
  const saved = readState<ServiceTokenState>(SIM_TOKEN_STATE);
  if (existing && saved && saved.tokenId === existing.id) return saved;
  const token = existing
    ? await cf<{ id: string; client_id: string; client_secret: string }>('POST', `${A()}/access/service_tokens/${existing.id}/rotate`)
    : await cf<{ id: string; client_id: string; client_secret: string }>('POST', `${A()}/access/service_tokens`, { name: SIM_TOKEN_NAME, duration: '8760h' });
  const state = { clientId: token.client_id, clientSecret: token.client_secret, tokenId: existing?.id ?? token.id };
  writeState(SIM_TOKEN_STATE, state);
  console.log(`${existing ? 'Rotated' : 'Created'} Access service token ${SIM_TOKEN_NAME} (secret in deploy/.state only).`);
  return state;
}

/** Adds the sim token to the reusable service-token policy, keeping every token already included. */
async function ensureInPolicy(tokenId: string): Promise<void> {
  const policies = await cf<{ id: string; name: string }[]>('GET', `${A()}/access/policies?per_page=100`);
  const found = policies.find((p) => p.name === POLICY_NAME);
  if (!found) throw new Error(`Access policy "${POLICY_NAME}" not found: run npm run dev:provision first`);
  const policy = await cf<{ name: string; decision: string; include: { service_token?: { token_id: string } }[]; exclude: unknown[]; require: unknown[] }>('GET', `${A()}/access/policies/${found.id}`);
  const ids = policy.include.map((i) => i.service_token?.token_id).filter((v): v is string => Boolean(v));
  if (ids.includes(tokenId)) return;
  await cf('PUT', `${A()}/access/policies/${found.id}`, { name: policy.name, decision: policy.decision, include: [...policy.include, { service_token: { token_id: tokenId } }], exclude: policy.exclude ?? [], require: policy.require ?? [] });
  console.log(`Added ${SIM_TOKEN_NAME} to the "${POLICY_NAME}" policy (${ids.length} tokens kept).`);
}

function ensureSimSecret(): string {
  const saved = readState<{ secret: string }>(SIM_SECRET_STATE);
  if (saved?.secret) return saved.secret;
  const secret = Buffer.from(randomBytes(32)).toString('base64url' as BufferEncoding);
  const out = wrangler(['secret', 'put', 'DEV_SIM_SECRET', '--config', configPath], { input: secret, allowFail: true });
  if (!/Success|Uploaded/i.test(out)) throw new Error(`wrangler secret put DEV_SIM_SECRET failed: ${out.split('\n').filter((l) => /error|fail/i.test(l)).join(' ').slice(0, 300)}`);
  writeState(SIM_SECRET_STATE, { secret, createdAt: new Date().toISOString() });
  console.log('Bound the DEV_SIM_SECRET Worker secret (value in deploy/.state only).');
  return secret;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const budgetUsd = Number(args.includes('--budget-usd') ? args[args.indexOf('--budget-usd') + 1] : 25);
  if (!(budgetUsd > 0 && budgetUsd <= 40)) throw new Error('--budget-usd must be above 0 and at most 40 (the gateway rule is $50 and must never be exceeded)');
  const config = readConfig();
  assertDevConfig(config);
  const token = await ensureSimToken();
  await ensureInPolicy(token.tokenId);
  ensureSimSecret();

  const dir = join(deployDir, '.generated');
  mkdirSync(dir, { recursive: true });
  const seedConfig = join(dir, 'wrangler.sim-seed.json');
  writeFileSync(seedConfig, JSON.stringify({ name: 'garderobe-dev-sim-seed', compatibility_date: '2026-08-01', compatibility_flags: ['nodejs_compat'], d1_databases: config.d1_databases.map((d) => ({ ...d, migrations_dir: join(deployDir, d.migrations_dir), remote: true })) }, null, 2));
  const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: seedConfig, persist: false, remoteBindings: true });
  const db = proxy.env.DB;
  try {
    const runLabel = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const seeded = await seedSimulationOwner(db, dataDir, { displayName: `Chris (simulation ${runLabel})`, runLabel });
    console.log(`Simulation owner ${seeded.userId}: ${seeded.garments} garments, ${seeded.units} units, ${seeded.rules} rules; profile ${seeded.profileMatchesSpec ? 'matches the spec hash' : 'DIFFERS'}; ${seeded.migrationIssues} migration issues; ${seeded.additionsCreated} owner-asserted additions.`);
    await setMonthlyBudget(db, seeded.userId, budgetUsd);

    // Move the sim token's identity to the new owner: retire the old row's subject, insert the new link. Audited on both owners.
    const subject = `service-token:${token.clientId}`;
    const now = new Date().toISOString();
    const current = await db.prepare('SELECT user_id, identity_id FROM auth_identities WHERE issuer = ? AND subject = ?').bind(TEAM_DOMAIN, subject).first<{ user_id: string; identity_id: string }>();
    const identityId = `idn_${crypto.randomUUID().replace(/-/g, '')}`;
    const audit = (userId: string, action: string, outcome: string, detail: Record<string, unknown>) =>
      db.prepare("INSERT INTO account_audit (user_id, audit_id, action, surface, grant_ref, idempotency_key, outcome, detail_json, created_at) VALUES (?, ?, ?, 'deploy', NULL, NULL, ?, ?, ?)").bind(userId, `aud_${crypto.randomUUID().replace(/-/g, '')}`, action, outcome, JSON.stringify({ ...detail, kind: 'access_service_token', tokenName: SIM_TOKEN_NAME, by: 'tests/simulation/scripts/setup-dev.ts' }), now);
    const stmts = [];
    if (current) {
      stmts.push(db.prepare('UPDATE auth_identities SET subject = ?, unlinked_at = ? WHERE user_id = ? AND identity_id = ?').bind(`${subject}#retired-${runLabel}`, now, current.user_id, current.identity_id));
      stmts.push(audit(current.user_id, 'identity_unlinked', 'unlinked', { identityId: current.identity_id, reason: 'moved to a new simulation owner' }));
    }
    stmts.push(db.prepare('INSERT INTO auth_identities (user_id, identity_id, issuer, subject, email, linked_at) VALUES (?, ?, ?, ?, NULL, ?)').bind(seeded.userId, identityId, TEAM_DOMAIN, subject, now));
    stmts.push(audit(seeded.userId, 'identity_linked', 'linked', { identityId, relinked: false }));
    await db.batch(stmts);
    const state: SimOwnerState = { userId: seeded.userId, runLabel, budgetUsd, preparedAt: now, garments: seeded.garments, units: seeded.units, profileMatchesSpec: seeded.profileMatchesSpec };
    writeState(SIM_OWNER_STATE, state);
    console.log(`Linked ${SIM_TOKEN_NAME} to the simulation owner (audited); app model budget capped at $${budgetUsd}. Run: npx tsx tests/simulation/src/run.ts --target dev`);
  } finally {
    await proxy.dispose();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
