/**
 * Garderobe dev deployment CLI. Run from garderobe/ (see deploy/README.md):
 *
 *   npm run deploy:dev              # provision (idempotent) + migrate + secrets + deploy: the one command
 *   npm run dev:provision           # account resources and Access only
 *   npm run dev:seed                # owner profile + May 2026 CSV + owner-asserted additions into dev D1/R2
 *   npm run dev:probe -- <name>     # real-platform probes (models, d1, queue, workflow, ai-search, r2, do, import-race, all)
 *   npm run dev:verify              # auth, isolation, idempotency, profile constraints, MCP over HTTPS
 *   npm run dev:measure             # usage from platform analytics
 *   npm run teardown:dev            # delete every dev resource (asks for --yes)
 */
const [cmd, ...args] = process.argv.slice(2);

const commands: Record<string, () => Promise<unknown>> = {
  provision: async () => (await import('./provision.js')).provision(),
  deploy: async () => (await import('./deploy.js')).deploy({ provisionFirst: !args.includes('--no-provision') }),
  seed: async () => {
    const m = await import('./seed.js');
    if (args[0] === 'link' || args[0] === 'unlink') return m.linkServiceToken(args[0], args[1] === 'b' ? 'b' : 'owner');
    return m.seed({ withTestEvents: !args.includes('--no-test-events') });
  },
  probe: async () => (await import('./probe.js')).probe(args),
  verify: async () => (await import('./verify.js')).verify(args),
  measure: async () => (await import('./measure.js')).measure(args),
  teardown: async () => (await import('./teardown.js')).teardown(args),
};

if (!cmd || !commands[cmd]) {
  console.error(`Usage: tsx deploy/scripts/dev.ts <${Object.keys(commands).join('|')}>`);
  process.exit(2);
}
try {
  await commands[cmd]!();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

export {};
