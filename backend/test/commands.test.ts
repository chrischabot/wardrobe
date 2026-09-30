import { describe, expect, it } from 'vitest';
import { CommandReceipt } from '@garderobe/contracts';
import { basicWardrobe, buckets, db, envelope, key, newUser, ok, run, service } from './helpers/fixtures.js';
import { getReceipt, publishBoardRevision, readOnlyPrincipal } from '../src/domain/index.js';

const TZ = 'Europe/London';
const clock = (iso: string) => ({ now: () => iso });
const count = async (table: string, userId: string) => (await db().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).bind(userId).first<{ n: number }>())!.n;

describe('receipts and idempotency', () => {
  it('returns a verified receipt matching the contract', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    const r = await ok(p, { type: 'mark_in_wash', garmentId: w.shirtA });
    expect(CommandReceipt.safeParse(r).success).toBe(true);
    expect(r.commandId).toMatch(/^cmd_/);
    expect(r.affected.some((a) => a.entityType === 'stock_lot' && a.version === 3)).toBe(true);
    expect(r.summary).toBe('In the wash: Lightweight oxford — blue. 0 clean remaining.');
    expect(r.effects.state).toBe('none');
    expect(r.effects.items[0]).toMatchObject({ kind: 'board_revalidation', external: false, status: 'pending' });
    expect(r.undo.available).toBe(true);
  });

  it('same key and body returns the stored receipt; same key with a different body is an error', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    const k = key('idem');
    const body = { idempotencyKey: k, source: 'app' as const, command: { type: 'mark_in_wash' as const, garmentId: w.shirtA } };
    const a = await service(p).execute(body);
    const b = await service(p).execute(body);
    expect(b.replayed).toBe(true);
    expect(b.commandId).toBe(a.commandId);
    expect(await buckets(p, w.shirtA)).toMatchObject({ hamper: 1 });
    const c = await service(p).execute({ ...body, command: { type: 'mark_in_wash', garmentId: w.shirtB } });
    expect(c.outcome).toBe('rejected');
    expect(c.error?.code).toBe('idempotency_key_reused');
    expect(await buckets(p, w.shirtB)).toMatchObject({ hamper: 0 });
  });

  it('concurrent retransmissions with one key commit exactly once', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    const body = envelope({ type: 'record_wear', timezone: TZ, items: [{ garmentId: w.socks }] });
    const results = await Promise.all([1, 2, 3].map(() => service(p, clock('2026-10-06T09:00:00.000Z')).execute(body)));
    expect(new Set(results.map((r) => r.commandId)).size).toBe(1);
    expect(results.filter((r) => r.replayed).length).toBe(2);
    expect(await count('wear_observations', p.userId)).toBe(1);
    expect(await buckets(p, w.socks)).toMatchObject({ clean: 3, hamper: 1 });
  });

  it('never deletes receipts', async () => {
    const p = await newUser();
    await basicWardrobe(p);
    await expect(db().prepare('DELETE FROM command_receipts WHERE user_id = ?').bind(p.userId).run()).rejects.toThrow(/never deleted/);
    expect(await count('command_receipts', p.userId)).toBe(7);
  });

  it('ADV-16: receipts cannot be rewritten with SQL; only undo may mark them undone, once', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    const r = await ok(p, { type: 'mark_in_wash', garmentId: w.shirtA });
    const before = await db().prepare('SELECT * FROM command_receipts WHERE user_id = ? AND command_id = ?').bind(p.userId, r.commandId).first();
    for (const sql of [
      "UPDATE command_receipts SET receipt_json = '{}' WHERE user_id = ? AND command_id = ?",
      "UPDATE command_receipts SET outcome = 'merged' WHERE user_id = ? AND command_id = ?",
      "UPDATE command_receipts SET undo_json = NULL WHERE user_id = ? AND command_id = ?",
      "UPDATE command_receipts SET user_id = 'usr_other' WHERE user_id = ? AND command_id = ?",
      "UPDATE command_receipts SET undone_by_command_id = 'cmd_x', source = 'mcp' WHERE user_id = ? AND command_id = ?",
    ]) {
      await expect(db().prepare(sql).bind(p.userId, r.commandId).run(), sql).rejects.toThrow(/immutable/);
    }
    expect(await db().prepare('SELECT * FROM command_receipts WHERE user_id = ? AND command_id = ?').bind(p.userId, r.commandId).first()).toEqual(before);
    // The undo path still works and cannot be repeated or reversed at the storage layer.
    const undo = await ok(p, { type: 'undo', targetCommandId: r.commandId });
    expect((await getReceipt(db(), p, r.commandId))!.undoneByCommandId).toBe(undo.commandId);
    await expect(db().prepare('UPDATE command_receipts SET undone_by_command_id = NULL WHERE user_id = ? AND command_id = ?').bind(p.userId, r.commandId).run()).rejects.toThrow(/immutable/);
    await expect(db().prepare("UPDATE command_receipts SET undone_by_command_id = 'cmd_other' WHERE user_id = ? AND command_id = ?").bind(p.userId, r.commandId).run()).rejects.toThrow(/immutable/);
  });
});

describe('atomic commit boundary', () => {
  it('a forced late-statement failure leaves no receipt, partial mutation or effect', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    const before = { receipts: await count('command_receipts', p.userId), obs: await count('wear_observations', p.userId), moves: await count('stock_movements', p.userId), effects: await count('command_effects', p.userId) };
    await expect(
      run(p, { type: 'record_wear', timezone: TZ, items: [{ garmentId: w.shirtA }, { garmentId: w.socks }] }, {}, {
        now: () => '2026-10-06T09:00:00.000Z',
        afterStatements: (d) => [d.prepare('UPDATE stock_lots SET clean_qty = -1 WHERE user_id = ? AND garment_id = ?').bind(p.userId, w.trousers)],
      }),
    ).rejects.toThrow(/CHECK constraint failed/);
    expect({ receipts: await count('command_receipts', p.userId), obs: await count('wear_observations', p.userId), moves: await count('stock_movements', p.userId), effects: await count('command_effects', p.userId) }).toEqual(before);
    expect(await buckets(p, w.shirtA)).toMatchObject({ clean: 1, hamper: 0 });
    expect(await count('daily_wears', p.userId)).toBe(0);
  });

  it('a bulk wear with one unresolvable target changes nothing (all-or-nothing)', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    const r = await run(p, { type: 'record_wear', timezone: TZ, items: [{ garmentId: w.shirtA }, { garmentId: 'g_doesnotexist' }] });
    expect(r.outcome).toBe('rejected');
    expect(r.error?.code).toBe('not_found');
    expect(await count('wear_observations', p.userId)).toBe(0);
    expect(await buckets(p, w.shirtA)).toMatchObject({ clean: 1 });
  });

  it('stale expected versions on an edit are a conflict and write nothing; racing edits cannot both win', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    const set = await ok(p, { type: 'set_restriction', kind: 'repair', scope: { garmentIds: [w.blazer] }, reason: 'Loose button' });
    const restrictionId = set.facts.restrictionId as string;
    const lift = (evidence: string) => envelope({ type: 'lift_restriction', restrictionId, evidence }, { expectedVersions: [{ entityType: 'restriction', entityId: restrictionId, version: 1 }] });
    const [a, b] = await Promise.all([service(p).execute(lift('Button sewn on')), service(p).execute(lift('Tailor fixed it'))]);
    expect([a.outcome, b.outcome].sort()).toEqual(['committed', 'conflict']);
    const loser = a.outcome === 'conflict' ? a : b;
    expect(loser.error?.code).toBe('stale_version');
    const row = await db().prepare('SELECT version, lift_evidence FROM restrictions WHERE user_id = ? AND restriction_id = ?').bind(p.userId, restrictionId).first<{ version: number; lift_evidence: string }>();
    expect(row!.version).toBe(2);
    expect(row!.lift_evidence).toBe((a.outcome === 'committed' ? a : b).facts.evidence);
  });
});

describe('item creation is explicit only', () => {
  it('requires explicit: true from an owner channel; status commands never create items', async () => {
    const p = await newUser();
    const missing = await run(p, { type: 'add_item', name: 'Mystery', category: 'shirt', roles: ['base_top'] } as never);
    expect(missing.error?.code).toBe('validation_failed');
    const system = await run(p, { type: 'add_item', explicit: true, name: 'Mystery', category: 'shirt', roles: ['base_top'] }, { source: 'system' });
    expect(system.error?.code).toBe('validation_failed');
    for (const cmd of [
      { type: 'mark_arrived' as const, garmentId: 'g_blue_stripe_new' },
      { type: 'back_from_tailor' as const, garmentId: 'g_blue_stripe_new' },
      { type: 'put_into_storage' as const, garmentId: 'g_blue_stripe_new' },
    ]) {
      expect((await run(p, cmd)).error?.code).toBe('not_found');
    }
    expect(await count('garments', p.userId)).toBe(0);
  });

  it('undo of a creation removes a mistaken entry, but not once it has recorded wears', async () => {
    const p = await newUser();
    const created = await ok(p, { type: 'add_item', explicit: true, name: 'Fabricated shirt', category: 'shirt', roles: ['base_top'] });
    const undone = await ok(p, { type: 'undo', targetCommandId: created.commandId });
    expect(undone.summary).toContain('removed as a mistaken entry');
    const g = await db().prepare('SELECT acquisition, disposal_reason FROM garments WHERE user_id = ?').bind(p.userId).first();
    expect(g).toEqual({ acquisition: 'disposed', disposal_reason: 'fabricated_entry' });
    const real = await ok(p, { type: 'add_item', explicit: true, name: 'Real shirt', category: 'shirt', roles: ['base_top'] });
    await ok(p, { type: 'record_wear', timezone: TZ, items: [{ garmentId: real.facts.garmentId as string }] });
    expect((await run(p, { type: 'undo', targetCommandId: real.commandId })).error?.code).toBe('not_reversible');
  });
});

describe('lifecycle commands', () => {
  it('arrived turns an incoming item into owned stock once; an expected date never does', async () => {
    const p = await newUser();
    const created = await ok(p, { type: 'add_item', explicit: true, name: 'NB 993 — grey', category: 'sneakers', roles: ['footwear'], acquisition: 'incoming' });
    const id = created.facts.garmentId as string;
    expect(await buckets(p, id)).toMatchObject({ clean: 0 });
    const arrived = await ok(p, { type: 'mark_arrived', garmentId: id });
    expect(arrived.summary).toBe('Arrived: NB 993 — grey.');
    expect(await buckets(p, id)).toMatchObject({ clean: 1 });
    expect((await run(p, { type: 'mark_arrived', garmentId: id })).error?.code).toBe('invalid_state');
  });

  it('tailor round trip, storage round trip, disposal, and undo with intervening-change checks', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    const sent = await ok(p, { type: 'send_to_tailor', garmentId: w.blazer, work: 'Take in waist', expectedReturn: '2026-10-20' });
    expect(sent.summary).toContain('An expected date is not a return');
    expect(await buckets(p, w.blazer)).toMatchObject({ clean: 0, away: 1 });
    const back = await ok(p, { type: 'back_from_tailor', garmentId: w.blazer, note: 'Waist taken in 2 cm' });
    expect(await buckets(p, w.blazer)).toMatchObject({ clean: 1, away: 0 });
    const project = await db().prepare('SELECT status, actual_return FROM lifecycle_projects WHERE user_id = ?').bind(p.userId).first<{ status: string; actual_return: string }>();
    expect(project!.status).toBe('returned');
    // Undo the return: back at the tailor, project reopened.
    await ok(p, { type: 'undo', targetCommandId: back.commandId });
    const g = await db().prepare('SELECT location FROM garments WHERE user_id = ? AND garment_id = ?').bind(p.userId, w.blazer).first<{ location: string }>();
    expect(g!.location).toBe('tailor');
    // Undo of the original send now conflicts? No: the garment is back at its post-send version? It changed twice since.
    expect((await run(p, { type: 'undo', targetCommandId: sent.commandId })).outcome).toBe('conflict');

    const stored = await ok(p, { type: 'put_into_storage', garmentId: w.shirtA, locationDetail: 'Loft' });
    expect(await buckets(p, w.shirtA)).toMatchObject({ storage: 1, clean: 0 });
    await ok(p, { type: 'take_out_of_storage', garmentId: w.shirtA });
    const conflict = await run(p, { type: 'undo', targetCommandId: stored.commandId });
    expect(conflict.outcome).toBe('conflict');
    expect(conflict.summary).toContain('changed since');

    const disposed = await ok(p, { type: 'dispose_item', garmentId: w.shirtB, reason: 'donated' });
    expect(await buckets(p, w.shirtB)).toMatchObject({ clean: 0, retired: 1 });
    await ok(p, { type: 'undo', targetCommandId: disposed.commandId });
    expect(await buckets(p, w.shirtB)).toMatchObject({ clean: 1, retired: 0 });
  });
});

describe('select option', () => {
  it('records an intention (never a wear), requires one footwear choice, rejects stale revisions and supports undo', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    const sneakers2 = (await ok(p, { type: 'add_item', explicit: true, name: 'NB 990v4 — navy', category: 'sneakers', roles: ['footwear'] })).facts.garmentId as string;
    const board = await publishBoardRevision(db(), p, {
      boardDate: '2026-10-07',
      timezone: TZ,
      expectedRevision: 0,
      options: [
        { position: 1, explanation: 'Blue oxford and walnut', slots: [{ garmentId: w.shirtA, role: 'base_top' }, { garmentId: w.trousers, role: 'bottom' }, { garmentId: w.socks, role: 'socks' }, { garmentId: w.sneakers, role: 'footwear', alternativeGroup: 'feet' }, { garmentId: sneakers2, role: 'footwear', alternativeGroup: 'feet' }] },
        { position: 2, explanation: 'White pima', slots: [{ garmentId: w.shirtB, role: 'base_top' }, { garmentId: w.trousers, role: 'bottom' }, { garmentId: w.socks, role: 'socks' }, { garmentId: w.sneakers, role: 'footwear' }] },
      ],
    });
    const [o1, o2] = board.options;
    expect((await run(p, { type: 'select_option', boardId: board.boardId, optionId: o1!.optionId })).error?.code).toBe('validation_failed');
    const chosen = await ok(p, { type: 'select_option', boardId: board.boardId, optionId: o1!.optionId, footwearGarmentId: sneakers2 });
    expect(chosen.summary).toContain('This is a plan, not a recorded wear');
    expect(chosen.summary).not.toContain('NB 990v4 — grey');
    expect(chosen.effects.state).toBe('projection_pending');
    expect(chosen.effects.items[0]).toMatchObject({ kind: 'calendar_projection', external: true });
    expect(await count('daily_wears', p.userId)).toBe(0);
    const second = await ok(p, { type: 'select_option', boardId: board.boardId, optionId: o2!.optionId });
    await ok(p, { type: 'undo', targetCommandId: second.commandId });
    const active = await db().prepare("SELECT option_id FROM selections WHERE user_id = ? AND status = 'active'").bind(p.userId).first<{ option_id: string }>();
    expect(active!.option_id).toBe(o1!.optionId);
    // A newer revision makes the old option ids stale.
    await publishBoardRevision(db(), p, { boardDate: '2026-10-07', timezone: TZ, expectedRevision: 1, options: [{ position: 1, explanation: 'Replacement', slots: [{ garmentId: w.shirtB, role: 'base_top' }, { garmentId: w.socks, role: 'socks' }, { garmentId: w.sneakers, role: 'footwear' }] }] });
    const stale = await run(p, { type: 'select_option', boardId: board.boardId, optionId: o2!.optionId });
    expect(stale.outcome).toBe('conflict');
    await expect(publishBoardRevision(db(), p, { boardDate: '2026-10-07', timezone: TZ, expectedRevision: 1, options: [{ position: 1, explanation: 'Old composition', slots: [{ garmentId: w.shirtA, role: 'base_top' }] }] })).rejects.toThrow(/revision 2/);
  });
});

describe('scopes', () => {
  it('a read-only connection cannot execute commands', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    const r = await service(readOnlyPrincipal(p.userId)).execute(envelope({ type: 'mark_in_wash', garmentId: w.shirtA }));
    expect(r.error?.code).toBe('insufficient_scope');
    expect(await buckets(p, w.shirtA)).toMatchObject({ clean: 1 });
  });

  it('a stored receipt can be read back with current undo state', async () => {
    const p = await newUser();
    const w = await basicWardrobe(p);
    const r = await ok(p, { type: 'mark_in_wash', garmentId: w.shirtA });
    const stored = await getReceipt(db(), p, r.commandId);
    expect(stored).toMatchObject({ commandId: r.commandId, summary: r.summary, undo: { available: true } });
  });
});
