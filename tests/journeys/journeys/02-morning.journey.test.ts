import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { ItemDetail, TodayResponse, type TodayResponse as Today } from '@garderobe/contracts';
import { seedOwner, uniq, type Owner } from '../harness/owner.js';
import { App } from '../harness/http.js';
import { installWorld, morningOf, type World } from '../harness/world.js';
import { expectDoneReceipt, expectGlanceableBoard, INTERROGATION } from '../harness/ux.js';
import { isNavy, offered, sneakerAndWelted, sneakersOnly } from '../harness/profile.js';
import { connectAssistant, connectMcp } from '../harness/mcp.js';

/**
 * Journey 2 — The morning (spec sections 1 and 3 "Today"; profile section 11). Open the board, look
 * at three to five outfits, choose one, swap a shirt, pick the shoes at the door, record what was
 * actually worn. Choose is an intention, not a wear; swapping a shirt changes only the shirt;
 * recording a wear records it; neither starts a negotiation about the wardrobe.
 */

const settle = () => new Promise((r) => setTimeout(r, 250));
const wearCount = async (userId: string, garmentId: string) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM daily_wears WHERE user_id = ? AND garment_id = ? AND status = 'active'").bind(userId, garmentId).first<{ n: number }>())!.n;

describe('Journey: morning board — fetch, choose, swap a shirt, I wore this', () => {
  let world: World;
  let owner: Owner;
  let app: App;
  let today: Today;

  beforeAll(async () => {
    world = installWorld({ now: '2026-10-05T20:00:00.000Z', weather: { scenario: 'mild' } });
    owner = await seedOwner();
    app = new App(owner.assertion);
    // Composed the evening before (21:00 London), read at 06:30.
    expect((await app.prepare({ date: '2026-10-06' })).published).toBe(true);
    world.clock.set(morningOf('2026-10-06'));
    today = await app.today();
  });

  it('opens straight to the prepared board: date and weather lead, then three to five named outfits', async () => {
    expect(today.date).toBe('2026-10-06');
    expectGlanceableBoard(today);
    expect(today.weather?.summary).toMatch(/°C/);
    expect(today.selection).toBeNull();
    expect(today.recordedWears).toEqual([]);
    expect(sneakersOnly(today).join('\n')).toBe('');
    // Reading never recomposes the board.
    const again = await app.today();
    expect(again.board!.currentRevision).toBe(today.board!.currentRevision);
  });

  it('a connected assistant sees exactly the same board revision as the app', async () => {
    const grant = await connectAssistant(owner.assertion, 'claude', ['wardrobe:read']);
    const mcp = await connectMcp(grant.accessToken);
    const r = await mcp.tool('garderobe_today');
    const viaMcp = TodayResponse.parse(r.structuredContent);
    expect(viaMcp.board!.boardId).toBe(today.board!.boardId);
    expect(viaMcp.board!.currentRevision).toBe(today.board!.currentRevision);
    expect(r.content[0]?.text).toBe(today.board!.document!.text);
    await mcp.close();
  });

  it('Choose records an intention with a verified receipt and Undo, not a wear', async () => {
    const pick = offered(today)[1]!;
    const r = await app.commit({ type: 'select_option', boardId: today.board!.boardId, optionId: pick.option.optionId });
    expectDoneReceipt(r);
    expect(r.summary).toMatch(/plan, not a recorded wear/);
    for (const g of pick.garments) expect(r.summary).toContain(g.name);
    const t = await app.today();
    expect(t.selection?.optionId).toBe(pick.option.optionId);
    expect(t.recordedWears).toEqual([]);
    for (const g of pick.garments) expect(await wearCount(owner.userId, g.garmentId)).toBe(0);
  });

  it('choosing again replaces the choice rather than stacking plans', async () => {
    const other = offered(today)[0]!;
    const r = await app.commit({ type: 'select_option', boardId: today.board!.boardId, optionId: other.option.optionId });
    expectDoneReceipt(r);
    const t = await app.today();
    expect(t.selection?.optionId).toBe(other.option.optionId);
    const active = await env.DB.prepare("SELECT COUNT(*) AS n FROM selections WHERE user_id = ? AND board_id = ? AND status = 'active'").bind(owner.userId, today.board!.boardId).first<{ n: number }>();
    expect(active!.n).toBe(1);
  });

  let swappedShirt = '';
  let originalShirt = '';
  let observationId = '';

  it('Swap offers validated shirts for that one slot — never a navy fallback, nothing else changes', async () => {
    const opt = offered(today)[0]!;
    originalShirt = opt.byRole('base_top')[0]!.garmentId;
    const r = await app.get<{ candidates: { garmentId: string; name: string; reason: string }[]; role: string }>(`/v1/today/options/${opt.option.optionId}/swaps?role=base_top`);
    expect(r.status).toBe(200);
    expect(r.body.candidates.length).toBeGreaterThan(0);
    const { byId } = await app.wardrobe();
    for (const c of r.body.candidates) {
      const g = byId.get(c.garmentId)!;
      expect(g.garment.roles).toContain('base_top');
      expect(opt.option.slots.map((s) => s.garmentId)).not.toContain(c.garmentId);
      expect(isNavy(g.garment), `swap candidate ${g.garment.name} is a navy fallback`).toBe(false);
      expect(g.availability.available).toBe(true);
      expect(c.reason.length).toBeGreaterThan(5);
      expect(c.reason).not.toMatch(INTERROGATION);
    }
    swappedShirt = r.body.candidates[0]!.garmentId;
    const t = await app.today();
    expect(t.board!.currentRevision).toBe(today.board!.currentRevision);
  });

  it('I wore this records the actual outfit, including the swapped shirt; only the worn shirt is counted', async () => {
    const opt = offered(today)[0]!;
    const items = opt.option.slots.map((s) => ({ garmentId: s.role === 'base_top' ? swappedShirt : s.garmentId, role: s.role }));
    const r = await app.commit({ type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-06', optionId: opt.option.optionId, items });
    expectDoneReceipt(r);
    observationId = r.facts.observationId as string;
    expect(observationId).toMatch(/^obs_/);
    expect(r.affected.some((a) => a.entityType === 'daily_wear')).toBe(true);
    expect(await wearCount(owner.userId, swappedShirt)).toBe(1);
    expect(await wearCount(owner.userId, originalShirt)).toBe(0);
    const t = await app.today();
    const worn = t.recordedWears.map((w) => w.garmentId);
    expect(worn).toContain(swappedShirt);
    expect(worn).not.toContain(originalShirt);
    // Exactly one pair of shoes logged.
    const shoes = t.recordedWears.filter((w) => opt.byRole('footwear').some((g) => g.garmentId === w.garmentId));
    expect(shoes).toHaveLength(1);
  });

  it('changing shirt later in the day counts only the new shirt (amendment, not a second outfit)', async () => {
    const opt = offered(today)[0]!;
    const third = offered(today)[2]!.byRole('base_top')[0]!.garmentId;
    const items = opt.option.slots.map((s) => ({ garmentId: s.role === 'base_top' ? third : s.garmentId, role: s.role }));
    const r = await app.commit({ type: 'amend_wear', observationId, items, reason: 'Changed shirt at lunch' });
    expectDoneReceipt(r);
    expect(await wearCount(owner.userId, third)).toBe(1);
    expect(await wearCount(owner.userId, swappedShirt)).toBe(0);
  });

  it('a second report of the same day from another client merges; nothing asks which one is right', async () => {
    const grant = await connectAssistant(owner.assertion, 'chatgpt', ['wardrobe:read', 'wardrobe:write']);
    const mcp = await connectMcp(grant.accessToken);
    const socks = offered(today)[0]!.byRole('socks')[0]!.garmentId;
    const res = await mcp.tool('garderobe_command', { idempotencyKey: uniq('mcp'), command: { type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-06', items: [{ garmentId: socks }] } });
    const receipt = res.structuredContent!.receipt as { outcome: string; summary: string };
    expect(receipt.outcome).toBe('merged');
    expect(receipt.summary).not.toMatch(INTERROGATION);
    expect(await wearCount(owner.userId, socks)).toBe(1);
    await mcp.close();
  });

  it('once the day is being worn, background repair does not restyle the chosen record', async () => {
    await settle();
    const t = await app.today();
    expect(t.board!.currentRevision).toBe(today.board!.currentRevision);
    expect(t.selection?.optionId).toBe(offered(today)[0]!.option.optionId);
  });
});

describe('Journey: picking footwear at the door once the owner says his feet have healed', () => {
  let owner: Owner;
  let app: App;
  let today: Today;

  beforeAll(async () => {
    installWorld({ now: '2026-10-07T19:30:00.000Z', weather: { scenario: 'mild' } });
    owner = await seedOwner();
    app = new App(owner.assertion);
    const paraboot = await owner.byName('Paraboot Norwegian split-toe');
    const detail = ItemDetail.parse((await app.get(`/v1/items/${paraboot}`)).body);
    const restriction = detail.restrictions.find((r) => r.liftedAt === null)!;
    const lifted = await app.commit({ type: 'lift_restriction', restrictionId: restriction.restrictionId, evidence: 'My feet have healed — the welted fleet is back.' });
    expectDoneReceipt(lifted);
    expect((await app.prepare({ date: '2026-10-08' })).published).toBe(true);
    today = await app.today('2026-10-08');
  });

  it('every outfit names both a sneaker and a welted alternative', () => {
    expectGlanceableBoard(today);
    expect(sneakerAndWelted(today).join('\n')).toBe('');
  });

  it('Choose needs the shoe first, so a wear never logs both; the receipt names only the chosen pair', async () => {
    const opt = offered(today)[0]!;
    const shoes = opt.byRole('footwear');
    expect(shoes.length).toBe(2);
    const refused = await app.command({ type: 'select_option', boardId: today.board!.boardId, optionId: opt.option.optionId });
    expect(refused.status).toBe(422);
    expect(refused.receipt.outcome).toBe('rejected');
    expect(refused.receipt.error?.message).toMatch(/choose one/i);
    const welted = shoes.find((g) => g.category !== 'sneakers')!;
    const sneaker = shoes.find((g) => g.category === 'sneakers')!;
    const r = await app.commit({ type: 'select_option', boardId: today.board!.boardId, optionId: opt.option.optionId, footwearGarmentId: welted.garmentId });
    expectDoneReceipt(r);
    expect(r.summary).toContain(welted.name);
    expect(r.summary).not.toContain(sneaker.name);
    const t = await app.today('2026-10-08');
    expect(t.selection?.footwearGarmentId).toBe(welted.garmentId);
  });
});
