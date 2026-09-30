import { canonicalJson, sha256Hex } from '../../../backend/src/domain/hash.js';
import type { ExportPackage } from '../../../backend/src/export/index.js';

/**
 * Export-package tampering as an attacker holding the file would do it (the ADV-12 approach): edit
 * files or the manifest, then recompute every file, table and manifest checksum. Checksums detect
 * corruption, not tampering, so a resealed package passes the checksum part of verifyExport.
 */

export async function reseal(pkg: ExportPackage): Promise<ExportPackage> {
  const files = { ...pkg.files };
  const fileList = await Promise.all(Object.entries(files).map(async ([path, body]) => ({ path, sha256: await sha256Hex(body) })));
  fileList.sort((a, b) => a.path.localeCompare(b.path));
  const tables = await Promise.all(pkg.manifest.tables.map(async (t) => ({ ...t, sha256: await sha256Hex(files[t.file] ?? '') })));
  const { packageSha256: _drop, ...rest } = { ...pkg.manifest, files: fileList, tables };
  return { manifest: { ...rest, packageSha256: await sha256Hex(canonicalJson(rest)) }, files };
}

/** Adds (or replaces) a table file and its manifest entry, then reseals. */
export async function injectTable(pkg: ExportPackage, table: string, rows: Record<string, unknown>[]): Promise<ExportPackage> {
  const file = `data/${table}.json`;
  const files = { ...pkg.files, [file]: canonicalJson(rows) };
  const tables = [...pkg.manifest.tables.filter((t) => t.name !== table), { name: table, file, rows: rows.length, sha256: '' }];
  return reseal({ manifest: { ...pkg.manifest, tables, excluded: pkg.manifest.excluded.filter((x) => x !== table) }, files });
}
