import { describe, expect, it } from 'vitest';
import { DEFAULT_ESTIMATOR_PARAMETERS, ESTIMATOR_VERSION } from '@garderobe/contracts';
import { boardWearProbability, dueCycles, estimateAvailability, estimateGarment, probabilityFewerThan, type EstimatorBoardDay, type EstimatorGarmentInput } from '../src/domain/index.js';
import { basicWardrobe, db, newOwner, newUser, ok } from './helpers/fixtures.js';
import { DEFAULT_LAUNDRY_ROUTINE } from '@garderobe/contracts';

const P = DEFAULT_ESTIMATOR_PARAMETERS;
const slot = (garmentId: string, alternativeGroup: string | null = null) => ({ garmentId, role: 'base_top', alternativeGroup });
const board = (date: string, options: EstimatorBoardDay['options'], extra: Partial<EstimatorBoardDay> = {}): EstimatorBoardDay => ({ boardDate: date, options, selectedOptionId: null, selectedFootwearId: null, dayHasRecordedWear: false, ...extra });
const five = (withG: number[], g = 'g_x'): EstimatorBoardDay['options'] =>
  [0, 1, 2, 3, 4].map((i) => ({ optionId: `opt_${i}`, slots: withG.includes(i) ? [slot(g), slot(`g_other${i}`)] : [slot(`g_other${i}`)] }));
const units = (clean: number, hamper: string[] = [], extra: Partial<EstimatorGarmentInput['units']> = {}) => ({
  clean: Array.from({ length: clean }, () => '2026-09-01T00:00:00.000Z'),
  worn: [],
  hamper,
  laundry: [],
  storage: [],
  away: [],
  retired: [],
  ...extra,
});
const garment = (extra: Partial<EstimatorGarmentInput> = {}): EstimatorGarmentInput => ({
  garmentId: 'g_x',
  laundryPolicy: 'per_wear',
  careChannel: 'service',
  eligible: true,
  exclusionReasons: [],
  units: units(1),
  exceptionUnits: 0,
  exceptions: [],
  cleanBasis: 'observed',
  ...extra,
});

describe('selection prior and board use (pure)', () => {
  it('uses 1/N per option times the board-use probability', () => {
    expect(boardWearProbability(board('2026-10-05', five([2])), 'g_x', P)).toBeCloseTo(0.7 / 5, 10);
  });
  it('sums mutually exclusive options that share a garment rather than charging each as a wear', () => {
    expect(boardWearProbability(board('2026-10-05', five([0, 3])), 'g_x', P)).toBeCloseTo((0.7 * 2) / 5, 10);
    expect(boardWearProbability(board('2026-10-05', five([0, 1, 2, 3, 4])), 'g_x', P)).toBeCloseTo(0.7, 10);
  });
  it('footwear alternatives share their option probability', () => {
    const opts = five([]);
    opts[0]!.slots.push({ garmentId: 'g_x', role: 'footwear', alternativeGroup: 'feet' }, { garmentId: 'g_y', role: 'footwear', alternativeGroup: 'feet' });
    expect(boardWearProbability(board('2026-10-05', opts), 'g_x', P)).toBeCloseTo(0.7 / 5 / 2, 10);
    const sel = board('2026-10-05', opts, { selectedOptionId: 'opt_0', selectedFootwearId: 'g_y' });
    expect(boardWearProbability(sel, 'g_x', P)).toBe(0);
    expect(boardWearProbability(sel, 'g_y', P)).toBeCloseTo(0.9 * 0.85, 10);
  });
  it('a selection raises the selected option and lowers the others', () => {
    expect(boardWearProbability(board('2026-10-05', five([1]), { selectedOptionId: 'opt_1' }), 'g_x', P)).toBeCloseTo(0.9 * 0.85, 10);
    expect(boardWearProbability(board('2026-10-05', five([1]), { selectedOptionId: 'opt_4' }), 'g_x', P)).toBeCloseTo((0.9 * 0.15) / 4, 10);
  });
  it('computes the Poisson-binomial chance that some clean stock remains', () => {
    expect(probabilityFewerThan([0.5, 0.5], 2)).toBeCloseTo(0.75, 10);
    expect(probabilityFewerThan([0.5, 0.5], 1)).toBeCloseTo(0.25, 10);
    expect(probabilityFewerThan([], 1)).toBe(1);
    expect(probabilityFewerThan([0.3], 0)).toBe(0);
  });
});

describe('availability estimate (pure)', () => {
  const base = { resets: [], asOf: '2026-10-07T06:00:00.000Z', targetDate: '2026-10-08' };
  it('is quantity-aware across uncertain board days and keeps inferred wears separate', () => {
    const boards = [board('2026-10-05', five([0, 1, 2, 3, 4])), board('2026-10-06', five([0, 1, 2, 3, 4])), board('2026-10-07', five([0]))];
    const one = estimateGarment({ ...base, garment: garment({ units: units(1) }), boards });
    const three = estimateGarment({ ...base, garment: garment({ units: units(3) }), boards });
    expect(one.estimatorVersion).toBe(ESTIMATOR_VERSION);
    expect(one.expectedInferredWears).toBeCloseTo(0.7 + 0.7 + 0.14, 10);
    expect(one.probabilityAvailable).toBeCloseTo(0.3 * 0.3 * 0.86, 10);
    expect(three.probabilityAvailable).toBeGreaterThan(one.probabilityAvailable);
    expect(three.likelyAvailable).toBe(true);
    expect(one.likelyAvailable).toBe(false);
  });
  it('replaces a day with a recorded wear by the observation', () => {
    const est = estimateGarment({ ...base, garment: garment(), boards: [board('2026-10-06', five([0, 1, 2, 3, 4]), { dayHasRecordedWear: true })] });
    expect(est.probabilityAvailable).toBe(1);
    expect(est.basis.some((b) => b.kind === 'recorded_wear')).toBe(true);
  });
  it('applies the weekly reset to dirty units before the Friday cutoff, not after', () => {
    const reset = { pool: 'service' as const, cycleKey: '2026-10-04', cutoffAt: '2026-10-02T08:00:00.000Z', effectiveAt: '2026-10-03T23:00:00.000Z' };
    const before = estimateGarment({ ...base, resets: [reset], garment: garment({ units: units(0, ['2026-10-01T10:00:00.000Z']) }), boards: [] });
    expect(before.estimatedCleanUnits).toBe(1);
    expect(before.basis.find((b) => b.kind === 'weekly_reset')?.resetCycle).toBe('2026-10-04');
    const after = estimateGarment({ ...base, resets: [reset], garment: garment({ units: units(0, ['2026-10-02T18:00:00.000Z']) }), boards: [] });
    expect(after.estimatedCleanUnits).toBe(0);
    expect(after.probabilityAvailable).toBe(0);
    // Hand-wash socks follow their own pool, not the service reset.
    const socks = estimateGarment({ ...base, resets: [reset], garment: garment({ careChannel: 'hand_wash', units: units(0, ['2026-10-01T10:00:00.000Z']) }), boards: [] });
    expect(socks.estimatedCleanUnits).toBe(0);
  });
  it('lets owner exceptions override the reset', () => {
    const reset = { pool: 'service' as const, cycleKey: '2026-10-04', cutoffAt: '2026-10-02T08:00:00.000Z', effectiveAt: '2026-10-03T23:00:00.000Z' };
    const stillAway = estimateGarment({ ...base, resets: [reset], garment: garment({ units: units(0, [], { laundry: ['2026-10-02T08:00:00.000Z'] }), exceptionUnits: 1 }), boards: [] });
    expect(stillAway.estimatedCleanUnits).toBe(0);
    expect(stillAway.basis.some((b) => b.kind === 'owner_exception')).toBe(true);
    const inBatch = estimateGarment({ ...base, resets: [reset], garment: garment({ units: units(0, [], { laundry: ['2026-10-02T08:00:00.000Z'] }) }), boards: [] });
    expect(inBatch.estimatedCleanUnits).toBe(1);
    const dirtyAfter = estimateGarment({ ...base, resets: [reset], garment: garment({ units: units(0, ['2026-10-01T10:00:00.000Z']), exceptions: [{ kind: 'dirty', occurredAt: '2026-10-05T10:00:00.000Z', quantity: 1 }] }), boards: [] });
    expect(dirtyAfter.estimatedCleanUnits).toBe(0);
  });
  it('treats hard exclusions as zero and non-laundered garments as not consumed', () => {
    expect(estimateGarment({ ...base, garment: garment({ eligible: false, exclusionReasons: ['At the tailor'] }), boards: [] })).toMatchObject({ probabilityAvailable: 0, likelyAvailable: false });
    expect(estimateGarment({ ...base, garment: garment({ laundryPolicy: 'never', careChannel: 'none' }), boards: [board('2026-10-06', five([0, 1, 2, 3, 4]))] }).probabilityAvailable).toBe(1);
  });
  it('derives Friday collection, Saturday return and Sunday baseline cycles in local time', () => {
    const cycles = dueCycles(DEFAULT_LAUNDRY_ROUTINE, 'Europe/London', '2026-10-07T12:00:00.000Z', '2026-09-30T00:00:00.000Z');
    expect(cycles).toContainEqual({ pool: 'service', cycleKey: '2026-10-04', cutoffAt: '2026-10-02T08:00:00.000Z', effectiveAt: '2026-10-03T23:00:00.000Z' });
    const winter = dueCycles(DEFAULT_LAUNDRY_ROUTINE, 'Europe/London', '2026-11-04T12:00:00.000Z', '2026-10-31T00:00:00.000Z');
    expect(winter).toContainEqual({ pool: 'service', cycleKey: '2026-11-01', cutoffAt: '2026-10-30T09:00:00.000Z', effectiveAt: '2026-11-01T00:00:00.000Z' });
  });
});

describe('availability estimator against D1', () => {
  it('uses the owner restrictions, planning policy and import baseline', async () => {
    const { principal, byName } = await newOwner();
    const est = await estimateAvailability(db(), principal, { targetDate: '2026-09-22', asOf: '2026-09-21T06:00:00.000Z' });
    const by = async (n: string) => {
      const id = await byName(n);
      return est.find((e) => e.garmentId === id)!;
    };
    expect((await by('Paraboot Reims — noir (black)')).eligible).toBe(false);
    expect((await by('NB 990v4 — grey')).probabilityAvailable).toBe(1);
    expect((await by('DBF Traveler — linen')).eligible).toBe(false);
    expect((await by('Anglo-Italian pocket square')).eligible).toBe(false);
    const blue = await by('Lightweight oxford — blue');
    expect(blue.probabilityAvailable).toBe(1);
    expect(blue.basis[0]!.detail).toContain('import baseline');
    const occasional = await estimateAvailability(db(), principal, { targetDate: '2026-09-22', asOf: '2026-09-21T06:00:00.000Z', includeOccasional: true, garmentIds: [await byName('Anglo-Italian pocket square')] });
    expect(occasional[0]!.eligible).toBe(true);
  });

  it('spreads uncertainty from an unselected published board and drops it when a wear is recorded', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    const { publishBoardRevision } = await import('../src/domain/index.js');
    await publishBoardRevision(db(), p, {
      boardDate: '2026-10-06',
      timezone: 'Europe/London',
      expectedRevision: 0,
      options: [
        { position: 1, explanation: 'A', slots: [{ garmentId: w.shirtA, role: 'base_top' }, { garmentId: w.socks, role: 'socks' }] },
        { position: 2, explanation: 'B', slots: [{ garmentId: w.shirtB, role: 'base_top' }, { garmentId: w.socks, role: 'socks' }] },
      ],
    });
    const est = await estimateAvailability(db(), p, { targetDate: '2026-10-07', asOf: '2026-10-06T20:00:00.000Z', garmentIds: [w.shirtA, w.socks] });
    const shirt = est.find((e) => e.garmentId === w.shirtA)!;
    expect(shirt.expectedInferredWears).toBeCloseTo(0.35, 10);
    expect(shirt.probabilityAvailable).toBeCloseTo(0.65, 10);
    expect(est.find((e) => e.garmentId === w.socks)!.probabilityAvailable).toBe(1);
    await ok(p, { type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-06', items: [{ garmentId: w.shirtB }] }, {}, { now: () => '2026-10-06T21:00:00.000Z' });
    const after = await estimateAvailability(db(), p, { targetDate: '2026-10-07', asOf: '2026-10-06T21:30:00.000Z', garmentIds: [w.shirtA, w.shirtB] });
    expect(after.find((e) => e.garmentId === w.shirtA)!.probabilityAvailable).toBe(1);
    expect(after.find((e) => e.garmentId === w.shirtB)!.probabilityAvailable).toBe(0);
  });
});
