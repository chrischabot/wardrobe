import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { ConversationPage, ItemDetail, StudioChoices, StudioSuggestion, type TodayResponse } from '@garderobe/contracts';
import { seedOwner, type Owner } from '../harness/owner.js';
import { App, call } from '../harness/http.js';
import { addDays, installWorld, morningOf, type World } from '../harness/world.js';
import { expectDoneReceipt, expectGlanceableBoard, INTERROGATION } from '../harness/ux.js';
import { offered } from '../harness/profile.js';
import { fakeModel, resetModel } from '../harness/assistant.js';
import { createDailyService } from '../../../backend/src/daily/runtime.js';

/**
 * Journey 10 — The UX contract under strain (spec sections 1, 3, 5, 9, 13 and 17 rows "Morning
 * independence", "Missing reports", "Calendar"). The morning board is ready with the phone offline
 * and no assistant connected, and reading it needs no inference; a week without wear reports asks
 * nothing; stale data is labelled stale; a failing connection leaves Today available; a pending
 * external effect is never shown as done.
 */

describe('Journey: the morning is prepared overnight, with the phone offline and no assistant connected', () => {
  let world: World;
  let owner: Owner;
  let app: App;

  beforeAll(async () => {
    world = installWorld({ now: '2026-10-05T20:00:00.000Z', calendar: true, weather: { scenario: 'elevenToNineteen' } });
    owner = await seedOwner();
    app = new App(owner.assertion);
    resetModel();
  });

  it('the scheduled phases compose, publish and project the board with no app request and no model', async () => {
    const daily = createDailyService(env, owner.userId, { weather: world.weather, calendar: world.calendar, calendarStore: world.calendar, clock: world.clock.now });
    const evening = await daily.runPhase('evening', '2026-10-06');
    expect(evening.status ?? 'complete').not.toBe('failed');
    world.clock.set('2026-10-06T05:40:00.000Z');
    await daily.runPhase('morning_refresh', '2026-10-06');
    world.clock.set('2026-10-06T05:50:00.000Z');
    const final = await daily.runPhase('final', '2026-10-06');
    expect(final.deadlineMet).toBe(true);
    // 07:00: the phone opens Today.
    world.clock.set('2026-10-06T06:00:00.000Z');
    const t = await app.today();
    expectGlanceableBoard(t, { requested: 5 });
    expect(fakeModel.calls, 'no inference was needed to prepare or read the board').toHaveLength(0);
    // One managed Calendar event holds every option, with the same day line.
    const events = [...world.calendar!.managed.values()];
    expect(events).toHaveLength(1);
    const ev = events[0]! as unknown as { description?: string; summary?: string; attendees?: unknown[] };
    expect(ev.description ?? '').toContain(t.board!.document!.dayLine);
    for (const o of t.board!.document!.options.filter((x) => x.status === 'offerable')) expect(ev.description ?? '').toContain(o.why);
    expect(ev.attendees ?? []).toEqual([]);
    expect(ev.description ?? '').not.toMatch(/PCF\d|g_[a-z0-9]{8}|hamper|probab/i);
  });

  it('a later revision replaces the managed contents of the same event instead of adding another', async () => {
    const daily = createDailyService(env, owner.userId, { weather: world.weather, calendar: world.calendar, calendarStore: world.calendar, clock: world.clock.now });
    const t = await app.today();
    const shirt = offered(t)[0]!.byRole('base_top')[0]!.garmentId;
    await app.commit({ type: 'mark_in_wash', garmentId: shirt });
    await new Promise((r) => setTimeout(r, 300)); // the API's own background repair (waitUntil)
    await daily.processEffects();
    await daily.sweep(); // and the next scheduled sweep
    const after = await app.today();
    expect(after.board!.currentRevision).toBeGreaterThan(t.board!.currentRevision);
    expect(offered(after).flatMap((o) => o.garments.map((g) => g.garmentId))).not.toContain(shirt);
    expect(world.calendar!.inserts).toBe(1);
    expect(world.calendar!.managed.size).toBe(1);
    const ev = [...world.calendar!.managed.values()][0]! as unknown as { description?: string };
    const effects = (await env.DB.prepare('SELECT kind, status, operation_key FROM command_effects WHERE user_id = ? ORDER BY rowid').bind(owner.userId).all()).results;
    expect(ev.description ?? '', `managed event after the repair; effects: ${JSON.stringify(effects)}`).toContain(offered(after)[0]!.doc!.why);
  });
});

describe('Journey: a week without wear reports produces no interrogation and still useful boards', () => {
  let world: World;
  let owner: Owner;
  let app: App;
  const boards: TodayResponse[] = [];
  /** Per-wear tops chosen Monday to Thursday; fixed before Friday and never chosen again. */
  const anchors = new Set<string>();
  /** Every garment of each morning's chosen outfit. */
  const chosen: { date: string; garmentIds: string[] }[] = [];

  beforeAll(async () => {
    world = installWorld({ now: '2026-10-04T20:00:00.000Z', weather: { scenario: 'mild' } });
    owner = await seedOwner();
    app = new App(owner.assertion);
  });

  it('each evening the scheduled service prepares a full board and one is chosen, but nothing is ever reported worn', async () => {
    // The boards come from the scheduled evening phase, as in production, which applies the weekly
    // laundry resets. (When this was investigated, "Prepare now" composed without applying a due reset;
    // it now applies it too, see backend/test/daily/prepare-reset.test.ts.)
    //
    // The anchors for the missed-wear promise are chosen deterministically, independent of ranking.
    // An anchor is a top that can only be worn as the base top and is laundered after every wear (a
    // shirt, T-shirt or polo), so a single unreported choice makes it probably unavailable.
    // - Monday to Thursday: choose the first option whose base top is anchorable. The board never
    //   repeats a base top (hard rule board.distinct_shirts), so a full board of five holds at most
    //   four other tops. If the wardrobe has fewer than five base tops that are not anchorable, every
    //   full board contains an anchorable one, so the anchor set cannot be empty.
    // - Friday on: choose the first option containing no anchor. An anchor fits only the base-top slot
    //   and tops are distinct within a board, so at most four of the five options hold one of the (at
    //   most four) anchors, and one option always avoids them all.
    const { byId } = await app.wardrobe();
    const anchorable = (id: string | undefined) => {
      const g = id ? byId.get(id)?.garment : undefined;
      return !!g && g.laundryPolicy === 'per_wear' && g.roles.length === 1 && g.roles[0] === 'base_top';
    };
    const otherTops = [...byId.values()].filter((w) => w.garment.roles.includes('base_top') && !anchorable(w.garment.garmentId));
    expect(otherTops.length, `base tops that are not per-wear, base-top-only pieces: ${otherTops.map((w) => w.garment.name).join(', ')}`).toBeLessThan(5);
    const daily = createDailyService(env, owner.userId, { weather: world.weather, calendar: null, clock: world.clock.now });
    let date = '2026-10-05';
    for (let i = 0; i < 8; i++, date = addDays(date, 1)) {
      world.clock.set(`${addDays(date, -1)}T20:00:00.000Z`);
      const evening = await daily.runPhase('evening', date);
      expect(evening.status ?? 'complete', `evening phase for ${date}`).not.toBe('failed');
      world.clock.set(morningOf(date, '06:45'));
      const t = await app.today();
      expectGlanceableBoard(t, { requested: 5 });
      boards.push(t);
      const options = offered(t);
      const baseTop = (o: (typeof options)[number]) => o.byRole('base_top')[0]?.garmentId;
      const early = date <= '2026-10-08';
      const pick = early
        ? options.find((o) => anchorable(baseTop(o)))
        : options.find((o) => !o.garments.some((g) => anchors.has(g.garmentId)));
      expect(pick, early ? `${date}: a full board offers a shirt, T-shirt or polo as a base top` : `${date}: a full board has an option without the anchors ${[...anchors].join(', ')}`).toBeTruthy();
      if (early) anchors.add(baseTop(pick!)!);
      chosen.push({ date, garmentIds: pick!.garments.map((g) => g.garmentId) });
      // Choose, then say nothing more.
      await app.commit({ type: 'select_option', boardId: t.board!.boardId, optionId: pick!.option.optionId });
    }
  });

  it('no board, receipt, conversation message or setting asks for status or confirmation', async () => {
    for (const t of boards) {
      expect(t.board!.document!.text).not.toMatch(INTERROGATION);
      expect(t.shortfall).toBeNull();
      for (const o of t.board!.document!.options) expect(o.qualification ?? '').not.toMatch(INTERROGATION);
    }
    const page = ConversationPage.parse((await app.get('/v1/conversation/messages?limit=50')).body);
    expect(page.messages).toEqual([]);
    const receipts = (await app.get<{ receipts: { summary: string; commandType: string }[] }>('/v1/receipts?limit=100')).body.receipts.filter((r) => r.commandType !== 'add_item'); // add_item: the seed's owner-asserted additions
    expect(receipts.map((r) => r.commandType).filter((c) => c !== 'select_option')).toEqual([]);
    for (const r of receipts) expect(r.summary).not.toMatch(INTERROGATION);
    // No confirmation backlog: nothing recorded as worn, nothing pending for the owner.
    const t = await app.today();
    expect(t.recordedWears).toEqual([]);
    const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM pending_actions WHERE user_id = ? AND status = 'pending'").bind(owner.userId).first<{ n: number }>().catch(() => ({ n: 0 }));
    expect(pending!.n).toBe(0);
  });

  it('a missed wear report does not exclude the chosen pieces indefinitely: after the weekly reset they are available and can be worn again', async () => {
    // The anchors are the per-wear tops chosen Monday to Thursday; from Friday on none was chosen again
    // (see the first test). Their only unreported "wear" precedes Friday's collection cutoff, so the
    // Sunday baseline reset must clear it. Whether the composer happens to rank one of them onto the
    // last two boards is taste and variety, not the promise, so the test asserts availability and
    // wearability.
    expect(anchors.size, 'tops chosen Monday to Thursday').toBeGreaterThan(0);
    for (const c of chosen.filter((x) => x.date >= '2026-10-09')) expect(c.garmentIds.filter((id) => anchors.has(id)), `${c.date} chose no anchor`).toEqual([]);
    const estimateOn = async (date: string, id: string) => {
      world.clock.set(morningOf(date, '06:50'));
      return ItemDetail.parse((await app.get(`/v1/items/${id}`)).body);
    };
    for (const id of anchors) {
      const sat = await estimateOn('2026-10-10', id);
      const mon = await estimateOn('2026-10-12', id);
      const name = mon.item.garment.name;
      const e = mon.estimate!;
      // The unreported choice was inferred before the reset, and the reset cleared it.
      expect(e.probabilityAvailable, `${name}: ${sat.estimate!.probabilityAvailable} on Saturday → ${e.probabilityAvailable} on Monday`).toBeGreaterThan(sat.estimate!.probabilityAvailable);
      expect(e.eligible, name).toBe(true);
      expect(e.likelyAvailable, `${name} is likely available after the Sunday reset (p=${e.probabilityAvailable})`).toBe(true);
      expect(e.estimatedCleanUnits, name).toBeGreaterThanOrEqual(1);
      expect(mon.item.availability.available, `${name}: “${mon.item.availability.label}”`).toBe(true);
      // The backend offers it for today, and it completes a valid outfit for the day.
      const choices = StudioChoices.parse((await app.post('/v1/studio/choices', { mode: 'today', date: '2026-10-12', role: 'base_top' })).body);
      expect(choices.items.find((c) => c.garmentId === id)?.eligibleToday, `${name} in Studio For today`).toBe(true);
      const s = StudioSuggestion.parse((await app.post('/v1/studio/suggest', { mode: 'today', date: '2026-10-12', locked: [{ garmentId: id, role: 'base_top' }], roles: ['bottom', 'socks', 'footwear', 'outer_layer', 'belt'] })).body);
      expect(s.validation.valid, `${name} completes a valid outfit on Monday: ${s.validation.issues.map((i) => i.message).join('; ')}`).toBe(true);
    }
    // Inferred wears never enter wear counts.
    for (const t of boards) for (const w of t.recordedWears) expect(w).toBeUndefined();
    const { byId } = await app.wardrobe();
    for (const id of anchors) expect(byId.get(id)!.recordedWearCount).toBe(0);
    expect(chosen).toHaveLength(8);
  });
});

describe('Journey: stale data is labelled stale; a failing connection leaves Today available', () => {
  let world: World;
  let owner: Owner;
  let app: App;

  beforeAll(async () => {
    world = installWorld({ now: '2026-10-05T20:00:00.000Z', calendar: true, weather: { scenario: 'mild' } });
    owner = await seedOwner();
    app = new App(owner.assertion);
  });

  it('a weather outage at the morning check keeps the last forecast, visibly marked stale with its age', async () => {
    await app.prepare({ date: '2026-10-06' });
    world.weather.set({ fail: true });
    world.clock.set('2026-10-06T05:40:00.000Z');
    const r = await app.prepare({ date: '2026-10-06' });
    expect(r.published).toBe(true);
    const t = await app.today();
    expect(t.board!.document!.weather.status).toBe('stale');
    expect(t.board!.document!.weather.ageMinutes).toBeGreaterThan(0);
    expect(t.sources.find((s) => s.source === 'weather')?.status).toBe('stale');
    expect(t.weather?.status).toBe('stale');
    world.weather.set({ fail: false });
  });

  it('with no forecast at all, the board says the weather is missing; missing never means dry, warm or calm', async () => {
    world.weather.set({ fail: true });
    world.clock.set('2026-10-07T19:00:00.000Z');
    const r = await app.prepare({ date: '2026-10-09' });
    const t = await app.today('2026-10-09');
    if (r.published) {
      expect(['missing', 'unavailable']).toContain(t.board!.document!.weather.status);
      expect(t.board!.document!.weather.peakTempC).toBeNull();
      expect(t.board!.document!.weather.line).not.toMatch(/dry|warm|calm/i);
    } else {
      expect(t.board).toBeNull();
      expect(r.reason.length).toBeGreaterThan(5);
    }
    world.weather.set({ fail: false });
  });

  it('a calendar outage still publishes the board and Today stays available, with calendar marked unavailable', async () => {
    world.calendar!.failListing = true;
    world.clock.set('2026-10-07T19:30:00.000Z');
    const r = await app.prepare({ date: '2026-10-08' });
    expect(r.published).toBe(true);
    const t = await app.today('2026-10-08');
    expectGlanceableBoard(t);
    expect(t.board!.document!.calendar.status).toBe('unavailable');
    expect(t.sources.find((s) => s.source === 'calendar')?.status).toBe('unavailable');
    world.calendar!.failListing = false;
    const web = await call('/board?date=2026-10-08', { assertion: owner.assertion });
    expect(web.status).toBe(200);
  });

  it('Choose queues the Calendar update; the receipt says pending, never projected, until read-back verifies it', async () => {
    const t = await app.today('2026-10-08');
    const r = await app.commit({ type: 'select_option', boardId: t.board!.boardId, optionId: offered(t)[0]!.option.optionId });
    expectDoneReceipt(r);
    const cal = r.effects.items.find((e) => e.kind === 'calendar_projection');
    expect(cal, 'a calendar projection effect is queued').toBeTruthy();
    expect(cal!.external).toBe(true);
    expect(cal!.status).not.toBe('projected');
    expect(r.effects.state).not.toBe('projected');
    expect(r.summary).not.toMatch(/calendar (updated|synced)|added to (your )?calendar/i);
  });
});
