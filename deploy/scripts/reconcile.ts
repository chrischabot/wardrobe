/**
 * Compares the owner's imported state on dev D1 with the local import (`npm run seed:demo`, local D1
 * under backend/.wrangler), using one signature query: garments and units per category, migration
 * issues by source and status and their stable keys, rule count and profile hash. Only counts, keys
 * and hashes are compared or printed, never garment content.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { backendDir } from './lib.js';

/**
 * Separate statements: D1 limits the number of terms in a compound SELECT. Garments still incoming
 * (not yet arrived) are left out: on dev they come only from the labelled TEST EVENT order, which
 * the local seed skips when its import is too recent; they carry no imported units.
 */
const SIGNATURE_SQL = (userExpr: string): string[] => [
  `SELECT 'g:' || category AS k, COUNT(*) AS n FROM garments WHERE user_id = ${userExpr} AND acquisition <> 'incoming' GROUP BY category`,
  `SELECT 'u:' || g.category AS k, SUM(s.clean_qty + s.worn_qty + s.hamper_qty + s.laundry_qty + s.storage_qty + s.away_qty + s.retired_qty) AS n
    FROM stock_lots s JOIN garments g ON g.user_id = s.user_id AND g.garment_id = s.garment_id WHERE s.user_id = ${userExpr} GROUP BY g.category`,
  `SELECT 'i:' || source_system || ':' || CASE WHEN resolved_at IS NULL THEN 'open' ELSE 'resolved' END AS k, COUNT(*) AS n FROM migration_issues WHERE user_id = ${userExpr} GROUP BY 1`,
  `SELECT 'ik:' || issue_key AS k, 1 AS n FROM migration_issues WHERE user_id = ${userExpr}`,
  `SELECT 'rules' AS k, COUNT(*) AS n FROM style_rules WHERE user_id = ${userExpr}`,
  `SELECT 'profile:' || content_sha256 AS k, 1 AS n FROM style_documents WHERE user_id = ${userExpr}`,
];

const owner = (issuer: string) => `(SELECT user_id FROM auth_identities WHERE issuer = '${issuer}' AND subject = 'owner' LIMIT 1)`;

function toMap(rows: { k: string; n: number }[]): Map<string, number> {
  return new Map(rows.map((r) => [r.k, r.n]));
}

export async function compareLocalAndDev(devDb: D1Database): Promise<{ matches: boolean | null; note?: string; differences?: string[]; signatureSha256?: { dev: string; local: string | null }; keys?: number }> {
  const devRows: { k: string; n: number }[] = [];
  for (const sql of SIGNATURE_SQL(owner('garderobe-dev-seed'))) devRows.push(...(await devDb.prepare(sql).all<{ k: string; n: number }>()).results);
  const dev = toMap(devRows);
  let localRows: { k: string; n: number }[];
  try {
    const out = execFileSync(join(backendDir, '..', 'node_modules', '.bin', 'wrangler'), ['d1', 'execute', 'DB', '--local', '--json', '--command', SIGNATURE_SQL(owner('local-dev')).map((s) => s.replace(/\s+/g, ' ')).join('; ')], { cwd: backendDir, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    localRows = (JSON.parse(out) as { results: { k: string; n: number }[] }[]).flatMap((r) => r.results);
  } catch (err) {
    return { matches: null, note: `local D1 not readable: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}` };
  }
  if (!localRows.length) return { matches: null, note: 'local D1 has no seeded owner (run npm run seed:demo)' };
  const local = toMap(localRows);
  const sig = (m: Map<string, number>) => createHash('sha256').update(JSON.stringify([...m.entries()].sort())).digest('hex');
  const differences: string[] = [];
  for (const k of new Set([...dev.keys(), ...local.keys()])) {
    if (dev.get(k) !== local.get(k)) differences.push(k.startsWith('ik:') ? `issue ${dev.has(k) ? 'only on dev' : 'only local'}` : `${k}: local ${local.get(k) ?? 0}, dev ${dev.get(k) ?? 0}`);
  }
  return { matches: differences.length === 0, differences, signatureSha256: { dev: sig(dev), local: sig(local) }, keys: dev.size };
}
