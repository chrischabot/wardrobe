/**
 * Tears down every Garderobe dev resource, and nothing else. Every deletion is by the exact dev name
 * or id recorded in deploy/dev-resources.json; the existing "owner only" Access policy, the
 * garderobe-dev AI Gateway (pre-existing, owner-created) and all non-dev resources are left alone.
 *
 *   npm run teardown:dev              # dry run: lists what would be deleted
 *   npm run teardown:dev -- --yes     # deletes
 *
 * Order: Worker (custom domains and queue consumer go with it) -> Access applications -> service-token
 * policy -> service tokens -> queues -> KV -> AI Search instance -> R2 (emptied first) -> D1.
 */
import { accountId, cf, CfError, configPath, NAMES, readResources, wrangler } from './lib.js';

export async function teardown(args: string[]): Promise<void> {
  const yes = args.includes('--yes');
  const r = readResources();
  const A = `/accounts/${accountId()}`;
  const steps: { what: string; run: () => Promise<unknown> }[] = [
    { what: `Worker ${NAMES.worker} (with its custom domains ${NAMES.appHost}, ${NAMES.mcpHost}, its Durable Object data and workflow binding)`, run: async () => wrangler(['delete', '--config', configPath, '--force'], { allowFail: true }) },
    { what: `Workflow ${NAMES.workflow}`, run: async () => wrangler(['workflows', 'delete', NAMES.workflow], { allowFail: true }) },
    { what: `Access application ${r.access.appApplication.name}`, run: () => cf('DELETE', `${A}/access/apps/${r.access.appApplication.id}`) },
    { what: `Access application ${r.access.mcpConsentApplication.name}`, run: () => cf('DELETE', `${A}/access/apps/${r.access.mcpConsentApplication.id}`) },
    { what: `Access policy ${r.access.serviceTokenPolicy.name}`, run: () => cf('DELETE', `${A}/access/policies/${r.access.serviceTokenPolicy.id}`) },
    { what: `Access service token ${r.access.serviceToken.name}`, run: () => cf('DELETE', `${A}/access/service_tokens/${r.access.serviceToken.id}`) },
    ...(r.access.serviceTokenB ? [{ what: `Access service token ${r.access.serviceTokenB.name}`, run: () => cf('DELETE', `${A}/access/service_tokens/${r.access.serviceTokenB!.id}`) }] : []),
    ...r.queues.map((q) => ({ what: `Queue ${q.name}`, run: () => cf('DELETE', `${A}/queues/${q.id}`) })),
    { what: `KV ${r.kv.oauth.title}`, run: () => cf('DELETE', `${A}/storage/kv/namespaces/${r.kv.oauth.id}`) },
    { what: `KV ${r.kv.cache.title}`, run: () => cf('DELETE', `${A}/storage/kv/namespaces/${r.kv.cache.id}`) },
    { what: `AI Search instance ${r.aiSearch.name}`, run: () => cf('DELETE', `${A}/ai-search/instances/${r.aiSearch.name}`) },
    {
      what: `R2 bucket ${r.r2.name} (objects deleted first)`,
      run: async () => {
        for (let i = 0; i < 100; i++) {
          const page = await cf<{ key: string }[]>('GET', `${A}/r2/buckets/${r.r2.name}/objects?per_page=1000`, undefined, 'CLOUDFLARE_R2_API_TOKEN');
          if (!page.length) break;
          for (const o of page) await cf('DELETE', `${A}/r2/buckets/${r.r2.name}/objects/${encodeURIComponent(o.key)}`, undefined, 'CLOUDFLARE_R2_API_TOKEN');
        }
        return cf('DELETE', `${A}/r2/buckets/${r.r2.name}`);
      },
    },
    { what: `D1 ${r.d1.name} (${r.d1.id})`, run: () => cf('DELETE', `${A}/d1/database/${r.d1.id}`) },
  ];
  console.log(`${yes ? 'Deleting' : 'Would delete (dry run; add --yes)'}:`);
  for (const s of steps) {
    if (!yes) {
      console.log(`  - ${s.what}`);
      continue;
    }
    try {
      await s.run();
      console.log(`  deleted: ${s.what}`);
    } catch (err) {
      console.log(`  ${err instanceof CfError && err.status === 404 ? 'already gone' : 'FAILED'}: ${s.what}${err instanceof CfError && err.status === 404 ? '' : ` (${err instanceof Error ? err.message : String(err)})`}`);
    }
  }
  console.log('Kept: the garderobe-dev AI Gateway, the "owner only" Access policy, and every non-dev resource.');
}
