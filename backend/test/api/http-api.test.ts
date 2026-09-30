import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import {
  CommandReceipt,
  ConnectionsResponse,
  ItemDetail,
  LaundryState,
  ReceiptsPage,
  SettingsResponse,
  StyleCurrentResponse,
  TemperaturePreview,
  TodayResponse,
  WardrobePage,
} from '@garderobe/contracts';
import { apiOwner, call, callJson, idem, installApiScenario, prepareToday } from '../helpers/api.js';

/**
 * The native/web HTTP API against the owner's real profile and inventory (May 2026 CSV plus the
 * 2026-09-29 owner-asserted additions), through the Worker fetch handler on local workerd + D1.
 * Every response is parsed with the shared contract it promises.
 */

const PROFILE_SHA = 'e15639d8';

describe('HTTP API on the owner’s data', () => {
  let owner: Awaited<ReturnType<typeof apiOwner>>;
  let a: string;
  let today: TodayResponse;
  const q = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).all<Record<string, unknown>>()).results;

  beforeAll(async () => {
    installApiScenario({ now: '2026-10-06T05:30:00.000Z', scenario: 'elevenToNineteen' });
    owner = await apiOwner();
    a = owner.assertion;
    await prepareToday(a);
    today = TodayResponse.parse((await callJson('/v1/today', { assertion: a })).body);
  });

  describe('GET /v1/today', () => {
    it('returns the published revision with weather, the day line and display data for every garment on the board', () => {
      expect(today.date).toBe('2026-10-06');
      expect(today.board?.status).toBe('published');
      expect(today.board?.options.filter((o) => o.status === 'offerable').length).toBeGreaterThanOrEqual(3);
      expect(today.dayLine).toBe(today.board?.document?.dayLine);
      expect(today.dayLine).toMatch(/^Tuesday/);
      expect(today.weather).toMatchObject({ status: 'fresh' });
      expect(typeof today.weather?.peakTempC).toBe('number');
      expect(typeof today.weather?.morningTempC).toBe('number');
      expect(today.weather!.peakTempC!).toBeGreaterThanOrEqual(today.weather!.morningTempC!);
      const ids = new Set(today.board!.options.flatMap((o) => o.slots.map((s) => s.garmentId)));
      const shown = new Set(today.garments!.map((g) => g.garmentId));
      for (const id of ids) expect(shown.has(id), id).toBe(true);
      for (const g of today.garments!) {
        expect(g.name.length).toBeGreaterThan(0);
        expect(Array.isArray(g.aliases)).toBe(true);
        expect(g).toHaveProperty('media');
      }
      expect(today.sources.map((s) => s.source).sort()).toEqual(['board', 'calendar', 'wardrobe', 'weather']);
      expect(today.sources.find((s) => s.source === 'calendar')?.status).toBe('missing');
    });

    it('follows the owner’s profile: socks in every option, sneakers only while healing', () => {
      for (const o of today.board!.options) {
        expect(o.slots.some((s) => s.role === 'socks'), o.optionId).toBe(true);
        const shoes = o.slots.filter((s) => s.role === 'footwear').map((s) => today.garments!.find((g) => g.garmentId === s.garmentId)!);
        for (const s of shoes) expect(s.category, s.name).toBe('sneakers');
      }
    });

    it('reading never recomposes: two reads return the same revision', async () => {
      const again = TodayResponse.parse((await callJson('/v1/today', { assertion: a })).body);
      expect(again.board?.currentRevision).toBe(today.board?.currentRevision);
      expect(again.board?.boardId).toBe(today.board?.boardId);
    });

    it('offers validated swap candidates for one piece without changing the board', async () => {
      const opt = today.board!.options[0]!;
      const r = await callJson<{ candidates: { garmentId: string; name: string }[]; role: string }>(`/v1/today/options/${opt.optionId}/swaps?role=base_top`, { assertion: a });
      expect(r.status).toBe(200);
      expect(r.body.role).toBe('base_top');
      const inOption = new Set(opt.slots.map((s) => s.garmentId));
      for (const c of r.body.candidates) expect(inOption.has(c.garmentId)).toBe(false);
      const after = TodayResponse.parse((await callJson('/v1/today', { assertion: a })).body);
      expect(after.board?.currentRevision).toBe(today.board?.currentRevision);
    });

    it('rejects a malformed date', async () => {
      expect((await callJson('/v1/today?date=tomorrow', { assertion: a })).status).toBe(422);
    });
  });

  describe('GET /v1/wardrobe', () => {
    it('returns the complete owner inventory with explicit totals and counts', async () => {
      const page = WardrobePage.parse((await callJson('/v1/wardrobe', { assertion: a })).body);
      expect(page.total).toBe(144);
      expect(page.items).toHaveLength(144);
      expect(page.complete).toBe(true);
      expect(page.nextCursor).toBeNull();
      expect(page.counts.owned + page.counts.incoming + page.counts.retired).toBe(144);
      expect(page.items.every((i) => 'media' in i)).toBe(true);
    });

    it('paginates with an explicit incomplete flag and a cursor', async () => {
      const first = WardrobePage.parse((await callJson('/v1/wardrobe?limit=50', { assertion: a })).body);
      expect(first.items).toHaveLength(50);
      expect(first.complete).toBe(false);
      expect(first.total).toBe(144);
      const ids = new Set(first.items.map((i) => i.garment.garmentId));
      let cursor = first.nextCursor;
      while (cursor) {
        const next = WardrobePage.parse((await callJson(`/v1/wardrobe?limit=50&cursor=${cursor}`, { assertion: a })).body);
        expect(next.complete).toBe(false);
        for (const i of next.items) ids.add(i.garment.garmentId);
        cursor = next.nextCursor;
      }
      expect(ids.size).toBe(144);
    });

    it('searches names, aliases and maker codes, and filters by category, availability, colour, location and last wear', async () => {
      const code = (await q("SELECT phrase, garment_id FROM garment_aliases WHERE user_id = ? AND kind = 'maker_code' AND phrase LIKE 'PCF%' LIMIT 1", owner.userId))[0]!;
      const byCode = WardrobePage.parse((await callJson(`/v1/wardrobe?q=${encodeURIComponent(String(code.phrase))}`, { assertion: a })).body);
      expect(byCode.items.map((i) => i.garment.garmentId)).toContain(code.garment_id);
      const socks = WardrobePage.parse((await callJson('/v1/wardrobe?category=socks', { assertion: a })).body);
      expect(socks.total).toBeGreaterThan(5);
      expect(socks.items.every((i) => i.garment.category === 'socks')).toBe(true);
      const unavailable = WardrobePage.parse((await callJson('/v1/wardrobe?availability=unavailable', { assertion: a })).body);
      expect(unavailable.items.every((i) => !i.availability.available && i.garment.acquisition === 'owned')).toBe(true);
      const incoming = WardrobePage.parse((await callJson('/v1/wardrobe?availability=incoming', { assertion: a })).body);
      expect(incoming.items.every((i) => i.garment.acquisition === 'incoming')).toBe(true);
      const home = WardrobePage.parse((await callJson('/v1/wardrobe?location=home', { assertion: a })).body);
      expect(home.items.every((i) => i.garment.location === 'home')).toBe(true);
      const fam = socks.items.find((i) => i.garment.colorFamily)?.garment.colorFamily;
      if (fam) {
        const byFam = WardrobePage.parse((await callJson(`/v1/wardrobe?colorFamily=${fam}`, { assertion: a })).body);
        expect(byFam.items.every((i) => i.garment.colorFamily === fam)).toBe(true);
      }
      const notWorn = WardrobePage.parse((await callJson('/v1/wardrobe?lastWornBefore=2026-10-01', { assertion: a })).body);
      expect(notWorn.total).toBe(144); // the import records no wear history
      expect((await callJson('/v1/wardrobe?availability=sometimes', { assertion: a })).status).toBe(422);
      expect((await callJson('/v1/wardrobe?ownerId=usr_x', { assertion: a })).status).toBe(422);
    });
  });

  describe('items, commands and receipts', () => {
    let shirt: string;
    let socks: string;
    beforeAll(async () => {
      const opt = today.board!.options[0]!;
      shirt = opt.slots.find((s) => s.role === 'base_top')!.garmentId;
      socks = opt.slots.find((s) => s.role === 'socks')!.garmentId;
    });

    it('GET /v1/items/{id} returns facts, restrictions, history, estimate, receipts and today’s combinations', async () => {
      const d = ItemDetail.parse((await callJson(`/v1/items/${shirt}`, { assertion: a })).body);
      expect(d.item.garment.garmentId).toBe(shirt);
      expect(d.combinations!.some((c) => c.optionId === today.board!.options[0]!.optionId)).toBe(true);
      expect((await callJson('/v1/items/g_doesnotexist', { assertion: a })).status).toBe(404);
    });

    it('another owner’s garment is not found (existence is not leaked)', async () => {
      const other = await apiOwner();
      const r = await callJson<{ error: { code: string } }>(`/v1/items/${shirt}`, { assertion: other.assertion });
      expect(r.status).toBe(404);
    });

    it('POST /v1/commands returns a verified receipt; a repeated key replays it; a changed body is refused', async () => {
      const key = idem();
      const body = { idempotencyKey: key, source: 'app', command: { type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-06', items: [{ garmentId: shirt }, { garmentId: socks }] } };
      const first = await callJson('/v1/commands', { assertion: a, body });
      expect(first.status).toBe(201);
      const r1 = CommandReceipt.parse(first.body);
      expect(r1.outcome).toBe('committed');
      expect(r1.affected.some((e) => e.entityType === 'daily_wear')).toBe(true);
      const again = CommandReceipt.parse((await callJson('/v1/commands', { assertion: a, body })).body);
      expect(again.commandId).toBe(r1.commandId);
      expect(again.replayed).toBe(true);
      const changed = await callJson<{ outcome: string; error: { code: string } }>('/v1/commands', { assertion: a, body: { ...body, command: { ...body.command, items: [{ garmentId: shirt }] } } });
      expect(changed.status).toBe(409);
      expect(changed.body.error.code).toBe('idempotency_key_reused');
      expect((await callJson(`/v1/commands/${r1.commandId}`, { assertion: a })).status).toBe(200);
      const td = TodayResponse.parse((await callJson('/v1/today', { assertion: a })).body);
      expect(td.recordedWears.map((w) => w.garmentId)).toEqual(expect.arrayContaining([shirt, socks]));
    });

    it('a second report of the same garment and date merges instead of counting twice', async () => {
      const r = CommandReceipt.parse((await callJson('/v1/commands', { assertion: a, body: { idempotencyKey: idem(), source: 'offline_replay', command: { type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-06', items: [{ garmentId: shirt }] } } })).body);
      expect(r.outcome).toBe('merged');
      const rows = await q("SELECT COUNT(*) AS n FROM daily_wears WHERE user_id = ? AND garment_id = ? AND wearing_date = '2026-10-06' AND status = 'active'", owner.userId, shirt);
      expect(rows[0]!.n).toBe(1);
    });

    it('stale expected versions on an edit return a conflict and write nothing', async () => {
      const s = SettingsResponse.parse((await callJson('/v1/settings', { assertion: a })).body);
      const body = { idempotencyKey: idem(), source: 'app', expectedVersions: [{ entityType: 'owner_settings', entityId: owner.userId, version: s.version + 5 }], command: { type: 'update_delivery_settings', dailyOptionCount: 4 } };
      const r = await callJson<{ outcome: string }>('/v1/commands', { assertion: a, body });
      expect(r.status).toBe(409);
      expect(r.body.outcome).toBe('conflict');
    });

    it('update_delivery_settings changes time, count and calendar through the command service', async () => {
      const before = SettingsResponse.parse((await callJson('/v1/settings', { assertion: a })).body);
      const r = CommandReceipt.parse((await callJson('/v1/commands', { assertion: a, body: { idempotencyKey: idem(), source: 'app', command: { type: 'update_delivery_settings', deliveryTime: '06:45', dailyOptionCount: 4, calendarId: 'garderobe-outfits' } } })).body);
      expect(r.outcome).toBe('committed');
      expect(r.summary).toContain('06:45');
      const after = SettingsResponse.parse((await callJson('/v1/settings', { assertion: a })).body);
      expect(after).toMatchObject({ deliveryTime: '06:45', dailyOptionCount: 4, calendarId: 'garderobe-outfits', version: before.version + 1 });
      const bad = await callJson('/v1/commands', { assertion: a, body: { idempotencyKey: idem(), source: 'app', command: { type: 'update_delivery_settings', dailyOptionCount: 9 } } });
      expect(bad.status).toBe(422);
    });

    it('save_combination is stored; plan_outfit is checked against the day first', async () => {
      // An earlier test records a wear of option 1's shirt and socks today, so plan an option that does not share that sock pair.
      const firstSocks = today.board!.options[0]!.slots.find((s) => s.role === 'socks')?.garmentId;
      const opt = today.board!.options.find((o, i) => i > 0 && o.status === 'offerable' && !o.slots.some((s) => s.role === 'socks' && s.garmentId === firstSocks))!;
      const slots = opt.slots.map((s) => ({ garmentId: s.garmentId, role: s.role, alternativeGroup: s.alternativeGroup }));
      const saved = CommandReceipt.parse((await callJson('/v1/commands', { assertion: a, body: { idempotencyKey: idem(), source: 'app', command: { type: 'save_combination', name: 'Tuesday option', slots } } })).body);
      expect(saved.outcome).toBe('committed');
      // A shirt alone is not an outfit for the day (no trousers, socks or shoes): nothing is stored.
      const invalidSlots = [{ garmentId: slots.find((s) => s.role === 'base_top')!.garmentId, role: 'base_top' }];
      const invalid = await callJson<{ error: { code: string } }>('/v1/commands', { assertion: a, body: { idempotencyKey: idem(), source: 'app', command: { type: 'plan_outfit', date: '2026-10-06', slots: invalidSlots } } });
      expect(invalid.status).toBe(422);
      expect(invalid.body.error.code).toBe('plan_invalid_for_day');
      const valid = await callJson<{ outcome: string }>('/v1/commands', { assertion: a, body: { idempotencyKey: idem(), source: 'app', command: { type: 'plan_outfit', date: '2026-10-06', slots: slots.filter((s) => s.role !== 'footwear').concat(slots.filter((s) => s.role === 'footwear').slice(0, 1)) } } });
      expect(valid.status).toBe(201);
      expect(valid.body.outcome).toBe('committed');
    });

    it('restricts the channel a client may claim', async () => {
      const r = await callJson<{ error: { code: string } }>('/v1/commands', { assertion: a, body: { idempotencyKey: idem(), source: 'system', command: { type: 'laundry_collected' } } });
      expect(r.status).toBe(422);
    });

    it('GET /v1/receipts pages through every stored receipt, newest first', async () => {
      const p1 = ReceiptsPage.parse((await callJson('/v1/receipts?limit=2', { assertion: a })).body);
      expect(p1.receipts).toHaveLength(2);
      expect(p1.nextCursor).not.toBeNull();
      const p2 = ReceiptsPage.parse((await callJson(`/v1/receipts?limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}`, { assertion: a })).body);
      expect(p2.receipts[0]!.commandId).not.toBe(p1.receipts[1]!.commandId);
      expect(p1.receipts[0]!.recordedAt >= p1.receipts[1]!.recordedAt).toBe(true);
    });
  });

  describe('laundry, temperature preview, style, settings, connections', () => {
    it('GET /v1/laundry keeps service laundry and hand wash apart and reflects “In the wash”', async () => {
      const shirt = today.board!.options[2]!.slots.find((s) => s.role === 'base_top')!.garmentId;
      const r = CommandReceipt.parse((await callJson('/v1/commands', { assertion: a, body: { idempotencyKey: idem(), source: 'app', command: { type: 'mark_in_wash', garmentId: shirt } } })).body);
      expect(r.outcome).toBe('committed');
      const l = LaundryState.parse((await callJson('/v1/laundry', { assertion: a })).body);
      expect(l.service.hamper.map((h) => h.garmentId)).toContain(shirt);
      expect(l.handWash.hamper.map((h) => h.garmentId)).not.toContain(shirt);
      expect(l.service.nextCollectionAt).toMatch(/^2026-10-09T08:00/); // Friday 09:00 London (BST)
    });

    it('the temperature preview is labelled a simulation and changes nothing', async () => {
      const before = (await q('SELECT COUNT(*) AS n FROM command_receipts WHERE user_id = ?', owner.userId))[0]!.n;
      const p = TemperaturePreview.parse((await callJson('/v1/wardrobe/temperature-preview?temperatureC=4', { assertion: a })).body);
      expect(p.simulation).toBe(true);
      expect(p.note).toMatch(/^Simulation/);
      expect(p.items.length).toBeGreaterThan(20);
      expect(p.items.some((i) => i.wearable) && p.items.some((i) => !i.wearable)).toBe(true);
      const after = (await q('SELECT COUNT(*) AS n FROM command_receipts WHERE user_id = ?', owner.userId))[0]!.n;
      expect(after).toBe(before);
      expect((await callJson('/v1/wardrobe/temperature-preview?temperatureC=hot', { assertion: a })).status).toBe(422);
      expect((await callJson('/v1/wardrobe/temperature-preview', { assertion: a })).status).toBe(422);
    });

    it('GET /v1/style/current returns the owner’s profile verbatim with its hash and rule counts', async () => {
      const s = StyleCurrentResponse.parse((await callJson('/v1/style/current', { assertion: a })).body);
      expect(s.document.contentSha256.startsWith(PROFILE_SHA)).toBe(true);
      expect(s.document.version).toBe(1);
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s.document.body)))).map((b) => b.toString(16).padStart(2, '0')).join('');
      expect(digest).toBe(s.document.contentSha256);
      expect(s.rules.active).toBeGreaterThanOrEqual(41);
      expect(s.rules.hard).toBeGreaterThan(8);
      expect(s.rules.missingPassages).toBe(0);
    });

    it('GET /v1/settings exposes delivery, the style document, connected assistants and connection health', async () => {
      const s = SettingsResponse.parse((await callJson('/v1/settings', { assertion: a })).body);
      expect(s.timezone).toBe('Europe/London');
      expect(s.styleDocuments![0]!.contentSha256.startsWith(PROFILE_SHA)).toBe(true);
      expect(s.connectedAssistants).toEqual([]);
      expect(s.connections!.map((c) => c.kind)).toEqual(expect.arrayContaining(['gmail', 'calendar']));
      expect(s.models?.simulated).toBe(true);
    });

    it('GET /v1/connections lists Gmail and Calendar first with the capability each would enable', async () => {
      const c = ConnectionsResponse.parse((await callJson('/v1/connections', { assertion: a })).body);
      expect(c.connections.slice(0, 2).map((x) => x.kind)).toEqual(['gmail', 'calendar']);
      expect(c.connections[0]!.status).toBe('disconnected');
      expect(c.connections[0]!.capabilities[0]!.missingPermission).toBe('gmail.readonly');
      expect(JSON.stringify(c)).not.toMatch(/token|secret/i);
    });

    it('POST /v1/connections refuses private and credential-bearing endpoints', async () => {
      for (const endpoint of ['http://127.0.0.1:9000/mcp', 'https://169.254.169.254/latest', 'https://tools.example/mcp?api_key=abc123']) {
        const r = await callJson<{ error: { code: string } }>('/v1/connections', { assertion: a, body: { name: 'Bad', endpoint } });
        expect(r.status, endpoint).toBe(422);
        expect(['url_not_allowed', 'validation_failed']).toContain(r.body.error.code);
      }
      const ok = await callJson<{ kind: string; status: string; endpoint: string }>('/v1/connections', { assertion: a, body: { name: 'Stockist catalogue', endpoint: 'https://mcp.stockist.example/mcp', credentialSecretName: 'STOCKIST_KEY' } });
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({ kind: 'mcp', status: 'connected', endpoint: 'https://mcp.stockist.example/mcp' });
    });
  });

  describe('private web board', () => {
    it('renders today’s board from the same semantic document, behind Access', async () => {
      const res = await call('/board', { assertion: a });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      const page = await res.text();
      const doc = today.board!.document!;
      const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
      expect(page).toContain(esc(doc.dayLine));
      for (const o of doc.options.filter((x) => x.status === 'offerable')) {
        expect(page).toContain(esc(o.why));
        for (const l of o.lines) expect(page).toContain(esc(l.text));
      }
      expect(page).toContain(`revision ${today.board!.currentRevision}`);
      expect(page).not.toContain('<script');
    });

    it('requires Access (no anonymous access, no alternate hostname)', async () => {
      expect((await call('/board')).status).toBe(401);
      expect((await call('/board', { assertion: a, origin: 'https://garderobe.owner.workers.dev' })).status).toBe(403);
    });
  });

  it('answers unknown routes and methods with structured errors', async () => {
    const r = await callJson<{ schemaVersion: string; error: { code: string } }>('/v1/nope', { assertion: a });
    expect(r.status).toBe(404);
    expect(r.body.schemaVersion).toBe('2026-10-01');
    expect((await callJson('/v1/today', { assertion: a, method: 'DELETE' })).status).toBe(405);
    expect((await call('/v1/commands', { assertion: a, method: 'POST', headers: { 'content-type': 'text/plain' } })).status).toBe(415);
  });
});
