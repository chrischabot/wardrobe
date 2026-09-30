/**
 * End-to-end MCP check against the running local server with the real MCP SDK client over HTTP.
 *
 *   npm run mcp:smoke --workspace @garderobe/backend              # uses .wrangler/dev-mcp-grant.json
 *   GARDEROBE_MCP_TOKEN=... npm run mcp:smoke --workspace @garderobe/backend -- --legacy
 *
 * Prints the negotiated protocol revision and the tool list, then calls all seven tools with real
 * arguments (garderobe_command saves today's first option as a combination, which is harmless and
 * idempotent per run). Exits non-zero on any tool error.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client-v2-2';

const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const grantFile = join(backendDir, '.wrangler', 'dev-mcp-grant.json');
const url = new URL(process.env.GARDEROBE_MCP_URL ?? 'http://localhost:8787/mcp');
const legacy = process.argv.includes('--legacy');
const token = process.env.GARDEROBE_MCP_TOKEN ?? (existsSync(grantFile) ? (JSON.parse(readFileSync(grantFile, 'utf8')) as { access_token: string }).access_token : '');
if (!token) {
  console.error('No token: run `npm run dev:auth --workspace @garderobe/backend -- mcp-grant` first, or set GARDEROBE_MCP_TOKEN.');
  process.exit(2);
}

type Result = { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown> };

const client = new Client({ name: 'garderobe-mcp-smoke', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } }, versionNegotiation: legacy ? { mode: 'legacy' } : { mode: 'auto' } });
// Confirmation questions (input_required) are answered "confirm" by this smoke client.
client.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: { choice: 'confirm' } }) as never);
await client.connect(new StreamableHTTPClientTransport(url, { authProvider: { token: async () => token } }) as never);
console.log(`Connected to ${url} — protocol ${client.getNegotiatedProtocolVersion()} (${legacy ? 'legacy mode requested' : 'auto negotiation'})`);
const tools = await client.listTools();
console.log(`${tools.tools.length} tools:`);
for (const t of tools.tools) console.log(`  ${t.name}  ${JSON.stringify(t.annotations)}  output=${t.outputSchema ? 'yes' : 'no'}`);

let failures = 0;
async function callTool(name: string, args: Record<string, unknown>): Promise<Result> {
  const r = (await client.callTool({ name, arguments: args })) as Result;
  if (r.isError) {
    failures++;
    console.log(`\n${name}: ERROR ${r.content[0]?.text}`);
  }
  return r;
}
const first = (text: string | undefined, n = 400) => (text ?? '').slice(0, n).replace(/\n+/g, ' | ');

const today = await callTool('garderobe_today', {});
const board = today.structuredContent?.board as { boardId: string; currentRevision: number; options: { optionId: string; slots: { garmentId: string; role: string; alternativeGroup: string | null }[] }[] } | null;
console.log(`\ngarderobe_today: revision ${board?.currentRevision ?? 'none'}, ${board?.options.length ?? 0} options, day line: ${String(today.structuredContent?.dayLine ?? '')}`);

const inv = await callTool('garderobe_inventory', { view: 'snapshot' });
console.log(`garderobe_inventory snapshot: ${String(inv.structuredContent?.total)} garments, complete=${String(inv.structuredContent?.complete)}, counts=${JSON.stringify(inv.structuredContent?.counts)}`);

const rec = await callTool('garderobe_recommend', { count: 3, brief: 'A cool morning, then a long walk' });
const recOpts = (rec.structuredContent?.options as { why: string }[] | undefined) ?? [];
console.log(`garderobe_recommend: ${recOpts.length} validated options; first: ${first(recOpts[0]?.why, 200)}`);

if (board?.options[0]) {
  const slots = board.options[0].slots.map((s) => ({ garmentId: s.garmentId, role: s.role, ...(s.alternativeGroup ? { alternativeGroup: s.alternativeGroup } : {}) }));
  const cmd = await callTool('garderobe_command', { idempotencyKey: `mcp-smoke:${board.boardId}:${board.currentRevision}`, command: { type: 'save_combination', name: 'Saved from the MCP smoke test', slots } });
  const receipt = cmd.structuredContent?.receipt as { outcome: string; replayed: boolean; summary: string } | null;
  console.log(`garderobe_command: status=${String(cmd.structuredContent?.status)} outcome=${receipt?.outcome} replayed=${receipt?.replayed} — ${receipt?.summary}`);
} else {
  console.log('garderobe_command: skipped (no board today; run `dev:auth -- prepare` first)');
}

const ask = await callTool('garderobe_ask', { text: 'Which of today’s outfits suits a cool morning best?', waitSeconds: 30 });
console.log(`garderobe_ask: status=${String(ask.structuredContent?.status)} run=${String(ask.structuredContent?.runId)} answer: ${first(String(ask.structuredContent?.answer ?? ''), 240)}`);

const research = await callTool('garderobe_research', { kind: 'size', maker: "Drake's", category: 'jacket' });
console.log(`garderobe_research (size): status=${String(research.structuredContent?.status)} — ${first(research.content[0]?.text, 200)}`);

const run = await callTool('garderobe_run', { runId: String(ask.structuredContent?.runId ?? 'run_missing') });
console.log(`garderobe_run: ${first(run.content[0]?.text, 200)}`);

await client.close();
if (failures) {
  console.error(`${failures} tool call(s) failed`);
  process.exit(1);
}
console.log('\nAll seven tools called successfully.');
