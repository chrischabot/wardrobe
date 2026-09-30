import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { ItemDetail, type CommandReceipt } from '@garderobe/contracts';
import { seedOwner, type Owner } from '../harness/owner.js';
import { App } from '../harness/http.js';
import { installWorld, type World } from '../harness/world.js';
import { expectDoneReceipt, expectNotDone, INTERROGATION } from '../harness/ux.js';

/**
 * Journey 14 — Return and exchange deadlines (spec section 10 "Return and exchange deadlines";
 * section 17 row "Returns": sourced request/post/receipt deadlines, reminders, partial refunds and
 * exchanges retain correct stock and monetary states). A Drake's order of a white button-down and a
 * navy games blazer: no deadline from vague terms or from a predicted delivery; a sourced window and
 * the recorded arrival give a deadline at 23:59 in the stated timezone with reminders seven and two
 * days before; drafting and requesting a return keep the shirt owned, posting it retires the stock,
 * and the refund lands on the order line; the blazer is exchanged for a larger size without ever
 * being owned twice, and a partial refund of the price difference keeps the money straight.
 *
 * Everything runs through POST /v1/commands (source 'app'). Order lines and deadlines have no read
 * route, so their state is read from D1 (noted per test). Stand-in: FakeWeatherProvider for Open-Meteo.
 */

const RETURNS_URL = 'https://www.drakes.com/pages/returns';

interface LineRow {
  line_id: string;
  external_line_id: string;
  status: string;
  arrived_qty: number;
  refunded_minor: number;
  remake_of_line_id: string | null;
  quantity: number;
  unit_price_minor: number;
  garment_id: string | null;
}

describe('Journey: returning a shirt and exchanging a blazer from one Drake’s order', () => {
  let world: World;
  let owner: Owner;
  let app: App;
  let shirt: string;
  let blazer44: string;
  let blazer46: string;
  let lineA: string;
  let lineB: string;
  let arrivalReceipt: CommandReceipt;

  const line = async (id: string) => (await env.DB.prepare('SELECT * FROM order_lines WHERE user_id = ? AND line_id = ?').bind(owner.userId, id).first<LineRow>())!;
  const deadlines = async () =>
    (await env.DB.prepare('SELECT line_id, kind, deadline_at, timezone, status, terms_source FROM return_deadlines WHERE user_id = ? ORDER BY deadline_at').bind(owner.userId).all<{ line_id: string; kind: string; deadline_at: string; timezone: string; status: string; terms_source: string }>()).results;
  const item = async (id: string) => ItemDetail.parse((await app.get(`/v1/items/${id}`)).body).item;
  const counts = async () => (await app.wardrobe()).page.counts;
  const terms = (over: { lineId: string; kind: 'request' | 'post' | 'retailer_receipt'; quote: string; windowDays: number; trigger: { event: 'delivery' | 'order' | 'dispatch'; date: string; evidence: string }; timezone?: string }) => ({
    type: 'record_return_terms' as const,
    lineId: over.lineId,
    kind: over.kind,
    terms: { sourceRef: RETURNS_URL, quote: over.quote, checkedAt: world.clock.now(), windowDays: over.windowDays },
    trigger: over.trigger,
    timezone: over.timezone ?? 'Europe/London',
  });

  beforeAll(async () => {
    world = installWorld({ now: '2026-09-22T10:00:00.000Z', weather: { scenario: 'mild' } });
    owner = await seedOwner();
    app = new App(owner.assertion);
    // The owner logs the order: the two pieces he is waiting for, linked to their order lines.
    shirt = (await app.commit({ type: 'add_item', explicit: true, name: 'Oxford button-down — white', category: 'shirt', roles: ['base_top'], maker: "Drake's", sizeLabel: '16', acquisition: 'incoming' })).facts.garmentId as string;
    blazer44 = (await app.commit({ type: 'add_item', explicit: true, name: 'Games blazer — navy (44)', category: 'blazer', roles: ['outer_layer'], maker: "Drake's", sizeLabel: '44', acquisition: 'incoming' })).facts.garmentId as string;
    const order = await app.commit({
      type: 'import_order',
      merchant: "Drake's",
      merchantOrderNumber: 'DR-40210',
      orderedAt: '2026-09-22T10:00:00.000Z',
      currency: 'GBP',
      sourceRef: 'gmail:gm_dr40210',
      lines: [
        { externalLineId: 'OCBD-WHT|16', description: 'Oxford button-down — white', quantity: 1, unitPriceMinor: 16500, arrivalEstimate: '2026-09-25', garmentId: shirt },
        { externalLineId: 'GB4-NVY|44', description: 'Games blazer — navy', quantity: 1, unitPriceMinor: 89500, arrivalEstimate: '2026-09-25', garmentId: blazer44 },
      ],
    });
    [lineA, lineB] = order.facts.createdLineIds as [string, string];
  });

  it('no deadline is invented: vague terms and a predicted delivery date are refused, and nothing reads as done', async () => {
    const vague = await app.command(terms({ lineId: lineA, kind: 'request', quote: 'Returns are accepted in most cases, subject to our policy.', windowDays: 28, trigger: { event: 'order', date: '2026-09-22', evidence: 'gmail:gm_dr40210' } }));
    expect(vague.status).toBe(422);
    expectNotDone(vague.receipt);
    expect(vague.receipt.error!.code).toBe('evidence_required');
    // The dispatch estimate is not a delivery: nothing has arrived yet.
    const estimate = await app.command(terms({ lineId: lineA, kind: 'request', quote: 'You can return unworn items within 28 days of delivery.', windowDays: 28, trigger: { event: 'delivery', date: '2026-09-25', evidence: 'Estimated delivery in the dispatch email' } }));
    expectNotDone(estimate.receipt);
    expect(estimate.receipt.error!.code).toBe('evidence_required');
    expect(estimate.receipt.error!.message).toMatch(/no recorded arrival/);
    // SURFACE GAP: no HTTP/MCP read route for return deadlines; read from D1
    expect(await deadlines()).toEqual([]);
  });

  it('once the owner says the parcel arrived, a sourced 28-day window gives a request deadline at 23:59 London, with reminders seven and two days before', async () => {
    world.clock.set('2026-09-26T12:00:00.000Z');
    arrivalReceipt = await app.commit({ type: 'mark_arrived', garmentId: shirt, occurredAt: '2026-09-26T11:00:00.000Z' });
    expectDoneReceipt(arrivalReceipt);
    expectDoneReceipt(await app.commit({ type: 'mark_arrived', garmentId: blazer44, occurredAt: '2026-09-26T11:00:00.000Z' }));
    expect(await counts()).toMatchObject({ owned: 146, incoming: 0 });

    const r = await app.commit(terms({ lineId: lineA, kind: 'request', quote: 'You can return unworn items within 28 days of delivery for a refund or exchange.', windowDays: 28, trigger: { event: 'delivery', date: '2026-09-26', evidence: `mark_arrived ${arrivalReceipt.commandId}` } }));
    expectDoneReceipt(r, { undo: false });
    expect(r.undo.reason).toBeTruthy();
    expect(r.facts).toMatchObject({ kind: 'request', deadlineDate: '2026-10-24', deadlineAt: '2026-10-24T22:59:00.000Z', timezone: 'Europe/London', reminderDates: ['2026-10-17', '2026-10-22'] });
    expect(r.summary).toContain('2026-10-24');
    expect(r.summary).toContain(RETURNS_URL);
    expect(r.summary).not.toMatch(INTERROGATION);
  });

  it('a retailer-receipt deadline across the end of British Summer Time lands at 23:59 GMT on the right day', async () => {
    const r = await app.commit(terms({ lineId: lineA, kind: 'retailer_receipt', quote: 'Returned items must reach our warehouse within 35 days of delivery.', windowDays: 35, trigger: { event: 'delivery', date: '2026-09-26', evidence: `mark_arrived ${arrivalReceipt.commandId}` } }));
    expectDoneReceipt(r, { undo: false });
    expect(r.facts).toMatchObject({ kind: 'retailer_receipt', deadlineDate: '2026-10-31', deadlineAt: '2026-10-31T23:59:00.000Z' });
    // SURFACE GAP: no HTTP/MCP read route for return deadlines; read from D1
    const rows = await deadlines();
    expect(rows.map((d) => [d.kind, d.deadline_at, d.timezone, d.status])).toEqual([
      ['request', '2026-10-24T22:59:00.000Z', 'Europe/London', 'open'],
      ['retailer_receipt', '2026-10-31T23:59:00.000Z', 'Europe/London', 'open'],
    ]);
    for (const d of rows) expect(JSON.parse(d.terms_source)).toMatchObject({ sourceRef: RETURNS_URL, trigger: { event: 'delivery', date: '2026-09-26' } });
  });

  it('the deadline counts from the real delivery date, not the predicted one, once an arrival is recorded', async () => {
    const r = await app.command(terms({ lineId: lineB, kind: 'post', quote: 'Please post your return to us within 30 days of delivery.', windowDays: 30, trigger: { event: 'delivery', date: '2026-09-25', evidence: 'Estimated delivery in the dispatch email' } }));
    if (r.receipt.outcome === 'committed' || r.receipt.outcome === 'merged') {
      expect(r.receipt.facts.deadlineDate, 'deadline counted from the dispatch estimate (25 Sept) instead of the recorded arrival (26 Sept)').toBe('2026-10-26');
    } else {
      expectNotDone(r.receipt);
    }
  });

  it('drafting and requesting a return keep the shirt owned (out of outfits); posting it retires the stock; the refund lands on the order line', async () => {
    world.clock.set('2026-09-30T09:00:00.000Z');
    const open = await app.commit({ type: 'open_lifecycle_project', kind: 'return', garmentIds: [shirt], details: { orderLineId: lineA, destination: "Drake's returns", collectionPreference: 'collection', nextAction: 'Book the courier collection' } });
    expectDoneReceipt(open, { undo: false });
    expect(open.undo.reason).toMatch(/Withdraw/);
    expect(open.facts).toMatchObject({ kind: 'return', stillOwned: true });
    const projectId = open.facts.projectId as string;
    let s = await item(shirt);
    expect(s.garment.acquisition).toBe('owned');
    expect(s.availability.available).toBe(false); // return pending: out of ordinary planning
    expect((await counts()).owned).toBe(146);

    const requested = await app.commit({ type: 'advance_lifecycle_project', projectId, status: 'requested' });
    expectDoneReceipt(requested, { undo: false });
    expect(requested.facts).toMatchObject({ stillOwned: true, gone: false });
    expect((await item(shirt)).garment.acquisition).toBe('owned');
    expect((await counts()).owned).toBe(146);

    world.clock.set('2026-10-02T10:00:00.000Z');
    const posted = await app.commit({ type: 'advance_lifecycle_project', projectId, status: 'posted', occurredAt: '2026-10-02T09:30:00.000Z' });
    expectDoneReceipt(posted, { undo: false });
    expect(posted.summary).toMatch(/posted and gone/);
    expect(posted.facts).toMatchObject({ gone: true, stillOwned: false, disposedGarmentIds: [shirt] });
    s = await item(shirt);
    expect([s.garment.acquisition, s.garment.disposalReason]).toEqual(['disposed', 'returned']);
    expect(await counts()).toMatchObject({ owned: 145, retired: 1 });

    world.clock.set('2026-10-06T10:00:00.000Z');
    const refunded = await app.commit({ type: 'advance_lifecycle_project', projectId, status: 'refunded', refundMinor: 16500, currency: 'GBP' });
    expectDoneReceipt(refunded, { undo: false });
    // SURFACE GAP: no HTTP/MCP read route for order lines; read from D1
    expect(await line(lineA)).toMatchObject({ status: 'refunded', refunded_minor: 16500, arrived_qty: 1 });
  });

  it('an exchange links the outgoing 44 and the incoming 46 without the blazer ever being owned twice; a partial refund of the difference keeps the money straight', async () => {
    world.clock.set('2026-09-30T10:00:00.000Z');
    const ex = await app.commit({ type: 'record_order_event', merchant: "Drake's", merchantOrderNumber: 'DR-40210', event: 'exchange_requested', externalLineIds: ['GB4-NVY|44'], sourceRef: 'gmail:gm_dr40210_exchange' });
    expectDoneReceipt(ex, { undo: false });
    expect((await line(lineB)).status).toBe('exchange_requested');
    expect((await item(blazer44)).garment.acquisition).toBe('owned'); // requesting an exchange removes nothing

    blazer46 = (await app.commit({ type: 'add_item', explicit: true, name: 'Games blazer — navy (46)', category: 'blazer', roles: ['outer_layer'], maker: "Drake's", sizeLabel: '46', acquisition: 'incoming' })).facts.garmentId as string;
    const replacement = await app.commit({ type: 'import_order', merchant: "Drake's", merchantOrderNumber: 'DR-40210', orderedAt: '2026-09-22T10:00:00.000Z', currency: 'GBP', sourceRef: 'gmail:gm_dr40210_exchange', lines: [{ externalLineId: 'GB4-NVY|46', description: 'Games blazer — navy (exchange)', quantity: 1, unitPriceMinor: 0, remakeOfExternalLineId: 'GB4-NVY|44', garmentId: blazer46 }] });
    const lineB2 = (replacement.facts.createdLineIds as string[])[0]!;
    expect(replacement.facts.remakes).toEqual([{ lineId: lineB2, originalLineId: lineB }]);
    expect((await line(lineB2)).remake_of_line_id).toBe(lineB);
    expect((await line(lineB)).status).toBe('replaced_by_remake');

    // The owner already owns other Drake's Games jackets; only the exchanged pair matters here.
    const ownedBlazers = async () => [...(await app.wardrobe('q=Games%20blazer')).byId.values()].filter((i) => i.garment.acquisition === 'owned' && /^Games blazer — navy \(/.test(i.garment.name)).map((i) => i.garment.name);
    expect(await ownedBlazers()).toEqual(['Games blazer — navy (44)']);
    expect((await counts()).incoming).toBe(1);

    const ret = await app.commit({ type: 'open_lifecycle_project', kind: 'return', garmentIds: [blazer44], details: { orderLineId: lineB, destination: "Drake's returns", collectionPreference: 'collection' } });
    const projectId = ret.facts.projectId as string;
    await app.commit({ type: 'advance_lifecycle_project', projectId, status: 'requested' });
    expect(await ownedBlazers()).toEqual(['Games blazer — navy (44)']);
    world.clock.set('2026-10-01T10:00:00.000Z');
    await app.commit({ type: 'advance_lifecycle_project', projectId, status: 'posted' });
    expect(await ownedBlazers()).toEqual([]);
    expect((await item(blazer44)).garment.disposalReason).toBe('returned');

    world.clock.set('2026-10-04T12:00:00.000Z');
    expectDoneReceipt(await app.commit({ type: 'mark_arrived', garmentId: blazer46, occurredAt: '2026-10-04T11:00:00.000Z' }));
    expect(await ownedBlazers()).toEqual(['Games blazer — navy (46)']);
    expect(await line(lineB2)).toMatchObject({ arrived_qty: 1, status: 'arrived' });

    // Drake's refunds £50 of the original line as the price difference.
    const partial = await app.commit({ type: 'record_order_event', merchant: "Drake's", merchantOrderNumber: 'DR-40210', event: 'refunded', externalLineIds: ['GB4-NVY|44'], refundMinor: 5000, sourceRef: 'gmail:gm_dr40210_refund' });
    expectDoneReceipt(partial, { undo: false });
    // SURFACE GAP: no HTTP/MCP read route for order lines; read from D1
    expect(await line(lineB)).toMatchObject({ status: 'partially_refunded', refunded_minor: 5000 });
    expect((await counts()).owned).toBe(145); // 144 + the 46; the shirt and the 44 went back
  });

  it('a refund can never exceed what was paid, so money states cannot go negative', async () => {
    const over = await app.command({ type: 'record_order_event', merchant: "Drake's", merchantOrderNumber: 'DR-40210', event: 'refunded', externalLineIds: ['OCBD-WHT|16'], refundMinor: 5000, sourceRef: 'gmail:gm_dr40210_bad' });
    expectNotDone(over.receipt);
    expect(await line(lineA)).toMatchObject({ status: 'refunded', refunded_minor: 16500 });
  });
});
