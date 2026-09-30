/**
 * AI Gateway spend on garderobe-dev from Cloudflare's own analytics (GraphQL Analytics API), and the
 * gateway's spend rule (read-only). Used before the live run (remaining budget) and after it (spend
 * per model during the run).
 *
 *   npx tsx tests/simulation/scripts/spend.ts [--since <ISO>] [--until <ISO>] [--json]
 *
 * Default window: the last 30 days (the spend rule's sliding window). Needs CLOUDFLARE_ACCOUNT_ID,
 * CLOUDFLARE_LOGS_API_TOKEN (analytics) and CLOUDFLARE_API_TOKEN (gateway settings).
 */
import { accountId, cf, graphql, NAMES } from '../../../deploy/scripts/lib.js';

export interface ModelSpend {
  model: string;
  provider: string;
  requests: number;
  erroredRequests: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface SpendReport {
  window: { since: string; until: string };
  totalUsd: number;
  byModel: ModelSpend[];
  rule: { limitUsd: number | null; window: string | null; raw: unknown };
}

export async function gatewaySpend(since: Date, until: Date = new Date()): Promise<SpendReport> {
  const data = await graphql<{ viewer: { accounts: { aiGatewayRequestsAdaptiveGroups: { count: number; sum: { cost: number; erroredRequests: number; uncachedTokensIn: number; uncachedTokensOut: number }; dimensions: { model: string; provider: string } }[] }[] } }>(
    `query($acct: string!, $since: Time!, $until: Time!) { viewer { accounts(filter: {accountTag: $acct}) {
      aiGatewayRequestsAdaptiveGroups(limit: 200, filter: {gateway: "${NAMES.gateway}", datetime_geq: $since, datetime_leq: $until}) { count sum { cost erroredRequests uncachedTokensIn uncachedTokensOut } dimensions { model provider } }
    } } }`,
    { acct: accountId(), since: since.toISOString(), until: until.toISOString() },
  );
  const groups = data.viewer.accounts[0]?.aiGatewayRequestsAdaptiveGroups ?? [];
  const byModel = groups
    .map((g) => ({ model: g.dimensions.model, provider: g.dimensions.provider, requests: g.count, erroredRequests: g.sum.erroredRequests, tokensIn: g.sum.uncachedTokensIn, tokensOut: g.sum.uncachedTokensOut, costUsd: Math.round(g.sum.cost * 1e6) / 1e6 }))
    .sort((a, b) => b.costUsd - a.costUsd);
  let rule: SpendReport['rule'] = { limitUsd: null, window: null, raw: null };
  try {
    const g = await cf<{ spend_limits?: { rules?: { limit?: number; window?: unknown; period?: unknown }[] } }>('GET', `/accounts/${accountId()}/ai-gateway/gateways/${NAMES.gateway}`);
    const r = g.spend_limits?.rules?.[0];
    rule = { limitUsd: typeof r?.limit === 'number' ? r.limit : null, window: r ? JSON.stringify(r.window ?? r.period ?? null) : null, raw: g.spend_limits ?? null };
  } catch (err) {
    rule = { limitUsd: null, window: null, raw: `unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { window: { since: since.toISOString(), until: until.toISOString() }, totalUsd: Math.round(byModel.reduce((s, m) => s + m.costUsd, 0) * 1e6) / 1e6, byModel, rule };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const at = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const since = at('--since') ? new Date(at('--since')!) : new Date(Date.now() - 30 * 86_400_000);
  const until = at('--until') ? new Date(at('--until')!) : new Date();
  const r = await gatewaySpend(since, until);
  if (args.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(`garderobe-dev gateway spend ${r.window.since} .. ${r.window.until}: $${r.totalUsd.toFixed(4)}; spend rule ${r.rule.limitUsd ?? 'unknown'} USD (${r.rule.window ?? 'window unknown'})`);
  for (const m of r.byModel) console.log(`  ${m.provider}/${m.model}: ${m.requests} requests (${m.erroredRequests} errored), ${m.tokensIn} in / ${m.tokensOut} out, $${m.costUsd.toFixed(4)}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
