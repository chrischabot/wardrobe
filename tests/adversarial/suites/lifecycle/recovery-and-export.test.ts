import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { exportOwnerData, importExport, verifyExport, type ExportPackage } from '../../../../backend/src/export/index.js';
import { issueRecoveryCredential, recoverWithCredential } from '../../../../backend/src/lifecycle/recovery.js';
import { canonicalJson, sha256Hex } from '../../../../backend/src/domain/hash.js';
import { sha256B64url } from '../../../../backend/src/auth/jose.js';
import { createUser, ownerPrincipal } from '../../../../backend/src/domain/index.js';
import { apiOwner, call, callJson, installApiScenario, ISSUER, randomVerifier, s256 } from '../../helpers/http.js';
import { connectMcp, mcpGrant } from '../../helpers/mcp.js';
import { count, key, one } from '../../helpers/seed.js';

/**
 * Recovery credential reuse, export tampering and credential leakage through exports, on the owner's
 * real data. The recovery code is shown once, works once and replaces earlier codes; an export omits
 * credentials and a tampered package is refused.
 */

async function nativeSession(assertion: string) {
  const verifier = randomVerifier();
  const params = new URLSearchParams({ response_type: 'code', client_id: 'garderobe-ios', redirect_uri: 'garderobe://auth/callback', code_challenge: await s256(verifier), code_challenge_method: 'S256', state: 's', resource: 'http://localhost:8787/v1' });
  const res = await call(`/v1/auth/native/authorize?${params}`, { assertion });
  const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
  const t = await callJson<Record<string, string>>('/v1/auth/native/token', { body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'garderobe-ios', code, redirect_uri: 'garderobe://auth/callback', code_verifier: verifier }) });
  return { access: t.body.access_token!, refresh: t.body.refresh_token! };
}

/** Re-seals a package after edits, as an attacker holding the file would (checksums are not a signature). */
async function reseal(pkg: ExportPackage): Promise<ExportPackage> {
  const files = { ...pkg.files };
  const fileList = await Promise.all(Object.entries(files).map(async ([path, body]) => ({ path, sha256: await sha256Hex(body) })));
  fileList.sort((a, b) => a.path.localeCompare(b.path));
  const tables = await Promise.all(pkg.manifest.tables.map(async (t) => ({ ...t, sha256: await sha256Hex(files[t.file] ?? '') })));
  const { packageSha256: _drop, ...rest } = { ...pkg.manifest, files: fileList, tables };
  return { manifest: { ...rest, packageSha256: await sha256Hex(canonicalJson(rest)) }, files };
}

describe('recovery credential abuse', () => {
  it('a recovery code works once; reuse, a wrong secret, a malformed code and a superseded code all fail', async () => {
    installApiScenario();
    const o = await apiOwner();
    const kit = await issueRecoveryCredential(env.DB, o.userId);
    const newId = { issuer: ISSUER, subject: key('recovered') };
    const out = await recoverWithCredential(env.DB, { credential: kit.credential, newIdentity: newId });
    expect(out.userId).toBe(o.userId);
    await expect(recoverWithCredential(env.DB, { credential: kit.credential, newIdentity: { issuer: ISSUER, subject: key('again') } })).rejects.toMatchObject({ code: 'unauthenticated' });
    const [prefix, id, secret] = out.replacementKit.credential.split('.');
    await expect(recoverWithCredential(env.DB, { credential: `${prefix}.${id}.${secret!.slice(0, -1)}A`, newIdentity: { issuer: ISSUER, subject: key('x') } })).rejects.toMatchObject({ code: 'unauthenticated' });
    for (const bad of ['', '...', 'garbage', `${prefix}.${id}`, `${prefix}.rcv_' OR 1=1 --.${secret}`]) await expect(recoverWithCredential(env.DB, { credential: bad, newIdentity: { issuer: ISSUER, subject: key('x') } })).rejects.toBeTruthy();
    const newer = await issueRecoveryCredential(env.DB, o.userId);
    await expect(recoverWithCredential(env.DB, { credential: out.replacementKit.credential, newIdentity: { issuer: ISSUER, subject: key('x') } })).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(newer.credential).not.toBe(out.replacementKit.credential);
  });

  it('racing redemptions of one code link at most one new identity', async () => {
    const o = await apiOwner();
    const kit = await issueRecoveryCredential(env.DB, o.userId);
    const subjects = [key('r1'), key('r2'), key('r3'), key('r4')];
    const outs = await Promise.allSettled(subjects.map((subject) => recoverWithCredential(env.DB, { credential: kit.credential, newIdentity: { issuer: ISSUER, subject } })));
    expect(outs.filter((x) => x.status === 'fulfilled').length).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM auth_identities WHERE user_id = ? AND subject IN (${subjects.map(() => '?').join(',')})`, o.userId, ...subjects)).toBe(1);
  });

  it('brute force is rate-limited per owner', async () => {
    const o = await apiOwner();
    const kit = await issueRecoveryCredential(env.DB, o.userId);
    const [prefix, id] = kit.credential.split('.');
    for (let i = 0; i < 5; i++) await recoverWithCredential(env.DB, { credential: `${prefix}.${id}.WRONG${i}`, newIdentity: { issuer: ISSUER, subject: key('bf') } }).catch(() => undefined);
    await expect(recoverWithCredential(env.DB, { credential: kit.credential, newIdentity: { issuer: ISSUER, subject: key('bf') } })).rejects.toBeTruthy();
  });

  it('recovery cannot take over another owner\'s login identity', async () => {
    const a = await apiOwner();
    const b = await apiOwner('Victim');
    const kit = await issueRecoveryCredential(env.DB, a.userId);
    await expect(recoverWithCredential(env.DB, { credential: kit.credential, newIdentity: { issuer: ISSUER, subject: b.subject } })).rejects.toMatchObject({ code: 'unauthenticated' });
    expect((await one<{ user_id: string }>('SELECT user_id FROM auth_identities WHERE issuer = ? AND subject = ?', ISSUER, b.subject)).user_id).toBe(b.userId);
  });

  it('after recovery, every earlier MCP grant and native session is dead', async () => {
    installApiScenario({ now: new Date(Date.now() + 60_000).toISOString() });
    const o = await apiOwner();
    const grant = await mcpGrant(o.assertion, 'claude');
    const session = await nativeSession(o.assertion);
    await new Promise((r) => setTimeout(r, 5));
    const kit = await issueRecoveryCredential(env.DB, o.userId);
    await recoverWithCredential(env.DB, { credential: kit.credential, newIdentity: { issuer: ISSUER, subject: key('after') } }, new Date(Date.now() + 1000).toISOString());
    expect((await call('/mcp', { method: 'POST', bearer: grant.accessToken, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status).toBe(401);
    expect((await call('/v1/auth/session', { bearer: session.access })).status).toBe(401);
    const r = await callJson<Record<string, string>>('/v1/auth/native/token', { body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'garderobe-ios', refresh_token: session.refresh }) });
    if (r.status === 200) expect((await call('/v1/auth/session', { bearer: r.body.access_token! })).status).toBe(401);
  });
});

describe('export tampering and credential leakage', () => {
  it('an edited, truncated or re-labelled package fails verification and is not imported', async () => {
    const o = await apiOwner();
    const pkg = await exportOwnerData(env.DB, o.principal);
    expect((await verifyExport(pkg)).ok).toBe(true);
    const edited: ExportPackage = { ...pkg, files: { ...pkg.files, 'data/restrictions.json': '[]' } };
    const dropped: ExportPackage = { ...pkg, files: Object.fromEntries(Object.entries(pkg.files).filter(([p]) => p !== 'data/garments.json')) };
    const relabelled: ExportPackage = { ...pkg, manifest: { ...pkg.manifest, owner: { userId: 'usr_someoneelse', displayName: 'X' } } };
    for (const [label, bad] of Object.entries({ edited, dropped, relabelled })) expect((await verifyExport(bad)).ok, label).toBe(false);
    const { userId } = await createUser(env.DB, { displayName: 'Restore target', identity: { issuer: 'https://adversarial.test.invalid', subject: key('rt') } });
    await expect(importExport(env.DB, ownerPrincipal(userId, 'test'), edited)).rejects.toMatchObject({ code: 'validation_failed' });
    expect(await count('SELECT COUNT(*) AS n FROM garments WHERE user_id = ?', userId)).toBe(0);
  });

  it('an import never lands in an owner who already has records, and never escapes its target owner', async () => {
    const o = await apiOwner();
    const victim = await apiOwner('Victim');
    const pkg = await exportOwnerData(env.DB, o.principal);
    await expect(importExport(env.DB, victim.principal, pkg)).rejects.toMatchObject({ code: 'invalid_state' });
    // A resealed package whose rows name the victim still writes only into the empty target.
    const forged = await reseal({ ...pkg, files: { ...pkg.files, 'data/garments.json': pkg.files['data/garments.json']!.replace(/"garment_id":/g, `"user_id":"${victim.userId}","garment_id":`) } });
    const { userId } = await createUser(env.DB, { displayName: 'Restore target', identity: { issuer: 'https://adversarial.test.invalid', subject: key('rt') } });
    const victimGarments = await count('SELECT COUNT(*) AS n FROM garments WHERE user_id = ?', victim.userId);
    await importExport(env.DB, ownerPrincipal(userId, 'test'), forged).catch(() => undefined);
    expect(await count('SELECT COUNT(*) AS n FROM garments WHERE user_id = ?', victim.userId)).toBe(victimGarments);
  });

  it('the export omits recovery verifiers, identity subjects, OAuth tokens and connector secrets', async () => {
    installApiScenario();
    const o = await apiOwner();
    const grant = await mcpGrant(o.assertion, 'claude');
    const session = await nativeSession(o.assertion);
    const kit = await issueRecoveryCredential(env.DB, o.userId);
    const all = JSON.stringify(await exportOwnerData(env.DB, o.principal));
    for (const s of [grant.accessToken, grant.refreshToken, session.access, session.refresh, kit.credential, kit.credential.split('.')[2]!, o.subject, 'pbkdf2-sha256$']) expect(all.includes(s), `export contains ${s.slice(0, 12)}…`).toBe(false);
  });

  // ADV-11 (DEFECTS.md): SECRET_COLUMN does not match access_hash / refresh_hash / previous_refresh_hash / code_hash, so the
  // export carries the hashes of live bearer and refresh tokens (credential material the spec says exports omit).
  it('[ADV-11] the export carries no hashes of live session or authorization-code tokens', async () => {
    installApiScenario();
    const o = await apiOwner();
    const session = await nativeSession(o.assertion);
    const all = JSON.stringify(await exportOwnerData(env.DB, o.principal));
    expect(all.includes(await sha256B64url(session.access)), 'access-token hash present').toBe(false);
    expect(all.includes(await sha256B64url(session.refresh)), 'refresh-token hash present').toBe(false);
  });

  // ADV-12 (DEFECTS.md, fixed): a package tampered to carry credential tables or columns (sessions, sign-in codes, token
  // hashes, active grants) must be refused on import, or restored without any working session, code or grant. The test
  // builds the tampered package itself from a genuine export (which deliberately carries none of these) and reseals it.
  describe('[ADV-12] a tampered export cannot plant a session, sign-in code or grant', () => {
    const REDIRECT = 'garderobe://auth/callback';

    /** Adds (or replaces) a table file and its manifest entry, then reseals every checksum. */
    async function inject(pkg: ExportPackage, table: string, rows: Record<string, unknown>[]): Promise<ExportPackage> {
      const file = `data/${table}.json`;
      const files = { ...pkg.files, [file]: canonicalJson(rows) };
      const tables = [...pkg.manifest.tables.filter((t) => t.name !== table), { name: table, file, rows: rows.length, sha256: '' }];
      return reseal({ manifest: { ...pkg.manifest, tables, excluded: pkg.manifest.excluded.filter((x) => x !== table) }, files });
    }

    async function freshTarget() {
      const { userId } = await createUser(env.DB, { displayName: 'Restore target', identity: { issuer: 'https://adversarial.test.invalid', subject: key('rt') } });
      return ownerPrincipal(userId, 'test');
    }

    /** Imports the package; returns whether it was refused. Whatever happens, nothing credential-bearing may be live. */
    async function importAndProbe(pkg: ExportPackage, probes: { bearer?: string; code?: { code: string; verifier: string } }) {
      expect((await verifyExport(pkg)).problems.filter((p) => /checksum|missing|not listed/.test(p)), 'the reseal itself must be valid').toEqual([]);
      const target = await freshTarget();
      let refused = false;
      try {
        await importExport(env.DB, target, pkg);
      } catch (e) {
        refused = true;
        expect((e as { code?: string }).code).toBe('validation_failed');
      }
      expect(await count('SELECT COUNT(*) AS n FROM app_sessions WHERE user_id = ?', target.userId)).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM native_auth_codes WHERE user_id = ?', target.userId)).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM mcp_grants WHERE user_id = ? AND status = 'active'", target.userId)).toBe(0);
      if (probes.bearer) expect((await call('/v1/auth/session', { bearer: probes.bearer })).status).toBe(401);
      if (probes.code) {
        const t = await callJson<Record<string, string>>('/v1/auth/native/token', { body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'garderobe-ios', code: probes.code.code, redirect_uri: REDIRECT, code_verifier: probes.code.verifier }) });
        expect(t.status).toBeGreaterThanOrEqual(400);
        expect(t.body.access_token).toBeUndefined();
      }
      return { refused, target };
    }

    it('a genuine export carries no session, sign-in code or token-hash material and restores cleanly (control)', async () => {
      installApiScenario();
      const o = await apiOwner();
      await nativeSession(o.assertion);
      await mcpGrant(o.assertion, 'claude');
      const pkg = await exportOwnerData(env.DB, o.principal);
      expect(Object.keys(pkg.files).some((p) => /app_sessions|native_auth_codes/.test(p))).toBe(false);
      expect(pkg.manifest.tables.some((t) => ['app_sessions', 'native_auth_codes'].includes(t.name))).toBe(false);
      expect((await verifyExport(pkg)).ok).toBe(true);
      const target = await freshTarget();
      await importExport(env.DB, target, pkg);
      expect(await count('SELECT COUNT(*) AS n FROM garments WHERE user_id = ?', target.userId)).toBe(await count('SELECT COUNT(*) AS n FROM garments WHERE user_id = ?', o.userId));
      expect(await count("SELECT COUNT(*) AS n FROM mcp_grants WHERE user_id = ? AND status = 'active'", target.userId)).toBe(0);
    });

    it('an injected app_sessions table whose access hash is the attacker\'s token is refused, and the token does not work', async () => {
      installApiScenario();
      const o = await apiOwner();
      const pkg = await exportOwnerData(env.DB, o.principal);
      const attackerToken = `attacker-${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      const forged = await inject(pkg, 'app_sessions', [
        { session_id: 'ses_planted_1', client_id: 'garderobe-ios', scope: 'wardrobe:read wardrobe:write', access_hash: await sha256B64url(attackerToken), access_expires_at: '2099-01-01T00:00:00.000Z', refresh_hash: await sha256B64url(`r-${crypto.randomUUID()}`), previous_refresh_hash: null, refresh_expires_at: '2099-01-01T00:00:00.000Z', status: 'active', revoked_reason: null, created_at: now, updated_at: now, last_used_at: null },
      ]);
      const { refused } = await importAndProbe(forged, { bearer: attackerToken });
      expect(refused).toBe(true);
    });

    it('an injected native sign-in code (code hash and challenge the attacker controls) is refused and cannot be redeemed', async () => {
      installApiScenario();
      const o = await apiOwner();
      const pkg = await exportOwnerData(env.DB, o.principal);
      const code = `attacker-code-${crypto.randomUUID()}`;
      const verifier = randomVerifier();
      const forged = await inject(pkg, 'native_auth_codes', [
        { code_hash: await sha256B64url(code), client_id: 'garderobe-ios', redirect_uri: REDIRECT, code_challenge: await s256(verifier), resource: 'http://localhost:8787/v1', scope: 'wardrobe:read wardrobe:write', expires_at: '2099-01-01T00:00:00.000Z', used_at: null, created_at: new Date().toISOString() },
      ]);
      const { refused } = await importAndProbe(forged, { code: { code, verifier } });
      expect(refused).toBe(true);
    });

    it('credential columns smuggled into ordinary tables (token hashes on settings rows, a provider grant handle on grants) are refused', async () => {
      installApiScenario();
      const o = await apiOwner();
      await mcpGrant(o.assertion, 'claude');
      const pkg = await exportOwnerData(env.DB, o.principal);
      const attackerToken = `attacker-${crypto.randomUUID()}`;
      const settings = JSON.parse(pkg.files['data/owner_settings.json']!) as Record<string, unknown>[];
      const withHash = await inject(pkg, 'owner_settings', settings.map((r) => ({ ...r, access_hash: 'x', REFRESH_HASH: 'y', api_token: 'z' })));
      expect((await importAndProbe(withHash, { bearer: attackerToken })).refused).toBe(true);
      const grants = JSON.parse(pkg.files['data/mcp_grants.json'] ?? '[]') as Record<string, unknown>[];
      expect(grants.length).toBeGreaterThan(0);
      const withHandle = await inject(pkg, 'mcp_grants', grants.map((g) => ({ ...g, provider_grant_id: 'attacker-grant', status: 'active', revoked_at: null })));
      expect((await importAndProbe(withHandle, {})).refused).toBe(true);
    });

    it('grants edited back to active (no credential column) restore revoked, never as a working connection', async () => {
      installApiScenario();
      const o = await apiOwner();
      await mcpGrant(o.assertion, 'claude');
      const pkg = await exportOwnerData(env.DB, o.principal);
      const grants = JSON.parse(pkg.files['data/mcp_grants.json'] ?? '[]') as Record<string, unknown>[];
      const forged = await inject(pkg, 'mcp_grants', grants.map((g) => ({ ...g, status: 'active', revoked_at: null, revoked_reason: null, version: 1 })));
      const { refused, target } = await importAndProbe(forged, {});
      if (!refused) expect(await count("SELECT COUNT(*) AS n FROM mcp_grants WHERE user_id = ? AND status = 'revoked'", target.userId)).toBe(grants.length);
    });

    it('a manifest that relabels a credential table as an ordinary file, or excluded tables listed as present, is refused', async () => {
      installApiScenario();
      const o = await apiOwner();
      const pkg = await exportOwnerData(env.DB, o.principal);
      const attackerToken = `attacker-${crypto.randomUUID()}`;
      const row = { session_id: 'ses_x', client_id: 'garderobe-ios', scope: 'wardrobe:read', access_hash: await sha256B64url(attackerToken), access_expires_at: '2099-01-01T00:00:00.000Z', refresh_hash: 'r', refresh_expires_at: '2099-01-01T00:00:00.000Z', status: 'active', created_at: '2026-09-29T00:00:00.000Z', updated_at: '2026-09-29T00:00:00.000Z' };
      // The data file is named innocently, but the manifest says it holds app_sessions.
      const files = { ...pkg.files, 'data/extra.json': canonicalJson([row]) };
      const relabelled = await reseal({ manifest: { ...pkg.manifest, tables: [...pkg.manifest.tables, { name: 'app_sessions', file: 'data/extra.json', rows: 1, sha256: '' }] }, files });
      expect((await importAndProbe(relabelled, { bearer: attackerToken })).refused).toBe(true);
    });
  });
});

describe('connection to the owner survives the attempts', () => {
  it('the owner can still use a fresh MCP grant after all of the above (control)', async () => {
    installApiScenario();
    const o = await apiOwner();
    const c = await connectMcp((await mcpGrant(o.assertion, 'claude')).accessToken);
    expect((await c.client.listTools()).tools.length).toBe(7);
    await c.close();
  });
});
