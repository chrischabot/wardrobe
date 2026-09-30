/**
 * Prepares the local comparison run: a fresh local D1/R2/KV state directory, the local Worker config
 * (the product entry wrapped by the simulation hook, tests/simulation/worker/local-entry.ts), a local
 * Access signing key (the same stand-in as backend/scripts/dev-auth.ts), DEV_SIM_SECRET, every
 * migration, and a fresh simulation owner seeded with the owner's real profile and wardrobe.
 *
 *   npx tsx tests/simulation/scripts/setup-local.ts [--port 8799]
 *   then: npx wrangler dev --local --port 8799 -c <workdir>/wrangler.sim-local.json --persist-to <workdir>/state
 *
 * The work directory is GARDEROBE_SIM_WORKDIR or <os tmpdir>/garderobe-simulation (never the repo).
 * The local assistant has no AI Gateway account, so it uses the product's deterministic fake model.
 */
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import { seedSimulationOwner } from '../src/seed-owner.js';

const simDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = join(simDir, '..', '..');
const backendDir = join(rootDir, 'backend');
export const workDir = process.env.GARDEROBE_SIM_WORKDIR ?? join(tmpdir(), 'garderobe-simulation');
export const localTargetFile = join(workDir, 'local-target.json');

export interface LocalTarget {
  kind: 'local';
  baseUrl: string;
  simSecret: string;
  accessKeyFile: string;
  issuer: string;
  audience: string;
  subject: string;
  userId: string;
  configPath: string;
  statePath: string;
  preparedAt: string;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const port = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 8799);
  const baseUrl = `http://localhost:${port}`;
  const statePath = join(workDir, 'state');
  rmSync(statePath, { recursive: true, force: true });
  mkdirSync(statePath, { recursive: true });

  const base = JSON.parse(readFileSync(join(backendDir, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, '')) as Record<string, any>;
  const config = {
    ...base,
    name: 'garderobe-simulation-local',
    main: join(simDir, 'worker', 'local-entry.ts'),
    d1_databases: base.d1_databases.map((d: Record<string, unknown>) => ({ ...d, migrations_dir: join(backendDir, 'migrations') })),
    vars: { ...base.vars, ENVIRONMENT: 'local', APP_ORIGIN: baseUrl, MCP_ORIGIN: baseUrl, APP_HOSTNAMES: 'localhost,127.0.0.1' },
  };
  const configPath = join(workDir, 'wrangler.sim-local.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const accessKeyFile = join(workDir, 'access-key.json');
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeFileSync(accessKeyFile, JSON.stringify({ ...privateKey.export({ format: 'jwk' }), kid: 'sim-local-access', alg: 'RS256' }), { mode: 0o600 });
  const jwks = JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'sim-local-access', alg: 'RS256', use: 'sig' }] });
  const secretValue = () => Buffer.from(randomBytes(32)).toString('base64url' as BufferEncoding);
  const simSecret = secretValue();
  writeFileSync(
    join(workDir, '.dev.vars'),
    [`ACCESS_JWKS_JSON='${jwks}'`, `DEV_SIM_SECRET=${simSecret}`, `MCP_STATE_SECRET=${secretValue()}`, `MEDIA_URL_SIGNING_KEY=${secretValue()}`].join('\n') + '\n',
    { mode: 0o600 },
  );

  console.log('Applying every migration to the fresh local D1...');
  execFileSync(join(rootDir, 'node_modules', '.bin', 'wrangler'), ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', statePath, '-c', configPath], { cwd: workDir, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });

  const subject = `simulation-owner-${Date.now().toString(36)}`;
  // wrangler dev/d1 --persist-to <dir> keep their state in <dir>/v3; getPlatformProxy takes that directory itself.
  const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath, persist: { path: join(statePath, 'v3') } });
  try {
    const seeded = await seedSimulationOwner(proxy.env.DB, join(rootDir, 'data'), { displayName: 'Chris (simulation)', runLabel: subject, identity: { issuer: config.vars.ACCESS_TEAM_DOMAIN, subject } });
    console.log(`Simulation owner ${seeded.userId}: ${seeded.garments} garments, ${seeded.units} units, ${seeded.rules} rules, profile ${seeded.profileMatchesSpec ? 'matches the spec hash' : 'DIFFERS from the spec hash'}; ${seeded.additionsCreated} owner-asserted additions.`);
    const target: LocalTarget = { kind: 'local', baseUrl, simSecret, accessKeyFile, issuer: config.vars.ACCESS_TEAM_DOMAIN, audience: String(config.vars.ACCESS_AUD).split(',')[0]!, subject, userId: seeded.userId, configPath, statePath, preparedAt: new Date().toISOString() };
    writeFileSync(localTargetFile, JSON.stringify(target, null, 2), { mode: 0o600 });
  } finally {
    await proxy.dispose();
  }
  console.log(`Ready. Start the Worker:\n  npx wrangler dev --local --port ${port} -c ${configPath} --persist-to ${statePath}\nthen run: npx tsx tests/simulation/src/run.ts --target local`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
