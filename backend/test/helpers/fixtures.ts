import { env } from 'cloudflare:workers';
import profileText from '../../../data/owner-profile.md?raw';
import csvText from '../../../data/wardrobe-inventory-2026-05.csv?raw';
import rulesCatalogue from '../../../data/owner-profile-rules.json';
import ownerAdditions from '../../../data/owner-asserted-additions-2026-09-29.json';
import { CommandService, createUser, ownerPrincipal, type CommandServiceOptions, type Principal } from '../../src/domain/index.js';
import { applyOwnerAssertedAdditions, importOwnerData, parseOwnerAdditions } from '../../src/import/index.js';
import type { CommandEnvelopeInput, CommandReceipt, DomainCommandInput } from '@garderobe/contracts';

export const db = (): D1Database => env.DB;
export const OWNER_SOURCES = { profileText, csvText, rulesCatalogue };
export const OWNER_ADDITIONS = parseOwnerAdditions(ownerAdditions, profileText);

let counter = 0;
export function key(prefix = 'k'): string {
  counter++;
  return `${prefix}-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A bare user with settings but no wardrobe. */
export async function newUser(name = 'Test user', opts: { now?: string } = {}): Promise<Principal> {
  const { userId } = await createUser(db(), {
    displayName: name,
    identity: { issuer: 'https://test.invalid', subject: key('sub') },
    settings: { homeLocationLabel: 'London', timezone: 'Europe/London', wearLoggingSince: '2026-01-01' },
    now: opts.now ?? '2026-01-01T00:00:00.000Z',
  });
  return ownerPrincipal(userId, 'test');
}

/** The owner with the real profile, rules and May 2026 inventory imported (plus, optionally, the 2026-09-29 owner-asserted additions). */
export async function newOwner(opts: { importedAt?: string; createdAt?: string; withAdditions?: boolean } = {}) {
  const { userId } = await createUser(db(), {
    displayName: 'Chris',
    identity: { issuer: 'https://test.invalid', subject: key('owner') },
    now: opts.createdAt ?? '2026-09-20T00:00:00.000Z',
  });
  const principal = ownerPrincipal(userId, 'test');
  const imported = await importOwnerData(db(), principal, OWNER_SOURCES, { importedAt: opts.importedAt ?? '2026-09-20T08:00:00.000Z' });
  const additions = opts.withAdditions ? await applyOwnerAssertedAdditions(db(), principal, OWNER_ADDITIONS) : null;
  const byName = async (name: string): Promise<string> => {
    const row = await db().prepare('SELECT garment_id FROM garments WHERE user_id = ? AND name = ?').bind(userId, name).first<{ garment_id: string }>();
    if (!row) throw new Error(`No garment named ${name}`);
    return row.garment_id;
  };
  return { principal, userId, imported, additions, byName };
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

/** Asserts a committed (or merged) receipt and returns it. */
export async function ok(principal: Principal, command: DomainCommandInput, extra: Partial<CommandEnvelopeInput> = {}, opts: CommandServiceOptions = {}): Promise<CommandReceipt> {
  const r = await run(principal, command, extra, opts);
  if (r.outcome !== 'committed' && r.outcome !== 'merged') throw new Error(`Expected commit, got ${r.outcome}: ${r.error?.code} ${r.error?.message} ${JSON.stringify(r.error?.details ?? {})}`);
  return r;
}

export async function buckets(principal: Principal, garmentId: string) {
  const { results } = await db()
    .prepare('SELECT clean_qty, worn_qty, hamper_qty, laundry_qty, storage_qty, away_qty, retired_qty FROM stock_lots WHERE user_id = ? AND garment_id = ?')
    .bind(principal.userId, garmentId)
    .all<Record<string, number>>();
  const sum = (k: string) => results.reduce((n, r) => n + (r[k] ?? 0), 0);
  return { clean: sum('clean_qty'), worn: sum('worn_qty'), hamper: sum('hamper_qty'), laundry: sum('laundry_qty'), storage: sum('storage_qty'), away: sum('away_qty'), retired: sum('retired_qty') };
}

export async function wearCount(principal: Principal, garmentId: string): Promise<number> {
  const r = await db().prepare("SELECT COUNT(*) AS n FROM daily_wears WHERE user_id = ? AND garment_id = ? AND status = 'active'").bind(principal.userId, garmentId).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Minimal wardrobe for focused accounting tests (created through explicit add_item commands). */
export async function basicWardrobe(principal: Principal) {
  const add = async (name: string, category: string, extra: Record<string, unknown> = {}) =>
    (await ok(principal, { type: 'add_item', explicit: true, name, category: category as never, roles: [], ...extra } as never)).facts.garmentId as string;
  return {
    shirtA: await add('Lightweight oxford — blue', 'shirt', { roles: ['base_top'], attributes: { fabricClass: 'lightweight_oxford' } }),
    shirtB: await add('Pima oxford — white', 'shirt', { roles: ['base_top'] }),
    trousers: await add('Di Sondrio walnut chino', 'trousers', { roles: ['bottom'] }),
    socks: await add('Merino — inky blue', 'socks', { roles: ['socks'], quantity: 4, tracking: 'anonymous_quantity' }),
    sneakers: await add('NB 990v4 — grey', 'sneakers', { roles: ['footwear'] }),
    belt: await add("Anderson's belt — brown", 'belt', { roles: ['belt'] }),
    blazer: await add("Drake's Navy Cotton-Linen Games Mk.IV", 'blazer', { roles: ['outer_layer'] }),
  };
}
