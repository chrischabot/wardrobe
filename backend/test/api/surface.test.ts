import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import {
  CommandReceipt,
  ComfortFeedbackResponse,
  ImportResponse,
  ItemDetail,
  LifecycleProjectsResponse,
  OrdersResponse,
  PackingProposalResponse,
  PrepareBoardResponse,
  RecoverResponse,
  RecoveryKitResponse,
  ReturnDeadlinesResponse,
  RunInputResponse,
  SavedCombinationsResponse,
  ServicePauseState,
  SwapCandidates,
  TodayResponse,
  TripDetail,
  TripsResponse,
  UploadAuthorization,
  UploadReceiveResponse,
  WardrobePage,
  EmailSyncResponse,
} from '@garderobe/contracts';
import '../helpers/assistant.js';
import { accessToken, apiOwner, call, callJson, idem, installApiScenario, prepareToday, type ApiClock } from '../helpers/api.js';
import { connectMcp, mcpGrant } from '../helpers/mcp.js';
import { makePng } from '../helpers/visual.js';
import { installApiTestOverrides } from '../../src/api/services.js';
import { installTestGmail } from '../../src/api/surface.js';
import { FakeCalendar } from '../../src/calendar/fake.js';
import { FakeGmail } from '../../src/connectors/google.js';
import { FakeWeatherProvider } from '../../src/weather/fake.js';
import { b64urlEncode, randomToken } from '../../src/auth/jose.js';

/**
 * The API-surface defects the journey suite found, and the routes that close its surface gaps. Every
 * request goes through the Worker fetch handler on local workerd + D1, on the owner's real data.
 */

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { type: string; text?: string }[] };
const q = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).all<Record<string, unknown>>()).results;

describe('availability follows laundry and trips (Wardrobe, item page, garderobe_inventory)', () => {
  let owner: Awaited<ReturnType<typeof apiOwner>>;
  let a: string;
  let shirt: string;
  beforeAll(async () => {
    installApiScenario({ now: '2026-10-06T05:30:00.000Z' });
    owner = await apiOwner();
    a = owner.assertion;
    shirt = await owner.byName('Lightweight oxford — gold');
  });

  const item = async (id: string) => ItemDetail.parse((await callJson(`/v1/items/${id}`, { assertion: a })).body).item;

  it('a clean shirt is available; In the wash makes it unavailable everywhere, with an owner-language label', async () => {
    expect((await item(shirt)).availability).toMatchObject({ available: true, label: 'Available' });
    const r = CommandReceipt.parse((await callJson('/v1/commands', { assertion: a, body: { idempotencyKey: idem(), source: 'app', command: { type: 'mark_in_wash', garmentId: shirt } } })).body);
    expect(r.outcome).toBe('committed');
    expect((await item(shirt)).availability).toMatchObject({ available: false, label: 'In the wash' });
    const avail = WardrobePage.parse((await callJson('/v1/wardrobe?availability=available&category=shirt', { assertion: a })).body);
    expect(avail.items.map((i) => i.garment.garmentId)).not.toContain(shirt);
    const unavail = WardrobePage.parse((await callJson('/v1/wardrobe?availability=unavailable&category=shirt', { assertion: a })).body);
    expect(unavail.items.map((i) => i.garment.garmentId)).toContain(shirt);
    const c = await connectMcp((await mcpGrant(a, 'claude', ['wardrobe:read'])).accessToken);
    const inv = (await c.client.callTool({ name: 'garderobe_inventory', arguments: { view: 'item', garmentId: shirt } })) as ToolResult;
    expect((inv.structuredContent!.item as { item: { availability: { available: boolean } } }).item.availability.available).toBe(false);
    await c.close();
  });

  it('collected for the laundry service it reads “At the laundry”; washed, it is available again', async () => {
    await callJson('/v1/commands', { assertion: a, body: { idempotencyKey: idem(), source: 'app', command: { type: 'laundry_collected' } } });
    expect((await item(shirt)).availability).toMatchObject({ available: false, label: 'At the laundry' });
    await callJson('/v1/commands', { assertion: a, body: { idempotencyKey: idem(), source: 'app', command: { type: 'laundry_returned' } } });
    expect((await item(shirt)).availability.available).toBe(true);
  });

  it('the item page lists that item’s wear receipts and every other receipt that affected it', async () => {
    const wear = CommandReceipt.parse((await callJson('/v1/commands', { assertion: a, body: { idempotencyKey: idem(), source: 'app', command: { type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-06', items: [{ garmentId: shirt }] } } })).body);
    const d = ItemDetail.parse((await callJson(`/v1/items/${shirt}`, { assertion: a })).body);
    expect(d.receipts.map((r) => r.commandId)).toContain(wear.commandId);
    expect(d.receipts.map((r) => r.commandType)).toEqual(expect.arrayContaining(['record_wear', 'mark_in_wash', 'laundry_collected', 'laundry_returned']));
    // Another garment's page does not show this wear.
    const other = await owner.byName('Clark oxford — beige');
    expect(ItemDetail.parse((await callJson(`/v1/items/${other}`, { assertion: a })).body).receipts.map((r) => r.commandId)).not.toContain(wear.commandId);
  });
});

describe('trips and packing through the API and MCP; the trip-day board on Today', () => {
  let owner: Awaited<ReturnType<typeof apiOwner>>;
  let a: string;
  let clock: ApiClock;
  let tripId: string;
  let packedShirt: string;
  beforeAll(async () => {
    ({ clock } = installApiScenario({ now: '2026-10-05T17:00:00.000Z' }));
    owner = await apiOwner();
    a = owner.assertion;
  });

  it('POST /v1/trips creates a trip once per Idempotency-Key; the proposal packs nothing', async () => {
    const body = { name: 'Paris', departsOn: '2026-10-09', returnsOn: '2026-10-11', destinations: [{ label: 'Paris', latitude: 48.8566, longitude: 2.3522, timezone: 'Europe/Paris' }], luggage: 'carry-on' };
    const key = idem('trip');
    const created = await callJson('/v1/trips', { assertion: a, body, headers: { 'idempotency-key': key } });
    expect(created.status).toBe(201);
    const t = TripDetail.parse(created.body);
    tripId = t.trip.tripId;
    expect(t.trip).toMatchObject({ status: 'planned', timezone: 'Europe/Paris' });
    const again = await callJson<{ replayed: boolean; trip: { tripId: string } }>('/v1/trips', { assertion: a, body, headers: { 'idempotency-key': key } });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, trip: { tripId } });
    expect((await callJson('/v1/trips', { assertion: a, body: { ...body, name: 'Rome' }, headers: { 'idempotency-key': key } })).status).toBe(409);
    expect(TripsResponse.parse((await callJson('/v1/trips', { assertion: a })).body).trips).toHaveLength(1);
    const p = PackingProposalResponse.parse((await callJson(`/v1/trips/${tripId}/proposal`, { assertion: a, body: {} })).body);
    expect(p.days.map((d) => d.date)).toEqual(['2026-10-09', '2026-10-10', '2026-10-11']);
    const d = TripDetail.parse((await callJson(`/v1/trips/${tripId}`, { assertion: a })).body);
    expect(d.items.every((i) => i.proposedQty > 0 && i.packedQty === 0)).toBe(true);
  });

  it('Packed takes the pieces out of the home Wardrobe (“Packed for a trip”)', async () => {
    clock.set('2026-10-08T18:00:00.000Z');
    const r = TripDetail.parse((await callJson(`/v1/trips/${tripId}/packed`, { assertion: a, body: {} })).body);
    expect(r.trip.status).toBe('packed');
    expect(r.summary).toMatch(/^Packed for Paris/);
    const units = new Map((await q("SELECT garment_id, tracking FROM garments WHERE user_id = ?", owner.userId)).map((g) => [String(g.garment_id), String(g.tracking)]));
    packedShirt = r.items.find((i) => i.packedQty > 0 && units.get(i.garmentId) === 'unit' && /oxford|shirt|plaid/i.test(i.name ?? ''))!.garmentId;
    const d = ItemDetail.parse((await callJson(`/v1/items/${packedShirt}`, { assertion: a })).body);
    expect(d.item.availability).toMatchObject({ available: false, label: 'Packed for a trip' });
  });

  it('on a trip day, prepare and GET /v1/today serve the trip board from the suitcase, and garderobe_today returns the same revision', async () => {
    clock.set('2026-10-09T05:00:00.000Z');
    const prep = PrepareBoardResponse.parse((await callJson('/v1/today/prepare', { assertion: a, body: {} })).body);
    expect(prep).toMatchObject({ published: true, purpose: `trip:${tripId}`, date: '2026-10-09' });
    const t = TodayResponse.parse((await callJson('/v1/today', { assertion: a })).body);
    expect(t.purpose).toBe(`trip:${tripId}`);
    expect(t.trip).toMatchObject({ tripId, name: 'Paris', timezone: 'Europe/Paris' });
    expect(t.board!.purpose).toBe(`trip:${tripId}`);
    const packed = new Set(TripDetail.parse((await callJson(`/v1/trips/${tripId}`, { assertion: a })).body).items.filter((i) => i.packedQty > 0).map((i) => i.garmentId));
    for (const o of t.board!.options) for (const s of o.slots) expect(packed.has(s.garmentId), s.garmentId).toBe(true);
    const c = await connectMcp((await mcpGrant(a, 'claude')).accessToken);
    const mcpToday = TodayResponse.parse(((await c.client.callTool({ name: 'garderobe_today', arguments: {} })) as ToolResult).structuredContent);
    expect([mcpToday.board!.boardId, mcpToday.board!.currentRevision, mcpToday.purpose]).toEqual([t.board!.boardId, t.board!.currentRevision, t.purpose]);
    const trips = (await c.client.callTool({ name: 'garderobe_inventory', arguments: { view: 'trip', tripId } })) as ToolResult;
    expect(((trips.structuredContent!.records as { trip: { status: string } }[])[0]!.trip.status)).toBe('packed');
    await c.close();
  });

  it('garderobe_command reaches the trip operations; a read-only grant gets a proposal only', async () => {
    const ro = await connectMcp((await mcpGrant(a, 'chatgpt', ['wardrobe:read'])).accessToken);
    const before = (await q('SELECT COUNT(*) AS n FROM trips WHERE user_id = ?', owner.userId))[0]!.n;
    const prop = (await ro.client.callTool({ name: 'garderobe_command', arguments: { idempotencyKey: idem('mcp'), operation: { type: 'create_trip', name: 'Oslo', departsOn: '2026-11-01', returnsOn: '2026-11-03', destinations: [{ label: 'Oslo', timezone: 'Europe/Oslo' }] } } })) as ToolResult;
    expect(prop.structuredContent).toMatchObject({ status: 'proposal', receipt: null });
    expect((await q('SELECT COUNT(*) AS n FROM trips WHERE user_id = ?', owner.userId))[0]!.n).toBe(before);
    await ro.close();
    const w = await connectMcp((await mcpGrant(a, 'claude')).accessToken);
    const key = idem('mcp');
    const args = { idempotencyKey: key, operation: { type: 'mark_unpacked', tripId } };
    const un = (await w.client.callTool({ name: 'garderobe_command', arguments: args })) as ToolResult;
    expect(un.structuredContent).toMatchObject({ status: 'executed', operation: { operation: 'mark_unpacked', replayed: false } });
    const again = (await w.client.callTool({ name: 'garderobe_command', arguments: args })) as ToolResult;
    expect(again.structuredContent).toMatchObject({ operation: { replayed: true } });
    const both = (await w.client.callTool({ name: 'garderobe_command', arguments: { idempotencyKey: idem('mcp'), command: { type: 'laundry_collected' }, operation: { type: 'propose_packing', tripId } } })) as ToolResult;
    expect(both.isError).toBe(true);
    await w.close();
    expect(TripDetail.parse((await callJson(`/v1/trips/${tripId}`, { assertion: a })).body).trip.status).toBe('completed');
  });
});

describe('a command from the app repairs the board and the outfit calendar immediately', () => {
  it('mark_in_wash on an offered shirt revises the board and inserts the managed event before the response returns', async () => {
    const clock = { value: '2026-10-05T20:00:00.000Z', now: () => clock.value };
    const calendar = new FakeCalendar(clock.now);
    installApiTestOverrides({ weather: new FakeWeatherProvider({ scenario: 'mild', clock: clock.now }), calendar, clock: clock.now });
    const owner = await apiOwner();
    await callJson('/v1/commands', { assertion: owner.assertion, body: { idempotencyKey: idem(), source: 'app', command: { type: 'update_delivery_settings', calendarId: 'garderobe-outfits' } } });
    expect((await callJson('/v1/today/prepare', { assertion: owner.assertion, body: { date: '2026-10-06' } })).status).toBe(200);
    const t = TodayResponse.parse((await callJson('/v1/today?date=2026-10-06', { assertion: owner.assertion })).body);
    const shirt = t.board!.options[0]!.slots.find((s) => s.role === 'base_top')!.garmentId;
    const r = await callJson('/v1/commands', { assertion: owner.assertion, body: { idempotencyKey: idem(), source: 'app', command: { type: 'mark_in_wash', garmentId: shirt } } });
    expect(r.status).toBe(201);
    // No sleep, no sweep: the repair ran as part of the command request.
    const after = TodayResponse.parse((await callJson('/v1/today?date=2026-10-06', { assertion: owner.assertion })).body);
    expect(after.board!.currentRevision).toBeGreaterThan(t.board!.currentRevision);
    expect(after.board!.options.flatMap((o) => o.slots.map((s) => s.garmentId))).not.toContain(shirt);
    expect(calendar.inserts).toBe(1);
    const ev = [...calendar.managed.values()][0] as unknown as { description?: string };
    expect(ev.description ?? '').toContain(after.board!.document!.options[0]!.why);
    const effects = await q("SELECT status FROM command_effects WHERE user_id = ? AND kind = 'board_revalidation'", owner.userId);
    expect(effects.every((e) => e.status !== 'pending')).toBe(true);
  });
});

describe('pause and resume as commands with receipts and Undo', () => {
  let owner: Awaited<ReturnType<typeof apiOwner>>;
  let a: string;
  beforeAll(async () => {
    installApiScenario({ now: '2026-10-05T17:00:00.000Z' });
    owner = await apiOwner();
    a = owner.assertion;
  });
  const state = async () => ServicePauseState.parse((await callJson('/v1/service/pause', { assertion: a })).body);

  it('pause_service pauses with a receipt; Undo withdraws it; resume_service ends a pause and prepares the next board', async () => {
    expect((await state()).paused).toBe(false);
    const p = CommandReceipt.parse((await callJson('/v1/commands', { assertion: a, body: { idempotencyKey: idem(), source: 'app', command: { type: 'pause_service', startsOn: '2026-10-06', resumeOn: '2026-10-10' } } })).body);
    expect(p.outcome).toBe('committed');
    expect(p.summary).toMatch(/paused from 2026-10-06 until 2026-10-10/);
    expect(p.undo.available).toBe(true);
    expect(await state()).toMatchObject({ paused: true, current: { startsOn: '2026-10-06', resumeOn: '2026-10-10', commandId: p.commandId } });
    const second = await callJson<{ outcome: string }>('/v1/commands', { assertion: a, body: { idempotencyKey: idem(), source: 'app', command: { type: 'pause_service' } } });
    expect(second.body.outcome).toBe('conflict');
    const undo = CommandReceipt.parse((await callJson('/v1/commands', { assertion: a, body: { idempotencyKey: idem(), source: 'app', command: { type: 'undo', targetCommandId: p.commandId } } })).body);
    expect(undo.outcome).toBe('committed');
    expect((await state()).paused).toBe(false);

    await callJson('/v1/commands', { assertion: a, body: { idempotencyKey: idem(), source: 'app', command: { type: 'pause_service' } } });
    const r = CommandReceipt.parse((await callJson('/v1/commands', { assertion: a, body: { idempotencyKey: idem(), source: 'app', command: { type: 'resume_service' } } })).body);
    expect(r.outcome).toBe('committed');
    expect((await state()).paused).toBe(false);
    const t = TodayResponse.parse((await callJson('/v1/today?date=2026-10-06', { assertion: a })).body);
    expect(t.board?.status).toBe('published');
    const nothing = CommandReceipt.parse((await callJson('/v1/commands', { assertion: a, body: { idempotencyKey: idem(), source: 'app', command: { type: 'resume_service' } } })).body);
    expect(nothing.outcome).toBe('rejected');
  });
});

describe('account recovery, sessions and portability routes', () => {
  let owner: Awaited<ReturnType<typeof apiOwner>>;
  let a: string;
  beforeAll(async () => {
    installApiScenario({ now: '2026-10-05T17:00:00.000Z' });
    owner = await apiOwner();
    a = owner.assertion;
  });

  async function nativeSession(assertion: string) {
    const verifier = randomToken(48);
    const challenge = b64urlEncode(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const params = new URLSearchParams({ response_type: 'code', client_id: 'garderobe-ios', redirect_uri: 'garderobe://auth/callback', code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource: 'http://localhost:8787/v1' });
    const code = new URL((await call(`/v1/auth/native/authorize?${params}`, { assertion })).headers.get('location')!).searchParams.get('code')!;
    return (await callJson<{ access_token: string; refresh_token: string }>('/v1/auth/native/token', { body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'garderobe-ios', code, redirect_uri: 'garderobe://auth/callback', code_verifier: verifier }) })).body;
  }

  it('recovery through the dedicated route binds a new identity, and a revoked native session is refused at refresh', async () => {
    const native = await nativeSession(a);
    const kit = RecoveryKitResponse.parse((await callJson('/v1/auth/recovery-kit', { assertion: a, body: {} })).body);
    expect(kit.credential).toMatch(/^GRDB\./);
    const newSubject = `apple-${crypto.randomUUID()}`;
    const fresh = await accessToken(newSubject);
    expect((await callJson('/v1/today', { assertion: fresh })).status).toBe(403);
    const wrong = await callJson<{ error: { code: string } }>('/v1/auth/recover', { assertion: fresh, body: { credential: `${kit.credential.slice(0, -4)}AAAA` } });
    expect(wrong.status).toBe(401);
    expect((await callJson('/v1/auth/recover', { body: { credential: kit.credential } })).status).toBe(401); // Access is required
    const ok = RecoverResponse.parse((await callJson('/v1/auth/recover', { assertion: fresh, body: { credential: kit.credential } })).body);
    expect(ok).toMatchObject({ recovered: true, displayName: 'Chris' });
    expect((await callJson('/v1/today', { assertion: fresh })).status).toBe(200);
    // The pre-recovery native session: refresh itself is refused, not issued and then rejected on use.
    const refresh = await callJson<{ error: string }>('/v1/auth/native/token', { body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'garderobe-ios', refresh_token: native.refresh_token }) });
    expect(refresh.status).toBe(400);
    expect(refresh.body.error).toBe('invalid_grant');
    expect((await callJson('/v1/auth/session', { bearer: native.access_token })).status).toBe(401);
    expect((await callJson('/v1/auth/recover', { assertion: await accessToken(`x-${crypto.randomUUID()}`), body: { credential: kit.credential } })).status).toBe(401); // spent
  });

  it('export produces a verified package; import restores it into an empty owner only', async () => {
    const pkg = (await callJson<{ manifest: { format: string; tables: { name: string; rows: number }[] }; files: Record<string, string> }>('/v1/export', { assertion: a, body: {} })).body;
    expect(pkg.manifest.format).toBe('garderobe-export/1');
    expect(pkg.manifest.tables.find((t) => t.name === 'garments')!.rows).toBe(144);
    const occupied = await callJson<{ error: { code: string } }>('/v1/import', { assertion: a, body: pkg });
    expect(occupied.status).toBe(409);
    const subject = `empty-${crypto.randomUUID()}`;
    const userId = `usr_${crypto.randomUUID().replace(/-/g, '')}`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (user_id, display_name, status, created_at, version) VALUES (?, 'Chris', 'active', ?, 1)").bind(userId, '2026-10-05T00:00:00.000Z'),
      env.DB.prepare('INSERT INTO auth_identities (user_id, identity_id, issuer, subject, linked_at) VALUES (?, ?, ?, ?, ?)').bind(userId, `idn_${crypto.randomUUID().replace(/-/g, '')}`, env.ACCESS_TEAM_DOMAIN!, subject, '2026-10-05T00:00:00.000Z'),
    ]);
    const target = await accessToken(subject);
    const tampered = { ...pkg, files: { ...pkg.files, 'views/profile.md': 'edited' } };
    expect((await callJson('/v1/import', { assertion: target, body: tampered })).status).toBe(422);
    const imported = ImportResponse.parse((await callJson('/v1/import', { assertion: target, body: pkg })).body);
    expect(imported.tables.find((t) => t.name === 'garments')!.rows).toBe(144);
    expect(WardrobePage.parse((await callJson('/v1/wardrobe', { assertion: target })).body).total).toBe(144);
  });
});

describe('read routes and the four iOS shapes', () => {
  let owner: Awaited<ReturnType<typeof apiOwner>>;
  let a: string;
  beforeAll(async () => {
    installApiScenario({ now: '2026-10-06T05:30:00.000Z' });
    owner = await apiOwner();
    a = owner.assertion;
    await prepareToday(a);
  });

  it('orders, returns, comfort, projects and saved combinations return their contracts', async () => {
    const shirt = await owner.byName('Clark oxford — beige');
    await callJson('/v1/commands', { assertion: a, body: { idempotencyKey: idem(), source: 'app', command: { type: 'import_order', merchant: 'Proper Cloth', merchantOrderNumber: 'PC-1001', orderedAt: '2026-10-01T10:00:00.000Z', currency: 'GBP', sourceRef: 'gmail:msg-1', lines: [{ externalLineId: 'L1', description: 'Oxford shirt', quantity: 1, unitPriceMinor: 12000 }] } } });
    await callJson('/v1/commands', { assertion: a, body: { idempotencyKey: idem(), source: 'app', command: { type: 'record_comfort_feedback', text: 'Collar rubbed on the long walk', garmentId: shirt, activity: 'long walk' } } });
    await callJson('/v1/commands', { assertion: a, body: { idempotencyKey: idem(), source: 'app', command: { type: 'open_lifecycle_project', kind: 'tailoring', garmentIds: [shirt], details: { work: 'Shorten sleeves' } } } });
    const t = TodayResponse.parse((await callJson('/v1/today', { assertion: a })).body);
    const slots = t.board!.options[0]!.slots.map((s) => ({ garmentId: s.garmentId, role: s.role, alternativeGroup: s.alternativeGroup }));
    await callJson('/v1/commands', { assertion: a, body: { idempotencyKey: idem(), source: 'app', command: { type: 'save_combination', name: 'Tuesday', slots } } });

    const orders = OrdersResponse.parse((await callJson('/v1/orders', { assertion: a })).body);
    expect(orders.orders[0]!).toMatchObject({ merchant: 'Proper Cloth', merchantOrderNumber: 'PC-1001' });
    expect(orders.orders[0]!.lines[0]!.arrivedQty).toBe(0);
    expect(ReturnDeadlinesResponse.parse((await callJson('/v1/returns', { assertion: a })).body).deadlines).toEqual([]);
    const comfort = ComfortFeedbackResponse.parse((await callJson(`/v1/comfort?garmentId=${shirt}`, { assertion: a })).body);
    expect(comfort.feedback[0]!.text).toBe('Collar rubbed on the long walk');
    const projects = LifecycleProjectsResponse.parse((await callJson('/v1/projects', { assertion: a })).body);
    const mine = projects.projects.find((p) => p.items.some((i) => i.garmentId === shirt))!;
    expect(mine).toMatchObject({ kind: 'tailoring', details: { work: 'Shorten sleeves' } });
    expect((await callJson(`/v1/projects/${mine.projectId}`, { assertion: a })).status).toBe(200);
    expect((await callJson('/v1/projects/prj_nothere', { assertion: a })).status).toBe(404);
    const combos = SavedCombinationsResponse.parse((await callJson('/v1/studio/combinations?kind=saved', { assertion: a })).body);
    expect(combos.combinations[0]!.name).toBe('Tuesday');
    expect((await callJson('/v1/studio/combinations?kind=wishlist', { assertion: a })).status).toBe(422);
    // Another owner sees none of it (their own imported projects only).
    const other = await apiOwner();
    expect(OrdersResponse.parse((await callJson('/v1/orders', { assertion: other.assertion })).body).orders).toEqual([]);
    const theirs = LifecycleProjectsResponse.parse((await callJson('/v1/projects', { assertion: other.assertion })).body).projects;
    expect(theirs.map((p) => p.projectId)).not.toContain(mine.projectId);
    expect((await callJson(`/v1/projects/${mine.projectId}`, { assertion: other.assertion })).status).toBe(404);
  });

  it('email sync is refused without Gmail and runs once per key with it', async () => {
    installTestGmail(null);
    expect((await callJson<{ error: { code: string } }>('/v1/intake/email/sync', { assertion: a, body: { query: 'order' } })).body.error.code).toBe('gmail_not_connected');
    installTestGmail(new FakeGmail([]));
    const key = idem('sync');
    const r = EmailSyncResponse.parse((await callJson('/v1/intake/email/sync', { assertion: a, body: { query: 'order' }, headers: { 'idempotency-key': key } })).body);
    expect(r.report).toBeTruthy();
    expect((await callJson<{ replayed: boolean }>('/v1/intake/email/sync', { assertion: a, body: { query: 'order' }, headers: { 'idempotency-key': key } })).body.replayed).toBe(true);
    installTestGmail(null);
  });

  it('swap candidates, the prepare-board response and the upload PUT response match their contracts', async () => {
    const t = TodayResponse.parse((await callJson('/v1/today', { assertion: a })).body);
    const swaps = SwapCandidates.parse((await callJson(`/v1/today/options/${t.board!.options[0]!.optionId}/swaps?role=base_top`, { assertion: a })).body);
    expect(swaps.role).toBe('base_top');
    PrepareBoardResponse.parse((await callJson('/v1/today/prepare', { assertion: a, body: { count: 3 } })).body);
    const png = makePng(900, 1200);
    const auth = UploadAuthorization.parse((await callJson('/v1/uploads', { assertion: a, body: { purpose: 'identify', contentType: 'image/png', byteLength: png.byteLength } })).body);
    const res = await callRaw(new URL(auth.uploadUrl, 'http://localhost:8787'), png, auth.headers);
    expect(res.status).toBe(200);
    expect(UploadReceiveResponse.parse(await res.json())).toMatchObject({ uploadId: auth.uploadId, receivedBytes: png.byteLength });
  });

  it('the run input endpoint validates its body and returns the RunInputResponse contract', async () => {
    const socks = String((await q("SELECT garment_id FROM garments WHERE user_id = ? AND category = 'socks' AND tracking = 'anonymous_quantity' LIMIT 1", owner.userId))[0]!.garment_id);
    const c = await connectMcp((await mcpGrant(a, 'claude')).accessToken, { onElicit: () => ({ action: 'decline' }) });
    const key = idem('mcp');
    await c.client.callTool({ name: 'garderobe_command', arguments: { idempotencyKey: key, command: { type: 'reconcile_quantity', garmentId: socks, clean: 1 } } });
    await c.close();
    const runId = String((await q('SELECT run_id FROM pending_actions WHERE user_id = ? AND idempotency_key = ?', owner.userId, key))[0]!.run_id);
    expect((await callJson(`/v1/runs/${runId}/input`, { assertion: a, body: { choiceId: 42 } })).status).toBe(422);
    const r = RunInputResponse.parse((await callJson(`/v1/runs/${runId}/input`, { assertion: a, body: { choiceId: 'confirm' } })).body);
    expect(r).toMatchObject({ status: 'declined', receipt: null });
  });
});

/** PUT raw bytes to an upload URL through the Worker. */
async function callRaw(url: URL, bytes: Uint8Array, headers: Record<string, string>): Promise<Response> {
  const { exports } = await import('cloudflare:workers');
  return exports.default.fetch(new Request(url, { method: 'PUT', headers: { ...headers, 'content-length': String(bytes.byteLength) }, body: bytes }));
}
