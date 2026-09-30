import { describe, expect, it } from 'vitest';
import { basicWardrobe, buckets, db, newUser, ok, run, wearCount } from './helpers/fixtures.js';
import { ensureLaundryResets, getLaundryState, listLaundryResets } from '../src/domain/index.js';

const TZ = 'Europe/London';
const clock = (iso: string) => ({ now: () => iso });

describe('footwear, belts and never-laundered roles', () => {
  it('cannot be put in the wash and never acquire a laundry state through wear', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    for (const id of [w.sneakers, w.belt]) {
      const r = await run(p, { type: 'mark_in_wash', garmentId: id });
      expect(r.outcome).toBe('rejected');
      expect(r.error?.code).toBe('never_laundered');
      expect(await buckets(p, id)).toMatchObject({ clean: 1, hamper: 0, worn: 0 });
    }
    await ok(p, { type: 'record_wear', timezone: TZ, items: [{ garmentId: w.sneakers }, { garmentId: w.belt }, { garmentId: w.blazer }] }, {}, clock('2026-10-06T09:00:00.000Z'));
    for (const id of [w.sneakers, w.belt, w.blazer]) expect(await buckets(p, id)).toMatchObject({ clean: 1, hamper: 0, worn: 0, laundry: 0 });
    await ok(p, { type: 'laundry_collected' }, {}, clock('2026-10-09T09:00:00.000Z'));
    for (const id of [w.sneakers, w.belt]) expect(await buckets(p, id)).toMatchObject({ laundry: 0 });
    expect(await wearCount(p, w.sneakers)).toBe(1);
  });
});

describe('service laundry batches', () => {
  it('pickup snapshots the hamper; a shirt worn after pickup stays in the hamper; a return completes only that batch', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    await ok(p, { type: 'record_wear', timezone: TZ, wearingDate: '2026-10-05', items: [{ garmentId: w.shirtA }, { garmentId: w.trousers }] }, {}, clock('2026-10-05T20:00:00.000Z'));
    await ok(p, { type: 'mark_in_wash', garmentId: w.trousers }, {}, clock('2026-10-05T21:00:00.000Z'));
    const collected = await ok(p, { type: 'laundry_collected' }, {}, clock('2026-10-09T08:00:00.000Z'));
    const batchId = collected.facts.batchId as string;
    expect((collected.facts.items as { name: string }[]).map((i) => i.name).sort()).toEqual(['Di Sondrio walnut chino', 'Lightweight oxford — blue']);
    await ok(p, { type: 'record_wear', timezone: TZ, wearingDate: '2026-10-09', items: [{ garmentId: w.shirtB }] }, {}, clock('2026-10-09T18:00:00.000Z'));
    const returned = await ok(p, { type: 'laundry_returned', batchId }, {}, clock('2026-10-10T11:00:00.000Z'));
    expect(returned.facts.status).toBe('returned');
    expect(await buckets(p, w.shirtA)).toMatchObject({ clean: 1, laundry: 0 });
    expect(await buckets(p, w.trousers)).toMatchObject({ clean: 1, laundry: 0 });
    expect(await buckets(p, w.shirtB)).toMatchObject({ clean: 0, hamper: 1 });
    const again = await run(p, { type: 'laundry_returned', batchId }, {}, clock('2026-10-10T12:00:00.000Z'));
    expect(again.error?.code).toBe('invalid_state');
  });

  it('a partial return keeps named exceptions away and a later return completes them', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    await ok(p, { type: 'record_wear', timezone: TZ, wearingDate: '2026-10-05', items: [{ garmentId: w.shirtA }, { garmentId: w.shirtB }] }, {}, clock('2026-10-05T20:00:00.000Z'));
    await ok(p, { type: 'laundry_collected' }, {}, clock('2026-10-09T08:00:00.000Z'));
    const partial = await ok(p, { type: 'laundry_partial_return', exceptions: [{ garmentId: w.shirtB }] }, {}, clock('2026-10-10T11:00:00.000Z'));
    expect(partial.facts.status).toBe('partially_returned');
    expect(partial.summary).toContain('Still away: Pima oxford — white');
    expect(await buckets(p, w.shirtA)).toMatchObject({ clean: 1, laundry: 0 });
    expect(await buckets(p, w.shirtB)).toMatchObject({ clean: 0, laundry: 1 });
    let state = await getLaundryState(db(), p);
    expect(state.openExceptions).toHaveLength(1);
    expect(state.batches[0]!.items.find((i) => i.garmentId === w.shirtB)!.status).toBe('away');
    const rest = await ok(p, { type: 'laundry_returned' }, {}, clock('2026-10-13T11:00:00.000Z'));
    expect(rest.facts.status).toBe('returned');
    expect(await buckets(p, w.shirtB)).toMatchObject({ clean: 1, laundry: 0 });
    state = await getLaundryState(db(), p);
    expect(state.openExceptions).toHaveLength(0);
    expect(state.batches).toHaveLength(0);
  });

  it('rejects an exception for an item not in the batch and a return with no batch away', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    expect((await run(p, { type: 'laundry_returned' })).error?.code).toBe('invalid_state');
    await ok(p, { type: 'mark_in_wash', garmentId: w.shirtA }, {}, clock('2026-10-05T20:00:00.000Z'));
    await ok(p, { type: 'laundry_collected' }, {}, clock('2026-10-09T08:00:00.000Z'));
    const r = await run(p, { type: 'laundry_partial_return', exceptions: [{ garmentId: w.shirtB }] }, {}, clock('2026-10-10T11:00:00.000Z'));
    expect(r.error?.code).toBe('validation_failed');
    expect(await buckets(p, w.shirtA)).toMatchObject({ laundry: 1 });
  });

  it('undo of a pickup withdraws the batch and returns its items to the hamper', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    await ok(p, { type: 'mark_in_wash', garmentId: w.shirtA }, {}, clock('2026-10-05T20:00:00.000Z'));
    const c = await ok(p, { type: 'laundry_collected' }, {}, clock('2026-10-09T08:00:00.000Z'));
    await ok(p, { type: 'undo', targetCommandId: c.commandId }, {}, clock('2026-10-09T08:05:00.000Z'));
    expect(await buckets(p, w.shirtA)).toMatchObject({ hamper: 1, laundry: 0 });
    const b = await db().prepare('SELECT status FROM laundry_batches WHERE user_id = ?').bind(p.userId).first<{ status: string }>();
    expect(b!.status).toBe('voided');
  });
});

describe('hand wash', () => {
  it('socks washed clears only the hand-wash hamper; socks never enter a service batch', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    await ok(p, { type: 'record_wear', timezone: TZ, wearingDate: '2026-10-05', items: [{ garmentId: w.shirtA }, { garmentId: w.socks }] }, {}, clock('2026-10-05T20:00:00.000Z'));
    const c = await ok(p, { type: 'laundry_collected' }, {}, clock('2026-10-09T08:00:00.000Z'));
    expect((c.facts.items as { garmentId: string }[]).some((i) => i.garmentId === w.socks)).toBe(false);
    expect(await buckets(p, w.socks)).toMatchObject({ clean: 3, hamper: 1, laundry: 0 });
    await ok(p, { type: 'record_wear', timezone: TZ, wearingDate: '2026-10-09', items: [{ garmentId: w.shirtB }] }, {}, clock('2026-10-09T20:00:00.000Z'));
    const washed = await ok(p, { type: 'socks_washed' }, {}, clock('2026-10-09T21:00:00.000Z'));
    expect(washed.facts.totalPairs).toBe(1);
    expect(await buckets(p, w.socks)).toMatchObject({ clean: 4, hamper: 0 });
    expect(await buckets(p, w.shirtB)).toMatchObject({ hamper: 1 });
    expect(await buckets(p, w.shirtA)).toMatchObject({ laundry: 1 });
    const r = await run(p, { type: 'socks_washed', garmentIds: [w.shirtB] });
    expect(r.error?.code).toBe('validation_failed');
  });
});

describe('weekly laundry reset records', () => {
  it('applies each Friday/Saturday/Sunday cycle once per owner and pool, catching up after missed runs', async () => {
    const p = await newUser('Reset owner', { now: '2026-09-01T00:00:00.000Z' });
    const first = await ensureLaundryResets(db(), p, '2026-09-08T12:00:00.000Z'); // Tuesday after Sunday 6 Sep
    expect(first.map((r) => `${r.pool}:${r.cycleKey}`).sort()).toEqual(['hand_wash:2026-09-06', 'service:2026-09-06']);
    const svc = first.find((r) => r.pool === 'service')!;
    expect(svc.cutoffAt).toBe('2026-09-04T08:00:00.000Z'); // Friday 09:00 BST
    expect(svc.effectiveAt).toBe('2026-09-05T23:00:00.000Z'); // Sunday 00:00 BST
    expect(await ensureLaundryResets(db(), p, '2026-09-09T12:00:00.000Z')).toEqual([]);
    // Three weeks with no runs: each missed cycle is applied exactly once.
    const caught = await ensureLaundryResets(db(), p, '2026-09-30T12:00:00.000Z');
    expect(caught.filter((r) => r.pool === 'service').map((r) => r.cycleKey).sort()).toEqual(['2026-09-13', '2026-09-20', '2026-09-27']);
    expect(await ensureLaundryResets(db(), p, '2026-09-30T13:00:00.000Z')).toEqual([]);
    const all = await listLaundryResets(db(), p);
    expect(all.filter((r) => r.pool === 'service')).toHaveLength(4);
    // No movements, pickups or returns are recorded by a reset.
    const m = await db().prepare('SELECT COUNT(*) AS n FROM laundry_batches WHERE user_id = ?').bind(p.userId).first<{ n: number }>();
    expect(m!.n).toBe(0);
  });
});
