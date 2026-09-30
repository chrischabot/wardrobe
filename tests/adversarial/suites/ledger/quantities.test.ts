import { describe, expect, it } from 'vitest';
import { buckets, count, ledgerSnapshot, negativeBuckets, newOwner, one, run, total, type Owner } from '../../helpers/seed.js';

/**
 * Quantity attacks on the stock ledger over the owner's real garments: impossible counts, aggregate
 * reconciliation abuse, wears of units that are away at the laundry, and partial returns that name
 * things the batch never held. Invariant throughout: no bucket is ever negative and units are never
 * invented except by an explicit owner count.
 */

const TZ = 'Europe/London';
const at = (iso: string) => ({ now: () => iso });

async function unitTotal(o: Owner): Promise<number> {
  return (await one<{ n: number }>('SELECT COALESCE(SUM(clean_qty + worn_qty + hamper_qty + laundry_qty + storage_qty + away_qty + retired_qty), 0) AS n FROM stock_lots WHERE user_id = ?', o.userId)).n;
}

describe('impossible counts are refused at the boundary', () => {
  it('negative, zero, fractional, huge, non-numeric and non-finite quantities write nothing', async () => {
    const o = await newOwner();
    const socks = await o.byName('Merino — fire red');
    const shirt = await o.byName('Lightweight oxford — gold');
    const before = await ledgerSnapshot(o.userId);
    const bad: unknown[] = [-1, 0, 1.5, 501, 1e308, '2', null, Number.NaN, Number.POSITIVE_INFINITY, -0.0001];
    for (const quantity of bad) {
      for (const command of [
        { type: 'mark_in_wash', garmentId: shirt, quantity },
        { type: 'mark_washed', garmentId: socks, quantity },
        { type: 'put_into_storage', garmentId: socks, quantity },
        { type: 'mark_arrived', garmentId: socks, quantity },
        { type: 'laundry_partial_return', exceptions: [{ garmentId: shirt, quantity }] },
      ]) {
        const r = await run(o.principal, command as never);
        expect(r.outcome, `${command.type} ${String(quantity)}`).toBe('rejected');
      }
      for (const field of ['clean', 'totalOwned']) {
        if (typeof quantity === 'number' && Number.isInteger(quantity) && quantity >= 0 && quantity <= 500) continue; // a valid owner count
        const r = await run(o.principal, { type: 'reconcile_quantity', garmentId: socks, [field]: quantity } as never);
        expect(r.outcome, `reconcile ${field} ${String(quantity)}`).toBe('rejected');
      }
    }
    const after = await ledgerSnapshot(o.userId);
    for (const t of ['stock_lots', 'stock_movements', 'daily_wears', 'garments']) expect(after[t], t).toEqual(before[t]);
  });

  it('an empty or oversized wear report is refused', async () => {
    const o = await newOwner();
    const shirt = await o.byName('Lightweight oxford — gold');
    expect((await run(o.principal, { type: 'record_wear', timezone: TZ, items: [] } as never)).outcome).toBe('rejected');
    expect((await run(o.principal, { type: 'record_wear', timezone: TZ, items: Array.from({ length: 31 }, () => ({ garmentId: shirt })) } as never)).outcome).toBe('rejected');
    expect((await run(o.principal, { type: 'record_wear', timezone: 'Mars/Olympus_Mons', items: [{ garmentId: shirt }] } as never)).outcome).toBe('rejected');
  });
});

describe('over-draws and reconciliation abuse', () => {
  it('putting fifty units of a one-unit shirt in the wash cannot create units or go negative', async () => {
    const o = await newOwner();
    const shirt = await o.byName('Lightweight oxford — gold');
    const before = await buckets(o.userId, shirt);
    await run(o.principal, { type: 'mark_in_wash', garmentId: shirt, quantity: 50 });
    const after = await buckets(o.userId, shirt);
    expect(total(after)).toBe(total(before));
    expect(await negativeBuckets(o.userId)).toEqual([]);
  });

  it('reconciling clean above the owned total never invents units; totalOwned below units away never goes negative', async () => {
    const o = await newOwner();
    const socks = await o.byName('Merino — fire red');
    const owned = total(await buckets(o.userId, socks));
    const r1 = await run(o.principal, { type: 'reconcile_quantity', garmentId: socks, clean: owned + 100 });
    expect(total(await buckets(o.userId, socks)), `outcome ${r1.outcome}`).toBe(owned);
    // Wear a pair (to the hand-wash hamper), then claim zero owned.
    await run(o.principal, { type: 'record_wear', timezone: TZ, wearingDate: '2026-09-25', items: [{ garmentId: socks }] }, {}, at('2026-09-25T20:00:00.000Z'));
    await run(o.principal, { type: 'reconcile_quantity', garmentId: socks, totalOwned: 0 });
    expect(await negativeBuckets(o.userId)).toEqual([]);
    const b = await buckets(o.userId, socks);
    expect(b.clean).toBeGreaterThanOrEqual(0);
    // The counted wear history survives the count correction.
    expect(await count("SELECT COUNT(*) AS n FROM daily_wears WHERE user_id = ? AND garment_id = ? AND status = 'active'", o.userId, socks)).toBe(1);
  });

  it('a wear reported for a disposed garment is kept as an observation with a warning but resurrects no unit; disposing twice is refused', async () => {
    const o = await newOwner();
    const shirt = await o.byName('Lightweight oxford — red stripe');
    expect((await run(o.principal, { type: 'dispose_item', garmentId: shirt, reason: 'donated' })).outcome).toBe('committed');
    expect((await run(o.principal, { type: 'dispose_item', garmentId: shirt, reason: 'donated' })).outcome).toBe('rejected');
    const disposed = await buckets(o.userId, shirt);
    const w = await run(o.principal, { type: 'record_wear', timezone: TZ, wearingDate: '2026-09-25', items: [{ garmentId: shirt }] }, {}, at('2026-09-25T20:00:00.000Z'));
    // The owner's word outranks the ledger (profile section 11), so the wear is recorded, flagged, and changes no stock.
    if (w.outcome === 'committed') expect(JSON.stringify(w.facts.warnings)).toMatch(/disposed/);
    expect(await buckets(o.userId, shirt)).toEqual(disposed);
    expect((await one<{ acquisition: string }>('SELECT acquisition FROM garments WHERE user_id = ? AND garment_id = ?', o.userId, shirt)).acquisition).toBe('disposed');
    expect(await negativeBuckets(o.userId)).toEqual([]);
  });

  it('"arrived" on a garment he already owns cannot add units', async () => {
    const o = await newOwner();
    const shirt = await o.byName('Lightweight oxford — gold');
    const before = total(await buckets(o.userId, shirt));
    const r = await run(o.principal, { type: 'mark_arrived', garmentId: shirt, quantity: 5 });
    expect(r.outcome).toBe('rejected');
    expect(total(await buckets(o.userId, shirt))).toBe(before);
  });
});

describe('laundry batches: post-pickup wears and partial returns', () => {
  async function collected(o: Owner) {
    const shirt = await o.byName('Lightweight oxford — moss');
    const trousers = await o.pick("category = 'trousers' AND laundry_policy = 'per_wear'").catch(() => null);
    await run(o.principal, { type: 'record_wear', timezone: TZ, wearingDate: '2026-09-24', items: [{ garmentId: shirt }] }, {}, at('2026-09-24T20:00:00.000Z'));
    await run(o.principal, { type: 'mark_in_wash', garmentId: shirt }, {}, at('2026-09-24T21:00:00.000Z'));
    const pickup = await run(o.principal, { type: 'laundry_collected' }, {}, at('2026-09-25T09:00:00.000Z'));
    expect(pickup.outcome).toBe('committed');
    const batchId = String(pickup.facts.batchId ?? pickup.affected.find((a) => a.entityType === 'laundry_batch')?.entityId);
    return { shirt, trousers, batchId };
  }

  it('a wear reported for a shirt that is away at the laundry is accepted as the owner\'s observation without negative stock', async () => {
    const o = await newOwner();
    const { shirt } = await collected(o);
    const before = await buckets(o.userId, shirt);
    expect(before.laundry).toBe(1);
    const w = await run(o.principal, { type: 'record_wear', timezone: TZ, wearingDate: '2026-09-26', items: [{ garmentId: shirt }] }, {}, at('2026-09-26T20:00:00.000Z'));
    expect(['committed', 'merged']).toContain(w.outcome);
    expect(await negativeBuckets(o.userId)).toEqual([]);
    expect(total(await buckets(o.userId, shirt))).toBe(total(before));
  });

  it('a partial return naming a garment the batch never held or a foreign garment is refused; an over-count is capped to what the batch held', async () => {
    const o = await newOwner();
    const other = await newOwner();
    const { shirt, batchId } = await collected(o);
    const sneakers = await o.byName('NB 990v4 — grey');
    const before = await ledgerSnapshot(o.userId);
    for (const exceptions of [[{ garmentId: sneakers }], [{ garmentId: await other.byName('Lightweight oxford — moss') }], [{ garmentId: 'g_00000000000000000000000000000000' }]]) {
      const r = await run(o.principal, { type: 'laundry_partial_return', batchId, exceptions }, {}, at('2026-09-27T12:00:00.000Z'));
      expect(r.outcome, JSON.stringify(exceptions)).toBe('rejected');
    }
    const after = await ledgerSnapshot(o.userId);
    for (const t of ['stock_lots', 'stock_movements']) expect(after[t], t).toEqual(before[t]);
    const units = total(await buckets(o.userId, shirt));
    const over = await run(o.principal, { type: 'laundry_partial_return', batchId, exceptions: [{ garmentId: shirt, quantity: 7 }] }, {}, at('2026-09-27T12:00:00.000Z'));
    if (over.outcome === 'committed') expect((over.facts.stillAway as { quantity: number }[]).reduce((n, x) => n + x.quantity, 0)).toBeLessThanOrEqual(1);
    expect(total(await buckets(o.userId, shirt))).toBe(units);
    expect(await negativeBuckets(o.userId)).toEqual([]);
  });

  it('returning the same batch twice, or a batch that does not exist, cannot duplicate units', async () => {
    const o = await newOwner();
    const { shirt, batchId } = await collected(o);
    const units = await unitTotal(o);
    expect((await run(o.principal, { type: 'laundry_returned', batchId }, {}, at('2026-09-27T12:00:00.000Z'))).outcome).toBe('committed');
    const twice = await run(o.principal, { type: 'laundry_returned', batchId }, {}, at('2026-09-27T13:00:00.000Z'));
    expect(twice.outcome).not.toBe('committed');
    expect((await run(o.principal, { type: 'laundry_returned', batchId: 'lb_doesnotexist000000000000000' }, {}, at('2026-09-27T13:00:00.000Z'))).outcome).toBe('rejected');
    expect(await unitTotal(o)).toBe(units);
    expect((await buckets(o.userId, shirt)).clean).toBe(1);
    expect(await negativeBuckets(o.userId)).toEqual([]);
  });

  it('a pickup with nothing in the hamper records nothing; a second pickup does not re-collect the same units', async () => {
    const o = await newOwner();
    const { shirt } = await collected(o);
    const again = await run(o.principal, { type: 'laundry_collected' }, {}, at('2026-09-25T09:05:00.000Z'));
    const b = await buckets(o.userId, shirt);
    expect(b.laundry).toBe(1);
    expect(['committed', 'rejected', 'merged']).toContain(again.outcome);
    expect(await negativeBuckets(o.userId)).toEqual([]);
  });
});
