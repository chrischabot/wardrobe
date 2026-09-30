import { ImportDataset, type ImportDatasetInput, type StockBucket } from '@garderobe/contracts';
import { json } from '../domain/db.js';
import { DomainError } from '../domain/errors.js';
import { newId } from '../domain/ids.js';
import { sha256Hex, utf8ByteLength } from '../domain/hash.js';
import { assertPrincipal, type Principal } from '../domain/principal.js';
import { normalizePhrase } from '../domain/catalog.js';
import { BUCKETS } from '../domain/stock/replay.js';

/**
 * Isolated importer for the neutral dataset (spec section 16). Assigns fresh canonical identities,
 * records every source row in import_references (imported, merged or held), records migration issues,
 * and is idempotent: rows already imported under the same source system are skipped.
 *
 * Imported stock is an import baseline: units are received into their stated buckets with
 * basis 'import_baseline'. No wear, laundry batch or arrival is created.
 */

export interface ImportOptions {
  sourceSystem: string;
  sourceLabel?: string;
  sourceSha256?: string;
  importedAt?: string;
}

export interface ImportResult {
  importId: string;
  garmentsCreated: number;
  garmentsSkipped: number;
  rowsImported: number;
  rowsMerged: number;
  rowsHeld: number;
  unitsReceived: number;
  restrictionsCreated: number;
  documentsCreated: number;
  rulesCreated: number;
  lifecycleProjectsCreated: number;
  ordersCreated: number;
  measurementsCreated: number;
  issuesRecorded: number;
  garmentIds: Record<string, string>;
  restrictionIds: Record<string, string>;
  documents: { sourceId: string; documentId: string; version: number; contentSha256: string; byteLength: number; expectedSha256: string | null; hashMatches: boolean | null }[];
}

type Group = D1PreparedStatement[];

async function commitGroups(db: D1Database, groups: Group[], maxPerBatch = 90): Promise<void> {
  let batch: D1PreparedStatement[] = [];
  for (const g of groups) {
    if (batch.length && batch.length + g.length > maxPerBatch) {
      await db.batch(batch);
      batch = [];
    }
    batch.push(...g);
  }
  if (batch.length) await db.batch(batch);
}

export async function importDataset(db: D1Database, principal: Principal, input: ImportDatasetInput, opts: ImportOptions): Promise<ImportResult> {
  assertPrincipal(principal);
  const userId = principal.userId;
  const data = ImportDataset.parse(input);
  const now = opts.importedAt ?? new Date().toISOString();
  const importId = newId('imp');
  const user = await db.prepare('SELECT user_id FROM users WHERE user_id = ?').bind(userId).first();
  if (!user) throw new DomainError('unauthenticated', 'Create the user before importing data');

  const { results: refRows } = await db
    .prepare('SELECT entity_type, source_id, entity_id FROM import_references WHERE user_id = ? AND source_system = ?')
    .bind(userId, opts.sourceSystem)
    .all<{ entity_type: string; source_id: string; entity_id: string | null }>();
  const refs = new Map(refRows.map((r) => [`${r.entity_type}|${r.source_id}`, r.entity_id]));
  const ref = (type: string, sourceId: string, entityId: string | null, row: { row?: number; rowSha256?: string; disposition?: string; note?: string } = {}) =>
    db
      .prepare(
        `INSERT INTO import_references (user_id, source_system, source_id, entity_type, entity_id, disposition, source_row, source_row_sha256, note, import_id, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(userId, opts.sourceSystem, sourceId, type, entityId, row.disposition ?? 'imported', row.row ?? null, row.rowSha256 ?? null, row.note ?? null, importId, now);

  const result: ImportResult = {
    importId,
    garmentsCreated: 0,
    garmentsSkipped: 0,
    rowsImported: 0,
    rowsMerged: 0,
    rowsHeld: 0,
    unitsReceived: 0,
    restrictionsCreated: 0,
    documentsCreated: 0,
    rulesCreated: 0,
    lifecycleProjectsCreated: 0,
    ordersCreated: 0,
    measurementsCreated: 0,
    issuesRecorded: 0,
    garmentIds: {},
    restrictionIds: {},
    documents: [],
  };
  const groups: Group[] = [];

  // Owner settings (never overwritten by a re-import).
  const settings = await db.prepare('SELECT user_id FROM owner_settings WHERE user_id = ?').bind(userId).first();
  if (!settings) {
    const o = data.owner;
    groups.push([
      db
        .prepare(
          `INSERT INTO owner_settings (user_id, home_location_label, home_latitude, home_longitude, timezone, delivery_time, daily_option_count, laundry_routine_json, estimator_params_json, wear_logging_since, version, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .bind(
          userId,
          o.homeLocationLabel,
          o.homeLatitude ?? null,
          o.homeLongitude ?? null,
          o.timezone,
          o.deliveryTime,
          o.dailyOptionCount,
          json(o.laundryRoutine ?? { service: { collectDow: 5, collectTime: '09:00', returnDow: 6, baselineDow: 0, baselineTime: '00:00' }, handWash: { baselineDow: 0, baselineTime: '00:00' } }),
          o.estimatorParameters ? json(o.estimatorParameters) : null,
          o.wearLoggingSince,
          now,
        ),
    ]);
  }

  // Garments. Identity rules (ADV-14): a row matches an existing garment of this owner when category,
  // maker, colour, size and maker code agree and its name (or an owner-phrase alias) matches the
  // garment's name or one of its owner-phrase aliases. A single match is merged into that garment (no
  // new record, no new units); several matches are held for review; no match creates a garment.
  // Rows whose source row number was imported before but now carries different content (a shifted
  // or edited file) go through the same identity rules instead of being skipped silently.
  const n = (v: string | null | undefined) => (v === null || v === undefined || v.trim() === '-' ? '' : normalizePhrase(v));
  type Candidate = { id: string; name: string; tuple: string; names: Set<string> };
  const { results: existingGarments } = await db
    .prepare('SELECT garment_id, name, category, maker, color, size_label, product_code FROM garments WHERE user_id = ?')
    .bind(userId)
    .all<{ garment_id: string; name: string; category: string; maker: string | null; color: string | null; size_label: string | null; product_code: string | null }>();
  const { results: existingAliases } = await db
    .prepare("SELECT garment_id, phrase_norm FROM garment_aliases WHERE user_id = ? AND kind = 'owner_phrase' AND retired_at IS NULL")
    .bind(userId)
    .all<{ garment_id: string; phrase_norm: string }>();
  const tupleOf = (x: { category: string; maker?: string | null; color?: string | null; sizeLabel?: string | null; productCode?: string | null }) =>
    [x.category, n(x.maker), n(x.color), n(x.sizeLabel), n(x.productCode)].join('|');
  const candidates: Candidate[] = existingGarments.map((e) => ({
    id: e.garment_id,
    name: e.name,
    tuple: tupleOf({ category: e.category, maker: e.maker, color: e.color, sizeLabel: e.size_label, productCode: e.product_code }),
    names: new Set([n(e.name), ...existingAliases.filter((a) => a.garment_id === e.garment_id).map((a) => a.phrase_norm)]),
  }));
  const matchedSourceIds = new Set<string>();
  const identityIssues: typeof data.issues = [];

  for (const g of data.garments) {
    const tuple = tupleOf(g);
    const names = new Set([n(g.name), ...g.aliases.filter((a) => a.kind === 'owner_phrase').map((a) => n(a.phrase))]);
    const matches = candidates.filter((c) => c.tuple === tuple && [...names].some((x) => x && c.names.has(x)));
    const rows = g.sourceRows ?? [{ sourceId: g.sourceId, disposition: 'imported' as const }];
    const existing = refs.get(`garment|${g.sourceId}`);
    if (existing && (matches.length === 0 ? candidates.find((c) => c.id === existing)?.tuple === tuple : matches.some((m) => m.id === existing))) {
      result.garmentIds[g.sourceId] = existing;
      result.garmentsSkipped++;
      continue;
    }
    if (matches.length === 1) {
      const m = matches[0]!;
      result.garmentIds[g.sourceId] = m.id;
      matchedSourceIds.add(g.sourceId);
      result.garmentsSkipped++;
      const group: Group = [];
      for (const r of rows) {
        if (refs.has(`garment|${r.sourceId}`)) continue;
        refs.set(`garment|${r.sourceId}`, m.id);
        group.push(ref('garment', r.sourceId, m.id, { ...r, disposition: 'merged', note: `Same garment as the existing "${m.name}" by identity (category, maker, colour, size, code and name); no new garment or units created` }));
        result.rowsMerged++;
      }
      identityIssues.push({
        issueKey: `duplicate_row_merged:${g.sourceId}:${rows[0]?.rowSha256 ?? tuple}`,
        kind: 'duplicate_row_merged',
        severity: 'info',
        sourceId: g.sourceId,
        detail: `Source row "${g.name}" repeats the existing garment "${m.name}"; it was matched to that garment instead of creating a duplicate.`,
        evidence: { garmentId: m.id, rows: rows.map((r) => r.row ?? null) },
      });
      if (group.length) groups.push(group);
      continue;
    }
    if (matches.length > 1) {
      matchedSourceIds.add(g.sourceId);
      const group: Group = [];
      for (const r of rows) {
        if (refs.has(`garment|${r.sourceId}`)) continue;
        refs.set(`garment|${r.sourceId}`, null as unknown as string);
        group.push(ref('garment', r.sourceId, null, { ...r, disposition: 'held', note: `Possible duplicate of ${matches.length} existing garments (${matches.map((x) => x.name).join('; ')}); held for review` }));
        result.rowsHeld++;
      }
      identityIssues.push({
        issueKey: `possible_duplicate:${g.sourceId}:${rows[0]?.rowSha256 ?? tuple}`,
        kind: 'possible_duplicate',
        severity: 'review',
        sourceId: g.sourceId,
        detail: `Source row "${g.name}" matches ${matches.length} existing garments (${matches.map((x) => x.name).join('; ')}); held for review instead of being imported or planned.`,
        evidence: { garmentIds: matches.map((x) => x.id), rows: rows.map((r) => r.row ?? null) },
      });
      if (group.length) groups.push(group);
      continue;
    }
    // New content. A source row number already used by different content gets a content-qualified id.
    const shift = (sid: string, sha?: string) => (refs.has(`garment|${sid}`) ? `${sid}#${(sha ?? tuple).slice(0, 12)}` : sid);
    const createRows = rows.map((r) => ({ ...r, sourceId: shift(r.sourceId, r.rowSha256) }));
    if (createRows.some((r) => refs.has(`garment|${r.sourceId}`))) {
      result.garmentsSkipped++;
      continue;
    }
    const garmentId = newId('g');
    const lotId = newId('lot');
    result.garmentIds[g.sourceId] = garmentId;
    result.garmentsCreated++;
    candidates.push({ id: garmentId, name: g.name, tuple, names });
    for (const r of createRows) refs.set(`garment|${r.sourceId}`, garmentId);
    const group: Group = [
      db
        .prepare(
          `INSERT INTO garments (user_id, garment_id, name, category, roles_json, maker, product_name, product_code, fabric, color, color_family, pattern, size_label, care_channel, laundry_policy,
             tracking, acquisition, disposal_reason, planning_policy, condition, location, location_detail, attributes_json, notes, wear_logging_since, created_at, updated_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .bind(
          userId,
          garmentId,
          g.name,
          g.category,
          json(g.roles),
          g.maker ?? null,
          g.productName ?? null,
          g.productCode ?? null,
          g.fabric ?? null,
          g.color ?? null,
          g.colorFamily ?? null,
          g.pattern ?? null,
          g.sizeLabel ?? null,
          g.laundryPolicy === 'never' ? 'none' : g.careChannel,
          g.laundryPolicy,
          g.tracking,
          g.acquisition,
          g.disposalReason ?? null,
          g.planningPolicy,
          g.condition,
          g.location,
          g.locationDetail ?? null,
          json(g.attributes),
          g.notes ?? null,
          data.owner.wearLoggingSince,
          now,
          now,
        ),
    ];
    const units: Record<StockBucket, string[]> = { clean: [], worn: [], hamper: [], laundry: [], storage: [], away: [], retired: [] };
    const movements: Group = [];
    let seq = Date.now() * 1000;
    for (const bucket of BUCKETS) {
      const qty = g.stock[bucket] ?? 0;
      if (qty <= 0) continue;
      for (let i = 0; i < qty; i++) units[bucket].push(now);
      result.unitsReceived += bucket === 'retired' ? 0 : qty;
      movements.push(
        db
          .prepare("INSERT INTO stock_movements (user_id, movement_id, seq, lot_id, garment_id, kind, params_json, occurred_at, recorded_at, command_id) VALUES (?, ?, ?, ?, ?, 'receive', ?, ?, ?, NULL)")
          .bind(userId, newId('mv'), seq++, lotId, garmentId, json({ kind: 'receive', qty, to: bucket, basis: 'import_baseline' }), now, now),
      );
    }
    group.push(
      db
        .prepare(
          `INSERT INTO stock_lots (user_id, lot_id, garment_id, clean_qty, worn_qty, hamper_qty, laundry_qty, storage_qty, away_qty, retired_qty, units_json, version, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .bind(userId, lotId, garmentId, units.clean.length, units.worn.length, units.hamper.length, units.laundry.length, units.storage.length, units.away.length, units.retired.length, json(units), now),
      ...movements,
    );
    const seen = new Set<string>();
    for (const a of g.aliases) {
      const norm = normalizePhrase(a.phrase);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      group.push(
        db
          .prepare('INSERT INTO garment_aliases (user_id, alias_id, garment_id, phrase, phrase_norm, kind, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(userId, newId('ali'), garmentId, a.phrase, norm, a.kind, `import:${opts.sourceSystem}:${g.sourceId}`, now),
      );
    }
    for (const f of g.facts) {
      group.push(
        db
          .prepare('INSERT INTO garment_facts (user_id, fact_id, garment_id, field, value_json, source_kind, source_ref, observed_at, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(userId, newId('fct'), garmentId, f.field, json(f.value), f.sourceKind, f.sourceRef, f.observedAt, f.confidence ?? null, now),
      );
    }
    for (const r of createRows) {
      group.push(ref('garment', r.sourceId, garmentId, r));
      if (r.disposition === 'merged') result.rowsMerged++;
      else result.rowsImported++;
    }
    groups.push(group);
  }

  // Style documents and their rules (verbatim; hash recorded and compared).
  const ruleKeysByRestriction = new Map<string, string>();
  for (const doc of data.styleDocuments) {
    for (const r of doc.rules) {
      if (!doc.body.includes(r.passage.quote)) throw new DomainError('validation_failed', `Rule ${r.ruleKey} quotes text that is not in "${doc.title}"`, { ruleKey: r.ruleKey });
      if (r.restrictionSourceId) ruleKeysByRestriction.set(r.restrictionSourceId, r.ruleKey);
    }
    const sha = await sha256Hex(doc.body);
    const existing = refs.get(`style_document|${doc.sourceId}`);
    const expected = doc.expectedSha256 ?? null;
    if (existing) {
      result.documents.push({ sourceId: doc.sourceId, documentId: existing, version: 1, contentSha256: sha, byteLength: utf8ByteLength(doc.body), expectedSha256: expected, hashMatches: expected ? expected === sha : null });
      continue;
    }
    const documentId = newId('doc');
    result.documentsCreated++;
    result.documents.push({ sourceId: doc.sourceId, documentId, version: 1, contentSha256: sha, byteLength: utf8ByteLength(doc.body), expectedSha256: expected, hashMatches: expected ? expected === sha : null });
    const group: Group = [
      db
        .prepare(
          `INSERT INTO style_documents (user_id, document_id, version, title, body, content_sha256, byte_length, is_demo, source, authored_on, imported_at, is_current)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .bind(userId, documentId, doc.title, doc.body, sha, utf8ByteLength(doc.body), doc.isDemo ? 1 : 0, doc.source, doc.authoredOn, now),
      ref('style_document', doc.sourceId, documentId),
    ];
    if (expected && expected !== sha) {
      data.issues.push({
        issueKey: `profile_hash_mismatch:${doc.sourceId}`,
        kind: 'profile_hash_mismatch',
        severity: 'info',
        sourceId: doc.sourceId,
        detail: `"${doc.title}" hashes to ${sha}, not the expected ${expected}. The supplied text is authoritative and was imported as given.`,
        evidence: { computed: sha, expected },
      });
    }
    groups.push(group);
    const ruleGroup: Group = [];
    for (const r of doc.rules) {
      result.rulesCreated++;
      ruleGroup.push(
        db
          .prepare(
            `INSERT INTO style_rules (user_id, rule_id, rule_key, kind, strength, category, statement, interpretation, machine_json, exception_policy, document_id, document_version,
               passage_section, passage_quote, passage_status, status, source, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'present', ?, 'profile', ?)`,
          )
          .bind(userId, newId('rule'), r.ruleKey, r.kind, r.strength, r.category, r.statement, r.interpretation, json(r.machine), r.exceptionPolicy, documentId, r.passage.section, r.passage.quote, r.status, now),
      );
    }
    if (ruleGroup.length) groups.push(ruleGroup);
  }

  // Restrictions.
  for (const r of data.restrictions) {
    const existing = refs.get(`restriction|${r.sourceId}`);
    if (existing) {
      result.restrictionIds[r.sourceId] = existing;
      continue;
    }
    const restrictionId = newId('rst');
    result.restrictionIds[r.sourceId] = restrictionId;
    result.restrictionsCreated++;
    const garmentIds = (r.scope.garmentSourceIds ?? []).map((s) => result.garmentIds[s]).filter((x): x is string => Boolean(x));
    const scope = {
      ...(garmentIds.length ? { garmentIds } : {}),
      ...(r.scope.categories?.length ? { categories: r.scope.categories } : {}),
      ...(r.scope.roles?.length ? { roles: r.scope.roles } : {}),
      ...(r.scope.attributes && Object.keys(r.scope.attributes).length ? { attributes: r.scope.attributes } : {}),
    };
    groups.push([
      db
        .prepare(
          `INSERT INTO restrictions (user_id, restriction_id, kind, scope_json, reason, starts_at, expected_end, required_evidence, rule_key, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .bind(userId, restrictionId, r.kind, json(scope), r.reason, r.startsAt, r.expectedEnd ?? null, r.requiredEvidence, ruleKeysByRestriction.get(r.sourceId) ?? null),
      ref('restriction', r.sourceId, restrictionId),
    ]);
  }

  // Lifecycle projects (e.g. tailoring candidates). A candidate is not "at the tailor".
  for (const p of data.lifecycleProjects) {
    if (refs.get(`lifecycle_project|${p.sourceId}`)) continue;
    // A row matched to (or held against) an existing garment does not open a second project on it.
    if (p.garmentSourceIds.every((s) => matchedSourceIds.has(s))) continue;
    const projectId = newId('prj');
    result.lifecycleProjectsCreated++;
    const group: Group = [
      db
        .prepare('INSERT INTO lifecycle_projects (user_id, project_id, kind, status, details_json, expected_return, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(userId, projectId, p.kind, p.status, json(p.details), p.expectedReturn ?? null, now, now),
      ref('lifecycle_project', p.sourceId, projectId),
    ];
    for (const s of p.garmentSourceIds) {
      const gid = result.garmentIds[s];
      if (gid) group.push(db.prepare('INSERT INTO lifecycle_project_items (user_id, project_id, garment_id, quantity) VALUES (?, ?, ?, 1)').bind(userId, projectId, gid));
    }
    groups.push(group);
  }

  // Orders (stable external identities deduplicate).
  for (const o of data.orders) {
    if (refs.get(`order|${o.sourceId}`)) continue;
    const orderId = newId('ord');
    result.ordersCreated++;
    const group: Group = [
      db
        .prepare('INSERT OR IGNORE INTO orders (user_id, order_id, merchant, merchant_order_number, ordered_at, currency, source_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(userId, orderId, o.merchant, o.merchantOrderNumber, o.orderedAt, o.currency, `import:${opts.sourceSystem}:${o.sourceId}`, now),
      ref('order', o.sourceId, orderId),
    ];
    for (const l of o.lines) {
      const lineId = newId('oln');
      group.push(
        db
          .prepare(
            `INSERT INTO order_lines (user_id, line_id, order_id, external_line_id, garment_id, description, quantity, unit_price_minor, currency, arrival_estimate, arrived_qty, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(userId, lineId, orderId, l.externalLineId, l.garmentSourceId ? (result.garmentIds[l.garmentSourceId] ?? null) : null, l.description, l.quantity, l.unitPriceMinor, o.currency, l.arrivalEstimate ?? null, l.arrivedQuantity, l.arrivedQuantity >= l.quantity ? 'arrived' : 'ordered'),
      );
      if (l.returnDeadline) {
        group.push(
          db
            .prepare('INSERT INTO return_deadlines (user_id, deadline_id, line_id, kind, deadline_at, timezone, terms_source, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(userId, newId('ddl'), lineId, l.returnDeadline.kind, l.returnDeadline.deadline, l.returnDeadline.timezone, l.returnDeadline.termsSource, l.returnDeadline.checkedAt),
        );
      }
    }
    groups.push(group);
  }

  for (const m of data.measurements) {
    if (refs.get(`measurement|${m.sourceId}`)) continue;
    const id = newId('msr');
    result.measurementsCreated++;
    groups.push([
      db
        .prepare('INSERT INTO measurements (user_id, measurement_id, subject, garment_id, name, value, unit, convention, measured_on, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(userId, id, m.subject, m.garmentSourceId ? (result.garmentIds[m.garmentSourceId] ?? null) : null, m.name, m.value, m.unit, m.convention ?? null, m.measuredOn, m.source, now),
      ref('measurement', m.sourceId, id),
    ]);
  }

  // Held rows: accounted for, not imported.
  for (const h of data.heldRows) {
    if (refs.has(`garment|${h.sourceId}`)) continue;
    result.rowsHeld++;
    groups.push([
      ref('garment', h.sourceId, null, { row: h.row, rowSha256: h.rowSha256, disposition: 'held', note: h.reason }),
      db
        .prepare('INSERT OR IGNORE INTO migration_issues (user_id, issue_id, source_system, source_id, issue_key, kind, severity, detail, evidence_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(userId, newId('iss'), opts.sourceSystem, h.sourceId, `held_row:${h.sourceId}`, 'held_row', 'review', h.reason, json({ row: h.row }), now),
    ]);
  }

  // Migration issues (deduplicated by issue key). Issues about a row matched to an existing garment
  // repeat what the original row already recorded, so they are not recorded again.
  const issueGroup: Group = [];
  for (const i of [...data.issues.filter((x) => !(x.garmentSourceId && matchedSourceIds.has(x.garmentSourceId))), ...identityIssues]) {
    issueGroup.push(
      db
        .prepare('INSERT OR IGNORE INTO migration_issues (user_id, issue_id, source_system, source_id, issue_key, kind, severity, entity_id, detail, evidence_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(userId, newId('iss'), opts.sourceSystem, i.sourceId ?? i.garmentSourceId ?? null, i.issueKey, i.kind, i.severity, i.garmentSourceId ? (result.garmentIds[i.garmentSourceId] ?? null) : null, i.detail, json(i.evidence), now),
    );
  }
  for (let k = 0; k < issueGroup.length; k += 40) groups.push(issueGroup.slice(k, k + 40));
  result.issuesRecorded = data.issues.length + identityIssues.length;

  groups.push([
    db
      .prepare('INSERT INTO import_runs (user_id, import_id, source_system, source_label, source_sha256, row_count, report_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(userId, importId, opts.sourceSystem, opts.sourceLabel ?? data.source.label ?? null, opts.sourceSha256 ?? null, result.rowsImported + result.rowsMerged + result.rowsHeld, json({ ...result, garmentIds: undefined }), now),
  ]);
  await commitGroups(db, groups);
  return result;
}
