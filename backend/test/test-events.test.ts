import { describe, expect, it } from 'vitest';
import { applyTestEvents, TEST_EVENT_LABEL } from '@garderobe/demo';
import { db, newOwner, service } from './helpers/fixtures.js';
import { getLaundryState, listDailyWears, listWardrobe } from '../src/domain/index.js';

describe('labelled test events on top of the imported owner baseline', () => {
  it('creates the scenario state the CSV lacks through commands, labelled, without touching the import baseline', async () => {
    const owner = await newOwner();
    const refsBefore = await db().prepare('SELECT COUNT(*) AS n FROM import_references WHERE user_id = ?').bind(owner.userId).first<{ n: number }>();
    const result = await applyTestEvents(service(owner.principal, { now: () => '2026-09-28T12:00:00.000Z' }), { garment: owner.byName, weekStart: '2026-09-21' });
    expect(result.receipts.every((r) => r.idempotencyKey.startsWith('test-event:'))).toBe(true);

    const page = await listWardrobe(db(), owner.principal);
    expect(page.counts).toMatchObject({ owned: 126, incoming: 1, retired: 1 });
    const label = (name: string) => page.items.find((i) => i.garment.name === name)!.availability.label;
    expect(label("Drake's Camel Field Games")).toBe('At the tailor');
    expect(label('DBF Grandfather Coat')).toBe('In storage');
    expect(label(`NB 993 — grey (${TEST_EVENT_LABEL})`)).toBe('Incoming');
    expect(label("Drake's red polka-dot")).toBe('Retired');

    const wears = await listDailyWears(db(), owner.principal, { from: '2026-09-21', to: '2026-09-27' });
    expect(new Set(wears.map((w) => w.wearingDate)).size).toBe(4);
    const obs = await db().prepare('SELECT DISTINCT source_ref FROM wear_observations WHERE user_id = ?').bind(owner.userId).all<{ source_ref: string }>();
    expect(obs.results.map((o) => o.source_ref)).toEqual([TEST_EVENT_LABEL]);

    const laundry = await getLaundryState(db(), owner.principal);
    expect(laundry.batches).toHaveLength(1);
    expect(laundry.batches[0]!.status).toBe('partially_returned');
    expect(laundry.openExceptions).toHaveLength(1);
    expect(laundry.hamper.service.map((h) => h.name)).toContain('Lightweight oxford — moss');
    expect(laundry.hamper.handWash).toHaveLength(0);

    const refsAfter = await db().prepare('SELECT COUNT(*) AS n FROM import_references WHERE user_id = ?').bind(owner.userId).first<{ n: number }>();
    expect(refsAfter!.n).toBe(refsBefore!.n);
    // Re-running the events is idempotent (same keys, same receipts).
    const again = await applyTestEvents(service(owner.principal, { now: () => '2026-09-28T12:00:00.000Z' }), { garment: owner.byName, weekStart: '2026-09-21' });
    expect(again.receipts.every((r) => r.replayed)).toBe(true);
  });
});
