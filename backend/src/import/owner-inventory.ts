import type { Category, GarmentAttributes, ImportDatasetInput, ImportGarmentInput, PlanningPolicy } from '@garderobe/contracts';
import { CATEGORY_DEFAULTS } from '../domain/catalog.js';
import { sha256Hex } from '../domain/hash.js';
import { parseCsv, type CsvRow } from './csv.js';

/**
 * Maps the owner's May 2026 inventory CSV ("clean master") to the neutral import format.
 *
 * Principles (spec section 16): data only; every source row is accounted for (imported, merged or
 * held); old status values are decomposed into acquisition, planning policy, location and
 * restrictions with their reason kept; unknowns stay unknown; conflicts with the September 2026
 * profile become migration issues instead of guesses. No wear history, laundry state or arrivals are
 * invented: the CSV contains none.
 */

export const INVENTORY_SOURCE_SYSTEM = 'owner-inventory-csv-2026-05';
export const INVENTORY_FILE = 'wardrobe-inventory-2026-05.csv';
/** The CSV names only the month; facts cite this instant with an explicit note. */
export const INVENTORY_OBSERVED_AT = '2026-05-31T00:00:00.000Z';
const PROFILE_OBSERVED_AT = '2026-09-13T23:00:00.000Z'; // 14 September 2026, Europe/London

export const EXPECTED_HEADER = [
  'Category',
  'Item',
  'Colour / Pattern',
  'Fabric / Material',
  'Brand',
  'Size',
  'Season',
  'Status',
  'Notes',
  'Source detail (fabric / construction)',
  'Price (£)',
  'Acquired',
  'Link',
  'Ref / PCF',
];

export interface InventoryRow {
  line: number;
  rowSha256: string;
  category: string;
  item: string;
  colour: string;
  fabric: string;
  brand: string;
  size: string;
  season: string;
  status: string;
  notes: string;
  sourceDetail: string;
  price: string;
  acquired: string;
  link: string;
  ref: string;
}

export interface StatusMapping {
  csvStatus: string;
  acquisition: 'owned';
  planningPolicy: PlanningPolicy;
  location: 'home';
  tier?: string;
  benchedReason?: string;
  tailoring?: 'candidate' | 'planned';
  fitNote?: string;
  breakingIn?: boolean;
  restrictedBy?: string;
  /** False for a status the importer does not know; such rows are held for review, never planned (ADV-15). */
  recognised: boolean;
  explanation: string;
}

export interface InventoryMapping {
  sourceSha256: string;
  title: string;
  header: string[];
  rows: InventoryRow[];
  garments: ImportGarmentInput[];
  statusMappings: Map<string, StatusMapping>;
  heldRows: { sourceId: string; row: number; rowSha256: string; reason: string }[];
  issues: NonNullable<ImportDatasetInput['issues']>;
  merges: { name: string; rows: number[] }[];
  renames: { item: string; names: string[] }[];
  lifecycle: NonNullable<ImportDatasetInput['lifecycleProjects']>;
}

const clean = (s: string | undefined): string => (s ?? '').trim();
const unknown = (s: string): string | undefined => {
  const v = clean(s);
  return v === '' || v === '-' || v === '(pre-sheet)' ? undefined : v;
};

export async function readInventoryCsv(csvText: string): Promise<{ title: string; header: string[]; rows: InventoryRow[]; sha256: string }> {
  const parsed = parseCsv(csvText);
  if (parsed.length < 3) throw new Error('Inventory CSV has no data rows');
  const title = clean(parsed[0]!.fields[0]);
  const header = parsed[1]!.fields.map(clean);
  if (header.join('|') !== EXPECTED_HEADER.join('|')) throw new Error(`Unexpected inventory header: ${header.join(', ')}`);
  const rows: InventoryRow[] = [];
  for (const r of parsed.slice(2)) {
    if (r.fields.every((f) => clean(f) === '')) continue;
    rows.push(await toRow(r));
  }
  return { title, header, rows, sha256: await sha256Hex(csvText) };
}

async function toRow(r: CsvRow): Promise<InventoryRow> {
  const f = r.fields;
  return {
    line: r.line,
    rowSha256: await sha256Hex(r.raw),
    category: clean(f[0]),
    item: clean(f[1]),
    colour: clean(f[2]),
    fabric: clean(f[3]),
    brand: clean(f[4]),
    size: clean(f[5]),
    season: clean(f[6]),
    status: clean(f[7]),
    notes: clean(f[8]),
    sourceDetail: clean(f[9]),
    price: clean(f[10]),
    acquired: clean(f[11]),
    link: clean(f[12]),
    ref: clean(f[13]),
  };
}

// ------------------------------------------------------------------ classification

export function categoryOf(row: InventoryRow): Category | null {
  const item = row.item.toLowerCase();
  switch (row.category) {
    case 'Footwear':
      if (row.brand === 'New Balance') return 'sneakers';
      return /\bboot\b/.test(item) ? 'boots' : 'shoes';
    case 'Shirt':
      return 'shirt';
    case 'Trouser':
      return /^denim\b/.test(item) ? 'jeans' : 'trousers';
    case 'Outerwear':
      if (/games|cashmere cord/.test(item)) return 'blazer';
      if (/grandfather coat|overcoat|peacoat/.test(item)) return 'coat';
      return 'jacket';
    case 'Accessory':
      if (/belt/.test(item)) return 'belt';
      if (/\btie\b/.test(item)) return 'tie';
      if (/scarf|bandana|polka-dot/.test(item)) return 'scarf';
      return 'accessory';
    case 'Sock':
      return 'socks';
    default:
      return null;
  }
}

const FAMILY_RULES: [RegExp, string][] = [
  [/\+|\/.*\/| plaid|ombre/, 'multi'],
  [/navy|ink|inky/, 'navy'],
  [/black|noir/, 'black'],
  [/off-white|bone white|\bwhite\b/, 'white'],
  [/cream/, 'cream'],
  [/beige|sand|biscuit|milky tea|camel|natural/, 'beige'],
  [/walnut|brown|tobacco|mocha|marron|café|bark|earth/, 'brown'],
  [/charcoal|grey|gray/, 'grey'],
  [/slate blue|blue jean|strong blue|light blue|\bblue\b/, 'blue'],
  [/slate/, 'slate'],
  [/sage/, 'sage'],
  [/olive|fatigue|khaki|moss/, 'olive'],
  [/green|evergreen|laurel|pine|forest|emerald/, 'green'],
  [/rust|clay/, 'rust'],
  [/burgundy|wine|maroon/, 'burgundy'],
  [/pink|rose/, 'pink'],
  [/red/, 'red'],
  [/gold|yellow/, 'gold'],
];

export function colourFamily(colour: string): string | undefined {
  const c = colour.toLowerCase();
  if (/stripe|check|pow/.test(c)) {
    for (const [re, fam] of FAMILY_RULES.slice(1)) if (re.test(c)) return fam;
    return 'multi';
  }
  for (const [re, fam] of FAMILY_RULES) if (re.test(c)) return fam;
  return undefined;
}

function pattern(row: InventoryRow): string | undefined {
  const s = `${row.item} ${row.colour}`.toLowerCase();
  if (/stripe/.test(s)) return /extra-wide/.test(s) ? 'extra-wide stripe' : /wide stripe/.test(s) ? 'wide stripe' : /university stripe/.test(s) ? 'university stripe' : 'stripe';
  if (/plaid/.test(s)) return 'plaid';
  if (/check|pow/.test(s)) return 'check';
  if (/ombre/.test(s)) return 'ombre';
  if (/polka/.test(s)) return 'polka dot';
  if (/herringbone/.test(`${s} ${row.fabric.toLowerCase()}`)) return 'herringbone';
  return undefined;
}

function fabricClass(row: InventoryRow): string | undefined {
  const item = row.item.toLowerCase();
  const fab = row.fabric.toLowerCase();
  if (item.startsWith('lightweight oxford')) return 'lightweight_oxford';
  if (item.startsWith('pima oxford')) return 'heavy_oxford';
  if (/cotton-linen|cotton sunwashed \+ linen|wool & linen/.test(fab)) return 'cotton_linen';
  if (/linen/.test(fab)) return 'linen';
  if (/oxford/.test(fab)) return 'oxford';
  if (/flannel/.test(fab)) return 'flannel';
  if (/corduroy|cord\b/.test(fab)) return 'corduroy';
  if (/denim/.test(fab)) return 'denim';
  if (/merino/.test(fab)) return 'merino';
  if (/alpaca/.test(fab)) return 'alpaca';
  if (/cashmere/.test(fab)) return 'cashmere';
  if (/moleskin/.test(fab)) return 'moleskin';
  if (/waxed/.test(fab)) return 'waxed_cotton';
  if (/silk knit/.test(fab)) return 'silk_knit';
  if (/wool-silk/.test(fab)) return 'wool_silk';
  if (/wool/.test(fab)) return 'wool';
  if (/twill|sateen|slub/.test(fab)) return 'cotton_twill';
  if (/leather|deerskin|suede/.test(fab)) return 'leather';
  return undefined;
}

function weight(row: InventoryRow): 'light' | 'mid' | 'heavy' | undefined {
  const s = `${row.item} ${row.fabric} ${row.notes}`.toLowerCase();
  if (/heavyweight|heavy rustic|heavy twill|\bheavy\b|~480gsm|~400gsm/.test(s)) return 'heavy';
  if (/lightweight|\blight\b|200gsm|thin/.test(s)) return 'light';
  return undefined;
}

export function temperatureRange(season: string): { minTempC?: number; maxTempC?: number } {
  const range = season.match(/(\d+)\s*-\s*(\d+)\s*°C/);
  if (range) return { minTempC: Number(range[1]), maxTempC: Number(range[2]) };
  const to = season.match(/To\s+(\d+)\s*°C/i);
  if (to) return { maxTempC: Number(to[1]) };
  const plus = season.match(/(\d+)\s*°C\+/);
  if (plus) return { minTempC: Number(plus[1]) };
  return {};
}

export function mapStatus(row: InventoryRow, category: Category | null): StatusMapping {
  const s = row.status;
  const base = { csvStatus: s, acquisition: 'owned' as const, location: 'home' as const, recognised: true };
  const footwearRestricted = category === 'shoes' || category === 'boots';
  const restrictedBy = footwearRestricted ? 'profile-sneakers-only' : undefined;
  if (s === 'Active') return { ...base, planningPolicy: 'normal', restrictedBy, explanation: 'Owned, planned normally, at home' + (restrictedBy ? '; welted footwear under the sneakers-only restriction' : '') };
  if (s === 'Active (layering tier)') return { ...base, planningPolicy: 'normal', tier: 'layering', explanation: 'Owned, planned normally as a layering piece' };
  if (s === 'Secondary/layering') return { ...base, planningPolicy: 'normal', tier: 'secondary_layering', explanation: 'Owned, planned normally as a secondary/layering piece, not primary' };
  if (s === 'Active (a bit large)') return { ...base, planningPolicy: 'normal', fitNote: 'a bit large', tailoring: /tailoring planned/i.test(row.notes) ? 'planned' : undefined, explanation: 'Owned, planned normally; fit note "a bit large"' + (/tailoring planned/i.test(row.notes) ? '; tailoring planned (not at the tailor)' : '') };
  if (s === 'Breaking in') return { ...base, planningPolicy: 'normal', breakingIn: true, restrictedBy, explanation: 'Owned; breaking in. Unavailable under the sneakers-only restriction until the owner says his feet have healed' };
  if (s === 'Occasional') return { ...base, planningPolicy: 'occasional', explanation: 'Owned; occasional (offered only on explicit request)' };
  const benched = s.match(/^Benched(?: \((.+)\))?$/);
  if (benched) {
    const reason = benched[1] ?? (row.notes || 'benched');
    const tooLarge = /too large/.test(reason);
    const why = benched[1] ? reason : "reason from the row's notes";
    return { ...base, planningPolicy: 'excluded', benchedReason: reason, tailoring: tooLarge ? 'candidate' : undefined, explanation: `Owned; excluded from planning (benched: ${why})${tooLarge && !/tailoring candidate/.test(reason) ? '; tailoring candidate' : ''}` };
  }
  return { ...base, planningPolicy: 'excluded', restrictedBy, recognised: false, explanation: `Unrecognised status "${s}"; row held for review, not imported or planned` };
}

function sockQuantity(row: InventoryRow): number | null {
  const m = row.notes.match(/(\d+)\s*x\b/i);
  return m ? Number(m[1]) : null;
}

function productName(detail: string): string | undefined {
  const first = detail.split(' · ')[0]!.replace(/\s*\|\s*Casual Pants\s*$/i, '').trim();
  return first || undefined;
}

function constructionFacts(row: InventoryRow): Record<string, string> {
  const out: Record<string, string> = {};
  const detail = row.sourceDetail;
  const collar = detail.match(/Soft [A-Za-z ]*Collar/);
  if (collar) out.collar = collar[0];
  const cuff = detail.match(/Soft [A-Za-z ]*Cuff/);
  if (cuff) out.cuff = cuff[0];
  if (/fused cuffs/i.test(row.notes)) out.cuffConstruction = 'fused';
  if (/welted/i.test(row.notes)) out.construction = 'welted';
  if (/\(remake\)/i.test(detail)) out.remake = 'true';
  return out;
}

// ------------------------------------------------------------------ mapping

const PAIR = /\s*\(pair (\d+)\)\s*$/i;

export async function mapInventory(csvText: string): Promise<InventoryMapping> {
  const { title, header, rows, sha256 } = await readInventoryCsv(csvText);
  const issues: InventoryMapping['issues'] = [];
  const heldRows: InventoryMapping['heldRows'] = [];
  const statusMappings = new Map<string, StatusMapping>();
  const garments: ImportGarmentInput[] = [];
  const lifecycle: InventoryMapping['lifecycle'] = [];
  const merges: InventoryMapping['merges'] = [];
  const renames: InventoryMapping['renames'] = [];

  // Items that appear on several rows with different colours get the colour in their perceptible name.
  const itemCounts = new Map<string, number>();
  for (const r of rows) if (!PAIR.test(r.item)) itemCounts.set(r.item, (itemCounts.get(r.item) ?? 0) + 1);
  for (const [item, n] of itemCounts) {
    if (n > 1) renames.push({ item, names: rows.filter((r) => r.item === item).map((r) => `${item} — ${r.colour.toLowerCase()}`) });
  }

  // Identical interchangeable rows ("pair 1" / "pair 2") merge into one garment with a quantity.
  const groups = new Map<string, InventoryRow[]>();
  for (const r of rows) {
    const key = PAIR.test(r.item) ? `pair:${r.item.replace(PAIR, '')}|${r.colour}|${r.fabric}|${r.brand}|${r.size}` : `row:${r.line}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  const cite = (r: InventoryRow) => `${INVENTORY_FILE}#row=${r.line} (clean master, May 2026; day not stated)`;

  for (const [key, group] of groups) {
    const r = group[0]!;
    const category = categoryOf(r);
    const sourceId = `csv:row-${r.line}`;
    if (!category || !r.item) {
      heldRows.push({ sourceId, row: r.line, rowSha256: r.rowSha256, reason: `Unrecognised category "${r.category}" or empty item; held for resolution` });
      continue;
    }
    const merged = key.startsWith('pair:');
    const status = mapStatus(r, category);
    if (!status.recognised) {
      // ADV-15: a status the importer does not understand is never guessed into a planning policy.
      statusMappings.set(r.status, statusMappings.get(r.status) ?? status);
      for (const g of group) heldRows.push({ sourceId: `csv:row-${g.line}`, row: g.line, rowSha256: g.rowSha256, reason: `Unrecognised status "${r.status}"; held for the owner's review instead of being planned` });
      continue;
    }
    if (merged) {
      // A merge is only valid when every other column is identical.
      const differs = group.some((g) => g.price !== r.price || g.acquired !== r.acquired || g.season !== r.season || g.status !== r.status || g.notes !== r.notes || g.sourceDetail !== r.sourceDetail);
      if (differs) {
        for (const g of group) heldRows.push({ sourceId: `csv:row-${g.line}`, row: g.line, rowSha256: g.rowSha256, reason: 'Numbered pair rows differ in detail; held instead of merging' });
        continue;
      }
      merges.push({ name: r.item.replace(PAIR, ''), rows: group.map((g) => g.line) });
    }
    const d = CATEGORY_DEFAULTS[category];
    statusMappings.set(r.status, statusMappings.get(r.status) ?? status);
    const renamed = !merged && (itemCounts.get(r.item) ?? 0) > 1;
    const name = merged ? r.item.replace(PAIR, '') : renamed ? `${r.item} — ${r.colour.toLowerCase()}` : r.item;
    const fam = colourFamily(r.colour);
    const temps = temperatureRange(r.season);
    const construction = constructionFacts(r);
    const isSock = category === 'socks';
    const qtyFromNote = isSock ? sockQuantity(r) : null;
    const quantity = merged ? group.length : isSock ? (qtyFromNote ?? 1) : 1;
    if (isSock && qtyFromNote === null) {
      issues.push({
        issueKey: `quantity_unstated:${sourceId}`,
        kind: 'quantity_unstated',
        severity: 'review',
        garmentSourceId: sourceId,
        detail: `${name}: the CSV gives no pair count (no "Nx" note). Recorded the minimum the row supports (1 pair); correct with a quantity reconciliation.`,
        evidence: { row: r.line, notes: r.notes },
      });
    }
    const model = r.brand === 'New Balance' ? (r.item.match(/99\d(v\d)?/)?.[0] ?? undefined) : undefined;
    const attributes: GarmentAttributes = {
      ...(fabricClass(r) ? { fabricClass: fabricClass(r) } : {}),
      ...(weight(r) ? { weight: weight(r) } : {}),
      ...temps,
      ...(r.season && r.season !== '-' ? { seasonLabel: r.season } : {}),
      ...(construction.construction ? { construction: construction.construction } : {}),
      ...(construction.cuffConstruction ? { cuffConstruction: construction.cuffConstruction } : {}),
      ...(model ? { model } : {}),
      ...(status.tier ? { tier: status.tier } : {}),
      ...(status.benchedReason ? { benchedReason: status.benchedReason } : {}),
      ...(status.fitNote ? { fitNote: status.fitNote } : {}),
      ...(status.breakingIn ? { breakingIn: true } : {}),
      ...(/bed sock/i.test(r.item) ? { indoorOnly: true } : {}),
      ...(/semi-transparent/i.test(r.notes) ? { tags: ['semi_transparent'] } : {}),
      csvStatus: r.status,
      ...(fam ? { colorFamilySource: 'derived_from_csv_colour' } : {}),
    };
    // Paraboot occupies the welted half of the fleet (profile section 9); the CSV states it only for the Reims.
    if (r.brand === 'Paraboot' && !attributes.construction) attributes.construction = 'welted';

    const aliases: { phrase: string; kind: 'owner_phrase' | 'maker_name' | 'maker_code' }[] = [];
    if (renamed || merged) aliases.push({ phrase: r.item, kind: 'owner_phrase' });
    if (merged) for (const g of group.slice(1)) aliases.push({ phrase: g.item, kind: 'owner_phrase' });
    const pn = /mislabel/i.test(r.notes) ? undefined : productName(r.sourceDetail);
    if (pn && pn.toLowerCase() !== name.toLowerCase()) aliases.push({ phrase: pn, kind: 'maker_name' });
    if (unknown(r.ref)) aliases.push({ phrase: r.ref, kind: 'maker_code' });
    const maker = unknown(r.brand);
    if (maker && !name.toLowerCase().startsWith(maker.toLowerCase()) && !isSock) aliases.push({ phrase: `${maker} ${name}`, kind: 'maker_name' });

    const facts: NonNullable<ImportGarmentInput['facts']> = [];
    const fact = (field: string, value: unknown) => facts.push({ field, value, sourceKind: 'import', sourceRef: cite(r), observedAt: INVENTORY_OBSERVED_AT });
    if (unknown(r.fabric)) fact('fabric', r.fabric);
    if (unknown(r.season)) fact('season', r.season);
    if (unknown(r.size)) fact('size', r.size);
    if (unknown(r.price)) fact('price_gbp', Number(r.price));
    if (unknown(r.acquired)) fact('acquired_on', r.acquired);
    if (unknown(r.sourceDetail)) fact('source_detail', r.sourceDetail);
    if (unknown(r.notes)) fact('notes', r.notes);
    fact('csv_status', r.status);
    for (const [k, v] of Object.entries(construction)) fact(`construction.${k}`, v);
    if (r.link) fact('link', r.link === 'link' ? 'present in the source sheet; URL not included in the export' : r.link);
    if (r.brand === 'Paraboot' && !construction.construction) {
      facts.push({ field: 'construction', value: 'welted', sourceKind: 'owner_statement', sourceRef: 'owner-profile.md §9: "Paraboot occupies the welted half of the fleet"', observedAt: PROFILE_OBSERVED_AT });
    }
    if (r.brand === '(pre-sheet)') fact('maker', 'unknown (listed as "(pre-sheet)")');

    garments.push({
      sourceId,
      name,
      category,
      roles: d.roles,
      maker,
      productName: pn,
      productCode: unknown(r.ref),
      fabric: unknown(r.fabric),
      color: unknown(r.colour),
      colorFamily: fam,
      pattern: pattern(r),
      sizeLabel: unknown(r.size),
      careChannel: d.careChannel,
      laundryPolicy: d.laundryPolicy,
      tracking: merged ? 'anonymous_quantity' : d.tracking,
      acquisition: 'owned',
      planningPolicy: status.planningPolicy,
      condition: 'unknown',
      location: 'home',
      attributes,
      notes: unknown(r.notes),
      stock: { clean: quantity },
      aliases,
      facts,
      sourceRows: group.map((g, i) => ({
        sourceId: `csv:row-${g.line}`,
        row: g.line,
        rowSha256: g.rowSha256,
        disposition: i === 0 ? ('imported' as const) : ('merged' as const),
        ...(i > 0 ? { note: `Identical to row ${r.line} except the pair number; merged into one garment with quantity ${group.length}` } : {}),
      })),
    });

    if (status.tailoring) {
      lifecycle.push({
        sourceId: `tailoring:${sourceId}`,
        kind: 'tailoring',
        garmentSourceIds: [sourceId],
        status: status.tailoring,
        details: { reason: status.benchedReason ?? status.fitNote ?? r.notes, csvStatus: r.status, notes: r.notes || undefined },
      });
    }
  }

  issues.push(...conflictIssues(rows, garments));
  return { sourceSha256: sha256, title, header, rows, garments, statusMappings, heldRows, issues, merges, renames, lifecycle };
}

// ------------------------------------------------------------------ profile vs CSV conflicts

/**
 * Things the September 2026 profile names that the May 2026 CSV lacks. Each quote is verbatim from
 * the profile (checked by tests). Absence is recorded, never filled in.
 */
export const PROFILE_CLAIMS: { key: string; quote: string; section: string; present: (rows: InventoryRow[]) => boolean; detail: string }[] = [
  {
    key: 'nb_990v6',
    section: '9. Footwear and accessories',
    quote: 'the 990v4 and 990v6 chosen on their merits rather than by habit',
    present: (rows) => rows.some((r) => /990v6/i.test(r.item)),
    detail: 'The profile names a New Balance 990v6 (also excluded by the sneakers-only rule); the May 2026 CSV lists only 990v4s. Not created; the restriction covers any 990v6 added later by model.',
  },
  {
    key: 'nb_993',
    section: '9. Footwear and accessories',
    quote: 'with the 993 a genuine complement',
    present: (rows) => rows.some((r) => /\b993\b/.test(r.item)),
    detail: 'The profile names a New Balance 993; the CSV has none. Not created.',
  },
  {
    key: 'rugbies',
    section: '3. The registers he dresses in',
    quote: 'Multi-stripe and panelled rugbies, worn loud over quiet trousers',
    present: (rows) => rows.some((r) => /rugby/i.test(r.item)),
    detail: 'The profile describes rugbies (the fun lane; size XL, remaining XXLs as layering); the CSV lists no rugby shirts. Not created.',
  },
  {
    key: 'shetland_knitwear',
    section: '4. Fabric is neurological, not decorative',
    quote: 'Shetland wool',
    present: (rows) => rows.some((r) => /shetland|jumper|sweater|cardigan|knit(?!.*tie)/i.test(`${r.item} ${r.fabric}`) && r.category !== 'Accessory'),
    detail: 'The profile names Shetland (and cashmere) knitwear and a cardigan at the quiet end; the CSV has no knitwear rows at all. Not created.',
  },
  {
    key: 'indigo_jeans_light_mid_dark',
    section: '8. Hard constraints',
    quote: 'Jeans are light, mid or dark.',
    present: (rows) => rows.some((r) => /jean|denim/i.test(r.item) && /indigo|blue|\bwash\b/i.test(r.colour) && r.category === 'Trouser'),
    detail: 'The profile names light, mid and dark jeans (and mid-wash jeans with a blue-stripe OCBD); the CSV lists only light olive and white denim trousers. No indigo jeans were created; naming rule kept for when they are added.',
  },
  {
    key: 'western_shirts',
    section: '3. The registers he dresses in',
    quote: 'western shirts, double denim',
    present: (rows) => rows.some((r) => /western/i.test(`${r.item} ${r.sourceDetail}`)),
    detail: 'The profile names western shirts; the CSV has none (one ISTO denim shirt only).',
  },
  {
    key: 'd43',
    section: '3. The registers he dresses in',
    quote: 'the D-43',
    present: (rows) => rows.some((r) => /d-?43/i.test(r.item)),
    detail: 'The profile names a D-43 jacket among field and workwear outerwear; the CSV has none.',
  },
  {
    key: 'academic_tweed_donegal',
    section: '3. The registers he dresses in',
    quote: 'salt-and-pepper tweed, chestnut houndstooth with a thin blue line, Donegal',
    present: (rows) => rows.some((r) => /donegal|houndstooth/i.test(`${r.item} ${r.fabric} ${r.colour}`)),
    detail: 'The profile (August 2026 reintroduction) names salt-and-pepper tweed, chestnut houndstooth and Donegal blazers; the May CSV has only a Harris Tweed Marylebone (benched, too large). They may post-date the CSV; not created.',
  },
  {
    key: 'paraboot_norwegian',
    section: '9. Footwear and accessories',
    quote: 'the alpine moc, the Norwegian split-toe and the plain city derby',
    present: (rows) => rows.some((r) => r.brand === 'Paraboot' && /avignon|norwegian|split/i.test(`${r.item} ${r.notes}`)),
    detail: 'The profile names three Paraboot bloodlines (alpine moc, Norwegian split-toe, city derby); the CSV has the Michael (moc) and two Reims (derby) but no Norwegian split-toe. Not created.',
  },
  {
    key: 'chore_coat_variants',
    section: '3. The registers he dresses in',
    quote: 'chore coats in their French, Dutch and Ivy variants',
    present: (rows) => rows.filter((r) => /chore/i.test(r.item)).length >= 2,
    detail: "The profile describes chore coats in French, Dutch and Ivy variants; the CSV lists one (Drake's Black Heavy Twill Chore) plus a work coat. The variants are not created.",
  },
];

function conflictIssues(rows: InventoryRow[], garments: ImportGarmentInput[]): InventoryMapping['issues'] {
  const out: InventoryMapping['issues'] = [];
  const byRow = (r: InventoryRow) => garments.find((g) => g.sourceRows?.some((s) => s.row === r.line));
  for (const claim of PROFILE_CLAIMS) {
    if (!claim.present(rows)) {
      out.push({ issueKey: `profile_absent:${claim.key}`, kind: 'profile_item_absent_from_inventory', severity: 'conflict', detail: claim.detail, evidence: { profileSection: claim.section, profileQuote: claim.quote } });
    }
  }
  for (const r of rows) {
    const g = byRow(r);
    const gid = g?.sourceId;
    const text = `${r.item} ${r.fabric} ${r.sourceDetail}`;
    if (/moleskin/i.test(text)) {
      out.push({
        issueKey: `fabric_conflict:moleskin:${gid}`,
        kind: 'profile_fabric_conflict',
        severity: 'conflict',
        garmentSourceId: gid,
        detail: `${g?.name ?? r.item} is owned and active ("${r.notes}"), but the profile says sealed or napped surfaces, moleskin included, repel. Kept as owned and plannable; the owner decides whether the profile or the garment wins.`,
        evidence: { row: r.line, profileSection: '4. Fabric is neurological, not decorative', profileQuote: 'sealed or napped surfaces, moleskin included' },
      });
    }
    if (/waxed/i.test(r.fabric)) {
      out.push({
        issueKey: `fabric_conflict:waxed:${gid}`,
        kind: 'profile_fabric_conflict',
        severity: 'review',
        garmentSourceId: gid,
        detail: `${g?.name ?? r.item} is waxed cotton; the profile lists sealed surfaces among fabrics that repel. Whether waxed cotton counts as "sealed" is not stated; kept as owned and active.`,
        evidence: { row: r.line, profileQuote: 'sealed or napped surfaces, moleskin included' },
      });
    }
    if (/mislabel/i.test(r.notes)) {
      out.push({
        issueKey: `source_label_conflict:${gid}`,
        kind: 'source_label_conflict',
        severity: 'review',
        garmentSourceId: gid,
        detail: `${g?.name ?? r.item}: the CSV itself notes "${r.notes}"; its source detail reads "${r.sourceDetail}". Imported under the Item name; the mislabelled source wording is kept only as a dated fact, not as a product name or alias.`,
        evidence: { row: r.line, notes: r.notes, sourceDetail: r.sourceDetail },
      });
    }
    if (/fused/i.test(r.notes)) {
      out.push({
        issueKey: `construction_conflict:fused:${gid}`,
        kind: 'profile_construction_conflict',
        severity: 'review',
        garmentSourceId: gid,
        detail: `${g?.name ?? r.item} has fused cuffs ("${r.notes}"); the profile says collars and cuffs must be sewn, never fused. Kept in its layering tier as the CSV states.`,
        evidence: { row: r.line, profileQuote: 'Collars and cuffs must be sewn, never fused' },
      });
    }
    if (/semi-transparent/i.test(r.notes)) {
      out.push({
        issueKey: `fabric_conflict:thin_linen:${gid}`,
        kind: 'profile_fabric_conflict',
        severity: 'review',
        garmentSourceId: gid,
        detail: `${g?.name ?? r.item} is pure linen noted "${r.notes}"; the profile says thin linen repels and names a thin, semi-transparent shirt as a failure. Kept active for 30 °C+ as the CSV states.`,
        evidence: { row: r.line, profileQuote: 'thin linen' },
      });
    }
    // Maker-specific sizes: never carried across makers.
    const cat = categoryOf(r);
    if (r.brand === "Drake's" && (cat === 'blazer' || cat === 'jacket' || cat === 'coat') && unknown(r.size) && r.size !== '46') {
      out.push({
        issueKey: `size_conflict:drakes:${gid}`,
        kind: 'size_conflict',
        severity: 'review',
        garmentSourceId: gid,
        detail: `${g?.name ?? r.item} is Drake's size ${r.size}; the profile gives 46 at Drake's for jackets and coats${/large/i.test(r.status) ? ` (the CSV notes "${r.status}"${r.notes ? `, "${r.notes}"` : ''})` : ''}. Recorded as sized; no fit is inferred.`,
        evidence: { row: r.line, profileQuote: "Jackets and coats: 46 at Drake's, including Games blazers, chores and macs." },
      });
    }
    if (r.brand === 'Private White VC' && unknown(r.size) && r.size !== '6' && !/too large/.test(r.status)) {
      out.push({
        issueKey: `size_conflict:pwvc:${gid}`,
        kind: 'size_conflict',
        severity: 'review',
        garmentSourceId: gid,
        detail: `${g?.name ?? r.item} is Private White size ${r.size} and active; the profile gives Private White chart size 6 / XL.`,
        evidence: { row: r.line, profileQuote: 'Private White chart size 6 / XL.' },
      });
    }
    if (r.category === 'Footwear' && r.size !== 'UK 8.5') {
      out.push({
        issueKey: `size_note:footwear:${gid}`,
        kind: 'size_note',
        severity: 'info',
        garmentSourceId: gid,
        detail: `${g?.name ?? r.item} is ${r.size}; the profile's UK 8.5 applies to sneakers and Paraboot. The CSV explains: "${r.notes}". Recorded as a maker-specific size.`,
        evidence: { row: r.line, profileQuote: 'Footwear: UK 8.5 across sneakers and Paraboot alike.' },
      });
    }
  }
  // Aggregated gaps.
  const benchedLarge = rows.filter((r) => /Benched \(too large/.test(r.status));
  if (benchedLarge.length) {
    out.push({
      issueKey: 'lifecycle_uncertain:benched_too_large',
      kind: 'lifecycle_uncertain',
      severity: 'review',
      detail: `${benchedLarge.length} rows are "Benched (too large)" in May 2026. The September profile describes a consignment of oversized pieces (Games blazers, a jungle jacket, rugbies) already sold. Whether any of these rows were consigned or sold since is unknown; all are kept owned, excluded from planning, as tailoring candidates.`,
      evidence: { rows: benchedLarge.map((r) => r.line), profileQuote: 'He sold Games blazers, a jungle jacket and rugbies because they no longer fit' },
    });
  }
  const linenShirts = rows.filter((r) => r.category === 'Shirt' && /linen/i.test(r.fabric) && !/cotton/i.test(r.fabric));
  if (linenShirts.length) {
    out.push({
      issueKey: 'thermal_basis_uncertain:pure_linen_shirts',
      kind: 'thermal_basis_uncertain',
      severity: 'review',
      detail: `${linenShirts.length} pure-linen shirts carry CSV seasons ("Warm-weather", "Transitional") that disagree with the spec's research rule "pure linen from 30 °C" (not a profile rule). Their season labels are imported as facts; no temperature threshold is invented.`,
      evidence: { rows: linenShirts.map((r) => r.line) },
    });
  }
  const preSheet = rows.filter((r) => r.brand === '(pre-sheet)');
  if (preSheet.length) {
    out.push({ issueKey: 'maker_unknown:pre_sheet', kind: 'maker_unknown', severity: 'info', detail: `${preSheet.length} rows list the brand as "(pre-sheet)"; maker and size stay unknown.`, evidence: { rows: preSheet.map((r) => r.line) } });
  }
  const pairsBrand = rows.filter((r) => r.brand === 'Pairs');
  if (pairsBrand.length) {
    out.push({
      issueKey: 'maker_ambiguous:socks_pairs',
      kind: 'maker_ambiguous',
      severity: 'info',
      detail: `${pairsBrand.length} sock rows list the brand as "Pairs"; it may be the maker or a unit label. Imported verbatim as the maker.`,
      evidence: { rows: pairsBrand.map((r) => r.line) },
    });
  }
  const links = rows.filter((r) => r.link === 'link');
  if (links.length) {
    out.push({ issueKey: 'link_missing:placeholder', kind: 'link_missing', severity: 'info', detail: `${links.length} rows say "link" but the export contains no URL; product pages must be found again for image discovery.`, evidence: { rows: links.map((r) => r.line) } });
  }
  return out;
}
