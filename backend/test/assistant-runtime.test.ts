import { describe, expect, it } from 'vitest';
import { OWNER_SOURCES, newOwner } from './helpers/fixtures.js';
import { assistantFor, chatCalls, converse, fake, resetFake } from './helpers/assistant.js';

describe('assistant runtime on @cloudflare/think', () => {
  it('runs a turn through the gateway-routed model service with the full profile', async () => {
    const owner = await newOwner();
    const a = await assistantFor(owner.userId);
    resetFake();
    const { turn } = await converse(a, 'What socks go with the walnut chinos?');
    expect(turn?.status).toBe('completed');
    const calls = chatCalls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.system).toContain(OWNER_SOURCES.profileText);
    expect(fake.calls[0]!.meta.gatewayId).toBeTruthy();
  });
});
