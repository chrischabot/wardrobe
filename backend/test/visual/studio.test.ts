import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { GarmentRole, StudioSlot } from '@garderobe/contracts';
import { ok, run } from '../helpers/fixtures.js';
import { slotsOf, tableCounts, visualScenario, type VisualScenario } from '../helpers/visual.js';

const DATE = '2026-10-06';

async function todaysBoard(s: VisualScenario) {
  const out = await s.rec.composeAndPublish({ date: DATE });
  expect(out.published).toBe(true);
  return out.board!;
}

/** A complete valid outfit for the day with a single pair of shoes (as the owner would wear it). */
async function validOutfit(s: VisualScenario): Promise<StudioSlot[]> {
  const board = await todaysBoard(s);
  const slots = slotsOf(board.options.find((o) => o.status === 'offerable')!);
  const shoes = slots.filter((x) => x.role === 'footwear');
  return shoes.length > 1 ? slots.filter((x) => x.role !== 'footwear' || x.garmentId === shoes[0]!.garmentId).map((x) => (x.role === 'footwear' ? { garmentId: x.garmentId, role: x.role } : x)) : slots;
}

describe('Studio: For today vs Explore', () => {
  it('For today offers only eligible owned pieces; Explore adds stored pieces with badges', async () => {
    const s = await visualScenario({ placeholders: true });
    const today = await s.studio.choices({ mode: 'today', date: DATE, role: 'base_top' });
    expect(today.items.length).toBeGreaterThan(5);
    expect(today.items.every((i) => i.eligibleToday && i.role === 'base_top')).toBe(true);
    expect(today.items.every((i) => i.assetClass === 'demo_placeholder' && i.label === 'Demo placeholder')).toBe(true);
    const shirt = today.items[0]!.garmentId;
    await s.cmd({ type: 'put_into_storage', garmentId: shirt });
    const after = await s.studio.choices({ mode: 'today', date: DATE, role: 'base_top' });
    expect(after.items.map((i) => i.garmentId)).not.toContain(shirt);
    const explore = await s.studio.choices({ mode: 'explore', date: DATE, role: 'base_top' });
    const stored = explore.items.find((i) => i.garmentId === shirt)!;
    expect(stored).toMatchObject({ eligibleToday: false, badges: expect.arrayContaining(['in_storage']) });
    expect(explore.items.length).toBeGreaterThan(after.items.length);
    // Eligible pieces are listed first in Explore.
    const firstIneligible = explore.items.findIndex((i) => !i.eligibleToday);
    expect(explore.items.slice(firstIneligible).every((i) => !i.eligibleToday)).toBe(true);
  });

  it('validate: a piece in the wash fails For today but only warns (day-bound) in Explore', async () => {
    const s = await visualScenario();
    const outfit = await validOutfit(s);
    expect((await s.studio.validate({ mode: 'today', date: DATE, slots: outfit })).valid).toBe(true);
    const top = outfit.find((x) => x.role === 'base_top')!;
    await s.cmd({ type: 'mark_in_wash', garmentId: top.garmentId });
    const t = await s.studio.validate({ mode: 'today', date: DATE, slots: outfit });
    expect(t.valid).toBe(false);
    expect(t.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'availability.eligible', garmentId: top.garmentId, dayBound: true })]));
    const e = await s.studio.validate({ mode: 'explore', date: DATE, slots: outfit });
    expect(e).toMatchObject({ valid: true, validForDate: false });
    // A structural problem fails in both modes.
    const noShoes = outfit.filter((x) => x.role !== 'footwear');
    expect((await s.studio.validate({ mode: 'explore', date: DATE, slots: noShoes })).valid).toBe(false);
    // The same verdict as the daily-service validator.
    const direct = await s.rec.validateProposal({ date: DATE, include: outfit.map((x) => x.garmentId) }, { slots: outfit });
    expect(direct.valid).toBe(false);
  });

  it('For today enforces the owner’s hard rules (sneakers only while healing); Explore reports them as day-bound', async () => {
    const s = await visualScenario();
    const outfit = await validOutfit(s);
    const boot = await s.byName("Drake's Clifford boot");
    const withBoot = outfit.map((x) => (x.role === 'footwear' ? { garmentId: boot, role: 'footwear' as const } : x));
    const t = await s.studio.validate({ mode: 'today', date: DATE, slots: withBoot });
    expect(t.valid).toBe(false);
    expect(t.issues.map((i) => i.code)).toContain('hard.sneakers_only_until_healed');
    expect((await s.studio.choices({ mode: 'today', date: DATE, role: 'footwear' })).items.map((i) => i.garmentId)).not.toContain(boot);
    const ex = (await s.studio.choices({ mode: 'explore', date: DATE, role: 'footwear' })).items.find((i) => i.garmentId === boot);
    expect(ex).toMatchObject({ eligibleToday: false, badges: expect.arrayContaining(['restricted']) });
  });
});

describe('Studio: "Find something that works with this" changes only unlocked slots', () => {
  it('keeps the locked shirt and trousers exactly and fills the rest with a combination that passes the daily-service validator', async () => {
    const s = await visualScenario({ placeholders: true });
    const outfit = await validOutfit(s);
    const locked = outfit.filter((x) => x.role === 'base_top' || x.role === 'bottom');
    const sug = await s.studio.suggest({ mode: 'today', date: DATE, locked, roles: ['socks', 'footwear', 'belt'] });
    expect(sug.found).toBe(true);
    for (const l of locked) expect(sug.slots).toContainEqual(l);
    expect(sug.changedRoles!.every((r) => !['base_top', 'bottom'].includes(r))).toBe(true);
    expect(sug.validation.valid).toBe(true);
    const check = await s.rec.validateProposal({ date: DATE, include: sug.slots.map((x) => x.garmentId) }, { slots: sug.slots });
    expect(check.valid).toBe(true);
    expect(sug.manifest!.items.map((i) => i.garmentId).sort()).toEqual(sug.slots.map((x) => x.garmentId).sort());
    expect(sug.explanation).toMatch(/^Works with /);
    // Deterministic: the same request gives the same suggestion.
    expect((await s.studio.suggest({ mode: 'today', date: DATE, locked, roles: ['socks', 'footwear', 'belt'] })).slots).toEqual(sug.slots);
  });

  it('with everything but the shoes locked, only the shoes change', async () => {
    const s = await visualScenario();
    const outfit = await validOutfit(s);
    const locked = outfit.filter((x) => x.role !== 'footwear');
    const sug = await s.studio.suggest({ mode: 'today', date: DATE, locked, roles: ['footwear'] });
    expect(sug.found).toBe(true);
    expect(sug.changedRoles).toEqual(['footwear']);
    expect(sug.slots.filter((x) => x.role !== 'footwear')).toEqual(locked);
  });

  it('randomised locks: locked slots never move, and every suggestion is valid for the day', async () => {
    const s = await visualScenario();
    const board = await todaysBoard(s);
    const pools: Partial<Record<GarmentRole, string[]>> = {};
    for (const role of ['base_top', 'bottom', 'outer_layer', 'socks', 'belt'] as GarmentRole[]) pools[role] = (await s.studio.choices({ mode: 'today', date: DATE, role })).items.map((i) => i.garmentId);
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % Math.max(1, n);
    };
    let found = 0;
    for (let i = 0; i < 12; i++) {
      const locked: StudioSlot[] = [];
      for (const role of ['base_top', 'bottom', 'outer_layer', 'socks', 'belt'] as GarmentRole[]) {
        const p = pools[role] ?? [];
        if (p.length && rnd(2)) locked.push({ garmentId: p[rnd(p.length)]!, role });
      }
      const sug = await s.studio.suggest({ mode: 'today', date: DATE, locked, roles: ['base_top', 'bottom', 'outer_layer', 'socks', 'footwear', 'belt', 'accessory'] });
      for (const l of locked) expect(sug.slots).toContainEqual(l);
      if (sug.found) {
        found++;
        const v = await s.rec.validateProposal({ date: DATE, include: sug.slots.map((x) => x.garmentId) }, { slots: sug.slots });
        expect(v.violations).toEqual([]);
      } else {
        expect(sug.slots).toEqual(locked);
        expect(sug.validation.valid).toBe(false);
      }
    }
    expect(found).toBeGreaterThan(3);
    expect(board.options.length).toBeGreaterThan(0);
  });

  it('when a locked piece cannot be worn today, says so and leaves the locks untouched', async () => {
    const s = await visualScenario();
    const outfit = await validOutfit(s);
    const top = outfit.find((x) => x.role === 'base_top')!;
    await s.cmd({ type: 'mark_in_wash', garmentId: top.garmentId });
    const sug = await s.studio.suggest({ mode: 'today', date: DATE, locked: [top], roles: ['bottom', 'socks', 'footwear'] });
    expect(sug.found).toBe(false);
    expect(sug.slots).toEqual([top]);
    expect(sug.explanation).toMatch(/Nothing works with .* today: .*no clean unit/);
    expect(sug.explanation).toMatch(/locked pieces were left as they are/);
    // Explore still finds a combination with it.
    const ex = await s.studio.suggest({ mode: 'explore', date: DATE, locked: [top], roles: ['bottom', 'socks', 'footwear'] });
    expect(ex.found).toBe(true);
    expect(ex.slots).toContainEqual(top);
    expect(ex.validation).toMatchObject({ valid: true, validForDate: false });
  });

  it('supports dress / one-piece layouts through the role model', async () => {
    const s = await visualScenario();
    const r = await ok(s.principal, { type: 'add_item', explicit: true, name: 'Linen boiler suit — sand', category: 'overshirt', roles: ['one_piece'], color: 'Sand', fabric: 'Linen' });
    const suit = (r.facts as { garmentId: string }).garmentId;
    const sug = await s.studio.suggest({ mode: 'explore', date: DATE, locked: [{ garmentId: suit, role: 'one_piece' }], roles: ['socks', 'footwear'] });
    expect(sug.found).toBe(true);
    expect(sug.slots.some((x) => x.role === 'base_top' || x.role === 'bottom')).toBe(false);
    expect(sug.manifest!.template).toBe('one_piece');
    const both = await s.studio.validate({ mode: 'explore', date: DATE, slots: [{ garmentId: suit, role: 'one_piece' }, ...sug.slots.filter((x) => x.role !== 'one_piece')] });
    expect(both.issues.filter((i) => i.code === 'integrity.complete')).toEqual([]);
  });

  it('browsing mutates nothing: choices, validate, suggest and manifests write no plan, wear, receipt or asset', async () => {
    const s = await visualScenario({ placeholders: true });
    const outfit = await validOutfit(s);
    const before = await tableCounts(s.userId);
    await s.studio.choices({ mode: 'today', date: DATE, role: 'base_top' });
    await s.studio.choices({ mode: 'explore', date: DATE, role: 'footwear' });
    await s.studio.validate({ mode: 'today', date: DATE, slots: outfit });
    await s.studio.suggest({ mode: 'today', date: DATE, locked: outfit.slice(0, 2), roles: ['socks', 'footwear'] });
    await s.studio.suggest({ mode: 'explore', date: DATE, locked: [], roles: ['base_top'] });
    await s.composites.manifestFor(outfit);
    expect(await tableCounts(s.userId)).toEqual(before);
  });
});

describe('Studio: Save combination, Plan for a day and Wear this have distinct effects', () => {
  it('save stores a combination only; plan stores one plan per day; only Wear this records a wear', async () => {
    const s = await visualScenario();
    const outfit = await validOutfit(s);
    const base = await tableCounts(s.userId);

    const saved = await s.studio.save({ idempotencyKey: 'studio:save:0001', slots: outfit, name: 'Gold and walnut' });
    expect(saved.receipt).toMatchObject({ outcome: 'committed', commandType: 'save_combination', facts: { kind: 'saved', wearRecorded: false, plannedForDate: null } });
    let c = await tableCounts(s.userId);
    expect(c.saved_combinations - base.saved_combinations).toBe(1);
    expect(c.daily_wears).toBe(base.daily_wears);
    expect(await s.studio.planFor(DATE)).toBeNull();

    const planned = await s.studio.plan({ idempotencyKey: 'studio:plan:0001', date: DATE, slots: outfit });
    expect(planned.receipt).toMatchObject({ outcome: 'committed', commandType: 'plan_outfit', facts: { kind: 'plan', plannedForDate: DATE, wearRecorded: false } });
    c = await tableCounts(s.userId);
    expect(c.daily_wears).toBe(base.daily_wears);
    expect(c.selections).toBe(base.selections);
    expect((await s.studio.planFor(DATE))!.slots).toEqual(outfit);
    expect(await s.studio.listCombinations({ kind: 'saved' })).toEqual([expect.objectContaining({ name: 'Gold and walnut', kind: 'saved', status: 'active' })]);

    s.clock.set('2026-10-06T18:00:00.000Z'); // the evening of the day: the owner wore it
    const worn = await s.studio.wear({ idempotencyKey: 'studio:wear:0001', slots: outfit, wearingDate: DATE });
    expect(worn).toMatchObject({ outcome: 'committed', commandType: 'record_wear' });
    c = await tableCounts(s.userId);
    expect(c.daily_wears - base.daily_wears).toBe(outfit.length);
    expect(c.saved_combinations - base.saved_combinations).toBe(2);
    // Replays are idempotent.
    expect((await s.studio.wear({ idempotencyKey: 'studio:wear:0001', slots: outfit, wearingDate: DATE })).replayed).toBe(true);
    expect((await tableCounts(s.userId)).daily_wears).toBe(c.daily_wears);
  });

  it('a new plan for the same day supersedes the old one; undo brings the old one back', async () => {
    const s = await visualScenario();
    const outfit = await validOutfit(s);
    const first = await s.studio.plan({ idempotencyKey: 'studio:plan:a001', date: DATE, slots: outfit });
    const shoe = outfit.find((x) => x.role === 'footwear')!;
    const altShoe = (await s.studio.choices({ mode: 'today', date: DATE, role: 'footwear' })).items.find((i) => i.garmentId !== shoe.garmentId)!;
    const other = outfit.map((x) => (x.role === 'footwear' ? { garmentId: altShoe.garmentId, role: 'footwear' as const } : x));
    expect((await s.studio.validate({ mode: 'today', date: DATE, slots: other })).valid).toBe(true);
    const second = await s.studio.plan({ idempotencyKey: 'studio:plan:a002', date: DATE, slots: other });
    expect(second.receipt!.facts).toMatchObject({ supersededCombinationId: (first.receipt!.facts as { combinationId: string }).combinationId });
    expect((await s.studio.planFor(DATE))!.slots).toEqual(other);
    const undo = await ok(s.principal, { type: 'undo', targetCommandId: second.receipt!.commandId });
    expect(undo.outcome).toBe('committed');
    expect((await s.studio.planFor(DATE))!.slots).toEqual(outfit);
    const all = await s.studio.listCombinations({ kind: 'plan', includeInactive: true });
    expect(all.map((p) => p.status).sort()).toEqual(['active', 'removed']);
  });

  it('a plan that fails the day’s validation is not stored; Wear this refuses two shoes', async () => {
    const s = await visualScenario();
    const outfit = await validOutfit(s);
    const top = outfit.find((x) => x.role === 'base_top')!;
    await s.cmd({ type: 'mark_in_wash', garmentId: top.garmentId });
    const r = await s.studio.plan({ idempotencyKey: 'studio:plan:bad1', date: DATE, slots: outfit });
    expect(r.receipt).toBeNull();
    expect(r.validation.valid).toBe(false);
    expect(await s.studio.planFor(DATE)).toBeNull();
    const sneakers = (await s.studio.choices({ mode: 'today', date: DATE, role: 'footwear' })).items.slice(0, 2);
    const two = [...outfit.filter((x) => x.role !== 'footwear'), ...sneakers.map((x) => ({ garmentId: x.garmentId, role: 'footwear' as const, alternativeGroup: 'footwear' }))];
    await expect(s.studio.wear({ idempotencyKey: 'studio:wear:two1', slots: two, wearingDate: DATE })).rejects.toMatchObject({ code: 'validation_failed' });
    // Saving an Explore combination is allowed even though it is not wearable today.
    expect((await s.studio.save({ idempotencyKey: 'studio:save:explore', slots: outfit, mode: 'explore' })).receipt!.outcome).toBe('committed');
  });

  it('the Studio commands are ordinary domain commands: structure checked, receipts stored, remove + undo', async () => {
    const s = await visualScenario();
    const outfit = await validOutfit(s);
    const dup = await run(s.principal, { type: 'save_combination', slots: [outfit[0]!, outfit[0]!] });
    expect(dup).toMatchObject({ outcome: 'rejected', error: { code: 'validation_failed' } });
    const wrongRole = await run(s.principal, { type: 'save_combination', slots: [{ garmentId: outfit.find((x) => x.role === 'bottom')!.garmentId, role: 'base_top' }] });
    expect(wrongRole.error?.code).toBe('validation_failed');
    const twoShoesNoGroup = await run(s.principal, { type: 'plan_outfit', date: DATE, slots: [...outfit, { garmentId: (await s.studio.choices({ mode: 'today', date: DATE, role: 'footwear' })).items.find((i) => !outfit.some((o) => o.garmentId === i.garmentId))!.garmentId, role: 'footwear' }] });
    expect(twoShoesNoGroup.error?.code).toBe('validation_failed');
    const saved = await ok(s.principal, { type: 'save_combination', slots: outfit });
    const id = (saved.facts as { combinationId: string }).combinationId;
    const removed = await s.studio.remove({ idempotencyKey: 'studio:remove:01', combinationId: id });
    expect(removed.outcome).toBe('committed');
    expect(await s.studio.listCombinations({ kind: 'saved' })).toEqual([]);
    expect((await s.studio.remove({ idempotencyKey: 'studio:remove:02', combinationId: id })).error?.code).toBe('invalid_state');
    await ok(s.principal, { type: 'undo', targetCommandId: removed.commandId });
    expect((await s.studio.listCombinations({ kind: 'saved' })).map((x) => x.combinationId)).toEqual([id]);
    // Stale expected versions conflict (edit class).
    const stale = await run(s.principal, { type: 'remove_combination', combinationId: id }, { expectedVersions: [{ entityType: 'saved_combination', entityId: id, version: 1 }] });
    expect(stale.outcome).toBe('conflict');
    const row = await env.DB.prepare('SELECT version, status FROM saved_combinations WHERE user_id = ? AND combination_id = ?').bind(s.userId, id).first<{ version: number; status: string }>();
    expect(row).toEqual({ version: 3, status: 'active' });
  });

  it('two concurrent plans for one day leave exactly one active plan', async () => {
    const s = await visualScenario();
    const outfit = await validOutfit(s);
    const results = await Promise.all([
      run(s.principal, { type: 'plan_outfit', date: '2026-10-09', slots: outfit }),
      run(s.principal, { type: 'plan_outfit', date: '2026-10-09', slots: outfit }),
      run(s.principal, { type: 'plan_outfit', date: '2026-10-09', slots: outfit }),
    ]);
    expect(results.every((r) => r.outcome === 'committed' || r.outcome === 'conflict')).toBe(true);
    const active = await env.DB.prepare("SELECT COUNT(*) AS n FROM saved_combinations WHERE user_id = ? AND kind = 'plan' AND status = 'active' AND planned_for_date = '2026-10-09'").bind(s.userId).first<{ n: number }>();
    expect(active!.n).toBe(1);
  });
});
