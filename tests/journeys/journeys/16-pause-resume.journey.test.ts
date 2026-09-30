import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { DailyService } from '../../../backend/src/daily/service.js';
import { getDailyBoard, managedEventId } from '../../../backend/src/recommend/publish.js';
import type { FakeCalendar } from '../../../backend/src/calendar/fake.js';
import { seedOwner, type Owner } from '../harness/owner.js';
import { App } from '../harness/http.js';
import { installWorld, type World } from '../harness/world.js';
import { connectAssistant, connectMcp } from '../harness/mcp.js';
import { expectDoneReceipt, expectGlanceableBoard, INTERROGATION } from '../harness/ux.js';
import { offered } from '../harness/profile.js';

/**
 * Journey 16 — Pause and resume (spec section 9 "Pause and resume"; section 17 row "Pause": queued
 * publication and reminders stop; resume has no missed-prompt backlog and preserves observations).
 * The owner pauses recommendations from Tuesday to Saturday: the managed outfit events inside the
 * interval are removed, every scheduled phase publishes nothing, but logging a wear, reading the
 * wardrobe and a connected assistant keep working and a running return deadline stays active. Resuming
 * on Thursday afternoon prepares only Friday's board — no backlog, no questions about missed days —
 * and respects the wears logged while paused. An indefinite pause stays paused until resumed.
 *
 * Stand-ins: FakeWeatherProvider replaces Open-Meteo; FakeCalendar (backend/src/calendar/fake.ts)
 * replaces Google Calendar for both the day's events and the managed outfit event.
 */

describe('Journey: pausing recommendations for a few days, then resuming', () => {
  let world: World;
  let owner: Owner;
  let app: App;
  let daily: DailyService;
  let calendar: FakeCalendar;
  let writesAfterPause: number;
  let wornWhilePaused: string[] = [];

  const event = async (date: string) => calendar.managed.get(await managedEventId(owner.userId, date)) ?? null;
  const board = (date: string) => getDailyBoard(env.DB, owner.principal, date, 'day');
  const boardDates = async () => (await env.DB.prepare("SELECT board_date FROM boards WHERE user_id = ? AND purpose = 'day' ORDER BY board_date").bind(owner.userId).all<{ board_date: string }>()).results.map((r) => r.board_date);
  const at = async (iso: string) => {
    world.clock.set(iso);
    return daily.sweep();
  };

  beforeAll(async () => {
    world = installWorld({ now: '2026-10-05T12:00:00.000Z', weather: { scenario: 'mild' }, calendar: true });
    calendar = world.calendar!;
    owner = await seedOwner();
    app = new App(owner.assertion);
    daily = new DailyService({ db: env.DB, principal: owner.principal, weather: world.weather, calendar, calendarStore: calendar, calendarId: 'garderobe-outfits', clock: world.clock.now });
  });

  it('before the break, the evening service prepares the next days and puts them in the outfit calendar, and a return deadline is running', async () => {
    // A shirt bought online, delivered on 24 September, with a sourced 14-day return window ending during the break.
    const shirt = (await app.commit({ type: 'add_item', explicit: true, name: 'Oxford button-down — white', category: 'shirt', roles: ['base_top'], maker: "Drake's", acquisition: 'incoming' })).facts.garmentId as string;
    const order = await app.commit({ type: 'import_order', merchant: "Drake's", merchantOrderNumber: 'DR-50001', orderedAt: '2026-09-20T10:00:00.000Z', currency: 'GBP', sourceRef: 'gmail:gm_dr50001', lines: [{ externalLineId: 'OCBD-WHT|16', description: 'Oxford button-down — white', quantity: 1, unitPriceMinor: 16500, garmentId: shirt }] });
    expectDoneReceipt(await app.commit({ type: 'mark_arrived', garmentId: shirt, occurredAt: '2026-09-24T11:00:00.000Z' }));
    const terms = await app.commit({ type: 'record_return_terms', lineId: (order.facts.createdLineIds as string[])[0]!, kind: 'request', terms: { sourceRef: 'https://www.drakes.com/pages/returns', quote: 'You can return unworn items within 14 days of delivery.', checkedAt: '2026-10-05T12:00:00.000Z', windowDays: 14 }, trigger: { event: 'delivery', date: '2026-09-24', evidence: 'mark_arrived receipt' }, timezone: 'Europe/London' });
    expect(terms.facts.deadlineDate).toBe('2026-10-08');

    // SURFACE GAP: no HTTP/MCP route for the scheduled phases; driven through DailyService
    const evening = await at('2026-10-05T20:05:00.000Z'); // Monday 21:05 London
    expect(evening.map((r) => [r.phase, r.boardDate, r.status])).toEqual([['evening', '2026-10-06', 'complete']]);
    expect(evening[0]!.projection!.status).toBe('projected');
    const ahead = await daily.runPhase('evening', '2026-10-07');
    expect(ahead).toMatchObject({ status: 'complete' });
    expect(ahead.projection!.status).toBe('projected');
    expect((await event('2026-10-06'))!.status).toBe('confirmed');
    expect((await event('2026-10-07'))!.status).toBe('confirmed');
    expectGlanceableBoard(await app.today('2026-10-06'));
  });

  it('pausing until Saturday needs no reason and removes the outfit events inside the interval so their reminders stop', async () => {
    // SURFACE GAP: no HTTP/MCP route for pause/resume; driven through DailyService.pause
    world.clock.set('2026-10-05T20:30:00.000Z');
    const p = await daily.pause({ startsOn: '2026-10-06', resumeOn: '2026-10-10' });
    expect(p).toMatchObject({ startsOn: '2026-10-06', resumeOn: '2026-10-10' });
    expect([...p.suppressedDates].sort()).toEqual(['2026-10-06', '2026-10-07']);
    expect((await event('2026-10-06'))!.status).toBe('cancelled');
    expect((await event('2026-10-07'))!.status).toBe('cancelled');
    const visible = await calendar.listEvents({ timeMin: '2026-10-06T00:00:00.000Z', timeMax: '2026-10-10T00:00:00.000Z', timezone: 'Europe/London' });
    expect(visible.filter((e) => e.managedByGarderobe)).toEqual([]);
    writesAfterPause = calendar.writes;
  });

  it('while paused, every scheduled phase publishes nothing and the outfit calendar stays quiet', async () => {
    // SURFACE GAP: no HTTP/MCP route for the scheduled phases; driven through DailyService.sweep
    const runs = [
      ...(await at('2026-10-06T05:45:00.000Z')), // 06:45 morning refresh
      ...(await at('2026-10-06T05:52:00.000Z')), // 06:52 final
      ...(await at('2026-10-06T20:05:00.000Z')), // evening for Wednesday: already ran before the pause, so deduplicated
      ...(await at('2026-10-07T05:45:00.000Z')),
      ...(await at('2026-10-07T20:05:00.000Z')), // evening for Thursday
    ];
    expect(runs.map((r) => `${r.phase}:${r.boardDate}:${r.status}`)).toEqual(['morning_refresh:2026-10-06:paused', 'final:2026-10-06:paused', 'morning_refresh:2026-10-07:paused', 'evening:2026-10-08:paused']);
    expect((await board('2026-10-06'))!.currentRevision).toBe(1);
    expect((await board('2026-10-07'))!.currentRevision).toBe(1);
    expect(await board('2026-10-08')).toBeNull();
    expect((await app.today('2026-10-08')).board).toBeNull();
    expect((await event('2026-10-06'))!.status).toBe('cancelled');
    expect((await event('2026-10-07'))!.status).toBe('cancelled');
    expect(await event('2026-10-08')).toBeNull();
    expect(calendar.writes, 'no calendar writes while paused').toBe(writesAfterPause);
    // An explicit "Prepare now" during the pause says why nothing was published rather than pretending.
    const prep = await app.prepare({ date: '2026-10-08' });
    expect(prep).toMatchObject({ published: false, reason: 'paused' });
  });

  it('observations, the wardrobe and a connected assistant keep working while paused, and the return deadline stays active', async () => {
    const b6 = (await app.today('2026-10-06')).board!;
    const [first, second] = offered(await app.today('2026-10-06'));
    const shirt1 = first!.option.slots.find((s) => s.role === 'base_top')!.garmentId;
    const shirt2 = second!.option.slots.find((s) => s.role === 'base_top')!.garmentId;
    world.clock.set('2026-10-07T08:00:00.000Z');
    const wear = await app.commit({ type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-06', items: first!.option.slots.filter((s) => s.role !== 'footwear' && s.role !== 'accessory').map((s) => ({ garmentId: s.garmentId, role: s.role })) });
    expectDoneReceipt(wear);
    expect(b6.boardDate).toBe('2026-10-06');

    const grant = await connectAssistant(owner.assertion, 'claude');
    const mcp = await connectMcp(grant.accessToken);
    const viaAssistant = await mcp.tool('garderobe_command', { idempotencyKey: 'mcp-paused-wear-2026-10-07', command: { type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-07', items: [{ garmentId: shirt2, role: 'base_top' }] } });
    expect(viaAssistant.isError ?? false).toBe(false);
    expect(viaAssistant.structuredContent).toMatchObject({ status: 'executed', receipt: { outcome: 'committed' } });
    await mcp.close();
    wornWhilePaused = [shirt1, shirt2];

    const { page } = await app.wardrobe();
    expect(page.total).toBe(145);
    // SURFACE GAP: no HTTP/MCP read route for return deadlines; read from D1
    const d = await env.DB.prepare('SELECT status, deadline_at FROM return_deadlines WHERE user_id = ?').bind(owner.userId).first<{ status: string; deadline_at: string }>();
    expect(d).toEqual({ status: 'open', deadline_at: '2026-10-08T22:59:00.000Z' });
  });

  it('resuming on Thursday afternoon prepares only Friday’s board: no backlog of old boards, no questions about missed days, and the wears logged while paused are respected', async () => {
    // SURFACE GAP: no HTTP/MCP route for pause/resume; driven through DailyService.resume
    world.clock.set('2026-10-08T12:00:00.000Z'); // 13:00 London: Thursday's delivery has passed
    const resumed = await daily.resume();
    expect(resumed.ended).toBe(1);
    expect(resumed.boardDate).toBe('2026-10-09');
    expect(resumed.outcome.published).toBe(true);
    expect(resumed.projection!.status).toBe('projected');
    expect(await boardDates()).toEqual(['2026-10-06', '2026-10-07', '2026-10-09']);
    expect((await board('2026-10-06'))!.currentRevision).toBe(1);
    expect((await board('2026-10-07'))!.currentRevision).toBe(1);
    expect((await event('2026-10-06'))!.status).toBe('cancelled');
    expect((await event('2026-10-07'))!.status).toBe('cancelled');
    expect((await event('2026-10-09'))!.status).toBe('confirmed');

    const friday = await app.today('2026-10-09');
    expectGlanceableBoard(friday);
    expect(friday.board!.document!.text).not.toMatch(INTERROGATION);
    expect(friday.board!.document!.text).not.toMatch(/\b(missed|while you were away|catch up|backlog)\b/i);
    const shirts = offered(friday).flatMap((o) => o.byRole('base_top').map((g) => g.garmentId));
    for (const s of wornWhilePaused) expect(shirts, 'a shirt worn during the pause is not repeated within the week').not.toContain(s);
    // The observations themselves are intact on their own dates.
    expect((await app.today('2026-10-06')).recordedWears.map((w) => w.garmentId)).toContain(wornWhilePaused[0]);
    expect((await app.today('2026-10-07')).recordedWears.map((w) => w.garmentId)).toContain(wornWhilePaused[1]);

    // Ordinary service carries on from here.
    const next = await at('2026-10-09T20:05:00.000Z');
    expect(next.map((r) => [r.phase, r.boardDate, r.status])).toEqual([['evening', '2026-10-10', 'complete']]);
  });

  it('an indefinite pause stays paused however long it lasts, and resuming applies the elapsed laundry resets and prepares one board', async () => {
    // SURFACE GAP: no HTTP/MCP route for pause/resume; driven through DailyService
    world.clock.set('2026-10-10T12:00:00.000Z');
    const p = await daily.pause();
    expect(p).toMatchObject({ startsOn: '2026-10-10', resumeOn: null });
    const later = [...(await at('2026-10-10T20:05:00.000Z')), ...(await at('2026-10-24T20:05:00.000Z')), ...(await at('2026-11-07T21:05:00.000Z'))];
    expect(later.length).toBeGreaterThanOrEqual(3);
    expect(later.every((r) => r.status === 'paused')).toBe(true);
    expect(await boardDates()).toEqual(['2026-10-06', '2026-10-07', '2026-10-09', '2026-10-10']);

    world.clock.set('2026-11-08T08:00:00.000Z'); // Sunday 08:00 GMT, four weeks on
    const resumed = await daily.resume();
    expect(resumed.boardDate).toBe('2026-11-09');
    expect(resumed.outcome.published).toBe(true);
    expect(resumed.resetsApplied, 'elapsed weekly cleanliness resets applied on resume').toBeGreaterThan(0);
    expect(await boardDates()).toEqual(['2026-10-06', '2026-10-07', '2026-10-09', '2026-10-10', '2026-11-09']);
    expectGlanceableBoard(await app.today('2026-11-09'));
  });
});
