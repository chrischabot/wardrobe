import { afterEach, describe, expect, it } from 'vitest';
import { db, newOwner, ok } from './helpers/fixtures.js';
import { assistantFor, chatCalls, converse, installFakeDay, realClock, resetFake, scriptToolCalls, toolResults } from './helpers/assistant.js';
import { installTestDailyProviders } from '../src/assistant/day-context.js';
import { FakeWeatherProvider } from '../src/weather/fake.js';
import { FakeCalendar } from '../src/calendar/fake.js';
import { RecommendationService } from '../src/recommend/index.js';
import { localDateOf, zonedInstant } from '../src/domain/time.js';
import type { Principal } from '../src/domain/principal.js';

const TZ = 'Europe/London';
const today = () => localDateOf(new Date().toISOString(), TZ);

function dayWith(opts: { scenario?: 'mild' | 'coldSnap' | 'heat'; event?: string } = {}) {
  const weather = new FakeWeatherProvider({ scenario: opts.scenario ?? 'mild', clock: realClock });
  const calendar = new FakeCalendar(realClock);
  if (opts.event) calendar.addEvent({ title: opts.event, start: zonedInstant(today(), '10:00', TZ), end: zonedInstant(today(), '11:00', TZ) });
  installFakeDay({ weather, calendar });
  return { weather, calendar, rec: (p: Principal) => new RecommendationService({ db: db(), principal: p, weather, calendar, clock: realClock }) };
}

const section = (system: string, title: string) => {
  const start = system.indexOf(`## ${title}`);
  if (start < 0) return '';
  const next = system.indexOf('\n## ', start + 3);
  return system.slice(start, next < 0 ? undefined : next);
};

afterEach(() => installFakeDay());

describe('the assistant receives the daily service’s trusted day context', () => {
  it('weather, calendar brief, availability, recent wear and the board reach a turn with no tool calls', async () => {
    const owner = await newOwner();
    const d = dayWith({ event: 'Client presentation' });
    const a = await assistantFor(owner.userId);
    resetFake();
    const { turn } = await converse(a, 'Morning. What should I think about today?');
    expect(turn!.status).toBe('completed');
    const call = chatCalls()[0]!;
    expect(call.toolNames).toContain('propose_outfit');
    expect(fakeToolCalls()).toBe(0);
    const system = call.system;
    expect(system).toContain('# Today (trusted daily service context)');
    expect(system).not.toContain('FALLBACK');
    const weather = section(system, 'Weather');
    expect(weather).toMatch(/Source: fake-weather-\d+-r0 \(fresh\); fetched 20\d\d-/);
    expect(weather).toMatch(/issued 20\d\d-/);
    expect(weather).toMatch(/Departure -?\d+(\.\d)? °C \(outerwear basis\); peak -?\d+(\.\d)? °C/);
    expect(section(system, 'Calendar day brief')).toContain('Client presentation [formal]');
    expect(section(system, 'Availability (hard gate for any outfit)')).toMatch(/\d+ of 127 owned pieces are available/);
    expect(section(system, 'Availability (hard gate for any outfit)')).toContain('Paraboot Reims — noir (black)');
    expect(section(system, 'Recent wear (daily service, 7-day repeat horizon)')).toContain('None recorded');
    expect(section(system, 'Published board')).toContain(`No board is published for ${today()}`);
    expect(d.weather.calls).toBeGreaterThan(0);
    expect(turn!.result).toMatchObject({ day: { fallback: false } });
  });

  it('a published board and a recorded wear from the daily service appear in the next turn', async () => {
    const owner = await newOwner();
    const d = dayWith();
    const published = await d.rec(owner.principal).composeAndPublish({ date: today() });
    expect(published.published).toBe(true);
    const shirt = (await db().prepare("SELECT garment_id FROM garments WHERE user_id = ? AND name = 'Lightweight oxford — gold'").bind(owner.userId).first<{ garment_id: string }>())!.garment_id;
    await ok(owner.principal, { type: 'record_wear', timezone: TZ, wearingDate: localDateOf(new Date(Date.now() - 86_400_000).toISOString(), TZ), items: [{ garmentId: shirt }] });
    const a = await assistantFor(owner.userId);
    resetFake();
    await converse(a, 'Which one should I pick?');
    const system = chatCalls()[0]!.system;
    const board = section(system, 'Published board');
    expect(board).toContain('Revision 1');
    expect(board).toContain(published.board!.options[0]!.optionId);
    expect(section(system, 'Recent wear (daily service, 7-day repeat horizon)')).toContain('Lightweight oxford — gold');
  });

  it('Ask about this: the stored message keeps the option and garment references with their names, for the model, the transcript and recall', async () => {
    const owner = await newOwner();
    const d = dayWith();
    const published = await d.rec(owner.principal).composeAndPublish({ date: today() });
    const option = published.board!.options[1]!;
    const shirt = (await db().prepare("SELECT garment_id FROM garments WHERE user_id = ? AND name = 'Lightweight oxford — gold'").bind(owner.userId).first<{ garment_id: string }>())!.garment_id;
    const references = [
      { kind: 'option', boardId: published.board!.boardId, optionId: option.optionId, boardRevision: 1 },
      { kind: 'garment', garmentId: shirt },
      { kind: 'garment', garmentId: 'gar_not_mine_0001' },
    ];
    const a = await assistantFor(owner.userId);
    resetFake();
    const { turn } = await converse(a, 'Why does this one work?', { references });
    const names = (await db().prepare('SELECT g.name FROM option_garments og JOIN garments g ON g.user_id = og.user_id AND g.garment_id = og.garment_id WHERE og.user_id = ? AND og.option_id = ?').bind(owner.userId, option.optionId).all<{ name: string }>()).results.map((r) => r.name);
    expect(names.length).toBeGreaterThan(2);
    // The model sees the exact identities.
    const thisTurn = chatCalls()[0]!.system.split('# This turn')[1]!;
    expect(thisTurn).toContain(option.optionId);
    for (const n of names) expect(thisTurn).toContain(n);
    expect(thisTurn).toContain('garment gar_not_mine_0001: not found');
    // The stored Session message keeps ids and display identity next to the text.
    const stored = (await a.rawTranscript()).find((m) => m.role === 'user' && m.text === 'Why does this one work?')!;
    const refs = (stored.metadata as { references: { kind: string; optionId?: string; garmentId?: string; found: boolean; display: { label: string } | null }[] }).references;
    expect(refs.map((r) => [r.kind, r.optionId ?? r.garmentId, r.found])).toEqual([
      ['option', option.optionId, true],
      ['garment', shirt, true],
      ['garment', 'gar_not_mine_0001', false],
    ]);
    expect(refs[0]!.display!.label.split(', ').sort()).toEqual([...names].sort());
    expect(refs[1]!.display!.label).toBe('Lightweight oxford — gold');
    // Recall keeps what was asked about.
    const userMessageId = (await db().prepare('SELECT user_message_id FROM assistant_turns WHERE user_id = ? AND turn_id = ?').bind(owner.userId, turn!.turnId).first<{ user_message_id: string }>())!.user_message_id;
    const recalled = (await db().prepare('SELECT text FROM recall_messages WHERE user_id = ? AND message_id = ?').bind(owner.userId, userMessageId).first<{ text: string }>())!.text;
    expect(recalled).toContain(`Asked about: board ${published.board!.boardId} option ${option.optionId}`);
    expect(recalled).toContain('Lightweight oxford — gold');
  });

  it('a cold snap changes the next turn’s weather section and its recorded context digest', async () => {
    const owner = await newOwner();
    const d = dayWith({ scenario: 'mild' });
    const a = await assistantFor(owner.userId);
    resetFake();
    const first = await converse(a, 'What jacket today?');
    d.weather.set({ scenario: 'coldSnap' });
    const second = await converse(a, 'And now?');
    const [c1, c2] = chatCalls();
    const w1 = section(c1!.system, 'Weather');
    const w2 = section(c2!.system, 'Weather');
    const peak = (w: string) => Number(w.match(/peak (-?\d+(?:\.\d)?) °C \(shirt/)![1]);
    expect(peak(w2)).toBeLessThan(peak(w1) - 5);
    expect(w2).toMatch(/fake-weather-\d+-r1/);
    expect(first.turn!.contextDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(second.turn!.contextDigest).not.toBe(first.turn!.contextDigest);
  });

  it('falls back to the published board, labelled, when the daily service returns nothing', async () => {
    const owner = await newOwner();
    installTestDailyProviders(null, () => ({
      context: async () => {
        throw new Error('daily service unavailable');
      },
      validateProposal: async () => {
        throw new Error('daily service unavailable');
      },
    }));
    const a = await assistantFor(owner.userId);
    resetFake();
    scriptToolCalls([[{ toolName: 'propose_outfit', input: { slots: [{ garmentId: 'g_00000000000000000000000000000000', role: 'base_top' }] } }]]);
    const { turn } = await converse(a, 'Anything for today?');
    const system = chatCalls()[0]!.system;
    expect(system).toContain('# Today (FALLBACK: daily service context unavailable)');
    expect(system).toContain('FALLBACK — the daily service could not build today’s context (daily service unavailable)'.replace('’', "'"));
    expect(system).toContain('do not invent them');
    expect(turn!.result).toMatchObject({ day: { fallback: true } });
    const card = toolResults()[0]!.value as { actionable: boolean; failedRules: { ruleKey: string }[] };
    expect(card.actionable).toBe(false);
    expect(card.failedRules[0]!.ruleKey).toBe('validation.unavailable');
  });
});

describe('outfits the assistant proposes pass the daily service’s validator before they are actionable', () => {
  async function setup() {
    const owner = await newOwner();
    const d = dayWith({ scenario: 'mild' });
    const composed = await d.rec(owner.principal).compose({ date: today() });
    const option = composed.composed.options[0]!;
    const byName = async (name: string) => (await db().prepare('SELECT garment_id FROM garments WHERE user_id = ? AND name = ?').bind(owner.userId, name).first<{ garment_id: string }>())!.garment_id;
    return { owner, d, slots: option.slots.map((s) => ({ garmentId: s.garmentId, role: s.role, alternativeGroup: s.alternativeGroup ?? null })), byName };
  }

  async function propose(userId: string, slots: unknown[], text = 'Suggest something for today.') {
    const a = await assistantFor(userId);
    resetFake();
    scriptToolCalls([[{ toolName: 'propose_outfit', input: { slots, explanation: 'test proposal' } }]]);
    const { turn } = await converse(a, text);
    const card = toolResults()[0]!.value as { actionable: boolean; failedRules: { ruleKey: string; detail: string }[]; summary: string; validatedBy: string };
    return { card, turn };
  }

  it('a valid outfit becomes an actionable card stored with the turn; nothing is selected or worn', async () => {
    const { owner, slots } = await setup();
    const { card, turn } = await propose(owner.userId, slots);
    expect(card.validatedBy).toBe('daily_service.validateProposal');
    expect(card.actionable, JSON.stringify(card.failedRules)).toBe(true);
    expect((turn!.result as { cards: { actionable: boolean }[] }).cards).toHaveLength(1);
    const wears = await db().prepare('SELECT COUNT(*) AS n FROM daily_wears WHERE user_id = ?').bind(owner.userId).first<{ n: number }>();
    const selections = await db().prepare('SELECT COUNT(*) AS n FROM selections WHERE user_id = ?').bind(owner.userId).first<{ n: number }>();
    expect([wears!.n, selections!.n]).toEqual([0, 0]);
  });

  it('a welted shoe under the sneakers-only restriction is rejected, naming the rule', async () => {
    const { owner, slots, byName } = await setup();
    const reims = await byName('Paraboot Reims — noir (black)');
    const withWelted = slots.map((s) => (s.role === 'footwear' ? { ...s, garmentId: reims } : s));
    const { card, turn } = await propose(owner.userId, withWelted);
    expect(card.actionable).toBe(false);
    expect(card.failedRules.map((f) => f.ruleKey)).toContain('hard.sneakers_only_until_healed');
    expect(card.summary).toMatch(/^Not actionable: failed .*hard\.sneakers_only_until_healed/);
    expect((turn!.result as { cards: { actionable: boolean }[] }).cards[0]!.actionable).toBe(false);
  });

  it('an invented garment id from the model is rejected as not an owned garment', async () => {
    const { owner, slots } = await setup();
    const invented = slots.map((s) => (s.role === 'base_top' ? { ...s, garmentId: 'g_11111111111111111111111111111111' } : s));
    const { card } = await propose(owner.userId, invented);
    expect(card.actionable).toBe(false);
    expect(card.failedRules.map((f) => f.ruleKey)).toContain('integrity.known_garment');
  });

  it('a garment in the wash is rejected on availability', async () => {
    const { owner, slots } = await setup();
    const top = slots.find((s) => s.role === 'base_top')!.garmentId;
    await ok(owner.principal, { type: 'mark_in_wash', garmentId: top });
    const { card } = await propose(owner.userId, slots);
    expect(card.actionable).toBe(false);
    const avail = card.failedRules.find((f) => f.ruleKey === 'availability.eligible');
    expect(avail?.detail).toMatch(/no clean unit|hamper|wash/i);
  });

  it('proposing is allowed on a read-only grant but still cannot make anything happen', async () => {
    const { owner, slots } = await setup();
    const a = await assistantFor(owner.userId);
    resetFake();
    scriptToolCalls([[{ toolName: 'propose_outfit', input: { slots } }, { toolName: 'record_wear', input: { garmentIds: slots.map((s) => s.garmentId) } }]]);
    await converse(a, 'Log this outfit.', { channel: 'mcp', grant: { scopes: ['wardrobe:read'], authenticatedBy: 'mcp_oauth' } });
    const [proposal, wear] = toolResults();
    expect((proposal!.value as { actionable: boolean }).actionable).toBe(true);
    expect(wear!.value.outcome).toBe('not_authorized');
  });
});

function fakeToolCalls(): number {
  return toolResults().length;
}
