import { beforeAll, describe, expect, it } from 'vitest';
import { SettingsResponse, StyleCurrentResponse, TodayResponse, WardrobePage, ItemDetail } from '@garderobe/contracts';
import { PROFILE_SHA256, PROFILE_TEXT, seedOwner, type Owner } from '../harness/owner.js';
import { App } from '../harness/http.js';
import { installWorld, type World } from '../harness/world.js';
import { expectGlanceableBoard } from '../harness/ux.js';
import { hardConstraintViolations, offered } from '../harness/profile.js';
import { connectAssistant, connectMcp } from '../harness/mcp.js';

/**
 * Journey 1 — First use (spec section 3 "First use", section 6 "Apply the supplied profile
 * faithfully"). The owner signs in and finds the imported wardrobe and style document, not a blank
 * form; Settings > My style shows the supplied profile byte for byte; the first sample board uses
 * that profile and the reconciled inventory; missing photographs block nothing; the temporary
 * sneakers-only restriction stays until an explicit update, however much time passes.
 */

const sha256 = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, '0')).join('');

describe('Journey: first use with the imported profile, inventory and a sample board', () => {
  let world: World;
  let owner: Owner;
  let app: App;

  beforeAll(async () => {
    world = installWorld({ now: '2026-10-05T19:00:00.000Z', weather: { scenario: 'mild' } });
    owner = await seedOwner();
    app = new App(owner.assertion);
  });

  it('signs in through Access and lands on the owner, with no board invented before one is prepared', async () => {
    const session = await app.get<{ displayName: string; authenticatedBy: string; scopes: string[] }>('/v1/auth/session');
    expect(session.status).toBe(200);
    expect(session.body.displayName).toBe('Chris');
    expect(session.body.scopes).toEqual(expect.arrayContaining(['wardrobe:read', 'wardrobe:write']));
    const t = await app.today('2026-10-06');
    expect(t.board).toBeNull();
    expect(t.sources.find((s) => s.source === 'board')?.status).toBe('missing');
  });

  it('the stored profile is byte-identical to the supplied file, with the spec’s hash, in Settings > My style', async () => {
    expect(await sha256(PROFILE_TEXT)).toBe(PROFILE_SHA256);
    const style = StyleCurrentResponse.parse((await app.get('/v1/style/current')).body);
    expect(style.document.body).toBe(PROFILE_TEXT);
    expect(style.document.contentSha256).toBe(PROFILE_SHA256);
    expect(await sha256(style.document.body)).toBe(PROFILE_SHA256);
    expect(style.document.version).toBe(1);
    expect(style.rules.active).toBeGreaterThanOrEqual(41);
    expect(style.rules.missingPassages).toBe(0);
    const settings = SettingsResponse.parse((await app.get('/v1/settings')).body);
    expect(settings.styleDocuments?.map((d) => d.contentSha256)).toContain(PROFILE_SHA256);
    expect(settings.timezone).toBe('Europe/London');
    expect(settings.deliveryTime).toBe('07:00');
    expect(settings.dailyOptionCount).toBe(5);
  });

  it('the same profile reaches a connected assistant verbatim (MCP resource)', async () => {
    const grant = await connectAssistant(owner.assertion, 'claude', ['wardrobe:read']);
    const mcp = await connectMcp(grant.accessToken);
    const r = await mcp.client.readResource({ uri: 'garderobe://style/current' });
    expect((r.contents[0] as { text: string }).text).toBe(PROFILE_TEXT);
    await mcp.close();
  });

  it('the wardrobe is the owner’s real imported inventory: 127 CSV garments plus the 17 owner-asserted additions', async () => {
    expect(owner.garmentCount).toBe(144);
    const { page, byId } = await app.wardrobe();
    expect(page.total).toBe(144);
    expect(byId.size).toBe(144);
    const names = [...byId.values()].map((i) => i.garment.name);
    for (const n of ['Lightweight oxford — light blue wide stripe', 'Di Sondrio walnut chino', 'NB 990v4 — grey', 'NB 990v6', 'Jeans — mid', 'Paraboot Norwegian split-toe', 'Multi-stripe rugby']) expect(names, n).toContain(n);
    // Owner-asserted additions keep unknown colour, maker and size as unknown (null), never guessed.
    // (The rugby's XL comes from the profile's own sentence "Rugbies: XL."; the 993's pair size is not stated.)
    const nb993 = [...byId.values()].find((i) => i.garment.name === 'NB 993')!;
    expect(nb993.garment.color).toBeNull();
    expect(nb993.garment.sizeLabel).toBeNull();
    expect([...byId.values()].find((i) => i.garment.name === 'Multi-stripe rugby')!.garment.sizeLabel).toBe('XL');
    // No invented wear history: zero recorded wears means not recorded.
    expect([...byId.values()].every((i) => i.recordedWearCount === 0 && i.lastRecordedWear === null)).toBe(true);
    // Counts distinguish owned, available, incoming and retired.
    expect(page.counts.owned).toBe(144);
    expect(page.counts.available).toBeLessThan(page.counts.owned);
  });

  it('prepares a sample board of five complete, named outfits from the profile and inventory, with no photographs needed', async () => {
    const prep = await app.prepare({ date: '2026-10-06' });
    expect(prep.published).toBe(true);
    const t = await app.today('2026-10-06');
    expectGlanceableBoard(t, { requested: 5 });
    expect(offered(t)).toHaveLength(5);
    // Missing photographs do not block recommendations.
    expect((t.garments ?? []).every((g) => g.media === null || g.media === undefined || typeof g.media === 'object')).toBe(true);
    const doc = t.board!.document!;
    expect(doc.weather.status).toBe('fresh');
    expect(hardConstraintViolations(t, { peakC: doc.weather.peakTempC!, departureC: doc.weather.departureTempC! }).join('\n')).toBe('');
    // The home key is the floor, never the only thing offered: the board spreads registers.
    const registers = new Set(doc.options.filter((o) => o.status === 'offerable').map((o) => o.register));
    expect(registers.size).toBeGreaterThanOrEqual(2);
    expect([...registers].every((r) => r === 'home_key')).toBe(false);
  });

  it('keeps the profile’s temporary sneakers-only restriction until an explicit update: elapsed time is not recovery', async () => {
    const paraboot = await owner.byName('Paraboot Norwegian split-toe');
    const d0 = ItemDetail.parse((await app.get(`/v1/items/${paraboot}`)).body);
    expect(d0.item.availability.available).toBe(false);
    expect(d0.restrictions.some((r) => r.liftedAt === null)).toBe(true);
    world.clock.set('2027-01-12T06:30:00.000Z'); // three months later
    const d1 = ItemDetail.parse((await app.get(`/v1/items/${paraboot}`)).body);
    expect(d1.restrictions.some((r) => r.liftedAt === null)).toBe(true);
    expect(d1.item.availability.available).toBe(false);
    await app.prepare({ date: '2027-01-12' });
    const t = await app.today('2027-01-12');
    expect(offered(t).flatMap((o) => o.byRole('footwear')).every((g) => g.category === 'sneakers' && !/990v6/.test(g.name))).toBe(true);
    world.clock.set('2026-10-05T19:00:00.000Z');
  });

  it('the wardrobe page is complete in one response for a few hundred items (no silent truncation)', async () => {
    const page = WardrobePage.parse((await app.get('/v1/wardrobe')).body);
    expect(page.complete).toBe(true);
    expect(page.items).toHaveLength(page.total);
    expect(TodayResponse.safeParse((await app.get('/v1/today?date=2026-10-06')).body).success).toBe(true);
  });
});
