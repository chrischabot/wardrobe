import { describe, expect, it } from 'vitest';
import { applyRecordedProbes, ModelRegistry } from '../src/models/registry.js';

/** Deployment probe records (MODEL_PROBES) enable only the profiles they name, for their own gateway. */
describe('recorded model probes', () => {
  const at = '2026-09-29T12:00:00.000Z';

  it('without records every candidate stays pending and chat has no selectable profile', () => {
    const r = ModelRegistry.fromEnvironment('dev');
    expect(applyRecordedProbes(r, undefined, 'garderobe-dev')).toEqual([]);
    expect(r.chain('chat').profiles).toEqual([]);
  });

  it('a failed primary stays skipped with its reason; a passed fallback serves the task', () => {
    const r = ModelRegistry.fromEnvironment('dev');
    const applied = applyRecordedProbes(
      r,
      JSON.stringify({
        'chat.gpt-6-1-sol': { status: 'failed', checkedAt: at, gatewayId: 'garderobe-dev', reason: '503 upstream unavailable' },
        'chat.opus-5-5-medium': { status: 'passed', checkedAt: at, gatewayId: 'garderobe-dev' },
      }),
      'garderobe-dev',
    );
    expect(applied.sort()).toEqual(['chat.gpt-6-1-sol', 'chat.opus-5-5-medium']);
    const chain = r.chain('chat');
    expect(chain.profiles.map((p) => p.profileId)).toEqual(['chat.opus-5-5-medium']);
    expect(chain.skipped).toContainEqual({ profileId: 'chat.gpt-6-1-sol', reason: 'Capability and Unified Billing probe failed: 503 upstream unavailable' });
  });

  it('ignores records for another gateway, unknown or fake profiles, and malformed input', () => {
    const r = ModelRegistry.fromEnvironment('dev');
    expect(applyRecordedProbes(r, JSON.stringify({ 'chat.fable-5-1': { status: 'passed', checkedAt: at, gatewayId: 'garderobe-prod' } }), 'garderobe-dev')).toEqual([]);
    expect(applyRecordedProbes(r, JSON.stringify({ 'chat.unknown': { status: 'passed', checkedAt: at, gatewayId: 'garderobe-dev' } }), 'garderobe-dev')).toEqual([]);
    expect(applyRecordedProbes(r, JSON.stringify({ 'chat.fable-5-1': { status: 'maybe', checkedAt: at, gatewayId: 'garderobe-dev' } }), 'garderobe-dev')).toEqual([]);
    expect(applyRecordedProbes(r, 'not json', 'garderobe-dev')).toEqual([]);
    expect(applyRecordedProbes(r, '[]', 'garderobe-dev')).toEqual([]);
    expect(r.chain('chat').profiles).toEqual([]);
    const t = ModelRegistry.forTests();
    expect(applyRecordedProbes(t, JSON.stringify({ 'fake.chat': { status: 'failed', checkedAt: at, gatewayId: 'garderobe-dev' } }), 'garderobe-dev')).toEqual([]);
  });
});
