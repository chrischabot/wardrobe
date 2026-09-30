import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { ItemDetail, StyleCurrentResponse, type TodayResponse } from '@garderobe/contracts';
import { PROFILE_SHA256, PROFILE_TEXT, seedOwner, uniq, type Owner } from '../harness/owner.js';
import { App } from '../harness/http.js';
import { addDays, installWorld, morningOf, type World } from '../harness/world.js';
import { expectDoneReceipt, expectGlanceableBoard, expectNotDone } from '../harness/ux.js';
import { hardConstraintViolations, isNavy, noRepeatWithinWeek, offered } from '../harness/profile.js';
import { connectAssistant, connectMcp, type Mcp } from '../harness/mcp.js';
import { assistantWorld, chatCalls, promptText, resetModel } from '../harness/assistant.js';
import { RecommendationService, getRevisionRecord } from '../../../backend/src/recommend/index.js';
import type { WeatherScenarioName } from '../../../backend/src/weather/fake.js';

/**
 * Journey 9 — The owner's profile, applied (profile sections 3, 5, 8, 11; spec section 6 "Apply the
 * supplied profile faithfully", section 7). Boards across varied weather and calendar days satisfy
 * every section 8 hard constraint, checked independently against the garments' own records: socks
 * always; sneakers only while healing, a sneaker plus welted alternative once lifted; shirts and
 * trousers against the peak, jackets against the morning, a lightweight oxford under a jacket at
 * 14–16 °C; no shirt or trousers repeated within seven days; no navy fallback on a swap; perceptible
 * names with jeans as light, mid or dark. Boards follow the section 11 format and spread registers;
 * benched pieces never appear. A profile edit changes the next board and turn; a one-day exception
 * does not rewrite the profile.
 *
 * Scenario state: the labelled TEST EVENT week (demo/src/test-events.ts) plus the owner wearing
 * option 1 each day through the API. Weather: FakeWeatherProvider scenarios; calendar: FakeCalendar.
 */

interface Day {
  date: string;
  scenario: WeatherScenarioName;
  event?: { title: string; start: string; end: string; selfResponse?: 'accepted' | 'declined' | 'tentative' };
  expect?: { peakC?: number; departureC?: number; occasion?: string | null };
}

const DAYS: Day[] = [
  { date: '2026-10-05', scenario: 'mild' },
  { date: '2026-10-06', scenario: 'elevenToNineteen', expect: { peakC: 19, departureC: 11 } },
  { date: '2026-10-07', scenario: 'jacketBand', expect: { departureC: 15 } },
  { date: '2026-10-08', scenario: 'coldSnap' },
  { date: '2026-10-09', scenario: 'heavyRain', event: { title: 'Client meeting with the Rotterdam team', start: '2026-10-09T09:00:00.000Z', end: '2026-10-09T10:30:00.000Z' }, expect: { occasion: 'formal' } },
  { date: '2026-10-10', scenario: 'heat' },
  { date: '2026-10-11', scenario: 'strongWind', event: { title: 'Board meeting', start: '2026-10-11T10:00:00.000Z', end: '2026-10-11T11:00:00.000Z', selfResponse: 'declined' }, expect: { occasion: null } },
  { date: '2026-10-12', scenario: 'rainAfterFour', event: { title: 'Dinner at Brasserie Zédel', start: '2026-10-12T18:30:00.000Z', end: '2026-10-12T21:00:00.000Z' }, expect: { occasion: 'dinner' } },
];

const season = (g: { attributes: Record<string, unknown> }) => String(g.attributes.seasonLabel ?? '');

describe('Journey: a fortnight of boards across varied weather and calendar days follows every hard constraint', () => {
  let world: World;
  let owner: Owner;
  let app: App;
  let mcp: Mcp;
  const boards = new Map<string, TodayResponse>();

  const wornInLastSevenDays = async (date: string): Promise<Set<string>> => {
    const r = await mcp.tool('garderobe_inventory', { view: 'history', from: addDays(date, -7), to: addDays(date, -1) });
    return new Set((r.structuredContent!.wears as { garmentId: string; status: string }[]).filter((w) => w.status === 'active').map((w) => w.garmentId));
  };

  beforeAll(async () => {
    world = installWorld({ now: '2026-10-04T19:00:00.000Z', calendar: true, weather: { byDate: Object.fromEntries(DAYS.map((d) => [d.date, d.scenario])) } });
    owner = await seedOwner();
    app = new App(owner.assertion);
    // The labelled TEST EVENT week before: wears Monday to Friday, a pickup, a partial return, the
    // tailor, storage, an incoming pair and a donation.
    await owner.applyTestEvents('2026-09-28', () => '2026-10-04T18:00:00.000Z');
    for (const d of DAYS) if (d.event) world.calendar!.addEvent({ title: d.event.title, start: d.event.start, end: d.event.end, selfResponse: d.event.selfResponse ?? 'accepted' });
    mcp = await connectMcp((await connectAssistant(owner.assertion, 'claude', ['wardrobe:read'])).accessToken);
  });

  for (const day of DAYS) {
    it(`${day.date} (${day.scenario}${day.event ? `, “${day.event.title}” ${day.event.selfResponse ?? 'accepted'}` : ''}): complete, glanceable and within every hard rule`, async () => {
      world.clock.set(`${addDays(day.date, -1)}T20:00:00.000Z`); // 21:00 London the evening before
      const prep = await app.prepare({ date: day.date });
      expect(prep.published, prep.reason).toBe(true);
      const t = await app.today(day.date);
      boards.set(day.date, t);
      expectGlanceableBoard(t);
      const doc = t.board!.document!;
      const w = doc.weather;
      expect(w.status).toBe('fresh');
      if (day.expect?.peakC !== undefined) expect(w.peakTempC).toBe(day.expect.peakC);
      if (day.expect?.departureC !== undefined) expect(w.departureTempC).toBe(day.expect.departureC);
      const worn = await wornInLastSevenDays(day.date);
      expect(hardConstraintViolations(t, { peakC: w.peakTempC!, departureC: w.departureTempC!, wornLastSevenDays: worn }).join('\n')).toBe('');
      // Thermal rule, by the owner's own season labels: a 19 °C day is a 19 °C outfit.
      for (const o of offered(t)) {
        for (const g of [...o.byRole('base_top'), ...o.byRole('bottom')]) {
          if (w.peakTempC! >= 18) expect(season(g), `${g.name} on a ${w.peakTempC} °C peak`).not.toMatch(/winter|^cold/i);
          if (w.peakTempC! <= 8) expect(season(g), `${g.name} on a ${w.peakTempC} °C peak`).not.toMatch(/warm|hot|summer|30/i);
        }
        // At a cold departure the jacket answers the morning.
        if (w.departureTempC! < 10) expect(o.byRole('outer_layer').length, `option ${o.option.position} at ${w.departureTempC} °C`).toBeGreaterThan(0);
      }
      // Registers spread: the home key is the floor, never the only thing offered.
      const regs = doc.options.filter((o) => o.status === 'offerable').map((o) => o.register);
      expect(new Set(regs).size, regs.join(',')).toBeGreaterThanOrEqual(2);
      // Within a board, displayed shirts and trousers are distinct.
      const tops = offered(t).flatMap((o) => o.byRole('base_top').map((g) => g.name));
      const bottoms = offered(t).flatMap((o) => o.byRole('bottom').map((g) => g.name));
      expect(new Set(tops).size, `shirts repeated within the board: ${tops.join(' | ')}`).toBe(tops.length);
      expect(new Set(bottoms).size, `trousers repeated within the board: ${bottoms.join(' | ')}`).toBe(bottoms.length);
      // Calendar shapes a subset of the board; declined events impose nothing.
      if (day.expect && 'occasion' in day.expect) {
        expect(doc.calendar.occasion).toBe(day.expect.occasion);
        if (day.expect.occasion) {
          expect(doc.suitabilityNote).toBeTruthy();
          const suitable = doc.options.filter((o) => o.status === 'offerable' && o.suitability?.suitable).length;
          expect(suitable).toBeGreaterThanOrEqual(1);
          if (day.expect.occasion === 'formal') expect(suitable, 'alternatives remain for the rest of the day').toBeLessThan(offered(t).length);
        } else {
          expect(doc.suitabilityNote).toBeNull();
        }
      }
      // The owner then wears option 1 (so the seven-day horizon keeps growing).
      world.clock.set(morningOf(day.date, '08:00'));
      const opt = offered(t)[0]!;
      await app.commit({ type: 'record_wear', timezone: 'Europe/London', wearingDate: day.date, optionId: opt.option.optionId, items: opt.option.slots.map((s) => ({ garmentId: s.garmentId, role: s.role })) });
    });
  }

  it('pieces away (tailor, storage, laundry exception), incoming, donated and benched never appear on any board', async () => {
    const names = new Set([...boards.values()].flatMap((t) => offered(t).flatMap((o) => o.garments.map((g) => g.name))));
    for (const n of ["Drake's Camel Field Games", 'DBF Grandfather Coat', "Drake's red polka-dot", 'Pima oxford — fatigue']) expect(names.has(n), n).toBe(false);
    const { byId } = await app.wardrobe();
    const benched = [...byId.values()].filter((i) => i.garment.planningPolicy === 'excluded').map((i) => i.garment.garmentId);
    expect(benched.length).toBeGreaterThan(5);
    const offeredIds = new Set([...boards.values()].flatMap((t) => offered(t).flatMap((o) => o.garments.map((g) => g.garmentId))));
    for (const b of benched) expect(offeredIds.has(b), byId.get(b)!.garment.name).toBe(false);
  });

  it('the belt line carries an optional scarf or tie flourish on the boards (often ignored, always welcome)', () => {
    const withFlourish = [...boards.values()].filter((t) => (t.board!.document!.options ?? []).some((o) => o.lines.some((l) => l.kind === 'belt' && l.flourish)));
    expect(withFlourish.length, 'boards whose belt line suggests a scarf or tie').toBeGreaterThanOrEqual(Math.ceil(boards.size / 2));
  });

  it('a swap never falls back to navy: the first (default) swap candidate is never navy, on any option of the last board', async () => {
    const date = DAYS.at(-1)!.date;
    world.clock.set(morningOf(date, '06:45'));
    const t = boards.get(date)!;
    const { byId } = await app.wardrobe();
    const navyOffers: string[] = [];
    let navyFirst = 0;
    for (const o of offered(t)) {
      for (const role of ['base_top', 'bottom'] as const) {
        const r = await app.get<{ candidates: { garmentId: string; name: string }[] }>(`/v1/today/options/${o.option.optionId}/swaps?role=${role}`);
        expect(r.status).toBe(200);
        r.body.candidates.forEach((c, i) => {
          if (isNavy(byId.get(c.garmentId)!.garment)) {
            navyOffers.push(`option ${o.option.position} ${role} #${i + 1}: ${c.name}`);
            if (i === 0) navyFirst++;
          }
        });
      }
    }
    expect(navyFirst, `navy offered as the first swap: ${navyOffers.join('; ')}`).toBe(0);
  });

  it('the Swap list offers no navy pieces at all (profile rule 6: never fall back to navy when a piece is swapped out)', async () => {
    const date = DAYS.at(-1)!.date;
    world.clock.set(morningOf(date, '06:45'));
    const t = boards.get(date)!;
    const { byId } = await app.wardrobe();
    const navyOffers: string[] = [];
    for (const o of offered(t)) {
      for (const role of ['base_top', 'bottom'] as const) {
        const r = await app.get<{ candidates: { garmentId: string; name: string }[] }>(`/v1/today/options/${o.option.optionId}/swaps?role=${role}`);
        r.body.candidates.forEach((c, i) => {
          if (isNavy(byId.get(c.garmentId)!.garment)) navyOffers.push(`option ${o.option.position} ${role} #${i + 1}: ${c.name}`);
        });
      }
    }
    expect(navyOffers.join('\n'), 'swap candidates offered in navy').toBe('');
  });

  it('the daily service’s own swap replaces only that slot, never with navy', async () => {
    const date = DAYS.at(-1)!.date;
    const t = boards.get(date)!;
    const rec = new RecommendationService({ db: env.DB, principal: owner.principal, weather: world.weather, calendar: world.calendar, clock: world.clock.now });
    // Try each option in turn: a swap may honestly find no valid replacement for one option.
    const outcomes: string[] = [];
    let target = offered(t)[0]!;
    let out: Awaited<ReturnType<typeof rec.swap>> | null = null;
    for (const candidate of offered(t)) {
      const r = await rec.swap({ boardDate: date, optionId: candidate.option.optionId, role: 'base_top' });
      outcomes.push(`option ${candidate.option.position}: ${r.status}`);
      if (r.changed) {
        target = candidate;
        out = r;
        break;
      }
    }
    expect(out?.changed, `no option could swap its shirt: ${outcomes.join('; ')}`).toBe(true);
    const before = target.byRole('base_top')[0]!;
    const after = await app.today(date);
    const replaced = offered(after).find((o) => o.doc?.lineage.previousOptionId === target.option.optionId || o.option.optionId === target.option.optionId)!;
    const top = replaced.byRole('base_top')[0]!;
    expect(top.garmentId).not.toBe(before.garmentId);
    expect(isNavy(top), `swap chose ${top.name}`).toBe(false);
    for (const role of ['bottom', 'socks', 'footwear']) expect(replaced.byRole(role).map((g) => g.garmentId)).toEqual(target.byRole(role).map((g) => g.garmentId));
  });

  it('indigo jeans are named light, mid or dark wherever they appear (coloured denim keeps its colour name)', async () => {
    const { byId } = await app.wardrobe();
    const jeans = [...byId.values()].filter((i) => i.garment.category === 'jeans' && /indigo|blue|denim/i.test(`${i.garment.color ?? ''} ${i.garment.colorFamily ?? ''}`) && !/white|olive|black|ecru/i.test(i.garment.color ?? ''));
    for (const i of jeans) expect(i.garment.name).toMatch(/\b(light|mid|dark)\b/i);
    for (const n of ['Jeans — light', 'Jeans — mid', 'Jeans — dark']) expect([...byId.values()].some((i) => i.garment.name === n), n).toBe(true);
  });

  it('board text never shows maker codes, job traces or laundry diagnostics inside the outfit copy', () => {
    for (const t of boards.values()) {
      const text = t.board!.document!.text;
      expect(text).not.toMatch(/PCF\d|g_[a-z0-9]{8}|opt_|cmd_|hamper|estimat|probab/i);
    }
  });
});

describe('Journey: once the owner says his feet have healed, every outfit names a sneaker and a welted alternative', () => {
  let owner: Owner;
  let app: App;

  beforeAll(async () => {
    installWorld({ now: '2026-10-05T19:00:00.000Z', weather: { byDate: { '2026-10-06': 'elevenToNineteen', '2026-10-07': 'heavyRain' } } });
    owner = await seedOwner();
    app = new App(owner.assertion);
  });

  it('the restriction holds until the owner’s statement, then the pairing applies with every other rule', async () => {
    await app.prepare({ date: '2026-10-06' });
    const before = await app.today('2026-10-06');
    const w0 = before.board!.document!.weather;
    expect(hardConstraintViolations(before, { peakC: w0.peakTempC!, departureC: w0.departureTempC! }).join('\n')).toBe('');
    const paraboot = await owner.byName('Paraboot Norwegian split-toe');
    const restriction = ItemDetail.parse((await app.get(`/v1/items/${paraboot}`)).body).restrictions.find((r) => r.liftedAt === null)!;
    // Elapsed time and the scheduler are not evidence: only the owner lifts it.
    const lift = await app.commit({ type: 'lift_restriction', restrictionId: restriction.restrictionId, evidence: 'My feet have healed.' });
    expectDoneReceipt(lift);
    for (const date of ['2026-10-06', '2026-10-07']) {
      await app.prepare({ date });
      const t = await app.today(date);
      const w = t.board!.document!.weather;
      expectGlanceableBoard(t);
      expect(hardConstraintViolations(t, { peakC: w.peakTempC!, departureC: w.departureTempC!, sneakersOnly: false }).join('\n'), date).toBe('');
      for (const o of offered(t)) expect(o.doc!.footwear.map((f) => f.kind).sort(), `option ${o.option.position}`).toEqual(['sneaker', 'welted']);
    }
  });
});

describe('Journey: a profile edit changes the next board and turn; a one-day exception does not rewrite the profile', () => {
  let world: World;
  let owner: Owner;
  let app: App;

  beforeAll(async () => {
    world = installWorld({ now: '2026-10-05T19:00:00.000Z', weather: { scenario: 'mild' } });
    assistantWorld(world);
    owner = await seedOwner();
    app = new App(owner.assertion);
  });

  it('a one-day exception is dated and scoped: the profile document is untouched and the rule returns the next day', async () => {
    const cords = await owner.byName('Stratton stretch corduroy');
    world.clock.set('2026-10-05T07:00:00.000Z');
    await app.commit({ type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-05', items: [{ garmentId: cords, role: 'bottom' }] });
    world.clock.set('2026-10-05T19:00:00.000Z');
    const brief = await app.commit({ type: 'set_temporary_brief', text: 'Happy to repeat the Stratton cords tomorrow.', validFrom: '2026-10-06', validTo: '2026-10-06', overridesRuleKey: 'hard.variety_seven_days' });
    expectDoneReceipt(brief);
    const style = StyleCurrentResponse.parse((await app.get('/v1/style/current')).body);
    expect(style.document.version).toBe(1);
    expect(style.document.contentSha256).toBe(PROFILE_SHA256);
    expect(style.document.body).toBe(PROFILE_TEXT);
    await app.prepare({ date: '2026-10-06' });
    const record = await getRevisionRecord(env.DB, owner.principal, (await app.today('2026-10-06')).board!.boardId, (await app.today('2026-10-06')).board!.currentRevision);
    expect(JSON.stringify((record!.context as { style: { briefs: unknown } }).style.briefs)).toContain('Stratton');
    // Next day the seven-day rule applies again: the cords are not offered.
    world.clock.set('2026-10-06T19:00:00.000Z');
    await app.prepare({ date: '2026-10-07' });
    const next = await app.today('2026-10-07');
    expect(noRepeatWithinWeek(next, new Set([cords])).join('\n')).toBe('');
  });

  it('a hard medical rule cannot be excepted, not even for one day', async () => {
    const r = await app.command({ type: 'set_temporary_brief', text: 'Sockless loafers today.', validFrom: '2026-10-08', validTo: '2026-10-08', overridesRuleKey: 'hard.socks_always' });
    expectNotDone(r.receipt);
    world.clock.set('2026-10-07T19:00:00.000Z');
    await app.prepare({ date: '2026-10-08' });
    const t = await app.today('2026-10-08');
    for (const o of offered(t)) expect(o.byRole('socks').length).toBeGreaterThan(0);
  });

  it('an edit in Settings > My style is a new verbatim version; the next board and the next turn use it', async () => {
    const style = StyleCurrentResponse.parse((await app.get('/v1/style/current')).body);
    const addition = '\n\nAmendment, 5 October 2026: cherry and gold oxfords are the current favourites; offer them early.\n';
    const edit = await app.commit({ type: 'edit_style_profile', documentId: style.document.documentId, baseVersion: style.document.version, body: style.document.body + addition, amendment: 'Autumn favourites.' });
    expectDoneReceipt(edit);
    const v2 = StyleCurrentResponse.parse((await app.get('/v1/style/current')).body);
    expect(v2.document.version).toBe(2);
    expect(v2.document.body.endsWith(addition)).toBe(true);
    expect(v2.document.contentSha256).not.toBe(PROFILE_SHA256);
    // A stale base version conflicts rather than overwriting.
    const stale = await app.command({ type: 'edit_style_profile', documentId: style.document.documentId, baseVersion: 1, body: style.document.body });
    expect(['conflict', 'rejected']).toContain(stale.receipt.outcome);
    // The next board's mandatory context carries version 2.
    world.clock.set('2026-10-08T19:00:00.000Z');
    await app.prepare({ date: '2026-10-09' });
    const t = await app.today('2026-10-09');
    const rec = await getRevisionRecord(env.DB, owner.principal, t.board!.boardId, t.board!.currentRevision);
    const docs = (rec!.context as { style: { documents: { version: number; sha256: string }[] } }).style.documents;
    expect(docs.map((d) => d.version)).toContain(2);
    expect(docs.map((d) => d.sha256)).toContain(v2.document.contentSha256);
    // The next conversation turn sees the new text, not a cached copy of the old one.
    resetModel();
    const turn = await app.post<{ runId: string }>('/v1/conversation/turns', { clientTurnId: uniq('ios'), text: 'Which shirt tomorrow?' });
    expect(turn.status).toBe(202);
    for (let i = 0; i < 200 && !chatCalls().length; i++) await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 200; i++) {
      const s = (await app.get<{ status: string }>(`/v1/runs/${turn.body.runId}`)).body;
      if (['finished', 'failed', 'cancelled'].includes(s.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(promptText(chatCalls()[0]!)).toContain('cherry and gold oxfords are the current favourites');
  });
});
