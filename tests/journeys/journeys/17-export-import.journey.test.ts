import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { ItemDetail, SettingsResponse, StyleCurrentResponse } from '@garderobe/contracts';
import { createUser, ownerPrincipal, type Principal } from '../../../backend/src/domain/index.js';
import { exportOwnerData, importExport, verifyExport, type ExportPackage } from '../../../backend/src/export/index.js';
import { issueRecoveryCredential, type RecoveryKit } from '../../../backend/src/lifecycle/index.js';
import { TripService } from '../../../backend/src/trips/service.js';
import { b64urlEncode, randomToken, sha256B64url } from '../../../backend/src/auth/jose.js';
import { accessAssertion, ISSUER, PROFILE_SHA256, PROFILE_TEXT, seedOwner, uniq, type Owner } from '../harness/owner.js';
import { App, call, callJson, ORIGIN } from '../harness/http.js';
import { installWorld, type World } from '../harness/world.js';
import { connectAssistant, type Grant } from '../harness/mcp.js';
import { expectDoneReceipt } from '../harness/ux.js';

/**
 * Journey 17 — Portable owner export (spec section 15 "Portable owner export"; section 17 row
 * "Portability": a complete export passes checksum and clean-import checks without credentials,
 * missing source history, or replayed external effects). After ordinary use — a logged wear, a
 * prepared board, an order, a comfort rule, a trip — "Export my wardrobe" produces one versioned,
 * checksummed package with readable views and a README; any tampering fails verification; no
 * credential leaves; and a clean import into a new, empty owner reproduces the same 144 garments with
 * the same ids and the byte-identical profile, which the new owner then sees through the API with its
 * own Access identity — with nothing external replayed.
 *
 * Stand-in: FakeWeatherProvider replaces Open-Meteo. The export package is held in memory (the
 * product has no download route).
 */

const TRANSCRIPT = [
  { id: 'msg_1', role: 'user', text: 'Log the light blue wide stripe for today.', createdAt: '2026-10-05T07:40:00.000Z' },
  { id: 'msg_2', role: 'assistant', text: 'Logged: Lightweight oxford — light blue wide stripe for 5 October.', createdAt: '2026-10-05T07:40:05.000Z' },
];
const REDIRECT = 'garderobe://auth/callback';

async function s256(v: string): Promise<string> {
  return b64urlEncode(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));
}

/** The native app's secretless PKCE sign-in (spec section 15), as the iOS app performs it. */
async function nativeSignIn(assertion: string): Promise<{ access: string; refresh: string }> {
  const verifier = randomToken(48);
  const params = new URLSearchParams({ response_type: 'code', client_id: 'garderobe-ios', redirect_uri: REDIRECT, code_challenge: await s256(verifier), code_challenge_method: 'S256', state: 'st-export', resource: `${ORIGIN}/v1` });
  const res = await call(`/v1/auth/native/authorize?${params}`, { assertion });
  const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
  const t = await callJson<{ access_token: string; refresh_token: string }>('/v1/auth/native/token', { body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'garderobe-ios', code, redirect_uri: REDIRECT, code_verifier: verifier, resource: `${ORIGIN}/v1` }) });
  expect(t.status).toBe(200);
  return { access: t.body.access_token, refresh: t.body.refresh_token };
}

async function emptyOwner(now: string): Promise<{ principal: Principal; subject: string }> {
  const subject = uniq('access-sub-restored');
  const { userId } = await createUser(env.DB, { displayName: 'Chris', identity: { issuer: ISSUER, subject, email: 'owner@example.invalid' }, now });
  return { principal: ownerPrincipal(userId, 'test'), subject };
}

describe('Journey: Export my wardrobe, then restore it into a new, empty owner', () => {
  let world: World;
  let owner: Owner;
  let app: App;
  let shirt: string;
  let kit: RecoveryKit;
  let grant: Grant;
  let pkg: ExportPackage;
  let restored: { principal: Principal; subject: string };
  let restoredApp: App;

  beforeAll(async () => {
    world = installWorld({ now: '2026-10-05T07:40:00.000Z', weather: { scenario: 'mild' } });
    owner = await seedOwner();
    app = new App(owner.assertion);
    shirt = await owner.byName('Lightweight oxford — light blue wide stripe');
    // Ordinary use, all through commands and services.
    expectDoneReceipt(await app.commit({ type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-05', items: [{ garmentId: shirt, role: 'base_top' }] }));
    world.clock.set('2026-10-05T19:00:00.000Z');
    expect((await app.prepare({ date: '2026-10-06' })).published).toBe(true);
    await app.commit({ type: 'import_order', merchant: "Drake's", merchantOrderNumber: 'DR-60001', orderedAt: '2026-10-01T10:00:00.000Z', currency: 'GBP', sourceRef: 'gmail:gm_dr60001', lines: [{ externalLineId: 'TIE-RST|OS', description: 'Silk knit tie — rust', quantity: 1, unitPriceMinor: 9500 }] });
    const sneakers = await owner.byName('NB 990v4 — grey');
    await app.commit({ type: 'record_comfort_feedback', text: 'Do not suggest these for long walks', garmentId: sneakers, activity: 'long walks', standingInstruction: { ownerQuote: 'Do not suggest these for long walks', appliesTo: { activity: 'long walks' } } });
    await new TripService({ db: env.DB, principal: owner.principal, weather: world.weather, calendar: null, clock: world.clock.now }).createTrip({ name: 'Paris', departsOn: '2026-10-16', returnsOn: '2026-10-18', destinations: [{ label: 'Paris', timezone: 'Europe/Paris' }] });
    // Credentials that must never leave: a recovery kit and a connected assistant.
    kit = await issueRecoveryCredential(env.DB, owner.userId, world.clock.now());
    grant = await connectAssistant(owner.assertion, 'claude');
  });

  it('produces one versioned, checksummed package with every record family, readable views, the transcript and a README', async () => {
    // SURFACE GAP: no HTTP/MCP route for Export my wardrobe; driven through exportOwnerData
    pkg = await exportOwnerData(env.DB, owner.principal, { now: world.clock.now(), transcript: TRANSCRIPT });
    expect(pkg.manifest.format).toBe('garderobe-export/1');
    expect(pkg.manifest.complete).toBe(true);
    expect(pkg.manifest.incomplete).toEqual([]);
    expect(pkg.manifest.exportedAt).toBe('2026-10-05T19:00:00.000Z');
    expect(pkg.manifest.watermarks.lastReceiptRecordedAt).toBeTruthy();
    expect((await verifyExport(pkg)).ok).toBe(true);
    const tables = new Map(pkg.manifest.tables.map((t) => [t.name, t.rows]));
    expect(tables.get('garments')).toBe(144);
    for (const t of ['garment_aliases', 'stock_movements', 'daily_wears', 'style_documents', 'style_rules', 'boards', 'orders', 'order_lines', 'trips', 'comfort_feedback', 'command_receipts']) expect(tables.has(t), `table ${t} exported`).toBe(true);
    expect(tables.get('daily_wears')).toBeGreaterThanOrEqual(1);
    expect(tables.get('trips')).toBe(1);
    expect(tables.get('orders')).toBe(1);
    // Readable without Garderobe: the profile verbatim, a garment list, the conversation and a README.
    expect(pkg.files['views/profile.md']).toBe(PROFILE_TEXT);
    expect(pkg.files['views/garments.csv']!.split('\n')).toHaveLength(145);
    expect(JSON.parse(pkg.files['conversation/messages.json']!)).toEqual(TRANSCRIPT);
    expect(pkg.files['README.md']).toMatch(/Units/);
    expect(pkg.files['README.md']).toMatch(/Dates/);
    expect(pkg.files['README.md']).toMatch(/Excluded by design/);
  });

  it('an export without the conversation transcript says it is incomplete rather than presenting itself as complete', async () => {
    // SURFACE GAP: no HTTP/MCP route for Export my wardrobe; driven through exportOwnerData
    const partial = await exportOwnerData(env.DB, owner.principal, { now: world.clock.now() });
    expect(partial.manifest.complete).toBe(false);
    expect(partial.manifest.incomplete.map((i) => i.component)).toContain('conversation transcript');
  });

  it('any tampering fails verification, and a tampered package is refused on import', async () => {
    const edited = { ...pkg, files: { ...pkg.files, 'data/garments.json': pkg.files['data/garments.json']!.replace('light blue wide stripe', 'dark blue wide stripe') } };
    expect(await verifyExport(edited)).toEqual({ ok: false, problems: ['checksum mismatch for data/garments.json'] });
    const recounted = { ...pkg, manifest: { ...pkg.manifest, tables: pkg.manifest.tables.map((t) => (t.name === 'garments' ? { ...t, rows: 143 } : t)) } };
    expect((await verifyExport(recounted)).problems).toContain('manifest checksum mismatch');
    const { 'views/profile.md': _dropped, ...rest } = pkg.files;
    void _dropped;
    expect((await verifyExport({ ...pkg, files: rest })).problems).toContain('missing file views/profile.md');
    const target = await emptyOwner(world.clock.now());
    await expect(importExport(env.DB, target.principal, edited)).rejects.toThrow(/failed verification/);
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM garments WHERE user_id = ?').bind(target.principal.userId).first<{ n: number }>();
    expect(left!.n).toBe(0);
  });

  it('carries no credentials: no recovery verifier or code, no login identity, no assistant tokens', async () => {
    const all = JSON.stringify(pkg);
    expect(pkg.manifest.excluded).toEqual(expect.arrayContaining(['recovery_credentials', 'auth_identities', 'users']));
    expect(all.includes(kit.credential.split('.')[2]!), 'recovery code secret in the export').toBe(false);
    expect(/pbkdf2|verifier_hash|credential_ref/.test(all), 'recovery verifier or credential reference in the export').toBe(false);
    expect(all.includes(owner.subject), 'login identity subject in the export').toBe(false);
    expect(all.includes(grant.accessToken), 'assistant access token in the export').toBe(false);
    expect(all.includes(grant.refreshToken), 'assistant refresh token in the export').toBe(false);
  });

  it('a clean import into a new, empty owner reproduces the same wardrobe and ids, which the new Access identity sees through the API', async () => {
    // SURFACE GAP: no HTTP/MCP route for importing an export; driven through importExport
    restored = await emptyOwner(world.clock.now());
    const result = await importExport(env.DB, restored.principal, pkg);
    expect(result.tables.find((t) => t.name === 'garments')!.rows).toBe(144);
    restoredApp = new App(await accessAssertion(restored.subject));
    const session = await restoredApp.get<{ displayName: string }>('/v1/auth/session');
    expect(session.status).toBe(200);
    expect(session.body.displayName).toBe('Chris');

    const before = await app.wardrobe();
    const after = await restoredApp.wardrobe();
    expect(after.page.total).toBe(144);
    expect([...after.byId.keys()].sort()).toEqual([...before.byId.keys()].sort());
    expect(after.page.counts).toEqual(before.page.counts);
    for (const [id, item] of before.byId) expect(after.byId.get(id)!.garment.name).toBe(item.garment.name);
    // History survives: the wear, the board, the style profile byte for byte.
    const d = ItemDetail.parse((await restoredApp.get(`/v1/items/${shirt}`)).body);
    expect([d.item.recordedWearCount, d.item.lastRecordedWear]).toEqual([1, '2026-10-05']);
    const style = StyleCurrentResponse.parse((await restoredApp.get('/v1/style/current')).body);
    expect(style.document.body).toBe(PROFILE_TEXT);
    expect(style.document.contentSha256).toBe(PROFILE_SHA256);
    expect(style.rules.active).toBe(StyleCurrentResponse.parse((await app.get('/v1/style/current')).body).rules.active);
    const oldBoard = (await app.today('2026-10-06')).board!;
    const newBoard = (await restoredApp.today('2026-10-06')).board!;
    expect(newBoard.boardId).toBe(oldBoard.boardId);
    expect(newBoard.options.map((o) => o.slots.map((s) => s.garmentId))).toEqual(oldBoard.options.map((o) => o.slots.map((s) => s.garmentId)));
  });

  it('nothing external is replayed by the import, and the original owner is untouched', async () => {
    const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM command_effects WHERE user_id = ? AND status IN ('pending', 'dispatched')").bind(restored.principal.userId).first<{ n: number }>();
    expect(pending!.n).toBe(0);
    expect((await app.wardrobe()).page.total).toBe(144);
    await expect(importExport(env.DB, restored.principal, pkg)).rejects.toThrow(/empty owner/);
  });

  it('the restored owner starts without the old owner’s authorizations: no connected assistant it never approved', async () => {
    const settings = SettingsResponse.parse((await restoredApp.get('/v1/settings')).body);
    const active = (settings.connectedAssistants ?? []).filter((g) => g.status === 'active');
    expect(active.map((g) => g.clientName), 'assistant grants copied into the restored owner as active').toEqual([]);
  });
});

describe('Journey: exporting after signing in with the native app', () => {
  let world: World;
  let pkg: ExportPackage;
  let tokens: { access: string; refresh: string };

  beforeAll(async () => {
    world = installWorld({ now: '2026-10-05T19:00:00.000Z', weather: { scenario: 'mild' } });
    const owner = await seedOwner();
    tokens = await nativeSignIn(owner.assertion);
    expect((await call('/v1/auth/session', { bearer: tokens.access })).status).toBe(200);
    pkg = await exportOwnerData(env.DB, owner.principal, { now: world.clock.now(), transcript: TRANSCRIPT });
  });

  it('the package holds no native session secrets: neither the access- nor the refresh-token hash', async () => {
    // SURFACE GAP: no HTTP/MCP route for Export my wardrobe; driven through exportOwnerData
    expect((await verifyExport(pkg)).ok).toBe(true);
    const all = JSON.stringify(pkg);
    const exported = pkg.manifest.tables.filter((t) => ['app_sessions', 'native_auth_codes'].includes(t.name) && t.rows > 0).map((t) => t.name);
    expect(exported, 'session and sign-in code tables exported with rows').toEqual([]);
    expect(all.includes(await sha256B64url(tokens.access)), 'native access-token hash in the export').toBe(false);
    expect(all.includes(await sha256B64url(tokens.refresh)), 'native refresh-token hash in the export').toBe(false);
  });

  it('that package still imports cleanly into an empty owner, who then sees the 144 garments', async () => {
    // SURFACE GAP: no HTTP/MCP route for importing an export; driven through importExport
    const target = await emptyOwner(world.clock.now());
    let failure: string | null = null;
    try {
      await importExport(env.DB, target.principal, pkg);
    } catch (err) {
      failure = err instanceof Error ? err.message.slice(0, 300) : String(err);
    }
    const left = (await env.DB.prepare('SELECT COUNT(*) AS n FROM garments WHERE user_id = ?').bind(target.principal.userId).first<{ n: number }>())!.n;
    expect(failure, `import of an export taken after a native sign-in (the failed import left ${left} garments in the target)`).toBeNull();
    const restored = new App(await accessAssertion(target.subject));
    expect((await restored.wardrobe()).page.total).toBe(144);
  });
});
