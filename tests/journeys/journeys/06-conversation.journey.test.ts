import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CancelRunResponse, ConversationPage, RunEvent, RunStatus, TurnResponse, type TodayResponse } from '@garderobe/contracts';
import { seedOwner, uniq, type Owner } from '../harness/owner.js';
import { App, call } from '../harness/http.js';
import { installWorld, type World } from '../harness/world.js';
import { assistantWorld, chatCalls, fakeModel, promptText, resetModel, scriptToolCalls } from '../harness/assistant.js';
import { INTERROGATION } from '../harness/ux.js';
import { offered } from '../harness/profile.js';

/**
 * Journey 6 — Conversation (spec section 3 "Conversation and capture", section 7 "Mandatory
 * context", section 13). One continuous stream; a turn is accepted, then answered through a durable
 * run with ordered events; Ask about this attaches the exact option identity; a run can be followed
 * and cancelled; asking is not logging; accepted is never shown as done.
 *
 * Stand-in: the model is the deterministic FakeModelTransport (no AI Gateway locally). The Think
 * actor, tools, command policy, runs and SSE projection are the real Worker code.
 */

function parseSse(text: string): RunEvent[] {
  return text
    .split('\n\n')
    .map((b) => b.trim())
    .filter((b) => b && !b.startsWith(':') && b.includes('data:'))
    .map((b) => RunEvent.parse(JSON.parse(b.split('\n').find((l) => l.startsWith('data: '))!.slice(6))));
}

describe('Journey: a conversation turn, Ask about this, run progress and cancel', () => {
  let world: World;
  let owner: Owner;
  let app: App;
  let today: TodayResponse;

  const waitForRun = async (runId: string): Promise<RunStatus> => {
    for (let i = 0; i < 300; i++) {
      const s = RunStatus.parse((await app.get(`/v1/runs/${runId}`)).body);
      if (['finished', 'failed', 'cancelled'].includes(s.status)) return s;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`run ${runId} did not finish`);
  };
  const turn = async (body: Record<string, unknown>) => {
    const r = await app.post('/v1/conversation/turns', { clientTurnId: uniq('ios'), ...body });
    return { status: r.status, turn: TurnResponse.parse(r.body) };
  };

  beforeAll(async () => {
    // The assistant's own clock is real time, so this journey runs on today's real date.
    world = installWorld({ now: new Date().toISOString(), weather: { scenario: 'mild' } });
    assistantWorld(world);
    owner = await seedOwner();
    app = new App(owner.assertion);
    await app.prepare();
    today = await app.today();
  });
  beforeEach(() => resetModel());

  it('a turn is accepted with a run id; accepted is not the answer, and the run becomes the answer', async () => {
    const { status, turn: t } = await turn({ text: 'What would you pair with the walnut chinos this week?' });
    expect(status).toBe(202);
    expect(t.status).toBe('accepted');
    const s = await waitForRun(t.runId);
    expect(s.status).toBe('finished');
    expect(s.message?.role).toBe('assistant');
    expect(s.message?.parts.some((p) => p.type === 'text')).toBe(true);
    expect(s.receipts ?? []).toEqual([]);
    const events = parseSse(await (await call(`/v1/runs/${t.runId}/events`, { assertion: owner.assertion })).text());
    expect(events[0]!.type).toBe('run_started');
    expect(events.at(-1)!.type).toBe('run_finished');
    // No status questionnaire rides along with a style question.
    const text = s.message!.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join(' ');
    expect(text).not.toMatch(INTERROGATION);
  });

  it('a model that makes no tool calls still receives the full profile, the wardrobe and the day', async () => {
    const { turn: t } = await turn({ text: 'Anything I should know about today?' });
    await waitForRun(t.runId);
    const calls = chatCalls();
    expect(calls.length).toBeGreaterThan(0);
    const prompt = promptText(calls[0]!);
    // The complete profile, not a summary: passages from its first and last sections.
    expect(prompt).toContain('Rotterdam');
    expect(prompt).toContain('Socks always, wicking merino by default');
    expect(prompt).toContain('Direct and decision-light');
    // Wardrobe facts and the day's context.
    expect(prompt).toContain('Di Sondrio walnut chino');
    expect(prompt).toMatch(/°C|temperature/i);
  });

  it('Ask about this attaches the exact board option; the assistant does not have to guess the card', async () => {
    const opt = offered(today)[1]!;
    const { turn: t } = await turn({ text: 'Why does this one work?', references: [{ kind: 'option', boardId: today.board!.boardId, optionId: opt.option.optionId, boardRevision: today.board!.currentRevision }] });
    await waitForRun(t.runId);
    const prompt = promptText(chatCalls()[0]!);
    expect(prompt).toContain(opt.option.optionId);
    for (const g of opt.garments) expect(prompt, g.name).toContain(g.name);
    const page = ConversationPage.parse((await app.get('/v1/conversation/messages?limit=2')).body);
    const mine = page.messages.find((m) => m.role === 'user' && m.runId === t.runId);
    expect(mine, `user message for the run; got ${JSON.stringify(page.messages.map((m) => ({ role: m.role, runId: m.runId, parts: m.parts })))}`).toBeTruthy();
    // The transcript keeps the attached identity with the message (the app renders it as a chip).
    expect(JSON.stringify(mine!.parts), 'reference kept in the transcript').toContain(opt.option.optionId);
  });

  it('an explicit “log this” commits through the command policy and the reply carries the verified receipt', async () => {
    const shirt = await owner.byName('Lightweight oxford — gold');
    scriptToolCalls([[{ toolName: 'record_wear', input: { garmentIds: [shirt] } }]]);
    const { turn: t } = await turn({ text: 'Log this: I wore the gold oxford today.' });
    const s = await waitForRun(t.runId);
    expect(s.receipts?.length).toBe(1);
    const r = s.receipts![0]!;
    expect(r.outcome).toBe('committed');
    expect(r.commandType).toBe('record_wear');
    expect(r.undo.available).toBe(true);
    const events = parseSse(await (await call(`/v1/runs/${t.runId}/events`, { assertion: owner.assertion })).text());
    expect(events.some((e) => e.type === 'command_receipt')).toBe(true);
    expect((await app.today()).recordedWears.map((w) => w.garmentId)).toContain(shirt);
  });

  it('asking whether an outfit works does not log it, whatever the model tries', async () => {
    const shirt = await owner.byName('Lightweight oxford — laurel');
    scriptToolCalls([[{ toolName: 'record_wear', input: { garmentIds: [shirt] } }]]);
    const { turn: t } = await turn({ text: 'Would the laurel oxford work with the walnut chinos?' });
    const s = await waitForRun(t.runId);
    expect((s.receipts ?? []).filter((r) => r.outcome === 'committed')).toEqual([]);
    expect((await app.today()).recordedWears.map((w) => w.garmentId)).not.toContain(shirt);
  });

  it('a photo in “What I wore” without an explicit log request never records anything', async () => {
    const shirt = await owner.byName('Lightweight oxford — blue');
    scriptToolCalls([[{ toolName: 'record_wear', input: { garmentIds: [shirt] } }]]);
    const { turn: t } = await turn({ text: 'Lift selfie from this morning', intent: 'what_i_wore', explicitLog: false });
    const s = await waitForRun(t.runId);
    expect((s.receipts ?? []).filter((r) => r.outcome === 'committed')).toEqual([]);
    expect((await app.today()).recordedWears.map((w) => w.garmentId)).not.toContain(shirt);
  });

  it('run progress is durable and a running reply can be cancelled; committed effects are reported, nothing else runs', async () => {
    fakeModel.delayMs = 4000;
    const { turn: t } = await turn({ text: 'Walk me through the history of the French chore coat.' });
    const mid = RunStatus.parse((await app.get(`/v1/runs/${t.runId}`)).body);
    expect(['queued', 'running']).toContain(mid.status);
    expect(mid.message?.parts?.length ?? 0).toBe(0);
    const c = CancelRunResponse.parse((await app.post(`/v1/runs/${t.runId}/cancel`, {})).body);
    expect(['cancelled', 'finished']).toContain(c.status);
    expect(c.committedEffects).toEqual([]);
    fakeModel.delayMs = 0;
    const s = await waitForRun(t.runId);
    expect(s.status).toBe('cancelled');
  });

  it('a resent turn (dropped connection) returns the existing turn instead of appending it again', async () => {
    const clientTurnId = uniq('ios-resend');
    const a = await app.post('/v1/conversation/turns', { clientTurnId, text: 'Is the moss oxford clean?' });
    const b = await app.post('/v1/conversation/turns', { clientTurnId, text: 'Is the moss oxford clean?' });
    expect(a.status).toBe(202);
    expect(b.status).toBe(200);
    expect(TurnResponse.parse(b.body)).toMatchObject({ status: 'existing', runId: TurnResponse.parse(a.body).runId });
    await waitForRun(TurnResponse.parse(a.body).runId);
    const page = ConversationPage.parse((await app.get('/v1/conversation/messages?limit=50')).body);
    expect(page.messages.filter((m) => m.clientTurnId === clientTurnId && m.role === 'user')).toHaveLength(1);
  });
});
