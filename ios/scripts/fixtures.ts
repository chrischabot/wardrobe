/**
 * iOS fixture generator and contract checker.
 *
 *   npx tsx ios/scripts/fixtures.ts generate        (from garderobe/) writes Sources/GarderobeKit/Resources/Fixtures
 *   npx tsx ios/scripts/fixtures.ts verify          fails if the committed fixtures differ from a fresh generation
 *   npx tsx ios/scripts/fixtures.ts check <dir>     validates JSON the Swift tests wrote (envelopes, receipts, requests)
 *
 * Garments come from the owner's real May 2026 CSV through the backend's own mapper, so names, roles,
 * aliases and attributes are exactly what the backend imports, followed by the 17 owner-asserted additions
 * of 2026-09-29 (data/owner-asserted-additions-2026-09-29.json), parsed and quote-checked by the backend's
 * parseOwnerAdditions and built as the seed's add_item commands build them (category defaults, one unit,
 * condition unknown, unknown colour/maker/size left null). Scenario state is the labelled TEST EVENT
 * overlay mirroring demo/src/test-events.ts. The board, conversation and weather are DEMO content.
 * Every fixture is validated against the shipped zod schemas in packages/contracts.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  CommandEnvelope,
  CommandReceipt,
  CONTRACTS_VERSION,
  API_VERSION,
  ItemDetail,
  SettingsResponse,
  TodayResponse,
  WardrobePage,
  RunEvent,
  DEFAULT_LAUNDRY_ROUTINE,
  AddItemCommand,
  ConnectionsResponse,
  ConversationPage,
  LaundryState,
  ReceiptsPage,
  RecallSearchRequest,
  RecallSearchResponse,
  RunInputRequest,
  RunInputResponse,
  RunStatus,
  SwapCandidates,
  UploadReceiveResponse,
  RunEventPayloads,
  StudioSuggestRequest,
  StudioValidateRequest,
  StyleCurrentResponse,
  TurnRequest,
  TurnResponse,
  UploadRequest,
  WardrobeQueryParams,
  AccountTransfers,
  ExportDownloadResult,
  McpImportResult,
  RecoveryKitLink,
  RecoveryKitResponse,
  RecoveryStatus,
  StagedImportPackage,
  type Garment,
} from '@garderobe/contracts';
import { additionIdempotencyKey, additionRestricted, mapInventory, parseOwnerAdditions } from '@garderobe/backend/import';
import { CATEGORY_DEFAULTS } from '@garderobe/backend/domain';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = join(here, '..', 'Sources', 'GarderobeKit', 'Resources', 'Fixtures');
const TEST_EVENT = 'TEST EVENT (fixture, not owner data)';
const DEMO = 'DEMO FIXTURE';

const h = (s: string, n = 20) => createHash('sha256').update(s).digest('hex').slice(0, n);
const gid = (sourceId: string) => `g_${h(sourceId)}`;

/** The owner's current wardrobe before any scenario overlay: May CSV + owner-asserted additions. */
const CSV_GARMENTS = 127;
const CSV_UNITS = 144;
const ADDITIONS_FILE = 'owner-asserted-additions-2026-09-29.json';

function readAdditions() {
  return parseOwnerAdditions(JSON.parse(readFileSync(join(root, 'data', ADDITIONS_FILE), 'utf8')), readFileSync(join(root, 'data', 'owner-profile.md'), 'utf8'));
}

/** Fixture garment ID of an addition (stable; derived from the seed's idempotency key). */
const additionGid = (key: string) => gid(additionIdempotencyKey(key));

/** The profile's sneakers-only restriction scope (categories shoes/boots, welted construction, the 990v6). */
const isRestricted = (g: Pick<Garment, 'category' | 'attributes'>) =>
  g.category === 'shoes' || g.category === 'boots' || g.attributes.construction === 'welted' || g.attributes.model === '990v6';

const IMPORTED_AT = '2026-09-29T08:00:00.000Z';
const BOARD_DATE = '2026-10-06';
const COMPOSED_AT = '2026-10-05T20:40:00.000Z';
const CHECKED_AT = '2026-10-06T05:52:00.000Z';

type Json = Record<string, unknown>;

const produced = new Map<string, string>();
let ownerSummary: { garments: number; units: number; additions: number; restricted: string[]; additionsRestricted: string[] } | null = null;

function emit(name: string, text: string) {
  produced.set(name, text);
}

function write(name: string, value: unknown) {
  emit(name, JSON.stringify(value, null, 2) + '\n');
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new Error(`${label} does not match its contract:\n${JSON.stringify(r.error.issues.slice(0, 5), null, 2)}`);
  return r.data;
}

async function generate() {
  const csv = readFileSync(join(root, 'data', 'wardrobe-inventory-2026-05.csv'), 'utf8');
  const mapping = await mapInventory(csv);

  // --- Garments exactly as mapped by the backend importer ---
  const garments: Garment[] = mapping.garments.map((g) => ({
    garmentId: gid(g.sourceId),
    name: g.name,
    category: g.category,
    roles: g.roles,
    maker: g.maker ?? null,
    productName: g.productName ?? null,
    productCode: g.productCode ?? null,
    fabric: g.fabric ?? null,
    color: g.color ?? null,
    colorFamily: g.colorFamily ?? null,
    pattern: g.pattern ?? null,
    sizeLabel: g.sizeLabel ?? null,
    careChannel: g.careChannel,
    laundryPolicy: g.laundryPolicy,
    tracking: g.tracking ?? 'unit',
    acquisition: g.acquisition,
    disposalReason: null,
    planningPolicy: g.planningPolicy ?? 'normal',
    condition: g.condition ?? 'good',
    location: g.location ?? 'home',
    locationDetail: g.locationDetail ?? null,
    attributes: (g.attributes ?? {}) as Garment['attributes'],
    notes: g.notes ?? null,
    wearLoggingSince: '2026-09-29',
    version: 1,
    createdAt: IMPORTED_AT,
    updatedAt: IMPORTED_AT,
  }));
  const stock = new Map<string, Record<string, number>>();
  const aliases = new Map<string, { aliasId: string; garmentId: string; phrase: string; kind: string; source: string | null }[]>();
  for (const g of mapping.garments) {
    const id = gid(g.sourceId);
    stock.set(id, { clean: 0, worn: 0, hamper: 0, laundry: 0, storage: 0, away: 0, retired: 0, ...(g.stock ?? {}) });
    aliases.set(
      id,
      (g.aliases ?? []).map((a, i) => ({ aliasId: `al_${h(g.sourceId + i, 16)}`, garmentId: id, phrase: a.phrase, kind: a.kind ?? 'owner_phrase', source: 'import' })),
    );
  }
  if (garments.length !== CSV_GARMENTS) throw new Error(`CSV baseline has ${garments.length} garments, expected ${CSV_GARMENTS}`);

  // --- Owner-asserted additions, built exactly as applyOwnerAssertedAdditions' add_item commands ---
  const additions = readAdditions();
  const ANSWER_AT = additions.answer.observedAt;
  for (const a of additions.additions) {
    const c = AddItemCommand.parse({
      type: 'add_item',
      explicit: true,
      ...a.item,
      acquisition: 'owned',
      quantity: 1,
      condition: 'unknown',
      attributes: { ...(a.item.attributes ?? {}), ownerAsserted: true, ownerAnswer: additions.answer.answeredOn },
      notes: `Owner-asserted ${additions.answer.answeredOn}; described only from the owner profile. Unknown: ${a.unknownFields.join('; ')}.`,
    });
    const d = CATEGORY_DEFAULTS[c.category];
    const laundryPolicy = c.laundryPolicy ?? d.laundryPolicy;
    const id = additionGid(a.key);
    garments.push({
      garmentId: id,
      name: c.name,
      category: c.category,
      roles: c.roles,
      maker: c.maker ?? null,
      productName: c.productName ?? null,
      productCode: c.productCode ?? null,
      fabric: c.fabric ?? null,
      color: c.color ?? null,
      colorFamily: c.colorFamily ?? null,
      pattern: c.pattern ?? null,
      sizeLabel: c.sizeLabel ?? null,
      careChannel: laundryPolicy === 'never' ? 'none' : (c.careChannel ?? d.careChannel),
      laundryPolicy,
      tracking: c.tracking ?? d.tracking,
      acquisition: 'owned',
      disposalReason: null,
      planningPolicy: c.planningPolicy ?? 'normal',
      condition: c.condition ?? 'unknown',
      location: c.location ?? 'home',
      locationDetail: null,
      attributes: (c.attributes ?? {}) as Garment['attributes'],
      notes: c.notes ?? null,
      wearLoggingSince: '2026-09-29',
      version: 1,
      createdAt: ANSWER_AT,
      updatedAt: ANSWER_AT,
    });
    if (additionRestricted(a) !== isRestricted(garments.at(-1)!)) throw new Error(`Restriction mismatch for addition ${a.key}`);
    stock.set(id, { clean: 1, worn: 0, hamper: 0, laundry: 0, storage: 0, away: 0, retired: 0 });
    aliases.set(id, []);
  }
  const baselineUnits = [...stock.values()].reduce((n, s) => n + Object.values(s).reduce((a, b) => a + b, 0), 0);
  const expectedGarments = CSV_GARMENTS + additions.additions.length;
  const expectedUnits = CSV_UNITS + additions.additions.length;
  if (garments.length !== expectedGarments || baselineUnits !== expectedUnits) {
    throw new Error(`Owner wardrobe is ${garments.length} garments / ${baselineUnits} units; expected ${expectedGarments} / ${expectedUnits}`);
  }
  const restrictedNames = garments.filter(isRestricted).map((g) => g.name);
  const addedRestricted = additions.additions.filter(additionRestricted).map((a) => a.item.name);
  ownerSummary = { garments: garments.length, units: baselineUnits, additions: additions.additions.length, restricted: restrictedNames, additionsRestricted: addedRestricted };
  const byName = new Map(garments.map((g) => [g.name, g]));
  const G = (name: string): Garment => {
    const g = byName.get(name);
    if (!g) throw new Error(`No garment named ${name}`);
    return g;
  };
  const move = (name: string, from: string, to: string, n = 1) => {
    const s = stock.get(G(name).garmentId)!;
    if ((s[from] ?? 0) < n) throw new Error(`${name}: cannot move ${n} from ${from}`);
    s[from]! -= n;
    s[to] = (s[to] ?? 0) + n;
  };

  // --- TEST EVENT overlay (mirrors demo/src/test-events.ts, week of 28 September 2026) ---
  const wears: { date: string; names: string[]; source: string }[] = [
    { date: '2026-09-28', source: 'app', names: ['Lightweight oxford — blue', 'Di Sondrio walnut chino', 'Merino — inky blue', 'NB 990v4 — grey', "Anderson's belt — brown"] },
    { date: '2026-09-29', source: 'mcp', names: ['Pima oxford — fatigue', 'JP double-pleated heavyweight chino — navy', 'Merino — deep earth brown', 'NB 990v4 — olive/cream', "Drake's Olive Jungle Jacket"] },
    { date: '2026-09-30', source: 'app', names: ['Lightweight oxford — light blue wide stripe', 'Olive reverse sateen fatigue', 'Merino — correct grey', 'NB 990v4 — navy'] },
    { date: '2026-10-02', source: 'app', names: ['Lightweight oxford — moss', 'Stratton stretch corduroy', 'Merino — pine green', 'NB 990v4 — grey'] },
    // DEMO overlay beyond demo/src/test-events.ts: Monday 5 October, so both hampers hold something.
    { date: '2026-10-05', source: 'app', names: ['Pima oxford — white', 'Cord — beige', 'Merino — inky blue', 'NB 990v4 — navy'] },
  ];
  // Trousers stay in use (single_wear_day); the Friday shirt is in the hamper; one shirt is still at the laundry.
  for (const n of ['Di Sondrio walnut chino', 'JP double-pleated heavyweight chino — navy', 'Olive reverse sateen fatigue', 'Stratton stretch corduroy', 'Cord — beige']) move(n, 'clean', 'worn');
  move('Lightweight oxford — moss', 'clean', 'hamper');
  move('Pima oxford — white', 'clean', 'hamper');
  move('Merino — inky blue', 'clean', 'hamper');
  move('Pima oxford — fatigue', 'clean', 'laundry');
  // Lifecycle states the CSV lacks.
  const camel = G("Drake's Camel Field Games");
  Object.assign(camel, { location: 'tailor', locationDetail: `Take in the waist (${TEST_EVENT})`, version: 2 });
  move(camel.name, 'clean', 'away');
  const coat = G('DBF Grandfather Coat');
  Object.assign(coat, { location: 'storage', locationDetail: `Loft (${TEST_EVENT})`, version: 2 });
  move(coat.name, 'clean', 'storage');
  const polka = G("Drake's red polka-dot");
  Object.assign(polka, { acquisition: 'disposed', disposalReason: 'donated', notes: TEST_EVENT, version: 2 });
  move(polka.name, 'clean', 'retired');
  const incoming: Garment = {
    ...G('NB 990v4 — grey'),
    garmentId: `g_${h('test-event:nb993')}`,
    name: `NB 993 — grey (${TEST_EVENT})`,
    maker: 'New Balance',
    productName: null,
    productCode: null,
    color: 'Grey',
    acquisition: 'incoming',
    attributes: { model: '993', testEvent: true },
    notes: TEST_EVENT,
  };
  garments.push(incoming);
  stock.set(incoming.garmentId, { clean: 0, worn: 0, hamper: 0, laundry: 0, storage: 0, away: 0, retired: 0 });
  aliases.set(incoming.garmentId, [{ aliasId: `al_${h('nb993', 16)}`, garmentId: incoming.garmentId, phrase: 'the 993s', kind: 'owner_phrase', source: 'owner' }]);

  const lastWear = new Map<string, string>();
  const wearCount = new Map<string, number>();
  for (const w of wears) for (const n of w.names) {
    const id = G(n).garmentId;
    lastWear.set(id, w.date);
    wearCount.set(id, (wearCount.get(id) ?? 0) + 1);
  }

  const availability = (g: Garment) => {
    const s = stock.get(g.garmentId)!;
    if (g.acquisition === 'incoming') return { label: 'Incoming', available: false, reasons: ['Ordered; not arrived'] };
    if (g.acquisition === 'disposed') return { label: g.disposalReason === 'donated' ? 'Donated' : 'Gone', available: false, reasons: ['No longer owned'] };
    if (g.location === 'tailor') return { label: 'At the tailor', available: false, reasons: [g.locationDetail ?? 'At the tailor'] };
    if (g.location === 'storage') return { label: 'In storage', available: false, reasons: [g.locationDetail ?? 'Seasonal storage'] };
    if (g.planningPolicy === 'excluded') return { label: 'Benched', available: false, reasons: [String(g.attributes.benchedReason ?? 'Excluded from planning')] };
    if (isRestricted(g)) return { label: 'Sneakers only for now', available: false, reasons: ['Healing restriction: sneakers only until his feet have healed'] };
    if ((s.clean ?? 0) > 0) return { label: g.planningPolicy === 'occasional' ? 'Available (occasional)' : 'Available', available: true, reasons: [] };
    // The backend's home availability (backend/src/domain/queries.ts homeAvailability): a per-wear or
    // single-day garment with no clean unit is at the laundry, in the wash or worn, not washed yet.
    if (g.laundryPolicy === 'per_wear' || g.laundryPolicy === 'single_wear_day') {
      const label = (s.laundry ?? 0) > 0 && (s.hamper ?? 0) === 0 && (s.worn ?? 0) === 0 ? 'At the laundry' : (s.hamper ?? 0) > 0 ? 'In the wash' : (s.worn ?? 0) > 0 ? 'Worn, not washed yet' : 'No clean unit';
      return { label, available: false, reasons: ['No clean unit (worn or in the wash)'] };
    }
    return { label: 'Unavailable', available: false, reasons: [] };
  };

  // Contract GarmentMedia. No image assets exist in this fixture set, so URLs stay null (honest: the
  // app shows a labelled outline) and nothing is marked verified.
  const media = (g: Garment) => ({
    thumbnailUrl: null,
    catalogueImageUrl: null,
    aspectRatio: g.roles.includes('footwear') ? 1.5 : 0.8,
    photos: [],
    verified: false,
    catalogueAssetId: null,
    assetClass: null,
    label: null,
    photosNeeded: false,
    urlsExpireAt: null,
  });
  const items = garments.map((g) => {
    const s = stock.get(g.garmentId)!;
    const totalOwned = Object.entries(s).filter(([k]) => k !== 'retired').reduce((a, [, v]) => a + v, 0);
    return {
      garment: g,
      aliases: aliases.get(g.garmentId) ?? [],
      stock: { garmentId: g.garmentId, buckets: s, totalOwned, version: g.version },
      availability: availability(g),
      lastRecordedWear: lastWear.get(g.garmentId) ?? null,
      recordedWearCount: wearCount.get(g.garmentId) ?? 0,
      media: media(g),
    };
  });
  const counts = {
    owned: garments.filter((g) => g.acquisition === 'owned').length,
    available: items.filter((i) => i.availability.available).length,
    incoming: garments.filter((g) => g.acquisition === 'incoming').length,
    retired: garments.filter((g) => g.acquisition === 'disposed').length,
  };
  const wardrobe = { schemaVersion: CONTRACTS_VERSION, apiVersion: API_VERSION, items, total: items.length, complete: true, nextCursor: null, counts, asOf: CHECKED_AT };
  write('wardrobe.json', parseOrThrow(WardrobePage, wardrobe, 'wardrobe.json'));

  // --- Item details for every garment ---
  const receipts: Record<string, unknown>[] = [];
  const receipt = (over: Json): Json => ({
    schemaVersion: CONTRACTS_VERSION,
    commandId: `cmd_${h(JSON.stringify(over))}`,
    idempotencyKey: `test-event:2026-09-28:${receipts.length + 1}`,
    commandType: 'record_wear',
    outcome: 'committed',
    replayed: false,
    rebased: false,
    affected: [],
    summary: '',
    facts: {},
    effects: { state: 'none', items: [] },
    undo: { available: true },
    compensatesCommandId: null,
    undoneByCommandId: null,
    occurredAt: '2026-09-28T07:30:00.000Z',
    recordedAt: '2026-09-28T07:31:00.000Z',
    error: null,
    ...over,
  });
  const wearReceipts = new Map<string, Json[]>();
  for (const w of wears) {
    const r = receipt({
      idempotencyKey: `test-event:2026-09-28:${receipts.length + 1}`,
      summary: `Recorded ${w.date}: counted ${w.names.join(', ')}. ${TEST_EVENT}`,
      affected: w.names.map((n) => ({ entityType: 'daily_wear', entityId: `${G(n).garmentId}|${w.date}`, version: 1, change: 'created' })),
      facts: { observationId: `obs_${h(w.date)}`, counted: w.names.map((n) => G(n).garmentId), label: TEST_EVENT },
      effects: { state: 'none', items: [{ effectId: `eff_${h(w.date)}`, kind: 'board_revalidation', external: false, status: 'projected', operationKey: `revalidate:${w.date}` }] },
      occurredAt: `${w.date}T07:30:00.000Z`,
      recordedAt: `${w.date}T07:31:00.000Z`,
    });
    receipts.push(r);
    for (const n of w.names) {
      const id = G(n).garmentId;
      wearReceipts.set(id, [...(wearReceipts.get(id) ?? []), r]);
    }
  }
  const details: Record<string, unknown> = {};
  for (const item of items) {
    const g = item.garment;
    const history = wears
      .filter((w) => w.names.includes(g.name))
      .map((w) => ({ garmentId: g.garmentId, wearingDate: w.date, timezone: 'Europe/London', firstOccurredAt: `${w.date}T07:30:00.000Z`, observationCount: 1, sources: [w.source], segments: [], status: 'active', revision: 1 }));
    const restricted = isRestricted(g);
    const detail = {
      schemaVersion: CONTRACTS_VERSION,
      item,
      restrictions: restricted
        ? [{ restrictionId: 'rst_profilesneakersonly', kind: 'healing', scope: { categories: ['shoes', 'boots'], attributes: { construction: 'welted', model: '990v6' } }, reason: 'Sneakers only, until he says his feet have healed.', startsAt: '2026-09-13T23:00:00.000Z', expectedEnd: null, requiredEvidence: 'owner_statement', liftedAt: null, liftEvidence: null, version: 1 }]
        : [],
      wearHistory: history.reverse(),
      estimate: {
        estimatorVersion: 'availability-estimator/1',
        garmentId: g.garmentId,
        asOf: CHECKED_AT,
        targetDate: BOARD_DATE,
        eligible: item.availability.available,
        exclusionReasons: item.availability.available ? [] : item.availability.reasons,
        estimatedCleanUnits: item.stock.buckets.clean ?? 0,
        expectedInferredWears: 0,
        probabilityAvailable: item.availability.available ? 1 : 0,
        likelyAvailable: item.availability.available,
        basis: [{ kind: 'physical_clean', detail: `${item.stock.buckets.clean ?? 0} clean`, quantity: item.stock.buckets.clean ?? 0 }],
      },
      receipts: wearReceipts.get(g.garmentId) ?? [],
    };
    details[g.garmentId] = parseOrThrow(ItemDetail, detail, `item ${g.name}`);
  }
  // item-details.json is written after the board below, with each item's known combinations.

  // --- Demo board for Tuesday 6 October 2026 (DEMO: composed here, not by the daily service) ---
  type Pick = [name: string, role: string, group?: string];
  const options: { explanation: string; picks: Pick[] }[] = [
    {
      explanation: 'Gold oxford under the black chore coat is warm against cool, and the yellow sock carries the gold down to the ankle instead of repeating the cream trouser.',
      picks: [["Drake's Black Heavy Twill Chore", 'outer_layer'], ['Lightweight oxford — gold', 'base_top'], ['Akita slub 5-pocket — cream', 'bottom'], ["Anderson's belt — brown", 'belt'], ['Silk knit tie — rust', 'accessory'], ['Merino — golden yellow', 'socks'], ['NB 990v4 — olive/cream', 'footwear']],
    },
    {
      explanation: 'Clay linen over slate is greyed adjacency with one warm voice; the soft olive pleats keep it off the office drone, and the shoe decides at the door.',
      picks: [['ISTO Linen Work Jacket — clay', 'outer_layer'], ['Lightweight oxford — slate', 'base_top'], ['JP double-pleated heavyweight chino — soft olive', 'bottom'], ["Anderson's belt — olive (dark khaki)", 'belt'], ["Drake's scarf — green Summer Moghul", 'accessory'], ['Merino — deep earth brown', 'socks'], ['NB 990v4 — grey', 'footwear', 'shoes'], ['NB 990v4 — olive/cream', 'footwear', 'shoes']],
    },
    {
      explanation: 'Sprezzatura on a quiet day: a washed pink oxford under a burgundy knit tie, one red carried at three depths down to the sock, and the navy sneaker answering the blazer.',
      picks: [["Drake's Navy Herringbone Games Mk.I", 'outer_layer'], ['Lightweight oxford — pink', 'base_top'], ['Di Sondrio grey chino', 'bottom'], ["Anderson's belt — brown", 'belt'], ['Silk knit tie — burgundy', 'accessory'], ['Merino — fire red', 'socks'], ['NB 990v4 — navy', 'footwear']],
    },
    {
      explanation: 'Denim shirt and walnut chino are the RRL end of the academy; the waxed Chasseur covers the eleven-degree start and the strong-blue sock rhymes with the shirt.',
      picks: [["Drake's Waxed Chasseur", 'outer_layer'], ['ISTO denim shirt', 'base_top'], ['Di Sondrio walnut chino', 'bottom'], ["Anderson's belt — brown", 'belt'], ["Drake's scarf — burgundy unicorn", 'accessory'], ['Merino — strong blue', 'socks'], ['NB 990v4 — grey', 'footwear']],
    },
    {
      explanation: 'The home key, done properly: light blue oxford and sand cotton-linen under the field jacket, with a forest-green sock as the single flash.',
      picks: [['Mr P Cotton-Linen Field Jacket', 'outer_layer'], ['Lightweight oxford — light blue', 'base_top'], ['Bergamo cotton-linen chino — sand', 'bottom'], ["Anderson's belt — olive (dark khaki)", 'belt'], ['Silk knit tie — emerald', 'accessory'], ['Merino — deep forest green', 'socks'], ['NB 990v4 — olive/cream', 'footwear']],
    },
  ];
  // One builder for the home board and the DEMO trip-day board, so both have the exact shape the API serves.
  type DocWeather = Record<string, unknown> & { locationLabel: string; status: string; fetchedAt: string; departureTempC: number | null; peakTempC: number | null; rainStartsAt: string | null; rainProbabilityMax: number | null; rainAmountMm: number | null; windSpeedMaxKmh: number | null; windGustMaxKmh: number | null; line: string; provider: string };
  interface BoardSpec {
    date: string;
    purpose: string;
    idSalt: string;
    options: { explanation: string; picks: Pick[] }[];
    registers: readonly string[];
    dayLine: string;
    shapeOfDay: string;
    occasion: string;
    weather: DocWeather;
    timezone: string;
    interval: { start: string; end: string };
    composedAt: string;
    checkedAt: string;
    trip: Json | null;
    /** Garments in a packed suitcase: they are not at home, but they are what a trip-day board wears. */
    packed?: Set<string>;
  }
  const composeToday = (spec: BoardSpec) => {
  const boardId = `brd_${h('board:' + spec.date + spec.idSalt)}`;
  const boardOptions = spec.options.map((o, i) => ({
    optionId: `opt_${h(spec.idSalt + 'option:' + i)}`,
    boardId,
    revision: 2,
    position: i + 1,
    slots: o.picks.map(([name, role, group]) => {
      const g = G(name);
      const item = items.find((x) => x.garment.garmentId === g.garmentId)!;
      if (!item.availability.available && !spec.packed?.has(g.garmentId)) throw new Error(`Board uses unavailable ${name}`);
      return { garmentId: g.garmentId, role, alternativeGroup: group ?? null };
    }),
    explanation: o.explanation,
    status: 'offerable',
    validation: { valid: true, validator: 'demo-fixture', checkedAt: spec.composedAt, label: DEMO },
  }));
  const boardGarmentIds = new Set(boardOptions.flatMap((o) => o.slots.map((s) => s.garmentId)));

  // Contract BoardDocument (board-document/1) for the demo board, in the profile's section 11 order.
  const registers = spec.registers;
  const byId = new Map(garments.map((g) => [g.garmentId, g]));
  const docOptions = boardOptions.map((o, i) => {
    const slots = o.slots.map((s) => ({ ...s, g: byId.get(s.garmentId)! }));
    const of = (role: string) => slots.filter((s) => s.role === role);
    const lines: Json[] = [];
    const outer = of('outer_layer');
    if (outer.length) lines.push({ kind: 'jacket', label: outer[0]!.g.category === 'blazer' ? 'Blazer' : outer[0]!.g.category === 'coat' ? 'Coat' : 'Jacket', text: outer.map((s) => s.g.name).join(' over '), garmentIds: outer.map((s) => s.garmentId), flourish: null });
    const tops = of('base_top');
    if (tops.length) lines.push({ kind: 'shirt', label: 'Shirt', text: tops.map((s) => s.g.name).join(', '), garmentIds: tops.map((s) => s.garmentId), flourish: null });
    const bottoms = of('bottom');
    if (bottoms.length) lines.push({ kind: 'trousers', label: bottoms[0]!.g.category === 'jeans' ? 'Jeans' : 'Trousers', text: bottoms.map((s) => s.g.name).join(', '), garmentIds: bottoms.map((s) => s.garmentId), flourish: null });
    const belts = of('belt');
    const flourish = of('accessory')[0];
    lines.push({
      kind: 'belt', label: 'Belt', text: belts.map((s) => s.g.name).join(', '), garmentIds: belts.map((s) => s.garmentId),
      flourish: flourish ? { garmentId: flourish.garmentId, kind: flourish.g.category === 'tie' ? 'tie' : 'scarf', text: `optional: ${flourish.g.name}` } : null,
    });
    const socks = of('socks');
    const shoes = of('footwear');
    lines.push({ kind: 'socks_and_shoes', label: 'Socks and shoes', text: `${socks.map((s) => s.g.name).join(', ')} with ${shoes.map((s) => s.g.name).join(' or ')}`, garmentIds: [...socks, ...shoes].map((s) => s.garmentId), flourish: null });
    return {
      optionId: o.optionId,
      position: o.position,
      status: 'offerable',
      register: registers[i],
      registers: [registers[i]],
      why: o.explanation,
      lines,
      garments: slots.map((s) => ({
        garmentId: s.garmentId, name: s.g.name, role: s.role, category: s.g.category, colour: s.g.color, colorFamily: s.g.colorFamily,
        aliases: (aliases.get(s.garmentId) ?? []).map((a) => a.phrase), images: [], optional: s.role === 'accessory', alternativeGroup: s.alternativeGroup,
      })),
      footwear: shoes.map((s) => ({ garmentId: s.garmentId, kind: 'sneaker' })),
      suitability: null,
      jointAvailability: 0.92,
      qualification: null,
      lineage: { previousOptionId: null, changedRoles: [] },
    };
  });
  const dayLine = spec.dayLine;
  const document = {
    documentVersion: 'board-document/1',
    boardDate: spec.date,
    timezone: spec.timezone,
    purpose: spec.purpose,
    dayLine,
    shapeOfDay: spec.shapeOfDay,
    suitabilityNote: null,
    weather: spec.weather,
    calendar: { status: 'unavailable', fetchedAt: null, occasion: spec.occasion, relevantEventTitle: null, suitableCount: 0 },
    requestedCount: spec.options.length,
    options: docOptions,
    reserves: 0,
    shortfall: null,
    prose: 'deterministic',
    text: [dayLine, ...docOptions.map((o) => [o.why, ...o.lines.map((l) => `${l.label}: ${l.text}${(l.flourish as Json | null) ? ` (${(l.flourish as Json).text})` : ''}`)].join('\n'))].join('\n\n'),
  };
  const today = {
    schemaVersion: CONTRACTS_VERSION,
    date: spec.date,
    timezone: spec.timezone,
    board: {
      boardId,
      boardDate: spec.date,
      timezone: spec.timezone,
      purpose: spec.purpose,
      currentRevision: 2,
      brief: { text: null, occasion: spec.occasion, requestedCount: spec.options.length, wearingInterval: spec.interval },
      status: 'published',
      options: boardOptions,
      version: 3,
      publishedAt: spec.composedAt,
      document,
    },
    selection: null,
    recordedWears: [],
    sources: [
      { source: 'wardrobe', status: 'fresh', observedAt: spec.checkedAt, revision: `w-${spec.date}-1` },
      { source: 'weather', status: 'fresh', observedAt: spec.weather.fetchedAt, revision: null },
      { source: 'calendar', status: 'unavailable', observedAt: spec.composedAt, revision: null },
      { source: 'board', status: 'fresh', observedAt: spec.composedAt, revision: '2' },
    ],
    shortfall: null,
    // Written by the HTTP API for every board: the day line, flattened weather and board garments.
    dayLine,
    weather: {
      locationLabel: document.weather.locationLabel,
      status: document.weather.status,
      observedAt: document.weather.fetchedAt,
      morningTempC: document.weather.departureTempC,
      peakTempC: document.weather.peakTempC,
      rainStartsAt: document.weather.rainStartsAt,
      precipitationProbability: document.weather.rainProbabilityMax === null ? null : document.weather.rainProbabilityMax / 100,
      rainAmountMm: document.weather.rainAmountMm,
      windKph: document.weather.windSpeedMaxKmh,
      gustKph: document.weather.windGustMaxKmh,
      summary: document.weather.line,
      source: document.weather.provider,
    },
    garments: garments
      .filter((g) => boardGarmentIds.has(g.garmentId))
      .map((g) => ({ ...g, aliases: (aliases.get(g.garmentId) ?? []).map((a) => a.phrase), media: media(g) })),
    // 'day' at home; 'trip:<tripId>' with the trip summary when a packed trip covers the date.
    purpose: spec.purpose,
    trip: spec.trip,
  };
  return { today, boardId, boardOptions };
  };

  const home = composeToday({
    date: BOARD_DATE,
    purpose: 'day',
    idSalt: '',
    options,
    registers: ['field_workwear', 'field_workwear', 'sprezzatura', 'rl_ivy', 'home_key'],
    dayLine: 'Tuesday, eleven degrees at the door and seventeen by two, dry with a light westerly: an office day that ends at dinner in Borough.',
    shapeOfDay: 'An office day that ends at dinner in Borough',
    occasion: 'Office, then dinner in Borough',
    weather: {
      provider: `${DEMO}: hourly forecast`, attribution: null, locationLabel: 'Elephant and Castle, London', timezone: 'Europe/London', status: 'fresh',
      fetchedAt: '2026-10-06T05:30:00.000Z', issuedAt: null, ageMinutes: 22, wearingInterval: { start: '07:30', end: '22:30' }, eveningOnly: false,
      departureTime: '08:00', departureTempC: 11, peakTempC: 17, lowTempC: 10, eveningTempC: 13, apparentPeakC: 16, rainProbabilityMax: 10, rainAmountMm: 0,
      rainStartsAt: null, precipitationType: 'none', windSpeedMaxKmh: 14, windGustMaxKmh: 26, humidityMax: 78, conditions: ['cool_start', 'warming'],
      alerts: [], missingFields: [], line: '11 °C leaving, 17 °C by 2; dry, light westerly',
    },
    timezone: 'Europe/London',
    interval: { start: '2026-10-06T07:30:00+01:00', end: '2026-10-06T22:30:00+01:00' },
    composedAt: COMPOSED_AT,
    checkedAt: CHECKED_AT,
    trip: null,
  });
  const { boardId, boardOptions } = home;
  write('today.json', parseOrThrow(TodayResponse, home.today, 'today.json'));

  // --- DEMO trip-day board: a packed trip covers Thursday 15 October 2026, so Today serves the board
  // composed from the suitcase under purpose trip:<tripId> (backend/src/api/today.ts). Not owner data.
  const tripId = `trp_${h('trip:demo-paris', 16)}`;
  const tripOptions: { explanation: string; picks: Pick[] }[] = [
    {
      explanation: 'A museum day on foot: the field jacket over light blue, sand cotton-linen that forgives a long walk, and the olive/cream sneaker for the cobbles.',
      picks: [['Mr P Cotton-Linen Field Jacket', 'outer_layer'], ['Lightweight oxford — light blue', 'base_top'], ['Bergamo cotton-linen chino — sand', 'bottom'], ["Anderson's belt — olive (dark khaki)", 'belt'], ['Merino — deep forest green', 'socks'], ['NB 990v4 — olive/cream', 'footwear']],
    },
    {
      explanation: 'Dinner out without a change: the navy herringbone over pink, grey chino, and the burgundy knit tie in the pocket until the restaurant.',
      picks: [["Drake's Navy Herringbone Games Mk.I", 'outer_layer'], ['Lightweight oxford — pink', 'base_top'], ['Di Sondrio grey chino', 'bottom'], ["Anderson's belt — brown", 'belt'], ['Silk knit tie — burgundy', 'accessory'], ['Merino — fire red', 'socks'], ['NB 990v4 — navy', 'footwear']],
    },
    {
      explanation: 'The same jacket again, as packed for: slate oxford and the soft olive pleats change the day without adding a bag.',
      picks: [['Mr P Cotton-Linen Field Jacket', 'outer_layer'], ['Lightweight oxford — slate', 'base_top'], ['JP double-pleated heavyweight chino — soft olive', 'bottom'], ["Anderson's belt — olive (dark khaki)", 'belt'], ['Merino — deep earth brown', 'socks'], ['NB 990v4 — grey', 'footwear']],
    },
  ];
  const TRIP_DATE = '2026-10-15';
  const trip = composeToday({
    date: TRIP_DATE,
    purpose: `trip:${tripId}`,
    idSalt: 'trip:',
    options: tripOptions,
    registers: ['home_key', 'sprezzatura', 'field_workwear'],
    dayLine: `${DEMO}: Thursday in Paris, twelve degrees leaving the hotel and fifteen by three, showers after four: a walking day that ends at dinner.`,
    shapeOfDay: 'A walking day that ends at dinner',
    occasion: 'Museums on foot, then dinner',
    weather: {
      provider: `${DEMO}: hourly forecast`, attribution: null, locationLabel: 'Paris', timezone: 'Europe/Paris', status: 'fresh',
      fetchedAt: '2026-10-15T05:10:00.000Z', issuedAt: null, ageMinutes: 30, wearingInterval: { start: '08:00', end: '23:00' }, eveningOnly: false,
      departureTime: '09:00', departureTempC: 12, peakTempC: 15, lowTempC: 11, eveningTempC: 13, apparentPeakC: 14, rainProbabilityMax: 60, rainAmountMm: 1.2,
      rainStartsAt: '16:00', precipitationType: 'rain', windSpeedMaxKmh: 18, windGustMaxKmh: 32, humidityMax: 88, conditions: ['jacket_band_14_16', 'rain'],
      alerts: [], missingFields: [], line: '12 °C leaving, 15 °C by 3; showers from 4',
    },
    timezone: 'Europe/Paris',
    interval: { start: '2026-10-15T08:00:00+02:00', end: '2026-10-15T23:00:00+02:00' },
    composedAt: '2026-10-14T19:40:00.000Z',
    checkedAt: '2026-10-15T05:20:00.000Z',
    trip: { tripId, name: `${DEMO}: Paris long weekend`, timezone: 'Europe/Paris', departsOn: '2026-10-14', returnsOn: '2026-10-17', destinations: ['Paris'] },
    packed: new Set(tripOptions.flatMap((o) => o.picks.map(([n]) => G(n).garmentId))),
  });
  write('today-trip.json', parseOrThrow(TodayResponse, trip.today, 'today-trip.json'));

  // ItemDetail.combinations: the published options each garment appears in.
  for (const o of boardOptions) {
    for (const s of o.slots) {
      const d = details[s.garmentId] as { combinations?: unknown[] };
      d.combinations = [...(d.combinations ?? []), { boardId, boardDate: BOARD_DATE, boardRevision: 2, optionId: o.optionId, position: o.position, why: o.explanation, garmentIds: o.slots.map((x) => x.garmentId) }];
    }
  }
  for (const [id, d] of Object.entries(details)) {
    const withCombos = { combinations: [], ...(d as object) };
    details[id] = parseOrThrow(ItemDetail, withCombos, `item ${id}`);
  }
  write('item-details.json', details);

  // --- Settings with the API's additions, and the owner's full style document (byte-exact) ---
  const grants = [
    { grantId: `mgr_${h('grant:claude', 16)}`, client: 'claude', clientId: 'https://claude.ai/oauth/garderobe', clientName: 'Claude', redirectHost: 'claude.ai', scopes: ['wardrobe:read', 'wardrobe:write'], canWrite: true, status: 'active', createdAt: '2026-09-29T12:00:00.000Z', lastUsedAt: '2026-10-05T20:31:00.000Z', lastOperation: 'garderobe_today', revokedAt: null },
    { grantId: `mgr_${h('grant:chatgpt', 16)}`, client: 'chatgpt', clientId: 'https://chatgpt.com/connector/garderobe', clientName: 'ChatGPT', redirectHost: 'chatgpt.com', scopes: ['wardrobe:read'], canWrite: false, status: 'active', createdAt: '2026-09-30T09:00:00.000Z', lastUsedAt: '2026-10-01T12:02:00.000Z', lastOperation: 'garderobe_inventory', revokedAt: null },
  ];
  const profileBytes = readFileSync(join(root, 'data', 'owner-profile.md'));
  const body = new TextDecoder('utf-8').decode(profileBytes);
  const rules = JSON.parse(readFileSync(join(root, 'data', 'owner-profile-rules.json'), 'utf8')) as { rules: { strength: string }[] };
  const style = {
    schemaVersion: CONTRACTS_VERSION,
    document: {
      documentId: 'sdoc_ownerprofile',
      version: 1,
      title: body.split('\n')[0]!.replace(/^#\s*/, ''),
      body,
      contentSha256: createHash('sha256').update(profileBytes).digest('hex'),
      byteLength: profileBytes.length,
      isDemo: false,
      source: 'owner_supplied',
      authoredOn: '2026-09-14',
      importedAt: IMPORTED_AT,
      isCurrent: true,
    },
    rules: { active: rules.rules.length, hard: rules.rules.filter((r) => r.strength === 'hard').length, missingPassages: 0 },
  };
  const styleCurrent = { ...style, documents: [style.document] };
  write('style-current.json', parseOrThrow(StyleCurrentResponse, styleCurrent, 'style-current.json'));

  // --- Laundry sheet ---
  const batchId = `lb_${h('batch:2026-10-01')}`;
  const shirtsCollected = ['Lightweight oxford — blue', 'Pima oxford — fatigue', 'Lightweight oxford — light blue wide stripe'];
  const laundry = {
    schemaVersion: CONTRACTS_VERSION,
    asOf: CHECKED_AT,
    service: {
      hamper: ['Lightweight oxford — moss', 'Pima oxford — white'].map((n) => ({ garmentId: G(n).garmentId, name: n, quantity: 1, tracking: 'unit' })),
      batches: [
        {
          batchId,
          channel: 'service',
          status: 'partially_returned',
          collectedAt: '2026-10-01T08:00:00.000Z',
          returnedAt: null,
          items: shirtsCollected.map((n) => ({
            garmentId: G(n).garmentId,
            lotId: `lot_${h(n, 12)}`,
            quantity: 1,
            returnedQuantity: n === 'Pima oxford — fatigue' ? 0 : 1,
            status: n === 'Pima oxford — fatigue' ? 'away' : 'returned',
          })),
          version: 2,
          names: Object.fromEntries(shirtsCollected.map((n) => [G(n).garmentId, n])),
        },
      ],
      nextCollectionAt: '2026-10-09T08:00:00.000Z',
    },
    handWash: { hamper: [{ garmentId: G('Merino — inky blue').garmentId, name: 'Merino — inky blue', quantity: 1, tracking: 'anonymous_quantity' }] },
    // TEST EVENT partial return: the fatigue oxford is an owner-reported exception still away.
    openExceptions: [{ exceptionId: `lex_${h('exception:fatigue', 16)}`, garmentId: G('Pima oxford — fatigue').garmentId, name: 'Pima oxford — fatigue', kind: 'still_away', quantity: 1, batchId, occurredAt: '2026-10-03T10:00:00.000Z' }],
  };
  write('laundry.json', parseOrThrow(LaundryState, laundry, 'laundry.json'));

  // --- Connections ---
  const conn = (kind: string, displayName: string, over: Json = {}) => ({
    connectionId: `con_${kind}${h(displayName, 6)}`,
    kind,
    displayName,
    status: 'connected',
    capabilities: [],
    lastSuccessAt: '2026-10-05T20:31:00.000Z',
    lastSuccessOperation: null,
    lastError: null,
    reconnectUrl: null,
    client: null,
    scopes: [],
    endpoint: null,
    protocolVersion: null,
    ...over,
  });
  const services = [
    conn('gmail', 'Gmail', { capabilities: [{ name: 'Find purchases in email', available: true, missingPermission: null }], lastSuccessOperation: 'Searched order confirmations' }),
    conn('calendar', 'Google Calendar', {
      status: 'needs_reauth',
      capabilities: [
        { name: 'Read the day ahead', available: false, missingPermission: 'calendar.events.readonly' },
        { name: 'Publish the morning outfit event', available: false, missingPermission: 'calendar.events' },
      ],
      lastSuccessAt: '2026-10-04T20:30:00.000Z',
      lastSuccessOperation: 'Read Monday\'s events',
      lastError: 'Google asked for sign-in again',
      // The API writes reconnect URLs relative to its origin.
      reconnectUrl: `/v1/connections/con_calendar${h('Google Calendar', 6)}/connect`,
    }),
    conn('drive', 'Google Drive', { status: 'disconnected', lastSuccessAt: null, reconnectUrl: `/v1/connections/con_drive${h('Google Drive', 6)}/connect` }),
    conn('mcp', 'Exa search', { capabilities: [{ name: 'Product research', available: true, missingPermission: null }], lastSuccessOperation: 'Checked a size chart', endpoint: 'https://mcp.exa.ai/mcp', protocolVersion: '2025-06-18', scopes: ['read'] }),
  ];
  // Assistant grants appear in /v1/connections as kind assistant_grant with the grant id (mgr_…).
  const grantConnections = grants.map((g) =>
    conn('assistant_grant', g.clientName, {
      connectionId: g.grantId,
      capabilities: [
        { name: 'Read your wardrobe', available: true, missingPermission: null },
        { name: 'Make changes', available: g.canWrite, missingPermission: g.canWrite ? null : 'wardrobe:write' },
      ],
      lastSuccessAt: g.lastUsedAt,
      lastSuccessOperation: g.lastOperation,
      client: g.client,
      scopes: g.scopes,
    }),
  );
  const connections = { schemaVersion: CONTRACTS_VERSION, connections: [...services, ...grantConnections] };
  write('connections.json', parseOrThrow(ConnectionsResponse, connections, 'connections.json'));
  write(
    'settings.json',
    parseOrThrow(
      SettingsResponse,
      {
        schemaVersion: CONTRACTS_VERSION, homeLocationLabel: 'Elephant and Castle, London', timezone: 'Europe/London', deliveryTime: '07:00', dailyOptionCount: 5,
        laundryRoutine: DEFAULT_LAUNDRY_ROUTINE, version: 1, calendarId: null,
        styleDocuments: [{ documentId: style.document.documentId, title: style.document.title, version: 1, contentSha256: style.document.contentSha256, byteLength: style.document.byteLength, authoredOn: '2026-09-14' }],
        connectedAssistants: grants, connections: services, models: { simulated: true, profiles: {} }, budget: {},
      },
      'settings.json',
    ),
  );

  // --- Conversation transcript (DEMO), including a July message for recall anchoring ---
  const opt3 = boardOptions[2]!;
  const msg = (id: string, role: string, createdAt: string, parts: unknown[], over: Json = {}) => ({ messageId: id, clientTurnId: null, role, createdAt, sourceChannel: 'app', status: 'complete', parts, ...over });
  const conversation = {
    schemaVersion: CONTRACTS_VERSION,
    messages: [
      msg('msg_july1', 'user', '2026-07-14T18:02:00.000Z', [{ type: 'text', text: `${DEMO}: Those rust suede sneakers in the window on Lower Marsh were good. Not today, though.` }]),
      msg('msg_july2', 'assistant', '2026-07-14T18:02:20.000Z', [{ type: 'text', text: 'Noted as a liking, not a plan. Rust would echo the Sedona plaid and the rust knit tie from below.' }]),
      msg('msg_oct1', 'user', '2026-10-05T19:40:00.000Z', [{ type: 'text', text: `${DEMO}: Dinner in Borough tomorrow; nothing formal.` }], { clientTurnId: 'turn_demo0001' }),
      msg('msg_oct2', 'assistant', '2026-10-05T19:40:30.000Z', [
        { type: 'text', text: 'Then the board can carry you from the office to the table without a change. Option three is the one I would argue for.' },
        { type: 'outfit_card', boardId, optionId: opt3.optionId, boardRevision: 2, garmentIds: opt3.slots.map((s) => s.garmentId), explanation: opt3.explanation, validated: true },
      ], { sourceChannel: 'mcp' }),
    ],
    before: 'cur_older0001',
    hasMore: true,
    activeRunId: null,
  };
  write('conversation.json', parseOrThrow(ConversationPage, conversation, 'conversation.json'));
  const older = {
    schemaVersion: CONTRACTS_VERSION,
    messages: [
      msg('msg_june1', 'user', '2026-06-02T08:15:00.000Z', [{ type: 'text', text: `${DEMO}: Is the navy Mk.IV too close to a City blazer?` }]),
      msg('msg_june2', 'assistant', '2026-06-02T08:15:40.000Z', [
        { type: 'text', text: 'No. Cotton-linen with a soft shoulder reads games, not boardroom; keep it away from a white shirt and black shoes.' },
        { type: 'result_card', kind: 'verdict', title: `${DEMO}: Navy Mk.IV — keep`, summary: 'Reads games, not boardroom; pair with texture, not a white shirt.', jobRef: 'run_demojune' },
      ], { runId: 'run_demojune' }),
    ],
    before: null,
    hasMore: false,
    activeRunId: null,
  };
  write('conversation-older.json', parseOrThrow(ConversationPage, older, 'conversation-older.json'));

  // --- Turn responses: an ordinary one, and one where Garderobe removed a pasted recovery code (DEMO). ---
  write('turn-response.json', parseOrThrow(TurnResponse, { schemaVersion: CONTRACTS_VERSION, clientTurnId: 'turn_fixture01', messageId: 'msg_user_fixture01', runId: 'run_demo0001', status: 'accepted' }, 'turn-response.json'));
  write(
    'turn-response-notice.json',
    parseOrThrow(
      TurnResponse,
      {
        schemaVersion: CONTRACTS_VERSION,
        clientTurnId: 'turn_fixture02',
        messageId: 'msg_user_fixture02',
        runId: 'run_demo0002',
        status: 'accepted',
        notice: {
          kind: 'secret_removed',
          title: 'Recovery code removed from your message',
          summary:
            'Garderobe removed a recovery code from your message before saving it; it was not stored, sent to the assistant or included in exports. If it is your current code, create a new one in Garderobe, since pasted codes should be treated as exposed.',
          redacted: [{ kind: 'recovery_code', count: 1 }],
        },
      },
      'turn-response-notice.json',
    ),
  );

  // --- An SSE run: includes an unknown event type the client must ignore ---
  const runId = 'run_demo0001';
  const events = [
    ['run_started', { messageId: 'msg_run1', clientTurnId: 'turn_fixture01' }],
    ['activity', { text: 'Checking tomorrow\'s forecast for Borough' }],
    ['text_delta', { messageId: 'msg_run1', delta: 'Seventeen at the peak, so a lightweight oxford ' }],
    ['tool_progress_v9', { anything: true }],
    ['text_delta', { messageId: 'msg_run1', delta: 'with the jacket for the walk home.' }],
    ['outfit_board', { messageId: 'msg_run1', card: { type: 'outfit_card', boardId, optionId: opt3.optionId, boardRevision: 2, garmentIds: opt3.slots.map((s) => s.garmentId), explanation: opt3.explanation, validated: true } }],
    ['sources', { messageId: 'msg_run1', sources: [{ title: `${DEMO}: Met Office hourly forecast`, url: 'https://www.metoffice.gov.uk/', checkedAt: '2026-10-05T19:41:00.000Z' }] }],
    ['run_finished', { messageId: 'msg_run1', status: 'finished', message: null }],
  ] as const;
  const sse = events
    .map(([type, data], i) => {
      const ev = { eventId: `${i + 1}`, runId, type, at: `2026-10-05T19:41:0${i}.000Z`, data };
      parseOrThrow(RunEvent, ev, `event ${type}`);
      const known = (RunEventPayloads as Record<string, z.ZodType>)[type];
      if (known) parseOrThrow(known, data, `event data ${type}`);
      return `id: ${ev.eventId}\nevent: ${type}\ndata: ${JSON.stringify(ev)}\n\n`;
    })
    .join(': keep-alive\n\n');
  emit('run-events.sse', sse);

  // --- Receipt templates ---
  const rejected = receipt({ commandType: 'select_option', outcome: 'rejected', summary: 'Nothing changed.', undo: { available: false, reason: 'Nothing was committed' }, error: { code: 'validation_failed', message: 'This option offers two footwear alternatives; choose one so the outfit never logs both' } });
  write('receipt-rejected.json', parseOrThrow(CommandReceipt, rejected, 'receipt-rejected.json'));
  write('receipts.json', parseOrThrow(ReceiptsPage, { schemaVersion: CONTRACTS_VERSION, receipts: [...receipts].reverse(), nextCursor: null }, 'receipts.json'));

  // --- Account: recovery status (never the code) and recent transfers. DEMO content, not owner data. ---
  write(
    'recovery-status.json',
    parseOrThrow(RecoveryStatus, { schemaVersion: CONTRACTS_VERSION, hasActiveKit: true, activeKitIssuedAt: '2026-09-14T19:05:00.000Z', lastRecoveredAt: null, failedAttemptsLast24h: 0, pendingCollection: null }, 'recovery-status.json'),
  );
  write(
    'account-transfers.json',
    parseOrThrow(
      AccountTransfers,
      {
        schemaVersion: CONTRACTS_VERSION,
        transfers: [
          { transferId: `xfr_${h('demo-export', 16)}`, kind: 'export_download', status: 'downloaded', surface: 'app', createdAt: '2026-09-30T18:10:00.000Z', expiresAt: '2026-09-30T18:25:00.000Z', completedAt: '2026-09-30T18:11:00.000Z', summary: { exportId: `exp_${h('demo-export', 12)}`, label: DEMO } },
        ],
        audit: [
          { auditId: `aud_${h('demo-audit-2', 16)}`, action: 'export', surface: 'app', grantRef: null, idempotencyKey: null, outcome: 'downloaded', detail: { label: DEMO }, createdAt: '2026-09-30T18:11:00.000Z' },
          { auditId: `aud_${h('demo-audit-1', 16)}`, action: 'export', surface: 'app', grantRef: null, idempotencyKey: null, outcome: 'link_issued', detail: { label: DEMO }, createdAt: '2026-09-30T18:10:00.000Z' },
        ],
      },
      'account-transfers.json',
    ),
  );

  write('owner-wardrobe.json', {
    label: 'Owner wardrobe before scenario overlays: May 2026 CSV + owner-asserted additions of 2026-09-29',
    ...ownerSummary,
    additionGarmentIds: readAdditions().additions.map((a) => additionGid(a.key)),
  });
  const s = ownerSummary!;
  console.log(`Owner wardrobe: ${s.garments} garments, ${s.units} units (${s.additions} owner-asserted additions); restricted: ${s.restricted.length} (${s.restricted.join(', ')})`);
  console.log(`Generated fixtures: ${items.length} wardrobe items incl. labelled TEST EVENT overlay, ${boardOptions.length} options, profile ${style.document.contentSha256.slice(0, 12)}…`);
}

function flush() {
  mkdirSync(out, { recursive: true });
  for (const [name, text] of produced) writeFileSync(join(out, name), text);
  console.log(`Wrote ${produced.size} files to ${out}`);
}

function verify() {
  // The committed wardrobe must contain every owner-asserted addition (explicit, besides the byte comparison).
  let committed: { items: { garment: { garmentId: string } }[] } = { items: [] };
  try {
    committed = JSON.parse(readFileSync(join(out, 'wardrobe.json'), 'utf8'));
  } catch {
    /* reported as stale below */
  }
  const present = new Set(committed.items.map((i) => i.garment.garmentId));
  const missing = readAdditions().additions.filter((a) => !present.has(additionGid(a.key))).map((a) => a.item.name);
  if (missing.length) {
    console.error(`Fixtures lack ${missing.length} owner-asserted additions (${missing.join(', ')}). Run: npx tsx ios/scripts/fixtures.ts generate`);
    process.exit(1);
  }
  const stale: string[] = [];
  for (const [name, text] of produced) {
    let current = '';
    try {
      current = readFileSync(join(out, name), 'utf8');
    } catch {
      current = '';
    }
    if (current !== text) stale.push(name);
  }
  const extra = readdirSync(out).filter((f) => !produced.has(f));
  if (stale.length || extra.length) {
    console.error(`Fixtures are stale: ${[...stale, ...extra.map((e) => `${e} (not generated)`)].join(', ')}. Run: npx tsx ios/scripts/fixtures.ts generate`);
    process.exit(1);
  }
  console.log(`${produced.size} fixtures are up to date with the CSV, profile and contracts.`);
}

/** Validates JSON files written by the Swift tests (GARDEROBE_CONTRACT_OUT). File name prefix picks the schema. */
function check(dir: string) {
  const schemas: [string, z.ZodType][] = [
    ['envelope-', CommandEnvelope],
    ['run-input-response-', RunInputResponse.extend({ run: RunStatus })],
    ['run-input-', RunInputRequest],
    ['swap-candidates-', SwapCandidates],
    ['upload-receive-', UploadReceiveResponse],
    ['receipt-', CommandReceipt],
    ['turn-response-', TurnResponse],
    ['turn-', TurnRequest],
    ['upload-', UploadRequest],
    ['studio-validate-', StudioValidateRequest],
    ['studio-suggest-', StudioSuggestRequest],
    ['query-', WardrobeQueryParams],
    ['recall-response-', RecallSearchResponse],
    ['recall-', RecallSearchRequest],
    ['export-download-', ExportDownloadResult],
    ['mcp-import-', McpImportResult],
    ['recovery-kit-link-', RecoveryKitLink],
    ['recovery-kit-response-', RecoveryKitResponse],
    ['recovery-status-', RecoveryStatus],
    ['account-transfers-', AccountTransfers],
    ['staged-import-', StagedImportPackage],
  ];
  let n = 0;
  const failures: string[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const entry = schemas.find(([p]) => f.startsWith(p));
    if (!entry) {
      failures.push(`${f}: no schema for this prefix`);
      continue;
    }
    const r = entry[1].safeParse(JSON.parse(readFileSync(join(dir, f), 'utf8')));
    n++;
    if (!r.success) failures.push(`${f}: ${JSON.stringify(r.error.issues.slice(0, 3))}`);
  }
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  if (n === 0) {
    console.error(`No Swift-encoded files found in ${dir}`);
    process.exit(1);
  }
  console.log(`${n} Swift-encoded payloads match the contracts.`);
}

const [mode, arg] = process.argv.slice(2);
if (mode === 'generate') {
  await generate();
  flush();
} else if (mode === 'verify') {
  await generate();
  verify();
} else if (mode === 'check' && arg) check(arg);
else {
  console.error('usage: fixtures.ts generate | verify | check <dir>');
  process.exit(2);
}
