import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_CLASS,
  COMMAND_TYPES,
  CONTRACTS_VERSION,
  CommandEnvelope,
  CommandReceipt,
  DomainCommand,
  JSON_SCHEMA_EXPORTS,
  StyleRuleCatalogue,
} from '../src/index.js';
import { renderJsonSchemaFile } from '../src/json-schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', '..', '..', 'data');

describe('command catalogue', () => {
  it('contains every command the foundation promises, each with a class', () => {
    const required = [
      'record_wear', 'amend_wear', 'mark_in_wash', 'mark_washed', 'socks_washed', 'laundry_collected', 'laundry_returned', 'laundry_partial_return',
      'send_to_tailor', 'back_from_tailor', 'mark_arrived', 'put_into_storage', 'take_out_of_storage', 'reconcile_quantity', 'add_item', 'dispose_item',
      'set_restriction', 'lift_restriction', 'select_option', 'edit_style_profile', 'set_temporary_brief', 'undo',
    ];
    // Other workstreams may add commands; the foundation's commands must all remain.
    for (const t of required) expect(COMMAND_TYPES, t).toContain(t);
    for (const t of COMMAND_TYPES) expect(COMMAND_CLASS[t]).toBeDefined();
  });

  it('the envelope is strict: no owner field, no unknown command fields', () => {
    const base = { idempotencyKey: 'abcdefgh-1', source: 'app', command: { type: 'mark_in_wash', garmentId: 'g_abc' } };
    expect(CommandEnvelope.safeParse(base).success).toBe(true);
    expect(CommandEnvelope.safeParse({ ...base, userId: 'usr_x' }).success).toBe(false);
    expect(CommandEnvelope.safeParse({ ...base, command: { ...base.command, ownerId: 'usr_x' } }).success).toBe(false);
    expect(CommandEnvelope.safeParse({ ...base, idempotencyKey: 'short' }).success).toBe(false);
  });

  it('item creation requires explicit: true', () => {
    expect(DomainCommand.safeParse({ type: 'add_item', name: 'X', category: 'shirt', roles: ['base_top'] }).success).toBe(false);
    expect(DomainCommand.safeParse({ type: 'add_item', explicit: true, name: 'X', category: 'shirt', roles: ['base_top'] }).success).toBe(true);
  });

  it('validates restriction scopes and temporary brief dates', () => {
    expect(DomainCommand.safeParse({ type: 'set_restriction', kind: 'healing', scope: {}, reason: 'x' }).success).toBe(false);
    expect(DomainCommand.safeParse({ type: 'set_temporary_brief', text: 'x', validFrom: '2026-10-08', validTo: '2026-10-07' }).success).toBe(false);
  });
});

describe('receipt contract', () => {
  it('parses a verified receipt', () => {
    const r = {
      schemaVersion: CONTRACTS_VERSION,
      commandId: 'cmd_abc',
      idempotencyKey: 'k-12345678',
      commandType: 'mark_in_wash',
      outcome: 'committed',
      replayed: false,
      rebased: false,
      affected: [{ entityType: 'stock_lot', entityId: 'lot_1', version: 2, change: 'updated' }],
      summary: 'In the wash: Lightweight oxford — blue. 0 clean remaining.',
      facts: {},
      effects: { state: 'none', items: [] },
      undo: { available: true },
      compensatesCommandId: null,
      undoneByCommandId: null,
      occurredAt: '2026-10-06T09:00:00.000Z',
      recordedAt: '2026-10-06T09:00:00.000Z',
      error: null,
    };
    expect(CommandReceipt.safeParse(r).success).toBe(true);
    expect(CommandReceipt.safeParse({ ...r, outcome: 'done' }).success).toBe(false);
  });
});

describe('JSON Schema for the iOS app', () => {
  it('committed schema files are current', () => {
    for (const name of Object.keys(JSON_SCHEMA_EXPORTS)) {
      const file = readFileSync(join(here, '..', 'json-schema', `${name}.json`), 'utf8');
      expect(file, `${name}.json is stale; run npm run schemas`).toBe(renderJsonSchemaFile(name, CONTRACTS_VERSION));
    }
  });
});

describe('owner data files', () => {
  const profile = readFileSync(join(dataDir, 'owner-profile.md'));
  it('the owner profile copy matches the spec hash byte for byte', () => {
    expect(createHash('sha256').update(profile).digest('hex')).toBe('e15639d891f9a5264c7eff13d05a478bcb188745aea11323b2131db37f5cb198');
    expect(profile.byteLength).toBe(14960);
  });
  it('the inventory CSV copy is byte-exact', () => {
    const csv = readFileSync(join(dataDir, 'wardrobe-inventory-2026-05.csv'));
    expect(createHash('sha256').update(csv).digest('hex')).toBe('ca9a5e06edbb2646ad91f102cb242a81b1776bd39e86e99300c0eb387254c946');
  });
  it('the rule catalogue parses and every quote is verbatim from its section', () => {
    const cat = StyleRuleCatalogue.parse(JSON.parse(readFileSync(join(dataDir, 'owner-profile-rules.json'), 'utf8')));
    const text = profile.toString('utf8');
    expect(cat.documentSha256).toBe(createHash('sha256').update(profile).digest('hex'));
    const keys = new Set<string>();
    for (const r of cat.rules) {
      expect(keys.has(r.ruleKey), r.ruleKey).toBe(false);
      keys.add(r.ruleKey);
      const start = text.indexOf(`## ${r.passage.section}`);
      expect(start, r.ruleKey).toBeGreaterThanOrEqual(0);
      const next = text.indexOf('\n## ', start + 3);
      const section = text.slice(start, next === -1 ? undefined : next);
      expect(section.includes(r.passage.quote), `${r.ruleKey} quote not in section ${r.passage.section}`).toBe(true);
    }
  });
});
