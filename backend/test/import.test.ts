import { describe, expect, it } from 'vitest';
import reportMd from '../../data/owner-inventory-reconciliation.md?raw';
import { db, newOwner, newUser, ok, OWNER_ADDITIONS, OWNER_SOURCES } from './helpers/fixtures.js';
import { estimateAvailability, evaluateEligibility, listWardrobe, resolveAlias, sha256Hex } from '../src/domain/index.js';
import {
  buildInventoryReconciliation,
  buildOwnerDataset,
  importDataset,
  importOwnerData,
  INVENTORY_SOURCE_SYSTEM,
  mapInventory,
  parseCsv,
  PROFILE_CLAIMS,
  renderReconciliationMarkdown,
  SPEC_PROFILE_SHA256,
} from '../src/import/index.js';
import { loadActiveRestrictions } from '../src/domain/restrictions.js';
import type { GarmentRow } from '../src/domain/records.js';

const HARD_CONSTRAINTS = [
  'hard.socks_always',
  'hard.sneakers_only_until_healed',
  'hard.sneaker_and_welted_alternative',
  'hard.thermal_peak_for_base',
  'hard.thermal_morning_for_outerwear',
  'hard.thermal_jacket_14_16_lightweight_oxford',
  'hard.variety_seven_days',
  'hard.never_fall_back_to_navy',
  'hard.perceptible_names',
];

describe('owner profile import (verbatim)', () => {
  it('stores the supplied profile byte-exact with SHA-256, version and import date, matching the spec hash', async () => {
    const { principal } = await newOwner();
    const row = await db()
      .prepare('SELECT * FROM style_documents WHERE user_id = ?')
      .bind(principal.userId)
      .first<{ body: string; content_sha256: string; byte_length: number; version: number; imported_at: string; is_demo: number; source: string; is_current: number }>();
    expect(row).not.toBeNull();
    expect(row!.body).toBe(OWNER_SOURCES.profileText);
    expect(await sha256Hex(row!.body)).toBe(SPEC_PROFILE_SHA256);
    expect(row!.content_sha256).toBe(SPEC_PROFILE_SHA256);
    expect(row!.byte_length).toBe(14960);
    expect(row!.version).toBe(1);
    expect(row!.imported_at).toBe('2026-09-20T08:00:00.000Z');
    expect(row!.is_demo).toBe(0);
    expect(row!.source).toBe('owner_supplied');
    expect(row!.is_current).toBe(1);
  });

  it('records a hash mismatch as a migration issue but keeps the supplied text authoritative', async () => {
    const principal = await newUser('Hash mismatch');
    const altered = OWNER_SOURCES.profileText + '\n';
    const owner = await buildOwnerDataset({ ...OWNER_SOURCES, profileText: altered }, { importedAt: '2026-09-20T08:00:00.000Z' });
    expect(owner.profile.matchesSpec).toBe(false);
    const result = await importDataset(db(), principal, owner.dataset, { sourceSystem: 'mismatch-test' });
    expect(result.documents[0]!.hashMatches).toBe(false);
    const body = await db().prepare('SELECT body FROM style_documents WHERE user_id = ?').bind(principal.userId).first<{ body: string }>();
    expect(body!.body).toBe(altered);
    const issue = await db().prepare("SELECT kind, severity FROM migration_issues WHERE user_id = ? AND kind = 'profile_hash_mismatch'").bind(principal.userId).first();
    expect(issue).toMatchObject({ kind: 'profile_hash_mismatch', severity: 'info' });
  });

  it('stores every derived rule with a verbatim passage, interpretation and hard/soft type, including all section 8 hard constraints', async () => {
    const { principal } = await newOwner();
    const { results } = await db()
      .prepare('SELECT rule_key, strength, kind, passage_section, passage_quote, interpretation, passage_status FROM style_rules WHERE user_id = ?')
      .bind(principal.userId)
      .all<{ rule_key: string; strength: string; kind: string; passage_section: string; passage_quote: string; interpretation: string; passage_status: string }>();
    expect(results.length).toBe(41);
    for (const r of results) {
      expect(OWNER_SOURCES.profileText.includes(r.passage_quote), r.rule_key).toBe(true);
      expect(OWNER_SOURCES.profileText.includes(`## ${r.passage_section}`), r.rule_key).toBe(true);
      expect(r.interpretation.length).toBeGreaterThan(10);
      expect(['hard', 'soft']).toContain(r.strength);
      expect(r.passage_status).toBe('present');
    }
    const keys = new Map(results.map((r) => [r.rule_key, r]));
    for (const k of HARD_CONSTRAINTS) {
      expect(keys.get(k), k).toBeDefined();
      expect(keys.get(k)!.strength).toBe('hard');
      expect(keys.get(k)!.passage_section).toBe('8. Hard constraints');
    }
    for (const k of [
      'colour.no_neutral_three_times',
      'colour.foot_echoes_higher_up',
      'register.home_key_never_only',
      'register.safe_never_leads',
      'filter.categories_out',
      'accessories.no_watches_or_jewellery',
      'accessories.belt_line_optional_flourish',
      'fabric.repels',
      'construction.real_weight_sewn_collars',
      'size.dbf_own_chart',
      'size.footwear_uk_8_5',
    ]) {
      expect(keys.get(k), k).toBeDefined();
    }
    expect(keys.get('colour.foot_echoes_higher_up')!.strength).toBe('soft');
  });

  it('implements sneakers-only as a restriction on every welted shoe and boot (and any 990v6), liftable only by owner statement', async () => {
    const { principal, byName } = await newOwner();
    const restrictions = await loadActiveRestrictions(db(), principal.userId);
    expect(restrictions).toHaveLength(1);
    const r = restrictions[0]!;
    expect(r.rule_key).toBe('hard.sneakers_only_until_healed');
    expect(r.required_evidence).toBe('owner_statement');
    expect(r.expected_end).toBeNull();
    const garment = async (name: string) => db().prepare('SELECT * FROM garments WHERE user_id = ? AND garment_id = ?').bind(principal.userId, await byName(name)).first<GarmentRow>();
    for (const name of ['Paraboot Reims — noir (black)', 'Paraboot Reims — café/marron', 'Paraboot Michael Cerf', "Drake's Clifford boot"]) {
      const e = evaluateEligibility((await garment(name))!, restrictions);
      expect(e.available, name).toBe(false);
      expect(e.label).toBe('Resting (healing restriction)');
    }
    for (const name of ['NB 990v4 — grey', 'NB 990v4 — navy', 'NB 990v4 — olive/cream']) {
      expect(evaluateEligibility((await garment(name))!, restrictions).available, name).toBe(true);
    }
    // A hypothetical 990v6 is caught by model.
    const v6 = { ...(await garment('NB 990v4 — grey'))!, garment_id: 'g_hypothetical', attributes_json: JSON.stringify({ model: '990v6' }) };
    expect(evaluateEligibility(v6, restrictions).available).toBe(false);
  });
});

describe('owner inventory import (section 16)', () => {
  it('accounts for every CSV row as imported, merged or held, with row hashes', async () => {
    const { principal } = await newOwner();
    const { results } = await db()
      .prepare("SELECT disposition, COUNT(*) AS n FROM import_references WHERE user_id = ? AND entity_type = 'garment' GROUP BY disposition")
      .bind(principal.userId)
      .all<{ disposition: string; n: number }>();
    const counts = Object.fromEntries(results.map((r) => [r.disposition, r.n]));
    expect(counts).toEqual({ imported: 127, merged: 3 });
    const mapping = await mapInventory(OWNER_SOURCES.csvText);
    expect(mapping.rows).toHaveLength(130);
    const missingHash = await db().prepare("SELECT COUNT(*) AS n FROM import_references WHERE user_id = ? AND entity_type = 'garment' AND source_row_sha256 IS NULL").bind(principal.userId).first<{ n: number }>();
    expect(missingHash!.n).toBe(0);
    const csvHash = await db().prepare('SELECT source_sha256 FROM import_runs WHERE user_id = ?').bind(principal.userId).first<{ source_sha256: string }>();
    expect(csvHash!.source_sha256).toBe('ca9a5e06edbb2646ad91f102cb242a81b1776bd39e86e99300c0eb387254c946');
  });

  it('merges numbered identical trousers into one garment with quantity 2 and keeps both labels as aliases', async () => {
    const { principal, byName } = await newOwner();
    const id = await byName('Di Sondrio walnut chino');
    const g = await db().prepare('SELECT tracking FROM garments WHERE user_id = ? AND garment_id = ?').bind(principal.userId, id).first<{ tracking: string }>();
    expect(g!.tracking).toBe('anonymous_quantity');
    const lot = await db().prepare('SELECT clean_qty FROM stock_lots WHERE user_id = ? AND garment_id = ?').bind(principal.userId, id).first<{ clean_qty: number }>();
    expect(lot!.clean_qty).toBe(2);
    const refs = await db().prepare('SELECT disposition, source_row, note FROM import_references WHERE user_id = ? AND entity_id = ? ORDER BY source_row').bind(principal.userId, id).all<{ disposition: string; source_row: number; note: string | null }>();
    expect(refs.results.map((r) => [r.disposition, r.source_row])).toEqual([
      ['imported', 65],
      ['merged', 66],
    ]);
    expect(refs.results[1]!.note).toContain('merged into one garment');
    expect(await resolveAlias(db(), principal, 'Di Sondrio walnut chino (pair 2)')).toMatchObject({ status: 'resolved', garmentId: id });
  });

  it('decomposes old statuses into acquisition, planning policy, location and lifecycle with the reason kept', async () => {
    const { principal, byName } = await newOwner();
    const get = async (name: string) =>
      db().prepare('SELECT acquisition, planning_policy, location, attributes_json FROM garments WHERE user_id = ? AND garment_id = ?').bind(principal.userId, await byName(name)).first<{ acquisition: string; planning_policy: string; location: string; attributes_json: string }>();
    const benched = await get('DBF Traveler — linen');
    expect(benched).toMatchObject({ acquisition: 'owned', planning_policy: 'excluded', location: 'home' });
    expect(JSON.parse(benched!.attributes_json)).toMatchObject({ benchedReason: 'too large', csvStatus: 'Benched (too large)' });
    expect(await get('Anglo-Italian pocket square')).toMatchObject({ planning_policy: 'occasional' });
    const breaking = await get('Paraboot Michael Cerf');
    expect(breaking).toMatchObject({ acquisition: 'owned', planning_policy: 'normal' });
    expect(JSON.parse(breaking!.attributes_json)).toMatchObject({ breakingIn: true, construction: 'welted' });
    const { results: projects } = await db()
      .prepare("SELECT status, COUNT(*) AS n FROM lifecycle_projects WHERE user_id = ? AND kind = 'tailoring' GROUP BY status")
      .bind(principal.userId)
      .all<{ status: string; n: number }>();
    expect(Object.fromEntries(projects.map((p) => [p.status, p.n]))).toEqual({ candidate: 10, planned: 2 });
    const atTailor = await db().prepare("SELECT COUNT(*) AS n FROM garments WHERE user_id = ? AND location <> 'home'").bind(principal.userId).first<{ n: number }>();
    expect(atTailor!.n).toBe(0);
  });

  it('takes sock quantities from Nx notes, records minimum quantities as issues, and keeps unknowns unknown', async () => {
    const { principal, byName } = await newOwner();
    const q = async (name: string) => (await db().prepare('SELECT clean_qty FROM stock_lots WHERE user_id = ? AND garment_id = ?').bind(principal.userId, await byName(name)).first<{ clean_qty: number }>())!.clean_qty;
    expect(await q('Merino — inky blue')).toBe(4);
    expect(await q('Merino — correct grey')).toBe(3);
    expect(await q('Merino — fire red')).toBe(1);
    expect(await q('Alpaca — true black')).toBe(1);
    const issue = await db().prepare("SELECT COUNT(*) AS n FROM migration_issues WHERE user_id = ? AND kind = 'quantity_unstated'").bind(principal.userId).first<{ n: number }>();
    expect(issue!.n).toBe(3);
    const cord = await db().prepare('SELECT maker, size_label FROM garments WHERE user_id = ? AND garment_id = ?').bind(principal.userId, await byName('Cord — beige')).first();
    expect(cord).toEqual({ maker: null, size_label: null });
    const bed = await db().prepare('SELECT attributes_json FROM garments WHERE user_id = ? AND garment_id = ?').bind(principal.userId, await byName('Alpaca bed sock — clotted cream')).first<{ attributes_json: string }>();
    expect(JSON.parse(bed!.attributes_json).indoorOnly).toBe(true);
  });

  it('stores fabric, season, size, price, acquired date and construction notes as dated facts sourced to the CSV row', async () => {
    const { principal, byName } = await newOwner();
    const id = await byName('Irish linen — slate+navy plaid');
    const { results } = await db().prepare('SELECT field, value_json, source_kind, source_ref, observed_at FROM garment_facts WHERE user_id = ? AND garment_id = ?').bind(principal.userId, id).all<{ field: string; value_json: string; source_kind: string; source_ref: string; observed_at: string }>();
    const f = new Map(results.map((r) => [r.field, r]));
    expect(JSON.parse(f.get('price_gbp')!.value_json)).toBe(156.86);
    expect(JSON.parse(f.get('acquired_on')!.value_json)).toBe('2026-04-21');
    expect(JSON.parse(f.get('fabric')!.value_json)).toBe('Baird McNutt Irish linen');
    expect(JSON.parse(f.get('construction.collar')!.value_json)).toBe('Soft Franklin Spread Collar');
    expect(f.get('price_gbp')!.source_kind).toBe('import');
    expect(f.get('price_gbp')!.source_ref).toContain('wardrobe-inventory-2026-05.csv#row=28');
    const canclini = await db().prepare("SELECT value_json FROM garment_facts WHERE user_id = ? AND garment_id = ? AND field = 'construction.cuffConstruction'").bind(principal.userId, await byName('Cotton-linen twill — Canclini sunwashed')).first<{ value_json: string }>();
    expect(JSON.parse(canclini!.value_json)).toBe('fused');
  });

  it('uses perceptible names from the Item column and resolves aliases from PCF refs, source detail and brand', async () => {
    const { principal, byName } = await newOwner();
    expect(await resolveAlias(db(), principal, 'PCF4382')).toMatchObject({ status: 'resolved', name: 'Cotton-linen oxford — blue wide stripe' });
    expect(await resolveAlias(db(), principal, 'Washed Gold Lightweight Oxford')).toMatchObject({ status: 'resolved', name: 'Lightweight oxford — gold' });
    expect(await resolveAlias(db(), principal, 'NB 990v4')).toMatchObject({ status: 'ambiguous' });
    const wide = await resolveAlias(db(), principal, 'wide stripe');
    expect(wide.status).toBe('ambiguous');
    if (wide.status === 'ambiguous') expect(wide.candidates.length).toBeGreaterThanOrEqual(3);
    // The Chasseur's mislabelled source wording is not an alias.
    const chore = await resolveAlias(db(), principal, 'cotton-twill chore jacket in green');
    expect(chore.status).toBe('not_found');
    expect(await byName("Drake's Waxed Chasseur")).toMatch(/^g_/);
  });

  it('“Paraboot boots” offers his Paraboots as a choice, changes no data and leaves them under the healing restriction (simulation D5)', async () => {
    const { principal, byName } = await newOwner({ withAdditions: true });
    const paraboots = ['Paraboot Michael Cerf', 'Paraboot Reims — café/marron', 'Paraboot Reims — noir (black)', 'Paraboot Norwegian split-toe'];
    const before = await db().prepare('SELECT garment_id, name, category, version FROM garments WHERE user_id = ? ORDER BY garment_id').bind(principal.userId).all();
    for (const phrase of ['Paraboot boots', 'my Paraboot boots', 'Paraboot shoes']) {
      const r = await resolveAlias(db(), principal, phrase);
      expect(r.status, phrase).toBe('ambiguous');
      if (r.status === 'ambiguous') expect(new Set(r.candidates.map((c) => c.name)), phrase).toEqual(new Set(paraboots));
    }
    // Word-level matching: a colour narrows to one pair (the Drake's Clifford, his only boot, is never offered for "Paraboot boots").
    expect(await resolveAlias(db(), principal, 'my black Paraboots')).toMatchObject({ status: 'resolved', name: 'Paraboot Reims — noir (black)' });
    const after = await db().prepare('SELECT garment_id, name, category, version FROM garments WHERE user_id = ? ORDER BY garment_id').bind(principal.userId).all();
    expect(after.results).toEqual(before.results);
    const ids = await Promise.all(paraboots.map((n) => byName(n)));
    const est = await estimateAvailability(db(), principal, { targetDate: '2026-10-08', asOf: '2026-10-07T06:00:00.000Z', garmentIds: ids });
    expect(est.map((e) => e.eligible)).toEqual([false, false, false, false]);
  });

  it('with a single Paraboot shoe, “Paraboot boots” offers it to confirm rather than resolving it or finding nothing', async () => {
    const principal = await newUser('One Paraboot');
    const add = async (name: string, category: string, maker: string) => (await ok(principal, { type: 'add_item', explicit: true, name, category, roles: ['footwear'], maker } as never)).facts.garmentId as string;
    const michael = await add('Paraboot Michael', 'shoes', 'Paraboot');
    await add('Drake’s Clifford boot', 'boots', "Drake's");
    const r = await resolveAlias(db(), principal, 'Paraboot boots');
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') expect(r.candidates.map((c) => c.garmentId)).toEqual([michael]);
  });

  it('creates no wears, batches or observations and starts every unit clean as an import baseline', async () => {
    const { principal } = await newOwner();
    for (const t of ['wear_observations', 'daily_wears', 'laundry_batches', 'command_receipts']) {
      const r = await db().prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).bind(principal.userId).first<{ n: number }>();
      expect(r!.n, t).toBe(0);
    }
    const kinds = await db().prepare('SELECT DISTINCT kind, params_json FROM stock_movements WHERE user_id = ?').bind(principal.userId).all<{ kind: string; params_json: string }>();
    expect(new Set(kinds.results.map((k) => k.kind))).toEqual(new Set(['receive']));
    expect(kinds.results.every((k) => JSON.parse(k.params_json).basis === 'import_baseline')).toBe(true);
    const dirty = await db().prepare('SELECT SUM(worn_qty + hamper_qty + laundry_qty) AS n FROM stock_lots WHERE user_id = ?').bind(principal.userId).first<{ n: number }>();
    expect(dirty!.n).toBe(0);
    const page = await listWardrobe(db(), principal);
    expect(page.total).toBe(127);
    expect(page.complete).toBe(true);
    expect(page.counts).toMatchObject({ owned: 127, incoming: 0, retired: 0 });
    expect(page.items.every((i) => i.recordedWearCount === 0 && i.lastRecordedWear === null)).toBe(true);
  });

  it('records profile-vs-CSV conflicts as migration issues instead of guessing', async () => {
    const { principal } = await newOwner();
    const { results } = await db().prepare('SELECT issue_key, kind, severity FROM migration_issues WHERE user_id = ?').bind(principal.userId).all<{ issue_key: string; kind: string; severity: string }>();
    const keys = results.map((r) => r.issue_key);
    for (const k of ['profile_absent:nb_990v6', 'profile_absent:nb_993', 'profile_absent:rugbies', 'profile_absent:shetland_knitwear', 'profile_absent:indigo_jeans_light_mid_dark', 'lifecycle_uncertain:benched_too_large']) {
      expect(keys, k).toContain(k);
    }
    expect(keys.some((k) => k.startsWith('fabric_conflict:moleskin:'))).toBe(true);
    expect(keys.some((k) => k.startsWith('source_label_conflict:'))).toBe(true);
    expect(keys.some((k) => k.startsWith('construction_conflict:fused:'))).toBe(true);
    expect(results.length).toBe(32);
    for (const c of PROFILE_CLAIMS) expect(OWNER_SOURCES.profileText.includes(c.quote), c.key).toBe(true);
    const nb = await db().prepare("SELECT COUNT(*) AS n FROM garments WHERE user_id = ? AND (name LIKE '%990v6%' OR name LIKE '%993%' OR name LIKE '%ugby%')").bind(principal.userId).first<{ n: number }>();
    expect(nb!.n).toBe(0);
  });

  it('is idempotent: a repeated import creates nothing new', async () => {
    const { principal } = await newOwner();
    const again = await importOwnerData(db(), principal, OWNER_SOURCES, { importedAt: '2026-09-21T08:00:00.000Z' });
    expect(again.result.garmentsCreated).toBe(0);
    expect(again.result.garmentsSkipped).toBe(127);
    expect(again.result.documentsCreated).toBe(0);
    expect(again.result.rulesCreated).toBe(0);
    const g = await db().prepare('SELECT COUNT(*) AS n FROM garments WHERE user_id = ?').bind(principal.userId).first<{ n: number }>();
    expect(g!.n).toBe(127);
    const units = await db().prepare('SELECT SUM(clean_qty) AS n FROM stock_lots WHERE user_id = ?').bind(principal.userId).first<{ n: number }>();
    expect(units!.n).toBe(144);
  });

  it('database counts match the reconciliation report, and the committed report is current', async () => {
    const { principal, imported } = await newOwner();
    const { results } = await db()
      .prepare('SELECT g.category, COUNT(DISTINCT g.garment_id) AS garments, SUM(l.clean_qty) AS units FROM garments g JOIN stock_lots l ON l.user_id = g.user_id AND l.garment_id = g.garment_id WHERE g.user_id = ? GROUP BY g.category ORDER BY g.category')
      .bind(principal.userId)
      .all<{ category: string; garments: number; units: number }>();
    expect(results).toEqual(imported.report.byCategory);
    expect(imported.report.accounting.allRowsAccounted).toBe(true);
    expect(renderReconciliationMarkdown(buildInventoryReconciliation(imported.owner, OWNER_ADDITIONS))).toBe(reportMd);
  });

  it('holds rows it cannot map instead of guessing, and records them', async () => {
    const principal = await newUser('Held rows');
    const csv = OWNER_SOURCES.csvText + '\r\nHat,Mystery cap,Grey,Wool,-,-,-,Active,,,,,,';
    const owner = await buildOwnerDataset({ ...OWNER_SOURCES, csvText: csv }, { importedAt: '2026-09-20T08:00:00.000Z' });
    expect(owner.mapping.heldRows).toHaveLength(1);
    const result = await importDataset(db(), principal, owner.dataset, { sourceSystem: INVENTORY_SOURCE_SYSTEM });
    expect(result.rowsHeld).toBe(1);
    const held = await db().prepare("SELECT entity_id, disposition, note FROM import_references WHERE user_id = ? AND disposition = 'held'").bind(principal.userId).first<{ entity_id: string | null; disposition: string; note: string }>();
    expect(held).toMatchObject({ entity_id: null, disposition: 'held' });
    expect(held!.note).toContain('Unrecognised category');
  });
});

describe('re-import identity and statuses (ADV-14, ADV-15)', () => {
  const CRLF = '\r\n';
  const lines = OWNER_SOURCES.csvText.split(CRLF);
  const withExtra = (rows: string[], at: 'end' | 'start' = 'end') => {
    const data = lines.slice(2).filter(Boolean);
    return [lines[0], lines[1], ...(at === 'start' ? [...rows, ...data] : [...data, ...rows]), ''].join(CRLF);
  };
  const goldRow = 'Shirt,Lightweight oxford — gold,Gold,Washed cotton oxford,Proper Cloth,MTM,All-but-coldest,Active,Solid; Ivy BD,Washed Gold Lightweight Oxford PCF4627,121.98,2025-03-25,,PCF4627';
  const garments = async (userId: string) => (await db().prepare('SELECT COUNT(*) AS n FROM garments WHERE user_id = ?').bind(userId).first<{ n: number }>())!.n;

  it('ADV-14: a re-imported row repeating an existing garment is matched to it: no new garment, no units, one merged reference', async () => {
    const { principal, userId, byName } = await newOwner();
    const gold = await byName('Lightweight oxford — gold');
    const units = async () => (await db().prepare('SELECT SUM(clean_qty) AS n FROM stock_lots WHERE user_id = ?').bind(userId).first<{ n: number }>())!.n;
    const unitsBefore = await units();
    const again = await importOwnerData(db(), principal, { ...OWNER_SOURCES, csvText: withExtra([goldRow]) }, { importedAt: '2026-09-27T08:00:00.000Z' });
    expect(again.result.garmentsCreated).toBe(0);
    expect(await garments(userId)).toBe(127);
    expect(await units()).toBe(unitsBefore);
    const merged = await db().prepare("SELECT entity_id, disposition, note FROM import_references WHERE user_id = ? AND source_id = 'csv:row-133'").bind(userId).first<{ entity_id: string; disposition: string; note: string }>();
    expect(merged).toMatchObject({ entity_id: gold, disposition: 'merged' });
    const issue = await db().prepare("SELECT kind, severity FROM migration_issues WHERE user_id = ? AND kind = 'duplicate_row_merged'").bind(userId).first();
    expect(issue).toEqual({ kind: 'duplicate_row_merged', severity: 'info' });
    // Running it again changes nothing.
    await importOwnerData(db(), principal, { ...OWNER_SOURCES, csvText: withExtra([goldRow]) }, { importedAt: '2026-09-28T08:00:00.000Z' });
    expect(await garments(userId)).toBe(127);
  });

  it('ADV-14: a row matching several existing garments is held for review, not imported or planned', async () => {
    const { principal, userId } = await newOwner();
    for (let i = 0; i < 2; i++) {
      await ok(principal, { type: 'add_item', explicit: true, name: 'Mystery shirt', category: 'shirt', roles: ['base_top'], maker: 'Acme', color: 'Blue', sizeLabel: 'L' });
    }
    const row = 'Shirt,Mystery shirt,Blue,Oxford,Acme,L,All-season,Active,,,,,,';
    const r = await importOwnerData(db(), principal, { ...OWNER_SOURCES, csvText: withExtra([row]) }, { importedAt: '2026-09-27T08:00:00.000Z' });
    expect(r.result.garmentsCreated).toBe(0);
    expect(r.result.rowsHeld).toBe(1);
    expect(await garments(userId)).toBe(129);
    const held = await db().prepare("SELECT disposition, entity_id FROM import_references WHERE user_id = ? AND source_id = 'csv:row-133'").bind(userId).first();
    expect(held).toEqual({ disposition: 'held', entity_id: null });
    expect(await db().prepare("SELECT severity FROM migration_issues WHERE user_id = ? AND kind = 'possible_duplicate'").bind(userId).first()).toEqual({ severity: 'review' });
  });

  it('ADV-14: a file with a row inserted at the top (every row number shifts) creates only the genuinely new garment', async () => {
    const { principal, userId } = await newOwner();
    const fresh = 'Shirt,Chambray work shirt,Blue,Chambray,Acme,L,All-season,Active,,,,,,';
    const r = await importOwnerData(db(), principal, { ...OWNER_SOURCES, csvText: withExtra([fresh], 'start') }, { importedAt: '2026-09-27T08:00:00.000Z' });
    expect(r.result.garmentsCreated).toBe(1);
    expect(await garments(userId)).toBe(128);
    expect(await db().prepare("SELECT COUNT(*) AS n FROM garments WHERE user_id = ? AND name = 'Chambray work shirt'").bind(userId).first()).toEqual({ n: 1 });
    const again = await importOwnerData(db(), principal, { ...OWNER_SOURCES, csvText: withExtra([fresh], 'start') }, { importedAt: '2026-09-28T08:00:00.000Z' });
    expect(again.result.garmentsCreated).toBe(0);
    expect(await garments(userId)).toBe(128);
    // No second tailoring project appeared for a shifted benched row.
    expect(await db().prepare("SELECT COUNT(*) AS n FROM lifecycle_projects WHERE user_id = ? AND kind = 'tailoring'").bind(userId).first()).toEqual({ n: 12 });
  });

  it('ADV-15: a row with an unrecognised status is held for review and never planned', async () => {
    const { principal, userId } = await newOwner();
    const rows = ['Shirt,Mystery oxford,Blue,Oxford,X,MTM,All-season,Owned by usr_attacker,,,,,,', 'Footwear,Paraboot Chambord,Tan,Leather,Paraboot,UK 8.5,All-season,Healed - wear freely,,,,,,'];
    const r = await importOwnerData(db(), principal, { ...OWNER_SOURCES, csvText: withExtra(rows) }, { importedAt: '2026-09-27T08:00:00.000Z' });
    expect(r.result.garmentsCreated).toBe(0);
    expect(r.result.rowsHeld).toBe(2);
    expect(await db().prepare("SELECT COUNT(*) AS n FROM garments WHERE user_id = ? AND name IN ('Mystery oxford', 'Paraboot Chambord')").bind(userId).first()).toEqual({ n: 0 });
    const held = await db().prepare("SELECT note FROM import_references WHERE user_id = ? AND disposition = 'held' ORDER BY source_id").bind(userId).all<{ note: string }>();
    expect(held.results.map((h) => h.note)).toEqual(['Unrecognised status "Owned by usr_attacker"; held for the owner\'s review instead of being planned', 'Unrecognised status "Healed - wear freely"; held for the owner\'s review instead of being planned']);
  });
});

describe('CSV parser', () => {
  it('handles quoted commas, escaped quotes, CRLF and LF', () => {
    const rows = parseCsv('a,"b, c","say ""hi"""\r\n1,2,3\n"multi\nline",x,y');
    expect(rows.map((r) => r.fields)).toEqual([
      ['a', 'b, c', 'say "hi"'],
      ['1', '2', '3'],
      ['multi\nline', 'x', 'y'],
    ]);
    expect(rows[2]!.line).toBe(3);
  });
  it('rejects an unterminated quote', () => {
    expect(() => parseCsv('a,"b\n')).toThrow(/Unterminated/);
  });
});
