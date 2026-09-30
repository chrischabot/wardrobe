import { describe, expect, it } from 'vitest';
import { db, newOwner, newUser, ok, run } from './helpers/fixtures.js';
import { issueRecoveryCredential, isGrantValid, isSessionValid, recoverWithCredential } from '../src/lifecycle/index.js';
import { exportOwnerData, importExport, verifyExport } from '../src/export/index.js';
import { listWardrobe } from '../src/domain/queries.js';

const gid = async (userId: string, name: string) => (await db().prepare('SELECT garment_id FROM garments WHERE user_id = ? AND name = ?').bind(userId, name).first<{ garment_id: string }>())!.garment_id;

async function orderLine(principal: Parameters<typeof ok>[0]) {
  const r = await ok(principal, { type: 'import_order', merchant: 'Paraboot', merchantOrderNumber: 'PB-77', orderedAt: '2026-09-01T10:00:00.000Z', currency: 'EUR', sourceRef: 'gmail:pb77', lines: [{ externalLineId: 'AVIGNON-42.5', description: 'Paraboot Avignon', quantity: 1, unitPriceMinor: 45000 }] });
  return (r.facts.createdLineIds as string[])[0]!;
}

describe('lifecycle: returns, comfort, projects, recovery and export', () => {
  it('return deadlines come only from sourced terms that state the window and a real trigger date', async () => {
    const owner = await newOwner();
    const lineId = await orderLine(owner.principal);
    const base = { type: 'return_terms' };
    void base;
    const vague = await run(owner.principal, { type: 'record_return_terms', lineId, kind: 'request', terms: { sourceRef: 'https://paraboot.com/returns', quote: 'Returns are accepted in most cases.', checkedAt: '2026-09-02T10:00:00.000Z', windowDays: 30 }, trigger: { event: 'order', date: '2026-09-01', evidence: 'gmail:pb77' }, timezone: 'Europe/Paris' });
    expect(vague.outcome).toBe('rejected');
    const noArrival = await run(owner.principal, { type: 'record_return_terms', lineId, kind: 'request', terms: { sourceRef: 'https://paraboot.com/returns', quote: 'You may request a return within 14 days of delivery.', checkedAt: '2026-09-02T10:00:00.000Z', windowDays: 14 }, trigger: { event: 'delivery', date: '2026-09-05', evidence: 'estimate' }, timezone: 'Europe/Paris' });
    expect(noArrival.error?.code).toBe('evidence_required');
    const good = await ok(owner.principal, { type: 'record_return_terms', lineId, kind: 'request', terms: { sourceRef: 'https://paraboot.com/returns', quote: 'You may request a return within 30 days of your order date.', checkedAt: '2026-09-02T10:00:00.000Z', windowDays: 30 }, trigger: { event: 'order', date: '2026-09-01', evidence: 'gmail:pb77' }, timezone: 'Europe/Paris' });
    expect(good.facts).toMatchObject({ deadlineDate: '2026-10-01', kind: 'request' });
    expect(good.facts.deadlineAt).toBe('2026-10-01T21:59:00.000Z');
  });

  it('a delivery deadline counts from the recorded arrival, not the estimate given; a later arrival recalculates it in its own receipt, and undo restores it', async () => {
    const owner = await newOwner();
    const socks = (await ok(owner.principal, { type: 'add_item', explicit: true, name: 'Merino socks — navy (order)', category: 'socks', roles: ['socks'], tracking: 'anonymous_quantity', acquisition: 'incoming' })).facts.garmentId as string;
    const order = await ok(owner.principal, { type: 'import_order', merchant: 'Pantherella', merchantOrderNumber: 'PA-9', orderedAt: '2026-09-01T10:00:00.000Z', currency: 'GBP', sourceRef: 'gmail:pa9', lines: [{ externalLineId: 'MER-NVY|2', description: 'Merino socks — navy', quantity: 2, unitPriceMinor: 2000, arrivalEstimate: '2026-09-03', garmentId: socks }] });
    const lineId = (order.facts.createdLineIds as string[])[0]!;
    await ok(owner.principal, { type: 'mark_arrived', garmentId: socks, quantity: 1, occurredAt: '2026-09-05T09:00:00.000Z' });
    const terms = { type: 'record_return_terms' as const, lineId, kind: 'request' as const, terms: { sourceRef: 'https://pantherella.example/returns', quote: 'Return unworn items within 14 days of delivery.', checkedAt: '2026-09-05T10:00:00.000Z', windowDays: 14 }, timezone: 'Europe/London' };
    // The caller offers the estimated date; the recorded arrival (5 Sept) governs.
    const d = await ok(owner.principal, { ...terms, trigger: { event: 'delivery', date: '2026-09-03', evidence: 'dispatch email estimate' } });
    expect(d.facts).toMatchObject({ deadlineDate: '2026-09-19', termsSource: { trigger: { event: 'delivery', date: '2026-09-05' }, statedTrigger: { date: '2026-09-03' } } });
    expect(d.summary).toContain('recorded arrival on 2026-09-05');
    const deadline = async () => (await db().prepare('SELECT deadline_at, terms_source FROM return_deadlines WHERE user_id = ? AND line_id = ?').bind(owner.userId, lineId).first<{ deadline_at: string; terms_source: string }>())!;
    expect((await deadline()).deadline_at).toBe('2026-09-19T22:59:00.000Z');

    // The second pair arrives on 8 Sept: the open delivery deadline moves, with the arrival's receipt.
    const second = await ok(owner.principal, { type: 'mark_arrived', garmentId: socks, quantity: 1, occurredAt: '2026-09-08T09:00:00.000Z' });
    expect(second.facts.recalculatedDeadlines).toEqual([{ deadlineId: d.facts.deadlineId, lineId, kind: 'request', fromDate: '2026-09-05', toDate: '2026-09-08', deadlineAt: '2026-09-22T22:59:00.000Z' }]);
    expect(second.summary).toContain('now counts from 2026-09-08');
    expect((await deadline()).deadline_at).toBe('2026-09-22T22:59:00.000Z');
    expect(JSON.parse((await deadline()).terms_source)).toMatchObject({ trigger: { date: '2026-09-08' }, recalculations: [{ fromDate: '2026-09-05', toDate: '2026-09-08', commandId: second.commandId }] });
    const line = async () => (await db().prepare('SELECT arrived_qty, arrived_at FROM order_lines WHERE user_id = ? AND line_id = ?').bind(owner.userId, lineId).first<{ arrived_qty: number; arrived_at: string }>())!;
    expect(await line()).toEqual({ arrived_qty: 2, arrived_at: '2026-09-08T09:00:00.000Z' });

    await ok(owner.principal, { type: 'undo', targetCommandId: second.commandId });
    expect((await deadline()).deadline_at).toBe('2026-09-19T22:59:00.000Z');
    expect(await line()).toEqual({ arrived_qty: 1, arrived_at: '2026-09-05T09:00:00.000Z' });
  });

  it('comfort feedback is scoped; only an explicit instruction becomes a standing rule, scoped and undoable', async () => {
    const owner = await newOwner();
    const shoes = await gid(owner.userId, 'NB 990v4 — grey');
    const obs = await ok(owner.principal, { type: 'record_comfort_feedback', text: 'these hurt after an hour on the train', garmentId: shoes, activity: 'commute', conditions: { setting: 'train' } }, { source: 'conversation' });
    expect(obs.facts).toMatchObject({ standingRuleId: null, universal: false });
    expect(obs.summary).not.toMatch(/medical|injury|diagnos/i);
    const rule = await ok(owner.principal, { type: 'record_comfort_feedback', text: 'do not suggest these for long walks', garmentId: shoes, activity: 'long walks', standingInstruction: { ownerQuote: 'do not suggest these for long walks', appliesTo: { activity: 'long walks' } } }, { source: 'conversation' });
    const ruleId = rule.facts.standingRuleId as string;
    const row = await db().prepare('SELECT machine_json, interpretation, status FROM style_rules WHERE user_id = ? AND rule_id = ?').bind(owner.userId, ruleId).first<{ machine_json: string; interpretation: string; status: string }>();
    expect(JSON.parse(row!.machine_json)).toMatchObject({ excludeGarmentIds: [shoes], when: { activity: 'long walks' } });
    expect(row!.interpretation).toMatch(/not a ban on the garment elsewhere/);
    await ok(owner.principal, { type: 'undo', targetCommandId: rule.commandId });
    expect((await db().prepare('SELECT status FROM style_rules WHERE user_id = ? AND rule_id = ?').bind(owner.userId, ruleId).first<{ status: string }>())!.status).toBe('retired');
    const fromScheduler = await run({ ...owner.principal, authenticatedBy: 'scheduler' }, { type: 'record_comfort_feedback', text: 'x', garmentId: shoes, standingInstruction: { ownerQuote: 'never these' } }, { source: 'system' });
    expect(fromScheduler.outcome).toBe('rejected');
  });

  it('a consignment keeps items owned and out of daily outfits until they physically leave: for sale, sold and gone are distinct', async () => {
    const owner = await newOwner();
    const jacket = await gid(owner.userId, 'PWVC Belted Safari');
    const open = await ok(owner.principal, { type: 'open_lifecycle_project', kind: 'consignment', garmentIds: [jacket], details: { destination: 'Consignment shop', collectionPreference: 'collection', reason: 'size_correction' } });
    const projectId = open.facts.projectId as string;
    expect(open.facts).toMatchObject({ stillOwned: true, categoryVerdict: null });
    const item = async () => (await listWardrobe(db(), owner.principal, { q: 'Belted Safari', acquisition: 'any' })).items[0]!;
    expect((await item()).garment.acquisition).toBe('owned');
    expect((await item()).availability.available).toBe(false);
    await ok(owner.principal, { type: 'advance_lifecycle_project', projectId, status: 'listed' });
    const sold = await ok(owner.principal, { type: 'advance_lifecycle_project', projectId, status: 'sold', proceedsMinor: 32000, currency: 'GBP' });
    expect(sold.facts).toMatchObject({ stillOwned: true, gone: false });
    expect((await item()).garment.acquisition).toBe('owned');
    const back = await run(owner.principal, { type: 'advance_lifecycle_project', projectId, status: 'listed' });
    expect(back.outcome).toBe('rejected');
    const gone = await ok(owner.principal, { type: 'advance_lifecycle_project', projectId, status: 'collected' });
    expect(gone.facts).toMatchObject({ gone: true, stillOwned: false, restrictionLifted: true });
    expect((await item()).garment.acquisition).toBe('disposed');
    expect((await item()).garment.disposalReason).toBe('sold');
  });

  it('withdrawing a sale returns the item to ordinary planning; a return project retires stock only when posted', async () => {
    const owner = await newOwner();
    const shirt = await gid(owner.userId, 'Lightweight oxford — gold');
    const sale = await ok(owner.principal, { type: 'open_lifecycle_project', kind: 'sale', garmentIds: [shirt] });
    await ok(owner.principal, { type: 'advance_lifecycle_project', projectId: sale.facts.projectId as string, status: 'withdrawn' });
    expect((await listWardrobe(db(), owner.principal, { q: 'Lightweight oxford — gold' })).items[0]!.availability.available).toBe(true);
    const ret = await ok(owner.principal, { type: 'open_lifecycle_project', kind: 'return', garmentIds: [shirt] });
    await ok(owner.principal, { type: 'advance_lifecycle_project', projectId: ret.facts.projectId as string, status: 'requested' });
    expect((await listWardrobe(db(), owner.principal, { q: 'Lightweight oxford — gold', acquisition: 'any' })).items[0]!.garment.acquisition).toBe('owned');
    await ok(owner.principal, { type: 'advance_lifecycle_project', projectId: ret.facts.projectId as string, status: 'posted' });
    const g = (await listWardrobe(db(), owner.principal, { q: 'Lightweight oxford — gold', acquisition: 'any' })).items[0]!.garment;
    expect([g.acquisition, g.disposalReason]).toEqual(['disposed', 'returned']);
  });

  it('a single-use recovery credential binds a new identity to the same user and invalidates prior sessions and grants', async () => {
    const owner = await newOwner();
    const before = new Date(Date.now() - 60_000).toISOString();
    const kit = await issueRecoveryCredential(db(), owner.userId);
    const stored = await db().prepare('SELECT verifier_hash FROM recovery_credentials WHERE user_id = ? AND credential_id = ?').bind(owner.userId, kit.credentialId).first<{ verifier_hash: string }>();
    expect(stored!.verifier_hash).not.toContain(kit.credential.split('.')[2]!);
    await expect(recoverWithCredential(db(), { credential: `${kit.credential.slice(0, -2)}XX`, newIdentity: { issuer: 'https://apple.example', subject: 'apple-1' } })).rejects.toThrow(/not valid/);
    const out = await recoverWithCredential(db(), { credential: kit.credential, newIdentity: { issuer: 'https://apple.example', subject: 'apple-1', email: 'chris@example.com' } });
    expect(out.userId).toBe(owner.userId);
    expect(await isSessionValid(db(), owner.userId, before)).toBe(false);
    expect(await isGrantValid(db(), owner.userId, before)).toBe(false);
    expect(await isSessionValid(db(), owner.userId, new Date(Date.now() + 1000).toISOString())).toBe(true);
    await expect(recoverWithCredential(db(), { credential: kit.credential, newIdentity: { issuer: 'https://apple.example', subject: 'apple-2' } })).rejects.toThrow(/not valid/);
    expect(out.replacementKit.credential).not.toBe(kit.credential);
    const wardrobe = await listWardrobe(db(), owner.principal, {});
    expect(wardrobe.counts.owned).toBe(127);
    // A recovery code cannot take over an identity already bound to someone else.
    const other = await newUser();
    const otherKit = await issueRecoveryCredential(db(), other.userId);
    await expect(recoverWithCredential(db(), { credential: otherKit.credential, newIdentity: { issuer: 'https://apple.example', subject: 'apple-1' } })).rejects.toThrow(/not valid/);
  });

  it('repeated wrong recovery attempts are rate limited', async () => {
    const u = await newUser();
    const kit = await issueRecoveryCredential(db(), u.userId);
    const wrong = `${kit.credential.split('.').slice(0, 2).join('.')}.WRONGSECRET`;
    for (let i = 0; i < 5; i++) await expect(recoverWithCredential(db(), { credential: wrong, newIdentity: { issuer: 'https://x.example', subject: `s${i}` } })).rejects.toThrow(/not valid/);
    await expect(recoverWithCredential(db(), { credential: kit.credential, newIdentity: { issuer: 'https://x.example', subject: 's9' } })).rejects.toThrow(/Too many/);
  });

  it('exports a checksummed, credential-free package that imports cleanly into an empty owner without replaying effects', async () => {
    const owner = await newOwner();
    const shirt = await gid(owner.userId, 'Lightweight oxford — gold');
    await ok(owner.principal, { type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-09-21', items: [{ garmentId: shirt }] });
    await issueRecoveryCredential(db(), owner.userId);
    await db().prepare("INSERT INTO connections (user_id, connection_id, name, namespace, kind, endpoint, credential_ref, transport, protocol_version, status, created_at, updated_at) VALUES (?, 'con_x', 'Tavily', 'tavily', 'tavily', 'https://mcp.tavily.com/mcp/', 'env:TAVILY_API_KEY', 'streamable-http', '2026-07-28', 'active', ?, ?)").bind(owner.userId, '2026-09-20T00:00:00Z', '2026-09-20T00:00:00Z').run();
    const pkg = await exportOwnerData(db(), owner.principal, { transcript: [{ id: 'm1', role: 'user', text: 'hello', createdAt: '2026-09-20T10:00:00Z' }] });
    expect(pkg.manifest.complete).toBe(true);
    expect((await verifyExport(pkg)).ok).toBe(true);
    const all = JSON.stringify(pkg);
    expect(all).not.toMatch(/verifier_hash|pbkdf2|env:TAVILY_API_KEY|credential_ref/);
    expect(pkg.manifest.excluded).toEqual(expect.arrayContaining(['recovery_credentials', 'auth_identities']));
    expect(pkg.files['views/profile.md']!.length).toBeGreaterThan(1000);
    expect(pkg.manifest.tables.find((t) => t.name === 'garments')!.rows).toBe(127);

    const tampered = { ...pkg, files: { ...pkg.files, 'data/garments.json': pkg.files['data/garments.json']!.replace('Lightweight oxford', 'Heavyweight oxford') } };
    expect((await verifyExport(tampered)).ok).toBe(false);

    const target = await newUser('Restored owner');
    await importExport(db(), target, pkg);
    const restored = await listWardrobe(db(), target, { acquisition: 'any' });
    expect(restored.counts.owned).toBe(127);
    expect(restored.items.some((i) => i.garment.garmentId === shirt)).toBe(true); // ids preserved
    const pendingEffects = await db().prepare("SELECT COUNT(*) AS n FROM command_effects WHERE user_id = ? AND status IN ('pending','dispatched')").bind(target.userId).first<{ n: number }>();
    expect(pendingEffects!.n).toBe(0);
    const conn = await db().prepare('SELECT status, credential_ref FROM connections WHERE user_id = ?').bind(target.userId).first<{ status: string; credential_ref: string | null }>();
    expect(conn).toEqual({ status: 'disconnected', credential_ref: null });
    await expect(importExport(db(), target, pkg)).rejects.toThrow(/empty owner/);
  });

  it('an export after a phone sign-in carries no sessions or token hashes, and restores cleanly with every assistant grant revoked and nothing pending', async () => {
    const now = '2026-09-20T10:00:00.000Z';
    const later = '2099-01-01T00:00:00.000Z';
    const session = async (userId: string, tag: string) => {
      const s = { access: `acc-${tag}-${crypto.randomUUID()}`, refresh: `ref-${tag}-${crypto.randomUUID()}` };
      await db()
        .prepare("INSERT INTO app_sessions (user_id, session_id, client_id, scope, access_hash, access_expires_at, refresh_hash, previous_refresh_hash, refresh_expires_at, status, created_at, updated_at) VALUES (?, ?, 'garderobe-ios', 'app', ?, ?, ?, ?, ?, 'active', ?, ?)")
        .bind(userId, `ses_${tag}`, `h-${s.access}`, later, `h-${s.refresh}`, `h-prev-${s.refresh}`, later, now, now)
        .run();
      return s;
    };
    const owner = await newOwner();
    const phone = await session(owner.userId, 'src');
    await db().prepare("INSERT INTO native_auth_codes (code_hash, user_id, client_id, redirect_uri, code_challenge, resource, scope, expires_at, created_at) VALUES (?, ?, 'garderobe-ios', 'garderobe://auth/callback', 'challenge-secret', 'https://x/v1', 'app', ?, ?)").bind(`code-${crypto.randomUUID()}`, owner.userId, later, now).run();
    await db()
      .prepare("INSERT INTO mcp_grants (user_id, grant_id, provider_grant_id, client_id, client_kind, client_name, redirect_host, scopes_json, status, created_at, updated_at) VALUES (?, 'grt_claude', 'provider-grant-handle', 'cl_1', 'claude', 'Claude', 'claude.ai', '[\"wardrobe:read\",\"wardrobe:write\"]', 'active', ?, ?)")
      .bind(owner.userId, now, now)
      .run();
    await db()
      .prepare("INSERT INTO pending_actions (user_id, pending_id, surface, kind, prompt, envelope_json, request_hash, idempotency_key, grant_ref, status, expires_at, created_at) VALUES (?, 'pnd_1', 'mcp', 'confirm', 'Lift it?', '{}', 'rh', 'ik', 'grt_claude', 'pending', ?, ?)")
      .bind(owner.userId, later, now)
      .run();
    await ok(owner.principal, { type: 'add_item', explicit: true, name: '=HYPERLINK("https://evil.example","x")', category: 'shirt', roles: ['base_top'] });

    const pkg = await exportOwnerData(db(), owner.principal, { transcript: [] });
    expect((await verifyExport(pkg)).ok).toBe(true);
    const names = pkg.manifest.tables.map((t) => t.name);
    expect(names).not.toContain('app_sessions');
    expect(names).not.toContain('native_auth_codes');
    expect(pkg.manifest.excluded).toEqual(expect.arrayContaining(['app_sessions', 'native_auth_codes']));
    const all = JSON.stringify(pkg);
    for (const secret of [phone.access, phone.refresh, 'challenge-secret', 'provider-grant-handle']) expect(all.includes(secret), secret).toBe(false);
    expect(JSON.parse(pkg.files['data/mcp_grants.json']!)).toMatchObject([{ grant_id: 'grt_claude', client_name: 'Claude' }]);
    expect(pkg.files['views/garments.csv']).toContain(`"'=HYPERLINK(`);

    // The no-credentials check refuses a package that carries session rows or token-hash columns.
    const planted = { ...pkg, files: { ...pkg.files, 'data/app_sessions.json': '[{"access_hash":"x"}]', 'data/garments.json': pkg.files['data/garments.json']!.replace('"garment_id":', '"refresh_hash":"y","garment_id":') } };
    expect((await verifyExport(planted)).problems).toEqual(expect.arrayContaining(['credential table app_sessions present', 'credential column garments.refresh_hash present']));

    // The target has signed in on its own phone already: the import still succeeds.
    const target = await newUser('Restored owner');
    await session(target.userId, 'dst');
    await importExport(db(), target, pkg, { now: '2026-09-21T08:00:00.000Z' });
    expect((await listWardrobe(db(), target, {})).counts.owned).toBe(128);
    expect((await db().prepare('SELECT session_id FROM app_sessions WHERE user_id = ?').bind(target.userId).all<{ session_id: string }>()).results.map((r) => r.session_id)).toEqual(['ses_dst']);
    expect(await db().prepare('SELECT status, revoked_at, revoked_reason, provider_grant_id FROM mcp_grants WHERE user_id = ?').bind(target.userId).first()).toEqual({ status: 'revoked', revoked_at: '2026-09-21T08:00:00.000Z', revoked_reason: 'restored from an export; reconnect to authorize', provider_grant_id: null });
    expect(await db().prepare('SELECT status FROM pending_actions WHERE user_id = ?').bind(target.userId).first()).toEqual({ status: 'cancelled' });
  });
});
