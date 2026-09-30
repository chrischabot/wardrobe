import { describe, expect, it } from 'vitest';
import { basicWardrobe, buckets, newUser, ok, run, wearCount } from './helpers/fixtures.js';

const TZ = 'Europe/London';
const clock = (iso: string) => ({ now: () => iso });

describe('anonymous sock quantities', () => {
  it('never go negative when more wears are reported than clean pairs exist; repairs are recorded', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    const receipts = [];
    for (let d = 1; d <= 6; d++) {
      const date = `2026-10-0${d}`;
      receipts.push(await ok(p, { type: 'record_wear', timezone: TZ, wearingDate: date, items: [{ garmentId: w.socks }] }, {}, clock('2026-10-07T09:00:00.000Z')));
      const b = await buckets(p, w.socks);
      for (const v of Object.values(b)) expect(v).toBeGreaterThanOrEqual(0);
      expect(b.clean + b.hamper + b.worn + b.laundry + b.storage + b.away).toBe(4);
    }
    expect(await buckets(p, w.socks)).toMatchObject({ clean: 0, hamper: 4 });
    expect(await wearCount(p, w.socks)).toBe(6);
    expect(JSON.stringify(receipts[4]!.facts.stockNotes)).toContain('accounting_repair');
  });

  it('are not tied to the daily wear count: a fresh pair moves stock without another counted wear; a duplicate report moves nothing', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    const opts = clock('2026-10-06T20:00:00.000Z');
    await ok(p, { type: 'record_wear', timezone: TZ, items: [{ garmentId: w.socks }] }, {}, opts);
    await ok(p, { type: 'record_wear', timezone: TZ, items: [{ garmentId: w.socks }] }, { source: 'mcp' }, opts);
    expect(await buckets(p, w.socks)).toMatchObject({ clean: 3, hamper: 1 });
    await ok(p, { type: 'record_wear', timezone: TZ, segment: 'evening', items: [{ garmentId: w.socks, freshUnit: true }] }, {}, opts);
    expect(await buckets(p, w.socks)).toMatchObject({ clean: 2, hamper: 2 });
    expect(await wearCount(p, w.socks)).toBe(1);
  });

  it('reconciliation takes aggregate corrections without inventing units or asking for pair identity', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    await ok(p, { type: 'record_wear', timezone: TZ, items: [{ garmentId: w.socks }] }, {}, clock('2026-10-06T09:00:00.000Z'));
    let r = await ok(p, { type: 'reconcile_quantity', garmentId: w.socks, clean: 5 }, {}, clock('2026-10-06T10:00:00.000Z'));
    expect(await buckets(p, w.socks)).toMatchObject({ clean: 4, hamper: 0 });
    expect(JSON.stringify(r.facts.stockNotes)).toContain('only 4 unit(s) are owned');
    r = await ok(p, { type: 'reconcile_quantity', garmentId: w.socks, totalOwned: 6, clean: 5 }, {}, clock('2026-10-06T11:00:00.000Z'));
    expect(await buckets(p, w.socks)).toMatchObject({ clean: 5, hamper: 1 });
    expect(r.summary).toBe('Corrected Merino — inky blue: 6 owned, 5 clean.');
    await ok(p, { type: 'reconcile_quantity', garmentId: w.socks, totalOwned: 3 }, {}, clock('2026-10-06T12:00:00.000Z'));
    expect(await buckets(p, w.socks)).toMatchObject({ clean: 3, hamper: 0, retired: 3 });
    const undo = await ok(p, { type: 'undo', targetCommandId: r.commandId }, {}, clock('2026-10-06T13:00:00.000Z'));
    expect(undo.outcome).toBe('committed');
    const b = await buckets(p, w.socks);
    expect(b.clean + b.hamper).toBe(3);
    const bad = await run(p, { type: 'reconcile_quantity', garmentId: w.shirtA, totalOwned: 3 });
    expect(bad.error?.code).toBe('validation_failed');
  });
});
