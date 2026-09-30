import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { ItemDetail, type Board, type BoardGarment, type TodayResponse, type WardrobeItem } from '@garderobe/contracts';
import { DailyService } from '../../../backend/src/daily/service.js';
import { TripService, type PackingProposal } from '../../../backend/src/trips/service.js';
import { getDailyBoard } from '../../../backend/src/recommend/publish.js';
import { seedOwner, type Owner } from '../harness/owner.js';
import { App } from '../harness/http.js';
import { installWorld, type World } from '../harness/world.js';
import { expectDoneReceipt, expectGlanceableBoard, INTERROGATION } from '../harness/ux.js';
import { baseLayersFitPeak, offered, outerwearFitsDeparture, perceptibleNames, sneakersOnly, socksAlways } from '../harness/profile.js';

/**
 * Journey 13 — Trip and packing mode (spec section 10 "Trip and packing mode"; section 5 "Trips and
 * packing"; section 17 row "Packing": a destination board uses packed quantities; home stock and home
 * laundry resets cannot leak into it; unpacking is distinct from washing). "Four days in Paris, one
 * dinner, carry-on only": a compact proposal with deliberate reuse; Packed is the owner's statement
 * and takes those units out of the home pool; the trip-day boards come from the suitcase in Paris
 * weather and time and keep the owner's hard constraints; a Sunday laundry reset at home does not wash
 * the suitcase; Unpacked brings pieces home without declaring them clean.
 *
 * Stand-ins: FakeWeatherProvider replaces Open-Meteo (London 'mild'; Paris 'elevenToNineteen').
 * No calendar is connected. Everything else is the real Worker code on local D1.
 */

const PARIS = { label: 'Paris', latitude: 48.8566, longitude: 2.3522, timezone: 'Europe/Paris' };

/** A TodayResponse-shaped view of a trip board so the harness's independent profile checkers apply. */
function asToday(board: Board, wardrobe: Map<string, WardrobeItem>): TodayResponse {
  const ids = new Set(board.options.flatMap((o) => o.slots.map((s) => s.garmentId)));
  const garments: BoardGarment[] = [...ids].map((id) => ({ ...wardrobe.get(id)!.garment, aliases: [], media: null }));
  return { board, garments } as unknown as TodayResponse;
}

const slotIds = (board: Board | null) => (board?.options ?? []).filter((o) => o.status === 'offerable').flatMap((o) => o.slots.map((s) => s.garmentId));

describe('Journey: four days in Paris, packed from the real wardrobe', () => {
  let world: World;
  let owner: Owner;
  let app: App;
  let trips: TripService;
  let daily: DailyService;
  let wardrobe: Map<string, WardrobeItem>;
  let tripId: string;
  let proposal: PackingProposal;
  let packed: Map<string, number>;
  let wornShirt: string;
  let resetsAtWear: number;

  const tripBoard = async (date: string) => getDailyBoard(env.DB, owner.principal, date, `trip:${tripId}`);
  const resetCount = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM laundry_resets WHERE user_id = ?').bind(owner.userId).first<{ n: number }>())!.n;
  /** Garments whose every unit went into the suitcase (single garments; socks are counted in pairs). */
  const fullyPacked = () => [...packed.keys()].filter((id) => wardrobe.get(id)!.garment.tracking === 'unit');

  beforeAll(async () => {
    world = installWorld({ now: '2026-10-05T17:00:00.000Z', weather: { scenario: 'mild', byLocation: { Paris: 'elevenToNineteen' } } });
    owner = await seedOwner();
    app = new App(owner.assertion);
    const deps = { db: env.DB, principal: owner.principal, weather: world.weather, calendar: null, clock: world.clock.now };
    trips = new TripService(deps);
    daily = new DailyService({ ...deps, calendarStore: null });
    wardrobe = (await app.wardrobe()).byId;
  });

  it('an ordinary request becomes a trip in Paris time, and the proposal is a compact set with deliberate reuse — nothing packed yet', async () => {
    // SURFACE GAP: no HTTP/MCP route for trips and packing; driven through TripService
    const trip = await trips.createTrip({
      name: 'Paris',
      departsOn: '2026-10-09',
      returnsOn: '2026-10-12',
      destinations: [PARIS],
      occasions: [{ date: '2026-10-10', occasion: 'dinner', note: 'dinner at Le Train Bleu' }],
      luggage: 'carry-on',
      laundryOpportunities: [{ date: '2026-10-11', kind: 'hotel laundry' }],
    });
    tripId = trip.tripId;
    expect(trip).toMatchObject({ status: 'planned', timezone: 'Europe/Paris', luggage: 'carry-on', allowRepeats: true });

    proposal = await trips.proposePacking(tripId);
    expect(proposal.days.map((d) => d.date)).toEqual(['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']);
    for (const d of proposal.days) expect(d.why).toMatch(/^Paris: 11 °C leaving, 19 °C later/);
    const tops = new Set(proposal.days.map((d) => d.garments.find((g) => g.role === 'base_top')!.garmentId));
    const bottoms = new Set(proposal.days.map((d) => d.garments.find((g) => g.role === 'bottom')!.garmentId));
    expect(tops.size).toBe(4); // one shirt per day
    expect(bottoms.size).toBeLessThan(4); // trousers deliberately reused
    expect(proposal.notes.join(' ')).toMatch(/estimates only/);
    // Proposed is not packed: the suitcase is still empty and the pieces are still at home.
    const { items } = await trips.getTrip(tripId);
    expect(items.every((i) => i.proposedQty > 0 && i.packedQty === 0)).toBe(true);
    const aTop = [...tops][0]!;
    const detail = ItemDetail.parse((await app.get(`/v1/items/${aTop}`)).body);
    expect(detail.item.availability.available).toBe(true);
  });

  it('Packed is the owner’s statement: packed pieces leave the home pool, so Thursday’s home board never offers them', async () => {
    // SURFACE GAP: no HTTP/MCP route for trips and packing; driven through TripService
    world.clock.set('2026-10-07T18:00:00.000Z'); // Wednesday 19:00 London
    const result = await trips.markPacked(tripId, proposal.items.map((i) => ({ garmentId: i.garmentId, quantity: i.quantity })));
    expect(result.trip.status).toBe('packed');
    expect(result.summary).toMatch(/^Packed for Paris: /);
    expect(result.summary).not.toMatch(INTERROGATION);
    packed = new Map(result.items.filter((i) => i.packedQty > 0).map((i) => [i.garmentId, i.packedQty]));
    expect(packed.size).toBe(proposal.items.length);

    const prep = await app.prepare({ date: '2026-10-08' });
    expect(prep.published).toBe(true);
    const home = await app.today('2026-10-08');
    expectGlanceableBoard(home);
    const inSuitcase = new Set(fullyPacked());
    const leaked = slotIds(home.board).filter((id) => inSuitcase.has(id)).map((id) => wardrobe.get(id)!.garment.name);
    expect(leaked, 'packed pieces offered on the home board').toEqual([]);
  });

  it('while packed, the wardrobe shows a packed shirt as packed for the trip rather than available at home', async () => {
    const shirt = fullyPacked().find((id) => wardrobe.get(id)!.garment.roles.includes('base_top'))!;
    const detail = ItemDetail.parse((await app.get(`/v1/items/${shirt}`)).body);
    expect(detail.item.availability.available, `${detail.item.garment.name} is in the suitcase`).toBe(false);
    expect(detail.item.availability.label).toBe('Packed for a trip');
  });

  it('the first destination board is prepared the evening before, from the suitcase only, in Paris weather and time, and keeps socks-always and sneakers-only', async () => {
    // SURFACE GAP: no HTTP/MCP route for the scheduled phases or trip-day boards; driven through DailyService.sweep and read with getDailyBoard (purpose trip:<id>)
    world.clock.set('2026-10-08T20:05:00.000Z'); // 21:05 London: the scheduled evening run
    const runs = await daily.sweep();
    expect(runs.map((r) => [r.phase, r.boardDate, r.status, r.purpose])).toEqual([['evening', '2026-10-09', 'complete', `trip:${tripId}`]]);
    expect(runs[0]!.publish!.published).toBe(true);
    const b1 = (await tripBoard('2026-10-09'))!;
    expect(b1.status).toBe('published');
    expect(b1.timezone).toBe('Europe/Paris');
    expect(b1.document!.weather).toMatchObject({ locationLabel: 'Paris', peakTempC: 19, departureTempC: 11 });
    expect(b1.document!.text).not.toMatch(INTERROGATION);
    // Only packed pieces, and never more units than went into the suitcase.
    const ids = slotIds(b1);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((id) => !packed.has(id)).map((id) => wardrobe.get(id)!.garment.name), 'home stock on the trip board').toEqual([]);
    for (const o of b1.options.filter((x) => x.status === 'offerable')) {
      const perGarment = new Map<string, number>();
      for (const s of o.slots) perGarment.set(s.garmentId, (perGarment.get(s.garmentId) ?? 0) + 1);
      for (const [id, n] of perGarment) expect(n).toBeLessThanOrEqual(packed.get(id)!);
    }
    // The owner's hard constraints still hold, checked independently from the garments' records.
    const t = asToday(b1, wardrobe);
    expect(offered(t).length).toBeGreaterThanOrEqual(1);
    expect([...socksAlways(t), ...sneakersOnly(t), ...perceptibleNames(t), ...baseLayersFitPeak(t, 19), ...outerwearFitsDeparture(t, 11)]).toEqual([]);
  });

  it('on a trip day the owner’s Today in the app serves the destination board from the suitcase', async () => {
    const t = await app.today('2026-10-09');
    expect(t.board, 'GET /v1/today on a trip day').not.toBeNull();
    expect(slotIds(t.board).every((id) => packed.has(id))).toBe(true);
  });

  it('a shirt worn on day one is not offered again from the suitcase, including after the Sunday laundry reset at home', async () => {
    // SURFACE GAP: no HTTP/MCP route for trip-day boards; read through getDailyBoard (purpose trip:<id>)
    const b1 = (await tripBoard('2026-10-09'))!;
    const chosen = b1.options.find((o) => o.status === 'offerable')!;
    wornShirt = chosen.slots.find((s) => s.role === 'base_top')!.garmentId;
    world.clock.set('2026-10-09T07:00:00.000Z');
    const wear = await app.commit({ type: 'record_wear', timezone: 'Europe/Paris', wearingDate: '2026-10-09', items: chosen.slots.filter((s) => s.role !== 'accessory' && s.role !== 'footwear').map((s) => ({ garmentId: s.garmentId, role: s.role })) });
    expectDoneReceipt(wear);
    resetsAtWear = await resetCount();

    world.clock.set('2026-10-09T20:05:00.000Z');
    await daily.sweep();
    const b2 = (await tripBoard('2026-10-10'))!;
    expect(b2.document!.calendar.occasion).toBe('dinner');
    expect(slotIds(b2)).not.toContain(wornShirt);
    expect(slotIds(b2).every((id) => packed.has(id))).toBe(true);

    world.clock.set('2026-10-10T20:05:00.000Z');
    await daily.sweep();
    world.clock.set('2026-10-11T20:05:00.000Z'); // Sunday evening: the weekly home reset has run by now
    const last = await daily.sweep();
    expect(await resetCount(), 'a weekly home reset ran during the trip').toBeGreaterThan(resetsAtWear);
    expect(last.find((r) => r.boardDate === '2026-10-12')).toMatchObject({ status: 'complete', purpose: `trip:${tripId}` });
    const b4 = (await tripBoard('2026-10-12'))!;
    expect(b4.status).toBe('published');
    expect(slotIds(b4), 'the home reset washed a shirt that was in the suitcase').not.toContain(wornShirt);
    expect(slotIds(b4).every((id) => packed.has(id))).toBe(true);
  });

  it('Unpacked brings everything home without declaring it clean: the shirt worn in Paris stays out of the home board until a wash is reported', async () => {
    // SURFACE GAP: no HTTP/MCP route for trips and packing; driven through TripService
    world.clock.set('2026-10-12T19:00:00.000Z');
    const unpacked = await trips.markUnpacked(tripId, '2026-10-12T21:00:00+02:00');
    expect(unpacked.trip.status).toBe('completed');
    expect(unpacked.summary).toMatch(/Nothing is marked clean/);
    expect(await daily.purposeFor('2026-10-13')).toBe('day');

    world.clock.set('2026-10-12T20:05:00.000Z');
    const evening = await daily.sweep();
    expect(evening.find((r) => r.boardDate === '2026-10-13')).toMatchObject({ status: 'complete', purpose: 'day' });
    const home = await app.today('2026-10-13');
    expectGlanceableBoard(home);
    expect(slotIds(home.board), 'unpacking is not washing').not.toContain(wornShirt);
    const ctx = await trips.recommendations.context({ date: '2026-10-13' });
    expect(ctx.byId.get(wornShirt)!.estimate!.estimatedCleanUnits).toBe(0);
    expect(ctx.byId.get(wornShirt)!.estimate!.basis.some((b) => /suitcase/.test(b.detail))).toBe(true);

    // Unworn pieces are simply home again.
    const unworn = fullyPacked().find((id) => id !== wornShirt && wardrobe.get(id)!.garment.roles.includes('base_top'))!;
    expect(ctx.byId.get(unworn)!.eligibility.available).toBe(true);
  });

  it('the item page agrees after unpacking: the shirt worn in Paris is not shown as clean before a wash is reported', async () => {
    world.clock.set('2026-10-13T06:00:00.000Z'); // Tuesday morning at home
    const detail = ItemDetail.parse((await app.get(`/v1/items/${wornShirt}`)).body);
    expect(detail.wearHistory.map((w) => w.wearingDate)).toContain('2026-10-09');
    expect(detail.estimate, 'item page carries an estimate').not.toBeNull();
    expect(detail.estimate!.estimatedCleanUnits, `${detail.item.garment.name}: the item page must not count the Paris shirt as washed by the home reset`).toBe(0);
  });

  it('the owner’s wash report is what makes the shirt clean again, with a receipt and Undo', async () => {
    // SURFACE GAP: no HTTP/MCP route exposes the recommendation context's estimate; read through TripService.recommendations.context
    const washed = await app.commit({ type: 'mark_washed', garmentId: wornShirt });
    expectDoneReceipt(washed);
    const after = await trips.recommendations.context({ date: '2026-10-13' });
    expect(after.byId.get(wornShirt)!.estimate!.estimatedCleanUnits).toBe(1);
  });
});
