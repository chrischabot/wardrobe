import { describe, expect, it } from 'vitest';
import { exports } from 'cloudflare:workers';
import { db } from './helpers/fixtures.js';

describe('worker and schema smoke', () => {
  it('serves /health with the contract version', async () => {
    const res = await exports.default.fetch('https://garderobe.test/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, contractsVersion: '2026-10-01', apiVersion: 'v1' });
  });

  it('applies the migration to real local D1', async () => {
    const { results } = await db().prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>();
    const names = results.map((r) => r.name);
    for (const t of ['users', 'garments', 'stock_lots', 'stock_movements', 'daily_wears', 'command_receipts', 'style_documents', 'import_references']) expect(names).toContain(t);
  });
});
