/**
 * Dev-only probe: two confirmations of two different staged imports racing on the real D1 (the race
 * the adversarial suite caught once, where both imports landed in one owner). Everything runs through
 * the product code: staging (`stageImportPackage`), the pending confirmation the MCP tool opens
 * (`openPending` with an operation envelope), and the owner's answer (`answerRun`, what
 * `POST /v1/runs/{id}/input` and `/confirm/{runId}` call), fired concurrently.
 *
 * Only synthetic owners are used (two tiny sources and one fresh empty target per round, labelled as
 * probe owners, like probe/d1). They stay in the dev database: imported receipts are immutable by
 * design. Returns ids, counts and outcome codes only.
 */
import { CommandService, createUser, ownerPrincipal } from '../../backend/src/domain/index.js';
import { exportOwnerData } from '../../backend/src/export/index.js';
import type { Principal } from '../../backend/src/domain/principal.js';
import { stageImportPackage } from '../../backend/src/api/portability.js';
import { importData } from '../../backend/src/api/surface.js';
import { answerRun, openPending } from '../../backend/src/mcp/pending.js';
import { stateSecret } from '../../backend/src/auth/oauth.js';
import { HttpError } from '../../backend/src/api/http.js';
import type { Env } from '../../backend/src/env.js';

const TZ = 'Europe/London';

async function source(env: Env, label: string, items: string[]) {
  const { userId } = await createUser(env.DB, {
    displayName: `Import-race probe source ${label} (synthetic, not the owner)`,
    identity: { issuer: 'garderobe-dev-probe', subject: `probe-${crypto.randomUUID()}` },
    settings: { homeLocationLabel: 'London', timezone: TZ, wearLoggingSince: '2026-01-01' },
  });
  const p = ownerPrincipal(userId, 'dev-probe');
  for (const name of items) {
    const r = await new CommandService(env.DB, p).execute({ idempotencyKey: `probe-${crypto.randomUUID()}`, source: 'app', command: { type: 'add_item', explicit: true, name, category: 'shirt', roles: ['base_top'] } } as never);
    if (r.outcome !== 'committed') throw new Error(`add_item ${r.outcome} ${r.error?.code}`);
  }
  return exportOwnerData(env.DB, p, { now: new Date().toISOString(), transcript: [] });
}

async function target(env: Env): Promise<Principal> {
  const { userId } = await createUser(env.DB, {
    displayName: 'Import-race probe target (synthetic, not the owner)',
    identity: { issuer: 'garderobe-dev-probe', subject: `probe-${crypto.randomUUID()}` },
  });
  return ownerPrincipal(userId, 'dev-probe');
}

const code = (r: PromiseSettledResult<unknown>) => (r.status === 'fulfilled' ? 'ok' : r.reason instanceof HttpError || (r.reason && typeof r.reason === 'object' && 'code' in r.reason) ? String((r.reason as { code: string }).code) : String(r.reason).slice(0, 80));
const garments = async (env: Env, userId: string) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM garments WHERE user_id = ?').bind(userId).first<{ n: number }>())!.n;

export async function probeImportRace(env: Env, ctx: ExecutionContext, body: { rounds?: number }) {
  const rounds = Math.min(Math.max(Math.trunc(Number(body?.rounds ?? 5)) || 5, 1), 20);
  const t0 = Date.now();
  const [pkgA, pkgB] = [await source(env, 'A', ['Probe shirt A1', 'Probe shirt A2']), await source(env, 'B', ['Probe shirt B1', 'Probe shirt B2', 'Probe shirt B3'])];
  const sizes = new Set([2, 3]);
  const results: Record<string, unknown>[] = [];
  for (let round = 0; round < rounds; round++) {
    // Confirmations: stage both, open both confirmation requests, answer both at the same moment.
    const p = await target(env);
    const staged = [await stageImportPackage(env, p, pkgA, 'dev-probe'), await stageImportPackage(env, p, pkgB, 'dev-probe')];
    const runs: string[] = [];
    for (const s of staged) {
      const envelope = { idempotencyKey: `probe-race-${crypto.randomUUID()}`, operation: { type: 'import_data' as const, packageId: s.packageId } };
      const { row } = await openPending(env, p, { envelope, question: { kind: 'confirm', prompt: 'Probe import', choices: [{ id: 'confirm', label: 'Yes' }, { id: 'decline', label: 'No' }] }, surface: 'mcp', args: envelope, grantRef: null, secret: stateSecret(env) });
      runs.push(row.run_id!);
    }
    const order = round % 2 ? [...runs].reverse() : runs;
    const settled = await Promise.allSettled(order.map((run) => answerRun(env, ctx, p, run, 'confirm')));
    const outcomes = settled.map((s) => (s.status === 'fulfilled' ? (s.value as { status: string }).status : code(s)));
    const n = await garments(env, p.userId);
    const imported = (await env.DB.prepare("SELECT COUNT(*) AS n FROM account_audit WHERE user_id = ? AND action = 'import' AND outcome = 'imported'").bind(p.userId).first<{ n: number }>())!.n;
    results.push({ round, path: 'confirmations', targetUserId: p.userId, outcomes, garments: n, importedAudits: imported, pass: outcomes.filter((o) => o === 'executed').length === 1 && sizes.has(n) && imported === 1 });
    // Direct imports (POST /v1/import's function) racing each other.
    const d = await target(env);
    const direct = await Promise.allSettled([importData(env, d, pkgA), importData(env, d, pkgB)]);
    const dn = await garments(env, d.userId);
    results.push({ round, path: 'direct', targetUserId: d.userId, outcomes: direct.map(code), garments: dn, pass: direct.filter((r) => r.status === 'fulfilled').length === 1 && sizes.has(dn) });
  }
  return { probe: 'import-race', rounds, checkedAt: new Date().toISOString(), ms: Date.now() - t0, passed: results.every((r) => r.pass), results };
}
