import { describe, expect, it } from 'vitest';
import { basicWardrobe, buckets, db, newUser, ok, run, service, envelope, wearCount } from './helpers/fixtures.js';
import { CommandService, getReceipt, listDailyWears } from '../src/domain/index.js';

const TZ = 'Europe/London';
const clock = (iso: string) => ({ now: () => iso });

describe('one counted wear per garment and local wearing date', () => {
  it("ADV-09: the wearing date follows the owner's time zone, so one instant reported from two device zones counts once", async () => {
    const p = await newUser(); // owner settings: Europe/London
    const w = await basicWardrobe(p);
    const opts = clock('2026-10-06T12:00:00.000Z');
    // 02:30Z is the 6th in London but 22:30 on the 5th in New York.
    const a = await ok(p, { type: 'record_wear', timezone: 'Europe/London', occurredAt: '2026-10-06T02:30:00.000Z', items: [{ garmentId: w.shirtA }] }, {}, opts);
    const b = await ok(p, { type: 'record_wear', timezone: 'America/New_York', occurredAt: '2026-10-06T02:30:00.000Z', items: [{ garmentId: w.shirtA }] }, { source: 'offline_replay' }, opts);
    expect(a.facts.wearingDate).toBe('2026-10-06');
    expect(b.facts.wearingDate).toBe('2026-10-06');
    expect(b.outcome).toBe('merged');
    expect((await listDailyWears(db(), p, { garmentId: w.shirtA })).map((d) => d.wearingDate)).toEqual(['2026-10-06']);
    expect(await buckets(p, w.shirtA)).toMatchObject({ clean: 0, hamper: 1 });
    // The device zone is kept as the observation's event zone.
    const zones = await db().prepare('SELECT timezone FROM wear_observations WHERE user_id = ? ORDER BY timezone').bind(p.userId).all<{ timezone: string }>();
    expect(zones.results.map((z) => z.timezone)).toEqual(['America/New_York', 'Europe/London']);
    // An explicit wearing date (e.g. on a trip) is still the key.
    const trip = await ok(p, { type: 'record_wear', timezone: 'America/New_York', wearingDate: '2026-10-05', items: [{ garmentId: w.shirtB }] }, {}, opts);
    expect(trip.facts.wearingDate).toBe('2026-10-05');
  });

  it('merges duplicate reports across clients into one counted wear, preserving every source', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    const opts = clock('2026-10-06T20:00:00.000Z');
    const items = [{ garmentId: w.shirtA }, { garmentId: w.trousers }, { garmentId: w.socks }];
    const first = await ok(p, { type: 'record_wear', timezone: TZ, wearingDate: '2026-10-06', items }, { source: 'app' }, opts);
    const second = await ok(p, { type: 'record_wear', timezone: TZ, wearingDate: '2026-10-06', items }, { source: 'mcp' }, opts);
    const third = await ok(p, { type: 'record_wear', timezone: TZ, wearingDate: '2026-10-06', items: [{ garmentId: w.shirtA }] }, { source: 'offline_replay' }, opts);
    expect(first.outcome).toBe('committed');
    expect(second.outcome).toBe('merged');
    expect(third.outcome).toBe('merged');
    const wears = await listDailyWears(db(), p, { garmentId: w.shirtA });
    expect(wears).toHaveLength(1);
    expect(wears[0]!.observationCount).toBe(3);
    expect(wears[0]!.sources).toEqual(['app', 'mcp', 'offline_replay']);
    // Stock consumed once: one shirt in the hamper, one pair of socks.
    expect(await buckets(p, w.shirtA)).toMatchObject({ clean: 0, hamper: 1 });
    expect(await buckets(p, w.socks)).toMatchObject({ clean: 3, hamper: 1 });
    const obs = await db().prepare('SELECT COUNT(*) AS n FROM wear_observations WHERE user_id = ?').bind(p.userId).first<{ n: number }>();
    expect(obs!.n).toBe(3);
  });

  it('counts again on the next local date (a day key, not a rolling 24 hours)', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    await ok(p, { type: 'record_wear', timezone: TZ, wearingDate: '2026-10-06', occurredAt: '2026-10-06T21:30:00+01:00', items: [{ garmentId: w.sneakers }] }, {}, clock('2026-10-07T12:00:00.000Z'));
    await ok(p, { type: 'record_wear', timezone: TZ, wearingDate: '2026-10-07', occurredAt: '2026-10-07T07:30:00+01:00', items: [{ garmentId: w.sneakers }] }, {}, clock('2026-10-07T12:00:00.000Z'));
    expect(await wearCount(p, w.sneakers)).toBe(2);
  });

  it('a shirt change increments only the new shirt', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    const opts = clock('2026-10-06T21:00:00.000Z');
    await ok(p, { type: 'record_wear', timezone: TZ, wearingDate: '2026-10-06', segment: 'day', items: [{ garmentId: w.shirtA }, { garmentId: w.trousers }, { garmentId: w.socks }, { garmentId: w.sneakers }, { garmentId: w.belt }] }, {}, opts);
    const evening = await ok(p, { type: 'record_wear', timezone: TZ, wearingDate: '2026-10-06', segment: 'evening', items: [{ garmentId: w.shirtB }, { garmentId: w.trousers }, { garmentId: w.socks }, { garmentId: w.sneakers }, { garmentId: w.belt }] }, {}, opts);
    expect(evening.outcome).toBe('committed');
    const counted = evening.facts.counted as { name: string; countedBefore: boolean; countedAfter: boolean }[];
    expect(counted.filter((c) => !c.countedBefore).map((c) => c.name)).toEqual(['Pima oxford — white']);
    for (const id of [w.shirtA, w.shirtB, w.trousers, w.socks, w.sneakers, w.belt]) expect(await wearCount(p, id)).toBe(1);
    expect(await buckets(p, w.trousers)).toMatchObject({ clean: 0, worn: 1, hamper: 0 });
    expect(await buckets(p, w.socks)).toMatchObject({ clean: 3, hamper: 1 });
    expect(await buckets(p, w.shirtA)).toMatchObject({ hamper: 1 });
    expect(await buckets(p, w.shirtB)).toMatchObject({ hamper: 1 });
    const trouserDay = (await listDailyWears(db(), p, { garmentId: w.trousers }))[0]!;
    expect(trouserDay.segments).toEqual(['day', 'evening']);
  });

  it('trousers follow the single-wear-day policy: in use after the wear, not in the hamper', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    await ok(p, { type: 'record_wear', timezone: TZ, items: [{ garmentId: w.trousers }] }, {}, clock('2026-10-06T09:00:00.000Z'));
    expect(await buckets(p, w.trousers)).toMatchObject({ clean: 0, worn: 1, hamper: 0 });
    // Continuing the same outfit later that day does not consume them again.
    await ok(p, { type: 'record_wear', timezone: TZ, items: [{ garmentId: w.trousers }] }, {}, clock('2026-10-06T18:00:00.000Z'));
    expect(await buckets(p, w.trousers)).toMatchObject({ clean: 0, worn: 1 });
    expect(await wearCount(p, w.trousers)).toBe(1);
  });

  it('keeps an overnight outfit on its starting date and handles the DST change without an extra wear', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    await ok(p, { type: 'record_wear', timezone: TZ, wearingDate: '2026-10-24', occurredAt: '2026-10-25T01:30:00+01:00', items: [{ garmentId: w.sneakers }] }, {}, clock('2026-10-25T12:00:00.000Z'));
    await ok(p, { type: 'record_wear', timezone: TZ, wearingDate: '2026-10-25', occurredAt: '2026-10-25T00:30:00+01:00', items: [{ garmentId: w.belt }] }, {}, clock('2026-10-26T12:00:00.000Z'));
    await ok(p, { type: 'record_wear', timezone: TZ, wearingDate: '2026-10-25', occurredAt: '2026-10-25T23:30:00+00:00', items: [{ garmentId: w.belt }] }, {}, clock('2026-10-26T12:00:00.000Z'));
    expect((await listDailyWears(db(), p, { garmentId: w.sneakers })).map((d) => d.wearingDate)).toEqual(['2026-10-24']);
    expect(await wearCount(p, w.belt)).toBe(1);
  });

  it('rejects future dates and inconsistent timestamps; rejects freshUnit on a single garment', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    const opts = clock('2026-10-06T09:00:00.000Z');
    expect((await run(p, { type: 'record_wear', timezone: TZ, wearingDate: '2026-10-07', items: [{ garmentId: w.shirtA }] }, {}, opts)).error?.code).toBe('validation_failed');
    expect((await run(p, { type: 'record_wear', timezone: TZ, wearingDate: '2026-10-01', occurredAt: '2026-10-05T10:00:00+01:00', items: [{ garmentId: w.shirtA }] }, {}, opts)).error?.code).toBe('validation_failed');
    expect((await run(p, { type: 'record_wear', timezone: 'Mars/Olympus', items: [{ garmentId: w.shirtA }] }, {}, opts)).error?.code).toBe('validation_failed');
    expect((await run(p, { type: 'record_wear', timezone: TZ, items: [{ garmentId: w.shirtA, freshUnit: true }] }, {}, opts)).error?.code).toBe('validation_failed');
    expect((await run(p, { type: 'record_wear', timezone: TZ, items: [{ garmentId: w.shirtA }, { garmentId: w.shirtA }] }, {}, opts)).error?.code).toBe('validation_failed');
  });

  it('accepts a wear of a garment the ledger thought unavailable, with a warning and no status change', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    await ok(p, { type: 'put_into_storage', garmentId: w.blazer }, {}, clock('2026-10-01T09:00:00.000Z'));
    const r = await ok(p, { type: 'record_wear', timezone: TZ, items: [{ garmentId: w.blazer }] }, {}, clock('2026-10-06T09:00:00.000Z'));
    expect((r.facts.warnings as string[])[0]).toContain('storage');
    expect(await wearCount(p, w.blazer)).toBe(1);
  });
});

describe('late observations recompute in event order', () => {
  it("a late report of yesterday's wear does not undo today's known wash", async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    await ok(p, { type: 'record_wear', timezone: TZ, wearingDate: '2026-10-06', occurredAt: '2026-10-06T08:00:00+01:00', items: [{ garmentId: w.socks }] }, {}, clock('2026-10-06T09:00:00.000Z'));
    await ok(p, { type: 'socks_washed', occurredAt: '2026-10-06T20:00:00+01:00' }, {}, clock('2026-10-06T20:00:00.000Z'));
    expect(await buckets(p, w.socks)).toMatchObject({ clean: 4, hamper: 0 });
    // Reported on Wednesday: Monday's pair was worn. It was washed on Tuesday evening.
    await ok(p, { type: 'record_wear', timezone: TZ, wearingDate: '2026-10-05', items: [{ garmentId: w.socks }] }, {}, clock('2026-10-07T09:00:00.000Z'));
    expect(await buckets(p, w.socks)).toMatchObject({ clean: 4, hamper: 0 });
    expect(await wearCount(p, w.socks)).toBe(2);
  });

  it('a late wear from before a pickup is not placed into a bag it never entered', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    await ok(p, { type: 'record_wear', timezone: TZ, wearingDate: '2026-10-05', occurredAt: '2026-10-05T08:00:00+01:00', items: [{ garmentId: w.shirtA }] }, {}, clock('2026-10-05T09:00:00.000Z'));
    const collected = await ok(p, { type: 'laundry_collected', occurredAt: '2026-10-09T09:00:00+01:00' }, {}, clock('2026-10-09T09:00:00.000Z'));
    expect((collected.facts.items as unknown[]).length).toBe(1);
    await ok(p, { type: 'record_wear', timezone: TZ, wearingDate: '2026-10-06', items: [{ garmentId: w.shirtB }] }, {}, clock('2026-10-10T09:00:00.000Z'));
    expect(await buckets(p, w.shirtB)).toMatchObject({ clean: 0, hamper: 1, laundry: 0 });
    expect(await buckets(p, w.shirtA)).toMatchObject({ laundry: 1 });
  });

  it('an amendment after a pickup preserves the historical pickup and records an explicit adjustment', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    const wear = await ok(p, { type: 'record_wear', timezone: TZ, wearingDate: '2026-10-05', occurredAt: '2026-10-05T08:00:00+01:00', items: [{ garmentId: w.shirtA }] }, {}, clock('2026-10-05T09:00:00.000Z'));
    await ok(p, { type: 'laundry_collected', occurredAt: '2026-10-09T09:00:00+01:00' }, {}, clock('2026-10-09T09:00:00.000Z'));
    const amended = await ok(p, { type: 'amend_wear', observationId: wear.facts.observationId as string, items: [{ garmentId: w.shirtB }], reason: 'It was the white shirt' }, {}, clock('2026-10-10T09:00:00.000Z'));
    expect(await wearCount(p, w.shirtA)).toBe(0);
    expect(await wearCount(p, w.shirtB)).toBe(1);
    // Shirt A physically went in the bag: it stays in the batch, drawn from clean as an adjustment.
    expect(await buckets(p, w.shirtA)).toMatchObject({ clean: 0, laundry: 1 });
    expect(await buckets(p, w.shirtB)).toMatchObject({ hamper: 1, laundry: 0 });
    expect(JSON.stringify(amended.facts.stockNotes)).toContain('Pickup preserved');
    // Undo the amendment: back to the original record.
    const undo = await ok(p, { type: 'undo', targetCommandId: amended.commandId }, {}, clock('2026-10-10T10:00:00.000Z'));
    expect(undo.compensatesCommandId).toBe(amended.commandId);
    expect(await wearCount(p, w.shirtA)).toBe(1);
    expect(await wearCount(p, w.shirtB)).toBe(0);
  });
});

describe('owner observations are accepted and rebased, never rejected on version conflict', () => {
  /**
   * Deployed D1 serves each query as a separate round trip with no shared snapshot, so another command
   * can commit between two reads of one plan. Local D1 answers in microseconds and rarely shows this.
   * This wrapper makes the interleaving deterministic: after the first read matching `trigger`
   * returns, `hook` commits a competing command on the real database before the plan continues.
   */
  function interleavingDb(real: D1Database, trigger: RegExp, hook: () => Promise<unknown>): D1Database {
    let fired = false;
    return new Proxy(real, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            const stmt = target.prepare(sql);
            if (!trigger.test(sql)) return stmt;
            const bind = stmt.bind.bind(stmt);
            (stmt as unknown as { bind: (...a: unknown[]) => D1PreparedStatement }).bind = (...args: unknown[]) => {
              const bound = bind(...args);
              const all = bound.all.bind(bound);
              (bound as unknown as { all: () => Promise<unknown> }).all = async () => {
                const result = await all();
                if (!fired) {
                  fired = true;
                  await hook();
                }
                return result;
              };
              return bound;
            };
            return stmt;
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as D1Database;
  }
  const DAY_OBSERVATIONS = /FROM wear_observations WHERE user_id = \? AND wearing_date = \?/;

  it('ADV-08 on deployed D1: a report whose reads straddle another commit gets a merged receipt, not a second committed one', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    const opts = clock('2026-10-06T09:00:00.000Z');
    const cmd = { type: 'record_wear' as const, timezone: TZ, items: [{ garmentId: w.shirtA }, { garmentId: w.trousers }] };
    let competitor: Awaited<ReturnType<typeof run>> | null = null;
    const racy = interleavingDb(db(), DAY_OBSERVATIONS, async () => {
      competitor = await service(p, opts).execute(envelope(cmd, { source: 'mcp' }));
    });
    const subject = await new CommandService(racy, p, opts).execute(envelope(cmd));
    expect(competitor!.outcome).toBe('committed');
    expect(subject.outcome).toBe('merged');
    expect(subject.summary).toContain('no new counted wear');
    expect(await wearCount(p, w.shirtA)).toBe(1);
    expect(await buckets(p, w.shirtA)).toMatchObject({ clean: 0, hamper: 1 });
    expect(await buckets(p, w.trousers)).toMatchObject({ clean: 0, worn: 1 });
    const moves = await db().prepare("SELECT COUNT(*) AS n FROM stock_movements WHERE user_id = ? AND kind = 'wear' AND voided_at IS NULL").bind(p.userId).first<{ n: number }>();
    expect(moves!.n).toBe(2);
    expect((await listDailyWears(db(), p, { garmentId: w.shirtA }))[0]).toMatchObject({ observationCount: 2, revision: 1 });
  });

  it('a retraction whose reads straddle a newly merged report keeps the wear counted and its stock movement', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    const opts = clock('2026-10-06T09:00:00.000Z');
    const cmd = { type: 'record_wear' as const, timezone: TZ, items: [{ garmentId: w.shirtA }] };
    const first = await ok(p, cmd, {}, opts);
    let mergedOutcome = '';
    const racy = interleavingDb(db(), DAY_OBSERVATIONS, async () => {
      mergedOutcome = (await service(p, opts).execute(envelope(cmd, { source: 'offline_replay' }))).outcome;
    });
    const undo = await new CommandService(racy, p, opts).execute(envelope({ type: 'undo', targetCommandId: first.commandId }));
    expect(mergedOutcome).toBe('merged');
    expect(undo.outcome).toBe('committed');
    expect(await wearCount(p, w.shirtA)).toBe(1);
    expect(await buckets(p, w.shirtA)).toMatchObject({ clean: 0, hamper: 1 });
    const moves = await db().prepare("SELECT COUNT(*) AS n FROM stock_movements WHERE user_id = ? AND garment_id = ? AND kind = 'wear' AND voided_at IS NULL").bind(p.userId, w.shirtA).first<{ n: number }>();
    expect(moves!.n).toBe(1);
    expect((await listDailyWears(db(), p, { garmentId: w.shirtA }))[0]).toMatchObject({ observationCount: 1, status: 'active' });
  });

  it('ADV-08: twenty concurrent identical reports are all accepted: one committed, nineteen merged, one counted wear', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    const opts = clock('2026-10-06T09:00:00.000Z');
    const cmd = { type: 'record_wear' as const, timezone: TZ, items: [{ garmentId: w.shirtA }, { garmentId: w.socks }] };
    const outs = await Promise.all(Array.from({ length: 20 }, () => service(p, opts).execute(envelope(cmd))));
    expect(outs.map((r) => r.error?.code).filter(Boolean)).toEqual([]);
    expect(outs.filter((r) => r.outcome === 'committed')).toHaveLength(1);
    expect(outs.filter((r) => r.outcome === 'merged')).toHaveLength(19);
    expect(await wearCount(p, w.shirtA)).toBe(1);
    expect(await buckets(p, w.shirtA)).toMatchObject({ clean: 0, hamper: 1 });
    expect(await buckets(p, w.socks)).toMatchObject({ clean: 3, hamper: 1 });
    const day = (await listDailyWears(db(), p, { garmentId: w.shirtA }))[0]!;
    expect(day.observationCount).toBe(20);
    expect(day.revision).toBe(1);
    // Every caller has a stored receipt.
    const n = await db().prepare("SELECT COUNT(*) AS n FROM command_receipts WHERE user_id = ? AND command_type = 'record_wear'").bind(p.userId).first<{ n: number }>();
    expect(n!.n).toBe(20);
  });

  it('rebases stale expected versions for an owner observation', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    const lot = await db().prepare('SELECT lot_id, version FROM stock_lots WHERE user_id = ? AND garment_id = ?').bind(p.userId, w.shirtA).first<{ lot_id: string; version: number }>();
    await ok(p, { type: 'mark_in_wash', garmentId: w.shirtA }, {}, clock('2026-10-06T07:00:00.000Z'));
    const r = await ok(p, { type: 'mark_washed', garmentId: w.shirtA }, { expectedVersions: [{ entityType: 'stock_lot', entityId: lot!.lot_id, version: lot!.version }] }, clock('2026-10-06T08:00:00.000Z'));
    expect(r.outcome).toBe('committed');
    expect(r.rebased).toBe(true);
    expect(await buckets(p, w.shirtA)).toMatchObject({ clean: 1, hamper: 0 });
  });

  it('concurrent reports of the same wear from two clients both commit and count once', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    const opts = clock('2026-10-06T09:00:00.000Z');
    const cmd = { type: 'record_wear' as const, timezone: TZ, items: [{ garmentId: w.shirtA }, { garmentId: w.socks }] };
    const [a, b] = await Promise.all([service(p, opts).execute(envelope(cmd, { source: 'app' })), service(p, opts).execute(envelope(cmd, { source: 'mcp' }))]);
    expect([a.outcome, b.outcome].sort()).toEqual(['committed', 'merged']);
    expect(await wearCount(p, w.shirtA)).toBe(1);
    expect(await buckets(p, w.socks)).toMatchObject({ clean: 3, hamper: 1 });
    expect((await listDailyWears(db(), p, { garmentId: w.shirtA }))[0]!.observationCount).toBe(2);
  });
});

describe('wear undo', () => {
  it('undo is a compensating command; the original receipt is kept and marked undone', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    const opts = clock('2026-10-06T09:00:00.000Z');
    const wear = await ok(p, { type: 'record_wear', timezone: TZ, items: [{ garmentId: w.shirtA }, { garmentId: w.trousers }] }, {}, opts);
    const undo = await ok(p, { type: 'undo', targetCommandId: wear.commandId }, {}, opts);
    expect(undo.compensatesCommandId).toBe(wear.commandId);
    expect(await wearCount(p, w.shirtA)).toBe(0);
    expect(await buckets(p, w.shirtA)).toMatchObject({ clean: 1, hamper: 0 });
    expect(await buckets(p, w.trousers)).toMatchObject({ clean: 1, worn: 0 });
    const original = await getReceipt(db(), p, wear.commandId);
    expect(original!.undoneByCommandId).toBe(undo.commandId);
    expect(original!.undo.available).toBe(false);
    const again = await run(p, { type: 'undo', targetCommandId: wear.commandId }, {}, opts);
    expect(again.error?.code).toBe('already_undone');
    const undoOfUndo = await run(p, { type: 'undo', targetCommandId: undo.commandId }, {}, opts);
    expect(undoOfUndo.error?.code).toBe('not_reversible');
    const obs = await db().prepare('SELECT status FROM wear_observations WHERE user_id = ?').bind(p.userId).first<{ status: string }>();
    expect(obs!.status).toBe('retracted');
  });
});
