import { env } from 'cloudflare:workers';
import profileText from '../../../data/owner-profile.md?raw';
import csvText from '../../../data/wardrobe-inventory-2026-05.csv?raw';
import rulesCatalogue from '../../../data/owner-profile-rules.json';
import ownerAdditions from '../../../data/owner-asserted-additions-2026-09-29.json';
import { CommandService, createUser, ownerPrincipal, type CommandServiceOptions, type Principal } from '../../../backend/src/domain/index.js';
import { applyOwnerAssertedAdditions, importOwnerData, parseOwnerAdditions } from '../../../backend/src/import/index.js';
import type { CommandEnvelopeInput, CommandReceipt, DomainCommandInput } from '@garderobe/contracts';

/**
 * Seeding for the adversarial suite. The owner is seeded exactly as the foundation seed
 * (demo/scripts/seed-local.ts) does it: `importOwnerData` with the byte-exact profile, its rule
 * catalogue and the May 2026 inventory CSV, then `applyOwnerAssertedAdditions` (the owner's
 * 2026-09-29 answer). No wardrobe data is invented here.
 */

export const db = (): D1Database => env.DB;
export const OWNER_SOURCES = { profileText, csvText, rulesCatalogue };
export const OWNER_PROFILE_TEXT = profileText;
export const OWNER_CSV_TEXT = csvText;
export const OWNER_ADDITIONS = parseOwnerAdditions(ownerAdditions, profileText);
export const SPEC_PROFILE_SHA256_PREFIX = 'e15639d8';

let counter = 0;
export function key(prefix = 'adv'): string {
  counter++;
  return `${prefix}-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function q<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T[]> {
  return (await env.DB.prepare(sql).bind(...binds).all<T>()).results;
}

export async function one<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T> {
  const r = await env.DB.prepare(sql).bind(...binds).first<T>();
  if (!r) throw new Error(`no row for ${sql}`);
  return r;
}

export async function count(sql: string, ...binds: unknown[]): Promise<number> {
  return (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0;
}

export interface Owner {
  principal: Principal;
  userId: string;
  byName: (name: string) => Promise<string>;
  /** First garment matching a SQL WHERE fragment over `garments` (bound after user_id). */
  pick: (where: string, ...binds: unknown[]) => Promise<string>;
}

/** The owner with the real profile, rules, May 2026 inventory and owner-asserted additions imported. */
export async function newOwner(opts: { importedAt?: string; createdAt?: string; withAdditions?: boolean; displayName?: string } = {}): Promise<Owner> {
  const { userId } = await createUser(db(), {
    displayName: opts.displayName ?? 'Chris',
    identity: { issuer: 'https://adversarial.test.invalid', subject: key('owner') },
    now: opts.createdAt ?? '2026-09-20T00:00:00.000Z',
  });
  const principal = ownerPrincipal(userId, 'test');
  await importOwnerData(db(), principal, OWNER_SOURCES, { importedAt: opts.importedAt ?? '2026-09-20T08:00:00.000Z' });
  if (opts.withAdditions ?? true) await applyOwnerAssertedAdditions(db(), principal, OWNER_ADDITIONS);
  return { principal, userId, ...lookups(userId) };
}

export function lookups(userId: string) {
  return {
    byName: async (name: string): Promise<string> => {
      const row = await db().prepare('SELECT garment_id FROM garments WHERE user_id = ? AND name = ?').bind(userId, name).first<{ garment_id: string }>();
      if (!row) throw new Error(`No garment named ${name}`);
      return row.garment_id;
    },
    pick: async (where: string, ...binds: unknown[]): Promise<string> => {
      const row = await db().prepare(`SELECT garment_id FROM garments WHERE user_id = ? AND (${where}) ORDER BY name LIMIT 1`).bind(userId, ...binds).first<{ garment_id: string }>();
      if (!row) throw new Error(`No garment where ${where}`);
      return row.garment_id;
    },
  };
}

export function service(principal: Principal, opts: CommandServiceOptions = {}): CommandService {
  return new CommandService(db(), principal, opts);
}

export function envelope(command: DomainCommandInput, extra: Partial<CommandEnvelopeInput> = {}): CommandEnvelopeInput {
  return { idempotencyKey: key(), source: 'app', ...extra, command };
}

export async function run(principal: Principal, command: DomainCommandInput, extra: Partial<CommandEnvelopeInput> = {}, opts: CommandServiceOptions = {}): Promise<CommandReceipt> {
  return service(principal, opts).execute(envelope(command, extra));
}

export async function ok(principal: Principal, command: DomainCommandInput, extra: Partial<CommandEnvelopeInput> = {}, opts: CommandServiceOptions = {}): Promise<CommandReceipt> {
  const r = await run(principal, command, extra, opts);
  if (r.outcome !== 'committed' && r.outcome !== 'merged') throw new Error(`Expected commit, got ${r.outcome}: ${r.error?.code} ${r.error?.message} ${JSON.stringify(r.error?.details ?? {})}`);
  return r;
}

export type Buckets = { clean: number; worn: number; hamper: number; laundry: number; storage: number; away: number; retired: number };

export async function buckets(userId: string, garmentId: string): Promise<Buckets> {
  const rows = await q<Record<string, number>>('SELECT clean_qty, worn_qty, hamper_qty, laundry_qty, storage_qty, away_qty, retired_qty FROM stock_lots WHERE user_id = ? AND garment_id = ?', userId, garmentId);
  const sum = (k: string) => rows.reduce((n, r) => n + (r[k] ?? 0), 0);
  return { clean: sum('clean_qty'), worn: sum('worn_qty'), hamper: sum('hamper_qty'), laundry: sum('laundry_qty'), storage: sum('storage_qty'), away: sum('away_qty'), retired: sum('retired_qty') };
}

export const total = (b: Buckets): number => b.clean + b.worn + b.hamper + b.laundry + b.storage + b.away + b.retired;

export async function wearCount(userId: string, garmentId: string): Promise<number> {
  return count("SELECT COUNT(*) AS n FROM daily_wears WHERE user_id = ? AND garment_id = ? AND status = 'active'", userId, garmentId);
}

/** Every stock bucket of every lot of this owner is non-negative and integral. */
export async function negativeBuckets(userId: string): Promise<Record<string, unknown>[]> {
  return q(
    `SELECT garment_id, clean_qty, worn_qty, hamper_qty, laundry_qty, storage_qty, away_qty, retired_qty FROM stock_lots WHERE user_id = ? AND
     (clean_qty < 0 OR worn_qty < 0 OR hamper_qty < 0 OR laundry_qty < 0 OR storage_qty < 0 OR away_qty < 0 OR retired_qty < 0)`,
    userId,
  );
}

/** A snapshot of ledger tables for "nothing changed" assertions. */
export async function ledgerSnapshot(userId: string): Promise<Record<string, unknown>> {
  const tables = ['garments', 'stock_lots', 'stock_movements', 'daily_wears', 'command_receipts', 'restrictions', 'style_documents', 'style_rules', 'wear_observations'];
  const out: Record<string, unknown> = {};
  for (const t of tables) {
    try {
      out[t] = await q(`SELECT * FROM ${t} WHERE user_id = ? ORDER BY rowid`, userId);
    } catch {
      out[t] = 'n/a';
    }
  }
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function healingRestrictionId(userId: string): Promise<string> {
  return (await one<{ restriction_id: string }>("SELECT restriction_id FROM restrictions WHERE user_id = ? AND kind = 'healing' AND lifted_at IS NULL", userId)).restriction_id;
}
