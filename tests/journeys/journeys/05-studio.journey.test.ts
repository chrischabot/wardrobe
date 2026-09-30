import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { StudioChoices, StudioSuggestion, StudioValidation, type StudioSlot } from '@garderobe/contracts';
import { seedOwner, type Owner } from '../harness/owner.js';
import { App } from '../harness/http.js';
import { installWorld } from '../harness/world.js';
import { expectDoneReceipt } from '../harness/ux.js';
import { offered } from '../harness/profile.js';
import { fakeModel, resetModel } from '../harness/assistant.js';
import { studioFor } from '../../../backend/src/api/visual.js';

/**
 * Journey 5 — Studio (spec section 3 "Studio", section 17 "Studio"). Selectors change one role at a
 * time; locked pieces stay locked while "Find something that works with this" fills the rest;
 * browsing mutates nothing and needs no inference; Save combination, Plan for a day and Wear this
 * have distinct effects and persist the correct garment IDs.
 */

describe('Journey: Studio — lock pieces and find something that works', () => {
  let owner: Owner;
  let app: App;
  let base: StudioSlot[];
  const receiptsCount = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM command_receipts WHERE user_id = ?').bind(owner.userId).first<{ n: number }>())!.n;

  beforeAll(async () => {
    installWorld({ now: '2026-10-05T20:00:00.000Z', weather: { scenario: 'mild' } }).clock.set('2026-10-06T06:00:00.000Z');
    owner = await seedOwner();
    app = new App(owner.assertion);
    await app.prepare({ date: '2026-10-06' });
    const t = await app.today('2026-10-06');
    base = offered(t)[0]!.option.slots.map((s) => ({ garmentId: s.garmentId, role: s.role, alternativeGroup: s.alternativeGroup ?? null }));
    resetModel();
  });

  it('For today selectors offer eligible owned pieces; Explore adds seasonal pieces, clearly badged; browsing changes nothing', async () => {
    const before = await receiptsCount();
    const today = StudioChoices.parse((await app.post('/v1/studio/choices', { mode: 'today', date: '2026-10-06', role: 'footwear' })).body);
    expect(today.items.length).toBeGreaterThan(3);
    const eligible = today.items.filter((i) => i.eligibleToday);
    expect(eligible.every((i) => i.category === 'sneakers' && !/990v6/.test(i.name))).toBe(true);
    const restricted = today.items.filter((i) => i.badges.includes('restricted'));
    for (const i of restricted) expect(i.eligibleToday).toBe(false);
    const explore = StudioChoices.parse((await app.post('/v1/studio/choices', { mode: 'explore', date: '2026-10-06', role: 'outer_layer' })).body);
    expect(explore.items.length).toBeGreaterThan(5);
    expect(await receiptsCount()).toBe(before);
    // Swipes are positioned locally from cached assets; the backend needs no model to answer.
    expect(fakeModel.calls).toHaveLength(0);
  });

  it('Find something that works with this changes only the unlocked slots, and the result validates', async () => {
    const locked = base.filter((s) => s.role === 'base_top' || s.role === 'bottom');
    const r = await app.post('/v1/studio/suggest', { mode: 'today', date: '2026-10-06', locked, roles: ['socks', 'footwear', 'outer_layer', 'belt'] });
    expect(r.status).toBe(200);
    const s = StudioSuggestion.parse(r.body);
    expect(s.slots.length).toBeGreaterThan(locked.length);
    for (const l of locked) expect(s.slots).toContainEqual(expect.objectContaining({ garmentId: l.garmentId, role: l.role }));
    expect(s.slots.filter((x) => x.role === 'base_top').map((x) => x.garmentId)).toEqual(locked.filter((x) => x.role === 'base_top').map((x) => x.garmentId));
    expect(s.slots.some((x) => x.role === 'socks')).toBe(true);
    expect((s.changedRoles ?? []).every((role) => ['socks', 'footwear', 'outer_layer', 'belt'].includes(role))).toBe(true);
    expect(s.validation.valid).toBe(true);
    expect(s.explanation.length).toBeGreaterThan(5);
    if (s.manifest) expect(s.manifest.imagined).toBe(false);
    expect(fakeModel.calls).toHaveLength(0);
  });

  it('validation explains what does not work instead of silently changing a locked piece', async () => {
    const noSocks = base.filter((s) => s.role !== 'socks');
    const v = StudioValidation.parse((await app.post('/v1/studio/validate', { mode: 'today', date: '2026-10-06', slots: noSocks })).body);
    expect(v.valid).toBe(false);
    expect(v.issues.map((i) => `${i.code} ${i.message}`).join(' ')).toMatch(/sock/i);
  });

  it('Save combination, Plan for a day and Wear this have distinct effects and keep the exact garment IDs', async () => {
    const saved = await app.commit({ type: 'save_combination', name: 'Tuesday corduroy idea', slots: base });
    expectDoneReceipt(saved);
    const planSlots = base.filter((s) => s.role !== 'footwear').concat(base.filter((s) => s.role === 'footwear').slice(0, 1));
    const plan = await app.commit({ type: 'plan_outfit', date: '2026-10-06', slots: planSlots });
    expectDoneReceipt(plan);
    // Neither saving nor planning is a wear.
    expect((await app.today('2026-10-06')).recordedWears).toEqual([]);
    // SURFACE GAP: no HTTP route lists saved combinations/plans; read through the Studio service.
    const studio = studioFor(env, owner.principal);
    const list = await studio.listCombinations({});
    const savedRow = list.find((c) => c.kind === 'saved' && c.name === 'Tuesday corduroy idea');
    expect(savedRow, 'saved combination persisted').toBeTruthy();
    expect(savedRow!.slots.map((s) => s.garmentId).sort()).toEqual(base.map((s) => s.garmentId).sort());
    const planned = await studio.planFor('2026-10-06');
    expect(planned?.slots.map((s) => s.garmentId).sort()).toEqual(planSlots.map((s) => s.garmentId).sort());
    // Wear this records the actual outfit.
    const wear = await app.commit({ type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-06', items: planSlots.map((s) => ({ garmentId: s.garmentId, role: s.role })) });
    expectDoneReceipt(wear);
    expect((await app.today('2026-10-06')).recordedWears.map((w) => w.garmentId).sort()).toEqual(planSlots.map((s) => s.garmentId).sort());
  });

  it('a plan that fails the day is refused with the reason, and nothing is stored', async () => {
    const r = await app.post<{ error: { code: string; message: string } }>('/v1/commands', { idempotencyKey: `app:plan-${Date.now()}`, source: 'app', command: { type: 'plan_outfit', date: '2026-10-07', slots: base.filter((s) => s.role === 'base_top') } });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('plan_invalid_for_day');
    expect(r.body.error.message.length).toBeGreaterThan(20);
    expect(await studioFor(env, owner.principal).planFor('2026-10-07')).toBeNull();
  });
});
