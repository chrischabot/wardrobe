import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import '../helpers/assistant.js';
import { accessToken, apiOwner, callJson, idem, installApiScenario, ISSUER, type ApiClock } from '../helpers/api.js';
import { connectMcp, mcpGrant } from '../helpers/mcp.js';
import type { ExportPackage } from '../../src/export/index.js';
import { fencedImportDbForTest, importData, installImportTestHook } from '../../src/api/surface.js';
import { ownerPrincipal } from '../../src/domain/principal.js';
import { HttpError } from '../../src/api/http.js';

/**
 * Two confirmations of two different staged imports arriving at the same moment (the race the
 * adversarial suite caught once on the dev deployment run): at most one import may land in the owner.
 * Each round uses a fresh empty owner, stages two different exports, opens both requests from a real
 * MCP client (the 2025-11-25 adapter, which leaves the confirmation to Garderobe), then fires both
 * owner confirmations (POST /v1/runs/{id}/input) concurrently through the Worker's fetch handler.
 */

const ROUNDS = 50;
const count = async (sql: string, ...binds: unknown[]) => Number((await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n);

async function emptyOwner(): Promise<{ userId: string; assertion: string }> {
  const subject = `race-${crypto.randomUUID()}`;
  const userId = `usr_${crypto.randomUUID().replace(/-/g, '')}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (user_id, display_name, status, created_at, version) VALUES (?, 'Chris', 'active', ?, 1)").bind(userId, '2026-10-05T00:00:00.000Z'),
    env.DB.prepare('INSERT INTO auth_identities (user_id, identity_id, issuer, subject, linked_at) VALUES (?, ?, ?, ?, ?)').bind(userId, `idn_${crypto.randomUUID().replace(/-/g, '')}`, ISSUER, subject, '2026-10-05T00:00:00.000Z'),
  ]);
  return { userId, assertion: await accessToken(subject) };
}

describe('concurrent import confirmations', () => {
  let clock: ApiClock;
  let pkgA: ExportPackage;
  let pkgB: ExportPackage;
  beforeAll(async () => {
    ({ clock } = installApiScenario({ now: '2026-10-06T05:30:00.000Z', scenario: 'mild' }));
    const a = await apiOwner();
    const b = await apiOwner();
    pkgA = (await callJson<ExportPackage>('/v1/export', { assertion: a.assertion, body: {} })).body;
    pkgB = (await callJson<ExportPackage>('/v1/export', { assertion: b.assertion, body: {} })).body;
    expect(pkgA.manifest.exportId).not.toBe(pkgB.manifest.exportId);
  });

  it(`two different staged packages confirmed at the same moment import at most once (${ROUNDS} rounds)`, { timeout: 600_000 }, async () => {
    const outcomes = { imported: 0, refusedInProgress: 0, refusedOccupied: 0 };
    for (let round = 0; round < ROUNDS; round++) {
      const target = await emptyOwner();
      const grant = await mcpGrant(target.assertion, 'claude');
      const staged = await Promise.all([pkgA, pkgB].map(async (p) => (await callJson<{ packageId: string }>('/v1/import/packages', { assertion: target.assertion, body: p })).body.packageId));
      const c = await connectMcp(grant.accessToken, { mode: 'legacy' });
      const runs: string[] = [];
      for (const packageId of staged) {
        const r = (await c.client.callTool({ name: 'garderobe_command', arguments: { idempotencyKey: idem('race'), operation: { type: 'import_data', packageId } } })) as { structuredContent: { status: string; runId: string } };
        expect(r.structuredContent.status).toBe('awaiting_owner');
        runs.push(r.structuredContent.runId);
      }
      await c.close();
      // Alternate which confirmation is sent first, so neither side always wins.
      const order = round % 2 ? [...runs].reverse() : runs;
      const answers = await Promise.all(order.map((run) => callJson<{ status?: string; error?: { code: string } }>(`/v1/runs/${run}/input`, { assertion: target.assertion, body: { choiceId: 'confirm' } })));
      const ok = answers.filter((x) => x.status === 200 && x.body.status === 'executed');
      const refused = answers.filter((x) => x.status !== 200);
      expect(ok.length, `round ${round}`).toBe(1);
      expect(refused.length, `round ${round}`).toBe(1);
      expect(refused[0]!.status, `round ${round}`).toBe(409);
      if (refused[0]!.body.error?.code === 'import_in_progress') outcomes.refusedInProgress++;
      else outcomes.refusedOccupied++;
      outcomes.imported++;
      expect(await count('SELECT COUNT(*) AS n FROM garments WHERE user_id = ?', target.userId), `round ${round}`).toBe(144);
      expect(await count("SELECT COUNT(*) AS n FROM account_audit WHERE user_id = ? AND action = 'import' AND outcome = 'imported'", target.userId)).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM import_claims WHERE owner_user = ? AND status = 'imported'", target.userId)).toBe(1);
      // Exactly one of the two packages landed; the other is still staged, untouched.
      const statuses = (await env.DB.prepare("SELECT status FROM account_transfers WHERE user_id = ? AND kind = 'import_package' ORDER BY status").bind(target.userId).all<{ status: string }>()).results.map((r) => r.status);
      expect(statuses).toEqual(['imported', 'staged']);
    }
    expect(outcomes.imported).toBe(ROUNDS);
    console.log('import race outcomes', outcomes);
  });

  it('a package that fails verification releases the claim, so a valid import still works; a second import is refused', async () => {
    const target = await emptyOwner();
    const tampered = { ...pkgA, files: { ...pkgA.files, 'views/profile.md': 'edited' } };
    expect((await callJson('/v1/import', { assertion: target.assertion, body: tampered })).status).toBe(422);
    expect(await count('SELECT COUNT(*) AS n FROM import_claims WHERE owner_user = ?', target.userId)).toBe(0);
    expect((await callJson('/v1/import', { assertion: target.assertion, body: pkgA })).status).toBe(200);
    const again = await callJson<{ error: { code: string } }>('/v1/import', { assertion: target.assertion, body: pkgB });
    expect(again.status).toBe(409);
    expect(await count('SELECT COUNT(*) AS n FROM garments WHERE user_id = ?', target.userId)).toBe(144);
  });

  it('direct HTTP imports racing each other also land once', async () => {
    for (let round = 0; round < 10; round++) {
      const target = await emptyOwner();
      const answers = await Promise.all([pkgA, pkgB].map((p) => callJson('/v1/import', { assertion: target.assertion, body: p })));
      expect(answers.map((x) => x.status).sort()).toEqual([200, 409]);
      expect(await count('SELECT COUNT(*) AS n FROM garments WHERE user_id = ?', target.userId)).toBe(144);
    }
  });

  describe('a stalled importer (the reviewer’s scenario)', () => {
    const garmentIds = (p: ExportPackage) => (JSON.parse(p.files['data/garments.json']!) as { garment_id: string }[]).map((g) => g.garment_id);
    const landed = async (userId: string, p: ExportPackage) => {
      const ids = new Set(garmentIds(p));
      const { results } = await env.DB.prepare('SELECT garment_id FROM garments WHERE user_id = ?').bind(userId).all<{ garment_id: string }>();
      return results.filter((r) => ids.has(r.garment_id)).length;
    };
    const rowsIn = async (userId: string) => {
      const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'").all<{ name: string }>()).results.map((t) => t.name);
      let total = 0;
      for (const t of tables) {
        const cols = (await env.DB.prepare(`SELECT name FROM pragma_table_info('${t}')`).all<{ name: string }>()).results.map((c) => c.name);
        if (!cols.includes('user_id') || ['users', 'auth_identities', 'owner_settings', 'account_audit'].includes(t)) continue;
        total += Number((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).bind(userId).first<{ n: number }>())!.n);
      }
      return total;
    };

    /**
     * Importer A passes the empty-owner check and every check inside the import service, then stalls
     * just before its first write (the injected hook) for longer than the takeover window. Importer B
     * takes the claim over and imports. A then resumes. Only B's package may land.
     */
    async function stallBeforeWrite(atBatch: number) {
      const t0 = clock.value;
      const target = await emptyOwner();
      let stalledClaim: string | null = null;
      let reached!: () => void;
      let release!: () => void;
      const atStall = new Promise<void>((r) => (reached = r));
      const gate = new Promise<void>((r) => (release = r));
      installImportTestHook(async (claimId, batch) => {
        if (stalledClaim === null && batch === atBatch) stalledClaim = claimId;
        if (claimId === stalledClaim && batch === atBatch) {
          reached();
          await gate;
        }
      });
      // Called in-process (the function behind POST /v1/import and MCP import_data): workerd does not let
      // one request wait on a promise resolved from another, so the stall cannot be held across fetches.
      const principal = ownerPrincipal(target.userId, 'test');
      const run = (p: ExportPackage) =>
        importData(env, principal, p).then(
          () => ({ status: 200, body: {} as { error?: { code: string } } }),
          (err: unknown) => {
            if (err instanceof HttpError) return { status: err.status, body: { error: { code: err.code } } };
            if (err && typeof err === 'object' && 'code' in err) return { status: 409, body: { error: { code: String((err as { code: string }).code) } } };
            throw err;
          },
        );
      let a: ReturnType<typeof run> | null = null;
      try {
        a = run(pkgA);
        await atStall;
        clock.set(new Date(Date.parse(t0) + 11 * 60_000).toISOString());
        const b = await run(pkgB);
        release();
        return { target, a: await a, b };
      } finally {
        // Always let the stalled importer finish before restoring the hook and clock, even if B threw.
        release();
        if (a) await a.catch(() => undefined);
        installImportTestHook(null);
        clock.set(t0);
      }
    }

    it('stalled before its first write: B takes over and imports; A resumes and writes nothing', async () => {
      const { target, a, b } = await stallBeforeWrite(0);
      expect(b.status).toBe(200);
      expect(a.status).toBe(409);
      expect(a.body.error!.code).toBe('import_superseded');
      expect(await landed(target.userId, pkgB)).toBe(garmentIds(pkgB).length);
      expect(await landed(target.userId, pkgA)).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM garments WHERE user_id = ?', target.userId)).toBe(144);
      expect(await count("SELECT COUNT(*) AS n FROM import_claims WHERE owner_user = ? AND status = 'imported'", target.userId)).toBe(1);
    });

    it('stalled after writing: the claim is never taken over, so nothing is laid on top of partial rows', async () => {
      const { target, a, b } = await stallBeforeWrite(1);
      expect(b.status).toBe(409);
      expect(b.body.error!.code).toBe('import_in_progress');
      expect(a.status).toBe(200);
      expect(await landed(target.userId, pkgA)).toBe(garmentIds(pkgA).length);
      expect(await landed(target.userId, pkgB)).toBe(0);
    });

    it('a fenced batch leaves nothing: an importer whose claim is gone cannot write even its first rows', async () => {
      const target = await emptyOwner();
      installImportTestHook(async (claimId, batch) => {
        if (batch === 0) await env.DB.prepare('DELETE FROM import_claims WHERE claim_id = ?').bind(claimId).run();
      });
      try {
        const a = await callJson<{ error?: { code: string } }>('/v1/import', { assertion: target.assertion, body: pkgA });
        expect(a.status).toBe(409);
        expect(a.body.error!.code).toBe('import_superseded');
      } finally {
        installImportTestHook(null);
      }
      expect(await rowsIn(target.userId)).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM command_preconditions WHERE check_id LIKE ?', 'icl_fence_%')).toBe(0);
    });

    it('the import handle refuses every write path except the fenced batch (reads still work)', async () => {
      const target = await emptyOwner();
      const fenced = fencedImportDbForTest(env.DB, target.userId, 'icl_none');
      const insert = () => fenced.prepare("INSERT INTO style_documents (user_id) VALUES (?)").bind(target.userId);
      expect(() => insert().run()).toThrow(/claim-fenced batch/);
      expect(() => fenced.exec('DELETE FROM garments')).toThrow(/claim-fenced batch/);
      expect(() => (fenced as unknown as { withSession: () => unknown }).withSession()).toThrow(/claim-fenced batch/);
      // A batch without a held claim fails as a whole.
      await expect(fenced.batch([insert()])).rejects.toThrow(/CHECK constraint failed/);
      expect(await fenced.prepare('SELECT COUNT(*) AS n FROM garments WHERE user_id = ?').bind(target.userId).first<{ n: number }>()).toEqual({ n: 0 });
      expect(await rowsIn(target.userId)).toBe(0);
    });
  });
});
