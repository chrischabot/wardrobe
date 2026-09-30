import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { getDailyBoard } from '../../src/recommend/publish.js';
import { managedEventId } from '../../src/recommend/publish.js';
import { validateOutfit } from '../../src/recommend/validate.js';
import { ownerScenario } from '../helpers/daily.js';

const resetCount = async (userId: string) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM laundry_resets WHERE user_id = ?').bind(userId).first<{ n: number }>())!.n;

describe('evening-to-morning schedule', () => {
  it('[D1] a board composed during an evening weather outage picks up the forecast when the provider answers in the morning', async () => {
    const s = await ownerScenario({ now: '2026-10-05T20:05:00.000Z', weather: { scenario: 'heavyRain', fail: true } }); // 21:05 London, provider down
    await s.daily.sweep();
    const evening = (await getDailyBoard(env.DB, s.principal, '2026-10-06'))!;
    expect(evening.document!.weather.status).toBe('unavailable');
    expect(evening.document!.weather.peakTempC).toBeNull();
    // The provider answers again; the 06:40 refresh must replace the seasonal fallback with the forecast.
    s.weather.set({ fail: false });
    s.clock.set('2026-10-06T05:41:00.000Z');
    const morning = await s.daily.sweep();
    expect(morning[0]).toMatchObject({ phase: 'morning_refresh', status: 'complete' });
    const board = (await getDailyBoard(env.DB, s.principal, '2026-10-06'))!;
    expect(board.currentRevision).toBeGreaterThan(evening.currentRevision);
    const w = board.document!.weather;
    expect(w.status).toBe('fresh');
    expect(typeof w.peakTempC).toBe('number');
    expect(typeof w.departureTempC).toBe('number');
    expect(w.conditions).toContain('rain');
    expect(board.document!.dayLine).not.toMatch(/dressed for the season, not a forecast/);
    // Outfits are held to the real forecast, and the Calendar event carries it.
    const ctx = await s.rec.context({ date: '2026-10-06' });
    for (const o of board.options.filter((x) => x.status === 'offerable')) expect(validateOutfit({ slots: o.slots }, ctx).valid).toBe(true);
    const ev = s.calendar.managed.get(await managedEventId(s.userId, '2026-10-06'))!;
    expect(ev.privateProperties.garderobeRevision).toBe(String(board.currentRevision));
    expect(ev.description).toContain(board.document!.dayLine);
    // The 06:50 final phase keeps it.
    s.clock.set('2026-10-06T05:49:00.000Z');
    expect(await s.daily.runPhase('final', '2026-10-06')).toMatchObject({ status: 'complete', deadlineMet: true });
    expect((await getDailyBoard(env.DB, s.principal, '2026-10-06'))!.document!.weather.status).toBe('fresh');
  });

  it('[D1] with an option already selected overnight, recovery keeps the selection and still publishes the forecast', async () => {
    const s = await ownerScenario({ now: '2026-10-05T20:05:00.000Z', weather: { scenario: 'heavyRain', fail: true } });
    await s.daily.sweep();
    const evening = (await getDailyBoard(env.DB, s.principal, '2026-10-06'))!;
    const chosen = evening.options.find((o) => o.status === 'offerable')!;
    await s.cmd({ type: 'select_option', boardId: evening.boardId, optionId: chosen.optionId });
    s.weather.set({ fail: false });
    s.clock.set('2026-10-06T05:41:00.000Z');
    await s.daily.sweep();
    const board = (await getDailyBoard(env.DB, s.principal, '2026-10-06'))!;
    expect(board.document!.weather.status).toBe('fresh');
    expect(board.document!.weather.conditions).toContain('rain');
    const sel = await env.DB.prepare("SELECT o.garment_id FROM selections s JOIN option_garments o ON o.user_id = s.user_id AND o.option_id = s.option_id WHERE s.user_id = ? AND s.board_id = ? AND s.status = 'active'").bind(s.userId, board.boardId).all<{ garment_id: string }>();
    expect(sel.results.length, 'the selection is carried to the new revision').toBeGreaterThan(0);
  });

  it('[D1] on a day already being worn, recovery publishes the forecast without changing the worn outfit or its wear records', async () => {
    const s = await ownerScenario({ now: '2026-10-05T20:05:00.000Z', weather: { scenario: 'heavyRain', fail: true } });
    await s.daily.sweep();
    const evening = (await getDailyBoard(env.DB, s.principal, '2026-10-06'))!;
    expect(evening.document!.weather.status).toBe('unavailable');
    const chosen = evening.options.find((o) => o.status === 'offerable')!;
    await s.cmd({ type: 'select_option', boardId: evening.boardId, optionId: chosen.optionId });
    // The owner dresses early and records the wear before the morning refresh.
    s.clock.set('2026-10-06T05:20:00.000Z');
    await s.cmd({ type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-06', items: chosen.slots.filter((x) => x.role !== 'accessory' && x.role !== 'footwear').map((x) => ({ garmentId: x.garmentId, role: x.role })) });
    const wearsBefore = (await env.DB.prepare("SELECT * FROM daily_wears WHERE user_id = ? AND wearing_date = '2026-10-06' ORDER BY garment_id").bind(s.userId).all()).results;
    expect(wearsBefore.length).toBeGreaterThan(0);
    s.weather.set({ fail: false });
    s.clock.set('2026-10-06T05:41:00.000Z');
    await s.daily.sweep();
    const board = (await getDailyBoard(env.DB, s.principal, '2026-10-06'))!;
    expect(board.currentRevision).toBeGreaterThan(evening.currentRevision);
    expect(board.document!.weather.status).toBe('fresh');
    expect(board.document!.weather.conditions).toContain('rain');
    expect(board.document!.dayLine).not.toMatch(/dressed for the season, not a forecast/);
    // Nothing about what is being worn changes: same options, same pieces, the selection carried, the wears untouched.
    const sig = (b: typeof board) => b.options.map((o) => `${o.status}:${o.slots.map((x) => `${x.role}=${x.garmentId}`).sort().join(',')}`);
    expect(sig(board)).toEqual(sig(evening));
    const sel = await env.DB.prepare("SELECT o.position FROM selections s JOIN board_options o ON o.user_id = s.user_id AND o.option_id = s.option_id WHERE s.user_id = ? AND s.board_id = ? AND s.status = 'active'").bind(s.userId, board.boardId).first<{ position: number }>();
    expect(sel?.position).toBe(chosen.position);
    const wearsAfter = (await env.DB.prepare("SELECT * FROM daily_wears WHERE user_id = ? AND wearing_date = '2026-10-06' ORDER BY garment_id").bind(s.userId).all()).results;
    expect(wearsAfter).toEqual(wearsBefore);
    // The 06:50 final phase keeps the forecast.
    s.clock.set('2026-10-06T05:49:00.000Z');
    expect(await s.daily.runPhase('final', '2026-10-06')).toMatchObject({ status: 'complete' });
    expect((await getDailyBoard(env.DB, s.principal, '2026-10-06'))!.document!.weather.status).toBe('fresh');
  });

  it('composes the evening before, projects the Calendar event, and deduplicates repeated triggers', async () => {
    const s = await ownerScenario({ now: '2026-10-05T20:05:00.000Z' }); // 21:05 in London
    const first = await s.daily.sweep();
    expect(first.map((r) => [r.phase, r.boardDate, r.status])).toEqual([['evening', '2026-10-06', 'complete']]);
    expect(first[0]!.publish).toMatchObject({ published: true, reason: 'published' });
    expect(first[0]!.projection!.status).toBe('projected');
    const resets = await resetCount(s.userId);
    expect(resets).toBeGreaterThan(0);
    s.clock.advanceMinutes(5);
    expect(await s.daily.sweep()).toEqual([]);
    expect(await s.daily.runPhase('evening', '2026-10-06')).toMatchObject({ status: 'duplicate' });
    expect((await getDailyBoard(env.DB, s.principal, '2026-10-06'))!.currentRevision).toBe(1);
    expect(await resetCount(s.userId)).toBe(resets);
    expect(s.calendar.inserts).toBe(1);
  });

  it('applies each weekly laundry reset once per owner, pool and cycle, catching up after missed runs', async () => {
    const s = await ownerScenario({ now: '2026-10-05T20:05:00.000Z' });
    await s.daily.sweep();
    const before = await resetCount(s.userId);
    for (let i = 0; i < 3; i++) {
      s.clock.advanceMinutes(1);
      await s.daily.runPhase('evening', '2026-10-07');
    }
    expect(await resetCount(s.userId)).toBe(before);
    // The next Sunday baseline adds exactly one cycle per pool, however many runs follow.
    s.clock.set('2026-10-11T20:05:00.000Z');
    await s.daily.sweep();
    await s.daily.sweep();
    expect(await resetCount(s.userId)).toBe(before + 2);
    const { results } = await env.DB.prepare('SELECT pool, cycle_key FROM laundry_resets WHERE user_id = ? ORDER BY cycle_key').bind(s.userId).all<{ pool: string; cycle_key: string }>();
    expect(new Set(results.map((r) => `${r.pool}:${r.cycle_key}`)).size).toBe(results.length);
  });

  it('the 06:40 refresh repairs options the new forecast invalidates; the 06:50 final run meets the deadline', async () => {
    const s = await ownerScenario({ now: '2026-10-05T20:05:00.000Z' });
    await s.daily.sweep();
    s.weather.set({ scenario: 'heat' });
    s.clock.set('2026-10-06T05:41:00.000Z'); // 06:41 local
    const morning = await s.daily.sweep();
    expect(morning[0]).toMatchObject({ phase: 'morning_refresh', status: 'complete' });
    expect(morning[0]!.repair!.changed).toBe(true);
    const board = (await getDailyBoard(env.DB, s.principal, '2026-10-06'))!;
    expect(board.currentRevision).toBeGreaterThan(1);
    const ctx = await s.rec.context({ date: '2026-10-06' });
    expect(ctx.thermal.peakTempC).toBe(31);
    for (const o of board.options.filter((x) => x.status === 'offerable')) expect(validateOutfit({ slots: o.slots }, ctx).valid).toBe(true);
    expect(board.document!.weather.peakTempC).toBe(31);
    s.clock.set('2026-10-06T05:51:00.000Z'); // 06:51 is after 06:50: run it at 06:49 instead
    s.clock.set('2026-10-06T05:49:00.000Z');
    const early = await s.daily.runPhase('final', '2026-10-06');
    expect(early).toMatchObject({ status: 'complete', deadlineMet: true });
    expect(early.projection!.status === 'projected' || early.projection!.status === 'up_to_date').toBe(true);
    const ev = s.calendar.managed.get(await managedEventId(s.userId, '2026-10-06'))!;
    expect(ev.privateProperties.garderobeRevision).toBe(String(board.currentRevision));
  });

  it('catches up a missed evening in the morning and records a missed deadline without publishing a backlog', async () => {
    const s = await ownerScenario({ now: '2026-10-06T05:45:00.000Z' }); // no evening run happened
    const morning = await s.daily.sweep();
    expect(morning[0]).toMatchObject({ phase: 'morning_refresh', boardDate: '2026-10-06' });
    expect(morning[0]!.publish!.published).toBe(true);
    const late = await ownerScenario({ now: '2026-10-06T06:30:00.000Z' }); // 07:30 local, after the deadline
    const final = await late.daily.sweep();
    expect(final[0]).toMatchObject({ phase: 'final', deadlineMet: false });
    expect(final[0]!.publish!.published).toBe(true);
    expect(await late.daily.runPhase('evening', '2026-10-01')).toMatchObject({ status: 'too_late' });
    expect(await getDailyBoard(env.DB, late.principal, '2026-10-01')).toBeNull();
  });
});

describe('pause and resume', () => {
  it('stops composition, publication and reminders; resume prepares only the next useful board with no backlog', async () => {
    const s = await ownerScenario({ now: '2026-10-05T12:00:00.000Z' });
    // A board already projected for tomorrow has its managed event removed by the pause.
    await s.rec.composeAndPublish({ date: '2026-10-06' });
    await s.daily.projector.projectDay('2026-10-06');
    const pause = await s.daily.pause({ resumeOn: '2026-10-10' });
    expect(pause.suppressedDates).toEqual(['2026-10-06']);
    expect(s.calendar.managed.get(await managedEventId(s.userId, '2026-10-06'))!.status).toBe('cancelled');
    s.clock.set('2026-10-05T20:05:00.000Z');
    const evening = await s.daily.sweep();
    expect(evening.map((r) => r.status)).toEqual(['paused']);
    expect((await s.rec.composeAndPublish({ date: '2026-10-07' })).reason).toBe('paused');
    expect(await getDailyBoard(env.DB, s.principal, '2026-10-07')).toBeNull();
    // Observations keep working while paused.
    const shirt = await s.byName('Selvedge twill — camel');
    s.clock.set('2026-10-06T09:00:00.000Z');
    const wear = await s.cmd({ type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-06', items: [{ garmentId: shirt, role: 'base_top' }] });
    expect(wear.outcome).toBe('committed');
    s.clock.set('2026-10-06T20:05:00.000Z');
    expect((await s.daily.sweep()).map((r) => r.status)).toEqual(['paused']);

    s.clock.set('2026-10-07T12:00:00.000Z'); // 13:00: today's delivery has passed
    const resumed = await s.daily.resume();
    expect(resumed.ended).toBe(1);
    expect(resumed.boardDate).toBe('2026-10-08');
    expect(resumed.outcome.published).toBe(true);
    expect(resumed.projection!.status).toBe('projected');
    const { results } = await env.DB.prepare('SELECT board_date FROM boards WHERE user_id = ? ORDER BY board_date').bind(s.userId).all<{ board_date: string }>();
    expect(results.map((r) => r.board_date)).toEqual(['2026-10-06', '2026-10-08']);
    const b6 = (await getDailyBoard(env.DB, s.principal, '2026-10-06'))!;
    expect(b6.currentRevision).toBe(1);
    expect((await s.daily.projector.row('2026-10-06'))!.status).toBe('suppressed');
    // The wear recorded during the pause is intact and respected (a repeat for the next board).
    expect(resumed.outcome.board!.options.flatMap((o) => o.slots.map((x) => x.garmentId))).not.toContain(shirt);
  });
});

describe('repair after reality changes', () => {
  it('wearing a planned garment repairs the selected future option and its Calendar event, preserving the actual wear', async () => {
    const s = await ownerScenario({ now: '2026-10-05T20:05:00.000Z' });
    await s.daily.sweep(); // board for 10-06
    const future = await s.rec.composeAndPublish({ date: '2026-10-07' });
    const chosen = future.board!.options[1]!;
    await s.cmd({ type: 'select_option', boardId: future.board!.boardId, optionId: chosen.optionId });
    const processed = await s.daily.processEffects(); // selection re-projects the 10-07 event
    expect(processed.projections.map((p) => p.status)).toEqual(['projected']);
    const eventId = await managedEventId(s.userId, '2026-10-07');
    expect(s.calendar.managed.get(eventId)!.summary).toBe('Outfit 2 of 5 chosen');
    const inserts = s.calendar.inserts;

    // On 10-06 the owner puts on the shirt planned for 10-07 (not today's board).
    const plannedShirt = chosen.slots.find((x) => x.role === 'base_top')!.garmentId;
    const today = (await getDailyBoard(env.DB, s.principal, '2026-10-06'))!;
    // Trousers worn today are not part of the chosen outfit, so only its shirt is affected.
    const chosenIds = new Set(chosen.slots.map((x) => x.garmentId));
    const todaysTrousers = today.options.map((o) => o.slots.find((x) => x.role === 'bottom')!.garmentId).find((id) => !chosenIds.has(id))!;
    s.clock.set('2026-10-06T07:30:00.000Z');
    await s.cmd({ type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-06', items: [{ garmentId: plannedShirt, role: 'base_top' }, { garmentId: todaysTrousers, role: 'bottom' }] });
    const result = await s.daily.processEffects();
    const repaired = result.repaired.find((r) => r.board?.boardDate === '2026-10-07')!;
    expect(repaired.status).toBe('revised');
    expect(result.repaired.find((r) => r.status === 'skipped_day_in_wear')).toBeDefined();

    const after = (await getDailyBoard(env.DB, s.principal, '2026-10-07'))!;
    const sel = await env.DB.prepare("SELECT option_id, board_revision FROM selections WHERE user_id = ? AND board_id = ? AND status = 'active'").bind(s.userId, after.boardId).first<{ option_id: string; board_revision: number }>();
    const kept = after.options.find((o) => o.optionId === sel!.option_id)!;
    expect(sel!.board_revision).toBe(after.currentRevision);
    const without = (o: typeof kept) => o.slots.filter((x) => x.role !== 'base_top').map((x) => `${x.role}:${x.garmentId}`).sort();
    expect(without(kept)).toEqual(without(chosen));
    const newShirt = kept.slots.find((x) => x.role === 'base_top')!.garmentId;
    expect(newShirt).not.toBe(plannedShirt);
    const ctx = await s.rec.context({ date: '2026-10-07' });
    expect(ctx.byId.get(newShirt)!.families).not.toContain('navy');
    for (const o of after.options) expect(o.slots.map((x) => x.garmentId)).not.toContain(plannedShirt);
    expect(after.document!.options.find((o) => o.optionId === kept.optionId)!.lineage).toEqual({ previousOptionId: chosen.optionId, changedRoles: ['base_top'] });
    expect(repaired.summary).toMatch(/replaces/);

    // The same managed event now shows the repaired revision; no duplicate event.
    const ev = s.calendar.managed.get(eventId)!;
    expect(ev.privateProperties.garderobeRevision).toBe(String(after.currentRevision));
    expect(ev.summary).toBe(`Outfit ${kept.position} of 5 chosen`);
    expect(s.calendar.inserts).toBe(inserts);

    // The actual wear is preserved, and today's board (being worn) is not rewritten.
    const wear = await env.DB.prepare("SELECT status FROM daily_wears WHERE user_id = ? AND garment_id = ? AND wearing_date = '2026-10-06'").bind(s.userId, plannedShirt).first<{ status: string }>();
    expect(wear!.status).toBe('active');
    expect((await getDailyBoard(env.DB, s.principal, '2026-10-06'))!.currentRevision).toBe(today.currentRevision);
    // A changed-item receipt is kept; processing again is a no-op.
    const receipts = await s.rec.listRevisionReceipts(after.boardId);
    expect(receipts.at(-1)!.result.summary).toMatch(/replaces/);
    expect((await s.daily.processEffects()).processed).toBe(0);
  });

  it('a laundry delay or new restriction revalidates open boards; invalid unselected options come from reserves', async () => {
    const s = await ownerScenario({ now: '2026-10-05T20:05:00.000Z' });
    const out = await s.rec.composeAndPublish({ date: '2026-10-07' });
    const victim = out.board!.options[0]!;
    const top = victim.slots.find((x) => x.role === 'base_top')!.garmentId;
    await s.cmd({ type: 'set_restriction', kind: 'repair', scope: { garmentIds: [top] }, reason: 'Collar needs mending' });
    const r = await s.daily.processEffects();
    const rev = r.repaired.find((x) => x.board?.boardDate === '2026-10-07')!;
    expect(rev.status).toBe('revised');
    expect(rev.changes.find((c) => c.previousOptionId === victim.optionId)!.kind).toMatch(/replaced_from_reserve|slot_repaired|replaced_by_composition/);
    const board = (await getDailyBoard(env.DB, s.principal, '2026-10-07'))!;
    expect(board.options.filter((o) => o.status === 'offerable')).toHaveLength(5);
    for (const o of board.options) expect(o.slots.map((x) => x.garmentId)).not.toContain(top);
  });
});

describe('runtime wiring', () => {
  it('createDailyService runs the scheduled sweep for a system principal with injected providers', async () => {
    const s = await ownerScenario({ now: '2026-10-05T20:05:00.000Z' });
    const { createDailyService } = await import('../../src/daily/runtime.js');
    const daily = createDailyService(env, s.userId, { weather: s.weather, calendar: s.calendar, calendarStore: s.calendar, clock: s.clock.now });
    const results = await daily.sweep();
    expect(results.map((r) => [r.phase, r.status, r.publish?.published])).toEqual([['evening', 'complete', true]]);
    // Without a Calendar connection the board still publishes; projection reports not connected.
    const t = await ownerScenario({ now: '2026-10-05T20:05:00.000Z' });
    const bare = createDailyService(env, t.userId, { weather: t.weather, clock: t.clock.now });
    const r = await bare.sweep();
    expect(r[0]!.publish!.published).toBe(true);
    expect(r[0]!.projection!.status).toBe('not_connected');
  });
});
