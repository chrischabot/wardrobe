import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ensureLaundryResets } from '../../src/domain/laundry.js';
import { getDailyBoard } from '../../src/recommend/publish.js';
import { ownerScenario } from '../helpers/daily.js';

const PARIS = { label: 'Paris', latitude: 48.8566, longitude: 2.3522, timezone: 'Europe/Paris' };

describe('trip and packing mode', () => {
  it('proposes, packs, dresses from the packed subset in destination weather, and unpacking is not washing', async () => {
    const s = await ownerScenario({ now: '2026-09-29T12:00:00.000Z', weather: { scenario: 'coldSnap', byLocation: { Paris: 'elevenToNineteen' } } });
    const trip = await s.trips.createTrip({ name: 'Paris', departsOn: '2026-10-01', returnsOn: '2026-10-05', destinations: [PARIS], occasions: [{ date: '2026-10-02', occasion: 'dinner', note: 'dinner at Le Train Bleu' }], luggage: 'carry-on' });
    expect(trip).toMatchObject({ status: 'planned', timezone: 'Europe/Paris', allowRepeats: true });

    // Proposal: one outfit per day for Paris weather, with deliberate reuse; nothing is packed yet.
    const proposal = await s.trips.proposePacking(trip.tripId);
    expect(proposal.days).toHaveLength(5);
    expect(proposal.days[0]!.why).toMatch(/^Paris: 11 °C leaving, 19 °C later/);
    const bottoms = new Set(proposal.days.map((d) => d.garments.find((g) => g.role === 'bottom')!.garmentId));
    const tops = new Set(proposal.days.map((d) => d.garments.find((g) => g.role === 'base_top')!.garmentId));
    expect(tops.size).toBe(5);
    expect(bottoms.size).toBeLessThan(5);
    const { items: proposedItems } = await s.trips.getTrip(trip.tripId);
    expect(proposedItems.every((i) => i.proposedQty > 0 && i.packedQty === 0)).toBe(true);

    // "Packed" is the owner's statement; packed units leave the home pool.
    s.clock.set('2026-09-30T17:00:00.000Z');
    const packed = await s.trips.markPacked(trip.tripId, proposal.items.map((i) => ({ garmentId: i.garmentId, quantity: i.quantity })), '2026-09-30T18:00:00+01:00');
    expect(packed.trip.status).toBe('packed');
    const packedIds = new Set(proposal.items.map((i) => i.garmentId));
    const home = await s.rec.compose({ date: '2026-10-08' });
    const singleUnitTops = proposal.items.filter((i) => home.context.byId.get(i.garmentId)!.roles.includes('base_top'));
    for (const i of singleUnitTops) expect(home.context.byId.get(i.garmentId)!.eligibility.label).toBe('Packed for a trip');
    for (const o of home.composed.options) for (const x of o.slots) if (x.role === 'base_top') expect(packedIds.has(x.garmentId)).toBe(false);

    // Trip days: the daily service dresses from the suitcase, in Paris weather and time.
    expect(await s.daily.purposeFor('2026-10-01')).toBe(`trip:${trip.tripId}`);
    s.clock.set('2026-09-30T19:05:00.000Z'); // 21:05 in Paris
    const first = await s.daily.runPhase('evening', '2026-10-01');
    expect(first).toMatchObject({ status: 'complete', purpose: `trip:${trip.tripId}` });
    const b1 = (await getDailyBoard(env.DB, s.principal, '2026-10-01', `trip:${trip.tripId}`))!;
    expect(b1.timezone).toBe('Europe/Paris');
    expect(b1.document!.weather).toMatchObject({ locationLabel: 'Paris', peakTempC: 19, departureTempC: 11 });
    for (const o of b1.options) for (const x of o.slots) expect(packedIds.has(x.garmentId)).toBe(true);

    // Wear on day one consumes that shirt for the rest of the trip.
    const worn = b1.options[0]!.slots.find((x) => x.role === 'base_top')!.garmentId;
    s.clock.set('2026-10-01T07:00:00.000Z');
    await s.cmd({ type: 'record_wear', timezone: 'Europe/Paris', wearingDate: '2026-10-01', items: b1.options[0]!.slots.filter((x) => x.role !== 'accessory' && x.role !== 'footwear').map((x) => ({ garmentId: x.garmentId, role: x.role })) });
    s.clock.set('2026-10-01T19:05:00.000Z');
    await s.daily.runPhase('evening', '2026-10-02');
    const b2 = (await getDailyBoard(env.DB, s.principal, '2026-10-02', `trip:${trip.tripId}`))!;
    expect(b2.document!.calendar.occasion).toBe('dinner');
    for (const o of b2.options) {
      expect(o.slots.map((x) => x.garmentId)).not.toContain(worn);
      for (const x of o.slots) expect(packedIds.has(x.garmentId)).toBe(true);
    }

    // A home laundry reset during the trip does not wash the suitcase.
    s.clock.set('2026-10-04T01:00:00.000Z');
    expect((await ensureLaundryResets(env.DB, s.principal, s.clock.value)).length).toBeGreaterThan(0);
    s.clock.set('2026-10-04T19:05:00.000Z');
    const late = await s.trips.composeTripDay(trip.tripId, '2026-10-05');
    expect(late.published).toBe(true);
    for (const o of late.board!.options) expect(o.slots.map((x) => x.garmentId)).not.toContain(worn);

    // Unpacked: units return home, still dirty; only a wash report makes the shirt available.
    s.clock.set('2026-10-05T18:00:00.000Z');
    const unpacked = await s.trips.markUnpacked(trip.tripId, '2026-10-05T19:00:00+01:00');
    expect(unpacked.trip.status).toBe('completed');
    expect(unpacked.summary).toMatch(/Nothing is marked clean/);
    s.clock.set('2026-10-08T20:05:00.000Z');
    const after = await s.rec.context({ date: '2026-10-09' });
    const shirt = after.byId.get(worn)!;
    expect(shirt.wornDates).toEqual(['2026-10-01']);
    expect(shirt.estimate!.estimatedCleanUnits).toBe(0);
    expect(shirt.estimate!.basis.some((b) => /suitcase/.test(b.detail))).toBe(true);
    await s.cmd({ type: 'mark_washed', garmentId: worn });
    const washed = await s.rec.context({ date: '2026-10-09' });
    expect(washed.byId.get(worn)!.estimate!.estimatedCleanUnits).toBe(1);
    // Back home, the next day uses the home board again.
    expect(await s.daily.purposeFor('2026-10-09')).toBe('day');
  });

  it('a packing proposal always reuses trousers: at most ceil(days/2) pairs over many seeds, one shirt per day, the dinner still served', async () => {
    // The journey-13 trip: four days in Paris, one dinner, carry-on only, on the owner's full wardrobe.
    const s = await ownerScenario({ withAdditions: true, now: '2026-10-05T17:00:00.000Z', weather: { scenario: 'mild', byLocation: { Paris: 'elevenToNineteen' } } });
    const trip = await s.trips.createTrip({ name: 'Paris', departsOn: '2026-10-09', returnsOn: '2026-10-12', destinations: [PARIS], occasions: [{ date: '2026-10-10', occasion: 'dinner', note: 'dinner at Le Train Bleu' }], luggage: 'carry-on', laundryOpportunities: [{ date: '2026-10-11', kind: 'hotel laundry' }] });
    const counts = new Map<number, number>();
    for (let i = 0; i < 60; i++) {
      const seed = `pack-${i}`;
      const p = await s.trips.proposePacking(trip.tripId, { seed });
      expect(p.days.map((d) => d.date), seed).toEqual(['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']);
      const tops = new Set(p.days.map((d) => d.garments.find((g) => g.role === 'base_top')!.garmentId));
      const bottoms = new Set(p.days.map((d) => d.garments.find((g) => g.role === 'bottom')!.garmentId));
      expect(tops.size, `${seed}: one shirt per day`).toBe(4);
      expect(bottoms.size, `${seed}: trousers ${[...bottoms].join(', ')}`).toBeLessThanOrEqual(2);
      counts.set(bottoms.size, (counts.get(bottoms.size) ?? 0) + 1);
      // Every proposed day is a complete, valid outfit for Paris that day.
      for (const d of p.days) {
        const v = await s.rec.validateProposal({ date: d.date, destination: PARIS }, { slots: d.garments.map((g) => ({ garmentId: g.garmentId, role: g.role as never })) });
        expect(v.violations.filter((x) => x.strength === 'hard'), `${seed} ${d.date}`).toEqual([]);
      }
    }
    console.log(`[trips] distinct trousers over 60 seeds: ${JSON.stringify(Object.fromEntries(counts))}`);
  }, 300_000);

  it('a long trip keeps reusing: once many shirts are used, reuse with the unused shirts is still found, every day is dressed, and no false fallback is reported', async () => {
    // Fourteen days, trouser limit 7. By the second week the best shirts for any packed pair are already
    // proposed, so a valid reuse exists only beyond the first board of each pinned composition.
    const s = await ownerScenario({ withAdditions: true, now: '2026-10-05T17:00:00.000Z', weather: { scenario: 'mild', byLocation: { Paris: 'elevenToNineteen' } } });
    const trip = await s.trips.createTrip({ name: 'Paris', departsOn: '2026-10-09', returnsOn: '2026-10-22', destinations: [PARIS], luggage: 'carry-on' });
    for (let i = 0; i < 4; i++) {
      const seed = `long-${i}`;
      const p = await s.trips.proposePacking(trip.tripId, { seed });
      expect(p.days, `${seed}: every day dressed; notes ${JSON.stringify(p.notes)}`).toHaveLength(14);
      expect(p.notes.filter((n) => /no complete outfit|none of the packed trousers/.test(n)), seed).toEqual([]);
      const tops = p.days.map((d) => d.garments.find((g) => g.role === 'base_top')!.garmentId);
      const bottoms = p.days.map((d) => d.garments.find((g) => g.role === 'bottom')!.garmentId);
      expect(new Set(tops).size, `${seed}: one shirt per day`).toBe(14);
      expect(new Set(bottoms).size, `${seed}: at most ceil(14/2) trousers`).toBeLessThanOrEqual(7);
      for (const d of p.days) {
        const v = await s.rec.validateProposal({ date: d.date, destination: PARIS }, { slots: d.garments.map((g) => ({ garmentId: g.garmentId, role: g.role as never })) });
        expect(v.violations.filter((x) => x.strength === 'hard'), `${seed} ${d.date}`).toEqual([]);
      }
    }
  }, 300_000);

  it('refuses trip boards before packing and for dates outside the trip', async () => {
    const s = await ownerScenario({ now: '2026-09-29T12:00:00.000Z' });
    const trip = await s.trips.createTrip({ name: 'Rotterdam', departsOn: '2026-10-01', returnsOn: '2026-10-02', destinations: [{ label: 'Rotterdam', timezone: 'Europe/Amsterdam' }] });
    await expect(s.trips.composeTripDay(trip.tripId, '2026-10-01')).rejects.toThrow(/Pack the trip/);
    const g = await s.byName('Lightweight oxford — slate');
    await s.trips.markPacked(trip.tripId, [{ garmentId: g, quantity: 1 }]);
    await expect(s.trips.composeTripDay(trip.tripId, '2026-10-04')).rejects.toThrow(/outside the trip/);
    // With a single packed shirt and nothing else, no complete outfit exists: nothing is published.
    const out = await s.trips.composeTripDay(trip.tripId, '2026-10-01');
    expect(out.published).toBe(false);
    expect(out.shortfall).toMatch(/No complete outfit/);
  });
});
