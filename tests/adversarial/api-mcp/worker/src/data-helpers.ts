/**
 * Helpers of the data, media, outbound-policy and secrets files (08, 10, 11, 12) of the adversarial suite.
 *
 * Nothing here stands in for the application: packages are requested, downloaded and imported through
 * the real routes, the database scan runs on the real local D1, and the object checks read the real
 * local R2 buckets. `repack` builds what an attacker who holds a package can build: the same ZIP with
 * files changed and the manifest and checksum list recomputed to match (the checksums in a package are
 * not a signature).
 */
import { SELF } from "cloudflare:test";
import { unzipSync, Zip, ZipDeflate, ZipPassThrough, zipSync } from "fflate";
import { APP_ORIGIN, bindings, runCron, sha256, sql, type TestOwner } from "./harness.ts";

export const decoder = new TextDecoder();
export const encoder = new TextEncoder();
export const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* Packages                                                             */
/* ------------------------------------------------------------------ */

export interface OpenedPackage {
  zip: Uint8Array;
  files: Record<string, Uint8Array>;
  manifest: any;
  text(path: string): string;
  json<T = any>(path: string): T;
  /** Every non-media file of the package as one text (media files are image bytes). */
  allText(): string;
}

export function openPackage(zip: Uint8Array): OpenedPackage {
  const files = unzipSync(zip);
  const text = (path: string): string => {
    const data = files[path];
    if (!data) throw new Error(`the package has no file ${path}`);
    return decoder.decode(data);
  };
  return {
    zip,
    files,
    manifest: JSON.parse(text("manifest.json")),
    text,
    json: (path) => JSON.parse(text(path)),
    allText: () =>
      Object.entries(files)
        .filter(([path]) => !path.startsWith("media/"))
        .map(([path, bytes]) => `\n=== ${path} ===\n${decoder.decode(bytes)}`)
        .join(""),
  };
}

/** Request an export through the real route and follow the job until it has settled. */
export async function requestExport(owner: TestOwner, extra: Record<string, unknown> = {}): Promise<any> {
  let job = await owner.api.json("POST", "/v1/exports", { clientRequestId: `adv-export-${crypto.randomUUID()}`, ...extra });
  for (let i = 0; i < 200 && (job.state === "queued" || job.state === "running"); i++) {
    await pause(50);
    job = await owner.api.json("GET", `/v1/exports/${job.exportId}`);
  }
  return job;
}

/** A ticket for an export or a backup of this owner (the real route). */
export async function ticketFor(owner: TestOwner, id: string): Promise<{ url: string; expiresAt: string; fileName: string }> {
  return owner.api.json("POST", id.startsWith("bkp_") ? `/v1/backups/${id}/ticket` : `/v1/exports/${id}/ticket`, {});
}

/** Download with a ticket URL and nothing else (no session), on the given origin. */
export const download = (ticketUrl: string, origin: string = APP_ORIGIN): Promise<Response> => SELF.fetch(`${origin}${ticketUrl}`);

/** Export, download and open the owner's package. The product asks to export again while the wardrobe was changing. */
export async function exportPackage(owner: TestOwner): Promise<OpenedPackage & { job: any }> {
  let job: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    job = await requestExport(owner);
    if (job.state === "completed") break;
  }
  if (job.state !== "completed" && job.state !== "completed_incomplete") throw new Error(`fixture: the export did not finish: ${job.state}`);
  const ticket = await ticketFor(owner, job.exportId);
  const response = await download(ticket.url);
  if (response.status !== 200) throw new Error(`fixture: the export download answered ${response.status}`);
  return { ...openPackage(new Uint8Array(await response.arrayBuffer())), job };
}

/** Take a backup now (the owner's own route), download and open it. */
export async function backupPackage(owner: TestOwner): Promise<OpenedPackage & { backup: any }> {
  let backup = await owner.api.json("POST", "/v1/backups", { clientRequestId: `adv-backup-${crypto.randomUUID()}` });
  for (let i = 0; i < 200 && (backup.state === "queued" || backup.state === "running"); i++) {
    await pause(50);
    backup = ((await owner.api.json("GET", "/v1/backups")).backups as any[]).find((b) => b.backupId === backup.backupId);
  }
  if (backup.state !== "completed" && backup.state !== "completed_incomplete") throw new Error(`fixture: the backup did not finish: ${backup.state}`);
  const ticket = await ticketFor(owner, backup.backupId);
  const response = await download(ticket.url);
  if (response.status !== 200) throw new Error(`fixture: the backup download answered ${response.status}`);
  return { ...openPackage(new Uint8Array(await response.arrayBuffer())), backup };
}

/** Send package bytes to the real import route as this owner. */
export const importInto = (owner: TestOwner, body: Uint8Array | string, headers: Record<string, string> = { "Content-Type": "application/zip" }): Promise<Response> =>
  owner.api.request("POST", "/v1/imports", { raw: body as BodyInit, headers });

/**
 * Build a package from files the way a holder of the package can: the manifest's file list and the
 * checksum list are recomputed from the (changed) files unless the attack is about a stale one.
 */
export async function repack(
  files: Record<string, Uint8Array>,
  options: { keepManifestFiles?: boolean; keepChecksums?: boolean; manifest?: (manifest: any) => void } = {},
): Promise<Uint8Array> {
  const out: Record<string, Uint8Array> = { ...files };
  const manifest = JSON.parse(decoder.decode(out["manifest.json"]!));
  if (!options.keepManifestFiles) {
    manifest.files = [];
    for (const [path, data] of Object.entries(out)) {
      if (path === "manifest.json" || path === "checksums.sha256") continue;
      manifest.files.push({ path, bytes: data.length, sha256: await sha256(data) });
    }
  }
  options.manifest?.(manifest);
  out["manifest.json"] = encoder.encode(JSON.stringify(manifest, null, 1));
  if (!options.keepChecksums) {
    const lines: string[] = [];
    for (const [path, data] of Object.entries(out)) if (path !== "checksums.sha256") lines.push(`${await sha256(data)}  ${path}`);
    out["checksums.sha256"] = encoder.encode(lines.join("\n") + "\n");
  }
  return zipSync(out);
}

/** Replace one JSON file of a package (returns a new file map). */
export function withJson(files: Record<string, Uint8Array>, path: string, change: (value: any) => void): Record<string, Uint8Array> {
  const value = JSON.parse(decoder.decode(files[path]!));
  change(value);
  return { ...files, [path]: encoder.encode(JSON.stringify(value)) };
}

function joinChunks(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** A ZIP written entry by entry, so the same name can appear twice (which an object of files cannot express). */
export function zipEntries(entries: [string, Uint8Array][]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  for (const [name, data] of entries) {
    const entry = new ZipPassThrough(name);
    zip.add(entry);
    entry.push(data, true);
  }
  zip.end();
  return joinChunks(chunks);
}

/**
 * A ZIP whose extra entry inflates to `megabytes` of zero bytes from a few hundred kilobytes (a zip bomb),
 * written as a stream so the test never holds the inflated data itself.
 */
export function zipWithBomb(files: Record<string, Uint8Array>, bombName: string, megabytes: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  for (const [name, data] of Object.entries(files)) {
    const entry = new ZipDeflate(name, { level: 6 });
    zip.add(entry);
    entry.push(data, true);
  }
  const bomb = new ZipDeflate(bombName, { level: 9 });
  zip.add(bomb);
  const block = new Uint8Array(1024 * 1024);
  for (let i = 0; i < megabytes; i++) bomb.push(block, i === megabytes - 1);
  zip.end();
  return joinChunks(chunks);
}

/* ------------------------------------------------------------------ */
/* Reading every table                                                  */
/* ------------------------------------------------------------------ */

export interface TableHit {
  table: string;
  column: string;
  /** The LABEL of the planted value that was found (never the value). */
  needle: string;
  rows: number;
}

export async function tableNames(): Promise<string[]> {
  const rows = await sql<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY name");
  return rows.map((r) => r.name);
}

/**
 * Characters removed from both sides before a planted value is looked for, so a value stored with spaces,
 * line breaks or dashes inserted (or swapped for their Unicode look-alikes) is still found: the ASCII hyphen
 * and space, every other character JavaScript's `\s` matches, and the Unicode hyphens and dashes U+2010..U+2015.
 */
export const SCAN_REMOVED: readonly number[] = [0x2d, 0x20, 9, 10, 11, 12, 13, 0xa0, 0x1680, ...Array.from({ length: 11 }, (_, i) => 0x2000 + i), 0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff];
const SCAN_REMOVED_SET = new Set(SCAN_REMOVED);

/** The form a planted value is compared in: SCAN_REMOVED dropped, ASCII letters upper-cased. */
export function scanForm(value: string): string {
  return [...value].filter((c) => !SCAN_REMOVED_SET.has(c.codePointAt(0)!)).join("").replace(/[a-z]/g, (c) => c.toUpperCase());
}

/** Every string inside a decoded JSON value (keys included), in document order. */
function jsonStrings(value: unknown, out: string[]): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) jsonStrings(item, out);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      jsonStrings(item, out);
    }
  return out;
}

/**
 * The forms one stored cell is searched in: the cell's text as stored, and, when the cell is JSON, its decoded
 * string values (so a planted value stored with escape sequences such as `\n` or `\u2010` inside a JSON string
 * is decoded before SCAN_REMOVED is applied), each on its own and all of them joined.
 */
export function storedForms(raw: string): string[] {
  const forms = [scanForm(raw)];
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"')) {
    try {
      const strings = jsonStrings(JSON.parse(trimmed), []);
      for (const s of strings) forms.push(scanForm(s));
      forms.push(scanForm(strings.join("")));
    } catch {
      /* not JSON: the stored text alone */
    }
  }
  return forms;
}

/**
 * Search every column of every table of the real local D1 for planted values. Returns where each was found,
 * by label. Columns are read cast to text, so JSON columns are covered; a JSON cell is also searched in its
 * decoded string values (storedForms). Both the stored value and the planted value are compared in scanForm()
 * in JavaScript, so whitespace, dashes or letter case inserted into a stored copy, escaped or not, do not hide it.
 */
export async function scanDatabase(needles: Record<string, string>, options: { skipTables?: string[] } = {}): Promise<TableHit[]> {
  const forms = Object.fromEntries(Object.entries(needles).map(([label, value]) => [label, scanForm(value)]));
  const labels = Object.keys(forms).filter((l) => forms[l]!.length > 0);
  const hits: TableHit[] = [];
  if (labels.length === 0) return hits;
  for (const table of await tableNames()) {
    if (options.skipTables?.includes(table)) continue;
    const columns = await sql<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`);
    for (const column of columns) {
      const values = (await sql<{ v: string | null }>(`SELECT CAST("${column.name}" AS TEXT) AS v FROM "${table}" WHERE "${column.name}" IS NOT NULL`)).map((r) => storedForms(String(r.v ?? "")));
      for (const label of labels) {
        const n = values.filter((cell) => cell.some((v) => v.includes(forms[label]!))).length;
        if (n > 0) hits.push({ table, column: column.name, needle: label, rows: n });
      }
    }
  }
  return hits;
}

/** Which of the planted values a text contains, by label (so a failure never prints a secret). */
export function found(text: string, needles: Record<string, string>): string[] {
  return Object.entries(needles)
    .filter(([, value]) => value.length > 0 && text.includes(value))
    .map(([label]) => label);
}

/* ------------------------------------------------------------------ */
/* Console                                                              */
/* ------------------------------------------------------------------ */

/**
 * Record what the Worker writes with `console.*` while it is installed. The test runner and the Worker
 * (and its conversation actor) run in one workerd isolate here, so they share this `console`; lines are
 * kept, not printed. This captures the local runtime only: it says nothing about a deployed log sink.
 */
export function captureConsole(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((m) => console[m]);
  const render = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  for (const m of methods) console[m] = (...args: unknown[]) => void lines.push(`${m}: ${args.map(render).join(" ")}`);
  return {
    lines,
    restore() {
      methods.forEach((m, i) => (console[m] = originals[i]!));
    },
  };
}

/* ------------------------------------------------------------------ */
/* Media                                                                */
/* ------------------------------------------------------------------ */

export interface RenditionRow {
  rendition_id: string;
  asset_id: string;
  kind: string;
  status: string;
  content_type: string;
  sha256: string;
  object_key: string;
  byte_length: number;
}

export const renditionsOf = (owner: TestOwner, assetId: string): Promise<RenditionRow[]> =>
  sql<RenditionRow>("SELECT rendition_id, asset_id, kind, status, content_type, sha256, object_key, byte_length FROM media_renditions WHERE user_id = ? AND asset_id = ? ORDER BY created_at, rendition_id", owner.userId, assetId);

/** Let the real background work (queue consumer, then the scheduled sweep) process an uploaded image. */
export async function settleMedia(owner: TestOwner, assetId: string): Promise<string> {
  let status = "processing";
  for (let i = 0; i < 60; i++) {
    status = (await sql<{ status: string }>("SELECT status FROM media_assets WHERE user_id = ? AND asset_id = ?", owner.userId, assetId))[0]?.status ?? "missing";
    if (status !== "processing") return status;
    if (i % 10 === 5) await runCron();
    await pause(100);
  }
  return status;
}

/** Keys in the private media bucket under a prefix (the real local R2). */
export async function mediaKeys(prefix: string): Promise<string[]> {
  const bucket = bindings().MEDIA_BUCKET!;
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

export const base64Url = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const fromBase64Url = (text: string): Uint8Array => {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/** A token in the product's own wire form, signed with a key the attacker chose. */
export async function forgeToken(secret: string, claims: Record<string, unknown>): Promise<string> {
  const body = base64Url(encoder.encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  return `${body}.${base64Url(mac)}`;
}

/** True when the bytes contain the sequence (for markers in served images). */
export function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}
