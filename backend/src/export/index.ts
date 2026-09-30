import { canonicalJson, sha256Hex } from '../domain/hash.js';
import { DomainError } from '../domain/errors.js';
import { assertPrincipal, type Principal } from '../domain/principal.js';
import { withoutPastedSecrets } from '../assistant/secrets.js';

/**
 * Portable owner export (spec section 15, "Portable owner export").
 *
 * One package: a versioned manifest with checksums, export time and store watermarks; documented
 * JSON records for every owner table (discovered from the schema, so tables added by other
 * workstreams are included automatically); readable Markdown/CSV views; a README. Credentials,
 * recovery verifiers, identity subjects, cookies, raw reasoning and derived search indexes are
 * excluded. Deletion tombstones apply. `importExport` verifies checksums and loads the package into
 * an empty owner without changing ids or replaying external effects.
 */

export const EXPORT_FORMAT = 'garderobe-export/1';

/** Tables never exported (credentials, identity bindings, operational ledgers, derived indexes). */
const EXCLUDED_TABLES = new Set([
  'users',
  'auth_identities',
  'recovery_credentials',
  'recovery_attempts',
  'identity_security',
  'model_reservations',
  'model_runs',
  'connector_calls',
  'recall_index_docs',
  'recall_watermarks',
  'export_manifests',
  'command_preconditions',
  // Native app sessions and sign-in codes: bearer-token hashes, never exported or restored.
  'app_sessions',
  'native_auth_codes',
]);
/** Columns that hold credential material (secrets, token hashes, code challenges, provider grant handles). */
const SECRET_COLUMN = /secret|token|verifier|password|cookie|credential_ref|^access_hash$|refresh_hash$|^code_hash$|^code_challenge$|^provider_grant_id$/i;

/**
 * The no-credentials check: a package must carry no credential table and no credential column.
 * verifyExport reports these, so importExport refuses a package that carries them.
 */
export function credentialProblems(pkg: ExportPackage): string[] {
  const problems: string[] = [];
  for (const t of pkg.manifest.tables) if (EXCLUDED_TABLES.has(t.name)) problems.push(`credential table ${t.name} present`);
  for (const [path, body] of Object.entries(pkg.files)) {
    const m = /^data\/([a-z0-9_]+)\.json$/.exec(path);
    if (!m) continue;
    if (EXCLUDED_TABLES.has(m[1]!)) {
      if (!problems.includes(`credential table ${m[1]} present`)) problems.push(`credential table ${m[1]} present`);
      continue;
    }
    let rows: unknown;
    try {
      rows = JSON.parse(body);
    } catch {
      problems.push(`unreadable ${path}`);
      continue;
    }
    const cols = new Set<string>();
    for (const r of Array.isArray(rows) ? rows : []) if (r && typeof r === 'object') for (const k of Object.keys(r)) if (SECRET_COLUMN.test(k)) cols.add(k);
    for (const c of cols) problems.push(`credential column ${m[1]}.${c} present`);
  }
  return problems;
}

export interface ExportManifest {
  format: typeof EXPORT_FORMAT;
  exportId: string;
  exportedAt: string;
  owner: { userId: string; displayName: string | null };
  watermarks: { lastReceiptRecordedAt: string | null; recallSourceSeq: number; tombstones: number };
  tables: { name: string; file: string; rows: number; sha256: string }[];
  files: { path: string; sha256: string }[];
  excluded: string[];
  complete: boolean;
  incomplete: { component: string; reason: string }[];
  packageSha256: string;
}

export interface ExportPackage {
  manifest: ExportManifest;
  files: Record<string, string>;
}

async function ownerTables(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'").all<{ name: string }>();
  const out: string[] = [];
  for (const { name } of results) {
    if (EXCLUDED_TABLES.has(name) || !/^[a-z0-9_]+$/.test(name)) continue;
    const cols = await db.prepare(`SELECT name FROM pragma_table_info('${name}')`).all<{ name: string }>();
    if (cols.results.some((c) => c.name === 'user_id')) out.push(name);
  }
  return topoSort(db, out);
}

/** Parents before children, from the schema's foreign keys. */
async function topoSort(db: D1Database, tables: string[]): Promise<string[]> {
  const deps = new Map<string, Set<string>>();
  for (const t of tables) {
    const fk = await db.prepare(`SELECT "table" AS parent FROM pragma_foreign_key_list('${t}')`).all<{ parent: string }>();
    deps.set(t, new Set(fk.results.map((r) => r.parent).filter((p) => p !== t && tables.includes(p))));
  }
  const order: string[] = [];
  const visiting = new Set<string>();
  const visit = (t: string) => {
    if (order.includes(t) || visiting.has(t)) return;
    visiting.add(t);
    for (const d of deps.get(t) ?? []) visit(d);
    visiting.delete(t);
    order.push(t);
  };
  [...tables].sort().forEach(visit);
  return order;
}

function csv(rows: Record<string, unknown>[], columns: string[]): string {
  const esc = (v: unknown) => {
    let s = v === null || v === undefined ? '' : String(v);
    // Spreadsheet formula injection: a cell starting with = + - @, tab or CR is shown as text.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n');
}

const README = `# Garderobe export (${EXPORT_FORMAT})

This package is a complete, private copy of one owner's Garderobe records.

- manifest.json lists every file with its SHA-256 checksum, the export time and store watermarks.
- data/<table>.json holds the records of each table as JSON arrays. Ids are stable opaque ids; relationships use them (e.g. order_lines.order_id -> orders.order_id, stock_lots.garment_id -> garments.garment_id).
- Dates: timestamps are UTC ISO-8601; local dates (wearing_date, board_date) are YYYY-MM-DD in the stated timezone. A counted wear is one per garment and local wearing date.
- Units: quantities are units; prices are minor currency units with an explicit currency; measurements carry their own unit.
- Recorded wear counts start when logging began (owner_settings.wear_logging_since); zero means unlogged, not unworn.
- Estimates (availability, laundry resets) are estimates, not observations. Command receipts are the audit trail.
- views/ has readable copies: the profile verbatim (profile.md) and a garment list (garments.csv).
- conversation/messages.json holds the original conversation messages with dates when supplied by the assistant actor.
- Excluded by design: credentials and connection secrets, recovery verifiers, login identity subjects, native app sessions and sign-in codes (and every token hash), browser cookies, raw model reasoning, and derived search indexes (rebuildable). Connected assistants (Claude, ChatGPT) are listed but restore as revoked: reconnect them after a restore. Media bytes are referenced by their storage keys.
- Spreadsheet safety: in views/*.csv a cell that would start with = + - @ is prefixed with ' so it opens as text.
`;

/**
 * Conversation text in any exported row or message loses pasted credentials (recovery codes, link
 * tokens, keys), including rows written before turns were redacted on acceptance (ADV-17).
 */
function exportValue(v: unknown): unknown {
  return typeof v === 'string' ? withoutPastedSecrets(v, { highEntropy: false }) : v;
}

export async function exportOwnerData(
  db: D1Database,
  principal: Principal,
  opts: { now?: string; transcript?: { id: string; role: string; text: string; createdAt?: string }[] } = {},
): Promise<ExportPackage> {
  assertPrincipal(principal);
  const userId = principal.userId;
  const exportedAt = opts.now ?? new Date().toISOString();
  const files: Record<string, string> = {};
  const tables: ExportManifest['tables'] = [];
  const incomplete: ExportManifest['incomplete'] = [];
  const tombstones = (await db.prepare('SELECT source_id FROM recall_tombstones WHERE user_id = ?').bind(userId).all<{ source_id: string }>()).results.map((r) => r.source_id);
  for (const table of await ownerTables(db)) {
    const { results } = await db.prepare(`SELECT * FROM ${table} WHERE user_id = ?`).bind(userId).all<Record<string, unknown>>();
    const rows = results
      .filter((r) => !(table.startsWith('recall_') && table !== 'recall_tombstones' && tombstones.includes(String(r.message_id ?? r.source_id))))
      .map((r) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r)) if (k !== 'user_id' && !SECRET_COLUMN.test(k)) out[k] = exportValue(v);
        return out;
      });
    const path = `data/${table}.json`;
    files[path] = canonicalJson(rows);
    tables.push({ name: table, file: path, rows: rows.length, sha256: await sha256Hex(files[path]!) });
  }
  const profile = await db.prepare("SELECT title, version, body FROM style_documents WHERE user_id = ? AND is_current = 1 ORDER BY imported_at").bind(userId).all<{ title: string; version: number; body: string }>();
  files['views/profile.md'] = profile.results.map((p) => p.body).join('\n\n---\n\n');
  const garments = await db.prepare('SELECT garment_id, name, category, maker, color, size_label, acquisition, planning_policy, location FROM garments WHERE user_id = ? ORDER BY category, name').bind(userId).all<Record<string, unknown>>();
  files['views/garments.csv'] = csv(garments.results, ['garment_id', 'name', 'category', 'maker', 'color', 'size_label', 'acquisition', 'planning_policy', 'location']);
  files['README.md'] = README;
  if (opts.transcript) files['conversation/messages.json'] = canonicalJson(opts.transcript.filter((m) => !tombstones.includes(m.id)).map((m) => ({ ...m, text: withoutPastedSecrets(m.text) })));
  else incomplete.push({ component: 'conversation transcript', reason: 'The original Session messages were not supplied by the assistant actor for this export; recall projections are included.' });
  const media = await db.prepare('SELECT COUNT(*) AS n FROM media_assets WHERE user_id = ?').bind(userId).first<{ n: number }>();
  if ((media?.n ?? 0) > 0) incomplete.push({ component: 'media bytes', reason: 'Media are referenced by storage key; bytes are exported separately from R2.' });
  const fileList: ExportManifest['files'] = [];
  for (const [path, body] of Object.entries(files)) fileList.push({ path, sha256: await sha256Hex(body) });
  fileList.sort((a, b) => a.path.localeCompare(b.path));
  const user = await db.prepare('SELECT display_name FROM users WHERE user_id = ?').bind(userId).first<{ display_name: string }>();
  const lastReceipt = await db.prepare('SELECT MAX(recorded_at) AS t FROM command_receipts WHERE user_id = ?').bind(userId).first<{ t: string | null }>();
  const seq = await db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM recall_messages WHERE user_id = ?').bind(userId).first<{ n: number }>();
  const manifest: Omit<ExportManifest, 'packageSha256'> = {
    format: EXPORT_FORMAT,
    exportId: `exp_${crypto.randomUUID().replace(/-/g, '')}`,
    exportedAt,
    owner: { userId, displayName: user?.display_name ?? null },
    watermarks: { lastReceiptRecordedAt: lastReceipt?.t ?? null, recallSourceSeq: seq?.n ?? 0, tombstones: tombstones.length },
    tables,
    files: fileList,
    excluded: [...EXCLUDED_TABLES].sort(),
    complete: incomplete.length === 0,
    incomplete,
  };
  const packageSha256 = await sha256Hex(canonicalJson(manifest));
  await db
    .prepare('INSERT INTO export_manifests (user_id, export_id, status, manifest_json, watermark, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(userId, manifest.exportId, manifest.complete ? 'complete' : 'incomplete', JSON.stringify({ ...manifest, packageSha256 }), manifest.watermarks.lastReceiptRecordedAt, exportedAt, exportedAt)
    .run();
  return { manifest: { ...manifest, packageSha256 }, files };
}

export async function verifyExport(pkg: ExportPackage): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  const { packageSha256, ...rest } = pkg.manifest;
  if ((await sha256Hex(canonicalJson(rest))) !== packageSha256) problems.push('manifest checksum mismatch');
  for (const f of pkg.manifest.files) {
    const body = pkg.files[f.path];
    if (body === undefined) problems.push(`missing file ${f.path}`);
    else if ((await sha256Hex(body)) !== f.sha256) problems.push(`checksum mismatch for ${f.path}`);
  }
  for (const t of pkg.manifest.tables) if (!pkg.manifest.files.some((f) => f.path === t.file)) problems.push(`table ${t.name} not listed in files`);
  problems.push(...credentialProblems(pkg));
  return { ok: problems.length === 0, problems };
}

/**
 * Load a verified package into an EMPTY owner (a fresh isolated fixture). Ids are preserved, external
 * effects are imported as superseded (never replayed), connections arrive disconnected, connected
 * assistants (MCP grants) arrive revoked, pending confirmations arrive cancelled, and sessions or
 * sign-in codes are never recreated: the restored owner signs in and reconnects afresh.
 */
export async function importExport(db: D1Database, target: Principal, pkg: ExportPackage, opts: { now?: string } = {}): Promise<{ tables: { name: string; rows: number }[] }> {
  assertPrincipal(target);
  const importedAt = opts.now ?? new Date().toISOString();
  const v = await verifyExport(pkg);
  if (!v.ok) throw new DomainError('validation_failed', `Export failed verification: ${v.problems.join('; ')}`);
  if (pkg.manifest.format !== EXPORT_FORMAT) throw new DomainError('validation_failed', `Unsupported export format ${pkg.manifest.format}`);
  const occupied = await db.prepare('SELECT (SELECT COUNT(*) FROM garments WHERE user_id = ?1) + (SELECT COUNT(*) FROM style_documents WHERE user_id = ?1) + (SELECT COUNT(*) FROM command_receipts WHERE user_id = ?1) AS n').bind(target.userId).first<{ n: number }>();
  if ((occupied?.n ?? 0) > 0) throw new DomainError('invalid_state', 'Imports go into an empty owner only; this owner already has records');
  const known = new Set(await ownerTables(db));
  const order = pkg.manifest.tables.map((t) => t.name).filter((t) => known.has(t));
  const sorted = (await topoSort(db, order)).filter((t) => order.includes(t));
  const out: { name: string; rows: number }[] = [];
  for (const table of sorted) {
    const rows = JSON.parse(pkg.files[`data/${table}.json`] ?? '[]') as Record<string, unknown>[];
    const cols = new Set((await db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>()).results.map((c) => c.name));
    const statements: D1PreparedStatement[] = [];
    for (const r of rows) {
      const row: Record<string, unknown> = { ...r, user_id: target.userId };
      if (table === 'command_effects' && row.status !== 'projected') row.status = 'superseded';
      if (table === 'connections') row.status = 'disconnected';
      if (table === 'mcp_grants' && row.status !== 'revoked') {
        row.status = 'revoked';
        row.revoked_at = importedAt;
        row.revoked_reason = 'restored from an export; reconnect to authorize';
      }
      if (table === 'pending_actions' && row.status === 'pending') row.status = 'cancelled';
      const keys = Object.keys(row).filter((k) => cols.has(k) && !SECRET_COLUMN.test(k));
      const verb = table === 'owner_settings' ? 'INSERT OR REPLACE' : 'INSERT';
      statements.push(db.prepare(`${verb} INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).bind(...keys.map((k) => row[k] ?? null)));
    }
    for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));
    out.push({ name: table, rows: rows.length });
  }
  return { tables: out };
}
