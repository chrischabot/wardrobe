/**
 * Live routing and name-matching check (follow-up to D2 and D5, FINDINGS.md). A handful of real
 * assistant turns on the current simulation owner, each with the model the app ledger recorded for it.
 *
 *   npx tsx tests/simulation/scripts/routing-live.ts --target dev [--out tests/simulation/reports/followup]
 *
 * Expected: the routine board question quoting the "Design review" calendar title runs on the chat
 * chain (gpt-6.1-sol); product-review requests run on the deep chain (Claude Opus 5.5 medium);
 * "Paraboot boots" resolves to a choice of the owner's Paraboots. Writes <out>/routing-<target>.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScenario } from '../src/scenario.js';
import { SIM_HEADER } from '../src/sim-state.js';
import { http, McpSession, oauthGrant, resolveTarget, type ToolResult } from '../src/target.js';
import { World } from '../src/world.js';

const args = process.argv.slice(2);
const at = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const kind = (at('--target') ?? 'dev') as 'local' | 'dev';
const out = at('--out') ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'reports', 'followup');
const target = resolveTarget(kind);
const world = new World(buildScenario(20261005), target.userId, target.simSecret);
const sc = (r: ToolResult) => (r.structuredContent ?? {}) as Record<string, any>;
const tag = Date.now().toString(36);

const TURNS: { label: string; text: string; expected: 'routine' | 'deep' }[] = [
  { label: 'design_review_routine', text: 'I have "Design review" today. Which of this morning\u2019s outfits would you pick, and why? Two sentences.', expected: 'routine' },
  { label: 'review_this_jacket', text: 'Can you review this jacket: the Drake\u2019s Waxed Chasseur? Two sentences.', expected: 'deep' },
  { label: 'paraboot_reviews', text: 'Paraboot reviews: what do people generally say? Two sentences.', expected: 'deep' },
];

await world.at(1, '07:05');
const mcp = new McpSession(target, await oauthGrant(target, () => world.header()), () => world.header(), () => ({ action: 'decline' }));
await mcp.connect();
const report: Record<string, unknown> = { target: kind, startedAt: new Date().toISOString(), simulationOwner: target.userId, simulatedAt: world.now };

const turns: (Record<string, unknown> & { label: string; expected: 'routine' | 'deep'; clientTurnId: string })[] = [];
for (const t of TURNS) {
  const clientTurnId = `routing-${tag}-${t.label}`;
  let r = await mcp.tool('garderobe_ask', { text: t.text, clientTurnId, waitSeconds: 50 });
  for (let i = 0; !r.isError && sc(r).status === 'running' && i < 8; i++) {
    await new Promise((res) => setTimeout(res, 15_000));
    r = await mcp.tool('garderobe_ask', { text: t.text, clientTurnId, waitSeconds: 50 });
  }
  turns.push({ ...t, clientTurnId, status: sc(r).status, answer: sc(r).answer ?? null, error: r.isError ? r.content.map((c) => c.text).join(' ').slice(0, 300) : undefined });
}
const resolve = sc(await mcp.tool('garderobe_inventory', { view: 'resolve', phrase: 'Paraboot boots' })).resolution as { status: string; candidates?: { name: string; distinguishing: string }[] } | null;
await mcp.close();

const audit = await http(`${target.appOrigin}/__sim/audit`, { method: 'POST', headers: { ...(await target.appHeaders()), [SIM_HEADER]: await world.header(), 'content-type': 'application/json' }, body: JSON.stringify({ since: '1970-01-01T00:00:00.000Z' }) });
const dbTurns = (audit.body?.turns ?? []) as { turn_id: string; client_turn_id: string }[];
const runs = (audit.body?.modelRuns ?? []) as { run_ref: string | null; task: string; profile_id: string; model: string; input_tokens: number | null; output_tokens: number | null; actual_micro_usd: number | null; status: string }[];
for (const t of turns) {
  const row = dbTurns.find((x) => x.client_turn_id === t.clientTurnId);
  const mine = runs.filter((x) => row && x.run_ref === `turn:${row.turn_id}`);
  const chain = mine.filter((x) => x.task === 'chat' || x.task === 'research');
  const depth = chain.some((x) => x.task === 'research') ? 'deep' : chain.length ? 'routine' : 'none';
  Object.assign(t, { models: mine.map((x) => ({ task: x.task, profileId: x.profile_id, model: x.model, inputTokens: x.input_tokens, outputTokens: x.output_tokens, costUsd: (x.actual_micro_usd ?? 0) / 1e6, status: x.status })), routedDepth: depth, pass: depth === t.expected && chain.every((x) => (t.expected === 'deep' ? x.model === 'claude-opus-5-5' : x.model === 'gpt-6.1-sol')) });
  console.log(`${String(t.label).padEnd(24)} expected ${t.expected.padEnd(7)} routed ${depth.padEnd(7)} ${[...new Set(chain.map((x) => x.model))].join('+')} $${mine.reduce((s, x) => s + (x.actual_micro_usd ?? 0), 0) / 1e6} pass=${t.pass}`);
}
const paraPass = resolve?.status === 'ambiguous' && (resolve.candidates ?? []).length >= 2 && (resolve.candidates ?? []).every((c) => /paraboot/i.test(`${c.name} ${c.distinguishing}`));
console.log(`Paraboot boots: ${resolve?.status} ${(resolve?.candidates ?? []).map((c) => c.name).join(' | ')} pass=${paraPass}`);
Object.assign(report, { turns, paraboot: { phrase: 'Paraboot boots', resolution: resolve, pass: paraPass }, spendCap: audit.body?.spendCap ?? null, ownerSpendUsd: (audit.body?.ownerSpendMicroUsd ?? 0) / 1e6, finishedAt: new Date().toISOString() });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `routing-${kind}.json`), JSON.stringify(report, null, 2) + '\n');
console.log(`Spend cap ${JSON.stringify(audit.body?.spendCap)}; owner spend $${report.ownerSpendUsd}`);
