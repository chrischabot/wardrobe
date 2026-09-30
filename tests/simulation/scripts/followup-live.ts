/**
 * Targeted follow-up checks on the live dev deployment (or local), on the current simulation owner,
 * for the fixes of defects D3 and D5 found by the 28-day run (FINDINGS.md). Run it after
 * `run.ts --target dev --seed 20261005 --limit-days 10` on the same owner; it continues at 20:00 on
 * day 10 of that plan.
 *
 *   npx tsx tests/simulation/scripts/followup-live.ts --target dev [--out tests/simulation/reports]
 *
 *  - D3: garderobe_research kind=topic over the real MCP client; when it returns status running, the
 *    `next` step (garderobe_run) is followed until the answer arrives.
 *  - D5: garderobe_inventory view=resolve "Paraboot boots" (a choice of the owner's Paraboots, not
 *    not_found); then the owner's healing statement through garderobe_ask, and the receipt summary
 *    of the lift must show his words within its first 200 characters.
 *  - The app-side spend cap as the deployed Worker reads it (the hook's audit route), with every
 *    model run of these turns.
 * Writes <out>/followup-<target>.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScenario } from '../src/scenario.js';
import { SIM_HEADER } from '../src/sim-state.js';
import { http, McpSession, oauthGrant, resolveTarget, type ToolResult } from '../src/target.js';
import { World } from '../src/world.js';

const simDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const at = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const kind = (at('--target') ?? 'dev') as 'local' | 'dev';
const out = at('--out') ?? join(simDir, 'reports');
const target = resolveTarget(kind);
const scenario = buildScenario(20261005);
const world = new World(scenario, target.userId, target.simSecret);
const sc = (r: ToolResult) => (r.structuredContent ?? {}) as Record<string, any>;
const textOf = (r: ToolResult) => r.content.map((c) => c.text ?? '').join(' ');
const startedAt = new Date().toISOString();
const tag = Date.now().toString(36);

await world.at(10, '20:00');
const mcp = new McpSession(target, await oauthGrant(target, () => world.header()), () => world.header(), () => ({ action: 'accept', content: { choice: 'confirm' } }));
await mcp.connect();
const report: Record<string, unknown> = { target: kind, startedAt, simulationOwner: target.userId, simulatedAt: world.now };

// ------------------------------------------------------------------ D3: research topic and its next step
{
  const question = 'What distinguishes an Ivy-style oxford cloth button-down from a modern business shirt, and how should the collar roll?';
  const t0 = Date.now();
  const r = await mcp.tool('garderobe_research', { kind: 'topic', question });
  const s = sc(r);
  const d3: Record<string, unknown> = { question, first: { status: s.status, runId: s.runId, next: s.next ?? null, answer: (s.result as { answer?: string } | undefined)?.answer ?? null, text: textOf(r).slice(0, 600), isError: Boolean(r.isError) } };
  if (s.status === 'running' && s.next?.tool === 'garderobe_run') {
    const polls: unknown[] = [];
    for (let i = 0; i < 16; i++) {
      await new Promise((res) => setTimeout(res, 15_000));
      const rr = await mcp.tool('garderobe_run', s.next.arguments);
      const rs = sc(rr) as { status?: string; message?: { parts?: { type: string; text?: string }[] } | null };
      polls.push({ status: rs.status, text: textOf(rr).slice(0, 200) });
      if (rs.status === 'finished' || rs.status === 'failed' || rs.status === 'cancelled') {
        d3.followed = { status: rs.status, answer: (rs.message?.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n') };
        break;
      }
    }
    d3.polls = polls;
  }
  const answer = (d3.first as { answer: string | null }).answer ?? (d3.followed as { answer?: string } | undefined)?.answer ?? null;
  d3.ms = Date.now() - t0;
  d3.pass = Boolean(answer && answer.length > 100) && (s.status === 'answered' || (s.status === 'running' && Boolean(s.next) && Boolean(d3.followed)));
  report.d3 = d3;
  console.log(`D3: first ${String(s.status)}${s.next ? ' with next' : ''}; ${d3.followed ? `followed next -> ${(d3.followed as { status: string }).status}` : 'no follow needed'}; answer ${answer ? `${answer.length} chars` : 'none'}; pass=${d3.pass}`);
}

// ------------------------------------------------------------------ D5a: "Paraboot boots" resolves to a choice
{
  const r = await mcp.tool('garderobe_inventory', { view: 'resolve', phrase: 'Paraboot boots' });
  const res = sc(r).resolution as { status: string; candidates?: { name: string; distinguishing: string }[]; name?: string } | null;
  const pass = res?.status === 'ambiguous' && (res.candidates ?? []).length >= 2 && (res.candidates ?? []).every((c) => /paraboot/i.test(`${c.name} ${c.distinguishing}`));
  report.d5Resolve = { phrase: 'Paraboot boots', resolution: res, pass };
  console.log(`D5 resolve: ${res?.status} ${(res?.candidates ?? []).map((c) => c.name).join(' | ')} pass=${pass}`);
}

// ------------------------------------------------------------------ D5b: healing statement and the lift receipt
{
  const words = 'My feet have fully healed now, so I can wear my welted shoes and boots again.';
  const clientTurnId = `followup-${tag}-healed`;
  let r = await mcp.tool('garderobe_ask', { text: words, clientTurnId, waitSeconds: 50 });
  for (let i = 0; !r.isError && sc(r).status === 'running' && i < 12; i++) {
    await new Promise((res) => setTimeout(res, 15_000));
    r = await mcp.tool('garderobe_ask', { text: words, clientTurnId, waitSeconds: 50 });
  }
  const s = sc(r);
  const receipts = ((s.receipts ?? []) as { commandType?: string; type?: string; outcome: string; summary: string }[]).map((x) => ({ type: x.commandType ?? x.type ?? null, outcome: x.outcome, summary: x.summary }));
  const lift = receipts.find((x) => /lift/i.test(`${x.type} ${x.summary}`) && x.outcome === 'committed');
  const pass = Boolean(lift && lift.summary.slice(0, 200).includes('My feet have fully healed'));
  report.d5Healing = { words, clientTurnId, status: s.status, answer: s.answer ?? null, receipts, liftSummaryFirst200: lift?.summary.slice(0, 200) ?? null, pass };
  console.log(`D5 healing: ${s.status}; lift receipt ${lift ? 'committed' : 'missing'}; first 200: ${lift?.summary.slice(0, 200) ?? '-'}; pass=${pass}`);
}

await mcp.close();

// ------------------------------------------------------------------ spend cap and model runs (hook audit route)
{
  const a = await http(`${target.appOrigin}/__sim/audit`, { method: 'POST', headers: { ...(await target.appHeaders()), [SIM_HEADER]: await world.header(), 'content-type': 'application/json' }, body: JSON.stringify({ since: '1970-01-01T00:00:00.000Z' }) });
  if (a.status === 200) {
    const turns = a.body.turns as { turn_id: string; client_turn_id: string }[];
    const mine = new Set(turns.filter((t) => t.client_turn_id.startsWith(`followup-${tag}`)).map((t) => `turn:${t.turn_id}`));
    report.spendCap = a.body.spendCap;
    report.ownerSpendUsd = (a.body.ownerSpendMicroUsd ?? 0) / 1e6;
    report.followupModelRuns = (a.body.modelRuns as { run_ref: string | null; created_at: string }[]).filter((x) => (x.run_ref && mine.has(x.run_ref)) || x.created_at >= world.now.slice(0, 10));
    console.log(`Spend cap as read by the deployed Worker: ${JSON.stringify(a.body.spendCap)}; simulation owner spend $${(report.ownerSpendUsd as number).toFixed(4)}`);
  } else report.auditError = `HTTP ${a.status} ${a.text.slice(0, 200)}`;
}

report.finishedAt = new Date().toISOString();
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `followup-${kind}.json`), JSON.stringify(report, null, 2) + '\n');
console.log(`Wrote ${join(out, `followup-${kind}.json`)}`);
