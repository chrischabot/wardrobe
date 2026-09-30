import { describe, expect, it } from 'vitest';
import { syntheticOwnerB } from '@garderobe/demo';
import { db, envelope, key, newOwner, ok, run, service } from './helpers/fixtures.js';
import { CommandService, createUser, estimateAvailability, getItemDetail, getReceipt, listWardrobe, ownerPrincipal, resolveAlias, getStyleContext } from '../src/domain/index.js';
import { importDataset } from '../src/import/index.js';

async function ownerB() {
  const { userId } = await createUser(db(), { displayName: 'Synthetic Test Owner B', identity: { issuer: 'https://test.invalid', subject: key('b') }, now: '2026-09-01T00:00:00.000Z' });
  const principal = ownerPrincipal(userId, 'test');
  const result = await importDataset(db(), principal, syntheticOwnerB, { sourceSystem: 'synthetic-test-owner-b' });
  return { principal, result };
}

describe('two-user isolation', () => {
  it('every read is scoped to the authenticated user', async () => {
    const a = await newOwner();
    const b = await ownerB();
    const pageA = await listWardrobe(db(), a.principal);
    const pageB = await listWardrobe(db(), b.principal);
    expect(pageA.total).toBe(127);
    expect(pageB.total).toBe(10);
    expect(pageB.items.every((i) => i.garment.name.startsWith('SYNTHETIC'))).toBe(true);
    const aShirt = await a.byName('Lightweight oxford — blue');
    await expect(getItemDetail(db(), b.principal, aShirt)).rejects.toMatchObject({ code: 'not_found' });
    expect(await resolveAlias(db(), b.principal, 'PCF4339')).toMatchObject({ status: 'not_found' });
    // Both owners have a "wide stripe" phrase; each resolves only within their own wardrobe.
    expect(await resolveAlias(db(), b.principal, 'the wide stripe')).toMatchObject({ status: 'resolved', name: 'SYNTHETIC wide stripe shirt' });
    const estimates = await estimateAvailability(db(), b.principal, { targetDate: '2026-10-07' });
    expect(estimates).toHaveLength(10);
    const ctxB = await getStyleContext(db(), b.principal, '2026-10-07');
    expect(ctxB.documents).toHaveLength(1);
    expect(ctxB.documents[0]!.isDemo).toBe(true);
    expect(ctxB.documents[0]!.title).toContain('SYNTHETIC');
    expect(ctxB.rules.map((r) => r.ruleKey)).toEqual(['synthetic.socks_always']);
    expect(ctxB.restrictions).toHaveLength(0);
  });

  it("commands cannot touch another user's garments, receipts or batches", async () => {
    const a = await newOwner();
    const b = await ownerB();
    const aShirt = await a.byName('Lightweight oxford — blue');
    const wear = await run(b.principal, { type: 'record_wear', timezone: 'Europe/Amsterdam', items: [{ garmentId: aShirt }] });
    expect(wear.error?.code).toBe('not_found');
    const aReceipt = await ok(a.principal, { type: 'mark_in_wash', garmentId: aShirt });
    expect(await getReceipt(db(), b.principal, aReceipt.commandId)).toBeNull();
    expect((await run(b.principal, { type: 'undo', targetCommandId: aReceipt.commandId })).error?.code).toBe('not_found');
    expect((await run(b.principal, { type: 'laundry_returned' })).error?.code).toBe('invalid_state');
    const lot = await db().prepare('SELECT hamper_qty FROM stock_lots WHERE user_id = ? AND garment_id = ?').bind(a.userId, aShirt).first<{ hamper_qty: number }>();
    expect(lot!.hamper_qty).toBe(1);
  });

  it('rejects forged owner fields anywhere in the body', async () => {
    const a = await newOwner();
    const b = await ownerB();
    const bGarment = b.result.garmentIds['b-4']!;
    const forgedTop = await service(a.principal).execute({ ...envelope({ type: 'mark_in_wash', garmentId: bGarment }), userId: b.principal.userId });
    expect(forgedTop.error?.code).toBe('forbidden_owner_field');
    const forgedNested = await service(a.principal).execute(envelope({ type: 'mark_in_wash', garmentId: bGarment, owner_id: b.principal.userId } as never));
    expect(forgedNested.error?.code).toBe('forbidden_owner_field');
    expect(forgedNested.error?.details?.fields).toEqual(['$.command.owner_id']);
    const ownGarmentForged = await service(b.principal).execute({ ...envelope({ type: 'mark_in_wash', garmentId: bGarment }), ownerId: b.principal.userId });
    expect(ownGarmentForged.error?.code).toBe('forbidden_owner_field');
    const lot = await db().prepare('SELECT hamper_qty FROM stock_lots WHERE user_id = ? AND garment_id = ?').bind(b.principal.userId, bGarment).first<{ hamper_qty: number }>();
    expect(lot!.hamper_qty).toBe(0);
  });

  it('idempotency keys are scoped per user', async () => {
    const a = await newOwner();
    const b = await ownerB();
    const k = key('shared');
    const ra = await service(a.principal).execute({ idempotencyKey: k, source: 'app', command: { type: 'mark_in_wash', garmentId: await a.byName('Pima oxford — white') } });
    const rb = await service(b.principal).execute({ idempotencyKey: k, source: 'app', command: { type: 'mark_in_wash', garmentId: b.result.garmentIds['b-5']! } });
    expect(ra.outcome).toBe('committed');
    expect(rb.outcome).toBe('committed');
    expect(rb.replayed).toBe(false);
  });

  it('compound foreign keys prevent cross-user references at the database level', async () => {
    const a = await newOwner();
    const b = await ownerB();
    const aShirt = await a.byName('Lightweight oxford — blue');
    await expect(
      db().batch([
        db().prepare("INSERT INTO wear_observations (user_id, observation_id, wearing_date, timezone, occurred_at, reported_at, source, command_id) VALUES (?, 'obs_x', '2026-10-01', 'UTC', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', 'app', 'cmd_x')").bind(b.principal.userId),
        db().prepare("INSERT INTO observation_items (user_id, observation_id, garment_id) VALUES (?, 'obs_x', ?)").bind(b.principal.userId, aShirt),
      ]),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it('refuses to operate without an authenticated internal user id', () => {
    expect(() => new CommandService(db(), { userId: 'alice@example.com', scopes: ['*'], authenticatedBy: 'test' })).toThrow(/authenticated principal/);
    expect(() => new CommandService(db(), null as never)).toThrow(/authenticated principal/);
  });
});
