import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { ItemDetail, StyleCurrentResponse } from '@garderobe/contracts';
import { seedOwner, type Owner } from '../harness/owner.js';
import { App } from '../harness/http.js';
import { installWorld, type World } from '../harness/world.js';
import { expectDoneReceipt, INTERROGATION } from '../harness/ux.js';

/**
 * Journey 15 — Optional comfort feedback (spec section 10 "Optional comfort feedback"; section 17
 * row "Comfort": one unsolicited discomfort report affects the relevant context without a
 * questionnaire, universal ban, or unsupported medical claim). "These hurt after an hour on the
 * train" is accepted as one observation linked to the shoes, the day and what is actually known; no
 * follow-up questions, no ban, no medical claim. "Do not suggest these for long walks" is an explicit
 * instruction: it becomes a standing rule with provenance and Undo, scoped to that garment and
 * activity, and a long-walk recommendation must respect it while ordinary days still may use them.
 *
 * All through the HTTP API (POST /v1/commands with source 'app', POST /v1/recommend). Stand-in:
 * FakeWeatherProvider for Open-Meteo.
 */

interface RecommendResult {
  date: string;
  options: { optionId: string; slots: { garmentId: string; name: string; role: string }[]; why: string }[];
  shortfall: string | null;
  document: { text: string };
}

const MEDICAL = /\b(medical|medically|injur(y|ies|ed)|diagnos\w*|doctor|physio\w*|podiatr\w*|treatment|inflammation|plantar)\b/i;
const WALK = { date: '2026-10-07', count: 5, brief: 'A long walk along the Thames Path tomorrow, most of the day on foot', occasion: 'outdoor' as const };
const ORDINARY = { date: '2026-10-07', count: 5 };

function footwear(r: RecommendResult): string[] {
  return r.options.flatMap((o) => o.slots.filter((s) => s.role === 'footwear').map((s) => s.garmentId));
}
function mostFrequent(ids: string[]): string {
  const n = new Map<string, number>();
  for (const id of ids) n.set(id, (n.get(id) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

describe('Journey: a brief discomfort report and an explicit standing instruction', () => {
  let world: World;
  let owner: Owner;
  let app: App;
  let ordinaryOptions: RecommendResult['options'];
  let walkBaseline: string[];
  let commuteShoes: string;
  let walkShoes: string;
  let rulesBefore: number;
  let ruleCommand: string;
  let ruleId: string;

  const recommend = async (body: Record<string, unknown>): Promise<RecommendResult> => {
    const r = await app.post<RecommendResult>('/v1/recommend', body);
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    return r.body;
  };
  const activeRules = async () => StyleCurrentResponse.parse((await app.get('/v1/style/current')).body).rules.active;
  /** "May still include": an ordinary outfit for the day wearing these shoes passes the day's validation. */
  const ordinaryOutfitWithValid = async (shoes: string): Promise<{ valid: boolean; issues: { message: string }[] }> => {
    const base = ordinaryOptions.find((o) => o.slots.some((s) => s.garmentId === shoes)) ?? ordinaryOptions[0]!;
    const slots = base.slots.map((s) => ({ garmentId: s.role === 'footwear' ? shoes : s.garmentId, role: s.role }));
    const unique = slots.filter((s, i) => slots.findIndex((x) => x.garmentId === s.garmentId) === i);
    const r = await app.post<{ valid: boolean; issues: { message: string }[] }>('/v1/studio/validate', { mode: 'today', date: ORDINARY.date, slots: unique });
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    return r.body;
  };

  beforeAll(async () => {
    world = installWorld({ now: '2026-10-05T19:00:00.000Z', weather: { scenario: 'mild' } });
    owner = await seedOwner();
    app = new App(owner.assertion);
    ordinaryOptions = (await recommend(ORDINARY)).options;
    walkBaseline = footwear(await recommend(WALK));
    commuteShoes = mostFrequent(ordinaryOptions.flatMap((o) => o.slots.filter((s) => s.role === 'footwear').map((s) => s.garmentId)));
    walkShoes = mostFrequent(walkBaseline);
    rulesBefore = await activeRules();
  });

  it('“These hurt after an hour on the train” is accepted once, linked to the shoes and the day, with no follow-up questions and no medical claim', async () => {
    world.clock.set('2026-10-06T18:30:00.000Z');
    const r = await app.commit({ type: 'record_comfort_feedback', text: 'These hurt after an hour on the train', garmentId: commuteShoes, wearingDate: '2026-10-06', activity: 'commute', conditions: { setting: 'train' } });
    expectDoneReceipt(r, { undo: false });
    expect(r.undo.reason).toMatch(/observation/);
    expect(r.summary).toContain('These hurt after an hour on the train');
    expect(r.summary).not.toMatch(/\?/); // no questionnaire
    expect(r.summary).not.toMatch(INTERROGATION);
    expect(r.summary).not.toMatch(MEDICAL);
    expect(r.facts).toMatchObject({ standingRuleId: null, universal: false, knownConditions: { setting: 'train' } });
    // Linked to the garment: the item page lists the receipt.
    const detail = ItemDetail.parse((await app.get(`/v1/items/${commuteShoes}`)).body);
    expect(detail.receipts.map((x) => x.commandId)).toContain(r.commandId);
    // SURFACE GAP: no HTTP/MCP read route for comfort observations; read from D1
    const row = await env.DB.prepare('SELECT garment_id, wearing_date, activity, layer, conditions_json, text, scope FROM comfort_feedback WHERE user_id = ? AND garment_id = ?').bind(owner.userId, commuteShoes).first<Record<string, unknown>>();
    expect(row).toMatchObject({ garment_id: commuteShoes, wearing_date: '2026-10-06', activity: 'commute', layer: null, text: 'These hurt after an hour on the train', scope: 'observation' });
    expect(JSON.parse(String(row!.conditions_json))).toEqual({ setting: 'train' });
  });

  it('missing context stays unknown: “this collar scratches” needs no date, activity or conditions, and asks nothing', async () => {
    const shirt = await owner.byName('Lightweight oxford — light blue wide stripe');
    const r = await app.commit({ type: 'record_comfort_feedback', text: 'This collar scratches', garmentId: shirt });
    expectDoneReceipt(r, { undo: false });
    expect(r.summary).not.toMatch(/\?/);
    expect(r.summary).not.toMatch(MEDICAL);
    expect(r.facts).toMatchObject({ standingRuleId: null, universal: false, knownConditions: {} });
    const row = await env.DB.prepare('SELECT wearing_date, activity, layer FROM comfort_feedback WHERE user_id = ? AND garment_id = ?').bind(owner.userId, shirt).first();
    expect(row).toEqual({ wearing_date: null, activity: null, layer: null });
  });

  it('one report is not a universal ban: the shoes stay available, no rule or restriction appears, and an ordinary day may still use them', async () => {
    const detail = ItemDetail.parse((await app.get(`/v1/items/${commuteShoes}`)).body);
    expect(detail.item.availability.available).toBe(true);
    expect(detail.restrictions.filter((x) => x.liftedAt === null)).toHaveLength(0);
    expect(await activeRules()).toBe(rulesBefore);
    const check = await ordinaryOutfitWithValid(commuteShoes);
    expect(check.valid, `an overheated commute does not ban the shoes from ordinary days: ${check.issues.map((i) => i.message).join('; ')}`).toBe(true);
  });

  it('“Do not suggest these for long walks” becomes a standing rule scoped to those shoes and long walks, with provenance and Undo', async () => {
    const r = await app.commit({ type: 'record_comfort_feedback', text: 'Do not suggest these for long walks', garmentId: walkShoes, activity: 'long walks', standingInstruction: { ownerQuote: 'Do not suggest these for long walks', appliesTo: { activity: 'long walks' } } });
    expectDoneReceipt(r); // Undo available
    expect(r.summary).toMatch(/will not be suggested for long walks/);
    expect(r.summary).not.toMatch(MEDICAL);
    expect(r.facts.universal).toBe(false);
    ruleCommand = r.commandId;
    ruleId = r.facts.standingRuleId as string;
    expect(ruleId).toMatch(/^rule_/);
    expect(await activeRules()).toBe(rulesBefore + 1);
    // Provenance: the owner's own words, the command that created it, and an explicit scope.
    const row = await env.DB.prepare('SELECT statement, interpretation, machine_json, source, created_by_command, status FROM style_rules WHERE user_id = ? AND rule_id = ?').bind(owner.userId, ruleId).first<Record<string, string>>();
    expect(row).toMatchObject({ statement: 'Do not suggest these for long walks', source: 'owner_comfort', created_by_command: ruleCommand, status: 'active' });
    expect(row!.interpretation).toMatch(/not a ban on the garment elsewhere/);
    expect(JSON.parse(row!.machine_json ?? '{}')).toMatchObject({ excludeGarmentIds: [walkShoes], when: { activity: 'long walks' } });
    // Scoped, not universal: the shoes remain available for other days.
    expect(ItemDetail.parse((await app.get(`/v1/items/${walkShoes}`)).body).item.availability.available).toBe(true);
  });

  it('a recommendation for a long walk respects the rule', async () => {
    expect(walkBaseline, 'before the rule, the walk recommendation used these shoes').toContain(walkShoes);
    const walk = await recommend(WALK);
    expect(walk.options.length).toBeGreaterThan(0);
    const name = walk.options.flatMap((o) => o.slots).find((s) => s.garmentId === walkShoes)?.name ?? walkShoes;
    expect(footwear(walk), `long-walk recommendation still offers ${name}, which the owner excluded for long walks`).not.toContain(walkShoes);
  });

  it('the rule is scoped: on an ordinary day an outfit with those shoes still validates', async () => {
    const ordinary = await ordinaryOutfitWithValid(walkShoes);
    expect(ordinary.valid, `the long-walks rule must not ban the shoes on an ordinary day: ${ordinary.issues.map((i) => i.message).join('; ')}`).toBe(true);
  });

  it('Undo retires the rule, and the owner’s profile is back to where it was', async () => {
    const undo = await app.commit({ type: 'undo', targetCommandId: ruleCommand });
    expect(undo.outcome).toBe('committed');
    expect(undo.summary).not.toMatch(INTERROGATION);
    const row = await env.DB.prepare('SELECT status FROM style_rules WHERE user_id = ? AND rule_id = ?').bind(owner.userId, ruleId).first<{ status: string }>();
    expect(row!.status).toBe('retired');
    expect(await activeRules()).toBe(rulesBefore);
  });
});
