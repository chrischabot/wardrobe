import { beforeAll, describe, expect, it } from 'vitest';
import { ItemDetail, TemperaturePreview, WardrobePage } from '@garderobe/contracts';
import { seedOwner, TEST_EVENT_LABEL, type Owner } from '../harness/owner.js';
import { App } from '../harness/http.js';
import { installWorld, type World } from '../harness/world.js';
import { expectDoneReceipt } from '../harness/ux.js';
import { offered } from '../harness/profile.js';
import { connectAssistant, connectMcp } from '../harness/mcp.js';

/**
 * Journey 4 — Wardrobe (spec section 3 "Wardrobe"; section 8 aliases). Search accepts the owner's
 * names, manufacturer names and codes (PCF…); filters cover category, availability, colour, season,
 * location and last wear. "In the wash", "Back from the tailor", "Arrived" and "Put into storage" are
 * direct commands with receipts. The temperature preview is explicitly a simulation.
 */

describe('Journey: wardrobe search by the owner’s names, maker names and PCF codes, with filters', () => {
  let owner: Owner;
  let app: App;
  const search = async (q: string) => WardrobePage.parse((await app.get(`/v1/wardrobe?q=${encodeURIComponent(q)}`)).body).items.map((i) => i.garment.name);

  beforeAll(async () => {
    installWorld({ now: '2026-10-06T07:00:00.000Z' });
    owner = await seedOwner();
    app = new App(owner.assertion);
  });

  it('finds a shirt by the name on the owner’s own list', async () => {
    expect(await search('Clark oxford — beige')).toContain('Clark oxford — beige');
    expect(await search('wide stripe')).toEqual(expect.arrayContaining(['Lightweight oxford — light blue wide stripe']));
  });

  it('finds a Proper Cloth shirt by its PCF code and by the maker', async () => {
    expect(await search('PCF4510')).toEqual(['Clark oxford — beige']);
    expect(await search('pcf4510')).toEqual(['Clark oxford — beige']);
    expect((await search('Proper Cloth')).length).toBeGreaterThan(5);
  });

  it('an ambiguous phrase gets one question with the distinguishing facts, never a new garment', async () => {
    const grant = await connectAssistant(owner.assertion, 'claude', ['wardrobe:read']);
    const mcp = await connectMcp(grant.accessToken);
    const r = await mcp.tool('garderobe_inventory', { view: 'resolve', phrase: 'blue stripe' });
    const res = r.structuredContent!.resolution as { status: string; candidates?: { name: string; distinguishing: string }[] };
    expect(res.status).toBe('ambiguous');
    expect(res.candidates!.length).toBeGreaterThanOrEqual(2);
    for (const c of res.candidates!) expect(c.distinguishing.length).toBeGreaterThan(3);
    const exact = await mcp.tool('garderobe_inventory', { view: 'resolve', phrase: 'PCF4510' });
    expect(exact.structuredContent!.resolution).toMatchObject({ status: 'resolved', name: 'Clark oxford — beige' });
    const none = await mcp.tool('garderobe_inventory', { view: 'resolve', phrase: 'purple velvet smoking jacket' });
    expect((none.structuredContent!.resolution as { status: string }).status).toBe('not_found');
    expect((await app.wardrobe()).page.total).toBe(144);
    await mcp.close();
  });

  it('filters by category, colour family, location and last recorded wear; “no recorded wear” is not “unworn”', async () => {
    const jeans = WardrobePage.parse((await app.get('/v1/wardrobe?category=jeans')).body);
    expect(jeans.items.map((i) => i.garment.name).sort()).toEqual(expect.arrayContaining(['Jeans — dark', 'Jeans — light', 'Jeans — mid']));
    const home = WardrobePage.parse((await app.get('/v1/wardrobe?location=home')).body);
    expect(home.items.every((i) => i.garment.location === 'home')).toBe(true);
    const fam = home.items.find((i) => i.garment.colorFamily)!.garment.colorFamily!;
    const byFam = WardrobePage.parse((await app.get(`/v1/wardrobe?colorFamily=${fam}`)).body);
    expect(byFam.items.length).toBeGreaterThan(0);
    expect(byFam.items.every((i) => i.garment.colorFamily === fam)).toBe(true);
    const shirt = await owner.byName('Clark oxford — beige');
    await app.commit({ type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-05', items: [{ garmentId: shirt }] });
    const before = WardrobePage.parse((await app.get('/v1/wardrobe?lastWornBefore=2026-10-01')).body);
    expect(before.items.map((i) => i.garment.garmentId)).not.toContain(shirt);
    expect(before.total).toBe(143);
    const benched = WardrobePage.parse((await app.get('/v1/wardrobe?availability=unavailable')).body);
    expect(benched.items.some((i) => /Benched/.test(i.availability.label))).toBe(true);
    for (const i of benched.items) expect(i.availability.reasons.length).toBeGreaterThan(0);
  });

  it('an item page carries status, availability basis, care, history and receipts in owner language', async () => {
    const shirt = await owner.byName('Clark oxford — beige');
    const d = ItemDetail.parse((await app.get(`/v1/items/${shirt}`)).body);
    expect(d.item.garment.maker).toBe('Proper Cloth');
    expect(d.item.aliases.map((a) => a.phrase)).toContain('PCF4510');
    expect(d.item.garment.careChannel).toBe('service');
    expect(d.wearHistory.map((w) => w.wearingDate)).toContain('2026-10-05');
    // Spec section 3: the receipt "remains accessible in item history and conversation".
    const all = (await app.get<{ receipts: { commandId: string; commandType: string }[] }>('/v1/receipts?limit=20')).body.receipts;
    const wear = all.find((r) => r.commandType === 'record_wear')!;
    expect(d.receipts.map((r) => r.commandId), 'the wear receipt is in the item history').toContain(wear.commandId);
    expect(d.receipts[0]!.summary.length).toBeGreaterThan(5);
  });
});

describe('Journey: item commands — in the wash, tailor, arrived, storage', () => {
  let world: World;
  let owner: Owner;
  let app: App;
  const detail = async (id: string) => ItemDetail.parse((await app.get(`/v1/items/${id}`)).body);

  beforeAll(async () => {
    world = installWorld({ now: '2026-10-05T19:00:00.000Z', weather: { scenario: 'coldSnap' } });
    owner = await seedOwner();
    app = new App(owner.assertion);
  });

  it('Send to the tailor and Back from the tailor move the jacket and open/close the project', async () => {
    const jacket = await owner.byName("Drake's Camel Field Games");
    const out = await app.commit({ type: 'send_to_tailor', garmentId: jacket, work: 'Take in the waist', expectedReturn: '2026-10-20' });
    expectDoneReceipt(out);
    expect(out.summary).toMatch(/tailor/i);
    const d = await detail(jacket);
    expect(d.item.garment.location).toBe('tailor');
    expect(d.item.availability.available).toBe(false);
    await app.prepare({ date: '2026-10-06' });
    const t = await app.today('2026-10-06');
    expect(offered(t).flatMap((o) => o.garments.map((g) => g.garmentId))).not.toContain(jacket);
    const back = await app.commit({ type: 'back_from_tailor', garmentId: jacket, note: 'Waist taken in 2 cm' });
    expectDoneReceipt(back);
    expect((await detail(jacket)).item.garment.location).toBe('home');
  });

  it('Put into storage and Take out of storage are reversible and keep the location', async () => {
    const coat = await owner.byName('DBF Grandfather Coat');
    const r = await app.commit({ type: 'put_into_storage', garmentId: coat, locationDetail: 'Loft' });
    expectDoneReceipt(r);
    const d = await detail(coat);
    expect(d.item.garment.location).toBe('storage');
    expect(d.item.garment.locationDetail).toBe('Loft');
    expect(d.item.availability.available).toBe(false);
    // The temperature preview answers what becomes wearable in the cold, including stored pieces,
    // and is explicitly a simulation that changes nothing.
    const p = TemperaturePreview.parse((await app.get('/v1/wardrobe/temperature-preview?temperatureC=2')).body);
    expect(p.simulation).toBe(true);
    expect(p.note).toMatch(/simulation/i);
    const stored = p.items.find((i) => i.garmentId === coat);
    expect(stored, 'stored coat appears in the preview').toBeTruthy();
    expect(stored!.inStorage).toBe(true);
    expect((await detail(coat)).item.garment.location).toBe('storage');
    const back = await app.commit({ type: 'take_out_of_storage', garmentId: coat });
    expectDoneReceipt(back);
    expect((await detail(coat)).item.garment.location).toBe('home');
  });

  it('Arrived turns an incoming order into owned stock with a receipt; an order alone never does', async () => {
    const add = await app.commit({ type: 'add_item', explicit: true, name: `Paraboot Michæl — test (${TEST_EVENT_LABEL})`.slice(0, 120), category: 'shoes', roles: ['footwear'], maker: 'Paraboot', acquisition: 'incoming', attributes: { construction: 'welted', testEvent: true }, notes: TEST_EVENT_LABEL });
    const id = add.facts.garmentId as string;
    let d = await detail(id);
    expect(d.item.garment.acquisition).toBe('incoming');
    expect(d.item.availability.label).toBe('Incoming');
    const counts0 = (await app.wardrobe()).page.counts;
    const arrived = await app.commit({ type: 'mark_arrived', garmentId: id });
    expectDoneReceipt(arrived);
    d = await detail(id);
    expect(d.item.garment.acquisition).toBe('owned');
    expect(d.item.stock.totalOwned).toBe(1);
    const counts1 = (await app.wardrobe()).page.counts;
    expect(counts1.incoming).toBe(counts0.incoming - 1);
    expect(counts1.owned).toBe(counts0.owned + 1);
    // Still restricted: a welted shoe arriving does not lift sneakers-only.
    expect(d.item.availability.available).toBe(false);
  });

  it('the temperature preview at a warm temperature shows what becomes wearable without changing availability', async () => {
    world.clock.set('2026-10-06T07:00:00.000Z');
    const before = (await app.wardrobe()).page.counts;
    const warm = TemperaturePreview.parse((await app.get('/v1/wardrobe/temperature-preview?temperatureC=24')).body);
    const cold = TemperaturePreview.parse((await app.get('/v1/wardrobe/temperature-preview?temperatureC=2')).body);
    const wearable = (p: typeof warm) => new Set(p.items.filter((i) => i.wearable).map((i) => i.garmentId));
    const w = wearable(warm);
    const c = wearable(cold);
    expect([...w].some((id) => !c.has(id))).toBe(true);
    expect([...c].some((id) => !w.has(id))).toBe(true);
    expect((await app.wardrobe()).page.counts).toEqual(before);
  });
});
