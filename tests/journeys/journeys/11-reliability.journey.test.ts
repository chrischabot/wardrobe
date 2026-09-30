import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { SettingsResponse, type TodayResponse } from '@garderobe/contracts';
import { seedOwner, uniq, type Owner } from '../harness/owner.js';
import { App } from '../harness/http.js';
import { installWorld, morningOf, type World } from '../harness/world.js';
import { expectGlanceableBoard, expectNotDone } from '../harness/ux.js';
import { hardConstraintViolations, offered } from '../harness/profile.js';
import { connectAssistant, connectMcp } from '../harness/mcp.js';
import { RecommendationService } from '../../../backend/src/recommend/index.js';

/**
 * Journey 11 — Reliable recommendations (spec sections 7 and 8; section 17 rows "Hallucinated items",
 * "Availability", "Concurrency", "Repair", "Selected future repair"). Invented pieces never become
 * actionable; availability states behave in ordinary and explicit requests; a laundry change racing
 * composition cannot publish a stale board; parallel edits conflict instead of overwriting; a
 * wear repairs a chosen future outfit while keeping its other pieces; impossible counts give fewer
 * honest options, never placeholders.
 */

type Rec = { options: { optionId: string; slots: { garmentId: string; role: string }[]; why: string }[]; shortfall: string | null };

describe('Journey: explicit requests and availability', () => {
  let owner: Owner;
  let app: App;
  const recommend = async (body: Record<string, unknown>) => {
    const r = await app.post<Rec>('/v1/recommend', { date: '2026-10-06', ...body });
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    return r.body;
  };

  beforeAll(async () => {
    installWorld({ now: '2026-10-05T19:00:00.000Z', weather: { scenario: 'mild' } });
    owner = await seedOwner();
    app = new App(owner.assertion);
  });

  it('an explicit request for a piece builds every option around it, with valid companions', async () => {
    const chino = await owner.byName('Di Sondrio walnut chino');
    const r = await recommend({ include: [chino], count: 3 });
    expect(r.options.length).toBeGreaterThan(0);
    // The MCP tool documents include as “Garment ids every option must contain”.
    for (const o of r.options) expect(o.slots.map((s) => s.garmentId), 'every option contains the requested chino').toContain(chino);
    for (const o of r.options) expect(o.slots.some((s) => s.role === 'socks')).toBe(true);
  });

  it('a requested count never justifies unavailable garments: restricted, dirty, incoming and retired pieces stay out', async () => {
    const paraboot = await owner.byName('Paraboot Norwegian split-toe');
    const shirt = await owner.byName('Lightweight oxford — gold');
    await app.commit({ type: 'mark_in_wash', garmentId: shirt });
    const donated = await owner.byName("Drake's red polka-dot");
    await app.commit({ type: 'dispose_item', garmentId: donated, reason: 'donated', note: 'TEST EVENT' });
    for (const id of [paraboot, shirt]) {
      const r = await recommend({ include: [id], count: 5 });
      for (const o of r.options) expect(o.slots.map((s) => s.garmentId)).not.toContain(id);
      expect(r.shortfall, 'an explained shortfall instead of a padded board').toBeTruthy();
    }
    const any = await recommend({ count: 5 });
    const ids = any.options.flatMap((o) => o.slots.map((s) => s.garmentId));
    for (const id of [paraboot, shirt, donated]) expect(ids).not.toContain(id);
  });

  it('bed socks are indoor-only and never appear on an outdoor board', async () => {
    const bed = await owner.byName('Alpaca bed sock — clotted cream');
    await app.prepare({ date: '2026-10-06' });
    const t = await app.today('2026-10-06');
    expect(offered(t).flatMap((o) => o.garments.map((g) => g.garmentId))).not.toContain(bed);
  });

  it('an invented garment id can never become an actionable outfit or an inventory change', async () => {
    const fake = 'g_inventedbymodel0001';
    const r = await app.post<{ error?: { code: string } } & Partial<Rec>>('/v1/recommend', { date: '2026-10-06', include: [fake] });
    if (r.status === 200) for (const o of r.body.options ?? []) expect(o.slots.map((s) => s.garmentId)).not.toContain(fake);
    else expect(r.status).toBeGreaterThanOrEqual(400);
    const wear = await app.command({ type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-05', items: [{ garmentId: fake }] });
    expectNotDone(wear.receipt);
    expect(wear.status).toBe(404);
    const mcp = await connectMcp((await connectAssistant(owner.assertion, 'claude')).accessToken);
    const viaMcp = await mcp.tool('garderobe_command', { idempotencyKey: uniq('mcp'), command: { type: 'mark_in_wash', garmentId: fake } });
    expect((viaMcp.structuredContent?.receipt as { outcome?: string } | undefined)?.outcome ?? 'rejected').not.toBe('committed');
    await mcp.close();
    expect((await app.wardrobe()).page.total).toBe(144);
  });
});

describe('Journey: concurrency — a laundry change racing composition, and two clients editing at once', () => {
  let world: World;
  let owner: Owner;
  let app: App;

  beforeAll(async () => {
    world = installWorld({ now: '2026-10-05T19:00:00.000Z', weather: { scenario: 'mild' } });
    owner = await seedOwner();
    app = new App(owner.assertion);
  });

  it('a shirt going into the wash while the board is being composed cannot be published as offerable', async () => {
    const rec = new RecommendationService({ db: env.DB, principal: owner.principal, weather: world.weather, calendar: null, clock: world.clock.now });
    const preview = await rec.compose({ date: '2026-10-06' });
    const firstShirt = preview.composed.options[0]!.slots.find((s) => s.role === 'base_top')!.garmentId;
    let raced = false;
    const out = await rec.composeAndPublish({ date: '2026-10-06' }, {
      beforePublish: async () => {
        if (raced) return;
        raced = true;
        await app.commit({ type: 'mark_in_wash', garmentId: firstShirt }); // the phone, mid-composition
      },
    });
    expect(out.published).toBe(true);
    const t = await app.today('2026-10-06');
    expect(offered(t).flatMap((o) => o.garments.map((g) => g.garmentId))).not.toContain(firstShirt);
    expectGlanceableBoard(t);
  });

  it('the app and a connected assistant editing the same settings: one wins, the other gets a conflict, nothing is overwritten', async () => {
    const s = SettingsResponse.parse((await app.get('/v1/settings')).body);
    const expectedVersions = [{ entityType: 'owner_settings', entityId: owner.userId, version: s.version }];
    const mcp = await connectMcp((await connectAssistant(owner.assertion, 'chatgpt')).accessToken);
    const [a, b] = await Promise.all([
      app.command({ type: 'update_delivery_settings', deliveryTime: '06:30' }, { expectedVersions }),
      mcp.tool('garderobe_command', { idempotencyKey: uniq('mcp'), expectedVersions, command: { type: 'update_delivery_settings', deliveryTime: '07:30' } }),
    ]);
    const outcomes = [a.receipt.outcome, (b.structuredContent!.receipt as { outcome: string }).outcome].sort();
    expect(outcomes).toEqual(['committed', 'conflict']);
    const after = SettingsResponse.parse((await app.get('/v1/settings')).body);
    expect(after.version).toBe(s.version + 1);
    expect(['06:30', '07:30']).toContain(after.deliveryTime);
    expect(after.deliveryTime).toBe(a.receipt.outcome === 'committed' ? '06:30' : '07:30');
    await mcp.close();
  });
});

describe('Journey: repair after reality changes', () => {
  let world: World;
  let owner: Owner;
  let app: App;

  beforeAll(async () => {
    world = installWorld({ now: '2026-10-05T19:00:00.000Z', weather: { scenario: 'mild' } });
    owner = await seedOwner();
    app = new App(owner.assertion);
  });

  it('wearing a piece of tomorrow’s chosen outfit repairs only that piece, keeping the rest and the actual wear', async () => {
    await app.prepare({ date: '2026-10-06' });
    await app.prepare({ date: '2026-10-07' });
    const tomorrow = await app.today('2026-10-07');
    const chosen = offered(tomorrow)[0]!;
    await app.commit({ type: 'select_option', boardId: tomorrow.board!.boardId, optionId: chosen.option.optionId });
    const trousers = chosen.byRole('bottom')[0]!.garmentId;
    const shirt = chosen.byRole('base_top')[0]!.garmentId;
    // Today (the 6th) the owner actually wears tomorrow's trousers.
    world.clock.set(morningOf('2026-10-06', '08:00'));
    const wear = await app.commit({ type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-06', items: [{ garmentId: trousers, role: 'bottom' }] });
    expect(wear.effects.items.some((e) => e.kind === 'board_revalidation')).toBe(true);
    let after: TodayResponse = tomorrow;
    for (let i = 0; i < 40 && after.board!.currentRevision === tomorrow.board!.currentRevision; i++) {
      await new Promise((r) => setTimeout(r, 100));
      after = await app.today('2026-10-07');
    }
    expect(after.board!.currentRevision, 'tomorrow’s board was repaired automatically').toBeGreaterThan(tomorrow.board!.currentRevision);
    const sel = after.selection!;
    expect(sel).toBeTruthy();
    const repaired = offered(after).find((o) => o.option.optionId === sel.optionId)!;
    expect(repaired.byRole('bottom').map((g) => g.garmentId)).not.toContain(trousers);
    expect(repaired.byRole('base_top').map((g) => g.garmentId)).toEqual([shirt]);
    expect(repaired.doc?.lineage.changedRoles ?? ['bottom']).toEqual(['bottom']);
    // The actual wear is preserved, and today's record is untouched.
    expect((await app.today('2026-10-06')).recordedWears.map((w) => w.garmentId)).toContain(trousers);
    const w = after.board!.document!.weather;
    expect(hardConstraintViolations(after, { peakC: w.peakTempC!, departureC: w.departureTempC!, wornLastSevenDays: new Set([trousers]) }).join('\n')).toBe('');
  });

  it('with only two clean shirts left, the board shows fewer honest options and one brief explanation — no placeholders', async () => {
    const { byId } = await app.wardrobe();
    const tops = [...byId.values()].filter((i) => i.garment.roles.includes('base_top') && i.garment.acquisition === 'owned' && i.availability.available);
    const keep = tops.filter((i) => i.garment.category === 'shirt' && /lightweight oxford/i.test(i.garment.name)).slice(0, 2).map((i) => i.garment.garmentId);
    expect(keep).toHaveLength(2);
    world.clock.set('2026-10-07T19:00:00.000Z');
    for (const i of tops) {
      if (keep.includes(i.garment.garmentId)) continue;
      // (Storage rather than the wash: knit and rugby tops are multi-wear and never enter the hamper.)
      await app.commit({ type: 'put_into_storage', garmentId: i.garment.garmentId, locationDetail: 'TEST EVENT: scarcity scenario' });
    }
    const prep = await app.prepare({ date: '2026-10-08' });
    expect(prep.published).toBe(true);
    const t = await app.today('2026-10-08');
    const opts = offered(t);
    expect(opts.length).toBeGreaterThan(0);
    expect(opts.length, `options: ${opts.map((o) => o.garments.map((g) => `${g.name} [${g.category}]`).join(' + ')).join(' || ')}`).toBeLessThanOrEqual(2);
    expect(t.board!.document!.shortfall).toBeTruthy();
    expect(t.board!.document!.shortfall!.length).toBeLessThan(300);
    expect(t.board!.options.filter((o) => o.status === 'withdrawn' || (o.status === 'offerable' && !o.slots.length))).toEqual([]);
    for (const o of opts) for (const g of o.byRole('base_top')) expect(keep).toContain(g.garmentId);
    const w = t.board!.document!.weather;
    expect(hardConstraintViolations(t, { peakC: w.peakTempC!, departureC: w.departureTempC! }).join('\n')).toBe('');
  });
});
