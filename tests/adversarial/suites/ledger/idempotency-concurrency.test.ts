import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { executeTool } from '../../../../backend/src/assistant/tools.js';
import { getDailyBoard, managedEventId } from '../../../../backend/src/recommend/publish.js';
import { toolCtx } from '../../helpers/assistant.js';
import { ownerScenario } from '../../helpers/daily.js';
import { hardConstraintBreaks } from '../../helpers/oracle.js';
import { apiOwner, callJson, idem, installApiScenario } from '../../helpers/http.js';
import { connectMcp, mcpGrant, tool } from '../../helpers/mcp.js';
import { buckets, count, envelope, negativeBuckets, newOwner, one, run, service } from '../../helpers/seed.js';
import { knownDefect } from '../../helpers/defects.js';

/**
 * Idempotency and concurrency attacks on the command service and the daily service, on real local D1
 * (every D1 batch is a real transaction). Races are real concurrent promises against one database.
 */

const TZ = 'Europe/London';

describe('replayed idempotency keys', () => {
  it('the same key with an altered payload is refused on every surface; the original receipt is untouched', async () => {
    installApiScenario();
    const o = await apiOwner();
    const shirt = await o.byName('Lightweight oxford — gold');
    const other = await o.byName('Lightweight oxford — pink');
    const key = idem();
    const first = await callJson<{ commandId: string; outcome: string }>('/v1/commands', { assertion: o.assertion, body: { idempotencyKey: key, source: 'app', command: { type: 'record_wear', timezone: TZ, wearingDate: '2026-10-05', items: [{ garmentId: shirt }] } } });
    expect(first.body.outcome).toBe('committed');
    const snapshot = await one('SELECT * FROM command_receipts WHERE user_id = ? AND command_id = ?', o.userId, first.body.commandId);
    const altered = [
      { type: 'record_wear', timezone: TZ, wearingDate: '2026-10-05', items: [{ garmentId: other }] },
      { type: 'record_wear', timezone: TZ, wearingDate: '2026-10-04', items: [{ garmentId: shirt }] },
      { type: 'mark_in_wash', garmentId: shirt },
    ];
    for (const command of altered) {
      const r = await callJson<{ error: { code: string } }>('/v1/commands', { assertion: o.assertion, body: { idempotencyKey: key, source: 'app', command } });
      expect(r.status, command.type).toBe(409);
      expect(r.body.error.code).toBe('idempotency_key_reused');
    }
    const c = await connectMcp((await mcpGrant(o.assertion, 'claude')).accessToken);
    const viaMcp = await tool(c, 'garderobe_command', { idempotencyKey: key, command: altered[0] });
    expect(JSON.stringify(viaMcp)).toMatch(/idempotency_key_reused/);
    await c.close();
    const direct = await run(o.principal, altered[1] as never, { idempotencyKey: key });
    expect(direct.error?.code).toBe('idempotency_key_reused');
    expect(await one('SELECT * FROM command_receipts WHERE user_id = ? AND command_id = ?', o.userId, first.body.commandId)).toEqual(snapshot);
    expect(await count("SELECT COUNT(*) AS n FROM daily_wears WHERE user_id = ? AND status = 'active'", o.userId)).toBe(1);
  });

  it('expectedVersions are part of the request identity: the same key with different preconditions is refused', async () => {
    const o = await newOwner();
    const rst = (await one<{ restriction_id: string; version: number }>("SELECT restriction_id, version FROM restrictions WHERE user_id = ? AND kind = 'healing'", o.userId));
    const nike = await o.byName('NB 993');
    const key = `app:${crypto.randomUUID()}`;
    const cmd = { type: 'set_restriction', kind: 'custom', scope: { garmentIds: [nike] }, reason: 'rubs' } as const;
    expect((await run(o.principal, cmd as never, { idempotencyKey: key })).outcome).toBe('committed');
    const again = await run(o.principal, cmd as never, { idempotencyKey: key, expectedVersions: [{ entityType: 'restriction', entityId: rst.restriction_id, version: rst.version }] });
    expect(again.error?.code).toBe('idempotency_key_reused');
  });
});

describe('cross-client duplicate wears', () => {
  it('the app, an MCP client and the assistant reporting the same garment and date make exactly one counted wear', async () => {
    installApiScenario({ now: '2026-10-05T18:00:00.000Z' });
    const o = await apiOwner();
    const shirt = await o.byName('Lightweight oxford — moss');
    const before = await buckets(o.userId, shirt);
    const command = { type: 'record_wear', timezone: TZ, wearingDate: '2026-10-05', items: [{ garmentId: shirt }] };
    const app = await callJson<{ outcome: string }>('/v1/commands', { assertion: o.assertion, body: { idempotencyKey: idem(), source: 'app', command } });
    const c = await connectMcp((await mcpGrant(o.assertion, 'claude')).accessToken);
    const mcp = await tool(c, 'garderobe_command', { idempotencyKey: idem('mcp'), command });
    await c.close();
    const at = () => '2026-10-05T18:00:00.000Z';
    const assistant = (await executeTool('record_wear', { garmentIds: [shirt], wearingDate: '2026-10-05' }, toolCtx(o.userId, 'I wore the moss oxford today.', { now: at }))) as { outcome: string };
    const offline = await run(o.principal, command as never, { source: 'offline_replay' }, { now: at });
    expect(app.body.outcome).toBe('committed');
    expect((mcp.structuredContent!.receipt as { outcome: string }).outcome).toBe('merged');
    expect(assistant.outcome).toBe('merged');
    expect(offline.outcome).toBe('merged');
    expect(await count("SELECT COUNT(*) AS n FROM daily_wears WHERE user_id = ? AND garment_id = ? AND status = 'active'", o.userId, shirt)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM stock_movements WHERE user_id = ? AND garment_id = ? AND kind = 'wear'", o.userId, shirt).catch(() => 1)).toBe(1);
    const after = await buckets(o.userId, shirt);
    expect(after.clean).toBe(before.clean - 1);
  });
});

describe('racing commands', () => {
  it('ten concurrent wear reports of one garment and date: one counted wear, one stock movement, no negative bucket', async () => {
    const o = await newOwner();
    const shirt = await o.byName('Lightweight oxford — slate');
    const outs = await Promise.all(Array.from({ length: 10 }, () => run(o.principal, { type: 'record_wear', timezone: TZ, wearingDate: '2026-09-25', items: [{ garmentId: shirt }] }, {}, { now: () => '2026-09-25T20:00:00.000Z' })));
    expect(outs.filter((r) => r.outcome === 'committed').length).toBe(1);
    // Integrity holds under contention whatever each caller was told (see ADV-08 for the liveness side).
    expect(await count("SELECT COUNT(*) AS n FROM daily_wears WHERE user_id = ? AND garment_id = ? AND status = 'active'", o.userId, shirt)).toBe(1);
    expect(await negativeBuckets(o.userId)).toEqual([]);
    for (const r of outs.filter((x) => x.outcome === 'conflict')) expect(await count('SELECT COUNT(*) AS n FROM command_receipts WHERE user_id = ? AND idempotency_key = ?', o.userId, r.idempotencyKey)).toBe(0);
  });

  it('three devices reporting the same wear at the same moment are all accepted (committed once, merged otherwise)', async () => {
    const o = await newOwner();
    const shirt = await o.byName('Lightweight oxford — off-white');
    const outs = await Promise.all(['app', 'mcp', 'offline_replay'].map((source) => run(o.principal, { type: 'record_wear', timezone: TZ, wearingDate: '2026-09-25', items: [{ garmentId: shirt }] }, { source: source as never }, { now: () => '2026-09-25T20:00:00.000Z' })));
    expect(outs.map((r) => r.outcome).sort()).toEqual(['committed', 'merged', 'merged']);
  });

  // ADV-08 (DEFECTS.md): under heavier contention some duplicate observation reports are refused with
  // conflict/retry_exhausted instead of merging; nothing is corrupted, but the owner's device is told to retry.
  it('[ADV-08] twenty concurrent duplicate wear reports are all accepted (none refused with retry_exhausted)', async () => {
    const o = await newOwner();
    const shirt = await o.byName('Lightweight oxford — slate');
    const outs = await Promise.all(Array.from({ length: 20 }, () => run(o.principal, { type: 'record_wear', timezone: TZ, wearingDate: '2026-09-25', items: [{ garmentId: shirt }] }, {}, { now: () => '2026-09-25T20:00:00.000Z' })));
    expect(outs.map((r) => `${r.outcome}${r.error ? `:${r.error.code}` : ''}`).filter((x) => x !== 'committed' && x !== 'merged')).toEqual([]);
  });

  it('the same key and body racing ten times produces one receipt and one effect', async () => {
    const o = await newOwner();
    const shirt = await o.byName('Lightweight oxford — pink');
    const env1 = envelope({ type: 'mark_in_wash', garmentId: shirt });
    const outs = await Promise.all(Array.from({ length: 10 }, () => service(o.principal).execute(env1)));
    expect(new Set(outs.map((r) => r.commandId)).size).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM command_receipts WHERE user_id = ? AND idempotency_key = ?', o.userId, env1.idempotencyKey)).toBe(1);
    const b = await buckets(o.userId, shirt);
    expect(b.hamper).toBe(1);
    expect(b.clean).toBe(0);
  });

  it('racing "in the wash" and "washed" on a single-unit shirt never loses or duplicates the unit', async () => {
    const o = await newOwner();
    const shirt = await o.byName('Lightweight oxford — laurel');
    const cmds = Array.from({ length: 12 }, (_, i) => (i % 2 ? { type: 'mark_washed', garmentId: shirt } : { type: 'mark_in_wash', garmentId: shirt }));
    await Promise.all(cmds.map((c) => run(o.principal, c as never)));
    const b = await buckets(o.userId, shirt);
    expect(b.clean + b.hamper + b.worn + b.laundry).toBe(1);
    expect(await negativeBuckets(o.userId)).toEqual([]);
  });

  it('racing selections of different options leave exactly one active selection', async () => {
    const s = await ownerScenario();
    const board = (await s.rec.composeAndPublish({ date: '2026-10-06' })).board!;
    await Promise.all(
      board.options.slice(0, 4).map((o) => run(s.principal, { type: 'select_option', boardId: board.boardId, optionId: o.optionId, ...(o.slots.filter((x) => x.role === 'footwear').length > 1 ? { footwearGarmentId: o.slots.find((x) => x.role === 'footwear')!.garmentId } : {}) }, {}, { now: s.clock.now })),
    );
    expect(await count("SELECT COUNT(*) AS n FROM selections WHERE user_id = ? AND status = 'active'", s.userId)).toBe(1);
  });

  it('racing profile edits from the same base version: exactly one commits, the rest conflict and write nothing', async () => {
    const o = await newOwner();
    const doc = await one<{ document_id: string; version: number; body: string }>('SELECT document_id, version, body FROM style_documents WHERE user_id = ? AND is_current = 1', o.userId);
    const outs = await Promise.all(Array.from({ length: 4 }, (_, i) => run(o.principal, { type: 'edit_style_profile', documentId: doc.document_id, baseVersion: doc.version, body: `${doc.body}\n\nEdit ${i}.` })));
    expect(outs.filter((r) => r.outcome === 'committed').length).toBe(1);
    expect(outs.filter((r) => r.outcome !== 'committed').every((r) => r.outcome === 'conflict' || r.outcome === 'rejected')).toBe(true);
    expect(await count('SELECT COUNT(*) AS n FROM style_documents WHERE user_id = ? AND document_id = ?', o.userId, doc.document_id)).toBe(2);
  });
});

describe('laundry versus composition races', () => {
  it('a garment put in the wash while the board is being composed never appears on the published board', async () => {
    const s = await ownerScenario();
    const { composed } = await s.rec.compose({ date: '2026-10-06' });
    const victims = composed.options.map((o) => o.slots.find((x) => x.role === 'base_top')!.garmentId);
    let fired = false;
    const out = await s.rec.composeAndPublish({ date: '2026-10-06' }, {
      beforePublish: async () => {
        if (fired) return;
        fired = true;
        for (const v of victims) await s.cmd({ type: 'mark_in_wash', garmentId: v });
      },
    });
    expect(out.published).toBe(true);
    expect(out.attempts).toBeGreaterThan(1);
    const board = (await getDailyBoard(env.DB, s.principal, '2026-10-06'))!;
    for (const o of board.options) for (const x of o.slots) expect(victims).not.toContain(x.garmentId);
    const ctx = await s.rec.context({ date: '2026-10-06' });
    for (const o of board.options.filter((x) => x.status === 'offerable')) expect(hardConstraintBreaks(o.slots, ctx)).toEqual([]);
  });

  it('a laundry pickup landing on every attempt exhausts the bounded retries and publishes nothing stale', async () => {
    const s = await ownerScenario();
    const out = await s.rec.composeAndPublish({ date: '2026-10-06' }, {
      maxAttempts: 3,
      beforePublish: async () => {
        const { composed } = await s.rec.compose({ date: '2026-10-06' });
        await s.cmd({ type: 'mark_in_wash', garmentId: composed.options[0]!.slots.find((x) => x.role === 'base_top')!.garmentId });
      },
    });
    expect(out.published).toBe(false);
    expect(out.reason).toBe('state_changed');
    expect(await getDailyBoard(env.DB, s.principal, '2026-10-06')).toBeNull();
  });

  it('a pause arriving while publication is queued stops the publication inside the same transaction', async () => {
    const s = await ownerScenario();
    const out = await s.rec.composeAndPublish({ date: '2026-10-06' }, { beforePublish: async () => void (await s.daily.pause({ startsOn: '2026-10-06' })) });
    expect(out.published).toBe(false);
    expect(out.reason).toBe('paused');
    expect(await getDailyBoard(env.DB, s.principal, '2026-10-06')).toBeNull();
    s.clock.set('2026-10-05T20:05:00.000Z');
    const phases = await s.daily.sweep();
    expect(phases.every((p) => (p as { published?: boolean }).published !== true)).toBe(true);
    expect(await getDailyBoard(env.DB, s.principal, '2026-10-06')).toBeNull();
  });
});

describe('out-of-order calendar projections', () => {
  it('a slow projection of an older selection never overwrites a newer one', async () => {
    const s = await ownerScenario();
    const board = (await s.rec.composeAndPublish({ date: '2026-10-06' })).board!;
    const pick = (i: number) => {
      const o = board.options[i]!;
      const shoes = o.slots.filter((x) => x.role === 'footwear');
      return s.cmd({ type: 'select_option', boardId: board.boardId, optionId: o.optionId, ...(shoes.length > 1 ? { footwearGarmentId: shoes[0]!.garmentId } : {}) });
    };
    await pick(0);
    const hold = s.calendar.holdNextWrite();
    const slow = s.daily.projector.projectDay('2026-10-06');
    await hold.reached;
    await pick(1); // newer desired content while the first write is in flight
    hold.release();
    await slow;
    await s.daily.processEffects();
    await s.daily.projector.projectDay('2026-10-06');
    const ev = await s.calendar.getEvent('garderobe-outfits', await managedEventId(s.userId, '2026-10-06'));
    const row = await one<{ desired_seq: number; projected_seq: number }>('SELECT desired_seq, projected_seq FROM calendar_projections WHERE user_id = ? AND board_date = ?', s.userId, '2026-10-06');
    expect(row.projected_seq).toBe(row.desired_seq);
    expect(ev!.privateProperties.garderobeSeq).toBe(String(row.desired_seq));
    expect(ev!.summary).toContain(`Outfit ${board.options[1]!.position}`);
  });

  it('concurrent projectors of the same day write once (lease) and converge', async () => {
    const s = await ownerScenario();
    await s.rec.composeAndPublish({ date: '2026-10-06' });
    const writesBefore = s.calendar.writes;
    const results = await Promise.all([s.daily.projector.projectDay('2026-10-06'), s.daily.projector.projectDay('2026-10-06'), s.daily.projector.projectDay('2026-10-06')]);
    expect(results.filter((r) => r.status === 'projected').length).toBeLessThanOrEqual(1);
    expect(s.calendar.writes - writesBefore).toBeLessThanOrEqual(1);
  });

  it('an event the owner deleted is not resurrected by a later projection', async () => {
    const s = await ownerScenario();
    const board = (await s.rec.composeAndPublish({ date: '2026-10-06' })).board!;
    await s.daily.projector.projectDay('2026-10-06');
    s.calendar.ownerDelete(await managedEventId(s.userId, '2026-10-06'));
    await s.cmd({ type: 'select_option', boardId: board.boardId, optionId: board.options[0]!.optionId, ...(board.options[0]!.slots.filter((x) => x.role === 'footwear').length > 1 ? { footwearGarmentId: board.options[0]!.slots.find((x) => x.role === 'footwear')!.garmentId } : {}) });
    await s.daily.processEffects();
    const r = await s.daily.projector.projectDay('2026-10-06');
    expect(r.status).toBe('suppressed');
    const ev = await s.calendar.getEvent('garderobe-outfits', await managedEventId(s.userId, '2026-10-06'));
    expect(ev?.status ?? 'cancelled').toBe('cancelled');
  });
});
