import { describe, expect, it } from 'vitest';
import reportMd from '../../data/owner-inventory-reconciliation.md?raw';
import { db, newOwner, OWNER_ADDITIONS, OWNER_SOURCES } from './helpers/fixtures.js';
import { estimateAvailability, listWardrobe } from '../src/domain/index.js';
import { applyOwnerAssertedAdditions, buildInventoryReconciliation, parseOwnerAdditions, renderReconciliationMarkdown } from '../src/import/index.js';

const RESOLVED = [
  'profile_absent:nb_990v6',
  'profile_absent:nb_993',
  'profile_absent:rugbies',
  'profile_absent:shetland_knitwear',
  'profile_absent:indigo_jeans_light_mid_dark',
  'profile_absent:western_shirts',
  'profile_absent:d43',
  'profile_absent:academic_tweed_donegal',
  'profile_absent:paraboot_norwegian',
  'profile_absent:chore_coat_variants',
];

describe('owner-asserted additions (owner answer of 2026-09-29)', () => {
  it('adds every confirmed piece through the explicit add-item command, separate from the CSV rows', async () => {
    const owner = await newOwner({ withAdditions: true });
    expect(owner.additions!.created).toBe(17);
    const { results } = await db()
      .prepare("SELECT command_type, source, idempotency_key FROM command_receipts WHERE user_id = ? AND idempotency_key LIKE 'owner-answer-2026-09-29:%'")
      .bind(owner.userId)
      .all<{ command_type: string; source: string }>();
    expect(results).toHaveLength(17);
    expect(results.every((r) => r.command_type === 'add_item' && r.source === 'conversation')).toBe(true);
    const refs = await db().prepare("SELECT COUNT(*) AS n FROM import_references WHERE user_id = ? AND entity_type = 'garment'").bind(owner.userId).first<{ n: number }>();
    expect(refs!.n).toBe(130);
    const linked = await db()
      .prepare("SELECT COUNT(*) AS n FROM import_references r JOIN garments g ON g.user_id = r.user_id AND g.garment_id = r.entity_id WHERE r.user_id = ? AND g.attributes_json LIKE '%ownerAsserted%'")
      .bind(owner.userId)
      .first<{ n: number }>();
    expect(linked!.n).toBe(0);
    const page = await listWardrobe(db(), owner.principal);
    expect(page.total).toBe(144);
    expect(page.items.reduce((n, i) => n + i.stock.totalOwned, 0)).toBe(161);
    for (const name of ['NB 990v6', 'NB 993', 'Multi-stripe rugby', 'Panelled rugby', 'Rugby — XXL (layering)', 'Shetland knitwear', 'Jeans — light', 'Jeans — mid', 'Jeans — dark', 'Western shirt', 'D-43', 'Salt-and-pepper tweed blazer', 'Chestnut houndstooth blazer', 'Donegal blazer', 'Paraboot Norwegian split-toe', 'French chore coat', 'Dutch chore coat']) {
      expect(await owner.byName(name), name).toMatch(/^g_/);
    }
  });

  it('describes each piece only by sourced profile passages and keeps everything else unknown', async () => {
    const owner = await newOwner({ withAdditions: true });
    const g = async (name: string) => db().prepare('SELECT * FROM garments WHERE user_id = ? AND garment_id = ?').bind(owner.userId, await owner.byName(name)).first<Record<string, unknown>>();
    expect(await g('Multi-stripe rugby')).toMatchObject({ size_label: 'XL', color: null, maker: null, fabric: null, pattern: 'multi-stripe', condition: 'unknown' });
    expect(await g('Rugby — XXL (layering)')).toMatchObject({ size_label: 'XXL', color: null, maker: null });
    expect(await g('Shetland knitwear')).toMatchObject({ fabric: 'Shetland wool', maker: null, color: null, size_label: null });
    expect(await g('Jeans — dark')).toMatchObject({ color: 'Indigo, dark', maker: null, size_label: null });
    expect(await g('Chestnut houndstooth blazer')).toMatchObject({ color: 'Chestnut with a thin blue line', pattern: 'houndstooth', fabric: null, maker: null });
    expect(await g('NB 990v6')).toMatchObject({ maker: 'New Balance', color: null, size_label: null });
    const { results: facts } = await db()
      .prepare("SELECT field, value_json, source_kind, source_ref FROM garment_facts f JOIN garments g ON g.user_id = f.user_id AND g.garment_id = f.garment_id WHERE f.user_id = ? AND g.attributes_json LIKE '%ownerAsserted%'")
      .bind(owner.userId)
      .all<{ field: string; value_json: string; source_kind: string; source_ref: string }>();
    const assertions = facts.filter((f) => f.field === 'owner_assertion');
    expect(assertions).toHaveLength(17);
    expect(assertions.every((f) => f.source_kind === 'owner_statement' && f.source_ref.includes('2026-09-29') && f.source_ref.includes('All of them'))).toBe(true);
    const passages = facts.filter((f) => f.source_ref.startsWith('owner-profile.md'));
    expect(passages.length).toBeGreaterThanOrEqual(17);
    for (const p of passages) expect(OWNER_SOURCES.profileText.includes(JSON.parse(p.value_json)), p.value_json).toBe(true);
    expect(facts.filter((f) => f.field === 'unknown_fields')).toHaveLength(17);
  });

  it('applies the sneakers-only restriction to the 990v6 and the split-toe; the 993 is wearable', async () => {
    const owner = await newOwner({ withAdditions: true });
    const ids = { v6: await owner.byName('NB 990v6'), split: await owner.byName('Paraboot Norwegian split-toe'), n993: await owner.byName('NB 993'), rugby: await owner.byName('Panelled rugby') };
    const est = await estimateAvailability(db(), owner.principal, { targetDate: '2026-10-01', asOf: '2026-09-30T06:00:00.000Z', garmentIds: Object.values(ids) });
    const by = (id: string) => est.find((e) => e.garmentId === id)!;
    expect(by(ids.v6).eligible).toBe(false);
    expect(by(ids.v6).exclusionReasons.join(' ')).toContain('Sneakers only');
    expect(by(ids.split).eligible).toBe(false);
    expect(by(ids.n993)).toMatchObject({ eligible: true, probabilityAvailable: 1 });
    expect(by(ids.rugby).eligible).toBe(true);
  });

  it('resolves the matching migration issues and records the details still needed', async () => {
    const owner = await newOwner({ withAdditions: true });
    expect([...owner.additions!.issuesResolved].sort()).toEqual([...RESOLVED].sort());
    const { results } = await db().prepare('SELECT issue_key, status, resolution, kind FROM migration_issues WHERE user_id = ?').bind(owner.userId).all<{ issue_key: string; status: string; resolution: string | null; kind: string }>();
    for (const k of RESOLVED) {
      const i = results.find((r) => r.issue_key === k)!;
      expect(i.status, k).toBe('resolved');
      expect(i.resolution).toContain('2026-09-29');
    }
    const open = results.filter((r) => r.status === 'open');
    expect(open.filter((r) => r.kind === 'details_needed')).toHaveLength(15);
    expect(open.filter((r) => r.kind === 'open_question').map((r) => r.issue_key).sort()).toEqual(['open_question:chore_coat_ivy_variant', 'open_question:indigo_denim_button_down']);
    expect(open.filter((r) => r.issue_key.startsWith('profile_absent:'))).toHaveLength(0);
    expect(results.find((r) => r.issue_key.startsWith('fabric_conflict:moleskin:'))!.status).toBe('open');
  });

  it('re-applying changes nothing', async () => {
    const owner = await newOwner({ withAdditions: true });
    const count = async (sql: string) => (await db().prepare(sql).bind(owner.userId).first<{ n: number }>())!.n;
    const before = [await count('SELECT COUNT(*) AS n FROM garments WHERE user_id = ?'), await count('SELECT COUNT(*) AS n FROM garment_facts WHERE user_id = ?'), await count('SELECT COUNT(*) AS n FROM migration_issues WHERE user_id = ?'), await count('SELECT COUNT(*) AS n FROM command_receipts WHERE user_id = ?')];
    const again = await applyOwnerAssertedAdditions(db(), owner.principal, OWNER_ADDITIONS);
    expect(again.created).toBe(0);
    expect(again.replayed).toBe(17);
    expect(again.issuesResolved).toEqual([]);
    expect(again.detailsNeededRecorded).toBe(0);
    const after = [await count('SELECT COUNT(*) AS n FROM garments WHERE user_id = ?'), await count('SELECT COUNT(*) AS n FROM garment_facts WHERE user_id = ?'), await count('SELECT COUNT(*) AS n FROM migration_issues WHERE user_id = ?'), await count('SELECT COUNT(*) AS n FROM command_receipts WHERE user_id = ?')];
    expect(after).toEqual(before);
  });

  it('rejects an additions file whose quote is not verbatim in the profile', () => {
    const bad = structuredClone(OWNER_ADDITIONS) as { additions: { passages: { quote: string }[] }[] };
    bad.additions[0]!.passages[0]!.quote = 'New Balance is the only spine';
    expect(() => parseOwnerAdditions(bad, OWNER_SOURCES.profileText)).toThrow(/quote not found/);
  });

  it('the committed reconciliation report reflects the additions and open issues', async () => {
    const owner = await newOwner();
    const report = buildInventoryReconciliation(owner.imported.owner, OWNER_ADDITIONS);
    expect(report.ownerAsserted!.totals).toEqual({ garments: 144, units: 161 });
    expect(report.issues.filter((i) => i.status === 'resolved')).toHaveLength(10);
    expect(renderReconciliationMarkdown(report)).toBe(reportMd);
  });
});
