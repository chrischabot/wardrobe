import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { ensureLaundryResets, listLaundryResets } from '../../../../backend/src/domain/laundry.js';
import { ownerScenario } from '../../helpers/daily.js';
import { count, newOwner, q, run } from '../../helpers/seed.js';
import { knownDefect } from '../../helpers/defects.js';

/**
 * Time edge cases on the owner's ledger: the October and March DST changes, time-zone disagreement
 * between clients, outfits worn past midnight, missed weekly laundry resets, clocks that go backwards,
 * and future dates. The local wearing date is the durable day key.
 */

const wears = (userId: string, garmentId: string) => q<{ wearing_date: string }>("SELECT wearing_date FROM daily_wears WHERE user_id = ? AND garment_id = ? AND status = 'active' ORDER BY wearing_date", userId, garmentId);

describe('daylight saving changes', () => {
  it('both occurrences of 01:30 on the October fall-back night map to one London day and one counted wear', async () => {
    const o = await newOwner();
    const shirt = await o.byName('Lightweight oxford — gold');
    const first = await run(o.principal, { type: 'record_wear', timezone: 'Europe/London', occurredAt: '2026-10-25T00:30:00.000Z', items: [{ garmentId: shirt }] }, {}, { now: () => '2026-10-25T09:00:00.000Z' });
    const second = await run(o.principal, { type: 'record_wear', timezone: 'Europe/London', occurredAt: '2026-10-25T01:30:00.000Z', items: [{ garmentId: shirt }] }, {}, { now: () => '2026-10-25T09:00:00.000Z' });
    expect(first.outcome).toBe('committed');
    expect(second.outcome).toBe('merged');
    expect((await wears(o.userId, shirt)).map((w) => w.wearing_date)).toEqual(['2026-10-25']);
  });

  it('the skipped hour of the March spring-forward and the instants around midnight land on the right local days', async () => {
    const o = await newOwner();
    const a = await o.byName('Lightweight oxford — pink');
    const b = await o.byName('Lightweight oxford — slate');
    const c = await o.byName('Lightweight oxford — laurel');
    const now = { now: () => '2027-03-29T12:00:00.000Z' };
    await run(o.principal, { type: 'record_wear', timezone: 'Europe/London', occurredAt: '2027-03-28T00:59:00.000Z', items: [{ garmentId: a }] }, {}, now); // 00:59 GMT
    await run(o.principal, { type: 'record_wear', timezone: 'Europe/London', occurredAt: '2027-03-28T01:00:00.000Z', items: [{ garmentId: b }] }, {}, now); // 02:00 BST
    await run(o.principal, { type: 'record_wear', timezone: 'Europe/London', occurredAt: '2027-03-28T23:30:00.000Z', items: [{ garmentId: c }] }, {}, now); // 00:30 BST next day
    expect((await wears(o.userId, a)).map((w) => w.wearing_date)).toEqual(['2027-03-28']);
    expect((await wears(o.userId, b)).map((w) => w.wearing_date)).toEqual(['2027-03-28']);
    expect((await wears(o.userId, c)).map((w) => w.wearing_date)).toEqual(['2027-03-29']);
  });

  it('the morning schedule survives the spring-forward (no double run, no missed final)', async () => {
    const s = await ownerScenario({ now: '2027-03-27T21:05:00.000Z' }); // 21:05 GMT Saturday
    const evening = await s.daily.sweep();
    expect(evening.map((p) => p.phase)).toEqual(['evening']);
    expect(await s.daily.sweep()).toEqual([]); // the same instant again runs nothing
    s.clock.set('2027-03-28T05:45:00.000Z'); // 06:45 BST
    expect((await s.daily.sweep()).map((p) => p.phase)).toEqual(['morning_refresh']);
    s.clock.set('2027-03-28T05:51:00.000Z'); // 06:51 BST
    expect((await s.daily.sweep()).map((p) => p.phase)).toEqual(['final']);
    expect(await s.daily.sweep()).toEqual([]);
  });
});

describe('time-zone disagreement and travel', () => {
  it('an explicit wearing date is the key: the same outfit reported from a New York device and a London device counts once', async () => {
    const o = await newOwner();
    const shirt = await o.byName('Lightweight oxford — moss');
    const now = { now: () => '2026-10-06T12:00:00.000Z' };
    await run(o.principal, { type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-05', items: [{ garmentId: shirt }] }, {}, now);
    await run(o.principal, { type: 'record_wear', timezone: 'America/New_York', wearingDate: '2026-10-05', items: [{ garmentId: shirt }] }, { source: 'mcp' }, now);
    expect((await wears(o.userId, shirt)).length).toBe(1);
  });

  const sameInstantTwoZones = async () => {
    // 2026-10-06T02:30Z is 03:30 on the 6th in London but 22:30 on the 5th in New York.
    const o = await newOwner();
    const shirt = await o.byName('Lightweight oxford — off-white');
    const now = { now: () => '2026-10-06T12:00:00.000Z' };
    const obs = 'sourceRef-same-instant';
    await run(o.principal, { type: 'record_wear', timezone: 'Europe/London', occurredAt: '2026-10-06T02:30:00.000Z', items: [{ garmentId: shirt }], sourceRef: obs }, {}, now);
    await run(o.principal, { type: 'record_wear', timezone: 'America/New_York', occurredAt: '2026-10-06T02:30:00.000Z', items: [{ garmentId: shirt }], sourceRef: obs }, { source: 'offline_replay' }, now);
    return { o, shirt, dates: (await wears(o.userId, shirt)).map((w) => w.wearing_date) };
  };

  it('the same instant reported with two time zones keeps the ledger consistent (no negative stock; variety sees every recorded date)', async () => {
    const { o, shirt, dates } = await sameInstantTwoZones();
    expect(dates.length).toBeGreaterThanOrEqual(1);
    expect(await count('SELECT COUNT(*) AS n FROM stock_lots WHERE user_id = ? AND (clean_qty < 0 OR hamper_qty < 0 OR worn_qty < 0)', o.userId)).toBe(0);
    const s = await ownerScenario({ owner: o, now: '2026-10-06T20:00:00.000Z' });
    const ctx = await s.rec.context({ date: '2026-10-07' });
    for (const d of dates) expect(ctx.byId.get(shirt)!.wornDates).toContain(d);
  });

  // ADV-09 (DEFECTS.md): the wearing date is derived from each report's claimed time zone, so one physical wear reported
  // by two devices that disagree on the zone (e.g. an offline replay from a phone still on New York time) counts twice.
  it('[ADV-09] the same instant reported with two different time zones yields one counted wear', async () => {
    const { dates } = await sameInstantTwoZones();
    expect(dates).toHaveLength(1);
  });

  it('a wear on a future local date is refused whichever time zone is claimed', async () => {
    const o = await newOwner();
    const shirt = await o.byName('Lightweight oxford — gold');
    const now = { now: () => '2026-10-06T10:00:00.000Z' };
    for (const timezone of ['Europe/London', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      const r = await run(o.principal, { type: 'record_wear', timezone, wearingDate: '2026-10-08', items: [{ garmentId: shirt }] }, {}, now);
      expect(r.outcome, timezone).toBe('rejected');
    }
    const farFuture = await run(o.principal, { type: 'record_wear', timezone: 'Europe/London', occurredAt: '2030-01-01T10:00:00.000Z', items: [{ garmentId: shirt }] }, {}, now);
    expect(farFuture.outcome).toBe('rejected');
    expect(await count("SELECT COUNT(*) AS n FROM daily_wears WHERE user_id = ?", o.userId)).toBe(0);
  });
});

describe('overnight outfits', () => {
  it('an outfit worn past midnight keeps its starting date; a later report of the same night merges into it', async () => {
    const o = await newOwner();
    const shirt = await o.byName('Lightweight oxford — pink');
    const now = { now: () => '2026-10-06T09:00:00.000Z' };
    await run(o.principal, { type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-05', occurredAt: '2026-10-05T18:00:00.000Z', items: [{ garmentId: shirt }] }, {}, now);
    const late = await run(o.principal, { type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-05', occurredAt: '2026-10-06T00:40:00.000Z', items: [{ garmentId: shirt }] }, {}, now);
    expect(late.outcome).toBe('merged');
    expect((await wears(o.userId, shirt)).map((w) => w.wearing_date)).toEqual(['2026-10-05']);
  });
});

describe('missed weekly resets and clocks that move backwards', () => {
  it('a three-week gap catches up once per cycle; a repeat or a backwards clock applies nothing twice', async () => {
    const o = await newOwner({ createdAt: '2026-09-01T00:00:00.000Z' });
    const r1 = await ensureLaundryResets(env.DB, o.principal, '2026-09-29T10:00:00.000Z');
    const keys1 = (await listLaundryResets(env.DB, o.principal)).map((r) => `${r.pool}:${r.cycleKey}`);
    expect(new Set(keys1).size).toBe(keys1.length);
    expect(r1.length).toBeGreaterThan(0);
    expect(await ensureLaundryResets(env.DB, o.principal, '2026-09-29T10:00:00.000Z')).toHaveLength(0);
    expect(await ensureLaundryResets(env.DB, o.principal, '2026-09-10T10:00:00.000Z')).toHaveLength(0); // clock went backwards
    const later = await ensureLaundryResets(env.DB, o.principal, '2026-10-20T10:00:00.000Z');
    const keys2 = (await listLaundryResets(env.DB, o.principal)).map((r) => `${r.pool}:${r.cycleKey}`);
    expect(new Set(keys2).size).toBe(keys2.length);
    expect(keys2.length).toBe(keys1.length + later.length);
    // Resets never move stock or record a pickup, return or wear.
    expect(await count('SELECT COUNT(*) AS n FROM stock_movements WHERE user_id = ?', o.userId)).toBe(await count("SELECT COUNT(*) AS n FROM stock_movements WHERE user_id = ? AND kind <> 'reset'", o.userId));
    expect(await count('SELECT COUNT(*) AS n FROM laundry_batches WHERE user_id = ?', o.userId).catch(() => 0)).toBe(0);
  });

  it('racing reset runs (two schedulers) record each cycle once', async () => {
    const o = await newOwner({ createdAt: '2026-09-01T00:00:00.000Z' });
    await Promise.all([1, 2, 3].map(() => ensureLaundryResets(env.DB, o.principal, '2026-09-29T10:00:00.000Z').catch(() => [])));
    const keys = (await listLaundryResets(env.DB, o.principal)).map((r) => `${r.pool}:${r.cycleKey}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the daily service never composes a past day, even when asked by a lagging scheduler', async () => {
    const s = await ownerScenario({ now: '2026-10-07T10:00:00.000Z' });
    const r = await s.daily.runPhase('evening', '2026-10-05');
    expect((r as { published?: boolean }).published ?? false).toBe(false);
    expect(await count("SELECT COUNT(*) AS n FROM boards WHERE user_id = ? AND board_date = '2026-10-05'", s.userId)).toBe(0);
  });
});
