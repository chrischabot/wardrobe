import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { seedOwner, type Owner } from '../harness/owner.js';
import { App } from '../harness/http.js';
import { installWorld } from '../harness/world.js';
import { expectDoneReceipt, expectNotDone } from '../harness/ux.js';
import { offered } from '../harness/profile.js';

/**
 * Journey 19 — A consignment project (spec section 10 "Disposal, alterations, and practical
 * projects"; profile section 10; section 17 "External actions"). The owner's oversized pieces go to
 * consignment as a size correction, not a verdict: a prepared listing is a durable project that can
 * be resumed later; for-sale stock stays owned but out of daily outfits until it physically leaves;
 * a drafted listing never means the item has left.
 *
 * Not covered locally: submitting a listing through Browser Run and reconciling an ambiguous
 * submission outcome (needs a live browser session and a real shop).
 */

describe('Journey: preparing, resuming and completing a consignment', () => {
  let owner: Owner;
  let app: App;
  let jacket = '';
  let projectId = '';

  beforeAll(async () => {
    installWorld({ now: '2026-10-05T19:00:00.000Z', weather: { scenario: 'mild' } });
    owner = await seedOwner();
    app = new App(owner.assertion);
    jacket = await owner.byName('PWVC Belted Safari');
  });

  it('preparing the listing is recorded as a project with copy, price and next action; the jacket stays owned', async () => {
    const r = await app.commit({
      type: 'open_lifecycle_project',
      kind: 'consignment',
      garmentIds: [jacket],
      details: { destination: 'The consignment shop', collectionPreference: 'collection', reason: 'size_correction', listingCopy: 'Private White V.C. belted safari jacket, size 7, worn a handful of times.', askingPriceMinor: 32000, currency: 'GBP', nextAction: 'Photograph the jacket, then submit the listing' },
    });
    projectId = r.facts.projectId as string;
    // Reversal is "withdraw" (lifts the for-sale restriction), not an Undo banner.
    expectDoneReceipt(r, { undo: false });
    expect(r.facts).toMatchObject({ stillOwned: true, categoryVerdict: null });
    const item = (await app.wardrobe()).byId.get(jacket)!;
    expect(item.garment.acquisition).toBe('owned');
    expect(item.availability.available).toBe(false);
  });

  it('for-sale stock never appears on a daily board', async () => {
    await app.prepare({ date: '2026-10-06' });
    const t = await app.today('2026-10-06');
    expect(offered(t).flatMap((o) => o.garments.map((g) => g.garmentId))).not.toContain(jacket);
  });

  it('days later the prepared listing is resumed exactly where it was left', async () => {
    // SURFACE GAP: no HTTP route reads lifecycle projects; the durable record is read from D1.
    const row = await env.DB.prepare('SELECT * FROM lifecycle_projects WHERE user_id = ? AND project_id = ?').bind(owner.userId, projectId).first<Record<string, unknown>>();
    expect(row, 'the project is durable').toBeTruthy();
    expect(JSON.stringify(row)).toContain('Photograph the jacket, then submit the listing');
    expect(JSON.stringify(row)).toContain('Private White V.C. belted safari jacket');
    const listed = await app.commit({ type: 'advance_lifecycle_project', projectId, status: 'listed', note: 'Listing submitted by the owner' });
    expectDoneReceipt(listed, { undo: false }); // an external submission is corrected by withdrawing, not undone
    expect((await app.wardrobe()).byId.get(jacket)!.garment.acquisition).toBe('owned');
  });

  it('sold is still owned; only the collection records that it has left, with proceeds', async () => {
    const sold = await app.commit({ type: 'advance_lifecycle_project', projectId, status: 'sold', proceedsMinor: 30000, currency: 'GBP' });
    expect(sold.facts).toMatchObject({ stillOwned: true, gone: false });
    const backwards = await app.command({ type: 'advance_lifecycle_project', projectId, status: 'preparing' });
    expectNotDone(backwards.receipt);
    const gone = await app.commit({ type: 'advance_lifecycle_project', projectId, status: 'collected' });
    expect(gone.facts).toMatchObject({ gone: true, stillOwned: false });
    const g = (await app.wardrobe()).byId.get(jacket)!.garment;
    expect([g.acquisition, g.disposalReason]).toEqual(['disposed', 'sold']);
    // History is kept: the item page still opens.
    expect((await app.get(`/v1/items/${jacket}`)).status).toBe(200);
  });
});
