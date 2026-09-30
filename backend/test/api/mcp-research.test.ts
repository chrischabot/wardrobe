import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fake, resetFake } from '../helpers/assistant.js';
import { apiOwner, installApiScenario } from '../helpers/api.js';
import { connectMcp, mcpGrant } from '../helpers/mcp.js';

/**
 * Simulation defect D3: garderobe_research kind=topic came back `running` with no answer and no hint
 * how to get it. Driven by the real MCP SDK client over HTTP on both protocol revisions, with the
 * deterministic fake model standing in for the research model (FakeModelTransport, with a delay for
 * the slow case).
 */

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { type: string; text?: string }[] };

const ANSWER = 'Oxford cloth button-down: a basketweave oxford, soft unlined collar with a long point and a roll from the buttons.';

describe.each(['modern', 'legacy'] as const)('garderobe_research topic answers or says how to get the answer (%s)', (mode) => {
  let token: string;
  beforeAll(async () => {
    installApiScenario({ now: '2026-10-06T05:30:00.000Z', scenario: 'mild' });
    const owner = await apiOwner();
    token = (await mcpGrant(owner.assertion, 'claude', ['wardrobe:read'])).accessToken;
  });
  beforeEach(() => {
    resetFake();
    fake.respondWith((call) => (call.lastUserText.includes('OCBD') ? { text: ANSWER } : undefined));
  });

  it('a topic that finishes within the call returns the answer itself', async () => {
    const c = await connectMcp(token, { mode });
    const res = (await c.client.callTool({ name: 'garderobe_research', arguments: { kind: 'topic', question: 'What makes a proper Ivy OCBD collar roll?' } })) as ToolResult;
    await c.close();
    expect(res.isError, res.content[0]?.text).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ kind: 'topic', status: 'answered', result: { answer: ANSWER } });
    expect(res.content[0]!.text).toContain(ANSWER);
  });

  it('a slow topic returns the run id with an explicit garderobe_run step, and that step returns the answer', async () => {
    fake.delayMs = 2500;
    const c = await connectMcp(token, { mode });
    const res = (await c.client.callTool({ name: 'garderobe_research', arguments: { kind: 'topic', question: 'Where did the OCBD collar roll come from?', waitSeconds: 0 } })) as ToolResult;
    expect(res.isError, res.content[0]?.text).toBeFalsy();
    const out = res.structuredContent as { status: string; runId: string; next: { tool: string; arguments: { runId: string; action: string }; instruction: string } };
    expect(out.status).toBe('running');
    expect(out.next).toMatchObject({ tool: 'garderobe_run', arguments: { runId: out.runId, action: 'status' } });
    // The text a model reads names the tool and the exact arguments.
    expect(res.content[0]!.text).toContain('garderobe_run');
    expect(res.content[0]!.text).toContain(`"runId":"${out.runId}"`);

    // Following the step exactly as given leads to the answer.
    let run: ToolResult | null = null;
    for (let i = 0; i < 60; i++) {
      run = (await c.client.callTool({ name: out.next.tool, arguments: out.next.arguments })) as ToolResult;
      if (run.structuredContent?.status === 'finished') break;
      expect(run.content[0]!.text).toContain('garderobe_run'); // still-running text keeps the hint
      await new Promise((r) => setTimeout(r, 200));
    }
    await c.close();
    expect(run!.structuredContent?.status).toBe('finished');
    expect(run!.content[0]!.text).toContain(ANSWER);
  });
});
