import { beforeAll, describe, expect, it } from 'vitest';
import { CancelRunResponse, ConversationPage, RecallSearchResponse, RunEvent, RunStatus, TurnResponse } from '@garderobe/contracts';
import '../helpers/assistant.js'; // deterministic fake model and day providers for the Think actor
import { apiOwner, call, callJson, installApiScenario } from '../helpers/api.js';

/**
 * Conversation turns into the owner's Think conversation, the canonical transcript, recall search,
 * durable runs and the SSE projection with replayable event ids and snapshot fallback.
 */

function parseSse(text: string): { id: string | null; event: string | null; data: RunEvent }[] {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((b) => b && !b.startsWith(':') && b.includes('data:'))
    .map((b) => {
      const lines = b.split('\n');
      const get = (k: string) => lines.find((l) => l.startsWith(`${k}: `))?.slice(k.length + 2) ?? null;
      return { id: get('id'), event: get('event'), data: RunEvent.parse(JSON.parse(get('data')!)) };
    });
}

async function waitForRun(assertion: string, runId: string): Promise<RunStatus> {
  for (let i = 0; i < 200; i++) {
    const s = RunStatus.parse((await callJson(`/v1/runs/${runId}`, { assertion })).body);
    if (['finished', 'failed', 'cancelled'].includes(s.status)) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('run did not finish');
}

describe('conversation, runs and the SSE projection', () => {
  let owner: Awaited<ReturnType<typeof apiOwner>>;
  let a: string;
  let turn: TurnResponse;
  const clientTurnId = `ios-${crypto.randomUUID()}`;

  beforeAll(async () => {
    installApiScenario();
    owner = await apiOwner();
    a = owner.assertion;
  });

  it('accepts a turn with a stable clientTurnId and returns a run id; a resend returns the existing turn', async () => {
    const body = { clientTurnId, text: 'What should I wear with the rust sneakers this week?', attachmentIds: [], references: [], intent: 'chat', explicitLog: false, sourceChannel: 'app' };
    const r = await callJson('/v1/conversation/turns', { assertion: a, body });
    expect(r.status).toBe(202);
    turn = TurnResponse.parse(r.body);
    expect(turn.status).toBe('accepted');
    expect(turn.runId).toMatch(/^run_/);
    const again = TurnResponse.parse((await callJson('/v1/conversation/turns', { assertion: a, body })).body);
    expect(again).toMatchObject({ status: 'existing', runId: turn.runId, messageId: turn.messageId });
    const changed = await callJson<{ error: { code: string } }>('/v1/conversation/turns', { assertion: a, body: { ...body, text: 'Something else' } });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('idempotency_key_reused');
  });

  it('refuses an empty turn, forged owner fields and unfinalized attachments', async () => {
    expect((await callJson('/v1/conversation/turns', { assertion: a, body: { clientTurnId: 'ios-empty-0001', text: '   ' } })).status).toBe(422);
    expect((await callJson('/v1/conversation/turns', { assertion: a, body: { clientTurnId: 'ios-forged-001', text: 'hi', ownerId: 'usr_other' } })).status).toBe(400);
    const r = await callJson<{ error: { code: string } }>('/v1/conversation/turns', { assertion: a, body: { clientTurnId: 'ios-attach-001', text: 'what is this', attachmentIds: ['upl_notthere'] } });
    expect(r.status).toBe(404);
  });

  it('streams ordered events ending in run_finished, and a durable run status', async () => {
    const res = await call(`/v1/runs/${turn.runId}/events`, { assertion: a });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = parseSse(await res.text());
    expect(events[0]!.data.type).toBe('run_started');
    expect(events.at(-1)!.data.type).toBe('run_finished');
    const ids = events.map((e) => Number(e.id));
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of events) expect(e.data.eventId).toBe(e.id);
    const text = events.find((e) => e.data.type === 'text_delta');
    expect(text).toBeTruthy();
    const status = await waitForRun(a, turn.runId);
    expect(status.status).toBe('finished');
    expect(status.message?.role).toBe('assistant');
    expect(status.message?.parts.some((p) => p.type === 'text')).toBe(true);
    expect(status.lastEventId).toBe(events.at(-1)!.id);
  });

  it('resumes after Last-Event-ID and sends a snapshot for an expired or unknown cursor', async () => {
    const all = parseSse(await (await call(`/v1/runs/${turn.runId}/events`, { assertion: a })).text());
    const mid = all[1]!.id!;
    const resumed = parseSse(await (await call(`/v1/runs/${turn.runId}/events`, { assertion: a, headers: { 'last-event-id': mid } })).text());
    expect(resumed.map((e) => e.id)).toEqual(all.filter((e) => Number(e.id) > Number(mid)).map((e) => e.id));
    for (const cursor of ['9999', 'not-a-cursor']) {
      const snap = parseSse(await (await call(`/v1/runs/${turn.runId}/events`, { assertion: a, headers: { 'last-event-id': cursor } })).text());
      expect(snap[0]!.data.type, cursor).toBe('snapshot');
      expect((snap[0]!.data.data as { status: string }).status).toBe('finished');
    }
  });

  it('pages the canonical transcript with source-channel metadata and a stable cursor', async () => {
    for (let i = 0; i < 2; i++) {
      const t = TurnResponse.parse((await callJson('/v1/conversation/turns', { assertion: a, body: { clientTurnId: `ios-more-${i}-${crypto.randomUUID()}`, text: `Follow-up ${i}: is the blue oxford clean?` } })).body);
      await waitForRun(a, t.runId);
    }
    const page = ConversationPage.parse((await callJson('/v1/conversation/messages?limit=4', { assertion: a })).body);
    expect(page.messages).toHaveLength(4);
    expect(page.hasMore).toBe(true);
    expect(page.activeRunId).toBeNull();
    const older = ConversationPage.parse((await callJson(`/v1/conversation/messages?limit=4&before=${page.before}`, { assertion: a })).body);
    expect(older.messages.length).toBeGreaterThan(0);
    expect(older.messages.map((m) => m.messageId)).not.toContain(page.messages[0]!.messageId);
    const first = older.messages[0]!;
    expect(first).toMatchObject({ role: 'user', clientTurnId, sourceChannel: 'conversation' });
    expect(first.runId).toBe(turn.runId);
    const around = ConversationPage.parse((await callJson(`/v1/conversation/messages?around=${first.messageId}&limit=3`, { assertion: a })).body);
    expect(around.messages.map((m) => m.messageId)).toContain(first.messageId);
  });

  it('searches dated conversations with an index watermark', async () => {
    const r = RecallSearchResponse.parse((await callJson('/v1/recall/search', { assertion: a, body: { query: 'rust sneakers' } })).body);
    expect(r.coverage).toHaveProperty('indexedSeq');
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits[0]!.quote.toLowerCase()).toContain('rust');
  });

  it('cancelling a finished run reports it as finished and stops nothing', async () => {
    const c = CancelRunResponse.parse((await callJson(`/v1/runs/${turn.runId}/cancel`, { assertion: a, body: {} })).body);
    expect(c.status).toBe('finished');
    expect(c.stopped).toEqual([]);
  });

  it('another owner cannot read this owner’s runs', async () => {
    const other = await apiOwner();
    expect((await callJson(`/v1/runs/${turn.runId}`, { assertion: other.assertion })).status).toBe(404);
    expect((await call(`/v1/runs/${turn.runId}/events`, { assertion: other.assertion })).status).toBe(404);
    const page = ConversationPage.parse((await callJson('/v1/conversation/messages', { assertion: other.assertion })).body);
    expect(page.messages).toEqual([]);
  });
});
