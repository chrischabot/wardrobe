/**
 * Status of runs the simulation started (for example background research), read over MCP as the simulation owner.
 *   npx tsx tests/simulation/scripts/run-status.ts --target dev <runId> [...]
 */
import { buildScenario } from '../src/scenario.js';
import { McpSession, oauthGrant, resolveTarget } from '../src/target.js';
import { World } from '../src/world.js';

const args = process.argv.slice(2);
const kind = (args[args.indexOf('--target') + 1] ?? 'dev') as 'local' | 'dev';
const ids = args.filter((a) => a.startsWith('run_'));
const target = resolveTarget(kind);
const world = new World(buildScenario(20261005), target.userId, target.simSecret);
await world.at(27, '22:00');
const mcp = new McpSession(target, await oauthGrant(target, () => world.header()), () => world.header(), () => ({ action: 'decline' }));
for (const runId of ids) {
  const r = await mcp.tool('garderobe_run', { runId, action: 'status' });
  const s = (r.structuredContent ?? {}) as Record<string, unknown>;
  console.log(runId, JSON.stringify({ status: s.status, kind: s.kind, message: typeof s.message === 'string' ? s.message.slice(0, 300) : s.message, updatedAt: s.updatedAt, error: r.isError ? r.content.map((c) => c.text).join(' ').slice(0, 300) : undefined }));
}
await mcp.close();
