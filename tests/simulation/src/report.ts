/** Human-readable report of one simulation run (the JSON next to it has every record). */
import type { AskRecord, DayRecord, RunReport } from './run.js';

function table(head: string[], rows: (string | number)[][]): string {
  const esc = (v: string | number) => String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n');
}

function group(days: DayRecord[], keys: (d: DayRecord) => string[]): (string | number)[][] {
  const m = new Map<string, DayRecord[]>();
  for (const d of days) for (const k of keys(d)) m.set(k, [...(m.get(k) ?? []), d]);
  return [...m.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, ds]) => {
      const asks = ds.flatMap((d) => d.asks);
      return [
        k,
        ds.length,
        ds.filter((d) => d.board?.status === 'published').length,
        ds.reduce((s, d) => s + d.violations.length + d.previews.reduce((x, p) => x + p.violations.length, 0), 0),
        ds.reduce((s, d) => s + d.actions.filter((a) => !a.ok).length, 0),
        asks.length,
        asks.reduce((s, a) => s + (a.violations?.length ?? 0), 0),
        ds.reduce((s, d) => s + d.errors.length, 0),
      ];
    });
}

const CONDITION_HEAD = ['condition', 'days', 'boards published', 'board/preview violations', 'unexpected command outcomes', 'assistant questions', 'assistant violations', 'errors'];

function models(a: AskRecord): string {
  const chat = (a.models ?? []).filter((m) => m.task === 'chat' || m.task === 'research');
  if (!chat.length) return a.models?.length ? a.models.map((m) => `${m.task}:${m.model}`).join(', ') : 'none recorded';
  const by = new Map<string, number>();
  for (const m of chat) by.set(m.model, (by.get(m.model) ?? 0) + 1);
  const cost = (a.models ?? []).reduce((s, m) => s + (m.costUsd ?? 0), 0);
  return `${[...by.entries()].map(([k, n]) => `${k} ×${n}`).join(', ')} ($${cost.toFixed(3)})`;
}

export function renderMarkdown(r: RunReport): string {
  const days = r.days;
  const asks = days.flatMap((d) => d.asks);
  const out: string[] = [];
  out.push(`# Garderobe MCP simulation: ${r.target}, seed ${r.seed}`);
  out.push(`Run ${r.runTag}, ${r.startedAt} to ${r.finishedAt}. Simulated ${days.length} days from ${r.scenario.startDate} (London). Simulation owner ${r.simulationOwner} seeded with the owner's real profile and wardrobe (${r.wardrobe.garments} garments).${r.deployedVersion ? ` Deployed Worker version ${r.deployedVersion}.` : ''}`);
  out.push(`MCP: protocol ${r.mcp.protocol ?? 'unknown'}, ${r.mcp.toolCalls} tool calls (${r.mcp.toolErrors} errors), ${r.mcp.refreshes} OAuth token refreshes.`);
  out.push('## Totals');
  out.push(table(['measure', 'value'], Object.entries(r.totals)));
  out.push('## Results per condition');
  out.push('### Weather');
  out.push(table(CONDITION_HEAD, group(days, (d) => [d.weatherKind])));
  out.push('### Calendar');
  out.push(table(CONDITION_HEAD, group(days, (d) => (d.calendarLabels.length ? d.calendarLabels : ['no events']))));
  out.push('### Circumstances and availability');
  out.push(table(CONDITION_HEAD, group(days, (d) => (d.circumstances.length ? d.circumstances : ['ordinary day']))));
  out.push('## Days');
  out.push(
    table(
      ['#', 'date', 'weather', 'board', 'weather check', 'pick', 'wear', 'actions', 'asks', 'violations'],
      days.map((d) => [d.index, `${d.date} ${d.weekday.slice(0, 3)}`, d.weatherKind, d.board ? `${d.board.status} ${d.board.offerable} (${d.board.purpose ?? 'day'})` : 'none', d.board?.weatherCheck ?? '-', d.selection ? `option ${d.selection.position}${d.selection.footwear ? ` + ${d.selection.footwear}` : ''}: ${d.selection.outcome}` : '-', d.wear?.outcome ?? '-', d.actions.map((a) => `${a.name}: ${a.outcome}`).join('; ') || '-', d.asks.map((a) => `${a.kind}: ${a.status}`).join('; ') || '-', d.violations.length + d.previews.reduce((x, p) => x + p.violations.length, 0)]),
    ),
  );
  const violations = days.flatMap((d) => [...d.violations.map((v) => `${d.date}: ${v}`), ...d.previews.flatMap((p) => p.violations.map((v) => `${d.date} (${p.kind} preview): ${v}`))]);
  out.push('## Board and preview violations');
  out.push(violations.length ? violations.map((v) => `- ${v}`).join('\n') : 'None.');
  const unexpected = days.flatMap((d) => d.actions.filter((a) => !a.ok).map((a) => `${d.date} ${a.at} ${a.name}: ${a.outcome}${a.code ? ` (${a.code})` : ''}${a.detail ? ` — ${a.detail}` : ''} (expected ${a.expected})`));
  out.push('## Unexpected command outcomes');
  out.push(unexpected.length ? unexpected.map((v) => `- ${v}`).join('\n') : 'None.');
  const errors = days.flatMap((d) => d.errors.map((e) => `${d.date}: ${e}`));
  out.push('## Errors');
  out.push(errors.length ? errors.map((v) => `- ${v.slice(0, 500)}`).join('\n') : 'None.');
  out.push('## Assistant turns');
  out.push(
    table(
      ['date', 'sim time', 'kind', 'depth expected', 'status', 'models (chat steps)', 'cards (actionable/rejected)', 'rejected rules', 'violations'],
      asks.map((a) => [a.date, a.simAt.slice(11, 16) + 'Z', a.kind, a.expectedDepth, `${a.status}${a.turnStatus ? `/${a.turnStatus}` : ''}${a.dayFallback ? ' (day FALLBACK)' : ''}`, models(a), `${a.cards?.filter((c) => c.actionable).length ?? 0}/${a.cards?.filter((c) => !c.actionable).length ?? 0}`, [...new Set((a.cards ?? []).flatMap((c) => c.failedRules.map((f) => f.ruleKey)))].join(', ') || '-', a.violations?.length ? a.violations.join('; ') : 0]),
    ),
  );
  out.push('### Questions and answers');
  for (const a of asks) out.push(`- **${a.date} ${a.kind}** — “${a.text}”\n  - ${a.status}: ${(a.answer ?? a.error ?? '(no answer)').replace(/\s+/g, ' ').slice(0, 700)}`);
  if (r.audit) {
    out.push('## Model runs and spend (app ledger)');
    out.push(`${r.audit.turns} assistant turns and ${r.audit.modelRuns} model runs recorded for the simulation owner; app-ledger spend $${r.audit.ownerSpendUsd.toFixed(4)}; ${r.audit.unattributedRuns} runs not attributed to a question (for example compaction or recall indexing).`);
    out.push(table(['task: profile (model)', 'runs', 'input tokens', 'output tokens', 'cost USD (app ledger)', 'failed'], Object.entries(r.audit.runsByModel).map(([k, v]) => [k, v.runs, v.inputTokens, v.outputTokens, v.costUsd.toFixed(4), v.failed])));
  }
  out.push('## Notes');
  out.push(r.notes.length ? r.notes.map((n) => `- ${n}`).join('\n') : 'None.');
  return out.join('\n\n') + '\n';
}
