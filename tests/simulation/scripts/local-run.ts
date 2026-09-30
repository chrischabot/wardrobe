/**
 * One-command local comparison run: fresh local state and simulation owner (setup-local.ts), the
 * local Worker (`wrangler dev --local` with the simulation entry), the simulation, then shutdown.
 *
 *   npx tsx tests/simulation/scripts/local-run.ts [--port 8799] [run.ts options, e.g. --seed 20261005]
 */
import { execFileSync, spawn } from 'node:child_process';
import { openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const simDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = join(simDir, '..', '..');
const bin = (n: string) => join(rootDir, 'node_modules', '.bin', n);
const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const port = portIdx >= 0 ? args[portIdx + 1]! : '8799';
const runArgs = portIdx >= 0 ? [...args.slice(0, portIdx), ...args.slice(portIdx + 2)] : args;
const workDir = process.env.GARDEROBE_SIM_WORKDIR ?? join(tmpdir(), 'garderobe-simulation');

execFileSync(bin('tsx'), [join(simDir, 'scripts', 'setup-local.ts'), '--port', port], { stdio: 'inherit', cwd: rootDir });
const target = JSON.parse(readFileSync(join(workDir, 'local-target.json'), 'utf8')) as { configPath: string; statePath: string };
const log = openSync(join(workDir, 'wrangler-dev.log'), 'w');
const worker = spawn(bin('wrangler'), ['dev', '--local', '--port', port, '--ip', '127.0.0.1', '-c', target.configPath, '--persist-to', target.statePath], { cwd: rootDir, stdio: ['ignore', log, log], detached: true, env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
const stop = () => {
  try {
    process.kill(-worker.pid!, 'SIGTERM');
  } catch {
    /* already gone */
  }
};
process.on('exit', stop);

async function main(): Promise<number> {
  for (let i = 0; i < 90; i++) {
    const ok = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false);
    if (ok) break;
    if (i === 89) throw new Error(`The local Worker did not start; see ${join(workDir, 'wrangler-dev.log')}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const child = spawn(bin('tsx'), [join(simDir, 'src', 'run.ts'), '--target', 'local', ...runArgs], { cwd: rootDir, stdio: 'inherit' });
  return new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 1)));
}

main()
  .then((code) => {
    stop();
    process.exit(code);
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    stop();
    process.exit(1);
  });
