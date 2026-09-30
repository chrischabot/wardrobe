import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import fc from 'fast-check';
import type { CommandEnvelopeInput, CommandReceipt, DomainCommandInput } from '@garderobe/contracts';
import { estimateAvailability } from '../../../../backend/src/domain/estimator.js';
import { validateOutfit, type CandidateSlot } from '../../../../backend/src/recommend/validate.js';
import type { MandatoryContext } from '../../../../backend/src/recommend/context.js';
import { getDailyBoard } from '../../../../backend/src/recommend/publish.js';
import { ownerScenario } from '../../helpers/daily.js';
import { hardConstraintBreaks } from '../../helpers/oracle.js';
import { count, negativeBuckets, newOwner, one, q, service, total, buckets, type Owner } from '../../helpers/seed.js';
import { knownDefect } from '../../helpers/defects.js';

describe('receipts at the storage layer', () => {
  it('a stored receipt cannot be deleted, even with direct SQL', async () => {
    const o = await newOwner();
    const id = (await one<{ command_id: string }>('SELECT command_id FROM command_receipts WHERE user_id = ? LIMIT 1', o.userId)).command_id;
    await expect(env.DB.prepare('DELETE FROM command_receipts WHERE user_id = ? AND command_id = ?').bind(o.userId, id).run()).rejects.toThrow();
  });

  // ADV-16 (DEFECTS.md): migration 0001 blocks DELETE on command_receipts with a trigger but not UPDATE, so the audit
  // trail is immutable only by convention in application code.
  it('[ADV-16] a stored receipt cannot be rewritten with direct SQL (UPDATE refused like DELETE)', async () => {
    const o = await newOwner();
    const id = (await one<{ command_id: string }>('SELECT command_id FROM command_receipts WHERE user_id = ? LIMIT 1', o.userId)).command_id;
    await expect(env.DB.prepare("UPDATE command_receipts SET receipt_json = '{}', outcome = 'merged' WHERE user_id = ? AND command_id = ?").bind(o.userId, id).run()).rejects.toThrow();
  });
});

/**
 * Property-based tests (fast-check 4.10) over the command service, the estimator, the validator and
 * the publisher, on the owner's real wardrobe in real local D1. Seeds are fixed so a failure is
 * reproducible: rerun with the printed seed and path. Each generated case gets a fresh owner.
 */

const TZ = 'Europe/London';
const SEED = 20261006;
const DATES = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26'];

type Op =
  | { k: 'wear'; g: number; d: number; fresh: boolean }
  | { k: 'wash'; g: number; qty: number }
  | { k: 'washed'; g: number }
  | { k: 'socks_washed' }
  | { k: 'collect' }
  | { k: 'return'; missing: number | null }
  | { k: 'reconcile'; clean: number | null; totalOwned: number | null }
  | { k: 'undo'; back: number }
  | { k: 'replay'; back: number }
  | { k: 'replay_altered'; back: number };

const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ k: fc.constant('wear' as const), g: fc.nat(5), d: fc.nat(DATES.length - 1), fresh: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant('wash' as const), g: fc.nat(5), qty: fc.integer({ min: 1, max: 4 }) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('washed' as const), g: fc.nat(5) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('socks_washed' as const) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('collect' as const) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('return' as const), missing: fc.option(fc.nat(5), { nil: null }) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('reconcile' as const), clean: fc.option(fc.integer({ min: 0, max: 6 }), { nil: null }), totalOwned: fc.option(fc.integer({ min: 0, max: 6 }), { nil: null }) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('undo' as const), back: fc.nat(10) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('replay' as const), back: fc.nat(10) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('replay_altered' as const), back: fc.nat(10) }) },
);

async function pool(o: Owner): Promise<string[]> {
  return Promise.all(['Lightweight oxford — gold', 'Lightweight oxford — pink', 'Merino — fire red', 'Merino — correct grey', 'NB 990v4 — grey', "Drake's Waxed Chasseur"].map((n) => o.byName(n)));
}

function commandFor(x: Op, g: string[], socks: string): DomainCommandInput | null {
  switch (x.k) {
    case 'wear':
      return { type: 'record_wear', timezone: TZ, wearingDate: DATES[x.d]!, items: [{ garmentId: g[x.g]!, ...(x.fresh ? { freshUnit: true } : {}) }] };
    case 'wash':
      return { type: 'mark_in_wash', garmentId: g[x.g]!, quantity: x.qty };
    case 'washed':
      return { type: 'mark_washed', garmentId: g[x.g]! };
    case 'socks_washed':
      return { type: 'socks_washed' };
    case 'collect':
      return { type: 'laundry_collected' };
    case 'return':
      return { type: 'laundry_returned', ...(x.missing !== null ? { exceptions: [{ garmentId: g[x.missing]! }] } : {}) };
    case 'reconcile':
      return x.clean === null && x.totalOwned === null ? null : { type: 'reconcile_quantity', garmentId: socks, ...(x.clean !== null ? { clean: x.clean } : {}), ...(x.totalOwned !== null ? { totalOwned: x.totalOwned } : {}) };
    default:
      return null;
  }
}

async function invariants(o: Owner, committed: { env: CommandEnvelopeInput; receipt: CommandReceipt }[], snapshots: Map<string, string>) {
  // 1. Stock never negative.
  expect(await negativeBuckets(o.userId)).toEqual([]);
  // 2. One counted wear per garment and local date, and at most one wear movement per garment and date.
  expect(await q("SELECT garment_id, wearing_date, COUNT(*) AS n FROM daily_wears WHERE user_id = ? AND status = 'active' GROUP BY garment_id, wearing_date HAVING n > 1", o.userId)).toEqual([]);
  // 3. Receipts are immutable: every stored receipt row is byte-identical to when it was first written,
  //    except the one field a compensation is allowed to set (undone_by_command_id).
  for (const [id, before] of snapshots) {
    const now = await one<Record<string, unknown>>('SELECT * FROM command_receipts WHERE user_id = ? AND command_id = ?', o.userId, id);
    const { undone_by_command_id: _u, ...rest } = now;
    expect(JSON.stringify(rest), id).toBe(before);
  }
  // 4. Replaying any committed envelope returns the same receipt and changes nothing.
  if (committed.length) {
    const pick = committed[committed.length - 1]!;
    const before = await count('SELECT COUNT(*) AS n FROM stock_movements WHERE user_id = ?', o.userId);
    const again = await service(o.principal, { now: () => '2026-09-27T12:00:00.000Z' }).execute(pick.env);
    expect(again.commandId).toBe(pick.receipt.commandId);
    expect(again.replayed).toBe(true);
    expect(await count('SELECT COUNT(*) AS n FROM stock_movements WHERE user_id = ?', o.userId)).toBe(before);
  }
}

describe('property: the command service keeps the ledger invariants under arbitrary command sequences', () => {
  it('stock never negative, one counted wear per garment/date, receipts immutable, replays idempotent, units conserved', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 4, maxLength: 22 }), async (ops) => {
        const o = await newOwner();
        const g = await pool(o);
        const socks = g[2]!;
        const unitsBefore = new Map(await Promise.all(g.filter((x) => x !== socks).map(async (id) => [id, total(await buckets(o.userId, id))] as const)));
        const committed: { env: CommandEnvelopeInput; receipt: CommandReceipt }[] = [];
        const snapshots = new Map<string, string>();
        const now = () => '2026-09-27T12:00:00.000Z';
        for (const x of ops) {
          let env1: CommandEnvelopeInput | null = null;
          if (x.k === 'undo' || x.k === 'replay' || x.k === 'replay_altered') {
            const target = committed[committed.length - 1 - (x.back % Math.max(committed.length, 1))];
            if (!target) continue;
            if (x.k === 'undo') env1 = { idempotencyKey: `prop:${crypto.randomUUID()}`, source: 'app', command: { type: 'undo', targetCommandId: target.receipt.commandId } };
            if (x.k === 'replay') env1 = target.env;
            if (x.k === 'replay_altered') {
              const altered = { ...target.env, command: { type: 'mark_washed', garmentId: g[0]! } as DomainCommandInput };
              const r = await service(o.principal, { now }).execute(altered);
              expect(target.env.command.type === 'mark_washed' && JSON.stringify(target.env.command) === JSON.stringify(altered.command) ? true : r.error?.code === 'idempotency_key_reused').toBe(true);
              continue;
            }
          } else {
            const command = commandFor(x, g, socks);
            if (!command) continue;
            env1 = { idempotencyKey: `prop:${crypto.randomUUID()}`, source: 'app', command };
          }
          const r = await service(o.principal, { now }).execute(env1!);
          if ((r.outcome === 'committed' || r.outcome === 'merged') && !r.replayed) {
            committed.push({ env: env1!, receipt: r });
            const row = await one<Record<string, unknown>>('SELECT * FROM command_receipts WHERE user_id = ? AND command_id = ?', o.userId, r.commandId);
            const { undone_by_command_id: _u, ...rest } = row;
            snapshots.set(r.commandId, JSON.stringify(rest));
          }
        }
        await invariants(o, committed, snapshots);
        // 5. Units of unit-tracked garments are conserved (only the socks were ever recounted).
        for (const [id, n] of unitsBefore) expect(total(await buckets(o.userId, id)), id).toBe(n);
        // 6. The estimator stays within its bounds on whatever state resulted.
        const est = await estimateAvailability(env.DB, o.principal, { targetDate: '2026-09-28', asOf: '2026-09-27T20:00:00.000Z', garmentIds: g });
        for (const e of est) {
          expect(e.probabilityAvailable).toBeGreaterThanOrEqual(0);
          expect(e.probabilityAvailable).toBeLessThanOrEqual(1);
          expect(e.estimatedCleanUnits).toBeGreaterThanOrEqual(0);
          if (!e.eligible) expect(e.likelyAvailable).toBe(false);
        }
      }),
      { numRuns: 40, seed: SEED, endOnFailure: true },
    );
  }, 600_000);
});

describe('property: the validator never accepts an outfit that breaks a hard constraint', () => {
  it('random outfits drawn from the real wardrobe under random weather: valid ⇒ no oracle break', async () => {
    const scenarios = ['mild', 'coldSnap', 'elevenToNineteen', 'jacketBand', 'heat', 'heavyRain'] as const;
    const contexts: MandatoryContext[] = [];
    for (const scenario of scenarios) {
      const s = await ownerScenario({ weather: { scenario } });
      contexts.push(await s.rec.context({ date: '2026-10-06' }));
    }
    let accepted = 0;
    await fc.assert(
      fc.property(fc.nat(contexts.length - 1), fc.array(fc.nat(10_000), { minLength: 8, maxLength: 8 }), fc.boolean(), fc.boolean(), fc.boolean(), (ci, picks, withOuter, withMid, withAccessory) => {
        const ctx = contexts[ci]!;
        const by = (role: string) => ctx.wardrobe.filter((w) => w.roles.includes(role as never));
        const choose = (role: string, i: number) => {
          const list = by(role);
          return list.length ? list[picks[i]! % list.length]! : null;
        };
        const slots: CandidateSlot[] = [];
        const add = (role: CandidateSlot['role'], i: number) => {
          const x = choose(role, i);
          if (x && !slots.some((s) => s.garmentId === x.garmentId)) slots.push({ garmentId: x.garmentId, role });
        };
        add('base_top', 0);
        add('bottom', 1);
        add('socks', 2);
        add('footwear', 3);
        if (withOuter) add('outer_layer', 4);
        if (withMid) add('mid_layer', 5);
        if (withAccessory) add('accessory', 6);
        add('belt', 7);
        const v = validateOutfit({ slots, source: 'model' }, ctx);
        if (v.valid) {
          accepted++;
          expect(hardConstraintBreaks(slots, ctx)).toEqual([]);
        }
      }),
      { numRuns: 3000, seed: SEED },
    );
    expect(accepted).toBeGreaterThan(0);
  }, 300_000);

  it('adversarial mutations of a valid option (swap in a random garment in a random role) are either rejected or still compliant', async () => {
    const s = await ownerScenario({ weather: { scenario: 'jacketBand' } });
    const { context: ctx, composed } = await s.rec.compose({ date: '2026-10-06' });
    const roles: CandidateSlot['role'][] = ['base_top', 'bottom', 'socks', 'footwear', 'outer_layer', 'mid_layer', 'accessory', 'belt', 'underwear', 'indoor', 'one_piece'];
    await fc.assert(
      fc.property(fc.nat(composed.options.length - 1), fc.nat(ctx.wardrobe.length - 1), fc.nat(roles.length - 1), fc.boolean(), (oi, gi, ri, drop) => {
        const base = composed.options[oi]!.slots;
        const role = roles[ri]!;
        const g = ctx.wardrobe[gi]!;
        const slots = drop ? base.filter((x) => x.role !== role) : [...base.filter((x) => x.role !== role), { garmentId: g.garmentId, role }];
        const v = validateOutfit({ slots, source: 'model' }, ctx);
        if (v.valid) expect(hardConstraintBreaks(slots, ctx)).toEqual([]);
      }),
      { numRuns: 2000, seed: SEED },
    );
  }, 300_000);
});

describe('property: every published option is complete, valid and compliant', () => {
  it('random weather, recent wears, laundry state, exclusions and requested counts never produce a non-compliant published option', async () => {
    const scenarios = ['mild', 'coldSnap', 'elevenToNineteen', 'jacketBand', 'heat', 'heavyRain', 'strongWind', 'warmDayCoolEvening', 'rainAfterFour'] as const;
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...scenarios),
        fc.array(fc.nat(10_000), { maxLength: 8 }),
        fc.array(fc.nat(10_000), { maxLength: 6 }),
        fc.option(fc.integer({ min: -3, max: 14 }), { nil: undefined }),
        async (scenario, wornPicks, excludePicks, requestedCount) => {
          const s = await ownerScenario({ weather: { scenario }, now: '2026-10-05T19:00:00.000Z' });
          const ctx0 = await s.rec.context({ date: '2026-10-06' });
          const laundered = ctx0.wardrobe.filter((g) => ['base_top', 'bottom'].some((r) => g.roles.includes(r as never)) && g.laundryPolicy === 'per_wear');
          for (const [i, p] of wornPicks.entries()) {
            const g = laundered[p % laundered.length]!;
            await s.tryCmd({ type: 'record_wear', timezone: TZ, wearingDate: DATES[i % DATES.length]!, items: [{ garmentId: g.garmentId }] });
            if (i % 2) await s.tryCmd({ type: 'mark_in_wash', garmentId: g.garmentId });
          }
          const exclude = excludePicks.map((p) => ctx0.wardrobe[p % ctx0.wardrobe.length]!.garmentId);
          s.clock.set('2026-10-05T20:00:00.000Z');
          const out = await s.rec.composeAndPublish({ date: '2026-10-06', exclude, requestedCount });
          const board = await getDailyBoard(env.DB, s.principal, '2026-10-06');
          if (!out.published) {
            expect(board).toBeNull();
            return;
          }
          const ctx = await s.rec.context({ date: '2026-10-06', exclude });
          const offerable = board!.options.filter((o) => o.status === 'offerable');
          expect(offerable.length).toBeGreaterThanOrEqual(1);
          expect(offerable.length).toBeLessThanOrEqual(10);
          for (const o of offerable) {
            expect(hardConstraintBreaks(o.slots, ctx), `${scenario} option ${o.position}`).toEqual([]);
            for (const x of o.slots) expect(exclude).not.toContain(x.garmentId);
          }
          // Distinct shirts across the board.
          const tops = offerable.map((o) => o.slots.find((x) => x.role === 'base_top')!.garmentId);
          expect(new Set(tops).size).toBe(tops.length);
          // Composition and publication never create a counted wear.
          expect(await count("SELECT COUNT(*) AS n FROM daily_wears WHERE user_id = ? AND wearing_date = '2026-10-06'", s.userId)).toBe(0);
        },
      ),
      { numRuns: 20, seed: SEED, endOnFailure: true },
    );
  }, 600_000);
});
