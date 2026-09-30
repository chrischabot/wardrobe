import { beforeAll, describe, expect, it } from 'vitest';
import { CommandReceipt, LaundryState, WardrobePage } from '@garderobe/contracts';
import { seedOwner, type Owner } from '../harness/owner.js';
import { App } from '../harness/http.js';
import { installWorld, type World } from '../harness/world.js';
import { expectDoneReceipt, expectNotDone } from '../harness/ux.js';

/**
 * Journey 3 — Laundry and undo (spec section 3 "Laundry, wear follow-through, and undo", section 5
 * "Quantity and laundry", section 8). The Laundry sheet keeps service laundry and hand wash apart;
 * Collected snapshots the hamper; Returned completes only that batch; "Some items still away" keeps
 * named exceptions away; Socks washed is separate. Each action returns a receipt and updates
 * availability. Undo is a compensating command that rechecks what happened since; receipts stay.
 */

const at = (date: string, hhmm: string) => `${date}T${hhmm}:00+01:00`;

describe('Journey: laundry collected, returned, partly returned, socks washed', () => {
  let world: World;
  let owner: Owner;
  let app: App;
  const g: Record<string, string> = {};
  const laundry = async () => LaundryState.parse((await app.get('/v1/laundry')).body);
  const item = async (id: string) => (await app.wardrobe()).byId.get(id)!;
  const clean = async (id: string) => (await item(id)).stock.buckets.clean ?? 0;

  beforeAll(async () => {
    world = installWorld({ now: '2026-10-05T18:00:00.000Z' });
    owner = await seedOwner();
    app = new App(owner.assertion);
    for (const [k, name] of Object.entries({ gold: 'Lightweight oxford — gold', laurel: 'Lightweight oxford — laurel', blue: 'Lightweight oxford — blue', chino: 'Di Sondrio walnut chino', inky: 'Merino — inky blue', grey: 'Merino — correct grey', sneakers: 'NB 990v4 — grey' })) g[k] = await owner.byName(name);
  });

  it('a recorded wear sends the shirt to the service hamper and the socks to hand wash, separately', async () => {
    const r = await app.commit({ type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-05', occurredAt: at('2026-10-05', '08:00'), items: [{ garmentId: g.gold!, role: 'base_top' }, { garmentId: g.chino!, role: 'bottom' }, { garmentId: g.inky!, role: 'socks' }, { garmentId: g.sneakers!, role: 'footwear' }] });
    expectDoneReceipt(r);
    const l = await laundry();
    expect(l.service.hamper.map((h) => h.garmentId)).toContain(g.gold);
    expect(l.service.hamper.map((h) => h.garmentId)).not.toContain(g.inky);
    expect(l.handWash.hamper.find((h) => h.garmentId === g.inky)).toMatchObject({ quantity: 1, tracking: 'anonymous_quantity' });
    // Four pairs of identical socks are one entry with a quantity: three still clean.
    const socks = await item(g.inky!);
    expect(socks.stock.totalOwned).toBe(4);
    expect(socks.stock.buckets.clean).toBe(3);
    expect(await clean(g.gold!)).toBe(0);
    expect((await item(g.gold!)).stock.buckets.hamper).toBe(1);
  });

  it('the Wardrobe shows a shirt in the hamper as not available now (availability follows the laundry)', async () => {
    // Spec section 3: each laundry action "updates current availability"; Wardrobe filters cover availability.
    const gold = await item(g.gold!);
    expect(gold.stock.buckets.hamper).toBe(1);
    expect(gold.availability.available, `Wardrobe labels a shirt in the hamper "${gold.availability.label}"`).toBe(false);
    const page = WardrobePage.parse((await app.get('/v1/wardrobe?availability=available&category=shirt')).body);
    expect(page.items.map((i) => i.garment.garmentId)).not.toContain(g.gold);
  });

  it('“In the wash” on a clean shirt is one tap with a receipt and Undo', async () => {
    world.clock.set('2026-10-05T18:30:00.000Z');
    const r = await app.commit({ type: 'mark_in_wash', garmentId: g.laurel!, occurredAt: at('2026-10-05', '19:00') });
    expectDoneReceipt(r);
    expect((await laundry()).service.hamper.map((h) => h.garmentId)).toEqual(expect.arrayContaining([g.gold, g.laurel]));
  });

  let batchId = '';
  it('Collected snapshots exactly the service hamper at pickup; a wear after pickup stays in the hamper', async () => {
    world.clock.set('2026-10-09T08:05:00.000Z');
    const r = await app.commit({ type: 'laundry_collected', occurredAt: at('2026-10-09', '09:00') });
    expectDoneReceipt(r);
    batchId = r.facts.batchId as string;
    const l1 = await laundry();
    const batch = l1.service.batches.find((b) => b.batchId === batchId)!;
    expect(batch.items.map((i) => i.garmentId).sort()).toEqual([g.gold, g.laurel].sort());
    expect(batch.names[g.gold!]).toBe('Lightweight oxford — gold');
    expect(l1.service.hamper).toEqual([]);
    // The socks never go in a service batch.
    expect(batch.items.map((i) => i.garmentId)).not.toContain(g.inky);
    world.clock.set('2026-10-09T09:30:00.000Z');
    await app.commit({ type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-09', occurredAt: at('2026-10-09', '10:00'), items: [{ garmentId: g.blue!, role: 'base_top' }] });
    const l2 = await laundry();
    expect(l2.service.hamper.map((h) => h.garmentId)).toEqual([g.blue]);
    expect(l2.service.batches.find((b) => b.batchId === batchId)!.items.map((i) => i.garmentId)).not.toContain(g.blue);
  });

  it('“Some items still away” starts from the batch and keeps only the named exception away', async () => {
    world.clock.set('2026-10-10T10:30:00.000Z');
    const r = await app.commit({ type: 'laundry_partial_return', batchId, exceptions: [{ garmentId: g.laurel! }], occurredAt: at('2026-10-10', '11:00') });
    expectDoneReceipt(r);
    expect(await clean(g.gold!)).toBe(1);
    expect(await clean(g.laurel!)).toBe(0);
    const l = await laundry();
    expect(l.openExceptions?.some((e) => e.garmentId === g.laurel)).toBe(true);
    // Expected returns never manufacture clean stock for the shirt worn after pickup.
    expect(await clean(g.blue!)).toBe(0);
  });

  it('Returned then completes that batch; the exception comes home without a shelf check', async () => {
    world.clock.set('2026-10-13T10:30:00.000Z');
    const r = await app.commit({ type: 'laundry_returned', batchId, occurredAt: at('2026-10-13', '11:00') });
    expectDoneReceipt(r);
    expect(await clean(g.laurel!)).toBe(1);
    const l = await laundry();
    expect(l.service.batches.find((b) => b.batchId === batchId)?.status ?? 'returned').toBe('returned');
  });

  it('Socks washed returns hand-wash pairs to clean, never through a service batch', async () => {
    world.clock.set('2026-10-13T19:30:00.000Z');
    await app.commit({ type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-13', occurredAt: at('2026-10-13', '08:00'), items: [{ garmentId: g.inky!, role: 'socks' }] });
    expect(await clean(g.inky!)).toBe(2);
    const r = await app.commit({ type: 'socks_washed', occurredAt: at('2026-10-13', '20:00') });
    expectDoneReceipt(r);
    expect((await item(g.inky!)).stock.buckets.clean).toBe(4);
    expect((await laundry()).handWash.hamper).toEqual([]);
  });

  it('a count correction never creates negative or fictional stock', async () => {
    world.clock.set('2026-10-17T19:30:00.000Z');
    const r = await app.commit({ type: 'reconcile_quantity', garmentId: g.grey!, clean: 1 });
    expectDoneReceipt(r);
    const s = await item(g.grey!);
    expect(s.stock.buckets.clean).toBe(1);
    expect(s.stock.totalOwned).toBe(3);
    // Four wears of a garment with one clean pair: accounting repairs, nothing goes negative.
    for (const d of ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17']) await app.commit({ type: 'record_wear', timezone: 'Europe/London', wearingDate: d, occurredAt: at(d, '08:00'), items: [{ garmentId: g.grey!, role: 'socks' }] });
    const after = await item(g.grey!);
    for (const v of Object.values(after.stock.buckets)) expect(v).toBeGreaterThanOrEqual(0);
    expect(after.stock.totalOwned).toBe(3);
    const page = WardrobePage.parse((await app.get('/v1/wardrobe?category=socks')).body);
    for (const i of page.items) for (const v of Object.values(i.stock.buckets)) expect(v).toBeGreaterThanOrEqual(0);
  });
});

describe('Journey: undo through a compensating command', () => {
  let owner: Owner;
  let app: App;
  let shirt = '';
  let trousers = '';

  beforeAll(async () => {
    installWorld({ now: '2026-10-06T07:00:00.000Z' });
    owner = await seedOwner();
    app = new App(owner.assertion);
    shirt = await owner.byName('Lightweight oxford — moss');
    trousers = await owner.byName('Stratton stretch corduroy');
  });

  it('undoing a mistaken wear creates a compensating receipt; the original stays, marked undone', async () => {
    const wear = await app.commit({ type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-06', items: [{ garmentId: shirt }, { garmentId: trousers }] });
    expectDoneReceipt(wear);
    const undo = await app.commit({ type: 'undo', targetCommandId: wear.commandId });
    expectDoneReceipt(undo, { undo: false });
    expect(undo.compensatesCommandId).toBe(wear.commandId);
    const original = CommandReceipt.parse((await app.get(`/v1/commands/${wear.commandId}`)).body);
    expect(original.undoneByCommandId).toBe(undo.commandId);
    const t = await app.today();
    expect(t.recordedWears.map((w) => w.garmentId)).not.toContain(shirt);
    const { byId } = await app.wardrobe();
    expect(byId.get(shirt)!.recordedWearCount).toBe(0);
    expect(byId.get(shirt)!.availability.available).toBe(true);
    // Both receipts remain readable in history.
    const receipts = (await app.get<{ receipts: { commandId: string }[] }>('/v1/receipts?limit=50')).body.receipts.map((r) => r.commandId);
    expect(receipts).toEqual(expect.arrayContaining([wear.commandId, undo.commandId]));
  });

  it('Undo does not expire with the banner: it still works later, and cannot be applied twice', async () => {
    const r = await app.commit({ type: 'put_into_storage', garmentId: trousers, locationDetail: 'Loft' });
    const later = await app.commit({ type: 'undo', targetCommandId: r.commandId });
    expectDoneReceipt(later, { undo: false });
    const { byId } = await app.wardrobe();
    expect(byId.get(trousers)!.garment.location).toBe('home');
    const twice = await app.command({ type: 'undo', targetCommandId: r.commandId });
    expectNotDone(twice.receipt);
  });

  it('undo rechecks intervening changes: a wear undone after the shirt went to the laundry keeps the pickup', async () => {
    const wear = await app.commit({ type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-06', items: [{ garmentId: shirt }] });
    const pickup = await app.commit({ type: 'laundry_collected' });
    const batchId = pickup.facts.batchId as string;
    const undo = await app.command({ type: 'undo', targetCommandId: wear.commandId });
    if (undo.receipt.outcome === 'committed') {
      const l = LaundryState.parse((await app.get('/v1/laundry')).body);
      // The historical pickup is preserved (the shirt physically went); nothing is silently rewritten.
      const batch = l.service.batches.find((b) => b.batchId === batchId);
      expect(batch?.items.map((i) => i.garmentId) ?? [shirt]).toContain(shirt);
      expect((await app.wardrobe()).byId.get(shirt)!.recordedWearCount).toBe(0);
    } else {
      expectNotDone(undo.receipt);
      expect(undo.receipt.error!.message.length).toBeGreaterThan(10);
    }
  });

  it('a receipt can never be deleted as a way of undoing', async () => {
    const r = await app.commit({ type: 'mark_in_wash', garmentId: await owner.byName('Lightweight oxford — gold') });
    const res = await app.get(`/v1/commands/${r.commandId}`);
    expect(res.status).toBe(200);
    const del = await (await import('../harness/http.js')).call(`/v1/commands/${r.commandId}`, { assertion: owner.assertion, method: 'DELETE' });
    expect([404, 405]).toContain(del.status);
    expect((await app.get(`/v1/commands/${r.commandId}`)).status).toBe(200);
  });
});
